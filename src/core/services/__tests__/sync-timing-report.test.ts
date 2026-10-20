/**
 * @vitest-environment node
 *
 * `sync:report-timing`'s host half: strict numeric-only validation, the
 * host-formatted line (no client string can reach it), the warn threshold, and the
 * per-connection budget. The channel's registration (capability, enforcement) is
 * pinned in main/ipc/__tests__/remote-handlers.ipc.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), isEnabled: vi.fn() }
}))

import { logger } from '../logger'
import {
  MAX_FRAME_BYTES,
  MAX_REPORTS_PER_MINUTE,
  MAX_REPORT_MS,
  SyncTimingReports,
  parseSyncTimingReport
} from '../sync-timing-report'

const GOOD = { frameBytes: 1_234_567, decodeMs: 12.34, syncToFrameMs: 56.78, hydrateMs: 90.12 }

/** Every line written, whatever the level. */
function lines(): Array<[string, string, string]> {
  return [
    ...vi
      .mocked(logger.info)
      .mock.calls.map(([s, m]) => ['info', s, m] as [string, string, string]),
    ...vi.mocked(logger.warn).mock.calls.map(([s, m]) => ['warn', s, m] as [string, string, string])
  ]
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.warn).mockClear()
})

describe('parseSyncTimingReport', () => {
  it('accepts the four numbers and ignores unknown keys', () => {
    expect(parseSyncTimingReport({ ...GOOD, extra: 'x', frameChars: 9 })).toEqual(GOOD)
  })

  it('accepts a report with no syncToFrameMs (a sync that was never timed)', () => {
    const { syncToFrameMs: _omit, ...rest } = GOOD
    expect(parseSyncTimingReport(rest)).toEqual(rest)
  })

  it('accepts zero', () => {
    const zero = { frameBytes: 0, decodeMs: 0, syncToFrameMs: 0, hydrateMs: 0 }
    expect(parseSyncTimingReport(zero)).toEqual(zero)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"frameBytes":1}'],
    ['a number', 7],
    ['an array', [1, 2, 3, 4]],
    ['a class instance carrying the right fields', Object.assign(new (class Report {})(), GOOD)],
    ['an empty object', {}]
  ])('rejects %s', (_label, raw) => {
    expect(parseSyncTimingReport(raw)).toBeNull()
  })

  it.each(['frameBytes', 'decodeMs', 'hydrateMs'] as const)(
    'rejects a report missing %s',
    (key) => {
      const bad: Record<string, unknown> = { ...GOOD }
      delete bad[key]
      expect(parseSyncTimingReport(bad)).toBeNull()
    }
  )

  it.each([
    ['a numeric string', '12'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative number', -1],
    ['a barely negative number', -0.001],
    ['null', null],
    ['a boolean', true],
    ['an object', { valueOf: () => 5 }],
    ['a bigint', 5n]
  ])('rejects %s in any field', (_label, value) => {
    for (const key of ['frameBytes', 'decodeMs', 'syncToFrameMs', 'hydrateMs']) {
      expect(parseSyncTimingReport({ ...GOOD, [key]: value }), key).toBeNull()
    }
  })

  it('clamps values above the sane maxima instead of trusting them', () => {
    expect(
      parseSyncTimingReport({
        frameBytes: 1e300,
        decodeMs: 1e300,
        syncToFrameMs: MAX_REPORT_MS + 1,
        hydrateMs: Number.MAX_VALUE
      })
    ).toEqual({
      frameBytes: MAX_FRAME_BYTES,
      decodeMs: MAX_REPORT_MS,
      syncToFrameMs: MAX_REPORT_MS,
      hydrateMs: MAX_REPORT_MS
    })
  })
})

