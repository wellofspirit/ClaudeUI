/**
 * Bridge ClaudeUI's ONE shared MCP catalog into pi (ADR-094).
 *
 * The catalog is the Claude-scoped server list McpDialog manages (user /
 * project / local, minus the cwd's `disabledMcpServers`) — the same read the
 * opencode and Codex bridges inherit (`readEnabledClaudeMcpServers`). pi 1.0
 * takes a server at runtime through the extension API
 * `pi.registerMcpServer(name, config)` (session-only, never written to pi's
 * `mcp.json`; `vendor/pi-src/packages/coding-agent/src/core/mcp-servers.ts`), so
 * the bridge extension fetches the translated set from its own PiBridgeHost
 * (`POST /mcp-servers`) while pi loads it and registers each entry.
 *
 * Constraints:
 * - Pure I/O separation, as in the other bridges: everything but
 *   {@link collectClaudeMcpForPi} and {@link readPiNativeMcpServerNames} is pure.
 * - Secrets (stdio `env`, HTTP `headers`) stay in memory: ClaudeUI's process →
 *   the token-authenticated loopback host → the pi process. Never an env var
 *   (every bash child would inherit it) and never a file.
 * - Every entry is `exposure: "direct"`: declared to the model like a built-in
 *   tool, so a call is an ordinary tool card that goes through the bridge's
 *   `tool_call` gate (pi's default, `codemode`, would hide the tools behind a
 *   script tool).
 * - pi's validation is stricter than Claude's shape (`validateMcpServerConfig`):
 *   names are `[A-Za-z0-9_-]+`, names differing only in `-`/`_` share a
 *   namespace, legacy SSE is refused. A server pi would refuse is SKIPPED here
 *   with a reason — one bad entry never costs the others (pi's own
 *   per-load clash check cannot see registrations staged in the same load, so
 *   the namespace dedupe below is the only one that runs).
 * - pi resolves `env` and `headers` values as config templates
 *   (`core/resolve-config-value.ts`): a leading `!` RUNS A SHELL COMMAND and
 *   `$NAME` / `${NAME}` interpolate. Claude's values are literals with
 *   `${VAR}` / `${VAR:-default}` expansion, so ClaudeUI expands Claude's syntax
 *   itself ({@link expandClaudeEnvRefs}) and escapes the result
 *   ({@link escapePiConfigValue}) — a header value `!x` must never become a
 *   command.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '../../shared/types'
import { readEnabledClaudeMcpServers } from '../services/claude-mcp'
import { logger } from '../services/logger'

/** pi's stdio entry (`McpStdioServerConfig`), as ClaudeUI registers it. */
export type PiMcpStdioEntry = {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  exposure: 'direct'
}

/** pi's streamable-HTTP entry (`McpHttpServerConfig`), as ClaudeUI registers it. */
export type PiMcpHttpEntry = {
  type: 'http'
  url: string
  headers?: Record<string, string>
  exposure: 'direct'
}

export type PiMcpServerEntry = PiMcpStdioEntry | PiMcpHttpEntry

/** What the bridge hands one pi process: the servers to register and the ones it left out. */
export interface PiMcpCatalog {
  servers: Record<string, PiMcpServerEntry>
  skipped: Array<{ name: string; reason: string }>
}

export const EMPTY_PI_MCP_CATALOG: PiMcpCatalog = Object.freeze({
  servers: Object.freeze({}) as Record<string, PiMcpServerEntry>,
  skipped: Object.freeze([]) as unknown as PiMcpCatalog['skipped']
})

/** pi's server-name rule (`SERVER_NAME` in mcp-servers.ts). */
const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/

/**
 * The names ClaudeUI's own hosted servers use on the other engines: Claude's
 * in-process `claude-ui` / `claude-ui-mockup` / `claude-ui-collab` and
 * opencode's `claudeui`. A user server under one of them would read as
 * ClaudeUI's own tools in cross-engine rules and cards (the auto-mode allow
 * skip refuses `mcp__claude-ui-collab…` and `mcp__claudeui…` rules), so it is
 * not bridged — compared by pi namespace, so `claude_ui` is reserved too.
 */
const RESERVED_SERVER_NAMES = ['claudeui', 'claude-ui', 'claude-ui-mockup', 'claude-ui-collab']

/**
 * pi's tool-name sanitizer: everything but `[A-Za-z0-9_]` becomes `_`
 * (`createMcpToolName`, `extensions/mcp/tools.ts`). A pi MCP tool is named
 * `mcp__<server>__<tool>` passed through this, so a Claude rule or agent tool
 * entry has to be passed through it too before it can match a pi tool name.
 */
export function piMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

