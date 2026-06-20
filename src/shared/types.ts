export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

/** SDK sends "Agent" (canonical, v0.2.63+) or "Task" (alias for backward compat) */
export function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task'
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; toolInput?: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolResult: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'cli_command'; commandName: string; commandArgs?: string; commandOutput?: string }
  | { type: 'api_error'; errorType: string; errorMessage: string }
  | { type: 'compact_separator'; text?: string }
  | {
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      base64Data: string
      fileName?: string
    }
  | { type: 'document'; mediaType: 'application/pdf'; base64Data: string; fileName?: string }

export interface FileAttachment {
  id: string
  fileName: string
  fileType: 'image' | 'pdf'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'
  base64Data: string
  previewUrl: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
}

export type EngineId = 'claude' | 'opencode'

/** Open-ended union: known vendors are named; unknown ones fall through as plain strings. */
export type VendorId = 'anthropic' | 'openai' | 'google' | 'local' | (string & {})

/** Vendor-qualified model identity — the canonical key for model selection and persistence. */
export interface ModelRef {
  engineId: EngineId
  vendorId: VendorId
  /** Model name string, e.g. 'claude-opus-4-8', 'default' */
  modelId: string
}

/** Construct a Claude ModelRef (engine 'claude' is 1:1 with vendor 'anthropic'). */
export function claudeModel(modelId: string): ModelRef {
  return { engineId: 'claude', vendorId: 'anthropic', modelId }
}

// ---------------------------------------------------------------------------
// Phase 4 identity types — declared here for vocabulary; wired in Phase 4
// ---------------------------------------------------------------------------

export type BillingType = 'subscription' | 'apiKey' | 'free' | 'unknown'

/** Resolved account descriptor held on the session. Wired in Phase 4. */
export interface AccountRef {
  engineId: EngineId
  vendorId: VendorId
  billingType: BillingType
  authState: 'authenticated' | 'unauthenticated' | 'unknown'
  label?: string
  accountId?: string
}

export interface SessionCapabilities {
  thinkingModes: boolean
  effortLevels: boolean
  voice: boolean
  hostedMcp: boolean
  backgroundTasks: boolean
  subagents: boolean
  plan: boolean
  costUsd: boolean
  fork: boolean
  sideQuestion: boolean
}

/** Full capability set for the Claude backend — every feature enabled. Frozen
 *  so the single shared reference can't be mutated by any consumer. */
export const CLAUDE_CAPABILITIES: SessionCapabilities = Object.freeze({
  thinkingModes: true,
  effortLevels: true,
  voice: true,
  hostedMcp: true,
  backgroundTasks: true,
  subagents: true,
  plan: true,
  costUsd: true,
  fork: true,
  sideQuestion: true
})

/** Return the frozen capabilities constant for a given engineId. */
export function capabilitiesFor(_engineId: EngineId): SessionCapabilities {
  return CLAUDE_CAPABILITIES
}

export interface SessionStatus {
  state: 'idle' | 'running' | 'error' | 'disconnected'
  sessionId: string | null
  /** Vendor-qualified model identity. Null until the engine reports a model. */
  model: ModelRef | null
  cwd: string | null
  totalCostUsd: number
  engineId: EngineId
  capabilities: SessionCapabilities
}

export interface PermissionSuggestion {
  type: string // 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories'
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: string // 'allow' | 'deny' | 'ask'
  destination: string // 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  mode?: string
  directories?: string[]
}

export interface PendingApproval {
  requestId: string
  /**
   * cli.js-assigned tool_use id for the invocation being prompted. The
   * correct binding key between an approval and its tool_use block —
   * matching on toolName+input alone is lossy (repeated identical calls
   * all collapse to the same approval and get the UI shown on every
   * historical card).
   */
  toolUseId?: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionSuggestion[]
  decisionReason?: string
  blockedPath?: string
}

export interface SessionResult {
  totalCostUsd: number
  durationMs: number
  result: string
  sessionId?: string | null
}

// ---------------------------------------------------------------------------
// Plugin session event types (ADR-005)
// All session events forwarded to plugins are wrapped in this shape.
// ---------------------------------------------------------------------------

/** Base envelope for all session events forwarded to plugins. */
export interface PluginSessionEvent {
  routingId: string
  sessionId: string | null
}

/** session:message event as seen by plugins. */
export interface PluginMessageEvent extends PluginSessionEvent {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
}

/** session:result event as seen by plugins. */
export interface PluginResultEvent extends PluginSessionEvent {
  totalCostUsd: number
  durationMs: number
  result: string
}

/** session:stream event as seen by plugins. */
export interface PluginStreamEvent extends PluginSessionEvent {
  type: 'text' | 'thinking'
  text: string
}

export type ApprovalDecision = 'allow' | 'allowForSession' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'localAuto'

