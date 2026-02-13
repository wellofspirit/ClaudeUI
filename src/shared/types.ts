export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  toolResult?: string
  isError?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  timestamp: number
}

export interface SessionStatus {
  state: 'idle' | 'running' | 'error'
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

export interface ModelInfo {
  value: string
  displayName: string
  description: string
}

export interface ClaudeAPI {
  platform: string
  pickFolder(): Promise<string | null>
  createSession(cwd: string, effort?: string): Promise<void>
  sendPrompt(prompt: string): Promise<void>
  cancelSession(): Promise<void>
  respondApproval(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  onMessage(cb: (message: ChatMessage) => void): () => void
  onStreamEvent(cb: (data: StreamDelta) => void): () => void
  onApprovalRequest(cb: (approval: PendingApproval) => void): () => void
  onStatus(cb: (status: SessionStatus) => void): () => void
  onResult(cb: (result: SessionResult) => void): () => void
  onError(cb: (error: string) => void): () => void
  onToolResult(cb: (data: { toolUseId: string; result: string; isError: boolean }) => void): () => void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  onTaskProgress(cb: (data: TaskProgress) => void): () => void
  onTaskNotification(cb: (data: TaskNotification) => void): () => void
  onSubagentStream(cb: (data: SubagentStreamDelta) => void): () => void
  onSubagentMessage(cb: (data: SubagentMessageData) => void): () => void
  onSubagentToolResult(cb: (data: SubagentToolResultData) => void): () => void
  onPermissionMode(cb: (mode: PermissionMode) => void): () => void
  onBackgroundOutput(cb: (data: BackgroundOutput) => void): () => void
  watchBackground(toolUseId: string): Promise<void>
  unwatchBackground(toolUseId: string): Promise<void>
  readBackgroundRange(toolUseId: string, offset: number, length: number): Promise<string>
  stopTask(toolUseId: string): Promise<{ success: boolean; error?: string }>
  setPermissionMode(mode: string): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: string): Promise<void>
  getModels(): Promise<ModelInfo[]>
}
