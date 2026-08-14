/**
 * Layer 3: E2E — SyncCore phase 4a shadow parity.
 *
 * ONE event stream, TWO interpretations: the main-process emission funnel
 * (`emitEvent` → ring → `applyEvent` → canonical) and the renderer's Zustand
 * store, wired exactly as `useClaudeEvents` wires it. At idle they must agree.
 *
 * This is the test the whole shadow stage exists to make possible. 4a duplicates
 * the event-handling logic on purpose; without a parity check the duplication is
 * just two chances to be wrong, and 4b's cutover (canonical becomes the state of
 * record for `sync-full`) would change what every client sees with no warning.
 *
 * The fields the comparator is told to ignore are listed — with reasons — in
 * {@link IGNORED_FIELDS}: each is state the renderer still WRITES locally rather
 * than deriving from the stream, which is 4c's problem, not a parity bug.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import {
  useSessionStore,
  getRemoteStateSnapshot,
  buildTodosFromMessages,
  buildSentFilesFromMessages,
  resolveRoutingId
} from '../../renderer/src/stores/session-store'
import { syncCore, emitEvent, setSyncWindow } from '../../main/services/sync-host'
import { rekeyShim } from '../../main/ipc/handlers-core'
import { compareShadow, formatShadowDiff, CLIENT_WRITTEN_FIELDS } from '../../main/sync/shadow'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import type {
  ChatMessage,
  PendingApproval,
  SessionStatus,
  StreamDelta,
  QueuedItem,
  TaskNotification,
  StatusLineData,
  MeteringSnapshot
} from '../../shared/types'

let app: TestApp
let cleanups: Array<() => void>

/**
 * Divergences 4a deliberately does not close. Every one is state the RENDERER
 * writes from a local action rather than from the event stream, so canonical
 * cannot match it at an arbitrary instant:
 *
 *  - `activeSessionId` — selection is per-client view state (ADR-041).
 *  - `recentSessionIds` / `pinnedSessionIds` / `customTitles` / `sessionEngines` /
 *    `hiddenSessions` / `hiddenProjects` — written by `createNewSession`,
 *    `addUserMessage`, `setCustomTitle`, … and reaching core only through the
 *    `config:sessions-changed` file-watcher loop.
 *  - `worktreeInfoMap` — the renderer PARSES a tool_result to derive it
 *    (`useClaudeEvents`), which is derive-and-store in a client: the very pattern
 *    item 11(e)'s rule bans. Moving it into the reducer is 4b/4c work.
 *  - `directories` — sourced from a query, not the stream.
 */
// ONE definition, shared with the dev shadow watch — see CLIENT_WRITTEN_FIELDS's
// doc comment in main/sync/shadow.ts for why the sets must not be able to drift.
const IGNORED_FIELDS = CLIENT_WRITTEN_FIELDS

/**
 * The renderer half of the comparison: `useClaudeEvents`'s handlers, verbatim in
 * behavior (including the derived-state rebuild triggers and the client-side
 * rekey), reading from the bridge the delivery adapter writes to.
 */
