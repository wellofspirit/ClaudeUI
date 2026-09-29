/**
 * Neutral autonomy-mode → opencode permission-ruleset mapping (ADR-022).
 *
 * Extracted from OpencodeSession.ts (which still re-exports both symbols for
 * back-compat) so `cross-engine-dispatcher.ts` can depend on it WITHOUT
 * importing OpencodeSession.ts. That import would form a require-cycle once
 * OpencodeSession.ts itself needs to call into the dispatcher (ADR-033 M2 —
 * `cancel()` tears down dispatch targets it owns, mirroring ClaudeSession):
 * cross-engine-dispatcher.ts → OpencodeSession.ts → cross-engine-dispatcher.ts.
 * This module has no dependents that could complete such a cycle.
 */

import { agentControlEditPatterns } from '../automode/agent-control-paths'

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
      // applyPermissionMode). Mirrors that agent's own rules (verified in the
      // opencode source — plan = merge(base, { edit:{'*':deny, …plan files…},
      // task:{general:deny} })): deny edits, and deny ONLY the mutating
      // `general` subagent. Read-only subagents (e.g. `explore`) stay allowed
      // via the baseline, so plan-mode research/`task` still works. `deny`
      // refuses without prompting → no approval round-trip, no hang.
      // (We don't reproduce opencode's plan-file edit allow-list — minor.)
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
        rule('edit', 'deny'),
        { permission: 'task', pattern: 'general', action: 'deny' },
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
      // `full`/`auto` are INTENTIONALLY gated identically to `default` for now.
      // ClaudeUI's `full` autonomy maps to Claude's `auto` permission mode — an
      // LLM-gated "security monitor", NOT `bypassPermissions`. We haven't ported
      // that gatekeeper to opencode yet, so a raw `{*:allow}` here would make
      // opencode `full` strictly LESS safe than Claude `full`. Interim: gate
      // `full` like `default` (never less safe than Claude) until the classifier
      // lands, at which point `full` switches risky tools to classifier-decided.
      // See ADR-022.
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
 */
export function buildAutoModeRuleset(): PermissionRule[] {
  return [
    ...buildRuleset('acceptEdits').filter((r) => r.permission !== 'edit'),
    { permission: 'edit', pattern: '*', action: 'ask' }
  ]
}
