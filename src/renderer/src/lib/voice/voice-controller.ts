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
 * desktop captured natively in the main process. It is unchanged, only
 * parameterized over {@link VoiceTransport} so the desktop runs it too.
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
  isActive(): boolean
}

export function createVoiceController(
  transport: VoiceTransport,
  options: { env?: CaptureEnv } = {}
): VoiceController {
  // The session the live capture is bound to. Audio is routed by the CAPTURE'S
  // owner in main, not by this id; it rides along for the transport's shape.
  let boundRoutingId = ''
  // One microphone per client, matching main's one-capture-per-owner rule
  // (core/services/voice-relay.ts). Constructed eagerly and cheaply — it touches
  // no device until `start()`.
  const capture = new BrowserVoiceCapture({
    sendAudio: (dataB64) => transport.audio(boundRoutingId, dataB64),
    env: options.env
  })

  return {
    async start(routingId, language) {
      // IDEMPOTENT, defensively. `BrowserVoiceCapture.start()` already no-ops
      // while active, but that alone is not enough: a second call would still
      // reach the transport's start, and main answers that by tearing the live
      // capture down and building a new one — an interrupted sentence. The mic
      // button's own `voiceState !== 'idle'` guard cannot cover this, because
      // that state arrives from main a round trip later, so two presses inside
      // the window both see `idle`. This is the check that holds.
      if (capture.isActive()) return
      boundRoutingId = routingId
      // Microphone FIRST, engine second: a denied permission must not spawn a
      // cli.js child and open a Deepgram stream nobody will speak into. Blocks
      // captured while the transport's start is in flight are held by the
      // capture and flushed on `arm()`, so the first second of speech is not
      // lost to the round trip.
      await capture.start()
      try {
        await transport.start(routingId, language)
      } catch (err) {
        await capture.stop()
        throw err
      }
      capture.arm()
    },

    async stop(routingId) {
      await capture.stop()
      // Always told, even if the capture was never armed: main may be holding a
      // stream open, and finalization is what flushes the last transcript back.
      await transport.stop(routingId)
    },

    isActive() {
      return capture.isActive()
    }
  }
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