export interface ProxySettings {
  enabled: boolean
  type: 'http' | 'socks5'
  hostname: string
  port: number
  username: string
  password: string
  /**
   * When true, cli.js's subprocesses (Bash tool, MCP, LSP, shell-snapshot) also
   * route through the proxy. When false (default), only cli.js's own Anthropic
   * API calls are proxied — git/curl/npm/etc. spawned by Claude stay direct.
   */
  proxySubprocesses?: boolean
}

/**
 * Custom Anthropic API endpoint config. When `enabled`, `baseUrl` is exposed to
 * cli.js spawns as `ANTHROPIC_BASE_URL` and `authToken` as `ANTHROPIC_AUTH_TOKEN`,
 * letting users redirect traffic to a self-hosted gateway, LM Studio, or any
 * Anthropic-compatible endpoint.
 */
export interface AnthropicEndpointSettings {
  enabled: boolean
  baseUrl: string
  authToken: string
}

/**
 * Model override config. When `enabled`, the user-supplied model names are
 * exposed to cli.js spawns as the matching Anthropic env vars:
 *   - `model`       → ANTHROPIC_MODEL              (primary model selection)
 *   - `sonnetModel` → ANTHROPIC_DEFAULT_SONNET_MODEL
 *   - `opusModel`   → ANTHROPIC_DEFAULT_OPUS_MODEL
 *   - `haikuModel`  → ANTHROPIC_DEFAULT_HAIKU_MODEL
 * Empty fields are skipped, so partial overrides leave cli.js's defaults
 * intact for the unset families. Useful when pointing cli.js at a custom
 * gateway whose model identifiers differ from Anthropic's canonical ones
 * (e.g. LM Studio, OpenRouter).
 */
export interface ModelOverrideSettings {
  enabled: boolean
  model: string
  sonnetModel: string
  opusModel: string
  haikuModel: string
}

export interface SandboxSettings {
  enabled: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  network: {
    restrictNetwork: boolean
    allowLocalBinding: boolean
    allowedDomains: string[]
    allowManagedDomainsOnly: boolean
    allowAllUnixSockets: boolean
    allowUnixSockets: string[]
  }
  filesystem: {
    allowWrite: string[]
    denyWrite: string[]
    denyRead: string[]
  }
  excludedCommands: string[]
}

// ---------------------------------------------------------------------------
// Claude permissions (allow/deny/ask rules from settings.json files)
// ---------------------------------------------------------------------------

export interface ClaudePermissions {
  allow: string[]
  deny: string[]
  ask: string[]
  additionalDirectories: string[]
  defaultMode: string | undefined
}

export type PermissionScope = 'user' | 'project' | 'local'

// AskUserQuestion tool types
export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[]
}

