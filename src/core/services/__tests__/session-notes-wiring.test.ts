/**
 * @vitest-environment node
 *
 * Reports back are off (slice 5, ruling 18): a session started from another reports
 * nothing to it. `session-notes.ts` stays for the future assistant feature but is
 * dormant until `enableSessionNotes()` — which nothing in production calls (the
 * session IPC registration's half of that is pinned in session.ipc.test.ts).
 *
 * `noteStopRequested` is the one live export: the Stop path and `session_stop` call it,
 * and it must keep feeding context pressure with notes off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStatus } from '../../../shared/types'
import type { NonUserItem, NonUserOutcome } from '../../providers/ISession'
import { TurnOriginLedger } from '../../providers/turn-origin-ledger'
import type { SessionManager } from '../session-manager'
import { linkChild, resetSessionLinksForTests } from '../session-links'
import {
  configureSessionNotes,
  enableSessionNotes,
  noteStopRequested,
  resetSessionNotesForTests
} from '../session-notes'
import { emitEvent, syncCore } from '../sync-host'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const pressure = vi.hoisted(() => ({ noteTurnStopped: vi.fn() }))
vi.mock('../context-pressure', () => pressure)

let n = 0
const id = (label: string): string => `${label}-${process.pid}-${++n}`
const status = (sessionId: string | null, state: SessionStatus['state']): SessionStatus =>
  ({
    state,
    sessionId,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    account: null
  }) as SessionStatus

const delivered: NonUserItem[] = []
const parentSession = {
  willQueue: true,
  originLedger: new TurnOriginLedger(),
  getSessionId: () => null,
  deliverNonUser: vi.fn(async (item: NonUserItem): Promise<NonUserOutcome> => {
    delivered.push(item)
    return 'queued'
  })
}
const sessions: Record<string, unknown> = {}
const manager = { get: (key: string) => sessions[key], has: (key: string) => key in sessions }

/** A started session that has gone live, and the session that started it (busy). */
function startedPair(): { child: string } {
  const parent = id('parent')
  const temp = id('temp')
  const child = id('child')
  emitEvent('session:created', [parent, { cwd: '/proj', engineId: 'claude' }])
  emitEvent('session:status', [parent, status(parent, 'running')])
  sessions[parent] = parentSession
  emitEvent('session:created', [temp, { cwd: '/proj', engineId: 'claude' }])
  linkChild({
    parent,
    childRoutingId: temp,
    engine: 'claude',
    kind: 'started',
    createdBy: 'agent',
    grouped: false
  })
  emitEvent('session:status', [temp, status(child, 'idle')])
  return { child }
}

const turn = (child: string): void => {
  emitEvent('session:status', [child, status(child, 'running')])
  emitEvent('session:message', [
    child,
    {
      id: id('a'),
      role: 'assistant',
      content: [{ type: 'text', text: 'All done.' }],
      timestamp: Date.now()
    }
  ])
  emitEvent('session:status', [child, status(child, 'idle')])
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))

beforeEach(() => {
  syncCore.resetCanonicalForTests()
  resetSessionLinksForTests()
  resetSessionNotesForTests()
  delivered.length = 0
  parentSession.deliverNonUser.mockClear()
  pressure.noteTurnStopped.mockClear()
})

afterEach(() => {
  resetSessionNotesForTests()
})

describe('turn-end notes are not wired', () => {
  it('a started session’s turn end sends nothing to the session that started it, even with the manager configured', async () => {
    configureSessionNotes(manager as unknown as SessionManager)
    const { child } = startedPair()
    turn(child)
    turn(child)
    await settle()
    expect(parentSession.deliverNonUser).not.toHaveBeenCalled()
  })

  it('and the module is not dormant by accident: enabling it is what makes the same turn end send a note', async () => {
    configureSessionNotes(manager as unknown as SessionManager)
    enableSessionNotes()
    const { child } = startedPair()
    turn(child)
    await settle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ origin: 'agent-note' })
    // A note never wakes: wake_when_done is gone.
    expect(delivered[0]).toMatchObject({ wake: false })
  })
})

describe('loading the module', () => {
  it('registers no host observer; only enableSessionNotes does, once', async () => {
    vi.resetModules()
    const added = vi.fn((_observer: unknown) => () => {})
    vi.doMock('../sync-host', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../sync-host')>()),
      addHostObserver: added
    }))
    try {
      // What session-notes imports registers its own observers: take the baseline after them.
      await import('../session-links')
      await import('../session-delivery')
      const baseline = added.mock.calls.length
      const notes = await import('../session-notes')
      expect(added.mock.calls.length).toBe(baseline)
      notes.enableSessionNotes()
      notes.enableSessionNotes()
      expect(added.mock.calls.length).toBe(baseline + 1)
    } finally {
      vi.doUnmock('../sync-host')
      vi.resetModules()
    }
  })
})

describe('noteStopRequested with notes off', () => {
  it('still tells context pressure the turn was stopped, and does nothing else', () => {
    const { child } = startedPair()
    expect(() => noteStopRequested(child)).not.toThrow()
    expect(pressure.noteTurnStopped).toHaveBeenCalledExactlyOnceWith(child)
    expect(delivered).toHaveLength(0)
  })
})
