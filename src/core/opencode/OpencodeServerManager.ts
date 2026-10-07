import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAppPath } from '../host'
import type { McpHttpHost } from './mcp-http-host'
import { startMcpHttpHost } from './mcp-http-host'
import { createOpencodeHostedToolsServer } from './opencode-hosted-tools'
import type {
  CallerRootResolver,
  CallerSessionLookup,
  DispatchAgentFn
} from './opencode-hosted-tools'
import {
  callerRestrictionFromAgent,
  mergeRestrictions,
  type CallerRestriction
} from './caller-restriction'
import type { Permission_Ruleset } from './protocol-v2/openapi'
import { collectClaudeMcpForOpencode } from './claude-mcp-bridge'
import {
  buildOpencodeConfigContent,
  configIdentity,
  type AgentPermissionOverlay,
  type OpencodeConfigInput
} from './opencode-server-config'
import {
  endStdioServer,
  spawnStdioServer,
  type SpawnResult,
  type SpawnServerFn
} from './opencode-server-spawn'
import {
  waitForHostedTools,
  waitForPermissionGuard,
  type HostedToolsReadiness,
  type PermissionGuard,
  type ReadinessDeps
} from './opencode-server-readiness'
import { agentPermissionOverlay } from './permission-v2'
import { harnessAvailable, harnessUnavailableMessage, resolveHarness } from '../harness/resolve'
import { toLaunch, type HarnessLaunch } from '../harness/launch'
import { logger } from '../services/logger'
import { OpencodeClient } from './OpencodeClient'

export type { SpawnResult, SpawnServerFn }
export type { HostedToolsReadiness, PermissionGuard }

/**
 * Thrown by `acquire` when the server's `claudeui-xeng` plugin is not loaded
 * and answering (ADR-097 §3, S6). Without its `permission.evaluate` hook the
 * user's saved "always" approvals from their own opencode would answer
 * ClaudeUI's permission asks, so ClaudeUI refuses to run sessions there.
 */
export class OpencodePermissionGuardError extends Error {
  constructor(
    readonly directory: string,
    readonly reason: string
  ) {
    super(
      `ClaudeUI will not run opencode sessions in ${directory}: its safety plugin is not active (${reason}). ` +
        'Without it, "always allow" approvals saved by your own opencode would answer ClaudeUI\'s permission prompts. ' +
        'Reinstall or update ClaudeUI; the opencode log has the plugin load error.'
    )
    this.name = 'OpencodePermissionGuardError'
  }
}

/**
 * opencode 2.x server lifecycle (ADR-097 §2, amends ADR-019).
 *
 * ONE `opencode serve --stdio` serves every directory: the directory travels
 * per request (`x-opencode-directory`), so servers are keyed by the config
 * they were injected with (`configIdentity`), not by cwd. In practice that is
 * one long-lived server per app; a cwd whose effective config differs (a
 * project-scoped Claude MCP server, a `disabledMcpServers` list) gets its own.
 * A config change therefore means a NEW server for new leases, while the old
 * one keeps serving its current holders and is ended when the last releases
 * (drained, never yanked). Every lease is ref-counted per directory.
 *
 * Each server gets its own hosted MCP endpoint (`claudeui`, mcp-http-host.ts)
 * and the `claudeui-xeng` directory plugin. `acquire(cwd)` returns once the
 * hosted tools are registered for that directory (opencode-server-readiness.ts)
 * — or the bounded wait gave up, which is logged — so the first turn in a
 * directory is offered `claudeui_*`.
 */

/** Connection details handed back to callers (and to the client). */
export interface ServerConnection {
  baseUrl: string
  password: string
  /** Pre-computed Authorization header value for HTTP Basic auth */
  authHeader: string
  /**
   * The absolute directory this lease is for. Every request about it must
   * carry it as `x-opencode-directory` (URI-encoded) — the server's own cwd is
   * NOT the caller's project (S3's client).
   */
  directory: string
  /** When the server printed its URL (epoch ms) — `modelListIsAuthoritative`'s input. */
  startedAt: number
  /** Whether the hosted tools were registered for `directory` when this lease was handed out. */
  hostedTools: HostedToolsReadiness
  /**
   * Asked for at acquire: when THIS lease is the last one released (by
   * `releaseIfCurrent`), the server stays up idle this long for the next read
   * instead of ending at once (S7, ADR-097 §5).
   */
  lingerMs?: number
}

/** A server of the caller's own (`acquireDetached`): `release()` ends it, once. */
export interface DetachedServer extends ServerConnection {
  release: () => void
}

interface ServerHandle {
  /** `configIdentity` of what this server was injected with. */
  key: string
  /** The idle end armed by a lingering last release; cleared by the next acquire. */
  idleTimer?: ReturnType<typeof setTimeout>
  baseUrl: string
  password: string
  authHeader: string
  startedAt: number
  process: ChildProcess
  mcpHost: McpHttpHost
  pluginExpected: boolean
  refCount: number
  /** Refs per normalized directory — `release(cwd)` and `subscribeExit(cwd)` look here. */
  cwdRefs: Map<string, number>
  /**
   * Fired when THIS server goes away and attached sessions must drop their
   * connection: an unexpected death, or a deliberate recycleAll(). NOT on the
   * last release or dispose(), which drop the handle (and clear this) first.
   */
  exitListeners: Set<() => void>
  /** Hosted-tools readiness per directory (each directory is its own MCP location). */
  readiness: Map<string, Promise<HostedToolsReadiness>>
  /** The plugin's permission guard per directory (only `active` results are kept). */
  guards: Map<string, Promise<PermissionGuard>>
  /**
   * The first-contact hook (proven-copy cleanup) succeeded on this server. Until
   * it has, the server serves credential-route leases only: anything else could
   * activate a location, and so resolve (and refresh) a copy (S7 review 1).
   */
  cleaned: boolean
  /** The hook run in flight or last settled. */
  cleanupRun?: { promise: Promise<boolean>; settled: boolean; startedAt: number }
  /** One `ensureCleaned` at a time per server. */
  ensuring?: Promise<void>
}

