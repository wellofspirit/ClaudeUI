/**
 * ADR-085 S4 (owner ruling 4) — opencode subagents follow the PARENT
 * session's rules and mode for every gated tool (ADR-097 §3, S6).
 *
 * 2.x makes ruling 4 native: a `subagent` child is created with the parent's
 * WHOLE session ruleset (`core/src/session.ts` create, `permissions ??
 * parent.permissions`), evaluated after the child agent's own rules — so every
 * gated category asks or allows exactly as the parent's does. What the
 * inheritance loses is the child AGENT's own narrowing: a parent rule naming
 * an action (the mode's `shell` ask, a user `Read(x)` allow) outranks an agent
 * that denies that action outright (explore's `{*: deny}`, a custom agent's
 * `shell: deny`). {@link childSessionRuleset} restores it: the parent's rules
 * plus a whole-category deny for every action the parent names and the
 * agent's own rules wholly deny — hidden from the child, and denied at call
 * time. The host PATCHes it onto the child when the child appears
 * (`session.created` with `parentID`) and again on every re-apply of the
 * parent (the child's copy is a snapshot).
 */

import type { OpencodeAction } from './permission-compiler'
import { wireOrder, type V2Rule } from './permission-v2'
import type { Permission_Ruleset } from './protocol-v2/openapi'
import { wildcardMatch } from './wildcard'

/** Either glob matches the other (`lsphub_find_refs` vs `lsphub_*` overlap). */
function permissionsOverlap(a: string, b: string, platform?: NodeJS.Platform): boolean {
  return wildcardMatch(a, b, platform) || wildcardMatch(b, a, platform)
}

/**
 * Walk the ruleset from the end (last-match-wins): the first rule whose
 * permission overlaps `category` and whose action is in `open` → `true` (some
 * call in the category may resolve to it); a catch-all (`pattern === '*'`)
 * rule that covers the WHOLE category (`wildcardMatch(category, permission)`)
 * with an action outside `open` shadows everything before it → `false`. A
 * narrower rule outside `open` only carves out, so the walk goes on past it.
 */
function categoryMayReach(
  rules: readonly V2Rule[],
  category: string,
  open: ReadonlySet<OpencodeAction>,
  platform?: NodeJS.Platform
): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (open.has(rule.effect)) {
      if (permissionsOverlap(rule.action, category, platform)) return true
      continue
    }
    if (rule.resource === '*' && wildcardMatch(category, rule.action, platform)) return false
  }
  return false
}

const ALLOW_OR_ASK: ReadonlySet<OpencodeAction> = new Set(['allow', 'ask'])

/**
 * Does the agent's OWN ruleset (`Agent_Info.permissions` from `GET /api/agent`
 * — opencode's defaults, the agent's native rules, the user's config and the
 * ClaudeUI overlay) deny every call of `action`? True when, walking from the
 * end, a catch-all deny covering the whole action comes before any allow/ask
 * that overlaps it (`lsphub_*` vs `lsphub_find`, either way round). A narrower
 * deny only carves out, so it does not count.
 */
export function agentWhollyDenies(
  agentRules: Permission_Ruleset,
  action: string,
  platform?: NodeJS.Platform
): boolean {
  return !categoryMayReach(agentRules, action, ALLOW_OR_ASK, platform)
}

/**
 * The agent's own DENY rules that still hold at the end of its ruleset: a deny
 * no later allow/ask of the agent's overlaps (action globs either way, resource
 * globs either way). `explore`'s `{*: deny}` is carved by its later allows, so
 * it does not count (its whole-category denies are found per action by
 * {@link agentWhollyDenies}); a custom agent's `shell "git push*": deny` after
 * `{*: allow}` does. A narrow deny that the agent itself carves (`git *` deny,
 * then `git status` allow) is not restored — the host backstop
 * ({@link evaluateChildCall}) covers it on the ask.
 */
function agentDenyRulesThatHold(
  agentRules: Permission_Ruleset,
  platform?: NodeJS.Platform
): V2Rule[] {
  const overlap = (a: string, b: string) =>
    wildcardMatch(a, b, platform) || wildcardMatch(b, a, platform)
  return agentRules.filter(
    (rule, i) =>
      rule.effect === 'deny' &&
      !agentRules
        .slice(i + 1)
        .some(
          (later) =>
            later.effect !== 'deny' &&
            overlap(later.action, rule.action) &&
            overlap(later.resource, rule.resource)
        )
  )
}

/**
 * The ruleset to PATCH onto a 2.x subagent child — and to PATCH again
 * whenever the parent's rules change or the child's agent changes
 * (`session.agent.selected`: a resumed child can be switched to another
 * agent). Pure and deterministic; the inputs are not mutated.
 *
 * = the parent's (wire) session ruleset, then the child agent's own deny rules
 * that hold ({@link agentDenyRulesThatHold}), then `{action, "*", deny}` for
 * every action the parent's rules open (an allow or ask names it) that the
 * agent wholly denies ({@link agentWhollyDenies}), in `wireOrder`. After the
 * parent's rules, the agent's denies win under last-match-wins, so neither a
 * parent gate (`shell *` ask) nor a user allow turns them back into an ask or
 * an allow; the whole-category ones sit last and hide the tool.
 *
 * So `explore` under a default-mode parent: `edit` and
 * `claudeui_dispatch_agent` re-denied (hidden), `shell`/`webfetch` keep the
 * parent's ask (ruling 4). A custom agent with `{*: allow}` + `shell "git
 * push*": deny`: `git push` stays denied under the parent's `shell` ask.
 */
export function childSessionRuleset(
  parentRules: Permission_Ruleset,
  agentRules: Permission_Ruleset,
  platform?: NodeJS.Platform
): V2Rule[] {
  const opened: string[] = []
  for (const r of parentRules) {
    if (r.effect !== 'deny' && !opened.includes(r.action)) opened.push(r.action)
  }
  const whole = opened
    .filter((action) => agentWhollyDenies(agentRules, action, platform))
    .map((action): V2Rule => ({ action, resource: '*', effect: 'deny' }))
  const own = agentDenyRulesThatHold(agentRules, platform).filter(
    (d) => !whole.some((w) => w.action === d.action && w.resource === d.resource)
  )
  return wireOrder([...parentRules, ...own, ...whole])
}

/**
 * The child agent's OWN verdict on one call (last match over its rules, no
 * match = `ask`, as 2.x evaluates) — the host's backstop for a child ask that
 * arrives before the child's ruleset is PATCHed, or that the agent carves
 * itself: `deny` → refuse the ask with the agent's rule.
 */
export function evaluateChildCall(
  agentRules: Permission_Ruleset,
  action: string,
  resource: string,
  platform?: NodeJS.Platform
): OpencodeAction {
  for (let i = agentRules.length - 1; i >= 0; i--) {
    const rule = agentRules[i]
    if (
      wildcardMatch(action, rule.action, platform) &&
      wildcardMatch(resource, rule.resource, platform)
    )
      return rule.effect
  }
  return 'ask'
}
