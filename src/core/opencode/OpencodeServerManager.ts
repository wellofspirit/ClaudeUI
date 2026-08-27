import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
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
import { killProcessTree } from '../services/process-tree'
// OpencodeConfigSettings import removed — engine-native config now lives in
// opencode's own file (opencode-config.ts). Only the MCP block is ephemeral.

/** Connection details handed back to callers (and to OpencodeClient). */
export interface ServerConnection {
  baseUrl: string
  password: string
  /** Pre-computed Authorization header value for HTTP Basic auth */
  authHeader: string
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
  binary: string,
  cwd: string,
  password: string,
  mcpPort: number,
  mcpToken: string
) => Promise<SpawnResult>

const PORT_PATTERN = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/

const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'

function locateBinary(): string {
  // Mirror the claude-cli locator (src/main/sdk/locate.ts): resolve via
  // app.getAppPath() — `__dirname` points at the bundled out/main in built/dev
  // Electron, so it can't find <projectRoot>/vendor. Outside Electron (smoke
  // scripts, integration tests) no host paths are wired → `getAppPath()` falls
  // back to cwd, which is the project root in those contexts.
  const appPath = getAppPath()

  if (!appPath.includes('app.asar')) {
    // Dev/built — appPath is the project root.
    const vendor = join(appPath, 'vendor', 'opencode-cli', BINARY_NAME)
    if (existsSync(vendor)) return vendor

    // Dev fallback: the pre-existing probe binary.
    const probe = join(appPath, '.cache', 'opencode-probe', 'package', 'bin', BINARY_NAME)
    if (existsSync(probe)) return probe

    throw new Error(
      `opencode binary not found at ${vendor}. Run \`bun run ensure-opencode\` to vendor it.`
    )
  }

  // Production — extraResources copies vendor/opencode-cli → <Resources>/opencode-cli.
  // dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    join(dirname(appPath), 'opencode-cli', BINARY_NAME),
    join(appPath.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'opencode-cli', BINARY_NAME)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Return the primary candidate; the caller surfaces the missing-file error.
  return candidates[0]
}

/** ~20 minutes — must exceed the dispatcher's 10-min DISPATCH_TIMEOUT_MS so a
 *  long-running Claude target never gets cut off by opencode's OWN per-server
 *  MCP callTool timeout (config default 5s — see
 *  src/shared/opencode-config-schema.1.18.23.json `McpRemoteConfig.timeout`,
 *  read by `requestTimeout()` in vendor/opencode-src/packages/opencode/src/mcp/index.ts:661-663).
 *  The dispatcher's own heartbeat (sendProgress) ALSO resets this — belt and
 *  suspenders, since opencode may not always ride a progressToken. */
const DISPATCH_MCP_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Locate the caller-identity plugin (ADR-033 M2) that must be loaded by the
 * EXTERNAL opencode process — mirrors locateBinary()'s dev/packaged split.
 * The file lives under `resources/opencode/` (not `vendor/opencode-cli/`
 * like the binary): it ships via electron-builder's `asarUnpack: resources/**`
 * rather than `extraResources`, so the packaged path swaps `app.asar` →
 * `app.asar.unpacked` IN PLACE instead of moving to a new Resources subdir.
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
 */
export function buildOpencodeConfigContent(
  mcpPort: number,
  mcpToken: string,
  bridgedMcp?: Record<string, OpencodeMcpEntry>,
  pluginPath?: string | null
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
        // ADR-033 M2: a dispatched Claude target can run far longer than
        // opencode's 5s MCP-request default (McpRemoteConfig.timeout) — a
        // long dispatch would otherwise have its callTool cancelled out from
        // under it. See DISPATCH_MCP_TIMEOUT_MS doc comment above.
        timeout: DISPATCH_MCP_TIMEOUT_MS
      },
      ...(bridgedMcp ?? {})
    },
    // Keep permission rejections non-fatal (Claude parity: a deny is a tool
    // error the model responds to, not a turn-killer). Reject-with-message
    // (CorrectedError) already never breaks the loop; this flag covers the
    // CASCADE bare-rejects opencode issues to the session's OTHER pending
    // permissions on any reject, which carry no message. Ephemeral env-var
    // config only — never written to a user file (ADR-031).
    experimental: { continue_loop_on_deny: true },
    // The binary we spawn is the VENDORED FORK (ADR-037): a self-update would
    // replace it with an upstream build and silently drop every patch we carry.
    // Version is owned by `package.json#opencodeCliVersion` + ensure-opencode,
    // never by the running process. Ephemeral like the block above — a user
    // config file is never rewritten to say this (ADR-031).
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
  binary: string,
  cwd: string,
  password: string,
  mcpPort: number,
  mcpToken: string
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd,
      env: {
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
        // opencode-config.ts — not injected here.
        OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(
          mcpPort,
          mcpToken,
          collectClaudeMcpForOpencode(cwd),
          locatePluginFile()
        )
      },
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
  /** Override the binary locator. Defaults to the real on-disk resolver. */
  locateBinaryFn?: () => string
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
  /**
   * Set once dispose() runs. A spawn already in flight when dispose() is called
   * would otherwise re-insert its resolved handle into `handles` AFTER dispose()
   * cleared the map — an orphaned `opencode.exe` surviving app quit (there is no
   * Windows job object reaping it). The spawn checks this flag right before the
   * insert and self-terminates instead.
   */
  private disposed = false
  private binary: string | null = null
  private readonly spawnFn: SpawnServerFn
  private readonly locateBinaryFn: () => string
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
    this.locateBinaryFn = opts.locateBinaryFn ?? locateBinary
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

  private getBinary(): string {
    if (!this.binary) this.binary = this.locateBinaryFn()
    return this.binary
  }

  /**
   * Cheap, deterministic "is opencode installed?" check: does the binary resolve
   * to a file that exists on disk? This NEVER spawns a server, so a transient
   * spawn/HTTP failure can't masquerade as "not installed" (the regression that
   * gated the Settings opencode sections off a flaky probe). Auth/model state is
   * a separate, allowed-to-fail concern — not "installed".
   */
  isBinaryAvailable(): boolean {
    try {
      return existsSync(this.getBinary())
    } catch {
      // locateBinary throws in dev when the binary isn't vendored.
      return false
    }
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
      const password = randomBytes(24).toString('base64url')
      const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
      const binary = this.getBinary()

      // Start the per-cwd MCP host BEFORE spawning opencode so we have the
      // port + token to inject via OPENCODE_CONFIG_CONTENT.
      // Engine-native config (model, providers, agents) is read by opencode from
      // its own global config file (written by opencode-config.ts) — not injected here.
      // dispatch_agent registration here stays UNCONDITIONAL (unlike Claude's
      // claude-ui-collab, gated on crossEngineDispatchAvailable('claude')) —
      // ADR-030/ADR-033 M4-A: opencode's dispatch target is always Claude,
      // ClaudeUI's bundled default engine, which is always installed. There is
      // no "is the target engine present" question on this side to gate on.
      const mcpHost = await this.startMcpHostFn(
        createOpencodeHostedToolsServer(key, {
          lookupCallerSession: (sessionId) => this.callerSessionLookup(sessionId),
          dispatch: this.dispatchAgentFn && ((req, ctx) => this.dispatchAgentFn!(req, ctx))
        })
      )

      let child: ChildProcess
      let baseUrl: string
      try {
        const result = await this.spawnFn(binary, key, password, mcpHost.port, mcpHost.token)
        child = result.process
        baseUrl = result.baseUrl
      } catch (err) {
        // If spawn fails, tear down the MCP host we already started.
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
