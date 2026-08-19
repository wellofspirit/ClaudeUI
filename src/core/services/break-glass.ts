/**
 * The HOST-ANCHOR break-glass writer: provision the password AND record it (S5).
 *
 * Two callers, and they are the two places "whoever is at the machine" can be:
 * `HostAnchor.setPassword` (behind the desktop's `remote:set-password`) and
 * `claudeui-server set-password` (a headless console). Neither is reachable from
 * a remote client by construction — `remote:*` has no registration on the remote
 * transport at all, and a console is a console.
 *
 * ## Why this is its own module
 *
 * Two constraints that pull in opposite directions, and this file is where they
 * meet.
 *
 *  1. **`claudeui-server set-password` must open a database and boot NOTHING
 *     else.** So the writer cannot live in `boot/host-anchor.ts`, which reaches
 *     `remote-server.ts` and would drag the terminal service, the sync core and
 *     the webauthn service into a process whose entire job is one row. An earlier
 *     revision booted the whole graph for this command and it was actively
 *     harmful: a recursive `fs.watch` on `~/.claude`, the usage poller (which can
 *     lazily SPAWN an engine), armed automation timers and `credentialSync`
 *     writing engine credential files — all `process.exit`ed through the middle
 *     of, next to a live `serve` racing it over the same DB and vault.
 *  2. **`remote-auth.ts` must stay thin.** It is the credential's own module and
 *     its unit tests mock `db` down to two functions; making it import
 *     `auth-policy` (for the audit row) and `command-registry` (for the actor)
 *     broke them, and rightly so — that is a real widening of what "the credential
 *     module" depends on.
 *
 * So: the composition sits one level up from the credential and one level below
 * the server graph. Its whole dependency set is `remote-auth` + `auth-policy` +
 * `command-registry` — the credential, its trail, and the identity on the trail.
 *
 * ## What it deliberately does NOT do
 *
 * **It does not disconnect anybody.** The 4008 sweep belongs to a host that HAS a
 * live listener, so `HostAnchor.setPassword` adds it and the console does not —
 * a console invocation is a separate process from any `claudeui-server serve`, so
 * its own in-process server would have no clients to drop either way. Consequence
 * worth knowing: rotating from the console while a `serve` runs elsewhere does
 * NOT drop that server's password clients; they die at their next reconnect, when
 * the old proof stops verifying.
 *
 * **It is not the web path's writer.** `authcfg:set-password` is session-gated and
 * has a REAL connection identity to attribute, so it must not borrow
 * `desktopConnection()`. It composes the same two shared pieces —
 * {@link provisionPassword} and `auditSettingsChange` — under its own actor. What
 * all three surfaces share is therefore the credential (one strength rule, one
 * KDF, one stored shape) and the audit ROW shape; what differs is who is named on
 * it. Only the SUCCESS row is common: a refused attempt leaves a dispatch error
 * row on the web path and nothing at all on these two, which are raw host-anchor
 * calls with no command registry around them.
 */

import { auditSettingsChange } from './auth-policy'
import { provisionPassword } from './remote-auth'
import { desktopConnection } from '../ipc/command-registry'

/**
 * Provision the break-glass credential from a host anchor, audit row included.
 *
 * `via` names WHICH host anchor in the trail's `detail` — `remote:set-password`
 * or `claudeui-server set-password`. It is a LABEL, never an authorization input:
 * both callers are the host anchor by construction, so nothing branches on it.
 *
 * The actor is `desktopConnection()`, matching how `--disable-auth` attributes
 * itself through `remote:set-config`: it is the process's host-anchor identity,
 * and `via` is what tells a reader whether the hands were on a renderer or on a
 * console.
 *
 * Throws (from `provisionPassword`) if the password is too short, BEFORE anything
 * is written or audited — so a refusal leaves no trace of a rotation that did not
 * happen.
 */
export function provisionBreakGlassPassword(password: string, opts: { via: string }): void {
  provisionPassword(password)
  auditSettingsChange(
    desktopConnection(),
    `break-glass password rotated via ${opts.via} on the host anchor`
  )
}