export interface StreamDelta {
  type: 'text' | 'thinking'
  text: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

export interface TaskProgress {
  toolUseId: string
  toolName: string
  parentToolUseId: string | null
  elapsedTimeSeconds: number
}

export interface TaskNotification {
  taskId: string
  toolUseId: string | null
  status: 'completed' | 'failed' | 'stopped'
  outputFile: string
  summary: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

export interface SubagentStreamDelta {
  toolUseId: string
  type: 'text' | 'thinking'
  text: string
}

export interface SubagentMessageData {
  toolUseId: string
  message: ChatMessage
}

export interface SubagentMessageBatchData {
  toolUseId: string
  messages: ChatMessage[]
}

export interface SubagentToolResultData {
  toolUseId: string
  toolResultToolUseId: string
  result: string
  isError: boolean
}

export interface BackgroundOutput {
  toolUseId: string
  tail: string
  totalSize: number
  done: boolean
}

export interface BashOutputData {
  toolUseId: string
  output: string
  totalLines: number
  totalBytes: number
}

export interface WatchUpdate {
  routingId: string
  messages: ChatMessage[]
  taskNotifications: TaskNotification[]
  statusLine?: StatusLineData | null
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  /** Capability flags surfaced by the SDK's `supportedModels()`. Authoritative. */
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  supportsAdaptiveThinking?: boolean
}

export interface SessionInfo {
  sessionId: string
  cwd: string
  projectKey: string
  title: string
  timestamp: number
  lastActivityAt: number
  /** cli.js-generated session title (from `{type:"ai-title"}` JSONL records). */
  aiTitle?: string | null
  /** Which engine produced this session. Defaults to 'claude' when absent (legacy records). */
  engineId?: EngineId
}

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface DirectoryGroup {
  cwd: string
  projectKey: string
  folderName: string
  sessions: SessionInfo[]
}

// ---------------------------------------------------------------------------
// Domain-specific API interfaces (composed into ClaudeAPI)
// ---------------------------------------------------------------------------

export interface ForkAnchorResult {
  /** JSONL line uuid to pass to cli.js `--resume-session-at`, or null if the
   *  message could not be resolved on disk (e.g. not yet flushed). */
  anchorUuid: string | null
  reason?: string
}

interface SessionAPI {
  platform: string
  pickFolder(): Promise<string | null>
  createSession(
    routingId: string,
    cwd: string,
    effort?: string,
    resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    thinkingMode?: string,
    resumeSessionAt?: string,
    forkSession?: boolean,
    engineId?: EngineId
  ): Promise<void>
  rekeySession(oldId: string, newId: string): Promise<void>
  /** Resolve the balanced JSONL line uuid to fork ("branch off") from, given
   *  an assistant message id. Returns { anchorUuid: null, reason } on failure. */
  resolveForkAnchor(sessionId: string, cwd: string, messageId: string): Promise<ForkAnchorResult>
  sendPrompt(
    routingId: string,
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void>
  cancelSession(routingId: string): Promise<void>
  interruptSession(routingId: string): Promise<void>
  respondApproval(
    routingId: string,
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  loadSessionHistory(
    sessionId: string,
    projectKey: string
  ): Promise<{
    messages: ChatMessage[]
    taskNotifications: TaskNotification[]
    customTitle: string | null
    agentIdToToolUseId: Record<string, string>
    statusLine: StatusLineData | null
    taskPrompts: Record<string, string>
    warnings: string[]
  }>
  loadSubagentHistory(
    sessionId: string,
    projectKey: string,
    agentId: string
  ): Promise<ChatMessage[]>
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
  onSessionCreated(
    cb: (routingId: string, data: { cwd: string; resumeSessionId?: string }) => void
  ): () => void
  onUserMessage(
    cb: (
      routingId: string,
      data: {
        prompt: string
        attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
        queued?: boolean
      }
    ) => void
  ): () => void
  onMessage(cb: (routingId: string, msg: ChatMessage) => void): () => void
  onStreamEvent(cb: (routingId: string, delta: StreamDelta) => void): () => void
  onApprovalRequest(cb: (routingId: string, approval: PendingApproval) => void): () => void
  onStatus(cb: (routingId: string, status: SessionStatus) => void): () => void
  onResult(cb: (routingId: string, result: SessionResult) => void): () => void
  onError(cb: (routingId: string, error: string) => void): () => void
  onWarning(cb: (routingId: string, warning: string) => void): () => void
  /** Refusal-fallback retraction — remove these messages from the transcript (docs/protocol/04-system-subtypes.md §4.20) */
  onMessagesRetracted(cb: (routingId: string, data: { messageIds: string[] }) => void): () => void
  onToolResult(
    cb: (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void
  ): () => void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  onTaskProgress(cb: (routingId: string, data: TaskProgress) => void): () => void
  onTaskNotification(cb: (routingId: string, data: TaskNotification) => void): () => void
  onSubagentStream(cb: (routingId: string, data: SubagentStreamDelta) => void): () => void
  onSubagentMessage(cb: (routingId: string, data: SubagentMessageData) => void): () => void
  onSubagentMessageBatch(
    cb: (routingId: string, data: SubagentMessageBatchData) => void
  ): () => void
  onSubagentToolResult(cb: (routingId: string, data: SubagentToolResultData) => void): () => void
  onPermissionMode(cb: (routingId: string, mode: PermissionMode) => void): () => void
  onSandboxViolation(cb: (routingId: string, message: string) => void): () => void
  onBashOutput(cb: (routingId: string, data: BashOutputData) => void): () => void
  onBackgroundOutput(cb: (routingId: string, data: BackgroundOutput) => void): () => void
  watchBackground(routingId: string, toolUseId: string): Promise<void>
  unwatchBackground(routingId: string, toolUseId: string): Promise<void>
  readBackgroundRange(
    routingId: string,
    toolUseId: string,
    offset: number,
    length: number
  ): Promise<string>
  stopTask(routingId: string, toolUseId: string): Promise<{ success: boolean; error?: string }>
  backgroundTask(
    routingId: string,
    toolUseId: string
  ): Promise<{ success: boolean; error?: string }>
  dequeueMessage(routingId: string, value: string): Promise<{ removed: number }>
  askSideQuestion(routingId: string, question: string): Promise<string | null>
  onSteerConsumed(cb: (routingId: string, data: { prompt: string }) => void): () => void
  setPermissionMode(routingId: string, mode: string): Promise<void>
  setModel(routingId: string, model: string): Promise<void>
  setEffort(routingId: string, effort: string): Promise<void>
  setThinkingMode(routingId: string, mode: string): Promise<void>
  getModels(): Promise<ModelInfo[]>
  generateTitle(conversationText: string): Promise<string | null>
  generateCommitMessage(diff: string): Promise<string | null>
  writeCustomTitle(sessionId: string, projectKey: string, title: string): Promise<void>
  getPlanContent(routingId: string): Promise<string | null>
  getSessionLogPath(routingId: string): Promise<string | null>
  watchSession(routingId: string, sessionId: string, projectKey: string): Promise<void>
  unwatchSession(routingId: string): Promise<void>
  onWatchUpdate(cb: (data: WatchUpdate) => void): () => void
  onDirectoriesChanged(cb: () => void): () => void
  onSlashCommands(cb: (routingId: string, commands: SlashCommandInfo[]) => void): () => void
  onSkills(cb: (routingId: string, names: string[]) => void): () => void
  /** cli.js auth source from session init: 'oauth' | 'api_key' | 'none' (ADR-014). */
  onAuthSource(cb: (routingId: string, source: string) => void): () => void
  onStatusLine(cb: (routingId: string, data: StatusLineData) => void): () => void
  onPlanSteps(cb: (routingId: string, todos: TodoItem[]) => void): () => void
  onSettingsChanged(cb: (settings: Record<string, unknown>) => void): () => void
  onSessionConfigChanged(cb: (config: UISessionConfig) => void): () => void
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
  loadSessionConfig(): Promise<UISessionConfig>
  saveSessionConfig(config: UISessionConfig): Promise<void>
  /** Permanently delete a session's JSONL + subagent directory from disk */
  deleteSession(sessionId: string, projectKey: string): Promise<void>
  /** Permanently delete an entire Claude project directory (all sessions) from disk */
  deleteProject(projectKey: string): Promise<void>
  loadSlashCommands(): Promise<SlashCommandInfo[]>
  saveSlashCommands(commands: SlashCommandInfo[]): Promise<void>
  scanCustomCommands(cwd: string): Promise<string[]>
  loadSkillDetails(cwd: string): Promise<SkillInfo[]>
  onBeforeQuit(cb: () => void): () => void
  confirmQuit(): Promise<void>
  testProxyConnection(
    proxy: ProxySettings
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }>
  logError(source: string, message: string): void
}

interface GitAPI {
  gitCheckRepo(cwd: string): Promise<boolean>
  gitGetStatus(cwd: string): Promise<GitStatusData>
  gitGetBranches(cwd: string): Promise<GitBranchData>
  gitCheckout(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitGetFilePatch(
    cwd: string,
    filePath: string,
    staged: boolean,
    ignoreWhitespace: boolean
  ): Promise<{ patch: string; isBinary?: boolean }>
  gitGetFileContents(
    cwd: string,
    filePath: string,
    staged: boolean
  ): Promise<{ oldContent: string; newContent: string }>
  gitStageFile(cwd: string, filePath: string): Promise<void>
  gitUnstageFile(cwd: string, filePath: string): Promise<void>
  gitDiscardFile(cwd: string, filePath: string): Promise<void>
  gitStageAll(cwd: string): Promise<void>
  gitUnstageAll(cwd: string): Promise<void>
  gitCommit(cwd: string, message: string): Promise<string>
  gitPush(cwd: string): Promise<void>
  gitPushWithUpstream(cwd: string, branch: string): Promise<void>
  gitPull(cwd: string): Promise<{ summary: string }>
  gitFetch(cwd: string): Promise<void>
  gitStartWatching(cwd: string): Promise<void>
  gitStopWatching(cwd: string): Promise<void>
  onGitStatusUpdate(cb: (data: { cwd: string; status: GitStatusData }) => void): () => void
}

interface McpAPI {
  mcpServerStatus(routingId: string): Promise<McpServerInfo[]>
  mcpToggleServer(routingId: string, serverName: string, enabled: boolean): Promise<void>
  mcpReconnectServer(routingId: string, serverName: string): Promise<void>
  mcpSetServers(
    routingId: string,
    servers: Record<string, McpServerConfig>
  ): Promise<McpSetServersResult>
  loadMcpServers(scope: McpServerScope, cwd?: string): Promise<Record<string, McpServerConfig>>
  saveMcpServers(
    scope: McpServerScope,
    servers: Record<string, McpServerConfig>,
    cwd?: string
  ): Promise<void>
  removeMcpServer(scope: McpServerScope, serverName: string, cwd?: string): Promise<void>
  mcpReadDisabled(cwd: string): Promise<string[]>
  mcpToggleDisabled(cwd: string, serverName: string, enabled: boolean): Promise<void>
  onMcpServers(
    cb: (routingId: string, servers: Array<{ name: string; status: string }>) => void
  ): () => void
  loadClaudePermissions(scope: PermissionScope, cwd?: string): Promise<ClaudePermissions>
  saveClaudePermissions(
    scope: PermissionScope,
    permissions: ClaudePermissions,
    cwd?: string
  ): Promise<void>
  /** Transcript retention window (cleanupPeriodDays). undefined = not set (CLI default of 30). */
  getCleanupPeriodDays(): Promise<number | undefined>
  setCleanupPeriodDays(days: number): Promise<void>
}

interface TerminalAPI {
  createTerminal(cwd: string): Promise<string>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  killTerminal(id: string): Promise<void>
  killTerminalsByCwd(cwd: string): Promise<string[]>
  onTerminalData(cb: (data: { terminalId: string; data: string }) => void): () => void
  onTerminalExit(cb: (data: { terminalId: string; code: number }) => void): () => void
}

interface AutomationAPI {
  listAutomations(): Promise<Automation[]>
  saveAutomation(automation: Automation): Promise<void>
  deleteAutomation(id: string): Promise<void>
  runAutomationNow(id: string): Promise<void>
  toggleAutomation(id: string, enabled: boolean): Promise<void>
  listAutomationRuns(automationId: string): Promise<AutomationRun[]>
  loadAutomationRunHistory(automationId: string, runId: string): Promise<ChatMessage[]>
  cancelAutomationRun(automationId: string): Promise<void>
  dismissAutomationRun(automationId: string, runId: string): Promise<void>
  sendAutomationMessage(automationId: string, prompt: string): Promise<void>
  onAutomationRunUpdate(
    cb: (data: { automationId: string; run: AutomationRun }) => void
  ): () => void
  onAutomationsChanged(cb: (automations: Automation[]) => void): () => void
  onAutomationRunMessage(
    cb: (data: { automationId: string; message: ChatMessage }) => void
  ): () => void
  onAutomationStreamEvent(
    cb: (data: { automationId: string; type: string; text: string }) => void
  ): () => void
  onAutomationProcessing(
    cb: (data: { automationId: string; isProcessing: boolean }) => void
  ): () => void
}

interface FileAPI {
  listDir(dirPath: string): Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath: string }>
  openInVSCode(cwd: string): Promise<void>
  createWorktree(cwd: string, name: string): Promise<WorktreeInfo>
  getWorktreeStatus(worktreePath: string, originalHead: string): Promise<WorktreeStatus>
  removeWorktree(worktreePath: string, branch: string, gitRoot: string): Promise<void>
  listWorktrees(cwd: string): Promise<WorktreeEntry[]>
}

interface AccountAPI {
  fetchAccountUsage(): Promise<AccountUsage>
  onAccountUsage(cb: (data: AccountUsage) => void): () => void
  fetchBlockUsage(): Promise<BlockUsageData>
  onBlockUsage(cb: (data: BlockUsageData) => void): () => void
  /** Filter usage analytics to one account email (null = all accounts) */
  setUsageAccountFilter(account: string | null): Promise<void>
  // --- Native Anthropic OAuth (ADR-014) ---
  /** Start the subscription login flow: opens the browser and awaits the
   *  loopback redirect. Resolves once cli.js has stored fresh credentials. */
  signIn(): Promise<AuthState>
  /** Manual fallback: submit the authorization code pasted by the user.
   *  `state` is recovered internally from the login URL. */
  submitOAuthCode(code: string): Promise<AuthState>
  /** Abort an in-flight login flow. */
  cancelSignIn(): Promise<void>
  /** Subscribe to login-flow state transitions. */
  onAuthState(cb: (state: AuthState) => void): () => void
  // --- Multiple-account support (ADR-015) ---
  /** Current accounts + active id + enabled flag. */
  getAccounts(): Promise<AccountsState>
  /** Toggle multi-account (file-based credential) mode. */
  setMultiAccountEnabled(enabled: boolean): Promise<AccountsState>
  /** Create a new account and start its login flow (resolves once login starts). */
  addAccount(): Promise<AccountsState>
  /** Make an existing account active (sessions respawn against it). */
  switchAccount(id: string): Promise<AccountsState>
  /** Delete a persisted account and its credentials. */
  deleteAccount(id: string): Promise<AccountsState>
  /** Subscribe to account list / active / enabled changes. */
  onAccountsChanged(cb: (state: AccountsState) => void): () => void
  /** Fired when the active account changed — renderer should respawn sessions. */
  onAccountRespawnSessions(cb: () => void): () => void
}

export interface NetworkInterfaceInfo {
  name: string // e.g. "Wi-Fi", "Ethernet", "Tailscale"
  address: string // e.g. "192.168.1.100"
  priority: number // lower = more preferred (1 = LAN, 9 = CGNAT/VPN)
}

interface RemoteAPI {
  getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]>
  startRemoteServer(opts?: {
    port?: number
    host?: string
    tunnel?: boolean
  }): Promise<{ port: number; token: string; lanUrl: string }>
  stopRemoteServer(): Promise<void>
  getRemoteStatus(): Promise<RemoteStatus>
  onRemoteStatus(cb: (status: RemoteStatus) => void): () => void
}

export type TunnelState =
  | 'stopped'
  | 'starting'
  | 'downloading'
  | 'connected'
  | 'error'
  | 'restarting'

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  lanUrl: string | null
  tunnelUrl: string | null
  tunnelState: TunnelState | null
  tunnelError: string | null
  connectedClients: number
  clientIps: string[]
}

// ---------------------------------------------------------------------------
// Voice input types
// ---------------------------------------------------------------------------

export type VoiceLanguageCode =
  | 'en'
  | 'es'
  | 'fr'
  | 'ja'
  | 'de'
  | 'pt'
  | 'it'
  | 'ko'
  | 'hi'
  | 'id'
  | 'ru'
  | 'pl'
  | 'tr'
  | 'nl'
  | 'uk'
  | 'el'
  | 'cs'
  | 'da'
  | 'sv'
  | 'no'

export interface VoiceLanguageOption {
  code: VoiceLanguageCode
  label: string
}

// Supported languages match the SDK's normalizeLanguageForSTT valid code set.
// Deepgram silently fails (connects but never transcribes) for unsupported codes.
export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'ja', label: 'Japanese' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ru', label: 'Russian' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'el', label: 'Greek' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' }
]

export interface VoiceTranscript {
  text: string
  isFinal: boolean
}

export type VoiceState = 'idle' | 'connecting' | 'recording' | 'processing'

interface VoiceAPI {
  voiceStartServer(routingId: string): Promise<void>
  voiceStopServer(routingId: string): Promise<void>
  voiceStartRecording(routingId: string, language: string): Promise<void>
  voiceStopRecording(routingId: string): Promise<void>
  onVoiceTranscript(cb: (routingId: string, data: VoiceTranscript) => void): () => void
  onVoiceState(cb: (routingId: string, state: VoiceState) => void): () => void
  onVoiceError(cb: (routingId: string, error: string) => void): () => void
}

export interface ClaudeAPI
  extends
    SessionAPI,
    GitAPI,
    McpAPI,
    TerminalAPI,
    AutomationAPI,
    FileAPI,
    AccountAPI,
    RemoteAPI,
    VoiceAPI,
    PluginAPI {
  /** Relay a log message from the renderer to the main process logger */
  logRelay(level: string, source: string, message: string): void
  /** App + SDK version info for display in Settings */
  getVersionInfo(): Promise<{ appVersion: string; sdkVersion: string; cliVersion: string }>
  /** Open the standalone log viewer window */
  openLogViewer(): Promise<void>
}

// ---------------------------------------------------------------------------
// Account usage types (5hr / 7-day rate windows)
// ---------------------------------------------------------------------------

export interface RateWindow {
  usedPercent: number // 0-100
  resetsAt: string | null // ISO8601 timestamp
}

export interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number | null // null = unlimited, otherwise in cents (divide by 100 for dollars)
  usedCredits: number // in cents (divide by 100 for dollars)
  utilization: number // percentage 0-100
}

