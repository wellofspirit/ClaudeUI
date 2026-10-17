/**
 * ClaudeUI's permission model compiled for opencode 2.x (ADR-097 §3, amending
 * ADR-022 and ADR-085 for the 2.x engine). Pure: no I/O, no logger.
 *
 * ## 2.x facts this module is built on (`vendor/opencode-src` @ v2.0.24; 2.0.26 differs in `external_directory`, below)
 *
 * - A rule is `{action, resource, effect}`. A call is checked against
 *   `agent.permissions ++ session.permissions` (`core/src/permission.ts`
 *   `configured`), LAST MATCH WINS (`evaluate`, `Wildcard.match` on both
 *   fields), no match = `ask`. Every resource of the call is evaluated: any
 *   `deny` → `BlockedError` (model sees `permission.rejected` "Permission
 *   denied: <action>", no rule dump), any `ask` → `permission.asked`.
 * - The deny check runs over the configured rules ONLY. After it, the
 *   project's SAVED allows (`/api/permission/saved`, the "always" table in the
 *   shared DB) are appended — so a saved allow outranks any session `ask`, but
 *   never a `deny`.
 * - `PATCH /api/session/:id {permissions}` REPLACES the session's rules (1.x
 *   appended). A child session (the `subagent` tool) is created with the
 *   PARENT's whole session ruleset (`session.ts` create: `permissions ??
 *   parent.permissions`), a snapshot; the child's own agent rules come first.
 * - Tool visibility (`tool.ts` `whollyDisabled`): a tool is hidden from the
 *   model when the LAST rule whose action matches its permission id has
 *   `resource:"*"` and `effect:"deny"`. `edit`/`write`/`patch` share the id
 *   `edit`. Code Mode's `execute` is hidden the same way.
 *
 * ## Decisions (ADR-097 §3 "As built (S6)")
 *
 * - The session ruleset only TIGHTENS: no `{*: allow}` baseline (every agent
 *   starts from one natively). Mode gates are catch-all `ask`s, the user's
 *   compiled rules follow, then plan-mode enforcement, the Code Mode deny and
 *   the dispatch ask. Without a session-level catch-all allow, a subagent's own
 *   narrowing survives for every action the session does not name, and
 *   {@link childSessionRuleset} restores it for the ones it does.
 * - Narrow DENY rules stay server-side denies (1.x sent them as asks, because
 *   1.x's `DeniedError` dumped the ruleset into the model's context; 2.x does
 *   not, and only a deny is immune to the shared saved-allow table).
 * - Whole-category denies go LAST, so the tool is hidden (Claude Code removes a
 *   wholly denied tool from the model's list too) — {@link wireOrder}.
 * - `execute` (Code Mode) is wholly denied in every mode: its runtime carries
 *   an UNGATED `fetch` (`core/src/codemode/web.ts`), which would bypass the
 *   `webfetch` gate and the auto-mode judge.
 * - `external_directory` is ClaudeUI's own ask in EVERY mode ({@link
 *   externalDirectoryGates}). Up to 2.0.24 every agent carried `{*: ask}` plus
 *   allows for opencode's own directories; 2.0.25 removed both and made
 *   `explore` allow everything (#53585, `36a38058fb`). The session rules follow
 *   the agent's, so the ask outranks even `explore`'s allow; the own-dir allows
 *   (`own-dirs.ts`) and the user's `additionalDirectories` allows come
 *   after it and win.
 * - Plan mode wholly denies `edit` (hidden; plan mode wins, ADR-085 ruling 7,
 *   immune to saved allows) and denies the `general` subagent; shell stays an
 *   `ask` the host judges per command (`host-precheck.ts`).
 */
import type { ClaudePermissions } from '../../shared/types'
import { agentControlEditPatterns } from '../automode/agent-control-paths'
import { broadBashGlobs } from './broad-bash-globs'
import type { AgentPermissionOverlay } from './opencode-server-config'
import { absoluteSpecifier, pathResources } from './permission-paths'
import {
  opencodeMcpKey,
  parseClaudeRule,
  parseMcpRuleTool,
  translateSpecifierPatterns,
  type OpencodePermissionRule
} from './permission-compiler'
import {
  CLAUDE_TOOL_TO_V2_ACTION,
  isV2BuiltinAction,
  V2_PATH_ACTIONS,
  type V2Action
} from './permission-keys'
import type { Permission_Effect, Permission_Rule } from './protocol-v2/openapi'
import { wildcardMatch } from './wildcard'

