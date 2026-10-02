/**
 * Neutral autonomy-mode → opencode permission-ruleset mapping (ADR-022).
 *
 * Extracted from OpencodeSession.ts (which still re-exports both symbols for
 * back-compat) so `cross-engine-dispatcher.ts` can depend on it WITHOUT
 * importing OpencodeSession.ts. That import would form a require-cycle once
 * OpencodeSession.ts itself needs to call into the dispatcher (ADR-033 M2 —
 * `cancel()` tears down dispatch targets it owns, mirroring ClaudeSession):
 * cross-engine-dispatcher.ts → OpencodeSession.ts → cross-engine-dispatcher.ts.
 * This module has no dependents that could complete such a cycle (nor does
 * `permission-compiler.ts`, which the dispatcher already reaches through
 * `pi/permission-engine.ts`).
 */

import { agentControlEditPatterns } from '../automode/agent-control-paths'
import { opencodeMcpKey } from './permission-compiler'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

/**
 * Map a neutral autonomy mode → an opencode session permission ruleset.
 *
 * opencode permissions are an ORDERED rule array evaluated LAST-MATCH-WINS
 * (verified against 1.17.9), where `permission` is a tool/category name
 * (`*`, `edit`, `bash`, `webfetch`, `task`, `read`, `glob`, `grep`, …) and
 * `pattern` matches the tool argument. Read-class tools (`read`/`glob`/`grep`/
 * `list`) and `task` are allow-by-default — they only prompt if we make them.
 *
 * We therefore start from a permissive `{*:allow}` baseline (mirroring how
 * opencode's own built-in agents are structured) and LAYER mode-specific
 * `ask`/`deny` overrides for the write-class tools on top. This preserves
 * Claude-equivalent semantics — reads + `task` auto-allowed; edits/bash/webfetch
 * gated — instead of the old wildcard `{*:* ask|allow}` that forced EVERY tool
 * (including `task`, which hung the turn) to prompt and clobbered opencode's
 * own protections. See ADR-022.
 *
 * `mode` is the Claude-style permission-mode string the renderer already speaks
 * (autonomy plan→'plan', ask→'default', autoEdit→'acceptEdits', full→'auto').
 */
