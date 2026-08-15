/**
 * Remote-access settings command BODIES — the HOST ANCHOR split (ADR-054
 * decision 6).
 *
 * ## Why this namespace exists at all
 *
 * "Desktop-only" was standing in for *"a surface that requires being on the
 * host"*, and the headless deployment (no desktop at all) forces that to be
 * named properly. ADR-054 splits it:
 *
 *  - **Auth-DISABLING operations** — the `off` master switch, and anything else
 *    that turns authentication off — are host-anchor ONLY, forever: the desktop
 *    renderer today, the server's own console/config file (reached over SSH) on
 *    a headless box. Never the web, not even behind a fresh ceremony, because a
 *    stolen stepped-up session must not be able to disable authentication. That
 *    writer stays in `remote:set-config`, which has no remote registration at
 *    all — a STRUCTURAL guarantee, not a capability check.
 *  - **Routine remote-access settings** — step-up tier, password rotation,
 *    auth-mode changes among the NON-off modes — become web-reachable behind a
 *    fresh presence proof. That is what makes a headless install administrable
 *    day to day without SSH.
 *
 * Hence a separate namespace rather than exposing `remote:*`: the structural
 * guard ("no `remote:*` channel is ever registered on the remote transport")
 * survives intact, and the `off` writer is on the other side of it.
 *
 * ## Freshness
 *
 * Every verb here demands a presence proof inside the MUTATION window on EVERY
 * tier — they behave strong-tier for everyone. The transport gate does this
 * ahead of dispatch (`classifyDispatch` → `authcfg`); the bodies assert it again
 * through the same table, so a future transport that forgets the gate still
 * cannot rewrite the auth surface with a stale proof. Same backstop discipline
 * as `terminal-service.assertAllowed`.
 */

import {
  AUTH_MODE_OFF_HOST_ANCHOR_ERROR,
  NEEDS_STEP_UP_ERROR
} from '../../shared/remote-protocol'
import type { RemoteAuthPolicy, StepUpTier } from '../../shared/types'
import {
  withAuthSurfaceReaction,
  type AuthSurfaceDisconnector
} from '../services/auth-policy'
import {
  MIN_AUDIT_RETENTION_DAYS,
  REMOTE_AUTH_POLICIES,
  STEP_UP_TIERS,
  appendAuditLog,
  getRemoteConfig,
  setRemoteConfig
} from '../services/db'
import { logger } from '../services/logger'
import { provisionPassword } from '../services/remote-auth'
import { authcfgAllowed } from '../services/step-up-tier'
import type { CommandConnection } from './command-registry'

/**
 * What these verbs need from the running server. Two members, two consequences a
 * settings write has on the LISTENER — and this module must not know what a
 * WebSocket is to have them.
 */
export interface AuthcfgHost extends AuthSurfaceDisconnector {
  /** Drop sockets that authenticated with the password that just rotated. */
  disconnectPasswordClients(): void
  /**
   * Re-derive ONE live connection against the auth surface as it now stands.
   *
   * The actor is spared the 4009 that re-admits everybody else, so without this
   * it would keep the tier it was admitted under — and an operator flipping to
   * `strong` would leave their own session as the one socket that never
   * expires. No-op for a connection id that is not a socket (the desktop
   * renderer) or has already gone.
   */
  resnapshotConnection(connectionId: string): void
}

/**
 * The freshness backstop. Throws {@link NEEDS_STEP_UP_ERROR} — the same
 * actionable refusal the transport produces, so a client that somehow reached a
 * body directly still gets an answer it can turn into a ceremony rather than an
 * opaque failure.
 */
function assertFresh(connection: CommandConnection): void {
  if (!authcfgAllowed(connection)) throw new Error(NEEDS_STEP_UP_ERROR)
}

