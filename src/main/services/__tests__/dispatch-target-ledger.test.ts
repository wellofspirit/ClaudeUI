/**
 * @vitest-environment node
 *
 * The X-Agent ledger (ADR-105, slice B-1): migration v35, the DAO in `db.ts`, and
 * the leaf module (`dispatch-target-ledger.ts`) the dispatcher and the three
 * history readers share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  MIGRATIONS,
  allDispatchTargetHarnessRefs,
  closeDb,
  dispatchTargetSpend,
  dispatchTargetsByParent,
  dispatchTargetsNotStopped,
  getDispatchTarget,
  getDispatchTargetByHarnessRef,
  getSessionRef,
  heldInboxItems,
  insertDispatchTarget,
  insertDispatchTargetWithRef,
  insertUsageEvent,
  interruptDispatchTargets,
  moveDispatchTargetParent,
  runningDispatchTargets,
  runMigrations,
  updateDispatchTarget,
  type Db,
  type DispatchTargetRow
} from '../../../core/services/db'
import {
  DISPATCH_CACHE_TTL_MS,
  dispatchLedger,
  dispatchPiSessionDir,
  interruptStaleDispatchTargets,
  isDispatchTargetSession,
  resetDispatchTargetSessions
} from '../../../core/services/dispatch-target-ledger'
import { currentInstanceOwner, type InstanceOwner } from '../../../core/services/instance-owner'
import { isRef } from '../../../shared/session-links'

let db: Db

beforeEach(() => {
  closeDb()
  resetDispatchTargetSessions()
  db = new BetterSqlite3(':memory:') as unknown as Db
  runMigrations(db)
})

afterEach(() => {
  db.close()
  closeDb()
  resetDispatchTargetSessions()
})

function row(over: Partial<DispatchTargetRow> = {}): DispatchTargetRow {
  return {
    id: 's-000001',
    engine: 'claude',
    harnessRef: '7d0c2f4e-1b8a-4a53-9a33-0f2d1c5e6b7a',
    parentSessionId: 'parent-1',
    parentEngine: 'opencode',
    parentToolUseId: 'toolu_1',
    cwd: '/proj',
    parentCwd: '/proj',
    model: 'haiku',
    launchMode: 'acceptEdits',
    accountKey: 'anthropic:org:acc',
    callerRestriction: null,
    name: null,
    description: null,
    handBack: false,
    state: 'running',
    createdAt: 100,
    lastActiveAt: 100,
    ...over
  }
}

describe('dispatch_target (migration v35)', () => {
  it('is created by its own migration, on top of an existing profile', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 35)
      )
      const exists = (): boolean =>
        older.prepare("SELECT 1 FROM sqlite_master WHERE name = 'dispatch_target'").get() !==
        undefined
      expect(exists()).toBe(false)
      runMigrations(older)
      expect(exists()).toBe(true)
      expect(older.pragma('user_version', { simple: true })).toBe(41)
      const columns = (
        older.prepare('PRAGMA table_info(dispatch_target)').all() as { name: string }[]
      ).map((c) => c.name)
      expect(columns).toEqual([
        'id',
        'engine',
        'harness_ref',
        'parent_session_id',
        'parent_engine',
        'parent_tool_use_id',
        'cwd',
        'model',
        'launch_mode',
        'account_key',
        'codex_account_id',
        'caller_restriction',
        'name',
        'description',
        'state',
        'created_at',
        'last_active_at',
        // v36 (the report store, ADR-105 §3): the target was started with `hand_back`.
        'hand_back',
        // v39: the instance that runs a `running` target.
        'owner_pid',
        'owner_boot',
        // v40: the dispatching session's own directory (the target's `cwd` may be its `workdir`).
        'parent_cwd'
      ])
    } finally {
      older.close()
    }
  })
})

describe('migration v39 (the owner of a running target)', () => {
  it('upgrades a v38 profile and keeps its rows, with no owner (they keep the old boot rule)', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 39)
      )
      expect(older.pragma('user_version', { simple: true })).toBe(38)
      older
        .prepare(
          `INSERT INTO dispatch_target
             (id, engine, harness_ref, parent_session_id, parent_engine, cwd, model, launch_mode,
              state, created_at, last_active_at, hand_back)
           VALUES ('s-aaaaaa', 'claude', 'h-1', 'p-1', 'claude', '/proj', 'haiku', 'default',
                   'running', 5, 6, 1)`
        )
        .run()
      runMigrations(older)
      expect(older.pragma('user_version', { simple: true })).toBe(41)
      const [kept] = runningDispatchTargets(older)
      expect(kept).toMatchObject({
        id: 's-aaaaaa',
        harnessRef: 'h-1',
        handBack: true,
        state: 'running',
        createdAt: 5,
        owner: null
      })
    } finally {
      older.close()
    }
  })
})

describe('migration v40 (the parent directory of a target)', () => {
  it('adds a nullable parent_cwd, and a row written before it reads it as its own cwd', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 40)
      )
      expect(older.pragma('user_version', { simple: true })).toBe(39)
      older
        .prepare(
          `INSERT INTO dispatch_target
             (id, engine, harness_ref, parent_session_id, parent_engine, cwd, model, launch_mode,
              state, created_at, last_active_at)
           VALUES ('s-bbbbbb', 'pi', 'h-2', 'p-1', 'claude', 'D:/repo', 'm', 'default',
                   'idle', 5, 6)`
        )
        .run()
      runMigrations(older)
      expect(older.pragma('user_version', { simple: true })).toBe(41)
      const column = (
        older.prepare('PRAGMA table_info(dispatch_target)').all() as {
          name: string
          notnull: number
        }[]
      ).find((c) => c.name === 'parent_cwd')
      expect(column).toMatchObject({ name: 'parent_cwd', notnull: 0 })
      expect(
        (
          older.prepare("SELECT parent_cwd FROM dispatch_target WHERE id = 's-bbbbbb'").get() as {
            parent_cwd: string | null
          }
        ).parent_cwd
      ).toBeNull()
      expect(getDispatchTarget('s-bbbbbb', older)).toMatchObject({
        cwd: 'D:/repo',
        parentCwd: 'D:/repo'
      })
    } finally {
      older.close()
    }
  })
})

describe('dispatch_target DAO', () => {
  it('stores the directory a target runs in beside the dispatching session directory', () => {
    insertDispatchTarget(row({ cwd: '/proj/wt/a', parentCwd: '/proj' }), db)
    expect(getDispatchTarget('s-000001', db)).toMatchObject({
      cwd: '/proj/wt/a',
      parentCwd: '/proj'
    })
    expect(
      (
        db.prepare("SELECT parent_cwd FROM dispatch_target WHERE id = 's-000001'").get() as {
          parent_cwd: string
        }
      ).parent_cwd
    ).toBe('/proj')
  })

  it('round-trips a row by id and by (engine, harness id)', () => {
    expect(insertDispatchTarget(row(), db)).toBe(true)
    expect(getDispatchTarget('s-000001', db)).toEqual(row())
    expect(getDispatchTargetByHarnessRef('claude', row().harnessRef, db)).toEqual(row())
    // The same harness id under another engine is another target.
    expect(getDispatchTargetByHarnessRef('pi', row().harnessRef, db)).toBeUndefined()
    expect(getDispatchTarget('s-nope00', db)).toBeUndefined()
  })

  it('refuses a second row for the same harness session or the same id', () => {
    expect(insertDispatchTarget(row(), db)).toBe(true)
    expect(insertDispatchTarget(row({ id: 's-000002' }), db)).toBe(false)
    expect(insertDispatchTarget(row({ harnessRef: 'other' }), db)).toBe(false)
    expect(insertDispatchTarget(row({ id: 's-000002', engine: 'pi' }), db)).toBe(true)
  })

  it('updates only the columns a patch names', () => {
    insertDispatchTarget(row({ name: 'reviewer' }), db)
    updateDispatchTarget('s-000001', { state: 'interrupted', lastActiveAt: 500 }, db)
    expect(getDispatchTarget('s-000001', db)).toEqual(
      row({ state: 'interrupted', lastActiveAt: 500, name: 'reviewer' })
    )
    updateDispatchTarget('s-000001', { harnessRef: 'renamed', accountKey: null, name: null }, db)
    expect(getDispatchTarget('s-000001', db)).toMatchObject({
      harnessRef: 'renamed',
      accountKey: null,
      name: null,
      state: 'interrupted'
    })
  })

  it("lists a parent's targets newest first and moves them on a rekey", () => {
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a', createdAt: 1 }), db)
    insertDispatchTarget(row({ id: 's-000002', harnessRef: 'b', createdAt: 2 }), db)
    insertDispatchTarget(
      row({ id: 's-000003', harnessRef: 'c', parentSessionId: 'someone-else' }),
      db
    )
    expect(dispatchTargetsByParent('parent-1', db).map((r) => r.id)).toEqual([
      's-000002',
      's-000001'
    ])
    moveDispatchTargetParent('parent-1', 'durable-1', db)
    expect(dispatchTargetsByParent('parent-1', db)).toEqual([])
    expect(dispatchTargetsByParent('durable-1', db).map((r) => r.id)).toEqual([
      's-000002',
      's-000001'
    ])
    expect(dispatchTargetsByParent('someone-else', db)).toHaveLength(1)
  })

  it('the boot pass turns running rows into interrupted and touches nothing else', () => {
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a', state: 'running' }), db)
    insertDispatchTarget(row({ id: 's-000002', harnessRef: 'b', state: 'idle' }), db)
    insertDispatchTarget(row({ id: 's-000003', harnessRef: 'c', state: 'failed' }), db)
    insertDispatchTarget(row({ id: 's-000004', harnessRef: 'd', state: 'running' }), db)
    const ids = ['s-000001', 's-000002', 's-000003', 's-000004']
    expect(interruptDispatchTargets(ids, db)).toEqual(['s-000001', 's-000004'])
    expect(ids.map((id) => getDispatchTarget(id, db)?.state)).toEqual([
      'interrupted',
      'idle',
      'failed',
      'interrupted'
    ])
    expect(interruptDispatchTargets(ids, db)).toEqual([])
  })

  it('records the owner of a running row and clears it when the boot pass interrupts it', () => {
    const owner = { pid: 4242, boot: 'boot-a' }
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a' }), db, owner)
    insertDispatchTarget(row({ id: 's-000002', harnessRef: 'b' }), db) // no owner
    expect(runningDispatchTargets(db).map((r) => [r.id, r.owner])).toEqual([
      ['s-000001', owner],
      ['s-000002', null]
    ])
    // The row type stays what it was: the owner rides beside it.
    expect(getDispatchTarget('s-000001', db)).toEqual(row({ id: 's-000001', harnessRef: 'a' }))
    updateDispatchTarget('s-000001', { owner: { pid: 1, boot: 'boot-b' } }, db)
    expect(runningDispatchTargets(db)[0].owner).toEqual({ pid: 1, boot: 'boot-b' })
    updateDispatchTarget('s-000001', { lastActiveAt: 9 }, db) // an omitted owner keeps its value
    expect(runningDispatchTargets(db)[0].owner).toEqual({ pid: 1, boot: 'boot-b' })
    interruptDispatchTargets(['s-000001'], db)
    expect(runningDispatchTargets(db).map((r) => r.id)).toEqual(['s-000002'])
    const raw = db
      .prepare('SELECT owner_pid, owner_boot FROM dispatch_target WHERE id = ?')
      .get('s-000001')
    expect(raw).toEqual({ owner_pid: null, owner_boot: null })
  })

  it('stopped is final: a later state or owner write (a run ending in another instance) is ignored', () => {
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a', state: 'stopped' }), db)
    updateDispatchTarget('s-000001', { state: 'idle', lastActiveAt: 9 }, db)
    expect(getDispatchTarget('s-000001', db)).toMatchObject({ state: 'stopped', lastActiveAt: 9 })
    updateDispatchTarget('s-000001', { state: 'running', owner: { pid: 1, boot: 'b' } }, db)
    expect(getDispatchTarget('s-000001', db)?.state).toBe('stopped')
    expect(runningDispatchTargets(db)).toEqual([])
    const raw = db
      .prepare('SELECT owner_pid, owner_boot FROM dispatch_target WHERE id = ?')
      .get('s-000001')
    expect(raw).toEqual({ owner_pid: null, owner_boot: null })
  })

  it('lists every row not ended on purpose (the boot sweep’s candidates)', () => {
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a', state: 'running' }), db)
    insertDispatchTarget(
      row({ id: 's-000002', harnessRef: 'b', state: 'idle', parentSessionId: 'p2' }),
      db
    )
    insertDispatchTarget(
      row({ id: 's-000003', harnessRef: 'c', state: 'stopped', parentSessionId: 'p3' }),
      db
    )
    insertDispatchTarget(
      row({ id: 's-000004', harnessRef: 'd', state: 'interrupted', parentSessionId: 'p4' }),
      db
    )
    expect(dispatchTargetsNotStopped(db).map((r) => r.id)).toEqual([
      's-000001',
      's-000002',
      's-000004'
    ])
  })

  it('lists every harness session id', () => {
    insertDispatchTarget(row({ id: 's-000001', harnessRef: 'a' }), db)
    insertDispatchTarget(row({ id: 's-000002', harnessRef: 'b', engine: 'opencode' }), db)
    expect(allDispatchTargetHarnessRefs(db).sort()).toEqual(['a', 'b'])
  })
})

describe('the store and the hide predicate (singleton DB)', () => {
  // A process that boots after the one that wrote the rows: another pid and boot id.
  const OTHER_BOOT: InstanceOwner = { pid: process.pid + 1, boot: 'a-later-boot' }
  const input = (harnessRef: string): Parameters<typeof dispatchLedger.create>[0] => {
    const { id: _id, state: _state, createdAt: _c, lastActiveAt: _l, ...rest } = row()
    return { ...rest, harnessRef }
  }

  it('create() mints a ref id, writes a running row and registers the session ref', () => {
    const created = dispatchLedger.create(input('sess-a'))
    expect(isRef(created.id)).toBe(true)
    expect(created.state).toBe('running')
    expect(dispatchLedger.get(created.id)).toEqual(created)
    expect(dispatchLedger.getByHarnessRef('claude', 'sess-a')).toEqual(created)
    // B-4 resolves the X-Agent by this ref: it is a session_ref row too.
    expect(getSessionRef(created.id)).toMatchObject({
      ref: created.id,
      engine: 'claude',
      sessionId: 'sess-a',
      routingId: null
    })
  })

  it('refuses the same harness session twice', () => {
    dispatchLedger.create(input('sess-a'))
    expect(() => dispatchLedger.create(input('sess-a'))).toThrow('Could not record')
  })

  it('isDispatchTargetSession is true for a recorded session only — and from the moment create() returns', () => {
    // Warm the cache BEFORE the row exists: a stale cache is the bug this guards.
    expect(isDispatchTargetSession('sess-a')).toBe(false)
    dispatchLedger.create(input('sess-a'))
    expect(isDispatchTargetSession('sess-a')).toBe(true)
    expect(isDispatchTargetSession('sess-b')).toBe(false)
  })

  // Two instances can share one operational.db (a dev and a packaged build, the server
  // and the desktop): the row the OTHER one wrote is not in this process's cache.
  it('sees a row another instance wrote behind the cache — once the cache is older than the TTL', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      expect(isDispatchTargetSession('foreign-target')).toBe(false) // loads the cache
      // Written straight to the table: this process's store never saw it.
      insertDispatchTargetWithRef(row({ id: 's-0f0f0f', harnessRef: 'foreign-target' }))
      // A miss inside the TTL is trusted (it is the common case: every ordinary transcript)…
      vi.setSystemTime(Date.now() + DISPATCH_CACHE_TTL_MS - 1_000)
      expect(isDispatchTargetSession('foreign-target')).toBe(false)
      // …and re-read once the cache is older than that.
      vi.setSystemTime(Date.now() + 2_000)
      expect(isDispatchTargetSession('foreign-target')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads at most once per interval, however many misses', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      expect(isDispatchTargetSession('a')).toBe(false)
      vi.setSystemTime(Date.now() + DISPATCH_CACHE_TTL_MS + 1)
      expect(isDispatchTargetSession('a')).toBe(false) // reload #1, stamps the cache
      // A row written now is not seen until another interval passes.
      insertDispatchTargetWithRef(row({ id: 's-0a0a0a', harnessRef: 'later' }))
      expect(isDispatchTargetSession('later')).toBe(false)
      vi.setSystemTime(Date.now() + DISPATCH_CACHE_TTL_MS + 1)
      expect(isDispatchTargetSession('later')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a corrected harness id is hidden too', () => {
    const created = dispatchLedger.create(input('minted'))
    expect(isDispatchTargetSession('reported')).toBe(false)
    dispatchLedger.update(created.id, { harnessRef: 'reported' })
    expect(isDispatchTargetSession('reported')).toBe(true)
    expect(dispatchLedger.getByHarnessRef('claude', 'reported')?.id).toBe(created.id)
  })

  it('reads the ledger on first use, so rows from an earlier run are hidden', () => {
    dispatchLedger.create(input('sess-a'))
    resetDispatchTargetSessions() // a fresh process: nothing cached
    expect(isDispatchTargetSession('sess-a')).toBe(true)
  })

  it('the boot pass interrupts running rows through the store module', () => {
    const created = dispatchLedger.create(input('sess-a'))
    // The process that wrote the row is gone (the one booting now is another).
    expect(interruptStaleDispatchTargets(OTHER_BOOT, () => false)).toBe(1)
    expect(dispatchLedger.get(created.id)?.state).toBe('interrupted')
  })

  describe('which instance owns a running row (migration v39)', () => {
    const ownerOf = (id: string): InstanceOwner | null =>
      runningDispatchTargets().find((r) => r.id === id)?.owner ?? null

    it('create() and every update to running record this instance; any other state clears it', () => {
      const created = dispatchLedger.create(input('sess-a'))
      expect(ownerOf(created.id)).toEqual(currentInstanceOwner())
      dispatchLedger.update(created.id, { state: 'idle' })
      // `runningDispatchTargets` leaves out the idle row, so make it `running` again without
      // touching the owner (the db-level update): what it holds now is what the idle update left.
      updateDispatchTarget(created.id, { state: 'running' })
      expect(ownerOf(created.id)).toBeNull()
      // A resume or a continuation sets it running again: the owner follows.
      updateDispatchTarget(created.id, { owner: { pid: 1, boot: 'stale' } })
      dispatchLedger.update(created.id, { state: 'running' })
      expect(ownerOf(created.id)).toEqual(currentInstanceOwner())
      // An update that does not touch the state keeps the owner.
      dispatchLedger.update(created.id, { lastActiveAt: 5 })
      expect(ownerOf(created.id)).toEqual(currentInstanceOwner())
    })

    it('a second instance booting on the same DB leaves the first one running rows alone', () => {
      const parent = `parent-shared-${process.pid}`
      const mine = dispatchLedger.create({ ...input('sess-a'), parentSessionId: parent })
      // The second instance: another pid and boot id, while this process (the first) is alive.
      expect(interruptStaleDispatchTargets(OTHER_BOOT)).toBe(0)
      expect(dispatchLedger.get(mine.id)?.state).toBe('running')
      expect(ownerOf(mine.id)).toEqual(currentInstanceOwner())
      expect(heldInboxItems(parent)).toEqual([])
    })

    it('interrupts, and tells the parent of, a row whose owner is gone', () => {
      const parent = `parent-dead-${process.pid}`
      const dead = dispatchLedger.create({ ...input('sess-dead'), parentSessionId: parent })
      const alive = dispatchLedger.create({ ...input('sess-alive'), parentSessionId: parent })
      updateDispatchTarget(dead.id, { owner: { pid: 777_001, boot: 'crashed-boot' } })
      updateDispatchTarget(alive.id, { owner: { pid: 777_002, boot: 'sibling-boot' } })
      expect(interruptStaleDispatchTargets(OTHER_BOOT, (pid) => pid === 777_002)).toBe(1)
      expect(dispatchLedger.get(dead.id)?.state).toBe('interrupted')
      expect(dispatchLedger.get(alive.id)?.state).toBe('running')
      expect(heldInboxItems(parent)).toMatchObject([{ fromKey: `x-agent:${dead.id}` }])
    })

    it('a live pid that is this process under another boot id is a reused pid: the row is interrupted', () => {
      const reused = dispatchLedger.create(input('sess-reused'))
      updateDispatchTarget(reused.id, { owner: { pid: process.pid, boot: 'an-earlier-boot' } })
      expect(interruptStaleDispatchTargets()).toBe(1)
      expect(dispatchLedger.get(reused.id)?.state).toBe('interrupted')
    })

    it('tells the parent only of the rows this pass changed (another instance got there first)', () => {
      const parent = `parent-race-${process.pid}`
      const raced = dispatchLedger.create({ ...input('sess-raced'), parentSessionId: parent })
      updateDispatchTarget(raced.id, { owner: { pid: 777_003, boot: 'crashed-boot' } })
      // The liveness probe is where the other instance's boot pass lands: it interrupts the row (and
      // tells the parent itself) between this pass reading it and updating it.
      const other = (pid: number): boolean => {
        expect(pid).toBe(777_003)
        interruptDispatchTargets([raced.id])
        return false
      }
      expect(interruptStaleDispatchTargets(OTHER_BOOT, other)).toBe(0)
      expect(dispatchLedger.get(raced.id)?.state).toBe('interrupted')
      expect(heldInboxItems(parent)).toEqual([])
    })

    it('ownedByOtherLiveInstance: only a running row another instance, still alive, owns', () => {
      const mine = dispatchLedger.create(input('sess-mine'))
      expect(dispatchLedger.ownedByOtherLiveInstance(mine.id, () => true)).toBe(false)
      const theirs = dispatchLedger.create(input('sess-theirs'))
      updateDispatchTarget(theirs.id, { owner: { pid: 777_004, boot: 'sibling-boot' } })
      expect(dispatchLedger.ownedByOtherLiveInstance(theirs.id, (pid) => pid === 777_004)).toBe(
        true
      )
      expect(dispatchLedger.ownedByOtherLiveInstance(theirs.id, () => false)).toBe(false)
      // Our pid under another boot id is a reused pid, not a second instance.
      updateDispatchTarget(theirs.id, { owner: { pid: process.pid, boot: 'an-earlier-boot' } })
      expect(dispatchLedger.ownedByOtherLiveInstance(theirs.id, () => true)).toBe(false)
      updateDispatchTarget(theirs.id, { owner: { pid: 777_004, boot: 'sibling-boot' } })
      dispatchLedger.update(theirs.id, { state: 'idle' })
      expect(dispatchLedger.ownedByOtherLiveInstance(theirs.id, () => true)).toBe(false)
      expect(dispatchLedger.ownedByOtherLiveInstance('s-nothing', () => true)).toBe(false)
    })

    it('a Stop is not written over by a late turn state from another instance', () => {
      const created = dispatchLedger.create(input('sess-a'))
      dispatchLedger.update(created.id, { state: 'stopped' })
      dispatchLedger.update(created.id, { state: 'idle' })
      dispatchLedger.update(created.id, { state: 'running' })
      expect(dispatchLedger.get(created.id)?.state).toBe('stopped')
      expect(ownerOf(created.id)).toBeNull()
    })

    it('a row with no owner (written before v39) is interrupted, as before', () => {
      insertDispatchTarget(row({ id: 's-0b0b0b', harnessRef: 'legacy' }))
      expect(interruptStaleDispatchTargets(OTHER_BOOT, () => true)).toBe(1)
      expect(getDispatchTarget('s-0b0b0b')?.state).toBe('interrupted')
    })
  })

  it('the boot pass leaves the parent of each interrupted X-Agent a dispatch-result notice in its inbox (ADR-105 §3)', () => {
    const parent = `parent-boot-${process.pid}`
    const named = dispatchLedger.create({
      ...input('sess-named'),
      parentSessionId: parent,
      name: 'rev'
    })
    const unnamed = dispatchLedger.create({ ...input('sess-unnamed'), parentSessionId: parent })
    const done = dispatchLedger.create({ ...input('sess-idle'), parentSessionId: parent })
    dispatchLedger.update(done.id, { state: 'idle' })

    expect(interruptStaleDispatchTargets(OTHER_BOOT, () => false)).toBe(2)
    expect(heldInboxItems(parent)).toMatchObject([
      {
        origin: 'dispatch-result',
        fromKey: `x-agent:${named.id}`,
        fromTitle: 'rev',
        body: `X-Agent rev was interrupted when ClaudeUI quit; continue it by messaging it with session_message (session: "rev" or "${named.id}").`
      },
      {
        origin: 'dispatch-result',
        fromKey: `x-agent:${unnamed.id}`,
        fromTitle: unnamed.id,
        body: `X-Agent ${unnamed.id} was interrupted when ClaudeUI quit; continue it by messaging it with session_message (session: "${unnamed.id}").`
      }
    ])
    // Once: the rows are `interrupted` now, so a second pass finds nothing running.
    expect(interruptStaleDispatchTargets(OTHER_BOOT, () => false)).toBe(0)
    expect(heldInboxItems(parent)).toHaveLength(2)
  })

  it('spend() sums the dispatch rows of one harness session and counts unpriced turns', () => {
    const usage = (
      id: string,
      apiCostUsd: number | null,
      sessionId: string,
      billing: { billingType?: 'subscription' | 'free' | 'apiKey'; billed?: number | null } = {}
    ): void =>
      insertUsageEvent({
        id,
        ts: 1,
        engineId: 'claude',
        vendorId: 'anthropic',
        accountId: null,
        accountUuid: null,
        modelId: 'claude-opus-4-8',
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
        equivCostUsd: apiCostUsd,
        engineCostUsd: apiCostUsd,
        sessionId,
        messageId: id,
        source: 'live',
        accountKey: 'unknown',
        accountLabel: null,
        billingType: billing.billingType ?? 'subscription',
        origin: 'dispatch',
        parentRoutingId: 'parent-1',
        apiCostUsd,
        billedCostUsd: billing.billed ?? null
      })
    usage('m1', 0.25, 'sess-a')
    usage('m2', 0.5, 'sess-a')
    usage('m3', null, 'sess-a')
    usage('m4', 9, 'sess-other')
    expect(dispatchTargetSpend('sess-a')).toEqual({ costUsd: 0.75, unpricedTurns: 1 })
    expect(dispatchLedger.spend('sess-a')).toEqual({ costUsd: 0.75, unpricedTurns: 1 })
    // The measure is the API-equivalent figure the live maxCostUsd gate counts (ADR-071),
    // not the display cost: a free turn shows 0 and an API-key turn its (smaller) bill.
    usage('m5', 0.4, 'sess-b', { billingType: 'free' })
    usage('m6', 0.3, 'sess-b', { billingType: 'apiKey', billed: 0.1 })
    expect(dispatchTargetSpend('sess-b').costUsd).toBeCloseTo(0.7)
    expect(dispatchTargetSpend('nobody')).toEqual({ costUsd: 0, unpricedTurns: 0 })
  })
})

describe('insertDispatchTargetWithRef', () => {
  it('writes the target and its session ref together', () => {
    expect(insertDispatchTargetWithRef(row(), db)).toBe(true)
    expect(getDispatchTarget('s-000001', db)).toEqual(row())
    expect(getSessionRef('s-000001', db)).toMatchObject({
      engine: 'claude',
      sessionId: row().harnessRef
    })
  })

  it('leaves no orphan ref when the second insert is refused', () => {
    // The harness session is already a target (written without its ref row)…
    insertDispatchTarget(row({ id: 's-000001' }), db)
    // …so a second target for it is refused AFTER its ref insert would have succeeded.
    expect(insertDispatchTargetWithRef(row({ id: 's-000002' }), db)).toBe(false)
    expect(getSessionRef('s-000002', db)).toBeUndefined()
    expect(getDispatchTarget('s-000002', db)).toBeUndefined()
  })
})

describe('dispatchPiSessionDir', () => {
  it('lives under ~/.claude/ui/dispatch/pi/<ledger id>, outside ~/.pi', () => {
    expect(dispatchPiSessionDir('s-ab12cd', '/home/u').replace(/\\/g, '/')).toBe(
      '/home/u/.claude/ui/dispatch/pi/s-ab12cd'
    )
  })

  it('refuses anything that is not a ref before it reaches a path', () => {
    expect(() => dispatchPiSessionDir('../../etc')).toThrow('not a dispatch target id')
    expect(() => dispatchPiSessionDir('s-ab12cd/..')).toThrow('not a dispatch target id')
  })
})