export function buildRuleset(mode: string): PermissionRule[] {
  const allowAll: PermissionRule = { permission: '*', pattern: '*', action: 'allow' }
  const rule = (permission: string, action: PermissionAction): PermissionRule => ({
    permission,
    pattern: '*',
    action
  })
  // Portable subset of opencode's own built-in guards (its agents keep these even
  // in permissive mode): a doom-loop ask + secret-file read protection. Layered
  // after the `{*:allow}` baseline (last-match-wins). We omit opencode's
  // `external_directory` guard — its safe form needs an env-specific allow-list
  // for opencode's own tool-output/temp dirs, so a bare `{external_directory:ask}`
  // would spuriously prompt on opencode's internal writes. See ADR-022.
  const guards: PermissionRule[] = [
    { permission: 'doom_loop', pattern: '*', action: 'ask' },
    { permission: 'read', pattern: '*.env', action: 'ask' },
    { permission: 'read', pattern: '*.env.*', action: 'ask' },
    { permission: 'read', pattern: '*.env.example', action: 'allow' }
  ]
  switch (mode) {
    case 'acceptEdits':
    case 'autoEdit':
      // Auto-accept file edits; still gate command execution + network fetch,
      // and edits to agent-control paths (ADR-084 §3), which ask the human as
      // cli.js's do. Those asks sit after `allowAll` so they win under
      // last-match-wins; the user's compiled rules are appended after this
      // base, so a user `Edit(.claude/**)` allow still wins. The rendered
      // patterns follow opencode's `Wildcard.match`, so they are
      // case-sensitive off Windows and cannot see 8.3 aliases, ADS suffixes or
      // apply_patch move destinations; auto mode does not rely on them (see
      // `buildAutoModeRuleset`).
      return [
        allowAll,
        ...guards,
        rule('bash', 'ask'),
        rule('webfetch', 'ask'),
        ...agentControlEditPatterns().map((pattern): PermissionRule => ({
          permission: 'edit',
          pattern,
          action: 'ask'
        }))
      ]
    case 'plan':
      // Read-only planning. Pairs with opencode's `plan` agent (set in
      // applyPermissionMode), whose own rules are plan = merge(base, {
      // edit:{'*':deny, …plan files…}, task:{general:deny} }): no edits, and
      // not the mutating `general` subagent. Read-only subagents (e.g.
      // `explore`) stay allowed via the baseline, so plan-mode research/`task`
      // still works. (We don't reproduce opencode's plan-file edit allow-list
      // — minor.)
      //
      // ADR-085 §3 — those two are `ask` here, NOT `deny`, and the REFUSAL is
      // host-side: `OpencodeSession.routePermissionAsk` (own and child asks)
      // and the dispatcher's `permission.asked` branch (plan dispatch targets)
      // reject them with PLAN_MODE_DENY_REASON, reading the mode at ask time.
      // A server-side deny went stale: PATCH APPENDS
      // (`vendor/opencode-src/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:194-198`,
      // `Permission.merge(current, payload)`) and a task child copies EVERY
      // deny of the parent session (`agent/subagent-permissions.ts:20-26`), so
      // after a plan → default switch the `edit`/`task:general` denies kept
      // binding the chat's subagents — they could never edit again. An ask
      // leaves nothing behind that a later mode's rules do not outrank.
      // Visible consequence: edit tools are no longer HIDDEN from the model in
      // plan mode (`permission/index.ts` `disabled()` hides a tool only for a
      // `deny` whose pattern is `*`); the plan agent's prompt and the host
      // refusal hold the line.
      //
      // ADR-085 ruling 7 — the `edit`/`task:general`/`bash` asks below are
      // what the host refuses or answers (host-precheck.ts: edits, the
      // `general` subagent and non-plan-safe commands are refused, a plan-safe
      // command a user allow rule covers is answered `once`). In plan mode the
      // session never appends a user `edit`/`bash`/`task` ALLOW after this base
      // (`withoutMutatingAllowRules`), so those three asks always reach the
      // host.
      //
      // …PLUS the same `bash`/`webfetch` gates `default` carries. opencode's
      // OWN plan agent leaves those on the `{*:allow}` baseline (it relies on
      // the planning SYSTEM PROMPT to keep the model read-only), which made
      // ClaudeUI's plan mode strictly MORE permissive than its default mode
      // for command execution and network fetch — a stricter autonomy tier
      // silently auto-running `rm -rf` / exfiltrating over webfetch. The
      // neutral autonomy ladder (ADR-022) requires plan ≤ default everywhere,
      // so we layer the gates back on. `ask` (not `deny`) mirrors default
      // exactly: an interactive session has a live SSE consumer, so the
      // resulting `permission.asked` reaches the approval dialog — no hang,
      // and read-only recon (`git log`, `ls`) is still one click away instead
      // of impossible. Kept LAST so the intent reads top-to-bottom; all four
      // rules live in disjoint permission namespaces, so order among them is
      // immaterial under last-match-wins.
      return [
        allowAll,
        ...guards,
        rule('edit', 'ask'),
        { permission: 'task', pattern: 'general', action: 'ask' },
        rule('bash', 'ask'),
        rule('webfetch', 'ask')
      ]
    case 'auto':
    case 'full':
    case 'default':
    case 'ask':
    default:
      // Claude default — read-only autonomy + ask for write-class tools.
      //
      // `full`/`auto` land here only as the NO-CLASSIFIER fallback: auto with
      // `autoMode.enabled === false`. Every judged auto caller builds its base
      // from `buildAutoModeRuleset` instead — the session (ADR-023, ADR-084 §3)
      // and, since ADR-088, an opencode dispatch target — so it never takes
      // this branch. Gated like `default` so a disabled classifier never means
      // allow-all: `full` is an LLM-gated mode, never `bypassPermissions`
      // (ADR-022).
      return [
        allowAll,
        ...guards,
        rule('edit', 'ask'),
        rule('bash', 'ask'),
        rule('webfetch', 'ask')
      ]
  }
}

