/**
 * Core boot — everything the app needs that does NOT need a window
 * (SyncCore phase 4d; ADR-051).
 *
 * ## Why this file exists
 *
 * Until 4d the entire service graph was constructed inside `createWindow()`:
 * `registerSessionIpc(win)` (and with it the canonical seeds, the config/projects
 * watchers, usage polling and every session/git/config channel), the remote
 * HTTP+WS server and its autostart, the terminal registration, the automation
 * manager. All of it was reachable only by making a `BrowserWindow` first — so
 * "the app runs with no window", the last phase-4 exit criterion, was not
 * something the code could even express. (`index.ts` carried a standing
 * `TODO(audit)` saying exactly that.)
 *
 * `bootCore()` runs from `app.whenReady()` BEFORE any window decision, and
 * `createWindow()` becomes purely ADDITIVE: the port hand-off, the host-local
 * delivery target, window chrome, plugins, the log viewer. With
 * `CLAUDEUI_NO_WINDOW=1` the window step is skipped entirely and core still
 * seeds canonical state, serves `sync-full`, spawns sessions and streams events
 * to WebSocket clients.
 *
 * ## The rule this file encodes
 *
 * Nothing here may CAPTURE a window. Whatever genuinely wants the host's window
 * reads it from `services/host-window.ts` at use time (`session:pick-folder`'s
 * dialog parent, a session's voice handle) and copes with `null`. That is what
 * makes the boot order — core, then maybe a window — expressible at all.
 *
 * Electron is still imported (`ipcMain`, `app`): this is the desktop shell's
 * core boot, not the future `claudeui-server` entrypoint. Physically extracting
 * `src/core` and adding a bun entrypoint is the named follow-on phase
 * (docs/architecture/sync-core.md §Follow-ons); the Electron-free fence that
 * keeps that a MOVE rather than a rewrite is already enforced on
 * `src/main/sync/**` + `src/shared/sync/**`.
 */

import { ipcMain } from 'electron'
import { registerSessionIpc } from './ipc/session.ipc'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerAutomationIpc } from './ipc/automation.ipc'
import { registerRemoteHandlers } from './ipc/remote-handlers'
import { RemoteServer, getNetworkInterfaces } from './services/remote-server'
import { RemoteDispatcher } from './services/remote-dispatcher'
import { TailscaleManager } from './services/tailscale-manager'
import { terminalService } from './services/terminal-service'
import { opencodeServerManager } from './opencode/OpencodeServerManager'
import { crossEngineDispatcher } from './services/cross-engine-dispatcher'
import { credentialSync } from './auth/vault/CredentialSync'
import { sharedProviderService } from './shared-providers'
import { accountManager } from './services/account-manager'
import { setLiveSessionCanceller, cancelClaudeSessions } from './services/session-invalidation'
import { claudeAuthProvider } from './auth/ClaudeAuthProvider'
import { logger } from './services/logger'
import {
  MIN_AUDIT_RETENTION_DAYS,
  REMOTE_AUTH_POLICIES,
  STEP_UP_TIERS,
  getRemoteConfig,
  setRemoteConfig as dbSetRemoteConfig,
  clearRemotePassword
} from './services/db'
import {
  auditAuthPolicyChange,
  authSurfaceChanged,
  describeAuthSurfaceChange
} from './services/auth-policy'
import { sanitizedRemoteConfig } from './services/remote-config-view'
import { registerWebauthnIpc } from './ipc/webauthn.ipc'
import { registerAuthcfgIpc } from './ipc/authcfg.ipc'
import { MAX_SESSION_MAX_AGE_HOURS } from './services/step-up-tier'
import { desktopConnection } from './ipc/command-registry'
import { provisionPassword } from './services/remote-auth'
import type { SessionManager } from './services/session-manager'
import type { RemoteAuthPolicy, StepUpTier, TailscaleDetection } from '../shared/types'

