/**
 * The remote IDE — the host's OWN VS Code CLI, run as `serve-web` and
 * reverse-proxied under `/vscode` (ADR-064).
 *
 * ## What lives here, and what does not
 *
 * This module owns the CHILD and the SESSION: detecting a usable CLI, spawning
 * `serve-web` on loopback with a per-spawn token, minting the one-time entry
 * tokens, holding the cookie sessions they exchange into, and reaping the child
 * when nobody is using it. What it deliberately does NOT own is the PROXY —
 * `remote-server.ts` pipes HTTP and upgrades, because the pre-route gates (funnel
 * refusal, Host allowlist, origin classification) live there and a second copy of
 * them would be a second door.
 *
 * The split is the same one `terminal-service.ts` makes: the service is the
 * policy + lifetime owner, the transport is the gate. `readIdePolicy` is the
 * fail-closed twin of `readTerminalPolicy`, and for the same reason — a DB hiccup
 * must leave the IDE OFF, never open and never fatal.
 *
 * ## Why nothing is bundled
 *
 * ADR-064 §1: the user installs and licenses VS Code themselves, we spawn what
 * they installed. That is what makes the Electron desktop and the headless
 * `claudeui-server` the SAME implementation — the standalone "VS Code CLI"
 * tarball is a single binary and `serve-web` needs no GUI — and it is why nothing
 * in this file resolves anything through `getAppPath()`: detection reads PATH and
 * platform well-knowns, both of which are correct on a headless box where the
 * app path is a bundle that does not exist.
 *
 * ## The one gate that is ours
 *
 * `serve-web`'s own `--connection-token` cannot be our admission secret: the
 * workbench JS needs it client-side (it arrives as a non-HttpOnly cookie), and —
 * probed live, VS Code 1.135.0 — **the WebSocket upgrade is not token-gated at
 * the HTTP layer at all**: an upgrade with zero credentials answers `101`. So
 * ours is the entry token → HttpOnly cookie session in this file, checked by the
 * proxy on every request AND every upgrade, and `serve-web`'s token stays what it
 * is upstream: a localhost defence-in-depth layer we hand only to browsers that
 * already passed our gate.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { appendAuditLog, getRemoteConfig } from './db'
import { logger } from './logger'
import { killProcessTree } from './process-tree'
import { safeHexEqual } from './remote-auth'
import { hostConnection, type CommandConnection } from '../ipc/command-registry'
import type { ConnectionOrigin } from './remote-server'
import type { IdeCliProbe, IdeEntry, IdeRuntimeState } from '../../shared/remote-protocol'

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** The host-side posture, read fresh so a Settings flip applies immediately. */
export interface IdePolicy {
  allowIde: boolean
  /** Operator-configured CLI path, or null to auto-detect. */
  cliPathOverride: string | null
}

/**
 * Read the persisted posture. Never throws: a DB hiccup must fail CLOSED (IDE
 * off) rather than take the app down or silently open an editor on the host.
 * Exactly `readTerminalPolicy`'s contract, one capability over.
 */
