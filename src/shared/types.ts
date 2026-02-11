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

export interface ClaudeAPI {
  pickFolder(): Promise<string | null>
  createSession(cwd: string): Promise<void>
  sendPrompt(prompt: string): Promise<void>
  cancelSession(): Promise<void>
  respondApproval(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): Promise<void>
  onMessage(cb: (message: ChatMessage) => void): () => void
  onStreamEvent(cb: (data: StreamDelta) => void): () => void
  onApprovalRequest(cb: (approval: PendingApproval) => void): () => void
  onStatus(cb: (status: SessionStatus) => void): () => void
  onResult(cb: (result: SessionResult) => void): () => void
  onError(cb: (error: string) => void): () => void
  onToolResult(cb: (data: { toolUseId: string; result: string; isError: boolean }) => void): () => void
}
