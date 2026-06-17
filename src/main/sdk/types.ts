/**
 * Public types for our local SDK layer. Designed as a drop-in for the subset
 * of `@anthropic-ai/claude-agent-sdk` that ClaudeUI actually uses.
 *
 * Messages are typed as `Record<string, unknown>` to match how the rest of
 * the codebase treats them — we never trust a Zod schema at this boundary.
 */

/**
 * Stream-json messages emitted by cli.js, discriminated on `type`. This is
 * a tagged union with a permissive index signature:
 *
 *   - The `type` field enables narrowing in consumer switches so the
 *     compiler knows `msg.event` exists on a `stream_event` branch but not
 *     on `result`.
 *   - `[k: string]: unknown` keeps the union forward-compatible: cli.js may
 *     add new top-level fields at any version bump, and the consumer can
 *     still read them with a cast (same semantics as the old
 *     `Record<string, unknown>` shape).
 *
 * Variants cover what ClaudeUI actually reads. If a cli.js message has a
 * `type` we haven't listed, `UnknownSDKMessage` absorbs it.
 */
export type SDKMessage =
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | SystemMessage
  | ResultMessage
  | ToolProgressMessage
  | RequestUsageMessage
  | RateLimitEventMessage
  | BashOutputMessage
  | AuthStatusMessage
  | ControlRequestMessage
  | ControlResponseMessage
  | ControlCancelRequestMessage

/** Fields every stream-json message may carry. `session_id` lands on the
 *  first message; `slug` flows with session-scoped messages. */
interface BaseSDKMessage {
  session_id?: string
  slug?: string
  [k: string]: unknown
}

export interface AssistantMessage extends BaseSDKMessage {
  type: 'assistant'
  /** The Anthropic-API `message` block. `id` is shared across partial
   *  updates so consumers can upsert by it. */
  message?: {
    id?: string
    role?: string
    content?: unknown
    usage?: Record<string, unknown>
    [k: string]: unknown
  }
  parent_tool_use_id?: string | null
  /** Present on the JSONL transcript (not the SDK stdout frame) when this
   *  "assistant" frame is a surfaced API error. Prefer `error` for live
   *  detection. */
  isApiErrorMessage?: boolean
  /** Top-level error code on a surfaced API-error frame — the reliable live
   *  signal on the SDK stdout stream (e.g. "authentication_failed"). Absent on
   *  normal/benign synthetic assistant frames. */
  error?: string
}

export interface UserMessage extends BaseSDKMessage {
  type: 'user'
  message?: {
    role?: string
    content?: unknown
    [k: string]: unknown
  }
  parent_tool_use_id?: string | null
}

export interface StreamEventMessage extends BaseSDKMessage {
  type: 'stream_event'
  event?: {
    type?: string
    delta?: {
      type?: string
      text?: string
      thinking?: string
      [k: string]: unknown
    }
    [k: string]: unknown
  }
  parent_tool_use_id?: string | null
}

export interface SystemMessage extends BaseSDKMessage {
  type: 'system'
  subtype?:
    | 'init'
    | 'status'
    | 'task_started'
    | 'task_updated'
    | 'task_notification'
    | 'queued_command_consumed'
    | 'compact_boundary'
    | 'model_refusal_fallback'
    | 'model_fallback'
    | string
  permissionMode?: string
  /** init-only fields */
  /** Resolved canonical model id (e.g. "claude-opus-4-8") — what the `default`
   *  alias and other server-resolved aliases actually map to this session. */
  model?: string
  slash_commands?: string[]
  skills?: string[]
  mcp_servers?: Array<{ name: string; status: string }>
  /** task_started / task_updated / task_notification shared fields */
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  /** task_updated patch — partial update to the task's state record */
  patch?: {
    status?: string
    end_time?: number
    [k: string]: unknown
  }
  /** task_notification-only fields */
  output_file?: string
  status?: string
  summary?: string
  usage?: {
    total_tokens?: number
    tool_uses?: number
    duration_ms?: number
  } | null
  /** queued_command_consumed-only field */
  prompt?: string
  /** model_refusal_fallback / model_fallback fields (docs/protocol/04-system-subtypes.md §4.20–4.21) */
  trigger?: string
  direction?: 'retry' | 'revert' | 'sticky'
  original_model?: string
  fallback_model?: string
  content?: string
  retracted_message_uuids?: string[]
}

