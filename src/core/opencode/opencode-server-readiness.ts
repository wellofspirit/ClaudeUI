/**
 * "Would a turn in this directory be offered ClaudeUI's hosted tools yet?"
 * (ADR-093 §2; S0 finding 1).
 *
 * In opencode 2.x MCP servers are LOCATION-scoped: every directory a server is
 * asked about connects its own MCP clients, asynchronously, the first time it
 * is used (vendor/opencode-v2-src/packages/core/src/mcp/index.ts — "initial
 * connections stay asynchronous so one slow server does not block Location
 * startup"). A server reporting `connected` is not yet a registered tool: the
 * tool registry picks the catalog up on an INTERNAL `mcp.tools.changed`, after
 * a 100 ms debounce (core/src/tool/mcp.ts), and `session.context` only flushes
 * the registration that ran at location start. Nothing on the public feed
 * announces it. So without a wait, the first turn in a directory can run
 * without `claudeui_dispatch_agent` and the other hosted tools.
 *
 * Signals, in order of preference — all public, non-experimental routes:
 * 1. `POST /api/rpc/claudeui-xeng/tools` — the ClaudeUI plugin's RPC answers
 *    `ctx.tool.list()` (the registry itself, "after every transform") filtered
 *    to `claudeui_*`. Ready = the sentinel tool is registered. Exact.
 * 2. `GET /api/mcp` — when the plugin is not loaded (not shipped, or its RPC
 *    never answers), `claudeui` connected + a settle margin over the 100 ms
 *    debounce. A heuristic, logged as such.
 * A `claudeui` status of failed / needs_auth / disabled ends the wait at once.
 * The status fallback only ever stands in for TOOL readiness, never for the
 * plugin's permission hook ({@link waitForPermissionGuard}).
 * The wait is bounded and never throws: on a timeout the caller logs it and
 * proceeds (the turn just may lack the hosted tools, as before S2).
 *
 * NOT covered: the model catalog. The first `/api/model` after a boot can be
 * empty for ~1.5 s (ADR-093 §6) — see `modelListIsAuthoritative`.
 */
import { HOSTED_MCP_SERVER } from './claude-mcp-bridge'

export const PLUGIN_RPC_ID = 'claudeui-xeng'
/** One hosted tool whose presence means the whole `claudeui` catalog is registered. */
export const READINESS_SENTINEL_TOOL = `${HOSTED_MCP_SERVER}_dispatch_agent`
export const READINESS_TIMEOUT_MS = 10_000
export const READINESS_POLL_MS = 50
/** Fallback settle margin after `connected` (registry debounce is 100 ms). */
export const READINESS_SETTLE_MS = 400
/** How long the plugin's RPC may stay silent after MCP connected before falling back. */
export const PLUGIN_RPC_GRACE_MS = 2_000

export type HostedToolsReadiness =
  /** Registered (signal says which evidence). */
  | { state: 'ready'; signal: 'registry' | 'mcp-status'; elapsedMs: number }
  /** `claudeui` itself failed to connect — waiting longer cannot help. */
  | { state: 'failed'; reason: string; elapsedMs: number }
  /** Bounded wait ran out. */
  | { state: 'timeout'; last: string; elapsedMs: number }
  /** Not waited for (a detached server, or no directory). */
  | { state: 'skipped' }

export interface ReadinessResponse {
  readonly status: number
  readonly body: unknown
}