export interface AccountUsage {
  fiveHour: RateWindow
  sevenDay: RateWindow | null
  sevenDaySonnet: RateWindow | null
  sevenDayOpus: RateWindow | null
  extraUsage: ExtraUsage | null
  planName: string | null // e.g. "claude_max_5x"
  fetchedAt: number // Date.now()
  error: string | null
}

// ---------------------------------------------------------------------------
// Native Anthropic OAuth (subscription "Log in with Claude") — see ADR-014
// ---------------------------------------------------------------------------

/** Account info returned by cli.js after a successful OAuth token exchange. */
export interface OAuthAccount {
  email: string | null
  organization: string | null
  subscriptionType: string | null // e.g. "max", "pro"
  tokenSource?: string | null
  apiKeySource?: string | null
  apiProvider?: string | null
}

// --- Multiple-account support (ADR-015) ---

export interface AccountInfo {
  id: string
  email: string | null
  subscriptionType: string | null
  organization: string | null
  createdAt: number
}

export interface AccountsState {
  /** Multi-account mode (file-based credentials via SKIP_SECURESTORAGE). */
  enabled: boolean
  activeId: string | null
  accounts: AccountInfo[]
}

export type AuthFlowStatus = 'idle' | 'authorizing' | 'success' | 'error'

/** Broadcast to the renderer on every transition of the native login flow. */
export interface AuthState {
  status: AuthFlowStatus
  account: OAuthAccount | null
  error: string | null
}