function wireRendererHandlers(app: TestApp): Array<() => void> {
  const list: Array<() => void> = []
  const store = useSessionStore.getState

  function on<T extends (...args: never[]) => void>(channel: string, cb: T): void {
    const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
    app.bridge.ipcRenderer.on(channel, handler)
    list.push(() => app.bridge.ipcRenderer.removeListener(channel, handler))
  }

  const rebuildTodos = (routingId: string): void => {
    const session = store().sessions[routingId]
    if (!session) return
    const todos = buildTodosFromMessages(session.messages)
    if (todos) store().setTodos(routingId, todos)
  }
  const rebuildSentFiles = (routingId: string): void => {
    const session = store().sessions[routingId]
    if (!session) return
    const sentFiles = buildSentFilesFromMessages(session.messages)
    if (sentFiles) store().setSentFiles(routingId, sentFiles)
  }
  const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

  on('session:created', (routingId: string, data: { cwd: string }) => {
    if (!store().sessions[routingId]) store().createNewSession(routingId, data.cwd, false)
    store().markSdkActive(routingId)
  })

  on('session:user-message', (routingId: string, data: { prompt: string }) => {
    const id = resolveRoutingId(routingId)
    if (!store().sessions[id]) return
    store().addUserMessage(id, `msg-${Math.random().toString(16).slice(2)}`, data.prompt)
  })

  on('session:message', (routingId: string, msg: ChatMessage) => {
    const id = resolveRoutingId(routingId)
    store().addMessage(id, msg)
    if (msg.content.some((b) => b.type === 'tool_use' && TASK_TOOLS.has(b.toolName))) {
      rebuildTodos(id)
    }
    if (msg.content.some((b) => b.type === 'tool_use' && b.toolName === 'SendUserFile')) {
      rebuildSentFiles(id)
    }
  })

  on('session:stream', (routingId: string, data: StreamDelta) => {
    const id = resolveRoutingId(routingId)
    if (data.type === 'thinking') store().appendStreamingThinking(id, data.text)
    else store().appendStreamingText(id, data.text)
  })

  on(
    'session:tool-result',
    (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => {
      const id = resolveRoutingId(routingId)
      store().appendToolResult(id, data.toolUseId, data.result, data.isError)
      if (data.toolUseId) store().removePendingApprovalByToolUse(id, data.toolUseId)
      if (!data.isError) rebuildTodos(id)
      if (store().sessions[id]?.sentFiles.some((f) => f.toolUseId === data.toolUseId)) {
        rebuildSentFiles(id)
      }
    }
  )

  on('session:approval-request', (routingId: string, approval: PendingApproval) => {
    store().addPendingApproval(resolveRoutingId(routingId), approval)
  })
  on('session:approval-dismiss', (routingId: string, data: { requestId: string }) => {
    store().removePendingApproval(resolveRoutingId(routingId), data.requestId)
  })

  on('session:status', (routingId: string, status: SessionStatus) => {
    let effective = routingId
    if (status.sessionId && status.sessionId !== routingId) {
      if (store().sessions[routingId]) {
        store().rekeySession(routingId, status.sessionId)
        effective = status.sessionId
      }
    }
    if (status.state === 'disconnected') {
      store().markSdkInactive(effective)
      store().setStatus(effective, { ...status, state: 'idle' })
      store().clearPendingApprovals(effective)
      return
    }
    store().setStatus(effective, status)
  })

  on('session:result', (routingId: string) => {
    const id = resolveRoutingId(routingId)
    const session = store().sessions[id]
    if (
      session &&
      session.todos.length > 0 &&
      session.todos.every((t) => t.status === 'completed')
    ) {
      store().setTodos(id, [])
    }
  })

  on('session:queue-changed', (routingId: string, data: { items: QueuedItem[] }) => {
    store().setQueueState(resolveRoutingId(routingId), data.items)
  })
  on('session:permission-mode', (routingId: string, mode: string) => {
    store().setPermissionMode(mode as never, resolveRoutingId(routingId))
  })
  on(
    'session:config-changed',
    (
      routingId: string,
      patch: {
        model?: string
        effort?: string
        thinkingMode?: string
        reasoningVariant?: string | null
      }
    ) => {
      store().applyRemoteSessionConfig(resolveRoutingId(routingId), patch)
    }
  )
  on('session:status-line', (routingId: string, data: StatusLineData) => {
    store().setStatusLine(resolveRoutingId(routingId), data)
  })
  on('session:metering', (routingId: string, data: MeteringSnapshot) => {
    store().setMetering(resolveRoutingId(routingId), data)
  })
  on(
    'session:task-started',
    (routingId: string, data: { toolUseId: string; taskId: string; taskType: string }) => {
      store().setTaskStarted(resolveRoutingId(routingId), data as never)
    }
  )
  on('session:task-notification', (routingId: string, data: TaskNotification) => {
    store().addTaskNotification(resolveRoutingId(routingId), data)
  })
  // Cross-instance registry config (useClaudeEvents.onSessionConfigChanged).
  on('config:sessions-changed', (config: Record<string, unknown>) => {
    store().applyExternalSessionConfig(config as never)
  })

  return list
}

/** The canonical/renderer diff, with the 4a-sanctioned masks applied. */
function parityDiff(): ReturnType<typeof compareShadow> {
  const canonical = syncCore.getSnapshot()
  const renderer = getRemoteStateSnapshot() as unknown as FullStateSnapshot
  const state = syncCore.getCanonicalState()
  const unseeded = new Set(
    Object.entries(state.sessions)
      .filter(([, s]) => !s.seeded)
      .map(([id]) => id)
  )
  return compareShadow(canonical, renderer, { unseeded, ignoreFields: IGNORED_FIELDS })
}

function expectParity(): void {
  const diffs = parityDiff()
  expect(diffs.length, `shadow divergence:\n${formatShadowDiff(diffs).join('\n')}`).toBe(0)
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
    // `applyRemoteSnapshot` derives this from the snapshot's settings (ADR-050),
    // and `createNewSession` seeds a new session's mode from it — so a test that
    // hydrates a snapshot would otherwise change the NEXT test's baseline mode.
    defaultPermissionMode: 'default'
  })
  syncCore.resetCanonicalForTests()
  // The delivery adapter's "primary window" is the test bridge: `emitEvent`
  // therefore drives the SAME path production uses (funnel → delivery →
  // webContents.send), which is what makes this an end-to-end parity check
  // rather than two hand-fed state machines.
  setSyncWindow({
    isDestroyed: () => false,
    webContents: { send: (channel: string, ...args: unknown[]) => app.emit(channel, ...args) }
  } as never)
  cleanups = wireRendererHandlers(app)
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  setSyncWindow(null)
  app.teardown()
})

