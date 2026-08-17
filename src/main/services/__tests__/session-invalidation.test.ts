/**
 * @vitest-environment node
 *
 * Which sessions a credential change is allowed to stop (F5 / R3).
 *
 * The scope is the whole point. Both triggers are Claude-credential events: an
 * account switch re-points `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and a successful
 * login replaces the Anthropic OAuth token. Neither touches opencode's or pi's
 * vendor credentials (ADR-036), so cancelling those sessions destroys a running
 * turn for no reason.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  cancelClaudeSessions,
  setLiveSessionCanceller,
  invalidateLiveSessions
} from '../session-invalidation'

interface FakeSession {
  engineId: string
  cancel: ReturnType<typeof vi.fn> & (() => void)
}

function makeManager(engines: string[]): {
  manager: { forEach(fn: (s: FakeSession) => void): void }
  sessions: FakeSession[]
  cleared: boolean
} {
  const sessions = engines.map(
    (engineId) => ({ engineId, cancel: vi.fn() }) as unknown as FakeSession
  )
  const state = { cleared: false }
  return {
    sessions,
    get cleared() {
      return state.cleared
    },
    manager: {
      forEach(fn: (s: FakeSession) => void) {
        for (const s of sessions) fn(s)
      }
    }
  }
}

describe('cancelClaudeSessions', () => {
  it('cancels claude sessions and leaves opencode / pi alone', () => {
    const { manager, sessions } = makeManager(['claude', 'opencode', 'pi', 'claude'])
    cancelClaudeSessions(manager)
    expect(sessions.map((s) => s.cancel.mock.calls.length)).toEqual([1, 0, 0, 1])
  })

  it('does nothing when no claude session is live', () => {
    const { manager, sessions } = makeManager(['opencode', 'pi'])
    cancelClaudeSessions(manager)
    expect(sessions.every((s) => s.cancel.mock.calls.length === 0)).toBe(true)
  })

  /**
   * `SessionManager.cancelAll()` also CLEARS the registry map. Nothing re-creates
   * the opencode/pi objects it would drop — the renderer's respawn only spawns
   * what its own store lists — so `manager.get()` would return undefined for them
   * and the next send would throw "No session for routingId".
   */
  it('never clears the registry (that is what `cancelAll` does, and it loses sessions)', () => {
    const { manager, sessions } = makeManager(['claude', 'pi'])
    cancelClaudeSessions(manager)
    let stillIterable = 0
    manager.forEach(() => stillIterable++)
    expect(stillIterable).toBe(sessions.length)
  })
})

describe('invalidateLiveSessions', () => {
  it('routes to the wired canceller', () => {
    const calls: string[] = []
    setLiveSessionCanceller(() => calls.push('cancel'))
    try {
      invalidateLiveSessions('a reason')
      expect(calls).toEqual(['cancel'])
    } finally {
      setLiveSessionCanceller(null)
    }
  })

  it('is a no-op when nothing is wired (windowless boot, unit tests)', () => {
    setLiveSessionCanceller(null)
    expect(() => invalidateLiveSessions('a reason')).not.toThrow()
  })

  it('swallows a throwing canceller — an auth flow must not fail on it', () => {
    setLiveSessionCanceller(() => {
      throw new Error('manager exploded')
    })
    try {
      expect(() => invalidateLiveSessions('a reason')).not.toThrow()
    } finally {
      setLiveSessionCanceller(null)
    }
  })
})
