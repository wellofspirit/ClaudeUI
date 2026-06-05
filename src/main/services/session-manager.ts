import type { BrowserWindow } from 'electron'
import { ClaudeSession } from './claude-session'
import { loadSessionHistory } from './session-history'
import type { ChatMessage, SandboxSettings } from '../../shared/types'

export class SessionManager {
  private sessions = new Map<string, ClaudeSession>()
  private _sessionTimeoutMs = 15 * 60 * 1000 // default 15 min, 0 = disabled

  /** Update the idle timeout for all current and future sessions. */
  setSessionTimeout(ms: number): void {
    this._sessionTimeoutMs = ms
    this.sessions.forEach((session) => session.setInactivityTimeout(ms))
  }

  create(
    routingId: string,
    win: BrowserWindow,
    cwd: string,
    effort?: string,
    resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    sandboxConfig?: SandboxSettings,
    thinkingMode?: string,
    resumeSessionAt?: string,
    forkSession?: boolean
  ): ClaudeSession {
    // Clean up existing session with same routingId
    const existing = this.sessions.get(routingId)
    if (existing) {
      existing.cancel()
    }

    const session = new ClaudeSession(routingId, win, cwd, effort, resumeSessionId, permissionMode, model, sandboxConfig, thinkingMode, resumeSessionAt, forkSession)
    session.setInactivityTimeout(this._sessionTimeoutMs)
    this.sessions.set(routingId, session)
    return session
  }

  get(routingId: string): ClaudeSession | undefined {
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
    if (session) {
      session.cancel()
    }
  }

  async interrupt(routingId: string): Promise<void> {
    const session = this.sessions.get(routingId)
    if (session) {
      await session.interrupt()
    }
  }

  cancelAll(): void {
    this.sessions.forEach((session) => session.cancel())
    this.sessions.clear()
  }

  /** Update the idle timeout for a specific session by routingId. Pass 0 to disable. */
  setInactivityTimeout(routingId: string, ms: number): void {
    const session = this.sessions.get(routingId)
    if (session) {
      session.setInactivityTimeout(ms)
    }
  }

  /** Get the SDK session UUID for a session identified by routingId. */
  getSessionId(routingId: string): string | null {
    return this.sessions.get(routingId)?.getSessionId() ?? null
  }

  /**
   * Get message history for a session by sessionId.
   * Returns in-memory messages if the session is active, otherwise loads from disk.
   * The plugin provides `cwd` (same value used in `create()`) to locate the JSONL file.
   */
  async getMessages(sessionId: string, cwd: string): Promise<ChatMessage[]> {
    // Try in-memory first
    for (const session of this.sessions.values()) {
      if (session.getSessionId() === sessionId) {
        return session.getMessages()
      }
    }
    // Fall back to disk
    const projectKey = cwd.replace(/[/.]/g, '-')
    const result = await loadSessionHistory(sessionId, projectKey)
    return result.messages
  }

  /** Iterate all active sessions */
  forEach(fn: (session: ClaudeSession) => void): void {
    this.sessions.forEach(fn)
  }
}
