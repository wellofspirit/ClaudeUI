/**
 * @vitest-environment node
 *
 * The session ref and link tables (slice 1b, migration v31), tested through the
 * driver seam: one ref per session however many ids it has gone by, the rekey
 * move (including the merge when a ref is already bound to the new id), and the
 * link rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  MIGRATIONS,
  allSessionLinks,
  clearSessionRefIds,
  closeDb,
  findSessionRef,
  getSessionLink,
  getSessionRef,
  insertSessionRef,
  moveSessionRef,
  runMigrations,
  sessionLinksByParent,
  markSessionLinkClientPrompted,
  setSessionLinkState,
  upsertSessionLink,
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

const ref = (
  r: string,
  over: Partial<Parameters<typeof insertSessionRef>[0]> = {}
): Parameters<typeof insertSessionRef>[0] => ({
  ref: r,
  engine: 'claude',
  sessionId: null,
  routingId: null,
  ...over
})

const link = (
  child: string,
  parent: string,
  over: Partial<Parameters<typeof upsertSessionLink>[0]> = {}
): Parameters<typeof upsertSessionLink>[0] => ({
  childRef: child,
  parentRef: parent,
  kind: 'started',
  createdBy: 'agent',
  wakeParent: false,
  state: 'starting',
  ...over
})

describe('session_ref / session_link tables', () => {
  it('are created by their own migration (v31), on top of an existing profile', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 31)
      )
      const exists = (name: string): boolean =>
        older.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
      expect(exists('session_ref')).toBe(false)
      expect(exists('session_link')).toBe(false)
      runMigrations(older)
      expect(exists('session_ref')).toBe(true)
      expect(exists('session_link')).toBe(true)
      expect(older.pragma('user_version', { simple: true })).toBe(32)
    } finally {
      older.close()
    }
  })
})

describe('refs', () => {
  it('keeps a ref unique, and an id bound to one ref only', () => {
    expect(insertSessionRef(ref('s-aaaaaa', { routingId: 'r1' }), db)).toBe(true)
    // The ref itself is taken.
    expect(insertSessionRef(ref('s-aaaaaa', { routingId: 'r2' }), db)).toBe(false)
    // So is a routing id, and a durable id within an engine.
    expect(insertSessionRef(ref('s-bbbbbb', { routingId: 'r1' }), db)).toBe(false)
    expect(insertSessionRef(ref('s-cccccc', { sessionId: 'd1' }), db)).toBe(true)
    expect(insertSessionRef(ref('s-dddddd', { sessionId: 'd1' }), db)).toBe(false)
    // Rows with no ids yet do not collide with each other.
    expect(insertSessionRef(ref('s-eeeeee'), db)).toBe(true)
    expect(insertSessionRef(ref('s-ffffff'), db)).toBe(true)
  })

  it('finds a session by its routing id or its durable id, the routing id winning a tie', () => {
    insertSessionRef(ref('s-aaaaaa', { routingId: 'r1' }), db)
    insertSessionRef(ref('s-bbbbbb', { sessionId: 'd1' }), db)
    expect(findSessionRef('r1', db)?.ref).toBe('s-aaaaaa')
    expect(findSessionRef('d1', db)?.ref).toBe('s-bbbbbb')
    expect(findSessionRef('nope', db)).toBeUndefined()
    // Both rows claim 'x' (one as a routing id, one as a durable id): the routing id answers.
    insertSessionRef(ref('s-cccccc', { sessionId: 'x' }), db)
    insertSessionRef(ref('s-dddddd', { routingId: 'x' }), db)
    expect(findSessionRef('x', db)?.ref).toBe('s-dddddd')
  })

  it('moves a ref to the new id on a rekey: both columns take it, the old id stops resolving', () => {
    insertSessionRef(ref('s-aaaaaa', { routingId: 'temp-1' }), db)
    moveSessionRef('temp-1', 'thread-9', db)
    const row = getSessionRef('s-aaaaaa', db)
    expect(row?.routingId).toBe('thread-9')
    expect(row?.sessionId).toBe('thread-9')
    expect(findSessionRef('temp-1', db)).toBeUndefined()
    // A rekey for an id with no ref changes nothing.
    moveSessionRef('ghost', 'thread-10', db)
    expect(findSessionRef('thread-10', db)).toBeUndefined()
  })

  it('merges into the ref already bound to the new id, pointing the links at it', () => {
    // 's-old' was assigned to the durable id of a cold session; the session was then
    // resumed under a fresh routing id that also got a ref ('s-new') and a child link.
    insertSessionRef(ref('s-oldold', { sessionId: 'thread-9', routingId: 'thread-9' }), db)
    insertSessionRef(ref('s-newnew', { routingId: 'temp-1' }), db)
    insertSessionRef(ref('s-child1', { routingId: 'kid-1' }), db)
    upsertSessionLink(link('s-child1', 's-newnew'), db)
    upsertSessionLink(link('s-newnew', 's-parent'), db)

    moveSessionRef('temp-1', 'thread-9', db)

    expect(getSessionRef('s-newnew', db)).toBeUndefined()
    expect(findSessionRef('thread-9', db)?.ref).toBe('s-oldold')
    expect(getSessionLink('s-child1', db)?.parentRef).toBe('s-oldold')
    // The newcomer's own link to its parent now belongs to the surviving ref.
    expect(getSessionLink('s-oldold', db)?.parentRef).toBe('s-parent')
    expect(getSessionLink('s-newnew', db)).toBeUndefined()
  })

  it('lets a deleted session keep its ref while no id resolves to it', () => {
    insertSessionRef(ref('s-aaaaaa', { sessionId: 'd1', routingId: 'd1' }), db)
    expect(clearSessionRefIds('d1', db)).toBe('s-aaaaaa')
    expect(findSessionRef('d1', db)).toBeUndefined()
    expect(getSessionRef('s-aaaaaa', db)?.sessionId).toBeNull()
    expect(clearSessionRefIds('d1', db)).toBeUndefined()
  })
})

describe('links', () => {
  it('records one parent per child; a second record replaces the first', () => {
    upsertSessionLink(link('s-child1', 's-parent', { now: 1_000 }), db)
    upsertSessionLink(
      link('s-child1', 's-other', { kind: 'handoff', createdBy: 'user', wakeParent: true }),
      db
    )
    const row = getSessionLink('s-child1', db)
    expect(row).toMatchObject({
      parentRef: 's-other',
      kind: 'handoff',
      createdBy: 'user',
      wakeParent: true,
      state: 'starting'
    })
    expect(allSessionLinks(db)).toHaveLength(1)
  })

  it('lists a parent’s children oldest first', () => {
    upsertSessionLink(link('s-bbbbbb', 's-parent', { now: 2_000 }), db)
    upsertSessionLink(link('s-aaaaaa', 's-parent', { now: 3_000 }), db)
    upsertSessionLink(link('s-cccccc', 's-parent', { now: 1_000 }), db)
    upsertSessionLink(link('s-dddddd', 's-else', { now: 1_000 }), db)
    expect(sessionLinksByParent('s-parent', db).map((l) => l.childRef)).toEqual([
      's-cccccc',
      's-bbbbbb',
      's-aaaaaa'
    ])
  })

  it('moves a link between states, reporting whether anything changed', () => {
    upsertSessionLink(link('s-child1', 's-parent'), db)
    expect(setSessionLinkState('s-child1', 'live', 5_000, db)).toBe(true)
    expect(getSessionLink('s-child1', db)).toMatchObject({ state: 'live', updatedAt: 5_000 })
    expect(setSessionLinkState('s-child1', 'live', 6_000, db)).toBe(false)
    expect(getSessionLink('s-child1', db)?.updatedAt).toBe(5_000)
    expect(setSessionLinkState('s-nope', 'live', 6_000, db)).toBe(false)
  })
})

describe('client_prompted_at (migration v32)', () => {
  it('is added by its own migration to a profile that already has links, which keep their rows with it null', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 32)
      )
      upsertSessionLink(link('s-child1', 's-parent'), older)
      expect(
        (older.prepare('PRAGMA table_info(session_link)').all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      ).not.toContain('client_prompted_at')
      runMigrations(older)
      expect(older.pragma('user_version', { simple: true })).toBe(32)
      expect(getSessionLink('s-child1', older)).toMatchObject({
        childRef: 's-child1',
        clientPromptedAt: null
      })
    } finally {
      older.close()
    }
  })

  it('is set once by the first client prompt, found by either of the session ids', () => {
    insertSessionRef(ref('s-kid111', { sessionId: 'd1', routingId: 'r1' }), db)
    upsertSessionLink(link('s-kid111', 's-parent'), db)
    expect(markSessionLinkClientPrompted('nobody', 100, db)).toBe(false)
    expect(markSessionLinkClientPrompted('r1', 100, db)).toBe(true)
    expect(getSessionLink('s-kid111', db)?.clientPromptedAt).toBe(100)
    expect(markSessionLinkClientPrompted('d1', 200, db)).toBe(false)
    expect(getSessionLink('s-kid111', db)?.clientPromptedAt).toBe(100)
  })

  it('is not reset when the link is recorded again (state moves, the prompt stays)', () => {
    insertSessionRef(ref('s-kid222', { routingId: 'r2' }), db)
    upsertSessionLink(link('s-kid222', 's-parent'), db)
    markSessionLinkClientPrompted('r2', 100, db)
    upsertSessionLink(link('s-kid222', 's-parent', { state: 'live' }), db)
    expect(getSessionLink('s-kid222', db)).toMatchObject({ state: 'live', clientPromptedAt: 100 })
  })
})
