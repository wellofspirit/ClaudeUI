import { join } from 'node:path'
import type { ClaudePermissions, PermissionSuggestion } from '../../shared/types'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
// Import cycle by construction: `rules-sync` needs THIS module's
// `parseClaudeRule` to read a Claude rule, and this module needs its writer to
// keep the generated Codex rule file in step with a persisted "always allow".
// Both directions are call-time only (no top-level use of the other module), so
// ESM's live bindings resolve it whichever module is evaluated first.
import { syncCodexRulesFile } from '../codex/rules-sync'
import { logger } from '../services/logger'
import { broadBashGlobs } from './broad-bash-globs'
import { wildcardMatch } from './wildcard'

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
 *
 * ADR-085 §3 — two things make that precedence hold against opencode's
 * text-glob matching:
 * - a Bash DENY or ASK rule compiles to its verbatim pattern PLUS
 *   over-approximating globs (`broad-bash-globs.ts`), so a broader allow
 *   (`Bash(git:*)` → `git*`) can no longer answer a reordered form of a
 *   narrower deny/ask (`git push origin main --force` vs
 *   `Bash(git push --force:*)`). Allow rules stay verbatim — broadening an
 *   allow would be an over-grant;
 * - MCP rules (`mcp__server__tool`, `mcp__server`, `mcp__server__*`) compile to
 *   opencode's MCP permission keys (`opencodeMcpKey`) instead of being skipped.
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
 * their own key). MCP rules (`mcp__…`) have their own branch in `compileTier`
 * (ADR-085 §3, `opencodeMcpKey`); any other unmapped tool is skipped — a bad
 * guess could over/under-grant.
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
 * The only two URL schemes opencode's webfetch tool will act on — it throws on
 * anything else BEFORE asking for permission
 * (vendor/opencode-src/packages/opencode/src/tool/webfetch.ts: `if
 * (!params.url.startsWith("http://") && !params.url.startsWith("https://"))
 * throw`). So enumerating both is an exhaustive, not a heuristic, cover.
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
 * - Bash: Claude's `cmd:*` prefix form → opencode glob `cmd*`; an existing glob
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
  // `shell` is the 2.x id of the same tool (ADR-093 §3, `permission-v2.ts`).
  if (category === 'bash' || category === 'shell') {
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
 * (`vendor/opencode-src/packages/opencode/src/mcp/catalog.ts:117`). Exported
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
 * opencode's built-in permission keys and tool ids, which a server-level MCP
 * glob must not also match: the `ctx.ask({ permission: … })` keys and tool ids
 * under `vendor/opencode-src/packages/opencode/src` (`tool/*.ts`,
 * `session/tools.ts`, `session/processor.ts` `doom_loop`, `session/llm.ts`
 * `workflow_tool_approval`, `cli/cmd/run.ts` `plan_enter`/`plan_exit`,
 * `tool/registry.ts` ids incl. code mode's `execute`, and the MCP resource tool
 * ids `permission/index.ts` `disabled()` maps to `read`), plus names other
 * releases used (`todoread`, `multiedit`, `batch`, `codesearch`, `patch`) — one
 * too many here only withholds a server-level allow.
 */
const OPENCODE_BUILTIN_PERMISSION_KEYS: readonly string[] = [
  'bash',
  'edit',
  'read',
  'glob',
  'grep',
  'list',
  'task',
  'webfetch',
  'websearch',
  'todowrite',
  'todoread',
  'skill',
  'lsp',
  'question',
  'plan_enter',
  'plan_exit',
  'doom_loop',
  'external_directory',
  'workflow_tool_approval',
  'apply_patch',
  'write',
  'patch',
  'multiedit',
  'batch',
  'codesearch',
  'invalid',
  'execute',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
]

/** Is this one of opencode's built-in permission keys (so never an MCP tool's key)? */
export function isOpencodeBuiltinPermissionKey(key: string): boolean {
  return OPENCODE_BUILTIN_PERMISSION_KEYS.includes(key)
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

/**
 * One MCP rule → its opencode rule, or none.
 * - deny/ask: always emitted (a server that is not configured is inert; the
 *   `s_*` over-match of a built-in key — a server named `external`, `doom`,
 *   `plan`, `list`, … — is an accepted residual: it only tightens).
 * - allow, tool level: the exact key.
 * - allow, server level: `s_*` only for a server in the live set AND when no
 *   built-in key matches `s_*` (an allow on `external_*` would silently grant
 *   `external_directory`); otherwise skipped — an over-grant is worse than an
 *   inert rule.
 */
function compileMcpRule(
  raw: string,
  mcp: { server: string; tool?: string },
  action: OpencodeAction,
  mcpServers: readonly string[] | undefined
): OpencodePermissionRule | null {
  const permission = opencodeMcpKey(mcp.server, mcp.tool)
  if (action !== 'allow' || mcp.tool !== undefined) return { permission, pattern: '*', action }
  if (!mcpServers?.includes(mcp.server)) {
    logger.debug('permission-compiler', `MCP allow ${raw} skipped: server not in the live set`)
    return null
  }
  // Win32 folding — the broader match, so a collision on either platform skips.
  if (OPENCODE_BUILTIN_PERMISSION_KEYS.some((key) => wildcardMatch(key, permission, 'win32'))) {
    logger.debug(
      'permission-compiler',
      `MCP allow ${raw} skipped: ${permission} also matches a built-in permission key`
    )
    return null
  }
  return { permission, pattern: '*', action }
}

/** Compile options (ADR-085 §3). */
export interface CompileOptions {
  /**
   * The live MCP server set (bridged Claude servers, `claudeui`, `GET /mcp`
   * keys). Gates server-level ALLOW rules only; absent → none is emitted.
   */
  mcpServers?: readonly string[]
}

function compileTier(
  rules: string[],
  action: OpencodeAction,
  opts: CompileOptions
): OpencodePermissionRule[] {
  const out: OpencodePermissionRule[] = []
  for (const raw of rules) {
    const parsed = parseClaudeRule(raw)
    if (!parsed) continue
    const mcp = parseMcpRuleTool(parsed.tool)
    if (mcp) {
      const rule = compileMcpRule(raw, mcp, action, opts.mcpServers)
      if (rule) out.push(rule)
      continue
    }
    const category = TOOL_TO_CATEGORY[parsed.tool]
    if (!category) continue // unmappable — skip
    const patterns = translateSpecifierPatterns(category, parsed.specifier)
    // A Bash deny/ask also compiles to over-approximating globs, so no allow
    // (compiled before it, or a server-side approval) outranks it — see the
    // module header. A bare `Bash` rule has no specifier: `['*']` already.
    if (category === 'bash' && action !== 'allow' && parsed.specifier) {
      for (const glob of broadBashGlobs(parsed.specifier)) {
        if (!patterns.includes(glob)) patterns.push(glob)
      }
    }
    for (const pattern of patterns) {
      out.push({ permission: category, pattern, action })
    }
  }
  return out
}

/**
 * Compile a Claude permission set → opencode rules (allow → ask → deny order).
 * `additionalDirectories` become `external_directory` ALLOW rules (path + `/*`),
 * widening access — we intentionally do NOT add a blanket `external_directory:ask`
 * (that would prompt on opencode's own tool-output/temp dirs). See ADR-022.
 * `opts.mcpServers` is the live MCP server set; without it a server-level MCP
 * allow rule is never emitted (ADR-085 §3).
 */
export function compileClaudeRulesToOpencode(
  perms: ClaudePermissions,
  opts: CompileOptions = {}
): OpencodePermissionRule[] {
  const rules: OpencodePermissionRule[] = [
    ...compileTier(perms.allow ?? [], 'allow', opts),
    ...compileTier(perms.ask ?? [], 'ask', opts),
    ...compileTier(perms.deny ?? [], 'deny', opts)
  ]
  for (const dir of perms.additionalDirectories ?? []) {
    if (!dir) continue
    rules.push({ permission: 'external_directory', pattern: join(dir, '*'), action: 'allow' })
  }
  return rules
}

/**
 * The compiled user ruleset with every ALLOW rule removed — what auto mode
 * patches onto the opencode session instead of the full set.
 *
 * ## Why (cli.js parity, `docs/protocol-cc/14-auto-mode-classifier.md` §3 step 2)
 *
 * cli.js's auto-mode fast path re-runs the permission check "with
 * classifier-bypassing allow rules **filtered out**". We had no equivalent, and
 * the consequence was live-observed: with a user allow rule `Bash(git:*)`, NO
 * git command ever raised `permission.asked`, so the judge never saw one — an
 * agent then evaded the static deny `Bash(git push --force:*)` by reordering
 * arguments (`git push origin main --force`) and the force-pushes landed
 * completely unclassified. A user allow rule is a statement about the *ask*
 * tier ("don't interrupt me for this"), not a waiver of the security monitor;
 * in auto mode, where the monitor IS the reviewer, treating it as one turns
 * every allow rule into a hole straight through the gate.
 *
 * ## Why ALL allow rules, not just `bash`
 *
 * Auto mode's base is already `acceptEdits` (`buildAutoModeRuleset()` =
 * `{*:allow}` + guards, with `bash`/`webfetch` asking, and `edit` asking only
 * so the host-side agent-control gate can clear it — ADR-084 §3). So reads,
 * globs, greps, tasks and `external_directory` (the compiled form of
 * `additionalDirectories`) are auto-allowed by the BASE regardless of what the
 * user's allow rules say, and ordinary edits by that gate — dropping them
 * changes nothing. The only allow rules that can have any effect here are
 * precisely the ones that override a base `ask`, i.e. exactly the
 * "classifier-bypassing" set cli.js filters. Scoping the filter to `bash`
 * would therefore be a narrower rule with identical behavior
 * today and a silent hole the next time the base gates another category.
 *
 * ASK and DENY rules are kept: they only ever tighten, and the ask tier is what
 * the G9 precedence guard (`wildcard.ts` `matchesUserAskRule`) reads back. That
 * includes the broad Bash deny/ask globs and the MCP deny/ask keys (ADR-085
 * §3) — intended: they keep a reordered denied command from running under
 * auto mode's server-side ruleset too.
 * Session-scoped "always allow" answers are NOT affected — those are opencode's
 * own per-session state from a live human click, not a stored config rule.
 *
 * Non-auto modes keep the full compiled ruleset: with no judge in the loop, an
 * allow rule is the user's only way to say "stop asking me", and removing it
 * there would be a pure regression.
 */
export function withoutAllowRules(
  rules: readonly OpencodePermissionRule[]
): OpencodePermissionRule[] {
  return rules.filter((r) => r.action !== 'allow')
}

/**
 * ADR-085 ruling 7 — the compiled rules without the ALLOW rules for `edit`, `bash` and `task`:
 * what plan mode patches. Plan mode refuses edits/writes and non-read-only commands regardless of
 * the user's allow rules.
 *
 * Why. The session appends the user half AFTER the plan base, and opencode evaluates
 * last-match-wins over `ruleset, approved`
 * (`vendor/opencode-src/packages/opencode/src/permission/index.ts` `evaluate`), so a user `Edit`
 * or `Bash(git:*)` allow turned the plan base's `edit`/`bash` asks back into server-side allows:
 * the call never asked, the host's plan refusal never saw it, and `git commit` ran. Dropping them
 * keeps both asks reaching the host. A bash allow cannot simply be kept for the read-only
 * commands — a glob over the command text cannot tell `git status` from `git commit` — so it is
 * applied HOST-side instead, where read-only-ness is judged per command
 * (`host-precheck.ts`: `plan-refuse` for a command `isPlanReadOnlyCommand` cannot vouch for,
 * `allow-rule` for a plan-safe one the user's allow rules cover).
 *
 * `task` allows go too, whatever their pattern. In plan mode the `{*: allow}` baseline already
 * allows every subagent except `general` (the base's one `task:general` ask), so a user `task`
 * allow can have exactly one server-side effect there: re-allowing the mutating `general`
 * subagent, whose ask the host refuses — and whose child session would then edit unasked (a
 * child inherits only the parent's denies). A `Task(explore)` allow is redundant with the
 * baseline; the user's task ask/deny rules compile after the allows and are kept.
 *
 * Why only these three categories: the ruling names edits/writes and commands, and `task:general`
 * is plan mode's third refusal. `read`/`glob`/`grep`/`list`/`external_directory` allows only
 * widen reads; `webfetch`, `websearch` and MCP allows keep today's behaviour — a recorded
 * residual. Every ask and deny passes through unchanged, including the broad Bash deny/ask
 * globs.
 *
 * Auto mode is unaffected: it patches {@link withoutAllowRules}, which strips every allow.
 */
export function withoutMutatingAllowRules(
  rules: readonly OpencodePermissionRule[]
): OpencodePermissionRule[] {
  return rules.filter(
    (r) =>
      !(
        r.action === 'allow' &&
        (r.permission === 'edit' || r.permission === 'bash' || r.permission === 'task')
      )
  )
}

// ── Reverse direction: opencode approval → Claude "always allow" suggestion ────

/**
 * Inverse of TOOL_TO_CATEGORY (first/canonical Claude tool per opencode category).
 * `shell` and `subagent` are the 2.x ids of `bash` and `task` (ADR-093 §3), so a
 * 2.x `permission.asked` action maps back the same way.
 */
const CATEGORY_TO_TOOL: Record<string, string> = {
  shell: 'Bash',
  subagent: 'Task',
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
