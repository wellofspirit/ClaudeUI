/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { canonicalizeWindowEnd, accountForTimestamp, type AccountLogRecord } from '../../../core/services/usage-windows'

const T = (iso: string): number => new Date(iso).getTime()

describe('canonicalizeWindowEnd', () => {
  it('rounds sub-second jitter to the minute', () => {
    expect(canonicalizeWindowEnd(T('2026-06-10T09:00:00.578Z'), [])).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
    expect(canonicalizeWindowEnd(T('2026-06-10T08:59:59.732Z'), [])).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
  })

  it('preserves non-hour-aligned window ends', () => {
    // Real windows are not always hour-aligned (03:40:00Z observed in the wild)
    expect(canonicalizeWindowEnd(T('2026-06-10T03:40:00.000Z'), [])).toBe(
      T('2026-06-10T03:40:00.000Z')
    )
  })

  it('snaps to a known end within tolerance (first-seen wins)', () => {
    const known = [T('2026-06-10T09:00:00.000Z')]
    // 09:01 jitter snaps back to the canonical 09:00
    expect(canonicalizeWindowEnd(T('2026-06-10T09:01:10.000Z'), known)).toBe(known[0])
    expect(canonicalizeWindowEnd(T('2026-06-10T08:58:30.000Z'), known)).toBe(known[0])
  })

  it('does not snap across genuinely different windows', () => {
    const known = [T('2026-06-10T03:40:00.000Z')]
    expect(canonicalizeWindowEnd(T('2026-06-10T09:00:00.000Z'), known)).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
  })

  it('is stable across repeated jittery observations of one window', () => {
    const known: number[] = []
    const observations = [
      '2026-06-10T09:00:00.578Z',
      '2026-06-10T09:00:00.732Z',
      '2026-06-10T09:00:00.432Z',
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T09:00:59.000Z'
    ]
    const ends = new Set(
      observations.map((iso) => {
        const end = canonicalizeWindowEnd(T(iso), known)
        if (!known.includes(end)) known.push(end)
        return end
      })
    )
    expect(ends.size).toBe(1)
  })
})

describe('accountForTimestamp', () => {
  const log: AccountLogRecord[] = [
    { ts: 1000, accountUuid: 'a', email: 'a@example.com' },
    { ts: 5000, accountUuid: 'b', email: 'b@example.com' },
    { ts: 9000, accountUuid: 'a', email: 'a@example.com' }
  ]

  it('returns null before the first record (unattributable)', () => {
    expect(accountForTimestamp(log, 999)).toBeNull()
  })

  it('attributes to the account active at the timestamp', () => {
    expect(accountForTimestamp(log, 1000)).toBe('a@example.com')
    expect(accountForTimestamp(log, 4999)).toBe('a@example.com')
    expect(accountForTimestamp(log, 5000)).toBe('b@example.com')
    expect(accountForTimestamp(log, 8999)).toBe('b@example.com')
  })

  it('handles switching back to a previous account', () => {
    expect(accountForTimestamp(log, 9001)).toBe('a@example.com')
  })

  it('returns null for an empty log', () => {
    expect(accountForTimestamp([], 1234)).toBeNull()
  })
})