/** Audit a settings write that is NOT an admission-rule change (no disconnect). */
function auditSettingsChange(connection: CommandConnection, detail: string): void {
  try {
    appendAuditLog({
      ts: Date.now(),
      connectionId: connection.connectionId,
      method: connection.identity.method,
      label: connection.identity.label,
      capability: 'admin',
      kind: 'command',
      channel: 'auth:settings-change',
      sessionId: null,
      outcome: 'ok',
      detail
    })
  } catch (err) {
    logger.error(
      'authcfg',
      `settings-change audit append failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * `authcfg:set-tier` — choose the post-login freshness posture.
 *
 * A tier change IS an admission rule (a connection's tier is snapshotted at
 * authentication), so it rides the shared auth-surface reaction: one audit row
 * plus a 4009 re-admission disconnect for everyone but the actor. The actor
 * keeps its own pre-change snapshot for the rest of its socket — the same
 * deliberate trade the policy path makes, and the snapshot it keeps is the one
 * it just chose.
 */
export async function authcfgSetTier(
  connection: CommandConnection,
  tier: StepUpTier,
  host: AuthcfgHost | null = null
): Promise<{ ok: true; tier: StepUpTier }> {
  assertFresh(connection)
  if (typeof tier !== 'string' || !(STEP_UP_TIERS as readonly string[]).includes(tier)) {
    throw new Error(
      `Unknown step-up tier "${String(tier)}" — expected one of ${STEP_UP_TIERS.join(', ')}`
    )
  }
  await withAuthSurfaceReaction({
    connection,
    host,
    via: 'authcfg:set-tier',
    mutate: () => setRemoteConfig({ stepUpTier: tier })
  })
  // The actor kept its old snapshot (it is spared the re-admission disconnect),
  // so re-derive it in place — otherwise the one session guaranteed NOT to be
  // governed by the new tier is the one that chose it.
  host?.resnapshotConnection(connection.connectionId)
  return { ok: true, tier }
}

/**
 * `authcfg:set-auth-mode` — the login ceremony axis, MINUS the master switch.
 *
 * `null` restores AUTO. `off` is refused with a typed error and no write: it is
 * the auth-DISABLING operation, so it is host-anchor only forever (see this
 * file's header). The refusal is checked before anything else so the mode is
 * never partially applied, and it is deliberately not a generic validation
 * failure — series 2's settings UI has to be able to explain WHY the option is
 * absent from a web client but present on the desktop.
 */
export async function authcfgSetAuthMode(
  connection: CommandConnection,
  mode: RemoteAuthPolicy | null,
  host: AuthcfgHost | null = null
): Promise<{ ok: true; mode: RemoteAuthPolicy | null }> {
  assertFresh(connection)
  if (mode === 'off') {
    logger.warn(
      'authcfg',
      `Refused authcfg:set-auth-mode("off") from ${connection.identity.label}: ` +
        'disabling authentication is host-anchor only (ADR-054 decision 6)'
    )
    throw new Error(AUTH_MODE_OFF_HOST_ANCHOR_ERROR)
  }
  if (mode !== null && !(REMOTE_AUTH_POLICIES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unknown remote auth policy "${String(mode)}" — expected null (auto) or one of ` +
        REMOTE_AUTH_POLICIES.filter((p) => p !== 'off').join(', ')
    )
  }
  await withAuthSurfaceReaction({
    connection,
    host,
    via: 'authcfg:set-auth-mode',
    mutate: () => setRemoteConfig({ authPolicy: mode })
  })
  // Same reason as `authcfg:set-tier`, and it reaches the tier too: auth-mode
  // `off` FORCES tier `off`, so a mode change can move the actor's EFFECTIVE
  // tier without the tier column being touched. (The other two verbs in this
  // namespace move neither the mode nor the tier, so they need no re-snapshot.)
  host?.resnapshotConnection(connection.connectionId)
  return { ok: true, mode }
}

/**
 * `authcfg:set-password` — rotate the break-glass credential.
 *
 * Mirrors the desktop `remote:set-password` semantics exactly, disconnect
 * included: the old proof is dead, so every socket that authenticated with it
 * must die too. Note that this can include the CALLER — a password-authenticated
 * connection that stepped up and then rotates is closed by its own write. That
 * is correct rather than unfortunate: it is holding a credential that no longer
 * exists.
 *
 * Not an auth-surface change (the METHODS available did not move, only the
 * secret), so it does not ride the 4009 reaction; it gets its own audit row.
 * `provisionPassword` owns the strength validation, so there is one rule for
 * both transports.
 */
export async function authcfgSetPassword(
  connection: CommandConnection,
  password: string,
  host: AuthcfgHost | null = null
): Promise<{ ok: true }> {
  assertFresh(connection)
  provisionPassword(password)
  auditSettingsChange(connection, 'break-glass password rotated via authcfg:set-password')
  host?.disconnectPasswordClients()
  return { ok: true }
}

/**
 * `authcfg:set-retention` — audit-log retention window, in days.
 *
 * Clamped to the 30-day FLOOR here as well as on read: retention is now settable
 * from a web client, so "0 days" would otherwise be a one-call erase of the very
 * trail that records the erasure. Returns the EFFECTIVE value so a UI shows what
 * was actually stored rather than what it asked for.
 *
 * Audited but NOT an auth-surface change: how long the trail is kept does not
 * change who may connect, so nobody is disconnected for it.
 */
export async function authcfgSetRetention(
  connection: CommandConnection,
  days: number
): Promise<{ ok: true; days: number }> {
  assertFresh(connection)
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    throw new Error('Audit retention must be a number of days')
  }
  // Upper bound is "effectively keep-all" rather than a policy: it only exists so
  // a nonsense value cannot overflow the cutoff arithmetic.
  const effective = Math.min(Math.max(Math.trunc(days), MIN_AUDIT_RETENTION_DAYS), 36_500)
  const before = getRemoteConfig()?.auditRetentionDays ?? null
  setRemoteConfig({ auditRetentionDays: effective })
  auditSettingsChange(
    connection,
    `audit retention ${before ?? 'default'}→${effective} days via authcfg:set-retention`
  )
  return { ok: true, days: effective }
}
