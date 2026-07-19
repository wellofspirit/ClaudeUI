/**
 * PiPermissionEngine — pure, engine-neutral tool-gating decision for pi.
 *
 * pi has no native permission system (docs/protocol-pi/README.md
 * "Extensions"); PiSession.gateToolCall calls `decide()` on every `tool_call`
 * hook invocation with the session's live mode + the user's merged Claude
 * permission rules + a per-session "always allow" set, and turns the result
 * into an allow/deny/ask response for PiBridgeHost.
 *
 * Mirrors ADR-022's opencode ruleset semantics with an EVALUATOR instead of a
 * compiled ruleset (opencode patches a ruleset onto its own server; pi has no
 * server-side permission concept to patch, so ClaudeUI evaluates the same
 * rules itself, per tool_call, entirely in the main process).
 */
import type { ToolKind } from '../../shared/tool-kinds'
import { hostedMcpKind } from '../../shared/tool-kinds'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { loadClaudePermissions } from '../services/claude-settings'
import { parseClaudeRule } from '../opencode/permission-compiler'
import { logger } from '../services/logger'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

/** The merged (user + project + local scope) Claude permission rule set. Same shape as ClaudePermissions — merging three scopes together yields no new fields. */
export type MergedClaudeRules = ClaudePermissions

export interface PermissionEngineContext {
  /** Claude-style permission-mode string, as arrives at PiSession.setPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto' | ... */
  mode: string
  rules: MergedClaudeRules
  /** "Allow for this session" entries: bare pi tool name (e.g. 'edit'), or `bash:<normalized command>` for bash. */
  sessionAllows: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// piToolKind — SAME mapping as the renderer's PiEngineToolMap.kindOf
// ---------------------------------------------------------------------------

/**
 * Mirrors `PiEngineToolMap.kindOf` (src/renderer/.../PiEngineToolMap.ts) for
 * this engine's mode-base decisions. Main cannot import renderer code (they
 * are separate Electron processes/bundles), so this switch is intentionally
 * DUPLICATED here rather than shared — PiEngineToolMap.test.ts asserts the two
 * tables agree for every known pi tool name (single-source guard): a change to
 * one without the other fails that test.
 */
export function piToolKind(toolName: string): ToolKind {
  const mcpKind = hostedMcpKind(toolName)
  if (mcpKind !== null) return mcpKind

  switch (toolName) {
    case 'bash':
      return 'command'
    case 'edit':
      return 'fileEdit'
    case 'write':
      return 'fileWrite'
    case 'read':
      return 'fileRead'
    case 'grep':
    case 'find':
    case 'ls':
      return 'search'
    // Hosted tools (M4a+b) registered via pi.registerTool() in the bridge
    // extension use BARE names — hostedMcpKind above only matches `mcp__*`
    // prefixed names, so these need explicit cases here too. Mirrors
    // PiEngineToolMap.kindOf's IDENTICAL cases (renderer side) — the
    // single-source guard test (PiEngineToolMap.test.ts) asserts the two
    // tables agree for every known pi tool name.
    case 'render_mermaid':
      return 'diagram'
    case 'create_mockup':
    case 'show_mockup':
      return 'mockup'
    case 'dispatch_agent':
      return 'task'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Hosted-tool auto-allow (M4a)
// ---------------------------------------------------------------------------

/**
 * Hosted LLM tools (M4a) — ClaudeUI's own render_mermaid/create_mockup/
 * show_mockup, registered via pi.registerTool() over the bridge (see
 * pi-bridge-source.ts + PiBridgeHost's /hosted-tool route). ALWAYS ALLOWED —
 * parity with Claude's auto-allowed `mcp__claude-ui__` prefix and opencode's
 * silent `{*:allow}` baseline for the same tools. Checked in decide() AFTER
 * deny rules (a user's explicit deny still wins — see decide()'s doc
 * comment) but BEFORE ask/sessionAllows/allow/mode-base, so these three
 * never prompt or fall through the ladder.
 *
 * `dispatch_agent` is deliberately NOT in this set: it gets NORMAL gating
 * (falls through to mode base), matching Claude routing dispatch_agent
 * through its own separate, non-auto-allowed `claude-ui-collab` MCP server
 * (collab-tool.ts) rather than the auto-allowed `claude-ui` one.
 */
export const PI_AUTO_ALLOW_HOSTED_TOOLS: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup'
])

// ---------------------------------------------------------------------------
// Claude rule string -> pi kind mapping (for evaluating the user's rules)
// ---------------------------------------------------------------------------

/**
 * Claude canonical tool name -> pi ToolKind, for matching the user's
 * Tool(specifier) rule strings against a pi tool_call. LS is included
 * alongside Grep/Glob (all three collapse to pi's single 'search' kind,
 * pi's `ls`/`grep`/`find` tools) for parity with opencode's own
 * TOOL_TO_CATEGORY table (permission-compiler.ts), which treats Read/Glob/
 * Grep/LS as siblings. Any Claude tool name NOT in this table (WebFetch,
 * Task, NotebookEdit, MultiEdit, ...) has no pi analog and never matches.
 */
const CLAUDE_TOOL_TO_KIND: Record<string, ToolKind> = {
  Bash: 'command',
  Edit: 'fileEdit',
  Write: 'fileWrite',
  Read: 'fileRead',
  Grep: 'search',
  Glob: 'search',
  LS: 'search'
}

/** Reverse of the above, for building "always allow" suggestions from a pi tool_call (PiSession). */
export const PI_TOOL_TO_CLAUDE_TOOL: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  read: 'Read',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS'
}

