/**
 * opencode's permission/policy matcher (`util/wildcard.ts`), shared by the
 * host's rule evaluation (`core/opencode/wildcard.ts`) and the config editors
 * (provider policies, tool rules), which evaluate config rules the same way.
 *
 * Shared code runs in the renderer and the web client too, where there is no
 * `process`: the platform is therefore an explicit argument here, never read
 * from the environment (the main side passes `process.platform`, the renderer
 * `window.api.platform`).
 */

/**
 * opencode's `Wildcard.match`: an anchored regex over the pattern.
 *
 * - both sides normalise `\` → `/` (so Windows paths match POSIX patterns)
 * - regex metacharacters are escaped, then `*` → `.*` and `?` → `.`
 * - a pattern ending in `" *"` also matches the bare prefix (`"ls *"` matches
 *   both `ls` and `ls -la`)
 * - dotall always; case-insensitive on win32 only
 *
 * `platform` decides only the case-folding (`win32` folds); any other value,
 * `web` included, matches case-sensitively.
 */
export function wildcardMatch(str: string, pattern: string, platform: string): boolean {
  if (str) str = str.replaceAll('\\', '/')
  if (pattern) pattern = pattern.replaceAll('\\', '/')
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars
    .replace(/\*/g, '.*') // * becomes .*
    .replace(/\?/g, '.') // ? becomes .

  // Pattern ending in " *" makes the trailing part optional, so "ls *" matches
  // both "ls" and "ls -la".
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'

  const flags = platform === 'win32' ? 'si' : 's'
  return new RegExp('^' + escaped + '$', flags).test(str)
}