describe('E2E: SyncCore shadow parity', () => {
  it('a full turn (stream → tools → todos → result) folds identically on both sides', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })], 'all')
    emitEvent('session:user-message', ['rid-1', { prompt: 'plan the work' }], 'all')
    emitEvent('session:stream', ['rid-1', { type: 'thinking', text: 'thinking...' }], 'all')
    emitEvent('session:stream', ['rid-1', { type: 'text', text: 'On it. ' }], 'all')
    emitEvent(
      'session:message',
      [
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
      ],
      'all'
    )
    emitEvent(
      'session:tool-result',
      ['rid-1', { toolUseId: 't-todo', result: 'ok', isError: false }],
      'all'
    )
    emitEvent(
      'session:status-line',
      ['rid-1', { model: 'sonnet', totalCostUsd: 0.12 } as never],
      'all'
    )
    emitEvent(
      'session:metering',
      [
        'rid-1',
        {
          engineId: 'claude',
          vendorId: 'anthropic',
          billingType: 'subscription',
          tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0, total: 15 },
          equivalentCostUsd: 0.12,
          contextWindow: { used: 15, size: 200000 }
        } as never
      ],
      'all'
    )
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')
    emitEvent('session:result', ['rid-1', {}], 'all')

    // Sanity: the stream really did land on both sides (a parity check between
    // two empty states would pass vacuously).
    expect(syncCore.getSnapshot().sessions['rid-1'].todos).toHaveLength(2)
    expect(useSessionStore.getState().sessions['rid-1'].todos).toHaveLength(2)
    expectParity()
  })

  it('metering survives into the snapshot on BOTH sides (item 8)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    const metering = {
      engineId: 'claude',
      vendorId: 'anthropic',
      billingType: 'subscription',
      tokens: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0, total: 3 },
      equivalentCostUsd: 0.01,
      contextWindow: { used: 3, size: 200000 }
    }
    emitEvent('session:metering', ['rid-1', metering as never], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')

    expect(syncCore.getSnapshot().sessions['rid-1'].metering).toEqual(metering)
    expect(
      (getRemoteStateSnapshot() as unknown as FullStateSnapshot).sessions['rid-1'].metering
    ).toEqual(metering)
    expectParity()
  })

  it('a mid-stream rekey with duplicate client rekey invokes stays in parity', async () => {
    // Core owns the rekey (item 7). Every client STILL invokes `session:rekey`
    // until 4c removes those call sites, so the shim has to absorb N duplicates
    // as no-ops. The registry it consults has already been re-keyed by core in the
    // same tick as the append, which is why `get(oldId)` misses.
    const shimResults: Array<{ ok: true; applied: boolean }> = []
    app.bridge.ipcMain.handle('session:rekey', (_e: unknown, oldId: string, newId: string) => {
      const result = rekeyShim({ get: () => undefined } as never, oldId, newId)
      shimResults.push(result)
      return result
    })

    emitEvent('session:created', ['temp-1', { cwd: '/project' }], 'all')
    emitEvent('session:stream', ['temp-1', { type: 'text', text: 'Partial ' }], 'all')

    emitEvent('session:status', ['temp-1', makeStatus({ sessionId: 'sdk-9' })], 'all')
    await app.api.rekeySession('temp-1', 'sdk-9')
    await app.api.rekeySession('temp-1', 'sdk-9')
    // Two invokes, ZERO extra applications — the duplicates are absorbed.
    expect(shimResults).toEqual([
      { ok: true, applied: false },
      { ok: true, applied: false }
    ])

    emitEvent('session:stream', ['sdk-9', { type: 'text', text: 'and done.' }], 'all')
    emitEvent(
      'session:message',
      [
        'sdk-9',
        {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial and done.' }],
          timestamp: 0
        } satisfies ChatMessage
      ],
      'all'
    )
    emitEvent('session:status', ['sdk-9', makeStatus({ state: 'idle', sessionId: 'sdk-9' })], 'all')

    expect(Object.keys(syncCore.getSnapshot().sessions)).toEqual(['sdk-9'])
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual(['sdk-9'])
    expectParity()
  })

  it('a queue take-back race lands the same transcript on both sides', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })], 'all')
    const items = (states: Array<QueuedItem['state']>): QueuedItem[] =>
      states.map((state, i) => ({ itemId: `i${i + 1}`, text: `queued ${i + 1}`, state }))

    emitEvent('session:queue-changed', ['rid-1', { items: items(['queued', 'queued']) }], 'all')
    emitEvent('session:queue-changed', ['rid-1', { items: items(['consumed', 'queued']) }], 'all')
    emitEvent('session:queue-changed', ['rid-1', { items: items(['consumed', 'recalled']) }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')

    expect(syncCore.getSnapshot().sessions['rid-1'].queue).toEqual([])
    expect(syncCore.getSnapshot().sessions['rid-1'].messages.map((m) => m.id)).toContain('steer-i1')
    expectParity()
  })

  it('an eviction + rehydrate cycle is masked, then clean again once warm', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent(
      'session:message',
      [
        'rid-1',
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
      ],
      'all'
    )
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')
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
    expectParity()
  })

  it('per-session config changes replicate to the renderer picker state (item 6)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent('session:config-changed', ['rid-1', { model: 'opus', effort: 'high' }], 'all')
    emitEvent('session:config-changed', ['rid-1', { thinkingMode: 'enabled' }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')

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
    // path is `applyRemoteSnapshot(sync-full.state)`, and `sync-full.state` is now
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

    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ sessionId: 'rid-1' })], 'all')
    emitEvent(
      'session:user-message',
      // Identity now rides the event (phase 4b A1) — the renderer still mints its
      // own until 4c, which is why the comparator masks user ids.
      ['rid-1', { id: 'msg-e2e-1', timestamp: 1_700_000_000_000, prompt: 'ship it' }],
      'all'
    )
    emitEvent('session:stream', ['rid-1', { type: 'thinking', text: 'planning' }], 'all')
    emitEvent('session:stream', ['rid-1', { type: 'text', text: 'On it. ' }], 'all')
    emitEvent(
      'session:message',
      [
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
      ],
      'all'
    )
    emitEvent(
      'session:tool-result',
      ['rid-1', { toolUseId: 't-todo', result: 'ok', isError: false }],
      'all'
    )
    emitEvent(
      'session:tool-result',
      ['rid-1', { toolUseId: 't-file', result: 'delivered', isError: false }],
      'all'
    )
    emitEvent('session:config-changed', ['rid-1', { model: 'opus', effort: 'high' }], 'all')
    emitEvent('session:permission-mode', ['rid-1', 'acceptEdits'], 'all')
    emitEvent(
      'session:status-line',
      ['rid-1', { model: 'opus', totalCostUsd: 0.31 } as never],
      'all'
    )
    emitEvent(
      'session:metering',
      [
        'rid-1',
        {
          engineId: 'claude',
          vendorId: 'anthropic',
          billingType: 'subscription',
          tokens: { input: 20, output: 9, cacheWrite: 0, cacheRead: 0, total: 29 },
          equivalentCostUsd: 0.31,
          contextWindow: { used: 29, size: 200000 }
        } as never
      ],
      'all'
    )
    emitEvent(
      'session:queue-changed',
      ['rid-1', { items: [{ itemId: 'q1', text: 'and then deploy', state: 'queued' }] }],
      'all'
    )
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')
    // Registry config: emitted last so both replicas end on the same value (the
    // renderer also writes recents locally on a user message — 4c's problem).
    emitEvent(
      'config:sessions-changed',
      [{ recentSessions: ['rid-1'], pinnedSessions: [], customTitles: { 'rid-1': 'Shipping' } }],
      'all'
    )
    expectParity()

    const live = getRemoteStateSnapshot() as unknown as FullStateSnapshot
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
    useSessionStore.getState().applyRemoteSnapshot(canonical, false)
    const hydrated = getRemoteStateSnapshot() as unknown as FullStateSnapshot

    // Almost nothing is masked here — NOT the whole client-written set: canonical
    // is authoritative for the registry config now, so recents/titles must match.
    // The two exceptions are genuinely per-client:
    //  - `activeSessionId` — selection (ADR-041); core serves null and the client
    //    picks its own landing session from recents.
    //  - `sessionEngines` — `createNewSession` writes it LOCALLY on the client
    //    that spawned the session, and it reaches core only through a
    //    `config:sessions-changed` save (4c makes that write a command).
    const diffs = compareShadow(hydrated, live, {
      ignoreFields: new Set(['activeSessionId', 'sessionEngines']),
      compareStreamingAlways: true
    })
    expect(diffs.length, `resync divergence:\n${formatShadowDiff(diffs).join('\n')}`).toBe(0)

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

  it('the comparator would CATCH a divergence (guard against a vacuous pass)', () => {
    emitEvent('session:created', ['rid-1', { cwd: '/project' }], 'all')
    emitEvent('session:status', ['rid-1', makeStatus({ state: 'idle', sessionId: 'rid-1' })], 'all')
    expectParity()

    // Poke the renderer replica behind the funnel's back.
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, 'rid-1': { ...s.sessions['rid-1'], permissionMode: 'plan' } }
    }))
    expect(parityDiff().map((d) => d.field)).toEqual(['permissionMode'])
  })
})
