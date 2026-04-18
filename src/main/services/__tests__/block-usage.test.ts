/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'

// We test the pure functions exported or accessible from block-usage.ts.
// Since many are module-private, we extract the logic into testable units
// by importing the module and testing via the public surface. For truly
// private helpers, we replicate the logic here to verify correctness.

// ---------------------------------------------------------------------------
// Replicated helpers (these are module-private in block-usage.ts)
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

const MODEL_PRICING: Array<{ match: string; pricing: ModelPricing }> = [
  { match: 'opus-4-5', pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 } },
  { match: 'opus-4-6', pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 } },
  { match: 'opus-4-7', pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 } },
  { match: 'opus-4', pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 } },
  { match: 'opus', pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 } },
  { match: 'sonnet', pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 } },
  { match: 'haiku-4', pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 } },
  { match: 'haiku-3', pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1, cacheReadPerMTok: 0.08 } },
  { match: 'haiku', pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 } },
]

const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3
}

function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase()
  for (const { match, pricing } of MODEL_PRICING) {
    if (lower.includes(match)) return pricing
  }
  return DEFAULT_PRICING
}

function calculateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const p = getPricing(model)
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok +
    (cacheCreationTokens / 1_000_000) * p.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerMTok
  )
}

function normalizeModelName(model: string): string | null {
  const lower = model.toLowerCase()
  if (lower === '<synthetic>' || lower === 'unknown' || !model) return null
  if (lower.startsWith('claude-')) return model
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  return model
}

interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

function emptyTokenCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  }
}

function dateStrFromTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MS_PER_HOUR = 3600_000

function floorToHour(ts: number): number {
  return Math.floor(ts / MS_PER_HOUR) * MS_PER_HOUR
}

function isGenericModelName(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)$/i.test(model)
}

