/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// We test the pure logic of UsageFetcher by extracting key methods.
// Since the class has many dependencies (electron, fs, fetch), we replicate
// the testable pure functions here.
// ---------------------------------------------------------------------------

interface RateWindow {
  usedPercent: number
  resetsAt: string | null
}

interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number | null
  usedCredits: number
  utilization: number
}

interface AccountUsage {
  fiveHour: RateWindow
  sevenDay: RateWindow | null
  sevenDaySonnet: RateWindow | null
  sevenDayOpus: RateWindow | null
  extraUsage: ExtraUsage | null
  planName: string | null
  fetchedAt: number
  error: string | null
}

function defaultUsage(): AccountUsage {
  return {
    fiveHour: { usedPercent: 0, resetsAt: null },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    planName: null,
    fetchedAt: Date.now(),
    error: null
  }
}

function parseResponse(data: Record<string, unknown>): AccountUsage {
  const parseWindow = (key: string): RateWindow | null => {
    const w = data[key] as { utilization?: number; resets_at?: string } | undefined
    if (!w || typeof w.utilization !== 'number') return null
    return {
      usedPercent: w.utilization,
      resetsAt: w.resets_at ?? null
    }
  }

  const fiveHour = parseWindow('five_hour')

  let extraUsage: ExtraUsage | null = null
  const eu = data['extra_usage'] as
    | {
        is_enabled?: boolean
        monthly_limit?: number | null
        used_credits?: number
        utilization?: number
      }
    | undefined
    | null
  if (eu && typeof eu === 'object') {
    extraUsage = {
      isEnabled: eu.is_enabled ?? false,
      monthlyLimit: eu.monthly_limit ?? null,
      usedCredits: eu.used_credits ?? 0,
      utilization: eu.utilization ?? 0
    }
  }

  return {
    fiveHour: fiveHour ?? { usedPercent: 0, resetsAt: null },
    sevenDay: parseWindow('seven_day'),
    sevenDaySonnet: parseWindow('seven_day_sonnet'),
    sevenDayOpus: parseWindow('seven_day_opus'),
    extraUsage,
    planName: null,
    fetchedAt: Date.now(),
    error: null
  }
}

// Replicate updateFromRateLimitEvent logic
function updateFromRateLimitEvent(
  lastUsage: AccountUsage | null,
  info: Record<string, unknown>
): AccountUsage | null {
  const utilization = info.utilization as number | undefined
  const rateLimitType = info.rateLimitType as string | undefined
  const resetsAt = info.resetsAt as number | undefined

  if (typeof utilization !== 'number') return null

  const window: RateWindow = {
    usedPercent: utilization * 100,
    resetsAt: typeof resetsAt === 'number' ? new Date(resetsAt * 1000).toISOString() : null
  }

  const fieldMap: Record<string, keyof AccountUsage> = {
    five_hour: 'fiveHour',
    seven_day: 'sevenDay',
    seven_day_sonnet: 'sevenDaySonnet',
    seven_day_opus: 'sevenDayOpus'
  }

  const field = rateLimitType ? fieldMap[rateLimitType] : undefined
  if (!field) return null

  const base = lastUsage ?? defaultUsage()
  return {
    ...base,
    [field]: window,
    fetchedAt: Date.now(),
    error: null
  }
}

// Replicate updateFromHeaderUtilization logic
function updateFromHeaderUtilization(
  lastUsage: AccountUsage | null,
  headerUtil: Record<string, { utilization: number; resets_at: number }>
): AccountUsage | null {
  const base = lastUsage ?? defaultUsage()
  let updated = false

  const windowMap: Record<string, keyof AccountUsage> = {
    five_hour: 'fiveHour',
    seven_day: 'sevenDay'
  }

  const result: Record<string, unknown> = { ...base }

  for (const [key, field] of Object.entries(windowMap)) {
    const data = headerUtil[key]
    if (!data || typeof data.utilization !== 'number') continue

    const window: RateWindow = {
      usedPercent: data.utilization * 100,
      resetsAt:
        typeof data.resets_at === 'number' ? new Date(data.resets_at * 1000).toISOString() : null
    }

    result[field] = window
    updated = true
  }

  if (!updated) return null

  return {
    ...(result as unknown as AccountUsage),
    fetchedAt: Date.now(),
    error: null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseResponse', () => {
  it('parses a complete API response', () => {
    const data = {
      five_hour: { utilization: 45.5, resets_at: '2025-01-15T20:00:00Z' },
      seven_day: { utilization: 30.2, resets_at: '2025-01-20T00:00:00Z' },
      seven_day_sonnet: { utilization: 15.0 },
      seven_day_opus: { utilization: 10.0, resets_at: '2025-01-20T00:00:00Z' }
    }

    const result = parseResponse(data)
    expect(result.fiveHour.usedPercent).toBe(45.5)
    expect(result.fiveHour.resetsAt).toBe('2025-01-15T20:00:00Z')
    expect(result.sevenDay!.usedPercent).toBe(30.2)
    expect(result.sevenDaySonnet!.usedPercent).toBe(15.0)
    expect(result.sevenDaySonnet!.resetsAt).toBeNull()
    expect(result.sevenDayOpus!.usedPercent).toBe(10.0)
    expect(result.error).toBeNull()
  })

  it('defaults fiveHour to 0% when missing', () => {
    const result = parseResponse({})
    expect(result.fiveHour.usedPercent).toBe(0)
    expect(result.fiveHour.resetsAt).toBeNull()
  })

  it('returns null for missing optional windows', () => {
    const result = parseResponse({ five_hour: { utilization: 10 } })
    expect(result.sevenDay).toBeNull()
    expect(result.sevenDaySonnet).toBeNull()
    expect(result.sevenDayOpus).toBeNull()
  })

  it('parses extra_usage', () => {
    const data = {
      five_hour: { utilization: 10 },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 25.5,
        utilization: 0.255
      }
    }

    const result = parseResponse(data)
    expect(result.extraUsage).not.toBeNull()
    expect(result.extraUsage!.isEnabled).toBe(true)
    expect(result.extraUsage!.monthlyLimit).toBe(100)
    expect(result.extraUsage!.usedCredits).toBe(25.5)
    expect(result.extraUsage!.utilization).toBe(0.255)
  })

  it('handles null extra_usage', () => {
    const result = parseResponse({ five_hour: { utilization: 10 }, extra_usage: null })
    expect(result.extraUsage).toBeNull()
  })

  it('defaults extra_usage fields', () => {
    const result = parseResponse({ five_hour: { utilization: 10 }, extra_usage: {} })
    expect(result.extraUsage!.isEnabled).toBe(false)
    expect(result.extraUsage!.monthlyLimit).toBeNull()
    expect(result.extraUsage!.usedCredits).toBe(0)
  })

  it('skips windows with non-numeric utilization', () => {
    const result = parseResponse({
      five_hour: { utilization: 'high' },
      seven_day: { utilization: null }
    })
    expect(result.fiveHour.usedPercent).toBe(0) // fallback
    expect(result.sevenDay).toBeNull()
  })
})

