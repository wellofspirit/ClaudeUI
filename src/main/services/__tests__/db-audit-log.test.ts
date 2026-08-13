/**
 * @vitest-environment node
 *
 * SyncCore phase 1 — the v9 audit_log migration + its append-only repository:
 *   - migration creates the table (queryable, empty) and the ts index
 *   - appendAuditLog round-trips through listAuditLog, newest-first
 *   - limit / before paging
 *   - the module exposes NO update or delete surface for audit rows
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import * as dbModule from '../db'
import { runMigrations, closeDb, appendAuditLog, listAuditLog, type Db } from '../db'

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
  it('exports exactly append + list for audit rows — no update, no delete', () => {
    const auditExports = Object.keys(dbModule)
      .filter((k) => /audit/i.test(k))
      .sort()
    expect(auditExports).toEqual(['appendAuditLog', 'listAuditLog'])
  })

  it('contains no UPDATE/DELETE statement against audit_log anywhere in db.ts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/services/db.ts'), 'utf-8')
    expect(src).not.toMatch(/UPDATE\s+audit_log/i)
    expect(src).not.toMatch(/DELETE\s+FROM\s+audit_log/i)
  })
})
