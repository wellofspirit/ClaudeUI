import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { getAppPath } from '../host'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpHttpHost } from './mcp-http-host'
import { startMcpHttpHost } from './mcp-http-host'
import { createOpencodeHostedToolsServer } from './opencode-hosted-tools'
import type { CallerSessionLookup, DispatchAgentFn } from './opencode-hosted-tools'
import type { OpencodeMcpEntry } from './claude-mcp-bridge'
import { collectClaudeMcpForOpencode } from './claude-mcp-bridge'
import { subagentPermissionConfigFor } from './subagent-permissions'
import type { SubagentPermissionConfig } from './subagent-permissions'
import { killProcessTree } from '../services/process-tree'
import { harnessAvailable, harnessUnavailableMessage, resolveHarness } from '../harness/resolve'
import { toLaunch, withLaunch, type HarnessLaunch } from '../harness/launch'
// OpencodeConfigSettings import removed — engine-native config now lives in
// opencode's own file (opencode-config.ts). Only the MCP block is ephemeral.

/** Connection details handed back to callers (and to OpencodeClient). */
export interface ServerConnection {
  baseUrl: string
  password: string
  /** Pre-computed Authorization header value for HTTP Basic auth */
  authHeader: string
}

/** A server of the caller's own (`acquireDetached`): `release()` kills it, once. */
export interface DetachedServer extends ServerConnection {
  release: () => void
}

export interface ServerHandle extends ServerConnection {
  refCount: number
  process: ChildProcess
  mcpHost: McpHttpHost
  /**
   * Callbacks fired when THIS spawn goes away and attached sessions must drop
   * their connection (see subscribeExit): an unexpected death, or a deliberate
   * recycleAll(). NOT fired on release()/dispose(), which drop the handle (and
   * clear this set) before killing — the exit handler is identity-gated.
   */
  exitListeners: Set<() => void>
}

/**
 * Result of spawning a server: the child process and the parsed base URL.
 * Injectable so the manager's lifecycle (ref-counting, concurrency, teardown)
 * can be unit-tested with a fake spawn — no real binary needed.
 */
export interface SpawnResult {
  process: ChildProcess
  baseUrl: string
}

export type SpawnServerFn = (
  launch: HarnessLaunch,
  cwd: string,
  password: string,
  mcpPort: number,
  mcpToken: string
) => Promise<SpawnResult>

const PORT_PATTERN = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/

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
 * ~20 minutes on opencode's OWN per-server MCP callTool timeout (config default
 * 5 s — see src/shared/opencode-config-schema.1.18.29.json
 * `McpRemoteConfig.timeout`, read by `requestTimeout()` in
 * vendor/opencode-src/packages/opencode/src/mcp/index.ts:661-663), so a
 * long-running dispatch into another engine is never cut off from the CALLER's
 * end.
 *
 * It is an IDLE cap, not an absolute one: `McpCatalog.convertTool` passes
 * `resetTimeoutOnProgress: true` plus an `onprogress` hook (which is what makes
 * the MCP SDK attach a progress token at all) and NO `maxTotalTimeout`, the
 * SDK's only absolute ceiling — so the dispatcher's 15 s `sendProgress`
 * heartbeat keeps resetting it for as long as the dispatched turn runs. That
 * is what lets ADR-033's 2026-09-18 amendment ("a dispatched agent runs until
 * the user's limit, and an unset limit means none") hold with opencode as the
 * caller. Orders of magnitude above the heartbeat interval, so a slow heartbeat
 * round-trip can never trip it either.
 */
