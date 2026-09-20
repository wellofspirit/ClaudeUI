/**
 * @vitest-environment node
 *
 * The dispatched-turn readers, on ADR-071 §1's ledger.
 *
 * `dispatched_usage` is gone (migration v20): a dispatched turn is a
 * `usage_event` row with `origin = 'dispatch'` and the dispatching session in
 * `parent_routing_id`. These are the same behaviours the old table's tests
 * pinned — the Delegated section's aggregate, one session's own dispatched-cost
 * breakdown, a rekey carrying rows forward — re-stated against the ledger:
 *   - dispatchedUsageSummary groups by (targetEngine, targetModel) and re-encodes
 *     the model the way the dispatcher spelled it
 *   - an UNPRICED turn adds nothing to a total but still counts as a dispatch
 *   - dispatchedCostsByRouting is scoped to one dispatching session
 *   - renameUsageEventParent moves a session's rows on rekey
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  runMigrations,
  closeDb,
  insertUsageEvent,
  dispatchedUsageSummary,
  dispatchedCostsByRouting,
  renameUsageEventParent,
  type UsageEventInsert,
  type Db
} from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

let nextId = 0

/**
 * One dispatched turn as `safeRecordUsage` writes it: `origin 'dispatch'`, the
 * dispatching session in `parentRoutingId`, and the target's vendor and model
 * split apart (the reader re-encodes them).
 */
function dispatchRow(overrides: Partial<UsageEventInsert> = {}): UsageEventInsert {
  nextId += 1
  return {
    id: `row-${nextId}`,
    ts: 1000,
    engineId: 'opencode',
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-5',
    inputTokens: 300,
    outputTokens: 100,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 50,
    cacheReadTokens: 50,
    equivCostUsd: 0.1,
    engineCostUsd: 0.1,
    sessionId: 'oc-sess-1',
    messageId: `dispatch:toolu_${nextId}:1000:${nextId}`,
    source: 'live',
    accountKey: 'openai:key:abc',
    accountLabel: 'openai key …abcd',
    billingType: 'apiKey',
    origin: 'dispatch',
    parentRoutingId: 'routing-A',
    apiCostUsd: 0.1,
    billedCostUsd: 0.1,
    ...overrides
  }
}

/** A session's own turn — never delegated work, whatever else it looks like. */
function sessionRow(overrides: Partial<UsageEventInsert> = {}): UsageEventInsert {
  return dispatchRow({ origin: 'session', parentRoutingId: null, ...overrides })
}

