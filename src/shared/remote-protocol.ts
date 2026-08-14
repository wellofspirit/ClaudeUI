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
  /**
   * File-scoped, low-privilege token for the `/sent-file` route (ADR-043 §5).
   * Same reasoning as {@link WsSyncFull.mockupToken}: it rides an `<a download>`
   * href / `<img src>` and is therefore URL-visible, so it must be separate
   * from the WS token and is only ever delivered over the authenticated (and,
   * on a tunnel, E2E-encrypted) channel.
   */
  fileToken?: string
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

// ---------------------------------------------------------------------------
// Step-up ceremony (SyncCore phase 2 — ADR-052 decision 5, security.md §Grant decay)
// ---------------------------------------------------------------------------

/**
 * Client → Server: prove human presence to obtain the decaying `shell` grant.
 *
 * Deliberately a TRANSPORT frame rather than a registry channel: a channel
 * would need a capability the caller already holds, which is the wrong layer
 * for "give me a capability I do not have". `pwProof` is the same
 * `hex(scrypt(...))` value {@link WsAuthRequest} carries — this phase's factor
 * is a fresh password proof; passkeys replace it later (security.md keeps the
 * password as the fallback path).
 */
export interface WsStepUpRequest {
  type: 'step-up'
  pwProof?: string
}

/** Machine-readable reason a step-up was refused (the client maps it to copy). */
export type StepUpFailureCode =
  /** The desktop-side "Allow remote terminal" toggle is OFF. */
  | 'terminal-disabled'
  /** No password credential is provisioned, so there is no step-up factor. */
  | 'no-password'
  /** The proof did not verify (consumes the password-failure budget). */
  | 'invalid-proof'
  /** The key is over the shared password-failure budget. */
  | 'throttled'
  /** Malformed frame / no proof presented. */
  | 'malformed'

/** Server → Client: step-up outcome. */
export interface WsStepUpResponse {
  type: 'step-up-response'
  ok: boolean
  /** Human-readable copy, safe to render inline. */
  error?: string
  code?: StepUpFailureCode
  /** `false` ⇒ the client must stop retrying as-is (throttled / disabled). */
  retryable?: boolean
  /** Success only: epoch-ms deadline of the grant just armed. */
  expiresAt?: number
}

/**
 * Error string a shell-capability dispatch throws when the connection holds no
 * live `shell` grant. Pinned here (not a free-form message) because the web
 * client matches on it to raise the step-up prompt — see
 * {@link isNeedsStepUpError}.
 */
export const NEEDS_STEP_UP_ERROR = 'needs-step-up'

/**
 * Error string a shell-capability dispatch throws when the desktop-side
 * "Allow remote terminal" toggle is OFF. Distinct from
 * {@link NEEDS_STEP_UP_ERROR} on purpose: no ceremony can fix it, so the client
 * must NOT prompt for a password.
 */
export const TERMINAL_DISABLED_ERROR = 'terminal-disabled'

function messageIncludes(message: unknown, needle: string): boolean {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Error
        ? message.message
        : String(message ?? '')
  return text.includes(needle)
}

/** True for the error a shell dispatch throws when a step-up is required. */
export function isNeedsStepUpError(message: unknown): boolean {
  return messageIncludes(message, NEEDS_STEP_UP_ERROR)
}

/** True for the error a shell dispatch throws while the terminal toggle is OFF. */
export function isTerminalDisabledError(message: unknown): boolean {
  return messageIncludes(message, TERMINAL_DISABLED_ERROR)
}

// ---------------------------------------------------------------------------
// Terminal stream (SyncCore phase 2 — the VOLATILE lane)
// ---------------------------------------------------------------------------
//
// These frames never enter the EventLog and never reach the audit log: PTY
// content and keystrokes capture secrets (security.md §Audit). They are
// transport frames rather than invokes so a keystroke costs no request/response
// bookkeeping — and they are accepted ONLY from a connection that currently
// holds an unexpired `shell` grant AND is attached to the terminal.
//
// `dataB64` is UTF-8-then-base64 (see shared/base64-text.ts).

