/**
 * The app-state reads and settings writes both transports serve — ONE declaration.
 *
 * UI config (`config:load-*` / `save-*`), engine availability and pi/account status,
 * the shared-provider reads, the Claude permission / trust / retention settings, and the
 * MCP reads. (The `config:*` engine/vendor/opencode family and the MCP writes are the
 * sibling `config-commands.ts`; the shared-provider mutations are `auth-commands.ts`.)
 *
 * The desktop envelopes the `shared-provider:*` reads (`{ ok, data }`); the WebSocket
 * answers them bare — hence `transport` and `envelopeFor`. Optional arguments go through
 * `opt()` where the remote handler always did: the web client's JSON marshalling turns an
 * omitted trailing argument into `null` (`wire-args.ts`); on the desktop it is inert.
 */

import { engineInstalled } from '../harness/resolve'
import { accountState } from '../host'
import { credentialSync } from '../auth/vault/CredentialSync'
import { locatePiDisplayPath } from '../pi/pi-locate'
import { sharedProviderService } from '../shared-providers'
import { loadClaudePermissions, loadCleanupPeriodDays } from '../services/claude-settings'
import { getWorkspaceTrust } from '../services/claude-workspace-trust'
import { listMcpCatalog, loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { loadSettings, loadSessionConfig, loadSlashCommands } from '../services/ui-config'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import type { SessionManager } from '../services/session-manager'
import type { EngineId, PermissionScope, ClaudePermissions } from '../../shared/types'
import type { CommandRegistration, Transport } from './command-registry'
import { envelopeFor } from './safe-handler'
import { opt } from './wire-args'
import {
  loadSkillDetails,
  saveSessions,
  saveUiSettings,
  mcpStatus,
  setCleanupPeriod,
  savePermissionsAndNotify,
  setWorkspaceTrustAndNotify
} from './handlers-core'

export function appStateCommands(
  manager: SessionManager,
  transport: Transport
): Array<Omit<CommandRegistration, 'transport'>> {
  const env = envelopeFor(transport)
  return [
    // UI config persistence (~/.claude/ui/), synced bidirectionally
    {
      channel: 'config:load-settings',
      capability: 'config',
      kind: 'query',
      handler: async () => loadSettings()
    },
    {
      channel: 'config:save-settings',
      capability: 'config',
      kind: 'command',
      handler: async (settings: UISettings) => saveUiSettings(settings)
    },
    {
      channel: 'config:load-sessions',
      capability: 'config',
      kind: 'query',
      handler: async () => loadSessionConfig()
    },
    {
      channel: 'config:save-sessions',
      capability: 'config',
      kind: 'command',
      handler: async (config: UISessionConfig) => saveSessions(config)
    },
    {
      channel: 'config:load-slash-commands',
      capability: 'config',
      kind: 'query',
      handler: async () => loadSlashCommands()
    },
    {
      channel: 'config:load-skill-details',
      capability: 'config',
      kind: 'query',
      handler: async (routingId: string | null, cwd: string) =>
        loadSkillDetails(manager, routingId, cwd)
    },
    // Cheap, deterministic engine availability check (the harness resolver's
    // answer). Backs the renderer's "is this engine installed?" gate WITHOUT
    // spawning a server/process — a transient spawn/HTTP failure can no longer
    // masquerade as "not installed".
    {
      channel: 'engine:is-installed',
      capability: 'config',
      kind: 'query',
      handler: async (engineId: EngineId): Promise<boolean> => engineInstalled(engineId)
    },
    // The pi a user can run in a terminal, for the Settings › pi subscription
    // hint's copyable "run this command in a terminal" block: the resolved
    // executable, or for a System pi the shim detection found rather than the
    // `cli.js` node runs (ADR-082 §2). Null if not found.
    {
      channel: 'pi:binary-path',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<string | null> => locatePiDisplayPath()
    },
    // Read-only ChatGPT auth-vault status for Settings › pi's "Connect ChatGPT" UI
    // (M6c). Never returns token material; see CredentialSync.getStatus().
    {
      channel: 'pi:auth-status',
      capability: 'config',
      kind: 'query',
      handler: async () => credentialSync.getStatus()
    },
    // The shared-provider READS. The mutations are in `auth-commands.ts`.
    {
      channel: 'shared-provider:list',
      capability: 'config',
      kind: 'query',
      handler: env(async () => sharedProviderService.listDefinitions())
    },
    {
      channel: 'shared-provider:statuses',
      capability: 'config',
      kind: 'query',
      handler: env(async () => sharedProviderService.listStatuses())
    },
    {
      channel: 'shared-provider:models',
      capability: 'config',
      kind: 'query',
      handler: env(async (id: string) => sharedProviderService.listProviderModels(id))
    },
    // Claude permission settings (allow/deny/ask rules)
    {
      channel: 'claude:load-permissions',
      capability: 'config',
      kind: 'query',
      handler: async (scope: string, cwd?: string | null) =>
        loadClaudePermissions(scope as 'user' | 'project' | 'local', opt(cwd))
    },
    // Hot-reload is belt-and-braces, not the only propagation path: cli.js DOES
    // run its chokidar settings watcher in ClaudeUI's child, so a disk write
    // lands on its own within ~1-1.5s (awaitWriteFinish). notifySettingsChanged
    // makes it immediate and deterministic, and covers a missed watcher event.
    {
      channel: 'claude:save-permissions',
      capability: 'config',
      kind: 'command',
      handler: async (scope: string, permissions: ClaudePermissions, cwd?: string | null) =>
        savePermissionsAndNotify(manager, scope as PermissionScope, permissions, opt(cwd))
    },
    // Whether cli.js will honor this workspace's project/local ALLOW rules, and
    // the toggle that grants it (writes ~/.claude.json like cli.js's trust dialog).
    {
      channel: 'claude:workspace-trust',
      capability: 'config',
      kind: 'query',
      handler: async (cwd: string) => getWorkspaceTrust(cwd)
    },
    {
      channel: 'claude:set-workspace-trust',
      capability: 'config',
      kind: 'command',
      handler: async (cwd: string, trusted: boolean) =>
        setWorkspaceTrustAndNotify(manager, cwd, trusted)
    },
    // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
    {
      channel: 'claude:get-cleanup-period',
      capability: 'config',
      kind: 'query',
      handler: async () => loadCleanupPeriodDays()
    },
    {
      channel: 'claude:set-cleanup-period',
      capability: 'config',
      kind: 'command',
      handler: async (days: number) => setCleanupPeriod(manager, days)
    },
    // MCP runtime status (Claude-only: capabilities.hostedMcp AND method presence —
    // opencode advertises hostedMcp:true but does not implement the MCP methods)
    {
      channel: 'mcp:status',
      capability: 'config',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string) => mcpStatus(manager, routingId)
    },
    // MCP config file reads (direct file access, no session needed)
    {
      channel: 'mcp:load-servers',
      capability: 'config',
      kind: 'query',
      handler: async (scope: string, cwd?: string | null) =>
        loadMcpServers(scope as 'user' | 'project' | 'local', opt(cwd))
    },
    // The catalog behind McpDialog's cold list: what a Claude session in `cwd` would load
    {
      channel: 'mcp:load-catalog',
      capability: 'config',
      kind: 'query',
      handler: async (cwd?: string | null) => listMcpCatalog(cwd)
    },
    // MCP disabled state (direct ~/.claude.json access, no session needed)
    {
      channel: 'mcp:read-disabled',
      capability: 'config',
      kind: 'query',
      handler: async (cwd: string) => readDisabledMcpServers(cwd)
    },
    // Multi-account state. Read-only here; the mutations are `config`-capability
    // commands in `auth-commands.ts`.
    {
      channel: 'account:get',
      capability: 'config',
      kind: 'query',
      handler: async () => accountState()
    }
  ]
}