/** Bound on one first-contact hook run: a stuck hook never blocks a server start. */
export const SERVER_STARTED_HOOK_TIMEOUT_MS = 5_000
/** Back-off between the retries an acquire makes when the cleanup failed. */
export const CLEANUP_RETRY_DELAYS_MS: readonly number[] = [500, 1_500]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Thrown by `acquire` (and `acquireDetached`) when ClaudeUI could not check a
 * server's credentials for copies of its own ChatGPT sign-in: such a server
 * is not used for anything that activates a location (fail closed).
 */
export class OpencodeCredentialCleanupError extends Error {
  constructor(readonly baseUrl: string) {
    super(
      'ClaudeUI could not check opencode’s saved credentials for a copy of its own ChatGPT sign-in, ' +
        'so it will not open opencode sessions on that server yet (opencode could refresh the copy and ' +
        'sign ClaudeUI out). This is usually a busy opencode database — try again in a moment.'
    )
    this.name = 'OpencodeCredentialCleanupError'
  }
}

/** Where readiness and the cwd resolver send their requests. */
export interface Endpoint {
  baseUrl: string
  authHeader: string
}

export type WaitReadyFn = (
  endpoint: Endpoint,
  directory: string,
  pluginExpected: boolean
) => Promise<HostedToolsReadiness>

export type WaitGuardFn = (
  endpoint: Endpoint,
  directory: string,
  pluginExpected: boolean
) => Promise<PermissionGuard>

/**
 * How to spawn opencode next, from the harness resolver
 * (`../harness/resolve.ts`, ADR-082): `CLAUDEUI_OPENCODE_CLI`, then the
 * harnesses.json selection (ClaudeUI's store or a System install; nothing is
 * bundled, ADR-082 §8). Throws the resolver's user-readable reason when there
 * is none, which the acquire path surfaces.
 */
function locateLaunch(): HarnessLaunch {
  const resolved = resolveHarness('opencode')
  if (resolved.launch === null) throw new Error(harnessUnavailableMessage('opencode'))
  return resolved.launch
}

/**
 * Locate the `claudeui-xeng` DIRECTORY plugin (ADR-097 §4) the external
 * opencode process loads. opencode 2.x refuses a plugin path that is a file
 * (only a warning: `core/src/config/plugin/source.ts`), so it is a directory
 * (`index.js` + `package.json`). Same dev/packaged split as before: it ships
 * under `resources/` via electron-builder's `asarUnpack: resources/**`, so the
 * packaged path swaps `app.asar` → `app.asar.unpacked` in place — a real
 * directory on disk, which is what opencode needs.
 * Null (never throws) when absent: opencode still starts (session lists and
 * other turn-less reads work), but `acquire` for a turn refuses the server
 * (`OpencodePermissionGuardError`) — the plugin carries the permission hook.
 */
export function locatePluginDir(appPath: string = getAppPath()): string | null {
  const rel = ['resources', 'opencode', 'claudeui-xeng']
  const candidate = appPath.includes('app.asar')
    ? join(appPath.replace('app.asar', 'app.asar.unpacked'), ...rel)
    : join(appPath, ...rel)
  return existsSync(join(candidate, 'index.js')) ? candidate : null
}

/** How many parents a hosted tool call walks up to find ClaudeUI's own session. */
const MAX_CALLER_DEPTH = 8

/**
 * A session's directory and parent from the server (`GET /api/session/{id}`),
 * or undefined when it cannot be read.
 */
async function fetchSessionRef(
  endpoint: Endpoint,
  sessionId: string
): Promise<{ directory?: string; parentID?: string; agent?: string } | undefined> {
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/api/session/${encodeURIComponent(sessionId)}`,
      {
        headers: { authorization: endpoint.authHeader },
        signal: AbortSignal.timeout(5_000)
      }
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      data?: { location?: { directory?: unknown }; parentID?: unknown; agent?: unknown }
    }
    const directory = body.data?.location?.directory
    const parentID = body.data?.parentID
    const agent = body.data?.agent
    return {
      ...(typeof directory === 'string' && directory ? { directory } : {}),
      ...(typeof parentID === 'string' && parentID ? { parentID } : {}),
      ...(typeof agent === 'string' && agent ? { agent } : {})
    }
  } catch {
    return undefined
  }
}

/** A directory's agents with their rulesets (`GET /api/agent`), or undefined. */
async function fetchAgents(
  endpoint: Endpoint,
  directory: string
): Promise<readonly { id: string; permissions: Permission_Ruleset }[] | undefined> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/api/agent`, {
      headers: {
        authorization: endpoint.authHeader,
        'x-opencode-directory': encodeURIComponent(directory)
      },
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: unknown }
    return Array.isArray(body.data)
      ? (body.data as { id: string; permissions: Permission_Ruleset }[])
      : undefined
  } catch {
    return undefined
  }
}

/** HTTP against the server, scoped to `directory` (readiness and the guard). */
function readinessDeps(endpoint: Endpoint, directory: string): ReadinessDeps {
  return {
    request: async (method, path, body) => {
      const response = await fetch(endpoint.baseUrl + path, {
        method,
        headers: {
          authorization: endpoint.authHeader,
          'x-opencode-directory': encodeURIComponent(directory),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5_000)
      })
      const text = await response.text()
      let parsed: unknown = text
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        // keep the text
      }
      return { status: response.status, body: parsed }
    }
  }
}

