/**
 * ADR-085 S4 (owner ruling 4) — opencode task subagents follow the PARENT
 * session's rules and mode for every gated tool.
 *
 * ## opencode 2.x (ADR-093 §3, S6) — {@link childSessionRuleset}
 *
 * 2.x makes ruling 4 native: a `subagent` child is created with the parent's
 * WHOLE session ruleset (`core/src/session.ts` create, `permissions ??
 * parent.permissions`), evaluated after the child agent's own rules — so every
 * gated category asks or allows exactly as the parent's does, and neither the
 * spawn-time static asks nor the `subagent:<name>` backstop below is needed.
 * What the inheritance loses is the child AGENT's own narrowing: a parent
 * rule naming an action (the mode's `shell` ask, a user `Read(x)` allow)
 * outranks an agent that denies that action outright (explore's `{*: deny}`,
 * a custom agent's `shell: deny`). {@link childSessionRuleset} restores it:
 * the parent's rules plus a whole-category deny for every action the parent
 * names and the agent's own rules wholly deny — hidden from the child, and
 * denied at call time. The host PATCHes it onto the child when the child
 * appears (`session.created` with `parentID`) and again on every re-apply of
 * the parent (the child's copy is a snapshot).
 *
 * The 1.x half below (static asks, backstop) serves the 1.x
 * `OpencodeSession`/dispatcher path only and goes with it (ADR-093 S10).
 *
 * ## opencode 1.x
 *
 * Why. An opencode task child runs under its own AGENT ruleset — `general` =
 * `{*: allow}` + the user's top-level config, `explore` = `{*: deny}` plus its
 * own `bash`/`webfetch`/… allows (`vendor/opencode-src/packages/opencode/src/
 * agent/agent.ts` `defaults` ~119, `general` ~182, `explore` ~196) — and the
 * child SESSION copies only the parent's `deny` + `external_directory` rules
 * (`agent/subagent-permissions.ts`). So in every parent mode a child ran bash,
 * edits, fetches and MCP tools with no ask, and in plan mode `explore`'s own
 * `bash: allow` ran `hostname` unasked. Ruling 4: children always ASK for the
 * gated categories, and the host answers each ask with the parent's current
 * ruleset (`host-precheck.ts` `parent-allow`).
 *
 * Two halves live here:
 *  - the STATIC asks injected at spawn (`OPENCODE_CONFIG_CONTENT.agent.<name>
 *    .permission`, {@link buildSubagentPermissionConfig}): the server config is
 *    per cwd and mode-less, and a PATCH on child discovery lands after the
 *    child's `runLoop` snapshot (`session/prompt.ts:1086`), so the ask has to be
 *    in the agent's own ruleset before the child starts;
 *  - the parent-side BACKSTOP ({@link subagentBackstopRules}): after reading
 *    the computed agent rulesets (`GET /agent`), a `task:<name>` ask on the
 *    parent for every subagent a gated category may still be allowed under —
 *    agents the pre-spawn scan cannot see (inline `agent:` keys in
 *    opencode.json, parent-dir `.opencode`, a user top-level allow that
 *    un-denies `explore`). The `task` ask is evaluated in the PARENT
 *    (`tool/task.ts:119-129`, patterns = `[subagent_type]`).
 */

import { logger } from '../services/logger'
import type { OpencodeAgentMode, OpencodeAgentScope } from './opencode-agents'
import {
  isAction,
  scanOpencodeConfig,
  withToolsPermission,
  type OpencodePermissionConfig
} from './opencode-config-permissions'
import type { OpencodeAction, OpencodePermissionRule } from './permission-compiler'
import { opencodeMcpKey } from './permission-compiler'
import { CLAUDEUI_MCP_SERVER, type PermissionRule } from './permission-ruleset'
import { wireOrder, type V2Rule } from './permission-v2'
import type { Permission_Ruleset } from './protocol-v2/openapi'
import { wildcardMatch } from './wildcard'

/**
 * A 1.x `GET /agent` row as the backstop reads it — structural, so this
 * module does not depend on the 1.x client. (2.x rows are `Agent_Info`, read
 * by {@link childSessionRuleset}'s caller.)
 */
export interface V1AgentRow {
  name: string
  mode: 'primary' | 'subagent' | 'all'
  permission: OpencodePermissionRule[]
}

/** The categories the parent's rulesets gate that a child would otherwise answer server-side. */
export const CHILD_GATED_CATEGORIES = ['bash', 'edit', 'webfetch'] as const

