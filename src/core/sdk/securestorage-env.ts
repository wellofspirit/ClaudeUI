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

export type SecurestorageEnvListener = (env: SecurestorageEnv | null) => void

let current: SecurestorageEnv | null = null
const listeners = new Set<SecurestorageEnvListener>()

/**
 * Be told when the ACTIVE credential dir moves. Returns the unsubscribe.
 *
 * The switch itself is `AccountManager`'s (main), and core cannot import main —
 * so this is how a core service learns that the account changed without the
 * dependency going the wrong way. `UsageFetcher` is the caller: the identity it
 * holds belongs to a dir, and a switch invalidates it immediately, not at the
 * next half-hourly poll (S2e).
 *
 * Fired only when the dir ACTUALLY changes, so re-applying the same pointer —
 * which `AccountManager.persistAndApply` does on four different mutations — is
 * free.
 */
export function onSecurestorageEnvChange(listener: SecurestorageEnvListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setSecurestorageEnv(env: SecurestorageEnv | null): void {
  const before = current?.dir ?? null
  current = env
  if ((env?.dir ?? null) === before) return
  for (const listener of listeners) {
    try {
      listener(env)
    } catch {
      // A listener that throws must not stop the switch it is only observing.
    }
  }
}

export function getSecurestorageEnv(): SecurestorageEnv | null {
  return current
}
