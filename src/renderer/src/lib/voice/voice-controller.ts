/**
 * The mic button's voice controller — one capture, one transport, every client.
 *
 * Pairs the client's single {@link BrowserVoiceCapture} with the voice TRANSPORT
 * (`window.api.voiceStart` / `voiceAudio` / `voiceStop`): IPC on the desktop,
 * the WebSocket on the web client. The transport only binds pushed audio to a
 * session's transcription server in the main process; the microphone is this
 * side's, on both.
 *
 * The sequencing below used to live in the web client's API adapter while the
 * desktop captured natively in the main process; it is parameterized over
 * {@link VoiceTransport} so both run it.
 *
 * ## A release never loses what was said
 *
 * A short press on a cold engine is the common case: the microphone opens at
 * once, but the transport's start can take seconds (it may spawn cli.js). A
 * release in that window used to close the microphone AND discard everything
 * captured, so the press produced nothing and said nothing. Now a stop:
 *
 *  1. HALTS the capture at once — tracks stopped, recording indicator off — but
 *     keeps its queue;
 *  2. waits for the in-flight start, whose `arm()` flushes that queue (a start
 *     that FAILED discards it instead — there is nowhere to send it);
 *  3. only then tells the transport to stop.
 *
 * Audio frames and the stop verb travel one ordered channel on both transports
 * (`ipcRenderer.send` + `invoke` on one webContents; frames + invoke on one
 * WebSocket), so the flushed frames reach main before the stop does. A release
 * before the microphone has even opened (a permission prompt) still cancels.
 */

import {
  BrowserVoiceCapture,
  micDeniedMessage,
  type CaptureEnv,
  type CaptureSilence
} from './browser-voice-capture'
import { resolveRekeyed } from '../../stores/replica'
import { readMicPreference } from './mic-preference'
import type { MicPreference } from './mic-devices'

/**
 * How long after a stop completes this client still owns that session's voice
 * messages: main's finalize timeout (8 s) plus the voice server's own 5 s safety,
 * with margin — the "No speech detected" outcome arrives at the very end of it.
 */
export const VOICE_OWNERSHIP_WINDOW_MS = 15_000

/** The main-process side of a capture. */
export interface VoiceTransport {
  start(routingId: string, language: string): Promise<void>
  /** One base64 PCM batch. Fire-and-forget. */
  audio(routingId: string, dataB64: string): void
  stop(routingId: string): Promise<void>
}

export interface VoiceController {
  start(routingId: string, language: string): Promise<void>
  stop(routingId: string): Promise<void>
  /** A press is in flight or the microphone is open. */
  isActive(): boolean
  /**
   * Hear about the microphone itself failing mid-capture (unplugged, muted by
   * the OS). An unplug also ends the capture through the normal stop, so what
   * was said still finalizes. Returns the unsubscribe.
   */
  onFault(listener: (message: string) => void): () => void
  /**
   * The live microphone's level (0..1) per ~150 ms block while capturing — the
   * mic's level ring. Returns the unsubscribe.
   */
  onLevel(listener: (level: number) => void): () => void
  /**
   * The live microphone went digitally silent for 1.5 s, or came back (see
   * {@link CaptureSilence}). Returns the unsubscribe.
   */
  onSilence(listener: (silence: CaptureSilence) => void): () => void
  /**
   * The capture moved to another microphone mid-press (a device change, or an
   * unplug it recovered from), with the new one's name. Returns the unsubscribe.
   */
  onSwitch(listener: (label: string) => void): () => void
  /**
   * Did THIS client capture for `routingId` — a capture live now, or one whose
   * stop completed within {@link VOICE_OWNERSHIP_WINDOW_MS}? Rekeys followed.
   *
   * The desktop's `voice:error` is a REPLICATED channel (channels.ts records the
   * anomaly), so every client watching a session hears it. Only the client that
   * held the microphone may show it — another client's pill would read as a
   * fault in ITS microphone.
   */
  ownsRecentCapture(routingId: string): boolean
}

interface StartRun {
  promise: Promise<void>
  /** A stop arrived for this press. Honoured only before the microphone opens. */
  cancelled: boolean
}

/** Subscribe-and-fan-out, for the controller's listener kinds. */
function listeners<T>(): {
  add(listener: (value: T) => void): () => void
  emit(value: T): void
} {
  const set = new Set<(value: T) => void>()
  return {
    add(listener) {
      set.add(listener)
      return () => set.delete(listener)
    },
    emit(value) {
      for (const listener of [...set]) listener(value)
    }
  }
}

