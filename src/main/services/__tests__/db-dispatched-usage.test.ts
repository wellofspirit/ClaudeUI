/**
 * @vitest-environment node
 *
 * Tests for the ADR-033 M4-B dispatched_usage migration (v6) + repo:
 *   - migration creates the table (queryable, empty)
 *   - insertDispatchedUsage round-trip (getDispatchedUsageSince)
 *   - dispatchedUsageSummary aggregation by (targetEngine, targetModel)
 *   - NULL total_tokens/cost_usd (best-effort captures) coalesce to 0 in the summary
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  runMigrations,
  closeDb,
  insertDispatchedUsage,
  getDispatchedUsageSince,
  dispatchedUsageSummary,
  dispatchedCostsByRouting,
  renameDispatchedUsage,
  type Db
} from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

describe('DB migration — v6 dispatched_usage', () => {
  it('applies all migrations and reaches the latest user_version', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      // Bump alongside MIGRATIONS in db.ts — currently v11 (webauthn_credential
      // + auth-policy columns, ADR-052 passkeys).
      expect(userVersion(db)).toBe(13)
    } finally {
      db.close()
    }
  })

  it('dispatched_usage table exists and is empty after migration', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const rows = db.prepare('SELECT * FROM dispatched_usage').all()
      expect(rows).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('insertDispatchedUsage / getDispatchedUsageSince', () => {
  it('round-trips a fully-populated row', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'routing-1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: 'oc-sess-1',
      toolUseId: 'toolu_1',
      totalTokens: 500,
      costUsd: 0.01,
      durationMs: 2000
    })

    const rows = getDispatchedUsageSince(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ts: 1000,
      fromRoutingId: 'routing-1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: 'oc-sess-1',
      toolUseId: 'toolu_1',
      totalTokens: 500,
      costUsd: 0.01,
      durationMs: 2000
    })
    expect(rows[0].id).toEqual(expect.any(Number))
  })

  it('round-trips a row with best-effort (null) usage fields', () => {
    insertDispatchedUsage({
      ts: 2000,
      fromRoutingId: 'routing-2',
      fromEngine: 'opencode',
      targetEngine: 'claude',
      targetModel: 'haiku',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: null,
      costUsd: null,
      durationMs: null
    })

    const rows = getDispatchedUsageSince(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].totalTokens).toBeNull()
    expect(rows[0].costUsd).toBeNull()
    expect(rows[0].durationMs).toBeNull()
    expect(rows[0].targetSessionId).toBeNull()
    expect(rows[0].toolUseId).toBeNull()
  })

  it('getDispatchedUsageSince filters by ts and orders newest first', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 10,
      costUsd: 0.001,
      durationMs: 100
    })
    insertDispatchedUsage({
      ts: 3000,
      fromRoutingId: 'r2',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 20,
      costUsd: 0.002,
      durationMs: 200
    })

    expect(getDispatchedUsageSince(0).map((r) => r.fromRoutingId)).toEqual(['r2', 'r1'])
    expect(getDispatchedUsageSince(2000).map((r) => r.fromRoutingId)).toEqual(['r2'])
  })
})

describe('dispatchedUsageSummary', () => {
  it('aggregates dispatches/tokens/cost per (targetEngine, targetModel)', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.01,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 1500,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 200,
      costUsd: 0.02,
      durationMs: 700
    })
    insertDispatchedUsage({
      ts: 2000,
      fromRoutingId: 'r2',
      fromEngine: 'opencode',
      targetEngine: 'claude',
      targetModel: 'haiku',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 50,
      costUsd: 0.005,
      durationMs: 300
    })

    const summary = dispatchedUsageSummary(0)
    expect(summary).toHaveLength(2)

    const gpt5 = summary.find((s) => s.targetModel === 'openai/gpt-5')
    expect(gpt5).toMatchObject({
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      dispatches: 2,
      totalTokens: 300
    })
    expect(gpt5?.costUsd).toBeCloseTo(0.03, 6)

    const haiku = summary.find((s) => s.targetModel === 'haiku')
    expect(haiku).toMatchObject({
      targetEngine: 'claude',
      targetModel: 'haiku',
      dispatches: 1,
      totalTokens: 50
    })
    expect(haiku?.costUsd).toBeCloseTo(0.005, 6)
  })

  it('NULL total_tokens/cost_usd coalesce to 0 — one unknown-usage row never poisons the aggregate', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.01,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 1500,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: null,
      costUsd: null,
      durationMs: null
    })

    const summary = dispatchedUsageSummary(0)
    expect(summary).toHaveLength(1)
    expect(summary[0].dispatches).toBe(2)
    expect(summary[0].totalTokens).toBe(100)
    expect(summary[0].costUsd).toBeCloseTo(0.01, 6)
  })

  it('respects sinceTs, excluding rows before the cutoff', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.01,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 5000,
      fromRoutingId: 'r1',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'm1',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.01,
      durationMs: 500
    })

    expect(dispatchedUsageSummary(4000)[0].dispatches).toBe(1)
    expect(dispatchedUsageSummary(0)[0].dispatches).toBe(2)
  })

  it('returns an empty array when there are no rows', () => {
    expect(dispatchedUsageSummary(0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Slice C — dispatchedCostsByRouting / renameDispatchedUsage
// ---------------------------------------------------------------------------

describe('dispatchedCostsByRouting', () => {
  it('aggregates cost per (targetEngine, targetModel) for ONE dispatching session', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'routing-A',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.1,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 1500,
      fromRoutingId: 'routing-A',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.05,
      durationMs: 500
    })
    // A different dispatching session — must NOT be included.
    insertDispatchedUsage({
      ts: 1600,
      fromRoutingId: 'routing-B',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 999,
      costUsd: 9.99,
      durationMs: 500
    })

    const rows = dispatchedCostsByRouting('routing-A')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetEngine: 'opencode', targetModel: 'openai/gpt-5' })
    expect(rows[0].costUsd).toBeCloseTo(0.15, 10)
  })

  it('excludes NULL-cost rows (a timed-out/errored turn recorded no real spend)', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'routing-C',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.2,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 2000,
      fromRoutingId: 'routing-C',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: null,
      costUsd: null,
      durationMs: null
    })

    const rows = dispatchedCostsByRouting('routing-C')
    expect(rows).toEqual([{ targetEngine: 'opencode', targetModel: 'openai/gpt-5', costUsd: 0.2 }])
  })

  it('returns separate rows per distinct targetModel', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'routing-D',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.1,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 1500,
      fromRoutingId: 'routing-D',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5-codex',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.2,
      durationMs: 500
    })

    const rows = dispatchedCostsByRouting('routing-D')
    expect(rows).toHaveLength(2)
    const byModel = new Map(rows.map((r) => [r.targetModel, r.costUsd]))
    expect(byModel.get('openai/gpt-5')).toBeCloseTo(0.1, 10)
    expect(byModel.get('openai/gpt-5-codex')).toBeCloseTo(0.2, 10)
  })

  it('returns an empty array for a routingId with no dispatched rows', () => {
    expect(dispatchedCostsByRouting('routing-none')).toEqual([])
  })
})

describe('renameDispatchedUsage', () => {
  it('moves rows from oldRoutingId to newRoutingId', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'tmp-routing',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: 'oc-sess-1',
      toolUseId: 'toolu_1',
      totalTokens: 100,
      costUsd: 0.1,
      durationMs: 500
    })

    renameDispatchedUsage('tmp-routing', 'canonical-session-id')

    expect(getDispatchedUsageSince(0).filter((r) => r.fromRoutingId === 'tmp-routing')).toEqual([])
    const moved = getDispatchedUsageSince(0).filter(
      (r) => r.fromRoutingId === 'canonical-session-id'
    )
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ targetModel: 'openai/gpt-5', costUsd: 0.1 })

    // seedDispatchedCosts()'s db query must find it under the NEW id.
    expect(dispatchedCostsByRouting('canonical-session-id')).toEqual([
      { targetEngine: 'opencode', targetModel: 'openai/gpt-5', costUsd: 0.1 }
    ])
  })

  it('is a no-op (does not throw) when oldRoutingId has no rows', () => {
    expect(() => renameDispatchedUsage('missing-old', 'new-id')).not.toThrow()
    expect(dispatchedCostsByRouting('new-id')).toEqual([])
  })

  it('moves ALL rows for oldRoutingId, preserving multiple entries', () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'multi-old',
      fromEngine: 'claude',
      targetEngine: 'opencode',
      targetModel: 'openai/gpt-5',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 100,
      costUsd: 0.1,
      durationMs: 500
    })
    insertDispatchedUsage({
      ts: 1500,
      fromRoutingId: 'multi-old',
      fromEngine: 'claude',
      targetEngine: 'claude',
      targetModel: 'haiku',
      targetSessionId: null,
      toolUseId: null,
      totalTokens: 50,
      costUsd: 0.05,
      durationMs: 300
    })

    renameDispatchedUsage('multi-old', 'multi-new')

    const rows = getDispatchedUsageSince(0).filter((r) => r.fromRoutingId === 'multi-new')
    expect(rows).toHaveLength(2)
  })
})
