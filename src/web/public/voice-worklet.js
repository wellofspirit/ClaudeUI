/**
 * AudioWorklet processor for remote voice capture — SyncCore phase 5 S3.
 *
 * A REAL FILE, served from the web client's own origin, rather than a `blob:`
 * URL built from a string at runtime: the remote server sends
 * `script-src 'self'` on this origin (remote-server.ts §securityHeaders), so a
 * blob module would be refused by our own CSP — and widening the policy on the
 * origin where model-authored content renders, to save one static file, is not a
 * trade worth making.
 *
 * It does as little as possible on purpose. It BATCHES the render quanta the
 * audio thread hands it (128 frames, ~2.7 ms) into ~150 ms blocks and posts them
 * to the page; the resampling and quantization to the 16 kHz i16LE the cli.js
 * voice server requires happen on the main thread, in `shared/audio/pcm16.ts`.
 *
 * That split is deliberate. This file cannot be imported by anything (a worklet
 * runs in its own global scope with no module graph reachable from the tests) and
 * cannot be tested — there is no AudioWorklet in jsdom and no audio device in CI.
 * So everything that could be WRONG rather than merely absent lives in a pure
 * function with unit tests, and what is left here is a copy loop.
 *
 * Batching at ~150 ms rather than the native path's ~11 ms: each block becomes
 * one WebSocket frame, and 7 frames a second is kind to a phone on cellular where
 * 90 would not be. Deepgram's endpointing works on a 300 ms window, so the added
 * latency is inside the noise.
 */

const BATCH_SECONDS = 0.15

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` is a global in AudioWorkletGlobalScope — the context's real
    // rate, which is what makes the batch a fixed DURATION regardless of whether
    // the browser honoured our 16 kHz request or gave us its native 48 kHz.
    this.batchSize = Math.max(128, Math.round(sampleRate * BATCH_SECONDS))
    this.buffer = new Float32Array(this.batchSize)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    // No input this quantum (the source is still connecting, or the track ended).
    // Returning true keeps the node alive; false would retire it permanently.
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.batchSize) this.flush()
    }
    return true
  }

  flush() {
    if (this.filled === 0) return
    const block = this.buffer.slice(0, this.filled)
    this.filled = 0
    // Transferred, not copied: the page is the only consumer, and a copy per
    // block would be 150 ms of audio memcpy'd twice a second for no reason.
    this.port.postMessage(block, [block.buffer])
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor)