/** What core hands back so the (optional) window layer can attach to it. */
export interface CoreBoot {
  sessionManager: SessionManager
  remoteServer: RemoteServer
  remoteDispatcher: RemoteDispatcher
  automationManager: ReturnType<typeof registerAutomationIpc>
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

// `sanitizedRemoteConfig` moved to `services/remote-config-view.ts` when
// `authcfg:get` became its second reader (ADR-054 series 2). Both transports
// must answer with the SAME object — the settings components are shared and
// branch only on transport for writes — and a second sanitizer would be a
// second place to forget a field.

/**
 * Boot the window-independent half of the app. Call ONCE, from
 * `app.whenReady()`, before deciding whether to make a window.
 */
export function bootCore({ remoteAccessDisabled }: BootCoreOptions): CoreBoot {
  // Sessions, config, git, usage, the canonical seeds and the file watchers.
  // Takes no window since 4d — see registerSessionIpc's doc comment.
  const sessionManager = registerSessionIpc()

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

  // An account switch or a fresh Claude login invalidates the credential every
  // running CLAUDE process cached, so both paths stop those processes MAIN-side
  // (services/session-invalidation.ts). Wired from here for the same reason the
  // opencode lookup above is: this module owns the manager and sits above both
  // import cycles. Registered BEFORE the two `init`s below, since either can
  // reach `persistAndApply` on its first load.
  //
  // The POLICY (claude only, `cancel` not `cancelAll`) lives in that module with
  // the reasoning; this is only the wiring that hands it the manager.
  setLiveSessionCanceller(() => cancelClaudeSessions(sessionManager))

  // Account + Claude-auth wiring. Process lifetime, and window-free: what a
  // headless session needs from AccountManager is `applyActive()` (the spawn env
  // of the active account), not the two host-local broadcasts. `createWindow()`
  // re-runs the trio with a real window — AuthManager.setWindow resets the
  // login-success subscribers per window generation and the two `init`s
  // re-register them (C-6), so re-running is the contract, not a duplication.
  accountManager.init(null)
  claudeAuthProvider.init(null)

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

  const automationManager = registerAutomationIpc()

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
  registerRemoteHandlers(remoteDispatcher, sessionManager, remoteServer)
  // Passkey management on the desktop transport (ADR-052). Separate call because
  // the ceremony verbs are remote-only — see webauthn.ipc.ts.
  registerWebauthnIpc(remoteServer)
  // Remote-access settings on the desktop transport (ADR-054 decision 6). The
  // `off` master switch is NOT among them — it stays in `remote:set-config`
  // below, which has no remote registration at all.
  registerAuthcfgIpc(remoteServer)

  // Idempotent registration, like every other register* in the tree: production
  // boots core exactly once, but a test that boots twice must not hit Electron's
  // "second handler for '<channel>'" throw.
  for (const ch of [
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
  ]) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.handle('remote:interfaces', () => {
    return getNetworkInterfaces()
  })
  ipcMain.handle(
    'remote:start',
    async (_e, opts?: { port?: number; host?: string; tunnel?: boolean }) => {
      // Harness instances never bring the listener up: the port and the
      // `tailscale serve` config it would claim belong to the primary app.
      if (remoteAccessDisabled) {
        throw new Error(
          'Remote access is disabled in this instance (CLAUDEUI_DISABLE_REMOTE=1 / --disable-remote)'
        )
      }
      // Fixed port/bind-host now come from the persisted config so a
      // configured port takes effect on every start, not just autostart.
      // `opts.host` (from the modal's interface picker) still overrides the
      // persisted bind host for a one-off start; `opts.port` is intentionally
      // NOT consulted here — the modal never sends one, and the persisted
      // port is the single source of truth for "what port do we listen on".
      const config = getRemoteConfig()
      const port = config?.port ?? 0
      const host = opts?.host ?? config?.bindHost ?? undefined
      // TLS mode is a persisted setting, not a per-start option — but the tunnel
      // still wins (RemoteServer enforces the mutual exclusion). A serve failure
      // does NOT fail this call (ADR-042): the loopback listener stays up and the
      // reason travels in `RemoteStatus.tls.serveError`, which the modal shows and
      // the app-level banner offers a one-click Force re-serve for. Only a listen
      // failure (e.g. EADDRINUSE) rejects here.
      return await remoteServer.start(port, host, {
        tunnel: opts?.tunnel,
        tls: (config?.tlsMode ?? 0) === 1
      })
    }
  )
  ipcMain.handle('remote:stop', () => {
    // Deliberately NOT awaited: every state change the renderer cares about has
    // already happened synchronously, while the promise only tracks socket
    // handles closing — which a hostile or sleeping peer can drag out. The
    // renderer therefore never sees a teardown failure, so log it here.
    remoteServer.stop().catch((err: unknown) => {
      logger.error(
        'boot-core',
        `Remote server teardown failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  })
  ipcMain.handle('remote:status', () => {
    return remoteServer.getStatus()
  })

  // Remote-server config + credential IPC (Phase 1 of remote auth). Desktop-
  // renderer-only: all four channels are `admin`-capability and are
  // never registered on the remote dispatcher (remote-handlers.ts), so a
  // remote client can never reach them. remote:get-config NEVER returns
  // password_salt/password_hash/kdf_params — only a passwordSet boolean.
  ipcMain.handle('remote:get-config', () => sanitizedRemoteConfig())
  ipcMain.handle(
    'remote:set-config',
    (
      _e,
      partial: {
        port?: number
        bindHost?: string | null
        autostart?: boolean
        tlsMode?: number
        tlsHttpsPort?: number
        allowTerminal?: boolean
        shellGrantIdleMinutes?: number
        authPolicy?: RemoteAuthPolicy | null
        passwordBreakGlass?: boolean
        passkeyTailnetExempt?: boolean
        stepUpTier?: StepUpTier
        stepUpMutationIdleMinutes?: number
        sessionMaxAgeHours?: number
        auditRetentionDays?: number
      }
    ) => {
      if (partial.port !== undefined && partial.port !== 0) {
        if (partial.port < 1024 || partial.port > 65535) {
          throw new Error('Port must be 0 (random) or between 1024 and 65535')
        }
      }
      // Grant decay is the whole point of the window (ADR-052 decision 5), so 0
      // ("never expires") is not offered; a day is the outer bound before the
      // ceremony stops meaning anything.
      if (partial.shellGrantIdleMinutes !== undefined) {
        if (
          !Number.isInteger(partial.shellGrantIdleMinutes) ||
          partial.shellGrantIdleMinutes < 1 ||
          partial.shellGrantIdleMinutes > 1440
        ) {
          throw new Error('Terminal grant timeout must be between 1 and 1440 minutes')
        }
      }
      // Unlike the local listen port, 0 is NOT allowed: `tailscale serve` binds
      // one concrete HTTPS port and the whole point of pinning it (ADR-042) is a
      // stable bookmark. Any other uint16 is accepted — the CLI takes any port;
      // 443/8443/10000 is only the Funnel-compatible triple.
      if (partial.tlsHttpsPort !== undefined) {
        if (
          !Number.isInteger(partial.tlsHttpsPort) ||
          partial.tlsHttpsPort < 1 ||
          partial.tlsHttpsPort > 65535
        ) {
          throw new Error('Tailscale HTTPS port must be between 1 and 65535')
        }
      }
      // The auth policy is writable ONLY here (ADR-052 decision 3 / security.md
      // §Policy modes). This channel is `admin`-pinned AND has no remote
      // registration at all — `registerRemoteHandlers` never touches `remote:*`
      // — so `off` is unreachable from any remote client by construction, and
      // `remote-handlers.ipc.test.ts` pins that absence.
      if (partial.authPolicy !== undefined && partial.authPolicy !== null) {
        if (!REMOTE_AUTH_POLICIES.includes(partial.authPolicy)) {
          throw new Error(
            `Unknown remote auth policy "${String(partial.authPolicy)}" — expected one of ${REMOTE_AUTH_POLICIES.join(', ')}`
          )
        }
      }
      // ADR-054's second axis. This handler keeps writing EVERYTHING — it is the
      // host anchor, so unlike `authcfg:apply` it has no refusals to make.
      if (partial.stepUpTier !== undefined && !STEP_UP_TIERS.includes(partial.stepUpTier)) {
        throw new Error(
          `Unknown step-up tier "${String(partial.stepUpTier)}" — expected one of ${STEP_UP_TIERS.join(', ')}`
        )
      }
      // Same reasoning as `shellGrantIdleMinutes`: freshness is the point, so 0
      // ("never expires") is not on offer, and a day is the outer bound before
      // the proof stops meaning anything.
      if (partial.stepUpMutationIdleMinutes !== undefined) {
        if (
          !Number.isInteger(partial.stepUpMutationIdleMinutes) ||
          partial.stepUpMutationIdleMinutes < 1 ||
          partial.stepUpMutationIdleMinutes > 1440
        ) {
          throw new Error('Mutation step-up timeout must be between 1 and 1440 minutes')
        }
      }
      // Ceiling is ONE WEEK, not a month: the budget becomes a `setTimeout`
      // delay, and `setTimeout` takes a signed 32-bit int — a value above
      // ~24.8 days wraps and fires on the next tick, cutting every strong-tier
      // socket at accept and turning the client's reconnect loop into a
      // self-inflicted outage. `sessionMaxAgeMs` clamps to the same ceiling for
      // rows written before this validation existed, and `armMaxAgeCut` guards
      // the arithmetic once more.
      if (partial.sessionMaxAgeHours !== undefined) {
        if (
          !Number.isInteger(partial.sessionMaxAgeHours) ||
          partial.sessionMaxAgeHours < 1 ||
          partial.sessionMaxAgeHours > MAX_SESSION_MAX_AGE_HOURS
        ) {
          throw new Error(
            `Session max age must be between 1 and ${MAX_SESSION_MAX_AGE_HOURS} hours`
          )
        }
      }
      // The 30-day FLOOR is enforced here as well as on read — retention is now
      // web-settable, and a trail that can be erased by the session under
      // investigation is not a trail.
      if (partial.auditRetentionDays !== undefined) {
        if (
          !Number.isInteger(partial.auditRetentionDays) ||
          partial.auditRetentionDays < MIN_AUDIT_RETENTION_DAYS ||
          partial.auditRetentionDays > 36_500
        ) {
          throw new Error(
            `Audit retention must be between ${MIN_AUDIT_RETENTION_DAYS} and 36500 days`
          )
        }
      }
      const before = sanitizedRemoteConfig()
      dbSetRemoteConfig(partial)
      const after = sanitizedRemoteConfig()
      // ANY auth-surface change — the policy mode, the step-up tier, the
      // break-glass toggle, or the tailnet exemption — is audited AND drops
      // every live remote socket.
      //
      // Both halves matter and are deliberately one branch. The audit is what
      // makes the change traceable after the fact rather than only visible while
      // a banner is up (security.md §Audit). The disconnect is what makes it
      // TAKE EFFECT: policy, grants, origin capability and tier are snapshotted
      // per connection, so without it a tightened policy would not reach anyone
      // already connected until they happened to reconnect. Auditing a change
      // that nobody was re-authenticated for would be a trail that lies.
      //
      // WHY THIS IS NOT `withAuthSurfaceReaction` (the shared writer the
      // credential and `authcfg:*` paths both use). Deliberate, not an oversight.
      //
      // The three things that must never drift between the paths are already
      // shared functions: the PREDICATE (`authSurfaceChanged`), the detail
      // FORMATTING (`describeAuthSurfaceChange`), and the single audit-row
      // writer (`auditAuthPolicyChange`). What is local here is only the
      // orchestration, and it is local because this path owes two obligations
      // the helper does not model: the `off`-specific startup-grade WARNING, and
      // returning the `after` snapshot as the IPC result. Both need the SAME
      // before/after pair the reaction decides on. Routing through the helper
      // would therefore mean either snapshotting twice — leaving the warning
      // deciding on a different pair than the disconnect, which is precisely the
      // drift consolidation exists to prevent — or widening the helper's
      // contract to hand back a pair that only one of its three callers wants.
      //
      // The other asymmetry is real too: this path compares
      // `sanitizedRemoteConfig()` (what the renderer is shown and what this
      // handler returns), while the helper compares `readAuthSurface()`. Same
      // values, different readers; making them one reader is a worthwhile
      // follow-on, but it is a change to what the desktop settings pane sees and
      // does not belong in a step-up-tier change.
      if (authSurfaceChanged(before, after)) {
        // ONE row writer, shared with the credential path (`webauthn:register-
        // verify` / `:revoke`), so an audit reader never has to know which of
        // the two produced a given row.
        const moved = describeAuthSurfaceChange(before, after)
        auditAuthPolicyChange(
          desktopConnection(),
          moved ? `${moved} (via remote:set-config on the host anchor)` : null
        )
        if (after.effectiveAuthPolicy === 'off') {
          logger.warn(
            'main',
            'REMOTE AUTHENTICATION HAS BEEN DISABLED (remoteAuthPolicy = "off"): every client that ' +
              'can reach the remote port now has operator-level access to this machine.'
          )
        } else {
          logger.info(
            'main',
            `Remote auth surface changed: ${moved ?? 'no detail'}`
          )
        }
        remoteServer.disconnectAuthSurfaceClients()
      }
      // Turning the terminal toggle OFF must bite NOW, not at the next
      // reconnect: every live connection loses its `shell` grant and every
      // remote attachment is dropped (ADR-052 decision 6).
      if (partial.allowTerminal !== undefined) remoteServer.applyTerminalPolicy()
      return after
    }
  )
  // Provisioning/clearing rotates the credential, so any live session that
  // authenticated with the OLD password must not outlive it. Token clients are
  // untouched (their credential didn't change).
  ipcMain.handle('remote:set-password', (_e, password: string) => {
    provisionPassword(password)
    remoteServer.disconnectPasswordClients()
  })
  ipcMain.handle('remote:clear-password', () => {
    clearRemotePassword()
    remoteServer.disconnectPasswordClients()
  })
  // Pre-flight probe for the Settings TLS toggle. Returned verbatim — the failure
  // variants carry an actionable, user-facing `message`. Desktop-only
  // (`admin` capability): it discloses the node's DNS name and the owner's
  // login. The explicit return type is the compile-time link between the manager's
  // union and the shared one the renderer consumes.
  ipcMain.handle('remote:tailscale-detect', async (): Promise<TailscaleDetection> => {
    return await tailscaleManager.detect()
  })
  // Force re-serve (ADR-042): claim the pinned HTTPS port, overwriting whatever
  // serve handler holds it. Desktop-only (`admin` capability) — a
  // remote client must never mutate the serve config of the very server it is
  // connected through. Throws propagate to the renderer so the banner can show
  // why the takeover failed.
  ipcMain.handle('remote:force-reserve', async (): Promise<void> => {
    // Machine-global mutation — a harness instance taking over the pinned port
    // would knock the primary app's remote access offline.
    if (remoteAccessDisabled) {
      throw new Error(
        'Remote access is disabled in this instance (CLAUDEUI_DISABLE_REMOTE=1 / --disable-remote)'
      )
    }
    await remoteServer.forceReserve()
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
  } else {
    void (async () => {
      try {
        // Serve-config reconciliation (ADR-042 decision 3) runs FIRST and
        // unconditionally — even with autostart/TLS off, because the leaked entry
        // it removes was created by a previous run and nothing else can clean it
        // up. It swallows its own failures (a down daemon just means the record
        // survives for the next launch), so it can never block autostart.
        await remoteServer.reconcileServeRecord()
        const config = getRemoteConfig()
        if (config?.autostart) {
          // autostartRetry: at login the Tailscale daemon may not be up yet, and a
          // failed `tailscale serve` here has no modal to report to — so keep the
          // (loopback-only) listener and retry in the background instead of failing.
          await remoteServer.start(config.port, config.bindHost ?? undefined, {
            tls: config.tlsMode === 1,
            autostartRetry: true
          })
        }
      } catch (err) {
        logger.error(
          'main',
          `Remote server autostart failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })()
  }

  return { sessionManager, remoteServer, remoteDispatcher, automationManager }
}