export type V2Rule = Permission_Rule
export type V2Effect = Permission_Effect

const rule = (action: string, effect: V2Effect, resource = '*'): V2Rule => ({
  action,
  resource,
  effect
})

// ── Claude rules → 2.x rules ─────────────────────────────────────────────────

/** Compile options. */
export interface CompileV2Options {
  /**
   * The live MCP server set (bridged Claude servers, `claudeui`, `GET /api/mcp`
   * names). Gates server-level ALLOW rules only; absent → none is emitted.
   */
  mcpServers?: readonly string[]
  /** Home directory for `~/` path specifiers (default `os.homedir()`). */
  home?: string
  /**
   * The session directory. 2.x asks with a path RELATIVE to it for a file
   * inside it or inside its git worktree (`core/src/file-access.ts` `resolve`),
   * so path rules compile relative forms too (`permission-paths.ts`).
   */
  cwd?: string
  /** The session's git worktree root, when known (a settings-relative `/x` root). */
  worktree?: string
  /** The platform `//c/x` path rules are read for (default `process.platform`). */
  platform?: NodeJS.Platform
}

const slash = (value: string): string => value.replaceAll('\\', '/')

/**
 * One parsed Claude specifier → the resources it covers for `action`
 * (see `permission-keys.ts` for how each action spells its resource).
 */
function specifierResources(
  action: V2Action,
  specifier: string | undefined,
  effect: V2Effect,
  opts: CompileV2Options
): string[] {
  if (!specifier) return ['*']
  // Deny/ask path rules cover every spelling 2.x may ask with; allows stay precise.
  if (V2_PATH_ACTIONS.has(action)) return pathResources(specifier, opts, effect !== 'allow')
  // shell `cmd:*` → `cmd*`; webfetch `domain:` → URL forms; websearch legacy.
  return translateSpecifierPatterns(action, specifier)
}

function compileTierV2(rules: readonly string[], effect: V2Effect, opts: CompileV2Options) {
  const out: V2Rule[] = []
  const push = (r: V2Rule) => {
    if (!out.some((o) => o.action === r.action && o.resource === r.resource)) out.push(r)
  }
  for (const raw of rules) {
    const parsed = parseClaudeRule(raw)
    if (!parsed) continue
    const mcp = parseMcpRuleTool(parsed.tool)
    if (mcp) {
      const action = opencodeMcpKey(mcp.server, mcp.tool)
      // An ALLOW whose action matches a built-in action is never emitted —
      // server level (`opencode_*` would grant `opencode_read_mcp_resource`)
      // or tool level (`mcp__external__directory` is `external_directory`);
      // a server-level allow also needs the server in the live set. Deny/ask
      // always — they only tighten.
      if (effect === 'allow') {
        if (mcp.tool === undefined && !opts.mcpServers?.includes(mcp.server)) continue
        if (isV2BuiltinAction((key) => wildcardMatch(key, action, 'win32'))) continue
      }
      push(rule(action, effect))
      continue
    }
    const action = CLAUDE_TOOL_TO_V2_ACTION[parsed.tool]
    if (!action) continue // unmappable or a dead 1.x key — skip, never guess
    const resources = specifierResources(action, parsed.specifier, effect, opts)
    // ADR-085 §3: a shell deny/ask also covers reordered forms of its command.
    if (action === 'shell' && effect !== 'allow' && parsed.specifier) {
      for (const glob of broadBashGlobs(parsed.specifier)) {
        if (!resources.includes(glob)) resources.push(glob)
      }
    }
    for (const resource of resources) push(rule(action, effect, resource))
  }
  return out
}

/**
 * The user's Claude rules (all scopes merged) → 2.x rules, allow → ask → deny
 * so a call several tiers match resolves deny > ask > allow under
 * last-match-wins (Claude's precedence, ADR-022). `additionalDirectories`
 * become `external_directory` allows (`<dir>/*`, the resource 2.x asks with).
 */
export function compileClaudeRulesV2(
  perms: ClaudePermissions,
  opts: CompileV2Options = {}
): V2Rule[] {
  const out = [
    ...compileTierV2(perms.allow ?? [], 'allow', opts),
    ...compileTierV2(perms.ask ?? [], 'ask', opts),
    ...compileTierV2(perms.deny ?? [], 'deny', opts)
  ]
  for (const dir of perms.additionalDirectories ?? []) {
    if (!dir) continue
    const abs = absoluteSpecifier(dir, opts.home, opts.platform) ?? slash(dir)
    out.push(rule('external_directory', 'allow', `${abs.replace(/\/+$/, '')}/*`))
  }
  return out
}