describe('updateFromRateLimitEvent', () => {
  it('updates fiveHour from rate_limit_event', () => {
    const result = updateFromRateLimitEvent(null, {
      utilization: 0.75,
      rateLimitType: 'five_hour',
      resetsAt: 1705350000 // epoch seconds
    })

    expect(result).not.toBeNull()
    expect(result!.fiveHour.usedPercent).toBe(75)
    expect(result!.fiveHour.resetsAt).toBeTruthy()
  })

  it('updates sevenDay window', () => {
    const result = updateFromRateLimitEvent(null, {
      utilization: 0.3,
      rateLimitType: 'seven_day'
    })

    expect(result).not.toBeNull()
    expect(result!.sevenDay!.usedPercent).toBe(30)
    expect(result!.sevenDay!.resetsAt).toBeNull()
  })

  it('returns null for unknown rateLimitType', () => {
    const result = updateFromRateLimitEvent(null, {
      utilization: 0.5,
      rateLimitType: 'unknown_type'
    })
    expect(result).toBeNull()
  })

  it('returns null when utilization is not a number', () => {
    const result = updateFromRateLimitEvent(null, {
      rateLimitType: 'five_hour'
    })
    expect(result).toBeNull()
  })

  it('preserves existing usage data when updating', () => {
    const existing: AccountUsage = {
      ...defaultUsage(),
      sevenDay: { usedPercent: 20, resetsAt: null }
    }

    const result = updateFromRateLimitEvent(existing, {
      utilization: 0.8,
      rateLimitType: 'five_hour'
    })

    expect(result!.fiveHour.usedPercent).toBe(80)
    expect(result!.sevenDay!.usedPercent).toBe(20) // preserved
  })

  it('converts epoch seconds to ISO string for resetsAt', () => {
    const result = updateFromRateLimitEvent(null, {
      utilization: 0.5,
      rateLimitType: 'five_hour',
      resetsAt: 1705350000
    })

    expect(result!.fiveHour.resetsAt).toContain('2024-01-15')
  })
})

describe('updateFromHeaderUtilization', () => {
  it('updates both five_hour and seven_day', () => {
    const result = updateFromHeaderUtilization(null, {
      five_hour: { utilization: 0.6, resets_at: 1705350000 },
      seven_day: { utilization: 0.3, resets_at: 1705950000 }
    })

    expect(result).not.toBeNull()
    expect(result!.fiveHour.usedPercent).toBe(60)
    expect(result!.sevenDay!.usedPercent).toBe(30)
  })

  it('returns null when no valid data', () => {
    const result = updateFromHeaderUtilization(null, {})
    expect(result).toBeNull()
  })

  it('updates only the windows present', () => {
    const result = updateFromHeaderUtilization(null, {
      five_hour: { utilization: 0.5, resets_at: 1705350000 }
    })

    expect(result).not.toBeNull()
    expect(result!.fiveHour.usedPercent).toBe(50)
    expect(result!.sevenDay).toBeNull()
  })

  it('preserves existing data', () => {
    const existing: AccountUsage = {
      ...defaultUsage(),
      sevenDayOpus: { usedPercent: 15, resetsAt: null }
    }

    const result = updateFromHeaderUtilization(existing, {
      five_hour: { utilization: 0.4, resets_at: 1705350000 }
    })

    expect(result!.sevenDayOpus!.usedPercent).toBe(15)
  })

  it('skips entries with non-numeric utilization', () => {
    const result = updateFromHeaderUtilization(null, {
      five_hour: { utilization: 'bad' as unknown as number, resets_at: 0 }
    })
    expect(result).toBeNull()
  })
})
