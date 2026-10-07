/**
 * The `OPENCODE_CONFIG_CONTENT` ClaudeUI injects into the opencode 2.x server it
 * spawns (ADR-097 §2, §4), in 2.x's native keys only
 * (`Config.InfoEncoded` in `protocol-v2/openapi.ts`):
 *
 * - `mcp.servers` — the user's Claude MCP catalog for the cwd
 *   (`collectClaudeMcpForOpencode`) plus ClaudeUI's hosted-tools server
 *   `claudeui`, every entry `codemode: false` so its tools stay direct tools
 *   rather than hiding behind Code Mode's `execute` (which would also make the
 *   tool-call id the `execute` call's id).
 * - `plugins` — the `claudeui-xeng` DIRECTORY plugin (caller identity + the
 *   readiness RPC; `resources/opencode/claudeui-xeng/`).
 * - `agents.<name>.permissions` — the mode-less agent overlay (ADR-097 §3,
 *   `permission-v2.ts` `agentPermissionOverlay`); an empty overlay emits no
 *   `agents` key at all.
 *
 * Not emitted any more: `experimental.continue_loop_on_deny` (2.x continues a
 * turn after a reject-with-message natively, ADR-097 §3) and `autoupdate`
 * (`OPENCODE_DISABLE_AUTOUPDATE=1` is the 2.x switch, see opencode-server-spawn.ts).
 *
 * Secrets: the hosted server's bearer and any bridged server's env/headers live
 * only in this string, which goes into the child's env and nowhere else — never
 * a file, never a log line. `configIdentity` is a one-way digest, safe to log.
 */
import { createHash } from 'node:crypto'
import type { Config_InfoEncoded, Permission_Ruleset } from './protocol-v2/openapi'
import { HOSTED_MCP_SERVER } from './claude-mcp-bridge'
import type { OpencodeMcpEntry, OpencodeMcpRemoteEntry } from './claude-mcp-bridge'

export { HOSTED_MCP_SERVER }

/**
 * Per-agent permission rules, injected as `agents.<name>.permissions`
 * (ADR-097 §3). The manager's default provider is `permission-v2.ts`
 * `agentPermissionOverlay`.
 */
export type AgentPermissionOverlay = Readonly<Record<string, Permission_Ruleset>>

/** Everything that decides which server a cwd gets (see `configIdentity`). */
export interface OpencodeConfigInput {
  /** Claude MCP servers bridged for the cwd (`collectClaudeMcpForOpencode`). */
  readonly bridgedMcp?: Readonly<Record<string, OpencodeMcpEntry>>
  /** Absolute path of the `claudeui-xeng` plugin directory, or null when not found. */
  readonly pluginDir?: string | null
  readonly agentPermissions?: AgentPermissionOverlay
}

/** The per-server hosted MCP endpoint (`mcp-http-host.ts`). */
export interface HostedMcpEndpoint {
  readonly port: number
  readonly token: string
}

/** The `mcp.servers.claudeui` entry for a hosted MCP endpoint. */
export function hostedMcpEntry(endpoint: HostedMcpEndpoint): OpencodeMcpRemoteEntry {
  return {
    type: 'remote',
    url: `http://127.0.0.1:${endpoint.port}/mcp`,
    headers: { Authorization: `Bearer ${endpoint.token}` },
    // A static bearer, never OAuth: without this opencode registers the server
    // as an OAuth integration (listed by GET /api/integration) and would start
    // an OAuth flow on a 401 (vendor/opencode-v2-src/packages/core/src/mcp/index.ts
    // `register`).
    oauth: false,
    codemode: false
    // No `timeout`: 2.x's default `execution` wall is 12 h
    // (core/src/mcp/client.ts DEFAULT_EXECUTION_TIMEOUT), far past any dispatch
    // the user would wait for (ADR-033 2026-09-18: an unset limit means none).
    // The 1.x numeric 20-min idle timeout has no 2.x equivalent shape.
  }
}

/** The v2 config object (exported for tests and the contract suite). */
export function buildOpencodeConfig(
  input: OpencodeConfigInput,
  hosted: HostedMcpEndpoint
): Config_InfoEncoded {
  const servers: Record<string, OpencodeMcpEntry> = {}
  for (const [name, entry] of Object.entries(input.bridgedMcp ?? {})) {
    // The bridge already drops it; the hosted server must win regardless.
    if (name !== HOSTED_MCP_SERVER) servers[name] = entry
  }
  servers[HOSTED_MCP_SERVER] = hostedMcpEntry(hosted)
  const agents = Object.entries(input.agentPermissions ?? {}).filter(
    ([, rules]) => rules.length > 0
  )
  return {
    mcp: { servers },
    ...(input.pluginDir ? { plugins: [input.pluginDir] } : {}),
    ...(agents.length > 0
      ? { agents: Object.fromEntries(agents.map(([name, permissions]) => [name, { permissions }])) }
      : {})
  }
}

/** `OPENCODE_CONFIG_CONTENT` for one server. Contains secrets — never log it. */
export function buildOpencodeConfigContent(
  input: OpencodeConfigInput,
  hosted: HostedMcpEndpoint
): string {
  return JSON.stringify(buildOpencodeConfig(input, hosted))
}

/** JSON with object keys sorted at every level, so equal configs digest equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The server key (ADR-097 §2: one server per distinct config injection). Covers
 * exactly what `buildOpencodeConfig` injects except the hosted endpoint, which
 * is per server rather than per config. Equal inputs → equal identity,
 * whatever their key order. A sha256 prefix: safe to log, reveals no secret.
 */
export function configIdentity(input: OpencodeConfigInput): string {
  const canonical = stableJson({
    bridgedMcp: input.bridgedMcp ?? {},
    pluginDir: input.pluginDir ?? null,
    agentPermissions: Object.fromEntries(
      Object.entries(input.agentPermissions ?? {}).filter(([, rules]) => rules.length > 0)
    )
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