/**
 * Auto mode (ADR-085 §4, cli.js parity): every ALLOW rule the user wrote is
 * left out of the server ruleset, so the calls it would answer still ask and
 * reach the host (the allow-rule skip, then the judge). Asks and denies only
 * tighten. The `external_directory` allows stay: they are compiled from
 * `additionalDirectories` — the user's configured workspace, not a per-call
 * allow (no Claude tool or MCP rule compiles to that action).
 */
export function withoutAllowRulesV2(rules: readonly V2Rule[]): V2Rule[] {
  return rules.filter((r) => r.effect !== 'allow' || r.action === 'external_directory')
}

/**
 * Plan mode (ADR-085 ruling 7): no `edit`, `shell` or `subagent` allow reaches
 * the server — appended after the plan gates they would turn its asks back
 * into allows. The user's shell allows are applied host-side for plan-safe
 * commands only (`host-precheck.ts` `allow-rule`).
 */
export function withoutMutatingAllowRulesV2(rules: readonly V2Rule[]): V2Rule[] {
  return rules.filter(
    (r) =>
      !(
        r.effect === 'allow' &&
        (r.action === 'edit' || r.action === 'shell' || r.action === 'subagent')
      )
  )
}

// ── Mode rulesets ────────────────────────────────────────────────────────────

/**
 * ClaudeUI's own hosted MCP server name on opencode (`opencode-hosted-tools.ts`,
 * `OpencodeServerManager.ts` — its tools are `claudeui_<tool>`).
 */
export const CLAUDEUI_MCP_SERVER = 'claudeui'

/**
 * The hosted cross-engine dispatch tool asks in every mode, after the user's
 * rules, so no blanket user rule can allow it silently (ADR-033 M2).
 */
export const DISPATCH_ASK_RULE: V2Rule = rule('claudeui_dispatch_agent', 'ask')

/**
 * Every hosted session tool asks in every mode (session tools, slice 2), so opencode
 * hands each call to ClaudeUI's `sessionToolsGate` (`OpencodeSession.routeSessionToolAsk`):
 * the scope and mode-parity decisions live there, and a mode that approves everything
 * (auto allows `claudeui_*`) must not skip them. After the user's rules, like the
 * dispatch ask.
 */
export const SESSION_TOOLS_ASK_RULE: V2Rule = rule(`${CLAUDEUI_MCP_SERVER}_session_*`, 'ask')

/** The session tools are hidden from a subagent child and a dispatch target: the root agent only. */
export const SESSION_TOOLS_DENY_RULE: V2Rule = rule(`${CLAUDEUI_MCP_SERVER}_session_*`, 'deny')

/**
 * Auto mode's catch-all for MCP tools. 2.x names an MCP tool's action
 * `<server>_<tool>` (`tool/mcp.ts` `name`), so every MCP action contains `_` —
 * whichever server, whenever it connected. The direct built-ins that contain
 * `_` are `external_directory` (re-stated by {@link autoModeGates}) and
 * ClaudeUI's own `claudeui_*` tools (re-allowed); the `opencode_*` built-ins
 * are Code Mode tools, unreachable while `execute` is hidden.
 */
export const AUTO_MCP_CATCH_ALL: V2Rule = rule('*_*', 'ask')

/** Code Mode: hidden in every mode (its runtime has an ungated `fetch`). */
export const EXECUTE_DENY_RULE: V2Rule = rule('execute', 'deny')

/**
 * What a throwaway session (side question, agent generation) runs with:
 * every tool hidden, so the model answers from text alone.
 */
export const THROWAWAY_RULESET: readonly V2Rule[] = [rule('*', 'deny')]

/**
 * The mode's gates, sent BEFORE the user's rules (so a user rule outranks
 * them). Asks only (plus the own-directory allows under the `external_directory`
 * ask, below): the agent's own `{*: allow}` is the baseline.
 *
 * - EVERY mode: `external_directory` asks, opencode's own directories allowed
 *   ({@link externalDirectoryGates}).
 * - default (also `ask`, `bypassPermissions` — ClaudeUI has no bypass for
 *   opencode — and auto with the classifier off): shell, edit, webfetch ask.
 * - acceptEdits / autoEdit: shell and webfetch ask; edits ask only on the
 *   agent-control paths (ADR-084 §3).
 * - auto (classifier on): acceptEdits, except EVERY edit asks (the host's
 *   agent-control gate clears ordinary ones) and EVERY MCP tool asks — a
 *   catch-all on the MCP action shape, so a server unknown when the rules were
 *   sent (late connect, the user's own config) is judged too
 *   ({@link autoModeGates}).
 * - plan: shell and webfetch ask; edits and the `general` subagent are
 *   enforced AFTER the user rules ({@link planEnforcement}).
 */
