import type {
  ChatMessage,
  EngineId,
  ApprovalDecision,
  PermissionSuggestion,
  SkillInfo,
  SandboxSettings
} from '../../shared/types'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'

/**
 * Engine-neutral session interface. All methods here are implemented by
 * every backend (Claude, opencode, etc.). Engine-specific capabilities
 * (voice, MCP, background tasks, etc.) live on ClaudeSession directly and
 * are gated behind `capabilities` flags.
 */
export interface ISession {
  readonly engineId: EngineId
  readonly routingId: string
  readonly cwd: string
  readonly capabilities: ResolvedCapabilities

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

  /**
   * Set the reasoning effort variant for opencode models (e.g. 'none', 'thinking', 'low').
   * Optional — Claude and other engines that do not support per-model variants ignore it.
   * Pass null to revert to opencode's default (variant omitted from the prompt body).
   */
  setReasoningVariant?(variant: string | null): void

  // ---------------------------------------------------------------------------
  // Optional capability-gated members. Implemented by engines that advertise the
  // named capability flag (or, where noted, are Claude-only with no flag —
  // absence of the method is the gate). Callers MUST check the flag and/or use
  // optional-call (`?.`) before invoking. Mirrors the setReasoningVariant?
  // precedent above.
  // ---------------------------------------------------------------------------

  /** Background tasks (gated by capabilities.backgroundTasks). */
  watchBackground?(toolUseId: string): void
  unwatchBackground?(toolUseId: string): void
  readBackgroundRange?(toolUseId: string, offset: number, length: number): string
  stopTask?(toolUseId: string): Promise<{ success: boolean; error?: string }>
  backgroundTask?(toolUseId: string): Promise<{ success: boolean; error?: string }>

  /** Message-queue dequeue. Claude-only; no capability flag gates it — the
   *  absence of the method is the gate (opencode has no dequeue). */
  dequeueMessage?(value: string): Promise<{ removed: number }>

  /** Voice input (gated by capabilities.voice). */
  voiceStartServer?(): Promise<{ port: number }>
  voiceStopServer?(): Promise<void>
  voiceStartRecording?(language: string): Promise<void>
  voiceStopRecording?(): Promise<void>

  /** Reasoning-effort tier (gated by capabilities.reasoning.effort != null). */
  setEffort?(effort: string): void
  /** Thinking mode (gated by capabilities.reasoning.thinking != null). */
  setThinkingMode?(mode: string): void

  /** Current ExitPlanMode plan content (gated by capabilities.plan). */
  getPlanContent?(): string | null
  /** Path to this session's cli.js log. Claude-only; no capability flag. */
  getSessionLogPath?(): string | null

  /** Hosted-MCP runtime control (gated by capabilities.hostedMcp AND method
   *  presence — opencode advertises hostedMcp:true but does not host MCP). */
  mcpServerStatus?(): Promise<unknown[]>
  mcpToggleServer?(serverName: string, enabled: boolean): Promise<void>
  mcpReconnectServer?(serverName: string): Promise<void>
  mcpSetServers?(servers: Record<string, unknown>): Promise<unknown>

  /** Hot-reload settings from disk. Claude-only; no capability flag. */
  notifySettingsChanged?(): Promise<void>
  /** Live token-usage snapshot. Claude-only; no capability flag. */
  getUsage?(): Promise<Record<string, unknown> | null>

  /** Discover skills for a cwd. Implemented by ALL engines (Claude → scanSkills,
   *  opencode → discoverOpencodeSkills). Optional so callers use optional-call +
   *  scanSkills fallback for the no-active-session case. */
  discoverSkills?(cwd: string): Promise<SkillInfo[]>

  /** Update the inactivity timeout. Pass 0 to disable. */
  setInactivityTimeout(ms: number): void

  /**
   * Re-broadcast an IPC event under this session's routing (same wire shape
   * as the session's own internal `send()`). Used by cross-engine dispatch
   * (ADR-033 M2) to forward a dispatched Claude target's approval requests
   * into the dispatching opencode session's chat, from OUTSIDE the session
   * class (the opencode-hosted `dispatch_agent` tool handler has no other
   * access to the protected `send()`).
   */
  emit(channel: string, data: unknown): void

  /**
   * Current permission-mode string (Claude-style — 'default'|'plan'|
   * 'acceptEdits'|'auto'|...). Optional: only engines whose sessions are a
   * cross-engine dispatch CALLER need it (opencode, for ADR-033 M2 autonomy
   * inheritance). Claude sessions build the dispatch context inline instead
   * (see collab-tool.ts) and don't implement this.
   */
  getAutonomyMode?(): string

  /**
   * Ask a one-off question outside the main conversation history (the `/btw`
   * command). Returns the assistant's answer, or null if the engine does not
   * support the capability or encounters an error.
   */
  askSideQuestion(question: string): Promise<string | null>

  /** Tear down all resources held by this session. */
  dispose(): void
}

/**
 * Named spawn options for engine-session construction. Replaces the former
 * 11-positional-parameter factory tuple. All members are optional; engines
 * ignore options they do not consume (noted per member).
 */
export interface EngineSpawnOptions {
  /** Reasoning-effort tier. Claude-only — opencode uses per-model reasoning variants instead. */
  effort?: string
  /** Engine session id to resume. Consumed by both engines. */
  resumeSessionId?: string
  /** Initial permission mode. Consumed by both engines. */
  permissionMode?: string
  /** Model value in the engine's convention (Claude alias / opencode "vendorId/modelId"). Both engines. */
  model?: string
  /** Sandbox settings. Claude-only — opencode's permission model is ADR-022. */
  sandboxConfig?: SandboxSettings
  /** Thinking mode ('adaptive' | 'enabled' | 'disabled'). Claude-only. */
  thinkingMode?: string
  /** Transcript line uuid to resume at (branch-off anchor, ADR-010). Claude-only. */
  resumeSessionAt?: string
  /** Fork at resumeSessionAt into a new session (ADR-010). Claude-only — opencode fork is unwired (ADR-030). */
  forkSession?: boolean
}

/**
 * Factory type for engine-session construction, registered in EngineRegistry.
 * Args are the same as SessionManager.create() minus the trailing engineId.
 */
export type EngineSessionFactory = (
  routingId: string,
  win: import('electron').BrowserWindow,
  cwd: string,
  opts: EngineSpawnOptions
) => ISession