export interface ResultMessage extends BaseSDKMessage {
  type: 'result'
  subtype?: string
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  result?: string
  errors?: string[]
}

export interface ToolProgressMessage extends BaseSDKMessage {
  type: 'tool_progress'
  tool_use_id?: string
  tool_name?: string
  parent_tool_use_id?: string | null
  elapsed_time_seconds?: number
}

export interface RequestUsageMessage extends BaseSDKMessage {
  type: 'request_usage'
  usage?: Record<string, unknown>
}

export interface RateLimitEventMessage extends BaseSDKMessage {
  type: 'rate_limit_event'
  header_utilization?: Record<string, { utilization: number; resets_at: number }>
}

export interface BashOutputMessage extends BaseSDKMessage {
  type: 'bash_output'
  tool_use_id?: string
  output?: string
  total_lines?: number
  total_bytes?: number
}

export interface AuthStatusMessage extends BaseSDKMessage {
  type: 'auth_status'
  isAuthenticating?: boolean
  output?: string
  error?: string
  uuid?: string
}

/** Raised by cli.js; handled internally by ControlChannel — never reaches
 *  consumer iterators today, but typed here so the union is closed on
 *  the actual wire set. */
export interface ControlRequestMessage extends BaseSDKMessage {
  type: 'control_request'
  request_id?: string
  request?: { subtype?: string; [k: string]: unknown }
}

export interface ControlResponseMessage extends BaseSDKMessage {
  type: 'control_response'
  response?: {
    subtype?: 'success' | 'error' | string
    request_id?: string
    response?: unknown
    error?: unknown
    pending_permission_requests?: unknown[]
  }
}

export interface ControlCancelRequestMessage extends BaseSDKMessage {
  type: 'control_cancel_request'
  request_id?: string
}

/** Helper for cli.js messages whose `type` is outside the union we've
 *  codified. Not part of `SDKMessage` itself — keeping it out of the union
 *  lets consumer `switch (msg.type)` narrow exhaustively to known
 *  variants. Use this shape when you're parsing raw stream-json output
 *  (wire log, tests) where any top-level type could legitimately appear. */
export interface UnknownSDKMessage extends BaseSDKMessage {
  type: string
}

/** Direction of a wire-log entry — 'in' = cli.js → us; 'out' = us → cli.js. */
export type WireDirection = 'in' | 'out'

/** One captured stream-json line. See sdk/wire-log.ts. */
export interface WireEntry {
  seq: number
  t: number
  dir: WireDirection
  line: Record<string, unknown>
}

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'auto'
  | 'dontAsk'
  | 'plan'

export interface CanUseToolResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
  updatedPermissions?: PermissionUpdate[]
  interrupt?: boolean
}

export interface CanUseToolContext {
  signal: AbortSignal
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  toolUseId?: string
  agentId?: string
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: CanUseToolContext
) => Promise<CanUseToolResult>

export interface ThinkingConfig {
  type: 'disabled' | 'enabled' | 'adaptive' | string
  budgetTokens?: number
  /**
   * Streaming display hint for thinking blocks. Forwarded as
   * --thinking-display; ignored when type is 'disabled'.
   */
  display?: 'streaming' | 'summarized' | string
}

export interface SystemPromptPreset {
  type: 'preset'
  preset: 'claude_code' | string
  append?: string
}

export type SystemPrompt = string | string[] | SystemPromptPreset

/**
 * Hook event callback. Fires when cli.js dispatches a hook_callback
 * control_request for a matcher-group this callback is registered under.
 */
export type HookCallback = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  context: { signal: AbortSignal }
) => Promise<unknown> | unknown

export interface HookMatcher {
  matcher?: string
  hooks: HookCallback[]
  timeout?: number
}

/**
 * Keys are hook event names: 'PreToolUse', 'PostToolUse', 'Notification',
 * 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'SubagentStop',
 * 'PreCompact', 'PostCompact', ...
 */
