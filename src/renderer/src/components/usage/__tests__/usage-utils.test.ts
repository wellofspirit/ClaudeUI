import { describe, it, expect, beforeEach } from 'vitest'
import {
  PROVIDER_OVERFLOW_COLOR,
  PROVIDER_SERIES_COLORS,
  buildProviderColorMap,
  formatReset,
  formatResetRelative,
  meterSeverity,
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

// ---------------------------------------------------------------------------
// The dashboard's palette and meter vocabulary (ADR-071 §8)
// ---------------------------------------------------------------------------

describe('buildProviderColorMap', () => {
  it('pins anthropic to the first slot and openai to the second, whatever the input order', () => {
    const map = buildProviderColorMap(['openrouter', 'openai', 'anthropic'])
    expect(map.get('anthropic')).toBe(PROVIDER_SERIES_COLORS[0])
    expect(map.get('openai')).toBe(PROVIDER_SERIES_COLORS[1])
    expect(map.get('openrouter')).toBe(PROVIDER_SERIES_COLORS[2])
  })

  it('gives an unpinned provider the same colour whether or not a pinned one is present', () => {
    // A filter that drops Anthropic must not repaint OpenRouter.
    const withPinned = buildProviderColorMap(['anthropic', 'openai', 'openrouter'])
    const withoutOne = buildProviderColorMap(['anthropic', 'openrouter'])
    expect(withoutOne.get('anthropic')).toBe(withPinned.get('anthropic'))
    // Slots close up when a provider genuinely leaves the data, which is the
    // documented behaviour: the map is rebuilt from what the range returned.
    expect(withoutOne.get('openrouter')).toBe(PROVIDER_SERIES_COLORS[1])
  })

  it('folds providers past the validated five into one neutral rather than inventing a hue', () => {
    const map = buildProviderColorMap(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(map.get('e')).toBe(PROVIDER_SERIES_COLORS[4])
    expect(map.get('f')).toBe(PROVIDER_OVERFLOW_COLOR)
    expect(map.get('g')).toBe(PROVIDER_OVERFLOW_COLOR)
  })
})

describe('meterSeverity', () => {
  it('grades at 70 and 90', () => {
    expect(meterSeverity(0)).toBe('ok')
    expect(meterSeverity(69.9)).toBe('ok')
    expect(meterSeverity(70)).toBe('warn')
    expect(meterSeverity(89.9)).toBe('warn')
    expect(meterSeverity(90)).toBe('crit')
    expect(meterSeverity(100)).toBe('crit')
  })
})

describe('formatResetRelative', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('counts forward to the reset', () => {
    expect(formatResetRelative('2026-09-21T13:48:00.000Z', now)).toBe('in 1h 48m')
  })

  it('says now for a window that has already turned over', () => {
    expect(formatResetRelative('2026-09-21T11:00:00.000Z', now)).toBe('now')
  })

  it('draws a dash rather than a guess when there is no reset to show', () => {
    expect(formatResetRelative(null, now)).toBe('—')
    expect(formatResetRelative('not a date', now)).toBe('—')
  })
})

describe('formatReset', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('counts a 5-hour window down, because that wait is actionable', () => {
    expect(formatReset('5h', '2026-09-21T13:48:00.000Z', now)).toBe('in 1h 48m')
  })

  it('names the weekday and clock time for a weekly window', () => {
    // Built from LOCAL parts so the expectation holds in any timezone.
    const at = new Date(2026, 8, 24, 9, 0, 0)
    expect(formatReset('7d', at.toISOString(), now)).toBe('Thu 09:00')
    expect(formatReset('7d:fable', at.toISOString(), now)).toBe('Thu 09:00')
  })

  it('pads a single-digit hour and minute', () => {
    const at = new Date(2026, 8, 21, 7, 5, 0)
    expect(formatReset('7d', at.toISOString(), now)).toBe('Mon 07:05')
  })

  it('draws a dash rather than a guess when there is no reset to show', () => {
    expect(formatReset('7d', null, now)).toBe('—')
    expect(formatReset('5h', 'not a date', now)).toBe('—')
  })
})
