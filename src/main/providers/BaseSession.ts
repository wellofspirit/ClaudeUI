import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  SessionCapabilities,
  SessionStatus,
  EngineId,
  ApprovalDecision,
  PermissionSuggestion
} from '../../shared/types'
import type { ISession } from './ISession'

/**
 * Abstract base class holding engine-neutral plumbing shared by all session
 * implementations (ClaudeSession, future opencode session, etc.).
 *
 * Owns:
 *  - The extraWindows static set (broadcast to remote clients)
 *  - Instance fields: win, routingId, cwd, messageHistory, inactivity timer
 *  - protected send() — IPC broadcast to win + extraWindows
 *  - getMessages() / setInactivityTimeout() — common ISession implementations
 *  - baseStatusFields() — injects engineId + capabilities into a SessionStatus object
 *
 * Subclasses must implement:
 *  - abstract readonly engineId: EngineId
 *  - abstract readonly capabilities: SessionCapabilities
 *  - All remaining ISession methods (run, interrupt, cancel, resolveApproval, etc.)
 *  - dispose() — resource teardown
 */
export abstract class BaseSession implements ISession {
  // ---------------------------------------------------------------------------
  // Static: extra broadcast windows (remote clients)
  // ---------------------------------------------------------------------------

  private static extraWindows = new Set<BrowserWindow>()

  static addExtraWindow(win: BrowserWindow): void {
    this.extraWindows.add(win)
  }

  static removeExtraWindow(win: BrowserWindow): void {
    this.extraWindows.delete(win)
  }

  static getExtraWindows(): Set<BrowserWindow> {
    return this.extraWindows
  }

  // ---------------------------------------------------------------------------
  // Instance fields
  // ---------------------------------------------------------------------------

  protected win: BrowserWindow
  /** Mutable: SessionManager.rekey() writes this when the session UUID arrives. */
  routingId: string
  readonly cwd: string
  protected messageHistory: ChatMessage[] = []
  protected inactivityTimer: ReturnType<typeof setTimeout> | null = null
  protected inactivityTimeoutMs = 15 * 60 * 1000

  constructor(routingId: string, win: BrowserWindow, cwd: string) {
    this.routingId = routingId
    this.win = win
    this.cwd = cwd
  }

  // ---------------------------------------------------------------------------
  // Abstract members — subclasses must implement
  // ---------------------------------------------------------------------------

  abstract readonly engineId: EngineId
  abstract readonly capabilities: SessionCapabilities
  abstract readonly willQueue: boolean
  abstract getSessionId(): string | null
  abstract run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void>
  abstract interrupt(): Promise<void>
  abstract cancel(): void
  abstract resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void
  abstract setModel(model: string): Promise<void>
  abstract setPermissionMode(mode: string): Promise<void>
  abstract dispose(): void

  // ---------------------------------------------------------------------------
  // Concrete shared implementations
  // ---------------------------------------------------------------------------

  getMessages(): ChatMessage[] {
    return this.messageHistory
  }

  setInactivityTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms
    if (!this.willQueue) this.resetInactivityTimer()
  }

  // ---------------------------------------------------------------------------
  // Protected helpers
  // ---------------------------------------------------------------------------

  protected resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  protected clearInactivityTimer(): void {
    // accessible from ClaudeSession.cancel()
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  /**
   * Broadcast an IPC event to the main window and all extra windows.
   * Identical semantics to the former private ClaudeSession.send().
   */
  protected send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, this.routingId, data)
    }
    for (const w of BaseSession.extraWindows) {
      if (!w.isDestroyed()) w.webContents.send(channel, this.routingId, data)
    }
  }

  /**
   * Returns the engineId + capabilities fields that every subclass must merge
   * into its SessionStatus object. Keeps status construction DRY.
   */
  protected baseStatusFields(): Pick<SessionStatus, 'engineId' | 'capabilities'> {
    return {
      engineId: this.engineId,
      capabilities: this.capabilities
    }
  }
}
