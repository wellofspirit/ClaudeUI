/**
 * Remote browser voice input — SyncCore phase 5 S3.
 *
 * "I want to be able to do voice input remotely." Headless mode has no
 * microphone and no window, so voice cannot stay a host-only surface; the
 * transcription server itself, however, is inside cli.js and is not going
 * anywhere. This module is the join: a capture whose AUDIO arrives as lane
 * frames from one WebSocket connection, fed into the same
 * {@link VoiceStreamClient} protocol the desktop microphone uses, with the
 * transcripts routed back to that ONE connection.
 *
 * ## The three rules that make it safe
 *
 * 1. **One capture per connection.** Starting voice for a second session stops
 *    the first. Not a limitation to work around — a browser has one microphone,
 *    and a model where two captures on one socket could interleave would need
 *    per-frame stream identity for no user-visible gain.
 * 2. **Audio is refused unless a capture is live on that exact connection.** A
 *    stray or replayed `voice-audio` frame is dropped in silence, with no answer
 *    — the same no-oracle discipline stale `term-input` follows: an error would
 *    tell a prober whether a capture exists.
 * 3. **Nothing about the audio is ever logged or audited.** Microphone content
 *    is keystrokes (security.md §Audit). The CONTROL verbs (`voice:start` /
 *    `voice:stop`) run through the command registry and are audited like any
 *    other command, which is the honest line: who turned a microphone on and
 *    when is a security fact; what they said is not ours to record.
 *
 * ## Lifetime
 *
 * A capture dies with whatever it depends on, and every one of those is already
 * a signal we have:
 *  - the client says `voice:stop`;
 *  - the socket closes — including ADR-054's 4010 max-age cut, which closes it —
 *    and {@link RemoteVoiceRegistry.releaseConnection} runs from the same place
 *    the PTY attachments and git interest are released;
 *  - the ENGINE dies, which closes the TCP socket to the voice server inside it;
 *    {@link VoiceStreamClient} treats that as a disconnect and cleans up, and the
 *    resulting `idle` transition retires the registry entry.
 */

import { sendToStreamConnection } from './sync-host'
import { logger } from './logger'
import { VoiceStreamClient } from './voice-stream-client'
import type { SessionManager } from './session-manager'
import type { CommandConnection } from '../ipc/command-registry'
import type { StreamEventFrame } from '../shared/sync/stream'
import type { VoiceState } from '../../shared/types'

const LOG_SOURCE = 'RemoteVoice'

/**
 * Cap on ONE decoded `voice-audio` frame.
 *
 * The browser controller posts ~150 ms batches, which is 4800 bytes of 16 kHz
 * i16LE mono — 32 KB is a full second of audio and roughly seven times any
 * honest frame, so it bounds a hostile sender without constraining a real one.
 * Bounded for the same reason `MAX_STREAM_WATCH` is: the length is chosen by a
 * remote client and the work happens in the main process.
 */
export const MAX_VOICE_FRAME_BYTES = 32 * 1024

/**
 * A capture whose audio is PUSHED in from a socket rather than pulled from a
 * device.
 *
 * `startAudioSource` has nothing to start — by the time `voice:start` resolves,
 * the browser is already producing frames, and any that arrived early were
 * buffered by the base class's pre-`ready` queue exactly like the desktop's
 * early-capture buffer.
 */
class RemoteVoiceClient extends VoiceStreamClient {
  constructor(
    port: number,
    private readonly connectionId: string,
    private readonly routingId: string,
    /** Called on every transition to `idle`, so the registry can retire us. */
    private readonly onIdle: () => void
  ) {
    super(port, LOG_SOURCE)
  }

  /** One decoded PCM chunk from the connection. */
  feed(chunk: Buffer): void {
    this.pushAudio(chunk)
  }

  protected startAudioSource(): boolean {
    return true
  }

  protected stopAudioSource(): void {
    /* The source is the socket; there is nothing local to switch off. */
  }

  /**
   * Unreachable today — {@link RemoteVoiceClient.startAudioSource} cannot fail,
   * because there is no device here to refuse. Stated rather than left to a
   * default so the base class has no wording of its own to fall back on, and so
   * a future push source that CAN fail has an honest message waiting.
   */
  protected audioSourceFailureMessage(): string {
    return 'Failed to start audio capture.'
  }

  protected emitState(state: VoiceState): void {
    this.deliver('voice:state', [this.routingId, state])
    if (state === 'idle') this.onIdle()
  }

  protected emitTranscript(text: string, isFinal: boolean): void {
    this.deliver('voice:transcript', [this.routingId, { text, isFinal }])
  }

  /**
   * A remote capture's failures are TARGETED, and therefore never touch the
   * `voice:error` ring entry the desktop's two emitters share. See the NOTE in
   * `shared/sync/channels.ts`: this is the half of that anomaly S3 could fix
   * without reducing ring membership.
   */
  protected emitError(message: string): void {
    this.deliver('voice:error', [this.routingId, message])
  }