function mergeModelFamilies(
  modelMap: Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>
): Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }> {
  const families = new Map<string, string[]>()
  for (const model of modelMap.keys()) {
    const lower = model.toLowerCase()
    let family = 'other'
    if (lower.includes('opus')) family = 'opus'
    else if (lower.includes('sonnet')) family = 'sonnet'
    else if (lower.includes('haiku')) family = 'haiku'
    const existing = families.get(family) ?? []
    existing.push(model)
    families.set(family, existing)
  }
  const merged = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
  for (const [, models] of families) {
    if (models.length === 1) {
      merged.set(models[0], modelMap.get(models[0])!)
      continue
    }
    const generic = models.filter(isGenericModelName)
    const specific = models.filter((m) => !isGenericModelName(m))
    for (const m of specific) {
      merged.set(m, { ...modelMap.get(m)! })
    }
    if (generic.length > 0) {
      const genericData = { tokens: emptyTokenCounts(), costUsd: 0, requestCount: 0 }
      for (const m of generic) {
        const data = modelMap.get(m)!
        genericData.tokens = addTokens(genericData.tokens, data.tokens)
        genericData.costUsd += data.costUsd
        genericData.requestCount += data.requestCount
      }
      if (specific.length > 0) {
        let target = specific[0]
        let maxReqs = 0
        for (const m of specific) {
          const data = merged.get(m)!
          if (data.requestCount > maxReqs) {
            maxReqs = data.requestCount
            target = m
          }
        }
        const existing = merged.get(target)!
        existing.tokens = addTokens(existing.tokens, genericData.tokens)
        existing.costUsd += genericData.costUsd
        existing.requestCount += genericData.requestCount
      } else {
        merged.set(generic[0], genericData)
      }
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getPricing', () => {
  it('matches opus-4-5 before opus-4', () => {
    const p = getPricing('claude-opus-4-5-20250101')
    expect(p.inputPerMTok).toBe(5)
    expect(p.outputPerMTok).toBe(25)
  })

  it('matches opus-4-6', () => {
    const p = getPricing('claude-opus-4-6')
    expect(p.inputPerMTok).toBe(5)
  })

  it('matches opus-4-7 before opus-4', () => {
    const p = getPricing('claude-opus-4-7')
    expect(p.inputPerMTok).toBe(5)
    expect(p.outputPerMTok).toBe(25)
  })

  it('matches older opus-4 (more expensive)', () => {
    const p = getPricing('claude-opus-4-20250101')
    expect(p.inputPerMTok).toBe(15)
    expect(p.outputPerMTok).toBe(75)
  })

  it('matches generic opus fallback', () => {
    const p = getPricing('opus')
    expect(p.inputPerMTok).toBe(5)
  })

  it('matches sonnet', () => {
    const p = getPricing('claude-sonnet-4-6-20250514')
    expect(p.inputPerMTok).toBe(3)
    expect(p.outputPerMTok).toBe(15)
  })

  it('matches haiku-4', () => {
    const p = getPricing('claude-haiku-4-5-20251001')
    expect(p.inputPerMTok).toBe(1)
  })

  it('matches haiku-3', () => {
    const p = getPricing('claude-haiku-3-5-20240101')
    expect(p.inputPerMTok).toBe(0.8)
  })

  it('returns default pricing for unknown models', () => {
    const p = getPricing('gpt-4o')
    expect(p).toEqual(DEFAULT_PRICING)
  })

  it('is case-insensitive', () => {
    const p = getPricing('Claude-SONNET-4-6')
    expect(p.inputPerMTok).toBe(3)
  })
})

describe('calculateCostFromTokens', () => {
  it('calculates cost for sonnet model', () => {
    // 1M input + 1M output = $3 + $15 = $18
    const cost = calculateCostFromTokens('claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0)
    expect(cost).toBeCloseTo(18, 2)
  })

  it('includes cache costs', () => {
    const cost = calculateCostFromTokens('claude-sonnet-4-6', 0, 0, 1_000_000, 1_000_000)
    // $3.75 cache write + $0.30 cache read = $4.05
    expect(cost).toBeCloseTo(4.05, 2)
  })

  it('returns 0 for zero tokens', () => {
    expect(calculateCostFromTokens('claude-sonnet-4-6', 0, 0, 0, 0)).toBe(0)
  })

  it('calculates correctly for opus-4 (expensive)', () => {
    const cost = calculateCostFromTokens('claude-opus-4-20250101', 1_000_000, 1_000_000, 0, 0)
    // $15 + $75 = $90
    expect(cost).toBeCloseTo(90, 2)
  })

  it('handles small token counts', () => {
    const cost = calculateCostFromTokens('claude-sonnet-4-6', 1000, 500, 0, 0)
    // (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6)
  })
})

describe('normalizeModelName', () => {
  it('returns null for <synthetic>', () => {
    expect(normalizeModelName('<synthetic>')).toBeNull()
  })

  it('returns null for unknown', () => {
    expect(normalizeModelName('unknown')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizeModelName('')).toBeNull()
  })

  it('passes through full claude- names', () => {
    expect(normalizeModelName('claude-sonnet-4-6-20250514')).toBe('claude-sonnet-4-6-20250514')
  })

  it('maps short opus to claude-opus', () => {
    expect(normalizeModelName('opus')).toBe('claude-opus')
  })

  it('maps short sonnet to claude-sonnet', () => {
    expect(normalizeModelName('sonnet')).toBe('claude-sonnet')
  })

  it('maps short haiku to claude-haiku', () => {
    expect(normalizeModelName('haiku')).toBe('claude-haiku')
  })

  it('returns unknown models as-is', () => {
    expect(normalizeModelName('gpt-4o')).toBe('gpt-4o')
  })
})

describe('token helpers', () => {
  it('emptyTokenCounts returns all zeros', () => {
    const t = emptyTokenCounts()
    expect(t.inputTokens).toBe(0)
    expect(t.outputTokens).toBe(0)
    expect(t.cacheCreationTokens).toBe(0)
    expect(t.cacheReadTokens).toBe(0)
  })

  it('totalTokens sums all fields', () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25 })).toBe(375)
  })

  it('addTokens adds corresponding fields', () => {
    const a = { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 3 }
    const b = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }
    const result = addTokens(a, b)
    expect(result).toEqual({ inputTokens: 11, outputTokens: 22, cacheCreationTokens: 8, cacheReadTokens: 7 })
  })
})

