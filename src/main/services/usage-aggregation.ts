/**
 * Pure usage aggregation — Phase 7 Pass 2.
 *
 * The block-grouping walk, per-model merge, burn-rate, and the WLS capacity
 * projection were extracted VERBATIM from block-usage.ts so the SQL-sourced
 * dashboard produces byte-for-byte identical UsageBlock/projection output on the
 * same input. block-usage.ts now feeds these functions from `usage_event`
 * (instead of the in-memory JSONL scan) and `usage_window_sample` (instead of
 * the in-memory projection ring buffer).
 *
 * NO file I/O, NO electron, NO DB imports — pure functions over plain inputs, so
 * the equivalence test can drive them directly against the same fixtures the old
 * block-usage.test.ts replicated.
 *
 * Behavior-preservation contract: the grouping, mergeModelFamilies, buildBlock,
 * and WLS math here must remain identical to the historical block-usage.ts. Do
 * not "improve" them — the equivalence test is the guard.
 */

import type { TokenCounts, ModelTokenBreakdown, UsageBlock } from '../../shared/types'
import { accountForTimestamp, type AccountLogRecord } from './usage-windows'

// ---------------------------------------------------------------------------
// Constants (mirror block-usage.ts)
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3600_000
const MS_PER_MINUTE = 60_000
export const SESSION_DURATION_MS = 5 * MS_PER_HOUR // 5 hours

/** Exponential decay half-life for weighting projection samples. */
const PROJECTION_HALF_LIFE_MS = 5 * MS_PER_MINUTE
/** Minimum samples before using regression (below this, single-point). */
const MIN_REGRESSION_SAMPLES = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One per-message usage record fed into block grouping (engine-tagged). */
export interface AggEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  messageId: string
  /** Engine that produced this turn — 'claude' | 'opencode'. */
  engineId: string
}

/** A 5h rate-limit window observed via resets_at (mirror of block-usage ApiWindow). */
export interface ApiWindow {
  start: number
  end: number
  account: string | null
}

/** A single (tokens, apiPercent) observation for projection regression. */
export interface ProjectionSample {
  timestamp: number
  tokens: number
  apiPercent: number
}

// ---------------------------------------------------------------------------
// Token helpers (verbatim from block-usage.ts)
// ---------------------------------------------------------------------------

export function emptyTokenCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

export function totalTokens(t: TokenCounts): number {
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

// ---------------------------------------------------------------------------
// Model family helpers (verbatim from block-usage.ts)
// ---------------------------------------------------------------------------

function isGenericModelName(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)$/i.test(model)
}

/**
 * Merge generic model names (e.g. "claude-sonnet") into their specific versioned
 * counterparts (e.g. "claude-sonnet-4-6"), but keep distinct versions separate.
 * Verbatim from block-usage.ts.
 */
