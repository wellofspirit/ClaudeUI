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
import type { CallerSessionLookup, DispatchAgentFn } from './opencode-hosted-tools'
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
import { waitForHostedTools, type HostedToolsReadiness } from './opencode-server-readiness'
import { harnessAvailable, harnessUnavailableMessage, resolveHarness } from '../harness/resolve'
import { toLaunch, type HarnessLaunch } from '../harness/launch'
import { logger } from '../services/logger'

export type { SpawnResult, SpawnServerFn }
export type { HostedToolsReadiness }

/**
 * opencode 2.x server lifecycle (ADR-093 §2, amends ADR-019).
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
}

/** A server of the caller's own (`acquireDetached`): `release()` ends it, once. */
export interface DetachedServer extends ServerConnection {
  release: () => void
}

interface ServerHandle {
  /** `configIdentity` of what this server was injected with. */
  key: string
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
}

/** Where readiness and the cwd resolver send their requests. */
interface Endpoint {
  baseUrl: string
  authHeader: string
}

export type WaitReadyFn = (
  endpoint: Endpoint,
  directory: string,
  pluginExpected: boolean
) => Promise<HostedToolsReadiness>

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
 * Locate the `claudeui-xeng` DIRECTORY plugin (ADR-093 §4) the external
 * opencode process loads. opencode 2.x refuses a plugin path that is a file
 * (only a warning: `core/src/config/plugin/source.ts`), so it is a directory
 * (`index.js` + `package.json`). Same dev/packaged split as before: it ships
 * under `resources/` via electron-builder's `asarUnpack: resources/**`, so the
 * packaged path swaps `app.asar` → `app.asar.unpacked` in place — a real
 * directory on disk, which is what opencode needs.
 * Null (never throws) when absent: opencode still starts; caller identity then
 * rests on `_meta` alone (no live-streaming call id) and readiness falls back
 * to the MCP status signal.
 */
export function locatePluginDir(appPath: string = getAppPath()): string | null {
  const rel = ['resources', 'opencode', 'claudeui-xeng']
  const candidate = appPath.includes('app.asar')
    ? join(appPath.replace('app.asar', 'app.asar.unpacked'), ...rel)
    : join(appPath, ...rel)
  return existsSync(join(candidate, 'index.js')) ? candidate : null
}

/** The calling session's directory from the server (`GET /api/session/{id}`), or undefined. */
async function fetchSessionDirectory(
  endpoint: Endpoint,
  sessionId: string
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/api/session/${encodeURIComponent(sessionId)}`,
      {
        headers: { authorization: endpoint.authHeader },
        signal: AbortSignal.timeout(5_000)
      }
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { location?: { directory?: unknown } } }
    const directory = body.data?.location?.directory
    return typeof directory === 'string' && directory ? directory : undefined
  } catch {
    return undefined
  }
}

/** The real readiness wait: HTTP against the server, scoped to `directory`. */
const defaultWaitReady: WaitReadyFn = (endpoint, directory, pluginExpected) =>
  waitForHostedTools(
    { pluginExpected },
    {
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
  )

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
  /** Override how a server is ended (default: stdin EOF, then tree kill). */
  endServerFn?: (child: ChildProcess) => void
  /** The servers' process cwd (requests carry their own directory). Default: home. */
  serverCwd?: string
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
   * opencode has no cross-process lock on its database (ADR-093 §6), and a
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
  private readonly endServerFn: (child: ChildProcess) => void
  private readonly serverCwd: string
  /**
   * Cross-engine dispatch (ADR-033 M2) dependencies, threaded in from OUTSIDE
   * this module (core-services.ts, at boot) — importing `sessionManager` or
   * `crossEngineDispatcher` here would form a require-cycle (see
   * opencode-hosted-tools.ts). Read live on every call.
   */
  private callerSessionLookup: CallerSessionLookup = () => undefined
  private dispatchAgentFn: DispatchAgentFn | undefined
  /** S6 seam: `agents.<name>.permissions` per cwd. Nothing is injected until S6. */
  private agentPermissionsFn: (
    cwd: string,
    mcpServers: readonly string[]
  ) => AgentPermissionOverlay = () => ({})

  constructor(opts: OpencodeServerManagerOptions = {}) {
    this.spawnFn = opts.spawnFn ?? ((launch, options) => spawnStdioServer(launch, options))
    this.locateBinaryFn = opts.locateBinaryFn ?? locateLaunch
    this.startMcpHostFn = opts.startMcpHostFn ?? startMcpHttpHost
    this.configInputFn = opts.configInputFn ?? ((cwd) => this.defaultConfigInput(cwd))
    this.waitReadyFn = opts.waitReadyFn ?? defaultWaitReady
    this.endServerFn = opts.endServerFn ?? ((child) => void endStdioServer(child))
    this.serverCwd = opts.serverCwd ?? homedir()
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
   * S6 seam (ADR-093 §3): per-agent permission rules injected as
   * `agents.<name>.permissions`. A changed answer changes the config identity,
   * so it reaches new leases on a new server.
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
      return endpoint ? fetchSessionDirectory(endpoint, sessionId) : undefined
    }
    const mcpHost = await this.startMcpHostFn(() =>
      createOpencodeHostedToolsServer(resolveCwd, {
        lookupCallerSession: (sessionId) => this.callerSessionLookup(sessionId),
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
      readiness: new Map()
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
    return handle
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
   */
  async acquire(
    cwd: string,
    options: { waitForHostedTools?: boolean } = {}
  ): Promise<ServerConnection> {
    const directory = resolvePath(cwd)
    const input = this.configInputFn(directory)
    const key = configIdentity(input)
    const handle = await this.resolveHandle(key, input)
    handle.refCount++
    handle.cwdRefs.set(directory, (handle.cwdRefs.get(directory) ?? 0) + 1)
    const hostedTools: HostedToolsReadiness =
      options.waitForHostedTools === false
        ? { state: 'skipped' }
        : await this.readinessFor(handle, directory)
    if (this.handles.get(key) !== handle) {
      // It died (or was recycled) while we waited: hand out nothing dead.
      handle.refCount--
      this.decrementCwd(handle, directory)
      throw new Error(`opencode server ${handle.baseUrl} went away while starting`)
    }
    return this.connectionOf(handle, directory, hostedTools)
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
   * A server for `cwd` of its OWN — never the pooled one, never shared — that
   * lives until its `release()`. For reads that must answer from the opencode
   * ClaudeUI runs NOW (model discovery). Spawned from the resolver's current
   * answer and reaped by dispose(). No readiness wait (`hostedTools: skipped`).
   */
  async acquireDetached(cwd: string): Promise<DetachedServer> {
    const directory = resolvePath(cwd)
    const input = this.configInputFn(directory)
    const handle = await this.startServer(configIdentity(input), input)
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
    this.releaseHandle(handle, directory)
  }

  private decrementCwd(handle: ServerHandle, directory: string): void {
    const left = (handle.cwdRefs.get(directory) ?? 0) - 1
    if (left > 0) handle.cwdRefs.set(directory, left)
    else handle.cwdRefs.delete(directory)
  }

  private releaseHandle(handle: ServerHandle, directory: string): void {
    handle.refCount--
    this.decrementCwd(handle, directory)
    if (handle.refCount > 0) return
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
   * S7 removes the callers — ADR-093 §5.) Deletion precedes the end so a racing
   * acquire starts fresh and the exit handler stays quiet. In-flight starts
   * are left alone.
   */
  recycleAll(): void {
    for (const [key, handle] of [...this.handles]) {
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