/** The real readiness wait. */
const defaultWaitReady: WaitReadyFn = (endpoint, directory, pluginExpected) =>
  waitForHostedTools({ pluginExpected }, readinessDeps(endpoint, directory))

/** The real guard probe (the plugin's `guard` RPC). */
const defaultWaitGuard: WaitGuardFn = (endpoint, directory, pluginExpected) =>
  waitForPermissionGuard({ pluginExpected }, readinessDeps(endpoint, directory))

export interface OpencodeServerManagerOptions {
  /**
   * Override the spawn implementation. Defaults to the real
   * `opencode serve --stdio`. Tests inject a fake to exercise the lifecycle
   * without a binary.
   */
  spawnFn?: SpawnServerFn
  /**
   * Override the launch locator. Defaults to the harness resolver; called on
   * every spawn, so an install or a selection change reaches the next server.
   * A bare path is a native launch (`toLaunch`).
   */
  locateBinaryFn?: () => string | HarnessLaunch
  /** Override the MCP host starter (tests avoid binding real ports). */
  startMcpHostFn?: (createServer: () => McpServer) => Promise<McpHttpHost>
  /**
   * What a cwd's server is injected with. Defaults to the Claude MCP bridge,
   * the located plugin and the agent-permission provider.
   */
  configInputFn?: (cwd: string) => OpencodeConfigInput
  /** Override the hosted-tools readiness wait (tests use a fake). */
  waitReadyFn?: WaitReadyFn
  /** Override the plugin permission-guard probe (tests use a fake). */
  waitGuardFn?: WaitGuardFn
  /** Override how a server is ended (default: stdin EOF, then tree kill). */
  endServerFn?: (child: ChildProcess) => void
  /** The servers' process cwd (requests carry their own directory). Default: home. */
  serverCwd?: string
  /** Override the config-reload calls (`session.active`, `location.reload`) — tests use a fake. */
  configReloadOpsFn?: (endpoint: Endpoint, directory: string) => ConfigReloadOps
}

/** What `reloadConfig` asks one server. */
export interface ConfigReloadOps {
  /** How many sessions run an execution on the server (`GET /api/session/active`). */
  activeExecutions(): Promise<number>
  /** `POST /api/location/reload`. */
  reloadLocations(): Promise<void>
}

/** What one `reloadConfig` did. */
export interface ConfigReloadReport {
  /** Servers whose locations were rebuilt. */
  reloaded: number
  /** Servers left to opencode's own config watcher because an execution was running. */
  busy: number
  /** Servers the reload failed on (logged). */
  failed: number
}

function defaultConfigReloadOps(endpoint: Endpoint, directory: string): ConfigReloadOps {
  const client = new OpencodeClient({ ...endpoint, directory })
  return {
    activeExecutions: async () => Object.keys(await client.activeSessions()).length,
    reloadLocations: () => client.reloadLocation()
  }
}

/**
 * Shared, ref-counted opencode 2.x servers, keyed by injected config. The
 * lifecycle contract sessions build on: acquire on attach, release on dispose,
 * last-out ends the server.
 */
export class OpencodeServerManager {
  /** Live servers by `configIdentity`, in start order (newest last). */
  private handles = new Map<string, ServerHandle>()
  /**
   * In-flight spawns by config key. Set SYNCHRONOUSLY before the spawn await so
   * concurrent acquires with the same config share one start.
   */
  private pending = new Map<string, Promise<ServerHandle>>()
  /** Servers handed out by acquireDetached() and not yet released. */
  private detached = new Set<ServerHandle>()
  /**
   * The last start, until it printed its URL (or failed). Starts take turns:
   * opencode has no cross-process lock on its database (ADR-097 §6), and a
   * first 2.x start migrates a 1.x-created one in place, so two processes must
   * not start at once (a discovery server beside the pooled one).
   */
  private startTurn: Promise<unknown> = Promise.resolve()
  /** Set once dispose() runs: nothing starts after it, and a start in flight reaps itself. */
  private disposed = false
  private readonly spawnFn: SpawnServerFn
  private readonly locateBinaryFn: () => string | HarnessLaunch
  private readonly startMcpHostFn: (createServer: () => McpServer) => Promise<McpHttpHost>
  private readonly configInputFn: (cwd: string) => OpencodeConfigInput
  private readonly waitReadyFn: WaitReadyFn
  private readonly waitGuardFn: WaitGuardFn
  private readonly endServerFn: (child: ChildProcess) => void
  private readonly serverCwd: string
  private readonly configReloadOpsFn: (endpoint: Endpoint, directory: string) => ConfigReloadOps
  /** Told after ClaudeUI changed opencode's config files (sessions drop their agent lists). */
  private readonly configListeners = new Set<() => void>()
  /**
   * Cross-engine dispatch (ADR-033 M2) dependencies, threaded in from OUTSIDE
   * this module (core-services.ts, at boot) — importing `sessionManager` or
   * `crossEngineDispatcher` here would form a require-cycle (see
   * opencode-hosted-tools.ts). Read live on every call.
   */
  private callerSessionLookup: CallerSessionLookup = () => undefined
  private dispatchAgentFn: DispatchAgentFn | undefined
  private serverStartedHook: ((endpoint: Endpoint) => Promise<void>) | undefined
  /**
   * `agents.<name>.permissions` per cwd (ADR-097 §3). Default: the mode-less
   * overlay (`permission-v2.ts` `agentPermissionOverlay`).
   */
  private agentPermissionsFn: (
    cwd: string,
    mcpServers: readonly string[]
  ) => AgentPermissionOverlay = () => agentPermissionOverlay()

