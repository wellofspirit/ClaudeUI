/**
 * AudioWorklet processor for voice capture — desktop window and web client alike.
 *
 * A REAL FILE, emitted by both builds as a same-origin asset (imported with
 * `?url&no-inline` by `browser-voice-capture.ts`), rather than a `blob:` or
 * `data:` URL built at runtime: the renderer's CSP and the remote server's
 * (remote-server.ts §securityHeaders) both say `script-src 'self'`, so either of
 * those would be refused by our own policy — and widening the policy on the
 * origin where model-authored content renders, to save one static file, is not a
 * trade worth making.
 *
 * It does as little as possible on purpose. It BATCHES the render quanta the
 * audio thread hands it (128 frames, ~2.7 ms) into ~150 ms blocks and posts them
 * to the page; the resampling and quantization to the 16 kHz i16LE the cli.js
 * voice server requires happen on the main thread, in `shared/audio/pcm16.ts`.
 *
 * That split is deliberate. This file is only ever referenced by URL (a worklet
 * runs in its own global scope with no module graph reachable from the tests) and
 * cannot be tested — there is no AudioWorklet in jsdom and no audio device in CI.
 * So everything that could be WRONG rather than merely absent lives in a pure
 * function with unit tests, and what is left here is a copy loop.
 *
 * Batching at ~150 ms rather than the retired native capture's ~11 ms: each
 * block becomes one WebSocket frame (or one IPC message on the desktop), and 7
 * frames a second is kind to a phone on cellular where 90 would not be. Deepgram's endpointing works on a 300 ms window, so the added
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
    // A release asks for the partial batch (< 150 ms — the last syllable) before
    // the graph is torn down. `flushed` follows the block on the same port, so
    // the page knows the tail has arrived; the waiting and its bound live in
    // `browser-voice-capture.ts`, where they can be tested.
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      this.flush()
      this.port.postMessage('flushed')
    }
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
