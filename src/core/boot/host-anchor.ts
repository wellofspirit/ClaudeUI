/**
 * The HOST ANCHOR surface — remote-server administration, as callable functions
 * (S3 stage 1b).
 *
 * ## What this is
 *
 * Ten operations that administer the remote server itself: start/stop/status,
 * the persisted config, the password credential, the Tailscale probe and the
 * forced re-serve. They are the `remote:*` family, and they are unique in this
 * codebase for being registered on NEITHER transport — they are raw
 * `ipcMain.handle` wiring in `boot-core.ts`, with no entry in the command
 * registry at all. That is deliberate and load-bearing: a remote client must
 * never be able to read or rotate the credential it authenticated with, flip the
 * transport it is connected through, or disable authentication (ADR-039/042,
 * and `PINNED_CAPABILITIES` pins all six to `admin` as the belt).
 *
 * ## Why they moved here
 *
 * Their BODIES were never Electron-shaped — they are ordinary calls on
 * `RemoteServer`, `TailscaleManager` and the DB. Only the `ipcMain.handle`
 * REGISTRATION was. Splitting the two means the headless server can offer the
 * same administration surface through the ONLY channel that is correct for it:
 * its console and CLI. "Host anchor" stops meaning "the Electron renderer" and
 * starts meaning "whoever is at the machine", which is what the name always
 * claimed.
 *
 * So `boot-core.ts` keeps its ten `ipcMain.handle` calls and each one now
 * forwards to the matching method here; `claudeui-server` calls the same methods
 * from its argument parser and its first-boot chain. One implementation, two
 * host surfaces, and no possibility of the desktop and the console validating
 * `remote:set-config` differently.
 *
 * Nothing in here is reachable from a WebSocket client by construction: this
 * module is never handed to `registerRemoteHandlers`, and nothing registers
 * these names in the registry.
 */

import { getNetworkInterfaces, type RemoteServer } from '../services/remote-server'
import type { TailscaleManager } from '../services/tailscale-manager'
import {
  MIN_AUDIT_RETENTION_DAYS,
  REMOTE_AUTH_POLICIES,
  STEP_UP_TIERS,
  getRemoteConfig,
  setRemoteConfig as dbSetRemoteConfig,
  clearRemotePassword
} from '../services/db'
import {
  auditAuthPolicyChange,
  authSurfaceChanged,
  describeAuthSurfaceChange
} from '../services/auth-policy'
import { sanitizedRemoteConfig } from '../services/remote-config-view'
import { MAX_SESSION_MAX_AGE_HOURS } from '../services/step-up-tier'
import { desktopConnection } from '../ipc/command-registry'
import { provisionPassword } from '../services/remote-auth'
import { logger } from '../services/logger'
import type {
  RemoteAuthPolicy,
  RemoteStatus,
  StepUpTier,
  TailscaleDetection
} from '../../shared/types'

/** The `remote:set-config` payload — every column the host anchor may write. */
export interface RemoteConfigPatch {
  port?: number
  bindHost?: string | null
  autostart?: boolean
  tlsMode?: number
  tlsHttpsPort?: number
  allowTerminal?: boolean
  shellGrantIdleMinutes?: number
  authPolicy?: RemoteAuthPolicy | null
  passwordBreakGlass?: boolean
  stepUpTier?: StepUpTier
  stepUpMutationIdleMinutes?: number
  sessionMaxAgeHours?: number
  auditRetentionDays?: number
}

/** What {@link createHostAnchor} returns — the ten host-anchor operations. */
export interface HostAnchor {
  interfaces(): ReturnType<typeof getNetworkInterfaces>
  start(opts?: {
    port?: number
    host?: string
    tunnel?: boolean
  }): ReturnType<RemoteServer['start']>
  stop(): void
  status(): RemoteStatus
  getConfig(): ReturnType<typeof sanitizedRemoteConfig>
  setConfig(partial: RemoteConfigPatch): ReturnType<typeof sanitizedRemoteConfig>
  setPassword(password: string): void
  clearPassword(): void
  tailscaleDetect(): Promise<TailscaleDetection>
  forceReserve(): Promise<void>
  /** Reconcile a leaked `tailscale serve` record, then autostart if configured. */
  reconcileAndAutostart(): Promise<void>
}

export interface HostAnchorDeps {
  remoteServer: RemoteServer
  tailscaleManager: TailscaleManager
  /**
   * Remote-access kill switch for SECONDARY instances (the Playwright verifier,
   * evals). The listener owns machine-global state — a pinned TCP port and the
   * host's `tailscale serve` config — so a harness instance must never
   * reconcile, autostart or force-reserve.
   */
  remoteAccessDisabled: boolean
}

export function createHostAnchor({
  remoteServer,
  tailscaleManager,
  remoteAccessDisabled
}: HostAnchorDeps): HostAnchor {
  return {
    interfaces() {
      return getNetworkInterfaces()
    },

    async start(opts) {
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
    },

    stop() {
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
    },

    status() {
      return remoteServer.getStatus()
    },

    getConfig() {
      return sanitizedRemoteConfig()
    },

    setConfig(partial) {
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
      // break-glass toggle, or one of the three timing dials — is audited AND
      // drops every live remote socket.
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
          logger.info('main', `Remote auth surface changed: ${moved ?? 'no detail'}`)
        }
        remoteServer.disconnectAuthSurfaceClients()
      }
      // Turning the terminal toggle OFF must bite NOW, not at the next
      // reconnect: every live connection loses its `shell` grant and every
      // remote attachment is dropped (ADR-052 decision 6).
      if (partial.allowTerminal !== undefined) remoteServer.applyTerminalPolicy()
      return after
    },

    // Provisioning/clearing rotates the credential, so any live session that
    // authenticated with the OLD password must not outlive it. Token clients are
    // untouched (their credential didn't change).
    setPassword(password) {
      provisionPassword(password)
      remoteServer.disconnectPasswordClients()
    },

    clearPassword() {
      clearRemotePassword()
      remoteServer.disconnectPasswordClients()
    },

    // Pre-flight probe for the Settings TLS toggle. Returned verbatim — the failure
    // variants carry an actionable, user-facing `message`. Desktop-only
    // (`admin` capability): it discloses the node's DNS name and the owner's
    // login. The explicit return type is the compile-time link between the manager's
    // union and the shared one the renderer consumes.
    async tailscaleDetect(): Promise<TailscaleDetection> {
      return await tailscaleManager.detect()
    },

    // Force re-serve (ADR-042): claim the pinned HTTPS port, overwriting whatever
    // serve handler holds it. Desktop-only (`admin` capability) — a
    // remote client must never mutate the serve config of the very server it is
    // connected through. Throws propagate to the renderer so the banner can show
    // why the takeover failed.
    async forceReserve(): Promise<void> {
      // Machine-global mutation — a harness instance taking over the pinned port
      // would knock the primary app's remote access offline.
      if (remoteAccessDisabled) {
        throw new Error(
          'Remote access is disabled in this instance (CLAUDEUI_DISABLE_REMOTE=1 / --disable-remote)'
        )
      }
      await remoteServer.forceReserve()
    },

    async reconcileAndAutostart(): Promise<void> {
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
    }
  }
}
