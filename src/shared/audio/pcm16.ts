/**
 * Float32 audio → 16 kHz signed-16-bit little-endian mono PCM.
 *
 * THE format problem of remote voice, solved in one pure function.
 *
 * The voice server inside cli.js streams to Deepgram Nova3 with
 * `encoding=linear16, sample_rate=16000, channels=1` (patch/voice-server/README.md),
 * and the desktop's native capture module emits exactly that. A browser cannot:
 * `MediaRecorder` produces opus/webm containers and nothing else — which is what
 * aborted the previous attempt at remote voice. `AudioWorklet` CAN: it hands the
 * page raw Float32 blocks at the `AudioContext`'s own rate (typically 48000), and
 * the conversion to the wire format is arithmetic.
 *
 * That arithmetic lives HERE, alone, because it is the one part of the browser
 * capture path that is testable without an audio device: the worklet processor
 * (`src/web/public/voice-worklet.js`) only batches and posts blocks, and the
 * controller (`src/web/voice-capture.ts`) only owns the state machine. Neither
 * does DSP. A second implementation of the resampling — in the worklet, say, to
 * save a postMessage — would be a second answer to "what does 16 kHz mean here",
 * and drift in it is inaudible until a transcript comes back garbled.
 *
 * Electron-free and I/O-free by construction, like the rest of `shared/`.
 *
 * ## Why box-averaging, and why the carry state
 *
 * Downsampling by picking every Nth sample aliases everything above 8 kHz back
 * into the speech band. Averaging each output sample's whole input window is a
 * (crude, one-pole-flat) low-pass that costs one add per input sample and needs
 * no filter state — the right trade for a 3:1 decimation feeding a speech model.
 *
 * The window boundaries do NOT reset per block. A block is an arbitrary slice of
 * a continuous stream (the worklet posts every ~150 ms, and 150 ms of 44100 Hz is
 * not a whole number of windows), so a function that restarted its accumulator at
 * every block would drop or duplicate a fraction of a sample per block — about
 * one sample per second at 44.1 kHz, an audible pitch drift over a long
 * utterance. {@link DownsampleState} carries the partial window and the
 * fractional boundary across the seam instead, which makes a long stream
 * bit-identical to the same audio handed over in one giant block. The unit tests
 * assert exactly that.
 */

/** What the cli.js voice server (and therefore Deepgram) requires. */
export const VOICE_SAMPLE_RATE = 16000

/**
 * The seam between two consecutive blocks of one capture.
 *
 * Opaque to callers: make it with {@link initialDownsampleState} and thread the
 * `state` each {@link downsampleToPcm16} returns into the next call. Treated as
 * immutable — every call returns a fresh one rather than mutating in place, so a
 * caller that keeps an old state can replay a block and get the same answer.
 */
export interface DownsampleState {
  /**
   * Input samples this capture has consumed, and output samples it has emitted.
   *
   * ABSOLUTE counters, not a per-block offset. A window closes when
   * `consumed >= (emitted + 1) * ratio`, so every boundary is computed from the
   * start of the capture in one multiplication rather than accumulated by
   * repeated addition. That is what makes the output bit-identical however the
   * stream is chopped up: an accumulated boundary rounds differently depending
   * on how many times it was re-based, and at a ratio that divides evenly
   * (44100 Hz for exactly one second) the last window landed on the wrong side
   * of the comparison and the block-split stream came out one sample short.
   *
   * Exact in float64 for any realistic capture (48 kHz × 2^53 samples).
   */
  consumed: number
  emitted: number
  /** Sum of the input samples the in-progress window has absorbed so far. */
  sum: number
  /** How many samples that is — the divisor when the window closes. */
  count: number
}

/**
 * Refuse an input rate we cannot honestly serve.
 *
 * Below 16 kHz this function would have to INVENT samples, and a box-averager
 * cannot: it would silently emit one sample per input sample, i.e. a stream the
 * server labels 16 kHz but which plays back fast and garbled. Every browser
 * `AudioContext` runs at 44100 or 48000 (and the controller asks for 16000
 * explicitly, which modern browsers honour), so this is a guard against the
 * impossible rather than a supported path — but a wrong transcript with no error
 * is the worst failure mode available here, so it throws.
 */
function assertRate(inputRate: number): void {
  if (!Number.isFinite(inputRate) || inputRate < VOICE_SAMPLE_RATE) {
    throw new RangeError(
      `voice capture needs an input sample rate of at least ${VOICE_SAMPLE_RATE} Hz (got ${inputRate})`
    )
  }
}

/** Start-of-capture state for a stream at `inputRate`. */
export function initialDownsampleState(inputRate: number): DownsampleState {
  assertRate(inputRate)
  return { consumed: 0, emitted: 0, sum: 0, count: 0 }
}

/**
 * Clamp + quantize one Float32 sample to the asymmetric int16 range.
 *
 * Negative full scale is -32768 and positive full scale is 32767, so the two
 * halves use different multipliers; a single 32767 would leave the loudest
 * negative peak a bit quiet, and a single 32768 would wrap the loudest positive
 * one to -32768 — a click. NaN (a worklet block from a disconnected device) is
 * silence, not a wrapped extreme.
 */
function quantize(sample: number): number {
  if (Number.isNaN(sample)) return 0
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
}

/**
 * One block of mono Float32 → the int16 samples it completes at 16 kHz.
 *
 * Pure: `input` and `state` are read, never written, and the returned `state`
 * is what the NEXT block of the same capture must be given. A short block, an
 * empty block and an odd-length block are all ordinary — the count of output
 * samples is whatever the window boundaries complete, which is why the caller
 * must not assume `input.length / ratio`.
 */
export function downsampleToPcm16(
  input: Float32Array,
  inputRate: number,
  state: DownsampleState
): { samples: Int16Array; state: DownsampleState } {
  assertRate(inputRate)
  const ratio = inputRate / VOICE_SAMPLE_RATE

  // Upper bound, never the exact count: the last window of the block usually
  // stays open. Sliced to the real length before returning so callers never see
  // trailing zeros (which would be audible clicks, not silence, at 16 kHz).
  const out = new Int16Array(Math.ceil(input.length / ratio) + 1)
  let written = 0

  let { consumed, emitted, sum, count } = state

  for (let i = 0; i < input.length; i++) {
    sum += input[i]
    count++
    consumed++
    // `>=` on the window's right edge, so an integer ratio closes exactly on the
    // ratio-th sample rather than one late. A `while` rather than an `if` only
    // because the loop must terminate on its own terms; `assertRate` keeps the
    // ratio at or above 1, so it never runs twice.
    while (consumed >= (emitted + 1) * ratio) {
      out[written++] = quantize(sum / count)
      sum = 0
      count = 0
      emitted++
    }
  }

  return { samples: out.subarray(0, written), state: { consumed, emitted, sum, count } }
}

/**
 * int16 samples → the little-endian bytes the wire format names.
 *
 * Written through a `DataView` with an explicit `littleEndian: true` rather than
 * handing over `samples.buffer`: a typed array's byte order is the HOST's, so
 * the shortcut would ship big-endian PCM on a big-endian machine and label it
 * `linear16` LE. Rare hardware, silent corruption, one line to be right.
 */
export function pcm16ToBytesLe(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
  return bytes
}
