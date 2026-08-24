import type { RemoteAuthPolicy, RemoteConfig, StepUpTier } from '../../../../shared/types'

/**
 * WHICH WRITER the remote-settings pane uses (ADR-054 §6 — the host anchor, as
 * re-mechanized by the 2026-08-16 amendment).
 *
 * The settings components are shared: the same React tree renders in the desktop
 * renderer and in the web bundle. What is NOT shared is how a write reaches the
 * database, and the split is a security boundary rather than a plumbing detail:
 *
 *  - **Host anchor** (`remote:set-config`) — the desktop renderer today, the
 *    server's own console/config on a headless box. It is the ONLY writer that
 *    can reach the `off` master switch, and it has no remote registration at
 *    all, so that is a STRUCTURAL guarantee rather than a capability check. Its
 *    editor unlocks with no ceremony and no TTL.
 *  - **Web** (`authcfg:apply`) — the routine set, in ONE batch, inside an open
 *    settings-editing session. A locked editor answers `needs-settings-session`,
 *    which the transport does NOT cure ambiently: the pane re-locks and the
 *    operator presses Edit again.
 *
 * The editor is a MODE on both transports, which is why there is one save
 * function rather than one per field: the pane collects edits locally and
 * commits them together, so a refused field changes nothing and one Save is one
 * audit row.
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

/** The editable set. Absent field ⇒ untouched, on both transports. */
export interface SettingsDraft {
  /** `null` restores AUTO; `'off'` is desktop-only and never sent from the web. */
  authMode?: RemoteAuthPolicy | null
  stepUpTier?: StepUpTier
  stepUpMutationIdleMinutes?: number
  sessionMaxAgeHours?: number
  /** The terminal's own act window — the third dial (ADR-052 grant decay). */
  shellGrantIdleMinutes?: number
  auditRetentionDays?: number
  passwordBreakGlass?: boolean
}

/**
 * Commit the whole draft.
 *
 * WEB — one `authcfg:apply`, which validates every field before writing any of
 * them, produces one audit row carrying the diff, and fires one 4009 sweep. It
 * answers with the fresh config, so no re-read is needed.
 *
 * DESKTOP — `remote:set-config`, unchanged. Not `authcfg:apply`, even though the
 * desktop connection would pass its gate: the host anchor's writer is the one
 * that can carry `authPolicy: 'off'`, and routing the desktop pane through a
 * verb that refuses the master switch would mean two save paths for one Save
 * button. One writer per transport, and the one with more authority stays on the
 * host.
 */
export async function saveSettingsDraft(draft: SettingsDraft): Promise<RemoteConfig> {
  if (!isWebClient()) {
    return window.api.setRemoteConfig({
      ...('authMode' in draft ? { authPolicy: draft.authMode ?? null } : {}),
      ...('stepUpTier' in draft ? { stepUpTier: draft.stepUpTier } : {}),
      ...('stepUpMutationIdleMinutes' in draft
        ? { stepUpMutationIdleMinutes: draft.stepUpMutationIdleMinutes }
        : {}),
      ...('sessionMaxAgeHours' in draft ? { sessionMaxAgeHours: draft.sessionMaxAgeHours } : {}),
      ...('shellGrantIdleMinutes' in draft
        ? { shellGrantIdleMinutes: draft.shellGrantIdleMinutes }
        : {}),
      ...('auditRetentionDays' in draft ? { auditRetentionDays: draft.auditRetentionDays } : {}),
      ...('passwordBreakGlass' in draft ? { passwordBreakGlass: draft.passwordBreakGlass } : {})
    })
  }
  const { config } = await window.api.authcfgApply(draft)
  return config
}

/**
 * Close the settings-editing session.
 *
 * Best-effort and never throws: it is called from Save, from Cancel and from the
 * pane unmounting, and none of those may fail because the socket went away or
 * the TTL already lapsed — the session is gone in all of those cases anyway.
 * Inert on the desktop, which has no session to close.
 */
export async function endSettingsSession(): Promise<void> {
  if (!isWebClient()) return
  try {
    await window.api.authcfgEnd()
  } catch {
    /* the editor is closing either way — see above */
  }
}

/**
 * Rotate the break-glass password. Session-gated on the web like the rest of the
 * area.
 *
 * On the web this can resolve because the socket was CLOSED (4008) rather than
 * because a response arrived: the rotation drops every client holding the old
 * password, the actor included, and the api-adapter races the two. The caller
 * must therefore not assume it still has a connection afterwards.
 */
export async function rotateRemotePassword(password: string): Promise<void> {
  if (!isWebClient()) {
    await window.api.setRemotePassword(password)
    return
  }
  await window.api.authcfgSetPassword(password)
}
