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
 * This file is deliberately Electron-free (only neutral `shared/types` and the
 * ambient `process`/`Buffer`), so it can live in `src/core` from the moment it
 * exists.
 */

import type { AccountsState, AccountRef, OAuthAccount } from '../shared/types'

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
