/**
 * Host-adapter contracts for the window-independent core (S2 extraction).
 *
 * `src/core` must not import Electron (lint-enforced once the extraction lands).
 * Anything that genuinely needs a host capability — the host's window handle,
 * the app's on-disk layout (`app.getAppPath`-class lookups), native OS
 * notifications — reaches it through the neutral shapes here and copes with
 * absence, exactly as `services/host-window.ts` already models the window
 * handle (read-at-use, tolerate `null`). The desktop shell wires the real
 * implementations in at boot (`src/main`); a non-Electron entrypoint wires its
 * own or leaves them unset, and the fallbacks below are the headless behaviour.
 *
 * This file is deliberately Electron-free (neutral `shared/types`, node built-ins
 * and the ambient `process`/`Buffer`), so it can live in `src/core` from the
 * moment it exists.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountsState, AccountRef, OAuthAccount } from '../shared/types'
import type { RelaunchAvailability, RelaunchResult } from '../shared/relaunch'
import type { BuildInfo, DevBuildInfo } from '../shared/build-info'
import type { UpdateTarget } from '../shared/update-manifest'
import type {
  AppUpdateEligibility,
  AppUpdateRebuildProgress,
  AppUpdateTree,
  AppUpdateTreeSummary
} from '../shared/types/app-update'

// ---------------------------------------------------------------------------
// Window handle
// ---------------------------------------------------------------------------

/**
 * The structural subset of Electron's `BrowserWindow` that the window-
 * independent modules actually touch — a delivery target for host-local
 * channels and a liveness check, nothing more. A real `BrowserWindow` is
 * assignable to this by construction; a test double provides the same two
 * members. Replacing the `type BrowserWindow` imports with this is what keeps
 * a window out of core's public API even when nothing is emitted at runtime.
 */
export interface HostWindowHandle {
  readonly webContents: {
    /**
     * Electron's webContents id. The desktop voice capture is keyed by it
     * (`voice-relay.ts` `desktopVoiceOwnerKey`), because the audio feed in main
     * only knows the IPC sender's id.
     */
    readonly id: number
    send(channel: string, ...args: unknown[]): void
    isDestroyed?(): boolean
  }
  isDestroyed(): boolean
  /**
   * The window-lifetime hook `terminal-service` uses to tear its shells down
   * when the host window closes. Only `'closed'` is consumed; a real
   * `BrowserWindow` satisfies this by construction.
   */
  on(event: 'closed', listener: () => void): void
}

// ---------------------------------------------------------------------------
// App paths (Electron's `app.getAppPath`)
// ---------------------------------------------------------------------------

/** What the movable modules need from Electron's `app` for on-disk layout. */
export interface HostPaths {
  /**
   * Electron's `app.getAppPath()` — the app root in dev, the `app.asar` path in
   * a packaged build. Engine binaries and the built web client are resolved
   * relative to it.
   */
  getAppPath(): string
}

let hostPaths: HostPaths | null = null

/**
 * Publish the host's path provider (or clear it). The desktop shell calls this
 * once, as early as its entrypoint loads, so no core module can observe an
 * unset provider on the spawn/serve path.
 */
export function setHostPaths(paths: HostPaths | null): void {
  hostPaths = paths
}

/**
 * The host app path, or `process.cwd()` when no host is wired — the exact
 * fallback the call sites (`sdk/locate`, `pi/pi-locate`, `OpencodeServerManager`,
 * `remote-server`) used inline before this seam existed, so a non-Electron
 * context (the vitest integration project, harness scripts) behaves as it did.
 */
export function getAppPath(): string {
  return hostPaths?.getAppPath() ?? process.cwd()
}

// ---------------------------------------------------------------------------
// Packaged-build flag (Electron's `app.isPackaged`)
// ---------------------------------------------------------------------------

let hostPackaged: (() => boolean) | null = null

/**
 * Publish "is this a packaged/production build" (or clear it). The desktop wires
 * `() => app.isPackaged`; the headless server wires `() => true`.
 */
export function setHostIsPackaged(probe: (() => boolean) | null): void {
  hostPackaged = probe
}

/**
 * Whether this is a packaged build. **Defaults to `false`** — i.e. "dev".
 *
 * The one consumer is the block-usage / reconciler startup in `session.ipc.ts`,
 * which SKIPS its background writes in dev so a dev instance cannot fight the
 * production instance over the same snapshot files. `false` is therefore the
 * conservative default: an unwired context (vitest, a harness script) writes
 * nothing, which is what it got before this seam existed. `claudeui-server`
 * wires `true` deliberately — a deployed server is not a dev build and its usage
 * history is the only one there is.
 */
