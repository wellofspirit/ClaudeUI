/**
 * Layer 3: E2E - SyncCore phase 4c hydration parity.
 *
 * ONE event stream, ONE interpretation. Until 4c this file compared the main
 * process's fold (`emitEvent` -> ring -> `applyEvent` -> canonical) against the
 * renderer's own ~40 handlers, and the SHADOW COMPARATOR (`main/sync/shadow.ts`)
 * existed to measure the gap between two implementations of one contract. The
 * renderer folds the same reducer now, so there is no second implementation left
 * to diff -- the comparator, `CLIENT_WRITTEN_FIELDS` and `__getRemoteState` are all
 * deleted, and what this file asserts instead is the property that actually
 * matters after the cutover:
 *
 *   a client that CRASHES and re-hydrates from `core.getSnapshot()` holds exactly
 *   the state a client that watched the whole stream holds.
 *
 * That is the client-side half of the phase-4 snapshot invariant (its server-side
 * half lives in `main/sync/__tests__/snapshot-invariant.unit.test.ts`), and it is
 * checked here through the REAL chain: `emitEvent` -> funnel -> subscriber -> the
 * renderer's `SyncClient` -> the replica's tap -> the store.
 *
 * The non-vacuity checks are kept deliberately: the 4b bug this file caught was a
 * snapshot field (`metering`) that nothing read back on hydration, and a test that
 * compares two empty objects would have passed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import { getReplicaState, hydrateReplica } from '@renderer/stores/replica'
import { syncCore, emitEvent, addSyncSubscriber } from '../../core/services/sync-host'
import { rekeyShim } from '../../core/ipc/handlers-core'
import { toSnapshot, type CanonicalState } from '../../core/shared/sync/state'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import type { ChatMessage, SessionStatus, QueuedItem } from '../../shared/types'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

let app: TestApp
/** Unsubscribes the renderer replica from the funnel's fan-out. */
let unsubscribeSync: (() => void) | null = null

/**
 * App-level fields the replica legitimately holds a different value for.
 *
 * `activeSessionId` is per-client VIEW state (ADR-041) - core serves `null` on
 * purpose and the client resolves its own. The registry-config fields are
 * client-ORIGINATED: `createNewSession` applies them to the replica and persists
 * through `config:save-sessions`, whose echo reaches every client - but in this
 * harness that echo is injected straight into the renderer's `SyncClient` rather
 * than through `syncCore`, so canonical never sees it. In production it does (the
 * desktop save path emits through the funnel, `handlers-core.saveSessions`), which
 * is why these are masked here and NOT a recorded product gap. `directories` is a
 * query result core refreshes out-of-band (`SyncCore.setDirectories`).
 */
const VIEW_OR_CLIENT_ORIGINATED = new Set<string>([
  'activeSessionId',
  'recentSessionIds',
  'pinnedSessionIds',
  'customTitles',
  'sessionEngines',
  'hiddenSessions',
  'hiddenProjects',
  'worktreeInfoMap',
  'directories',
  'settings',
  'autoModeDisabledBySettings'
])

/**
 * Diff canonical state against the replica's, field by field.
 *
 * Deep JSON equality over the WHOLE `CanonicalState`, with no normalization: the
 * retired comparator had to strip thinking-block durations and user-message
 * identity because the renderer minted its own, and it no longer does.
 */
