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
import { randomUUID } from 'node:crypto'
import {
  closeDb,
  insertUsageEvents,
  getUsageEventsSince,
  getWindowSamples,
  recordWindowSample,
  upsertDailyUsage,
  getAllDailyUsage,
  type UsageEventRow,
  type DailyUsageRow,
  type WindowSampleRow
} from '../../../core/services/db'
import {
  groupEntriesIntoBlocks,
  computeProjectionWLS,
  totalTokens as aggTotalTokens,
  type AggEntry,
  type ApiWindow,
  type ProjectionSample
} from '../../../core/services/usage-aggregation'
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
    entry(
      BASE + 8 * MS_PER_HOUR + 20 * MS_PER_MINUTE,
      'claude-haiku-4-5',
      300,
      100,
      0,
      0,
      0.0005,
      'm5'
    ),
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
    expect(
      back.map((e) => [
        e.inputTokens,
        e.outputTokens,
        e.cacheCreationTokens,
        e.cacheReadTokens,
        e.costUsd
      ])
    ).toEqual(
      orig.map((e) => [
        e.inputTokens,
        e.outputTokens,
        e.cacheCreationTokens,
        e.cacheReadTokens,
        e.costUsd
      ])
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
  const buckets = new Map<
    string,
    { tokens: number; cost: number; models: Record<string, number> }
  >()
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
    b.costUsd +=
      (r.engineId === 'claude' ? r.engineCostUsd : (r.equivCostUsd ?? r.engineCostUsd)) ?? 0
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
    const src = fromDb ? (upsertClaudeEntries(entries), claudeEntriesFromDb(0)) : entries
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

// ===========================================================================
// Phase 9a — DB-sourced WLS projection (usage_window_sample + cumTokensAt)
//
// The BlockUsageService.buildDbProjectionSamples method reconstructs
// ProjectionSample[] from (a) usage_window_sample rows for the active window
// and (b) cumulative token counts from the current block's ParsedEntries.
// These tests verify:
//   1. The DB-sourced samples produce the same WLS result as in-memory samples
//      when the token-at-ts reconstruction matches (deterministic fixture).
//   2. A projection is produced when the in-memory ring is empty but the DB has
//      samples (simulates a cold restart).
// ===========================================================================

const WINDOW_END_9A = BASE + 5 * MS_PER_HOUR

/**
 * Simulate buildDbProjectionSamples inline (mirrors the BlockUsageService private method).
 * Takes window samples from the DB for `canonicalEnd === windowEnd` and reconstructs
 * cumTokensAt(ts) from the CURRENT block's entries (scoped to `>= blockStart`, sorted by
 * timestamp). Entries before blockStart belong to prior blocks and MUST be excluded —
 * the through-origin WLS would otherwise inflate the projected capacity.
 */
function buildProjectionSamplesFromDb(
  accountUuid: string,
  windowEnd: number,
  blockStart: number,
  blockEntries: ParsedEntry[]
): ProjectionSample[] {
  const dbSamples = getWindowSamples(accountUuid).filter((s) => s.canonicalEnd === windowEnd)
  if (dbSamples.length === 0) return []
  const sorted = blockEntries
    .filter((e) => e.timestamp >= blockStart)
    .sort((a, b) => a.timestamp - b.timestamp)
  const cumTokensAt = (ts: number): number => {
    let total = 0
    for (const e of sorted) {
      if (e.timestamp > ts) break
      total += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
    }
    return total
  }
  return dbSamples.map((s) => ({
    timestamp: s.ts,
    tokens: cumTokensAt(s.ts),
    apiPercent: s.usedPercent
  }))
}

describe('Phase 9a — DB-sourced WLS projection', () => {
  const ACCOUNT_UUID = 'test-uuid-9a'

  beforeEach(() => closeDb())
  afterEach(() => closeDb())

  it('DB-sourced samples produce identical WLS result to in-memory samples (token-at-ts match)', () => {
    // Build a set of block entries
    const blockEntries: ParsedEntry[] = [
      entry(BASE, 'claude-sonnet-4-6', 10_000, 5_000, 2_000, 1_000, 0.12, 'e1'),
      entry(
        BASE + 30 * MS_PER_MINUTE,
        'claude-sonnet-4-6',
        20_000,
        8_000,
        4_000,
        1_500,
        0.24,
        'e2'
      ),
      entry(BASE + 60 * MS_PER_MINUTE, 'claude-opus-4-8', 5_000, 3_000, 500, 0, 0.5, 'e3')
    ]

    // Compute cumulative tokens at each timestamp (exactly what buildDbProjectionSamples does)
    function cumAt(ts: number): number {
      let total = 0
      for (const e of blockEntries) {
        if (e.timestamp > ts) break
        total += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
      }
      return total
    }

    // Build in-memory samples (what the ring buffer would hold)
    const inMemorySamples: ProjectionSample[] = [
      { timestamp: BASE, tokens: cumAt(BASE), apiPercent: 5 },
      {
        timestamp: BASE + 30 * MS_PER_MINUTE,
        tokens: cumAt(BASE + 30 * MS_PER_MINUTE),
        apiPercent: 11
      },
      {
        timestamp: BASE + 60 * MS_PER_MINUTE,
        tokens: cumAt(BASE + 60 * MS_PER_MINUTE),
        apiPercent: 16
      }
    ]

    // Write matching window samples to the DB
    for (const s of inMemorySamples) {
      recordWindowSample({
        id: randomUUID(),
        ts: s.timestamp,
        accountUuid: ACCOUNT_UUID,
        usedPercent: s.apiPercent,
        canonicalEnd: WINDOW_END_9A
      } as WindowSampleRow)
    }

    // Reconstruct samples from DB (block starts at BASE)
    const dbSamples = buildProjectionSamplesFromDb(ACCOUNT_UUID, WINDOW_END_9A, BASE, blockEntries)

    // DB-reconstructed samples must match in-memory samples
    expect(dbSamples).toHaveLength(inMemorySamples.length)
    for (let i = 0; i < inMemorySamples.length; i++) {
      expect(dbSamples[i].tokens).toBe(inMemorySamples[i].tokens)
      expect(dbSamples[i].apiPercent).toBe(inMemorySamples[i].apiPercent)
    }

    // WLS projection must be identical
    const blockTokens = cumAt(BASE + 60 * MS_PER_MINUTE)
    const cost = 0.86
    const now = BASE + 90 * MS_PER_MINUTE
    expect(computeProjectionWLS(dbSamples, blockTokens, cost, now)).toEqual(
      computeProjectionWLS(inMemorySamples, blockTokens, cost, now)
    )
  })

  it('projection produced when in-memory ring is empty but DB has samples (cold restart case)', () => {
    // This simulates: app restarted, ring buffer is empty, but usage_window_sample
    // was written before the restart and is present in the DB.
    const blockEntries: ParsedEntry[] = [
      entry(BASE, 'claude-sonnet-4-6', 10_000, 5_000, 0, 0, 0.1, 'r1'),
      entry(BASE + 20 * MS_PER_MINUTE, 'claude-sonnet-4-6', 15_000, 7_000, 0, 0, 0.15, 'r2'),
      entry(BASE + 40 * MS_PER_MINUTE, 'claude-opus-4-8', 8_000, 4_000, 0, 0, 0.2, 'r3')
    ]

    function cumAt(ts: number): number {
      let total = 0
      for (const e of blockEntries) {
        if (e.timestamp > ts) break
        total += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
      }
      return total
    }

    // Write 3 window samples to the DB (enough for WLS regression)
    const sampleTimes = [BASE, BASE + 20 * MS_PER_MINUTE, BASE + 40 * MS_PER_MINUTE]
    const apiPercents = [5, 10, 15]
    for (let i = 0; i < 3; i++) {
      recordWindowSample({
        id: randomUUID(),
        ts: sampleTimes[i],
        accountUuid: ACCOUNT_UUID,
        usedPercent: apiPercents[i],
        canonicalEnd: WINDOW_END_9A
      } as WindowSampleRow)
    }

    // DB samples must be found even when the ring is empty (block starts at BASE)
    const dbSamples = buildProjectionSamplesFromDb(ACCOUNT_UUID, WINDOW_END_9A, BASE, blockEntries)
    expect(dbSamples.length).toBeGreaterThanOrEqual(3)

    // Projection must be non-null (sufficient samples for regression)
    const blockTokens = cumAt(BASE + 40 * MS_PER_MINUTE)
    const cost = 0.45
    const now = BASE + 90 * MS_PER_MINUTE
    const proj = computeProjectionWLS(dbSamples, blockTokens, cost, now)
    expect(proj).not.toBeNull()
    expect(proj!.tokens).toBeGreaterThan(blockTokens)
  })

  it('cumTokensAt is scoped to the CURRENT block — prior blocks do NOT inflate the projection', () => {
    // GUARD (Phase 9a review fix): viewEntries spans the FULL 7-day scan window
    // across ALL blocks. buildDbProjectionSamples must scope to the current block
    // (>= blockStart) so prior blocks' tokens don't leak into the through-origin
    // WLS fit. A constant token offset C from earlier blocks inflates k = Σwtp/Σwpp
    // and thus the projected window capacity.
    //
    // Fixture: a PRIOR block (~6h before) with large token counts, plus the CURRENT
    // block. Window samples + projection are for the CURRENT block only.
    const CURRENT_START = BASE
    const PRIOR_START = BASE - 6 * MS_PER_HOUR // gap > 5h → a distinct earlier block

    // Entries: 2 huge prior-block entries + 3 current-block entries.
    const priorBlockEntries: ParsedEntry[] = [
      entry(PRIOR_START, 'claude-opus-4-8', 500_000, 200_000, 0, 0, 5.0, 'prior1'),
      entry(
        PRIOR_START + 30 * MS_PER_MINUTE,
        'claude-opus-4-8',
        400_000,
        150_000,
        0,
        0,
        4.0,
        'prior2'
      )
    ]
    const currentBlockEntries: ParsedEntry[] = [
      entry(CURRENT_START, 'claude-sonnet-4-6', 10_000, 5_000, 0, 0, 0.1, 'cur1'),
      entry(
        CURRENT_START + 20 * MS_PER_MINUTE,
        'claude-sonnet-4-6',
        15_000,
        7_000,
        0,
        0,
        0.15,
        'cur2'
      ),
      entry(CURRENT_START + 40 * MS_PER_MINUTE, 'claude-opus-4-8', 8_000, 4_000, 0, 0, 0.2, 'cur3')
    ]
    // viewEntries = the FULL scan (both blocks), exactly as block-usage passes it.
    const viewEntries = [...priorBlockEntries, ...currentBlockEntries]

    // Window samples (current block only)
    const sampleTimes = [
      CURRENT_START,
      CURRENT_START + 20 * MS_PER_MINUTE,
      CURRENT_START + 40 * MS_PER_MINUTE
    ]
    const apiPercents = [5, 10, 15]
    for (let i = 0; i < 3; i++) {
      recordWindowSample({
        id: randomUUID(),
        ts: sampleTimes[i],
        accountUuid: ACCOUNT_UUID,
        usedPercent: apiPercents[i],
        canonicalEnd: WINDOW_END_9A
      } as WindowSampleRow)
    }

    const now = CURRENT_START + 90 * MS_PER_MINUTE

    // Expected (SCOPED): cumTokensAt over current-block entries only.
    const scopedSamples = buildProjectionSamplesFromDb(
      ACCOUNT_UUID,
      WINDOW_END_9A,
      CURRENT_START,
      viewEntries
    )
    // The first scoped sample's tokens must be the FIRST current entry only (15_000),
    // NOT current + prior (which would be 15_000 + 1_250_000).
    expect(scopedSamples[0].tokens).toBe(15_000)
    const currentBlockTokens = currentBlockEntries.reduce(
      (acc, e) => acc + e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens,
      0
    )
    const scopedProj = computeProjectionWLS(scopedSamples, currentBlockTokens, 0.45, now)
    expect(scopedProj).not.toBeNull()

    // UNSCOPED (the pre-fix bug): cumTokensAt over the FULL viewEntries.
    // Replicate the OLD unscoped reconstruction inline.
    const sortedAll = [...viewEntries].sort((a, b) => a.timestamp - b.timestamp)
    const cumAllAt = (ts: number): number => {
      let total = 0
      for (const e of sortedAll) {
        if (e.timestamp > ts) break
        total += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
      }
      return total
    }
    const unscopedSamples: ProjectionSample[] = sampleTimes.map((ts, i) => ({
      timestamp: ts,
      tokens: cumAllAt(ts),
      apiPercent: apiPercents[i]
    }))
    // The unscoped first sample includes the 1.25M prior-block tokens — the bug.
    expect(unscopedSamples[0].tokens).toBe(1_250_000 + 15_000)
    const unscopedProj = computeProjectionWLS(unscopedSamples, currentBlockTokens, 0.45, now)

    // PROOF: the unscoped projection is grossly inflated vs the scoped one.
    // (The prior-block offset pushes projected capacity far higher.)
    expect(unscopedProj).not.toBeNull()
    expect(unscopedProj!.tokens).toBeGreaterThan(scopedProj!.tokens * 5)
  })

  it('account-filter mismatch (samples for active account, no current-block entries) → no throw, null projection', () => {
    // accept-with-note: when the user filters to an account != the active one, the
    // window samples (keyed by the active account uuid) and the filtered viewEntries
    // can mismatch. With no current-block entries surviving the filter, cumTokensAt
    // returns 0 for every sample. This must NOT throw — computeWLS safely returns null
    // (k=0 → maxTokens=0 < currentTok). Same safe-degrade as the in-memory ring.
    for (let i = 0; i < 3; i++) {
      recordWindowSample({
        id: randomUUID(),
        ts: BASE + i * 10 * MS_PER_MINUTE,
        accountUuid: ACCOUNT_UUID,
        usedPercent: 5 + i * 5,
        canonicalEnd: WINDOW_END_9A
      } as WindowSampleRow)
    }

    // viewEntries filtered to a DIFFERENT account → empty current-block slice.
    const emptySlice: ParsedEntry[] = []
    expect(() => {
      const samples = buildProjectionSamplesFromDb(ACCOUNT_UUID, WINDOW_END_9A, BASE, emptySlice)
      // All sample tokens are 0 (no entries to sum).
      expect(samples.every((s) => s.tokens === 0)).toBe(true)
      // blockTokens 0 → computeWLS short-circuits to null without throwing.
      expect(computeProjectionWLS(samples, 0, 0, BASE + 90 * MS_PER_MINUTE)).toBeNull()
    }).not.toThrow()
  })
})