const DISPATCH_MCP_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Locate the caller-identity plugin (ADR-033 M2) that must be loaded by the
 * EXTERNAL opencode process — the same dev/packaged split as the bundled
 * Claude Code (`../harness/resolve.ts`), although the opencode binary itself
 * comes from ClaudeUI's harness store or a System install (ADR-082 §8).
 * The file lives under `resources/opencode/`: it ships via electron-builder's
 * `asarUnpack: resources/**` rather than `extraResources`, so the packaged
 * path swaps `app.asar` → `app.asar.unpacked` IN PLACE instead of moving to a
 * new Resources subdir.
 * Returns null (never throws) when the file isn't found — the plugin is a
 * best-effort feature; its absence just means `dispatch_agent` (opencode →
 * Claude direction) fails loud with a clear message (see
 * opencode-hosted-tools.ts's missing-caller-identity branch) instead of
 * opencode itself refusing to start.
 */
function locatePluginFile(): string | null {
  const appPath = getAppPath()
  const rel = ['resources', 'opencode', 'claudeui-xeng-plugin.ts']
  const candidate = appPath.includes('app.asar')
    ? join(appPath.replace('app.asar', 'app.asar.unpacked'), ...rel)
    : join(appPath, ...rel)
  return existsSync(candidate) ? candidate : null
}

/**
 * Build the OPENCODE_CONFIG_CONTENT JSON string that wires opencode's MCP
 * client to our per-cwd in-process HTTP host, and optionally injects user-set
 * opencode config fields (model, providers, agents, etc.).
 *
 * opencode parses this env var as JSON and merges it into its config, so
 * the `mcp` key is treated identically to mcp entries in opencode.json.
 * The `claudeui` server name drives tool-name prefixing in opencode:
 *   claudeui_render_mermaid, claudeui_create_mockup, claudeui_show_mockup.
 *
 * The model/provider/agent/disabled fields are now written to opencode's OWN
 * config file by opencode-config.ts. This function emits ONLY the mcp.claudeui
 * block so the per-cwd MCP host is wired up at spawn time.
 *
 * API keys are NEVER injected — credentials stay in auth.json.
 *
 * `agentPermissions` (ADR-085 S4, owner ruling 4) — when present and
 * non-empty, emitted as the `agent` block: STRING `ask`s per task-able agent
 * (`agent.<name>.permission.<category> = "ask"`, built by
 * `subagent-permissions.ts` `buildSubagentPermissionConfig`), so a task
 * child's bash/edit/webfetch/MCP call raises `permission.asked` instead of
 * being answered by the agent's own `{*: allow}` (or `explore`'s own
 * `bash: allow`), and the HOST answers it with the parent's rules. Why this
 * shape: this env var merges LAST among the user's config sources
 * (`vendor/opencode-src/packages/opencode/src/config/config.ts:482-490`, after
 * the `.opencode` agent files) with `mergeDeep`, where a STRING value replaces
 * the file's value but an object would merge key-wise and keep a file's more
 * specific allow pattern (research probe, facts Q1). Per agent, never a
 * top-level `permission` key: the top-level config sits AFTER `explore`'s own
 * `{*: deny}` (`agent/agent.ts` ~196-218) and would turn its denies into asks.
 * The server is per cwd and shared by every session and dispatch target in
 * that folder, in every mode, so the asks are mode-less by design: the host
 * decides per parent mode (`host-precheck.ts` `parent-allow`).
 */
export function buildOpencodeConfigContent(
  mcpPort: number,
  mcpToken: string,
  bridgedMcp?: Record<string, OpencodeMcpEntry>,
  pluginPath?: string | null,
  agentPermissions?: SubagentPermissionConfig
): string {
  const config: Record<string, unknown> = {
    mcp: {
      claudeui: {
        type: 'remote',
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        headers: {
          Authorization: `Bearer ${mcpToken}`
        },
        enabled: true,
        // ADR-033 M2: a dispatched target can run far longer than opencode's
        // 5s MCP-request default (McpRemoteConfig.timeout) — a long dispatch
        // would otherwise have its callTool cancelled out from under it. Idle,
        // not absolute: see DISPATCH_MCP_TIMEOUT_MS's doc comment above.
        timeout: DISPATCH_MCP_TIMEOUT_MS
      },
      ...(bridgedMcp ?? {})
    },
    // ADR-085 S4 — per-agent string asks for task subagents (see the doc
    // comment above). Absent/empty → the key is not emitted at all.
    ...(agentPermissions && Object.keys(agentPermissions).length > 0
      ? { agent: agentPermissions }
      : {}),
    // Keep permission rejections non-fatal (Claude parity: a deny is a tool
    // error the model responds to, not a turn-killer). Reject-with-message
    // (CorrectedError) already never breaks the loop; this flag covers the
    // CASCADE bare-rejects opencode issues to the session's OTHER pending
    // permissions on any reject, which carry no message. Ephemeral env-var
    // config only — never written to a user file (ADR-031).
    experimental: { continue_loop_on_deny: true },
    // The binary we spawn is a digest-checked upstream release from ClaudeUI's
    // harness store (ADR-081 §7, ADR-082 §4), or a System install ClaudeUI
    // never updates: a ClaudeUI-spawned server must not replace it under a
    // running session. Version is owned by
    // `src/shared/harness-manifests/opencode.json` (ADR-082), never
    // by the running process. Ephemeral like the block above — a user config
    // file is never rewritten to say this (ADR-031).
    autoupdate: false,
    // ADR-033 M2: the caller-identity plugin, loaded ONLY when vendored (dev
    // and packaged builds both resolve it via locatePluginFile()). Absent in
    // any context where the file isn't found — opencode itself never fails
    // to start over this; the dispatch tool just fails loud instead (see
    // opencode-hosted-tools.ts).
    ...(pluginPath ? { plugin: [pluginPath] } : {})
  }

  return JSON.stringify(config)
}

/**
 * Spawn `opencode serve` and resolve once it prints the listening port to stdout.
 * Rejects on spawn error, early exit, or a 15s timeout.
 */
function spawnServer(
  launch: HarnessLaunch,
  cwd: string,
  password: string,
  mcpPort: number,
  mcpToken: string
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Bridged Claude MCP servers — computed once: the config block below, and
    // the MCP keys the subagent asks name (ADR-085 S4).
    const bridged = collectClaudeMcpForOpencode(cwd)
    const spec = withLaunch(launch, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      // Hard kill switch for opencode's cloud share (share-next.ts reads
      // OPENCODE_DISABLE_SHARE once at module load and short-circuits every
      // create/sync/remove path). The config-level `share` key is NOT enough:
      // it lives in opencode's own config file, which the user — or a project
      // file — can set back to "auto", and sharing uploads whole sessions
      // (messages, file diffs) to opencode's servers. An env var on the child
      // we spawn cannot be overridden from a config file.
      OPENCODE_DISABLE_SHARE: '1',
      // Inject the per-cwd in-process MCP server so opencode connects to it
      // without requiring any global plugin installation. Bridged Claude MCP
      // servers are also injected here so secrets (env/headers) never touch
      // opencode's on-disk config. Engine-native settings (model, providers,
      // agents) are now written to opencode's own config file by
      // opencode-config.ts — not injected here. The one agent field that IS
      // injected is ADR-085 S4's per-subagent permission asks (ephemeral,
      // never written to a user file — ADR-031).
      OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(
        mcpPort,
        mcpToken,
        bridged,
        locatePluginFile(),
        subagentPermissionConfigFor(cwd, Object.keys(bridged))
      )
    })
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let resolved = false

    // opencode prints startup diagnostics (config-parse errors, MCP connect
    // failures, etc.) to stderr before exiting non-zero. Capture it so an
    // exit-before-port / timeout error is DIAGNOSABLE instead of a bare code=1.
    const stderrTail = (): string => {
      const t = stderr.trim()
      return t ? ` — stderr: ${t.slice(-600)}` : ''
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill()
        reject(
          new Error(`opencode serve did not print port within 15s (cwd: ${cwd})${stderrTail()}`)
        )
      }
    }, 15_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      // Once the port is parsed the buffers are never read again (all reject
      // paths gate on `!resolved`). Keep the listener attached so the pipe
      // still drains — but stop appending, or `stdout` grows unbounded for the
      // whole server lifetime as opencode keeps logging (a slow main-process
      // leak). Same for stderr below.
      if (resolved) return
      stdout += chunk.toString()
      const m = PORT_PATTERN.exec(stdout)
      if (m) {
        resolved = true
        clearTimeout(timeout)
        const port = parseInt(m[1], 10)
        resolve({ process: child, baseUrl: `http://127.0.0.1:${port}` })
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      // Warnings (e.g. unset password) AND fatal startup errors land here. We
      // accumulate rather than ignore so the reject paths can surface the cause.
      // After resolve, stderr is never read again — stop accumulating so it
      // doesn't grow unbounded (see the stdout note above).
      if (resolved) return
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error(`Failed to spawn opencode: ${err.message}${stderrTail()}`))
      }
    })

    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(
          new Error(
            `opencode exited before printing port (code=${code}, signal=${signal})${stderrTail()}`
          )
        )
      }
    })
  })
}

