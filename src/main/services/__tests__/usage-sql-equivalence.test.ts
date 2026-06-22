/**
 * @vitest-environment node
 *
 * FULL-SQL EQUIVALENCE GUARD (Phase 7 Pass 2 completion).
 *
 * Proves the SQL-sourced dashboard == the old JSONL/file-sourced dashboard:
 *   1. Blocks: usage_event round-trip → groupEntriesIntoBlocks produces the SAME
 *      UsageBlocks as the old JSONL ParsedEntry path on the same fixtures.
 *   2. Daily: the daily_usage rollup → dailyHistory produces the SAME per-day
 *      totals/models as the old entry-bucket loadDailyHistory on the same fixtures.
 *
 * Both round-trips go through the real DB stub (node:sqlite), so the lossless-
 * ness of the usage_event/daily_usage mapping is genuinely exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  closeDb,
  insertUsageEvents,
  getUsageEventsSince,
  upsertDailyUsage,
  getAllDailyUsage,
  type UsageEventRow,
  type DailyUsageRow
} from '../db'
import {
  groupEntriesIntoBlocks,
  computeProjectionWLS,
  totalTokens as aggTotalTokens,
  type AggEntry,
  type ApiWindow,
  type ProjectionSample
} from '../usage-aggregation'
import { v4 as uuid } from 'uuid'
import { equivalentCostUsd } from '../../../shared/pricing'
import type { UsageBlock } from '../../../shared/types'

const MS_PER_HOUR = 3600_000
const MS_PER_MINUTE = 60_000

beforeEach(() => closeDb())
afterEach(() => closeDb())

// ---------------------------------------------------------------------------
// The OLD JSONL ParsedEntry shape + grouping input mapping
// ---------------------------------------------------------------------------

interface ParsedEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  messageId: string
}

/** OLD path: ParsedEntry[] → AggEntry[] (engine 'claude'), as block-usage did pre-SQL. */
function oldEntriesToAgg(entries: ParsedEntry[]): AggEntry[] {
  return entries.map((e) => ({
    timestamp: e.timestamp,
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    cacheReadTokens: e.cacheReadTokens,
    costUsd: e.costUsd,
    messageId: e.messageId,
    engineId: 'claude'
  }))
}

// ---------------------------------------------------------------------------
// The NEW SQL path: ParsedEntry[] → usage_event (upsert) → read back → AggEntry[]
// Mirrors block-usage's upsertClaudeEntriesToDb + claudeEntriesFromDb exactly.
// ---------------------------------------------------------------------------

function upsertClaudeEntries(entries: ParsedEntry[]): void {
  const rows: UsageEventRow[] = []
  for (const e of entries) {
    if (!e.messageId) continue
    const equiv = equivalentCostUsd('anthropic', e.model, {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheWriteTokens: e.cacheCreationTokens,
      cacheWrite1hTokens: 0,
      cacheReadTokens: e.cacheReadTokens
    })
    rows.push({
      id: uuid(),
      ts: e.timestamp,
      engineId: 'claude',
      vendorId: 'anthropic',
      accountId: null,
      accountUuid: null,
      modelId: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheWriteTokens: e.cacheCreationTokens,
      cacheWrite1hTokens: 0,
      cacheReadTokens: e.cacheReadTokens,
      equivCostUsd: equiv ?? e.costUsd,
      engineCostUsd: e.costUsd,
      sessionId: null,
      messageId: e.messageId,
      source: 'backfill'
    })
  }
  insertUsageEvents(rows)
}