describe('SyncTimingReports.report', () => {
  it('writes ONE SyncStats line in the desktop line shape, transport=web', () => {
    new SyncTimingReports().report('c1', GOOD)
    expect(lines()).toEqual([
      [
        'info',
        'SyncStats',
        'client sync-full applied: transport=web frameChars=1234567 decodeMs=12.3 ' +
          'syncToFrameMs=56.8 hydrateMs=90.1 totalMs=159.2'
      ]
    ])
  })

  it('omits syncToFrameMs from the line when the client did not send one', () => {
    const { syncToFrameMs: _omit, ...rest } = GOOD
    new SyncTimingReports().report('c1', rest)
    expect(lines()[0][2]).toBe(
      'client sync-full applied: transport=web frameChars=1234567 decodeMs=12.3 ' +
        'hydrateMs=90.1 totalMs=102.5'
    )
  })

  it('never lets a client string reach the log (extra keys, newlines, forged lines)', () => {
    new SyncTimingReports().report('c1', {
      ...GOOD,
      note: 'x\n2026-01-01 [SyncStats] sync-full sent: forged',
      transport: 'desktop',
      level: 'error',
      frameChars: 'evil\nline',
      message: 'evil'
    })
    const all = lines()
    expect(all).toHaveLength(1)
    expect(all[0][2]).not.toMatch(/forged|evil|\n/)
    expect(all[0][2]).toContain('transport=web')
    expect(all[0][2]).toContain('frameChars=1234567')
  })

  it('always logs at info, even past 2 s: a client-controlled number must not choose the level', () => {
    const reports = new SyncTimingReports()
    reports.report('c1', { frameBytes: 1, decodeMs: 500, syncToFrameMs: 500, hydrateMs: 1000 })
    expect(lines().map(([level]) => level)).toEqual(['info'])
    // 2001 ms total: the desktop relay would warn here; the host's web path must not.
    reports.report('c1', { frameBytes: 1, decodeMs: 500, syncToFrameMs: 500, hydrateMs: 1001 })
    expect(lines().map(([level]) => level)).toEqual(['info', 'info'])
    expect(lines()[1][2]).toMatch(/^slow client sync-full applied: transport=web /)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it('drops a malformed report without a log line', () => {
    const reports = new SyncTimingReports()
    for (const raw of [null, 'x', { ...GOOD, hydrateMs: Number.NaN }, { ...GOOD, decodeMs: -1 }]) {
      reports.report('c1', raw)
    }
    expect(lines()).toEqual([])
    expect(vi.mocked(logger.debug)).not.toHaveBeenCalled()
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
  })

  it('allows 6 reports a minute per connection and drops the rest, quietly', () => {
    const reports = new SyncTimingReports()
    for (let i = 0; i < MAX_REPORTS_PER_MINUTE + 4; i++) reports.report('c1', GOOD, 1000 + i)
    expect(MAX_REPORTS_PER_MINUTE).toBe(6)
    expect(lines()).toHaveLength(6)
  })

  it('budgets each connection separately', () => {
    const reports = new SyncTimingReports()
    for (let i = 0; i < 10; i++) reports.report('c1', GOOD, 1000)
    reports.report('c2', GOOD, 1000)
    expect(lines()).toHaveLength(7)
  })

  it('refills as the window slides: a slot frees 60 s after the call that took it', () => {
    const reports = new SyncTimingReports()
    for (let i = 0; i < 6; i++) reports.report('c1', GOOD, 1000)
    reports.report('c1', GOOD, 1000 + 59_999)
    expect(lines()).toHaveLength(6)
    reports.report('c1', GOOD, 1000 + 60_000)
    expect(lines()).toHaveLength(7)
  })

  it('charges malformed calls to the budget too, so spam cannot probe for free', () => {
    const reports = new SyncTimingReports()
    for (let i = 0; i < 6; i++) reports.report('c1', 'junk', 1000)
    reports.report('c1', GOOD, 1000)
    expect(lines()).toEqual([])
  })

  it('forgets a connection on release, and bounds the map if a release is ever missed', () => {
    const reports = new SyncTimingReports()
    for (let i = 0; i < 6; i++) reports.report('c1', GOOD, 1000)
    reports.releaseConnection('c1')
    expect(reports.trackedConnections()).toBe(0)
    reports.report('c1', GOOD, 1000)
    expect(lines()).toHaveLength(7)

    for (let i = 0; i < 5000; i++) reports.report(`leak-${i}`, GOOD, 1000)
    expect(reports.trackedConnections()).toBeLessThanOrEqual(1024)
  })
})