export interface OpencodeServerManagerOptions {
  /**
   * Override the spawn implementation. Defaults to the real `opencode serve`
   * spawn. Tests inject a fake to exercise the lifecycle without a binary.
   */
  spawnFn?: SpawnServerFn
  /**
   * Override the launch locator. Defaults to the harness resolver; called on
   * every spawn, so an install or a selection change reaches the next server.
   * A bare path is a native launch (`toLaunch`).
   */
  locateBinaryFn?: () => string | HarnessLaunch
  /**
   * Override the MCP host starter. Defaults to startMcpHttpHost + the real
   * createOpencodeHostedToolsServer. Tests inject a fake to avoid binding real
   * ports.
   */
  startMcpHostFn?: (mcpServer: McpServer) => Promise<McpHttpHost>
}

/**
 * Shared, ref-counted `opencode serve` per normalized cwd. All sessions in the
 * same folder multiplex one server. This is the lifecycle contract Phase 5b's
 * OpencodeSession builds on: acquire on attach, release on dispose, last-out kills.
 */
export class OpencodeServerManager {
  private handles = new Map<string, ServerHandle>()
  /**
   * In-flight spawns, keyed by normalized cwd. Set SYNCHRONOUSLY before the
   * spawn await so concurrent `acquire(sameCwd)` calls await a single spawn
   * instead of each launching a server (the race FIX 1 closes).
   */
  private pending = new Map<string, Promise<ServerHandle>>()
  /** Servers handed out by acquireDetached() and not yet released. */
  private detached = new Set<ServerHandle>()
  /**
   * The last `opencode serve` start, until it printed its port (or failed).
   * Starts take turns: opencode migrates its ONE database at startup, and two
   * processes migrating a database that needs it — a fresh one, or the first
   * start after an update that adds a migration — race, and the loser exits
   * ("Failed query: CREATE TABLE …", verified against 1.18.34). Concurrent
   * starts are common: a discovery server beside a session's, two projects.
   * A server that is up has migrated, so only the start waits, never a request.
   */
  private startTurn: Promise<unknown> = Promise.resolve()
  /**
   * Set once dispose() runs. A spawn already in flight when dispose() is called
   * would otherwise re-insert its resolved handle into `handles` AFTER dispose()
   * cleared the map — an orphaned `opencode.exe` surviving app quit (there is no
   * Windows job object reaping it). The spawn checks this flag right before the
   * insert and self-terminates instead.
   */
  private disposed = false
  private readonly spawnFn: SpawnServerFn
  private readonly locateBinaryFn: () => string | HarnessLaunch
  private readonly startMcpHostFn: (mcpServer: McpServer) => Promise<McpHttpHost>
  /**
   * Cross-engine dispatch (ADR-033 M2) dependencies, threaded in from OUTSIDE
   * this module (main/index.ts, at app bootstrap) rather than imported
   * directly — importing `sessionManager` or `crossEngineDispatcher` here
   * would form a require-cycle (see the cycle note on CallerSessionLookup in
   * opencode-hosted-tools.ts). Bound via setter so callers set once, read
   * live on every server spawn (createOpencodeHostedToolsServer is only
   * invoked per-cwd-spawn, but the closures below always read the CURRENT
   * field value, not a stale one captured at construction time).
   */
  private callerSessionLookup: CallerSessionLookup = () => undefined
  private dispatchAgentFn: DispatchAgentFn | undefined