export interface ReadinessDeps {
  /** One request against the server, scoped to `directory` (x-opencode-directory). */
  readonly request: (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ) => Promise<ReadinessResponse>
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface ReadinessOptions {
  /** False when no plugin was injected: go straight to the status fallback. */
  readonly pluginExpected: boolean
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly settleMs?: number
  readonly pluginGraceMs?: number
}

function registeredTools(response: ReadinessResponse | null): string[] | null {
  if (!response || response.status !== 200) return null
  const output = (response.body as { output?: { tools?: unknown } } | null)?.output
  return Array.isArray(output?.tools)
    ? output.tools.filter((t): t is string => typeof t === 'string')
    : null
}

function hostedStatus(
  response: ReadinessResponse | null
): { status: string; error?: string } | null {
  if (!response || response.status !== 200) return null
  const servers = (response.body as { data?: unknown } | null)?.data
  if (!Array.isArray(servers)) return null
  const hosted = servers.find(
    (server): server is { name: string; status: { status: string; error?: string } } =>
      !!server &&
      typeof server === 'object' &&
      (server as { name?: unknown }).name === HOSTED_MCP_SERVER
  )
  return hosted?.status ?? null
}

const settle = async (promise: Promise<ReadinessResponse>): Promise<ReadinessResponse | null> =>
  promise.catch(() => null)

/** Wait (bounded) until the hosted tools are registered for one directory. */
export async function waitForHostedTools(
  options: ReadinessOptions,
  deps: ReadinessDeps
): Promise<HostedToolsReadiness> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS
  const pollMs = options.pollMs ?? READINESS_POLL_MS
  const settleMs = options.settleMs ?? READINESS_SETTLE_MS
  const graceMs = options.pluginGraceMs ?? PLUGIN_RPC_GRACE_MS
  const start = now()
  let connectedAt: number | null = null
  let last = 'no answer yet'
  for (;;) {
    const [rpc, mcp] = await Promise.all([
      options.pluginExpected
        ? settle(deps.request('POST', `/api/rpc/${PLUGIN_RPC_ID}/tools`, { input: {} }))
        : Promise.resolve(null),
      settle(deps.request('GET', '/api/mcp'))
    ])
    const at = now()
    const elapsedMs = at - start
    const tools = registeredTools(rpc)
    if (tools?.includes(READINESS_SENTINEL_TOOL))
      return { state: 'ready', signal: 'registry', elapsedMs }
    const status = hostedStatus(mcp)
    if (status && ['failed', 'needs_auth', 'disabled'].includes(status.status)) {
      return {
        state: 'failed',
        reason: `${HOSTED_MCP_SERVER} ${status.status}${status.error ? `: ${status.error}` : ''}`,
        elapsedMs
      }
    }
    if (status?.status === 'connected') connectedAt ??= at
    // Fallback: no plugin, or its RPC stayed silent well after the server
    // connected (plugin missing from this build, or it failed to load).
    const rpcSilent = tools === null
    if (
      connectedAt !== null &&
      (!options.pluginExpected || (rpcSilent && at - connectedAt >= graceMs)) &&
      at - connectedAt >= settleMs
    ) {
      return { state: 'ready', signal: 'mcp-status', elapsedMs }
    }
    last =
      `rpc ${rpc ? `${rpc.status} ${tools ? `[${tools.join(',')}]` : ''}`.trim() : options.pluginExpected ? 'unreachable' : 'not used'}` +
      `, ${HOSTED_MCP_SERVER} ${status?.status ?? 'absent'}`
    if (elapsedMs >= timeoutMs) return { state: 'timeout', last, elapsedMs }
    await sleep(pollMs)
  }
}

// ── The permission guard (ADR-093 §3, S6) ───────────────────────────────────

export const GUARD_TIMEOUT_MS = 10_000

export type PermissionGuard =
  /** The plugin answered: its `permission.evaluate` and MCP hooks are registered. */
  | { state: 'active'; elapsedMs: number }
  /** No plugin, or it never confirmed both hooks: ClaudeUI must not run sessions here. */
  | { state: 'missing'; reason: string; elapsedMs: number }

/**
 * "Is ClaudeUI's permission hook active for this directory?" — the plugin's
 * `guard` RPC (`POST /api/rpc/claudeui-xeng/guard`) must answer
 * `{permissionHook: true, mcpDirect: true}`. Unlike {@link waitForHostedTools}
 * there is no heuristic fallback: the MCP status says nothing about hooks, and
 * without the hook the user's saved "always" rows answer ClaudeUI's asks. A
 * missing plugin answers `missing` at once; a silent or partial one after the
 * bounded wait. Never throws.
 */
export async function waitForPermissionGuard(
  options: { pluginExpected: boolean; timeoutMs?: number; pollMs?: number },
  deps: ReadinessDeps
): Promise<PermissionGuard> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  if (!options.pluginExpected)
    return {
      state: 'missing',
      reason: 'the claudeui-xeng plugin was not found in this ClaudeUI build',
      elapsedMs: 0
    }
  const timeoutMs = options.timeoutMs ?? GUARD_TIMEOUT_MS
  let last = 'no answer'
  for (;;) {
    const response = await settle(
      deps.request('POST', `/api/rpc/${PLUGIN_RPC_ID}/guard`, { input: {} })
    )
    const elapsedMs = now() - start
    const output = (response?.body as { output?: Record<string, unknown> } | null)?.output
    if (response?.status === 200 && output?.permissionHook === true && output?.mcpDirect === true)
      return { state: 'active', elapsedMs }
    last = response
      ? `guard RPC ${response.status} ${JSON.stringify(output ?? response.body).slice(0, 200)}`
      : 'guard RPC unreachable'
    if (elapsedMs >= timeoutMs)
      return {
        state: 'missing',
        reason: `the claudeui-xeng plugin did not confirm its permission hook (${last})`,
        elapsedMs
      }
    await sleep(options.pollMs ?? READINESS_POLL_MS * 2)
  }
}

/**
 * Model-discovery seam for S7 (ADR-093 §6, ADR-092): an empty `/api/model`
 * shortly after a server started is a cold location, not "no models" — the
 * catalog fills ~1.5 s later. Discovery must not negative-cache a list this
 * says is not authoritative; it retries (or waits for `model.updated`).
 * MCP readiness above says nothing about models.
 */
export const MODEL_CATALOG_WARMUP_MS = 10_000

export function modelListIsAuthoritative(input: {
  readonly count: number
  /** `ServerConnection.startedAt`. */
  readonly startedAt: number
  readonly now?: number
}): boolean {
  if (input.count > 0) return true
  return (input.now ?? Date.now()) - input.startedAt >= MODEL_CATALOG_WARMUP_MS
}
