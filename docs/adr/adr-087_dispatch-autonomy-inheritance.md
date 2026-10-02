# ADR-087: Dispatch targets inherit auto mode, live, and are judged

**Status:** Accepted (2026-10-01). Built on branch `pi-subagents-dispatch-judge`.
**Amends:** [ADR-033](adr-033_cross-engine-dispatch.md) §5 and its "M2 shipped" note (a target's
auto mode is no longer allow-all, and its mode is no longer fixed at creation).
**Relates to:** [ADR-081](adr-081_claudeui-owned-judge-transport.md) (the judge transport),
[ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) (the judge's environment),
[ADR-084](adr-084_read-only-judge-bypass.md) (the read-only gate, the agent-control edit gate),
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) (deny/ask rules on targets; S4,
delegated work judged against the parent), [ADR-076](adr-076_claude-automode-verdict-on-the-wire.md)
(cli.js's own verdicts), [ADR-023](adr-023_opencode-automode-classifier.md) (ClaudeUI's judge),
[ADR-067](adr-067_codex-shared-permission-model.md) (the shared permission ladder),
[ADR-069](adr-069_codex-host-per-home-and-account.md) (Codex targets are threads on the caller's host),
[ADR-088](adr-088_pi-subagents-host-run.md) (amends the transcript rule: `system` rows are skipped).

## Context

Three findings about how a dispatch target (ADR-033) behaved when its parent ran in auto mode:

1. **Every non-opencode target ran auto with no judge.** A Claude target was spawned
   `bypassPermissions` + `allowDangerouslySkipPermissions`; a pi target's gate decided from the
   `auto` mode base, which allows everything; a Codex target got Codex's own `auto_review`
   guardian, but only because `thread/start` carried it. Only the user's deny/ask rules (ADR-085
   §3) stood between a dispatched agent and the machine.
2. **opencode targets asked the human for everything.** `buildRuleset('auto')` falls through to the
   `default` rules, and the dispatcher had no judge, so every edit, bash and webfetch ask became a
   card — the opposite failure.
3. **Modes were frozen at creation.** `PiTargetEntry.autonomyMode` and `CodexTargetEntry.autonomyMode`
   were snapshots, the Claude target baked `permissionMode` into its spawn, and the opencode target
   PATCHed a ruleset once. A parent switched into or out of auto mid-dispatch changed nothing.

## Decision

Owner rulings (2026-10-01):

1. Auto-mode dispatch targets are **judged**, on every target engine.
2. A Claude target keeps **cli.js's own judge** (`permissionMode: 'auto'`, never `bypassPermissions`).
   pi and opencode targets use **ClaudeUI's own judge** (ADR-081 transport). Codex targets keep
   Codex's native **`auto_review`** guardian.
3. Everything spun off a parent in auto **inherits auto mode, read LIVE** from the parent.
4. **No third copy** of the judge pipeline: the engine-neutral steps are one shared module.

### Per engine, as built

| Target   | Parent in `auto`                                                    | Judge                        | Live mode                                                                           |
| -------- | ------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| Claude   | cli.js `auto`, no skip flag; the prompt carries a preamble          | cli.js's own classifier      | `set_permission_mode` at the next continuation turn or the target's next ask        |
| opencode | the auto-mode base ruleset (every edit asks), host answers each ask | ClaudeUI's (shared pipeline) | every ask reads the parent's mode; the ruleset is a creation-time snapshot          |
| pi       | the `acceptEdits` base decides; an `ask` goes to the judge          | ClaudeUI's (shared pipeline) | every gate call reads the parent's mode                                             |
| Codex    | `on-request` + `auto_review` (unchanged table)                      | Codex's native guardian      | `codexTurnPolicy(mode)` on every `turn/start`; the gate decides by that turn's mode |

`bypassPermissions` on the parent still spawns a Claude target bypass + skip (a parent in bypass is
not in auto); `plan` still maps to `default` for Claude. With the TARGET engine's
`autoMode.enabled === false`, a pi/opencode target keeps the old no-judge behaviour (pi allow-all,
opencode gated like `default`).

### The live accessor

