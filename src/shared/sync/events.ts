/**
 * The typed subscription surface for replicated + volatile channels —
 * SyncCore phase 4c (ADR-051).
 *
 * These signatures used to live on `ClaudeAPI` as ~45 `onFoo(cb)` members that
 * the preload implemented with `ipcRenderer.on` and the web `api-adapter`
 * re-implemented with `connection.on`. That was ADR-008's hand-maintained mirror:
 * two implementations of one contract, kept honest only by a typecheck of the
 * SIGNATURES. Both clients read the same {@link SyncClient} now, so there is one
 * implementation — and this map is what keeps it typed.
 *
 * Keys are the wire channel names (`src/shared/sync/channels.ts`); values are the
 * listener shape, with the positional args the funnel emits (`args[0]` is the
 * routing id for every session-scoped channel — sync-core.md §"Wire encoding").
 *
 * A channel that is CLASSIFIED but has no entry here is simply one no client
 * subscribes to; the funnel guard checks the other direction (nothing subscribes
 * to an unclassified channel).
 *
 * Host-local channels are deliberately absent: they are per-transport by nature
 * (a web client has no window chrome, no microphone, no local OAuth browser) and
 * stay on `window.api.onFoo`.
 */

import type {
  Automation,
  AutomationRun,
  AccountUsage,
  BashOutputData,
  BackgroundOutput,
  BlockUsageData,
  ChatMessage,
  EngineId,
  GitStatusData,
  MeteringSnapshot,
  PendingApproval,
  PermissionMode,
  QueuedItem,
  SessionResult,
  SessionStatus,
  SlashCommandInfo,
  StatusLineData,
  StreamDelta,
  SubagentMessageBatchData,
  SubagentMessageData,
  SubagentStreamDelta,
  SubagentToolResultData,
  TaskNotification,
  TaskProgress,
  TaskStartedData,
  TodoItem,
  ToolResultImage,
  FileDiff,
  UISessionConfig,
  WatchUpdate
} from '../types'

/** Attachment shape as it rides `session:user-message` / a queued item. */
export interface WireAttachment {
  mediaType: string
  base64Data: string
  fileName?: string
}

export interface SyncEventMap {
  // -------------------------------------------------------------------------
  // Session lifecycle + transcript
  // -------------------------------------------------------------------------
  /**
   * A session was spawned. The payload carries the config it spawned WITH
   * (`prepareAndCreateSession`): `permissionMode`, `engineId` and the RESOLVED
   * `model`. They are optional because they are a post-phase-4 payload addition —
   * a client talking to an older host, or a replay of a committed fixture, sees
   * the `{cwd, resumeSessionId}` shape, and the reducer falls back to the existing
   * session values for every absent field. Before the addition, every client
   * except the originator (and canonical itself, hence every snapshot) folded
   * `emptySession()`'s default/claude/default over the session's real config.
   *
   * `effort` / `thinkingMode` are NOT here on purpose: the spawn args carrying
   * them are already resolved model defaults, whereas the canonical fields mean
   * "explicitly picked" — see the emit site's note.
   */
  'session:created': (
    routingId: string,
    data: {
      cwd: string
      resumeSessionId?: string
      permissionMode?: PermissionMode
      engineId?: EngineId
      model?: string
    }
  ) => void
  /**
   * Relayed for NON-queued sends only. A send that queues rides
   * `session:queue-changed` instead (ADR-053) — the old `{queued:true}` flavor is
   * retired.
   *
   * `id`/`timestamp` are minted by the EMITTER (SyncCore phase 4b) so every
   * replica agrees on the transcript's identity; they are optional because a
   * client may still be running against an older host that omits them, in which
   * case the reducer falls back to a positional id.
   */
  'session:user-message': (
    routingId: string,
    data: {
      id?: string
      timestamp?: number
      prompt: string
      attachments?: WireAttachment[]
    }
  ) => void
  'session:message': (routingId: string, msg: ChatMessage) => void
  /** Refusal-fallback retraction (docs/protocol/04-system-subtypes.md §4.20). */
  'session:messages-retracted': (routingId: string, data: { messageIds: string[] }) => void
  'session:tool-result': (
    routingId: string,
    data: {
      toolUseId: string
      result: string
      isError: boolean
      fileDiffs?: FileDiff[]
      /** Images the tool returned (see ToolResultImage). Omitted when there are none. */
      images?: ToolResultImage[]
    }
  ) => void
  'session:stream': (routingId: string, delta: StreamDelta) => void
  'session:status': (routingId: string, status: SessionStatus) => void
  'session:result': (routingId: string, result: SessionResult) => void

  // -------------------------------------------------------------------------
  // Approvals (ADR-038 — event-driven ONLY)
  // -------------------------------------------------------------------------
  'session:approval-request': (routingId: string, approval: PendingApproval) => void
  /** Externally-resolved approval (opencode's deny-cascade, ADR-033). */
  'session:approval-dismiss': (routingId: string, data: { requestId: string }) => void