export function mergeModelFamilies(
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
// Window lookup (verbatim from block-usage.ts findWindowFor)
// ---------------------------------------------------------------------------

/** Grace for attaching entries that slightly precede a window's derived start. */
const WINDOW_START_GRACE_MS = 30 * MS_PER_MINUTE

function findWindowFor(
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

// ---------------------------------------------------------------------------
// Block building (verbatim from block-usage.ts buildBlock)
// ---------------------------------------------------------------------------

function buildBlock(
  entries: AggEntry[],
  blockStart: number,
  windowAligned: boolean,
  now: number
): UsageBlock {
  const endTime = blockStart + SESSION_DURATION_MS
  const actualEndTime = entries[entries.length - 1].timestamp

  const tokens = emptyTokenCounts()
  let costUsd = 0
  const modelMap = new Map<
    string,
    { tokens: TokenCounts; costUsd: number; requestCount: number }
  >()

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

  const projectedUsage: UsageBlock['projectedUsage'] = null

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
    projectedUsage,
    finalApiPercent: null,
    windowAligned
  }
}

// ---------------------------------------------------------------------------
// Block grouping (verbatim from block-usage.ts groupIntoBlocks)
// ---------------------------------------------------------------------------

/**
 * Group chronologically-sorted entries into 5h blocks. Verbatim port of
 * block-usage.ts groupIntoBlocks — `knownWindows` and the account log are passed
 * in (they were instance state). `now` is injectable for deterministic tests.
 */
export function groupEntriesIntoBlocks(
  entries: AggEntry[],
  knownWindows: ApiWindow[],
  accountLog: AccountLogRecord[],
  now: number = Date.now()
): UsageBlock[] {
  if (entries.length === 0) return []

  const blockStartFor = (ts: number): { start: number; aligned: boolean } => {
    const win = findWindowFor(knownWindows, ts, accountForTimestamp(accountLog, ts))
    if (win) return { start: win.start, aligned: true }
    return { start: floorToHour(ts), aligned: false }
  }

  const blocks: UsageBlock[] = []
  let blockEntries: AggEntry[] = []
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
      blocks.push(buildBlock(blockEntries, blockStart, blockAligned, now))
      blockStart = ideal.start
      blockAligned = ideal.aligned
      blockEntries = [entry]
    } else {
      blockEntries.push(entry)
      if (!blockAligned && ideal.aligned && ideal.start === blockStart) {
        blockAligned = true
      }
    }
  }

  if (blockEntries.length > 0) {
    blocks.push(buildBlock(blockEntries, blockStart, blockAligned, now))
  }

  // Clamp isActive=false for blocks preceding the current API window.
  const currentWindow = knownWindows.find((w) => now >= w.start && now < w.end)
  if (currentWindow) {
    for (const block of blocks) {
      if (block.isActive && block.startTime < currentWindow.start) {
        block.isActive = false
      }
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// WLS projection (verbatim from block-usage.ts computeProjectionWLS)
// ---------------------------------------------------------------------------

/**
 * Compute the projected window capacity from (tokens, apiPercent) samples using
 * weighted least squares regression. Verbatim port of block-usage.ts
 * computeProjectionWLS:
 *   tokens = k × apiPercent   (proportional, through origin)
 *   k = Σ(wᵢ·tᵢ·pᵢ) / Σ(wᵢ·pᵢ²)   (weighted least squares, half-life 5min)
 *   projectedMax = k × 100
 * Single-point fallback when fewer than 3 samples. `now` injectable for tests.
 *
 * The only change vs the original is the SAMPLE SOURCE (the caller builds these
 * from usage_event tokens × usage_window_sample.used_percent); the math is
 * identical.
 */
export function computeProjectionWLS(
  samples: ProjectionSample[],
  blockTokens: number,
  blockCostUsd: number,
  now: number = Date.now()
): UsageBlock['projectedUsage'] {
  if (samples.length === 0) return null

  const currentTok = blockTokens
  if (currentTok <= 0) return null

  // Blended cost-per-token over the block's actual model + cache-TTL mix.
  const costPerToken = blockCostUsd / currentTok

  // ---- Single-point fallback ----
  if (samples.length < MIN_REGRESSION_SAMPLES) {
    const latest = samples[samples.length - 1]
    if (latest.apiPercent <= 0) return null
    const maxTokens = latest.tokens / (latest.apiPercent / 100)
    return {
      tokens: Math.round(maxTokens),
      costUsd: Math.round(maxTokens * costPerToken * 100) / 100
    }
  }

  // ---- Weighted Least Squares: tokens = k × percent ----
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

// ---------------------------------------------------------------------------
// Per-engine breakdown (NEW in Pass 2 — opencode now appears)
// ---------------------------------------------------------------------------

export interface EngineUsageBreakdown {
  engineId: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
}

/**
 * Aggregate entries by engineId. NEW for the per-engine dashboard view — this is
 * how opencode usage surfaces. Cost uses each entry's costUsd (equivalent cost
 * for priced models; opencode entries carry the pricing-table or engine cost).
 */
export function perEngineBreakdown(entries: AggEntry[]): EngineUsageBreakdown[] {
  const byEngine = new Map<string, EngineUsageBreakdown>()
  for (const e of entries) {
    let agg = byEngine.get(e.engineId)
    if (!agg) {
      agg = { engineId: e.engineId, tokens: emptyTokenCounts(), costUsd: 0, requestCount: 0 }
      byEngine.set(e.engineId, agg)
    }
    agg.tokens.inputTokens += e.inputTokens
    agg.tokens.outputTokens += e.outputTokens
    agg.tokens.cacheCreationTokens += e.cacheCreationTokens
    agg.tokens.cacheReadTokens += e.cacheReadTokens
    agg.costUsd += e.costUsd
    agg.requestCount += 1
  }
  return Array.from(byEngine.values()).sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
}
