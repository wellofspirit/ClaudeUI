/**
 * @vitest-environment node
 *
 * **The phase-4 snapshot invariant** — SyncCore phase 4b's exit criterion.
 *
 *     restore(snapshot@N) + fold(events N+1 … head) === canonical@head
 *
 * That is the entire contract a reconnecting client rests on. `sync-full` hands
 * it a snapshot plus a watermark and it replays forward from there; if the two
 * halves did not compose exactly, a resync would produce a state no client that
 * stayed connected ever had — and nothing would say so, because both sides look
 * internally consistent.
 *
 * It is the STRUCTURAL replacement for the deleted `event-log.test.ts`. That test
 * pinned a workaround: the old snapshot came from an async renderer round-trip,
 * so the server deliberately UNDER-claimed the watermark and re-sent a few events
 * the snapshot already contained. `SyncCore.getSnapshot()` reads the seq and
 * serializes in one synchronous tick, so the claim is exact and the race the old
 * test guarded is unrepresentable. What replaces "does it under-claim correctly?"
 * is "does the exact claim compose?" — this file.
 *
 * Randomized, but SEEDED: every failure prints the seed that produced it, and
 * re-running with that seed replays the counterexample. The event pool is drawn
 * from the committed golden fixtures (the streams that actually broke the
 * as-built layer) plus the channels no fixture covers yet, so the interleavings
 * exercise real payload shapes rather than invented ones.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SyncCore, type Delivery } from '../sync-core'
import { applyEvent, checkDerivedFields } from '../../shared/sync/reducer'
import { isVolatileStream } from '../../shared/sync/channels'
import {
  applyItemStreamFrame,
  itemStreamKey,
  type ItemStreamFrame,
  type ItemStreamTarget
} from '../../shared/sync/item-stream'
import { fromSnapshot, type CanonicalState } from '../../shared/sync/state'
import type { FullStateSnapshot } from '../../../shared/remote-protocol'
import type { SessionStatus } from '../../../shared/types'

/** Delivery no longer selects targets (4c) — the class does. */
const ALL: Delivery = {}

interface PoolEvent {
  channel: string
  args: unknown[]
}

// ---------------------------------------------------------------------------
// The event pool
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'shared', 'sync', '__tests__', 'fixtures')

/** Every event in every committed golden fixture (messages, streams, status/rekey, queue, metering, tool results, results). */
function fixtureEvents(): PoolEvent[] {
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const events: PoolEvent[] = []
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8')) as {
      events: PoolEvent[]
    }
    events.push(...parsed.events)
  }
  return events
}

/**
 * Channels the fixtures do not carry yet, added so the interleavings cover the
 * whole canonical surface the spec names: config (both app-level flavors and the
 * per-session one), watch-update (the payload-heavy full re-read), approvals,
 * tasks, subagents, and the app-level catalogs.
 */
const EXTRA_EVENTS: PoolEvent[] = [
  // OLD-shape (pre-S4): the payload carried the transcript. Kept because the
  // committed fixtures and any ring caught up across the upgrade still contain
  // this shape, and the reducer still folds it.
  [
    'session:watch-update',
    {
      routingId: 'watched-1',
      messages: [
        {
          id: 'w1',
          role: 'assistant',
          content: [{ type: 'text', text: 'from disk' }],
          timestamp: 0
        }
      ],
      taskNotifications: [],
      statusLine: { model: 'sonnet', totalCostUsd: 0.4 }
    }
  ],
  // NEW-shape (S4): the notify production actually emits. Its only fold effect is
  // the bootstrap + cwd — the transcript is a seed — so the invariant has to hold
  // for an event that carries an address and nothing else.
  [
    'session:watch-update',
    { routingId: 'watched-2', sessionId: 'uuid-w2', projectKey: '-repo', cwd: '/repo/watched' }
  ],
  [
    'config:sessions-changed',
    {
      recentSessions: ['rid', 'uuid-9'],
      pinnedSessions: ['rid'],
      customTitles: { rid: 'The Session' },
      hiddenSessions: [],
      hiddenProjects: ['/old'],
      worktreeInfoMap: {}
    }
  ],
  ['config:settings-changed', { theme: 'monokai', expandToolCalls: false }],
  ['session:config-changed', 'rid', { model: 'opus', effort: 'high' }],
  ['session:config-changed', 'rid', { thinkingMode: 'enabled', reasoningVariant: null }],
  ['session:permission-mode', 'rid', 'plan'],
  [
    'session:approval-request',
    'rid',
    { requestId: 'req-1', toolUseId: 'tu-1', toolName: 'Bash', toolInput: {} }
  ],
  ['session:approval-dismiss', 'rid', { requestId: 'req-1' }],
  ['session:task-started', 'rid', { toolUseId: 'tu-task', taskId: 't-1', taskType: 'Task' }],
  [
    'session:task-progress',
    'rid',
    { toolUseId: 'tu-task', toolName: 'Task', parentToolUseId: null, elapsedTimeSeconds: 3 }
  ],
  ['session:task-notification', 'rid', { toolUseId: 'tu-task', message: 'done', taskId: 't-1' }],
  [
    'session:subagent-message',
    'rid',
    {
      toolUseId: 'tu-task',
      message: {
        id: 'sa-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'sub' }],
        timestamp: 0
      }
    }
  ],
  ['session:slash-commands', 'rid', [{ name: '/compact' }, { name: '/review' }]],
  ['session:skills', 'rid', ['dataviz', 'patch-readme']],
  // The 4b payload additions: an event-carried user identity and an
  // emitter-timed thinking span. Both must survive a snapshot + catchup fold
  // exactly like everything else.
  [
    'session:user-message',
    'rid',
    { id: 'msg-fixed-1', timestamp: 1_700_000_000_000, prompt: 'with identity' }
  ],
  [
    'session:message',
    'rid',
    {
      id: 'sealer-1',
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'weighing options' },
        { type: 'text', text: 'here you go' }
      ],
      timestamp: 0,
      thinkingDurationMs: 4200
    }
  ]
].map(([channel, ...args]) => ({ channel: channel as string, args }))

