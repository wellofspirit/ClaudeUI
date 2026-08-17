/**
 * @vitest-environment node
 *
 * SyncCore phase 1 — the v9 audit_log migration + its append-only repository:
 *   - migration creates the table (queryable, empty) and the ts index
 *   - appendAuditLog round-trips through listAuditLog, newest-first
 *   - limit / before paging
 *   - the module exposes no UPDATE and exactly one moving-window delete
 *   - ADR-054: the nullable `detail` column and the retention sweep
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import * as dbModule from '../../../core/services/db'
import {
  runMigrations,
  closeDb,
  appendAuditLog,
  clampAuditRetentionDays,
  listAuditLog,
  pruneAuditLog,
  DEFAULT_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  type Db
} from '../../../core/services/db'

const MS_PER_DAY = 24 * 60 * 60 * 1000

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function entry(over: Partial<Parameters<typeof appendAuditLog>[0]> = {}): Parameters<
  typeof appendAuditLog
>[0] {
  return {
    ts: 1000,
    connectionId: 'conn-1',
    method: 'token',
    label: 'token',
    capability: 'git',
    kind: 'command',
    channel: 'git:commit',
    sessionId: null,
    outcome: 'ok',
    ...over
  }
}

describe('DB migration — v9 audit_log', () => {
  it('creates an empty, queryable audit_log with a ts index', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(db.prepare('SELECT * FROM audit_log').all()).toEqual([])
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'")
        .all() as Array<{ name: string }>
      expect(indexes.map((i) => i.name)).toContain('idx_audit_log_ts')
    } finally {
      db.close()
    }
  })
})

describe('appendAuditLog / listAuditLog', () => {
  it('round-trips a row', () => {
    appendAuditLog(entry({ sessionId: 'routing-7', label: 'owner@example.com' }))
    const rows = listAuditLog()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ts: 1000,
      connectionId: 'conn-1',
      method: 'token',
      label: 'owner@example.com',
      capability: 'git',
      kind: 'command',
      channel: 'git:commit',
      sessionId: 'routing-7',
      outcome: 'ok'
    })
    expect(typeof rows[0].id).toBe('number')
  })

  it('returns rows newest-first and honors limit', () => {
    appendAuditLog(entry({ ts: 1, channel: 'a' }))
    appendAuditLog(entry({ ts: 2, channel: 'b' }))
    appendAuditLog(entry({ ts: 3, channel: 'c' }))

    expect(listAuditLog().map((r) => r.channel)).toEqual(['c', 'b', 'a'])
    expect(listAuditLog({ limit: 2 }).map((r) => r.channel)).toEqual(['c', 'b'])
  })

  it('pages with an exclusive `before` bound', () => {
    appendAuditLog(entry({ ts: 1, channel: 'a' }))
    appendAuditLog(entry({ ts: 2, channel: 'b' }))
    appendAuditLog(entry({ ts: 3, channel: 'c' }))

    expect(listAuditLog({ before: 3 }).map((r) => r.channel)).toEqual(['b', 'a'])
    expect(listAuditLog({ before: 1 })).toEqual([])
  })

  it('preserves an error outcome verbatim', () => {
    appendAuditLog(entry({ outcome: 'error' }))
    expect(listAuditLog()[0].outcome).toBe('error')
  })
})

describe('append-only surface', () => {
  it('exports append + list + the ONE sanctioned prune, and nothing else', () => {
    // ADR-054 decision 5 added retention, so the surface is no longer "no
    // deletion at all" — but it is still an exhaustive pin, which is the part
    // that matters. A fourth audit export (a row-targeted delete, an update, a
    // "clear log" helper) fails here and has to be argued for in review.
    const auditExports = Object.keys(dbModule)
      .filter((k) => /audit/i.test(k))
      .sort()
    expect(auditExports).toEqual([
      'DEFAULT_AUDIT_RETENTION_DAYS',
      'MIN_AUDIT_RETENTION_DAYS',
      'appendAuditLog',
      'clampAuditRetentionDays',
      'listAuditLog',
      'pruneAuditLog'
    ])
  })

  it('never UPDATEs audit_log, and deletes only by the moving ts window', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/services/db.ts'), 'utf-8')
    // No rewriting of history, ever.
    expect(src).not.toMatch(/UPDATE\s+audit_log/i)
    // Exactly one DELETE, and its predicate is `ts < ?` — a retention sweep that
    // cannot be AIMED. A delete keyed on id/connection_id/channel would let an
    // actor remove the rows that name it, which is the property this pin exists
    // to protect now that deletion exists at all.
    const deletes = src.match(/DELETE\s+FROM\s+audit_log[^`']*/gi) ?? []
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.replace(/\s+/g, ' ').trim()).toBe('DELETE FROM audit_log WHERE ts < ?')
  })
})

