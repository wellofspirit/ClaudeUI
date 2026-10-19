/**
 * @vitest-environment node
 *
 * "Delivered when the parent is live again" (ADR-105 §3): the held X-Agent result of a
 * parent that was not live is flushed — with wake — at the first `session:status` `idle`
 * of a session object whose engine is up, after the session was armed by a `disconnected`
 * status, a `session:created` or a hold. Nothing else flushes it (a turn end, a dispose-
 * replace with no status, a status of an engine that is not up yet).
 *
 * Part 1 pins the REAL status sequence of a `ClaudeSession` on a fake cli.js — the evidence
 * the edge was chosen from. Part 2 drives the observer against the real session and the
 * real inbox (the node:sqlite-backed `session_inbox`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import {
  addHostObserver,
  clearSyncSubscribersForTests,
  emitEvent
} from '../../../core/services/sync-host'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})
vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    setServerStartedHook: () => {},
    isBinaryAvailable: (): boolean => false
  }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../../core/services/context-window', () => ({
  getContextWindowSize: vi.fn(() => 200000)
}))
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { fetch: vi.fn(async () => null) }
}))
vi.mock('../../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

import { ClaudeSession } from '../../../core/services/claude-session'
import {
  deliverDispatchResult,
  watchDispatchResultFlush
} from '../../../core/services/dispatch-result-flush'
import { deliver } from '../../../core/services/session-delivery'
import { heldInboxCount, heldInboxItems } from '../../../core/services/db'
import type { SessionManager } from '../../../core/services/session-manager'
import type { BrowserWindow } from 'electron'

afterEach(() => {
  clearSyncSubscribersForTests()
})

/** A cli.js handle that answers `initialize` (the spawn is then up) and otherwise parks. */
function makeHandle(prompt: AsyncIterable<unknown>): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  end: () => void
  frames: Array<Record<string, unknown>>
} {
  let wake: (() => void) | null = null
  let done = false
  const frames: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const frame of prompt) frames.push(frame as Record<string, unknown>)
  })()
  const handle = {
    [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (!done) {
          await new Promise<void>((r) => {
            wake = r
          })
        }
        return { done: true, value: undefined }
      }
    }),
    initializationResult: async (): Promise<unknown> => ({ account: { email: 'a@b.c' } }),
    interrupt: vi.fn(async () => {}),
    cancelAsyncMessage: vi.fn(async () => ({ cancelled: true })),
    applyFlagSettings: vi.fn(async () => ({}))
  }
  return {
    handle,
    end: () => {
      done = true
      wake?.()
      wake = null
    },
    frames
  }
}

function makeWin(): BrowserWindow {
  const win = {
    isDestroyed: () => false,
    webContents: { send: (): void => {} }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return win
}

const handles: Array<ReturnType<typeof makeHandle>> = []
const sessions: ClaudeSession[] = []
let counter = 0
const newId = (): string => `r-flush-${process.pid}-${++counter}`

beforeEach(() => {
  vi.clearAllMocks()
  handles.length = 0
  mockQuery.mockImplementation((params: { prompt: AsyncIterable<unknown> }) => {
    const h = makeHandle(params.prompt)
    handles.push(h)
    return h.handle
  })
})
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
  for (const h of handles) h.end()
})

/** Every `session:status` of `id` with the session's liveness AT that moment. */
function recordStatuses(
  id: string,
  sessionOf: () => ClaudeSession | undefined
): { seq: string[]; stop: () => void } {
  const seq: string[] = []
  const stop = addHostObserver((channel, args) => {
    if (channel !== 'session:status' || args[0] !== id) return
    const state = (args[1] as { state?: string }).state
    seq.push(`${state}:${sessionOf()?.isEngineLive() ? 'live' : 'down'}`)
  })
  return { seq, stop }
}

const RESULT = {
  origin: 'dispatch-result' as const,
  text: 'X-Agent impl-e1 finished: report here',
  from: { key: 's-abc234', title: 'impl-e1' },
  wake: true
}