export function hostIsPackaged(): boolean {
  return hostPackaged?.() ?? false
}

// ---------------------------------------------------------------------------
// Multi-account credential root (ADR-015)
// ---------------------------------------------------------------------------

let hostAccountsRoot: string | null = null

/**
 * Publish the directory holding the per-account credential dirs (or clear it).
 *
 * `AccountManager` owns `<root>/<localId>/.credentials.json` on the desktop and
 * the default below is that layout, so nothing has to wire this in production.
 * It exists because the ADR-071 §6 limits provider READS those directories for
 * accounts that are not active, and a test must be able to point that read at a
 * fixture tree instead of the real `~/.claude`.
 */
export function setHostAccountsDir(dir: string | null): void {
  hostAccountsRoot = dir
}

/** The per-account credential root — `~/.claude/ui/accounts` unless redirected. */
export function hostAccountsDir(): string {
  return hostAccountsRoot ?? join(homedir(), '.claude', 'ui', 'accounts')
}

// ---------------------------------------------------------------------------
// The build this process is (ADR-072 §5)
// ---------------------------------------------------------------------------

let hostVersion: string | null = null

/**
 * Publish the version string this host reports for itself.
 *
 * `app.getVersion()` is Electron-only and `src/main/index.ts` already derives
 * the display form from it (`Local Build` for a dev run), so this is the same
 * seam shape `setHostAccountsDir` uses: main publishes what only main can know,
 * and core reads it. The usage hub is the one consumer — ADR-072 §5 sends the
 * app version with each push so the hub's machine list can say which build a
 * device is on, which is how "two machines priced the same model differently"
 * becomes diagnosable rather than mysterious.
 */
export function setHostAppVersion(version: string | null): void {
  hostVersion = version
}

/** The host's version, or `unknown` when nothing published one (vitest, a script). */
export function hostAppVersion(): string {
  return hostVersion ?? 'unknown'
}

// ---------------------------------------------------------------------------
// The build id (remote clients reload when it changes)
// ---------------------------------------------------------------------------

let hostBuild: string | null = null

/**
 * Publish this host's build id (`buildId(readBuildInfo(...))` in
 * `src/shared/build-info.ts`), or null for a dev run. The remote server sends it
 * in every successful `auth-response`, so a web client that reconnects to a
 * different build reloads its page instead of running old JavaScript against a
 * new host.
 */
export function setHostBuildId(id: string | null): void {
  hostBuild = id
}

/** The host's build id, or null (a dev host, or nothing published). */
export function hostBuildId(): string | null {
  return hostBuild
}

// ---------------------------------------------------------------------------
// Relaunch (quit, and have a detached helper start this host again)
// ---------------------------------------------------------------------------

/**
 * What the `app:relaunch*` commands need from the host. The desktop wires its
 * relaunch service (`src/main/services/relaunch/`); the headless server sets
 * `null` until it has a monitor that can restart it (S5), so the commands answer
 * "not available" there rather than quitting a server nobody can start again.
 */
export interface HostRelaunch {
  /** Whether a relaunch can start now, and why not. */
  availability(): RelaunchAvailability
  /**
   * Start a relaunch: resolves once the helper is running and the quit is under
   * way; throws a clear error when refused (the host keeps running).
   */
  relaunch(): Promise<void>
  /** The newest relaunch result for this install, or null. */
  lastResult(): RelaunchResult | null
}

let hostRelaunchImpl: HostRelaunch | null = null

/** Publish the host's relaunch (or clear it). Wired in `boot-core`; the server sets null. */
export function setHostRelaunch(relaunch: HostRelaunch | null): void {
  hostRelaunchImpl = relaunch
}

/** The host's relaunch, or null when this host cannot relaunch itself. */
export function hostRelaunch(): HostRelaunch | null {
  return hostRelaunchImpl
}

// ---------------------------------------------------------------------------
// ClaudeUI's own updates (auto-update design §3)
// ---------------------------------------------------------------------------

/**
 * What differs per host for ClaudeUI's own updates. The core service
 * (`services/app-update.ts`) finds, verifies and downloads a release; staging
 * the archive and restarting into it are the host's. Unset (null), the service
 * reports `supported: false` and does nothing: no checks, no timers, no files.
 *
 * Errors any method throws are shown to every client (`app-update:state` is a
 * `config` read), so their messages must not carry local paths.
 */
