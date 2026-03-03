import type { BrowserWindow } from 'electron'
import { ClaudeSession } from './claude-session'

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
    permissionMode?: string
  ): ClaudeSession {
    // Clean up existing session with same routingId
    const existing = this.sessions.get(routingId)
    if (existing) {
      existing.cancel()
    }

    const session = new ClaudeSession(routingId, win, cwd, effort, resumeSessionId, permissionMode)
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

  cancelAll(): void {
    this.sessions.forEach((session) => session.cancel())
    this.sessions.clear()
  }

  getTeamInfo(routingId: string): ReturnType<ClaudeSession['getTeamInfo']> | null {
    return this.sessions.get(routingId)?.getTeamInfo() ?? null
  }

  /** Iterate all active sessions */
  forEach(fn: (session: ClaudeSession) => void): void {
    this.sessions.forEach(fn)
  }
}
