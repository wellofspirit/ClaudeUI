/**
 * Public types for our local SDK layer. Designed as a drop-in for the subset
 * of `@anthropic-ai/claude-agent-sdk` that ClaudeUI actually uses.
 *
 * Messages are typed as `Record<string, unknown>` to match how the rest of
 * the codebase treats them — we never trust a Zod schema at this boundary.
 */

export type SDKMessage = Record<string, unknown>

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
  context: CanUseToolContext,
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

export type SystemPrompt = string | SystemPromptPreset

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

export type McpServerConfig =
  | McpServerStdio
  | McpServerHttp
  | McpServerSse
  | SdkMcpServer

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
  /** Executable overrides (for Electron's ELECTRON_RUN_AS_NODE=1 setup). */
  pathToClaudeCodeExecutable?: string
  executable?: string
  executableArgs?: string[]
  /**
   * Env overlay merged on top of process.env for the cli.js child.
   *   { ELECTRON_RUN_AS_NODE: '1' }  — isolated to the cli.js spawn, does
   *   NOT leak into Electron's GPU/renderer children.
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
  jsonSchema?: unknown
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
    opts?: { persist?: boolean },
  ): Promise<{ title?: string } | unknown>
  askSideQuestion(question: string): Promise<unknown>
  launchUltrareview(args: unknown, opts?: { confirm?: boolean }): Promise<unknown>
  stopTask(taskId: string): Promise<unknown>
  backgroundTask(toolUseId: string): Promise<unknown>
  dequeueMessage(value: string): Promise<unknown>
  voiceServerStart(): Promise<unknown>
  voiceServerStop(): Promise<unknown>
  getUsage(): Promise<unknown>
  getContextUsage(): Promise<unknown>

  // --- MCP servers --------------------------------------------------------
  mcpServerStatus(): Promise<unknown>
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
}