export type HooksConfig = Record<string, HookMatcher[]>

/** MCP elicitation request — user-input prompt initiated by an MCP server. */
export interface ElicitationContext {
  serverName: string
  message?: unknown
  mode?: string
  url?: string
  elicitationId?: string
  requestedSchema?: unknown
  title?: string
  displayName?: string
  description?: string
}

export type ElicitationCallback = (
  params: ElicitationContext,
  opts: { signal: AbortSignal }
) => Promise<unknown>

export type GetOAuthTokenCallback = (opts: { signal: AbortSignal }) => Promise<string | null>

/**
 * Generic user-dialog prompt initiated by cli.js
 * (`control_request { subtype: 'request_user_dialog' }`).
 *
 * Fields come straight from cli.js's `requestUserDialog` bridge method
 * (see vendor/claude-cli/cli.js ~char 11933210). `dialog_kind` discriminates
 * the UX (for example: a choice between candidate tool uses). When no
 * handler is registered we default to `{ behavior: 'cancelled' }` so cli.js
 * stops waiting — blocking on an unhandled dialog stalls the feature that
 * opened it.
 */
export interface UserDialogRequest {
  dialogKind?: string
  payload?: unknown
  toolUseId?: string
}

export interface UserDialogResult {
  behavior?: 'cancelled' | 'accepted' | string
  [k: string]: unknown
}

export type UserDialogCallback = (
  request: UserDialogRequest,
  opts: { signal: AbortSignal }
) => Promise<UserDialogResult>

export type SpawnClaudeCodeProcess = (opts: {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}) => import('node:child_process').ChildProcess