export interface AppUpdateHost {
  /** The running build's identity (`services/build-info.ts`). */
  buildInfo(): BuildInfo | DevBuildInfo
  /** This host's manifest asset key (e.g. `desktop-darwin-arm64`), or null when none fits. */
  target(): UpdateTarget | null
  /** Whether an update can be applied here (writable install, not translocated, ...). */
  eligibility(): Promise<AppUpdateEligibility>
  /** Absolute directory the archives are downloaded into (under `~/.claude/ui/updates`). */
  downloadsDir(): string
  /** Extract a verified archive and run the platform checks; the id names the result. */
  stage(archivePath: string, version: string): Promise<{ stagedId: string }>
  /** Whether an earlier `stage` result is still there and valid (after a restart). */
  isStaged(stagedId: string, version: string): Promise<boolean>
  /** Restart into the staged build. */
  apply(stagedId: string, version: string): Promise<void>

  // ── Local rebuild (optional: the desktop only) ──────────────────────────────

  /** Whether a source checkout to rebuild from is known (cheap; read on every view). */
  rebuildAvailable?(): boolean
  /** The checkouts the host itself lists (never a client-supplied path); no paths in the result. */
  trees?(): Promise<AppUpdateTree[]>
  /**
   * Rebuild from the tree `treeId` names. Resolves once the pre-checks passed and
   * the build started (rejects with the reason one refused it); `done` settles
   * when the build is staged (the version and commit it carries) or failed. A
   * cancelled build rejects `done` with an error named `RebuildCancelled`.
   */
  rebuild?(
    treeId: string,
    onProgress: (progress: AppUpdateRebuildProgress) => void
  ): Promise<{
    tree: AppUpdateTreeSummary
    done: Promise<{ version: string; commit: string | null }>
  }>
  /** Stop a running rebuild by its process group (nothing staged); a no-op when none runs. */
  cancelRebuild?(): Promise<void>
  /**
   * Quitting: stop a running rebuild and refuse every later one, including one
   * still in its pre-checks (it would otherwise spawn a build that outlives the app).
   */
  stopRebuild?(): Promise<void>
  /** Restart into the build the last rebuild staged. */
  applyRebuild?(): Promise<void>
}

let hostAppUpdateImpl: AppUpdateHost | null = null

/** Publish the host's update seam (or clear it). Both hosts wire it before core starts. */
export function setHostAppUpdate(host: AppUpdateHost | null): void {
  hostAppUpdateImpl = host
}

/** The host's update seam, or null where this host cannot update itself. */
export function hostAppUpdate(): AppUpdateHost | null {
  return hostAppUpdateImpl
}

// ---------------------------------------------------------------------------
// Native directory picker
// ---------------------------------------------------------------------------

/**
 * Open the host's native folder picker; resolve to the chosen absolute path, or
 * `null` when the user cancelled.
 *
 * Backed by Electron's `dialog.showOpenDialog` on the desktop. There is no
 * headless implementation and there should never be one: the channel behind it
 * (`session:pick-folder`) declares the `host` capability, so it is unreachable
 * from any remote client by construction, and a server with no operator at its
 * console has no one to show a dialog to.
 */
export type HostPicker = () => Promise<string | null>

let hostPicker: HostPicker | null = null

/** Publish the native folder picker (or clear it). Wired in `boot-core`. */
export function setHostPicker(picker: HostPicker | null): void {
  hostPicker = picker
}

/** Pick a directory, or `null` when cancelled OR when no host picker is wired. */
export function pickHostDirectory(): Promise<string | null> {
  return hostPicker ? hostPicker() : Promise.resolve(null)
}

// ---------------------------------------------------------------------------
// Vendor-OAuth loopback listener
// ---------------------------------------------------------------------------

let hostOAuthLoopbackEnabled: boolean | null = null

/**
 * Publish whether this host can RECEIVE the vendor-OAuth redirect on its own
 * loopback (or clear it). The desktop wires `true` in `boot-core`: the browser
 * it opens runs on the same machine, so `http://localhost:1455/auth/callback`
 * lands on a listener this process owns.
 */
export function setHostOAuthLoopback(enabled: boolean | null): void {
  hostOAuthLoopbackEnabled = enabled
}

/**
 * Whether to bind the vendor-OAuth loopback listener. **Defaults to `false`** —
 * i.e. the headless behaviour, which is the point of this seam.
 *
 * The ChatGPT client is registered to the fixed `http://localhost:1455/auth/callback`
 * and the redirect URI cannot change (ADR-057), so on `claudeui-server` the
 * redirect lands on the REMOTE browser's own loopback, never on the server box.
 * A listener there would receive nothing, hold the fixed port for the flow's
 * five-minute timeout, and make two concurrent sign-ins collide on `EADDRINUSE`.
 * The code arrives by paste-back (`completeFromPastedInput`) or device code
 * instead, neither of which needs a port.
 */