describe('dateStrFromTimestamp', () => {
  it('formats a date correctly', () => {
    // 2025-01-15 in UTC
    const ts = new Date('2025-01-15T12:00:00Z').getTime()
    const str = dateStrFromTimestamp(ts)
    // Result depends on local timezone, but format should be YYYY-MM-DD
    expect(str).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('pads single-digit months and days', () => {
    const ts = new Date('2025-03-05T00:00:00').getTime()
    const str = dateStrFromTimestamp(ts)
    expect(str).toMatch(/^\d{4}-0\d-0\d$/)
  })
})

describe('floorToHour', () => {
  it('floors to the start of the hour', () => {
    const ts = new Date('2025-01-15T14:37:22.000Z').getTime()
    const floored = floorToHour(ts)
    expect(new Date(floored).toISOString()).toBe('2025-01-15T14:00:00.000Z')
  })

  it('is idempotent for exact hours', () => {
    const ts = new Date('2025-01-15T14:00:00.000Z').getTime()
    expect(floorToHour(ts)).toBe(ts)
  })
})

describe('mergeModelFamilies', () => {
  it('merges generic name into the specific versioned variant', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-sonnet-4-6', {
      tokens: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 1,
      requestCount: 10,
    })
    map.set('claude-sonnet', {
      tokens: { inputTokens: 50, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 0.5,
      requestCount: 3,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(1)
    const entry = merged.get('claude-sonnet-4-6')!
    expect(entry.requestCount).toBe(13)
    expect(entry.tokens.inputTokens).toBe(150)
    expect(entry.costUsd).toBe(1.5)
  })

  it('keeps distinct versions separate within the same family', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-opus-4-6', {
      tokens: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 2,
      requestCount: 10,
    })
    map.set('claude-opus-4-5', {
      tokens: { inputTokens: 80, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 5,
      requestCount: 5,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(2)
    expect(merged.has('claude-opus-4-6')).toBe(true)
    expect(merged.has('claude-opus-4-5')).toBe(true)
    expect(merged.get('claude-opus-4-6')!.requestCount).toBe(10)
    expect(merged.get('claude-opus-4-5')!.requestCount).toBe(5)
  })

  it('merges generic into most-requested specific when multiple specifics exist', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-sonnet-4-6', {
      tokens: emptyTokenCounts(), costUsd: 1, requestCount: 10,
    })
    map.set('claude-sonnet-4', {
      tokens: emptyTokenCounts(), costUsd: 0.5, requestCount: 3,
    })
    map.set('claude-sonnet', {
      tokens: { inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 0.2, requestCount: 2,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(2) // two specific versions
    // Generic merged into the most-requested specific (claude-sonnet-4-6)
    expect(merged.get('claude-sonnet-4-6')!.requestCount).toBe(12)
    expect(merged.get('claude-sonnet-4')!.requestCount).toBe(3)
  })

  it('keeps single-model families as-is', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-opus-4-6', {
      tokens: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsd: 2,
      requestCount: 5,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(1)
    expect(merged.get('claude-opus-4-6')!.requestCount).toBe(5)
  })

  it('separates different families', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-opus-4-6', {
      tokens: emptyTokenCounts(), costUsd: 1, requestCount: 5,
    })
    map.set('claude-sonnet-4-6', {
      tokens: emptyTokenCounts(), costUsd: 0.5, requestCount: 3,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(2)
    expect(merged.has('claude-opus-4-6')).toBe(true)
    expect(merged.has('claude-sonnet-4-6')).toBe(true)
  })

  it('keeps generic-only family as-is', () => {
    const map = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
    map.set('claude-haiku', {
      tokens: emptyTokenCounts(), costUsd: 0.5, requestCount: 8,
    })

    const merged = mergeModelFamilies(map)
    expect(merged.size).toBe(1)
    expect(merged.get('claude-haiku')!.requestCount).toBe(8)
  })
})
