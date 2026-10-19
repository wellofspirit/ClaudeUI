/**
 * ADR-102 — the renderer half of the load-progress plan: frames from the Claude
 * history read plus the subagent fetches fold into ONE monotonic fraction, with
 * the ETA withheld until it means something and the phases mapped for the UI.
 */

import { describe, it, expect } from 'vitest'
import {
  createLoadProgress,
  describeTranscriptLoad,
  formatEta,
  type TranscriptLoadProgress
} from '../transcript-load-progress'

const MB = 1024 * 1024

/** A tracker on a manual clock, collecting every emission. */
function setup(): {
  t: ReturnType<typeof createLoadProgress>
  out: TranscriptLoadProgress[]
  tick: (ms: number) => void
} {
  let clock = 1_000
  const out: TranscriptLoadProgress[] = []
  const t = createLoadProgress(
    (p) => out.push(p),
    () => clock
  )
  return { t, out, tick: (ms) => (clock += ms) }
}

const frame = (done: number, total: number | null, phase = 'transcript'): never =>
  ({ done, total, phase }) as never

describe('createLoadProgress', () => {
  it('starts indeterminate: no total, no fraction, no ETA', () => {
    const { t, out } = setup()
    t.start()
    expect(out).toEqual([
      {
        fraction: null,
        phase: 'reading',
        doneBytes: 0,
        totalBytes: null,
        etaMs: null,
        subagents: null
      }
    ])
  })

  it('stays indeterminate with no frames at all (old server / engine without byte progress)', () => {
    const { t, out } = setup()
    t.start()
    t.subagentsStarted(3)
    t.subagentFetched(100)
    t.finish()
    expect(out.every((p) => p.fraction === null && p.totalBytes === null)).toBe(true)
    expect(out.at(-1)!.phase).toBe('subagents')
  })

  it('takes the total from the FIRST frame and never re-scales to a later one', () => {
    const { t, out } = setup()
    t.history(frame(0, 100))
    t.history(frame(50, 100))
    t.history(frame(60, 9999)) // a different total mid-flight is ignored
    expect(out.map((p) => p.totalBytes)).toEqual([100, 100, 100])
    expect(out.at(-1)!.fraction).toBeCloseTo(0.6)
  })

  it('maps transcript / costs / unknown phases to reading and sending to receiving', () => {
    const { t, out } = setup()
    t.history(frame(0, 100, 'transcript'))
    t.history(frame(10, 100, 'costs'))
    t.history(frame(20, 100, 'from-the-future'))
    expect(out.map((p) => p.phase)).toEqual(['reading', 'reading', 'reading'])
    t.history(frame(20, 100, 'sending'))
    expect(out.at(-1)!.phase).toBe('receiving')
    // Receiving keeps the last fraction instead of resetting it.
    expect(out.at(-1)!.fraction).toBeCloseTo(0.2)
    expect(out.at(-1)!.etaMs).toBeNull()
  })

  it('a sending frame with no total (non-Claude engine, remote) is just "receiving", indeterminate', () => {
    const { t, out } = setup()
    t.start()
    t.history(frame(0, null, 'sending'))
    expect(out.at(-1)).toMatchObject({ phase: 'receiving', fraction: null, totalBytes: null })
  })

  it('is monotonic whatever order and values arrive', () => {
    const { t, out } = setup()
    t.history(frame(0, 100))
    t.history(frame(40, 100))
    t.history(frame(30, 100)) // a stale frame must not move the bar back
    t.history(frame(70, 100))
    t.subagentsStarted(2)
    t.subagentFetched(10)
    t.subagentFetched(10)
    const fractions = out.map((p) => p.fraction as number)
    for (let i = 1; i < fractions.length; i++)
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
  })

  it("continues from the history read's last done through the subagent fetches up to the total", () => {
    const { t, out } = setup()
    // Plan: history reads 60 of 100, the remaining 40 are the subagent transcripts.
    t.history(frame(0, 100))
    t.history(frame(60, 100, 'costs'))
    t.subagentsStarted(2)
    expect(out.at(-1)).toMatchObject({ phase: 'subagents', subagents: 2, doneBytes: 60 })
    t.subagentFetched(25)
    expect(out.at(-1)!.doneBytes).toBe(85)
    t.subagentFetched(15)
    expect(out.at(-1)!.doneBytes).toBe(100)
    expect(out.at(-1)!.fraction).toBe(1)
  })

  it('treats a missing subagent size as 0 and never exceeds the total', () => {
    const { t, out } = setup()
    t.history(frame(0, 100))
    t.history(frame(90, 100))
    t.subagentsStarted(3)
    t.subagentFetched(undefined) // an agent with no file on disk
    expect(out.at(-1)!.doneBytes).toBe(90)
    t.subagentFetched(500) // sizes list EVERY file; more than the plan allows for
    expect(out.at(-1)!.doneBytes).toBe(100)
    expect(out.at(-1)!.fraction).toBe(1)
  })

  it('finish() lands on 100% when the total is known, and does nothing when it is not', () => {
    const a = setup()
    a.t.history(frame(0, 100))
    a.t.history(frame(40, 100))
    a.t.finish()
    expect(a.out.at(-1)).toMatchObject({ fraction: 1, doneBytes: 100, etaMs: null })

    const b = setup()
    b.t.start()
    b.t.finish()
    expect(b.out).toHaveLength(1)
  })

  it('withholds the ETA until 5% done AND 300 ms elapsed, then extrapolates', () => {
    const { t, out, tick } = setup()
    t.history(frame(0, 1000))
    tick(100)
    t.history(frame(500, 1000)) // plenty done, too little time
    expect(out.at(-1)!.etaMs).toBeNull()
    tick(400) // 500 ms elapsed, 50% done -> as long again
    t.history(frame(500, 1000))
    expect(out.at(-1)!.etaMs).toBeCloseTo(500)

    const early = setup()
    early.t.history(frame(0, 1000))
    early.tick(5000)
    early.t.history(frame(10, 1000)) // 1% — a guess, not an estimate
    expect(early.out.at(-1)!.etaMs).toBeNull()
  })
})