describe('retention (ADR-054 decision 5)', () => {
  it('deletes only rows older than the window and keeps the rest', () => {
    const now = 10_000 * MS_PER_DAY
    const row = (ts: number, channel: string): void => {
      appendAuditLog({
        ts,
        connectionId: 'c1',
        method: 'token',
        label: 'token',
        capability: 'chat',
        kind: 'command',
        channel,
        sessionId: null,
        outcome: 'ok'
      })
    }
    row(now - 400 * MS_PER_DAY, 'ancient')
    row(now - 366 * MS_PER_DAY, 'just-too-old')
    row(now - 364 * MS_PER_DAY, 'just-inside')
    row(now - 1 * MS_PER_DAY, 'yesterday')

    expect(pruneAuditLog(now)).toBe(2)
    expect(listAuditLog().map((r) => r.channel).sort()).toEqual(['just-inside', 'yesterday'])
    // Idempotent on the same clock.
    expect(pruneAuditLog(now)).toBe(0)
  })

  it('is EXACT at the boundary: a row at ts === cutoff survives', () => {
    // The predicate is `ts < cutoff`, strictly. Worth pinning rather than
    // assuming: an off-by-one here silently shortens (or lengthens) every
    // operator's retention by a day, and a `<=` would make the floor a
    // 29-days-and-change window rather than the 30 the guard promises.
    const now = 10_000 * MS_PER_DAY
    const cutoff = now - DEFAULT_AUDIT_RETENTION_DAYS * MS_PER_DAY
    const row = (ts: number, channel: string): void => {
      appendAuditLog({
        ts,
        connectionId: 'c1',
        method: 'token',
        label: 'token',
        capability: 'chat',
        kind: 'command',
        channel,
        sessionId: null,
        outcome: 'ok'
      })
    }
    row(cutoff - 1, 'one-ms-too-old')
    row(cutoff, 'exactly-at-cutoff')
    row(cutoff + 1, 'one-ms-inside')

    expect(pruneAuditLog(now)).toBe(1)
    expect(listAuditLog().map((r) => r.channel).sort()).toEqual([
      'exactly-at-cutoff',
      'one-ms-inside'
    ])
  })

  it('purges auth rows on the SAME window as command rows (uniform, by decision)', () => {
    const now = 10_000 * MS_PER_DAY
    appendAuditLog({
      ts: now - 400 * MS_PER_DAY,
      connectionId: 'c1',
      method: 'webauthn',
      label: 'Phone',
      capability: 'admin',
      kind: 'command',
      channel: 'auth:webauthn-assert',
      sessionId: null,
      outcome: 'ok',
      detail: 'passkey login accepted'
    })
    expect(pruneAuditLog(now)).toBe(1)
    expect(listAuditLog()).toEqual([])
  })

  it('clamps to the 30-day floor — a caller cannot erase the trail that names it', () => {
    expect(clampAuditRetentionDays(0)).toBe(MIN_AUDIT_RETENTION_DAYS)
    expect(clampAuditRetentionDays(-5)).toBe(MIN_AUDIT_RETENTION_DAYS)
    expect(clampAuditRetentionDays(29)).toBe(MIN_AUDIT_RETENTION_DAYS)
    expect(clampAuditRetentionDays(31)).toBe(31)
    expect(clampAuditRetentionDays(null)).toBe(DEFAULT_AUDIT_RETENTION_DAYS)
    expect(clampAuditRetentionDays(Number.NaN)).toBe(DEFAULT_AUDIT_RETENTION_DAYS)

    // …and the clamp is applied by the prune itself, not only by its callers.
    const now = 10_000 * MS_PER_DAY
    appendAuditLog({
      ts: now - 20 * MS_PER_DAY,
      connectionId: 'c1',
      method: 'token',
      label: 'token',
      capability: 'chat',
      kind: 'command',
      channel: 'session:send',
      sessionId: null,
      outcome: 'ok'
    })
    expect(pruneAuditLog(now, 0)).toBe(0)
    expect(listAuditLog()).toHaveLength(1)
  })

  it('carries `detail` on auth rows and NULL on command rows', () => {
    appendAuditLog({
      ts: 1,
      connectionId: 'c1',
      method: 'token',
      label: 'token',
      capability: 'chat',
      kind: 'command',
      channel: 'session:send',
      sessionId: 's1',
      outcome: 'ok'
    })
    appendAuditLog({
      ts: 2,
      connectionId: 'c1',
      method: 'webauthn',
      label: 'Phone',
      capability: 'shell',
      kind: 'command',
      channel: 'auth:webauthn-assert',
      sessionId: null,
      outcome: 'ok',
      detail: 'shell + mutation grants armed via passkey step-up'
    })
    const rows = listAuditLog()
    expect(rows.find((r) => r.channel === 'session:send')!.detail).toBeNull()
    expect(rows.find((r) => r.channel === 'auth:webauthn-assert')!.detail).toBe(
      'shell + mutation grants armed via passkey step-up'
    )
  })
})
