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
 * ## The settings-editing SESSION (ADR-054 §6 amendment, 2026-08-16)
 *
 * Every WRITE here demands a live settings-editing session on the calling
 * connection — opened by one deliberate step-up carrying `intent: 'settings'`,
 * five minutes, revoked by {@link authcfgEnd}, by disconnect, or by its own TTL.
 * This REPLACED the mutation-window check the verbs shipped with: that made
 * administering an ambient capability, invisible while held, and it is why the
 * timing dials had to stay desktop-only as a compensating restriction. A bounded
 * mode makes them safe to expose.
 *
 * The transport gate does this ahead of dispatch (`classifyDispatch` →
 * `authcfg`); the bodies assert it again through the same table, so a future
 * transport that forgets the gate still cannot rewrite the auth surface with the
 * editor locked. Same backstop discipline as `terminal-service.assertAllowed`.
 *
 * {@link authcfgGet} is the ONE exception and deliberately so: it is a `query`,
 * classified `read`, and therefore free. The pane's default state IS the read —
 * demanding an unlock before the current settings can be DISPLAYED would put the
 * ceremony in front of the explanation of why there is a ceremony. It stays
 * behind `admin` — the same capability the writes and `webauthn:credentials`
 * declare — so only a passkey / break-glass connection sees it at all.
 */

import {
  AUTH_MODE_OFF_HOST_ANCHOR_ERROR,
  LAN_LINK_UNAVAILABLE_ERROR,
  NEEDS_SETTINGS_SESSION_ERROR
} from '../../shared/remote-protocol'
import type { RemoteAuthPolicy, RemoteConfig, StepUpTier } from '../../shared/types'
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
import { sanitizedRemoteConfig } from '../services/remote-config-view'
import {
  MAX_SESSION_MAX_AGE_HOURS as MAX_SESSION_MAX_AGE_HOURS_LIMIT,
  authcfgAllowed,
  endSettingsSession
} from '../services/step-up-tier'
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
   * `http://<ip>:<port>/remote#k=<key>` for the LAN channel, or null when the
   * running server serves no non-loopback bind (ADR-056 item C). The server owns
   * this because the ip:port half comes from LIVE listener state, not from
   * config: a listener started on port 0 has a port nothing else knows.
   */
  lanLink(): string | null
  /**
   * Generate a NEW LAN channel key and return the link that carries it.
   *
   * Never strands anybody, and that is a contract rather than an accident: the
   * key is consumed at handshake only (each connection derives its own AES
   * session keys from it at `e2e-activate` and never re-reads the stored value),
   * so established channels keep working and NOBODY is disconnected. Only new
   * handshakes need the new key. Returns null on the same "no LAN bind" ground
   * as {@link AuthcfgHost.lanLink}.
   */
  rotateLanKey(): string | null
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
 * The session backstop. Throws {@link NEEDS_SETTINGS_SESSION_ERROR} — the same
 * typed refusal the transport produces, so a client that somehow reached a body
 * directly still gets the answer that means "re-lock and let the operator press
 * Edit", rather than the ambient `needs-step-up` its generic gate would silently
 * cure.
 */
function assertSettingsSession(connection: CommandConnection): void {
  if (!authcfgAllowed(connection)) throw new Error(NEEDS_SETTINGS_SESSION_ERROR)
}

/** Audit a settings write that is NOT an admission-rule change (no disconnect). */
function auditSettingsChange(connection: CommandConnection, detail: string): void {
  auditAuthcfg(connection, 'auth:settings-change', detail)
}

/**
 * Audit a SESSION event — the editor opening or closing. Its own channel
 * because it is not a settings WRITE: nothing about the configuration moved,
 * only who is currently allowed to move it. (The OPEN row is written by the
 * transport, which is where the ceremony completes; this file writes the
 * explicit close.)
 */
function auditSettingsSession(connection: CommandConnection, detail: string): void {
  auditAuthcfg(connection, 'auth:settings-session', detail)
}

