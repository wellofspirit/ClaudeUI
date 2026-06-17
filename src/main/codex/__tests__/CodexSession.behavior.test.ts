/**
 * Behavioral tests for CodexSession lifecycle correctness.
 *
 * These exercise run()/notification-handler logic WITHOUT spawning the real
 * codex binary, by mocking:
 *   - electron        → test shim (CodexSession transitively imports ./locate → electron app)
 *   - ./locate        → returns a dummy binary path
 *   - node:child_process → a fake child with no-op pipe streams
 *   - ./CodexAppServerClient → a FakeClient that records the registered
 *     notification/request handlers and lets the test invoke them, and stubs
 *     request() for the handshake + turn/start.
 *
 * Covers the Phase-8 hardening fixes:
 *   #1 per-turn assembly buffers cleared between turns
 *   #2 error notification with willRetry:false clears running + emits error status
 *   #3 spawn/handshake failure surfaced to renderer (no unhandled rejection) + cleanup
 *   #4 re-entrant run() guard
 *   #6 dispose() suppresses late emissions / auto-declines pending approvals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../locate', () => ({
  locateCodex: () => '/fake/codex',
  getCodexVersion: () => 'test',
}))

// --- Hoisted fakes ----------------------------------------------------------
//
// vi.mock factories are hoisted above all module-level code, so any state they
// reference must be created via vi.hoisted() (which is hoisted with them).
// Two gotchas this setup works around:
//  1. node builtins (child_process/readline) need BOTH the named export and a
//     `default` carrying the same override, spread over importOriginal(), or
//     `import { spawn }` leaks the REAL spawn — a real ENOENT child then hangs
//     dispose()'s kill() and wedges the worker.
//  2. The shared fakeChildren/fakeClients arrays + classes live in vi.hoisted()
//     so the hoisted factories can reference them.

const H = vi.hoisted(() => {
  type NotifHandler = (params: unknown) => void
  type ReqHandler = (params: unknown) => Promise<unknown> | unknown

  class FakeChild {
    stdin = { writable: true, write: () => {}, end: () => {} }
    stdout = { on: () => {}, once: () => {} }
    stderr = { on: () => {} }
    killed = false
    exitCode: number | null = null
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? []
      arr.push(cb)
      this.listeners.set(event, arr)
      return this
    }
    once(event: string, cb: (...args: unknown[]) => void): this {
      return this.on(event, cb)
    }
    kill(_signal?: string): boolean {
      this.killed = true
      return true
    }
    emitExit(code: number | null, signal: string | null): void {
      this.exitCode = code
      for (const cb of this.listeners.get('exit') ?? []) cb(code, signal)
    }
  }

  // Control knobs read by FakeClient (mutated by individual tests).
  // `handshakeError`, when set, is thrown from thread/start (lets a test inject
  // a specific error type such as CodexSpawnError, constructed in the test body
  // — the hoisted block can't import it).
  const ctl: { failHandshake: boolean; handshakeError: unknown } = {
    failHandshake: false,
    handshakeError: null,
  }

  class FakeClient {
    notifHandlers = new Map<string, NotifHandler[]>()
    reqHandlers = new Map<string, ReqHandler>()
    disposed = false
    /** Per-method responses cover the handshake + turn/start. */
    requestImpl: (method: string, params: unknown) => Promise<unknown> = async (method) => {
      if (method === 'thread/start') {
        if (ctl.handshakeError) throw ctl.handshakeError
        if (ctl.failHandshake) throw new Error('handshake failed: connection refused')
        return { thread: { id: 'thread-fake-1' } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-fake-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-fake-1' } }
      return {}
    }
    request(method: string, params: unknown, _opts?: unknown): Promise<unknown> {
      return this.requestImpl(method, params)
    }
    notify(_method: string, _params: unknown): void {}
    handleServerNotification(method: string, handler: NotifHandler): void {
      const arr = this.notifHandlers.get(method) ?? []
      arr.push(handler)
      this.notifHandlers.set(method, arr)
    }
    handleServerRequest(method: string, handler: ReqHandler): void {
      this.reqHandlers.set(method, handler)
    }
    handleUnknownServerNotification(): void {}
    handleUnknownServerRequest(): void {}
    close(): void {
      this.disposed = true
    }
    dispose(): void {
      this.disposed = true
    }
    /** Test helper: fire a server notification through the registered handler(s). */
    fireNotification(method: string, params: unknown): void {
      for (const h of this.notifHandlers.get(method) ?? []) h(params)
    }
  }

  const fakeChildren: FakeChild[] = []
  const fakeClients: FakeClient[] = []
  return { FakeChild, FakeClient, fakeChildren, fakeClients, ctl }
})

