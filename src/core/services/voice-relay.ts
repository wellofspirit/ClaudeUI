/**
 * Voice relay — the main process's half of voice input, for every client.
 *
 * Capture happens in a RENDERER: the desktop window and a remote web client run
 * the same Web Audio implementation (`renderer/src/lib/voice/`), which pushes
 * 16 kHz i16LE PCM here. The main process owns no microphone at all — it used to
 * load Claude Code's native `audio-capture` module for the desktop, which binds
 * the OS default input at start and exposes no device API, and that was the
 * reason to move. What is left here is the join: PUSHED audio from one capture
 * owner, fed into the cli.js voice-server protocol ({@link VoiceStreamClient}),
 * with the transcripts routed back to that ONE owner.
 *
 * ## Capture owners
 *
 * An owner is an opaque KEY plus a DELIVERY strategy ({@link VoiceOwner}):
 *
 *  - a remote browser — key = its WebSocket `connectionId`, delivery = targeted
 *    `stream-ev` lane frames to that socket ({@link remoteVoiceOwner});
 *  - the desktop window — key = `desktop:<webContents.id>`, delivery =
 *    `voice:state` / `voice:transcript` sent to that window's webContents, and
 *    `voice:error` through the funnel ({@link desktopVoiceOwner}; see its
 *    `error` for why that one channel is different).
 *
 * The audio arrives on the owner's own wire — the `voice-audio` lane frame for a
 * socket, the `voice:audio` IPC message for the desktop window — and both land
 * in {@link VoiceRelayRegistry.feed} under the owner's key.
 *
 * ## The three rules that make it safe
 *
 * 1. **One capture per owner.** Starting voice for a second session stops the
 *    first. Not a limitation to work around — a client has one microphone, and a
 *    model where two captures on one owner could interleave would need
 *    per-frame stream identity for no user-visible gain.
 * 2. **Audio is refused unless a capture is live for that exact owner.** A stray
 *    or replayed audio frame is dropped in silence, with no answer — the same
 *    no-oracle discipline stale `term-input` follows: an error would tell a
 *    prober whether a capture exists.
 * 3. **Nothing about the audio is ever logged or audited.** Microphone content
 *    is keystrokes (security.md §Audit). The CONTROL verbs (`voice:start` /
 *    `voice:stop` remotely, `voice:start-recording` / `voice:stop-recording` on
 *    the desktop) run through the command registry and are audited like any
 *    other command, which is the honest line: who turned a microphone on and
 *    when is a security fact; what they said is not ours to record.
 *
 * ## Lifetime
 *
 * A capture dies with whatever it depends on, and every one of those is already
 * a signal we have:
 *  - the owner says stop;
 *  - the OWNER dies — a socket closes (including ADR-054's 4010 max-age cut,
 *    which closes it) or the desktop window's webContents is destroyed — and
 *    {@link VoiceRelayRegistry.releaseOwner} runs from the place that notices
 *    (`remote-server.ts`'s close handler; `main/ipc/voice-feed.ts`);
 *  - the ENGINE dies, which closes the TCP socket to the voice server inside it;
 *    {@link VoiceStreamClient} treats that as a disconnect and cleans up, and the
 *    resulting `idle` transition retires the registry entry.
 */

import { emitEvent, sendToStreamConnection } from './sync-host'
import { logger } from './logger'
import { VoiceStreamClient } from './voice-stream-client'
import { VOICE_UNSUPPORTED, voiceRefusal } from './voice-gate'
import type { SessionManager } from './session-manager'
import type { HostWindowHandle } from '../host'
import type { StreamEventFrame } from '../shared/sync/stream'
import type { VoiceState } from '../../shared/types'

const LOG_SOURCE = 'VoiceRelay'

/**
 * Cap on ONE decoded audio frame.
 *
 * The capture posts ~150 ms batches, which is 4800 bytes of 16 kHz i16LE mono —
 * 32 KB is a full second of audio and roughly seven times any honest frame, so
 * it bounds a hostile sender without constraining a real one. Bounded for the
 * same reason `MAX_STREAM_WATCH` is: the length is chosen by a client and the
 * work happens in the main process.
 */
