/**
 * @vitest-environment node
 *
 * S3c — one rule for what a limit window is called, from the length the API
 * states. The whole table, because every surface (the sample writer, the value
 * ledger, the accounts panel, the sidebar popup) now spells a kind through it,
 * and a disagreement between two of them is a window silently split into two
 * series.
 */

import { describe, it, expect } from 'vitest'
import {
  isShortWindow,
  UNKNOWN_WINDOW_LABEL,
  windowKindForMinutes,
  windowKindLabel,
  windowKindMinutes,
  windowKindsForReading
} from '../window-kind'

describe('windowKindForMinutes', () => {
  it('names the two lengths that have names', () => {
    expect(windowKindForMinutes(300, 'primary')).toBe('5h')
    expect(windowKindForMinutes(10_080, 'primary')).toBe('7d')
    // The slot never decides — a weekly window in the primary slot is weekly.
    expect(windowKindForMinutes(10_080, 'secondary')).toBe('7d')
  })

  it('spells any other whole number of days in days and of hours in hours', () => {
    expect(windowKindForMinutes(4320, 'primary')).toBe('3d')
    expect(windowKindForMinutes(1440, 'primary')).toBe('1d')
    expect(windowKindForMinutes(60, 'primary')).toBe('1h')
    expect(windowKindForMinutes(180, 'secondary')).toBe('3h')
    // 30 h is neither a whole number of days nor the familiar 5 h.
    expect(windowKindForMinutes(1800, 'primary')).toBe('30h')
  })

  it('falls to minutes for anything else, fraction included', () => {
    expect(windowKindForMinutes(45, 'primary')).toBe('45m')
    expect(windowKindForMinutes(90, 'primary')).toBe('90m')
    expect(windowKindForMinutes(0.5, 'primary')).toBe('0.5m')
  })

  it('a window with no usable duration is the slot itself, never a guessed 5h', () => {
    for (const minutes of [null, undefined, 0, -300, NaN, Infinity]) {
      expect(windowKindForMinutes(minutes, 'primary')).toBe('primary')
      expect(windowKindForMinutes(minutes, 'secondary')).toBe('secondary')
    }
  })
})

describe('windowKindsForReading', () => {
  it('leaves two different lengths alone', () => {
    expect(
      windowKindsForReading({
        primary: { windowMinutes: 300 },
        secondary: { windowMinutes: 10_080 }
      })
    ).toEqual({ primary: '5h', secondary: '7d' })
  })

  /**
   * The kind is an identity downstream — the sample dedup key, `usage_window`'s
   * primary key, one row per kind in `latestWindowSamples`, the meter's React
   * key — so two windows may never share one.
   */
  it('suffixes the secondary when both slots state the SAME length', () => {
    expect(
      windowKindsForReading({
        primary: { windowMinutes: 10_080 },
        secondary: { windowMinutes: 10_080 }
      })
    ).toEqual({ primary: '7d', secondary: '7d:secondary' })
    expect(
      windowKindsForReading({ primary: { windowMinutes: 60 }, secondary: { windowMinutes: 60 } })
    ).toEqual({ primary: '1h', secondary: '1h:secondary' })
  })

  it('reads the suffixed kind’s length and label off its base', () => {
    const { secondary } = windowKindsForReading({
      primary: { windowMinutes: 10_080 },
      secondary: { windowMinutes: 10_080 }
    })
    expect(windowKindMinutes(secondary)).toBe(10_080)
    expect(windowKindLabel(secondary)).toBe('7-day secondary')
    expect(isShortWindow(secondary)).toBe(false)
  })

  it('never collides two length-less slots — they keep their own names', () => {
    expect(windowKindsForReading({ primary: { windowMinutes: null }, secondary: {} })).toEqual({
      primary: 'primary',
      secondary: 'secondary'
    })
  })

  it('answers for a reading with one slot, or none', () => {
    expect(windowKindsForReading({ primary: { windowMinutes: 10_080 }, secondary: null })).toEqual({
      primary: '7d',
      secondary: 'secondary'
    })
    expect(windowKindsForReading({})).toEqual({ primary: 'primary', secondary: 'secondary' })
  })
})

describe('windowKindLabel', () => {
  it('says the length a person would say', () => {
    expect(windowKindLabel('5h')).toBe('5-hour')
    expect(windowKindLabel('7d')).toBe('7-day')
    expect(windowKindLabel('3d')).toBe('3-day')
    expect(windowKindLabel('1h')).toBe('1-hour')
    expect(windowKindLabel('45m')).toBe('45-minute')
  })

  it('labels a length-less window `limit`', () => {
    expect(windowKindLabel('primary')).toBe(UNKNOWN_WINDOW_LABEL)
    expect(windowKindLabel('secondary')).toBe('limit')
  })

  it('keeps a scoped weekly’s slug beside its base label', () => {
    expect(windowKindLabel('7d:opus')).toBe('7-day opus')
    expect(windowKindLabel('7d:claude-fable')).toBe('7-day claude fable')
  })

  it('returns an unrecognised kind unchanged rather than inventing a word', () => {
    expect(windowKindLabel('monthly')).toBe('monthly')
  })
})

describe('windowKindMinutes', () => {
  it('reads the length back out of the kind', () => {
    expect(windowKindMinutes('5h')).toBe(300)
    expect(windowKindMinutes('7d')).toBe(10_080)
    expect(windowKindMinutes('3d')).toBe(4320)
    expect(windowKindMinutes('45m')).toBe(45)
    // A scoped weekly is a week, like its base.
    expect(windowKindMinutes('7d:fable')).toBe(10_080)
  })

  it('answers null when the kind names no length', () => {
    expect(windowKindMinutes('primary')).toBeNull()
    expect(windowKindMinutes('secondary')).toBeNull()
    expect(windowKindMinutes('monthly')).toBeNull()
  })

  it('round-trips every kind the forward rule can produce', () => {
    for (const minutes of [300, 10_080, 4320, 60, 1800, 45, 1440]) {
      expect(windowKindMinutes(windowKindForMinutes(minutes, 'primary'))).toBe(minutes)
    }
  })
})

describe('isShortWindow', () => {
  it('splits at a day, by the stated minutes first', () => {
    expect(isShortWindow('5h')).toBe(true)
    expect(isShortWindow('7d')).toBe(false)
    expect(isShortWindow('3d')).toBe(false)
    expect(isShortWindow('7d:fable')).toBe(false)
    expect(isShortWindow('1d')).toBe(false)
    expect(isShortWindow('23h')).toBe(true)
  })

  it('believes the minutes over the kind when the two disagree', () => {
    // A pre-S3c ChatGPT row kinded `5h` whose reading now carries a week.
    expect(isShortWindow('5h', 10_080)).toBe(false)
    expect(isShortWindow('7d', 60)).toBe(true)
  })

  it('treats a window of unknown length as short — a countdown is true of any window', () => {
    expect(isShortWindow('primary')).toBe(true)
    expect(isShortWindow('primary', null)).toBe(true)
  })
})
