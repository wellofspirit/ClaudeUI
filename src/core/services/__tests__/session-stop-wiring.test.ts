/**
 * @vitest-environment node
 *
 * The stop paths tell context pressure directly (slice 5 follow-up): the Stop button /
 * remote interrupt (`SessionManager.interrupt`) and a session's `session_stop` both call
 * `context-pressure.noteTurnStopped`, and nothing in production loads the dormant
 * `session-notes.ts` to do it. The factory below counts loads of that module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager as SessionManagerType } from '../session-manager'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const probes = vi.hoisted(() => ({ notesLoaded: 0, noteTurnStopped: vi.fn() }))
vi.mock('../session-notes', () => {
  probes.notesLoaded++
  return { noteStopRequested: vi.fn() }
})
vi.mock('../context-pressure', () => ({
  noteHandedOff: vi.fn(),
  noteTurnStopped: probes.noteTurnStopped
}))

import { SessionManager } from '../session-manager'
import { configureSessionTools, sessionStop } from '../session-tools'
import { refFor } from '../session-links'
import { emitEvent, syncCore } from '../sync-host'

beforeEach(() => {
  probes.noteTurnStopped.mockClear()
  syncCore.resetCanonicalForTests()
})

describe('stopping a turn', () => {
  it('SessionManager.interrupt tells context pressure, and loads no session-notes', async () => {
    const real = new SessionManager()
    try {
      const interrupt = vi.fn(async () => {})
      ;(real as unknown as { sessions: Map<string, unknown> }).sessions.set('r-stop-1', {
        interrupt
      })
      await real.interrupt('r-stop-1')
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(probes.noteTurnStopped).toHaveBeenCalledExactlyOnceWith('r-stop-1')
    } finally {
      real.disposeRekeyObserver()
    }
    expect(probes.notesLoaded).toBe(0)
  })

  it("session_stop tells context pressure about the target's turn, and loads no session-notes", async () => {
    const caller = `r-stop-caller-${process.pid}`
    const target = `r-stop-target-${process.pid}`
    for (const id of [caller, target]) {
      emitEvent('session:created', [id, { cwd: '/proj', engineId: 'claude' }])
    }
    const interrupt = vi.fn(async () => {})
    const sessions: Record<string, unknown> = { [target]: { willQueue: true, interrupt } }
    configureSessionTools({
      manager: { get: (id: string) => sessions[id] } as unknown as SessionManagerType,
      createSession: async () => {},
      sendPrompt: () => {}
    })
    try {
      const result = await sessionStop(
        { routingId: caller, engine: 'claude', cwd: '/proj', permissionMode: 'default' },
        { session: refFor('claude', target) }
      )
      expect(result.text).toMatch(/^stopped s-/)
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(probes.noteTurnStopped).toHaveBeenCalledExactlyOnceWith(target)
    } finally {
      configureSessionTools(null)
    }
    expect(probes.notesLoaded).toBe(0)
  })
})
