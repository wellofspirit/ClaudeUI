import { join } from 'node:path'
import type { ClaudePermissions, PermissionSuggestion } from '../../shared/types'

/**
 * Compile ClaudeUI's neutral permission rules (stored in Claude's
 * `Tool(specifier)` form — the source of truth the PermissionsDialog edits) into
 * an opencode permission ruleset, so the SAME user-configured allow/ask/deny
 * rules + additional directories apply to opencode sessions. See ADR-022.
 *
 * opencode rules are an ordered array evaluated LAST-MATCH-WINS. The caller
 * appends the compiled rules AFTER the autonomy-mode base ruleset, so user rules
 * override the base. Within the compiled block we emit allow → ask → deny so
 * that a tool matching multiple tiers resolves deny > ask > allow (deny is last
 * → wins), replicating Claude's precedence.
 */

export type OpencodeAction = 'allow' | 'ask' | 'deny'

export interface OpencodePermissionRule {
  permission: string
  pattern: string
  action: OpencodeAction
}

/**
 * Map a Claude tool name → opencode permission category. opencode groups tools
 * by category (`edit` covers Write/Edit/NotebookEdit; read-class tools each have
 * their own key). Unmapped tools (e.g. `mcp__…`) are skipped — opencode manages
 * MCP permissions separately and a bad guess could over/under-grant.
 */
const TOOL_TO_CATEGORY: Record<string, string> = {
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  NotebookRead: 'read',
  Bash: 'bash',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'task'
}

/**
 * Parse a Claude rule string `Tool(specifier)` → `{ tool, specifier? }`.
 * Mirrors cli.js's `cY`: a trailing `)` is required for a specifier, an empty or
 * `*` specifier collapses to a whole-tool rule. Returns null for an empty tool.
 */
export function parseClaudeRule(rule: string): { tool: string; specifier?: string } | null {
  const trimmed = rule.trim()
  const open = trimmed.indexOf('(')
  if (open < 0) return trimmed ? { tool: trimmed } : null
  // Specifier rules must end with ')'; otherwise treat the whole string as a tool name.
  if (!trimmed.endsWith(')')) return { tool: trimmed }
  const tool = trimmed.slice(0, open).trim()
  if (!tool) return null
  const specifier = trimmed.slice(open + 1, -1).trim()
  return specifier === '' || specifier === '*' ? { tool } : { tool, specifier }
}

/**
 * Translate a Claude specifier → an opencode `pattern` for the given category.
 * - Bash: Claude's `cmd:*` prefix form → opencode glob `cmd*`; an existing glob
 *   or exact command passes through.
 * - WebFetch: `domain:example.com` → `example.com*`.
 * - File/other: globs and exact paths pass through (both use glob matching).
 */
export function translateSpecifier(category: string, specifier: string | undefined): string {
  if (!specifier) return '*'
  if (category === 'bash') {
    const prefix = specifier.match(/^(.+):\*$/)
    if (prefix) return `${prefix[1]}*`
    return specifier
  }
  if (category === 'webfetch' || category === 'websearch') {
    const domain = specifier.match(/^domain:(.+)$/)
    if (domain) return `${domain[1]}*`
    return specifier
  }
  return specifier
}

function compileTier(rules: string[], action: OpencodeAction): OpencodePermissionRule[] {
  const out: OpencodePermissionRule[] = []
  for (const raw of rules) {
    const parsed = parseClaudeRule(raw)
    if (!parsed) continue
    const category = TOOL_TO_CATEGORY[parsed.tool]
    if (!category) continue // unmappable (e.g. MCP) — skip in v1
    out.push({ permission: category, pattern: translateSpecifier(category, parsed.specifier), action })
  }
  return out
}

/**
 * Compile a Claude permission set → opencode rules (allow → ask → deny order).
 * `additionalDirectories` become `external_directory` ALLOW rules (path + `/*`),
 * widening access — we intentionally do NOT add a blanket `external_directory:ask`
 * (that would prompt on opencode's own tool-output/temp dirs). See ADR-022.
 */
export function compileClaudeRulesToOpencode(perms: ClaudePermissions): OpencodePermissionRule[] {
  const rules: OpencodePermissionRule[] = [
    ...compileTier(perms.allow ?? [], 'allow'),
    ...compileTier(perms.ask ?? [], 'ask'),
    ...compileTier(perms.deny ?? [], 'deny')
  ]
  for (const dir of perms.additionalDirectories ?? []) {
    if (!dir) continue
    rules.push({ permission: 'external_directory', pattern: join(dir, '*'), action: 'allow' })
  }
  return rules
}

// ── Reverse direction: opencode approval → Claude "always allow" suggestion ────

/** Inverse of TOOL_TO_CATEGORY (first/canonical Claude tool per opencode category). */
const CATEGORY_TO_TOOL: Record<string, string> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  list: 'LS',
  edit: 'Edit',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task'
}

/**
 * Build an "always allow" suggestion (Claude `addRules` form) for an opencode
 * `permission.asked` event, so the approval dialog can offer persisting the rule.
 * `permission` is the opencode category (e.g. `bash`), `patterns` the matched
 * argument(s) (e.g. the command / path). Returns null for an unmapped category.
 *
 * The matched pattern becomes the rule specifier (`Bash(echo hi)`), which the
 * forward compiler maps back to opencode `{bash,'echo hi',allow}` — round-trips.
 * No specific/`*` pattern → a whole-tool rule.
 */
export function suggestOpencodeAllowRule(
  permission: string,
  patterns: string[] | undefined,
  destination = 'localSettings'
): PermissionSuggestion | null {
  const toolName = CATEGORY_TO_TOOL[permission]
  if (!toolName) return null
  const first = patterns?.find((p) => p && p !== '*')
  return {
    type: 'addRules',
    behavior: 'allow',
    destination,
    rules: [{ toolName, ...(first ? { ruleContent: first } : {}) }]
  }
}

/** Render a suggestion rule → a Claude rule string (`Tool(specifier)` / `Tool`). */
export function suggestionRuleToClaudeString(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

/** Map a PermissionSuggestion `destination` → a ClaudePermissions scope, or null
 *  (e.g. `session`, which opencode persists natively via replyPermission('always')). */
export function suggestionDestinationToScope(
  destination: string
): 'user' | 'project' | 'local' | null {
  switch (destination) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'local'
    default:
      return null
  }
}
