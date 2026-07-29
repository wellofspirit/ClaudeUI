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

/**
 * Client → Server: auth handshake.
 *
 * Exactly ONE credential is honoured. The server branches on `pwProof` first,
 * then `token`, and never falls through from a failed method to another — so a
 * client cannot try a weak credential and then a strong one on the same socket.
 *
 * `token` is optional as of Phase 2 (it was required before). The legacy
 * `{ type:'auth', token }` frame is byte-identical, so an older `/remote`
 * bundle cached in a phone browser still authenticates.
 */
export interface WsAuthRequest {
  type: 'auth'
  /** Random per-start bearer token from the URL fragment. */
  token?: string
  /**
   * Password proof: `hex(H)` where
   * `H = scrypt(NFC(password), salt, dkLen, {N,r,p})` using the salt/params
   * advertised by `GET /remote/auth-info`. The server compares `sha256(H)`
   * against the stored hash — see `src/main/services/remote-auth.ts`.
   */
  pwProof?: string
}

/** Server → Client: auth result */
export interface WsAuthResponse {
  type: 'auth-response'
  ok: boolean
  error?: string
  /** Which method the server accepted. Present on success. */
  method?: RemoteAuthMethod
  /**
   * Present only for `method: 'tailnet-identity'`. This frame is UNSOLICITED —
   * the server sends it on `connection`, before (and instead of waiting for) any
   * client `auth` frame, because identity lives entirely in the upgrade request
   * headers and there is nothing for the client to send. `login` is the
   * `Tailscale-User-Login` value the server accepted.
   */
  identity?: { login: string }
  /**
   * Failure only. `false` = the presented credential is definitively rejected;
   * the client must stop retrying with it (and drop any cached copy) rather
   * than spinning the reconnect backoff. Absent = unspecified, treat as
   * definitive.
   */
  retryable?: boolean
}

/**
 * KDF parameters for the password credential — the parsed form of
 * `remote_config.kdf_params`. Advertised verbatim by `/remote/auth-info` so a
 * future cost bump does not silently break older clients: the client MUST
 * derive from these and never from hardcoded constants.
 */
export interface RemoteKdfParams {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  dkLen: number
}

/**
 * Unauthenticated pre-handshake discovery (`GET /remote/auth-info`).
 *
 * Contains NO secret material — a salt is public by construction, and the
 * method list is observable anyway by attempting each method. It must never
 * carry the WS token, the mockup token, the E2E key, the password hash, the
 * hostname, version strings, or `lastError` (fingerprinting / path leaks).
 */
export interface RemoteAuthInfo {
  /** Bumped when the handshake grammar changes; a client refuses an unknown major. */
  version: 1
  /** Methods this server will accept on a new connection. Never empty while running. */
  methods: RemoteAuthMethod[]
  /** Present iff `methods` includes `'password'`. */
  password?: { saltHex: string; kdf: RemoteKdfParams }
  /**
   * Present iff `methods` includes `'tailnet-identity'`. Purely informational:
   * the server decides from the request headers, never from anything the client
   * sends.
   *
   * `login` is non-null ONLY when THIS request would be authenticated as the
   * node owner — i.e. it echoes back the caller's own trusted header value, so
   * it discloses nothing the caller did not already prove. It is null when the
   * request did not arrive through `tailscale serve`, AND when it did but
   * carried a login other than the owner's: a non-owner must fall through to
   * the password form rather than be told to connect credential-less (they
   * would just be refused). See `evaluateIdentity` in `remote-server.ts`.
   */
  identity?: { login: string | null }
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
  ModelRef,
  RemoteAuthMethod
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

// Re-export RemoteStatus / RemoteAuthMethod from the main types (canonical definition)
export type { RemoteStatus, RemoteAuthMethod } from './types'