export interface StatusLineData {
  totalCostUsd: number
  totalDurationMs: number
  totalApiDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  cachedTokens: number
  totalTokens: number
  contextWindowSize: number
  usedPercentage: number | null
  remainingPercentage: number | null
}

// ---------------------------------------------------------------------------
// Block usage types (ccusage-inspired token tracking per 5hr window)
// ---------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface ModelTokenBreakdown {
  model: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
}

export interface UsageBlock {
  id: string // ISO string of floored start time
  startTime: number // epoch ms, floored to hour
  endTime: number // startTime + 5hrs
  actualEndTime: number // timestamp of last entry
  isActive: boolean
  tokens: TokenCounts
  costUsd: number
  requestCount: number
  models: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  projectedUsage: { tokens: number; costUsd: number } | null
  /** Final API usage % when this block ended (from last snapshot). Used for accurate display. */
  finalApiPercent: number | null
  /** Whether the block boundary came from an observed API window (resets_at)
   *  rather than the floorToHour fallback. */
  windowAligned?: boolean
}

/** A single point-in-time snapshot, stored every poll cycle */
export interface UsageSnapshot {
  timestamp: number // when this snapshot was taken
  apiUsagePercent: number // 5hr API usage % at this moment
  apiResetAt: string | null // when the 5hr window resets
  activeBlockId: string | null // which block is active
  /** Cumulative totals for the active block at this point in time */
  blockTokens: TokenCounts | null
  blockCostUsd: number
  blockRequestCount: number
  /** Per-model cumulative totals for the active block */
  blockModels: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  /** Projected window capacity at this snapshot (from WLS regression) */
  projectedUsage: { tokens: number; costUsd: number } | null
}

