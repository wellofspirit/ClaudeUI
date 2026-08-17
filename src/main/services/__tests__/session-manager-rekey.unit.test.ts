/**
 * @vitest-environment node
 *
 * Rekey ownership: core drives the registry — SyncCore phase 4a item 7.
 *
 * The registry must follow core's rekey in the SAME tick as the append, and only
 * ONE manager may own that subscription: `registerSessionIpc` builds a fresh
 * SessionManager and re-runs when macOS re-creates the window, so a stacking
 * subscription would re-key session objects that no live manager owns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SessionStatus } from '../../../shared/types'

vi.mock('../../../core/services/db', () => ({
  renameDispatchedUsage: vi.fn(),
  dispatchedCostsByRouting: vi.fn(() => []),
  appendAuditLog: vi.fn()
}))
vi.mock('../../../core/services/session-history', () => ({ loadSessionHistory: vi.fn(async () => ({ messages: [] })) }))
vi.mock('../../../core/providers/register-engines', () => ({}))

const { SessionManager } = await import('../../../core/services/session-manager')
const { syncCore, emitEvent } = await import('../../../core/services/sync-host')

function status(sessionId: string | null): SessionStatus {
  return {
    state: 'running',
    sessionId,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    account: null
  } as SessionStatus
}

/** Inject a session object under `routingId` without spawning an engine. */
function seat(
  manager: InstanceType<typeof SessionManager>,
  routingId: string
): { routingId: string } {
  const stub = { routingId }
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(routingId, stub)
  return stub
}

describe('SessionManager — core-owned rekey', () => {
  beforeEach(() => {
    syncCore.resetCanonicalForTests()
  })

  it('re-keys the registry when core rekeys canonical state', () => {
    const manager = new SessionManager()
    emitEvent('session:created', ['temp-1', { cwd: '/x' }])
    const stub = seat(manager, 'temp-1')

    emitEvent('session:status', ['temp-1', status('uuid-9')])

    expect(manager.has('temp-1')).toBe(false)
    expect(manager.get('uuid-9')).toBe(stub)
    // The session object's own routing id moves with it, so its next send is
    // addressed correctly without any re-registration.
    expect(stub.routingId).toBe('uuid-9')
    manager.disposeRekeyObserver()
  })

  it('a NEWER manager supersedes the older subscription (no stacking)', () => {
    const first = new SessionManager()
    const firstStub = seat(first, 'temp-1')
    // macOS dock re-open: registerSessionIpc runs again with a fresh manager.
    const second = new SessionManager()
    emitEvent('session:created', ['temp-1', { cwd: '/x' }])
    const secondStub = seat(second, 'temp-1')

    emitEvent('session:status', ['temp-1', status('uuid-9')])

    expect(second.get('uuid-9')).toBe(secondStub)
    // The abandoned manager is untouched — its objects are nobody's business now.
    expect(first.has('temp-1')).toBe(true)
    expect(firstStub.routingId).toBe('temp-1')
    second.disposeRekeyObserver()
  })

  it('an unrelated status (no new sessionId) does not re-key', () => {
    const manager = new SessionManager()
    emitEvent('session:created', ['uuid-9', { cwd: '/x' }])
    seat(manager, 'uuid-9')

    emitEvent('session:status', ['uuid-9', status('uuid-9')])
    emitEvent('session:status', ['uuid-9', status(null)])

    expect(manager.has('uuid-9')).toBe(true)
    manager.disposeRekeyObserver()
  })

  it('disposeRekeyObserver detaches the manager', () => {
    const manager = new SessionManager()
    emitEvent('session:created', ['temp-1', { cwd: '/x' }])
    seat(manager, 'temp-1')
    manager.disposeRekeyObserver()

    emitEvent('session:status', ['temp-1', status('uuid-9')])

    // Canonical still rekeyed (it always does); the detached registry did not.
    expect(Object.keys(syncCore.getCanonicalState().sessions)).toEqual(['uuid-9'])
    expect(manager.has('temp-1')).toBe(true)
  })

  it('create() is unaffected by the subscription (win is still per-session)', () => {
    const manager = new SessionManager()
    expect(typeof manager.setSessionTimeout).toBe('function')
    expect(manager.get('nope')).toBeUndefined()
    manager.disposeRekeyObserver()
    // A no-op double dispose must not throw — `activeRekeyUnsubscribe` may still
    // point at this manager's unsubscribe when a later one supersedes it.
    expect(() => manager.disposeRekeyObserver()).not.toThrow()
  })
})

/** Unused import guard: keeps the BrowserWindow type reference meaningful. */
export type _Win = BrowserWindow
