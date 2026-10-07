import type { OpencodeAction, OpencodePermissionRule } from './permission-compiler'
import { wildcardMatch as sharedWildcardMatch } from '../../shared/opencode-wildcard'

/**
 * Host-side port of opencode's permission matcher, used by the ask-rule
 * precedence guard (G9, `docs/automode-rework-plan.md` §4.5 — since ADR-085 S2
 * part of the host pre-check, `host-precheck.ts`, in every mode), by the host
 * session-allow set's coverage test (`session-allows.ts`) and by the 2.x
 * evaluators below.
 *
 * Why we need it: opencode evaluates the ruleset itself and does not say
 * which rule decided — `permission.asked` carries the action and resources
 * but no provenance. So to know whether the ask we just received came from a
 * rule the *user* wrote, we have to re-run the match ourselves.
 *
 * This is deliberately opencode-specific and lives next to `permission-compiler.ts`
 * rather than in the engine-neutral `src/main/automode/` module.
 *
 * The match is opencode's `Wildcard.match` (`packages/core/src/util/wildcard.ts`)
 * and its last-match-wins evaluation (`packages/core/src/permission.ts`).
 * The host-precheck helpers take rules in the `{permission, pattern, action}`
 * shape (`permission-v2.ts` `asHostPrecheckRules` adapts 2.x rules).
 */

/**
 * opencode's `Wildcard.match` (`shared/opencode-wildcard.ts`, which the
 * renderer uses too and so takes the platform explicitly) on THIS process's
 * platform by default.
 */
export function wildcardMatch(
  str: string,
  pattern: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return sharedWildcardMatch(str, pattern, platform)
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
 * where the host has to name the rule it acted on ({@link userDenyRule}).
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
 * denies. The compiler emits allow → ask → deny, so a matching deny is always
 * the user tier's last match.
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

// ── opencode 2.x (`{action, resource, effect}`, ADR-097 §3) ──────────────────

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