describe('describeTranscriptLoad', () => {
  // The planned total is ~2x the real session size, so bytes are never printed.
  const base: TranscriptLoadProgress = {
    fraction: 0.428,
    phase: 'reading',
    doneBytes: 34.2 * MB,
    totalBytes: 80.1 * MB,
    etaMs: 2_400,
    subagents: null
  }

  it('reading: a percentage and the ETA', () => {
    expect(describeTranscriptLoad(base)).toBe('Reading transcript · 42% · ~3 s left')
  })

  it('subagents: names the count', () => {
    expect(
      describeTranscriptLoad({
        ...base,
        fraction: 0.87,
        phase: 'subagents',
        subagents: 73,
        etaMs: 800
      })
    ).toBe('Loading 73 subagents · 87% · ~1 s left')
    expect(describeTranscriptLoad({ ...base, phase: 'subagents', subagents: 1, etaMs: null })).toBe(
      'Loading 1 subagent · 42%'
    )
  })

  it('never claims a byte size (the planned total is not the session size)', () => {
    for (const phase of ['reading', 'subagents'] as const) {
      expect(describeTranscriptLoad({ ...base, phase, subagents: 2 })).not.toMatch(/MB|KB|\bof\b/)
    }
  })

  it('never rounds up to 100% before the load is actually complete', () => {
    expect(describeTranscriptLoad({ ...base, fraction: 0.996, etaMs: null })).toBe(
      'Reading transcript · 99%'
    )
    expect(describeTranscriptLoad({ ...base, fraction: 1, etaMs: null })).toBe(
      'Reading transcript · 100%'
    )
  })

  it('receiving, and the unknown-fraction fallback (just the label)', () => {
    expect(describeTranscriptLoad({ ...base, phase: 'receiving' })).toBe('Receiving…')
    expect(describeTranscriptLoad({ ...base, fraction: null, totalBytes: null, etaMs: null })).toBe(
      'Reading transcript'
    )
  })
})

describe('formatEta', () => {
  it('seconds under a minute, minutes after, never "0 s"', () => {
    expect(formatEta(10)).toBe('~1 s left')
    expect(formatEta(2_400)).toBe('~3 s left')
    expect(formatEta(59_000)).toBe('~59 s left')
    expect(formatEta(60_000)).toBe('~1 min left')
    expect(formatEta(61_000)).toBe('~2 min left')
  })
})