function parityDiff(): string[] {
  const canonical = syncCore.getCanonicalState()
  const replica = getReplicaState()
  const diffs: string[] = []

  const appKeys = new Set([...Object.keys(canonical), ...Object.keys(replica)])
  for (const key of appKeys) {
    if (key === 'sessions' || VIEW_OR_CLIENT_ORIGINATED.has(key)) continue
    const k = key as keyof CanonicalState
    if (!jsonEq(canonical[k], replica[k])) diffs.push(key)
  }

  const ids = new Set([...Object.keys(canonical.sessions), ...Object.keys(replica.sessions)])
  for (const id of ids) {
    const c = canonical.sessions[id]
    const r = replica.sessions[id]
    if (!c || !r) {
      diffs.push(`${id}: ${c ? 'missing-in-replica' : 'missing-in-canonical'}`)
      continue
    }
    // The renderer strips a cold session's transcript to bound its heap; canonical
    // deliberately does not evict (docs/architecture/sync-channels.md §Eviction).
    // A cache decision, not drift - a reselect re-hydrates it from disk.
    if (r.messages.length === 0 && c.messages.length > 0) continue
    for (const key of Object.keys(c)) {
      // `seeded` is core-internal and not on the wire; the catalogs live app-level
      // on both sides and are compared above.
      if (key === 'seeded' || key === 'slashCommands' || key === 'sdkSkillNames') continue
      const k = key as keyof typeof c
      if (!jsonEq(c[k], r[k])) diffs.push(`${id}.${key}`)
    }
  }
  return diffs
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function expectParity(): void {
  const diffs = parityDiff()
  expect(diffs, `canonical/replica divergence: ${diffs.join(', ')}`).toEqual([])
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'running',
    sessionId: null,
    model: 'sonnet',
    cwd: '/project',
    totalCostUsd: 0,
    engineId: 'claude',
    account: null,
    ...overrides
  } as SessionStatus
}

beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    sessionEngines: {},
    slashCommands: [],
    sdkSkillNames: [],
    // The replica derives this from the snapshot's settings (ADR-050),
    // and `createNewSession` seeds a new session's mode from it — so a test that
    // hydrates a snapshot would otherwise change the NEXT test's baseline mode.
    defaultPermissionMode: 'default'
  })
  mirrorStoreIntoReplica()
  syncCore.resetCanonicalForTests()
  // The renderer replica registers as a SUBSCRIBER (SyncCore phase 4c), so
  // `emitEvent` drives the SAME chain production uses — funnel → ring + canonical
  // → every subscriber → the renderer's SyncClient — carrying the RING's own seq.
  // That is what makes this an end-to-end parity check rather than two hand-fed
  // state machines, and it is now literally the desktop's production path.
  unsubscribeSync = addSyncSubscriber((seq, channel, args) => {
    app.syncClient.receiveEvent({ seq, channel, args })
  })
})

afterEach(() => {
  unsubscribeSync?.()
  unsubscribeSync = null
  app.teardown()
})

