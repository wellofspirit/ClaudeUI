/**
 * @vitest-environment node
 *
 * EQUIVALENCE GUARD (Phase 7 Pass 2) — the #1 behavior-preservation test.
 *
 * The SQL-backed dashboard delegates block grouping + WLS projection to the
 * extracted pure module `usage-aggregation.ts`. This test replicates the OLD
 * block-usage.ts in-memory logic inline (the historical implementation) and
 * asserts the extracted module produces BYTE-FOR-BYTE identical UsageBlock
 * output and identical WLS projections on the SAME input.
 *
 * If this test fails, the SQL aggregation has drifted from the old JSONL
 * aggregation — a real regression in the Claude dashboard / WLS.
 */

import { describe, it, expect } from 'vitest'
import {
  groupEntriesIntoBlocks,
  computeProjectionWLS,
  type AggEntry,
  type ApiWindow,
  type ProjectionSample
} from '../usage-aggregation'
import type { TokenCounts, UsageBlock, ModelTokenBreakdown } from '../../../shared/types'
import { accountForTimestamp, type AccountLogRecord } from '../usage-windows'

const MS_PER_HOUR = 3600_000
const MS_PER_MINUTE = 60_000
const SESSION_DURATION_MS = 5 * MS_PER_HOUR
const WINDOW_START_GRACE_MS = 30 * MS_PER_MINUTE
const PROJECTION_HALF_LIFE_MS = 5 * MS_PER_MINUTE
const MIN_REGRESSION_SAMPLES = 3

// ===========================================================================
// OLD IMPLEMENTATION — replicated verbatim from the pre-Phase-7 block-usage.ts
// (this is the behavioral reference the SQL path must match)
// ===========================================================================

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
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens
  }
}
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
    for (const m of specific) merged.set(m, { ...modelMap.get(m)! })
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

interface OldEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  messageId: string
}

function oldFindWindowFor(
  windows: ApiWindow[],
  ts: number,
  account: string | null
): ApiWindow | null {
  const containing = windows.filter((w) => ts >= w.start && ts < w.end)
  if (containing.length > 0) {
    const matching = containing.find((w) => w.account === null || w.account === account)
    return matching ?? containing[0]
  }
  for (const w of windows) {
    if (ts < w.start && w.start - ts <= WINDOW_START_GRACE_MS) return w
  }
  return null
}

function oldBuildBlock(
  entries: OldEntry[],
  blockStart: number,
  windowAligned: boolean,
  now: number
): UsageBlock {
  const endTime = blockStart + SESSION_DURATION_MS
  const actualEndTime = entries[entries.length - 1].timestamp
  const tokens = emptyTokenCounts()
  let costUsd = 0
  const modelMap = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
  for (const entry of entries) {
    tokens.inputTokens += entry.inputTokens
    tokens.outputTokens += entry.outputTokens
    tokens.cacheCreationTokens += entry.cacheCreationTokens
    tokens.cacheReadTokens += entry.cacheReadTokens
    costUsd += entry.costUsd
    const existing = modelMap.get(entry.model)
    if (existing) {
      existing.tokens = addTokens(existing.tokens, {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens
      })
      existing.costUsd += entry.costUsd
      existing.requestCount += 1
    } else {
      modelMap.set(entry.model, {
        tokens: {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          cacheReadTokens: entry.cacheReadTokens
        },
        costUsd: entry.costUsd,
        requestCount: 1
      })
    }
  }
  const mergedMap = mergeModelFamilies(modelMap)
  const models: ModelTokenBreakdown[] = Array.from(mergedMap.entries()).map(([model, data]) => ({
    model,
    tokens: data.tokens,
    costUsd: data.costUsd,
    requestCount: data.requestCount
  }))
  const isActive = now < endTime && now - actualEndTime < SESSION_DURATION_MS
  let burnRate: UsageBlock['burnRate'] = null
  const durationMs = actualEndTime - entries[0].timestamp
  if (durationMs > 0) {
    const durationMin = durationMs / MS_PER_MINUTE
    const tok = totalTokens(tokens)
    burnRate = {
      tokensPerMin: Math.round(tok / durationMin),
      costPerHour: Math.round((costUsd / durationMin) * 60 * 100) / 100
    }
  }
  return {
    id: new Date(blockStart).toISOString(),
    startTime: blockStart,
    endTime,
    actualEndTime,
    isActive,
    tokens,
    costUsd: Math.round(costUsd * 10000) / 10000,
    requestCount: entries.length,
    models,
    burnRate,
    projectedUsage: null,
    finalApiPercent: null,
    windowAligned
  }
}

