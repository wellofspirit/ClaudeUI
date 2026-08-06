/**
 * RN9 — the LogViewer's `entries` array was uncapped: a long-lived viewer grew
 * its state array (and the DOM rendered from it) without bound. `capEntries` is
 * the pure appender both IPC handlers now funnel through.
 */

import { describe, it, expect } from 'vitest'
import { capEntries, MAX_LOG_ENTRIES } from '../LogViewer'

type Entry = Parameters<typeof capEntries>[0][number]

function entry(n: number): Entry {
  return { timestamp: '12:00:00.000', level: 'info', source: 'main', message: `m${n}` }
}

function entries(from: number, count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => entry(from + i))
}

describe('capEntries (RN9)', () => {
  it('appends normally while under the cap', () => {
    const prev = entries(0, 3)
    expect(capEntries(prev, entries(3, 2)).map((e) => e.message)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4'
    ])
  })

  it('does not mutate the previous array (React state identity stays sane)', () => {
    const prev = entries(0, 3)
    const next = capEntries(prev, entries(3, 1))
    expect(prev).toHaveLength(3)
    expect(next).not.toBe(prev)
  })

  it('pins length at the cap and drops the OLDEST entries', () => {
    const prev = entries(0, MAX_LOG_ENTRIES)
    const next = capEntries(prev, entries(MAX_LOG_ENTRIES, 5))

    expect(next).toHaveLength(MAX_LOG_ENTRIES)
    // First 5 dropped, newest 5 retained at the tail.
    expect(next[0].message).toBe('m5')
    expect(next.at(-1)!.message).toBe(`m${MAX_LOG_ENTRIES + 4}`)
  })

  it('holds the cap when a single batch alone overshoots it', () => {
    const next = capEntries([], entries(0, MAX_LOG_ENTRIES * 2))
    expect(next).toHaveLength(MAX_LOG_ENTRIES)
    expect(next[0].message).toBe(`m${MAX_LOG_ENTRIES}`)
  })

  it('stays pinned across many successive appends (the leak scenario)', () => {
    let acc: Entry[] = []
    for (let i = 0; i < 300; i++) acc = capEntries(acc, entries(i * 100, 100))
    expect(acc).toHaveLength(MAX_LOG_ENTRIES)
    expect(acc.at(-1)!.message).toBe('m29999')
  })
})
