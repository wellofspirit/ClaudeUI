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
  type Db
} from '../db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

describe('DB migration — v6 dispatched_usage', () => {
  it('applies all migrations and reaches user_version 6', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(userVersion(db)).toBe(6)
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
