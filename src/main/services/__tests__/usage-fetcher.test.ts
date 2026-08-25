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
  sevenDayModels: Array<{ label: string; window: RateWindow }> | null
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
    sevenDayModels: null,
    extraUsage: null,
    planName: null,
    fetchedAt: Date.now(),
    error: null
  }
}

// Mirror of UsageFetcher.parseResponse (this file replicates pure logic by
// convention). Accepts both the flat /api/oauth/usage HTTP body and the
// structured `get_usage` SDK-relay shape (windows nested under rate_limits).
function parseResponse(data: Record<string, unknown>): AccountUsage {
  const isStructured = 'rate_limits' in data || 'rate_limits_available' in data
  const rateLimits =
    isStructured && data.rate_limits && typeof data.rate_limits === 'object'
      ? (data.rate_limits as Record<string, unknown>)
      : null
  const windowSource: Record<string, unknown> = isStructured ? (rateLimits ?? {}) : data

  const parseWindow = (key: string): RateWindow | null => {
    const w = windowSource[key] as
      { utilization?: number | null; resets_at?: string | null } | undefined | null
    if (!w || typeof w.utilization !== 'number') return null
    return {
      usedPercent: w.utilization,
      resetsAt: w.resets_at ?? null
    }
  }

  const fiveHour = parseWindow('five_hour')

  let extraUsage: ExtraUsage | null = null
  const eu = windowSource['extra_usage'] as
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

  const sevenDayModels: Array<{ label: string; window: RateWindow }> = []
  const limits = windowSource['limits']
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      const entry = raw as {
        kind?: unknown
        percent?: unknown
        resets_at?: string | null
        scope?: { model?: { display_name?: unknown } | null } | null
      } | null
      if (!entry || typeof entry !== 'object' || entry.kind !== 'weekly_scoped') continue
      const label = entry.scope?.model?.display_name
      if (typeof label !== 'string' || typeof entry.percent !== 'number') continue
      sevenDayModels.push({
        label,
        window: { usedPercent: entry.percent, resetsAt: entry.resets_at ?? null }
      })
    }
  }

  const planName = typeof data.subscription_type === 'string' ? data.subscription_type : null

  return {
    fiveHour: fiveHour ?? { usedPercent: 0, resetsAt: null },
    sevenDay: parseWindow('seven_day'),
    sevenDaySonnet: parseWindow('seven_day_sonnet'),
    sevenDayOpus: parseWindow('seven_day_opus'),
    sevenDayModels: sevenDayModels.length ? sevenDayModels : null,
    extraUsage,
    planName,
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

// ---------------------------------------------------------------------------
// Structured `get_usage` shape (SDK-relay fallback).
//
// cli.js v2.1.177 added a native `get_usage` control that supersedes the
// usage-relay patch. Its response nests the rate-limit windows (and
// extra_usage) under `rate_limits`, and adds session / subscription_type /
// behaviors / rate_limits_available. parseResponse must read windows from
// `rate_limits` for this shape — the old flat-shape parser silently produced
// 0% (the "API response missing five_hour utilization" warning the user hit).
// ---------------------------------------------------------------------------

describe('parseResponse — structured get_usage shape', () => {
  const structured = (rateLimits: Record<string, unknown> | null) => ({
    session: { total_cost_usd: 1.23, model_usage: {} },
    subscription_type: 'team',
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
    behaviors: null
  })

  it('reads windows nested under rate_limits', () => {
    const result = parseResponse(
      structured({
        five_hour: { utilization: 5, resets_at: '2026-06-22T11:59:59Z' },
        seven_day: { utilization: 32, resets_at: '2026-06-25T10:59:59Z' },
        seven_day_sonnet: { utilization: 8, resets_at: '2026-06-25T10:59:59Z' },
        seven_day_opus: null
      })
    )
    expect(result.fiveHour.usedPercent).toBe(5)
    expect(result.fiveHour.resetsAt).toBe('2026-06-22T11:59:59Z')
    expect(result.sevenDay!.usedPercent).toBe(32)
    expect(result.sevenDaySonnet!.usedPercent).toBe(8)
    expect(result.sevenDayOpus).toBeNull()
    expect(result.error).toBeNull()
  })

  it('maps subscription_type to planName', () => {
    const result = parseResponse(structured({ five_hour: { utilization: 5 } }))
    expect(result.planName).toBe('team')
  })

  it('parses extra_usage nested under rate_limits', () => {
    const result = parseResponse(
      structured({
        five_hour: { utilization: 5 },
        extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 0, utilization: null }
      })
    )
    expect(result.extraUsage).not.toBeNull()
    expect(result.extraUsage!.isEnabled).toBe(true)
    expect(result.extraUsage!.monthlyLimit).toBe(20000)
  })

  it('defaults to 0% (without crashing) when rate_limits is null — API-key / 3P sessions', () => {
    const result = parseResponse(structured(null))
    expect(result.fiveHour.usedPercent).toBe(0)
    expect(result.fiveHour.resetsAt).toBeNull()
    expect(result.sevenDay).toBeNull()
    expect(result.planName).toBe('team')
  })

  it('utilization stays 0-100 verbatim (no fraction conversion)', () => {
    const result = parseResponse(structured({ five_hour: { utilization: 50, resets_at: null } }))
    expect(result.fiveHour.usedPercent).toBe(50) // not 5000, not 0.5
  })
})