function oldGroupIntoBlocks(
  entries: OldEntry[],
  knownWindows: ApiWindow[],
  accountLog: AccountLogRecord[],
  now: number
): UsageBlock[] {
  if (entries.length === 0) return []
  const blockStartFor = (ts: number): { start: number; aligned: boolean } => {
    const win = oldFindWindowFor(knownWindows, ts, accountForTimestamp(accountLog, ts))
    if (win) return { start: win.start, aligned: true }
    return { start: floorToHour(ts), aligned: false }
  }
  const blocks: UsageBlock[] = []
  let blockEntries: OldEntry[] = []
  let blockStart = 0
  let blockAligned = false
  for (const entry of entries) {
    if (blockEntries.length === 0) {
      const ideal = blockStartFor(entry.timestamp)
      blockStart = ideal.start
      blockAligned = ideal.aligned
      blockEntries = [entry]
      continue
    }
    const ideal = blockStartFor(entry.timestamp)
    const timeSinceBlockStart = entry.timestamp - blockStart
    const lastEntry = blockEntries[blockEntries.length - 1]
    const timeSinceLastEntry = entry.timestamp - lastEntry.timestamp
    const windowMismatch = ideal.aligned && ideal.start !== blockStart
    if (
      timeSinceBlockStart > SESSION_DURATION_MS ||
      timeSinceLastEntry > SESSION_DURATION_MS ||
      windowMismatch
    ) {
      blocks.push(oldBuildBlock(blockEntries, blockStart, blockAligned, now))
      blockStart = ideal.start
      blockAligned = ideal.aligned
      blockEntries = [entry]
    } else {
      blockEntries.push(entry)
      if (!blockAligned && ideal.aligned && ideal.start === blockStart) blockAligned = true
    }
  }
  if (blockEntries.length > 0) {
    blocks.push(oldBuildBlock(blockEntries, blockStart, blockAligned, now))
  }
  const currentWindow = knownWindows.find((w) => now >= w.start && now < w.end)
  if (currentWindow) {
    for (const block of blocks) {
      if (block.isActive && block.startTime < currentWindow.start) block.isActive = false
    }
  }
  return blocks
}

function oldComputeWLS(
  samples: ProjectionSample[],
  blockTokens: number,
  blockCostUsd: number,
  now: number
): UsageBlock['projectedUsage'] {
  if (samples.length === 0) return null
  const currentTok = blockTokens
  if (currentTok <= 0) return null
  const costPerToken = blockCostUsd / currentTok
  if (samples.length < MIN_REGRESSION_SAMPLES) {
    const latest = samples[samples.length - 1]
    if (latest.apiPercent <= 0) return null
    const maxTokens = latest.tokens / (latest.apiPercent / 100)
    return {
      tokens: Math.round(maxTokens),
      costUsd: Math.round(maxTokens * costPerToken * 100) / 100
    }
  }
  let sumWTP = 0
  let sumWPP = 0
  for (const s of samples) {
    if (s.apiPercent <= 0) continue
    const age = now - s.timestamp
    const w = Math.exp((-age * Math.LN2) / PROJECTION_HALF_LIFE_MS)
    sumWTP += w * s.tokens * s.apiPercent
    sumWPP += w * s.apiPercent * s.apiPercent
  }
  if (sumWPP === 0) return null
  const k = sumWTP / sumWPP
  const maxTokens = k * 100
  if (maxTokens < currentTok) return null
  return {
    tokens: Math.round(maxTokens),
    costUsd: Math.round(maxTokens * costPerToken * 100) / 100
  }
}

// ===========================================================================
// Fixtures
// ===========================================================================

/** Tag an OldEntry with engineId 'claude' to feed the new (AggEntry) path. */
function toAgg(e: OldEntry): AggEntry {
  return { ...e, engineId: 'claude' }
}

function entry(
  ts: number,
  model: string,
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
  cost = 0,
  id = `msg_${ts}`
): OldEntry {
  return {
    timestamp: ts,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    costUsd: cost,
    messageId: id
  }
}

