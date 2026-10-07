import type { PermissionSuggestion } from '../../shared/types'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
// Import cycle by construction: `rules-sync` needs THIS module's
// `parseClaudeRule` to read a Claude rule, and this module needs its writer to
// keep the generated Codex rule file in step with a persisted "always allow".
// Both directions are call-time only (no top-level use of the other module), so
// ESM's live bindings resolve it whichever module is evaluated first.
import { syncCodexRulesFile } from '../codex/rules-sync'
import { logger } from '../services/logger'

/**
 * The Claude-rule half of opencode's permission handling that does not depend
 * on the wire shape: parsing a Claude `Tool(specifier)` rule, translating a
 * specifier into the resource globs opencode matches, opencode's MCP key
 * naming, and the reverse direction — an opencode ask → a Claude "always
 * allow" suggestion, persisted to the shared Claude permission store. The
 * compiler itself (Claude rules → 2.x `{action, resource, effect}` rules) is
 * `permission-v2.ts` (ADR-022, ADR-085 §3, ADR-097 §3).
 */

export type OpencodeAction = 'allow' | 'ask' | 'deny'

/**
 * A rule in the host pre-check's shape (`host-precheck.ts`, `wildcard.ts`):
 * `permission` = the 2.x action, `pattern` = the resource glob
 * (`permission-v2.ts` `asHostPrecheckRules`).
 */
