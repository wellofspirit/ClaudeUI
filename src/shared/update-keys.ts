/**
 * The public keys an update manifest signature must verify under (Ed25519,
 * base64 DER SPKI), pinned in the build. A list so a key can be rotated: add the
 * new key and ship a release, then sign with it, later drop the old one.
 *
 * EMPTY until the owner adds the production key: see the key runbook
 * (`.work/auto-update/key-runbook.md` in the arc worktree). With no key no
 * signature verifies, so a client built now never installs anything. `id` is a
 * label (the first 16 hex chars of the SPKI's sha256, computed by the signing
 * script or core where node:crypto exists, not here).
 */
export const UPDATE_PUBLIC_KEYS: readonly { id: string; spki: string }[] = []

/**
 * macOS: designated requirements a staged release may satisfy instead of the
 * running app's own (design review ruling 10). A release is accepted when
 * `codesign --verify -R '=<requirement>'` passes for the running app's
 * designated requirement OR for one of these, so a change of signing
 * certificate can be shipped: add the new certificate's requirement here in a
 * release signed with the old one, then sign with the new one. Empty by default:
 * only the running app's own identity is accepted. Ignored when the running app
 * is ad-hoc signed (a local build), which has no identity to keep.
 */
export const UPDATE_ACCEPTED_REQUIREMENTS: readonly string[] = []
