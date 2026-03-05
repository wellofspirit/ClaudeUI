export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

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
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; base64Data: string; fileName?: string }
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

export interface SessionStatus {
  state: 'idle' | 'running' | 'error' | 'disconnected'
  sessionId: string | null
  model: string | null
  cwd: string | null
  totalCostUsd: number
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
}

export type ApprovalDecision = 'allow' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

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

export interface TeamInfoSnapshot {
  routingId: string
  teamName: string | null
  teammates: TeammateInfo[]
  /** Session ID for JSONL history loading */
  sessionId: string | null
  /** Project key for JSONL history loading */
  projectKey: string | null
}

export interface TeammateInfo {
  toolUseId: string
  name: string
  sanitizedName: string
  teamName: string
  sanitizedTeamName: string
  agentId: string
  /** Hex ID for subagent JSONL filename (may differ from agentId for team agents) */
  fileId?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
}

export interface TeammateDetectedData {
  toolUseId: string
  name: string
  sanitizedName: string
  teamName: string
  sanitizedTeamName: string
  agentId: string
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
}

export interface SessionInfo {
  sessionId: string
  cwd: string
  projectKey: string
  title: string
  timestamp: number
  lastActivityAt: number
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

interface SessionAPI {
  platform: string
  pickFolder(): Promise<string | null>
  createSession(routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string): Promise<void>
  rekeySession(oldId: string, newId: string): Promise<void>
  sendPrompt(routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>): Promise<void>
  cancelSession(routingId: string): Promise<void>
  respondApproval(routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  loadSessionHistory(sessionId: string, projectKey: string): Promise<{ messages: ChatMessage[]; taskNotifications: TaskNotification[]; customTitle: string | null; agentIdToToolUseId: Record<string, string>; statusLine: StatusLineData | null; teamName: string | null; pendingTeammates: Record<string, { name: string; teamName: string }>; taskPrompts: Record<string, string> }>
  loadSubagentHistory(sessionId: string, projectKey: string, agentId: string): Promise<ChatMessage[]>
  buildSubagentFileMap(sessionId: string, projectKey: string, taskPrompts: Record<string, string>): Promise<Record<string, string>>
  loadBackgroundOutput(projectKey: string, taskId: string, outputFile?: string): Promise<{ content: string | null; purged: boolean }>
  onSessionCreated(cb: (routingId: string, data: { cwd: string; resumeSessionId?: string }) => void): () => void
  onUserMessage(cb: (routingId: string, data: { prompt: string; attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }> }) => void): () => void
  onMessage(cb: (routingId: string, msg: ChatMessage) => void): () => void
  onStreamEvent(cb: (routingId: string, delta: StreamDelta) => void): () => void
  onApprovalRequest(cb: (routingId: string, approval: PendingApproval) => void): () => void
  onStatus(cb: (routingId: string, status: SessionStatus) => void): () => void
  onResult(cb: (routingId: string, result: SessionResult) => void): () => void
  onError(cb: (routingId: string, error: string) => void): () => void
  onToolResult(cb: (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void): () => void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  onTaskProgress(cb: (routingId: string, data: TaskProgress) => void): () => void
  onTaskNotification(cb: (routingId: string, data: TaskNotification) => void): () => void
  onSubagentStream(cb: (routingId: string, data: SubagentStreamDelta) => void): () => void
  onSubagentMessage(cb: (routingId: string, data: SubagentMessageData) => void): () => void
  onSubagentMessageBatch(cb: (routingId: string, data: SubagentMessageBatchData) => void): () => void
  onSubagentToolResult(cb: (routingId: string, data: SubagentToolResultData) => void): () => void
  onPermissionMode(cb: (routingId: string, mode: PermissionMode) => void): () => void
  onSandboxViolation(cb: (routingId: string, message: string) => void): () => void
  onBackgroundOutput(cb: (routingId: string, data: BackgroundOutput) => void): () => void
  watchBackground(routingId: string, toolUseId: string): Promise<void>
  unwatchBackground(routingId: string, toolUseId: string): Promise<void>
  readBackgroundRange(routingId: string, toolUseId: string, offset: number, length: number): Promise<string>
  stopTask(routingId: string, toolUseId: string): Promise<{ success: boolean; error?: string }>
  backgroundTask(routingId: string, toolUseId: string): Promise<{ success: boolean; error?: string }>
  dequeueMessage(routingId: string, value: string): Promise<{ removed: number }>
  onSteerConsumed(cb: (routingId: string, data: { prompt: string }) => void): () => void
  setPermissionMode(routingId: string, mode: string): Promise<void>
  setModel(routingId: string, model: string): Promise<void>
  setEffort(routingId: string, effort: string): Promise<void>
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
  sendToTeammate(routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string): Promise<void>
  broadcastToTeam(routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string): Promise<void>
  getTeamInfo(routingId: string): Promise<TeamInfoSnapshot | null>
  openTeamsViewWindow(routingId: string): Promise<void>
  onTeammateDetected(cb: (routingId: string, data: TeammateDetectedData) => void): () => void
  onTeamCreated(cb: (routingId: string, data: { teamName: string }) => void): () => void
  onTeamDeleted(cb: (routingId: string, data: Record<string, never>) => void): () => void
  onSlashCommands(cb: (routingId: string, commands: SlashCommandInfo[]) => void): () => void
  onSkills(cb: (routingId: string, names: string[]) => void): () => void
  onStatusLine(cb: (routingId: string, data: StatusLineData) => void): () => void
  onSettingsChanged(cb: (settings: Record<string, unknown>) => void): () => void
  onSessionConfigChanged(cb: (config: UISessionConfig) => void): () => void
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
  loadSessionConfig(): Promise<UISessionConfig>
  saveSessionConfig(config: UISessionConfig): Promise<void>
  loadSlashCommands(): Promise<SlashCommandInfo[]>
  saveSlashCommands(commands: SlashCommandInfo[]): Promise<void>
  loadSkillDetails(cwd: string): Promise<SkillInfo[]>
  onBeforeQuit(cb: () => void): () => void
  confirmQuit(): Promise<void>
  logError(source: string, message: string): void
}

interface GitAPI {
  gitCheckRepo(cwd: string): Promise<boolean>
  gitGetStatus(cwd: string): Promise<GitStatusData>
  gitGetBranches(cwd: string): Promise<GitBranchData>
  gitCheckout(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitGetFilePatch(cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean): Promise<{ patch: string }>
  gitGetFileContents(cwd: string, filePath: string, staged: boolean): Promise<{ oldContent: string; newContent: string }>
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
  mcpSetServers(routingId: string, servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>
  loadMcpServers(scope: McpServerScope, cwd?: string): Promise<Record<string, McpServerConfig>>
  saveMcpServers(scope: McpServerScope, servers: Record<string, McpServerConfig>, cwd?: string): Promise<void>
  mcpReadDisabled(cwd: string): Promise<string[]>
  mcpToggleDisabled(cwd: string, serverName: string, enabled: boolean): Promise<void>
  onMcpServers(cb: (routingId: string, servers: Array<{ name: string; status: string }>) => void): () => void
  loadClaudePermissions(scope: PermissionScope, cwd?: string): Promise<ClaudePermissions>
  saveClaudePermissions(scope: PermissionScope, permissions: ClaudePermissions, cwd?: string): Promise<void>
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
  onAutomationRunUpdate(cb: (data: { automationId: string; run: AutomationRun }) => void): () => void
  onAutomationsChanged(cb: (automations: Automation[]) => void): () => void
  onAutomationRunMessage(cb: (data: { automationId: string; message: ChatMessage }) => void): () => void
  onAutomationStreamEvent(cb: (data: { automationId: string; type: string; text: string }) => void): () => void
  onAutomationProcessing(cb: (data: { automationId: string; isProcessing: boolean }) => void): () => void
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
}

export interface NetworkInterfaceInfo {
  name: string // e.g. "Wi-Fi", "Ethernet", "Tailscale"
  address: string // e.g. "192.168.1.100"
  priority: number // lower = more preferred (1 = LAN, 9 = CGNAT/VPN)
}

interface RemoteAPI {
  getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]>
  startRemoteServer(opts?: { port?: number; host?: string }): Promise<{ port: number; token: string; lanUrl: string }>
  stopRemoteServer(): Promise<void>
  getRemoteStatus(): Promise<RemoteStatus>
  onRemoteStatus(cb: (status: RemoteStatus) => void): () => void
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  lanUrl: string | null
  tunnelUrl: string | null
  connectedClients: number
  clientIps: string[]
}

export interface ClaudeAPI extends SessionAPI, GitAPI, McpAPI, TerminalAPI, AutomationAPI, FileAPI, AccountAPI, RemoteAPI {}

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

/** Daily file format: ~/.claude/ui/usage/YYYY-MM-DD.json */
export interface DailyUsageFile {
  date: string // YYYY-MM-DD
  snapshots: UsageSnapshot[] // time-series, one per poll cycle
  /** Completed blocks that overlapped with this day */
  completedBlocks: UsageBlock[]
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
  path: string       // filesystem path to SKILL.md (empty for bundled)
  content: string    // markdown body (no frontmatter)
}

// ---------------------------------------------------------------------------
// MCP Server types (MCP server management dialog)
// ---------------------------------------------------------------------------

export type McpServerScope = 'user' | 'project' | 'local' | 'claudeai' | 'managed'
export type McpServerConnectionStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'not_started'
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
  index: string       // staged status: ' '|'M'|'A'|'D'|'R'|'?'|'!'
  working: string     // working tree status
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
