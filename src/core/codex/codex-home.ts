/**
 * Where a Codex child keeps its state: the one rule, in one place.
 *
 * It lives apart from `rules-sync.ts` (its original home) because the transport
 * needs it too, and `rules-sync.ts` is the execpolicy compiler — it pulls in the
 * Claude permission loader, the opencode rule parser and the binary locator, and
 * carries module state of its own (`armCodexRulesSync`). None of that belongs in
 * the spawn path of every app-server. `rules-sync.ts` re-exports
 * {@link resolveCodexHome} so its callers and tests are unchanged.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `$CODEX_HOME` when set and non-empty, else `~/.codex` — Codex's own rule
 *  (`codex-rs/utils/home-dir/src/lib.rs` `find_codex_home`). */
export function resolveCodexHome(): string {
  return codexHomeForEnv(undefined)
}

/**
 * The home a child spawned with `env` will use. `CodexClientOptions.env`
 * REPLACES inheritance rather than merging, so the answer must come from the
 * environment the CHILD gets, not from this process's: Codex's `find_codex_home`
 * reads `CODEX_HOME` and then its own home directory, both out of its
 * environment. Only an absent `env` (every production caller today) falls back
 * to this process's `homedir()`.
 */
export function codexHomeForEnv(env: NodeJS.ProcessEnv | undefined): string {
  const fromEnv = (env ?? process.env).CODEX_HOME
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return join(env ? homeDirIn(env) : homedir(), '.codex')
}

/** `homedir()`'s own rule applied to a replacement environment. */
function homeDirIn(env: NodeJS.ProcessEnv): string {
  const home = process.platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME
  return home && home.length > 0 ? home : homedir()
}

/**
 * A stable key for one home across the spellings two callers may use for it
 * (relative vs absolute, `/` vs `\`, and on Windows a differing drive-letter or
 * path case, where the filesystem does not distinguish them).
 */
export function codexHomeKey(home: string): string {
  const absolute = resolve(home)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