export const MAX_VOICE_FRAME_BYTES = 32 * 1024

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/** Where one owner's voice emissions go. Never carries audio. */
export interface VoiceDelivery {
  state(routingId: string, state: VoiceState): void
  transcript(routingId: string, text: string, isFinal: boolean): void
  error(routingId: string, message: string): void
}

export interface VoiceOwner {
  /** Opaque, unique per owner; the key {@link VoiceRelayRegistry.feed} matches against. */
  readonly key: string
  /** The voice-server client's log tag, so the two kinds stay separable in the log. */
  readonly logSource: string
  readonly delivery: VoiceDelivery
  /**
   * Announce `connecting` the moment a start is accepted, and `idle` when that
   * pending start is cancelled or fails — rather than only once the voice server
   * is reachable.
   *
   * The desktop has always done this (a first press spawns cli.js, seconds during
   * which the mic button should already read as live), and moving its capture
   * into the renderer was not meant to change what the window shows. A remote
   * owner never did, and its tests pin that a cancelled pending start tells the
   * client nothing; unifying the two is lifecycle work, not part of the move.
   */
  readonly announcesPendingStart: boolean
}

/**
 * A remote browser: the socket that started the capture is the one the
 * transcripts go back to, as PASS-THROUGH lane frames carrying the channel and
 * args verbatim, so the web client dispatches them into the very same
 * per-channel listeners the desktop path feeds — `session-store`'s `voiceState`
 * / `voiceInterimTranscript`, and `addError` for a failure. The transport moved;
 * the meaning did not, and there is no second interpretation of a transcript to
 * drift.
 *
 * Its failures are TARGETED too, and therefore never touch the `voice:error`
 * ring entry the desktop raises. See the NOTE in `shared/sync/channels.ts`.
 */
export function remoteVoiceOwner(connectionId: string): VoiceOwner {
  const deliver = (channel: string, args: unknown[]): void => {
    const frame: StreamEventFrame = { type: 'stream-ev', channel, args }
    sendToStreamConnection(connectionId, frame)
  }
  return {
    key: connectionId,
    logSource: 'RemoteVoice',
    announcesPendingStart: false,
    delivery: {
      state: (routingId, state) => deliver('voice:state', [routingId, state]),
      transcript: (routingId, text, isFinal) =>
        deliver('voice:transcript', [routingId, { text, isFinal }]),
      error: (routingId, message) => deliver('voice:error', [routingId, message])
    }
  }
}

/**
 * The desktop owner key for a webContents. ONE derivation, shared by the start
 * (`session.ipc.ts`) and the audio feed (`main/ipc/voice-feed.ts`) — a mismatch
 * would drop every frame in silence, which is exactly what rule 2 is for.
 */
export function desktopVoiceOwnerKey(webContentsId: number): string {
  return `desktop:${webContentsId}`
}

/**
 * The desktop window.
 *
 * `voice:state` / `voice:transcript` are HOST-LOCAL (microphone capture belongs to
 * the window holding the microphone), so they go to this window's webContents
 * and nowhere else. Guarded: the window can be destroyed while a capture is still
 * finalizing (closed mid-transcription), and sending to a destroyed webContents
 * throws — which would surface as an uncaughtException. `isDestroyed?.()`
 * tolerates the plain test double.
 *
 * `voice:error` is the one channel that is NOT host-local, and goes through the
 * funnel instead. It is classified `replicated` (rings, reaches every client) —
 * an anomaly `shared/sync/channels.ts` records rather than papers over — and
 * since SyncCore phase 4c the desktop renderer subscribes to it on the sync
 * transport, so a targeted `webContents.send` would land nowhere. A remote
 * owner's errors never come through here and never enter the event lane at all.
 */
export function desktopVoiceOwner(win: HostWindowHandle): VoiceOwner {
  const wc = win.webContents
  // The ONE computed-channel window send, and every literal handed to it is
  // host-local — which is what sync-funnel-guard.test.ts checks of this file.
  const host = {
    send(channel: string, args: unknown[]): void {
      if (win.isDestroyed?.() || wc.isDestroyed?.()) return
      wc.send(channel, ...args)
    }
  }
  return {
    key: desktopVoiceOwnerKey(wc.id),
    logSource: 'DesktopVoice',
    announcesPendingStart: true,
    delivery: {
      state: (routingId, state) => host.send('voice:state', [routingId, state]),
      transcript: (routingId, text, isFinal) =>
        host.send('voice:transcript', [routingId, { text, isFinal }]),
      error: (routingId, message) => emitEvent('voice:error', [routingId, message])
    }
  }
}