  constructor(opts: OpencodeServerManagerOptions = {}) {
    this.spawnFn = opts.spawnFn ?? ((launch, options) => spawnStdioServer(launch, options))
    this.locateBinaryFn = opts.locateBinaryFn ?? locateLaunch
    this.startMcpHostFn = opts.startMcpHostFn ?? startMcpHttpHost
    this.configInputFn = opts.configInputFn ?? ((cwd) => this.defaultConfigInput(cwd))
    this.waitReadyFn = opts.waitReadyFn ?? defaultWaitReady
    this.waitGuardFn = opts.waitGuardFn ?? defaultWaitGuard
    this.endServerFn = opts.endServerFn ?? ((child) => void endStdioServer(child))
    this.serverCwd = opts.serverCwd ?? homedir()
    this.configReloadOpsFn = opts.configReloadOpsFn ?? defaultConfigReloadOps
  }

  /** Wire the caller-session lookup used by the hosted `dispatch_agent` (ADR-033 M2). */
  setCallerSessionLookup(fn: CallerSessionLookup): void {
    this.callerSessionLookup = fn
  }

  /** Wire the cross-engine dispatch function used by the hosted `dispatch_agent` (ADR-033 M2). */
  setDispatchAgent(fn: DispatchAgentFn): void {
    this.dispatchAgentFn = fn
  }

  /**
   * Per-agent permission rules injected as `agents.<name>.permissions`
   * (ADR-097 §3; replaces the default overlay). A changed answer changes the
   * config identity, so it reaches new leases on a new server.
   */
  setAgentPermissionProvider(
    fn: (cwd: string, mcpServers: readonly string[]) => AgentPermissionOverlay
  ): void {
    this.agentPermissionsFn = fn
  }

  private defaultConfigInput(cwd: string): OpencodeConfigInput {
    const bridgedMcp = collectClaudeMcpForOpencode(cwd)
    return {
      bridgedMcp,
      pluginDir: locatePluginDir(),
      agentPermissions: this.agentPermissionsFn(cwd, Object.keys(bridgedMcp))
    }
  }

  /** Resolved per spawn, never memoised here (the resolver caches and invalidates). */
  private getLaunch(): HarnessLaunch {
    return toLaunch(this.locateBinaryFn())
  }

  /**
   * Cheap, deterministic "is opencode installed?" check (the harness resolver's
   * answer). This NEVER spawns a server.
   */
  isBinaryAvailable(): boolean {
    return harnessAvailable('opencode')
  }

  /** Resolve (or start) the server for a config key. Its refCount is NOT incremented. */
  private async resolveHandle(key: string, input: OpencodeConfigInput): Promise<ServerHandle> {
    const existing = this.handles.get(key)
    if (existing) return existing
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const spawnPromise = (async (): Promise<ServerHandle> => {
      const handle = await this.startServer(key, input)
      this.handles.set(key, handle)
      handle.process.on('exit', (code, signal) => {
        if (this.handles.get(key) !== handle) return
        // Reaching this identity gate means the death was UNEXPECTED: every
        // deliberate end (last release, recycleAll, dispose) removes the
        // handle first. Fan out so attached sessions drop the dead connection.
        this.handles.delete(key)
        handle.mcpHost.close().catch(() => {})
        logger.warn(
          'OpencodeServerManager',
          `opencode server ${handle.baseUrl} (config ${key}) exited unexpectedly (code=${code}, signal=${signal})`
        )
        this.fanOutExit(handle)
      })
      return handle
    })()

    this.pending.set(key, spawnPromise)
    try {
      return await spawnPromise
    } finally {
      if (this.pending.get(key) === spawnPromise) this.pending.delete(key)
    }
  }

  private fanOutExit(handle: ServerHandle): void {
    const listeners = [...handle.exitListeners]
    handle.exitListeners.clear()
    for (const cb of listeners) {
      try {
        cb()
      } catch {
        // One bad subscriber must never starve the others.
      }
    }
  }

