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
  /**
   * The event-log epoch (per-process instance id) under which `lastSeq` was
   * accumulated. Absent on a brand-new connection. When it does not match the
   * server's current epoch (e.g. the desktop app was restarted), `lastSeq` is
   * meaningless and the server MUST answer with a full snapshot rather than a
   * catchup that would falsely report "caught up" (M-DB4).
   */
  epoch?: string
}

/** Server → Client: catchup (replay missed events) */
export interface WsSyncCatchup {
  type: 'sync-catchup'
  events: EventEntry[]
  /** Current event-log epoch — the client stores it to send back on reconnect. */
  epoch: string
}

/** Server → Client: full state snapshot (too far behind or fresh connect) */
export interface WsSyncFull {
  type: 'sync-full'
  state: FullStateSnapshot
  /** Current event-log epoch — the client stores it to send back on reconnect. */
  epoch: string
  /**
   * Mockup-scoped, low-privilege token for building `/mockup` iframe URLs.
   * Delivered over the authenticated (and, on a tunnel, E2E-encrypted) WS
   * channel rather than the served HTML, so it is never handed to an
   * unauthenticated visitor who merely loads `/remote` (the WS token now
   * rides the URL fragment and is invisible to the HTTP GET — R3/H2).
   */
  mockupToken?: string
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

/** Client → Server: activate E2E encryption (key is NOT sent — both sides already have it) */
export interface WsE2EActivate {
  type: 'e2e-activate'
}

/** Server → Client: E2E acknowledged, all subsequent messages are encrypted */
export interface WsE2EAck {
  type: 'e2e-ack'
}

export type WsClientMessage =
  | WsAuthRequest
  | WsInvokeRequest
  | WsSyncRequest
  | WsPing
  | WsPong
  | WsE2EActivate
export type WsServerMessage =
  | WsAuthResponse
  | WsInvokeResponse
  | WsEvent
  | WsSyncCatchup
  | WsSyncFull
  | WsPing
  | WsPong
  | WsE2EAck

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
  SlashCommandInfo,
  WorktreeInfo,
  EngineId,
  ModelRef
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
  thinkingMode?: string
  reasoningVariant?: string | null
  statusLine: StatusLineData | null
  slashCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
  /** Whether cli.js/the engine is live for this session. A remote client MUST
   *  carry this so its first send steers the running session instead of
   *  respawning it (as Claude) — see H15 / InputBox.doSend. */
  sdkActive?: boolean
  /** Engine chosen at session-creation time — so a remote first-send spawns the
   *  correct engine rather than defaulting to claude. */
  selectedEngineId?: EngineId
  /** Model picker value within the selected engine. */
  selectedModel?: string
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
  /** Per-session engine + model map (sessionId → { engineId, model? }). Carried
   *  so a remote client's saves don't round-trip an empty map that wipes every
   *  session's engine/model mapping on the desktop (H15). */
  sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
  /** Hidden session ids — carried for the same non-destructive-save reason. */
  hiddenSessions?: string[]
  /** Hidden project keys — carried for the same non-destructive-save reason. */
  hiddenProjects?: string[]
}

// Re-export RemoteStatus from the main types (canonical definition)
export type { RemoteStatus } from './types'
