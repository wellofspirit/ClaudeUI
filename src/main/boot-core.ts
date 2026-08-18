/**
 * The DESKTOP host layer — Electron's half of the boot (S3 stage 1b).
 *
 * ## What this file is now
 *
 * Until S3 it was the whole composition root: it constructed every service AND
 * wired `ipcMain`. The service graph moved to `src/core/boot/core-services.ts`,
 * which is Electron-free, so `claudeui-server` can construct exactly the same
 * graph. What is left here is precisely the part that is Electron:
 *
 *   1. the desktop TRANSPORT BINDER — the adapter that turns a registry
 *      registration into an `ipcMain.handle` (`ipc/desktop-transport.ts`);
 *   2. the HOST ADAPTERS — account/auth reads, the mockup server, the native
 *      folder picker, `app.isPackaged`, native notifications;
 *   3. the desktop's own post-session wiring (`setLiveSessionCanceller` and the
 *      two auth `init`s), handed to core as its one ordered hook;
 *   4. the ten raw `remote:*` `ipcMain.handle` calls — the HOST ANCHOR. Their
 *      bodies moved to `core/boot/host-anchor.ts` (the console needs them too);
 *      what stays here is the ipcMain registration, which is the only part that
 *      was ever desktop-specific.
 *
 * ## The rule this file still encodes
 *
 * Nothing here may CAPTURE a window. Whatever genuinely wants the host's window
 * reads it from `services/host-window.ts` at use time (`session:pick-folder`'s
 * dialog parent, a session's voice handle) and copes with `null`. That is what
 * makes the boot order — core, then maybe a window — expressible at all.
 */

