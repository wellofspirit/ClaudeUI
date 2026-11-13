import type { ClaudePermissions, PermissionScope, WorkspaceTrust } from '../approvals'
import type {
  McpCatalogResult,
  McpCliResult,
  McpServerConfig,
  McpServerInfo,
  McpServerScope,
  McpSetServersResult
} from '../mcp'
import type { ClaudeSandboxScope, SandboxSettingsPatch } from '../engine-config'

export interface McpAPI {
  mcpServerStatus(routingId: string): Promise<McpServerInfo[]>
  mcpToggleServer(routingId: string, serverName: string, enabled: boolean): Promise<void>
  mcpReconnectServer(routingId: string, serverName: string): Promise<void>
  mcpSetServers(
    routingId: string,
    servers: Record<string, McpServerConfig>
  ): Promise<McpSetServersResult>
  loadMcpServers(scope: McpServerScope, cwd?: string): Promise<Record<string, McpServerConfig>>
  saveMcpServers(
    scope: McpServerScope,
    servers: Record<string, McpServerConfig>,
    cwd?: string
  ): Promise<void>
  removeMcpServer(scope: McpServerScope, serverName: string, cwd?: string): Promise<void>
  /** `cwd` omitted: the home directory (user-scope view, no project). */
  loadMcpCatalog(cwd?: string): Promise<McpCatalogResult>
  /** Add through `claude mcp add-json -s <scope>` (cwd = the session cwd). */
  mcpCliAdd(
    scope: 'user' | 'project' | 'local',
    name: string,
    config: McpServerConfig,
    cwd?: string
  ): Promise<McpCliResult>
  mcpCliRemove(
    scope: 'user' | 'project' | 'local',
    name: string,
    cwd?: string
  ): Promise<McpCliResult>
  /** Make a live Claude session re-read its MCP config (after a native write). */
  mcpReloadServers(
    routingId: string,
    /** Retry (bounded) until this server is / is no longer listed live. */
    expect?: { name: string; present: boolean }
  ): Promise<void>
  mcpReadDisabled(cwd: string): Promise<string[]>
  mcpToggleDisabled(cwd: string, serverName: string, enabled: boolean): Promise<void>
  loadClaudePermissions(scope: PermissionScope, cwd?: string): Promise<ClaudePermissions>
  saveClaudePermissions(
    scope: PermissionScope,
    permissions: ClaudePermissions,
    cwd?: string
  ): Promise<void>
  /** Whether Claude Code honors this workspace's project/local ALLOW rules, and the
   *  directory that trust is recorded on. Untrusted → cli.js silently drops them;
   *  deny/ask and user-scope allows still apply. null when there is no cwd. */
  getWorkspaceTrust(cwd: string): Promise<WorkspaceTrust | null>
  /** Trust or untrust the workspace (writes ~/.claude.json the way cli.js's own trust
   *  dialog does) and refresh running Claude sessions on it. Resolves to the new state. */
  setWorkspaceTrust(cwd: string, trusted: boolean): Promise<WorkspaceTrust>
  /** Transcript retention window (cleanupPeriodDays). undefined = not set (CLI default of 30). */
  getCleanupPeriodDays(): Promise<number | undefined>
  setCleanupPeriodDays(days: number): Promise<void>
  /** Turn Claude Code's `disableAutoMode` on or off in ~/.claude/settings.json. Rejects with a
   *  readable message when that file is not valid JSON. The applied value arrives as the
   *  `config:claude-auto-mode-changed` event, not as the result. */
  setClaudeDisableAutoMode(disabled: boolean): Promise<void>
  /** Save the fields the user changed into the `sandbox` block of Claude Code's user settings
   *  file. Rejects with a readable message when the file is not valid JSON or the host cannot
   *  run the sandbox. The applied state arrives as the `config:claude-sandbox-changed` event,
   *  not as the result. */
  setClaudeSandbox(patch: SandboxSettingsPatch): Promise<void>
  /** Which of the project, local and managed settings files turn the sandbox on for `cwd`. */
  claudeSandboxScopes(cwd: string): Promise<ClaudeSandboxScope[]>
}