/** One agent's injected permission block: string asks only. */
export type SubagentPermissionConfig = Record<string, { permission: Record<string, 'ask'> }>

/**
 * An agent as the spawn-time scan sees it (`opencode-config-permissions.ts`
 * `scanOpencodeConfig`): its md files and `agent.<name>` config entries,
 * merged in opencode's order.
 */
export interface SubagentScanEntry {
  name: string
  kind: 'custom' | 'builtin'
  mode: OpencodeAgentMode
  disabled?: boolean
  /** Informational (where a file backs it); the ask model does not depend on it. */
  scope: OpencodeAgentScope | null
  /**
   * The agent's OWN `permission` config: a string map as the settings UI
   * writes it, or — hand-written — an object (pattern map) per key or a bare
   * string for the whole block, all read as opencode's `Permission.fromConfig`
   * would.
   */
  permission?: OpencodePermissionConfig | string
  /**
   * The legacy `tools` map (`{bash: false}` …): folded UNDER `permission` the
   * way the vendor decodes an agent (`packages/core/src/v1/config/agent.ts`
   * `normalize` ~62-80) — a `false` is a `deny`, `write`/`edit`/`patch` map to
   * `edit`, and an explicit `permission` key wins.
   */
  tools?: Record<string, boolean>
}

/**
 * Built-ins ClaudeUI's catalog lists as hidden subagents (`opencode-agents.ts`
 * `BUILTIN_AGENTS`) but the vendor runs as tool-less hidden PRIMARIES
 * (`agent.ts` `compaction`/`title`/`summary`: `mode: "primary"`, `{*: deny}`) —
 * never task-able, so never injected.
 */
const TOOL_LESS_BUILTINS: ReadonlySet<string> = new Set(['title', 'summary', 'compaction'])

/**
 * The native ruleset each task-able agent starts from before its own file
 * (`agent.ts`): `general` and every custom agent `defaults` (`{*: allow}` —
 * custom agents are `merge(defaults, user)`, ~272-280); `explore` adds
 * `{*: deny}` and its own read-class/`bash`/`webfetch` allows (~196-218).
 * Only the rules that can decide a gated category are modelled; the user's
 * top-level config (`user`) follows it, then the agent's own config.
 */
function nativeRules(name: string, kind: 'custom' | 'builtin'): OpencodePermissionRule[] {
  const rule = (permission: string, action: OpencodeAction): OpencodePermissionRule => ({
    permission,
    pattern: '*',
    action
  })
  const base = [rule('*', 'allow')]
  if (kind === 'builtin' && name === 'explore') {
    return [
      ...base,
      rule('*', 'deny'),
      ...['grep', 'glob', 'list', 'bash', 'webfetch', 'websearch', 'read'].map((p) =>
        rule(p, 'allow')
      )
    ]
  }
  return base
}

/**
 * A permission config as ordered rules, the way `Permission.fromConfig` reads
 * it (`permission/index.ts` ~186-198, key order is rule order): a string value
 * is one catch-all rule, an object value one rule per pattern. A bare string
 * (`{"*": <action>}`) and the legacy `tools` map are normalized first
 * (`withToolsPermission`). Anything else is ignored.
 */
function ownRules(permission: unknown, tools?: unknown): OpencodePermissionRule[] {
  const out: OpencodePermissionRule[] = []
  for (const [key, value] of Object.entries(withToolsPermission(permission, tools))) {
    if (isAction(value)) {
      out.push({ permission: key, pattern: '*', action: value })
    } else if (value && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (isAction(action)) out.push({ permission: key, pattern, action })
      }
    }
  }
  return out
}

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

/** A 1.x rule in the 2.x shape (the walk is the same glob logic on both). */
const asV2 = (rules: readonly OpencodePermissionRule[]): V2Rule[] =>
  rules.map((r) => ({ action: r.permission, resource: r.pattern, effect: r.action }))

const ALLOW_ONLY: ReadonlySet<OpencodeAction> = new Set(['allow'])
const ALLOW_OR_ASK: ReadonlySet<OpencodeAction> = new Set(['allow', 'ask'])

/**
 * Could a call in `category` still be ALLOWED under this agent ruleset for
 * SOME pattern? True when an `allow` rule whose permission overlaps `category`
 * (either glob matches the other — `wildcardMatch` both ways, so
 * `lsphub_find_refs` vs `lsphub_*` overlap) is not followed by a catch-all
 * (`pattern === '*'`) ask/deny rule for it. A later NARROWER ask/deny only
 * carves out, so the allow still stands — over-approximates toward "ungated"
 * (→ one more task ask), never toward "gated".
 */
