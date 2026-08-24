/**
 * @vitest-environment node
 *
 * The emission funnel's invariants — SyncCore phase 4a items 1/2/3/7.
 *
 * These are the properties the whole replication model rests on, so each test
 * names the invariant it pins:
 *
 *  2. one emission ⇒ exactly one ring append; the delivered seq IS the ring seq
 *  3. append → apply → deliver, in that order; seq order === apply order;
 *     reentrant emits are FIFO
 *  7. rekey: core-owned, and no event carrying the new routingId can precede the
 *     `session:status` that introduces it
 */

import { describe, it, expect, vi } from 'vitest'
import { SyncCore, type Delivery } from '../sync-core'
import type { ChatMessage, SessionStatus } from '../../../shared/types'

/** Delivery no longer selects targets (4c) — the class does. */
const ALL: Delivery = {}

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
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

/** Records every delivery in order, with the seq the funnel assigned. */
function recordingCore(options?: { onUnclassified?: (c: string) => void }): {
  core: SyncCore
  delivered: Array<{ seq: number; channel: string; args: unknown[]; cls: string }>
} {
  const core = new SyncCore(options)
  const delivered: Array<{ seq: number; channel: string; args: unknown[]; cls: string }> = []
  // The host adapter routes on `delivery.cls` (SyncCore phase 4c), so that is what
  // the funnel has to hand it — recorded here instead of a per-call target.
  core.setDelivery((seq, channel, args, delivery) =>
    delivered.push({ seq, channel, args, cls: delivery.cls })
  )
  return { core, delivered }
}

describe('SyncCore.emit — ring single-append (invariant 2)', () => {
  it('appends exactly once per emission and delivers THAT seq', () => {
    const { core, delivered } = recordingCore()
    core.emit('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], ALL)
    core.emit('session:message', ['rid', { id: 'm2', role: 'assistant', content: [] }], ALL)

    expect(core.currentSeq()).toBe(2)
    expect(delivered.map((d) => d.seq)).toEqual([1, 2])
    expect(core.getAfter(0)?.map((e) => e.seq)).toEqual([1, 2])
  })

  it('does NOT append a host-local channel, and reports seq 0 for it', () => {
    const { core, delivered } = recordingCore()
    core.emit('auth:state', [{ status: 'success' }])
    expect(core.currentSeq()).toBe(0)
    expect(delivered).toEqual([
      {
        seq: 0,
        channel: 'auth:state',
        args: [{ status: 'success' }],
        cls: 'host-local'
      }
    ])
  })
})

describe('SyncCore.emit — fail-closed classification (item 3)', () => {
  it('refuses an unclassified channel: no append, no apply, no delivery', () => {
    const onUnclassified = vi.fn()
    const { core, delivered } = recordingCore({ onUnclassified })

    core.emit('totally:new-channel', ['rid', {}], ALL)

    expect(onUnclassified).toHaveBeenCalledWith('totally:new-channel')
    expect(core.currentSeq()).toBe(0)
    expect(delivered).toEqual([])
  })

  it('a reducer throw does NOT break the emission it rode in on', () => {
    // Routing every send through the funnel is only safe if a malformed payload
    // degrades canonical state and nothing else — before the funnel such a payload
    // was a harmless no-op at the far end. Since 4b the degraded state is what a
    // reconnecting client gets, so the error is logged loudly rather than swallowed.
    const onApplyError = vi.fn()
    const core = new SyncCore({ onApplyError })
    const delivered: string[] = []
    core.setDelivery((_seq, channel) => delivered.push(channel))

    // A payload whose own accessor throws — the general shape of "the reducer
    // blew up on something an engine or an older cached client sent".
    const hostile = {
      id: 'm1',
      role: 'assistant',
      get content(): never {
        throw new Error('boom')
      }
    }

    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    core.emit('session:message', ['rid', hostile], ALL)
    core.emit('session:permission-mode', ['rid', 'plan'], ALL)

    expect(onApplyError).toHaveBeenCalledTimes(1)
    expect(onApplyError.mock.calls[0][0]).toBe('session:message')
    expect(delivered).toEqual(['session:created', 'session:message', 'session:permission-mode'])
    // Ring order is untouched, and the events after the bad one still apply.
    expect(core.currentSeq()).toBe(3)
    expect(core.getCanonicalState().sessions['rid'].permissionMode).toBe('plan')
  })

  it('classified-but-non-canonical channels ring and deliver without touching state', () => {
    const { core, delivered } = recordingCore()
    core.emit('session:error', ['rid', 'boom'], ALL)
    expect(core.currentSeq()).toBe(1)
    expect(delivered).toHaveLength(1)
    expect(core.getCanonicalState().sessions).toEqual({})
  })
})

describe('SyncCore.emit — pipeline order (invariant 3)', () => {
  it('applies to canonical BEFORE delivery', () => {
    const core = new SyncCore()
    const observed: Array<string | undefined> = []
    core.setDelivery(() => {
      // Delivery must see the state the event produced — that is what makes a
      // snapshot at seq N provably contain every event through N.
      observed.push(core.getCanonicalState().sessions['rid']?.permissionMode)
    })
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    core.emit('session:permission-mode', ['rid', 'plan'], ALL)
    expect(observed).toEqual(['default', 'plan'])
  })

  it('queues a reentrant emit FIFO so seq order === apply order', () => {
    const core = new SyncCore()
    const order: number[] = []
    let reentered = false
    core.setDelivery((seq, channel) => {
      order.push(seq)
      if (channel === 'session:created' && !reentered) {
        reentered = true
        // A service reacting inside a listener. Without the FIFO queue this
        // nested event would take seq 2 and be DELIVERED before seq 1's
        // delivery finished, so a catchup replay would not match live order.
        core.emit('session:permission-mode', ['rid', 'plan'], ALL)
      }
    })
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)

    expect(order).toEqual([1, 2])
    expect(core.getAfter(0)?.map((e) => e.channel)).toEqual([
      'session:created',
      'session:permission-mode'
    ])
  })

  it('drains a multi-deep reentrancy chain in issue order', () => {
    const core = new SyncCore()
    const channels: string[] = []
    let fired = 0
    core.setDelivery((_seq, channel) => {
      channels.push(channel)
      if (channel === 'session:created' && fired === 0) {
        fired++
        core.emit('session:permission-mode', ['rid', 'plan'], ALL)
        core.emit('session:result', ['rid', {}], ALL)
      }
    })
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    expect(channels).toEqual(['session:created', 'session:permission-mode', 'session:result'])
  })
})

