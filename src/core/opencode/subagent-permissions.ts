/**
 * ADR-085 S4 (owner ruling 4) — opencode task subagents follow the PARENT
 * session's rules and mode for every gated tool.
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
// TODO(S6): 1.x `GET /agent` row (`permission: {permission, pattern, action}[]`).
// 2.x is `Agent_Info` from `OpencodeClient.agents()` with `permissions:
// {action, resource, effect}[]` and the v2 key table (ADR-093 §3).
import type { OpencodeAgentInfo } from './OpencodeV1Client'
import type { OpencodeAction, OpencodePermissionRule } from './permission-compiler'
import { opencodeMcpKey } from './permission-compiler'
import { CLAUDEUI_MCP_SERVER, type PermissionRule } from './permission-ruleset'
import { wildcardMatch } from './wildcard'

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
  rules: readonly OpencodePermissionRule[],
  category: string,
  open: ReadonlySet<OpencodeAction>,
  platform?: NodeJS.Platform
): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (open.has(rule.action)) {
      if (permissionsOverlap(rule.permission, category, platform)) return true
      continue
    }
    if (rule.pattern === '*' && wildcardMatch(category, rule.permission, platform)) return false
  }
  return false
}

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
  return categoryMayReach(rules, category, ALLOW_ONLY, platform)
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
  return !categoryMayReach(rules, category, ALLOW_OR_ASK, platform)
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
  agents: readonly OpencodeAgentInfo[],
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
