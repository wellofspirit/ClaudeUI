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
  DirectoryGroup,
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
  SubagentMessageBatchData,
  SubagentMessageData,
  SubagentToolResultData,
  TaskNotification,
  TaskProgress,
  TaskStartedData,
  TodoItem,
  ToolResultImage,
  ToolReviewBlock,
  FileDiff,
  UISessionConfig,
  WatchUpdate
} from '../../../shared/types'
import type { ItemStreamOpen, ItemStreamSeal } from './item-stream'

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
  'session:item-open': (routingId: string, data: ItemStreamOpen) => void
  'session:item-seal': (routingId: string, data: ItemStreamSeal) => void
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
      /**
       * Fork/branch anchor — a JSONL line uuid (Claude) the resumed transcript is
       * TRUNCATED at, inclusive. Every client that reads that transcript for
       * itself must cut at the same line the engine did.
       */
      resumeSessionAt?: string
      permissionMode?: PermissionMode
      engineId?: EngineId
      model?: string
    }
  ) => void
  /**
   * A session was explicitly DELETED (one session, or one of the sessions a
   * project delete sweeps). Payload-free: the id is the whole fact.
   *
   * Emitted by `SyncCore.removeSession` on both surfaces, after the live session
   * is cancelled and before its files are unlinked. The reducer drops the entry
   * AND every id-keyed app-level row, which is what stops a deleted session from
   * coming back as a dangling sidebar title/pin on a client that did not delete it.
   */
  'session:removed': (routingId: string) => void
  /**
   * "Start fresh": the session's conversation was reset in place (transcript,
   * streams, todos, queue, tasks, subagents, per-session config), keeping its
   * cwd and its `sdkActive` flag.
   *
   * `permissionMode` is the mode a fresh RUN starts in, resolved by the client
   * that asked (it needs `availableModels` + the auto-mode gate, which the
   * reducer cannot see) and validated by the emitter.
   */
  'session:conversation-cleared': (
    routingId: string,
    data: { permissionMode?: PermissionMode }
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
  /** Refusal-fallback retraction (docs/protocol-cc/04-system-subtypes.md §4.20). */
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
  /**
   * A permission judge's verdict on the tool call it judged (F18). Shaped like
   * `session:tool-result` for the same reason: it is a block that attaches to an
   * assistant message that ALREADY exists. The producer is responsible for
   * holding it until the `tool_use` has landed — the reducer drops a verdict it
   * cannot bind rather than minting a message for it.
   */
  'session:tool-review': (
    routingId: string,
    data: { toolUseId: string; review: ToolReviewBlock }
  ) => void
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
  /**
   * A credential the session needs was rejected and cannot be renewed
   * (ADR-068 §4) — the ONE auth event, from every engine that can tell a
   * rejected credential apart. Codex raises it when it cannot answer the
   * app-server's `account/chatgptAuthTokens/refresh`, opencode for a
   * `ProviderAuthError` carrying a vendor, Claude for an `authentication`
   * api_error, and pi for a turn whose `errorMessage` opens with a 401/403 (the
   * only status it exposes — see `core/pi/event-mapper.ts`'s classifier).
   *
   * `providerId` is what the sign-in dialog acts on: `anthropic`, `chatgpt`, or
   * `opencode:<vendorId>` / `pi:<vendorId>` for a vendor no shared provider owns
   * (those have no flow, so the row opens Settings › Models & providers
   * instead).
   *
   * **`message` is the emitting engine's verbatim words, and emitting a
   * companion `session:error` alongside this event is FORBIDDEN** (ADR-070 §1).
   * This comment used to say the opposite — "it carries no message, the emitting
   * engine sends its own words as `session:error`" — and that sanction is
   * precisely how ADR-068 §4's "one event, one card" shipped as one event and
   * several independently-dismissable cards. The information-preservation
   * instinct was right and the delivery was wrong: the text rides here, and the
   * row discloses it in place. A guard test per engine pins the absence of the
   * duplicate. Every engine ALSO puts the same text in the transcript as an
   * `api_error` / `errorType: 'authentication'` block, so the failure has a
   * permanent, correctly-anchored home rather than a card that vanishes.
   */
  'session:auth-required': (
    routingId: string,
    data: { providerId: string; accountId?: string; message?: string }
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
  /**
   * The merged sidebar listing (claude + opencode + pi), applied as a REPLACE.
   *
   * Was payload-less — a "refetch now" every client answered with its own
   * three-query merge, which is exactly why canonical (claude-only) and the
   * clients disagreed. `directories` is optional so an OLD-shape event replays as
   * the no-op notify it used to be rather than blanking the list.
   */
  'session:directories-changed': (directories?: DirectoryGroup[]) => void
  'config:settings-changed': (settings: Record<string, unknown>) => void
  'config:sessions-changed': (config: UISessionConfig) => void
  'git:status-update': (data: { cwd: string; status: GitStatusData }) => void
  'mockup:file-changed': (directory: string) => void
  'usage:data': (data: AccountUsage) => void
  'usage:block-data': (data: BlockUsageData) => void
  /**
   * Per-account ChatGPT rate limits changed (ADR-068 §2) — a live session pushed
   * an `account/rateLimits/updated`, or a panel-driven read finished. Deliberately
   * PAYLOAD-FREE: clients re-query `usage:chatgpt-limits`, so the map has exactly
   * one shape and one owner.
   */
  'usage:chatgpt-limits-changed': () => void
  /**
   * A credential for `providerId` was successfully stored — the ONE resolution
   * signal (ADR-070 §2). Before it, nothing in the app meant "this provider's
   * credential is good now", so every auth surface invented its own clear
   * condition and none of them was "the user signed in".
   *
   * APP-LEVEL on purpose: it is a fact about a PROVIDER, not about a session, so
   * it carries no routingId. The reducer fans it across every session whose
   * `authRequired.providerId` matches and marks them resolved — one fold, so a
   * desktop sign-in clears the owed sign-in on the phone too.
   *
   * Emitted by Anthropic's own success transition (`AuthManager.finalize`) and
   * by the vault's one post-completion tail
   * (`CredentialSync.applyCompletedLogin`, which covers the desktop loopback,
   * the ADR-057 paste-back and the device-code flow alike).
   */
  'provider:auth-resolved': (data: { providerId: string }) => void

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
