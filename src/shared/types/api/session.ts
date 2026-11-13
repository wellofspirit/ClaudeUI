import type {
  HarnessId,
  HarnessInstallCancelResult,
  HarnessInstallResult,
  HarnessSelection,
  HarnessStateEntry,
  HarnessStateSnapshot,
  HarnessUpdateMode,
  HarnessUpdatesView,
  HarnessUpgradePromptView,
  HarnessVersionsResult
} from '../../harness-types'
import type { InvokeProgress } from '../../remote-protocol'
import type { ActiveTask, SubagentIndexEntry, TaskNotification } from '../tasks'
import type {
  AgentTypeInfo,
  OpencodeAgentDetail,
  OpencodeAgentInput,
  OpencodeAgentScope,
  OpencodeAgentSummary,
  OpencodeCatalogModel,
  OpencodeConfigSettings,
  OpencodeNativeRaw,
  OpencodeProviderCatalogEntry,
  PiModelsRaw,
  PiNativeRaw,
  ProviderRemoveKind,
  RawConfigPatch
} from '../opencode'
import type { ApprovalDecision, PermissionSuggestion } from '../approvals'
import type { AttachmentUpload, ChatMessage } from '../content'
import type { DirectoryGroup } from '../files'
import type {
  EngineConfig,
  JudgeModelSupport,
  ProxySettings,
  SharedAutoModeConfig,
  VendorConfig
} from '../engine-config'
import type {
  EngineHistoryLoad,
  ForkAnchorResult,
  LoadSessionHistoryOptions,
  SessionInfo,
  StatusLineData
} from '../session'
import type { EngineId } from '../engine'
import type { SessionSpawnRequest } from '../session-config'
import type { EngineModelGroup, ModelInfo } from '../models'
import type { SkillInfo } from '../skills'
import type { SlashCommandInfo, UISessionConfig } from '../ui'