  /**
   * The emission goes out as a PASS-THROUGH lane frame carrying the channel and
   * args verbatim, so the web client dispatches it into the very same
   * per-channel listeners the desktop path feeds — `session-store`'s
   * `voiceState` / `voiceInterimTranscript`, and `addError` for a failure. The
   * transport moved; the meaning did not, and there is no second interpretation
   * of a transcript to drift.
   */
  private deliver(channel: string, args: unknown[]): void {
    const frame: StreamEventFrame = { type: 'stream-ev', channel, args }
    sendToStreamConnection(this.connectionId, frame)
  }
}

interface Entry {
  client: RemoteVoiceClient
  routingId: string
}

export class RemoteVoiceRegistry {
  private entries = new Map<string, Entry>()

  /**
   * Bind this connection's audio to `routingId`'s voice server and start
   * capturing.
   *
   * Claude-engine only, matching the desktop's gate exactly (`capabilities.voice`
   * — the voice server is a cli.js patch, so there is nothing to talk to on
   * opencode or pi). Throws on refusal: unlike the audio frames, the control verb
   * is a request the caller is entitled to an answer to.
   */
  async start(
    manager: SessionManager,
    connection: CommandConnection,
    routingId: string,
    language?: string
  ): Promise<void> {
    if (typeof routingId !== 'string' || routingId === '') {
      throw new Error('voice:start requires a session id')
    }
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    if (!session.capabilities.voice || !session.voiceStartServer) {
      throw new Error('Provider does not support voice')
    }

    // One microphone per connection (rule 1). Stopping first also means a client
    // that lost track of its own state can always recover by starting again.
    await this.stop(connection.connectionId)

    const { port } = await session.voiceStartServer()
    if (!port) throw new Error('Voice server failed to return a port')

    const connectionId = connection.connectionId
    const client = new RemoteVoiceClient(port, connectionId, routingId, () => {
      // Retire only if we are still the live entry: a stop-then-start in the same
      // tick would otherwise have the OLD client's idle transition delete the new
      // one's registration and silently drop every frame that follows.
      if (this.entries.get(connectionId)?.client === client) this.entries.delete(connectionId)
    })
    this.entries.set(connectionId, { client, routingId })

    try {
      await client.startRecording(language && language !== '' ? language : 'en')
    } catch (err) {
      this.entries.delete(connectionId)
      client.destroy()
      throw err
    }
  }

  /**
   * One inbound `voice-audio` frame.
   *
   * Silent about everything: no capture, an oversized payload and undecodable
   * base64 all return without an answer and without logging the payload. The
   * only thing worth a log line is the oversize case, and it says the size and
   * nothing else — a length is already more than we would print about audio if
   * it were not needed to diagnose a client that batches wrong.
   */
  feed(connectionId: string, dataB64: unknown): void {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    if (typeof dataB64 !== 'string' || dataB64 === '') return
    // Bound BEFORE decoding: base64 is 4 characters per 3 bytes, so this refuses
    // an over-budget frame without ever allocating its buffer.
    if (dataB64.length > Math.ceil(MAX_VOICE_FRAME_BYTES / 3) * 4) {
      logger.warn(LOG_SOURCE, `Dropped an oversized voice frame (${dataB64.length} b64 chars)`)
      return
    }
    const chunk = Buffer.from(dataB64, 'base64')
    // Undecodable base64 decodes to nothing — dropped like any other frame we
    // cannot use, and not worth a log line a prober could provoke at will.
    if (chunk.length === 0) return
    // The character-count gate above is one BOUNDARY sample coarse (base64 packs
    // 3 bytes into 4 chars, so the last group can carry up to two bytes past the
    // budget). This is the exact one.
    if (chunk.length > MAX_VOICE_FRAME_BYTES) {
      logger.warn(LOG_SOURCE, `Dropped an oversized voice frame (${chunk.length} bytes)`)
      return
    }
    entry.client.feed(chunk)
  }

  /**
   * End this connection's capture, if it has one. Idempotent, and awaited by
   * `voice:stop` so the client knows finalization has begun — the remaining
   * transcripts still arrive asynchronously, exactly as they do on the desktop.
   */
  async stop(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    this.entries.delete(connectionId)
    await entry.client.stopRecording()
  }

  /**
   * The socket died (close, or ADR-054's 4010 max-age cut). Tear the capture
   * down without waiting on finalization: there is nobody left to deliver a
   * transcript to, and the point is that no authority outlives the socket.
   */
  releaseConnection(connectionId: string): void {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    this.entries.delete(connectionId)
    entry.client.destroy()
  }

  /** Is a capture live on this connection? Diagnostics + tests. */
  isCapturing(connectionId: string): boolean {
    return this.entries.has(connectionId)
  }

  /** Drop every capture. Test seam only. */
  clearForTests(): void {
    for (const connectionId of [...this.entries.keys()]) this.releaseConnection(connectionId)
  }
}

/** The one registry the remote transport uses. */
export const remoteVoice = new RemoteVoiceRegistry()
