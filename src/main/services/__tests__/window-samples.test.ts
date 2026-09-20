/**
 * @vitest-environment node
 *
 * ADR-071 §6 — the one writer of `usage_window_sample`.
 *
 * Three callers share it (the active Claude poll, the limits provider's
 * on-demand read of a stored account, the ChatGPT store), so the rules that
 * decide what becomes a row have to hold once, here, rather than per caller:
 * a window with no reset instant cannot be filed, an unchanged reading is not
 * new information, and two series must not snap onto each other's ends.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { recordWindowSample } = vi.hoisted(() => ({ recordWindowSample: vi.fn() }))
vi.mock('../../../core/services/db', () => ({ recordWindowSample }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { recordLimitSamples, resetWindowSampleDedup } from '../../../core/services/window-samples'

const NOW = 1_700_000_000_000
const KEY = 'anthropic:org_x:uuid_x'
const later = (ms: number): string => new Date(NOW + ms).toISOString()

beforeEach(() => {
  recordWindowSample.mockReset()
  resetWindowSampleDedup()
})

function rows(): Array<Record<string, unknown>> {
  return recordWindowSample.mock.calls.map(([row]) => row as Record<string, unknown>)
}

describe('recordLimitSamples', () => {
  it('writes one row per window, keyed by account and kind', () => {
    const written = recordLimitSamples({
      accountKey: KEY,
      accountUuid: 'uuid_x',
      now: NOW,
      windows: [
        { kind: '5h', usedPercent: 10, resetsAt: later(60_000) },
        { kind: '7d', usedPercent: 20, resetsAt: later(600_000) }
      ]
    })

    expect(written).toBe(2)
    expect(rows().map((r) => [r.windowKind, r.accountKey, r.accountUuid])).toEqual([
      ['5h', KEY, 'uuid_x'],
      ['7d', KEY, 'uuid_x']
    ])
  })

  it('files a vendor with no account uuid under its account key', () => {
    recordLimitSamples({
      accountKey: 'chatgpt:ws-1:user-1',
      now: NOW,
      windows: [{ kind: '5h', usedPercent: 10, resetsAt: later(60_000) }]
    })

    // account_uuid is NOT NULL and a ChatGPT workspace has none; the key stands
    // in so the column keeps one meaning.
    expect(rows()[0].accountUuid).toBe('chatgpt:ws-1:user-1')
  })

  it('skips a window that cannot name its own end', () => {
    const written = recordLimitSamples({
      accountKey: KEY,
      now: NOW,
      windows: [
        { kind: '5h', usedPercent: 10, resetsAt: null },
        { kind: '7d', usedPercent: 20, resetsAt: 'not a date' },
        { kind: '7d:opus', usedPercent: 30, resetsAt: later(-1) }
      ]
    })

    expect(written).toBe(0)
    expect(recordWindowSample).not.toHaveBeenCalled()
  })

  it('writes nothing when the reading has not moved', () => {
    const windows = [{ kind: '5h', usedPercent: 10, resetsAt: later(60_000) }]
    expect(recordLimitSamples({ accountKey: KEY, now: NOW, windows })).toBe(1)
    expect(recordLimitSamples({ accountKey: KEY, now: NOW + 1000, windows })).toBe(0)
    expect(
      recordLimitSamples({
        accountKey: KEY,
        now: NOW + 2000,
        windows: [{ kind: '5h', usedPercent: 11, resetsAt: later(60_000) }]
      })
    ).toBe(1)
  })

  it('snaps jitter in one series without merging two different series', () => {
    recordLimitSamples({
      accountKey: KEY,
      now: NOW,
      windows: [{ kind: '5h', usedPercent: 10, resetsAt: new Date(NOW + 60_000).toISOString() }]
    })
    // 30 seconds later the server reports the same window end with jitter: one
    // canonical end, and the percent is what tells the samples apart.
    recordLimitSamples({
      accountKey: KEY,
      now: NOW + 30_000,
      windows: [{ kind: '5h', usedPercent: 11, resetsAt: new Date(NOW + 60_500).toISOString() }]
    })

    expect(rows().map((r) => r.canonicalEnd)).toEqual([
      rows()[0].canonicalEnd,
      rows()[0].canonicalEnd
    ])

    // A different account's window at the same instant is its own series.
    recordLimitSamples({
      accountKey: 'anthropic:org_y:uuid_y',
      now: NOW,
      windows: [{ kind: '5h', usedPercent: 10, resetsAt: new Date(NOW + 60_000).toISOString() }]
    })
    expect(rows()).toHaveLength(3)
  })

  it('keeps going when one window fails to write, and retries it next time', () => {
    recordWindowSample.mockImplementationOnce(() => {
      throw new Error('locked')
    })
    const windows = [
      { kind: '5h', usedPercent: 10, resetsAt: later(60_000) },
      { kind: '7d', usedPercent: 20, resetsAt: later(600_000) }
    ]

    expect(recordLimitSamples({ accountKey: KEY, now: NOW, windows })).toBe(1)
    expect(recordWindowSample).toHaveBeenCalledTimes(2)

    // The lost row is not deduped away: nothing was written for `5h`, so the
    // same reading is still new information.
    expect(recordLimitSamples({ accountKey: KEY, now: NOW + 1000, windows })).toBe(1)
    expect(rows().filter((r) => r.windowKind === '5h')).toHaveLength(2)
  })

  it('does not let two accounts share the `unknown` series', () => {
    // Every account that has never been active keys to `unknown`; without the
    // uuid in the series key, the first one's reading would dedup the second's.
    const window = { kind: '5h', usedPercent: 10, resetsAt: later(60_000) }
    recordLimitSamples({
      accountKey: 'unknown',
      accountUuid: 'uuid_a',
      now: NOW,
      windows: [window]
    })
    recordLimitSamples({
      accountKey: 'unknown',
      accountUuid: 'uuid_b',
      now: NOW,
      windows: [window]
    })

    expect(rows().map((r) => r.accountUuid)).toEqual(['uuid_a', 'uuid_b'])
  })
})