  /**
   * Start one server with its MCP host — registered NOWHERE: the caller owns
   * it (the pool, or a detached lease). Reaps what it started, and rejects,
   * when dispose() ran meanwhile.
   */
  private async startServer(key: string, input: OpencodeConfigInput): Promise<ServerHandle> {
    if (this.disposed) throw new Error('OpencodeServerManager disposed')
    const password = randomBytes(24).toString('base64url')
    const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
    // Fail fast — before an MCP host — when opencode cannot run at all.
    this.getLaunch()

    // The hosted tools resolve a call's directory from its caller: ClaudeUI's
    // own session first, else the server's record of the session (a task
    // child, a dispatch target). The server's URL is known only after spawn.
    let endpoint: Endpoint | null = null
    const resolveCwd = async (sessionId: string | undefined): Promise<string | undefined> => {
      if (!sessionId) return undefined
      const own = this.callerSessionLookup(sessionId)?.cwd
      if (own) return own
      return endpoint ? (await fetchSessionRef(endpoint, sessionId))?.directory : undefined
    }
    // A subagent child of a ClaudeUI chat calling a hosted tool: its id is not
    // a ClaudeUI session, so walk its parents (ADR-097 §4, S9). Every child on
    // the way contributes its agent's own restriction (option a); an agent
    // whose rules cannot be read refuses the call (fail closed).
    const resolveCallerRoot: CallerRootResolver = async (sessionId) => {
      const chain: { agent?: string; directory?: string }[] = []
      let id = sessionId
      for (let depth = 0; endpoint && depth < MAX_CALLER_DEPTH; depth++) {
        const ref = await fetchSessionRef(endpoint, id)
        if (!ref?.parentID) return undefined
        chain.push({ agent: ref.agent, directory: ref.directory })
        if (this.callerSessionLookup(ref.parentID)) {
          let restriction: CallerRestriction | undefined
          for (const link of chain) {
            const directory = link.directory ?? this.serverCwd
            const agents = await fetchAgents(endpoint, directory)
            const agent = link.agent ? agents?.find((a) => a.id === link.agent) : agents?.[0]
            if (!agent)
              return {
                refused: `ClaudeUI could not read the permission rules of the calling subagent${link.agent ? ` (${link.agent})` : ''}, so it will not dispatch for it.`
              }
            restriction = mergeRestrictions(
              restriction,
              callerRestrictionFromAgent(agent, directory)
            )
          }
          return { root: ref.parentID, restriction }
        }
        id = ref.parentID
      }
      return undefined
    }
    const mcpHost = await this.startMcpHostFn(() =>
      createOpencodeHostedToolsServer(resolveCwd, {
        lookupCallerSession: (sessionId) => this.callerSessionLookup(sessionId),
        resolveCallerRoot,
        dispatch: this.dispatchAgentFn && ((req, ctx) => this.dispatchAgentFn!(req, ctx)),
        onIdentityMismatch: (identity) =>
          logger.warn(
            'OpencodeServerManager',
            `hosted tool call: _meta session ${identity.sessionId} differs from the plugin stamp — using _meta, no call id`
          )
      })
    )

    let result: SpawnResult
    try {
      const turn = this.startTurn.then(() => {
        // A start queued behind others: shutdown may have come meanwhile, and
        // the launch resolves NOW (an install made while this waited wins).
        if (this.disposed) throw new Error('OpencodeServerManager disposed before spawn')
        return this.spawnFn(this.getLaunch(), {
          cwd: this.serverCwd,
          password,
          configContent: buildOpencodeConfigContent(input, mcpHost)
        })
      })
      this.startTurn = turn.catch(() => {})
      result = await turn
    } catch (err) {
      await mcpHost.close().catch(() => {})
      throw err
    }
    endpoint = { baseUrl: result.baseUrl, authHeader }

    const handle: ServerHandle = {
      key,
      baseUrl: result.baseUrl,
      password,
      authHeader,
      startedAt: Date.now(),
      process: result.process,
      mcpHost,
      pluginExpected: !!input.pluginDir,
      refCount: 0,
      cwdRefs: new Map(),
      exitListeners: new Set(),
      readiness: new Map(),
      guards: new Map(),
      cleaned: !this.serverStartedHook
    }

    if (this.disposed) {
      this.endServerFn(handle.process)
      await mcpHost.close().catch(() => {})
      throw new Error('OpencodeServerManager disposed during spawn')
    }
    logger.info(
      'OpencodeServerManager',
      `opencode server ${handle.baseUrl} started (config ${key}${handle.pluginExpected ? '' : ', claudeui-xeng plugin NOT found'})`
    )
    // First contact: runs before the server is handed to anyone. A failed or
    // stuck run leaves it uncleaned — credential-route leases only, until a
    // retry (on the next acquire that needs more) succeeds.
    if (!handle.cleaned) {
      const ok = await this.boundedCleanup(handle)
      if (!ok)
        logger.warn(
          'OpencodeServerManager',
          `first-contact cleanup on ${handle.baseUrl} did not finish — no location requests until it does`
        )
    }
    return handle
  }