describe('E2E: SyncCore hydration parity', () => {
  it('a full turn (stream → tools → todos → result) folds identically on both sides', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })])
    emitEvent('session:user-message', ['rid-1', { prompt: 'plan the work' }])
    emitEvent('session:stream', ['rid-1', { type: 'thinking', text: 'thinking...' }])
    emitEvent('session:stream', ['rid-1', { type: 'text', text: 'On it. ' }])
    emitEvent('session:message', [
      'rid-1',
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          {
            type: 'tool_use',
            toolUseId: 't-todo',
            toolName: 'TodoWrite',
            toolInput: {
              todos: [
                { content: 'step one', status: 'in_progress', activeForm: 'Doing one' },
                { content: 'step two', status: 'pending', activeForm: 'Doing two' }
              ]
            }
          }
        ],
        timestamp: 0
      } satisfies ChatMessage
    ])
    emitEvent('session:tool-result', [
      'rid-1',
      { toolUseId: 't-todo', result: 'ok', isError: false }
    ])
    emitEvent('session:status-line', ['rid-1', { model: 'sonnet', totalCostUsd: 0.12 } as never])
    emitEvent('session:metering', [
      'rid-1',
      {
        engineId: 'claude',
        vendorId: 'anthropic',
        billingType: 'subscription',
        tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0, total: 15 },
        equivalentCostUsd: 0.12,
        contextWindow: { used: 15, size: 200000 }
      } as never
    ])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])
    emitEvent('session:result', ['rid-1', {}])

    // Sanity: the stream really did land on both sides (a parity check between
    // two empty states would pass vacuously).
    expect(syncCore.getSnapshot().sessions['rid-1'].todos).toHaveLength(2)
    expect(useSessionStore.getState().sessions['rid-1'].todos).toHaveLength(2)
    expectParity()
  })

  it('metering survives into the snapshot on BOTH sides (item 8)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    const metering = {
      engineId: 'claude',
      vendorId: 'anthropic',
      billingType: 'subscription',
      tokens: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0, total: 3 },
      equivalentCostUsd: 0.01,
      contextWindow: { used: 3, size: 200000 }
    }
    emitEvent('session:metering', ['rid-1', metering as never])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])

    expect(syncCore.getSnapshot().sessions['rid-1'].metering).toEqual(metering)
    expect(toSnapshot(getReplicaState(), syncCore.currentSeq()).sessions['rid-1'].metering).toEqual(
      metering
    )
    expectParity()
  })

  it('a mid-stream rekey with duplicate client rekey invokes stays in parity', async () => {
    // Core owns the rekey (item 7), and as of 4c NO client invokes `session:rekey`
    // any more - the handler survives only as a shim for cached phone bundles. It
    // still has to absorb N duplicates as no-ops: the registry it consults has
    // already been re-keyed by core in the same tick as the append, which is why
    // `get(oldId)` misses.
    const shimResults: Array<{ ok: true; applied: boolean }> = []

    emitEvent('session:created', ['temp-1', { cwd: '/project' }])
    emitEvent('session:stream', ['temp-1', { type: 'text', text: 'Partial ' }])

    emitEvent('session:status', ['temp-1', makeStatus({ sessionId: 'sdk-9' })])
    // The CLIENT no longer invokes `session:rekey` at all (4c) - core owns the
    // move. The shim stays reachable for cached phone bundles, so drive it
    // directly, twice, to prove the duplicate is a no-op.
    shimResults.push(rekeyShim({ get: () => undefined } as never, 'temp-1', 'sdk-9'))
    shimResults.push(rekeyShim({ get: () => undefined } as never, 'temp-1', 'sdk-9'))
    // Two invokes, ZERO extra applications — the duplicates are absorbed.
    expect(shimResults).toEqual([
      { ok: true, applied: false },
      { ok: true, applied: false }
    ])

    emitEvent('session:stream', ['sdk-9', { type: 'text', text: 'and done.' }])
    emitEvent('session:message', [
      'sdk-9',
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial and done.' }],
        timestamp: 0
      } satisfies ChatMessage
    ])
    emitEvent('session:status', ['sdk-9', makeStatus({ state: 'idle', sessionId: 'sdk-9' })])

    expect(Object.keys(syncCore.getSnapshot().sessions)).toEqual(['sdk-9'])
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual(['sdk-9'])
    expectParity()
  })

  it('a queue take-back race lands the same transcript on both sides', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })])
    const items = (states: Array<QueuedItem['state']>): QueuedItem[] =>
      states.map((state, i) => ({ itemId: `i${i + 1}`, text: `queued ${i + 1}`, state }))

    emitEvent('session:queue-changed', ['rid-1', { items: items(['queued', 'queued']) }])
    emitEvent('session:queue-changed', ['rid-1', { items: items(['consumed', 'queued']) }])
    emitEvent('session:queue-changed', ['rid-1', { items: items(['consumed', 'recalled']) }])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])

    expect(syncCore.getSnapshot().sessions['rid-1'].queue).toEqual([])
    expect(syncCore.getSnapshot().sessions['rid-1'].messages.map((m) => m.id)).toContain('steer-i1')
    expectParity()
  })

  it('an eviction + rehydrate cycle is masked, then clean again once warm', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:message', [
      'rid-1',
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
    ])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])
    expectParity()

    // Renderer-side eviction: the lightweight entry stays, the transcript is
    // stripped and re-hydrated on reselect. Canonical keeps the transcript, and
    // that asymmetry must read as "evicted", not as drift.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'rid-1': { ...s.sessions['rid-1'], evicted: true, isHistorical: true, messages: [] }
      }
    }))
    mirrorStoreIntoReplica()
    expectParity()

    // Rehydrate from disk (what loadHistoricalSession does) → strictly compared again.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'rid-1': {
          ...s.sessions['rid-1'],
          evicted: false,
          messages: [
            { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
          ]
        }
      }
    }))
    mirrorStoreIntoReplica()
    expectParity()
  })

  it('per-session config changes replicate to the renderer picker state (item 6)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:config-changed', ['rid-1', { model: 'opus', effort: 'high' }])
    emitEvent('session:config-changed', ['rid-1', { thinkingMode: 'enabled' }])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])

    const rendered = useSessionStore.getState().sessions['rid-1']
    expect(rendered.selectedModel).toBe('opus')
    expect(rendered.effort).toBe('high')
    expect(rendered.thinkingMode).toBe('enabled')
    expectParity()
  })

  // -------------------------------------------------------------------------
  // Phase 4b — the cutover proof: "a phone reconnecting sees the truth"
  // -------------------------------------------------------------------------

  it('a FRESH store hydrated from core.getSnapshot() matches the live renderer store', () => {
    // This is the cutover itself, end to end. The web client's only hydration
    // path is `hydrateReplica(sync-full.state)`, and `sync-full.state` is now
    // `core.getSnapshot()`. So: drive a full turn, then throw the store away and
    // rebuild it from canonical alone — the way a phone that reconnects does —
    // and require the rebuild to match what the client that stayed connected has.
    // Before 4b this comparison was circular (the snapshot WAS the renderer's
    // store); now it has content.
    const DIRECTORIES = [{ path: '/project', name: 'project', sessions: [] }]
    // Both sides learn the sidebar listing from the same query; canonical holds
    // it because `sync-full` carries it (SyncCore.setDirectories, phase 4b A3).
    syncCore.setDirectories(DIRECTORIES as never)
    useSessionStore.setState({ directories: DIRECTORIES as never })
    mirrorStoreIntoReplica()

    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })])
    emitEvent(
      'session:user-message',
      // Identity now rides the event (phase 4b A1) — the renderer still mints its
      // own until 4c, which is why the comparator masks user ids.
      ['rid-1', { id: 'msg-e2e-1', timestamp: 1_700_000_000_000, prompt: 'ship it' }]
    )
    emitEvent('session:stream', ['rid-1', { type: 'thinking', text: 'planning' }])
    emitEvent('session:stream', ['rid-1', { type: 'text', text: 'On it. ' }])
    emitEvent('session:message', [
      'rid-1',
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'planning' },
          { type: 'text', text: 'On it.' },
          {
            type: 'tool_use',
            toolUseId: 't-todo',
            toolName: 'TodoWrite',
            toolInput: {
              todos: [{ content: 'step one', status: 'in_progress', activeForm: 'Doing one' }]
            }
          },
          {
            type: 'tool_use',
            toolUseId: 't-file',
            toolName: 'SendUserFile',
            toolInput: { files: ['out/report.md'], caption: 'the report', display: 'attach' }
          }
        ],
        timestamp: 0,
        // The emitter's thinking-span timing (phase 4b A2).
        thinkingDurationMs: 1234
      }
    ])
    emitEvent('session:tool-result', [
      'rid-1',
      { toolUseId: 't-todo', result: 'ok', isError: false }
    ])
    emitEvent('session:tool-result', [
      'rid-1',
      { toolUseId: 't-file', result: 'delivered', isError: false }
    ])
    emitEvent('session:config-changed', ['rid-1', { model: 'opus', effort: 'high' }])
    emitEvent('session:permission-mode', ['rid-1', 'acceptEdits'])
    emitEvent('session:status-line', ['rid-1', { model: 'opus', totalCostUsd: 0.31 } as never])
    emitEvent('session:metering', [
      'rid-1',
      {
        engineId: 'claude',
        vendorId: 'anthropic',
        billingType: 'subscription',
        tokens: { input: 20, output: 9, cacheWrite: 0, cacheRead: 0, total: 29 },
        equivalentCostUsd: 0.31,
        contextWindow: { used: 29, size: 200000 }
      } as never
    ])
    emitEvent('session:queue-changed', [
      'rid-1',
      { items: [{ itemId: 'q1', text: 'and then deploy', state: 'queued' }] }
    ])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])
    // Registry config: emitted last so both replicas end on the same value (the
    // renderer also writes recents locally on a user message — 4c's problem).
    emitEvent('config:sessions-changed', [
      { recentSessions: ['rid-1'], pinnedSessions: [], customTitles: { 'rid-1': 'Shipping' } }
    ])
    expectParity()

    const live = toSnapshot(getReplicaState(), syncCore.currentSeq())
    const canonical = syncCore.getSnapshot()

    // Throw the replica away and rebuild it from the snapshot alone.
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
      worktreeInfoMap: {},
      sessionEngines: {},
      hiddenSessionIds: [],
      hiddenProjectKeys: []
    })
    mirrorStoreIntoReplica()
    hydrateReplica(canonical, false)
    const hydrated = toSnapshot(getReplicaState(), syncCore.currentSeq())

    // Whole-snapshot equality, not a masked field walk. Two exceptions, both
    // genuinely per-client:
    //  - `activeSessionId` - selection (ADR-041); core serves null and the client
    //    picks its own landing session from recents, so the fresh replica resolves
    //    it independently.
    //  - `sessionEngines` - `createNewSession` writes it LOCALLY on the client that
    //    spawned the session, reaching core through a `config:sessions-changed`
    //    save the harness routes around (see VIEW_OR_CLIENT_ORIGINATED).
    const strip = (snap: FullStateSnapshot): unknown => {
      const { activeSessionId: _sel, sessionEngines: _eng, seq: _seq, ...rest } = snap
      return rest
    }
    expect(strip(hydrated)).toEqual(strip(live))

    // Non-vacuity: every field a resync used to silently drop is populated.
    const session = hydrated.sessions['rid-1']
    expect(session.messages.map((m) => m.id)).toEqual(['msg-e2e-1', 'a1'])
    expect(session.queue).toEqual([{ itemId: 'q1', text: 'and then deploy', state: 'queued' }])
    expect(session.metering?.equivalentCostUsd).toBe(0.31)
    expect(session.todos).toHaveLength(1)
    expect(session.sentFiles).toEqual([
      { path: 'out/report.md', caption: 'the report', display: 'attach', toolUseId: 't-file' }
    ])
    expect(session.selectedModel).toBe('opus')
    expect(session.effort).toBe('high')
    expect(session.permissionMode).toBe('acceptEdits')
    expect(session.statusLine).toMatchObject({ totalCostUsd: 0.31 })
    expect(hydrated.directories).toEqual(DIRECTORIES)
    expect(hydrated.recentSessionIds).toEqual(['rid-1'])
    expect(hydrated.customTitles).toEqual({ 'rid-1': 'Shipping' })
    // The phone lands on a real session even though the snapshot carries no
    // selection (phase 4b A5 — resolved from recents by the client itself).
    expect(useSessionStore.getState().activeSessionId).toBe('rid-1')
    // And the emitter-timed duration survived into the client's transcript, which
    // the pre-4b clock-free reducer could not have produced.
    const thinking = session.messages[1].content.find((b) => b.type === 'thinking')
    expect(thinking?.type === 'thinking' ? thinking.durationMs : null).toBe(1234)
  })

  it('the parity check would CATCH a divergence (guard against a vacuous pass)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }])
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })])
    expectParity()

    // Poke the renderer replica behind the funnel's back.
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, 'rid-1': { ...s.sessions['rid-1'], permissionMode: 'plan' } }
    }))
    mirrorStoreIntoReplica()
    expect(parityDiff()).toEqual(['rid-1.permissionMode'])
  })
})
