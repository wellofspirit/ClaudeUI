/**
 * @vitest-environment node
 *
 * The held inbox table (slice 1a, migration v30), tested through the driver seam
 * (the suite aliases `better-sqlite3` to a `node:sqlite`-backed stub): an item a
 * session could not take now waits here, oldest first, until its next turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  MIGRATIONS,
  addInboxItem,
  closeDb,
  deleteSessionInbox,
  heldInboxCount,
  heldInboxItems,
  markInboxDelivered,
  moveSessionInbox,
  runMigrations,
  type Db
} from '../../../core/services/db'

let db: Db

beforeEach(() => {
  closeDb()
  db = new BetterSqlite3(':memory:') as unknown as Db
  runMigrations(db)
})

afterEach(() => {
  db.close()
  closeDb()
})

const item = (target: string, body: string, over: Record<string, unknown> = {}) => ({
  target,
  origin: 'session-message' as const,
  fromKey: 'sender-1',
  fromTitle: 'Triage assistant',
  senderModeClass: null,
  body,
  ...over
})

describe('session_inbox', () => {
  it('is created by its own migration (v30), on top of an existing profile', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 30)
      )
      const exists = (): boolean =>
        older.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_inbox'").get() !==
        undefined
      expect(exists()).toBe(false)
      runMigrations(older)
      expect(exists()).toBe(true)
      expect(older.pragma('user_version', { simple: true })).toBe(38)
    } finally {
      older.close()
    }
    const columns = (
      db.prepare('PRAGMA table_info(session_inbox)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toEqual([
      'id',
      'target',
      'origin',
      'from_key',
      'from_title',
      'sender_mode_class',
      'body',
      'created_at',
      'delivered_at',
      'report_run'
    ])
  })

  it('v37 adds report_run to a v36 profile and keeps the run of a held X-Agent result', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 37)
      )
      const columns = (): string[] =>
        (older.prepare('PRAGMA table_info(session_inbox)').all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      expect(columns()).not.toContain('report_run')
      older
        .prepare(
          "INSERT INTO session_inbox (target, origin, from_key, from_title, body, created_at) VALUES ('a', 'session-message', 'k', 't', 'old row', 1)"
        )
        .run()
      runMigrations(older)
      expect(columns()).toContain('report_run')
      // A row from before the column reads as no run.
      expect(heldInboxItems('a', older)[0].reportRun).toBeNull()
      addInboxItem(item('a', 'result', { origin: 'dispatch-result', reportRun: 3 }), older)
      expect(heldInboxItems('a', older).map((r) => r.reportRun)).toEqual([null, 3])
    } finally {
      older.close()
    }
  })

  it('holds items per target, oldest first, with the sender and class intact', () => {
    addInboxItem(item('a', 'first', { senderModeClass: 'bypass', createdAt: 5 }), db)
    addInboxItem(item('b', 'other session'), db)
    addInboxItem(item('a', 'second', { origin: 'agent-note' }), db)
    const held = heldInboxItems('a', db)
    expect(held.map((r) => r.body)).toEqual(['first', 'second'])
    expect(held[0]).toMatchObject({
      target: 'a',
      origin: 'session-message',
      fromKey: 'sender-1',
      fromTitle: 'Triage assistant',
      senderModeClass: 'bypass',
      createdAt: 5,
      deliveredAt: null
    })
    expect(held[1]).toMatchObject({ origin: 'agent-note', senderModeClass: null })
    expect(heldInboxCount('a', db)).toBe(2)
    expect(heldInboxCount('b', db)).toBe(1)
    expect(heldInboxCount('nobody', db)).toBe(0)
  })

  it('a delivered item leaves the inbox but stays a row', () => {
    const first = addInboxItem(item('a', 'first'), db)
    addInboxItem(item('a', 'second'), db)
    markInboxDelivered(first, 99, db)
    expect(heldInboxItems('a', db).map((r) => r.body)).toEqual(['second'])
    expect(heldInboxCount('a', db)).toBe(1)
    const row = db.prepare('SELECT delivered_at FROM session_inbox WHERE id = ?').get(first) as {
      delivered_at: number
    }
    expect(Number(row.delivered_at)).toBe(99)
  })

  it('keeps the dispatch-result origin of a held X-Agent result (an unknown origin still reads as a session message)', () => {
    addInboxItem(
      item('a', 'result', { origin: 'dispatch-result', fromKey: 'x-agent:s-abc234' }),
      db
    )
    db.prepare(
      "INSERT INTO session_inbox (target, origin, from_key, from_title, body, created_at) VALUES ('a', 'bogus', 'k', 't', 'odd', 1)"
    ).run()
    expect(heldInboxItems('a', db).map((r) => [r.origin, r.fromKey])).toEqual([
      ['dispatch-result', 'x-agent:s-abc234'],
      ['session-message', 'k']
    ])
  })

  it('follows a session to its post-rekey id', () => {
    addInboxItem(item('temp-id', 'waiting'), db)
    moveSessionInbox('temp-id', 'engine-id', db)
    expect(heldInboxItems('temp-id', db)).toEqual([])
    expect(heldInboxItems('engine-id', db).map((r) => r.body)).toEqual(['waiting'])
  })

  it('is dropped with its session', () => {
    addInboxItem(item('gone', 'x'), db)
    addInboxItem(item('kept', 'y'), db)
    deleteSessionInbox('gone', db)
    expect(heldInboxCount('gone', db)).toBe(0)
    expect(heldInboxCount('kept', db)).toBe(1)
  })
})
