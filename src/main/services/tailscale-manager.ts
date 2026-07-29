import { execFile } from 'node:child_process'
import { logger } from './logger'
import type { TailscaleDetection } from '../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a successful CLI invocation. Mirrors `child_process.execFile`'s
 * callback payload.
 */
export interface TailscaleExecResult {
  stdout: string
  stderr: string
}

/**
 * Shape `execTailscale` rejects with. `code` is the process exit code (a
 * number) or a libuv error string such as `ENOENT` (binary missing) /
 * `ETIMEDOUT`. Node's `execFile` attaches `stdout`/`stderr` to the error, and
 * `killed: true` when the timeout fired — all three are load-bearing for the
 * detection matrix, so they are part of the contract.
 */
export interface TailscaleExecFailure extends Error {
  code?: number | string
  stdout?: string
  stderr?: string
  killed?: boolean
  signal?: NodeJS.Signals | null
}

/**
 * Injectable exec seam. Resolves on exit 0, rejects with a
 * {@link TailscaleExecFailure} otherwise. Making this a constructor parameter
 * is what lets the whole detection matrix be unit-tested on a machine with no
 * tailscale installed.
 */
export type TailscaleExecFn = (
  file: string,
  args: string[],
  timeoutMs: number
) => Promise<TailscaleExecResult>

/**
 * Outcome of {@link TailscaleManager.detect}.
 *
 * Declared in `src/shared/types.ts` (and re-exported here so existing importers
 * are unaffected) because the renderer and the web client consume it too —
 * `remote:tailscale-detect` returns it verbatim and `RemoteStatus.tls.detection`
 * carries its `state`. One declaration means the IPC boundary cannot drift from
 * what this file produces.
 */
export type { TailscaleDetection }

/** One HTTPS port already claimed in the node's serve config. */
export interface ServeOccupancy {
  httpsPort: TailscaleHttpsPort
  /** The handler target, e.g. `http://127.0.0.1:5173`, `<text>`, `<path>`, or
   *  `tcp-forward:127.0.0.1:1234` for a raw/TLS-terminated TCP forwarder. */
  target: string
  /** True when this entry is one we created (proxying to our own local port). */
  ours: boolean
}

export type ServeFailureReason =
  /** `detect()` did not return `ok` — see {@link TailscaleServeError.detection}. */
  | 'not-ready'
  /** Every candidate HTTPS port is held by a config that is not ours. */
  | 'all-ports-occupied'
  /** The CLI exited non-zero (or timed out). */
  | 'exec-failed'
  /** The CLI exited 0 but the config did not actually land — see NOTE in `enableServe`. */
  | 'verify-failed'

/** Typed failure for the serve mutations. */
export class TailscaleServeError extends Error {
  readonly reason: ServeFailureReason
  readonly detail?: string
  readonly detection?: TailscaleDetection

