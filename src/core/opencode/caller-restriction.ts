/**
 * A subagent child's own restrictions, carried into the dispatch it makes
 * (ADR-097 S9, owner decision 2026-10-07, option a).
 *
 * When an opencode subagent child calls `dispatch_agent`, the dispatch belongs
 * to the chat it descends from (`resolveCallerRoot`), so the target would run
 * under the CHAT's mode and rules — wider than the child's agent may be (a
 * custom agent with `edit: deny` could get edits made through a Claude
 * target). The target therefore also gets the calling agent's own deny and ask
 * rules, as Claude-form rules (`Bash(...)`, `Edit(//abs/**)`, `WebFetch`,
 * `mcp__server`, …): the one vocabulary every target engine already compiles
 * the user's deny/ask tiers from (ADR-085 §3) — Claude's `--settings`, pi's and
 * Codex's permission engine, opencode's `compileClaudeRulesV2`.
 *
 * Semantics: the agent's own rules evaluated ALONE are a floor (the
 * `claudeui-xeng` plugin's child-agent floor, ADR-097 §3): last match wins, no
 * match = ask. Only ever TIGHTENS: deny and ask rules only, never an allow, and
 * a deny with no exact Claude-form equivalent becomes a whole-category deny —
 * never dropped. An ask with no equivalent is kept when it maps to a category,
 * and `external_directory` asks are not mapped (every target already gates
 * access outside its workspace: targets get no additional directories,
 * ADR-033).
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Permission_Ruleset } from './protocol-v2/openapi'
import { V2_BUILTIN_ACTIONS } from './permission-keys'
import { agentWhollyDenies, evaluateChildCall } from './subagent-permissions'
import { wildcardMatch } from './wildcard'

/** The restriction a dispatch carries from the subagent(s) that made it. */
export interface CallerRestriction {
  /** The calling agent ids, innermost first (a grandchild's chain included). */
  readonly agents: readonly string[]
  /** Claude-form deny rules. */
  readonly deny: readonly string[]
  /** Claude-form ask rules. */
  readonly ask: readonly string[]
}

/** The Claude tools each 2.x action stands for (the inverse of `permission-keys.ts`). */
const ACTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  shell: ['Bash', 'PowerShell'],
  read: ['Read', 'NotebookRead'],
  edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  subagent: ['Task', 'Agent'],
  skill: ['Skill'],
  question: ['AskUserQuestion'],
  // Not mapped: Code Mode's `execute`. Every ClaudeUI session ruleset denies it
  // (ADR-097 §3) and a child copies that, so the agent's own `execute` rule
  // never decides what the child can do; the categories it would call are
  // mapped on their own.
  // No Claude-form "outside the workspace": every file and shell tool.
  external_directory: [
    'Read',
    'NotebookRead',
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
    'Glob',
    'Grep',
    'Bash',
    'PowerShell'
  ]
}

/** The actions mapped one by one (the rest of the built-ins are Code Mode internals). */
const MAPPED_ACTIONS = Object.keys(ACTION_TOOLS)

type Tier = 'deny' | 'ask'

/** `*` in a 2.x resource crosses `/`; in a Claude path rule only `**` does. */
const pathGlob = (resource: string): string => resource.replace(/\*+/g, '**')

/** An absolute path specifier (`//abs`) for a 2.x path resource of `cwd`. */
function absolutePathRule(resource: string, cwd: string): string {
  const abs = isAbsolute(resource) ? resource : resolvePath(cwd, resource)
  return `/${pathGlob(abs.replace(/\\/g, '/'))}`
}

/** The host a URL glob names, when it names one exactly. */
function exactHost(resource: string): string | undefined {
  const match = resource.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
  const host = match?.[1]?.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  return host && !/[*?]/.test(host) ? host.toLowerCase() : undefined
}

/**
 * Claude-form rules for one narrow (resource ≠ `*`) rule of `action`; a
 * resource with no exact equivalent maps to the whole category.
 */
function narrowRules(action: string, resource: string, cwd: string): string[] {
  const whole = [...(ACTION_TOOLS[action] ?? [])]
  switch (action) {
    case 'shell': {
      const first = resource.trim().split(/\s+/)[0] ?? ''
      // A resource whose program is itself a glob has no Bash(...) form.
      if (!first || /[*?]/.test(first)) return whole
      return [`Bash(${resource.trim()})`, `PowerShell(${resource.trim()})`]
    }
    case 'read':
      return ['Read', 'NotebookRead'].map((tool) => `${tool}(${absolutePathRule(resource, cwd)})`)
    case 'edit':
      return ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].map(
        (tool) => `${tool}(${absolutePathRule(resource, cwd)})`
      )
    case 'external_directory':
      return ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead'].map(
        (tool) => `${tool}(${absolutePathRule(resource, cwd)})`
      )
    case 'webfetch': {
      const host = exactHost(resource)
      return host ? [`WebFetch(domain:${host})`] : whole
    }
    default:
      return whole
  }
}

/**
 * An MCP action (`<server>_<tool>`, 2.x `tool/mcp.ts`) → `mcp__<server>`. The
 * server/tool split of a sanitized name is ambiguous, so the WHOLE server (the
 * first segment) is restricted — tighter, never looser.
 */