import { app, dialog, ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { installDesktopTransport } from './ipc/desktop-transport'
import { startCoreServices } from '../core/boot/core-services'
import type { RemoteConfigPatch } from '../core/boot/host-anchor'
import { RemoteServer } from '../core/services/remote-server'
import { RemoteDispatcher } from '../core/services/remote-dispatcher'
import './auth/register-auth-providers'
import { accountManager } from './services/account-manager'
import { authManager } from './services/auth-manager'
import { setLiveSessionCanceller, cancelClaudeSessions } from './services/session-invalidation'
import { claudeAuthProvider } from './auth/ClaudeAuthProvider'
import { engineAuthRegistry } from './auth/EngineAuthRegistry'
import { getHostWindow } from '../core/services/host-window'
import { setHostAuth, setHostIsPackaged, setHostMockup, setHostPicker } from '../core/host'
import { routeHttpMockup, serveMockup } from './services/mockup-protocol'
import type { SessionManager } from '../core/services/session-manager'
import type { AutomationManager } from '../core/services/automation-manager'
import type { TailscaleDetection } from '../shared/types'

/** What core hands back so the (optional) window layer can attach to it. */
export interface CoreBoot {
  sessionManager: SessionManager
  remoteServer: RemoteServer
  remoteDispatcher: RemoteDispatcher
  automationManager: AutomationManager
}

export interface BootCoreOptions {
  /**
   * Remote-access kill switch for SECONDARY instances (the Playwright verifier,
   * evals). The listener owns machine-global state — a pinned TCP port and the
   * host's `tailscale serve` config — so a harness instance must never
   * reconcile, autostart or force-reserve. See index.ts's comment.
   */
  remoteAccessDisabled: boolean
}

/** The `remote:*` channels, cleared before re-registering (idempotent boot). */
const HOST_ANCHOR_CHANNELS = [
  'remote:interfaces',
  'remote:start',
  'remote:stop',
  'remote:status',
  'remote:get-config',
  'remote:set-config',
  'remote:set-password',
  'remote:clear-password',
  'remote:tailscale-detect',
  'remote:force-reserve'
]

/**
 * Boot the window-independent half of the app. Call ONCE, from
 * `app.whenReady()`, before deciding whether to make a window.
 */
export function bootCore({ remoteAccessDisabled }: BootCoreOptions): CoreBoot {
  // The desktop transport adapter. Installed FIRST, before any registrar runs —
  // a channel registered while no binder is installed would land in the registry
  // with no `ipcMain` handler behind it, and the renderer would see "no handler
  // for '<channel>'".
  installDesktopTransport()

  // Desktop implementations of the core host-adapter seams (S2 + S3). Wired
  // before any session or the HTTP server is constructed, so the extracted
  // (Electron-free) core reads account state, serves `/mockup`, opens a native
  // picker and knows whether this is a packaged build through these instead of
  // importing the Electron-bound modules directly.
  //
  // HostAuth is DATA/STATUS-ONLY: state reads, the probe-cache refresh, and the
  // login-status report. The OAuth-browser flow stays in
  // account-manager/ClaudeAuthProvider (src/main).
  setHostAuth({
    getAccountState: () => accountManager.getState(),
    buildClaudeAccountRef: (id) => claudeAuthProvider.buildAccountRef(id),
    updateClaudeAuthSource: (source, account) =>
      claudeAuthProvider.updateAuthSource(source, account),
    reportLoginStatus: (account) => authManager.reportLoginStatus(account)
  })
  // HostMockup composes mockup-protocol's PURE route+serve; the Electron
  // `protocol.register*` half stays desktop-only (registered from index.ts).
  setHostMockup((pathname, searchParams, selfSource) =>
    serveMockup(routeHttpMockup(pathname, searchParams), selfSource)
  )
  // The native folder picker behind `session:pick-folder` (`host` capability, so
  // desktop-only by construction). A windowless boot has no window to parent the
  // dialog to, and Electron's overload set makes that a different call rather
  // than a nullable arg — which is exactly why this lives here and not in core.
  // The host window is a real `BrowserWindow` at runtime (createWindow publishes
  // it) even though the neutral `HostWindowHandle` seam narrows what
  // `getHostWindow()` advertises.
  setHostPicker(async () => {
    const win = getHostWindow() as BrowserWindow | null
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  setHostIsPackaged(() => app.isPackaged)

  // The desktop-auth dependencies the `auth:*` / `account:*` / `vendor-auth:*`
  // family needs on BOTH transports. `engineAuthRegistry` is populated by the
  // `register-auth-providers` side-effect import above — which moved here from
  // session.ipc.ts when that file left `src/main`, since it wires the
  // Electron-bound providers.
  const authDeps = {
    requireEngineAuth: (engineId: Parameters<typeof engineAuthRegistry.require>[0]) =>
      engineAuthRegistry.require(engineId),
    setAccountEnabled: (enabled: boolean) => accountManager.setEnabled(enabled)
  }

  const core = startCoreServices({
    remoteAccessDisabled,
    authDeps,
    // Desktop native-notification sink for automation runs.
    notifier: (notification) => {
      new Notification({ ...notification, silent: false }).show()
    },
    // The desktop honours the persisted autostart checkbox + the ADR-042
    // serve-record reconciliation.
    autostart: true,
    afterSessionGraph: (sessionManager) => {
      // An account switch or a fresh Claude login invalidates the credential
      // every running CLAUDE process cached, so both paths stop those processes
      // MAIN-side (services/session-invalidation.ts). Registered BEFORE the two
      // `init`s below, since either can reach `persistAndApply` on its first
      // load.
      //
      // The POLICY (claude only, `cancel` not `cancelAll`) lives in that module
      // with the reasoning; this is only the wiring that hands it the manager.
      setLiveSessionCanceller(() => cancelClaudeSessions(sessionManager))

      // Account + Claude-auth wiring. Process lifetime, and window-free: what a
      // headless session needs from AccountManager is `applyActive()` (the spawn
      // env of the active account), not the two host-local broadcasts.
      // `createWindow()` re-runs the trio with a real window —
      // AuthManager.setWindow resets the login-success subscribers per window
      // generation and the two `init`s re-register them (C-6), so re-running is
      // the contract, not a duplication.
      accountManager.init(null)
      claudeAuthProvider.init(null)
    }
  })

  // ── The HOST ANCHOR on ipcMain ─────────────────────────────────────
  //
  // These ten channels are registered on NEITHER transport — no entry in the
  // command registry at all — which is what makes them unreachable from any
  // remote client by construction (ADR-039/042). Their BODIES live in
  // `core/boot/host-anchor.ts` because `claudeui-server` needs the same
  // operations from its console; only this ipcMain registration is desktop.
  //
  // Idempotent, like every other register* in the tree: production boots core
  // exactly once, but a test that boots twice must not hit Electron's "second
  // handler for '<channel>'" throw.
  const anchor = core.hostAnchor
  for (const ch of HOST_ANCHOR_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.handle('remote:interfaces', () => anchor.interfaces())
  ipcMain.handle(
    'remote:start',
    async (_e, opts?: { port?: number; host?: string; tunnel?: boolean }) => anchor.start(opts)
  )
  ipcMain.handle('remote:stop', () => anchor.stop())
  ipcMain.handle('remote:status', () => anchor.status())
  // remote:get-config NEVER returns password_salt/password_hash/kdf_params —
  // only a passwordSet boolean.
  ipcMain.handle('remote:get-config', () => anchor.getConfig())
  ipcMain.handle('remote:set-config', (_e, partial: RemoteConfigPatch) => anchor.setConfig(partial))
  ipcMain.handle('remote:set-password', (_e, password: string) => anchor.setPassword(password))
  ipcMain.handle('remote:clear-password', () => anchor.clearPassword())
  // The explicit return type is the compile-time link between the manager's
  // union and the shared one the renderer consumes.
  ipcMain.handle('remote:tailscale-detect', async (): Promise<TailscaleDetection> =>
    anchor.tailscaleDetect()
  )
  ipcMain.handle('remote:force-reserve', async (): Promise<void> => anchor.forceReserve())

  return {
    sessionManager: core.sessionManager,
    remoteServer: core.remoteServer,
    remoteDispatcher: core.remoteDispatcher,
    automationManager: core.automationManager
  }
}
