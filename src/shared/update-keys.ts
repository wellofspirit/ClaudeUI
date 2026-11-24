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
