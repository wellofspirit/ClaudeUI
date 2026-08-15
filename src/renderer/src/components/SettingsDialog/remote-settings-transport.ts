import type { RemoteAuthPolicy, RemoteConfig, StepUpTier } from '../../../../shared/types'

/**
 * WHICH WRITER the remote-settings pane uses (ADR-054 decision 6 — the host
 * anchor).
 *
 * The settings components are shared: the same React tree renders in the desktop
 * renderer and in the web bundle. What is NOT shared is how a write reaches the
 * database, and the split is a security boundary rather than a plumbing detail:
 *
 *  - **Host anchor** (`remote:set-config`) — the desktop renderer today, the
 *    server's own console/config on a headless box. It is the ONLY writer that
 *    can reach the `off` master switch, and it has no remote registration at
 *    all, so that is a STRUCTURAL guarantee rather than a capability check.
 *  - **Web** (`authcfg:*`) — the routine subset: tier, auth mode among the
 *    non-`off` modes, password rotation, audit retention. Each demands `admin`
 *    plus a presence proof inside the mutation window on every tier; a stale
 *    proof answers `needs-step-up`, which the web transport turns into one
 *    ceremony and a single retry before any of these promises settle.
 *
 * Every function here answers with a FRESH {@link RemoteConfig} so callers hold
 * one shape whichever writer ran. On the desktop that is what the IPC returns;
 * on the web it costs one extra `authcfg:get` — a query, so it is free of any
 * freshness demand and cannot itself provoke a second ceremony.
 */

/**
 * Is this the web bundle (i.e. NOT the host anchor)?
 *
 * Optional chaining like every other platform probe in the renderer: a re-render
 * can be flushed after a test harness dropped `window.api`, and "no api" is
 * never "web".
 */
export function isWebClient(): boolean {
  return window.api?.platform === 'web'
}

/** Re-read the config after a write that does not return one. */
function reread(): Promise<RemoteConfig> {
  return window.api.getRemoteConfig()
}

/** Post-login freshness tier. */
export async function writeStepUpTier(tier: StepUpTier): Promise<RemoteConfig> {
  if (!isWebClient()) return window.api.setRemoteConfig({ stepUpTier: tier })
  await window.api.authcfgSetTier(tier)
  return reread()
}

/**
 * Login ceremony mode. `null` restores AUTO.
 *
 * `'off'` must never reach here from a web client — the picker does not offer it
 * there — and if it somehow did, the server refuses it with
 * `auth-off-is-host-anchor-only` and writes nothing. The desktop's `off` path
 * deliberately stays on `setRemoteConfig` with its typed confirmation, so this
 * function never carries the master switch on either transport.
 */
export async function writeAuthMode(mode: RemoteAuthPolicy | null): Promise<RemoteConfig> {
  if (!isWebClient()) return window.api.setRemoteConfig({ authPolicy: mode })
  await window.api.authcfgSetAuthMode(mode)
  return reread()
}

/**
 * Audit-log retention window. The server clamps to the 30-day FLOOR and returns
 * the EFFECTIVE value, so the re-read is what the field should show — not what
 * was asked for.
 */
export async function writeAuditRetention(days: number): Promise<RemoteConfig> {
  if (!isWebClient()) return window.api.setRemoteConfig({ auditRetentionDays: days })
  await window.api.authcfgSetRetention(days)
  return reread()
}

/**
 * Rotate the break-glass password.
 *
 * Resolves `{ rotated: true }` on both transports. On the web this can resolve
 * because the socket was CLOSED (4008) rather than because a response arrived:
 * the rotation drops every client holding the old password, the actor included,
 * and the api-adapter races the two. The caller must therefore not assume it
 * still has a connection afterwards.
 */
export async function rotateRemotePassword(password: string): Promise<void> {
  if (!isWebClient()) {
    await window.api.setRemotePassword(password)
    return
  }
  await window.api.authcfgSetPassword(password)
}

/**
 * The dials that only the host anchor may write: the strong tier's mutation
 * window and its session max-age.
 *
 * Deliberately NOT given `authcfg:*` verbs. ADR-054 decision 6 makes the routine
 * settings web-reachable so a headless box is administrable day to day; these
 * two are the *shape* of the freshness policy rather than day-to-day
 * administration, and every verb added to that namespace is another thing a
 * stolen stepped-up session can reach. A web client renders them read-only and
 * says where to change them.
 */
export function writeHostAnchorDials(partial: {
  stepUpMutationIdleMinutes?: number
  sessionMaxAgeHours?: number
}): Promise<RemoteConfig> {
  return window.api.setRemoteConfig(partial)
}
