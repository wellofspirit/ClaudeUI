/**
 * The cli.js voice-server protocol, once — SyncCore phase 5 S3.
 *
 * Audio streams into the transcription server the `voice-server` patch opens
 * inside cli.js (patch/voice-server/README.md). Since the voice-input rework the
 * only concrete client is the relay's push-fed one (`services/voice-relay.ts`):
 * every capture — the desktop window's and a remote browser's — runs in a
 * renderer and pushes PCM to the main process. Owners still differ in where the
 * transcripts go, and agree about everything else: the TCP connect, the
 * newline-JSON framing, the pre-`ready` buffer, the state machine, the
 * finalization timeout, the teardown.
 *
 * So that half lives here and is written once, with the audio SOURCE and the
 * DELIVERY as the abstract members below. It was extracted when there were two
 * sources (the desktop's native microphone and the remote browser) and is kept
 * as the seam: a second copy of the protocol would be a second place for the
 * `connecting`-window race (see {@link VoiceStreamClient.startRecording}) and the
 * finalize timeout to be got subtly wrong, and both were bugs here already.
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
 * The one thing read OUT of the audio is a level, kept in memory to choose an
 * outcome message ({@link VoiceStreamClient.outcomeMessage}) and never written
 * anywhere.
 *
 * ## No press is silently lost
 *
 * A stop that lands before the server is `ready` — a short press on a cold
 * engine, which is most first presses — used to tear the stream down and
 * discard the buffered audio with no word to anyone. It now DRAINS: the stop is
 * recorded, the source stops, and when `ready` arrives the buffer is flushed and
 * finalized exactly as a stop after `ready` would be. Only an owner death
 * ({@link VoiceStreamClient.destroy}) or a failure discards. What can still go
 * wrong is bounded and said out loud: a `ready` that never comes times out
 * ({@link READY_TIMEOUT_MS}), an `error` before `ready` ends the capture, and a
 * capture that ends with no transcript says why.
 */

import * as net from 'net'
import * as readline from 'readline'
import { logger } from './logger'
import { pcm16Level } from '../../shared/audio/pcm16'
import type { VoiceNoticeTone, VoiceState } from '../../shared/types'

/** How long a connected voice socket may wait for the server's `ready`. */
export const READY_TIMEOUT_MS = 10_000
/** How long a stopped capture may wait for the server's `closed`. */
const FINALIZE_TIMEOUT_MS = 8_000
/**
 * The shortest capture an empty result is worth explaining. A blip of a press
 * that produced nothing is not a mystery; two seconds of silence is. cli.js's own
 * `/voice` uses the same threshold (on wall-clock; this measures the audio
 * actually relayed, which is the same thing without the spawn wait in it).
 */
export const OUTCOME_MIN_AUDIO_MS = 2_000
/** 16 kHz i16LE mono — the voice server's wire format. */
const PCM_BYTES_PER_MS = 32

// Worded for the renderer's notice pill above the mic: short, no trailing full
// stop, the fix after an em dash.
export const VOICE_READY_TIMEOUT_MESSAGE = 'Voice transcription didn’t start — try again'
export const VOICE_NO_AUDIO_MESSAGE =
  'No audio from microphone — check the input device and microphone access'
export const VOICE_NO_SPEECH_MESSAGE = 'No speech detected'

/**
 * One relayed chunk's level — `shared/audio/pcm16.ts`'s {@link pcm16Level}, the
 * same formula the renderer's capture uses for its level ring, over the chunk's
 * i16LE bytes. Read with an explicit byte order, never by aliasing the buffer.
 */
