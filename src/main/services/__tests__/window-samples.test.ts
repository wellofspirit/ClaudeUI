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

import {
  onLimitSamplesWritten,
  recordLimitSamples,
  resetLimitSamplesWrittenListeners,
  resetWindowSampleDedup,
  type LimitReadingWritten
} from '../../../core/services/window-samples'

const NOW = 1_700_000_000_000
const KEY = 'anthropic:org_x:uuid_x'
const later = (ms: number): string => new Date(NOW + ms).toISOString()

beforeEach(() => {
  recordWindowSample.mockReset()
  resetWindowSampleDedup()
  resetLimitSamplesWrittenListeners()
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

  /**
   * Round 2 — why two slots of one length need distinct kinds (S3c).
   *
   * The series key is `accountKey:accountUuid:kind`, so two windows sharing a
   * kind share a series: the second one's end snaps onto the first's and the
   * value ledger, whose primary key is `(account, kind, end)`, sees one window
   * where the plan has two. `<kind>:secondary` is what keeps them apart.
   */
  it('keeps two same-length windows of one reading apart by their kinds', () => {
    recordLimitSamples({
      accountKey: KEY,
      now: NOW,
      windows: [
        { kind: '7d', usedPercent: 63, resetsAt: later(600_000), windowMinutes: 10_080 },
        // A minute apart, which is INSIDE the snap tolerance — the same kind
        // would have collapsed the two onto one canonical end.
        {
          kind: '7d:secondary',
          usedPercent: 12,
          resetsAt: later(660_000),
          windowMinutes: 10_080
        }
      ]
    })

    const written = rows()
    expect(written.map((r) => r.windowKind)).toEqual(['7d', '7d:secondary'])
    expect(written[0].canonicalEnd).not.toBe(written[1].canonicalEnd)
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

/**
 * The hub's seam (ADR-072 §4). ONE notifier here rather than a hook at each of
 * the three callers: they already agree here on what makes a sample comparable,
 * and the hub needs the same agreement.
 */
describe('onLimitSamplesWritten', () => {
  it('reports the readings a write actually produced, with the canonical end', () => {
    const seen: LimitReadingWritten[][] = []
    onLimitSamplesWritten((readings) => seen.push(readings))

    recordLimitSamples({
      accountKey: KEY,
      accountUuid: 'uuid_x',
      accountLabel: 'someone@example.com',
      vendorId: 'anthropic',
      plan: 'max_20x',
      now: NOW,
      windows: [
        { kind: '5h', usedPercent: 42, resetsAt: later(60_000), windowMinutes: 300 },
        { kind: '7d', usedPercent: 7, resetsAt: later(600_000), windowMinutes: 10_080 }
      ]
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(seen[0][0]).toMatchObject({
      accountKey: KEY,
      accountLabel: 'someone@example.com',
      vendorId: 'anthropic',
      plan: 'max_20x',
      windowKind: '5h',
      windowMinutes: 300,
      usedPercent: 42,
      observedAt: NOW
    })
    // The canonical end, not the raw reset: two machines reading the same window
    // a minute apart must name the same instant or the hub keys two windows.
    expect(seen[0][0].resetsAt).toBe(new Date(rows()[0].canonicalEnd as number).toISOString())
  })

  it('does not fire when every window was unchanged', () => {
    const listener = vi.fn()
    onLimitSamplesWritten(listener)
    const windows = [{ kind: '5h', usedPercent: 42, resetsAt: later(60_000) }]

    recordLimitSamples({ accountKey: KEY, accountUuid: 'uuid_x', now: NOW, windows })
    expect(listener).toHaveBeenCalledTimes(1)

    recordLimitSamples({ accountKey: KEY, accountUuid: 'uuid_x', now: NOW, windows })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire for a reading whose window cannot be dated', () => {
    const listener = vi.fn()
    onLimitSamplesWritten(listener)
    recordLimitSamples({
      accountKey: KEY,
      accountUuid: 'uuid_x',
      now: NOW,
      windows: [{ kind: '5h', usedPercent: 42, resetsAt: null }]
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('a subscriber that throws does not fail the reading', () => {
    onLimitSamplesWritten(() => {
      throw new Error('subscriber is broken')
    })
    expect(() =>
      recordLimitSamples({
        accountKey: KEY,
        accountUuid: 'uuid_x',
        now: NOW,
        windows: [{ kind: '5h', usedPercent: 42, resetsAt: later(60_000) }]
      })
    ).not.toThrow()
    expect(rows()).toHaveLength(1)
  })
})