/**
 * The pool is the EVENT lane, and only the event lane.
 *
 * The invariant this file pins is `restore(snapshot@N) + fold(events N+1..head)
 * === canonical@head`, which is a statement about things that RING. Since phase 5
 * S1 the streaming deltas do not: they carry no seq, a catchup cannot replay
 * them, and their accumulation is healed by re-watching (`SyncCore.streamReplay`)
 * instead. Leaving them in the pool would not test the invariant — it would
 * assert that catchup reproduces something catchup deliberately no longer
 * carries. The stream lane's own version of the property is the mid-turn test
 * below.
 */
const POOL: PoolEvent[] = [...fixtureEvents(), ...EXTRA_EVENTS].filter(
  (e) => !isVolatileStream(e.channel)
)

/**
 * Every routing id the pool can address — created up-front so no sample is a no-op
 * on an unknown session. `watched-2` is DELIBERATELY absent: the S4 notify is the
 * one event whose branch still bootstraps, so leaving its id uncreated is what
 * puts that bootstrap inside the invariant.
 */
const POOL_ROUTING_IDS = ['rid', 'temp-1', 'uuid-9', 'watched-1', 'a']

function bootstrap(core: SyncCore): void {
  for (const id of POOL_ROUTING_IDS) {
    core.emit('session:created', [id, { cwd: '/repo' }], ALL)
  }
}

function runningStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'running',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    capabilities: undefined as never,
    account: null,
    ...overrides
  } as SessionStatus
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32 — 32-bit state, uniform enough, and reproducible)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted. The two states are built by different code paths
 * (`fromSnapshot` vs a chain of reducer spreads), so their key INSERTION order
 * differs while the values are identical — and plain `JSON.stringify` would call
 * that a difference. Arrays keep their order: there, order is meaning.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      )
    }
    return val
  })
}

/**
 * Canonical state as the wire sees it: `seeded` is core-internal bookkeeping the
 * snapshot cannot carry (a restored session is complete by definition), so it is
 * stripped from BOTH sides rather than asserted.
 */
function comparable(state: CanonicalState): string {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).map(([id, s]) => {
      const { seeded: _seeded, ...rest } = s
      return [id, rest]
    })
  )
  return stableJson({ ...state, sessions })
}

/**
 * The invariant itself. Folds the ring's tail onto a restored snapshot and
 * compares with live canonical at head.
 */
function expectFoldsToHead(core: SyncCore, snapshot: FullStateSnapshot, seed: number): void {
  const tail = core.getAfter(snapshot.seq)
  expect(tail, `seed ${seed}: catchup from seq ${snapshot.seq} fell out of the ring`).not.toBeNull()

  let folded = fromSnapshot(snapshot)
  for (const entry of tail!) {
    folded = applyEvent(folded, { channel: entry.channel, args: entry.args, seq: entry.seq })
  }

  const live = core.getCanonicalState()
  expect(
    comparable(folded),
    `seed ${seed}: snapshot@${snapshot.seq} + ${tail!.length} catchup event(s) ` +
      `did not fold to canonical@${core.currentSeq()}`
  ).toBe(comparable(live))
  // The derived-field tripwire must agree on both sides too: a restore that
  // silently dropped `todos`/`sentFiles` would still compare equal if the fold
  // happened to re-derive them, and this catches the reverse (a restore that
  // kept a value the transcript no longer supports).
  expect(stableJson(checkDerivedFields(folded)), `seed ${seed}: derived drift after restore`).toBe(
    stableJson(checkDerivedFields(live))
  )
}