/** Entry-derived daily summary — computed from deduplicated JSONL entries. */
export interface DailySummary {
  totalTokens: number
  costUsd: number
  models: Record<string, number> // model → total tokens
  blockCount: number
  requestCount: number
}

/** Daily file format: ~/.claude/ui/usage/YYYY-MM-DD.json */
export interface DailyUsageFile {
  date: string // YYYY-MM-DD
  snapshots: UsageSnapshot[] // time-series, one per poll cycle
  /** Completed blocks that overlapped with this day */
  completedBlocks: UsageBlock[]
  /** Authoritative daily totals computed from deduplicated JSONL entries.
   *  Added to fix overlapping-block double-counting — once persisted, this
   *  is used instead of summing completedBlocks. */
  dailySummary?: DailySummary
}

/** Data pushed to renderer for display */
export interface BlockUsageData {
  currentBlock: UsageBlock | null
  recentBlocks: UsageBlock[] // last 48hrs of completed blocks
  /** Today's time-series snapshots for intra-block analysis */
  todaySnapshots: UsageSnapshot[]
  /** Daily aggregates for 30-day chart */
  dailyHistory: Array<{
    date: string
    totalTokens: number // sum of all 4 token types
    costUsd: number
    models: Record<string, number> // model → totalTokens
    peakApiPercent: number // highest API % seen that day
    blockCount: number // number of blocks that day
  }>
  /** Distinct account emails seen in the account log (for the filter UI) */
  accounts: string[]
  /** Active account filter (email), or null for all accounts */
  accountFilter: string | null
}