function mcpRules(action: string): string[] {
  const server = action.split('_')[0]
  if (!server || /[*?]/.test(server)) return ['mcp__*']
  return [`mcp__${server}`]
}

/** The agent's rules of `tier` that still hold at the end (no later rule of another effect overlaps). */
function rulesThatHold(
  rules: Permission_Ruleset,
  tier: Tier,
  platform: NodeJS.Platform | undefined
): Permission_Ruleset[number][] {
  const overlap = (a: string, b: string) =>
    wildcardMatch(a, b, platform) || wildcardMatch(b, a, platform)
  return rules.filter(
    (rule, i) =>
      rule.effect === tier &&
      !rules
        .slice(i + 1)
        .some(
          (later) =>
            later.effect !== tier &&
            overlap(later.action, rule.action) &&
            overlap(later.resource, rule.resource)
        )
  )
}

/**
 * The calling agent's restriction from its own ruleset (`Agent_Info.permissions`).
 * `cwd` resolves relative path resources (the child's directory).
 */
export function callerRestrictionFromAgent(
  agent: { readonly id: string; readonly permissions: Permission_Ruleset },
  cwd: string,
  platform?: NodeJS.Platform
): CallerRestriction {
  const rules = agent.permissions
  const deny = new Set<string>()
  const ask = new Set<string>()
  const add = (tier: Tier, items: readonly string[]) => {
    for (const item of items) (tier === 'deny' ? deny : ask).add(item)
  }

  // Per category: the agent's verdict over the whole category, alone.
  for (const action of MAPPED_ACTIONS) {
    // No rule names the category at all: opencode asks (no match = ask).
    if (!rules.some((r) => wildcardMatch(action, r.action, platform))) {
      if (action !== 'external_directory') add('ask', ACTION_TOOLS[action])
      continue
    }
    if (agentWhollyDenies(rules, action, platform)) {
      add('deny', ACTION_TOOLS[action])
      continue
    }
    const verdict = evaluateChildCall(rules, action, '*', platform)
    // A catch-all deny the agent carves narrower allows out of: the target
    // cannot follow the carve-outs, so the whole category (tighter).
    if (verdict === 'deny') add('deny', ACTION_TOOLS[action])
    else if (verdict === 'ask' && action !== 'external_directory') add('ask', ACTION_TOOLS[action])
  }

  // Narrow rules that hold, and MCP rules.
  for (const tier of ['deny', 'ask'] as const) {
    for (const rule of rulesThatHold(rules, tier, platform)) {
      if (tier === 'ask' && rule.action === 'external_directory') continue
      const builtins = MAPPED_ACTIONS.filter((action) =>
        wildcardMatch(action, rule.action, platform)
      )
      for (const action of builtins)
        add(
          tier,
          rule.resource === '*' ? ACTION_TOOLS[action] : narrowRules(action, rule.resource, cwd)
        )
      // ClaudeUI's own hosted tools are not the target's.
      const mcpShaped =
        rule.action.includes('_') || /[*?]/.test(rule.action)
          ? !V2_BUILTIN_ACTIONS.some((b) => b === rule.action)
          : false
      if (mcpShaped && !wildcardMatch(rule.action, 'claudeui_*', platform))
        add(tier, mcpRules(rule.action))
    }
  }
  // A deny wins over an ask for the same rule.
  for (const rule of deny) ask.delete(rule)
  return { agents: [agent.id], deny: [...deny], ask: [...ask] }
}

/** Two restrictions together (a nested child: every level's). */
export function mergeRestrictions(
  a: CallerRestriction | undefined,
  b: CallerRestriction | undefined
): CallerRestriction | undefined {
  if (!a) return b
  if (!b) return a
  const deny = [...new Set([...a.deny, ...b.deny])]
  return {
    agents: [...new Set([...a.agents, ...b.agents])],
    deny,
    ask: [...new Set([...a.ask, ...b.ask])].filter((rule) => !deny.includes(rule))
  }
}

/** Does `held` already include every rule of `wanted` (a continuation may not loosen)? */
export function restrictionCovers(
  held: CallerRestriction | undefined,
  wanted: CallerRestriction | undefined
): boolean {
  if (!wanted) return true
  const deny = new Set(held?.deny ?? [])
  const either = new Set([...(held?.deny ?? []), ...(held?.ask ?? [])])
  return wanted.deny.every((rule) => deny.has(rule)) && wanted.ask.every((r) => either.has(r))
}

/** One line for the judge: what the calling agent may not do (empty when nothing). */
export function restrictionNote(restriction: CallerRestriction | undefined): string {
  if (!restriction || (restriction.deny.length === 0 && restriction.ask.length === 0)) return ''
  const who = restriction.agents.map((a) => JSON.stringify(a)).join(', ')
  const parts = [
    restriction.deny.length ? `may not: ${restriction.deny.join(', ')}` : '',
    restriction.ask.length ? `must ask before: ${restriction.ask.join(', ')}` : ''
  ].filter(Boolean)
  return `dispatched by the ${who} subagent, which ${parts.join('; ')}`
}