// ---------------------------------------------------------------------------
// Weekly per-model buckets (`rate_limits.limits[]`).
//
// The modern payload adds a generalized `limits[]` array beside the legacy
// per-window keys. A weekly per-model bucket (e.g. Fable) exists ONLY there —
// seven_day_opus / seven_day_sonnet are null on such accounts. cli.js keeps
// `kind === "weekly_scoped"` entries with a `scope.model` and titles the bar
// from `scope.model.display_name`; parseResponse mirrors that contract. The
// `percent` field is already 0-100 (like `utilization`, not a header fraction).
// ---------------------------------------------------------------------------

describe('parseResponse — weekly per-model buckets (limits[])', () => {
  const fable = {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 32,
    severity: 'normal',
    resets_at: '2026-08-29T05:00:00.991527+00:00',
    scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    is_active: false
  }
  const session = {
    kind: 'session',
    group: 'session',
    percent: 39,
    resets_at: '2026-08-25T11:39:59.991307+00:00',
    scope: null,
    is_active: true
  }
  const weeklyAll = {
    kind: 'weekly_all',
    group: 'weekly',
    percent: 18,
    resets_at: '2026-08-29T04:59:59.991327+00:00',
    scope: null,
    is_active: false
  }

  it('keeps weekly_scoped entries and labels them from scope.model.display_name', () => {
    const result = parseResponse({ five_hour: { utilization: 39 }, limits: [fable] })
    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } }
    ])
  })

  it('ignores session and weekly_all entries', () => {
    const result = parseResponse({ five_hour: { utilization: 39 }, limits: [session, weeklyAll] })
    expect(result.sevenDayModels).toBeNull()
  })

  it('reads limits[] nested under rate_limits (structured relay shape)', () => {
    const result = parseResponse({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 39 },
        seven_day_opus: null,
        seven_day_sonnet: null,
        // Opaque codename keys the endpoint also serves — never surfaced.
        nimbus_quill: { utilization: 0, resets_at: null },
        limits: [session, weeklyAll, fable]
      }
    })
    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } }
    ])
    expect(result.sevenDayOpus).toBeNull()
    expect(result.sevenDaySonnet).toBeNull()
  })

  it('skips malformed weekly_scoped entries', () => {
    const result = parseResponse({
      five_hour: { utilization: 39 },
      limits: [
        null,
        'nonsense',
        { kind: 'weekly_scoped', percent: 10, scope: null }, // no model
        { kind: 'weekly_scoped', percent: 10, scope: { model: null } },
        { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 42 } } },
        { kind: 'weekly_scoped', percent: 'lots', scope: { model: { display_name: 'Fable' } } },
        fable
      ]
    })
    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } }
    ])
  })

  it('defaults resetsAt to null and keeps every scoped model', () => {
    const result = parseResponse({
      five_hour: { utilization: 39 },
      limits: [
        fable,
        { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Quill' } } }
      ]
    })
    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } },
      { label: 'Quill', window: { usedPercent: 7, resetsAt: null } }
    ])
  })

  it('returns null when limits is absent or not an array', () => {
    expect(parseResponse({ five_hour: { utilization: 39 } }).sevenDayModels).toBeNull()
    expect(
      parseResponse({ five_hour: { utilization: 39 }, limits: 'nope' }).sevenDayModels
    ).toBeNull()
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

// ---------------------------------------------------------------------------
// Window-sample population (Phase 7 Pass 2)
// Replicates recordWindowSampleFromUsage's decision logic (the class has heavy
// deps; this file's convention is to replicate the pure logic). Verifies the
// canonicalize + snap-dedup + skip-when-no-account/expired + key-dedup gate.
// ---------------------------------------------------------------------------

describe('recordWindowSampleFromUsage decision logic', () => {
  const WINDOW_SNAP_TOLERANCE_MS = 2 * 60_000
  const MS_PER_MINUTE = 60_000

  function canonicalizeWindowEnd(resetMs: number, knownEnds: number[]): number {
    const rounded = Math.round(resetMs / MS_PER_MINUTE) * MS_PER_MINUTE
    for (const end of knownEnds) {
      if (Math.abs(end - rounded) <= WINDOW_SNAP_TOLERANCE_MS) return end
    }
    return rounded
  }

  /** Returns the sample to record (or null to skip), updating knownEnds/lastKey. */
  function decide(
    usage: { error: string | null; fiveHour: { usedPercent: number; resetsAt: string | null } },
    accountUuid: string | undefined,
    knownEnds: number[],
    lastKey: string | null,
    now: number
  ): {
    sample: { accountUuid: string; usedPercent: number; canonicalEnd: number } | null
    key: string | null
  } {
    if (usage.error) return { sample: null, key: lastKey }
    if (!accountUuid) return { sample: null, key: lastKey }
    const resetsAt = usage.fiveHour.resetsAt
    if (!resetsAt) return { sample: null, key: lastKey }
    const resetMs = new Date(resetsAt).getTime()
    if (isNaN(resetMs) || resetMs <= now) return { sample: null, key: lastKey }
    const canonicalEnd = canonicalizeWindowEnd(resetMs, knownEnds)
    if (!knownEnds.includes(canonicalEnd)) {
      knownEnds.push(canonicalEnd)
      knownEnds.sort((a, b) => a - b)
    }
    const usedPercent = usage.fiveHour.usedPercent
    const key = `${accountUuid}:${usedPercent}:${canonicalEnd}`
    if (key === lastKey) return { sample: null, key } // dedup
    return { sample: { accountUuid, usedPercent, canonicalEnd }, key }
  }

  const NOW = new Date('2026-06-22T10:00:00.000Z').getTime()
  const FUTURE = new Date('2026-06-22T13:00:00.000Z').toISOString()

  it('records a sample for a valid future window with an account', () => {
    const { sample } = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: FUTURE } },
      'uuid_1',
      [],
      null,
      NOW
    )
    expect(sample).not.toBeNull()
    expect(sample!.usedPercent).toBe(42)
    expect(sample!.accountUuid).toBe('uuid_1')
  })

  it('skips when there is no active account', () => {
    const { sample } = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: FUTURE } },
      undefined,
      [],
      null,
      NOW
    )
    expect(sample).toBeNull()
  })

  it('skips on error', () => {
    const { sample } = decide(
      { error: 'no creds', fiveHour: { usedPercent: 0, resetsAt: FUTURE } },
      'uuid_1',
      [],
      null,
      NOW
    )
    expect(sample).toBeNull()
  })

  it('skips an expired window', () => {
    const past = new Date('2026-06-22T09:00:00.000Z').toISOString()
    const { sample } = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: past } },
      'uuid_1',
      [],
      null,
      NOW
    )
    expect(sample).toBeNull()
  })

  it('dedups an identical consecutive sample (same account/percent/window)', () => {
    const knownEnds: number[] = []
    const first = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: FUTURE } },
      'uuid_1',
      knownEnds,
      null,
      NOW
    )
    expect(first.sample).not.toBeNull()
    const second = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: FUTURE } },
      'uuid_1',
      knownEnds,
      first.key,
      NOW
    )
    expect(second.sample).toBeNull() // identical → deduped
  })

  it('records again when used_percent changes within the same window', () => {
    const knownEnds: number[] = []
    const first = decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: FUTURE } },
      'uuid_1',
      knownEnds,
      null,
      NOW
    )
    const second = decide(
      { error: null, fiveHour: { usedPercent: 55, resetsAt: FUTURE } },
      'uuid_1',
      knownEnds,
      first.key,
      NOW
    )
    expect(second.sample).not.toBeNull()
    expect(second.sample!.usedPercent).toBe(55)
    // canonical end is reused (same window) via snap-dedup
    expect(knownEnds).toHaveLength(1)
  })

  it('snap-dedups a jittered resets_at to the same canonical end', () => {
    const knownEnds: number[] = []
    const t1 = new Date('2026-06-22T13:00:00.578Z').toISOString()
    const t2 = new Date('2026-06-22T13:00:30.000Z').toISOString() // 30s later, within tolerance
    decide(
      { error: null, fiveHour: { usedPercent: 42, resetsAt: t1 } },
      'uuid_1',
      knownEnds,
      null,
      NOW
    )
    decide(
      { error: null, fiveHour: { usedPercent: 50, resetsAt: t2 } },
      'uuid_1',
      knownEnds,
      null,
      NOW
    )
    expect(knownEnds).toHaveLength(1) // both snapped to one canonical end
  })
})