/**
 * Emit a seeded interleaving, taking a snapshot at random points, and check the
 * invariant for EVERY snapshot taken. Returns how many were checked so a test
 * can prove it wasn't vacuous.
 */
function runInterleaving(seed: number, eventCount = 60): number {
  const rand = mulberry32(seed)
  const core = new SyncCore()
  bootstrap(core)

  const snapshots: FullStateSnapshot[] = []
  for (let i = 0; i < eventCount; i++) {
    const pick = POOL[Math.floor(rand() * POOL.length)]
    core.emit(pick.channel, pick.args, ALL)
    // ~1 in 4 events, capture a snapshot the way `sync-full` would.
    if (rand() < 0.25) snapshots.push(core.getSnapshot())
  }
  // Always include one taken at head — the "client connects right now" case.
  snapshots.push(core.getSnapshot())

  for (const snapshot of snapshots) expectFoldsToHead(core, snapshot, seed)
  return snapshots.length
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('snapshot invariant — restore(N) + fold(N+1..head) === canonical@head', () => {
  it('the pool is the one we think it is (non-vacuity)', () => {
    // A pool that silently lost the fixture events would still pass every
    // invariant check below — on an almost-empty state.
    const channels = new Set(POOL.map((e) => e.channel))
    expect(POOL.length).toBeGreaterThan(40)
    // `session:stream` is deliberately ABSENT — see the POOL note.
    expect(channels.has('session:stream')).toBe(false)
    for (const required of [
      'session:message',
      'session:status',
      'session:queue-changed',
      'session:user-message',
      'session:metering',
      'session:watch-update',
      'config:sessions-changed',
      'config:settings-changed'
    ]) {
      expect(channels.has(required), `pool is missing ${required}`).toBe(true)
    }
  })

  it('holds across 40 seeded interleavings', () => {
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) checked += runInterleaving(seed)
    // Every seed contributes at least the head snapshot, most contribute ~15.
    expect(checked).toBeGreaterThan(200)
  })

  it('hydrates an active item, folds reliable rekey suffixes, and heals a volatile gap by replay', () => {
    const core = new SyncCore()
    const frames: ItemStreamFrame[] = []
    core.setStreamDelivery((frame) => {
      if (frame.type === 'item-stream') frames.push(frame)
    })
    core.emit('session:created', ['temp-item', { cwd: '/repo' }], ALL)

    const target: ItemStreamTarget = {
      messageId: 'answer-1',
      blockIndex: 0,
      kind: 'text'
    }
    core.emit(
      'session:item-open',
      [
        'temp-item',
        {
          target,
          message: {
            id: target.messageId,
            role: 'assistant',
            timestamp: 1,
            content: [{ type: 'text', text: '' }]
          }
        }
      ],
      ALL
    )
    core.emit('session:item-delta', ['temp-item', { target, chunk: 'first' }], ALL)
    const snapshot = core.getSnapshot()

    // Hydration carries the reliable scaffold and the volatile value current at
    // its exact watermark.
    let replica = fromSnapshot(snapshot)
    expect(replica.sessions['temp-item'].itemStreams[itemStreamKey(target)]?.value).toBe('first')

    core.emit('session:item-delta', ['temp-item', { target, chunk: ' second' }], ALL)
    core.emit('session:permission-mode', ['temp-item', 'plan'], ALL)
    core.emit('session:item-delta', ['temp-item', { target, chunk: ' third' }], ALL)
    core.emit('session:status', ['temp-item', runningStatus({ sessionId: 'stable-item' })], ALL)
    core.emit('session:item-delta', ['stable-item', { target, chunk: ' fourth' }], ALL)
    core.emit('session:item-delta', ['stable-item', { target, chunk: ' fifth' }], ALL)

    // Catchup folds only the reliable suffix. The status moves the open stream
    // with the session, while volatile text remains at the hydrated prefix.
    const suffix = core.getAfter(snapshot.seq)
    expect(suffix).not.toBeNull()
    for (const entry of suffix!) {
      replica = applyEvent(replica, { channel: entry.channel, args: entry.args, seq: entry.seq })
    }
    expect(replica.sessions['temp-item']).toBeUndefined()
    expect(replica.sessions['stable-item'].permissionMode).toBe('plan')
    expect(replica.sessions['stable-item'].itemStreams[itemStreamKey(target)]?.value).toBe('first')

    // Simulate a dropped append by offering the later frame first. Offset
    // validation refuses the suffix instead of corrupting the hydrated prefix.
    const later = frames.find((frame) => frame.op === 'append' && frame.chunk === ' fifth')
    expect(later).toBeDefined()
    const gap = applyItemStreamFrame(replica, later!)
    expect(gap.result).toBe('mismatch')
    expect(gap.state).toBe(replica)

    // Re-watch answers atomically at the reliable watermark and closes both the
    // dropped suffix and the routing-id move.
    const replay = core.itemStreamReplay('stable-item')
    expect(replay.op).toBe('replace')
    const healed = applyItemStreamFrame(replica, replay)
    expect(healed.result).toBe('applied')
    expect(comparable(healed.state)).toBe(comparable(core.getCanonicalState()))
    expect(healed.state.sessions['stable-item'].itemStreams[itemStreamKey(target)]?.value).toBe(
      'first second third fourth fifth'
    )
  })

  it('holds for a snapshot taken mid-reentrancy-drain (snapshots land between applies)', () => {
    // `emit` queues a nested emission FIFO and processes it after the current
    // event completes, so a snapshot taken from inside a delivery callback sees a
    // state with the outer event applied and the inner one not yet appended.
    const core = new SyncCore()
    const taken: FullStateSnapshot[] = []
    let reentered = false
    core.setDelivery((_seq, channel) => {
      if (channel === 'session:message' && !reentered) {
        reentered = true
        core.emit('session:permission-mode', ['rid', 'plan'], ALL)
        core.emit('session:result', ['rid', {}], ALL)
      }
      taken.push(core.getSnapshot())
    })
    core.emit('session:created', ['rid', { cwd: '/repo' }], ALL)
    core.emit(
      'session:message',
      [
        'rid',
        { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
      ],
      ALL
    )

    expect(reentered).toBe(true)
    expect(taken.length).toBe(4)
    for (const snapshot of taken) expectFoldsToHead(core, snapshot, 0)
    // The snapshot taken during the drain must NOT already contain the nested
    // event's effect (that would mean apply order outran append order).
    expect(taken[1].sessions['rid'].permissionMode).toBe('default')
    expect(core.getSnapshot().sessions['rid'].permissionMode).toBe('plan')
  })

  it('the ring-eviction edge is a complete sync-full, not a partial catchup', () => {
    // A client too far behind gets `getAfter() === null`, which is exactly when
    // the server answers sync-full instead of a catchup (remote-server.handleSync).
    // The property that has to hold there is that the head snapshot ALONE restores
    // to canonical — no catchup to lean on.
    const core = new SyncCore({ capacity: 4 })
    bootstrap(core)
    const stale = core.getSnapshot()
    const rand = mulberry32(7)
    for (let i = 0; i < 30; i++) {
      const pick = POOL[Math.floor(rand() * POOL.length)]
      core.emit(pick.channel, pick.args, ALL)
    }

    expect(core.getAfter(stale.seq)).toBeNull()
    const head = core.getSnapshot()
    expect(core.getAfter(head.seq)).toEqual([])
    expect(comparable(fromSnapshot(head))).toBe(comparable(core.getCanonicalState()))
  })

  it('getSnapshot claims the CURRENT seq exactly — no under-claim, no over-claim', () => {
    // The deleted event-log test's real subject, restated as a property of the
    // synchronous path: an exact claim means the catchup from it is empty, and a
    // client that starts its cursor there has missed nothing.
    const core = new SyncCore()
    bootstrap(core)
    core.emit('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], ALL)
    const snapshot = core.getSnapshot()
    expect(snapshot.seq).toBe(core.currentSeq())
    expect(core.getAfter(snapshot.seq)).toEqual([])
    expect(snapshot.sessions['rid'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('a counterexample would be CAUGHT (guard against a vacuous invariant)', () => {
    const core = new SyncCore()
    bootstrap(core)
    core.emit('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], ALL)
    const snapshot = core.getSnapshot()
    core.emit('session:permission-mode', ['rid', 'plan'], ALL)
    // Hand the checker a snapshot whose watermark over-claims by one: the seal
    // event is then excluded from the catchup, which is precisely the permanent
    // skip the old watermark race caused.
    expect(() => expectFoldsToHead(core, { ...snapshot, seq: snapshot.seq + 1 }, 0)).toThrow()
  })
})