/**
 * The ruleset as PATCHed onto an opencode session — never evaluated host-side
 * (the host keeps the ruleset it built, and the user's rules as compiled).
 *
 * ## Why
 *
 * opencode's server-side deny is `PermissionV1.DeniedError`, whose message
 * JSON-dumps every session rule whose permission matches the call's into the
 * tool result the model reads
 * (`vendor/opencode-src/packages/core/src/v1/permission.ts` `DeniedError`,
 * thrown in `packages/opencode/src/permission/index.ts` `ask`). With the broad
 * Bash globs (`broad-bash-globs.ts`, up to 240 per deny/ask rule) and one
 * appended copy per mode visited (PATCH appends), one denied `git push` put
 * 707 rules, ~50 KB — the user's own rules included — into the model's
 * context. So the session's own server never denies a call it could show:
 *
 * - a NARROW deny (pattern ≠ `*`) in a `hostDecided` category is sent as
 *   `ask`. Every such ask reaches the host — own-session asks always, a task
 *   child's through its spawn-time static asks — and the host pre-check
 *   refuses it with the rule (`host-precheck.ts` rung 1b; the dispatcher's
 *   `opencodeTargetRefusal`). The ask still sits where the deny sat, after
 *   every allow, so no allow outranks it server-side.
 * - a WHOLE-CATEGORY deny (pattern `*`, any category) stays a deny and moves
 *   to the end, keeping its order among the others. Last for its permission,
 *   it is what opencode's `disabled()` reads, so the tool is hidden from the
 *   model and never called (`permission/index.ts` `disabled`: the last rule
 *   whose permission matches, if its pattern is `*` and it denies). Left in
 *   place, a later narrow `bash` ask (from another deny rule) would keep bash
 *   visible and the whole-category deny would answer every call with the full
 *   dump. Moving a deny-everything rule later only tightens: the rules it
 *   passes (the backstop's `task:<name>` asks, the dispatch ask) could only
 *   have turned it into an ask.
 *
 * Narrow denies in other categories (`read`, `glob`, `grep`, `list`,
 * `websearch`, `task`, …) stay server-side: a task child copies only the
 * parent session's DENY rules (`agent/subagent-permissions.ts`), and those
 * categories carry no static child ask, so an ask there would let a child run
 * what the user denied. Their dump holds only that category's rules.
 */
export function opencodeWireRuleset(
  rules: readonly PermissionRule[],
  hostDecided: readonly string[]
): PermissionRule[] {
  const kept: PermissionRule[] = []
  const wholeCategoryDenies: PermissionRule[] = []
  for (const rule of rules) {
    if (rule.action !== 'deny') kept.push(rule)
    else if (rule.pattern === '*') wholeCategoryDenies.push(rule)
    else if (hostDecided.includes(rule.permission)) kept.push({ ...rule, action: 'ask' })
    else kept.push(rule)
  }
  return [...kept, ...wholeCategoryDenies]
}

/**
 * ClaudeUI's own hosted MCP server name on opencode (`opencode-hosted-tools.ts`,
 * `OpencodeServerManager.ts` — its tools are `claudeui_<tool>`).
 */
export const CLAUDEUI_MCP_SERVER = 'claudeui'

/**
 * The base ruleset auto mode patches (ADR-023; ADR-084 §3): the acceptEdits
 * base, except that EVERY edit asks. `OpencodeSession.handleAutoModeApproval`
 * then clears an edit host-side with the shared agent-control matcher
 * (`isAgentControlTarget`) — replying `once` with no judge call when every
 * target it names is clear, and sending it to the judge otherwise. The host
 * matcher folds case on every platform, sees 8.3 aliases, ADS suffixes and
 * trailing dots, resolves `..` against the session cwd, and reads apply_patch
 * move destinations, none of which opencode's server-side patterns can do.
 * The agent-control asks are therefore dropped here: the blanket ask covers
 * them.
 *
 * ADR-085 §3 — plus one `ask` per MCP server in `opts.mcpServers`
 * (`<sanitized server>_*`), so every MCP call reaches the host (the user's MCP
 * rules, then the judge) instead of the `{*: allow}` baseline answering it
 * server-side. Never `*_*`: built-in permission keys contain `_` too
 * (`external_directory`, `doom_loop`). `claudeui` is excluded — its hosted
 * tools (mermaid, mockups) stay allowed as pi's `PI_AUTO_ALLOW_HOSTED_TOOLS`
 * do, and its dispatch tool keeps `DISPATCH_AGENT_ASK_RULE` (appended last by
 * the session). These sit BEFORE the user's compiled rules, so a user MCP
 * allow/ask/deny rule still wins. Non-auto modes keep the baseline for MCP.
 */
export function buildAutoModeRuleset(
  opts: { mcpServers?: readonly string[] } = {}
): PermissionRule[] {
  return [
    ...buildRuleset('acceptEdits').filter((r) => r.permission !== 'edit'),
    { permission: 'edit', pattern: '*', action: 'ask' },
    ...(opts.mcpServers ?? [])
      .filter((server) => server !== CLAUDEUI_MCP_SERVER)
      .map((server): PermissionRule => ({
        permission: opencodeMcpKey(server),
        pattern: '*',
        action: 'ask'
      }))
  ]
}