function claudeEntriesFromDb(cutoff: number): ParsedEntry[] {
  const rows = getUsageEventsSince(cutoff, 'claude')
  return rows.map((r) => ({
    timestamp: r.ts,
    model: r.modelId,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheWriteTokens,
    cacheReadTokens: r.cacheReadTokens,
    costUsd: r.engineCostUsd ?? r.equivCostUsd ?? 0,
    messageId: r.messageId
  }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = new Date('2026-06-20T09:00:00.000Z').getTime()

function entry(
  ts: number,
  model: string,
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
  cost = 0,
  id = `msg_${ts}_${model}`
): ParsedEntry {
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

/** A realistic multi-model, multi-block fixture with cache writes (incl. 1h-priced cost). */
function fixture(): ParsedEntry[] {
  return [
    entry(BASE, 'claude-sonnet-4-6', 1000, 500, 200, 100, 0.012, 'm1'),
    entry(BASE + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 2000, 800, 400, 150, 0.024, 'm2'),
    entry(BASE + 2 * MS_PER_HOUR, 'claude-opus-4-8', 500, 300, 50, 0, 0.05, 'm3'),
    // gap > 5h → new block
    entry(BASE + 8 * MS_PER_HOUR, 'claude-opus-4-8', 800, 400, 0, 0, 0.06, 'm4'),
    entry(BASE + 8 * MS_PER_HOUR + 20 * MS_PER_MINUTE, 'claude-haiku-4-5', 300, 100, 0, 0, 0.0005, 'm5'),
    // generic model name (folds into a specific via mergeModelFamilies)
    entry(BASE + 8 * MS_PER_HOUR + 40 * MS_PER_MINUTE, 'claude-sonnet', 400, 200, 0, 0, 0.006, 'm6')
  ]
}

// ===========================================================================
// Block equivalence: SQL-sourced blocks == old JSONL blocks
// ===========================================================================

describe('SQL-sourced blocks == old JSONL blocks (same fixtures)', () => {
  const NOW = BASE + 30 * MS_PER_HOUR // far future — nothing active

  function blocksOld(entries: ParsedEntry[], windows: ApiWindow[], now: number): UsageBlock[] {
    return groupEntriesIntoBlocks(oldEntriesToAgg(entries), windows, [], now)
  }

  function blocksSql(entries: ParsedEntry[], windows: ApiWindow[], now: number): UsageBlock[] {
    upsertClaudeEntries(entries)
    const dbEntries = claudeEntriesFromDb(0)
    return groupEntriesIntoBlocks(oldEntriesToAgg(dbEntries), windows, [], now)
  }

  it('no windows (floorToHour) — identical blocks', () => {
    const f = fixture()
    expect(blocksSql(f, [], NOW)).toEqual(blocksOld(f, [], NOW))
  })

  it('with a known window — identical blocks', () => {
    const windowEnd = BASE + 5 * MS_PER_HOUR
    const windows: ApiWindow[] = [
      { start: windowEnd - 5 * MS_PER_HOUR, end: windowEnd, account: null }
    ]
    const f = fixture()
    expect(blocksSql(f, windows, NOW)).toEqual(blocksOld(f, windows, NOW))
  })

  it('active block (now within window, recent activity) — identical', () => {
    const now = BASE + 90 * MS_PER_MINUTE
    const f = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 100, 50, 0.012, 'a1'),
      entry(BASE + 60 * MS_PER_MINUTE, 'claude-opus-4-8', 500, 250, 0, 0, 0.03, 'a2')
    ]
    expect(blocksSql(f, [], now)).toEqual(blocksOld(f, [], now))
  })

  it('block costUsd preserved (1h-cache-priced cost survives the round-trip)', () => {
    // The fixture's cost values reflect calculateCostFromTokens with the 1h split;
    // engine_cost_usd carries them verbatim, so block.costUsd must be identical.
    const f = fixture()
    const sql = blocksSql(f, [], NOW)
    const old = blocksOld(f, [], NOW)
    expect(sql.map((b) => b.costUsd)).toEqual(old.map((b) => b.costUsd))
    // and the per-model cost breakdown
    expect(sql.flatMap((b) => b.models.map((m) => [m.model, m.costUsd]))).toEqual(
      old.flatMap((b) => b.models.map((m) => [m.model, m.costUsd]))
    )
  })

  it('round-trip preserves token counts exactly (no precision loss)', () => {
    const f = fixture()
    upsertClaudeEntries(f)
    const back = claudeEntriesFromDb(0).sort((a, b) => a.timestamp - b.timestamp)
    const orig = [...f].sort((a, b) => a.timestamp - b.timestamp)
    expect(back.map((e) => [e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens, e.costUsd])).toEqual(
      orig.map((e) => [e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens, e.costUsd])
    )
  })
})

// ===========================================================================
// Daily equivalence: daily_usage rollup → dailyHistory == old entry-bucket daily
// ===========================================================================

const SCAN_WINDOW_MS = 7 * 24 * MS_PER_HOUR

function dateStrFromTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

function mergeDailyModelFamilies(models: Record<string, number>): Record<string, number> {
  const familyOf = (model: string): string => {
    const lower = model.toLowerCase()
    if (lower.includes('opus')) return 'opus'
    if (lower.includes('sonnet')) return 'sonnet'
    if (lower.includes('haiku')) return 'haiku'
    return model
  }
  const modelMap = new Map<string, number>()
  for (const [model, tok] of Object.entries(models)) {
    const family = familyOf(model)
    modelMap.set(family, (modelMap.get(family) || 0) + tok)
  }
  const resolved: Record<string, number> = {}
  for (const [family, tok] of modelMap) {
    let bestModel = family
    let bestTok = 0
    for (const [model, mTok] of Object.entries(models)) {
      if (familyOf(model) === family && mTok > bestTok) {
        bestModel = model
        bestTok = mTok
      }
    }
    resolved[bestModel] = tok
  }
  return resolved
}

interface DailyHistoryEntry {
  date: string
  totalTokens: number
  costUsd: number
  models: Record<string, number>
}

/** OLD daily: bucket ParsedEntry by local day, merge families. (peakApi/blockCount ignored here.) */
function dailyOld(entries: ParsedEntry[]): DailyHistoryEntry[] {
  const buckets = new Map<string, { tokens: number; cost: number; models: Record<string, number> }>()
  for (const e of entries) {
    const day = dateStrFromTimestamp(e.timestamp)
    let b = buckets.get(day)
    if (!b) {
      b = { tokens: 0, cost: 0, models: {} }
      buckets.set(day, b)
    }
    const tok = e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
    b.tokens += tok
    b.cost += e.costUsd
    const norm = normalizeModelName(e.model)
    if (norm) b.models[norm] = (b.models[norm] || 0) + tok
  }
  const out: DailyHistoryEntry[] = []
  for (const date of [...buckets.keys()].sort()) {
    const b = buckets.get(date)!
    if (b.tokens === 0 && b.cost === 0) continue
    out.push({
      date,
      totalTokens: b.tokens,
      costUsd: Math.round(b.cost * 100) / 100,
      models: mergeDailyModelFamilies(b.models)
    })
  }
  return out
}

/** NEW daily: usage_event → daily_usage rollup → dailyHistoryFromDb (mirrors block-usage). */
function dailySql(entries: ParsedEntry[], now: number): DailyHistoryEntry[] {
  upsertClaudeEntries(entries)
  // Rollup (mirror rollupDailyUsageFromDb — Claude cost = engine_cost_usd)
  const cutoff = now - SCAN_WINDOW_MS
  const rows = getUsageEventsSince(cutoff)
  const buckets = new Map<string, DailyUsageRow>()
  for (const r of rows) {
    const date = dateStrFromTimestamp(r.ts)
    const key = `${date}|${r.engineId}|${r.vendorId}|${r.modelId}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        date,
        engineId: r.engineId,
        vendorId: r.vendorId,
        modelId: r.modelId,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        requestCount: 0,
        peakApiPercent: 0,
        source: 'rollup'
      }
      buckets.set(key, b)
    }
    b.inputTokens += r.inputTokens
    b.outputTokens += r.outputTokens
    b.cacheWriteTokens += r.cacheWriteTokens
    b.cacheReadTokens += r.cacheReadTokens
    b.costUsd += (r.engineId === 'claude' ? r.engineCostUsd : r.equivCostUsd ?? r.engineCostUsd) ?? 0
    b.requestCount += 1
  }
  upsertDailyUsage([...buckets.values()])

  // dailyHistoryFromDb (mirror)
  const all = getAllDailyUsage()
  const byDate = new Map<string, { tokens: number; cost: number; models: Record<string, number> }>()
  for (const r of all) {
    let d = byDate.get(r.date)
    if (!d) {
      d = { tokens: 0, cost: 0, models: {} }
      byDate.set(r.date, d)
    }
    const tok = r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheReadTokens
    d.tokens += tok
    d.cost += r.costUsd
    const norm = normalizeModelName(r.modelId)
    if (norm) d.models[norm] = (d.models[norm] || 0) + tok
  }
  const out: DailyHistoryEntry[] = []
  for (const date of [...byDate.keys()].sort()) {
    const d = byDate.get(date)!
    if (d.tokens === 0 && d.cost === 0) continue
    out.push({
      date,
      totalTokens: d.tokens,
      costUsd: Math.round(d.cost * 100) / 100,
      models: mergeDailyModelFamilies(d.models)
    })
  }
  return out
}

describe('SQL daily == old entry-bucket daily (same fixtures)', () => {
  const NOW = BASE + 2 * 24 * MS_PER_HOUR

  it('single day, multi-model — identical daily totals + model map', () => {
    const f = fixture()
    expect(dailySql(f, NOW)).toEqual(dailyOld(f))
  })

  it('multi-day fixture — identical per-day aggregation', () => {
    const f = [
      entry(BASE, 'claude-sonnet-4-6', 1000, 500, 100, 50, 0.012, 'd1'),
      entry(BASE + 25 * MS_PER_HOUR, 'claude-opus-4-8', 2000, 800, 0, 0, 0.05, 'd2'),
      entry(BASE + 25 * MS_PER_HOUR + MS_PER_HOUR, 'claude-sonnet', 500, 250, 0, 0, 0.006, 'd3')
    ]
    const now = BASE + 3 * 24 * MS_PER_HOUR
    expect(dailySql(f, now)).toEqual(dailyOld(f))
  })

  it('cost rounds to cents identically', () => {
    const f = [entry(BASE, 'claude-sonnet-4-6', 123456, 7891, 0, 0, 0.379999, 'c1')]
    const sql = dailySql(f, NOW)
    const old = dailyOld(f)
    expect(sql[0].costUsd).toBe(old[0].costUsd)
  })
})

// ===========================================================================
// WLS preservation: projection over SQL-block tokens == over JSONL-block tokens
//
// DECISION (documented): the in-memory ring buffer remains the apiPercent sample
// SOURCE (its timing-dependent admission — stale-pause, window-reset, materially-
// lower-percent dedup, per-poll dedup — is not reproducible bit-identically from
// usage_window_sample rows). The projection MATH (computeProjectionWLS) is the
// shared module's, already proven bit-identical to the old WLS. The only input
// that changed is the BLOCK TOKENS the samples pair with — and those are now
// SQL-sourced. This test proves the block tokens (hence the projection) are
// identical whether sourced from JSONL or the usage_event round-trip, so the
// projection is preserved end-to-end. usage_window_sample stays populated for a
// future full re-source.
// ===========================================================================

describe('WLS projection preserved across the SQL block-token round-trip', () => {
  const NOW = BASE + 90 * MS_PER_MINUTE

  function activeBlockTokens(entries: ParsedEntry[], fromDb: boolean): number {
    const src = fromDb
      ? (upsertClaudeEntries(entries), claudeEntriesFromDb(0))
      : entries
    const blocks = groupEntriesIntoBlocks(oldEntriesToAgg(src), [], [], NOW)
    const active = blocks.find((b) => b.isActive) ?? blocks[blocks.length - 1]
    return aggTotalTokens(active.tokens)
  }

  it('identical block tokens → identical projection on the same sample timeline', () => {
    const f = [
      entry(BASE, 'claude-sonnet-4-6', 10000, 5000, 2000, 1000, 0.12, 'w1'),
      entry(BASE + 30 * MS_PER_MINUTE, 'claude-sonnet-4-6', 20000, 8000, 4000, 1500, 0.24, 'w2'),
      entry(BASE + 60 * MS_PER_MINUTE, 'claude-opus-4-8', 5000, 3000, 500, 0, 0.5, 'w3')
    ]
    const jsonlTok = activeBlockTokens(f, false)
    closeDb()
    const sqlTok = activeBlockTokens(f, true)
    expect(sqlTok).toBe(jsonlTok)

    // Scripted apiPercent/token sample timeline (as the ring buffer would hold).
    const samples: ProjectionSample[] = [
      { timestamp: BASE, tokens: 15000, apiPercent: 5 },
      { timestamp: BASE + 30 * MS_PER_MINUTE, tokens: 32000, apiPercent: 11 },
      { timestamp: BASE + 60 * MS_PER_MINUTE, tokens: jsonlTok, apiPercent: 16 }
    ]
    const samplesSql: ProjectionSample[] = [
      { timestamp: BASE, tokens: 15000, apiPercent: 5 },
      { timestamp: BASE + 30 * MS_PER_MINUTE, tokens: 32000, apiPercent: 11 },
      { timestamp: BASE + 60 * MS_PER_MINUTE, tokens: sqlTok, apiPercent: 16 }
    ]
    const cost = 0.86
    expect(computeProjectionWLS(samplesSql, sqlTok, cost, NOW)).toEqual(
      computeProjectionWLS(samples, jsonlTok, cost, NOW)
    )
  })
})