  /**
   * The first-contact hook (S7 follow-up, ADR-097 §5): the credential store's
   * proven-copy cleanup. 2.0.24 resolves (and so may refresh) the active OAuth
   * credential only when a location activates its plugins; the credential
   * routes do not activate one, so a hook using only them runs ahead of every
   * resolution. One run, bounded by {@link SERVER_STARTED_HOOK_TIMEOUT_MS};
   * resolves whether it succeeded (a run that outlives the bound may still
   * succeed later and mark the server).
   */
  private boundedCleanup(handle: ServerHandle): Promise<boolean> {
    const hook = this.serverStartedHook
    if (!hook) {
      handle.cleaned = true
      return Promise.resolve(true)
    }
    let run = handle.cleanupRun
    // A run past its bound is presumed stuck: start another (the deletions are
    // idempotent — removing a removed id is a no-op).
    if (!run || run.settled || Date.now() - run.startedAt >= SERVER_STARTED_HOOK_TIMEOUT_MS) {
      const entry: { promise: Promise<boolean>; settled: boolean; startedAt: number } = {
        promise: Promise.resolve(false),
        settled: false,
        startedAt: Date.now()
      }
      entry.promise = (async () => {
        await hook({ baseUrl: handle.baseUrl, authHeader: handle.authHeader })
        return true
      })()
        .catch((err: unknown) => {
          logger.warn(
            'OpencodeServerManager',
            `first-contact cleanup failed: ${err instanceof Error ? err.name : 'error'}`
          )
          return false
        })
        .then((ok) => {
          entry.settled = true
          // Any run that succeeds cleans the server (a late one included).
          if (ok) handle.cleaned = true
          return ok
        })
      handle.cleanupRun = entry
      run = entry
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      run.promise,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SERVER_STARTED_HOOK_TIMEOUT_MS)
      })
    ]).finally(() => clearTimeout(timer))
  }

  /**
   * Make sure the first-contact cleanup succeeded on `handle` before it serves
   * anything that can activate a location: retries with back-off
   * ({@link CLEANUP_RETRY_DELAYS_MS}), then fails closed with
   * {@link OpencodeCredentialCleanupError}. A later acquire tries again.
   */
  private ensureCleaned(handle: ServerHandle): Promise<void> {
    if (handle.cleaned) return Promise.resolve()
    handle.ensuring ??= (async () => {
      for (let attempt = 0; attempt <= CLEANUP_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await sleep(CLEANUP_RETRY_DELAYS_MS[attempt - 1])
        if (handle.cleaned || (await this.boundedCleanup(handle))) return
      }
      throw new OpencodeCredentialCleanupError(handle.baseUrl)
    })().finally(() => {
      handle.ensuring = undefined
    })
    return handle.ensuring
  }

  /** Wire the first-contact hook (the credential store's copy cleanup, at boot). */
  setServerStartedHook(hook: ((endpoint: Endpoint) => Promise<void>) | null): void {
    this.serverStartedHook = hook ?? undefined
  }

  /** Hosted-tools readiness for one directory of one server, waited once (memoized). */
  private readinessFor(handle: ServerHandle, directory: string): Promise<HostedToolsReadiness> {
    let ready = handle.readiness.get(directory)
    if (!ready) {
      ready = this.waitReadyFn(handle, directory, handle.pluginExpected)
        .catch((err): HostedToolsReadiness => ({
          state: 'timeout',
          last: `readiness probe threw: ${err instanceof Error ? err.message : String(err)}`,
          elapsedMs: 0
        }))
        .then((result) => {
          this.logReadiness(handle, directory, result)
          return result
        })
      handle.readiness.set(directory, ready)
    }
    return ready
  }

  /**
   * The plugin's permission guard for one directory: memoized only while
   * `active`; a `missing` answer is dropped so the next acquire probes again.
   */
  private guardFor(handle: ServerHandle, directory: string): Promise<PermissionGuard> {
    let guard = handle.guards.get(directory)
    if (!guard) {
      guard = this.waitGuardFn(handle, directory, handle.pluginExpected)
        .catch((err): PermissionGuard => ({
          state: 'missing',
          reason: `guard probe threw: ${err instanceof Error ? err.message : String(err)}`,
          elapsedMs: 0
        }))
        .then((result) => {
          if (result.state !== 'active') {
            handle.guards.delete(directory)
            logger.error(
              'OpencodeServerManager',
              `claudeui-xeng permission guard NOT active on ${handle.baseUrl} for ${directory}: ${result.reason} — refusing sessions there`
            )
          }
          return result
        })
      handle.guards.set(directory, guard)
    }
    return guard
  }

  private logReadiness(
    handle: ServerHandle,
    directory: string,
    result: HostedToolsReadiness
  ): void {
    const where = `${handle.baseUrl} for ${directory}`
    switch (result.state) {
      case 'ready':
        logger.info(
          'OpencodeServerManager',
          `hosted tools registered on ${where} after ${result.elapsedMs} ms (${result.signal === 'registry' ? 'plugin registry' : 'mcp status + settle'})`
        )
        return
      case 'failed':
        logger.warn(
          'OpencodeServerManager',
          `hosted MCP server failed on ${where}: ${result.reason} — turns there run without claudeui_* tools`
        )
        return
      case 'timeout':
        logger.warn(
          'OpencodeServerManager',
          `hosted tools still not registered on ${where} after ${result.elapsedMs} ms (${result.last}) — the first turn may run without claudeui_* tools`
        )
        return
      case 'skipped':
        return
    }
  }

  private connectionOf(
    handle: ServerHandle,
    directory: string,
    hostedTools: HostedToolsReadiness
  ): ServerConnection {
    return {
      baseUrl: handle.baseUrl,
      password: handle.password,
      authHeader: handle.authHeader,
      directory,
      startedAt: handle.startedAt,
      hostedTools
    }
  }

  /**
   * Acquire the server for `cwd`: the one whose injected config matches this
   * cwd's (started if none), once the hosted tools are registered for the cwd
   * (bounded wait, logged when it gives up). Pair every `acquire` with exactly
   * one release (prefer `releaseIfCurrent(cwd, conn)`).
   *
   * `waitForHostedTools: false` skips the wait (`hostedTools: skipped`) for a
   * caller that runs no turn — session lists, auth, usage reads — so it never
   * pays for MCP start-up it does not use.
   *
   * Every other (turn-running) acquire also requires the plugin's permission
   * guard to be active for the directory, and throws
   * {@link OpencodePermissionGuardError} otherwise (fail closed; the lease is
   * released). The hosted-tools status fallback never stands in for it.
   */
  async acquire(
    cwd: string,
    options: {
      waitForHostedTools?: boolean
      lingerMs?: number
      /**
       * The lease only uses `/api/credential` routes, which never activate a
       * location — the one kind served by a server whose first-contact cleanup
       * has not succeeded (S7 review 1).
       */
      credentialRoutesOnly?: boolean
    } = {}
  ): Promise<ServerConnection> {
    const directory = resolvePath(cwd)
    const input = this.configInputFn(directory)
    const key = configIdentity(input)
    const handle = await this.resolveHandle(key, input)
    return this.leaseOn(handle, directory, options)
  }

  /** A lease on a resolved server (the rest of `acquire`). */
  private async leaseOn(
    handle: ServerHandle,
    directory: string,
    options: { waitForHostedTools?: boolean; lingerMs?: number; credentialRoutesOnly?: boolean }
  ): Promise<ServerConnection> {
    const key = handle.key
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer)
      handle.idleTimer = undefined
    }
    handle.refCount++
    handle.cwdRefs.set(directory, (handle.cwdRefs.get(directory) ?? 0) + 1)
    if (!options.credentialRoutesOnly) {
      try {
        await this.ensureCleaned(handle)
      } catch (err) {
        // Release (and end it when this was its only lease): never hand it out.
        this.releaseHandle(handle, directory)
        throw err
      }
    }
    const turn = options.waitForHostedTools !== false
    const [hostedTools, guard] = await Promise.all([
      turn ? this.readinessFor(handle, directory) : ({ state: 'skipped' } as const),
      turn ? this.guardFor(handle, directory) : null
    ])
    if (guard && guard.state !== 'active') {
      // Release (and end it when this was its only lease): never hand it out.
      this.releaseHandle(handle, directory)
      throw new OpencodePermissionGuardError(directory, guard.reason)
    }
    if (this.handles.get(key) !== handle) {
      // It died (or was recycled) while we waited: hand out nothing dead.
      handle.refCount--
      this.decrementCwd(handle, directory)
      throw new Error(`opencode server ${handle.baseUrl} went away while starting`)
    }
    const conn = this.connectionOf(handle, directory, hostedTools)
    return options.lingerMs ? { ...conn, lingerMs: options.lingerMs } : conn
  }

  /**
   * `acquire`, but only on a server already running (and cleaned): null instead
   * of starting one. For reads that must never cost a spawn of their own (the
   * sidebar's session-list refresh, S9). `anyConfig`: any live pooled server
   * will do — for routes that are global (the session list, history and
   * delete), so a project whose config differs never makes a second server.
   */
  async acquireIfRunning(
    cwd: string,
    options: { waitForHostedTools?: boolean; lingerMs?: number; anyConfig?: boolean } = {}
  ): Promise<ServerConnection | null> {
    if (this.disposed) return null
    const directory = resolvePath(cwd)
    const own = this.handles.get(configIdentity(this.configInputFn(directory)))
    const handle =
      own?.cleaned === true
        ? own
        : options.anyConfig
          ? [...this.handles.values()].find((h) => h.cleaned)
          : undefined
    if (!handle) return null
    const { anyConfig: _anyConfig, ...lease } = options
    return this.leaseOn(handle, directory, lease)
  }

  /**
   * Run the hosted-tools wait for `conn`'s directory again, bypassing the memo —
   * for S8 after `POST /api/location/reload`, which reconnects the location's
   * MCP clients. Resolves `skipped` when the server is gone.
   */
  async refreshReadiness(conn: ServerConnection): Promise<HostedToolsReadiness> {
    const handle = this.handleOf(conn)
    if (!handle) return { state: 'skipped' }
    handle.readiness.delete(conn.directory)
    return this.readinessFor(handle, conn.directory)
  }

  /**
   * Subscribe to "ClaudeUI changed opencode's config": fired by every
   * `reloadConfig`, reloaded or not (opencode's own watcher applies the files
   * either way), so per-connection caches (a session's agent list) re-read.
   */
  onConfigChanged(cb: () => void): () => void {
    this.configListeners.add(cb)
    return () => {
      this.configListeners.delete(cb)
    }
  }

  /**
   * After ClaudeUI wrote opencode's config (ADR-097 S8): rebuild every pooled
   * server's locations with `POST /api/location/reload`, then re-run each held
   * directory's hosted-tools readiness (the reload reconnects MCP) and drop its
   * permission-guard memo (the plugin registers again).
   *
   * A server with a running execution is NOT reloaded: a reload cancels pending
   * permission asks and forms ("Interaction cancelled because the location shut
   * down" — the tool fails, the turn goes on without the user's answer).
   * opencode's own config watcher applies the written files there anyway
   * (config documents, agent and provider definitions, ~0.5 s); the reload is
   * what makes the change deterministic where nothing is in flight. Residual: an
   * execution that starts between the check and the reload (well under a
   * second) can lose an ask the same way. Detached servers are short-lived and
   * left alone. Never throws.
   */
  async reloadConfig(): Promise<ConfigReloadReport> {
    const report: ConfigReloadReport = { reloaded: 0, busy: 0, failed: 0 }
    for (const handle of [...this.handles.values()]) {
      const directories = [...handle.cwdRefs.keys()]
      const ops = this.configReloadOpsFn(handle, directories[0] ?? this.serverCwd)
      try {
        // A reload activates locations: never on a server not cleaned yet (S7).
        await this.ensureCleaned(handle)
        const running = await ops.activeExecutions()
        if (running > 0) {
          report.busy++
          logger.info(
            'OpencodeServerManager',
            `config changed: ${handle.baseUrl} not reloaded (${running} running execution(s)); opencode's config watcher applies it`
          )
          continue
        }
        await ops.reloadLocations()
        report.reloaded++
        for (const directory of directories) {
          handle.readiness.delete(directory)
          handle.guards.delete(directory)
        }
        await Promise.all(directories.map((directory) => this.readinessFor(handle, directory)))
      } catch (err) {
        report.failed++
        logger.warn(
          'OpencodeServerManager',
          `config reload on ${handle.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    for (const cb of [...this.configListeners]) {
      try {
        cb()
      } catch (err) {
        logger.warn('OpencodeServerManager', `config listener threw: ${String(err)}`)
      }
    }
    return report
  }

  /**
   * A server for `cwd` of its OWN — never the pooled one, never shared — that
   * lives until its `release()`. For reads that must answer from the opencode
   * ClaudeUI runs NOW (model discovery). Spawned from the resolver's current
   * answer and reaped by dispose(). No readiness wait (`hostedTools: skipped`).
   */
  async acquireDetached(cwd: string): Promise<DetachedServer> {
    const directory = resolvePath(cwd)
    const input = this.configInputFn(directory)
    const handle = await this.startServer(configIdentity(input), input)
    try {
      await this.ensureCleaned(handle)
    } catch (err) {
      this.endServerFn(handle.process)
      handle.mcpHost.close().catch(() => {})
      throw err
    }
    this.detached.add(handle)
    handle.process.on('exit', () => {
      if (this.detached.delete(handle)) handle.mcpHost.close().catch(() => {})
    })
    return {
      ...this.connectionOf(handle, directory, { state: 'skipped' }),
      release: () => {
        if (!this.detached.delete(handle)) return
        this.endServerFn(handle.process)
        handle.mcpHost.close().catch(() => {})
      }
    }
  }

  private handleOf(conn: Pick<ServerConnection, 'baseUrl' | 'password'>): ServerHandle | undefined {
    for (const handle of this.handles.values())
      if (handle.baseUrl === conn.baseUrl && handle.password === conn.password) return handle
    return undefined
  }

  /** The newest live server holding a lease for `directory`. */
  private newestHolding(directory: string): ServerHandle | undefined {
    let found: ServerHandle | undefined
    for (const handle of this.handles.values())
      if ((handle.cwdRefs.get(directory) ?? 0) > 0) found = handle
    return found
  }

  /**
   * Release a lease by cwd. When servers with different configs both hold
   * `cwd` (a config change between two acquires), the NEWEST is released —
   * right for an acquire/release pair around one call. A long-lived holder
   * should use releaseIfCurrent(cwd, conn), which is exact.
   */
  release(cwd: string): void {
    const directory = resolvePath(cwd)
    const handle = this.newestHolding(directory)
    if (handle) this.releaseHandle(handle, directory)
  }

  /**
   * Release a lease ONLY if `conn`'s server is still live. Exact: a server's
   * baseUrl+password is unique per spawn, so a connection-loss path can never
   * decrement a REPLACEMENT server another session has since acquired.
   * No-op when the server already went away.
   */
  releaseIfCurrent(cwd: string, conn: ServerConnection): void {
    const handle = this.handleOf(conn)
    if (!handle) return
    const directory = resolvePath(cwd)
    if ((handle.cwdRefs.get(directory) ?? 0) <= 0) return
    this.releaseHandle(handle, directory, conn.lingerMs)
  }

  private decrementCwd(handle: ServerHandle, directory: string): void {
    const left = (handle.cwdRefs.get(directory) ?? 0) - 1
    if (left > 0) handle.cwdRefs.set(directory, left)
    else handle.cwdRefs.delete(directory)
  }

  private releaseHandle(handle: ServerHandle, directory: string, lingerMs = 0): void {
    handle.refCount--
    this.decrementCwd(handle, directory)
    if (handle.refCount > 0) return
    if (lingerMs > 0 && this.handles.get(handle.key) === handle && !this.disposed) {
      // Idle, not ended: the next read within the window reuses it (S7).
      if (handle.idleTimer) clearTimeout(handle.idleTimer)
      handle.idleTimer = setTimeout(() => {
        handle.idleTimer = undefined
        if (handle.refCount === 0) this.endHandle(handle)
      }, lingerMs)
      handle.idleTimer.unref?.()
      return
    }
    this.endHandle(handle)
  }

  /** End a released server. */
  private endHandle(handle: ServerHandle): void {
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer)
      handle.idleTimer = undefined
    }
    // Drop the handle BEFORE ending it: the exit handler is identity-gated, so
    // this is what marks the end as deliberate and suppresses the fan-out.
    if (this.handles.get(handle.key) === handle) this.handles.delete(handle.key)
    handle.exitListeners.clear()
    this.endServerFn(handle.process)
    handle.mcpHost.close().catch(() => {})
  }

  /**
   * Subscribe to the loss of a server — an unexpected death, or recycleAll().
   * With `conn`, exactly that lease's server; without, the newest live server
   * holding `cwd`. Returns an unsubscribe bound to that handle (a stale one can
   * never touch a respawn); a no-op when there is none.
   */
  subscribeExit(cwd: string, cb: () => void, conn?: ServerConnection): () => void {
    const handle = conn ? this.handleOf(conn) : this.newestHolding(resolvePath(cwd))
    if (!handle) return () => {}
    handle.exitListeners.add(cb)
    return () => {
      handle.exitListeners.delete(cb)
    }
  }

  /**
   * End every pooled server so the next acquire starts a fresh one, fanning
   * out exit listeners so attached sessions drop their connections now.
   * (1.x needed this after every auth change; 2.x hot-reloads credentials and
   * S7 removes the callers — ADR-097 §5.) Deletion precedes the end so a racing
   * acquire starts fresh and the exit handler stays quiet. In-flight starts
   * are left alone.
   */
  recycleAll(): void {
    for (const [key, handle] of [...this.handles]) {
      if (handle.idleTimer) clearTimeout(handle.idleTimer)
      this.handles.delete(key)
      this.fanOutExit(handle)
      this.endServerFn(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
  }

  /**
   * End all servers — call on app shutdown. Each gets stdin EOF (and a tree
   * kill after the grace period if it is still up); if the app exits first,
   * the closed pipe ends it anyway.
   */
  dispose(): void {
    this.disposed = true
    for (const handle of this.handles.values()) {
      if (handle.idleTimer) clearTimeout(handle.idleTimer)
      handle.exitListeners.clear()
      this.endServerFn(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
    this.handles.clear()
    this.pending.clear()
    for (const handle of this.detached) {
      this.endServerFn(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
    this.detached.clear()
  }

  /** For testing: the count of live (resolved) pooled servers. */
  get activeCount(): number {
    return this.handles.size
  }
}

export const opencodeServerManager = new OpencodeServerManager()
