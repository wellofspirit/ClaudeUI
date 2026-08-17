import type { OpencodeAction, OpencodePermissionRule } from './permission-compiler'

/**
 * Host-side port of opencode's permission matcher, used by the auto-mode
 * ask-rule precedence guard (G9, `docs/automode-rework-plan.md` §4.5).
 *
 * Why we need it: opencode evaluates the ruleset itself, logs the matched rule,
 * and then **discards** it (`permission/index.ts:73`) — the `permission.asked`
 * event carries `{id, sessionID, permission, patterns, metadata, always, tool}`
 * and no provenance. So to know whether the ask we just received came from a
 * rule the *user* wrote, we have to re-run the match ourselves.
 *
 * This is deliberately opencode-specific and lives next to `permission-compiler.ts`
 * rather than in the engine-neutral `src/main/automode/` module.
 *
 * Ported verbatim in behaviour from opencode 1.17.14
 * (`vendor/opencode-src/packages/opencode/src/util/wildcard.ts` and
 * `.../permission/index.ts`).
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
 * `platform` is injectable purely so the win32 branch is testable off-Windows.
 */
export function wildcardMatch(
  str: string,
  pattern: string,
  platform: NodeJS.Platform = process.platform
): boolean {
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

/**
 * opencode's `evaluate()`: **last match wins** over the flattened ruleset, with
 * no fallthrough rule here (the caller decides what "no user rule matched"
 * means — opencode's own fallthrough is `{action:'ask', pattern:'*'}`, but that
 * default is exactly the thing we must NOT treat as user intent).
 */
export function evaluateOpencodeRules(
  permission: string,
  pattern: string,
  rules: readonly OpencodePermissionRule[],
  platform: NodeJS.Platform = process.platform
): OpencodeAction | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (
      wildcardMatch(permission, rule.permission, platform) &&
      wildcardMatch(pattern, rule.pattern, platform)
    ) {
      return rule.action
    }
  }
  return undefined
}

/**
 * True when a pending approval is explained by an `ask` the **user** authored.
 *
 * Matching is restricted to the user-origin ruleset on purpose: replicating
 * opencode's runtime *defaults* half is fragile (it depends on whitelisted dirs
 * and worktree state) and defaults never carry user intent. Within the user
 * half we honour opencode's last-match-wins, so a later user `allow`/`deny` on
 * the same pattern outranks an earlier `ask`.
 *
 * `patterns` mirrors the event payload: opencode asks once per pattern and needs
 * an ask if *any* of them resolves to `ask`. An absent/empty list degrades to
 * `['*']`, matching opencode's whole-category semantics.
 */
export function matchesUserAskRule(
  rules: readonly OpencodePermissionRule[],
  permission: string,
  patterns: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (rules.length === 0) return false
  const list = patterns && patterns.length > 0 ? patterns : ['*']
  return list.some((p) => evaluateOpencodeRules(permission, p, rules, platform) === 'ask')
}
