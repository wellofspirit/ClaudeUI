import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'

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
  password: string
) => Promise<SpawnResult>

const PORT_PATTERN = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/

const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'

function locateBinary(): string {
  // Mirror the claude-cli locator (src/main/sdk/locate.ts): resolve via
  // app.getAppPath() — `__dirname` points at the bundled out/main in built/dev
  // Electron, so it can't find <projectRoot>/vendor. Outside Electron (smoke
  // scripts, integration tests) `app` is undefined → fall back to cwd, which is
  // the project root in those contexts.
  const appPath = app?.getAppPath ? app.getAppPath() : process.cwd()

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

/**
 * Spawn `opencode serve` and resolve once it prints the listening port to stdout.
 * Rejects on spawn error, early exit, or a 15s timeout.
 */
function spawnServer(binary: string, cwd: string, password: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill()
        reject(new Error(`opencode serve did not print port within 15s (cwd: ${cwd})`))
      }
    }, 15_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const m = PORT_PATTERN.exec(stdout)
      if (m && !resolved) {
        resolved = true
        clearTimeout(timeout)
        const port = parseInt(m[1], 10)
        resolve({ process: child, baseUrl: `http://127.0.0.1:${port}` })
      }
    })

    child.stderr?.on('data', (_chunk: Buffer) => {
      // stderr carries warnings (e.g. about an unset password) — ignore
    })

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error(`Failed to spawn opencode: ${err.message}`))
      }
    })

    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error(`opencode exited before printing port (code=${code}, signal=${signal})`))
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
  private binary: string | null = null
  private readonly spawnFn: SpawnServerFn
  private readonly locateBinaryFn: () => string

  constructor(opts: OpencodeServerManagerOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawnServer
    this.locateBinaryFn = opts.locateBinaryFn ?? locateBinary
  }

  private getBinary(): string {
    if (!this.binary) this.binary = this.locateBinaryFn()
    return this.binary
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
      const { process: child, baseUrl } = await this.spawnFn(binary, key, password)

      const handle: ServerHandle = {
        baseUrl,
        password,
        authHeader,
        refCount: 0,
        process: child,
      }
      this.handles.set(key, handle)

      // If the server dies unexpectedly (crash, external kill), drop the handle
      // so the next acquire re-spawns instead of handing out a dead server.
      child.on('exit', () => {
        if (this.handles.get(key) === handle) {
          this.handles.delete(key)
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
   * process is killed and the handle dropped.
   */
  release(cwd: string): void {
    const key = resolvePath(cwd)
    const handle = this.handles.get(key)
    if (!handle) return

    handle.refCount--
    if (handle.refCount <= 0) {
      this.handles.delete(key)
      this.killProcess(handle.process)
    }
  }

  /** Kill all servers — call on app shutdown. */
  dispose(): void {
    for (const handle of this.handles.values()) {
      this.killProcess(handle.process)
    }
    this.handles.clear()
    this.pending.clear()
  }

  private killProcess(child: ChildProcess): void {
    if (process.platform === 'win32' && child.pid != null) {
      // SIGTERM on Windows only kills the parent; taskkill /T /F reaps the whole tree.
      // We still call child.kill() so the in-process 'exit' event fires (needed for
      // the handle-drop listener wired in resolveHandle).
      child.kill()
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }

  /** For testing: the count of live (resolved) servers. */
  get activeCount(): number {
    return this.handles.size
  }
}

export const opencodeServerManager = new OpencodeServerManager()