export function categoryMayAllow(
  rules: readonly OpencodePermissionRule[],
  category: string,
  platform?: NodeJS.Platform
): boolean {
  return categoryMayReach(asV2(rules), category, ALLOW_ONLY, platform)
}

/**
 * Is every call in `category` DENIED under this ruleset — a covering catch-all
 * deny with no later allow/ask that overlaps it? Where it holds, an injected
 * ask would WIDEN the agent (a deny turned into an ask the host then answers
 * with the parent's rules, and a tool opencode hid — `disabled()` hides a
 * catch-all deny — made visible again), so no ask is injected.
 */
function categoryFullyDenied(
  rules: readonly OpencodePermissionRule[],
  category: string,
  platform?: NodeJS.Platform
): boolean {
  return !categoryMayReach(asV2(rules), category, ALLOW_OR_ASK, platform)
}

/**
 * `agent.<name>.permission` string asks for the spawn config
 * (`OPENCODE_CONFIG_CONTENT`, `OpencodeServerManager.buildOpencodeConfigContent`).
 *
 * Why STRING values: `OPENCODE_CONFIG_CONTENT` merges LAST among the user's
 * config sources (`config/config.ts:482-490`, after the `.opencode` agent
 * files), with `mergeDeep` — a string value REPLACES the agent file's value for
 * that key, where an object value would merge key-wise and keep a file's more
 * specific allow pattern (research probe: `bash: {"*": "ask"}` over a file's
 * `bash: {"git *": "allow"}` still allowed `git push`). The agent's own config
 * is applied after `defaults` and the user's top-level config (`agent.ts`
 * ~272-293), and the child SESSION tier (the parent's copied denies) after
 * that — so the injected ask beats `{*: allow}` and explore's `bash: allow`,
 * and the parent's compiled denies still beat the ask.
 *
 * Rules:
 *  - only task-able agents: `mode !== 'primary'` and not `disabled` (opencode
 *    deletes a disabled agent — injecting for it would resurrect it as a
 *    phantom), and never the tool-less hidden built-ins `title`/`summary`/
 *    `compaction` (primaries in the vendor; hidden subagents in ClaudeUI's
 *    catalog);
 *  - the candidate categories are {@link CHILD_GATED_CATEGORIES} plus
 *    `opencodeMcpKey(server)` for every server in `mcpServers` except
 *    `CLAUDEUI_MCP_SERVER` — the parent's own treatment of `claudeui`
 *    (mermaid/mockups allowed; the dispatch tool gated by its own rule, and a
 *    child's dispatch call fails closed anyway: the plugin stamps the CHILD
 *    session id, which no caller owns);
 *  - a category gets an ask UNLESS the agent's ruleset as opencode builds it —
 *    native rules, then the user's top-level config (`userPermission`), then
 *    the agent's own config (`agent.ts` order) — DENIES it entirely
 *    ({@link categoryFullyDenied}): an ask there would widen a deny. So
 *    `general` with no config gets every candidate; `explore` gets `bash`
 *    and `webfetch` ONLY — its `{*: deny}` already denies edits and MCP —
 *    unless the user's config re-opens a category (a top-level
 *    `permission.edit: allow` → an `edit` ask, no wider than that allow); a
 *    category the user's config denies outright (a string `deny`, a
 *    `"*": "deny"` it does not re-open, an all-deny pattern map, a legacy
 *    `tools: {x: false}`) gets none. Any other value (`allow`, `ask`,
 *    absent, a mixed pattern map) → `ask`: ruling 4, the parent's rules
 *    decide. A pattern-map value is REPLACED by the
 *    string ask (its narrower allows and denies are gone; the parent's rules,
 *    and the parent's denies the child session copies, decide instead);
 *  - never an entry for a name not in `agents` (opencode would create a
 *    PHANTOM agent, `mode: "all"`, for an unknown name — facts Q1), and never a
 *    top-level `permission` key (it sits after explore's `{*: deny}` and would
 *    turn its denies into asks);
 *  - output keys sorted (stable config content): agents by name, each
 *    agent's categories in {@link CHILD_GATED_CATEGORIES} order, then the MCP
 *    keys sorted.
 */
