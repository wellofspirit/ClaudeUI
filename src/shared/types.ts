export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'cli_command' | 'api_error' | 'compact_separator' | 'image' | 'document'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  toolResult?: string
  isError?: boolean
  // cli_command fields
  commandName?: string
  commandArgs?: string
  commandOutput?: string
  // api_error fields
  errorType?: string
  errorMessage?: string
  // image/document fields
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'
  base64Data?: string
  fileName?: string
}

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

export interface PendingApproval {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export interface SessionResult {
  totalCostUsd: number
  durationMs: number
  result: string
}

export type ApprovalDecision = 'allow' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

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

export interface DirectoryGroup {
  cwd: string
  projectKey: string
  folderName: string
  sessions: SessionInfo[]
}

/** Wrapper for routed event data — all session events include routingId */
export interface RoutedData<T> {
  routingId: string
  data: T
}

export interface ClaudeAPI {
  platform: string
  pickFolder(): Promise<string | null>
  createSession(routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string): Promise<void>
  rekeySession(oldId: string, newId: string): Promise<void>
  sendPrompt(routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>): Promise<void>
  cancelSession(routingId: string): Promise<void>
  respondApproval(routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  loadSessionHistory(sessionId: string, projectKey: string): Promise<{ messages: ChatMessage[]; taskNotifications: TaskNotification[]; customTitle: string | null; agentIdToToolUseId: Record<string, string>; statusLine: StatusLineData | null; teamName: string | null; pendingTeammates: Record<string, { name: string; teamName: string }>; taskPrompts: Record<string, string> }>
  loadSubagentHistory(sessionId: string, projectKey: string, agentId: string): Promise<ChatMessage[]>
  buildSubagentFileMap(sessionId: string, projectKey: string, taskPrompts: Record<string, string>): Promise<Record<string, string>>
  loadBackgroundOutput(projectKey: string, taskId: string, outputFile?: string): Promise<{ content: string | null; purged: boolean }>

  onMessage(cb: (data: RoutedData<ChatMessage>) => void): () => void
  onStreamEvent(cb: (data: RoutedData<StreamDelta>) => void): () => void
  onApprovalRequest(cb: (data: RoutedData<PendingApproval>) => void): () => void
  onStatus(cb: (data: RoutedData<SessionStatus>) => void): () => void
  onResult(cb: (data: RoutedData<SessionResult>) => void): () => void
  onError(cb: (data: RoutedData<string>) => void): () => void
  onToolResult(cb: (data: RoutedData<{ toolUseId: string; result: string; isError: boolean }>) => void): () => void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  onTaskProgress(cb: (data: RoutedData<TaskProgress>) => void): () => void
  onTaskNotification(cb: (data: RoutedData<TaskNotification>) => void): () => void
  onSubagentStream(cb: (data: RoutedData<SubagentStreamDelta>) => void): () => void
  onSubagentMessage(cb: (data: RoutedData<SubagentMessageData>) => void): () => void
  onSubagentMessageBatch(cb: (data: RoutedData<SubagentMessageBatchData>) => void): () => void
  onSubagentToolResult(cb: (data: RoutedData<SubagentToolResultData>) => void): () => void
  onPermissionMode(cb: (data: RoutedData<PermissionMode>) => void): () => void
  onBackgroundOutput(cb: (data: RoutedData<BackgroundOutput>) => void): () => void
  watchBackground(routingId: string, toolUseId: string): Promise<void>
  unwatchBackground(routingId: string, toolUseId: string): Promise<void>
  readBackgroundRange(routingId: string, toolUseId: string, offset: number, length: number): Promise<string>
  stopTask(routingId: string, toolUseId: string): Promise<{ success: boolean; error?: string }>
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
  onTeammateDetected(cb: (data: RoutedData<TeammateDetectedData>) => void): () => void
  onTeamCreated(cb: (data: RoutedData<{ teamName: string }>) => void): () => void
  onTeamDeleted(cb: (data: RoutedData<Record<string, never>>) => void): () => void
  // Git operations
  gitCheckRepo(cwd: string): Promise<boolean>
  gitGetStatus(cwd: string): Promise<GitStatusData>
  gitGetBranches(cwd: string): Promise<GitBranchData>
  gitCheckout(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitGetFilePatch(cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean): Promise<{ patch: string }>
  gitGetFileContents(cwd: string, filePath: string, staged: boolean): Promise<{ oldContent: string; newContent: string }>
  gitStageFile(cwd: string, filePath: string): Promise<void>
  gitUnstageFile(cwd: string, filePath: string): Promise<void>
  gitStageAll(cwd: string): Promise<void>
  gitUnstageAll(cwd: string): Promise<void>
  gitCommit(cwd: string, message: string): Promise<string>
  gitPush(cwd: string): Promise<void>
  gitStartWatching(cwd: string): Promise<void>
  gitStopWatching(cwd: string): Promise<void>
  onGitStatusUpdate(cb: (data: { cwd: string; status: GitStatusData }) => void): () => void

  openInVSCode(cwd: string): Promise<void>
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
  loadSessionConfig(): Promise<UISessionConfig>
  saveSessionConfig(config: UISessionConfig): Promise<void>
  loadSlashCommands(): Promise<SlashCommandInfo[]>
  saveSlashCommands(commands: SlashCommandInfo[]): Promise<void>
  onSlashCommands(cb: (data: RoutedData<SlashCommandInfo[]>) => void): () => void
  onStatusLine(cb: (data: RoutedData<StatusLineData>) => void): () => void
  onSettingsChanged(cb: (settings: Record<string, unknown>) => void): () => void
  onSessionConfigChanged(cb: (config: UISessionConfig) => void): () => void

  // Account usage (5hr / 7-day rate limits)
  fetchAccountUsage(): Promise<AccountUsage>
  onAccountUsage(cb: (data: AccountUsage) => void): () => void

  // Block usage analytics
  fetchBlockUsage(): Promise<BlockUsageData>
  onBlockUsage(cb: (data: BlockUsageData) => void): () => void
}

// ---------------------------------------------------------------------------
// Account usage types (5hr / 7-day rate windows)
// ---------------------------------------------------------------------------

export interface RateWindow {
  usedPercent: number // 0-100
  resetsAt: string | null // ISO8601 timestamp
}

export interface AccountUsage {
  fiveHour: RateWindow
  sevenDay: RateWindow | null
  sevenDaySonnet: RateWindow | null
  sevenDayOpus: RateWindow | null
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
// UI session config
// ---------------------------------------------------------------------------

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
}

export interface SlashCommandInfo {
  name: string
  description?: string
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