export interface SessionAPI {
  platform: string
  /**
   * True only when this launch opted into the verifier hooks
   * (`CLAUDEUI_VERIFIER_HOOKS=1` / `--claudeui-verifier-hooks`), which is what
   * makes the renderer publish `window.__claudeuiVerifier`. False on the web
   * client, always. See `src/shared/verifier-hooks.ts`.
   */
  verifierHooks: boolean
  pickFolder(): Promise<string | null>
  /**
   * Start (or resume) an engine session for a routing id. `SessionSpawnRequest` documents the
   * fields; `announce` is what every replica adopts as the session's OWN on the birth event
   * (`session:created`), so a replica shows what the process runs. `announce.effort` has
   * three states: a string = announce the effort the process is spawned with
   * (`config.effort`); `null` = the model is KNOWN to take none (clears); absent = the model
   * is unknown to this client (empty or failed catalog), announce nothing so no replica
   * loses a pick. `thinkingMode` is the raw pick (`null` = no pick).
   */
  createSession(routingId: string, request: SessionSpawnRequest): Promise<void>
  /**
   * `rekeySession` was DELETED in SyncCore phase 4c. Core owns the rekey: it
   * applies `rekeyTargetFor` to canonical state and re-keys its own session
   * registry in the same tick it emits the `session:status` that implies one, so a
   * client telling main to rekey was a client racing the authority. The main-side
   * `session:rekey` handler SURVIVES as a shim for cached phone bundles that still
   * invoke it (it logs and applies a rekey core did not own).
   */
  /** Resolve the fork ("branch off") anchor for an engine session. Claude:
   *  `messageId` (the renderer's ChatMessage.id) resolves to a JSONL line
   *  uuid; `messageIndex` is unused. pi: no stable id exists, so `messageIndex`
   *  (the message's position in the store's `messages` array) resolves to a
   *  pi entryId (or the clone-latest sentinel) instead; `messageId` is unused.
   *  Returns { anchorUuid: null, reason } on failure. */
  resolveForkAnchor(
    sessionId: string,
    cwd: string,
    messageId: string,
    engineId: EngineId,
    messageIndex: number
  ): Promise<ForkAnchorResult>
  sendPrompt(routingId: string, prompt: string, attachments?: AttachmentUpload[]): Promise<void>
  cancelSession(routingId: string): Promise<void>
  /**
   * Reset a session's conversation in place ("start fresh"). Emits the
   * replicated `session:conversation-cleared`; `permissionMode` is the mode a
   * fresh RUN starts in, which only a client can resolve.
   */
  clearConversation(routingId: string, permissionMode?: string): Promise<void>
  interruptSession(routingId: string): Promise<void>
  respondApproval(
    routingId: string,
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): Promise<void>
  /**
   * Approve an auto-mode block after the fact (ADR-091 part 6): the host grants
   * the next identical call once (pi, opencode, their dispatch targets), marks
   * the review approved, and sends the agent a user prompt to run it again.
   * An unknown or already-approved `toolUseId` is a no-op.
   */
  approveBlocked(routingId: string, toolUseId: string): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  /** Fetch the global opencode session list (all cwds). Best-effort: returns [] on error. */
  listOpencodeSessionsGlobal(): Promise<SessionInfo[]>
  /** Load a persisted opencode session's transcript and status line (read-only,
   *  for painting history on sidebar click). Best-effort: returns no messages
   *  and a null status line on error. */
  loadOpencodeHistory(sessionId: string): Promise<EngineHistoryLoad>
  /** Fetch the global pi session list (all cwds, read from ~/.pi/agent/sessions).
   *  Best-effort: returns [] on error. */
  listPiSessionsGlobal(): Promise<SessionInfo[]>
  /** Load a persisted pi session's transcript and status line (read-only,
   *  for painting history on sidebar click). Best-effort: returns no messages
   *  and a null status line on error. */
  loadPiHistory(sessionId: string): Promise<EngineHistoryLoad>
  loadSessionHistory(
    sessionId: string,
    projectKey: string,
    /**
     * Fork/branch anchor (a JSONL line uuid) to TRUNCATE the load at, inclusive
     * — the value the session was resumed with. Omit to load the whole file.
     */
    resumeSessionAt?: string,
    /**
     * Progress of the read (ADR-102): byte-based and Claude-only (other engines
     * report nothing, so a caller shows an indeterminate bar). Frames arrive
     * throttled; see the planning contract on `loadSessionHistory` in
     * `core/services/session-history.ts`. With the callback omitted this is the
     * plain, non-streaming invoke.
     */
    onProgress?: (progress: InvokeProgress) => void,
    /**
     * Claude only (ADR-102 Arc 2). `deferStatusLine: true` returns the transcript
     * WITHOUT the cost/token pass: `statusLine` is `null` and the progress plan is
     * the transcript pass alone. The status line then comes from
     * {@link loadSessionStatusLine}. Anything but a literal `true` is ignored.
     */
    options?: LoadSessionHistoryOptions
  ): Promise<{
    messages: ChatMessage[]
    taskNotifications: TaskNotification[]
    customTitle: string | null
    agentIdToToolUseId: Record<string, string>
    statusLine: StatusLineData | null
    taskPrompts: Record<string, string>
    warnings: string[]
    /**
     * Subagent transcripts the reader already resolved, by PARENT tool_use id.
     * opencode's and pi's readers return them inline; Claude's live in per-agent
     * JSONL files and are fetched separately through {@link loadSubagentHistory}.
     */
    subagentMessages?: Record<string, ChatMessage[]>
    /**
     * The X-Agents of this session that are running now (ADR-105 §5): their task
     * records, which no transcript holds. Keyed by the launching tool_use id.
     */
    activeTasks?: Record<string, ActiveTask>
    /**
     * Claude only: every subagent the main transcript (or a sidecar) mapped to
     * an origin tool_use id, by that id. Sizes, ordering and names for the
     * client's per-agent fetches; the transcripts themselves are fetched through
     * {@link loadSubagentHistory}.
     */
    subagentIndex?: Record<string, SubagentIndexEntry>
    /**
     * Claude only: mtime (ms) of the main transcript when the read STARTED, so
     * a cache keyed on it can never claim a state newer than what was read.
     */
    transcriptMtimeMs?: number
  }>
  /**
   * Claude only: the status line (cost, tokens, context) of a transcript — the
   * pass `loadSessionHistory` skips under `deferStatusLine`, with the SAME result
   * the full read would have carried. Progress is `M + S` bytes (main transcript
   * + every subagent file), phase `costs`. Always the whole transcript: no fork
   * anchor, so anchored callers stay on the full read.
   */
  loadSessionStatusLine(
    sessionId: string,
    projectKey: string,
    onProgress?: (progress: InvokeProgress) => void
  ): Promise<StatusLineData>
  loadSubagentHistory(
    sessionId: string,
    projectKey: string,
    agentId: string
  ): Promise<ChatMessage[]>
  /**
   * The bytes behind a {@link BlobRef} (`blob:get`, ADR-087). `null` for an
   * unknown, evicted or malformed id — a legal answer the caller renders as
   * "unavailable".
   */
  getBlob(blobId: string): Promise<{ mediaType: string; base64Data: string } | null>
  buildSubagentFileMap(
    sessionId: string,
    projectKey: string,
    taskPrompts: Record<string, string>
  ): Promise<Record<string, string>>
  loadBackgroundOutput(
    projectKey: string,
    taskId: string,
    outputFile?: string
  ): Promise<{ content: string | null; purged: boolean }>
  /**
   * Ask the host for this client's sync transport (SyncCore phase 4c).
   *
   * Desktop: the preload is holding a `MessagePort` from main and forwards it into
   * the main world with `window.postMessage` (a port is not a type
   * `contextBridge` can marshal). Call it AFTER installing the `message` listener
   * — see `renderer/src/sync/desktop-transport.ts`.
   *
   * Web: a no-op. The WebSocket connection is constructed before `window.api`
   * exists and installs its own client, so there is nothing to acquire. Present on
   * both transports so the renderer has one call site.
   *
   * Replicated and volatile events arrive on that transport, subscribed to with
   * `shared/sync/client-registry.onSyncEvent` and typed by `SyncEventMap`. The
   * `onFoo` members that remain on this interface are HOST-LOCAL only.
   */
  acquireSyncPort(): void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  watchBackground(routingId: string, toolUseId: string): Promise<void>
  unwatchBackground(routingId: string, toolUseId: string): Promise<void>
  readBackgroundRange(
    routingId: string,
    toolUseId: string,
    offset: number,
    length: number
  ): Promise<string>
  /** `isDispatch` marks a cross-engine dispatch card's stop (ADR-033 M3):
   *  the handler routes it to the dispatcher with a durable stop-intent
   *  (armIfUnknown) instead of ever falling through to the session path —
   *  the renderer can show "running" before dispatch() is even invoked. */
  stopTask(
    routingId: string,
    toolUseId: string,
    isDispatch?: boolean
  ): Promise<{ success: boolean; error?: string }>
  backgroundTask(
    routingId: string,
    toolUseId: string
  ): Promise<{ success: boolean; error?: string }>
  /**
   * @deprecated ADR-053 — superseded by {@link ClaudeAPI.recallQueued}. Kept so a
   * `/remote` bundle cached in a phone browser still takes messages back; the
   * host ignores `value` and recalls everything, reporting the count as `removed`.
   */
  dequeueMessage(routingId: string, value: string): Promise<{ removed: number }>
  /**
   * Stop Claude Code holding messages other Claude sessions send this one
   * (`crossSessionInbound: 'accept'` on this process); the ones it holds are
   * delivered. Claude only.
   */
  allowPeerMessages(routingId: string): Promise<{ success: boolean; error?: string }>
  /**
   * "Add to group" (`true`) and "Detach from group" (`false`) on a session that was
   * started from, or handed off from, another (slices 1b and 5): the link stays (it is
   * the lineage), only whether the sidebar shows the pair as one group changes, on
   * every client. The id is the started session's.
   */
  setSessionGrouped(
    routingId: string,
    grouped: boolean
  ): Promise<{ success: boolean; error?: string }>
  /**
   * The Start buttons on a session proposal card (slice 1c-b, slice 5): start the
   * proposed session exactly as shown, as the user's own act. `grouped` is which button:
   * true joins the proposing session's group, false is standalone work; absent, the
   * proposal's own relation decides. `startedRef` names the new session.
   */
  startSessionProposal(
    proposalId: string,
    grouped?: boolean
  ): Promise<{ success: boolean; error?: string; startedRef?: string }>
  /** The Dismiss button on a proposal card. */
  dismissSessionProposal(proposalId: string): Promise<{ success: boolean; error?: string }>
  /**
   * The user's answer to a session's context-pressure banner (slice 4): `handoff` tells the
   * session to wrap up and hand off, `dismiss` is "Not now". Either clears the banner on
   * every client.
   */
  respondContextPressure(
    routingId: string,
    answer: 'handoff' | 'dismiss'
  ): Promise<{ success: boolean; error?: string }>
  /**
   * Take back every still-recallable queued item (ADR-053). `recalled` carries
   * their texts in queue order for the client to join with `\n`; `notRecalled`
   * counts items the engine had already started consuming — those stay on the
   * card until their `consumed` transition arrives.
   */
  recallQueued(routingId: string): Promise<{ recalled: string[]; notRecalled: number }>
  askSideQuestion(routingId: string, question: string): Promise<string | null>
  setPermissionMode(routingId: string, mode: string): Promise<void>
  setModel(routingId: string, model: string): Promise<void>
  setEffort(routingId: string, effort: string): Promise<void>
  setThinkingMode(routingId: string, mode: string): Promise<void>
  setReasoningVariant(routingId: string, variant: string | null): Promise<void>
  getModels(): Promise<ModelInfo[]>
  /**
   * The model catalog as engine groups: with `engineId`, only that engine's
   * groups (and only its probe runs); without, every engine's in one reply that
   * waits for the slowest probe. Rejects an unknown engine id.
   */
  getEngineModels(engineId?: EngineId): Promise<EngineModelGroup[]>
  /**
   * For each judge-picker value, whether ClaudeUI can call that model for the
   * engine's auto-mode judge (ADR-081 §3), and if not, why. Token-free: it
   * checks credentials for presence and never fetches or refreshes one.
   */
  judgeModelSupport(
    engineId: 'opencode' | 'pi',
    values: string[]
  ): Promise<Record<string, JudgeModelSupport>>
  /**
   * Whether the route a judge model would take is resting after a rate limit
   * (`judge-cooldown.ts`, process-wide, per provider+model+account): the epoch
   * ms it recovers at, else null — also null for a model or account ClaudeUI
   * cannot route. `accountId` is a ChatGPT vault account id
   * (`AutoModeConfig.fallbackJudgeAccount`); absent → the active account.
   * Token-free: it resolves the route and returns only the time.
   */
  judgeRouteResting(
    engineId: 'opencode' | 'pi',
    model: string,
    accountId?: string
  ): Promise<{ until: number } | null>
  /** Full opencode provider catalog (~146 providers) for the settings provider manager.
   *  Returns [] when opencode isn't installed or discovery fails. */
  getOpencodeProviders(): Promise<OpencodeProviderCatalogEntry[]>
  /** Toggle opencode's `disabled_providers` veto. Reversible; destroys nothing. */
  setOpencodeProviderDisabled(providerId: string, disabled: boolean): Promise<void>
  /**
   * Destructive: deletes the credential and/or provider declaration ClaudeUI owns,
   * then clears the id from `disabled_providers` and the model allowlist. Settings-only
   * removal clears those entries without deleting credentials or declarations. Pass the
   * `removeKind` from the entry's resolved `actions` — never a widened value.
   */
  removeOpencodeProvider(providerId: string, kind: ProviderRemoveKind): Promise<void>
  /** All catalog models for a single opencode provider (for the model-allowlist dialog). */
  getOpencodeProviderModels(providerId: string): Promise<OpencodeCatalogModel[]>
  /** Unfiltered authenticated pi catalog for the model-allowlist dialog. */
  getPiModelCatalogGroups(): Promise<EngineModelGroup[]>
  /** Deterministic "is this engine installed?" check (binary on disk). Does NOT
   *  spawn a server, so transient runtime failures can't read as "not installed". */
  engineIsInstalled(engineId: EngineId): Promise<boolean>
  // ── Harness manager (ADR-082 arc 2; `core/ipc/harness-commands.ts`) ──
  // Reads are `config`; every write is `admin` (§7), so a base remote
  // connection is refused them. Live updates arrive as the `harness:changed`
  // and `harness:install-progress` sync events (`onSyncEvent`).
  /** Every harness: manifest, selection, resolver answer, detection, store. No probes. */
  harnessState(): Promise<HarnessStateSnapshot>
  /** Upstream releases for the version dropdown (network, cached for an hour). */
  harnessVersions(id: HarnessId): Promise<HarnessVersionsResult>
  /** Save a harness's source; running sessions keep their binary. Throws on an invalid choice. */
  setHarnessSelection(id: HarnessId, selection: HarnessSelection): Promise<HarnessStateEntry>
  /** Install into ClaudeUI's store; resolves when the install finishes. */
  installHarness(id: HarnessId, version: string): Promise<HarnessInstallResult>
  /** Abort an in-flight `installHarness` for this harness and version. */
  cancelHarnessInstall(id: HarnessId, version: string): Promise<HarnessInstallCancelResult>
  /** Re-detect System installs (all harnesses when omitted); resolves with the new state. */
  detectHarnesses(ids?: HarnessId[]): Promise<HarnessStateSnapshot>
  /** Install updates: Automatically | Ask me (ADR-082 §6). Answers the updates view. */
  setHarnessUpdateMode(mode: HarnessUpdateMode): Promise<HarnessUpdatesView>
  /** Install every available harness update; resolves with the state once the run ends. */
  updateHarnesses(): Promise<HarnessStateSnapshot>
  /** Ask upstream for new versions now; resolves with the new state. */
  checkHarnessUpdates(): Promise<HarnessStateSnapshot>
  /** Answer the one-time upgrade sheet (ADR-082 §8): it does not come back. */
  answerHarnessUpgradePrompt(): Promise<HarnessUpgradePromptView>
  generateTitle(conversationText: string): Promise<string | null>
  generateCommitMessage(diff: string): Promise<string | null>
  writeCustomTitle(sessionId: string, projectKey: string, title: string): Promise<void>
  getPlanContent(routingId: string): Promise<string | null>
  getSessionLogPath(routingId: string): Promise<string | null>
  watchSession(
    routingId: string,
    sessionId: string,
    projectKey: string,
    /** Optional only for old clients — see `services/session-watcher.ts`. */
    cwd?: string
  ): Promise<void>
  unwatchSession(routingId: string): Promise<void>
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
  loadSessionConfig(): Promise<UISessionConfig>
  saveSessionConfig(config: UISessionConfig): Promise<void>
  /** Permanently delete a session's JSONL + subagent directory from disk (claude), or via HTTP API (opencode) */
  deleteSession(sessionId: string, projectKey: string, engineId?: EngineId): Promise<void>
  /** Permanently delete an entire Claude project directory (all sessions) from disk */
  deleteProject(projectKey: string): Promise<void>
  loadSlashCommands(): Promise<SlashCommandInfo[]>
  saveSlashCommands(commands: SlashCommandInfo[]): Promise<void>
  /** The session's own skills (its engine's plus the shared catalog); catalog for `cwd` with no live session. */
  loadSkillDetails(routingId: string | null, cwd: string): Promise<SkillInfo[]>
  onBeforeQuit(cb: () => void): () => void
  /**
   * Confirm the quit. `removeWorktreePaths`: worktree directories to delete AFTER the
   * app's sessions, terminals and engines are torn down (their cwd locks released) and
   * before it exits; the quit may take a moment. Desktop only; a no-op on the web client.
   */
  confirmQuit(removeWorktreePaths?: string[]): Promise<void>
  /** Cancel a pending quit prompt: clears the fallback timer, leaves services running. */
  cancelQuit(): Promise<void>
  /**
   * The quit modal is on screen: main stops its short fallback timer (which force-quits if the
   * renderer never answers) so the user can take as long as they need. A renderer that never
   * calls this still hits the fallback. Desktop only; a no-op on the web client.
   */
  ackQuitPrompt(): Promise<void>
  testProxyConnection(
    proxy: ProxySettings
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }>
  loadEngineConfig(engineId: string): Promise<EngineConfig>
  saveEngineConfig(engineId: string, config: EngineConfig): Promise<void>
  loadVendorConfig(vendorId: string): Promise<VendorConfig>
  saveVendorConfig(vendorId: string, config: VendorConfig): Promise<void>
  /** The engine-shared classifier trust lists (`~/.claude/ui/automode.json`). */
  loadSharedAutoMode(): Promise<SharedAutoModeConfig>
  /** Replaces the shared trust lists wholesale; an empty list is stored absent. */
  saveSharedAutoMode(config: SharedAutoModeConfig): Promise<void>
  /** Load opencode's engine-native config from opencode's own global config file. */
  loadOpencodeSettings(): Promise<OpencodeConfigSettings>
  /** Save opencode's engine-native config to opencode's own global config file. */
  /** `base`: the snapshot the caller edited — only its changes relative to it are written. */
  saveOpencodeSettings(
    settings: OpencodeConfigSettings,
    base?: OpencodeConfigSettings
  ): Promise<void>
  /** Read opencode's config file verbatim (no projection) for the schema-driven editor. */
  readOpencodeNativeRaw(): Promise<OpencodeNativeRaw>
  /** Apply leaf patches to opencode's config file, preserving comments + siblings. */
  patchOpencodeNative(patches: RawConfigPatch[]): Promise<void>
  /** Switch an opencode 2.x built-in tool off (top-level `{action,*,deny}`) or back on. */
  setOpencodeToolDisabled(action: string, disabled: boolean): Promise<void>
  /** Read pi's global settings.json verbatim for the curated pi Configuration panes. */
  readPiNativeRaw(): Promise<PiNativeRaw>
  /** Apply leaf patches to pi's global settings.json, preserving siblings + formatting. */
  patchPiNative(patches: RawConfigPatch[]): Promise<void>
  /** Replace pi's global settings.json with `text` verbatim (Raw config pane). */
  writePiNativeText(text: string): Promise<void>
  /** Read pi's models.json verbatim, plus the ids the shared-provider projection owns. */
  readPiModelsRaw(): Promise<PiModelsRaw>
  /** Apply leaf patches to pi's models.json; refuses projection-owned provider entries. */
  patchPiModels(patches: RawConfigPatch[]): Promise<void>
  /**
   * One provider's ClaudeUI model allowlist (ADR-074 §2): `null` deletes the key
   * (All models, including ones added later), a list sets it (`[]` → none).
   */
  setProviderModelAllowlist(
    engine: 'opencode' | 'pi',
    providerId: string,
    models: string[] | null
  ): Promise<void>
  listOpencodeAgents(cwd?: string): Promise<OpencodeAgentSummary[]>
  /**
   * The agent types `engine` can spawn (ADR-094): built-ins plus the agent
   * definitions found for `cwd` (user and project). Read-only.
   */
  listAgentTypes(engine: EngineId, cwd?: string): Promise<AgentTypeInfo[]>
  readOpencodeAgent(
    name: string,
    scope: OpencodeAgentScope,
    cwd?: string
  ): Promise<OpencodeAgentDetail | null>
  saveOpencodeAgent(input: OpencodeAgentInput, cwd?: string): Promise<void>
  deleteOpencodeAgent(name: string, scope: OpencodeAgentScope, cwd?: string): Promise<void>
  setOpencodeAgentDisabled(
    name: string,
    scope: OpencodeAgentScope,
    cwd: string | undefined,
    disabled: boolean
  ): Promise<void>
  generateOpencodeAgent(
    description: string,
    cwd?: string
  ): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }>
  logError(source: string, message: string): void
}
