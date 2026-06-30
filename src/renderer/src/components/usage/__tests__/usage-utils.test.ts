import { describe, it, expect, beforeEach } from 'vitest'
import {
  formatTokenCount,
  formatCost,
  sumTokens,
  shortModelName,
  formatTime,
  formatShortDate,
  formatDuration,
  getModelColor
} from '../usage-utils'

describe('formatTokenCount', () => {
  it('formats millions', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })

  it('formats exactly 1M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
  })

  it('formats thousands', () => {
    expect(formatTokenCount(45_000)).toBe('45.0K')
  })

  it('formats exactly 1K', () => {
    expect(formatTokenCount(1_000)).toBe('1.0K')
  })

  it('formats small numbers as-is', () => {
    expect(formatTokenCount(500)).toBe('500')
  })

  it('formats zero', () => {
    expect(formatTokenCount(0)).toBe('0')
  })
})

describe('formatCost', () => {
  it('formats dollar amounts >= $1 with 2 decimals', () => {
    expect(formatCost(5.123)).toBe('$5.12')
  })

  it('formats cent amounts with 2 decimals', () => {
    expect(formatCost(0.05)).toBe('$0.05')
  })

  it('formats sub-cent amounts with 4 decimals', () => {
    expect(formatCost(0.0012)).toBe('$0.0012')
  })

  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('formats exactly $1', () => {
    expect(formatCost(1)).toBe('$1.00')
  })
})

describe('sumTokens', () => {
  it('sums all token fields', () => {
    expect(
      sumTokens({
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 25
      })
    ).toBe(375)
  })

  it('returns 0 for all-zero counts', () => {
    expect(
      sumTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0
      })
    ).toBe(0)
  })
})

describe('shortModelName', () => {
  it('formats opus with major.minor version', () => {
    expect(shortModelName('claude-opus-4-6-20250514')).toBe('Opus 4.6')
  })

  it('formats sonnet with major.minor version', () => {
    expect(shortModelName('claude-sonnet-4-6-20250514')).toBe('Sonnet 4.6')
  })

  it('formats haiku with major.minor version', () => {
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('formats fable, including the [1m] context suffix', () => {
    expect(shortModelName('claude-fable-5')).toBe('Fable 5')
    expect(shortModelName('claude-fable-5[1m]')).toBe('Fable 5')
  })

  it('formats opus 4.5 distinctly from 4.6', () => {
    expect(shortModelName('claude-opus-4-5-20250101')).toBe('Opus 4.5')
  })

  it('formats model with major-only version', () => {
    expect(shortModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  })

  it('formats older versions correctly', () => {
    expect(shortModelName('claude-haiku-3-5-20240101')).toBe('Haiku 3.5')
  })

  it('capitalizes short names without version', () => {
    expect(shortModelName('opus')).toBe('Opus')
    expect(shortModelName('sonnet')).toBe('Sonnet')
    expect(shortModelName('haiku')).toBe('Haiku')
  })

  it('returns unknown (non-Claude) model ids as-is — does not mangle', () => {
    expect(shortModelName('some-model-name')).toBe('some-model-name')
  })

  it('does not mangle opencode model ids (regression: mimo-v2.5-free → was "v2.5-free")', () => {
    expect(shortModelName('mimo-v2.5-free')).toBe('mimo-v2.5-free')
    expect(shortModelName('grok-code-fast')).toBe('grok-code-fast')
    expect(shortModelName('glm-4.6')).toBe('glm-4.6')
  })

  it('returns model as-is for short names', () => {
    expect(shortModelName('gpt')).toBe('gpt')
  })
})

describe('formatTime', () => {
  it('formats morning time', () => {
    const ts = new Date('2025-01-15T09:05:00').getTime()
    expect(formatTime(ts)).toBe('9:05 AM')
  })

  it('formats afternoon time', () => {
    const ts = new Date('2025-01-15T14:30:00').getTime()
    expect(formatTime(ts)).toBe('2:30 PM')
  })

  it('formats midnight as 12:00 AM', () => {
    const ts = new Date('2025-01-15T00:00:00').getTime()
    expect(formatTime(ts)).toBe('12:00 AM')
  })

  it('formats noon as 12:00 PM', () => {
    const ts = new Date('2025-01-15T12:00:00').getTime()
    expect(formatTime(ts)).toBe('12:00 PM')
  })

  it('pads minutes with leading zero', () => {
    const ts = new Date('2025-01-15T08:03:00').getTime()
    expect(formatTime(ts)).toBe('8:03 AM')
  })
})

describe('formatShortDate', () => {
  it('formats a date string', () => {
    expect(formatShortDate('2025-01-15')).toBe('Jan 15')
  })

  it('formats different months', () => {
    expect(formatShortDate('2025-12-01')).toBe('Dec 1')
  })

  it('formats February', () => {
    expect(formatShortDate('2025-02-28')).toBe('Feb 28')
  })
})

describe('formatDuration', () => {
  it('formats minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5m')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
  })

  it('formats zero as seconds', () => {
    expect(formatDuration(0)).toBe('0s')
  })

  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(45_000)).toBe('45s')
  })

  it('formats exact hours', () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe('2h 0m')
  })

  it('floors partial minutes', () => {
    expect(formatDuration(5.5 * 60_000)).toBe('5m')
  })
})

describe('getModelColor', () => {
  beforeEach(() => {
    // Note: colorCache is module-level, so colors persist across tests.
    // The first call sets the cache. This is intentional and tests the caching.
  })

  it('returns electric indigo for opus models', () => {
    expect(getModelColor('claude-opus-4-6')).toBe('#7c5cff')
  })

  it('returns terracotta coral for fable models', () => {
    expect(getModelColor('claude-fable-5')).toBe('#d97757')
    expect(getModelColor('claude-fable-5[1m]')).toBe('#d97757')
  })

  it('returns amber for sonnet models', () => {
    expect(getModelColor('claude-sonnet-4-6')).toBe('#e8a728')
  })

  it('returns cyan for haiku models', () => {
    expect(getModelColor('claude-haiku-4-5')).toBe('#06b6d4')
  })

  it('returns a fallback color for unknown models', () => {
    const color = getModelColor('some-unknown-model')
    expect(color).toBeTruthy()
    expect(color.startsWith('#')).toBe(true)
  })

  it('returns same color for same model (caching)', () => {
    const c1 = getModelColor('test-model-xyz')
    const c2 = getModelColor('test-model-xyz')
    expect(c1).toBe(c2)
  })
})