// ---------------------------------------------------------------------------
// Automation types (scheduled cron-job system)
// ---------------------------------------------------------------------------

export interface AutomationSchedule {
  type: 'interval' | 'cron'
  intervalMs?: number
  cronExpression?: string
}

export interface Automation {
  id: string
  name: string
  prompt: string
  cwd: string
  schedule: AutomationSchedule
  permissions: { allow: string[]; deny: string[] }
  model?: string
  effort?: string
  thinkingMode?: 'adaptive' | 'enabled' | 'disabled'
  permissionMode?: 'default' | 'auto'
  enabled: boolean
  lastRunAt: number | null
  lastRunStatus: 'success' | 'error' | null
  createdAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error'
  totalCostUsd: number
  error?: string
  resultSummary?: string
  /** SDK session ID — used to locate the project JSONL for message history */
  sessionId?: string
  /** SDK project key (cwd with /.\\ replaced by -) — used with sessionId to load history */
  projectKey?: string
}

// ---------------------------------------------------------------------------
// Worktree types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  worktreeName: string
  originalCwd: string
  gitRoot: string
  originalHeadCommit: string
  createdAt: number
}

export interface WorktreeStatus {
  uncommittedFiles: number
  commitsAhead: number
  files: string[]
}

export interface WorktreeEntry {
  name: string
  path: string
  branch: string
  exists: boolean
}

// ---------------------------------------------------------------------------
// UI session config
// ---------------------------------------------------------------------------

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
  worktreeInfoMap?: Record<string, WorktreeInfo>
  /** Session IDs the user has chosen to hide from the sidebar */
  hiddenSessions?: string[]
  /** Project keys the user has chosen to hide from the sidebar */
  hiddenProjects?: string[]
  /**
   * Engine + model per session. Maps sessionId → { engineId, model? }.
   * Absent keys are treated as claude. The entry is written at session-creation
   * time, updated whenever the user switches model, and carried over on rekey.
   * On reopen, the optional `model` field seeds `selectedModel` so the last
   * model choice is restored (Phase 1 behavior addition).
   */
  sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
}

