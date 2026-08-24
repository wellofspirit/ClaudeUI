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
import { applyEvent, auxFromCanonical, checkDerivedFields } from '../../shared/sync/reducer'
import { isVolatileStream } from '../../shared/sync/channels'
import { applyStreamFrame } from '../../shared/sync/stream'
import { fromSnapshot, type CanonicalState } from '../../shared/sync/state'
import type { FullStateSnapshot } from '../../../shared/remote-protocol'

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
  ['session:subagent-stream', 'rid', { toolUseId: 'tu-task', type: 'thinking', text: 'hmm' }],
  ['session:subagent-stream', 'rid', { toolUseId: 'tu-task', type: 'text', text: 'ok' }],
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
  ['session:stream', 'rid', { type: 'thinking', text: 'weighing options' }],
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

/** The client's restore path: snapshot → canonical + the aux it must resume from. */
function restore(snapshot: FullStateSnapshot): {
  state: CanonicalState
  aux: ReturnType<typeof auxFromCanonical>
} {
  const state = fromSnapshot(snapshot)
  return { state, aux: auxFromCanonical(state) }
}

/**
 * The invariant itself. Folds the ring's tail onto a restored snapshot and
 * compares with live canonical at head.
 */
function expectFoldsToHead(core: SyncCore, snapshot: FullStateSnapshot, seed: number): void {
  const tail = core.getAfter(snapshot.seq)
  expect(tail, `seed ${seed}: catchup from seq ${snapshot.seq} fell out of the ring`).not.toBeNull()

  const { state, aux } = restore(snapshot)
  let folded = state
  for (const entry of tail!) {
    folded = applyEvent(folded, { channel: entry.channel, args: entry.args, seq: entry.seq }, aux)
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

  it('holds for a stream that ends mid-turn (snapshot with open streaming buffers)', () => {
    const core = new SyncCore()
    core.emit('session:created', ['rid', { cwd: '/repo' }], ALL)
    core.emit('session:stream', ['rid', { type: 'thinking', text: 'still going' }], ALL)
    const snapshot = core.getSnapshot()
    // The seal arrives AFTER the snapshot: the restored state must recognise the
    // open span from `streamingThinking` alone (auxFromCanonical), or the fold
    // leaves stale thinking text behind and diverges.
    core.emit('session:stream', ['rid', { type: 'text', text: 'answer' }], ALL)
    core.emit(
      'session:message',
      [
        'rid',
        {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'still going' },
            { type: 'text', text: 'answer' }
          ],
          timestamp: 0,
          thinkingDurationMs: 900
        }
      ],
      ALL
    )
    expectFoldsToHead(core, snapshot, 0)
    // Non-vacuity: the fold really did clear the buffer and stamp the duration.
    const live = core.getCanonicalState().sessions['rid']
    expect(live.streamingThinking).toBe('')
    const block = live.messages[0].content.find((b) => b.type === 'thinking')
    expect(block?.type === 'thinking' ? block.durationMs : null).toBe(900)
  })

  it('the STREAM lane heals by replay, not by catchup (phase 5 S1)', () => {
    // The volatile lane's version of the same invariant, and the reason the pool
    // excludes those channels: a snapshot plus the ring's tail cannot reproduce
    // deltas that never entered the ring. `stream:watch`'s replay is what closes
    // the gap, and it must close it EXACTLY — the replica ends holding canonical's
    // accumulation, not an approximation of it.
    const core = new SyncCore()
    core.emit('session:created', ['rid', { cwd: '/repo' }], ALL)
    core.emit('session:stream', ['rid', { type: 'thinking', text: 'weighing ' }], ALL)
    const snapshot = core.getSnapshot()

    // Everything after the snapshot rides the stream lane and therefore reaches a
    // reconnecting client through NOTHING the ring carries.
    core.emit('session:stream', ['rid', { type: 'thinking', text: 'the options' }], ALL)
    core.emit('session:stream', ['rid', { type: 'text', text: 'here you go' }], ALL)
    core.emit(
      'session:subagent-stream',
      ['rid', { toolUseId: 'tu-1', type: 'text', text: 'sub' }],
      ALL
    )

    const { state: restored, aux } = restore(snapshot)
    // Catchup alone leaves it at the snapshot's value — stated, not assumed.
    expect(restored.sessions['rid'].streamingThinking).toBe('weighing ')
    expect(restored.sessions['rid'].streamingText).toBe('')

    // Give the replica text of its own before healing. Without this the thinking
    // buffer is cleared by the SEAL that the text frame's append path performs,
    // so the test would pass whether or not the replay can state an EMPTY stream
    // — which is exactly the hole the empty-frame rule closes.
    const diverged: CanonicalState = {
      ...restored,
      sessions: {
        ...restored.sessions,
        rid: { ...restored.sessions['rid'], streamingText: 'stale partial' }
      }
    }

    let healed = diverged
    for (const frame of core.streamReplay('rid')) {
      const outcome = applyStreamFrame(healed, aux, frame)
      expect(outcome.result, `replay frame ${frame.streamId} was refused`).toBe('applied')
      healed = outcome.state
    }

    const live = core.getCanonicalState().sessions['rid']
    const after = healed.sessions['rid']
    expect(after.streamingThinking).toBe(live.streamingThinking)
    expect(after.streamingText).toBe(live.streamingText)
    expect(after.subagentStreamingText).toEqual(live.subagentStreamingText)
    // Non-vacuity: the live state really is mid-turn with both buffers occupied.
    expect(live.streamingText).toBe('here you go')
    expect(live.streamingThinking).toBe('')
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
