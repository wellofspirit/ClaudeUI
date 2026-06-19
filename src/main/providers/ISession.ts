import type {
  ChatMessage,
  SessionCapabilities,
  ProviderId,
  ApprovalDecision,
  PermissionSuggestion
} from '../../shared/types'

/**
 * Provider-neutral session interface. All methods here are implemented by
 * every backend (Claude, opencode, etc.). Engine-specific capabilities
 * (voice, MCP, background tasks, etc.) live on ClaudeSession directly and
 * are gated behind `capabilities` flags.
 */
export interface ISession {
  readonly provider: ProviderId
  readonly routingId: string
  readonly cwd: string
  readonly capabilities: SessionCapabilities

  /** Whether a prompt sent now will be queued (session actively processing a turn) */
  readonly willQueue: boolean

  /** Get the backend session UUID (available after first message exchange). */
  getSessionId(): string | null

  /** Get all messages exchanged in this session. */
  getMessages(): ChatMessage[]

  /** Run a prompt turn. Passing null spawns the process without sending a message. */
  run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void>

  /** Interrupt the current turn without killing the session. */
  interrupt(): Promise<void>

  /** Cancel (tear down) the session entirely. */
  cancel(): void

  /** Resolve a pending tool-use approval. */
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void

  /** Set the model for future turns. */
  setModel(model: string): Promise<void>

  /** Set the permission mode. */
  setPermissionMode(mode: string): Promise<void>

  /** Update the inactivity timeout. Pass 0 to disable. */
  setInactivityTimeout(ms: number): void

  /** Tear down all resources held by this session. */
  dispose(): void
}

/**
 * Factory type for provider-session construction, registered in ProviderRegistry.
 * Args are the same as SessionManager.create() minus the leading providerId.
 */
export type ProviderSessionFactory = (
  routingId: string,
  win: import('electron').BrowserWindow,
  cwd: string,
  effort?: string,
  resumeSessionId?: string,
  permissionMode?: string,
  model?: string,
  sandboxConfig?: import('../../shared/types').SandboxSettings,
  thinkingMode?: string,
  resumeSessionAt?: string,
  forkSession?: boolean
) => ISession
