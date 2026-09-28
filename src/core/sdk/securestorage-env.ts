/**
 * The ACTIVE multi-account credential dir (ADR-015), as module state.
 *
 * `dir` is the active account's directory, `~/.claude/ui/accounts/<id>/`, whose
 * `.credentials.json` the app owns; null = single-account mode, where cli.js
 * uses the user's own Claude Code login. `AccountManager.applyActive()` sets it,
 * and everything that must follow the active account reads it: `buildEnv()`
 * hands cli.js that file's access token (`host-token.ts`), the token keeper
 * keeps it fresh, and the usage code reads and attributes against it.
 *
 * The name predates that: spawns used to be pointed at `dir` through
 * `SKIP_SECURESTORAGE` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` and the (retired)
 * `skip-securestorage` patch, so cli.js read and refreshed the file itself.
 */

export interface SecurestorageEnv {
  /** The active account's credentials dir. */
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