export function modeGates(
  mode: string,
  opts: { autoMode?: boolean; externalDirAllows?: readonly V2Rule[] } = {}
): V2Rule[] {
  const shellWeb = [rule('shell', 'ask'), rule('webfetch', 'ask')]
  const external = externalDirectoryGates(opts.externalDirAllows)
  switch (mode) {
    case 'plan':
      return [...shellWeb, ...external]
    case 'acceptEdits':
    case 'autoEdit':
      return [
        ...shellWeb,
        ...agentControlEditPatterns().map((p) => rule('edit', 'ask', p)),
        ...external
      ]
    case 'auto':
    case 'full':
      if (opts.autoMode) return autoModeGates(opts.externalDirAllows ?? [])
      return [rule('shell', 'ask'), rule('edit', 'ask'), rule('webfetch', 'ask'), ...external]
    default:
      return [rule('shell', 'ask'), rule('edit', 'ask'), rule('webfetch', 'ask'), ...external]
  }
}

/**
 * The `external_directory` ask every mode carries, then the allows for
 * opencode's own directories (`own-dirs.ts` `opencodeOwnDirAllows`) so
 * they stay silent. Placed in the mode gates — BEFORE the user's rules — so the
 * `additionalDirectories` allows compiled from them still win, and AFTER the
 * agent's own rules, so the ask outranks `explore`'s `{external_directory,*,allow}`
 * (2.0.25+) for it and for its subagent children. Only allows for the action
 * are taken from `ownDirAllows`.
 */
export function externalDirectoryGates(ownDirAllows: readonly V2Rule[] = []): V2Rule[] {
  return [
    rule('external_directory', 'ask'),
    ...ownDirAllows.filter((r) => r.action === 'external_directory' && r.effect === 'allow')
  ]
}

/**
 * Auto mode (classifier on): shell, webfetch and every edit ask; every MCP
 * tool asks ({@link AUTO_MCP_CATCH_ALL}) except ClaudeUI's hosted `claudeui_*`
 * tools (the dispatch tool keeps its own ask, appended later). The catch-all
 * also covers `external_directory`; it is re-stated as the ordinary ask with
 * opencode's own directories allowed after it ({@link externalDirectoryGates}).
 */
export function autoModeGates(externalDirAllows: readonly V2Rule[] = []): V2Rule[] {
  return [
    rule('shell', 'ask'),
    rule('webfetch', 'ask'),
    rule('edit', 'ask'),
    AUTO_MCP_CATCH_ALL,
    rule(`${CLAUDEUI_MCP_SERVER}_*`, 'allow'),
    ...externalDirectoryGates(externalDirAllows)
  ]
}

/**
 * Plan mode's server-side refusals, AFTER the user's rules so none of them
 * re-opens what plan mode closes: every edit (wholly denied → edit/write/patch
 * hidden) and the mutating `general` subagent. Robust against a stale host
 * and against the shared saved-allow table, which an `ask` is not.
 */
export function planEnforcement(): V2Rule[] {
  return [rule('subagent', 'deny', 'general'), rule('edit', 'deny')]
}

/**
 * The order 2.x sees: every WHOLE-CATEGORY deny (`resource:"*"`) moves to the
 * end, keeping its order among the others; everything else stays in place.
 * Last for its action, the deny is what `whollyDisabled` reads, so the tool is
 * hidden. Moving a deny-everything rule later only tightens: whatever it
 * passes could only have narrowed it to an ask or an allow for some resource.
 * Narrow denies stay where they are (and stay denies — see the module doc).
 */
export function wireOrder(rules: readonly V2Rule[]): V2Rule[] {
  const kept: V2Rule[] = []
  const whole: V2Rule[] = []
  for (const r of rules) (r.effect === 'deny' && r.resource === '*' ? whole : kept).push(r)
  return [...kept, ...whole]
}

