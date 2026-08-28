/**
 * The Electron-free service graph — everything the app is, minus a host
 * (S3 stage 1b).
 *
 * ## What moved, and what did not
 *
 * This is `bootCore()`'s body. `src/main/boot-core.ts` used to construct the
 * whole graph AND wire `ipcMain`; it now wires only the host-shaped seams (the
 * desktop transport binder, the `HostAuth`/`HostMockup`/`HostPicker`/packaged
 * adapters, and the ten raw `remote:*` `ipcMain.handle` calls) and delegates
 * everything else here. `src/server/main.ts` wires its own adapters and calls
 * the same function. One service graph, two hosts.
 *
 * **The ORDER of this function is its contract.** The S3 kickoff proposed
 * splitting each registrar into a construction half and a registration half;
 * that is impossible here because the two are interleaved — `registerSessionIpc`
 * builds the manager, registers ~100 channels, then starts the git-watch
 * fan-out, the projects/config watchers, the canonical seed and the usage
 * poller, then registers nine more. Nothing below may be reordered, and the
 * whole point of moving the registrars WHOLE (rather than splitting them) is
 * that nothing had to be.
 *
 * ## The one hook, and why it exists
 *
 * `afterSessionGraph` fires at exactly one point: after the session manager and
 * the cross-engine wiring exist, and before `credentialSync.start()`. The
 * desktop uses it for the three steps that are genuinely its own —
 * `setLiveSessionCanceller`, `accountManager.init(null)` and
 * `claudeAuthProvider.init(null)` — and the ordering comment those carried is
 * why this is a hook rather than three more options: the canceller MUST be
 * registered before the two `init`s, since either can reach `persistAndApply` on
 * its first load. A caller that gets to choose the order would be a caller that
 * can get it wrong.
 */

import { registerSessionIpc } from '../ipc/session.ipc'
import { registerTerminalIpc } from '../ipc/terminal.ipc'
import { registerAutomationIpc } from '../ipc/automation.ipc'
import { registerWebauthnIpc } from '../ipc/webauthn.ipc'
import { registerAuthcfgIpc } from '../ipc/authcfg.ipc'
import { registerRemoteViewIpc } from '../ipc/remote-view-commands'
import { registerRemoteHandlers } from '../ipc/remote-handlers'
import { RemoteServer } from '../services/remote-server'
import { RemoteDispatcher } from '../services/remote-dispatcher'
import { TailscaleManager } from '../services/tailscale-manager'
import { terminalService } from '../services/terminal-service'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { crossEngineDispatcher } from '../services/cross-engine-dispatcher'
import { credentialSync } from '../auth/vault/CredentialSync'
import { sharedProviderService } from '../shared-providers'
import { logger } from '../services/logger'
import { createHostAnchor, type HostAnchor } from './host-anchor'
import type { CommandConnection } from '../ipc/command-registry'
import type { HostNotifier } from '../host'
import type { AuthCommandDeps } from '../ipc/auth-commands'
import type { AutomationManager } from '../services/automation-manager'
import type { SessionManager } from '../services/session-manager'

/** What core hands back so a host layer can attach to it. */
export interface CoreServices {
  sessionManager: SessionManager
  remoteServer: RemoteServer
  remoteDispatcher: RemoteDispatcher
  tailscaleManager: TailscaleManager
  automationManager: AutomationManager
  /** Remote-server administration (start/stop/config/password/tailscale). */
  hostAnchor: HostAnchor
}

export interface CoreServicesOptions {
  /**
   * Remote-access kill switch for SECONDARY instances (the Playwright verifier,
   * evals). The listener owns machine-global state — a pinned TCP port and the
   * host's `tailscale serve` config — so a harness instance must never
   * reconcile, autostart or force-reserve.
   */
  remoteAccessDisabled: boolean
  /**
   * The desktop-auth capabilities the `auth:*` / `account:*` / `vendor-auth:*`
   * family needs. Injected because that subsystem stays in `src/main` (it opens
   * the OAuth browser), so the Electron-free registrars must never import it.
   */
  authDeps: AuthCommandDeps
  /** Native OS notifications for automation runs. Omitted headless. */
  notifier?: HostNotifier
  /**
   * Run the serve-record reconciliation + configured autostart (ADR-042).
   *
   * The desktop passes `true`: autostart is a user setting and the reconcile
   * must happen on every launch to clear a leaked `tailscale serve` entry.
   * `claudeui-server` passes `false` and starts the listener itself, from its
   * CLI arguments — a server whose entire purpose is to listen must not have
   * that decision made for it by a persisted checkbox.
   */
  autostart: boolean
  /**
   * WHICH host surface this process is, for the host anchor's audit rows.
   *
   * Both values carry `method: 'host'` — the anchor is the host's own surface in
   * either deployment — so this selects the row's LABEL. The desktop takes the
   * default (`desktop-renderer`); `claudeui-server` passes
   * `hostConnection('server-console')`, because a headless box has no renderer and
   * a row naming one would misattribute.
   */
  hostActor?: CommandConnection
  /** See the module header — fires between the session graph and credential sync. */
  afterSessionGraph?: (manager: SessionManager) => void
}

