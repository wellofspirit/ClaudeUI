/**
 * Cutting a long take for the final pass — ADR-101 §7.
 *
 * Parakeet's encoder is attention over the whole input, so memory and time grow
 * faster than the audio does. Measured on the target hardware: 60 s peaks at
 * ~1.3 GB / ~2 s, 120 s at 1.8 GB / 6 s, 300 s at 3.9 GB / 25 s — and the worker
 * already holds ~0.8 GB for the model. So the final pass decodes up to
 * {@link MAX_SEGMENT_S} in one piece (full context, the accuracy the design pays
 * for) and cuts anything longer into segments of at most that.
 *
 * Where to cut matters more than how often: a cut inside a word loses it. Each
 * cut goes at the quietest {@link QUIET_WINDOW_S} (lowest RMS) within the last
 * {@link CUT_SEARCH_S} of its segment — a breath or a pause between sentences, in
 * any dictation that long. Pure arithmetic over samples, so it is tested by
 * planting a quiet stretch and checking the cut lands in it.
 */

import { SAMPLE_RATE } from './recognizer'

/** The most audio one decode is given. */
export const MAX_SEGMENT_S = 60
/** A cut is searched for in this much of the segment's tail. */
export const CUT_SEARCH_S = 15
/** The length of the stretch whose loudness decides a cut. */
export const QUIET_WINDOW_S = 0.3

export interface Segment {
  /** Sample indices into the take; `end` is exclusive. */
  start: number
  end: number
}

/**
 * Split `audio` into consecutive segments of at most {@link MAX_SEGMENT_S}.
 * A take of exactly that length (or less) is one segment.
 */
export function planSegments(audio: Float32Array, sampleRate: number = SAMPLE_RATE): Segment[] {
  const maxLen = MAX_SEGMENT_S * sampleRate
  const searchLen = CUT_SEARCH_S * sampleRate
  const win = Math.round(QUIET_WINDOW_S * sampleRate)

  const segments: Segment[] = []
  let start = 0
  while (audio.length - start > maxLen) {
    const limit = start + maxLen
    const from = limit - searchLen
    // Prefix sums of squares over the search region: any window's energy is two
    // lookups, so scanning every sample position costs one pass.
    const prefix = new Float64Array(searchLen + 1)
    for (let i = 0; i < searchLen; i++) {
      const v = audio[from + i]
      prefix[i + 1] = prefix[i] + v * v
    }
    let best = 0
    let bestEnergy = Infinity
    for (let w = 0; w + win <= searchLen; w++) {
      const energy = prefix[w + win] - prefix[w]
      if (energy < bestEnergy) {
        bestEnergy = energy
        best = w
      }
    }
    const cut = from + best + (win >> 1)
    segments.push({ start, end: cut })
    start = cut
  }
  segments.push({ start, end: audio.length })
  return segments
}