export function buildSubagentPermissionConfig(input: {
  /** The scanned agents (`scanOpencodeConfig`), each with its merged own `permission`. */
  agents: ReadonlyArray<SubagentScanEntry>
  /** MCP server names known at spawn (the bridged Claude servers); `claudeui` is ignored. */
  mcpServers: readonly string[]
  /** The user's merged top-level opencode `permission` (the vendor's `user` rules). */
  userPermission?: OpencodePermissionConfig
}): SubagentPermissionConfig {
  const mcpKeys = [
    ...new Set(
      input.mcpServers
        .filter((server) => server !== CLAUDEUI_MCP_SERVER)
        .map((server) => opencodeMcpKey(server))
    )
  ].sort()
  const candidates = [...CHILD_GATED_CATEGORIES, ...mcpKeys]
  const out: SubagentPermissionConfig = {}
  const eligible = input.agents
    .filter(
      (a) =>
        a.mode !== 'primary' &&
        !a.disabled &&
        !(a.kind === 'builtin' && TOOL_LESS_BUILTINS.has(a.name))
    )
    .map((a) => a.name)
  for (const name of [...new Set(eligible)].sort()) {
    const agent = input.agents.find((a) => a.name === name)!
    const rules = [
      ...nativeRules(agent.name, agent.kind),
      ...ownRules(input.userPermission),
      ...ownRules(agent.permission, agent.tools)
    ]
    const permission: Record<string, 'ask'> = {}
    for (const category of candidates) {
      if (!categoryFullyDenied(rules, category)) permission[category] = 'ask'
    }
    if (Object.keys(permission).length > 0) out[name] = { permission }
  }
  return out
}

/** The built-in task-able agents, as the scan reports them with no file. */
const BUILTIN_SUBAGENTS: readonly SubagentScanEntry[] = [
  { name: 'general', kind: 'builtin', mode: 'subagent', scope: null },
  { name: 'explore', kind: 'builtin', mode: 'subagent', scope: null }
]

/**
 * The spawn-time asks for a cwd: the opencode config scan
 * (`scanOpencodeConfig` — the user's config files and agent md files, merged
 * in opencode's order) fed to {@link buildSubagentPermissionConfig}. Never
 * throws: on any failure it returns the asks for the built-in set
 * (`general`/`explore`) alone — the built-ins are never skipped. A CUSTOM
 * agent whose md file could not be read is left out (its own ruleset stands,
 * and the parent-side `task:<name>` backstop gates its spawn) — never an ask
 * that might widen a deny it could not see.
 */
export function subagentPermissionConfigFor(
  cwd: string,
  mcpServers: readonly string[]
): SubagentPermissionConfig {
  try {
    const scan = scanOpencodeConfig(cwd)
    const agents = scan.agents.filter((a) => a.kind === 'builtin' || !scan.unreadable.has(a.name))
    return buildSubagentPermissionConfig({
      agents,
      mcpServers,
      userPermission: scan.userPermission
    })
  } catch (err) {
    logger.warn(
      'subagent-permissions',
      `agent scan failed — asks injected for the built-in subagents only: ${err instanceof Error ? err.message : String(err)}`
    )
    try {
      return buildSubagentPermissionConfig({ agents: BUILTIN_SUBAGENTS, mcpServers })
    } catch {
      return {}
    }
  }
}

/**
 * The parent-side backstop: one `{permission: 'task', pattern: <name>,
 * action: 'ask'}` per non-primary agent for which some gated category
 * {@link categoryMayAllow}s. `gated` = {@link CHILD_GATED_CATEGORIES} plus, in
 * auto mode only (the one mode whose parent base gates MCP),
 * `opencodeMcpKey(server)` per known server except `claudeui`. Sorted by name.
 * An agent whose `permission` is not an array (a malformed `GET /agent` row)
 * is treated as ungated — fail toward the ask.
 */
export function subagentBackstopRules(
  agents: readonly V1AgentRow[],
  gated: readonly string[],
  platform?: NodeJS.Platform
): PermissionRule[] {
  const names = new Set<string>()
  for (const agent of agents) {
    if (!agent || typeof agent.name !== 'string' || agent.mode === 'primary') continue
    const rules = Array.isArray(agent.permission) ? agent.permission : null
    if (rules === null || gated.some((category) => categoryMayAllow(rules, category, platform))) {
      names.add(agent.name)
    }
  }
  return [...names]
    .sort()
    .map((name): PermissionRule => ({ permission: 'task', pattern: name, action: 'ask' }))
}

/**
 * What the backstop patches when `GET /agent` failed: every task spawn asks
 * (fail closed, like the session PATCH itself; the static asks still cover
 * the built-ins).
 */
export const TASK_BACKSTOP_FAIL_CLOSED_RULE: PermissionRule = {
  permission: 'task',
  pattern: '*',
  action: 'ask'
}

// ── opencode 2.x ─────────────────────────────────────────────────────────────

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