describe('SyncCore.getSnapshot', () => {
  it('stamps the CURRENT seq (no under-claim needed — same tick as serialization)', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    core.emit('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], ALL)
    const snap = core.getSnapshot()
    expect(snap.seq).toBe(2)
    expect(snap.sessions['rid'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('serializes internal-only fields away (metering absent rather than null)', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    const snap = core.getSnapshot()
    expect('metering' in snap.sessions['rid']).toBe(true)
    expect(snap.sessions['rid'].metering).toBeUndefined()
    expect('seeded' in snap.sessions['rid']).toBe(false)
  })
})

describe('SyncCore.setAppState — query-shaped app state (phase 4b)', () => {
  it('lands in the snapshot without touching the ring', () => {
    // Not an event by design: `directories` is a listing clients FETCH, and the
    // boot seeds are files they used to read themselves. Appending them would put
    // payloads in the ring no reducer branch interprets — and would make the
    // ring's contents depend on how often a watcher fired.
    const { core, delivered } = recordingCore()
    core.setDirectories([{ path: '/repo', sessions: [] } as never])
    core.setAppState({
      settings: { theme: 'monokai' },
      recentSessionIds: ['rid'],
      autoModeDisabledBySettings: true
    })

    const snap = core.getSnapshot()
    expect(snap.directories).toEqual([{ path: '/repo', sessions: [] }])
    expect(snap.settings).toEqual({ theme: 'monokai' })
    expect(snap.recentSessionIds).toEqual(['rid'])
    expect(snap.autoModeDisabledBySettings).toBe(true)
    expect(core.currentSeq()).toBe(0)
    expect(delivered).toEqual([])
  })

  it('a later config event replaces a seeded value (events win over seeds)', () => {
    // The seed is a floor, not a lock: whichever save fires next is the truth,
    // and it must not have to fight the boot value.
    const { core } = recordingCore()
    core.setAppState({ recentSessionIds: ['stale'], customTitles: { a: 'old' } })
    core.emit(
      'config:sessions-changed',
      [{ recentSessions: ['fresh'], customTitles: { a: 'new' } }],
      ALL
    )
    const snap = core.getSnapshot()
    expect(snap.recentSessionIds).toEqual(['fresh'])
    expect(snap.customTitles).toEqual({ a: 'new' })
  })
})

describe('SyncCore — rekey ownership (invariant 7)', () => {
  it('notifies the host registry when a status introduces a new sessionId', () => {
    const { core } = recordingCore()
    const rekeys: Array<[string, string]> = []
    core.onRekey((oldId, newId) => rekeys.push([oldId, newId]))

    core.emit('session:created', ['temp-1', { cwd: '/x' }], ALL)
    core.emit('session:status', ['temp-1', status({ sessionId: 'uuid-9' })], ALL)

    expect(rekeys).toEqual([['temp-1', 'uuid-9']])
    expect(Object.keys(core.getCanonicalState().sessions)).toEqual(['uuid-9'])
  })

  it('the status event is appended BEFORE any event carrying the new routingId', () => {
    const { core, delivered } = recordingCore()
    core.onRekey(() => {
      // A registry that re-keys and immediately emits under the NEW id — the
      // realistic shape of a session whose next status/message follows at once.
      core.emit('session:permission-mode', ['uuid-9', 'plan'], ALL)
    })
    core.emit('session:created', ['temp-1', { cwd: '/x' }], ALL)
    core.emit('session:status', ['temp-1', status({ sessionId: 'uuid-9' })], ALL)

    const ring = core.getAfter(0) ?? []
    const statusIdx = ring.findIndex((e) => e.channel === 'session:status')
    const newIdIdx = ring.findIndex((e) => e.args[0] === 'uuid-9')
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(newIdIdx).toBeGreaterThan(statusIdx)
    // And delivery order matches ring order.
    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3])
  })

  it('duplicate rekeys converge on ONE application (N clients, one effect)', () => {
    const { core } = recordingCore()
    const rekeys: Array<[string, string]> = []
    core.onRekey((oldId, newId) => rekeys.push([oldId, newId]))

    core.emit('session:created', ['temp-1', { cwd: '/x' }], ALL)
    const s = status({ sessionId: 'uuid-9' })
    // The same status re-delivered (catchup overlap / a second engine tick).
    core.emit('session:status', ['temp-1', s], ALL)
    core.emit('session:status', ['temp-1', s], ALL)
    core.emit('session:status', ['uuid-9', s], ALL)

    expect(rekeys).toEqual([['temp-1', 'uuid-9']])
    expect(Object.keys(core.getCanonicalState().sessions)).toEqual(['uuid-9'])
  })

  it('does not rekey when the engine sessionId equals the routing id', () => {
    const { core } = recordingCore()
    const rekeys: unknown[] = []
    core.onRekey((o, n) => rekeys.push([o, n]))
    core.emit('session:created', ['uuid-9', { cwd: '/x' }], ALL)
    core.emit('session:status', ['uuid-9', status({ sessionId: 'uuid-9' })], ALL)
    expect(rekeys).toEqual([])
  })
})

describe('SyncCore.seedSession (item 5)', () => {
  it('seeds an empty transcript and marks the session seeded', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'uuid-1' }], ALL)
    expect(core.getCanonicalState().sessions['rid'].seeded).toBe(false)

    core.seedSession('rid', {
      cwd: '/x',
      messages: [{ id: 'h1', role: 'assistant', content: [], timestamp: 1 }]
    })
    const s = core.getCanonicalState().sessions['rid']
    expect(s.seeded).toBe(true)
    expect(s.messages.map((m) => m.id)).toEqual(['h1'])
  })

  it('never clobbers live events that arrived before the seed resolved', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'uuid-1' }], ALL)
    core.emit('session:message', ['rid', { id: 'live-1', role: 'assistant', content: [] }], ALL)

    core.seedSession('rid', {
      messages: [{ id: 'h1', role: 'assistant', content: [], timestamp: 1 }]
    })

    const s = core.getCanonicalState().sessions['rid']
    expect(s.messages.map((m) => m.id)).toEqual(['live-1'])
    expect(s.seeded).toBe(true)
  })

  it('a fresh (non-resumed) session is seeded by its own creation', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    expect(core.getCanonicalState().sessions['rid'].seeded).toBe(true)
  })

  it('survives an eviction + rehydrate cycle (item 5)', () => {
    // 4a mirrors the renderer's real policy: the renderer never REMOVES an entry,
    // it strips the heavy arrays and re-hydrates from disk on reselect. Canonical
    // therefore does not evict on a timer either; `removeSession` exists for
    // explicit removal, and a later resume re-seeds from the transcript. Both
    // halves must be lossless.
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'uuid-1' }], ALL)
    core.seedSession('rid', {
      messages: [{ id: 'h1', role: 'assistant', content: [], timestamp: 1 }]
    })
    core.emit('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], ALL)
    expect(core.getSnapshot().sessions['rid'].messages.map((m) => m.id)).toEqual(['h1', 'm1'])

    core.removeSession('rid')
    expect(core.getSnapshot().sessions['rid']).toBeUndefined()

    // Rehydrate: the session is reopened and seeded from disk again.
    core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'uuid-1' }], ALL)
    core.seedSession('rid', {
      messages: [
        { id: 'h1', role: 'assistant', content: [], timestamp: 1 },
        { id: 'm1', role: 'assistant', content: [], timestamp: 2 }
      ]
    })
    const after = core.getSnapshot().sessions['rid']
    expect(after.messages.map((m) => m.id)).toEqual(['h1', 'm1'])
    // And the stream keeps working on the rehydrated entry.
    core.emit('session:message', ['rid', { id: 'm2', role: 'assistant', content: [] }], ALL)
    expect(core.getSnapshot().sessions['rid'].messages.map((m) => m.id)).toEqual(['h1', 'm1', 'm2'])
  })

  it('removeSession drops the thinking-span bookkeeping too', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    core.emit('session:stream', ['rid', { type: 'thinking', text: 'hmm' }], ALL)
    core.removeSession('rid')
    // A recreated session must not inherit the removed one's open span, which
    // would silently blank its first streamingThinking.
    core.emit('session:created', ['rid', { cwd: '/x' }], ALL)
    core.emit('session:stream', ['rid', { type: 'thinking', text: 'fresh' }], ALL)
    core.emit('session:stream', ['rid', { type: 'text', text: 'answer' }], ALL)
    expect(core.getCanonicalState().sessions['rid'].streamingText).toBe('answer')
  })
})

