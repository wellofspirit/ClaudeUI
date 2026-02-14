export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'cli_command' | 'api_error' | 'compact_separator'
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
  sendPrompt(routingId: string, prompt: string): Promise<void>
  cancelSession(routingId: string): Promise<void>
  respondApproval(routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  loadSessionHistory(sessionId: string, projectKey: string): Promise<{ messages: ChatMessage[]; taskNotifications: TaskNotification[]; customTitle: string | null; agentIdToToolUseId: Record<string, string> }>
  loadSubagentHistory(sessionId: string, projectKey: string, agentId: string): Promise<ChatMessage[]>
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
  writeCustomTitle(sessionId: string, projectKey: string, title: string): Promise<void>
  getPlanContent(routingId: string): Promise<string | null>
  getSessionLogPath(routingId: string): Promise<string | null>
  watchSession(routingId: string, sessionId: string, projectKey: string): Promise<void>
  unwatchSession(routingId: string): Promise<void>
  onWatchUpdate(cb: (data: WatchUpdate) => void): () => void
  onDirectoriesChanged(cb: () => void): () => void
  openInVSCode(cwd: string): Promise<void>
}