/** The namespace pi gives a server (`mcpNamespace`): names that share one collide. */
export function piMcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`
}

/**
 * A Claude MCP rule's tool name in pi's form, for the permission ladder
 * (`PermissionEngineContext.mcpRuleKey`). `mcp__my-server__get-issue` →
 * `mcp__my_server__get_issue`, the name pi gave that tool.
 */
export const piMcpRuleKey = piMcpName

/**
 * A subagent definition's `tools` / `disallowedTools` entry as pi's `--tools` /
 * `--exclude-tools` must spell it. Non-MCP entries pass through. An MCP entry is
 * sanitized like a tool name with `*` kept (pi's pattern wildcard), and a bare
 * server (`mcp__github`, Claude's server-level form) becomes `mcp__github__*`.
 */
export function piSubagentToolEntry(entry: string): string {
  if (!entry.startsWith('mcp__')) return entry
  const rest = entry.slice('mcp__'.length)
  const spelled = `mcp__${rest.replace(/[^A-Za-z0-9_*]/g, '_')}`
  return rest.includes('__') ? spelled : `${spelled}__*`
}

const CLAUDE_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Claude Code's `${VAR}` / `${VAR:-default}` expansion of an `.mcp.json`
 * string, against `env`. A variable that is unset (or empty) with no default
 * stays as written, and its NAME is collected in `missing` — the value itself
 * is never logged.
 */
export function expandClaudeEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): string {
  return value.replace(CLAUDE_ENV_REF, (whole, name: string, fallback: string | undefined) => {
    const set = env[name]
    if (set !== undefined && set !== '') return set
    if (fallback !== undefined) return fallback
    missing.add(name)
    return whole
  })
}

/**
 * Make `value` a LITERAL for pi's config-value resolver: `$` → `$$` (no
 * interpolation), and a leading `!` → `$!` (never a shell command). Both are
 * pi's own documented escapes (`resolveConfigValue`).
 */
export function escapePiConfigValue(value: string): string {
  const escaped = value.replace(/\$/g, '$$$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}

/** Expand then escape every value of a pi template map (`env`, `headers`). */
function piTemplateMap(
  map: Record<string, string>,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [
      k,
      escapePiConfigValue(expandClaudeEnvRefs(v, env, missing))
    ])
  )
}

/**
 * Translate one catalog entry into pi's shape, or say why pi cannot take it.
 * `name` is validated here too (pi refuses the whole registration otherwise).
 * `env` is the environment Claude-style `${VAR}` references expand against —
 * ClaudeUI's own, which is what a Claude session it spawns would see.
 */
export function translateClaudeMcpServerForPi(
  name: string,
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env
): { entry: PiMcpServerEntry; missingEnv: string[] } | { skip: string } {
  if (!PI_SERVER_NAME.test(name)) {
    return { skip: 'pi only accepts letters, digits, "_" and "-" in a server name' }
  }
  if (typeof cfg !== 'object' || cfg === null) return { skip: 'not a server entry' }
  // `type` is wider on disk than in the TS union (`sdk`, `ws`, …).
  const type = (cfg as { type?: unknown }).type
  if (type === 'sse') return { skip: 'pi does not support legacy SSE; use the streamable HTTP URL' }
  if (type !== undefined && type !== 'stdio' && type !== 'http') {
    return { skip: `pi does not support the "${String(type)}" transport` }
  }
  const missing = new Set<string>()
  const expand = (v: string): string => expandClaudeEnvRefs(v, env, missing)

  const isStdio = type === 'stdio' || (type === undefined && !!cfg.command && !cfg.url)
  if (isStdio) {
    if (typeof cfg.command !== 'string' || cfg.command.trim() === '') {
      return { skip: 'no command' }
    }
    if (
      cfg.args !== undefined &&
      !(Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === 'string'))
    ) {
      return { skip: 'args must be a list of strings' }
    }
    if (cfg.env !== undefined && !isStringRecord(cfg.env))
      return { skip: 'env must map names to strings' }
    const entry: PiMcpStdioEntry = {
      type: 'stdio',
      command: expand(cfg.command),
      exposure: 'direct'
    }
    if (cfg.args && cfg.args.length > 0) entry.args = cfg.args.map(expand)
    if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = piTemplateMap(cfg.env, env, missing)
    // Not in Claude's documented shape, but pi takes it and a hand-written
    // `.mcp.json` may carry it. Relative paths resolve against the session cwd
    // in pi, which is also where Claude Code runs a server.
    const cwd = (cfg as { cwd?: unknown }).cwd
    if (typeof cwd === 'string' && cwd !== '') entry.cwd = expand(cwd)
    return { entry, missingEnv: [...missing] }
  }

  if (typeof cfg.url !== 'string' || cfg.url === '') return { skip: 'neither a command nor a url' }
  const url = expand(cfg.url)
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return { skip: 'url is not a valid URL' }
  }
  if (protocol !== 'http:' && protocol !== 'https:') return { skip: 'url must be http or https' }
  if (cfg.headers !== undefined && !isStringRecord(cfg.headers)) {
    return { skip: 'headers must map names to strings' }
  }
  const entry: PiMcpHttpEntry = { type: 'http', url, exposure: 'direct' }
  if (cfg.headers && Object.keys(cfg.headers).length > 0) {
    entry.headers = piTemplateMap(cfg.headers, env, missing)
  }
  return { entry, missingEnv: [...missing] }
}

/**
 * Filter + translate a catalog (already merged and minus the disabled list).
 * Pure. Order is the catalog's: of two names pi would put in one namespace, the
 * first wins and the second is skipped (pi would throw on it).
 */
export function buildPiMcpCatalog(
  enabled: Record<string, McpServerConfig>,
  env: NodeJS.ProcessEnv = process.env
): PiMcpCatalog {
  const servers: Record<string, PiMcpServerEntry> = {}
  const skipped: PiMcpCatalog['skipped'] = []
  const reserved = new Set(RESERVED_SERVER_NAMES.map(piMcpNamespace))
  const taken = new Map<string, string>()
  for (const [name, cfg] of Object.entries(enabled)) {
    if (reserved.has(piMcpNamespace(name))) {
      skipped.push({ name, reason: 'the name is reserved by ClaudeUI' })
      continue
    }
    const translated = translateClaudeMcpServerForPi(name, cfg, env)
    if ('skip' in translated) {
      skipped.push({ name, reason: translated.skip })
      continue
    }
    const namespace = piMcpNamespace(name)
    const owner = taken.get(namespace)
    if (owner !== undefined) {
      skipped.push({ name, reason: `pi gives it the same tool names as "${owner}"` })
      continue
    }
    taken.set(namespace, name)
    if (translated.missingEnv.length > 0) {
      logger.warn(
        'PiMcpBridge',
        `MCP server "${name}": unset environment variable(s) ${translated.missingEnv.join(', ')} left as written`
      )
    }
    servers[name] = translated.entry
  }
  return { servers, skipped }
}

/**
 * The catalog a pi session in `cwd` registers. Never throws: a config-read
 * failure degrades to "no bridged servers", as in the other bridges.
 */
export function collectClaudeMcpForPi(cwd: string): PiMcpCatalog {
  try {
    const catalog = buildPiMcpCatalog(readEnabledClaudeMcpServers(cwd))
    for (const { name, reason } of catalog.skipped) {
      logger.info('PiMcpBridge', `MCP server "${name}" not bridged to pi: ${reason}`)
    }
    return catalog
  } catch (err) {
    logger.warn('PiMcpBridge', 'Failed to collect Claude MCP servers for pi', err)
    return { servers: {}, skipped: [] }
  }
}

function serverNamesIn(file: string, definesOnly: boolean): string[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return []
    return Object.entries(servers as Record<string, unknown>)
      .filter(([, v]) => {
        if (typeof v !== 'object' || v === null) return false
        // A project entry with no command/url/type only overrides a global one.
        if (!definesOnly) return true
        const o = v as Record<string, unknown>
        return o.command !== undefined || o.url !== undefined || o.type !== undefined
      })
      .map(([name]) => name)
  } catch {
    return []
  }
}

/**
 * The servers pi's OWN config defines for a session in `cwd`: the global
 * `<agentDir>/mcp.json` and the project `<cwd>/.pi/mcp.json` (read because the
 * bridge extension trusts every project ClaudeUI opens). Names only — never
 * the configs. Best-effort: unreadable files count as empty.
 */
export function readPiNativeMcpServerNames(
  cwd: string,
  // pi's own rule (config.ts getAgentDir); `piAgentDir()` is not imported to
  // keep this module a leaf (pi-session-list sits in an import cycle).
  agentDir: string = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
): string[] {
  return [
    ...new Set([
      ...serverNamesIn(join(agentDir, 'mcp.json'), false),
      ...serverNamesIn(join(cwd, '.pi', 'mcp.json'), true)
    ])
  ]
}

/**
 * Names in `bridged` that pi's own `mcp.json` also defines (by namespace, pi's
 * rule). pi's file wins — the bridged registration is ignored by pi's MCP
 * extension — so these are only logged, and still sent (pi applies the rule).
 */
export function piNativeCollisions(
  bridged: readonly string[],
  native: readonly string[]
): string[] {
  const nativeSpaces = new Set(native.map(piMcpNamespace))
  return bridged.filter((name) => nativeSpaces.has(piMcpNamespace(name)))
}

/**
 * The Claude-form server name a pi MCP tool's server part stands for, when
 * exactly one known name maps to it (pi's sanitizer is lossy). Falls back to
 * the pi form. What the auto-mode allow-rule skip compares a rule's server to.
 */
export function claudeServerForPi(piServer: string, known: readonly string[]): string {
  const matches = known.filter((name) => piMcpName(name) === piServer)
  return matches.length === 1 ? matches[0] : piServer
}
