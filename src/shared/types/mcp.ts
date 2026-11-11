// ---------------------------------------------------------------------------
// MCP Server types (MCP server management dialog)
// ---------------------------------------------------------------------------

export type McpServerScope =
  'user' | 'project' | 'local' | 'claudeai' | 'managed' | 'plugin' | 'claudeui'

/** Where the catalog found an entry; `claudeui` is McpDialog's legacy files (cli.js ignores them). */
export type McpCatalogSource = 'plugin' | 'user' | 'project' | 'local' | 'managed' | 'claudeui'

export interface McpCatalogServer {
  /** The name Claude Code knows it by (`plugin:p:s` for a plugin server). */
  name: string
  config: McpServerConfig
  source: McpCatalogSource
  /** Named in `disabledMcpServers`: listed so it can be re-enabled, but not loaded. */
  disabled?: boolean
}

/** `mcp:load-catalog`. No `ok` key: preload `unwrap` treats `{ok}` envelopes specially. */
export interface McpCatalogResult {
  servers: McpCatalogServer[]
  skipped: { name: string; reason: string }[]
}

/** `mcp:cli-add` / `mcp:cli-remove`: cli.js's own message when it refused. */
export interface McpCliResult {
  error?: string
}

export type McpServerConnectionStatus =
  'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'not_started'

export type McpServerTransport = 'stdio' | 'sse' | 'http'

export interface McpServerToolInfo {
  name: string
  description?: string
  annotations?: {
    readOnly?: boolean
    destructive?: boolean
    openWorld?: boolean
  }
}

export interface McpServerConfig {
  type?: McpServerTransport
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse/http transport
  url?: string
  headers?: Record<string, string>
}

export interface McpServerInfo {
  name: string
  status: McpServerConnectionStatus
  serverInfo?: { name: string; version: string }
  error?: string
  config?: McpServerConfig
  scope?: McpServerScope
  tools?: McpServerToolInfo[]
}

export interface McpSetServersResult {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}