export function pcm16LevelLe(chunk: Buffer): number {
  const samples = new Int16Array(chunk.length >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = chunk.readInt16LE(i * 2)
  return pcm16Level(samples)
}

/** Above this a chunk counts as signal (cli.js: `hadAudioSignal`). */
const SIGNAL_LEVEL = 0.01

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
  /** The `ready` deadline, armed once the socket connects; cleared by `ready`/cleanup. */
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The owner has released. Before `ready` this is the DRAIN: nothing more is
   * accepted, what is buffered waits for `ready`, and `ready` finalizes.
   */
  private stopRequested = false
  /**
   * What this capture's audio and transcripts amounted to, for the outcome
   * message. A level and a byte count — never the audio.
   */
  private hadSignal = false
  private hadTranscript = false
  private relayedBytes = 0
  /** Something already told the owner why (an error); no outcome message on top. */
  private outcomeSaid = false
  /**
   * Bumped by every start and every {@link VoiceStreamClient.cleanup}, so a start
   * whose connect resolves after a stop (or after a newer start) can tell it has
   * been superseded. See {@link VoiceStreamClient.startRecording}.
   */
  private startGen = 0

  /** Log tag — the owner kind, so desktop and remote captures stay separable. */
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
   * Per-source, because the wording is user-facing and only the source knows
   * what refusing means for it. A push source cannot refuse today, but states its
   * message rather than inheriting one.
   */
  protected abstract audioSourceFailureMessage(): string

  /** Deliver a state transition to whoever owns this capture's UI. */
  protected abstract emitState(state: VoiceState): void

  /** Deliver one interim/final transcript. */
  protected abstract emitTranscript(text: string, isFinal: boolean): void

  /**
   * Deliver a voice message — a failure, or the outcome of a capture that
   * produced nothing. Never carries audio, only a reason. `tone` is how the
   * notice pill reads it: `info` for an outcome ("No speech detected"), `warn`
   * (the default) for an error or something to fix.
   */
  protected abstract emitError(message: string, tone?: VoiceNoticeTone): void

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
   * `earlyBuffer` is audio captured before the server was reachable. It is
   * flushed in order ahead of live audio once the server reports `ready`. The
   * relay passes none: a renderer holds its own pre-arm queue until the start
   * resolves, and anything pushed after that is buffered here like live audio.
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

    const gen = ++this.startGen
    this.setState('connecting')
    this.audioBuffer = []
    this.streamReady = false
    this.stopRequested = false
    this.hadSignal = false
    this.hadTranscript = false
    this.relayedBytes = 0
    this.outcomeSaid = false
    for (const chunk of earlyBuffer) this.pushAudio(chunk)

    try {
      // Connect to the voice server in cli.js
      const conn = await this.connect()

      // A cleanup during the connect window (owner death, a failure) already
      // reported idle. Adopting this socket would resurrect a capture nobody is
      // holding, so drop it — before any handler is attached, so its 'close'
      // cannot tear down a newer capture. A plain STOP in that window does not
      // land here: it only marks the drain, and this connect proceeds into it.
      if (gen !== this.startGen) {
        conn.rl.close()
        conn.socket.destroy()
        return
      }
      this.conn = conn

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

      // A server that accepts the socket but never says `ready` (Deepgram never
      // answering) would otherwise leave the owner in `connecting` forever —
      // and, since a drain waits for `ready`, swallow a released press too.
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null
        if (this.streamReady || gen !== this.startGen) return
        logger.warn(this.logSource, 'Voice server never reported ready — giving up')
        this.emitError(VOICE_READY_TIMEOUT_MESSAGE)
        this.cleanup()
      }, READY_TIMEOUT_MS)

      // Released while connecting: the source is already stopped; drain.
      if (this.stopRequested) return

      if (!this.startAudioSource()) {
        this.emitError(this.audioSourceFailureMessage())
        this.cleanup()
        return
      }

      // Will transition to 'recording' on 'ready' message from voice server
    } catch (err) {
      // A superseded start's failed connect is not this capture's failure.
      if (gen !== this.startGen) return
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(this.logSource, `Failed to start recording: ${msg}`)
      this.emitError(`Failed to connect to voice server: ${msg}`)
      this.cleanup()
    }
  }

  /**
   * Stop the current recording session.
   *
   * After `ready`: finalize now. Before it — connected or still connecting —
   * DRAIN: stop the source, keep what is buffered, and let `ready` flush and
   * finalize it (see the header). Never a discard; that is
   * {@link VoiceStreamClient.destroy}'s job.
   */
  async stopRecording(): Promise<void> {
    // `processing` is already stopping, and a drain is already a stop: a second
    // `voice_stop` is noise to the server, and a second finalize timer would
    // orphan the first one's handle.
    if (this.state === 'idle' || this.state === 'processing' || this.stopRequested) return

    this.stopRequested = true
    // Stop audio capture immediately
    this.stopAudioSource()

    if (this.conn && this.streamReady) this.beginFinalize()
    // else: draining — `ready`, the ready timeout or a failure decides what's next.
  }

  /** `voice_stop`, `processing`, and the safety net for a `closed` that never comes. */
  private beginFinalize(): void {
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
    }, FINALIZE_TIMEOUT_MS)
    // The server will send remaining transcripts, then 'closed'
  }

  /** Clean up and destroy this client */
  destroy(): void {
    this.stopAudioSource()
    this.cleanup()
  }

  // -- Audio in ----------------------------------------------------------------

  /**
   * Hand one PCM chunk to the server, or buffer it until the Deepgram socket is
   * up. Called by the concrete source — one pushed frame from a renderer.
   *
   * Chunks that arrive when this client is neither connecting nor recording —
   * or after a stop — are DROPPED rather than buffered: they belong to a capture
   * that has ended, and queuing them would flush stale speech into the next one.
   * (Both transports carry audio and the stop verb on one ordered channel, so a
   * renderer's drained queue arrives BEFORE the stop, never after it.)
   */
  protected pushAudio(chunk: Buffer): void {
    if (this.state !== 'recording' && this.state !== 'connecting') return
    if (this.stopRequested) return
    this.relayedBytes += chunk.length
    if (!this.hadSignal && pcm16LevelLe(chunk) > SIGNAL_LEVEL) this.hadSignal = true
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
        if (this.streamReady) break
        this.clearReadyTimer()
        this.streamReady = true
        // A drain skips `recording`: the owner already let go.
        if (!this.stopRequested) this.setState('recording')
        // Flush buffered audio
        if (this.conn) {
          for (const buf of this.audioBuffer) {
            this.sendToServer({ type: 'audio', data: buf.toString('base64') })
          }
        }
        this.audioBuffer = []
        // Released before `ready`: what was said is flushed; finalize it now.
        if (this.stopRequested) this.beginFinalize()
        break

      case 'transcript':
        if (msg.text !== undefined && msg.isFinal !== undefined) {
          if (msg.text.trim() !== '') this.hadTranscript = true
          this.emitTranscript(msg.text, msg.isFinal)
        }
        break

      case 'error':
        logger.error(this.logSource, `Voice server error: ${msg.message}`)
        this.outcomeSaid = true
        this.emitError(msg.message || 'Unknown voice error')
        // Before `ready` there is no stream to keep: the owner would otherwise sit
        // in `connecting` with nothing coming. After it, the server carries on.
        if (!this.streamReady) this.cleanup()
        break

      case 'closed': {
        // A stop that finalized normally — the only end an outcome message is for.
        const outcome = this.state === 'processing' ? this.outcomeMessage() : null
        if (outcome) this.emitError(outcome.message, outcome.tone)
        this.cleanup()
        break
      }

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

  /**
   * Why a capture that finalized normally produced nothing, or null. Mirrors
   * cli.js's own `/voice`: only for a capture long enough to be a real attempt,
   * only with no non-empty transcript, and never when an error already spoke.
   */
  private outcomeMessage(): { message: string; tone: VoiceNoticeTone } | null {
    if (this.outcomeSaid || this.hadTranscript) return null
    if (this.relayedBytes < OUTCOME_MIN_AUDIO_MS * PCM_BYTES_PER_MS) return null
    // Heard sound but no words is an OUTCOME (grey). Heard nothing at all is
    // something to fix — the wrong input device, a closed lid (amber).
    return this.hadSignal
      ? { message: VOICE_NO_SPEECH_MESSAGE, tone: 'info' }
      : { message: VOICE_NO_AUDIO_MESSAGE, tone: 'warn' }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
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
    this.startGen++
    this.stopAudioSource()
    this.streamReady = false
    this.stopRequested = false
    this.audioBuffer = []
    this.clearReadyTimer()
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
