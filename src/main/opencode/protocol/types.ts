// Trimmed types derived from opencode 1.17.9 /doc snapshot

export interface ModelCapabilities {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  interleaved?: { field: string }
}

export interface Model {
  id: string
  providerID: string
  api: { id: string; url: string; npm: string }
  name: string
  family: string
  capabilities: ModelCapabilities
  cost?: { input: number; output: number; cache?: { read: number; write: number } }
  limit?: { context: number; output?: number; input?: number }
  status?: string
  /** Effort variants keyed by variant name (e.g. 'none', 'thinking', 'low', 'high').
   *  Present only when capabilities.reasoning === true. */
  variants?: Record<string, Record<string, unknown>>
}

export interface Provider {
  id: string
  name: string
  source: 'env' | 'config' | 'custom' | 'api'
  env: string[]
  options: Record<string, unknown>
  models: Record<string, Model>
  key?: string
}

export interface ConfigProvidersResponse {
  providers: Provider[]
  default?: Record<string, string>
}

export interface ProviderListResponse {
  all: Provider[]
}

export type AuthOption =
  | {
      type: 'api'
      label: string
      prompts?: Array<{ type: string; key: string; message: string; secret?: boolean }>
    }
  | {
      type: 'oauth'
      label: string
      prompts?: Array<{
        type: string
        key: string
        message: string
        options?: Array<{ label: string; value: string; hint?: string }>
      }>
    }

export type AuthCredentials =
  | { type: 'api'; key: string }
  | { type: 'oauth'; token: string; refreshToken?: string; expiresAt?: number }

export interface Session {
  id: string
  slug?: string
  projectID?: string
  directory?: string
  path?: string
  parentID?: string
  title?: string
  summary?: { additions: number; deletions: number; files: number }
}

export interface CreateSessionRequest {
  parentID?: string
  title?: string
}

export interface PromptRequest {
  messageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  noReply?: boolean
  tools?: Record<string, boolean>
  system?: string
  parts: Array<TextPartInput | FilePartInput>
  /** Effort variant name to use for this prompt (e.g. 'none', 'thinking', 'low'). Omit to use opencode default. */
  variant?: string
}

export interface TextPartInput {
  type: 'text'
  text: string
}

export interface FilePartInput {
  type: 'file'
  mime: string
  url: string
}

export interface ForkRequest {
  messageID?: string
}

// SSE events from GET /event
export interface OpencodeEvent {
  id: string
  type: string
  properties: Record<string, unknown>
}

// Known event type string constants (from /doc EventMessage* schemas)
// Command entry from GET /command
export interface Command {
  name: string
  description?: string
  agent?: string
  model?: string
  template: string
  subtask?: boolean
  // source and hints may not serialize through the v1 OpenAPI — treat as optional/best-effort
  source?: 'command' | 'mcp' | 'skill'
  hints?: string[]
}

// Command invocation body for POST /session/{id}/command
export interface RunCommandRequest {
  command: string
  arguments: string
  agent?: string
  model?: string
  variant?: string
  messageID?: string
  parts?: unknown[]
}

// Skill entry from GET /skill
export interface Skill {
  name: string
  description?: string
  location: string
  content: string
}

/**
 * A single question item from opencode's `question.asked` SSE event.
 * Mirrors QInfo from opencode 1.17.9 /doc.
 */
export interface QuestionInfo {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export const EVENT_TYPES = {
  SERVER_CONNECTED: 'server.connected',
  SESSION_CREATED: 'session.created',
  SESSION_UPDATED: 'session.updated',
  SESSION_DELETED: 'session.deleted',
  SESSION_STATUS: 'session.status',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_REMOVED: 'message.removed',
  MESSAGE_PART_UPDATED: 'message.part.updated',
  MESSAGE_PART_REMOVED: 'message.part.removed',
  MESSAGE_PART_DELTA: 'message.part.delta',
  SESSION_NEXT_STEP_STARTED: 'session.next.step.started',
  SESSION_NEXT_STEP_ENDED: 'session.next.step.ended',
  SESSION_NEXT_STEP_FAILED: 'session.next.step.failed',
  SESSION_NEXT_TEXT_STARTED: 'session.next.text.started',
  SESSION_NEXT_TEXT_DELTA: 'session.next.text.delta',
  SESSION_NEXT_TEXT_ENDED: 'session.next.text.ended',
  SESSION_NEXT_TOOL_CALLED: 'session.next.tool.called',
  SESSION_NEXT_TOOL_SUCCESS: 'session.next.tool.success',
  SESSION_NEXT_TOOL_FAILED: 'session.next.tool.failed',
  PERMISSION_ASKED: 'permission.asked',
  PERMISSION_REPLIED: 'permission.replied',
  QUESTION_ASKED: 'question.asked',
  QUESTION_REPLIED: 'question.replied',
  QUESTION_REJECTED: 'question.rejected',
  COMMAND_EXECUTED: 'command.executed',
} as const

export type KnownEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]
