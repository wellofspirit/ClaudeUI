import type { BrowserWindow } from 'electron'
import { ClaudeSession } from './claude-session'

export class SessionManager {
  private sessions = new Map<string, ClaudeSession>()

  create(
    routingId: string,
    win: BrowserWindow,
    cwd: string,
    effort?: string,
    resumeSessionId?: string
  ): ClaudeSession {
    // Clean up existing session with same routingId
    const existing = this.sessions.get(routingId)
    if (existing) {
      existing.cancel()
    }

    const session = new ClaudeSession(routingId, win, cwd, effort, resumeSessionId)
    this.sessions.set(routingId, session)
    return session
  }

  get(routingId: string): ClaudeSession | undefined {
    return this.sessions.get(routingId)
  }

  has(routingId: string): boolean {
    return this.sessions.has(routingId)
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
}