export interface SlashCommandInfo {
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// Skill types (skills management dialog)
// ---------------------------------------------------------------------------

export type SkillSource = 'project' | 'user' | 'plugin' | 'bundled'

export interface SkillInfo {
  name: string
  displayName?: string
  description: string
  source: SkillSource
  pluginName?: string
  path: string // filesystem path to SKILL.md (empty for bundled)
  content: string // markdown body (no frontmatter)
}

// ---------------------------------------------------------------------------
// MCP Server types (MCP server management dialog)
// ---------------------------------------------------------------------------

export type McpServerScope = 'user' | 'project' | 'local' | 'claudeai' | 'managed'
export type McpServerConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'not_started'
export type McpServerTransport = 'stdio' | 'sse' | 'http'

export interface McpServerToolInfo {
  name: string
  description?: string
  annotations?: {
    readOnly?: boolean
    destructive?: boolean
    openWorld?: boolean
  }
}

export interface McpServerConfig {
  type?: McpServerTransport
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse/http transport
  url?: string
  headers?: Record<string, string>
}

export interface McpServerInfo {
  name: string
  status: McpServerConnectionStatus
  serverInfo?: { name: string; version: string }
  error?: string
  config?: McpServerConfig
  scope?: McpServerScope
  tools?: McpServerToolInfo[]
}

export interface McpSetServersResult {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

// ---------------------------------------------------------------------------
// Diff review comment types
// ---------------------------------------------------------------------------

export interface DiffComment {
  id: string
  filePath: string
  lineNumber: number
  /** End line when a range is selected (inclusive). Equals lineNumber for single-line. */
  endLineNumber: number
  side: 'old' | 'new'
  lineContent: string
  comment: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Plan review comment types
// ---------------------------------------------------------------------------

export interface PlanComment {
  id: string
  /** The exact text the user highlighted in the rendered plan */
  selectedText: string
  /** 1-based start line of the selection in the raw plan markdown */
  lineNumber: number
  /** 1-based end line (inclusive). Equals lineNumber for single-line selections. */
  endLineNumber: number
  /** Index of the plan section this comment belongs to (for UI placement) */
  sectionIndex: number
  comment: string
  createdAt: number
}

export interface PlanReviewData {
  planContent: string
  approvalRequestId: string
  comments: PlanComment[]
}

// ---------------------------------------------------------------------------
// Terminal types
// ---------------------------------------------------------------------------

export interface TerminalTab {
  id: string
  title: string
  cwd: string
}

// ---------------------------------------------------------------------------
// Git integration types
// ---------------------------------------------------------------------------

export interface GitFileStatus {
  path: string
  index: string // staged status: ' '|'M'|'A'|'D'|'R'|'?'|'!'
  working: string // working tree status
}

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  trackingBranch: string | null
  files: GitFileStatus[]
  staged: string[]
  unstaged: string[]
  untracked: string[]
  linesAdded: number
  linesRemoved: number
}

export interface GitBranchData {
  current: string
  local: string[]
  remote: string[]
  tracking: Record<string, string>
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

export type ActiveView =
  | { type: 'chat' }
  | { type: 'usage' }
  | { type: 'automations' }
  | { type: 'plugin'; pluginId: string }

// ---------------------------------------------------------------------------
// Plugin system types
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void
}

export interface PluginViewConfig {
  /** Unique view ID (defaults to plugin ID if only one view) */
  id: string
  /** Label shown in sidebar */
  label: string
  /** SVG icon string for sidebar NavItem */
  icon?: string
  /** Absolute path to HTML file for the webview */
  htmlFile: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  views: PluginViewConfig[]
  error?: string
}

export interface ClaudeUIPlugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

export interface PluginContext {
  /** Plugin ID */
  id: string
  /** Filesystem path to plugin directory */
  pluginDir: string
  /** Data directory for plugin persistence (~/.claude/ui/plugins/<id>/data/) */
  dataDir: string
  /** Config directory (~/.claude/ui/plugins/<id>/) */
  configDir: string
  /** Debug mode (CLAUDEUI_PLUGIN_DEBUG=1) */
  debug: boolean
  /** Namespaced logger */
  logger: {
    info(message: string): void
    warn(message: string, err?: unknown): void
    error(message: string, err?: unknown): void
    debug(message: string): void
  }
  // Core services — typed as `any` here since main-process classes
  // are not importable from shared types. Actual implementations
  // provide the real SessionManager / AutomationManager instances.
  /** Session manager — create/get/cancel sessions */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any
  /** Automation manager */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automations: any
  /** Main window reference */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window: any
  /** Raw ipcMain for advanced use cases */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain: any
  /** SDK query escape hatch */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkQuery: any
  /** Subscribe to session/app events (same payloads as IPC events) */
  on(event: string, handler: (...args: unknown[]) => void): Disposable
  /** Emit custom events (auto-namespaced to plugin:<id>:<event>) */
  emit(event: string, ...args: unknown[]): void
  /** Register an IPC handler (auto-namespaced to plugin:<id>:<channel>) */
  registerIpcHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a remote handler (auto-namespaced to plugin:<id>:<channel>) */
  registerRemoteHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a UI view that replaces the chat panel */
  registerView(config: Omit<PluginViewConfig, 'id'> & { id?: string }): Disposable
}

export type PluginViewWithOwner = PluginViewConfig & { pluginId: string }

interface PluginAPI {
  listPlugins(): Promise<PluginInfo[]>
  reloadPlugin(id: string): Promise<void>
  getPluginViews(): Promise<PluginViewWithOwner[]>
  getPluginPreloadPath(): Promise<string>
  onPluginViewsChanged(cb: (views: PluginViewWithOwner[]) => void): () => void

  // Mockup preview
  readMockupHtml(cwd: string, directory: string): Promise<string>
  watchMockup(cwd: string, directory: string): Promise<void>
  unwatchMockup(cwd: string, directory: string): Promise<void>
  onMockupFileChanged(cb: (directory: string) => void): () => void
  /**
   * The iframe `src` for a mockup preview. Platform-specific transport:
   * desktop returns a `mockup-asset://` URL (privileged Electron protocol);
   * the web client returns an HTTP URL on the remote server. Synchronous —
   * it's a pure URL builder.
   */
  getMockupPreviewUrl(cwd: string, directory: string, opts?: { dark?: boolean }): string
}