/** Client → Server: keystrokes for an attached terminal. Refreshes grant decay. */
export interface WsTermInput {
  type: 'term-input'
  termId: string
  dataB64: string
}

/** Client → Server: viewport size for an attached terminal. */
export interface WsTermResize {
  type: 'term-resize'
  termId: string
  cols: number
  rows: number
}

/** Server → Client: PTY output, sent only to attached sockets. */
export interface WsTermData {
  type: 'term-data'
  termId: string
  dataB64: string
}

/** Server → Client: the PTY exited, sent only to attached sockets. */
export interface WsTermExit {
  type: 'term-exit'
  termId: string
  exitCode: number
}

/** Why the server dropped a remote attachment. */
export type TermDetachReason =
  /** The desktop-side terminal toggle was turned OFF. */
  | 'policy-off'
  /** The socket could not keep up and was dropped instead of buffered. */
  | 'backpressure'
  /** The connection's `shell` grant decayed. */
  | 'grant-expired'

/** Server → Client: this socket is no longer attached to `termId`. */
export interface WsTermDetached {
  type: 'term-detached'
  termId: string
  reason: TermDetachReason
}

export type WsClientMessage =
  | WsAuthRequest
  | WsInvokeRequest
  | WsSyncRequest
  | WsPing
  | WsPong
  | WsE2EActivate
  | WsStepUpRequest
  | WsTermInput
  | WsTermResize
export type WsServerMessage =
  | WsAuthResponse
  | WsInvokeResponse
  | WsEvent
  | WsSyncCatchup
  | WsSyncFull
  | WsPing
  | WsPong
  | WsE2EAck
  | WsStepUpResponse
  | WsTermData
  | WsTermExit
  | WsTermDetached

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
  SentFile,
  QueuedItem,
  TaskNotification,
  TaskProgress,
  StatusLineData,
  DirectoryGroup,
  SlashCommandInfo,
  WorktreeInfo,
  EngineId,
  ModelRef,
  MeteringSnapshot,
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
  /** Files delivered via SendUserFile. Optional so an older remote server that
   *  predates the widget still hydrates (falls back to []). */
  sentFiles?: SentFile[]
  /** Queue of record (ADR-053) — pending items only; consumed ones are already
   *  chat messages. Optional for the same older-server-compat reason as
   *  `sentFiles`: without it every resync silently emptied the queue card. */
  queue?: QueuedItem[]
  taskNotifications: TaskNotification[]
  /** Started-but-not-finished tasks (task_started with no task_notification
   *  yet) — without this a remote client that connects or resyncs mid-task
   *  reads an async-launched Task as already complete. */
  activeTasks?: Record<string, { taskId: string; taskType: string }>
  taskProgressMap: Record<string, TaskProgress>
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  permissionMode: string
  /**
   * `null` when unset. The declaration used to say `string`, but no producer has
   * ever sent one for an unset value — the renderer's own snapshot builder emits
   * the store's `null` — so the type was a latent lie that only surfaced when
   * SyncCore's canonical state was compared against it (phase 4a shadow parity).
   */
  effort: string | null
  thinkingMode?: string | null
  reasoningVariant?: string | null
  statusLine: StatusLineData | null
  /**
   * Engine-neutral metering snapshot. Optional for the same older-server-compat
   * reason as {@link PerSessionSnapshot.queue} / {@link PerSessionSnapshot.sentFiles}:
   * before SyncCore phase 4a the snapshot carried no metering at all, so every
   * resync silently blanked the TopBar breakdown on remote clients.
   */
  metering?: MeteringSnapshot
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
  /**
   * Whether the host's Claude settings carry `disableAutoMode: "disable"`
   * (ADR-050). The remote client can't read `~/.claude/settings.json` itself,
   * and it needs this to gate the auto default when IT creates a session.
   * Optional: an older host omits it, which reads as "not disabled" — the
   * post-spawn rejection fallback stays the backstop for that mixed-version
   * window.
   */
  autoModeDisabledBySettings?: boolean
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