  constructor(opts: OpencodeServerManagerOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawnServer
    this.locateBinaryFn = opts.locateBinaryFn ?? locateLaunch
    this.startMcpHostFn = opts.startMcpHostFn ?? startMcpHttpHost
  }

  /** Wire the caller-session lookup used by the opencode-hosted `dispatch_agent`
   *  tool (ADR-033 M2). Call once at app bootstrap. */
  setCallerSessionLookup(fn: CallerSessionLookup): void {
    this.callerSessionLookup = fn
  }

  /** Wire the cross-engine dispatch function used by the opencode-hosted
   *  `dispatch_agent` tool (ADR-033 M2). Call once at app bootstrap. */
  setDispatchAgent(fn: DispatchAgentFn): void {
    this.dispatchAgentFn = fn
  }

  /**
   * Resolved per spawn, never memoised here: the resolver caches, and its
   * `invalidateHarness` is how a new install reaches the next server.
   */
  private getLaunch(): HarnessLaunch {
    return toLaunch(this.locateBinaryFn())
  }

  /**
   * Cheap, deterministic "is opencode installed?" check (the harness resolver's
   * answer). This NEVER spawns a server, so a transient spawn/HTTP failure can't
   * masquerade as "not installed" (the regression that gated the Settings
   * opencode sections off a flaky probe). Auth/model state is a separate,
   * allowed-to-fail concern — not "installed".
   */
  isBinaryAvailable(): boolean {
    return harnessAvailable('opencode')
  }

