import type { OpencodeAction, OpencodePermissionRule } from './permission-compiler'

/**
 * Host-side port of opencode's permission matcher, used by the ask-rule
 * precedence guard (G9, `docs/automode-rework-plan.md` §4.5 — since ADR-085 S2
 * part of the host pre-check, `host-precheck.ts`, in every mode) and by the
 * host session-allow set's coverage test (`session-allows.ts`).
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
  return lastMatchingRule(permission, pattern, rules, platform)?.action
}

/**
 * The rule {@link evaluateOpencodeRules} decides by — the LAST rule whose
 * `permission` and `pattern` both match — or `undefined` when none does. Used
 * where the host has to name the rule it acted on (ADR-085 S4: a child ask
 * the parent's ruleset denies is refused with that rule's text).
 */
export function lastMatchingRule(
  permission: string,
  pattern: string,
  rules: readonly OpencodePermissionRule[],
  platform: NodeJS.Platform = process.platform
): OpencodePermissionRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (
      wildcardMatch(permission, rule.permission, platform) &&
      wildcardMatch(pattern, rule.pattern, platform)
    ) {
      return rule
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

/**
 * The user DENY rule an ask resolves to, or `undefined`: the first of the
 * ask's patterns (absent/empty → `['*']`) whose last matching user-origin rule
 * denies. The host's replay of the server-side deny that
 * `permission-ruleset.ts` `opencodeWireRuleset` sends as an `ask` (ADR-085
 * follow-up) — the compiler emits allow → ask → deny, so a matching deny is
 * always the user tier's last match, and the rules the session appends after
 * that tier (the subagent backstop, the dispatch ask) are other permissions.
 */
export function userDenyRule(
  rules: readonly OpencodePermissionRule[],
  permission: string,
  patterns: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): OpencodePermissionRule | undefined {
  if (rules.length === 0) return undefined
  const list = patterns && patterns.length > 0 ? patterns : ['*']
  for (const pattern of list) {
    const rule = lastMatchingRule(permission, pattern, rules, platform)
    if (rule?.action === 'deny') return rule
  }
  return undefined
}

/**
 * opencode's per-ask verdict over a ruleset (`permission/index.ts` `ask()`):
 * evaluate every pattern (absent/empty → `['*']`); any `deny` → `'deny'`; all
 * `allow` → `'allow'`; else `'ask'`. A pattern no rule matches counts as
 * `'ask'` (opencode's own fallthrough — and fail toward the human).
 *
 * ADR-085 S4: the host answers a task child's ask with this verdict over the
 * PARENT session's current ruleset (`host-precheck.ts`, `parent-allow`).
 */
export function evaluateOpencodeAsk(
  rules: readonly OpencodePermissionRule[],
  permission: string,
  patterns: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): OpencodeAction {
  const list = patterns && patterns.length > 0 ? patterns : ['*']
  let verdict: OpencodeAction = 'allow'
  for (const pattern of list) {
    const action = evaluateOpencodeRules(permission, pattern, rules, platform) ?? 'ask'
    if (action === 'deny') return 'deny'
    if (action !== 'allow') verdict = 'ask'
  }
  return verdict
}

// ── opencode 2.x (`{action, resource, effect}`, ADR-093 §3) ──────────────────

/** A 2.x rule (structurally `Permission_Rule`). */
interface V2RuleShape {
  readonly action: string
  readonly resource: string
  readonly effect: OpencodeAction
}

/**
 * 2.x `Permission.evaluate`'s match (`core/src/permission.ts`): the LAST rule
 * whose `action` and `resource` globs both match, or `undefined`.
 */
export function lastMatchingV2Rule<R extends V2RuleShape>(
  action: string,
  resource: string,
  rules: readonly R[],
  platform: NodeJS.Platform = process.platform
): R | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (
      wildcardMatch(action, rule.action, platform) &&
      wildcardMatch(resource, rule.resource, platform)
    ) {
      return rule
    }
  }
  return undefined
}

/**
 * 2.x's verdict for one call over a ruleset (`permission.ts`
 * `evaluateInput`, without the saved-allow table): every resource is
 * evaluated (none → `['*']`); any `deny` → `deny`; any `ask` or unmatched
 * resource (2.x's default) → `ask`; else `allow`.
 */
export function evaluateV2Call(
  rules: readonly V2RuleShape[],
  action: string,
  resources: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): OpencodeAction {
  const list = resources && resources.length > 0 ? resources : ['*']
  const effects = list.map(
    (resource) => lastMatchingV2Rule(action, resource, rules, platform)?.effect ?? 'ask'
  )
  if (effects.includes('deny')) return 'deny'
  return effects.includes('ask') ? 'ask' : 'allow'
}

/**
 * 2.x `whollyDisabled` (`core/src/tool.ts`): is a tool whose permission id is
 * `action` hidden from the model? The last rule whose action glob matches
 * decides: hidden iff it is `resource:"*"` + `deny`. (`edit`, `write` and
 * `patch` all use the id `edit`; MCP tools `<server>_<tool>`.)
 */
export function v2ToolHidden(
  rules: readonly V2RuleShape[],
  action: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (wildcardMatch(action, rule.action, platform))
      return rule.resource === '*' && rule.effect === 'deny'
  }
  return false
}
