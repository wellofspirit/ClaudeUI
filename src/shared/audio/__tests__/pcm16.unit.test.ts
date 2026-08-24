/**
 * Layer 1 unit tests for the ONE piece of DSP in the remote-voice path.
 *
 * The worklet cannot be tested here (jsdom has no `AudioWorklet`, no
 * `AudioContext`, and no audio device — see the note in
 * `src/web/__tests__/voice-capture.unit.test.ts`), so correctness of the wire
 * format rests entirely on this file. What it has to prove:
 *
 *  - the output really is 16 kHz mono int16 LE, whatever the input rate;
 *  - block boundaries are invisible — a stream split into odd chunks produces
 *    byte-identical output to the same stream in one block (the drift property);
 *  - clipping and NaN are handled at the quantizer rather than wrapping.
 */

import { describe, it, expect } from 'vitest'
import {
  VOICE_SAMPLE_RATE,
  downsampleToPcm16,
  initialDownsampleState,
  pcm16ToBytesLe,
  type DownsampleState
} from '../pcm16'

/** Run a whole stream through, block by block, and concatenate the output. */
function runBlocks(blocks: Float32Array[], rate: number): Int16Array {
  let state: DownsampleState = initialDownsampleState(rate)
  const chunks: Int16Array[] = []
  for (const block of blocks) {
    const result = downsampleToPcm16(block, rate, state)
    state = result.state
    // `subarray` is a view over the scratch buffer — copy before keeping it.
    chunks.push(new Int16Array(result.samples))
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Int16Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Split a stream into fixed-size blocks (the worklet's shape). */
function split(input: Float32Array, size: number): Float32Array[] {
  const blocks: Float32Array[] = []
  for (let i = 0; i < input.length; i += size) blocks.push(input.slice(i, i + size))
  return blocks
}

function sine(samples: number, rate: number, hz: number): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

describe('downsampleToPcm16', () => {
  it('decimates 48 kHz to 16 kHz at exactly 3:1', () => {
    const input = new Float32Array(4800) // 100 ms
    const { samples } = downsampleToPcm16(input, 48000, initialDownsampleState(48000))
    expect(samples.length).toBe(1600) // 100 ms at 16 kHz
  })

  it('passes 16 kHz input through sample-for-sample', () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1])
    const { samples } = downsampleToPcm16(
      input,
      VOICE_SAMPLE_RATE,
      initialDownsampleState(VOICE_SAMPLE_RATE)
    )
    expect(Array.from(samples)).toEqual([0, 16384, -16384, 32767])
  })

  it('holds a DC level through the resampler (the box average is unity-gain)', () => {
    const input = new Float32Array(4800).fill(0.25)
    const { samples } = downsampleToPcm16(input, 48000, initialDownsampleState(48000))
    expect(samples.length).toBe(1600)
    // 0.25 * 32767 = 8191.75 → 8192. Every window sees the same three samples.
    for (const s of samples) expect(s).toBe(8192)
  })

  it('clips rather than wraps, and treats NaN as silence', () => {
    const input = Float32Array.from([5, -5, Number.NaN, 0])
    const { samples } = downsampleToPcm16(
      input,
      VOICE_SAMPLE_RATE,
      initialDownsampleState(VOICE_SAMPLE_RATE)
    )
    expect(Array.from(samples)).toEqual([32767, -32768, 0, 0])
  })

  it('is drift-free across block boundaries at a NON-integer ratio (44.1 kHz)', () => {
    // 44100/16000 = 2.75625 — no block size makes this land on a window edge, so
    // a per-block accumulator reset would lose a fraction of a sample every
    // block. One second of audio is ~360 blocks, i.e. hundreds of lost samples.
    const rate = 44100
    const input = sine(rate, rate, 440) // 1 second
    const whole = runBlocks([input], rate)
    const chunked = runBlocks(split(input, 6615), rate) // 150 ms blocks
    expect(chunked.length).toBe(whole.length)
    expect(Array.from(chunked)).toEqual(Array.from(whole))
    // And the count is the rate conversion, to within the one open window.
    expect(Math.abs(whole.length - VOICE_SAMPLE_RATE)).toBeLessThanOrEqual(1)
  })

  it('is invariant to block SIZE, including odd and empty blocks', () => {
    const rate = 48000
    const input = sine(9600, rate, 300)
    const reference = runBlocks([input], rate)

    for (const size of [1, 7, 128, 999, 4801]) {
      expect(Array.from(runBlocks(split(input, size), rate)), `block size ${size}`).toEqual(
        Array.from(reference)
      )
    }

    // An empty block is a no-op that must not disturb the seam.
    const withGaps: Float32Array[] = []
    for (const block of split(input, 128)) {
      withGaps.push(new Float32Array(0))
      withGaps.push(block)
    }
    expect(Array.from(runBlocks(withGaps, rate))).toEqual(Array.from(reference))
  })

  it('accumulates no drift over a long stream (30 s at 44.1 kHz)', () => {
    const rate = 44100
    const seconds = 30
    const blocks: Float32Array[] = []
    for (let i = 0; i < seconds * 7; i++) blocks.push(new Float32Array(Math.round(rate / 7)))
    const out = runBlocks(blocks, rate)
    const expected = seconds * VOICE_SAMPLE_RATE
    // Everything but the single window still open when the stream ends.
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(2)
  })

  it('refuses an input rate below 16 kHz rather than silently emitting fast audio', () => {
    expect(() => initialDownsampleState(8000)).toThrow(RangeError)
    expect(() =>
      downsampleToPcm16(new Float32Array(10), 8000, { consumed: 0, emitted: 0, sum: 0, count: 0 })
    ).toThrow(RangeError)
  })

  it('does not mutate the state it was given', () => {
    const state = initialDownsampleState(48000)
    const snapshot = { ...state }
    downsampleToPcm16(new Float32Array(100).fill(0.5), 48000, state)
    expect(state).toEqual(snapshot)
  })
})

describe('pcm16ToBytesLe', () => {
  it('writes little-endian pairs regardless of host byte order', () => {
    const bytes = pcm16ToBytesLe(Int16Array.from([0x0102, -2, 0]))
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff, 0x00, 0x00])
  })

  it('produces two bytes per sample — the length the server bills as 16 kHz i16 mono', () => {
    const { samples } = downsampleToPcm16(
      new Float32Array(48000),
      48000,
      initialDownsampleState(48000)
    )
    // 1 s of input → 16000 samples → 32000 bytes.
    expect(pcm16ToBytesLe(samples).length).toBe(32000)
  })
})
