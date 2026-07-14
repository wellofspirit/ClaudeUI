/**
 * Local SDK layer — drop-in replacement for the parts of
 * `@anthropic-ai/claude-agent-sdk` that ClaudeUI uses.
 *
 * Backed by a vendored copy of cli.js (see scripts/extract-cli.mjs), so we
 * ship one dependency fewer and can iterate on our own patches without
 * waiting for upstream SDK releases.
 */
export { query } from './query'
export { createSdkMcpServer, tool, sendProgress } from './create-sdk-mcp'
export { locateBunClaude, locateCliJs, getCliVersion } from './locate'
export type {
  SDKMessage,
  AssistantMessage,
  UserMessage,
  StreamEventMessage,
  SystemMessage,
  ResultMessage,
  ToolProgressMessage,
  RequestUsageMessage,
  RateLimitEventMessage,
  BashOutputMessage,
  AuthStatusMessage,
  ControlRequestMessage,
  ControlResponseMessage,
  ControlCancelRequestMessage,
  UnknownSDKMessage,
  PermissionMode,
  CanUseTool,
  CanUseToolResult,
  QueryOptions,
  QueryInput,
  QueryHandle,
  McpServerConfig,
  McpServerStdio,
  McpServerHttp,
  McpServerSse,
  SdkMcpServer,
  SdkMcpTool,
  SdkToolExtra,
  ToolResultContent,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  PermissionUpdate,
  PermissionRuleValue,
  PermissionBehavior,
  PermissionUpdateDestination,
  WireDirection,
  WireEntry
} from './types'