/** Trim + collapse internal whitespace runs, for comparing bash commands. */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

function bashSpecifierMatches(specifier: string, input: Record<string, unknown>): boolean {
  const command = normalizeWhitespace(String(input.command ?? ''))
  const prefixMatch = specifier.match(/^(.+):\*$/)
  if (prefixMatch) {
    return command.startsWith(normalizeWhitespace(prefixMatch[1]))
  }
  return command === normalizeWhitespace(specifier)
}

// Debug-log de-duplication for skipped path-glob-style rules — process-scoped
// (not strictly per-PiSession-instance; decide() takes no session identity to
// key a finer-grained cache on, and repeating this debug line across sessions
// in the same long-lived Electron process is harmless noise, not a bug).
const loggedSkippedRules = new Set<string>()

/**
 * Does a single Claude rule string match this pi tool_call? Bare tool rules
 * (no specifier) match unconditionally for the mapped kind. Bash specifiers
 * are evaluated (prefix `cmd:*` / exact, whitespace-normalized). Any OTHER
 * specifier (path-glob rules like `Edit(src/**)`, or a Grep/Glob pattern) is
 * NOT evaluated in M2a — logged once (debug) and skipped, which correctly
 * falls through to the next tier rather than ever default-allowing.
 * M3: path-glob rules.
 */
function ruleMatchesTool(rule: string, kind: ToolKind, input: Record<string, unknown>): boolean {
  const parsed = parseClaudeRule(rule)
  if (!parsed) return false
  const mappedKind = CLAUDE_TOOL_TO_KIND[parsed.tool]
  if (!mappedKind || mappedKind !== kind) return false

  if (parsed.specifier === undefined) return true

  if (mappedKind === 'command') {
    return bashSpecifierMatches(parsed.specifier, input)
  }

  if (!loggedSkippedRules.has(rule)) {
    loggedSkippedRules.add(rule)
    logger.debug('PiPermissionEngine', `Skipping unevaluated specifier rule "${rule}" (path-glob rules land in M3)`)
  }
  return false
}

/** First rule in `rules` that matches this tool_call, or undefined. Used to build a human-readable deny reason. */
export function firstMatchingRule(
  rules: readonly string[],
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const kind = piToolKind(toolName)
  return rules.find((r) => ruleMatchesTool(r, kind, input))
}

/** The "allow for this session" dedup key for a tool_call — bash is scoped by its (normalized) command, everything else by bare tool name. */
export function sessionAllowKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') return `bash:${normalizeWhitespace(String(input.command ?? ''))}`
  return toolName
}

// ---------------------------------------------------------------------------
// Mode base
// ---------------------------------------------------------------------------