export function hostOAuthLoopback(): boolean {
  return hostOAuthLoopbackEnabled ?? false
}

// ---------------------------------------------------------------------------
// Native notifications
// ---------------------------------------------------------------------------

/** A native OS notification request — the shape `automation-manager` emits. */
export interface HostNotification {
  title: string
  body: string
}

/**
 * Emit a native OS notification. The desktop shell backs this with Electron's
 * `Notification`; a headless deployment leaves it unset (no desktop to notify).
 */
export type HostNotifier = (notification: HostNotification) => void

// ---------------------------------------------------------------------------
// Account / Claude-auth reads (DATA ONLY — see the hard constraint below)
// ---------------------------------------------------------------------------

/**
 * The account-state reads the session graph needs from the desktop's auth
 * subsystem (`account-manager`, `ClaudeAuthProvider`), which STAYS in
 * `src/main` because it opens the OAuth browser (`shell.openExternal`) — a
 * host-physical flow the headless server gets its own vendor-OAuth for in a
 * later series.
 *
 * HARD CONSTRAINT: this is DATA ONLY. It exposes exactly the read/probe/report
 * operations below and MUST NOT grow a flow-initiating method (no sign-in, no
 * `openExternal`, no code submission). Those stay in `src/main`; a core module
 * that needs one is scope creep into the deferred headless-OAuth design.
 */
export interface HostAuth {
  /** `AccountManager.getState()` — multi-account enable flag + active id. */
  getAccountState(): AccountsState
  /** `ClaudeAuthProvider.buildClaudeAccountRef(id)` — the probe-cached account ref. */
  buildClaudeAccountRef(activeAccountId?: string | null): AccountRef
  /** `ClaudeAuthProvider.updateAuthSource(...)` — refresh the probe cache from cli.js init. */
  updateClaudeAuthSource(source: string, account?: OAuthAccount | null): void
  /**
   * `AuthManager.reportLoginStatus(account)` — publish the login status carried
   * by cli.js's `initialize` response, so the desktop's sign-in banner is
   * accurate before any chat session is opened (ADR-014).
   *
   * STATUS-ONLY, and within the DATA-ONLY constraint above: it REPORTS an
   * observation the engine already handed us. It initiates nothing, and the
   * broadcast it drives is a host-local window channel — which is exactly why a
   * headless server leaves it unimplemented rather than emulating it.
   */
  reportLoginStatus(account: unknown): void
}

let hostAuth: HostAuth | null = null

/** Publish the desktop auth reads (or clear them). Wired in `boot-core`. */
export function setHostAuth(auth: HostAuth | null): void {
  hostAuth = auth
}

/** Account state, or `null` when no host auth is wired (headless). */
export function accountState(): AccountsState | null {
  return hostAuth?.getAccountState() ?? null
}

/** The probe-cached account ref, or `null` when no host auth is wired. */
export function buildClaudeAccountRef(activeAccountId?: string | null): AccountRef | null {
  return hostAuth?.buildClaudeAccountRef(activeAccountId) ?? null
}

/** Forward a cli.js auth-source signal to the desktop provider (no-op when unwired). */
export function updateClaudeAuthSource(source: string, account?: OAuthAccount | null): void {
  hostAuth?.updateClaudeAuthSource(source, account)
}

/** Report cli.js's `initialize` login status to the host (no-op when unwired). */
export function reportHostLoginStatus(account: unknown): void {
  hostAuth?.reportLoginStatus(account)
}

// ---------------------------------------------------------------------------
// Mockup HTTP serving
// ---------------------------------------------------------------------------

/** The bytes + headers a mockup HTTP request resolves to (neutral shape). */
export interface HostMockupServed {
  status: number
  headers: Record<string, string>
  body: Buffer | string
}

/**
 * Resolve+serve a `/mockup` HTTP request. The desktop wires this to
 * `mockup-protocol`'s PURE `routeHttpMockup` + `serveMockup` (the Electron
 * `protocol.register*` half of that module stays desktop-only in `src/main`).
 */
export type HostMockup = (
  pathname: string,
  searchParams: URLSearchParams,
  selfSource: string
) => Promise<HostMockupServed>

let hostMockup: HostMockup | null = null

/** Publish the mockup HTTP server (or clear it). Wired in `boot-core`. */
export function setHostMockup(mockup: HostMockup | null): void {
  hostMockup = mockup
}

/** Serve a `/mockup` request, or `null` when no host mockup server is wired. */
export function serveHostMockup(
  pathname: string,
  searchParams: URLSearchParams,
  selfSource: string
): Promise<HostMockupServed> | null {
  return hostMockup ? hostMockup(pathname, searchParams, selfSource) : null
}
