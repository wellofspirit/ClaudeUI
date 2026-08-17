/**
 * The cli.js voice-server protocol, once — SyncCore phase 5 S3.
 *
 * Two things now stream audio into the transcription server the `voice-server`
 * patch opens inside cli.js (patch/voice-server/README.md): the desktop's native
 * microphone ({@link ../services/voice-client.VoiceClient}) and a remote
 * browser's AudioWorklet capture ({@link ../services/remote-voice}). They differ
 * in exactly two ways — where the PCM comes from, and where the transcripts go —
 * and agree about everything else: the TCP connect, the newline-JSON framing, the
 * pre-`ready` buffer, the state machine, the finalization timeout, the teardown.
 *
 * So that half lives here and is written once. The two audio SOURCES and the two
 * DELIVERY targets are the abstract members below. A second copy of the protocol
 * would be a second place for the `connecting`-window race (see
 * {@link VoiceStreamClient.startRecording}) and the finalize timeout to be got
 * subtly wrong, and both were bugs here already.
 *
 * Protocol (client → server):
 *   {"type":"voice_start","language":"en"}
 *   {"type":"audio","data":"<base64 PCM>"}
 *   {"type":"voice_stop"}
 *
 * Protocol (server → client):
 *   {"type":"ready"}
 *   {"type":"transcript","text":"...","isFinal":true|false}
 *   {"type":"error","message":"..."}
 *   {"type":"closed"}
 *
 * **Audio is never logged.** Not the base64, not the decoded bytes, not their
 * length in a way that would fingerprint speech — the same rule `term-data` and
 * the stream lane carry (security.md §Audit). Microphone content is keystrokes.
 */

import * as net from 'net'
import * as readline from 'readline'
import { logger } from './logger'
import type { VoiceState } from '../../shared/types'

interface VoiceServerConnection {
  socket: net.Socket
  rl: readline.Interface
}

export abstract class VoiceStreamClient {
  private port: number
  private conn: VoiceServerConnection | null = null
  private state: VoiceState = 'idle'
  private audioBuffer: Buffer[] = []
  private streamReady = false
  /** The finalization safety net; cleared by {@link VoiceStreamClient.cleanup}. */
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null

  /** Log tag — the concrete client's name, so the two sources stay separable. */
  protected readonly logSource: string

  constructor(port: number, logSource: string) {
    this.port = port
    this.logSource = logSource
  }

  // -- What the two sources/targets must supply --------------------------------

  /**
   * Begin producing audio. Return false if the source could not start (a denied
   * microphone), in which case the caller's start is aborted and cleaned up.
   *
   * A PUSH source (the remote browser, which is already sending frames by the
   * time this runs) has nothing to start and answers true.
   */
  protected abstract startAudioSource(): boolean

  /** Stop producing audio. Must be idempotent — cleanup calls it unconditionally. */
  protected abstract stopAudioSource(): void

  /**
   * What to tell the user when {@link startAudioSource} refuses.
   *
   * Per-source, because the two sources fail differently and the wording is
   * user-facing: the desktop is RE-starting a microphone that is already running
   * (`ClaudeSession` opened it the instant the button went down, to buffer while
   * the SDK spawns), so "restart" is the accurate word there and was the shipped
   * string. Parameterized rather than generalized so extracting this base class
   * could not quietly reword a message someone may already recognize.
   */
  protected abstract audioSourceFailureMessage(): string

  /** Deliver a state transition to whoever owns this capture's UI. */
  protected abstract emitState(state: VoiceState): void

  /** Deliver one interim/final transcript. */
  protected abstract emitTranscript(text: string, isFinal: boolean): void

  /** Deliver a failure. Never carries audio, only a reason. */
  protected abstract emitError(message: string): void

  // -- Lifecycle ---------------------------------------------------------------

  /** Update the voice server port (e.g., after the engine respawned). */
  updatePort(port: number): void {
    this.port = port
  }

  /** Current state — the registry uses it to decide whether a capture is live. */
  currentState(): VoiceState {
    return this.state
  }

  /**
   * Start a voice recording session.
   *
   * `earlyBuffer` is audio captured before the server was reachable (the desktop
   * starts its microphone the instant the button is pressed, and a remote client
   * may have frames in flight before `voice:start` resolved). It is flushed in
   * order ahead of live audio once the server reports `ready`.
   */
  async startRecording(language: string, earlyBuffer: Buffer[] = []): Promise<void> {
    // Only start from a clean idle state. Previously `connecting` was also
    // admitted, but a second startRecording during the connect window builds a
    // second socket that orphans the first; the first socket's eventual 'close'
    // then runs handleDisconnect → cleanup and tears down the *active* session.
    if (this.state !== 'idle') {
      logger.warn(this.logSource, `Cannot start recording in state: ${this.state}`)
      return
    }

    this.setState('connecting')
    this.audioBuffer = [...earlyBuffer]
    this.streamReady = false

    try {
      // Connect to the voice server in cli.js
      this.conn = await this.connect()

      // Set up message handling
      this.conn.rl.on('line', (line) => this.handleMessage(line))
      this.conn.socket.on('close', () => this.handleDisconnect())
      this.conn.socket.on('error', (err) => {
        logger.error(this.logSource, `Socket error: ${err.message}`)
        this.emitError(`Connection error: ${err.message}`)
        this.cleanup()
      })

      // Send voice_start command
      this.sendToServer({ type: 'voice_start', language })

      if (!this.startAudioSource()) {
        this.emitError(this.audioSourceFailureMessage())
        this.cleanup()
        return
      }

      // Will transition to 'recording' on 'ready' message from voice server
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(this.logSource, `Failed to start recording: ${msg}`)
      this.emitError(`Failed to connect to voice server: ${msg}`)
      this.cleanup()
    }
  }

