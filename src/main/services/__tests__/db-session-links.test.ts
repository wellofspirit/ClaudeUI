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
  getSessionProposal,
  insertSessionProposal,
  markSessionLinkClientPrompted,
  sessionProposalStartedRef,
  sessionProposalsByParent,
  settleSessionProposal,
  transitionSessionProposal,
  trimSessionProposals,
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
      expect(older.pragma('user_version', { simple: true })).toBe(33)
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
      expect(older.pragma('user_version', { simple: true })).toBe(33)
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

describe('session_proposal (migration v33)', () => {
  const proposal = (
    id: string,
    over: Partial<Parameters<typeof insertSessionProposal>[0]> = {}
  ): Parameters<typeof insertSessionProposal>[0] => ({
    id,
    parentRef: 's-parent',
    title: 'T',
    prompt: 'p',
    background: 'b',
    placement: '{}',
    createdAt: 100,
    expiresAt: 1000,
    ...over
  })

  it('is created by its own migration on top of an existing profile', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 33)
      )
      const exists = (): boolean =>
        older.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get('session_proposal') !==
        undefined
      expect(exists()).toBe(false)
      runMigrations(older)
      expect(exists()).toBe(true)
      expect(older.pragma('user_version', { simple: true })).toBe(33)
    } finally {
      older.close()
    }
  })

  it('stores a pending proposal and reads it back; the id is unique', () => {
    insertSessionProposal(proposal('p-00000001', { placement: '{"cwd":"/x"}' }), db)
    expect(getSessionProposal('p-00000001', db)).toMatchObject({
      id: 'p-00000001',
      parentRef: 's-parent',
      state: 'pending',
      placement: '{"cwd":"/x"}',
      createdAt: 100,
      expiresAt: 1000,
      startedRef: null,
      dismissReason: null
    })
    expect(() => insertSessionProposal(proposal('p-00000001'), db)).toThrow()
    expect(getSessionProposal('p-nope', db)).toBeUndefined()
  })

  it('lists a parent’s proposals oldest first, by state, even within one millisecond', () => {
    insertSessionProposal(proposal('p-0000000b', { createdAt: 5 }), db)
    insertSessionProposal(proposal('p-0000000a', { createdAt: 5 }), db)
    insertSessionProposal(proposal('p-0000000c', { createdAt: 4 }), db)
    insertSessionProposal(proposal('p-0000000d', { parentRef: 's-other' }), db)
    expect(sessionProposalsByParent('s-parent', undefined, db).map((r) => r.id)).toEqual([
      'p-0000000c',
      'p-0000000b',
      'p-0000000a'
    ])
    settleSessionProposal('p-0000000c', { state: 'dismissed', reason: 'user' }, db)
    expect(sessionProposalsByParent('s-parent', 'pending', db).map((r) => r.id)).toEqual([
      'p-0000000b',
      'p-0000000a'
    ])
  })

  it('settles a pending proposal exactly once, whichever way', () => {
    insertSessionProposal(proposal('p-00000010'), db)
    insertSessionProposal(proposal('p-00000011'), db)
    expect(
      settleSessionProposal('p-00000010', { state: 'started', startedRef: 's-child1' }, db)
    ).toBe(true)
    expect(getSessionProposal('p-00000010', db)).toMatchObject({
      state: 'started',
      startedRef: 's-child1'
    })
    // Neither a dismissal nor a second start can follow.
    expect(settleSessionProposal('p-00000010', { state: 'dismissed', reason: 'user' }, db)).toBe(
      false
    )
    expect(
      settleSessionProposal('p-00000010', { state: 'started', startedRef: 's-other' }, db)
    ).toBe(false)
    expect(getSessionProposal('p-00000010', db)?.startedRef).toBe('s-child1')
    expect(settleSessionProposal('p-00000011', { state: 'dismissed', reason: 'expired' }, db)).toBe(
      true
    )
    expect(settleSessionProposal('p-00000011', { state: 'started', startedRef: 's-x' }, db)).toBe(
      false
    )
    expect(getSessionProposal('p-00000011', db)).toMatchObject({
      state: 'dismissed',
      dismissReason: 'expired',
      startedRef: null
    })
    expect(settleSessionProposal('p-nope', { state: 'dismissed', reason: 'x' }, db)).toBe(false)
  })

  it('claims a pending proposal once; only the claim can finish or give it back', () => {
    insertSessionProposal(proposal('p-00000020'), db)
    expect(transitionSessionProposal('p-00000020', 'pending', { state: 'starting' }, db)).toBe(true)
    // Starting is nobody else's: not a dismissal, not a second claim, not an expiry settle.
    expect(settleSessionProposal('p-00000020', { state: 'dismissed', reason: 'user' }, db)).toBe(
      false
    )
    expect(transitionSessionProposal('p-00000020', 'pending', { state: 'starting' }, db)).toBe(
      false
    )
    expect(getSessionProposal('p-00000020', db)?.state).toBe('starting')
    expect(sessionProposalsByParent('s-parent', 'pending', db)).toEqual([])
    // Given back, it is pending again; claimed again, it can finish.
    expect(transitionSessionProposal('p-00000020', 'starting', { state: 'pending' }, db)).toBe(true)
    expect(transitionSessionProposal('p-00000020', 'pending', { state: 'starting' }, db)).toBe(true)
    expect(
      transitionSessionProposal(
        'p-00000020',
        'starting',
        { state: 'started', startedRef: 's-kid999' },
        db
      )
    ).toBe(true)
    expect(getSessionProposal('p-00000020', db)).toMatchObject({
      state: 'started',
      startedRef: 's-kid999'
    })
    expect(sessionProposalStartedRef('s-kid999', db)).toBe(true)
    expect(sessionProposalStartedRef('s-other1', db)).toBe(false)
  })

  it('trims a parent to N rows: evicted first, then other dismissed, oldest first; never pending, starting or started', () => {
    const make = (id: string, at: number): void =>
      insertSessionProposal(proposal(id, { createdAt: at }), db)
    make('p-00000030', 1) // dismissed by the user
    make('p-00000031', 2) // evicted
    make('p-00000032', 3) // started
    make('p-00000033', 4) // evicted
    make('p-00000034', 5) // pending
    make('p-00000035', 6) // starting
    settleSessionProposal('p-00000030', { state: 'dismissed', reason: 'user' }, db)
    settleSessionProposal('p-00000031', { state: 'dismissed', reason: 'evicted' }, db)
    settleSessionProposal('p-00000032', { state: 'started', startedRef: 's-kid300' }, db)
    settleSessionProposal('p-00000033', { state: 'dismissed', reason: 'evicted' }, db)
    transitionSessionProposal('p-00000035', 'pending', { state: 'starting' }, db)
    expect(trimSessionProposals('s-parent', 10, db)).toBe(0)
    expect(trimSessionProposals('s-parent', 5, db)).toBe(1)
    expect(getSessionProposal('p-00000031', db)).toBeUndefined() // the oldest evicted
    expect(getSessionProposal('p-00000033', db)).toBeDefined()
    expect(trimSessionProposals('s-parent', 1, db)).toBe(2) // the other evicted, then the user's
    expect(sessionProposalsByParent('s-parent', undefined, db).map((r) => r.id)).toEqual([
      'p-00000032',
      'p-00000034',
      'p-00000035'
    ])
    // Another parent is untouched.
    insertSessionProposal(proposal('p-00000036', { parentRef: 's-other' }), db)
    expect(trimSessionProposals('s-parent', 0, db)).toBe(0)
    expect(getSessionProposal('p-00000036', db)).toBeDefined()
  })
})