`DispatchContext.autonomyMode: string` became `getAutonomyMode: () => string`, plus
`getMessages: () => ChatMessage[]` (the dispatching session's live transcript). All four callers
(Claude's collab server, opencode's hosted tool via `core-services.ts`, PiSession, CodexSession)
pass accessors over the live session. `entry.ctx` is replaced on every continuation, so
`entry.ctx.getAutonomyMode()` is always the latest. There is no push: a switch is pulled at the next
decision point.

### One shared pipeline

`src/core/automode/judge-pipeline.ts` — `runJudgePipeline(action, hooks)` — runs the steps
PiSession and OpencodeSession each carried: the category fast path, the ADR-084 read-only gate, the
ADR-085 §4 allow-rule gate (skipped when no `allowRuleAction` hook is given), the fail-closed stale
judge-model check, ground truth, `classify`, the settle check, G10, verdict logging, the denial
caps, outcomes and the review. Engine specifics are hooks; G9 (a user ask rule → the human) stays
in each caller. PiSession runs on it, and so does OpencodeSession (S4, 2026-10-02); opencode's
agent-control edit fast path (ADR-084 §3) stays in the session, before the pipeline.
`src/core/services/dispatch-target-judge.ts` (`DispatchTargetJudge`, one per pi/opencode target)
supplies the target hooks.

opencode needed two hooks, because its ask can precede its tool input (ADR-084 §1, ADR-085 §3):

- **`inputFor(stage)`** — the input a stage reads. `'read-only'` is awaited before the read-only
  gate (opencode: the shell TOOL PART's input, waiting up to `TOOL_INPUT_WAIT_MS`; `null` skips the
  gate). `'judge'` is awaited AFTER the allow-rule skip and before the stale-judge check (opencode:
  an MCP ask's part input; ground truth and `classify` read it, and the human card shows it).
  `'settled'` from either ends the pipeline with no reply. Without the hook every stage reads
  `action.input`. The judge stage sits after the allow-rule skip on purpose: a single input for all
  three gates (the first design) would put the MCP wait in front of the skip and delay an
  allow-rule-covered ask's reply by up to `TOOL_INPUT_WAIT_MS` — an observable ordering change.
- **`stillPending(stage)`** — the settle check now names its stage (`'read-only'`, `'allow-rule'`,
  `'judge'`, `'error'`), so opencode keeps its stage-specific log lines; and the pipeline checks it
  once more after an allow-rule allow, before the review (opencode's old skip did). Implementations
  without the parameter (pi children, the dispatch targets) are unchanged.

Two behaviour deltas of the migration, accepted (each is the pipeline's existing rule; no existing
test pins either):

1. A judge path that throws after the ask was answered meanwhile ends `settled`; opencode used to
   raise a card for the already-answered ask (a bug fix).
2. A child ask whose parent `task` part carries no input logs its allow-rule gate line with
   `(subagent unknown)` (the pipeline uses one `subagent` value for the gate's log and the judge's
   header); opencode passed no subagent to the gate in that case.

### What a target's judge sees

- **Transcript (owner ruling D1):** the PARENT transcript, followed by the TARGET's own assistant
  trajectory — its forwarded messages with every `user`-role message removed, upserted by id,
  bounded to the most recent 200, kept across continuation turns. The parent's human turns stay the
  only `User:` lines (the only real authorisation); the child's own earlier calls tell the judge
  what it has already done. An opencode target's task children contribute nothing (their parts are
  not on the target's accumulators).
- **Amended (ADR-088 S3, 2026-10-02):** `slimTranscript` skips every `role: 'system'` message, for
  every engine, before its user branch: system rows are engine/host notes (compaction, API errors,
  Codex guardian notices, and the agent messages ClaudeUI injects into a pi session — task
  notifications and `send_message` deliveries, which are system rows), never a human turn. Before
  this, a system row with a text block (Codex's guardian notice) rendered as a `User:` line when a
  Codex session dispatched to a judged target. See [ADR-088](adr-088_pi-subagents-host-run.md)
  "Background runs and messaging".
- **Amended (S4, 2026-10-02) — Claude's own task notifications are system rows too.** cli.js
  delivers a background agent's `<task-notification>` as a `user` frame; ClaudeSession used to insert
  it as a `role: 'user'` message, which `slimTranscript` rendered as `User:` and treated as the user's
  reply to the assistant's last proposal. It is now the shared agent note (`services/agent-note.ts`:
  `role: 'system'`, one `context_note` labelled "from an agent, not from you", text verbatim), live
  and on reload alike (the history loader builds the same row where the notification was delivered —
  a turn-starting `user` line or an absorbed `queued_command` attachment; the `queue-operation`
  records add none). Recognition is structural first: cli.js's `origin.kind` (`'task-notification'`
  for a notification, `'human'` for a typed prompt); only a frame or line without `origin` (pre
  2.1.241) falls back to the XML with a known status. A typed prompt never becomes a system row.
- **Amended (S4, 2026-10-02) — ClaudeSession records the user's prompts.** Before S4 its
  `messageHistory` held no human turn at all (`run()` never recorded the prompt; the renderer adds
  the bubble from `session:user-message`), so a Claude session's dispatched pi/opencode target was
  judged with no `User:` line but cli.js's notifications. `run()` now records the prompt locally (no
  `session:message`), keyed by the wire uuid; a queued item is recorded when cli.js takes it
  (`command_lifecycle` `started`, or the turn-end flush), once. **Residual:** a RESUMED Claude
  session starts with an empty `messageHistory` (nothing is replayed into it), so its dispatched
  targets' judge sees only the turns of the current process.
- **Amended (S4, 2026-10-02) — opencode's synthetic user text is not the user.** On replay
  (`convertStoredMessage` → `messageHistory`, which the judge reads), a `text` part opencode itself
  wrote into a user message (`synthetic: true`: the "Summarize the task tool output above…" nudge,
  "The following tool was executed by the user", the compaction continue prompt, @-file expansions
  that inline file content) is dropped; a user message left empty is no row (opencode's own app
  skips them too).
- **The action** is headed as the `dispatch:<engine>` subagent's, with the target's model as the
  description and the LATEST dispatch prompt as its task (`classifier.ts` `actionHeader`).
- **Model:** the TARGET engine's `autoMode.judgeModel`, else the target's model; a configured model
  the catalog no longer lists fails closed to the human with one banner per target.
- **Usage:** every judge call is a `judge` ledger row with `parentRoutingId` = the dispatching
  session's routing id, `sessionId` = the target's engine session.
- **Environment:** the user's deny/ask rules (allow empty — exactly what binds a target), the shared
  trust lists, session-start git remotes per target.
- **Per target:** denial caps, the outcome map (keyed by the target's own tool ids, so a blocked call
  is annotated on the trajectory), the banners.
- **Verdicts** are emitted as `session:tool-review` under the dispatching routing with the TARGET's
  tool id; the reducer finds the nested block in the subagent bucket, so the verdict lands on the
  TaskCard with no renderer change.

### Claude target specifics

cli.js's judge sees only the target transcript, where the dispatch prompt is a `user` message. Every
prompt pushed to a Claude target is therefore prefixed with `DISPATCH_PROMPT_PREAMBLE` ("Task
delegated to you by another agent acting for the user:"). pi/opencode targets need none (their judge
reads the parent transcript with the subagent header); Codex is left alone. A live switch is applied
with `set_permission_mode`; a rejected `auto` falls back to `default` with one `session:warning` and is
not retried on that process; `bypassPermissions` is never applied to a process spawned without the
skip flag (`default` instead).

### Codex target specifics

`CodexTargetEntry.autonomyMode` is now "the mode the thread's native policy runs under": set at
creation, refreshed at every `turn/start`, which re-sends `codexTurnPolicy(mode)`. The gate reads
it, never the live accessor: a mid-turn switch into `auto` must not make ClaudeUI's gate allow by
mode base while the thread still runs `approvalsReviewer: 'user'` — no guardian would be reviewing.
A mid-turn switch binds at the next turn.

Under `auto` the gate decides as `default` — the interactive rule (`CodexSession.gate()`): the native
`auto_review` guardian has already approved everything it was willing to, so what reaches ClaudeUI's
gate is what it ESCALATED, and escalations belong to the human. (Before this ADR the target gated
`auto` by its allow-all mode base, silently accepting every escalation.)

The dispatcher reads the live mode through one helper that normalises the legacy `full` to `auto`
(`CODEX_TURN_POLICY` has no `full` row, and `full` is not a cli.js mode).

### Residuals, accepted

- **The opencode ruleset is a creation-time snapshot** (a PATCH only appends). A target created
  under `default` and switched to `auto` is judged on every edit/bash/webfetch ask (more asks than
  necessary, never fewer); one created under `acceptEdits` and switched to `auto` keeps the
  server-side edit allow except the agent-control patterns.
- **Asks already parked on the human when the parent switches into auto stay with the human.**
- A Claude target's mid-turn switch takes effect at its next tool ask or next turn. A target running
  cli.js `auto` rarely calls `canUseTool` (its own judge decides first), so a mid-turn switch OUT of
  auto in practice binds at the next turn.
- **Host/engine-authored `user` rows left as they are (S4 survey):** a Claude SUBAGENT transcript's
  `external` user lines (the delegation prompt and messages sent to that agent) render as user rows
  inside that agent's nested card — never in the root `messageHistory`, and Claude targets are judged
  by cli.js; a third-party pi extension's `pi.sendUserMessage` is indistinguishable from a typed
  prompt in pi's session file (ClaudeUI's own agent messages are `custom`, ADR-088). Codex filters
  its own contextual user fragments out of `userMessage` items; the user's own prompts and steers
  are real `user` rows everywhere.

## Consequences

- An auto parent's delegated work is reviewed exactly as its own work is, by the judge that engine
  would use, instead of running unreviewed (pi/Claude) or asking for everything (opencode).
- One pipeline for PiSession and both ClaudeUI-judged target kinds; a fix lands once.
- Every judgement of a target call costs a judge call, billed and ledgered under the dispatching
  session.
- The two "mode is fixed at creation" tests were rewritten as live-mode tests.

## Alternatives considered

- **A push-based mode notification** to every live target on `setPermissionMode` — rejected: it
  needs a new seam through every session class for what a pull at the next decision point gives.
- **A third copy of the judge pipeline in the dispatcher** — rejected by ruling 4.
- **Judging with the parent transcript only** (the ADR-085 S4 precedent for opencode task children)
  — rejected by ruling D1: the judge could not see what the target already did.
- **Judging with the target's own transcript only** (Claude Code's default for its subagents) —
  rejected: the target's transcript never shows what the USER asked; its only `user` message is
  another agent's prompt.

## Out of scope

- Re-PATCHing an opencode target's ruleset on a mode switch.
- Moving an ask already parked on the human to the judge after a switch into auto.