function auditAuthcfg(connection: CommandConnection, channel: string, detail: string): void {
  try {
    appendAuditLog({
      ts: Date.now(),
      connectionId: connection.connectionId,
      method: connection.identity.method,
      label: connection.identity.label,
      capability: 'admin',
      kind: 'command',
      channel,
      sessionId: null,
      outcome: 'ok',
      detail
    })
  } catch (err) {
    logger.error(
      'authcfg',
      `${channel} audit append failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * `authcfg:get` — the settings surface as this client may see it.
 *
 * The READ half of ADR-054 decision 6. "Routine remote-access settings become
 * web-reachable" is unimplementable without it: the pane has to show the tier,
 * the dials, the credential count and the effective policy before an operator
 * can meaningfully change any of them, and re-deriving those in the renderer is
 * exactly how a displayed policy drifts from the enforced one.
 *
 * Answers with the SAME object `remote:get-config` does
 * ({@link sanitizedRemoteConfig}) — one sanitizer, so a field can never be
 * exposed on one transport and forgotten on the other, and the shared settings
 * components need no per-transport shape. It carries no secret by construction:
 * salt / hash / KDF params never leave that function, only a `passwordSet`
 * boolean.
 *
 * NO freshness assertion, and no `AUTHCFG_CHANNELS` membership: this is a
 * `query`, so `classifyDispatch` calls it `read` and it never slides a window
 * either (queries never refresh — ADR-054 decision 4). The namespace-completeness
 * guard in `__tests__/remote-handlers.ipc.test.ts` ("everything in the authcfg
 * namespace is a `command` EXCEPT the declared reads") pins that every OTHER
 * verb here is a `command` that IS in that set, so "outside the set" can only
 * ever mean a deliberate read.
 */
export async function authcfgGet(_connection: CommandConnection): Promise<RemoteConfig> {
  return sanitizedRemoteConfig()
}

/**
 * What one `authcfg:apply` may carry. Every field optional; absent means
 * "leave alone", which is what lets the pane send only what the operator moved.
 */
export interface AuthcfgApplyPatch {
  /** `null` restores AUTO. `'off'` is refused — host anchor only, forever. */
  authMode?: RemoteAuthPolicy | null
  stepUpTier?: StepUpTier
  stepUpMutationIdleMinutes?: number
  sessionMaxAgeHours?: number
  /** The TERMINAL's own act window (ADR-052) — the third dial. */
  shellGrantIdleMinutes?: number
  auditRetentionDays?: number
  /**
   * The ADMISSION toggle. It was always a member of the auth surface — the same
   * class of setting as the tier, sweeping and auditing through the same
   * machinery — but it used to live outside the editor as an always-live switch.
   * The owner's ruling folded it in: the pane is the configuration of ALL of
   * these, so it is staged, saved and swept with the rest.
   *
   * `passkeyTailnetExempt` was its twin until ADR-056 retired what it exempted
   * FROM — ambient tailnet admission — and with it the setting.
   */
  passwordBreakGlass?: boolean
}

/** Bounds mirrored from `boot-core.ts`'s host-anchor writer — one rule, two doors. */
const MIN_IDLE_MINUTES = 1
const MAX_IDLE_MINUTES = 1440
const MIN_SESSION_MAX_AGE_HOURS = 1
const MAX_AUDIT_RETENTION_DAYS = 36_500

function assertInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/**
 * `authcfg:apply` — the settings editor's SAVE (ADR-054 §6 amendment).
 *
 * Replaces `set-tier` / `set-auth-mode` / `set-retention`, which were one series
 * old and are gone rather than deprecated. Three properties the per-field verbs
 * could not have:
 *
 *  - **Validated together, written once.** Every field is checked before
 *    anything is stored, so a batch with one bad value changes nothing at all.
 *    A pane that saved four fields through four verbs could leave the surface
 *    half-moved, with the operator's own connection dropped by the 4009 from
 *    field two and fields three and four never sent.
 *  - **One audit row for one operator action.** The reader sees the whole diff
 *    the human intended, not a scatter of rows to correlate by timestamp.
 *  - **One re-admission sweep.** Four verbs meant up to four 4009 storms for a
 *    single Save.
 *
 * A zero-change apply is a success that writes nothing and disconnects nobody —
 * `withAuthSurfaceReaction` already has that discipline (it compares the surface
 * before and after), and retention-only changes audit without a sweep because
 * how long the trail is kept does not change who may connect.
 */
export async function authcfgApply(
  connection: CommandConnection,
  patch: AuthcfgApplyPatch,
  host: AuthcfgHost | null = null
): Promise<{ ok: true; config: RemoteConfig }> {
  assertSettingsSession(connection)
  if (patch === null || typeof patch !== 'object') {
    throw new Error('authcfg:apply expects an object of settings to change')
  }

  // ── Validate EVERYTHING first ─────────────────────────────────────────────
  const write: Parameters<typeof setRemoteConfig>[0] = {}

  if ('authMode' in patch) {
    const mode = patch.authMode
    // Checked before anything else, and by identity rather than by falling out
    // of the generic validation, so the refusal can say WHY: the settings UI has
    // to explain that this option is absent from a browser and present on the
    // desktop, not render a shrug.
    if (mode === 'off') {
      logger.warn(
        'authcfg',
        `Refused authcfg:apply{authMode:"off"} from ${connection.identity.label}: ` +
          'disabling authentication is host-anchor only (ADR-054 decision 6)'
      )
      throw new Error(AUTH_MODE_OFF_HOST_ANCHOR_ERROR)
    }
    if (mode !== null && !(REMOTE_AUTH_POLICIES as readonly string[]).includes(mode as string)) {
      throw new Error(
        `Unknown remote auth policy "${String(mode)}" — expected null (auto) or one of ` +
          REMOTE_AUTH_POLICIES.filter((p) => p !== 'off').join(', ')
      )
    }
    write.authPolicy = mode ?? null
  }

  if ('stepUpTier' in patch) {
    const tier = patch.stepUpTier
    if (typeof tier !== 'string' || !(STEP_UP_TIERS as readonly string[]).includes(tier)) {
      throw new Error(
        `Unknown step-up tier "${String(tier)}" — expected one of ${STEP_UP_TIERS.join(', ')}`
      )
    }
    write.stepUpTier = tier
  }

  if ('stepUpMutationIdleMinutes' in patch) {
    write.stepUpMutationIdleMinutes = assertInteger(
      patch.stepUpMutationIdleMinutes,
      'Idle re-check',
      MIN_IDLE_MINUTES,
      MAX_IDLE_MINUTES
    )
  }

  if ('shellGrantIdleMinutes' in patch) {
    write.shellGrantIdleMinutes = assertInteger(
      patch.shellGrantIdleMinutes,
      'Terminal re-check',
      MIN_IDLE_MINUTES,
      MAX_IDLE_MINUTES
    )
  }

  if ('passwordBreakGlass' in patch) {
    if (typeof patch.passwordBreakGlass !== 'boolean') {
      throw new Error('passwordBreakGlass must be true or false')
    }
    write.passwordBreakGlass = patch.passwordBreakGlass
  }

  if ('sessionMaxAgeHours' in patch) {
    // The one-week ceiling is not cosmetic: the value becomes a `setTimeout`
    // delay, and past the signed-32-bit ms limit it wraps and fires at once —
    // cutting every strong-tier socket at accept.
    write.sessionMaxAgeHours = assertInteger(
      patch.sessionMaxAgeHours,
      'Session length',
      MIN_SESSION_MAX_AGE_HOURS,
      MAX_SESSION_MAX_AGE_HOURS_LIMIT
    )
  }

  if ('auditRetentionDays' in patch) {
    // The 30-day FLOOR is a refusal here, not a silent clamp: this arrives from
    // an editor the operator is looking at, and quietly storing something other
    // than what they typed is worse than telling them the floor exists.
    write.auditRetentionDays = assertInteger(
      patch.auditRetentionDays,
      'Log retention',
      MIN_AUDIT_RETENTION_DAYS,
      MAX_AUDIT_RETENTION_DAYS
    )
  }

  // ── Apply atomically, then react ONCE ─────────────────────────────────────
  const before = getRemoteConfig()?.auditRetentionDays ?? null
  await withAuthSurfaceReaction({
    connection,
    host,
    via: 'authcfg:apply',
    mutate: () => setRemoteConfig(write)
  })
  // Retention is NOT part of the auth surface (it does not change who may
  // connect), so the reaction above ignores it — but it is still a settings
  // change and still owes a row. Only when it actually moved.
  if (write.auditRetentionDays !== undefined && write.auditRetentionDays !== before) {
    auditSettingsChange(
      connection,
      `audit retention ${before ?? 'default'}→${write.auditRetentionDays} days via authcfg:apply`
    )
  }
  // The actor is spared the re-admission disconnect, so it would otherwise keep
  // the snapshot it was ADMITTED under — leaving the one session not governed by
  // the settings that session just chose. Reaches the tier too: auth-mode `off`
  // FORCES tier `off`, so a mode change can move the effective tier without the
  // tier column being touched.
  host?.resnapshotConnection(connection.connectionId)
  return { ok: true, config: sanitizedRemoteConfig() }
}

/**
 * `authcfg:end` — close the settings editor.
 *
 * Called on Save, on Cancel, and on the pane unmounting, so the bounded mode
 * really is bounded by the operator's action rather than only by its TTL. No
 * session is required to call it and calling it without one is a no-op success:
 * a client that lost track (a reconnect, a re-render, a Cancel after the TTL
 * already lapsed) must be able to say "I am done" without having to prove it was
 * ever editing, and turning that into an error would only teach clients to
 * swallow it.
 *
 * Audited on `auth:settings-session` (an end is a session event, not a settings
 * write) and only when there WAS something to close — a trail of clients tidying
 * up after themselves is noise.
 */
export async function authcfgEnd(connection: CommandConnection): Promise<{ ok: true }> {
  const had = (connection.settingsSessionExpiresAt ?? null) !== null
  endSettingsSession(connection)
  if (had) auditSettingsSession(connection, 'settings session ended via authcfg:end')
  return { ok: true }
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
 *
 * Kept as its own verb rather than folded into {@link authcfgApply}: a password
 * is not a config field — it is write-only, it is never read back, and its
 * disconnect semantics (4008 to the password clients, possibly including the
 * caller) are nothing like a settings diff's 4009 sweep. It is session-gated
 * like the rest of the area since the §6 amendment.
 */
export async function authcfgSetPassword(
  connection: CommandConnection,
  password: string,
  host: AuthcfgHost | null = null
): Promise<{ ok: true }> {
  assertSettingsSession(connection)
  provisionPassword(password)
  auditSettingsChange(connection, 'break-glass password rotated via authcfg:set-password')
  host?.disconnectPasswordClients()
  return { ok: true }
}

/**
 * `authcfg:lan-link` — the LAN channel link, `http://<ip>:<port>/remote#k=<key>`
 * (ADR-056 item C).
 *
 * SESSION-GATED, unlike its namespace sibling `authcfg:get`. The free-read rule
 * there is "the pane's default state IS the read, so demanding an unlock to
 * DISPLAY the current settings would put the ceremony in front of its own
 * explanation" — and it does not reach this verb, which hands out a live channel
 * secret rather than displaying a setting. Declared a `query` because it moves
 * nothing; membership of `AUTHCFG_CHANNELS` is what gates it, and that is
 * deliberate: what gates a verb here is what it DISCLOSES, not its kind.
 *
 * The desktop connection is exempt through the ordinary presence table (it is
 * the host anchor), so the desktop pane renders the link with no ceremony.
 */
export async function authcfgLanLink(
  connection: CommandConnection,
  host: AuthcfgHost | null = null
): Promise<{ url: string }> {
  assertSettingsSession(connection)
  const url = host?.lanLink() ?? null
  if (!url) throw new Error(LAN_LINK_UNAVAILABLE_ERROR)
  return { url }
}

/**
 * `authcfg:rotate-lan-key` — mint a new LAN channel key and hand back the new
 * link (ADR-056 item C).
 *
 * NEVER STRANDS, by construction rather than by care: the key is consumed at
 * handshake only, so every established E2E channel keeps running on the session
 * keys it derived at activation and nobody is disconnected. Only a NEW handshake
 * needs the new key. The response carries the link so the actor's own UI can
 * render it immediately — a rotation whose new link the operator had to go and
 * find would be a rotation they would put off.
 *
 * Audited as `auth:settings-change` with NO 4009 sweep: the admission rules for
 * existing identities did not move, only the key a future socket must open the
 * channel with. Sweeping would disconnect every live client to tell them
 * something that does not apply to them.
 */
export async function authcfgRotateLanKey(
  connection: CommandConnection,
  host: AuthcfgHost | null = null
): Promise<{ url: string }> {
  assertSettingsSession(connection)
  const url = host?.rotateLanKey() ?? null
  if (!url) throw new Error(LAN_LINK_UNAVAILABLE_ERROR)
  auditSettingsChange(connection, 'LAN channel key rotated via authcfg:rotate-lan-key')
  return { url }
}

// `authcfg:set-retention` is GONE — folded into `authcfg:apply` above, like
// `set-tier` and `set-auth-mode`. Retention was the one field of the three that
// never rode the auth-surface reaction, and keeping a separate verb for it would
// have left the pane with two save paths for one Save button.