// ---------------------------------------------------------------------------
// The voice-server client
// ---------------------------------------------------------------------------

/**
 * A capture whose audio is PUSHED in from a renderer rather than pulled from a
 * device.
 *
 * `startAudioSource` has nothing to start — by the time the start resolves, the
 * renderer is already producing frames, and any that arrived early were buffered
 * by the base class's pre-`ready` queue.
 */
class RelayVoiceClient extends VoiceStreamClient {
  constructor(
    port: number,
    private readonly owner: VoiceOwner,
    /**
     * Read per emit, never copied: a brand-new session's routing id is REKEYED
     * when cli.js mints its id — usually mid-capture, because the first press is
     * what spawns cli.js. A copied id keeps emitting on the old key, which the
     * client drops.
     */
    private readonly getRoutingId: () => string,
    /** Called on every transition to `idle`, so the registry can retire us. */
    private readonly onIdle: () => void
  ) {
    super(port, owner.logSource)
  }

  /** One decoded PCM chunk from the owner. */
  feed(chunk: Buffer): void {
    this.pushAudio(chunk)
  }

  protected startAudioSource(): boolean {
    return true
  }

  protected stopAudioSource(): void {
    /* The source is the renderer; there is nothing local to switch off. */
  }

  /**
   * Unreachable today — {@link RelayVoiceClient.startAudioSource} cannot fail,
   * because there is no device here to refuse. Stated rather than left to a
   * default so the base class has no wording of its own to fall back on, and so
   * a future push source that CAN fail has an honest message waiting.
   */
  protected audioSourceFailureMessage(): string {
    return 'Failed to start audio capture.'
  }

  protected emitState(state: VoiceState): void {
    this.owner.delivery.state(this.getRoutingId(), state)
    if (state === 'idle') this.onIdle()
  }

  protected emitTranscript(text: string, isFinal: boolean): void {
    this.owner.delivery.transcript(this.getRoutingId(), text, isFinal)
  }

