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
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  thinking?: ThinkingConfig
  persistSession?: boolean
  abortController?: AbortController
  mcpServers?: Record<string, McpServerConfig>
  canUseTool?: CanUseTool
  settingSources?: SettingSource[]
  includePartialMessages?: boolean
  effort?: 'low' | 'medium' | 'high'
  resume?: string
  stderr?: (chunk: Buffer) => void
  /** Executable overrides (for Electron's ELECTRON_RUN_AS_NODE=1 setup). */
  pathToClaudeCodeExecutable?: string
  executable?: string
  executableArgs?: string[]
  /** Forwarded to CLI as-is (escape hatch). */
  extraArgs?: string[]
  /** Emit hook_event control requests to this handler. */
  includeHookEvents?: boolean
  /** Agents config. */
  agents?: string
  /** When true, skip permission prompts entirely (maps to --allow-dangerously-skip-permissions). */
  allowDangerouslySkipPermissions?: boolean
  /** Initial permission settings baked into the session (forwarded via initialize). */
  settings?: Record<string, unknown>
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
  /** Cancel the currently executing turn. */
  interrupt(): Promise<unknown>
  setPermissionMode(mode: PermissionMode): Promise<unknown>
  setModel(model?: string): Promise<unknown>
  stopTask(taskId: string): Promise<unknown>
  backgroundTask(toolUseId: string): Promise<unknown>
  dequeueMessage(value: string): Promise<unknown>
  askSideQuestion(question: string): Promise<unknown>
  getUsage(): Promise<unknown>
  mcpServerStatus(): Promise<unknown>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<unknown>
  reconnectMcpServer(serverName: string): Promise<unknown>
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown>
  applyFlagSettings(settings: Record<string, unknown>): Promise<unknown>
  voiceServerStart(): Promise<unknown>
  voiceServerStop(): Promise<unknown>
  supportedModels(): Promise<unknown[]>
  supportedCommands(): Promise<unknown[]>
  supportedAgents(): Promise<unknown[]>
}