/**
 * The REPLACE twin (phase 5 S4). `seedSession` fills only an empty transcript,
 * because the session it seeds is spawned and live events must win; a watched
 * session has no engine and its file only grows, so replacing is the only correct
 * behaviour — and a fill-only guard would freeze it at its first read.
 */
describe('SyncCore.seedWatchedSession (phase 5 S4)', () => {
  const message = (id: string): ChatMessage => ({
    id,
    role: 'assistant',
    content: [],
    timestamp: 1
  })

  it('bootstraps the entry with its cwd — a watched session has no birth event', () => {
    const { core, delivered } = recordingCore()
    core.seedWatchedSession('watched', { cwd: '/repo', messages: [message('w1')] })

    const s = core.getCanonicalState().sessions['watched']
    expect(s.cwd).toBe('/repo')
    expect(s.messages.map((m) => m.id)).toEqual(['w1'])
    expect(s.seeded).toBe(true)
    // Seeds are not events: nothing rings, nothing is delivered.
    expect(core.currentSeq()).toBe(0)
    expect(delivered).toEqual([])
  })

  it('REPLACES on every later read, where seedSession would have frozen it', () => {
    const { core } = recordingCore()
    core.seedWatchedSession('watched', { cwd: '/repo', messages: [message('w1')] })
    core.seedWatchedSession('watched', { cwd: '/repo', messages: [message('w1'), message('w2')] })
    expect(core.getCanonicalState().sessions['watched'].messages.map((m) => m.id)).toEqual([
      'w1',
      'w2'
    ])

    // The contrast, on the same state: the fill-only twin would have kept the
    // first read forever.
    core.seedSession('watched', { messages: [message('w1')] })
    expect(core.getCanonicalState().sessions['watched'].messages.map((m) => m.id)).toEqual([
      'w1',
      'w2'
    ])
  })

  it('re-derives todos and dismisses a completed list (no session:result exists)', () => {
    const { core } = recordingCore()
    const todoWrite = (status: 'pending' | 'completed'): ChatMessage => ({
      id: 'w1',
      role: 'assistant',
      timestamp: 1,
      content: [
        {
          type: 'tool_use',
          toolUseId: 't',
          toolName: 'TodoWrite',
          toolInput: { todos: [{ content: 'watched', status, activeForm: 'w' }] }
        }
      ]
    })

    core.seedWatchedSession('watched', {
      cwd: '/repo',
      messages: [todoWrite('pending')]
    })
    expect(core.getCanonicalState().sessions['watched'].todos.map((t) => t.content)).toEqual([
      'watched'
    ])

    core.seedWatchedSession('watched', {
      cwd: '/repo',
      messages: [todoWrite('completed')]
    })
    expect(core.getCanonicalState().sessions['watched'].todos).toEqual([])
  })

  it('an absent cwd leaves the established one alone (old 3-arg watch)', () => {
    const { core } = recordingCore()
    core.emit('session:created', ['watched', { cwd: '/repo' }], ALL)
    core.seedWatchedSession('watched', { messages: [message('w1')] })
    expect(core.getCanonicalState().sessions['watched'].cwd).toBe('/repo')
  })
})