/**
 * Construct the window-independent service graph and register every command.
 * Call ONCE per process.
 */
export function startCoreServices(options: CoreServicesOptions): CoreServices {
  const { remoteAccessDisabled, authDeps, notifier, autostart, hostActor, afterSessionGraph } =
    options

  // Sessions, config, git, usage, the canonical seeds and the file watchers.
  // Takes no window since 4d — see registerSessionIpc's doc comment.
  const sessionManager = registerSessionIpc(authDeps)

  // Cross-engine dispatch (ADR-033 M2, opencode → Claude): thread the
  // caller-session lookup + dispatch function into OpencodeServerManager
  // from HERE rather than importing sessionManager/crossEngineDispatcher
  // inside opencode-hosted-tools.ts or OpencodeServerManager.ts directly —
  // either import would form a require-cycle (see the cycle note on
  // CallerSessionLookup in opencode-hosted-tools.ts). This module sits above
  // both cycles, so it's the one safe place to close the loop.
  opencodeServerManager.setCallerSessionLookup((sessionId) => {
    const session = sessionManager.get(sessionId)
    if (!session || session.engineId !== 'opencode') return undefined
    return {
      cwd: session.cwd,
      autonomyMode: session.getAutonomyMode?.() ?? 'default',
      emit: (channel, data) => session.emit(channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        session.addDispatchedCost(engineId, modelId, costUsd)
    }
  })
  opencodeServerManager.setDispatchAgent((req, ctx) => crossEngineDispatcher.dispatch(req, ctx))

  // The host's own post-session wiring — see the module header for why this is
  // one ordered hook rather than several options.
  afterSessionGraph?.(sessionManager)

  // Reconcile central credentials first, then materialize all shared-provider
  // routes. Both are best-effort and must never block app startup.
  void (async () => {
    try {
      await credentialSync.start()
    } catch (err) {
      logger.warn(
        'main',
        `credentialSync.start() failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    try {
      await sharedProviderService.syncAll()
    } catch (err) {
      logger.warn(
        'main',
        `sharedProviderService.syncAll() failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })()

  registerTerminalIpc()

  const automationManager = registerAutomationIpc(notifier)

  // ── Remote access server ───────────────────────────────────────────
  const remoteDispatcher = new RemoteDispatcher()
  // ONE TailscaleManager shared between the server and the detect IPC, so the
  // binary/version cache is coherent (and Settings' pre-flight probe sees exactly
  // what a TLS-mode start will see).
  const tailscaleManager = new TailscaleManager()
  const remoteServer = new RemoteServer(remoteDispatcher, undefined, tailscaleManager)
  // Multi-attach delivery path (SyncCore phase 2): the pty manager hands frames
  // for attached remote connections to THIS server's sink.
  terminalService.setRemoteSink(remoteServer.terminalSink())
  // The 4th arg wires the vendor-OAuth / account / native-OAuth family (S4,
  // ADR-057) onto the remote transport — the desktop-auth subsystem stays in
  // `src/main`, so its registry + account manager are injected here rather than
  // imported by the (Electron-free) core registrar.
  registerRemoteHandlers(remoteDispatcher, sessionManager, remoteServer, authDeps)
  // Passkey management on the desktop transport (ADR-052). Separate call because
  // the ceremony verbs are remote-only — see webauthn.ipc.ts.
  registerWebauthnIpc(remoteServer)
  // Remote-access settings on the desktop transport (ADR-054 decision 6). The
  // `off` master switch is NOT among them — it stays on the host anchor, which
  // has no remote registration at all.
  registerAuthcfgIpc(remoteServer)
  // The redacted status read on the desktop transport (owner ruling,
  // 2026-08-28). Registered here rather than inside `registerSessionIpc`
  // because the server it reads does not exist until this point; the remote
  // half is spread from the same declaration in `registerRemoteHandlers`.
  registerRemoteViewIpc(remoteServer)

  const hostAnchor = createHostAnchor({
    remoteServer,
    tailscaleManager,
    remoteAccessDisabled,
    actor: hostActor
  })

  // Autostart: fire-and-forget so a listen failure (e.g. EADDRINUSE from a
  // stale previous instance) never blocks or crashes app startup. The error
  // reaches the UI through RemoteStatus.lastError (set by RemoteServer.start's
  // catch block), not through this try/catch — this one is just a backstop
  // logger so an unexpected throw (not a listen failure) doesn't go silent.
  //
  // A remote-disabled instance skips the WHOLE block, reconciliation included:
  // reconcileServeRecord() cannot tell "leaked record from a previous run" from
  // "record owned by the live primary instance", so running it here would tear
  // down the primary app's serve entry.
  if (remoteAccessDisabled) {
    logger.info(
      'main',
      'Remote access disabled for this instance (CLAUDEUI_DISABLE_REMOTE) — skipping serve reconciliation and autostart'
    )
  } else if (autostart) {
    void (async () => {
      try {
        await hostAnchor.reconcileAndAutostart()
      } catch (err) {
        logger.error(
          'main',
          `Remote server autostart failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })()
  }

  return {
    sessionManager,
    remoteServer,
    remoteDispatcher,
    tailscaleManager,
    automationManager,
    hostAnchor
  }
}