  /** Stop the current recording session */
  async stopRecording(): Promise<void> {
    if (this.state === 'idle') return

    // Stop audio capture immediately
    this.stopAudioSource()

    if (this.conn && this.streamReady) {
      this.setState('processing')
      this.sendToServer({ type: 'voice_stop' })

      // Safety: if cli.js doesn't send 'closed' within 8s, force cleanup.
      // hb8's safety timeout is 5s, so 8s gives plenty of margin.
      //
      // CLEARED by cleanup(), which is what the normal path takes seconds
      // earlier when `closed` arrives. Left armed, it holds the event loop open
      // for 8 s past a finished capture — invisible in the desktop app, but it
      // charged every teardown of a test that ended a capture, and a timer whose
      // work is already done is exactly what the quiet-event-loop pass removed
      // elsewhere.
      this.finalizeTimer = setTimeout(() => {
        this.finalizeTimer = null
        if (this.state === 'processing') {
          logger.warn(this.logSource, 'Finalization timeout — forcing cleanup')
          this.cleanup()
        }
      }, 8000)
      // The server will send remaining transcripts, then 'closed'
    } else {
      this.cleanup()
    }
  }

  /** Clean up and destroy this client */
  destroy(): void {
    this.stopAudioSource()
    this.cleanup()
  }

  // -- Audio in ----------------------------------------------------------------

  /**
   * Hand one PCM chunk to the server, or buffer it until the Deepgram socket is
   * up. Called by the concrete source — native `onData`, or a remote frame.
   *
   * Chunks that arrive when this client is neither connecting nor recording are
   * DROPPED rather than buffered: they belong to a capture that has ended, and
   * queuing them would flush stale speech into the next one.
   */
  protected pushAudio(chunk: Buffer): void {
    if (this.state !== 'recording' && this.state !== 'connecting') return
    if (this.streamReady && this.conn) {
      this.sendToServer({ type: 'audio', data: chunk.toString('base64') })
    } else {
      this.audioBuffer.push(chunk)
    }
  }

  // -- Private -----------------------------------------------------------------

  private connect(): Promise<VoiceServerConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, '127.0.0.1')
      const rl = readline.createInterface({ input: socket })
      // `readline` attaches its OWN 'error' forwarder to the input stream, and it
      // re-emits on the Interface — which, with no listener, hits EventEmitter's
      // unhandled-'error' rule and THROWS. Two consequences, both bad and both
      // real: an ordinary mid-capture engine death (`ECONNRESET` on this socket)
      // becomes an uncaughtException in the main process, and because readline's
      // forwarder is attached FIRST it throws before the socket handler below can
      // run — so the capture is never cleaned up either. Found as an unhandled
      // ECONNRESET while testing `RemoteServer.stop()` with a live capture.
      rl.on('error', () => {
        /* the socket's own handler owns the failure; this only defuses the throw */
      })

      // Connection timeout — only for the initial handshake
      const connectTimer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.on('connect', () => {
        clearTimeout(connectTimer)
        // Disable idle timeout — the socket may be idle for seconds during
        // voice finalization (Deepgram safety timeout is 5s)
        socket.setTimeout(0)
        resolve({ socket, rl })
      })

      socket.on('error', (err) => {
        clearTimeout(connectTimer)
        reject(err)
      })
    })
  }

  private handleMessage(line: string): void {
    let msg: { type: string; text?: string; isFinal?: boolean; message?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      logger.warn(this.logSource, `Invalid JSON from voice server: ${line.slice(0, 100)}`)
      return
    }

    switch (msg.type) {
      case 'ready':
        this.streamReady = true
        this.setState('recording')
        // Flush buffered audio
        if (this.conn) {
          for (const buf of this.audioBuffer) {
            this.sendToServer({ type: 'audio', data: buf.toString('base64') })
          }
        }
        this.audioBuffer = []
        break

      case 'transcript':
        if (msg.text !== undefined && msg.isFinal !== undefined) {
          this.emitTranscript(msg.text, msg.isFinal)
        }
        break

      case 'error':
        logger.error(this.logSource, `Voice server error: ${msg.message}`)
        this.emitError(msg.message || 'Unknown voice error')
        break

      case 'closed':
        this.cleanup()
        break

      default:
        break
    }
  }

  /**
   * The socket to cli.js died. That is also how an ENGINE DEATH reaches us: the
   * TCP server lives inside the cli.js child, so a crashed or reaped child
   * closes every voice socket it was serving, and a capture that has lost its
   * transcriber must end rather than keep accepting audio.
   */
  private handleDisconnect(): void {
    if (this.state !== 'idle') this.cleanup()
  }

  private sendToServer(msg: Record<string, unknown>): void {
    if (!this.conn) return
    try {
      this.conn.socket.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      logger.error(this.logSource, `Failed to send to voice server: ${err}`)
    }
  }

  private setState(state: VoiceState): void {
    this.state = state
    this.emitState(state)
  }

  protected cleanup(): void {
    this.stopAudioSource()
    this.streamReady = false
    this.audioBuffer = []
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }

    if (this.conn) {
      try {
        this.conn.rl.close()
        this.conn.socket.destroy()
      } catch {
        /* ignore */
      }
      this.conn = null
    }

    this.setState('idle')
  }
}