describe('dispatchedUsageSummary', () => {
  it('aggregates by target engine and model, re-encoding the model value', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.1, billedCostUsd: 0.1 }))
    insertUsageEvent(dispatchRow({ ts: 1500, apiCostUsd: 0.05, billedCostUsd: 0.05 }))
    insertUsageEvent(
      dispatchRow({
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        inputTokens: 50,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
        apiCostUsd: 0.005,
        billedCostUsd: 0.005
      })
    )

    const summary = dispatchedUsageSummary(0)
    expect(summary).toHaveLength(2)
    const opencode = summary.find((s) => s.targetEngine === 'opencode')
    // The ledger stores vendor and model apart; the Delegated section and the
    // live breakdown both key on the encoded form.
    expect(opencode).toMatchObject({ targetModel: 'openai/gpt-5', dispatches: 2 })
    // 300 + 100 + 50 + 50 per row — cache_write_1h is a SUBSET of cache_write
    // and is not added again.
    expect(opencode!.totalTokens).toBe(1000)
    expect(opencode!.costUsd).toBeCloseTo(0.15, 6)

    const claude = summary.find((s) => s.targetEngine === 'claude')
    expect(claude).toMatchObject({ targetModel: 'haiku', dispatches: 1, totalTokens: 50 })
    expect(claude!.costUsd).toBeCloseTo(0.005, 6)
  })

  it('ignores a session turn — only delegated work is delegated work', () => {
    insertUsageEvent(dispatchRow())
    insertUsageEvent(sessionRow({ apiCostUsd: 9.99, billedCostUsd: 9.99 }))

    const summary = dispatchedUsageSummary(0)
    expect(summary).toHaveLength(1)
    expect(summary[0].dispatches).toBe(1)
  })

  it('an unpriced turn adds nothing to the total but still counts as a dispatch', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.01, billedCostUsd: 0.01 }))
    // A timed-out turn nothing could price: not a zero — unknown.
    insertUsageEvent(
      dispatchRow({
        ts: 1500,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
        equivCostUsd: null,
        engineCostUsd: null,
        apiCostUsd: null,
        billedCostUsd: null
      })
    )

    const summary = dispatchedUsageSummary(0)
    expect(summary).toHaveLength(1)
    expect(summary[0].dispatches).toBe(2)
    expect(summary[0].costUsd).toBeCloseTo(0.01, 6)
  })

  it('shows what a subscription turn was WORTH, and what an API-key turn was billed', () => {
    insertUsageEvent(
      dispatchRow({ billingType: 'subscription', apiCostUsd: 0.4, billedCostUsd: 0 })
    )
    insertUsageEvent(
      dispatchRow({
        ts: 1500,
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        billingType: 'apiKey',
        apiCostUsd: 0.1,
        billedCostUsd: 0.25
      })
    )

    const summary = dispatchedUsageSummary(0)
    expect(summary.find((s) => s.targetEngine === 'opencode')!.costUsd).toBeCloseTo(0.4)
    expect(summary.find((s) => s.targetEngine === 'claude')!.costUsd).toBeCloseTo(0.25)
  })

  it('orders the most expensive target first', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.01, billedCostUsd: 0.01 }))
    insertUsageEvent(
      dispatchRow({
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        apiCostUsd: 5,
        billedCostUsd: 5
      })
    )

    expect(dispatchedUsageSummary(0).map((s) => s.targetEngine)).toEqual(['claude', 'opencode'])
  })

  it('respects sinceTs, excluding rows before the cutoff', () => {
    insertUsageEvent(dispatchRow({ ts: 1000 }))
    insertUsageEvent(dispatchRow({ ts: 5000 }))

    expect(dispatchedUsageSummary(4000)[0].dispatches).toBe(1)
    expect(dispatchedUsageSummary(0)[0].dispatches).toBe(2)
  })

  it('returns an empty array when there are no rows', () => {
    expect(dispatchedUsageSummary(0)).toEqual([])
  })
})

