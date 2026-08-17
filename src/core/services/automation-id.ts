/**
 * The automation id slug rule, on its own.
 *
 * It lived in `automation-manager.ts` (which still re-exports it) until the
 * automation channels were ported to the command registry: the transport-
 * agnostic registrations in `ipc/automation-commands.ts` re-validate every
 * caller-supplied id at the perimeter, and that module is imported by
 * `remote-handlers.ts`, which must not pull `automation-manager`'s graph —
 * Electron's `Notification`, the SDK, the run store — into a headless build.
 * The rule is one line and one regex, so it moved rather than being copied.
 */

/**
 * Strict slug for an automation id (audit M-AU3). Renderer-supplied ids flow
 * into path.join — including the destructive `fs.rmSync(runsDir(id), …)` in
 * delete() — so an id like `../..` would escape the automation dir and delete
 * arbitrary directories above it. A hostile/compromised renderer or the remote
 * surface is the trigger. Real ids are uuid v4 (hex + hyphens); this allows
 * that plus conservative slug punctuation and rejects any `.`, `/` or `\`
 * needed for traversal.
 */
const AUTOMATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** True iff `id` is a safe automation/run id (no path-traversal characters). */
export function isValidAutomationId(id: unknown): id is string {
  return typeof id === 'string' && AUTOMATION_ID_RE.test(id)
}