type FakeClient = InstanceType<typeof H.FakeClient>
const fakeChildren = H.fakeChildren
const fakeClients = H.fakeClients
const ctl = H.ctl

vi.mock('node:child_process', async (io) => {
  const actual = await io<typeof import('node:child_process')>()
  const spawn = (): unknown => {
    const c = new H.FakeChild()
    H.fakeChildren.push(c)
    return c
  }
  return { ...actual, spawn, default: { ...actual, spawn } }
})

vi.mock('node:readline', async (io) => {
  const actual = await io<typeof import('node:readline')>()
  const createInterface = (): unknown => ({ on: () => {}, close: () => {} })
  return { ...actual, createInterface, default: { ...actual, createInterface } }
})

vi.mock('../CodexAppServerClient', () => ({
  CodexAppServerClient: class {
    constructor() {
      const c = new H.FakeClient()
      H.fakeClients.push(c)
      return c as unknown as object
    }
  },
  CodexAppServerError: class extends Error {},
}))

// --- Imports under test (after mocks) ---------------------------------------

import { CodexSession } from '../CodexSession'
import { CodexSpawnError } from '../codexQuery'
import type { BrowserWindow } from 'electron'

// --- Test harness -----------------------------------------------------------

interface SentEvent {
  channel: string
  routingId: string
  data: unknown
}

function makeFakeWin(sent: SentEvent[]): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, routingId: string, data: unknown) => {
        sent.push({ channel, routingId, data })
      },
    },
  } as unknown as BrowserWindow
}

/** Latest fake client created by the most recent spawnAndHandshake. */
function latestClient(): FakeClient {
  return fakeClients[fakeClients.length - 1]
}

let sent: SentEvent[]
const liveSessions: CodexSession[] = []

/** Construct a CodexSession and track it for teardown (clears its inactivity
 *  timer, which would otherwise keep the event loop alive and hang vitest). */
function makeSession(): CodexSession {
  const s = new CodexSession('r1', makeFakeWin(sent), '/cwd', undefined, undefined, 'acceptEdits')
  liveSessions.push(s)
  return s
}

beforeEach(() => {
  sent = []
  fakeChildren.length = 0
  fakeClients.length = 0
  liveSessions.length = 0
  ctl.failHandshake = false
  ctl.handshakeError = null
})

afterEach(() => {
  // dispose() clears the BaseSession inactivity setTimeout (15 min) that would
  // otherwise hold the event loop open and hang the test process on exit.
  for (const s of liveSessions) {
    try {
      s.dispose()
    } catch {
      /* ignore */
    }
  }
})

// Access private assembly state for white-box assertions.
function assembly(session: CodexSession): {
  itemText: Map<string, string>
  commandOutput: Map<string, string>
  totalInputTokens: number
} {
  return (session as unknown as { assemblyState: never }).assemblyState
}

// White-box access to the private client/child handles.
function privates(session: CodexSession): { client: unknown; child: unknown } {
  return session as unknown as { client: unknown; child: unknown }
}

function statusEvents(): Array<{ state: string }> {
  return sent
    .filter((e) => e.channel === 'session:status')
    .map((e) => e.data as { state: string })
}