  // -------------------------------------------------------------------------
  // Tasks + subagents
  // -------------------------------------------------------------------------
  'session:task-progress': (routingId: string, data: TaskProgress) => void
  'session:task-notification': (routingId: string, data: TaskNotification) => void
  /** Task exists and is running — see TaskStartedData for why this is needed. */
  'session:task-started': (routingId: string, data: TaskStartedData) => void
  'session:subagent-stream': (routingId: string, data: SubagentStreamDelta) => void
  'session:subagent-message': (routingId: string, data: SubagentMessageData) => void
  'session:subagent-message-batch': (routingId: string, data: SubagentMessageBatchData) => void
  'session:subagent-tool-result': (routingId: string, data: SubagentToolResultData) => void

  // -------------------------------------------------------------------------
  // Queue of record (ADR-053)
  // -------------------------------------------------------------------------
  /** Full queue list for a session — idempotent and replay-safe. */
  'session:queue-changed': (routingId: string, data: { items: QueuedItem[] }) => void

  // -------------------------------------------------------------------------
  // Per-session config
  // -------------------------------------------------------------------------
  'session:permission-mode': (routingId: string, mode: PermissionMode) => void
  /**
   * Per-session config replication (SyncCore phase 4a). A PARTIAL patch: only the
   * fields the setter changed are present, and each is a replace. Emitted
   * pre-spawn too — before this, a model pick on one client was invisible to every
   * other (docs/architecture/remote.md defect 1).
   */
  'session:config-changed': (
    routingId: string,
    patch: {
      model?: string
      effort?: string
      thinkingMode?: string
      reasoningVariant?: string | null
    }
  ) => void
  'session:status-line': (routingId: string, data: StatusLineData) => void
  /** Engine-neutral metering snapshot (Phase 7 Pass 2), alongside status-line. */
  'session:metering': (routingId: string, data: MeteringSnapshot) => void
  'session:plan': (routingId: string, todos: TodoItem[]) => void

  // -------------------------------------------------------------------------
  // Catalogs + diagnostics
  // -------------------------------------------------------------------------
  'session:slash-commands': (routingId: string, commands: SlashCommandInfo[]) => void
  'session:skills': (routingId: string, names: string[]) => void
  'session:mcp-servers': (
    routingId: string,
    servers: Array<{ name: string; status: string }>
  ) => void
  'session:error': (routingId: string, error: string) => void
  'session:warning': (routingId: string, warning: string) => void
  'session:sandbox-violation': (routingId: string, message: string) => void
  'session:vendor-auth-required': (
    routingId: string,
    data: { vendorId: string; message: string }
  ) => void
  /**
   * Login status from session init: 'authenticated' | 'none'. The
   * oauth-vs-api-key distinction lives only in the auth probe's billingType
   * (ADR-014 / ADR-021).
   */
  'session:auth-source': (routingId: string, source: string) => void

  // -------------------------------------------------------------------------
  // Volatile lane (phase 5 separates these out)
  // -------------------------------------------------------------------------
  'session:bash-output': (routingId: string, data: BashOutputData) => void
  'session:background-output': (routingId: string, data: BackgroundOutput) => void

  // -------------------------------------------------------------------------
  // Watched sessions + app config
  // -------------------------------------------------------------------------
  'session:watch-update': (data: WatchUpdate) => void
  /** A payload-less notify: the sidebar refetches via `session:list-directories`. */
  'session:directories-changed': () => void
  'config:settings-changed': (settings: Record<string, unknown>) => void
  'config:sessions-changed': (config: UISessionConfig) => void
  'git:status-update': (data: { cwd: string; status: GitStatusData }) => void
  'mockup:file-changed': (directory: string) => void
  'usage:data': (data: AccountUsage) => void
  'usage:block-data': (data: BlockUsageData) => void

  // -------------------------------------------------------------------------
  // Automation
  // -------------------------------------------------------------------------
  'automation:changed': (automations: Automation[]) => void
  'automation:run-update': (data: { automationId: string; run: AutomationRun }) => void
  'automation:run-message': (data: { automationId: string; message: ChatMessage }) => void
  'automation:stream-event': (data: { automationId: string; type: string; text: string }) => void
  'automation:processing': (data: { automationId: string; isProcessing: boolean }) => void

  // -------------------------------------------------------------------------
  // Anomaly, recorded not fixed
  // -------------------------------------------------------------------------
  /**
   * `voice:error` is host-local in nature but ONE of its two emitters is
   * `BaseSession.send`, so it rings and reaches every subscriber. Kept in this map
   * for the sync path; the desktop's `window.api.onVoiceError` is gone with the
   * per-channel preload surface, so BOTH emitters land here.
   */
  'voice:error': (routingId: string, error: string) => void
}

/** Every channel a client may subscribe to through the sync transport. */
export type SyncChannel = keyof SyncEventMap
