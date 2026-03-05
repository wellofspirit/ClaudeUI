// ---------------------------------------------------------------------------
// Remote Access WebSocket Protocol
// ---------------------------------------------------------------------------

/** Client → Server: request (mirrors ipcRenderer.invoke) */
export interface WsInvokeRequest {
  type: 'invoke'
  id: string
  channel: string
  args: unknown[]
}

/** Server → Client: response to an invoke */
export interface WsInvokeResponse {
  type: 'invoke-response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Server → Client: push event (mirrors webContents.send) */
export interface WsEvent {
  type: 'event'
  seq: number
  channel: string
  args: unknown[]
}

/** Client → Server: auth handshake */
export interface WsAuthRequest {
  type: 'auth'
  token: string
}

/** Server → Client: auth result */
export interface WsAuthResponse {
  type: 'auth-response'
  ok: boolean
  error?: string
}

/** Client → Server: state sync request */
export interface WsSyncRequest {
  type: 'sync'
  lastSeq: number
}

/** Server → Client: catchup (replay missed events) */
export interface WsSyncCatchup {
  type: 'sync-catchup'
  events: EventEntry[]
}

/** Server → Client: full state snapshot (too far behind or fresh connect) */
export interface WsSyncFull {
  type: 'sync-full'
  state: FullStateSnapshot
}

/** Bidirectional keepalive */
export interface WsPing {
  type: 'ping'
  timestamp: number
}
export interface WsPong {
  type: 'pong'
  timestamp: number
}

export type WsClientMessage = WsAuthRequest | WsInvokeRequest | WsSyncRequest | WsPing | WsPong
export type WsServerMessage = WsAuthResponse | WsInvokeResponse | WsEvent | WsSyncCatchup | WsSyncFull | WsPing | WsPong

// ---------------------------------------------------------------------------
// Event Log
// ---------------------------------------------------------------------------

export interface EventEntry {
  seq: number
  channel: string
  args: unknown[]
  timestamp: number
}

// ---------------------------------------------------------------------------
// Full State Snapshot (sent to clients on fresh connect or when too far behind)
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  TaskNotification,
  TaskProgress,
  StatusLineData,
  DirectoryGroup,
  TeammateInfo,
  SlashCommandInfo,
  WorktreeInfo
} from './types'

export interface PerSessionSnapshot {
  routingId: string
  cwd: string
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  todos: TodoItem[]
  taskNotifications: TaskNotification[]
  taskProgressMap: Record<string, TaskProgress>
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  permissionMode: string
  effort: string
  statusLine: StatusLineData | null
  teamName: string | null
  teammates: Record<string, TeammateInfo>
  focusedAgentId: string | null
  slashCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
}

export interface FullStateSnapshot {
  /** Current sequence number (client should track from here) */
  seq: number
  /** All active sessions */
  sessions: Record<string, PerSessionSnapshot>
  /** Directory listing for the sidebar */
  directories: DirectoryGroup[]
  /** Which session is active (routingId) */
  activeSessionId: string | null
  /** App settings (theme, UI prefs, etc.) */
  settings: Record<string, unknown>
  /** Recent session IDs */
  recentSessionIds: string[]
  /** Pinned session IDs */
  pinnedSessionIds: string[]
  /** Custom session titles */
  customTitles: Record<string, string>
  /** Worktree info map */
  worktreeInfoMap: Record<string, WorktreeInfo>
}

// Re-export RemoteStatus from the main types (canonical definition)
export type { RemoteStatus } from './types'