/**
 * Mode-base decision BEFORE user rules / sessionAllows are considered:
 *  - default            -> fileRead/search allow, everything else ask
 *  - acceptEdits         -> also fileEdit/fileWrite allow, bash/unknown ask
 *  - bypassPermissions/full/auto -> allow everything
 *  - plan (defensive; pi never advertises 'plan' in autonomyModes) -> treat as default
 *  - any other/unrecognised mode string -> treat as default (fail toward asking, not allowing)
 */
function modeBaseDecision(mode: string, kind: ToolKind): 'allow' | 'ask' {
  switch (mode) {
    case 'bypassPermissions':
    case 'full':
    case 'auto':
      return 'allow'
    case 'acceptEdits':
      return kind === 'fileRead' || kind === 'search' || kind === 'fileEdit' || kind === 'fileWrite'
        ? 'allow'
        : 'ask'
    case 'plan':
    case 'default':
    default:
      return kind === 'fileRead' || kind === 'search' ? 'allow' : 'ask'
  }
}

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

/**
 * Decide allow/ask/deny for one pi tool_call.
 *
 * Precedence — severity wins, deny(3) > hosted-auto-allow > ask(2) >
 * allow(1): any matching deny rule -> 'deny'; else a hosted LLM tool
 * (PI_AUTO_ALLOW_HOSTED_TOOLS, M4a) -> 'allow'; else any matching ask rule ->
 * 'ask'; else sessionAllows or a matching allow rule -> 'allow'; else the
 * mode base. This mirrors Claude's own deny > ask > allow precedence
 * (ADR-022 gives opencode the identical property) and keeps a deny/ask rule
 * meaningful even in `full` mode — an "allow everything" autonomy mode is
 * still not a bypass of an explicit user rule. The hosted-tool short-circuit
 * sits directly below deny (so an explicit user deny still wins) and above
 * everything else (so render_mermaid/create_mockup/show_mockup never prompt
 * or depend on mode/rules) — see PI_AUTO_ALLOW_HOSTED_TOOLS' doc comment.
 */
export function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PermissionEngineContext
): PermissionDecision {
  const kind = piToolKind(toolName)

  if (ctx.rules.deny.some((r) => ruleMatchesTool(r, kind, input))) return 'deny'
  if (PI_AUTO_ALLOW_HOSTED_TOOLS.has(toolName)) return 'allow'
  if (ctx.rules.ask.some((r) => ruleMatchesTool(r, kind, input))) return 'ask'
  if (ctx.sessionAllows.has(sessionAllowKey(toolName, input))) return 'allow'
  if (ctx.rules.allow.some((r) => ruleMatchesTool(r, kind, input))) return 'allow'

  return modeBaseDecision(ctx.mode, kind)
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * Exported (ADR-033 M4c): a pi cross-engine dispatch TARGET's gate uses this
 * verbatim as its `decide()` rules — a dispatched target should not inherit
 * the user's interactive-session Claude permission rules (only the target's
 * fixed autonomy mode governs it). See cross-engine-dispatcher.ts's
 * `gatePiTargetToolCall`.
 */
export const EMPTY_RULES: MergedClaudeRules = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

/**
 * Merge the user/project/local Claude permission scopes for `cwd` (mirrors
 * OpencodeSession.compiledUserRules' identical 3-scope merge — ADR-022
 * parity: "one config applies to all harnesses"). Best-effort: any failure
 * yields empty rules rather than breaking gating.
 */
export function mergedClaudeRulesFor(cwd: string): MergedClaudeRules {
  try {
    const merged: MergedClaudeRules = {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }
    const scopes: PermissionScope[] = ['user', 'project', 'local']
    for (const scope of scopes) {
      const p = loadClaudePermissions(scope, cwd)
      merged.allow.push(...p.allow)
      merged.deny.push(...p.deny)
      merged.ask.push(...p.ask)
      merged.additionalDirectories.push(...p.additionalDirectories)
    }
    return merged
  } catch (err) {
    logger.warn(
      'PiPermissionEngine',
      `mergedClaudeRulesFor failed (best-effort -> empty rules): ${err instanceof Error ? err.message : String(err)}`
    )
    return { ...EMPTY_RULES }
  }
}