describe('the status sequence of a real ClaudeSession (the evidence for the flush edge)', () => {
  it('constructor: idle with no engine; spawn: idle once cli.js answered; cancel: disconnected; respawn: idle again', async () => {
    const id = newId()
    const held: { session?: ClaudeSession } = {}
    const rec = recordStatuses(id, () => held.session)
    const session = new ClaudeSession(id, makeWin(), '/tmp/proj')
    held.session = session
    sessions.push(session)
    // The constructor's `idle` comes before the session object is even assigned (no engine).
    const spawn = session.run(null)
    await vi.waitFor(() => expect(rec.seq).toHaveLength(2))
    session.cancel()
    const respawn = session.run(null)
    await vi.waitFor(() => expect(rec.seq).toHaveLength(4))
    rec.stop()
    expect(rec.seq).toEqual(['idle:down', 'idle:live', 'disconnected:down', 'idle:live'])
    void spawn
    void respawn
  })
})

describe('the flush of a held X-Agent result', () => {
  function managerOf(get: () => ClaudeSession | undefined, id: string): SessionManager {
    return { get: (key: string) => (key === id ? get() : undefined) } as unknown as SessionManager
  }

  it('a respawn after a disconnect delivers it once, with wake, at the first live idle status — not before', async () => {
    const id = newId()
    // The parent was not live when the X-Agent ended: held, nothing spawned.
    expect(
      await deliver(
        managerOf(() => undefined, id),
        id,
        RESULT
      )
    ).toEqual({
      result: 'held',
      why: 'no-live-session'
    })
    const session = new ClaudeSession(id, makeWin(), '/tmp/proj')
    sessions.push(session)
    const manager = managerOf(() => session, id)
    const watch = watchDispatchResultFlush(manager, addHostObserver)
    try {
      // The new object's own `idle` (engine not up, nothing armed) is not the edge...
      emitEvent('session:status', [id, { state: 'idle' }])
      expect(heldInboxCount(id)).toBe(1)
      expect(handles).toHaveLength(0)
      // ...a disconnect only arms the edge...
      session.cancel()
      expect(heldInboxCount(id)).toBe(1)
      expect(handles).toHaveLength(0)
      // ...and the respawn's idle with the engine up flushes: one frame, the held result.
      void session.run(null)
      await vi.waitFor(() => expect(heldInboxCount(id)).toBe(0))
      await vi.waitFor(() => expect(handles.at(-1)!.frames.length).toBeGreaterThan(0))
      const frame = handles.at(-1)!.frames[0]
      expect((frame.message as { content: string }).content).toBe(
        '<cross-session-message from="x-agent:s-abc234" from-name="X-Agent impl-e1">\nX-Agent impl-e1 finished: report here\n</cross-session-message>'
      )
      expect(frame.origin).toMatchObject({ kind: 'peer', from: 'x-agent:s-abc234' })
      expect(watch.armed()).not.toContain(id)
      // A later turn end flushes nothing: delivered once.
      const sentBefore = handles.at(-1)!.frames.length
      emitEvent('session:status', [id, { state: 'idle' }])
      await new Promise((r) => setTimeout(r, 20))
      expect(handles.at(-1)!.frames).toHaveLength(sentBefore)
    } finally {
      watch.stop()
    }
  })

  it('a newly created session object arms the edge too (a reopen or a respawn that had no disconnect)', async () => {
    const id = newId()
    await deliver(
      managerOf(() => undefined, id),
      id,
      RESULT
    )
    const session = new ClaudeSession(id, makeWin(), '/tmp/proj')
    sessions.push(session)
    const watch = watchDispatchResultFlush(
      managerOf(() => session, id),
      addHostObserver
    )
    try {
      emitEvent('session:created', [id, { cwd: '/tmp/proj' }])
      expect(watch.armed()).toContain(id)
      expect(heldInboxCount(id)).toBe(1)
      void session.run(null)
      await vi.waitFor(() => expect(heldInboxCount(id)).toBe(0))
    } finally {
      watch.stop()
    }
  })

  it('the status that re-keys a session moves its armed edge to the new id', () => {
    const watch = watchDispatchResultFlush(
      { get: () => undefined } as unknown as SessionManager,
      addHostObserver
    )
    try {
      watch.arm('temp-id')
      emitEvent('session:status', ['temp-id', { state: 'running', sessionId: 'durable-id' }])
      expect(watch.armed()).toEqual(['durable-id'])
    } finally {
      watch.stop()
    }
  })

  it('a deleted session is forgotten', () => {
    const id = newId()
    const watch = watchDispatchResultFlush(
      { get: () => undefined } as unknown as SessionManager,
      addHostObserver
    )
    try {
      watch.arm(id)
      emitEvent('session:removed', [id])
      expect(watch.armed()).not.toContain(id)
    } finally {
      watch.stop()
    }
  })

  it('a dispose-replace sends no status: nothing is flushed, and a status of an engine that is not up is no edge', async () => {
    const id = newId()
    await deliver(
      managerOf(() => undefined, id),
      id,
      RESULT
    )
    const first = new ClaudeSession(id, makeWin(), '/tmp/proj')
    sessions.push(first)
    let current = first
    const watch = watchDispatchResultFlush(
      managerOf(() => current, id),
      addHostObserver
    )
    try {
      watch.arm(id)
      // The object is replaced under its id: the old one retires without a status...
      first.dispose()
      const second = new ClaudeSession(id, makeWin(), '/tmp/proj')
      sessions.push(second)
      current = second
      // ...and the replacement's constructor says `idle` with no engine behind it.
      await new Promise((r) => setTimeout(r, 20))
      expect(heldInboxCount(id)).toBe(1)
      expect(handles).toHaveLength(0)
      expect(watch.armed()).toContain(id)
    } finally {
      watch.stop()
    }
  })

  it('without arming (no disconnect, no new object, no hold) a live idle status flushes nothing', async () => {
    const id = newId()
    await deliver(
      managerOf(() => undefined, id),
      id,
      RESULT
    )
    const session = new ClaudeSession(id, makeWin(), '/tmp/proj')
    sessions.push(session)
    void session.run(null)
    await vi.waitFor(() => expect(handles).toHaveLength(1))
    const watch = watchDispatchResultFlush(
      managerOf(() => session, id),
      addHostObserver
    )
    try {
      emitEvent('session:status', [id, { state: 'idle' }])
      await new Promise((r) => setTimeout(r, 20))
      expect(heldInboxItems(id)).toHaveLength(1)
    } finally {
      watch.stop()
    }
  })

  it('a running status is not the edge: the flush waits for the turn to end', async () => {
    const id = newId()
    await deliver(
      managerOf(() => undefined, id),
      id,
      RESULT
    )
    const session = new ClaudeSession(id, makeWin(), '/tmp/proj')
    sessions.push(session)
    void session.run(null)
    await vi.waitFor(() => expect(handles).toHaveLength(1))
    const watch = watchDispatchResultFlush(
      managerOf(() => session, id),
      addHostObserver
    )
    try {
      watch.arm(id)
      emitEvent('session:status', [id, { state: 'running' }])
      await new Promise((r) => setTimeout(r, 20))
      expect(heldInboxCount(id)).toBe(1)
      emitEvent('session:status', [id, { state: 'idle' }])
      await vi.waitFor(() => expect(heldInboxCount(id)).toBe(0))
    } finally {
      watch.stop()
    }
  })

  it('the dispatcher hands a result over with origin dispatch-result: a parent with no live object holds it and arms the edge; a live idle parent takes it at once', async () => {
    const item = { from: RESULT.from, text: RESULT.text }
    // No object for the id: held in the inbox, the edge armed.
    const away = newId()
    const watchAway = watchDispatchResultFlush(
      managerOf(() => undefined, away),
      addHostObserver
    )
    try {
      expect(
        await deliverDispatchResult(
          managerOf(() => undefined, away),
          watchAway,
          away,
          item
        )
      ).toEqual({ result: 'held', why: 'no-live-session' })
      expect(heldInboxItems(away)).toMatchObject([
        { origin: 'dispatch-result', fromKey: 'x-agent:s-abc234' }
      ])
      expect(watchAway.armed()).toContain(away)
    } finally {
      watchAway.stop()
    }

    // A live, idle parent: handed to the engine at once (a turn starts), nothing held, nothing armed.
    const here = newId()
    const session = new ClaudeSession(here, makeWin(), '/tmp/proj')
    sessions.push(session)
    void session.run(null)
    await vi.waitFor(() => expect(handles).toHaveLength(1))
    const watchHere = watchDispatchResultFlush(
      managerOf(() => session, here),
      addHostObserver
    )
    try {
      expect(
        await deliverDispatchResult(
          managerOf(() => session, here),
          watchHere,
          here,
          item
        )
      ).toEqual({
        result: 'delivered'
      })
      expect(heldInboxCount(here)).toBe(0)
      expect(watchHere.armed()).not.toContain(here)
      await vi.waitFor(() => expect(handles[0].frames.length).toBeGreaterThan(0))
    } finally {
      watchHere.stop()
    }
  })
})
