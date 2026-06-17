/**
 * Scoped credential-storage env state for cli.js spawns (ADR-015).
 *
 * Mirrors endpoint-env.ts: keep `SKIP_SECURESTORAGE` /
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` out of the Electron main process env and
 * overlay them only onto cli.js spawns via buildEnv().
 *
 * When set, the `skip-securestorage` patch forces cli.js to read/write the
 * plaintext `.credentials.json` in `dir` (bypassing the macOS Keychain), which
 * is how multi-account keeps a separate credential file per account. `dir` is
 * the active account's directory; null = single-account (Keychain) mode.
 */

export interface SecurestorageEnv {
  /** Per-account credentials dir → CLAUDE_SECURESTORAGE_CONFIG_DIR. */
  dir: string
}

let current: SecurestorageEnv | null = null

export function setSecurestorageEnv(env: SecurestorageEnv | null): void {
  current = env
}

export function getSecurestorageEnv(): SecurestorageEnv | null {
  return current
}
