/**
 * @vitest-environment node
 *
 * Slice C (ADR-033 cross-engine dispatch) — SessionManager.rekey() must carry
 * dispatched_usage rows from the pre-rekey routingId forward to the SDK
 * session UUID, via db.ts's renameDispatchedUsage. Without this, a dispatch
 * recorded under a fresh session's temporary routingId becomes unreachable
 * from BaseSession.seedDispatchedCosts() on a later resume (which looks up by
 * the STABLE post-rekey id).
 *
 * Exercises the REAL SessionManager class (not the hand-rolled mock used by
 * session-manager.test.ts) so the actual `renameDispatchedUsage` wiring in
 * rekey() is under test. `../providers/register-engines` and
 * `../providers/EngineRegistry` are mocked to avoid pulling in the real
 * ClaudeSession/OpencodeSession classes (and their Electron/opencode deps) —
 * this test only needs rekey()'s map bookkeeping + db call, not real sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRenameDispatchedUsage, mockCreateSession } = vi.hoisted(() => ({
  mockRenameDispatchedUsage: vi.fn(),
  mockCreateSession: vi.fn()
}))

vi.mock('../db', () => ({
  renameDispatchedUsage: mockRenameDispatchedUsage
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// Side-effect-only in the real module (registers engine factories) — mocked
// out so importing SessionManager doesn't pull in ClaudeSession/OpencodeSession.
vi.mock('../../providers/register-engines', () => ({}))

vi.mock('../../providers/EngineRegistry', () => ({
  engineRegistry: {
    createSession: mockCreateSession
  }
}))

vi.mock('../session-history', () => ({ loadSessionHistory: vi.fn() }))

import { SessionManager } from '../session-manager'

function makeFakeSession(routingId: string): {
  routingId: string
  cancel: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  setInactivityTimeout: ReturnType<typeof vi.fn>
  getSessionId: () => string | null
  getMessages: () => never[]
} {
  return {
    routingId,
    cancel: vi.fn(),
    dispose: vi.fn(),
    setInactivityTimeout: vi.fn(),
    getSessionId: () => null,
    getMessages: () => []
  }
}

describe('SessionManager.rekey — dispatched_usage id chain (Slice C)', () => {
  beforeEach(() => {
    mockRenameDispatchedUsage.mockReset()
    mockCreateSession.mockReset()
  })

  it('carries dispatched_usage rows from the old routingId to the new one', () => {
    mockCreateSession.mockImplementation((_engineId: string, routingId: string) =>
      makeFakeSession(routingId)
    )
    const mgr = new SessionManager()
    mgr.create('tmp-routing', {} as never, '/tmp/proj')

    mgr.rekey('tmp-routing', 'sdk-session-uuid')

    expect(mockRenameDispatchedUsage).toHaveBeenCalledWith('tmp-routing', 'sdk-session-uuid')
    expect(mgr.has('tmp-routing')).toBe(false)
    expect(mgr.has('sdk-session-uuid')).toBe(true)
  })

  it('does not call renameDispatchedUsage for an unknown oldId (nothing to rekey)', () => {
    const mgr = new SessionManager()
    mgr.rekey('nonexistent', 'new-id')
    expect(mockRenameDispatchedUsage).not.toHaveBeenCalled()
  })

  // M-CL3: create-over-existing must dispose() (permanently retire + fence) the
  // old object, NOT merely cancel() it — cancel() leaves the object usable and
  // its late run()-finally would re-arm an idle timer whose cancel() later
  // broadcasts disconnected for, and disposeFor()s, the LIVE replacement.
  it('disposes (not just cancels) the existing session when replacing under the same routingId', () => {
    const created: ReturnType<typeof makeFakeSession>[] = []
    mockCreateSession.mockImplementation((_engineId: string, routingId: string) => {
      const s = makeFakeSession(routingId)
      created.push(s)
      return s
    })
    const mgr = new SessionManager()

    mgr.create('route-replace', {} as never, '/tmp/proj')
    mgr.create('route-replace', {} as never, '/tmp/proj') // replacement

    const first = created[0]
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(first.cancel).not.toHaveBeenCalled()
    // The live session is the second object.
    expect(mgr.get('route-replace')).toBe(created[1])
  })

  it('a throwing renameDispatchedUsage never breaks rekey (best-effort, logged)', () => {
    mockRenameDispatchedUsage.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    mockCreateSession.mockImplementation((_engineId: string, routingId: string) =>
      makeFakeSession(routingId)
    )
    const mgr = new SessionManager()
    mgr.create('tmp-routing-2', {} as never, '/tmp/proj')

    expect(() => mgr.rekey('tmp-routing-2', 'sdk-session-uuid-2')).not.toThrow()
    expect(mgr.has('sdk-session-uuid-2')).toBe(true)
  })
})