/** Stdio MCP server (`type: 'stdio'`) — child process with JSON-RPC over stdio. */
export interface McpServerStdio {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** HTTP MCP server — remote JSON-RPC. */
export interface McpServerHttp {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/** SSE MCP server. */
export interface McpServerSse {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

/**
 * In-process "SDK" MCP server produced by `createSdkMcpServer()`. Lives
 * inside our process; its tools are called via JSON-RPC over the CLI's
 * control channel (subtype: `mcp_message`).
 *
 * `instance` is a `McpServer` from `@modelcontextprotocol/sdk`. We keep
 * the tool list as plain descriptors alongside so initialize payloads
 * and introspection don't have to walk the McpServer internals.
 */
export interface SdkMcpServer {
  type: 'sdk'
  name: string
  version?: string
  tools: SdkMcpTool[]
  /** Underlying MCP SDK server instance (wired to a Transport by McpHost). */
  instance?: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
}

export type McpServerConfig = McpServerStdio | McpServerHttp | McpServerSse | SdkMcpServer

/**
 * A tool registered on an in-process SDK MCP server. The schema is a record
 * of Zod validators (or any runtime with `.parse()`), matching the upstream
 * `tool()` helper's signature.
 */
export interface SdkMcpTool {
  name: string
  description: string
  inputSchema: Record<string, ZodLike>
  handler: (input: Record<string, unknown>) => Promise<ToolResultContent>
}

/** Minimal Zod-shaped interface — we only need parsing and JSON schema conversion. */
export interface ZodLike {
  parse(input: unknown): unknown
  // Internal Zod def used for schema introspection
  _def?: unknown
  // Zod v4 exposes .isOptional()
  isOptional?(): boolean
  optional?(): ZodLike
  describe?(text: string): ZodLike
}

export interface ToolResultContent {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: string; [k: string]: unknown }
  >
  isError?: boolean
}

export type SettingSource = 'user' | 'project' | 'local'

/**
 * Permission rule update. Mirrors the upstream SDK's PermissionUpdate
 * discriminated union — kept verbatim so existing callers that cast to it
 * don't need rewrites.
 */
export type PermissionRuleValue = { toolName: string; ruleContent?: string }
export type PermissionBehavior = 'allow' | 'deny' | 'ask'
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'
export type PermissionUpdate =
  | {
      type: 'addRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'replaceRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | {
      type: 'addDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }

export interface QueryOptions {
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  systemPrompt?: SystemPrompt
  maxTurns?: number
  /** Tool-allowlist shape: array (possibly empty) or `'default'`. undefined = omit. */
  tools?: string[] | 'default'
  allowedTools?: string[]
  disallowedTools?: string[]
  thinking?: ThinkingConfig
  persistSession?: boolean
  abortController?: AbortController
  mcpServers?: Record<string, McpServerConfig>
  canUseTool?: CanUseTool
  settingSources?: SettingSource[]
  includePartialMessages?: boolean
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string
  resume?: string
  stderr?: (chunk: Buffer) => void
  /**
   * Executable overrides. Default spawn target is the rebundled Bun binary
   * (`bun-claude[.exe]`) resolved by `locateBunClaude()`. Callers can swap
   * in a different executable for tests or alternative runtimes.
   */
  pathToClaudeCodeExecutable?: string
  executable?: string
  executableArgs?: string[]
  /**
   * When true, `pathToClaudeCodeExecutable` is NOT injected as an argv entry
   * before `buildArgs(options)` — the executable is already self-contained
   * (e.g. our rebundled Bun binary with cli.js embedded). When false/unset,
   * legacy Node-spawn behavior: `[executable, cliPath, ...buildArgs()]`.
   */
  standaloneExecutable?: boolean
  /**
   * Env overlay merged on top of process.env for the CLI child.
   * Historically used for `{ ELECTRON_RUN_AS_NODE: '1' }` under the old
   * Node-spawn pipeline; unnecessary with the standalone Bun binary.
   */
  env?: Record<string, string | undefined>
  /**
   * Extra CLI args as a flag-bag. Keys become `--<key>`; value `null` means
   * boolean flag, string means `--<key> <value>`. SDK-compatible shape.
   */
  extraArgs?: Record<string, string | null>
  /**
   * Sandbox config blob — merged into the `--settings` JSON at spawn time.
   * Shape is app-defined; cli.js reads it from the settings.sandbox key.
   */
  sandbox?: Record<string, unknown>
  /** Emit hook_event control requests to this handler. */
  includeHookEvents?: boolean
  /** Single agent name — forwarded as --agent. */
  agent?: string
  /** When true, skip permission prompts entirely (maps to --allow-dangerously-skip-permissions). */
  allowDangerouslySkipPermissions?: boolean
  /** Initial permission settings baked into the session (forwarded via initialize). */
  settings?: Record<string, unknown>
  /** Ring-buffer capacity for the wire log accessible via queryHandle.wireLog().
   *  Default 1000 entries. Each entry is tiny (sequence + timestamp + line
   *  reference), but stream_event deltas can arrive at 100+ per turn, so
   *  bump this only when a debug dump actually needs the history. */
  wireLogCapacity?: number

  // --- Initialize-payload fields (not CLI flags) --------------------------
  /** Hook callbacks, registered at initialize and fired via hook_callback. */
  hooks?: HooksConfig
  /** JSON schema for structured outputs. Forwarded via initialize. */
  jsonSchema?: unknown
  /** Appended to the subagent system prompt (not CLI flag). */
  appendSubagentSystemPrompt?: string
  /** Strip dynamic (per-user) sections from the system prompt. */
  excludeDynamicSections?: boolean
  /** Custom agent definitions for this session. */
  agents?: Record<string, unknown>
  /** Enable prompt suggestions. */
  promptSuggestions?: boolean
  /** Enable agent-progress summaries. */
  agentProgressSummaries?: boolean

  // --- Callbacks ---------------------------------------------------------
  /** MCP elicitation prompt handler. */
  onElicitation?: ElicitationCallback
  /** OAuth token refresh provider. */
  getOAuthToken?: GetOAuthTokenCallback
  /**
   * Handler for cli.js's generic `request_user_dialog` control_request.
   * When omitted we auto-respond `{ behavior: 'cancelled' }` so cli.js
   * doesn't hang on dialogs no consumer has wired up.
   */
  onUserDialog?: UserDialogCallback
  /**
   * Opt into cli.js's `auth_status` stream events. When true, the child
   * emits `{ type: 'auth_status', ... }` lines on auth-state changes
   * (authenticate start/finish, errors). Off by default — existing
   * consumers don't expect the extra line type.
   */
  enableAuthStatus?: boolean
  /** Override the default child_process.spawn with a custom launcher. */
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess

  // --- Additional pass-through flags mirroring the upstream SDK ---
  additionalDirectories?: string[]
  assistant?: boolean
  betas?: string[]
  channels?: string[]
  continueConversation?: boolean
  debug?: boolean
  debugFile?: string
  fallbackModel?: string
  forkSession?: boolean
  maxBudgetUsd?: number
  permissionPromptToolName?: string
  plugins?: Array<{ type: 'local'; path: string }>
  resumeSessionAt?: string
  sessionId?: string
  sessionMirror?: boolean
  strictMcpConfig?: boolean
  taskBudget?: { total: number }
}

export interface QueryInput {
  prompt: string | AsyncIterable<SDKMessage>
  options?: QueryOptions
}

/**
 * Async iterator over server messages, with control methods attached.
 * Matches the shape `for await (const msg of q) { ... }` + `q.interrupt()`.
 */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  // --- Turn / session control ---------------------------------------------
  interrupt(): Promise<unknown>
  /**
   * Send cli.js's `end_session` control subtype. Graceful counterpart to
   * `interrupt()` — the CLI main loop breaks out of its read loop after
   * draining pending output. Consumers should still observe the child
   * exit after calling this; don't assume the Promise resolution means
   * the subprocess is fully gone.
   */
  endSession(): Promise<unknown>
  setPermissionMode(mode: PermissionMode): Promise<unknown>
  setModel(model?: string): Promise<unknown>
  setMaxThinkingTokens(tokens: number | null): Promise<unknown>
  applyFlagSettings(settings: Record<string, unknown>): Promise<unknown>
  getSettings(): Promise<unknown>
  rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<unknown>
  cancelAsyncMessage(messageUuid: string): Promise<{ cancelled: boolean } | unknown>
  seedReadState(path: string, mtime: number): Promise<unknown>
  enableRemoteControl(enabled: boolean, opts?: { name?: string }): Promise<unknown>
  generateSessionTitle(
    description: string,
    opts?: { persist?: boolean }
  ): Promise<{ title?: string } | unknown>
  askSideQuestion(question: string): Promise<string | null>
  launchUltrareview(args: unknown, opts?: { confirm?: boolean }): Promise<unknown>
  stopTask(taskId: string): Promise<unknown>
  backgroundTask(toolUseId: string): Promise<unknown>
  dequeueMessage(value: string): Promise<{ removed: number }>
  voiceServerStart(): Promise<{ port: number }>
  voiceServerStop(): Promise<{ stopped: boolean }>
  getUsage(): Promise<Record<string, unknown>>
  getContextUsage(): Promise<Record<string, unknown>>

  // --- MCP servers --------------------------------------------------------
  mcpServerStatus(): Promise<unknown[]>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<unknown>
  reconnectMcpServer(serverName: string): Promise<unknown>
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown>
  enableChannel(serverName: string): Promise<unknown>
  mcpAuthenticate(serverName: string): Promise<unknown>
  mcpClearAuth(serverName: string): Promise<unknown>
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>

  // --- Claude OAuth -------------------------------------------------------
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<unknown>
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>
  claudeOAuthWaitForCompletion(): Promise<unknown>

  // --- Plugins ------------------------------------------------------------
  reloadPlugins(): Promise<unknown>

  // --- Initialization accessors (cached from initialize response) ---------
  /** Full initialize response (models, commands, agents, skills, plugins, ...). */
  initializationResult(): Promise<Record<string, unknown>>
  supportedModels(): Promise<unknown[]>
  supportedCommands(): Promise<unknown[]>
  supportedAgents(): Promise<unknown[]>

  // --- Diagnostics --------------------------------------------------------
  /** Snapshot of every ndjson line that's crossed the stdio pipe for this
   *  query. Shallow copy — safe to mutate. Ring-buffered (see
   *  `wireLogCapacity`), so very long sessions only retain the tail. */
  wireLog(): WireEntry[]
}
