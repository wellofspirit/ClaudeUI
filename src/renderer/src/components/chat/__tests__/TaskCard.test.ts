/**
 * Layer 1: Unit tests for pure utility functions in TaskCard.tsx.
 *
 * Tests parseUsage, formatDuration, formatElapsed, and formatTokens.
 * No rendering, no store, no IPC — pure string/number transformations.
 */

import { describe, it, expect } from 'vitest'
import { parseUsage, formatDuration, formatElapsed, formatTokens } from '../TaskCard'

// ---------------------------------------------------------------------------
// parseUsage
// ---------------------------------------------------------------------------

describe('parseUsage', () => {
  it('parseUsage_noUsageTag_returnsBodyUnchangedAndNullUsage', () => {
    const text = 'Task completed successfully.'
    const result = parseUsage(text)
    expect(result.body).toBe(text)
    expect(result.usage).toBeNull()
  })

  it('parseUsage_withAllFields_parsesAllValuesCorrectly', () => {
    const text = `Some result text\n<usage>\ntotal_tokens: 12345\ntool_uses: 7\nduration_ms: 45000\n</usage>`
    const result = parseUsage(text)
    expect(result.body).toBe('Some result text')
    expect(result.usage).toEqual({
      totalTokens: 12345,
      toolUses: 7,
      durationMs: 45000,
    })
  })

  it('parseUsage_withPartialFields_missingFieldsAreNull', () => {
    const text = `Output\n<usage>\ntotal_tokens: 500\n</usage>`
    const result = parseUsage(text)
    expect(result.usage?.totalTokens).toBe(500)
    expect(result.usage?.toolUses).toBeNull()
    expect(result.usage?.durationMs).toBeNull()
  })

  it('parseUsage_tagAtEndOfText_bodyIsTextBeforeTagTrimmed', () => {
    const text = `The task is done.\n<usage>\ntotal_tokens: 100\ntool_uses: 2\nduration_ms: 5000\n</usage>`
    const result = parseUsage(text)
    expect(result.body).toBe('The task is done.')
    expect(result.usage?.totalTokens).toBe(100)
  })

  it('parseUsage_tagInMiddleOfText_tagRemovedAndBodyTrimmed', () => {
    const text = `Before\n<usage>\ntotal_tokens: 200\n</usage>\nAfter`
    const result = parseUsage(text)
    // trimEnd removes trailing whitespace from the body
    expect(result.body).toBe('Before\n\nAfter')
    expect(result.usage?.totalTokens).toBe(200)
  })

  it('parseUsage_multiLineContentInsideTag_parsesCorrectly', () => {
    const text = [
      'Completed the analysis.',
      '<usage>',
      '  total_tokens: 9876',
      '  tool_uses: 15',
      '  duration_ms: 120000',
      '</usage>',
    ].join('\n')

    const result = parseUsage(text)
    expect(result.body).toBe('Completed the analysis.')
    expect(result.usage?.totalTokens).toBe(9876)
    expect(result.usage?.toolUses).toBe(15)
    expect(result.usage?.durationMs).toBe(120000)
  })

  it('parseUsage_onlyUsageTag_bodyIsEmpty', () => {
    const text = '<usage>\ntotal_tokens: 50\n</usage>'
    const result = parseUsage(text)
    expect(result.body).toBe('')
    expect(result.usage?.totalTokens).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('formatDuration_underOneSecond_appendsMs', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formatDuration_exactlyZero_returnsZeroMs', () => {
    expect(formatDuration(0)).toBe('0ms')
  })

  it('formatDuration_999ms_remainsInMsRange', () => {
    expect(formatDuration(999)).toBe('999ms')
  })

  it('formatDuration_oneSecond_switchesToSecondsFormat', () => {
    expect(formatDuration(1000)).toBe('1.0s')
  })

  it('formatDuration_oneAndHalfSeconds_showsDecimal', () => {
    expect(formatDuration(1500)).toBe('1.5s')
  })

  it('formatDuration_thirtySeconds_showsDecimal', () => {
    expect(formatDuration(30000)).toBe('30.0s')
  })

  it('formatDuration_justUnderOneMinute_staysInSecondsFormat', () => {
    expect(formatDuration(59999)).toBe('60.0s')
  })

  it('formatDuration_exactlyOneMinute_switchesToMinutesFormat', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
  })

  it('formatDuration_ninetySeconds_showsOneMinuteThirtySeconds', () => {
    expect(formatDuration(90000)).toBe('1m 30s')
  })

  it('formatDuration_twoMinutes_showsTwoMinutesZeroSeconds', () => {
    expect(formatDuration(120000)).toBe('2m 0s')
  })
})

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('formatElapsed_underOneMinute_appendsS', () => {
    expect(formatElapsed(5)).toBe('5s')
  })

  it('formatElapsed_thirtySeconds_returnsThirtyS', () => {
    expect(formatElapsed(30)).toBe('30s')
  })

  it('formatElapsed_59seconds_staysInSecondsFormat', () => {
    expect(formatElapsed(59)).toBe('59s')
  })

  it('formatElapsed_exactlyOneMinute_switchesToMinutesFormat', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
  })

  it('formatElapsed_ninetySeconds_showsOneMinuteThirtySeconds', () => {
    expect(formatElapsed(90)).toBe('1m 30s')
  })

  it('formatElapsed_125seconds_showsTwoMinutesFiveSeconds', () => {
    expect(formatElapsed(125)).toBe('2m 5s')
  })

  it('formatElapsed_fractionalSeconds_roundsToNearestSecond', () => {
    expect(formatElapsed(5.6)).toBe('6s')
    expect(formatElapsed(5.4)).toBe('5s')
  })
})

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('formatTokens_underOneThousand_returnsExactNumber', () => {
    expect(formatTokens(500)).toBe('500')
  })

  it('formatTokens_zero_returnsZero', () => {
    expect(formatTokens(0)).toBe('0')
  })

  it('formatTokens_999_staysUnderThreshold', () => {
    expect(formatTokens(999)).toBe('999')
  })

  it('formatTokens_exactlyOneThousand_switchesToKFormat', () => {
    expect(formatTokens(1000)).toBe('1.0k')
  })

  it('formatTokens_1500_showsOneDecimalPlace', () => {
    expect(formatTokens(1500)).toBe('1.5k')
  })

  it('formatTokens_15000_showsFifteenK', () => {
    expect(formatTokens(15000)).toBe('15.0k')
  })

  it('formatTokens_roundsToOneDecimalPlace', () => {
    // 1234 → 1.234 → "1.2k"
    expect(formatTokens(1234)).toBe('1.2k')
  })
})
