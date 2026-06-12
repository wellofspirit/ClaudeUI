/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Test SessionManager's pure state management logic using a minimal mock.
// We avoid importing the real module to prevent pulling in Electron deps.
// ---------------------------------------------------------------------------

class MockSession {
  routingId: string
  cancelled = false
  timeoutMs = 0
  sessionId: string | null = null
  messages: Array<{ id: string }> = []

  constructor(routingId: string) {
    this.routingId = routingId
  }
  cancel(): void {
    this.cancelled = true
  }
  async interrupt(): Promise<void> {
    /* noop */
  }
  setInactivityTimeout(ms: number): void {
    this.timeoutMs = ms
  }
  getSessionId(): string | null {
    return this.sessionId
  }
  getMessages(): Array<{ id: string }> {
    return this.messages
  }
}

// Replicate SessionManager's core logic
class TestSessionManager {
  private sessions = new Map<string, MockSession>()
  private _sessionTimeoutMs = 15 * 60 * 1000

  setSessionTimeout(ms: number): void {
    this._sessionTimeoutMs = ms
    this.sessions.forEach((session) => session.setInactivityTimeout(ms))
  }

  create(routingId: string): MockSession {
    const existing = this.sessions.get(routingId)
    if (existing) existing.cancel()
    const session = new MockSession(routingId)
    session.setInactivityTimeout(this._sessionTimeoutMs)
    this.sessions.set(routingId, session)
    return session
  }

  get(routingId: string): MockSession | undefined {
    return this.sessions.get(routingId)
  }

  has(routingId: string): boolean {
    return this.sessions.has(routingId)
  }

  rekey(oldId: string, newId: string): void {
    const session = this.sessions.get(oldId)
    if (!session) return
    session.routingId = newId
    this.sessions.delete(oldId)
    this.sessions.set(newId, session)
  }

  cancel(routingId: string): void {
    const session = this.sessions.get(routingId)
    if (session) session.cancel()
  }

  cancelAll(): void {
    this.sessions.forEach((session) => session.cancel())
    this.sessions.clear()
  }

  getSessionId(routingId: string): string | null {
    return this.sessions.get(routingId)?.getSessionId() ?? null
  }

  setInactivityTimeout(routingId: string, ms: number): void {
    const session = this.sessions.get(routingId)
    if (session) session.setInactivityTimeout(ms)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let mgr: TestSessionManager

  beforeEach(() => {
    mgr = new TestSessionManager()
  })

  describe('create', () => {
    it('creates a new session', () => {
      const session = mgr.create('route-1')
      expect(session.routingId).toBe('route-1')
      expect(mgr.has('route-1')).toBe(true)
    })

    it('cancels existing session with same routingId', () => {
      const session1 = mgr.create('route-1')
      const session2 = mgr.create('route-1')
      expect(session1.cancelled).toBe(true)
      expect(session2.cancelled).toBe(false)
      expect(mgr.get('route-1')).toBe(session2)
    })

    it('applies default timeout to new sessions', () => {
      mgr.setSessionTimeout(5000)
      const session = mgr.create('route-1')
      expect(session.timeoutMs).toBe(5000)
    })
  })

  describe('rekey', () => {
    it('moves session from old ID to new ID', () => {
      mgr.create('old-id')
      mgr.rekey('old-id', 'new-id')

      expect(mgr.has('old-id')).toBe(false)
      expect(mgr.has('new-id')).toBe(true)
      expect(mgr.get('new-id')!.routingId).toBe('new-id')
    })

    it('does nothing for non-existent old ID', () => {
      mgr.rekey('nonexistent', 'new-id')
      expect(mgr.has('new-id')).toBe(false)
    })

    it('preserves the session object during rekey', () => {
      const session = mgr.create('old-id')
      session.sessionId = 'sdk-123'
      mgr.rekey('old-id', 'new-id')

      expect(mgr.get('new-id')!.sessionId).toBe('sdk-123')
    })
  })

  describe('cancel', () => {
    it('cancels a specific session', () => {
      const session = mgr.create('route-1')
      mgr.cancel('route-1')
      expect(session.cancelled).toBe(true)
    })

    it('does nothing for non-existent session', () => {
      // Should not throw
      mgr.cancel('nonexistent')
    })
  })

  describe('cancelAll', () => {
    it('cancels all sessions and clears the map', () => {
      const s1 = mgr.create('r1')
      const s2 = mgr.create('r2')
      mgr.cancelAll()

      expect(s1.cancelled).toBe(true)
      expect(s2.cancelled).toBe(true)
      expect(mgr.has('r1')).toBe(false)
      expect(mgr.has('r2')).toBe(false)
    })
  })

  describe('setSessionTimeout', () => {
    it('propagates timeout to all existing sessions', () => {
      const s1 = mgr.create('r1')
      const s2 = mgr.create('r2')
      mgr.setSessionTimeout(10000)

      expect(s1.timeoutMs).toBe(10000)
      expect(s2.timeoutMs).toBe(10000)
    })
  })

  describe('setInactivityTimeout', () => {
    it('sets timeout for a specific session', () => {
      const session = mgr.create('r1')
      mgr.setInactivityTimeout('r1', 30000)
      expect(session.timeoutMs).toBe(30000)
    })

    it('does nothing for non-existent session', () => {
      mgr.setInactivityTimeout('nonexistent', 30000)
    })
  })

  describe('getSessionId', () => {
    it('returns session ID when set', () => {
      const session = mgr.create('r1')
      session.sessionId = 'sdk-456'
      expect(mgr.getSessionId('r1')).toBe('sdk-456')
    })

    it('returns null for session without SDK ID', () => {
      mgr.create('r1')
      expect(mgr.getSessionId('r1')).toBeNull()
    })

    it('returns null for non-existent session', () => {
      expect(mgr.getSessionId('nonexistent')).toBeNull()
    })
  })
})