  constructor(
    reason: ServeFailureReason,
    message: string,
    opts?: { detail?: string; detection?: TailscaleDetection }
  ) {
    super(message)
    this.name = 'TailscaleServeError'
    this.reason = reason
    this.detail = opts?.detail
    this.detection = opts?.detection
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HTTPS ports we are willing to bind, in preference order.
 *
 * NOTE this is a *policy* choice, not a platform limit. `tailscale serve`
 * itself accepts any uint16 for `--https` (`srvTypeAndPortFromFlags` in
 * `cmd/tailscale/cli/serve_v2.go`); the well-known 443/8443/10000 triple is the
 * set Tailscale *Funnel* is restricted to (`ipn/serve.go` `CheckFunnelPort`,
 * driven by the `https://tailscale.com/cap/funnel-ports` node attr). Sticking
 * to it keeps a future Funnel option viable and matches what users expect from
 * the docs. Widening it is a one-line change here.
 */
export const HTTPS_PORT_CANDIDATES = [443, 8443, 10000] as const

export type TailscaleHttpsPort = (typeof HTTPS_PORT_CANDIDATES)[number]

/** Read-only queries (`version`, `status`, `serve status`) are fast. */
const QUERY_TIMEOUT_MS = 10_000

/**
 * Mutations (`serve --bg …`) get a longer budget — and the timeout is
 * load-bearing rather than hygiene: on a tailnet without HTTPS certificates
 * `tailscale serve --https=… <target>` calls `enableFeatureInteractive`, which
 * can block indefinitely on `WatchIPNBus` waiting for an admin to flip the
 * setting. `detect()` gates that case away, but the timeout is the backstop.
 */
const MUTATE_TIMEOUT_MS = 20_000

/** `status --json` on a large tailnet is big; we request it without peers, but
 *  keep headroom anyway. */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Ordered binary candidates per platform. Entries without a path separator are
 * resolved through `PATH` by `execFile`.
 *
 * macOS specifics (observed on the standalone "macsys" build, 1.98.5):
 * `/opt/homebrew/bin/tailscale` and `/usr/local/bin/tailscale` are both tiny
 * `#!/bin/sh` wrappers that `exec` the CLI inside `Tailscale.app`, so probing
 * them is equivalent to probing the app binary. The app self-updates in place,
 * so the Homebrew Caskroom version in the wrapper's path is *not* the running
 * version — always ask `tailscale version`.
 */
const BINARY_CANDIDATES: Record<string, readonly string[]> = {
  darwin: [
    'tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  ],
  win32: [
    'tailscale.exe',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
  ],
  linux: ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale']
}

const DEFAULT_CANDIDATES: readonly string[] = ['tailscale', '/usr/local/bin/tailscale']

/** `tailcfg.CapabilityHTTPS` — the bare string `"https"`. */
const CAP_HTTPS = 'https'

// ---------------------------------------------------------------------------
// Shapes of the JSON we consume (only the fields we actually read)
// ---------------------------------------------------------------------------

interface RawStatus {
  BackendState?: string
  AuthURL?: string
  CertDomains?: string[] | null
  Version?: string
  Self?: {
    DNSName?: string
    Online?: boolean
    Tags?: string[] | null
    Capabilities?: string[] | null
    CapMap?: Record<string, unknown> | null
    /** Index into {@link RawStatus.User}. Observed as a ~16-digit integer, which
     *  is still below 2^53 and therefore exact in JS. */
    UserID?: number | string
    TailscaleIPs?: string[] | null
  } | null
  /**
   * Keyed by the stringified user id.
   *
   * ⚠️ OBSERVED on 1.98.5: `status --json --peers=false` emits `User: null` — the
   * user map only accompanies the peer list. Since that is the read we prefer,
   * the owner login usually has to come from {@link TailscaleManager.whoisLogin}
   * instead of this map.
   */
  User?: Record<string, { ID?: number | string; LoginName?: string } | null> | null
}

/** `whois --json` — only the two fields we read. */
interface RawWhois {
  Node?: { Tags?: string[] | null } | null
  UserProfile?: { LoginName?: string } | null
}

interface RawHttpHandler {
  Proxy?: string
  Path?: string
  Text?: string
}
interface RawWebServerConfig {
  Handlers?: Record<string, RawHttpHandler | null> | null
}
interface RawTcpPortHandler {
  HTTPS?: boolean
  HTTP?: boolean
  TCPForward?: string
  TerminateTLS?: string
}
/** `ipn.ServeConfig` — see `ipn/serve.go`. */
interface RawServeConfig {
  TCP?: Record<string, RawTcpPortHandler | null> | null
  /** Keyed by `"$SNI_NAME:$PORT"`. */
  Web?: Record<string, RawWebServerConfig | null> | null
  Services?: Record<string, RawServeConfig | null> | null
  /** Configs from a *foreground* `tailscale serve` (no `--bg`), keyed by IPN
   *  session id. They occupy the port just as much as a background config but
   *  are invisible at the top level — scanning only the top level under-reports
   *  occupancy, and we would then silently clobber someone. */
  Foreground?: Record<string, RawServeConfig | null> | null
}

// ---------------------------------------------------------------------------
// Real exec implementation
// ---------------------------------------------------------------------------

/** Default {@link TailscaleExecFn} backed by `child_process.execFile`. */
export const realExecTailscale: TailscaleExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const failure = err as TailscaleExecFailure
          failure.stdout = String(stdout ?? '')
          failure.stderr = String(stderr ?? '')
          reject(failure)
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  const f = err as TailscaleExecFailure
  const parts = [f?.stderr, f?.stdout, f?.message].filter((s): s is string => Boolean(s))
  return parts.join('\n')
}

/** True when the failure is the exec timeout firing (Node sets `killed`). */
function isTimeout(err: unknown): boolean {
  const f = err as TailscaleExecFailure
  return f?.killed === true || f?.code === 'ETIMEDOUT' || f?.signal === 'SIGTERM'
}

function isMissingBinary(err: unknown): boolean {
  const code = (err as TailscaleExecFailure)?.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR'
}

/**
 * `Access denied: …` is how `client/local` surfaces a localapi 403, which on
 * Unix means the caller is neither root nor the configured operator.
 */
function isAccessDenied(text: string): boolean {
  return text.includes('Access denied') || text.includes('--operator=')
}

/**
 * `client/local/local.go` wraps a failed localapi dial as
 * `Failed to connect to local Tailscale daemon for <path>; not running? Error: …`.
 */
function isDaemonDown(text: string): boolean {
  return (
    text.includes('Failed to connect to local Tailscale daemon') ||
    text.includes('not running?') ||
    text.includes('tailscaled.service not running')
  )
}

/** Older CLIs may not know `--peers`; detect a flag-parse rejection. */
function isUnknownFlag(text: string): boolean {
  return text.includes('flag provided but not defined') || text.includes('flag needs an argument')
}

/** `tailscale version` line 1 is the plain semver; the rest is commit metadata. */
function parseVersion(stdout: string): string {
  const first = stdout.split('\n')[0]?.trim() ?? ''
  return first.split(/\s+/)[0] || 'unknown'
}

/** `Self.DNSName` carries a trailing dot (`box.tailXXXX.ts.net.`) — strip it. */
function stripTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/**
 * Login of the user who owns `Self`, lowercased, or null when it cannot be
 * determined. This is the ONE value the Phase-3 identity allowlist compares
 * against, so every uncertain case must return null (fail closed):
 *
 * - **Tagged node** ⇒ null. `tailscale serve` sets no identity headers at all
 *   for a tagged device (`ipn/ipnlocal/serve.go`: `if node.IsTagged() return`),
 *   so there is no login to accept and identity auth must be off.
 * - **No `User` entry** for `Self.UserID` ⇒ null. Looked up by the map key
 *   first (that is how the CLI indexes it), then by scanning for a matching
 *   `ID`, so a payload whose key formatting differs still resolves.
 */
function ownerLoginFrom(status: RawStatus): string | null {
  const self = status.Self
  if (!self) return null
  if (self.Tags && self.Tags.length > 0) return null
  const userId = self.UserID
  if (userId === undefined || userId === null || userId === '') return null
  const users = status.User ?? {}
  const key = String(userId)
  const direct = users[key]
  const found = direct ?? Object.values(users).find((u) => u && String(u.ID) === key) ?? null
  const login = found?.LoginName?.trim()
  return login ? login.toLowerCase() : null
}

/** Our canonical serve target for a local port. */
function ourTarget(localPort: number): string {
  return `http://127.0.0.1:${localPort}`
}

/** Describe a `TCPPortHandler` that has no matching `Web` entry. */
function describeTcpHandler(h: RawTcpPortHandler): string {
  if (h.TCPForward) {
    return `${h.TerminateTLS ? 'tls-terminated-tcp' : 'tcp'}-forward:${h.TCPForward}`
  }
  return h.HTTPS ? 'https' : h.HTTP ? 'http' : 'unknown'
}

/** Describe an `HTTPHandler` for the conflict UI. */
function describeWebHandler(h: RawHttpHandler): string {
  if (h.Proxy) return h.Proxy
  if (h.Path) return `path:${h.Path}`
  if (h.Text !== undefined) return 'text'
  return 'unknown'
}

/**
 * Every `ServeConfig` reachable from the root: the root itself, each
 * `Foreground[*]` session config, and each `Services[*]` config. See the
 * `Foreground` note on {@link RawServeConfig}.
 */
function flattenServeConfigs(root: RawServeConfig): RawServeConfig[] {
  const out: RawServeConfig[] = [root]
  for (const nested of Object.values(root.Foreground ?? {})) {
    if (nested) out.push(...flattenServeConfigs(nested))
  }
  for (const svc of Object.values(root.Services ?? {})) {
    if (svc) out.push(...flattenServeConfigs(svc))
  }
  return out
}

/** Port half of an `ipn.HostPort` key (`"$SNI_NAME:$PORT"`). */
function hostPortPort(key: string): number | null {
  const idx = key.lastIndexOf(':')
  if (idx < 0) return null
  const n = Number(key.slice(idx + 1))
  return Number.isInteger(n) ? n : null
}

// ---------------------------------------------------------------------------
// TailscaleManager
// ---------------------------------------------------------------------------

/**
 * Read-mostly wrapper around the `tailscale` CLI for the Phase-3 "serve + TLS +
 * tailnet identity" remote-access mode.
 *
 * Every mutation is *targeted*: we only ever add/remove the one `--https=<port>`
 * handler we own. `tailscale serve reset` is deliberately never issued — it
 * would wipe a user's unrelated serve configuration.
 */
export class TailscaleManager {
  private readonly exec: TailscaleExecFn
  /** Resolved binary + its `version` output, cached across calls. */
  private resolved: { binaryPath: string; version: string } | null = null
  /** Ports we enabled in this process (used for `ours` when no port is given). */
  private ownedHttpsPorts = new Set<number>()
  /** Set when `status --json --peers=false` is rejected by an older CLI. */
  private supportsNoPeersFlag = true

  constructor(exec: TailscaleExecFn = realExecTailscale) {
    this.exec = exec
  }

  /** Forget the cached binary/version (e.g. after the user installs Tailscale). */
  resetCache(): void {
    this.resolved = null
    this.supportsNoPeersFlag = true
  }

  // -------------------------------------------------------------------------
  // detect
  // -------------------------------------------------------------------------

  /**
   * Classify the local Tailscale installation. Decision tree keyed off the
   * failure-mode table in the Phase-3 recon notes:
   *
   * - no candidate binary execs                 → `not-installed`
   * - `Access denied` / operator hint on stderr → `no-operator`
   * - localapi dial failure                     → `daemon-down`
   * - `BackendState: NeedsLogin/NeedsMachineAuth` → `logged-out`
   * - `BackendState: Stopped`                   → `daemon-down`
   * - Running but no `CertDomains` and no `https` node cap → `https-disabled`
   * - anything else (timeout, bad JSON, transient states) → `error`
   *
   * IMPORTANT: `tailscale status --json` marshals and returns *before* the CLI's
   * `isRunningOrStarting()` check, so it exits **0** even when logged out or
   * stopped (`cmd/tailscale/cli/status.go`). Never key detection off the exit
   * code — only off `BackendState`.
   */
  async detect(): Promise<TailscaleDetection> {
    let binaryPath: string
    let version: string
    try {
      const found = await this.resolveBinary()
      binaryPath = found.binaryPath
      version = found.version
    } catch (err) {
      // resolveBinary only throws when *every* candidate failed. If any failed
      // for a reason other than "missing", surface that instead of pretending
      // tailscale is not installed.
      const text = errText(err)
      if (isAccessDenied(text)) {
        return {
          state: 'no-operator',
          message:
            'Tailscale refused access to its local API. Run `sudo tailscale set --operator=$USER` once, then try again.',
          detail: text.slice(-500)
        }
      }
      return {
        state: 'not-installed',
        message:
          'Tailscale was not found. Install it from https://tailscale.com/download and make sure the `tailscale` command is on your PATH.',
        detail: text.slice(-500)
      }
    }

    let raw: string
    try {
      raw = await this.statusJson(binaryPath)
    } catch (err) {
      const text = errText(err)
      if (isTimeout(err)) {
        return {
          state: 'error',
          message: `Tailscale did not respond within ${QUERY_TIMEOUT_MS / 1000}s. Check that the Tailscale app is running.`,
          binaryPath,
          detail: text.slice(-500)
        }
      }
      if (isAccessDenied(text)) {
        return {
          state: 'no-operator',
          message:
            'Tailscale refused access to its local API. Run `sudo tailscale set --operator=$USER` once, then try again.',
          binaryPath,
          detail: text.slice(-500)
        }
      }
      if (isDaemonDown(text)) {
        return {
          state: 'daemon-down',
          message:
            'The Tailscale daemon is not running. Start the Tailscale app (or `sudo tailscaled`) and try again.',
          binaryPath,
          detail: text.slice(-500)
        }
      }
      return {
        state: 'error',
        message: `Could not read Tailscale status: ${(err as Error)?.message ?? String(err)}`,
        binaryPath,
        detail: text.slice(-500)
      }
    }

    let status: RawStatus
    try {
      status = JSON.parse(raw) as RawStatus
    } catch {
      return {
        state: 'error',
        message: 'Tailscale returned status output this version of ClaudeUI could not parse.',
        binaryPath,
        detail: raw.slice(0, 300)
      }
    }

    const backendState = status.BackendState ?? ''
    if (backendState === 'NeedsLogin') {
      return {
        state: 'logged-out',
        message: status.AuthURL
          ? `You are logged out of Tailscale. Log in at ${status.AuthURL}`
          : 'You are logged out of Tailscale. Run `tailscale login` (or log in from the Tailscale app) and try again.',
        binaryPath,
        detail: `BackendState=${backendState}`
      }
    }
    if (backendState === 'NeedsMachineAuth') {
      return {
        state: 'logged-out',
        message:
          'This device is waiting for approval by a tailnet admin. Approve it in the Tailscale admin console, then try again.',
        binaryPath,
        detail: `BackendState=${backendState}`
      }
    }
    if (backendState === 'Stopped') {
      return {
        state: 'daemon-down',
        message:
          'Tailscale is disconnected. Turn it back on from the Tailscale app (or run `tailscale up`) and try again.',
        binaryPath,
        detail: `BackendState=${backendState}`
      }
    }
    if (backendState !== 'Running') {
      return {
        state: 'error',
        message: `Tailscale is not ready yet (state: ${backendState || 'unknown'}). Try again in a moment.`,
        binaryPath,
        detail: `BackendState=${backendState}`
      }
    }

    const dnsName = stripTrailingDot(status.Self?.DNSName ?? '')
    if (!dnsName) {
      return {
        state: 'error',
        message:
          'Tailscale reported no MagicDNS name for this device. Enable MagicDNS in the Tailscale admin console (DNS → MagicDNS) and try again.',
        binaryPath,
        detail: 'Self.DNSName empty'
      }
    }

    const certDomains = status.CertDomains ?? []
    // Two independent signals that HTTPS certificates are enabled for the
    // tailnet: the netmap's CertDomains, and the `https` node capability the
    // CLI itself gates on (`tailcfg.CapabilityHTTPS`). Accept either — a freshly
    // enabled tailnet can have the cap before any CertDomains land.
    const caps = new Set<string>([
      ...(status.Self?.Capabilities ?? []),
      ...Object.keys(status.Self?.CapMap ?? {})
    ])
    if (certDomains.length === 0 && !caps.has(CAP_HTTPS)) {
      return {
        state: 'https-disabled',
        message:
          'HTTPS certificates are not enabled for this tailnet. Enable them in the Tailscale admin console (DNS → HTTPS Certificates), then try again.',
        binaryPath,
        detail: 'CertDomains empty and node lacks the "https" capability'
      }
    }

    // Owner login: from the `User` map when the payload carries one, else via
    // `whois` on our own tailnet address (see whoisLogin). A tagged node never
    // gets identity headers, so it is not worth a second exec.
    let ownerLogin = ownerLoginFrom(status)
    const tagged = (status.Self?.Tags?.length ?? 0) > 0
    if (ownerLogin === null && !tagged) {
      ownerLogin = await this.whoisLogin(binaryPath, status.Self?.TailscaleIPs?.[0])
    }

    return { state: 'ok', binaryPath, version, dnsName, certDomains, ownerLogin }
  }

  // -------------------------------------------------------------------------
  // serve status
  // -------------------------------------------------------------------------

  /**
   * Which of {@link HTTPS_PORT_CANDIDATES} are already claimed, and by what.
   *
   * `ours` is decided by target when `localPort` is supplied (the reliable test,
   * and the only one that survives an app restart — a `--bg` serve config is
   * persisted per-profile and outlives our process). Without `localPort` it
   * falls back to "did *this* process enable it".
   */
  async getServeStatus(localPort?: number): Promise<{ occupied: ServeOccupancy[] }> {
    const { binaryPath } = await this.resolveBinary()
    let stdout: string
    try {
      // Exit code is 0 both with and without a config; the no-config body is
      // the literal `{}`.
      stdout = (await this.exec(binaryPath, ['serve', 'status', '--json'], QUERY_TIMEOUT_MS)).stdout
    } catch (err) {
      throw new TailscaleServeError('exec-failed', 'Could not read the Tailscale serve config.', {
        detail: errText(err).slice(-500)
      })
    }

    let config: RawServeConfig
    try {
      config = (JSON.parse(stdout || '{}') ?? {}) as RawServeConfig
    } catch {
      throw new TailscaleServeError(
        'exec-failed',
        'Tailscale returned a serve config this version of ClaudeUI could not parse.',
        { detail: stdout.slice(0, 300) }
      )
    }

    const wanted = ourTarget(localPort ?? -1)
    const occupied: ServeOccupancy[] = []

    for (const httpsPort of HTTPS_PORT_CANDIDATES) {
      const target = this.findTargetForPort(config, httpsPort)
      if (target === null) continue
      const ours = localPort !== undefined ? target === wanted : this.ownedHttpsPorts.has(httpsPort)
      occupied.push({ httpsPort, target, ours })
    }

    return { occupied }
  }

  /**
   * Target string for `httpsPort` across the root config and every nested
   * (foreground / service) config, or `null` when the port is free. Prefers the
   * `/` mount's handler, since that is the mount we would write.
   */
  private findTargetForPort(root: RawServeConfig, httpsPort: number): string | null {
    let fallback: string | null = null

    for (const cfg of flattenServeConfigs(root)) {
      for (const [key, web] of Object.entries(cfg.Web ?? {})) {
        if (hostPortPort(key) !== httpsPort || !web) continue
        const handlers = web.Handlers ?? {}
        const root_ = handlers['/']
        if (root_) return describeWebHandler(root_)
        for (const h of Object.values(handlers)) {
          if (h) fallback ??= describeWebHandler(h)
        }
      }
      // A TCP entry with no matching Web entry means a raw/TLS-terminated
      // forwarder (or a Web config for a different SNI) — still occupied.
      const tcp = cfg.TCP?.[String(httpsPort)]
      if (tcp) fallback ??= describeTcpHandler(tcp)
    }

    return fallback
  }

  // -------------------------------------------------------------------------
  // enable / disable serve
  // -------------------------------------------------------------------------

  /**
   * Point a `tailscale serve` HTTPS listener at `localPort`, trying
   * {@link HTTPS_PORT_CANDIDATES} in order and skipping any port held by a
   * FOREIGN config. A port whose target is already ours is reused (the CLI call
   * is idempotent — `SetWebHandler` overwrites the `/` mount).
   *
   * Two non-obvious safeguards, both required by observed CLI behaviour:
   *
   * 1. **`detect()` must be `ok` first.** On a tailnet without HTTPS
   *    certificates, `serve --https=… <target>` runs
   *    `enableFeatureInteractive(…, CapabilityHTTPS)`, which either prints a
   *    setup URL and calls `os.Exit(0)` *without configuring anything*, or
   *    blocks on `WatchIPNBus` until an admin enables the feature. `--yes` does
   *    not suppress it. Gating on `detect()` keeps us out of both branches.
   * 2. **Exit 0 is not proof.** Because of (1), success is confirmed by
   *    re-reading `serve status --json` and checking our target actually landed.
   */
  async enableServe(localPort: number): Promise<{ httpsPort: number; url: string }> {
    const detection = await this.detect()
    if (detection.state !== 'ok') {
      throw new TailscaleServeError('not-ready', detection.message, {
        detail: detection.detail,
        detection
      })
    }

    const { occupied } = await this.getServeStatus(localPort)
    const byPort = new Map(occupied.map((o) => [o.httpsPort, o]))

    let chosen: TailscaleHttpsPort | null = null
    for (const candidate of HTTPS_PORT_CANDIDATES) {
      const entry = byPort.get(candidate)
      if (!entry || entry.ours) {
        chosen = candidate
        break
      }
    }
    if (chosen === null) {
      const summary = occupied.map((o) => `${o.httpsPort} → ${o.target}`).join(', ')
      throw new TailscaleServeError(
        'all-ports-occupied',
        `All Tailscale HTTPS ports (${HTTPS_PORT_CANDIDATES.join(', ')}) are already used by another serve configuration. Free one with \`tailscale serve --https=<port> off\` and try again.`,
        { detail: summary }
      )
    }

    const target = ourTarget(localPort)
    // Syntax pinned to tailscale 1.98.5 (`cmd/tailscale/cli/serve_v2.go`):
    //   tailscale serve --bg --https=<port> <target>
    // `--https` is a value flag so `--https=443` and `--https 443` both parse;
    // the `=` form keeps it to one argv element. The pre-1.46 grammar
    // (`serve https:8443 / http://localhost:3000`) is rejected by current CLIs
    // with a "run this instead" hint, so do not emit it.
    const args = ['serve', '--bg', `--https=${chosen}`, target]

    let stdout = ''
    try {
      const res = await this.exec(detection.binaryPath, args, MUTATE_TIMEOUT_MS)
      stdout = res.stdout
    } catch (err) {
      throw new TailscaleServeError(
        'exec-failed',
        isTimeout(err)
          ? `Tailscale did not finish configuring serve within ${MUTATE_TIMEOUT_MS / 1000}s.`
          : `Tailscale could not configure serve on port ${chosen}.`,
        { detail: errText(err).slice(-500) }
      )
    }

    // Post-exec verification — see safeguard (2) above.
    const after = await this.getServeStatus(localPort)
    const landed = after.occupied.find((o) => o.httpsPort === chosen && o.ours)
    if (!landed) {
      throw new TailscaleServeError(
        'verify-failed',
        `Tailscale reported success but no serve handler is configured on port ${chosen}. This usually means HTTPS certificates still need to be enabled for your tailnet.`,
        { detail: [stdout.trim(), JSON.stringify(after.occupied)].filter(Boolean).join('\n') }
      )
    }

    this.ownedHttpsPorts.add(chosen)
    const url =
      chosen === 443 ? `https://${detection.dnsName}` : `https://${detection.dnsName}:${chosen}`
    logger.info('tailscale-manager', `serve enabled on ${chosen} → ${target} (${url})`)
    return { httpsPort: chosen, url }
  }

  /**
   * Remove only *our* handler: `tailscale serve --https=<port> off`.
   *
   * Never `tailscale serve reset` — that wipes the user's entire serve config,
   * including entries we did not create. `--bg` is not passed because a
   * turn-off never enters foreground mode (`wantFg := !e.bg.Value && !turnOff`).
   *
   * Idempotent: "handler does not exist" / "serve config does not exist" from
   * the CLI is treated as already-off.
   */
  async disableServe(httpsPort: number): Promise<void> {
    const { binaryPath } = await this.resolveBinary()
    try {
      await this.exec(binaryPath, ['serve', `--https=${httpsPort}`, 'off'], MUTATE_TIMEOUT_MS)
    } catch (err) {
      const text = errText(err)
      if (text.includes('handler does not exist') || text.includes('serve config does not exist')) {
        logger.info('tailscale-manager', `serve on ${httpsPort} was already off`)
        this.ownedHttpsPorts.delete(httpsPort)
        return
      }
      throw new TailscaleServeError(
        'exec-failed',
        isTimeout(err)
          ? `Tailscale did not finish removing serve on port ${httpsPort} in time.`
          : `Tailscale could not turn off serve on port ${httpsPort}.`,
        { detail: text.slice(-500) }
      )
    }
    this.ownedHttpsPorts.delete(httpsPort)
    logger.info('tailscale-manager', `serve disabled on ${httpsPort}`)
  }

  // -------------------------------------------------------------------------
  // Binary discovery
  // -------------------------------------------------------------------------

  /**
   * First candidate whose `version` call succeeds, cached. Probing with
   * `version` (rather than `which`) avoids per-platform lookup tools and proves
   * the file is actually executable.
   *
   * Rejects with the *most informative* failure when nothing works: a permission
   * / access-denied error beats a plain ENOENT, so `detect()` can tell
   * "not installed" from "installed but locked down".
   */
  private async resolveBinary(): Promise<{ binaryPath: string; version: string }> {
    if (this.resolved) return this.resolved

    const candidates = BINARY_CANDIDATES[process.platform] ?? DEFAULT_CANDIDATES
    let best: unknown = null
    for (const candidate of candidates) {
      try {
        const { stdout } = await this.exec(candidate, ['version'], QUERY_TIMEOUT_MS)
        this.resolved = { binaryPath: candidate, version: parseVersion(stdout) }
        return this.resolved
      } catch (err) {
        if (best === null || (isMissingBinary(best) && !isMissingBinary(err))) best = err
      }
    }
    throw best ?? new Error('No tailscale binary candidates configured')
  }

  /**
   * Owner login via `tailscale whois --json <our own tailnet IP>`.
   *
   * Why a second call at all: `status --json --peers=false` — the read we prefer,
   * because a large tailnet's peer list is megabytes — returns `User: null`
   * (OBSERVED on 1.98.5; the user map only ships with the peers), so the map
   * lookup finds nothing. `whois` is the SAME localapi call `tailscale serve`
   * uses to fill `Tailscale-User-Login` (`b.WhoIs("tcp", srcAddr)` in
   * `ipn/ipnlocal/serve.go`), and its payload is ~2 KB regardless of tailnet
   * size — so this resolves the owner exactly the way the header we compare
   * against is resolved, without paying for the peer list.
   *
   * Every failure path returns null, which disables identity auth (fail closed).
   */
  private async whoisLogin(binaryPath: string, selfIp: string | undefined): Promise<string | null> {
    if (!selfIp) return null
    try {
      const { stdout } = await this.exec(binaryPath, ['whois', '--json', selfIp], QUERY_TIMEOUT_MS)
      const parsed = JSON.parse(stdout) as RawWhois
      // Belt and braces: a tagged node has no user identity to accept.
      if ((parsed.Node?.Tags?.length ?? 0) > 0) return null
      const login = parsed.UserProfile?.LoginName?.trim()
      return login ? login.toLowerCase() : null
    } catch (err) {
      logger.warn(
        'tailscale-manager',
        `Could not resolve the node owner via whois: ${errText(err).slice(-200)}`
      )
      return null
    }
  }

  /**
   * `status --json --peers=false` — peers are irrelevant to us and a large
   * tailnet's peer list bloats the output. Falls back to plain `status --json`
   * if the installed CLI rejects `--peers`.
   */
  private async statusJson(binaryPath: string): Promise<string> {
    const args = ['status', '--json']
    if (this.supportsNoPeersFlag) args.push('--peers=false')
    try {
      return (await this.exec(binaryPath, args, QUERY_TIMEOUT_MS)).stdout
    } catch (err) {
      if (this.supportsNoPeersFlag && isUnknownFlag(errText(err))) {
        this.supportsNoPeersFlag = false
        return (await this.exec(binaryPath, ['status', '--json'], QUERY_TIMEOUT_MS)).stdout
      }
      throw err
    }
  }
}