export function readIdePolicy(): IdePolicy {
  try {
    const config = getRemoteConfig()
    return {
      allowIde: config?.allowIde ?? false,
      cliPathOverride: config?.ideCliPath ?? null
    }
  } catch (err) {
    logger.warn(
      'vscode-web',
      `Could not read the remote-IDE policy (failing closed): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { allowIde: false, cliPathOverride: null }
  }
}

// ---------------------------------------------------------------------------
// Origin policy — THE widening point (ADR-064 §3)
// ---------------------------------------------------------------------------

/**
 * The origins a remote IDE may be handed out on. **This const is the whole
 * decision**, and it is deliberately the only thing a future widening edits.
 *
 * The IDE's traffic is ordinary browser fetch/WS: it cannot ride the E2E
 * envelope (that layer is our own client's JS encrypting frame payloads, a
 * service worker cannot intercept WebSockets, and VS Code owns its SW scope
 * regardless). So serving it over the quick tunnel would hand source and shell
 * traffic to Cloudflare's edge in plaintext — the exact exposure ADR-039 refused
 * — and plain-HTTP LAN cannot even boot the workbench, which needs a secure
 * context for its service worker.
 *
 * `tailnet-serve` is the recommended origin (serve terminates TLS end to end);
 * `localhost` is development and the host's own browser. Widening later is
 * editing this array plus an ADR amendment recording the ruling — no plumbing
 * moves, because every consumer asks {@link ideOriginPolicy} rather than testing
 * an origin itself.
 */
export const IDE_ALLOWED_ORIGINS = ['tailnet-serve', 'localhost'] as const

/** Typed verdict, so a refusal can be EXPLAINED rather than rendered as failure. */
export type IdeOriginVerdict = { allowed: true } | { allowed: false; reason: 'origin-not-allowed' }

/** May the IDE be handed out on this connection's origin? */
export function ideOriginPolicy(origin: ConnectionOrigin): IdeOriginVerdict {
  return (IDE_ALLOWED_ORIGINS as readonly string[]).includes(origin)
    ? { allowed: true }
    : { allowed: false, reason: 'origin-not-allowed' }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * One-time entry-token lifetime. Short by design: the token is minted by a
 * button press and spent by the navigation that press triggers, so a minute is
 * already generous, and anything longer is a live IDE capability sitting in a
 * URL somebody may have shared a screenshot of.
 */
const ENTRY_TOKEN_TTL_MS = 60_000

/** Bound on unspent entry tokens; the oldest is dropped past it. */
const MAX_PENDING_ENTRIES = 8

/**
 * Absolute cookie-session lifetime. Not an idle window: an IDE tab left open for
 * a day has been open for a day, and "still typing" is not a fresh presence
 * proof (ADR-054's read/act reasoning, applied to a surface with no per-act gate
 * at all).
 */
const SESSION_TTL_MS = 24 * 3_600_000

/** Bound on live cookie sessions; the oldest is evicted past it. */
const MAX_SESSIONS = 16

/** No live proxied socket and no `/vscode` request for this long ⇒ reap. */
const IDLE_REAP_MS = 30 * 60_000

/** How often the reaper looks. */
const REAP_INTERVAL_MS = 60_000

/** Budget for `<candidate> serve-web --help`. */
const PROBE_TIMEOUT_MS = 5_000

/** Budget for `serve-web` to print its port. Mirrors OpencodeServerManager. */
const SPAWN_TIMEOUT_MS = 15_000

/** Name of the cookie our gate rides. Never `vscode-tkn`, which is upstream's. */
export const IDE_COOKIE_NAME = 'claudeui-ide'

/** The base path every proxied route (workbench assets AND the remote WS) sits under. */
export const IDE_BASE_PATH = '/vscode'

/**
 * `Web UI available at http://127.0.0.1:39217/vscode?tkn=…` — the line
 * `serve-web` prints on STDOUT once its listener is up.
 *
 * Tolerant of the host part because `--host` is ours to choose and a future
 * change to it must not silently break port discovery; the PORT is the only
 * capture, and it is what everything downstream needs.
 */
const PORT_PATTERN = /Web UI available at\s+https?:\/\/[^\s/]+:(\d+)\//

// ---------------------------------------------------------------------------
// Small pure helpers (exported for the unit tests)
// ---------------------------------------------------------------------------

/**
 * Read one cookie value out of a raw `Cookie` header.
 *
 * Hand-rolled because there is no cookie code anywhere else in `src/` and one
 * lookup does not earn a dependency. Deliberately returns the FIRST match: a
 * client that sends the pair twice gets the first one judged, and the proxy
 * strips every copy before forwarding (see {@link stripIdeCookie}), so a second
 * value can neither be validated nor reach upstream.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * The `Cookie` header with every `claudeui-ide` pair removed, or undefined when
 * nothing is left.
 *
 * OUR cookie must never reach the VS Code server: it is the credential for our
 * gate, and forwarding it would put it in the logs and reach of a child process
 * that has no business holding it. Everything else passes through untouched —
 * including upstream's own `vscode-tkn`, which the workbench needs.
 */
export function stripIdeCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  const kept = header
    .split(';')
    .filter((part) => {
      const eq = part.indexOf('=')
      const key = (eq < 0 ? part : part.slice(0, eq)).trim()
      return key !== IDE_COOKIE_NAME
    })
    .map((p) => p.trim())
    .filter((p) => p !== '')
  return kept.length > 0 ? kept.join('; ') : undefined
}

/**
 * A host path as the workbench's `?folder=` wants it.
 *
 * The workbench parses this CLIENT-side out of the page URL (it is not embedded
 * in the served HTML), and it wants a POSIX-shaped path that KEEPS the Windows
 * drive colon: `D:\WorkPlace\ClaudeUI` → `/D:/WorkPlace/ClaudeUI`. The leading
 * slash is what makes it a URI path rather than a relative one.
 */
export function ideFolderParam(folder: string): string {
  const forward = folder.replace(/\\/g, '/')
  return /^[a-zA-Z]:\//.test(forward) ? `/${forward}` : forward
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Injected seams, so detection/spawn/reaping are testable without a real CLI. */
export interface VscodeWebServiceDeps {
  spawn?: typeof realSpawn
  platform?: () => NodeJS.Platform
  exists?: (candidate: string) => boolean
  env?: () => NodeJS.ProcessEnv
  now?: () => number
  killTree?: (child: ChildProcess) => void
}

interface PendingEntry {
  token: string
  expiresAt: number
  folder: string
}

export class VscodeWebService {
  private readonly deps: Required<VscodeWebServiceDeps>

  /** The `serve-web` child, or null while stopped/errored. */
  private child: ChildProcess | null = null
  private state: IdeRuntimeState = 'stopped'
  private port = 0
  /** `--connection-token` for THIS spawn; regenerated per child, never persisted. */
  private token = ''
  private lastError: string | null = null

  /** Single-flight for {@link ensureRunning}. */
  private startInFlight: Promise<{ port: number; token: string }> | null = null

  /** Cached detection, keyed on platform + override so a change invalidates it. */
  private probeCache: IdeCliProbe | null = null
  private probeCacheKey: string | null = null
  private probeInFlight: Promise<IdeCliProbe> | null = null

  /**
   * Unspent entry tokens. An ARRAY, not a Map, and that is the point: the lookup
   * iterates and compares with {@link safeHexEqual}, so a keyed `Map.get` on a
   * secret — which leaks a prefix-match timing signal — is not even expressible
   * here. Same reasoning as the server's `consumeEnrollToken`.
   */
  private entries: PendingEntry[] = []

  /** Live cookie sessions: `id → createdAt`. In memory, dying with the process. */
  private sessions = new Map<string, number>()

  /**
   * Sockets the proxy is currently piping. Held so `clearSessions` can actually
   * END a live IDE — clearing a cookie the browser already used would otherwise
   * leave an established WebSocket running for as long as the tab stayed open.
   */
  private sockets = new Set<Duplex>()

  /** Last `/vscode` request or socket event — the reaper's idle clock. */
  private lastActivityAt = 0

  private reapTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Identity for rows this service writes on its OWN behalf (reaper, shutdown,
   * unexpected child death). Set by `core-services` so a headless box attributes
   * to `server-console` rather than to a renderer it does not have.
   */
  private hostActor: CommandConnection | null = null

  constructor(deps: VscodeWebServiceDeps = {}) {
    this.deps = {
      spawn: deps.spawn ?? realSpawn,
      platform: deps.platform ?? (() => process.platform),
      exists: deps.exists ?? ((candidate) => fs.existsSync(candidate)),
      env: deps.env ?? (() => process.env),
      now: deps.now ?? (() => Date.now()),
      killTree: deps.killTree ?? ((child) => killProcessTree(child))
    }
  }

  /** See {@link hostActor}. */
  setHostActor(actor: CommandConnection): void {
    this.hostActor = actor
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  runtime(): IdeRuntimeState {
    return this.state
  }

  /** Last spawn/child failure, for the availability answer's explain-why copy. */
  lastErrorMessage(): string | undefined {
    return this.lastError ?? undefined
  }

  /** Upstream port to proxy to, or null when there is no live child. */
  upstreamPort(): number | null {
    return this.state === 'running' && this.port > 0 ? this.port : null
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /** Drop the cached probe — the override moved, or the toggle flipped. */
  invalidateProbe(): void {
    this.probeCache = null
    this.probeCacheKey = null
  }

  /**
   * Find a usable VS Code CLI, cached until the override changes or a re-probe
   * is asked for.
   *
   * Candidate order (ADR-064 §1): the host-anchored override, trusted as given →
   * `code-tunnel` beside whatever `code` PATH resolves to → the platform's
   * well-known install locations → the POSIX `code` script itself.
   *
   * A candidate is valid iff `<candidate> serve-web --help` exits 0 inside
   * {@link PROBE_TIMEOUT_MS}. **On Windows only `.exe` candidates are
   * auto-probed**: `code.cmd` is a batch wrapper (unspawnable under the repo's
   * `shell: false` rule, and its `Microsoft VS Code` path has a space in it), and
   * running the Electron `Code.exe` by accident would flash a GUI at whoever is
   * sitting at the machine. An EXPLICIT override is exempt from that rule — the
   * operator typed it.
   */
  async probeCli(override?: string | null, opts?: { force?: boolean }): Promise<IdeCliProbe> {
    const configured = override !== undefined ? override : readIdePolicy().cliPathOverride
    const key = `${this.deps.platform()}|${configured ?? ''}`
    if (!opts?.force && this.probeCache !== null && this.probeCacheKey === key) {
      return this.probeCache
    }
    if (this.probeInFlight && this.probeCacheKey === key && !opts?.force) return this.probeInFlight

    const run = (async (): Promise<IdeCliProbe> => {
      const candidates = this.candidatePaths(configured)
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: 'cli-not-found',
          detail: 'No VS Code CLI was found on PATH or in the usual install locations.'
        }
      }
      let lastDetail: string | undefined
      for (const candidate of candidates) {
        const result = await this.validateCandidate(candidate.path)
        if (result.ok) return { ok: true, cliPath: candidate.path }
        lastDetail = result.detail
      }
      // Every candidate EXISTED (that is how it became a candidate) and none
      // answered `serve-web --help`, so this is an unusable CLI rather than a
      // missing one — a distinction the settings pane turns into two different
      // instructions ("install VS Code" vs "that is not a VS Code CLI").
      return { ok: false, reason: 'cli-invalid', detail: lastDetail }
    })()

    this.probeCacheKey = key
    this.probeInFlight = run
    try {
      const probe = await run
      // Guarded on the key still being OURS: a probe raced by one with a
      // different override must not store its answer under the newer key.
      if (this.probeCacheKey === key) this.probeCache = probe
      return probe
    } finally {
      if (this.probeInFlight === run) this.probeInFlight = null
    }
  }

  /** Ordered candidate list — see {@link probeCli} for the ordering rationale. */
  private candidatePaths(override: string | null): Array<{ path: string; trusted: boolean }> {
    const out: Array<{ path: string; trusted: boolean }> = []
    const win = this.deps.platform() === 'win32'
    const push = (candidate: string | null | undefined, trusted = false): void => {
      if (!candidate) return
      // Windows auto-probe is `.exe`-only; an operator's own override is not.
      if (win && !trusted && !candidate.toLowerCase().endsWith('.exe')) return
      if (out.some((c) => c.path === candidate)) return
      if (!trusted && !this.deps.exists(candidate)) return
      out.push({ path: candidate, trusted })
    }

    // (1) The override, TRUSTED AS GIVEN — existence is not pre-checked, so a
    //     typo produces a real `cli-invalid`/`cli-not-found` from the probe with
    //     a detail the operator can act on, rather than being silently skipped in
    //     favour of some other VS Code on the machine.
    if (override) out.push({ path: override, trusted: true })

    const tunnel = win ? 'code-tunnel.exe' : 'code-tunnel'
    // (2) `code-tunnel` beside the `code` that PATH resolves to. This is the arm
    //     that works on a machine where VS Code was installed anywhere unusual,
    //     because the user's own PATH is the answer to "where is it".
    const codeOnPath = this.resolveOnPath('code')
    if (codeOnPath) push(path.join(path.dirname(codeOnPath), tunnel))

    // (3) Platform well-knowns.
    const env = this.deps.env()
    if (win) {
      const localAppData = env.LOCALAPPDATA
      const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
      if (localAppData) {
        push(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', tunnel))
      }
      if (programFiles) push(path.join(programFiles, 'Microsoft VS Code', 'bin', tunnel))
    } else if (this.deps.platform() === 'darwin') {
      const bin = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin'
      push(path.join(bin, 'code-tunnel'))
      push(path.join(bin, 'code'))
    } else {
      push('/usr/share/code/bin/code-tunnel')
      push('/usr/bin/code')
    }

    // (4) The POSIX `code` script itself, last. On Windows the PATH entry is
    //     `code.cmd`, which the `.exe` rule above already excludes.
    if (codeOnPath) push(codeOnPath)
    return out
  }

  /** First existing `<dir>/<name><ext>` across PATH, or null. */
  private resolveOnPath(name: string): string | null {
    const env = this.deps.env()
    const raw = env.PATH ?? env.Path ?? ''
    const exts = this.deps.platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
    for (const dir of raw.split(path.delimiter)) {
      if (!dir) continue
      for (const ext of exts) {
        const candidate = path.join(dir, `${name}${ext}`)
        if (this.deps.exists(candidate)) return candidate
      }
    }
    return null
  }

  /** `<candidate> serve-web --help`, exit 0 inside the probe budget. */
  private validateCandidate(candidate: string): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let stderr = ''
      const done = (ok: boolean, detail?: string): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ ok, detail })
      }

      let child: ChildProcess
      try {
        child = this.deps.spawn(candidate, ['serve-web', '--help'], {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          shell: false
        })
      } catch (err) {
        resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) })
        return
      }

      timer = setTimeout(() => {
        try {
          this.deps.killTree(child)
        } catch {
          /* already gone */
        }
        done(false, `\`serve-web --help\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s`)
      }, PROBE_TIMEOUT_MS)

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 600) stderr += chunk.toString()
      })
      child.on('error', (err) => done(false, err.message))
      child.on('exit', (code) =>
        done(code === 0, code === 0 ? undefined : `exit ${code}${stderr ? ` — ${stderr.trim()}` : ''}`)
      )
    })
  }

  // -------------------------------------------------------------------------
  // The child
  // -------------------------------------------------------------------------

  /**
   * Bring `serve-web` up (or hand back the live one). Single-flight, so two
   * mints racing on one host do not spawn two servers.
   *
   * Deliberately no auto-restart loop, unlike `TunnelManager`: a tunnel is
   * infrastructure that should heal itself, an IDE is a thing a person opened.
   * An unexpected death leaves state `error` and clears the sessions, and the
   * NEXT mint respawns — which is also the moment a human is present to see the
   * result.
   */
  ensureRunning(actor?: CommandConnection): Promise<{ port: number; token: string }> {
    if (this.state === 'running' && this.child !== null && this.port > 0) {
      return Promise.resolve({ port: this.port, token: this.token })
    }
    if (this.startInFlight) return this.startInFlight

    // The latch is released in a `finally` ON THE RETURNED PROMISE, not in a
    // detached `.then`, and the difference is a real defect the tests caught: a
    // detached chain settles AFTER the caller's own `await`, so a caller that
    // awaited a start and then immediately asked again — exactly what a mint does
    // after an unexpected child death — got the stale resolved promise back and
    // the port of a server that no longer exists. Chaining it means the latch is
    // provably clear by the time anybody can observe the result.
    const started = (async () => {
      const probe = await this.probeCli()
      if (!probe.ok) throw new Error(probe.detail ?? probe.reason)
      return await this.spawnServeWeb(probe.cliPath, actor)
    })().finally(() => {
      // Guarded, so a start that lost a race cannot clear a NEWER one's latch.
      if (this.startInFlight === started) this.startInFlight = null
    })
    this.startInFlight = started
    return started
  }

  private spawnServeWeb(
    cliPath: string,
    actor?: CommandConnection
  ): Promise<{ port: number; token: string }> {
    return new Promise((resolve, reject) => {
      // A fresh token per spawn. It gates VS Code's inner protocol on loopback
      // and is handed only to a browser that already passed OUR gate, so it never
      // needs to survive a restart — and a stored one would be a standing secret
      // for a child that is usually not even running.
      const token = crypto.randomBytes(32).toString('hex')
      this.state = 'starting'
      this.lastError = null

      const args = [
        'serve-web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--connection-token',
        token,
        '--server-base-path',
        IDE_BASE_PATH,
        // Suppresses the interactive prompt only. The ACCEPTANCE act is the
        // operator flipping the toggle on, whose copy links the terms (ADR-064).
        '--accept-server-license-terms',
        '--disable-telemetry'
      ]

      let child: ChildProcess
      try {
        child = this.deps.spawn(cliPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.failStart(message, actor)
        reject(new Error(message))
        return
      }
      this.child = child

      let stdout = ''
      let stderr = ''
      let settled = false
      const stderrTail = (): string => {
        const t = stderr.trim()
        return t ? ` — stderr: ${t.slice(-600)}` : ''
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          this.deps.killTree(child)
        } catch {
          /* already gone */
        }
        const message = `serve-web did not print a port within ${SPAWN_TIMEOUT_MS / 1000}s${stderrTail()}`
        this.failStart(message, actor)
        reject(new Error(message))
      }, SPAWN_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        // Once the port is parsed the buffer is never read again, so stop
        // appending — `serve-web` logs for its whole lifetime and this would
        // otherwise be a slow main-process leak (the OpencodeServerManager note).
        if (settled) return
        stdout += chunk.toString()
        const match = PORT_PATTERN.exec(stdout)
        if (!match) return
        settled = true
        clearTimeout(timer)
        this.port = Number(match[1])
        this.token = token
        this.state = 'running'
        this.lastError = null
        this.lastActivityAt = this.deps.now()
        this.startReaper()
        logger.info('vscode-web', `serve-web is up on 127.0.0.1:${this.port} (${cliPath})`)
        this.audit({
          channel: 'ide:spawn',
          outcome: 'ok',
          detail: `serve-web spawned from ${cliPath} on 127.0.0.1:${this.port}`,
          actor
        })
        resolve({ port: this.port, token })
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return
        stderr += chunk.toString()
      })

      child.on('error', (err) => {
        if (settled) {
          this.handleChildGone(`spawn error: ${err.message}`)
          return
        }
        settled = true
        clearTimeout(timer)
        this.failStart(`${err.message}${stderrTail()}`, actor)
        reject(new Error(err.message))
      })

      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          const message = `serve-web exited before printing a port (code=${code}, signal=${signal})${stderrTail()}`
          this.failStart(message, actor)
          reject(new Error(message))
          return
        }
        // Died AFTER we were serving: end every session (their upstream is gone)
        // and go to `error`. The next mint respawns.
        this.handleChildGone(`exited (code=${code}, signal=${signal})`)
      })
    })
  }

  /** A start that never reached a port. */
  private failStart(message: string, actor?: CommandConnection): void {
    this.state = 'error'
    this.lastError = message
    this.child = null
    this.port = 0
    this.token = ''
    logger.warn('vscode-web', `serve-web failed to start: ${message}`)
    this.audit({ channel: 'ide:spawn', outcome: 'error', detail: message, actor })
  }

  /** The child we were serving from is gone. */
  private handleChildGone(reason: string): void {
    if (this.child === null && this.state === 'stopped') return
    this.child = null
    this.port = 0
    this.token = ''
    this.state = 'error'
    this.lastError = reason
    this.stopReaper()
    logger.warn('vscode-web', `serve-web ${reason}`)
    this.audit({ channel: 'ide:exit', outcome: 'error', detail: `serve-web ${reason}` })
    this.clearSessions('child-exited')
  }

  /** Kill the child and go to `stopped` (the ORDERLY path). */
  private teardownChild(reason: string): void {
    const child = this.child
    this.child = null
    this.port = 0
    this.token = ''
    this.state = 'stopped'
    this.stopReaper()
    if (!child) return
    // ALWAYS the tree. Killing the CLI process alone orphans the inner server
    // child, which keeps the port — observed live on Windows.
    try {
      this.deps.killTree(child)
    } catch {
      /* already gone */
    }
    logger.info('vscode-web', `serve-web stopped (${reason})`)
    this.audit({ channel: 'ide:exit', outcome: 'ok', detail: `serve-web stopped (${reason})` })
  }

  /**
   * Stop the child on purpose (toggle-off, shutdown). Public so the transport's
   * `applyIdePolicy` can end an IDE the operator just switched off.
   */
  stopChild(reason: string): void {
    if (this.child === null && this.state !== 'running' && this.state !== 'starting') return
    this.teardownChild(reason)
  }

  // -------------------------------------------------------------------------
  // Entry tokens
  // -------------------------------------------------------------------------

  /**
   * Mint a single-use entry URL for `folder`.
   *
   * RELATIVE, because the browser is already on the origin it will open: the
   * server never has to guess (or be told) what that origin is, and the cookie
   * the entry sets is scoped to `/vscode` on it.
   */
  mintEntry(actor: CommandConnection, folder: string): IdeEntry {
    this.pruneEntries()
    while (this.entries.length >= MAX_PENDING_ENTRIES) this.entries.shift()
    const token = crypto.randomBytes(32).toString('hex')
    this.entries.push({ token, expiresAt: this.deps.now() + ENTRY_TOKEN_TTL_MS, folder })
    logger.info(
      'vscode-web',
      `Minted an IDE entry for ${actor.identity.label} (${this.entries.length} pending)`
    )
    return { url: `${IDE_BASE_PATH}/enter?it=${token}` }
  }

  /**
   * Spend one. Single-use — the match is REMOVED before it is reported, so two
   * tabs racing the same link cannot both win — and the compare is constant-time
   * across the whole set for the reason {@link entries} is an array.
   */
  redeemEntry(candidate: string | null | undefined): {
    cookieValue: string
    redirect: string
  } | null {
    this.pruneEntries()
    let hit = -1
    for (let i = 0; i < this.entries.length; i++) {
      if (safeHexEqual(this.entries[i].token, candidate)) hit = i
    }
    if (hit < 0) return null
    const [entry] = this.entries.splice(hit, 1)
    if (this.state !== 'running' || this.token === '') {
      // The child died between mint and click. The token is spent either way
      // (single-use is single-use); the operator presses the button again, which
      // respawns. Answering with a cookie for a server that is gone would only
      // move the failure one navigation later.
      return null
    }
    const cookieValue = crypto.randomBytes(32).toString('hex')
    this.pruneSessions()
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) break
      this.sessions.delete(oldest.value)
    }
    this.sessions.set(cookieValue, this.deps.now())
    this.lastActivityAt = this.deps.now()
    const folder = encodeURIComponent(ideFolderParam(entry.folder))
    return {
      cookieValue,
      redirect: `${IDE_BASE_PATH}/?tkn=${this.token}&folder=${folder}`
    }
  }

  private pruneEntries(): void {
    const now = this.deps.now()
    this.entries = this.entries.filter((e) => e.expiresAt > now)
  }

  // -------------------------------------------------------------------------
  // Cookie sessions
  // -------------------------------------------------------------------------

  /**
   * Is this request carrying a live session cookie? Constant-time across the set
   * (no early break) for the same reason the entry lookup is.
   */
  validateCookie(cookieHeader: string | undefined): boolean {
    const value = readCookie(cookieHeader, IDE_COOKIE_NAME)
    if (!value) return false
    this.pruneSessions()
    let ok = false
    for (const id of this.sessions.keys()) {
      if (safeHexEqual(id, value)) ok = true
    }
    return ok
  }

  private pruneSessions(): void {
    const now = this.deps.now()
    for (const [id, createdAt] of this.sessions) {
      if (now - createdAt > SESSION_TTL_MS) this.sessions.delete(id)
    }
  }

  /**
   * End every IDE session, and the sockets they are riding.
   *
   * Both halves are load-bearing. Dropping the cookies alone would leave an
   * ESTABLISHED WebSocket — the workbench's remote-agent channel — running for as
   * long as the tab stayed open, because our gate only ever runs at request and
   * upgrade time. Called by toggle-off, by every 4008/4009 auth-surface sweep,
   * and on server stop.
   */
  clearSessions(reason: string): void {
    const live = this.sessions.size
    const pending = this.entries.length
    const sockets = this.sockets.size
    this.sessions.clear()
    this.entries = []
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear()
    if (live === 0 && pending === 0 && sockets === 0) return
    logger.info(
      'vscode-web',
      `Cleared ${live} IDE session(s), ${pending} pending entry token(s) and ${sockets} live socket(s): ${reason}`
    )
    this.audit({
      channel: 'ide:sessions-cleared',
      outcome: 'ok',
      detail: `${live} session(s), ${pending} pending token(s), ${sockets} socket(s) invalidated: ${reason}`
    })
  }

  // -------------------------------------------------------------------------
  // Proxy bookkeeping (called by remote-server)
  // -------------------------------------------------------------------------

  /** A `/vscode` HTTP request happened — the reaper's idle clock resets. */
  noteRequest(): void {
    this.lastActivityAt = this.deps.now()
  }

  /** Track one proxied socket for the reaper and for {@link clearSessions}. */
  registerSocket(socket: Duplex): void {
    if (this.sockets.has(socket)) return
    this.sockets.add(socket)
    this.lastActivityAt = this.deps.now()
    const drop = (): void => {
      this.sockets.delete(socket)
      this.lastActivityAt = this.deps.now()
    }
    socket.once('close', drop)
    socket.once('error', drop)
  }

  /** Live proxied sockets — test/inspection seam. */
  liveSocketCount(): number {
    return this.sockets.size
  }

  // -------------------------------------------------------------------------
  // Reaper
  // -------------------------------------------------------------------------

  private startReaper(): void {
    if (this.reapTimer) return
    this.reapTimer = setInterval(() => this.maybeReap(), REAP_INTERVAL_MS)
    // An idle sweep must never be the reason a process stays alive.
    this.reapTimer.unref?.()
  }

  private stopReaper(): void {
    if (!this.reapTimer) return
    clearInterval(this.reapTimer)
    this.reapTimer = null
  }

  /** Test seam: run one reaper tick without waiting for the interval. */
  maybeReap(): void {
    if (this.state !== 'running') return
    if (this.sockets.size > 0) return
    if (this.deps.now() - this.lastActivityAt < IDLE_REAP_MS) return
    this.clearSessions('idle-reaped')
    this.teardownChild('idle for 30 minutes with no live sockets')
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Full teardown: sessions, tokens, timers, child. Idempotent. */
  stop(): void {
    this.clearSessions('service-stopped')
    this.stopReaper()
    this.teardownChild('service stopped')
    this.state = 'stopped'
    this.lastError = null
    this.startInFlight = null
    this.invalidateProbe()
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  /**
   * One audit row. `capability: 'ide'` on every row and `kind: 'command'`, the
   * `auditAuth` convention: these move state and must never be filtered out as
   * unaudited reads. Never throws — the trail is observability, and refusing to
   * spawn an editor because the DB is wedged would be the worse failure.
   */
  private audit(entry: {
    channel: string
    outcome: 'ok' | 'error'
    detail: string
    actor?: CommandConnection
  }): void {
    const actor = entry.actor ?? this.hostActor ?? hostConnection()
    try {
      appendAuditLog({
        ts: this.deps.now(),
        connectionId: actor.connectionId,
        method: actor.identity.method,
        label: actor.identity.label,
        capability: 'ide',
        kind: 'command',
        channel: entry.channel,
        sessionId: null,
        outcome: entry.outcome,
        detail: entry.detail
      })
    } catch (err) {
      logger.error('vscode-web', `audit append failed for ${entry.channel}: ${err}`)
    }
  }
}

/**
 * The process-wide instance, mirroring `terminalService`: one `serve-web` child
 * per host, whichever surface asked for it.
 */
export const vscodeWebService = new VscodeWebService()