/** What {@link buildSessionRuleset} needs. */
export interface SessionRulesetInput {
  /** The Claude-style permission mode (`default`, `acceptEdits`, `plan`, `auto`, …). */
  mode: string
  /** True when auto mode's classifier judges (`auto`/`full` with autoMode enabled). */
  autoMode: boolean
  /** The user's merged Claude permissions (user + project + local scopes). */
  permissions: ClaudePermissions
  /** The live MCP server set (bridged + `claudeui` + `GET /api/mcp`). */
  mcpServers: readonly string[]
  /** The session directory (path rules also compile relative to it). */
  cwd?: string
  /** The session's git worktree root, when known (settings-relative `/x` rules). */
  worktree?: string
  /** The allows for opencode's own directories (`own-dirs.ts` `resolveOpencodeOwnDirAllows`), every mode. */
  externalDirAllows?: readonly V2Rule[]
  /** Home for `~/` specifiers (tests). */
  home?: string
  /** The platform path rules are read for (tests; default `process.platform`). */
  platform?: NodeJS.Platform
}

/** The compiled session ruleset and what the host keeps beside it. */
export interface SessionRuleset {
  /** Send as `permissions` on `POST /api/session` / `PATCH /api/session/:id`. */
  rules: V2Rule[]
  /**
   * The user's compiled rules, ALL tiers (allows included even when the mode
   * withholds them from `rules`): the host pre-check's provenance set (G9,
   * rung 1b deny) — `host-precheck.ts`.
   */
  userRules: V2Rule[]
  /** The primary agent the mode runs (`plan` in plan mode, else the default). */
  agent: 'plan' | undefined
}

/**
 * The ruleset a ClaudeUI opencode session runs with (and every subagent child
 * inherits): mode gates → the user's rules (auto: without allows; plan:
 * without edit/shell/subagent allows) → plan enforcement → Code Mode deny →
 * dispatch ask → session tools ask, in {@link wireOrder}. Deterministic (equal input, equal
 * output), so a caller can skip an unchanged PATCH.
 */
export function buildSessionRuleset(input: SessionRulesetInput): SessionRuleset {
  const autoMode = input.autoMode && (input.mode === 'auto' || input.mode === 'full')
  const userRules = compileClaudeRulesV2(input.permissions, {
    mcpServers: input.mcpServers,
    cwd: input.cwd,
    worktree: input.worktree,
    home: input.home,
    platform: input.platform
  })
  const effective = autoMode
    ? withoutAllowRulesV2(userRules)
    : input.mode === 'plan'
      ? withoutMutatingAllowRulesV2(userRules)
      : userRules
  // ORDER IS LOAD-BEARING (last match wins on the wire): auto mode's gates carry
  // `claudeui_*` allow ({@link autoModeGates}), and the two asks below are what outrank it.
  // `SESSION_TOOLS_ASK_RULE` must stay the last non-deny rule: anything appended after it
  // that could match `claudeui_session_*` would silently un-gate the family in auto mode
  // (permission-v2.test pins this for every mode).
  const rules = wireOrder([
    ...modeGates(input.mode, { autoMode, externalDirAllows: input.externalDirAllows }),
    ...effective,
    ...(input.mode === 'plan' ? planEnforcement() : []),
    EXECUTE_DENY_RULE,
    DISPATCH_ASK_RULE,
    SESSION_TOOLS_ASK_RULE
  ])
  return { rules, userRules, agent: input.mode === 'plan' ? 'plan' : undefined }
}

/**
 * The config-level overlay (`agents.<name>.permissions`, the S2 seam
 * `OpencodeServerManager.setAgentPermissionProvider`). Mode-less by nature
 * (one server serves every mode), so it carries only what holds for an agent
 * in every session that runs it: the `plan` agent never offers the mutating
 * `general` subagent. The `subagent` tool lists the subagents the PRIMARY
 * agent's own rules do not deny (`tool/plugin/subagent.ts` context hook —
 * agent rules, not session rules), so this keeps `general` out of plan mode's
 * list; the session's {@link planEnforcement} denies the call regardless.
 * Built-in agents only: an overlay entry for a name opencode does not define
 * would create a phantom agent.
 */
export function agentPermissionOverlay(): AgentPermissionOverlay {
  return { plan: [rule('subagent', 'deny', 'general')] }
}

/**
 * 2.x rules in the shape the host pre-check reads (`host-precheck.ts`
 * `HostPrecheckContext.userRules`). The matching is the same
 * glob logic on either shape, and a 2.x `permission.asked` carries the 2.x
 * action as the approval's tool name, so the ladder runs unchanged on 2.x
 * rules through this view.
 */
export function asHostPrecheckRules(rules: readonly V2Rule[]): OpencodePermissionRule[] {
  return rules.map((r) => ({ permission: r.action, pattern: r.resource, action: r.effect }))
}