const BASE = new Date('2026-06-20T09:00:00.000Z').getTime()

// ===========================================================================
// Block-grouping equivalence
// ===========================================================================

describe('groupEntriesIntoBlocks — equivalence with old block-usage grouping', () => {
  const NOW = BASE + 30 * MS_PER_HOUR // far future so nothing is active

  function assertEquivalent(
    entries: OldEntry[],
    windows: ApiWindow[],
    accountLog: AccountLogRecord[],
    now: number
  ): void {
    const oldBlocks = oldGroupIntoBlocks(entries, windows, accountLog, now)
    const newBlocks = groupEntriesIntoBlocks(entries.map(toAgg), windows, accountLog, now)
    expect(newBlocks).toEqual(oldBlocks)
  }

  it('single entry, no windows → floorToHour block', () => {
    assertEquivalent([entry(BASE + 17 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)], [], [], NOW)
  })

  it('multiple entries within 5h → one block', () => {
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 100, 50, 0.01),
      entry(BASE + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 2000, 800, 200, 100, 0.02),
      entry(BASE + 2 * MS_PER_HOUR, 'claude-opus-4-8', 500, 300, 0, 0, 0.05)
    ]
    assertEquivalent(entries, [], [], NOW)
  })

  it('gap > 5h since last entry → new block', () => {
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + 6 * MS_PER_HOUR, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    assertEquivalent(entries, [], [], NOW)
  })

  it('entries spanning > 5h from block start → new block', () => {
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + 2 * MS_PER_HOUR, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + 5 * MS_PER_HOUR + MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    assertEquivalent(entries, [], [], NOW)
  })

  it('window-aligned grouping (one known window)', () => {
    const windowEnd = BASE + 5 * MS_PER_HOUR
    const windows: ApiWindow[] = [{ start: windowEnd - SESSION_DURATION_MS, end: windowEnd, account: null }]
    const entries = [
      entry(BASE + 10 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + 2 * MS_PER_HOUR, 'claude-opus-4-8', 500, 300, 0, 0, 0.05)
    ]
    assertEquivalent(entries, windows, [], NOW)
  })

  it('window mismatch splits blocks (two adjacent windows)', () => {
    const w1End = BASE + 5 * MS_PER_HOUR
    const w2End = w1End + 5 * MS_PER_HOUR
    const windows: ApiWindow[] = [
      { start: w1End - SESSION_DURATION_MS, end: w1End, account: null },
      { start: w2End - SESSION_DURATION_MS, end: w2End, account: null }
    ]
    const entries = [
      entry(BASE + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(w1End + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    assertEquivalent(entries, windows, [], NOW)
  })

  it('grace-zone attachment (entry slightly precedes window start)', () => {
    const windowStart = BASE + MS_PER_HOUR
    const windowEnd = windowStart + SESSION_DURATION_MS
    const windows: ApiWindow[] = [{ start: windowStart, end: windowEnd, account: null }]
    // Entry 20min before window start (within 30min grace)
    const entries = [entry(windowStart - 20 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)]
    assertEquivalent(entries, windows, [], NOW)
  })

  it('account-matched window selection (overlapping windows, different accounts)', () => {
    const end = BASE + 5 * MS_PER_HOUR
    const windows: ApiWindow[] = [
      { start: end - SESSION_DURATION_MS, end, account: 'a@x.com' },
      { start: end - SESSION_DURATION_MS, end: end + 1, account: 'b@x.com' }
    ]
    const accountLog: AccountLogRecord[] = [{ ts: BASE - 1000, accountUuid: 'b', email: 'b@x.com' }]
    const entries = [entry(BASE + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)]
    assertEquivalent(entries, windows, accountLog, NOW)
  })

  it('provisional → aligned upgrade in place', () => {
    // First entry has no window (floorToHour); a later entry resolves to a window
    // whose start matches the floored start → block upgrades to aligned.
    const flooredStart = floorToHour(BASE)
    const windowEnd = flooredStart + SESSION_DURATION_MS
    const windows: ApiWindow[] = [{ start: flooredStart, end: windowEnd, account: null }]
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + MS_PER_HOUR, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    // Mismatch: oldFindWindowFor returns the window for BOTH entries (aligned).
    assertEquivalent(entries, windows, [], NOW)
  })

  it('active-block clamping (block before current window marked inactive)', () => {
    const now = BASE + 3 * MS_PER_HOUR // inside the current window
    const curStart = BASE + 2 * MS_PER_HOUR
    const windows: ApiWindow[] = [{ start: curStart, end: curStart + SESSION_DURATION_MS, account: null }]
    // An entry well before the current window — its floorToHour block would be
    // "active" by time but must be clamped inactive.
    const entries = [
      entry(BASE - 4 * MS_PER_HOUR, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(curStart + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    assertEquivalent(entries, windows, [], now)
  })

  it('mixed model families merge identically (generic + specific)', () => {
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01, 'm1'),
      entry(BASE + 10 * MS_PER_MINUTE, 'claude-sonnet', 500, 250, 0, 0, 0.005, 'm2'),
      entry(BASE + 20 * MS_PER_MINUTE, 'claude-opus-4-8', 300, 150, 0, 0, 0.03, 'm3'),
      entry(BASE + 30 * MS_PER_MINUTE, 'claude-opus-4-5', 200, 100, 0, 0, 0.02, 'm4')
    ]
    assertEquivalent(entries, [], [], NOW)
  })

  it('empty entries → empty blocks', () => {
    assertEquivalent([], [], [], NOW)
  })

  it('active block when now is within block window and recent activity', () => {
    const now = BASE + 90 * MS_PER_MINUTE
    const entries = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01),
      entry(BASE + 60 * MS_PER_MINUTE, 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.01)
    ]
    assertEquivalent(entries, [], [], now)
  })
})

