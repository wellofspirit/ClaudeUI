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

import { BrowserVoiceCapture, type CaptureEnv } from './browser-voice-capture'

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
}

interface StartRun {
  promise: Promise<void>
  /** A stop arrived for this press. Honoured only before the microphone opens. */
  cancelled: boolean
}

export function createVoiceController(
  transport: VoiceTransport,
  options: { env?: CaptureEnv } = {}
): VoiceController {
  // The session the live capture is bound to. Audio is routed by the CAPTURE'S
  // owner in main, not by this id; it rides along for the transport's shape.
  let boundRoutingId = ''
  let inflight: StartRun | null = null
  let stopping: Promise<void> | null = null
  const faultListeners = new Set<(message: string) => void>()

  // One microphone per client, matching main's one-capture-per-owner rule
  // (core/services/voice-relay.ts). Constructed eagerly and cheaply — it touches
  // no device until `start()`.
  const capture = new BrowserVoiceCapture({
    sendAudio: (dataB64) => transport.audio(boundRoutingId, dataB64),
    env: options.env,
    onFault: (fault) => {
      for (const listener of [...faultListeners]) listener(fault.message)
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
        await transport.stop(routingId)
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

    onFault(listener) {
      faultListeners.add(listener)
      return () => faultListeners.delete(listener)
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
    shared = createVoiceController({
      start: (routingId, language) => window.api.voiceStart(routingId, language),
      audio: (routingId, dataB64) => window.api.voiceAudio(routingId, dataB64),
      stop: (routingId) => window.api.voiceStop(routingId)
    })
  }
  return shared
}

/** Drop the shared controller. Test seam only. */
export function resetVoiceControllerForTests(): void {
  shared = null
}
