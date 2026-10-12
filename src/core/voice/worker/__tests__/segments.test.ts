/**
 * @vitest-environment node
 *
 * Cut-point planning for the long final pass. `planSegments` takes the sample
 * rate, so these use 1 kHz: the constants are in seconds and scale with it, and a
 * 130 s take is then 130 000 samples instead of two million.
 */

import { describe, it, expect } from 'vitest'
import { CUT_SEARCH_S, MAX_SEGMENT_S, QUIET_WINDOW_S, planSegments } from '../segments'

const RATE = 1000

/** `seconds` of loud audio with silent stretches planted at the given [from, to) seconds. */
function take(seconds: number, quiet: Array<[number, number]> = []): Float32Array {
  const audio = new Float32Array(seconds * RATE)
  for (let i = 0; i < audio.length; i++) audio[i] = i % 2 === 0 ? 0.5 : -0.5
  for (const [from, to] of quiet) audio.fill(0, from * RATE, to * RATE)
  return audio
}

describe('planSegments', () => {
  it('a take of up to 60 s is one segment — exactly 60 s included', () => {
    expect(planSegments(take(10), RATE)).toEqual([{ start: 0, end: 10 * RATE }])
    expect(planSegments(take(MAX_SEGMENT_S), RATE)).toEqual([
      { start: 0, end: MAX_SEGMENT_S * RATE }
    ])
  })

  it('one sample past 60 s is two segments, neither over the cap', () => {
    const audio = new Float32Array(MAX_SEGMENT_S * RATE + 1).fill(0.5)
    const segments = planSegments(audio, RATE)
    expect(segments).toHaveLength(2)
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_S * RATE)
  })

  it('cuts land in the planted quiet stretches', () => {
    // First segment ends by 60 s, so its cut is searched in [45, 60]; the second
    // by 110.x s, searched in [95.x, 110.x].
    const segments = planSegments(
      take(130, [
        [50, 50.5],
        [100, 100.5]
      ]),
      RATE
    )
    expect(segments).toHaveLength(3)
    const [a, b, c] = segments
    expect(a.end).toBeGreaterThanOrEqual(50 * RATE)
    expect(a.end).toBeLessThanOrEqual(50.5 * RATE)
    expect(b.end).toBeGreaterThanOrEqual(100 * RATE)
    expect(b.end).toBeLessThanOrEqual(100.5 * RATE)
    // The cut is mid-window, so a whole quiet window surrounds it.
    expect(a.end - (QUIET_WINDOW_S * RATE) / 2).toBeGreaterThanOrEqual(50 * RATE)
    expect(a.end + (QUIET_WINDOW_S * RATE) / 2).toBeLessThanOrEqual(50.5 * RATE)

    // Contiguous, covering the take, none over the cap.
    expect(a.start).toBe(0)
    expect(b.start).toBe(a.end)
    expect(c.start).toBe(b.end)
    expect(c.end).toBe(130 * RATE)
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_S * RATE)
  })

  it('picks the QUIETEST stretch, not merely a quiet one', () => {
    const audio = take(100)
    // Two dips in the search range [45, 60]: a deeper one later.
    for (let i = 48 * RATE; i < 49 * RATE; i++) audio[i] *= 0.2
    for (let i = 55 * RATE; i < 56 * RATE; i++) audio[i] *= 0.05
    const [first] = planSegments(audio, RATE)
    expect(first.end).toBeGreaterThanOrEqual(55 * RATE)
    expect(first.end).toBeLessThanOrEqual(56 * RATE)
  })

  it('ignores quiet before the last 15 s of the segment', () => {
    const [first] = planSegments(take(100, [[20, 21]]), RATE)
    expect(first.end).toBeGreaterThanOrEqual((MAX_SEGMENT_S - CUT_SEARCH_S) * RATE)
    expect(first.end).toBeLessThanOrEqual(MAX_SEGMENT_S * RATE)
  })

  it('a take with no quiet at all is still cut within bounds', () => {
    const segments = planSegments(take(200), RATE)
    expect(segments.length).toBeGreaterThanOrEqual(4)
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_S * RATE)
    expect(segments.at(-1)!.end).toBe(200 * RATE)
  })

  it('works at the real 16 kHz rate by default', () => {
    expect(planSegments(new Float32Array(16_000))).toEqual([{ start: 0, end: 16_000 }])
  })
})