export function createVoiceController(
  transport: VoiceTransport,
  options: {
    env?: CaptureEnv
    deniedMessage?: string
    /** The preferred microphone (`mic-preference.ts`); absent = the system default. */
    preference?: () => MicPreference | null
    /** Where a pre-rekey id went (`stores/replica`'s `resolveRekeyed`). Test seam. */
    resolveId?: (routingId: string) => string
  } = {}
): VoiceController {
  const resolveId = options.resolveId ?? resolveRekeyed
  /**
   * Sessions this client captured for → until when it owns their voice messages
   * (`Infinity` while a press is in flight). Pruned on every write and read.
   */
  const owned = new Map<string, number>()
  const prune = (): void => {
    const now = Date.now()
    for (const [id, until] of owned) if (until <= now) owned.delete(id)
  }
  const claim = (routingId: string, until: number): void => {
    prune()
    const live = resolveId(routingId)
    for (const id of [...owned.keys()]) if (resolveId(id) === live) owned.delete(id)
    owned.set(live, until)
  }
  // The session the live capture is bound to. Audio is routed by the CAPTURE'S
  // owner in main, not by this id; it rides along for the transport's shape.
  let boundRoutingId = ''
  let inflight: StartRun | null = null
  let stopping: Promise<void> | null = null
  const faults = listeners<string>()
  const levels = listeners<number>()
  const silences = listeners<CaptureSilence>()
  const switches = listeners<string>()

  // One microphone per client, matching main's one-capture-per-owner rule
  // (core/services/voice-relay.ts). Constructed eagerly and cheaply — it touches
  // no device until `start()`.
  const capture = new BrowserVoiceCapture({
    sendAudio: (dataB64) => transport.audio(boundRoutingId, dataB64),
    env: options.env,
    deniedMessage: options.deniedMessage,
    onLevel: (level) => levels.emit(level),
    onSilence: (silence) => silences.emit(silence),
    preference: options.preference,
    onSwitch: (label) => switches.emit(label),
    onFault: (fault) => {
      faults.emit(fault.message)
      // Unplugged: nothing more will come, so end the capture the normal way —
      // what was said before the cable came out still finalizes.
      if (fault.ended) void controller.stop(boundRoutingId).catch(() => {})
    }
  })

  const controller: VoiceController = {
    async start(routingId, language) {
      // IDEMPOTENT, defensively. A second call would otherwise reach the
      // transport's start, and main answers that by tearing the live capture
      // down and building a new one — an interrupted sentence. The mic button's
      // own `voiceState !== 'idle'` guard cannot cover this, because that state
      // arrives from main a round trip later, so two presses inside the window
      // both see `idle`. This is the check that holds.
      // A press being RELEASED (its drain still running) does not count: a quick
      // re-press queues behind the drain instead of being swallowed.
      if ((inflight && !inflight.cancelled) || capture.isActive()) return
      boundRoutingId = routingId
      // Owned from the press — a refusal or a server error before `ready` is
      // this client's to show, too.
      claim(routingId, Infinity)
      const run: StartRun = { promise: Promise.resolve(), cancelled: false }
      run.promise = (async () => {
        // A previous release still draining goes first: its transport stop must
        // reach main before this start does, or main would end THIS capture.
        if (stopping) await stopping.catch(() => {})
        if (run.cancelled) return
        // Microphone FIRST, engine second: a denied permission must not spawn a
        // cli.js child and open a Deepgram stream nobody will speak into. Blocks
        // captured while the transport's start is in flight are held by the
        // capture and flushed on `arm()`, so the first second of speech is not
        // lost to the round trip.
        await capture.start()
        // Released while the microphone was still opening: nothing was captured,
        // so this press is simply cancelled.
        if (run.cancelled && !capture.isActive()) return
        try {
          await transport.start(routingId, language)
        } catch (err) {
          await capture.stop()
          throw err
        }
        // Live: stream from here on. Halted by a release in the meantime: this is
        // the drain — the queue goes out now, ahead of the stop.
        capture.arm()
      })()
      inflight = run
      try {
        await run.promise
      } finally {
        if (inflight === run) inflight = null
      }
    },

    async stop(routingId) {
      const run = inflight
      const stop = (async () => {
        if (run) run.cancelled = true
        // The microphone closes NOW; what it captured is kept for the drain.
        await capture.halt()
        // The start decides where that goes: its `arm()` flushes it, its failure
        // (already surfaced by the start's own caller) discards it.
        if (run) await run.promise.catch(() => {})
        await capture.stop()
        // Always told, even if the capture was never armed: main may be holding a
        // stream open, and finalization is what flushes the last transcript back.
        try {
          await transport.stop(routingId)
        } finally {
          // The outcome ("No speech detected") and late errors arrive after this;
          // they are still ours for the window — unless a newer press on the SAME
          // session (a re-press during this drain) already re-claimed it as live.
          const newerPress = inflight !== null && inflight !== run && !inflight.cancelled
          const reclaimed =
            (newerPress || capture.isActive()) && resolveId(boundRoutingId) === resolveId(routingId)
          if (!reclaimed) claim(routingId, Date.now() + VOICE_OWNERSHIP_WINDOW_MS)
        }
      })()
      stopping = stop
      try {
        await stop
      } finally {
        if (stopping === stop) stopping = null
      }
    },

    isActive() {
      return (inflight !== null && !inflight.cancelled) || capture.isActive()
    },

    onFault: (listener) => faults.add(listener),
    onLevel: (listener) => levels.add(listener),
    onSilence: (listener) => silences.add(listener),
    onSwitch: (listener) => switches.add(listener),

    ownsRecentCapture(routingId) {
      prune()
      const live = resolveId(routingId)
      for (const id of owned.keys()) if (resolveId(id) === live) return true
      return false
    }
  }
  return controller
}

let shared: VoiceController | null = null

/**
 * The client's one controller, over `window.api`'s voice transport. Lazy, so
 * nothing touches `window.api` at import time and a test can install its own
 * `window.api` before the first press.
 */
export function voiceController(): VoiceController {
  if (!shared) {
    shared = createVoiceController(
      {
        start: (routingId, language) => window.api.voiceStart(routingId, language),
        audio: (routingId, dataB64) => window.api.voiceAudio(routingId, dataB64),
        stop: (routingId) => window.api.voiceStop(routingId)
      },
      { deniedMessage: micDeniedMessage(window.api?.platform), preference: readMicPreference }
    )
  }
  return shared
}

/** Drop the shared controller. Test seam only. */
export function resetVoiceControllerForTests(): void {
  shared = null
}