// ===========================================================================
// WLS projection equivalence
// ===========================================================================

describe('computeProjectionWLS — equivalence with old block-usage WLS', () => {
  const NOW = BASE + 2 * MS_PER_HOUR

  function sample(offsetMin: number, tokens: number, apiPercent: number): ProjectionSample {
    return { timestamp: BASE + offsetMin * MS_PER_MINUTE, tokens, apiPercent }
  }

  function assertWLSEquivalent(
    samples: ProjectionSample[],
    blockTokens: number,
    blockCost: number,
    now: number
  ): void {
    const oldProj = oldComputeWLS(samples, blockTokens, blockCost, now)
    const newProj = computeProjectionWLS(samples, blockTokens, blockCost, now)
    expect(newProj).toEqual(oldProj)
  }

  it('empty samples → null', () => {
    assertWLSEquivalent([], 1000, 1.0, NOW)
  })

  it('single sample → single-point fallback', () => {
    assertWLSEquivalent([sample(0, 50_000, 10)], 50_000, 0.5, NOW)
  })

  it('two samples → single-point fallback (< 3)', () => {
    assertWLSEquivalent([sample(0, 30_000, 6), sample(10, 50_000, 10)], 50_000, 0.5, NOW)
  })

  it('three samples → WLS regression', () => {
    assertWLSEquivalent(
      [sample(0, 30_000, 6), sample(10, 50_000, 10), sample(20, 70_000, 14)],
      70_000,
      0.7,
      NOW
    )
  })

  it('many samples with decay weighting', () => {
    const samples: ProjectionSample[] = []
    for (let i = 0; i < 20; i++) {
      samples.push(sample(i * 3, 10_000 + i * 5000, 2 + i * 1.0))
    }
    assertWLSEquivalent(samples, 105_000, 1.5, NOW)
  })

  it('zero-percent samples skipped in regression', () => {
    assertWLSEquivalent(
      [sample(0, 0, 0), sample(10, 50_000, 10), sample(15, 60_000, 12), sample(20, 70_000, 14)],
      70_000,
      0.7,
      NOW
    )
  })

  it('projection below current tokens → null (sanity check)', () => {
    // High apiPercent with low tokens → maxTokens < current would not happen here,
    // but a regression giving a tiny k must return null when below currentTok.
    assertWLSEquivalent(
      [sample(0, 90_000, 95), sample(10, 95_000, 98), sample(20, 99_000, 99)],
      99_000,
      1.0,
      NOW
    )
  })

  it('zero block tokens → null', () => {
    assertWLSEquivalent([sample(0, 50_000, 10)], 0, 0, NOW)
  })

  it('single-point with zero apiPercent → null', () => {
    assertWLSEquivalent([sample(0, 50_000, 0)], 50_000, 0.5, NOW)
  })
})