export interface OpencodePermissionRule {
  permission: string
  pattern: string
  action: OpencodeAction
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
 * The only two URL schemes opencode's webfetch tool will act on — it throws on
 * anything else BEFORE asking for permission
 * (vendor/opencode-src/packages/core/src/tool/plugin/webfetch.ts `assertHttpUrl`,
 * then `permission.assert` with `resources: [input.url]`). So enumerating both
 * is an exhaustive, not a heuristic, cover.
 */
const WEBFETCH_SCHEMES = ['http://', 'https://'] as const

/**
 * What may legally follow a host in a URL: nothing (bare origin), a path, a
 * port, or a fragment. Emitting the host with each of these terminators
 * anchors the match to the host BOUNDARY, so `domain:example.com` cannot also
 * match `https://example.com.evil.example/steal` the way a bare
 * `https://example.com*` prefix would. That matters because the SAME
 * translation feeds the ALLOW tier — turning today's inert rule into an
 * over-grant would be a worse bug than the one being fixed.
 *
 * Known gap: a query string with NO path (`https://example.com?q=1`) is not
 * covered — `?` is a single-char METAcharacter in opencode's `Wildcard.match`
 * (vendor/.../util/wildcard.ts maps `?` → `.`), so a literal `?` is simply not
 * expressible in a pattern. Every URL normaliser (and every browser) rewrites
 * that form to `https://example.com/?q=1`, which the `/*` terminator covers.
 */
const WEBFETCH_HOST_TERMINATORS = ['', '/*', ':*', '#*'] as const

/**
 * Translate a Claude specifier → the opencode `pattern`(s) for the given
 * category. Returns a LIST because one Claude specifier can need several
 * opencode patterns to cover the same subject space (see WebFetch below);
 * every emitted pattern carries the rule's action, so they are semantically
 * one rule.
 *
 * - shell (Bash): Claude's `cmd:*` prefix form → opencode glob `cmd*`; an existing glob
 *   or exact command passes through.
 * - WebFetch: `domain:example.com` → the URL-shaped patterns opencode actually
 *   matches against. opencode asks with the FULL URL (`patterns: [params.url]`
 *   in webfetch.ts), NOT the host, so the old host-shaped `example.com*`
 *   pattern could never match `https://example.com/x` — every WebFetch domain
 *   rule the user wrote was silently inert.
 * - WebSearch: `domain:…` is deliberately left in its legacy host-glob form —
 *   opencode's websearch asks with the search QUERY (`patterns: [params.query]`
 *   in websearch.ts), which no URL-shaped pattern could match either. There is
 *   no faithful mapping for "restrict results to a domain" in opencode's
 *   permission model; emitting URL patterns here would only trade one inert
 *   shape for another while implying a guarantee we cannot keep.
 * - File/other: globs and exact paths pass through (both use glob matching).
 */
export function translateSpecifierPatterns(
  category: string,
  specifier: string | undefined
): string[] {
  if (!specifier) return ['*']
  if (category === 'shell') {
    const prefix = specifier.match(/^(.+):\*$/)
    return [prefix ? `${prefix[1]}*` : specifier]
  }
  if (category === 'webfetch') {
    const domain = specifier.match(/^domain:(.+)$/)
    if (domain) {
      return WEBFETCH_SCHEMES.flatMap((scheme) =>
        WEBFETCH_HOST_TERMINATORS.map((tail) => `${scheme}${domain[1]}${tail}`)
      )
    }
    return [specifier]
  }
  if (category === 'websearch') {
    const domain = specifier.match(/^domain:(.+)$/)
    return [domain ? `${domain[1]}*` : specifier]
  }
  return [specifier]
}

// ── MCP rules → opencode MCP permission keys (ADR-085 §3) ────────────────────

/**
 * opencode's MCP name sanitiser, ported verbatim
 * (`vendor/opencode-src/packages/core/src/tool/mcp.ts` `namespace`/`name`). Exported
 * for the auto-mode allow-rule skip (ADR-085 §4), which compares a rule's
 * tool name to an MCP ask's key in the key's form.
 */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * The opencode permission key an MCP tool asks under, or the server-level glob
 * over them. opencode names an MCP tool `sanitize(server) + "_" +
 * sanitize(tool)` (`mcp/catalog.ts:117-119`) and asks with exactly that key and
 * `patterns: ["*"]` (`session/tools.ts:408`), so a rule is a `permission` glob
 * with pattern `*`. Server level is `sanitize(server) + "_*"` — never `*_*`:
 * built-in keys contain `_` too (`external_directory`, `doom_loop`, …).
 */
export function opencodeMcpKey(server: string, tool?: string): string {
  return `${sanitizeMcpName(server)}_${tool === undefined ? '*' : sanitizeMcpName(tool)}`
}

/**
 * Parse an MCP rule's TOOL NAME (a specifier in parens is ignored):
 * `mcp__<server>` or `mcp__<server>__*` → server level, `mcp__<server>__<tool>`
 * → tool level, the server being everything up to the next `__` (Claude's own
 * left-to-right reading). `null` when it is not an MCP rule or names no server.
 */
export function parseMcpRuleTool(tool: string): { server: string; tool?: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  const server = sep < 0 ? rest : rest.slice(0, sep)
  if (!server) return null
  const name = sep < 0 ? '' : rest.slice(sep + 2)
  return name === '' || name === '*' ? { server } : { server, tool: name }
}

// ── Reverse direction: opencode approval → Claude "always allow" suggestion ────

/**
 * opencode 2.x action → the canonical Claude tool (the inverse of
 * `permission-keys.ts` `CLAUDE_TOOL_TO_V2_ACTION`).
 */
const CATEGORY_TO_TOOL: Record<string, string> = {
  shell: 'Bash',
  subagent: 'Task',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  edit: 'Edit',
  webfetch: 'WebFetch',
  websearch: 'WebSearch'
}

/**
 * Build an "always allow" suggestion (Claude `addRules` form) for an opencode
 * `permission.asked` event, so the approval dialog can offer persisting the rule.
 * `permission` is the opencode action (e.g. `shell`), `patterns` the matched
 * argument(s) (e.g. the command / path). Returns null for an unmapped category.
 *
 * The matched pattern becomes the rule specifier (`Bash(echo hi)`), which the
 * forward compiler maps back to opencode `{shell,'echo hi',allow}` — round-trips.
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
export function suggestionRuleToClaudeString(rule: {
  toolName: string
  ruleContent?: string
}): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

/** Map a PermissionSuggestion `destination` → a ClaudePermissions scope, or null
 *  (e.g. `session`, which the opencode host keeps in its session-allow set,
 *  `session-allows.ts` — ADR-085 S2; nothing is written for it). */
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

/**
 * Write "always allow" suggestions to the shared Claude permission store — the
 * ONE copy behind `CodexSession`, `PiSession` and `OpencodeSession`, which all
 * answer an approval the same way: group the suggested rules by the scope their
 * `destination` maps to, then merge each group into that scope's allow list.
 *
 * Destinations with no on-disk scope (`session`, `cliArg`) are skipped — those
 * are the engines' own in-memory grants (opencode's host session-allow set,
 * `session-allows.ts`; Codex's `sessionAllows`), already applied by the caller.
 *
 * Returns whether any scope was written, so a caller holding a cached rules
 * merge (PiSession) knows to invalidate it and honour the new rule on its very
 * next gate call. A failing store write is logged and swallowed: losing the
 * "always" is not worth failing the approval the user just answered.
 *
 * `source` is only the log label — pass the calling session's name.
 */
export function persistAllowSuggestions(
  suggestions: PermissionSuggestion[],
  cwd: string,
  source = 'permissions'
): boolean {
  try {
    const byScope = new Map<'user' | 'project' | 'local', string[]>()
    for (const suggestion of suggestions) {
      if (suggestion.type !== 'addRules' || suggestion.behavior !== 'allow' || !suggestion.rules)
        continue
      const scope = suggestionDestinationToScope(suggestion.destination)
      if (!scope) continue
      const entries = byScope.get(scope) ?? []
      for (const rule of suggestion.rules) entries.push(suggestionRuleToClaudeString(rule))
      byScope.set(scope, entries)
    }
    for (const [scope, ruleStrings] of byScope) {
      const perms = loadClaudePermissions(scope, cwd)
      const allow = new Set(perms.allow)
      for (const rule of ruleStrings) allow.add(rule)
      saveClaudePermissions(scope, { ...perms, allow: [...allow] }, cwd)
      // Only the user scope feeds the generated Codex execpolicy file.
      if (scope === 'user') syncCodexRulesFile()
    }
    return byScope.size > 0
  } catch (err) {
    logger.warn(
      source,
      `persisting allow rules failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