  /**
   * Resolve (or spawn) the server for `cwd` and return a handle whose refCount
   * has NOT yet been incremented. Concurrent callers share a single spawn via
   * the `pending` map.
   */
  private async resolveHandle(key: string): Promise<ServerHandle> {
    const existing = this.handles.get(key)
    if (existing) return existing

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const spawnPromise = (async (): Promise<ServerHandle> => {
      const handle = await this.startServer(key)
      const child = handle.process
      const mcpHost = handle.mcpHost

      this.handles.set(key, handle)

      // If the server dies unexpectedly (crash, external kill), drop the handle
      // and close the MCP host so the next acquire re-spawns instead of handing
      // out a dead server.
      child.on('exit', () => {
        if (this.handles.get(key) === handle) {
          this.handles.delete(key)
          mcpHost.close().catch(() => {})
          // Reaching this identity gate means the death was UNEXPECTED: every
          // deliberate kill path (release() at refCount 0, dispose()) removes
          // the handle from the map first. Fan out so each attached session can
          // drop its now-dangling connection instead of holding a green dot on
          // a dead server. Drain first — a listener must not see itself again.
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
      })

      return handle
    })()

    this.pending.set(key, spawnPromise)
    try {
      return await spawnPromise
    } catch (err) {
      // Spawn failed — clear the pending entry so a later acquire can retry.
      if (this.pending.get(key) === spawnPromise) {
        this.pending.delete(key)
      }
      throw err
    } finally {
      // On success, clear the pending entry once resolved; the handle now lives
      // in `handles`. (On failure the catch already cleared it; double-delete is
      // a no-op.)
      if (this.pending.get(key) === spawnPromise) {
        this.pending.delete(key)
      }
    }
  }

  /**
   * Spawn one server for `key` with its MCP host — registered NOWHERE: the
   * caller owns it (the pool's `handles`, or a detached lease). Reaps what it
   * started, and rejects, when dispose() ran meanwhile.
   */
  private async startServer(key: string): Promise<ServerHandle> {
    // Shut down: start nothing, not even the MCP host.
    if (this.disposed) throw new Error('OpencodeServerManager disposed')
    const password = randomBytes(24).toString('base64url')
    const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
    // Fail fast — before an MCP host — when opencode cannot run at all. The
    // launch actually spawned is resolved again when this start's turn comes.
    this.getLaunch()

    // Start the per-cwd MCP host BEFORE spawning opencode so we have the
    // port + token to inject via OPENCODE_CONFIG_CONTENT.
    // Engine-native config (model, providers, agents) is read by opencode from
    // its own global config file (written by opencode-config.ts) — not injected here.
    // dispatch_agent registration here stays UNCONDITIONAL (unlike Claude's
    // claude-ui-collab, gated on crossEngineDispatchAvailable('claude')): the
    // server is per-cwd and outlives any one harness change (ADR-082), so the
    // honest per-session answer is the session's `crossEngineDispatch`
    // capability, and a dispatch into a harness that is gone is refused by
    // the dispatcher's own per-request guards.
    const mcpHost = await this.startMcpHostFn(
      createOpencodeHostedToolsServer(key, {
        lookupCallerSession: (sessionId) => this.callerSessionLookup(sessionId),
        dispatch: this.dispatchAgentFn && ((req, ctx) => this.dispatchAgentFn!(req, ctx))
      })
    )

    let child: ChildProcess
    let baseUrl: string
    try {
      const turn = this.startTurn.then(() => {
        // A start queued behind others: shutdown may have come meanwhile, so
        // look again right before spawning — never spawn after dispose(). And
        // resolve the launch NOW: an install or selection change made while
        // this waited is what the next server should run.
        if (this.disposed) throw new Error('OpencodeServerManager disposed before spawn')
        return this.spawnFn(this.getLaunch(), key, password, mcpHost.port, mcpHost.token)
      })
      this.startTurn = turn.catch(() => {})
      const result = await turn
      child = result.process
      baseUrl = result.baseUrl
    } catch (err) {
      // If spawn fails (or never ran), tear down the MCP host we already started.
      await mcpHost.close().catch(() => {})
      throw err
    }

    const handle: ServerHandle = {
      baseUrl,
      password,
      authHeader,
      refCount: 0,
      process: child,
      mcpHost,
      exitListeners: new Set()
    }

    // dispose() ran while this spawn was in flight: do NOT register the handle
    // (it would leak past app quit — see `disposed`). Reap what we just spawned
    // and reject so the pending entry is cleared like any other spawn failure.
    if (this.disposed) {
      this.killProcess(child)
      await mcpHost.close().catch(() => {})
      throw new Error('OpencodeServerManager disposed during spawn')
    }

    return handle
  }

  /**
   * Acquire a server for `cwd`. Spawns one if none exists (or joins an in-flight
   * spawn), else reuses the existing one. Increments the refcount. Pair every
   * `acquire` with exactly one `release`.
   */
  async acquire(cwd: string): Promise<ServerConnection> {
    const key = resolvePath(cwd)
    const handle = await this.resolveHandle(key)
    handle.refCount++
    return { baseUrl: handle.baseUrl, password: handle.password, authHeader: handle.authHeader }
  }

  /**
   * A server for `cwd` of its OWN — never the pooled one, never shared — that
   * lives until its `release()`. For reads that must answer from the opencode
   * ClaudeUI runs NOW: a pooled server is started once and kept for as long as
   * anyone holds `cwd` (an OAuth hold, a reconciler pass, a throwaway agent
   * turn), so after a harness install or selection change it can still be the
   * previous binary, with the provider map that binary built at startup.
   *
   * Spawned from the resolver's current answer, like every pooled spawn, and
   * reaped by dispose(). Releasing it touches nothing a session holds.
   */
  async acquireDetached(cwd: string): Promise<DetachedServer> {
    const handle = await this.startServer(resolvePath(cwd))
    this.detached.add(handle)
    handle.process.on('exit', () => {
      if (this.detached.delete(handle)) handle.mcpHost.close().catch(() => {})
    })
    return {
      baseUrl: handle.baseUrl,
      password: handle.password,
      authHeader: handle.authHeader,
      release: () => {
        if (!this.detached.delete(handle)) return
        this.killProcess(handle.process)
        handle.mcpHost.close().catch(() => {})
      }
    }
  }

  /**
   * Release a previously-acquired server. Decrements the refcount; at 0 the
   * process is killed, the MCP host is closed, and the handle is dropped.
   */
  release(cwd: string): void {
    const key = resolvePath(cwd)
    const handle = this.handles.get(key)
    if (!handle) return
    this.releaseHandle(key, handle)
  }

  /**
   * Release a ref ONLY if the stored handle is still the very spawn `conn` came
   * from. `password` is fresh random bytes per spawn, so baseUrl+password is a
   * unique spawn identity.
   *
   * This is the safe release for a connection-loss path: a plain release(cwd)
   * looks the cwd up by key alone, so if our server died and another session
   * has since acquired a NEW one for the same cwd, it would decrement the new
   * handle's refcount and can kill a server other sessions are still using.
   * No-op when the handle is absent (already dropped on death) or mismatched.
   */
  releaseIfCurrent(cwd: string, conn: ServerConnection): void {
    const key = resolvePath(cwd)
    const handle = this.handles.get(key)
    if (!handle) return
    if (handle.baseUrl !== conn.baseUrl || handle.password !== conn.password) return
    this.releaseHandle(key, handle)
  }

  private releaseHandle(key: string, handle: ServerHandle): void {
    handle.refCount--
    if (handle.refCount <= 0) {
      // Drop the handle BEFORE killing: the child's 'exit' handler is gated on
      // handle identity, so this is what marks the death as deliberate and
      // suppresses the subscribeExit fan-out.
      this.handles.delete(key)
      handle.exitListeners.clear()
      this.killProcess(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
  }

  /**
   * Subscribe to the loss of the server currently serving `cwd` — an unexpected
   * death, or a deliberate recycleAll() (see that method).
   * Returns an unsubscribe bound to that exact handle, so a stale unsubscribe
   * held across a respawn can never remove a listener from the new handle.
   * A no-op unsubscribe is returned when no server is live for `cwd` — callers
   * subscribe right after acquire(), where one always is.
   */
  subscribeExit(cwd: string, cb: () => void): () => void {
    const handle = this.handles.get(resolvePath(cwd))
    if (!handle) return () => {}
    handle.exitListeners.add(cb)
    return () => {
      handle.exitListeners.delete(cb)
    }
  }

  /**
   * Tear down every pooled server so the next acquire spawns a fresh one.
   *
   * Why this exists: opencode builds its provider map ONCE per process (an
   * InstanceState in provider/provider.ts) and never watches auth.json. A
   * credential added or removed through Settings is therefore invisible to
   * every already-running server — prompts for that provider's models fail
   * with ProviderModelNotFoundError (the provider is absent from runtime
   * state; the "did you mean" suggestion comes from the static catalog) until
   * an app restart. Recycling is the only reload signal we have.
   *
   * Deletion precedes the kill, exactly as releaseHandle does: a racing
   * acquire() must spawn a FRESH server rather than get handed a dying handle,
   * and the child's 'exit' handler is identity-gated on `handles.get(key)`, so
   * removing the entry first suppresses its duplicate cleanup + fan-out. The
   * exit listeners ARE fanned out here (unlike release/dispose) so attached
   * sessions drop their connections now and lazily reconnect — their
   * markDisconnected → releaseIfCurrent no-ops against the already-removed
   * handle, so no refcount underflow and no second kill.
   *
   * In-flight spawns (`pending`) are deliberately left alone: a process that
   * hasn't started yet builds its provider state lazily on its first request,
   * which necessarily happens after the auth.json write that triggered us.
   */
  recycleAll(): void {
    for (const [key, handle] of [...this.handles]) {
      this.handles.delete(key)
      const listeners = [...handle.exitListeners]
      handle.exitListeners.clear()
      for (const cb of listeners) {
        try {
          cb()
        } catch {
          // One bad subscriber must never starve the others.
        }
      }
      this.killProcess(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
  }

  /** Kill all servers — call on app shutdown. */
  dispose(): void {
    // Set BEFORE reaping so any spawn still resolving self-terminates at its
    // pre-insert check instead of registering an orphan (see `disposed`).
    this.disposed = true
    for (const handle of this.handles.values()) {
      // App shutdown is deliberate — no session needs a disconnect fan-out.
      handle.exitListeners.clear()
      this.killProcess(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
    this.handles.clear()
    this.pending.clear()
    for (const handle of this.detached) {
      this.killProcess(handle.process)
      handle.mcpHost.close().catch(() => {})
    }
    this.detached.clear()
  }

  private killProcess(child: ChildProcess): void {
    // M-OC4: taskkill MUST reap the tree before child.kill() runs — see
    // killProcessTree. taskkill terminating the root still fires the 'exit'
    // event the handle-drop listener (resolveHandle) relies on.
    killProcessTree(child)
  }

  /** For testing: the count of live (resolved) servers. */
  get activeCount(): number {
    return this.handles.size
  }
}

export const opencodeServerManager = new OpencodeServerManager()