describe('CodexSession.run re-entrancy guard (#4)', () => {
  it('ignores a second run() while a turn is already active', async () => {
    const session = makeSession()

    await session.run('first prompt')
    expect(session.willQueue).toBe(true) // running === true

    const client = latestClient()
    const turnStartCalls = vi.spyOn(client, 'request')

    // Second run while running — must be ignored (no second turn/start).
    await session.run('second prompt')

    const turnStarts = turnStartCalls.mock.calls.filter((c) => c[0] === 'turn/start')
    expect(turnStarts).toHaveLength(0)
  })

  it('allows run() again after the turn completes', async () => {
    const session = makeSession()
    await session.run('first prompt')

    // Complete the turn.
    latestClient().fireNotification('turn/completed', { turn: { id: 'turn-fake-1', status: 'completed' } })
    expect(session.willQueue).toBe(false)

    const reqSpy = vi.spyOn(latestClient(), 'request')
    await session.run('second prompt')
    const turnStarts = reqSpy.mock.calls.filter((c) => c[0] === 'turn/start')
    expect(turnStarts).toHaveLength(1)
  })
})

describe('CodexSession spawn/handshake failure surfacing + cleanup (#3)', () => {
  it('surfaces a handshake failure to the renderer (resolves, no unhandled rejection)', async () => {
    const session = makeSession()

    // run() is called fire-and-forget by the session:send IPC, so a spawn/
    // handshake failure must be surfaced via session:error + session:status,
    // NOT rethrown (which would become an unhandled rejection).
    ctl.failHandshake = true
    await expect(session.run('first prompt')).resolves.toBeUndefined()

    // Error surfaced to the renderer.
    const errors = sent.filter((e) => e.channel === 'session:error').map((e) => e.data)
    expect(errors).toContain('handshake failed: connection refused')
    expect(statusEvents().map((s) => s.state)).toContain('error')
    // running left false.
    expect(session.willQueue).toBe(false)
  })

  it('maps CodexSpawnError to a friendly "not found" message', async () => {
    const session = makeSession()

    ctl.handshakeError = new CodexSpawnError('codex binary not found or not executable: ENOENT')
    await expect(session.run('first prompt')).resolves.toBeUndefined()

    const errors = sent.filter((e) => e.channel === 'session:error').map((e) => e.data)
    expect(errors).toContain('Codex CLI not found. Install it (or check your PATH) and try again.')
    expect(statusEvents().map((s) => s.state)).toContain('error')
  })

  it('nulls client + kills child on failure, so the next run re-spawns cleanly', async () => {
    const session = makeSession()

    // First run fails: spawnAndHandshake() tears down its half-open connection
    // (#3) before run() surfaces the error, leaving client/child null.
    ctl.failHandshake = true
    await session.run('first prompt')

    expect(privates(session).client).toBeNull()
    expect(privates(session).child).toBeNull()
    // The first fake child must have been killed during cleanup.
    expect(fakeChildren[0].killed).toBe(true)
    expect(session.willQueue).toBe(false)

    // Second run: handshake now succeeds → a fresh spawn + working turn. The
    // null client from the failed attempt is what lets run() re-enter
    // spawnAndHandshake() instead of firing turn/start on a dead connection.
    ctl.failHandshake = false
    sent.length = 0
    await session.run('second prompt')

    expect(privates(session).client).not.toBeNull()
    expect(session.willQueue).toBe(true)
    // A second child was spawned for the retry.
    expect(fakeChildren.length).toBe(2)
    expect(statusEvents().map((s) => s.state)).toContain('running')
  })
})

describe('CodexSession error notification (#2)', () => {
  it('willRetry:false clears running and emits error status', async () => {
    const session = makeSession()
    await session.run('do something')
    expect(session.willQueue).toBe(true)

    sent.length = 0 // focus on what the error notification emits
    latestClient().fireNotification('error', {
      error: { message: 'Fatal: connection refused' },
      willRetry: false,
    })

    // running cleared
    expect(session.willQueue).toBe(false)
    // error status emitted
    const states = statusEvents().map((s) => s.state)
    expect(states).toContain('error')
    // error message surfaced
    const errors = sent.filter((e) => e.channel === 'session:error').map((e) => e.data)
    expect(errors).toContain('Fatal: connection refused')
  })

  it('willRetry:true stays a warning and keeps running (no status change)', async () => {
    const session = makeSession()
    await session.run('do something')
    expect(session.willQueue).toBe(true)

    sent.length = 0
    latestClient().fireNotification('error', {
      error: { message: 'Rate limited, retrying' },
      willRetry: true,
    })

    // still running — the retry will continue the turn
    expect(session.willQueue).toBe(true)
    // warning surfaced, not error
    const warnings = sent.filter((e) => e.channel === 'session:warning').map((e) => e.data)
    expect(warnings).toContain('Rate limited, retrying')
    expect(sent.filter((e) => e.channel === 'session:error')).toHaveLength(0)
    // no error status
    expect(statusEvents().map((s) => s.state)).not.toContain('error')
  })

  it('missing willRetry field defaults to terminal (error)', async () => {
    const session = makeSession()
    await session.run('do something')

    sent.length = 0
    latestClient().fireNotification('error', { error: { message: 'boom' } })

    expect(session.willQueue).toBe(false)
    expect(statusEvents().map((s) => s.state)).toContain('error')
  })
})