describe('dispatchedCostsByRouting', () => {
  it('aggregates cost per (targetEngine, targetModel) for ONE dispatching session', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.1, billedCostUsd: 0.1 }))
    insertUsageEvent(dispatchRow({ ts: 1500, apiCostUsd: 0.05, billedCostUsd: 0.05 }))
    // A different dispatching session — must NOT be included.
    insertUsageEvent(
      dispatchRow({ parentRoutingId: 'routing-B', apiCostUsd: 9.99, billedCostUsd: 9.99 })
    )

    const rows = dispatchedCostsByRouting('routing-A')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetEngine: 'opencode', targetModel: 'openai/gpt-5' })
    expect(rows[0].costUsd).toBeCloseTo(0.15, 10)
  })

  it('excludes an unpriced turn (a timed-out turn recorded no resolvable spend)', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.2, billedCostUsd: 0.2 }))
    insertUsageEvent(
      dispatchRow({ ts: 2000, apiCostUsd: null, billedCostUsd: null, billingType: 'unknown' })
    )

    expect(dispatchedCostsByRouting('routing-A')).toEqual([
      { targetEngine: 'opencode', targetModel: 'openai/gpt-5', costUsd: 0.2 }
    ])
  })

  it('a target whose every turn was unpriced gets no row at all', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: null, billedCostUsd: null, billingType: 'unknown' }))
    expect(dispatchedCostsByRouting('routing-A')).toEqual([])
  })

  it('ignores the dispatching session own turns', () => {
    insertUsageEvent(sessionRow({ parentRoutingId: 'routing-A', apiCostUsd: 3 }))
    expect(dispatchedCostsByRouting('routing-A')).toEqual([])
  })

  it('returns separate rows per distinct targetModel', () => {
    insertUsageEvent(dispatchRow({ apiCostUsd: 0.1, billedCostUsd: 0.1 }))
    insertUsageEvent(dispatchRow({ modelId: 'gpt-5-codex', apiCostUsd: 0.2, billedCostUsd: 0.2 }))

    const rows = dispatchedCostsByRouting('routing-A')
    expect(rows).toHaveLength(2)
    const byModel = new Map(rows.map((r) => [r.targetModel, r.costUsd]))
    expect(byModel.get('openai/gpt-5')).toBeCloseTo(0.1, 10)
    expect(byModel.get('openai/gpt-5-codex')).toBeCloseTo(0.2, 10)
  })

  it('returns an empty array for a routingId with no dispatched rows', () => {
    expect(dispatchedCostsByRouting('routing-none')).toEqual([])
  })

  it('round-trips a model the dispatcher canonicalised from a slash-less config', () => {
    // `gpt-5-codex` under opencode decodes to vendor 'opencode', which the
    // dispatcher canonicalises to 'opencode/gpt-5-codex' BEFORE anything keys
    // on it — so the reader's re-encode is the same string the live breakdown
    // (`addDispatchedCost`) used, and a reloaded session shows one row, not
    // two.
    insertUsageEvent(
      dispatchRow({
        engineId: 'opencode',
        vendorId: 'opencode',
        modelId: 'gpt-5-codex',
        apiCostUsd: 0.1,
        billedCostUsd: 0.1
      })
    )
    expect(dispatchedCostsByRouting('routing-A')).toEqual([
      { targetEngine: 'opencode', targetModel: 'opencode/gpt-5-codex', costUsd: 0.1 }
    ])
  })

  it('reads an engine this build does not know without throwing', () => {
    // `engineMeta()` throws on an unregistered id; a stored row must not be
    // able to take a DB read down with it.
    insertUsageEvent(
      dispatchRow({
        engineId: 'ghost-engine',
        modelId: 'ghostly/m',
        apiCostUsd: 0.3,
        billedCostUsd: 0.3
      })
    )
    expect(dispatchedCostsByRouting('routing-A')).toEqual([
      { targetEngine: 'ghost-engine', targetModel: 'ghostly/m', costUsd: 0.3 }
    ])
  })
})

describe('renameUsageEventParent — a rekey carries the dispatched rows', () => {
  it('moves rows from oldRoutingId to newRoutingId', () => {
    insertUsageEvent(
      dispatchRow({ parentRoutingId: 'tmp-routing', apiCostUsd: 0.1, billedCostUsd: 0.1 })
    )

    renameUsageEventParent('tmp-routing', 'canonical-session-id')

    expect(dispatchedCostsByRouting('tmp-routing')).toEqual([])
    // seedDispatchedCosts()'s query must find it under the NEW id.
    expect(dispatchedCostsByRouting('canonical-session-id')).toEqual([
      { targetEngine: 'opencode', targetModel: 'openai/gpt-5', costUsd: 0.1 }
    ])
  })

  it('is a no-op (does not throw) when oldRoutingId has no rows', () => {
    expect(() => renameUsageEventParent('missing-old', 'new-id')).not.toThrow()
    expect(dispatchedCostsByRouting('new-id')).toEqual([])
  })

  it('moves ALL rows for oldRoutingId, preserving multiple entries', () => {
    insertUsageEvent(dispatchRow({ parentRoutingId: 'multi-old', apiCostUsd: 0.1 }))
    insertUsageEvent(
      dispatchRow({
        parentRoutingId: 'multi-old',
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        apiCostUsd: 0.05
      })
    )

    renameUsageEventParent('multi-old', 'multi-new')

    expect(dispatchedCostsByRouting('multi-new')).toHaveLength(2)
  })
})

describe('migration v20 — the old table is gone', () => {
  it('dispatched_usage no longer exists after migration', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('dispatched_usage')
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