  protected emitError(message: string): void {
    this.owner.delivery.error(this.getRoutingId(), message)
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface Entry {
  client: RelayVoiceClient
}

interface PendingStart {
  gen: number
  owner: VoiceOwner
  /** Read at cancellation, so a cancelled desktop start reports idle under the live id. */
  routingId: () => string
}

export class VoiceRelayRegistry {
  private entries = new Map<string, Entry>()
  /**
   * Per owner, the start still awaiting the voice server (a first start spawns
   * cli.js — seconds). {@link VoiceRelayRegistry.stop} deletes it, so a start
   * that wakes without its generation here was cancelled and must not open a
   * capture nobody is holding.
   */
  private pendingStarts = new Map<string, PendingStart>()
  private startGen = 0

  /**
   * Bind this owner's audio to `routingId`'s voice server and start relaying.
   *
   * Claude-engine only (`capabilities.voice` — the voice server is a cli.js
   * patch, so there is nothing to talk to on opencode or pi, or on a Claude Code
   * binary without the patch). Throws on refusal: unlike the audio frames, the
   * control verb is a request the caller is entitled to an answer to.
   */
  async start(
    manager: SessionManager,
    owner: VoiceOwner,
    routingId: string,
    language?: string
  ): Promise<void> {
    if (typeof routingId !== 'string' || routingId === '') {
      throw new Error('voice:start requires a session id')
    }
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    const refusal = voiceRefusal(session)
    if (refusal) throw new Error(refusal)
    if (!session.voiceStartServer) throw new Error(VOICE_UNSUPPORTED)

    const key = owner.key
    const liveRoutingId = (): string => session.routingId

    // Registered before anything awaits, so a stop that lands at any point from
    // here on cancels this start. Overwriting also cancels an older start still
    // pending for this owner.
    const gen = ++this.startGen
    this.pendingStarts.set(key, { gen, owner, routingId: liveRoutingId })

    // One microphone per owner (rule 1). Stopping first also means a client that
    // lost track of its own state can always recover by starting again.
    // `endCapture`, not `stop`: that would cancel this very start.
    await this.endCapture(key)

    // Announced AFTER the previous capture has begun finalizing, so its
    // `processing` cannot land on top of this start's `connecting`; and only if
    // this start survived that await (a stop in it has already reported idle).
    if (owner.announcesPendingStart && this.pendingStarts.get(key)?.gen === gen) {
      owner.delivery.state(liveRoutingId(), 'connecting')
    }

    let server: { port: number }
    try {
      server = await session.voiceStartServer()
    } catch (err) {
      // Cancelled while spawning: the stop already answered; this is not its failure.
      if (this.pendingStarts.get(key)?.gen !== gen) return
      this.pendingStarts.delete(key)
      if (owner.announcesPendingStart) owner.delivery.state(liveRoutingId(), 'idle')
      throw err
    }
    // A stop, a newer start or the owner going away landed during the spawn.
    if (this.pendingStarts.get(key)?.gen !== gen) return
    this.pendingStarts.delete(key)
    const { port } = server
    if (!port) {
      if (owner.announcesPendingStart) owner.delivery.state(liveRoutingId(), 'idle')
      throw new Error('Voice server failed to return a port')
    }

    const client = new RelayVoiceClient(port, owner, liveRoutingId, () => {
      // Retire only if we are still the live entry: a stop-then-start in the same
      // tick would otherwise have the OLD client's idle transition delete the new
      // one's registration and silently drop every frame that follows.
      if (this.entries.get(key)?.client === client) this.entries.delete(key)
    })
    this.entries.set(key, { client })

    try {
      await client.startRecording(language && language !== '' ? language : 'en')
    } catch (err) {
      this.entries.delete(key)
      client.destroy()
      throw err
    }
  }

  /**
   * One inbound audio frame for `ownerKey`.
   *
   * Silent about everything: no capture, an oversized payload and undecodable
   * base64 all return without an answer and without logging the payload. The
   * only thing worth a log line is the oversize case, and it says the size and
   * nothing else — a length is already more than we would print about audio if
   * it were not needed to diagnose a client that batches wrong.
   */
  feed(ownerKey: string, dataB64: unknown): void {
    const entry = this.entries.get(ownerKey)
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
   * End this owner's capture, if it has one. Idempotent, and awaited by the stop
   * verb so the client knows finalization has begun — the remaining transcripts
   * still arrive asynchronously.
   */
  async stop(ownerKey: string): Promise<void> {
    const pending = this.pendingStarts.get(ownerKey)
    this.pendingStarts.delete(ownerKey)
    // The owner was told `connecting` for a start that will now never open; a
    // release must always leave it idle.
    if (pending?.owner.announcesPendingStart) {
      pending.owner.delivery.state(pending.routingId(), 'idle')
    }
    await this.endCapture(ownerKey)
  }

  /** Finalize this owner's live capture, leaving any pending start alone. */
  private async endCapture(ownerKey: string): Promise<void> {
    const entry = this.entries.get(ownerKey)
    if (!entry) return
    this.entries.delete(ownerKey)
    await entry.client.stopRecording()
  }

  /**
   * The owner died (a socket closed — including ADR-054's 4010 max-age cut — or
   * the desktop window's webContents was destroyed). Tear the capture down
   * without waiting on finalization: there is nobody left to deliver a
   * transcript to, and the point is that no authority outlives its owner.
   */
  releaseOwner(ownerKey: string): void {
    this.pendingStarts.delete(ownerKey)
    const entry = this.entries.get(ownerKey)
    if (!entry) return
    this.entries.delete(ownerKey)
    entry.client.destroy()
  }

  /** Is a capture live for this owner? Diagnostics + tests. */
  isCapturing(ownerKey: string): boolean {
    return this.entries.has(ownerKey)
  }

  /** Drop every capture. Test seam only. */
  clearForTests(): void {
    for (const ownerKey of [...this.entries.keys()]) this.releaseOwner(ownerKey)
    this.pendingStarts.clear()
  }
}

/** The one registry both transports feed. */
export const voiceRelay = new VoiceRelayRegistry()
