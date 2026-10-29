/**
 * @vitest-environment node
 *
 * Migration v41 — the Codex engine was removed. A profile that still holds Codex rows is
 * settled the way a session delete settles it, and nothing that another build sharing the
 * file still names (the Codex tables, `dispatch_target.codex_account_id`) is dropped.
 *
 * Seeded at v40 by replaying the production prefix, then migrated to the latest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  MIGRATIONS,
  allSessionMeta,
  closeDb,
  runMigrations,
  type Db
} from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const NOW = 1_700_000_000_000

const placement = (engine: string): string => JSON.stringify({ engine, cwd: '/w' })

function seedAtV40(): Db {
  const db = new BetterSqlite3(':memory:') as unknown as Db
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 40)
  )
  expect(db.pragma('user_version', { simple: true })).toBe(40)

  const meta = db.prepare(
    'INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
  meta.run('cx1', 'codex', 'openai', 'gpt-5', NOW)
  meta.run('cx2', 'codex', 'openai', 'gpt-5', NOW)
  meta.run('cl1', 'claude', 'anthropic', 'opus', NOW)

  const inbox = db.prepare(
    `INSERT INTO session_inbox (target, origin, from_key, from_title, body, created_at)
     VALUES (?, 'session-message', 'k', 't', 'hi', ?)`
  )
  inbox.run('cx1', NOW)
  inbox.run('cl1', NOW)

  const ref = db.prepare(
    'INSERT INTO session_ref (ref, engine, session_id, routing_id, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  ref.run('s-cx0001', 'codex', 'cx1', 'cx1', NOW)
  ref.run('s-cx0002', 'codex', null, 'cx2', NOW)
  ref.run('s-cl0001', 'claude', 'cl1', 'cl1', NOW)
  ref.run('s-cl0002', 'claude', 'cl2', 'cl2', NOW)
  ref.run('s-cl0003', 'claude', 'cl3', 'cl3', NOW)

  const link = db.prepare(
    `INSERT INTO session_link (child_ref, parent_ref, kind, created_by, wake_parent, state, created_at, updated_at)
     VALUES (?, ?, 'started', 'agent', 0, ?, ?, ?)`
  )
  // A live Codex child of a Claude parent, and one that never started.
  link.run('s-cx0001', 's-cl0001', 'live', NOW, NOW)
  link.run('s-cx0002', 's-cl0001', 'starting', NOW, NOW)
  // A live Claude child of a Codex parent.
  link.run('s-cl0002', 's-cx0001', 'live', NOW, NOW)
  // A Claude pair no Codex ref is part of.
  link.run('s-cl0003', 's-cl0001', 'live', NOW, NOW)

  const proposal = db.prepare(
    `INSERT INTO session_proposal (id, parent_ref, title, prompt, background, placement, state, created_at, expires_at)
     VALUES (?, 's-cl0001', 't', 'p', 'b', ?, ?, ?, ?)`
  )
  proposal.run('prop-cx', placement('codex'), 'pending', NOW, NOW + 1)
  proposal.run('prop-cl', placement('claude'), 'pending', NOW, NOW + 1)
  proposal.run('prop-cx-started', placement('codex'), 'started', NOW, NOW + 1)

  const target = db.prepare(
    `INSERT INTO dispatch_target
       (id, engine, harness_ref, parent_session_id, parent_engine, cwd, model, launch_mode,
        account_key, codex_account_id, state, created_at, last_active_at, owner_pid, owner_boot)
     VALUES (?, ?, ?, 'cl1', ?, '/w', 'm', 'default', NULL, ?, ?, ?, ?, ?, ?)`
  )
  target.run('s-xa0001', 'codex', 'h1', 'claude', 'acct-1', 'running', NOW, NOW, 100, 'boot-1')
  target.run('s-xa0002', 'codex', 'h2', 'claude', null, 'idle', NOW, NOW, null, null)
  target.run('s-xa0003', 'claude', 'h3', 'codex', null, 'interrupted', NOW, NOW, null, null)
  target.run('s-xa0004', 'claude', 'h4', 'claude', null, 'running', NOW, NOW, 100, 'boot-1')

  db.prepare(
    "INSERT INTO codex_session_overrides (session_id, settings_json, updated_at) VALUES ('cx1', '{}', 1)"
  ).run()
  db.prepare(
    "INSERT INTO codex_forks (thread_id, forked_from_id, created_at) VALUES ('f', 'cx1', 1)"
  ).run()

  db.prepare(
    `INSERT INTO usage_event (id, ts, engine_id, vendor_id, model_id, message_id)
     VALUES ('u1', ?, 'codex', 'openai', 'gpt-5', 'm1')`
  ).run(NOW)
  return db
}

const rows = (db: Db, sql: string): Array<Record<string, unknown>> =>
  db.prepare(sql).all() as Array<Record<string, unknown>>

describe('migration v41 — Codex engine removal', () => {
  it('settles every row that names a Codex session, and leaves the rest and the history alone', () => {
    const db = seedAtV40()
    try {
      runMigrations(db)
      expect(db.pragma('user_version', { simple: true })).toBe(41)

      // session_meta: Codex rows gone, Claude intact.
      expect(rows(db, 'SELECT session_id FROM session_meta').map((r) => r.session_id)).toEqual([
        'cl1'
      ])
      // session_inbox: the rows aimed at Codex sessions go.
      expect(rows(db, 'SELECT target FROM session_inbox').map((r) => r.target)).toEqual(['cl1'])

      // session_ref: kept, ids cleared (cards keep naming them); Claude refs untouched.
      expect(
        rows(
          db,
          "SELECT ref, session_id, routing_id FROM session_ref WHERE engine = 'codex' ORDER BY ref"
        )
      ).toEqual([
        { ref: 's-cx0001', session_id: null, routing_id: null },
        { ref: 's-cx0002', session_id: null, routing_id: null }
      ])
      expect(
        rows(db, "SELECT routing_id FROM session_ref WHERE engine = 'claude' ORDER BY ref").map(
          (r) => r.routing_id
        )
      ).toEqual(['cl1', 'cl2', 'cl3'])

      // session_link: live ends, a never-started own link fails, the parent-side child ends,
      // the Claude-only link stays live.
      const state = Object.fromEntries(
        rows(db, 'SELECT child_ref, state FROM session_link').map((r) => [r.child_ref, r.state])
      )
      expect(state).toEqual({
        's-cx0001': 'ended',
        's-cx0002': 'failed',
        's-cl0002': 'ended',
        's-cl0003': 'live'
      })

      // session_proposal: only the pending Codex one is dismissed.
      expect(
        Object.fromEntries(
          rows(db, 'SELECT id, state, dismiss_reason FROM session_proposal').map((r) => [
            r.id,
            [r.state, r.dismiss_reason]
          ])
        )
      ).toEqual({
        'prop-cx': ['dismissed', 'engine-removed'],
        'prop-cl': ['pending', null],
        'prop-cx-started': ['started', null]
      })

      // dispatch_target: rows kept, non-terminal Codex ones stopped (owner cleared), Claude's untouched.
      expect(
        Object.fromEntries(
          rows(db, 'SELECT id, state, owner_pid FROM dispatch_target').map((r) => [
            r.id,
            [r.state, r.owner_pid]
          ])
        )
      ).toEqual({
        's-xa0001': ['stopped', null],
        's-xa0002': ['stopped', null],
        's-xa0003': ['stopped', null],
        's-xa0004': ['running', 100]
      })

      // Codex-only tables: rows gone, tables and the column an older build names are still there.
      expect(rows(db, 'SELECT * FROM codex_session_overrides')).toEqual([])
      expect(rows(db, 'SELECT * FROM codex_forks')).toEqual([])
      expect(
        (db.pragma('table_info(dispatch_target)') as Array<{ name: string }>).map((c) => c.name)
      ).toContain('codex_account_id')

      // History is history.
      expect(rows(db, 'SELECT engine_id FROM usage_event')).toEqual([{ engine_id: 'codex' }])
    } finally {
      db.close()
    }
  })

  it('does not return a Codex session_meta row an older build writes after the migration', () => {
    const db = seedAtV40()
    try {
      runMigrations(db)
      db.prepare(
        "INSERT INTO session_meta (session_id, engine_id, updated_at) VALUES ('late-cx', 'codex', ?)"
      ).run(NOW)
      expect(Object.keys(allSessionMeta(db))).toEqual(['cl1'])
    } finally {
      db.close()
    }
  })

  it('migrates a profile that never had Codex rows without touching anything', () => {
    const db = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 40)
      )
      db.prepare(
        "INSERT INTO session_meta (session_id, engine_id, updated_at) VALUES ('cl1', 'claude', 1)"
      ).run()
      runMigrations(db)
      expect(rows(db, 'SELECT session_id FROM session_meta')).toEqual([{ session_id: 'cl1' }])
    } finally {
      db.close()
    }
  })
})