describe('CodexSession per-turn assembly reset (#1)', () => {
  it('clears itemText + commandOutput buffers at the start of each turn', async () => {
    const session = makeSession()
    await session.run('turn one')

    // Simulate a turn that streams text + buffers command output but never
    // completes the items (abnormal end).
    const client = latestClient()
    client.fireNotification('item/agentMessage/delta', {
      delta: 'partial',
      itemId: 'leak-item',
      threadId: 'thread-fake-1',
      turnId: 'turn-fake-1',
    })
    client.fireNotification('item/commandExecution/outputDelta', {
      delta: 'stdout-leak',
      itemId: 'leak-cmd',
      threadId: 'thread-fake-1',
      turnId: 'turn-fake-1',
    })

    expect(assembly(session).itemText.get('leak-item')).toBe('partial')
    expect(assembly(session).commandOutput.get('leak-cmd')).toBe('stdout-leak')

    // Turn ends abnormally (no item/completed). Then a new turn begins.
    client.fireNotification('turn/completed', { turn: { id: 'turn-fake-1', status: 'completed' } })
    await session.run('turn two')

    // Per-turn buffers must be empty at the start of turn two.
    expect(assembly(session).itemText.size).toBe(0)
    expect(assembly(session).commandOutput.size).toBe(0)
  })

  it('does NOT reset session-level token accumulators between turns', async () => {
    const session = makeSession()
    await session.run('turn one')

    const client = latestClient()
    client.fireNotification('thread/tokenUsage/updated', {
      threadId: 'thread-fake-1',
      turnId: 'turn-fake-1',
      tokenUsage: {
        last: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 150 },
        total: { totalTokens: 150 },
        modelContextWindow: 128000,
      },
    })
    expect(assembly(session).totalInputTokens).toBe(100)

    client.fireNotification('turn/completed', { turn: { id: 'turn-fake-1', status: 'completed' } })
    await session.run('turn two')

    // Token total persists across the turn boundary (session-level metric).
    expect(assembly(session).totalInputTokens).toBe(100)
  })
})

describe('CodexSession dispose suppresses late emissions (#6)', () => {
  it('drops mapped emissions produced after dispose()', async () => {
    const session = makeSession()
    await session.run('do something')
    const client = latestClient()

    session.dispose()
    sent.length = 0

    // A late notification arriving after dispose must not emit anything.
    client.fireNotification('item/agentMessage/delta', {
      delta: 'late',
      itemId: 'x',
      threadId: 'thread-fake-1',
      turnId: 'turn-fake-1',
    })
    expect(sent.filter((e) => e.channel === 'session:stream')).toHaveLength(0)
  })

  it('approval handler returns decline without emitting after dispose()', async () => {
    const session = makeSession()
    await session.run('do something')
    const client = latestClient()

    session.dispose()
    sent.length = 0

    const handler = client.reqHandlers.get('item/commandExecution/requestApproval')!
    const resp = await handler({ itemId: 'cmd-1', command: 'rm -rf /' })
    expect(resp).toEqual({ decision: 'decline' })
    // No approval-request IPC emitted post-dispose.
    expect(sent.filter((e) => e.channel === 'session:approval-request')).toHaveLength(0)
  })
})
