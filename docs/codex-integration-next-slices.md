# Codex integration: next slice specs

Kickoff specs for the next two implementation slices, preserved here because the orchestrating session's scratchpad expires. Each was written for an Opus implementing subagent under ADR-026: the main model reviews every line, reruns gates, and commits. Adjust HEAD references and file ownership notes before dispatching.

## Slice A: identity-aware held queue via turn/steer (ADR-053 parity)

Repo: /Users/daniel.liu/work/ClaudeUI, branch `codex-integration`, uncommitted worktree.
You implement; the reviewer reads every line. Same hard rules as before: no commit/add/stash/branch/reset, no `bun install`, no real credentials, no touching `~/.codex`, never revert unrelated uncommitted work. Every behaviour change ships with a guard test you prove fails before the fix.

Read first, in this order: `docs/adr/adr-053_queue-item-identity-cc-parity.md`, `docs/adr/adr-066_codex-fourth-engine.md` §"History and queue without a core rewrite", `src/core/providers/session-queue.ts`, `src/core/providers/BaseSession.ts` (queue section), `src/core/codex/CodexSession.ts`, `src/core/shared/sync/reducer.ts` case `session:queue-changed`, `src/core/opencode/OpencodeSession.ts` around its `flushQueuedItems` call sites (the reference for "forward at an observed sub-turn boundary"), and `src/core/codex/protocol/v2/TurnSteerParams.ts`.

### Design (decided; do not reopen)

Codex's native queue starts a NEW turn when idle, so it cannot back ADR-053's active-turn queue. Core keeps the queue of record. Held items are forwarded with `turn/steer` at an observed sub-turn boundary while a turn is active, or with the ordinary `turn/start` path at idle. Correlation is by identity, never by text.

Identity contract:

- A consumed queue item becomes the chat row `steer-<itemId>` (reducer already does this).
- Codex forwards each held item with `clientUserMessageId: 'steer-<itemId>'`. The native `userMessage` item then arrives with `clientId === 'steer-<itemId>'` and `mapCodexItem` already emits `replacesMessageId`, so the native row replaces the synthesized one by identity. Duplicate texts therefore never collide.

### Changes

### 1. `SessionQueue` (`src/core/providers/session-queue.ts`)

Add `consumeById(itemId): QueuedItem | undefined` beside `consumeByText`. Same state transition, keyed by `itemId`. Keep `consumeByText` untouched; Claude/opencode/pi keep using it. Unit test in the existing session-queue test file.

### 2. `BaseSession` (`src/core/providers/BaseSession.ts`)

Extract the send inside `flushQueuedItems` into a protected hook:

```ts
protected forwardQueuedItem(item: QueuedItem): Promise<void> {
  return this.run(item.text, item.attachments)
}
```

`flushQueuedItems` calls the hook. Pure refactor for the three existing engines: their existing queue tests must pass unchanged, and you must state that you ran them (`bun run test:unit src/core/providers src/core/opencode src/core/pi src/core/services/__tests__/claude-session*` or the equivalent you find).

### 3. `CodexSession` (`src/core/codex/CodexSession.ts`)

- Remove the `enqueuePrompt` override that throws. Inherit BaseSession's hold-by-default behaviour. `willQueue` stays as is.
- Boundary observation: after handling `item/completed` for the active turn, and inside `finishTurn` once the session is idle again, call `void this.flushQueuedItems()`. Mirror opencode's placement; do not flush on deltas.
- Override `forwardQueuedItem(item)`:
  - Active turn (`this.busy && this.turnId`): send `turn/steer { threadId, expectedTurnId: this.turnId, clientUserMessageId: 'steer-'+item.itemId, input: [...] }` with the same text/image input mapping `run()` uses (reuse, do not duplicate the attachment validation/mapping; extract a private helper). On success: `this.queue.consumeById(item.itemId)` then `this.queue.emit()`. A successful steer is acceptance; it does not need `item/completed` of the user item.
  - Idle: `await this.run(item.text, item.attachments, 'steer-'+item.itemId)`; on `turn/start` success consume by id and emit. Do NOT route this through `handlers-core.sendPrompt` (that path emits its own `session:user-message`; the queue path must not).
  - `turn/steer` rejected with an RPC error (turn already ended / `expectedTurnId` mismatch): leave the item `queued`, `unmarkForwarded` happens in the base loop because state is still `queued`; the next boundary or idle flush retries via the correct path. That retry is not blind: the RPC was refused, nothing was delivered.
  - `request-timeout` with `ambiguousDelivery === true`: reconcile before anything else. Query `thread/items/list { threadId, turnId: <the turn you steered>, limit: 100, sortDirection: 'asc' }` (page with cursor, bounded) on the root's own client and look for a `userMessage` item whose `clientId === 'steer-'+item.itemId`. Found: consume by id, emit. Not found: keep the item forwarded (unrecallable, not consumed), emit `session:error` saying delivery is uncertain and will be reconciled when the turn ends, and re-run the same reconciliation from `finishTurn` for that turn; found there → consume; not found there → `unmarkForwarded` so it is recallable again and eligible for the idle flush. If the reconciliation read itself fails, treat as not found at turn end only; never resend while the owning turn is still active. Never resend on the timeout itself.
- `disconnected()` must call `recallQueuedOnEngineLoss()` before `status('disconnected')` (it currently does not).
- Recall: default `tryRecallQueuedItem` (recallable until forwarded) is correct for Codex; do not override.
- Keep `run()`'s existing "turn already running" rejection for direct sends; the queue path is the only way in while busy.

### 4. Capability flags (`src/shared/model-capabilities.ts`)

Set `CODEX_ENGINE_CAPABILITIES.queue = true`. Report what `steer` gates in the renderer (grep) and leave it `false` unless it gates only behaviour this slice fully delivers; say which you chose and why.

### 5. Tests (all must fail before the corresponding change)

`src/core/codex/__tests__/codex-session.test.ts` (extend the existing fixture; use fake timers for the timeout case):

- enqueue while busy sends no RPC and broadcasts `session:queue-changed` with the item `queued`; recall before any boundary returns it and broadcasts `recalled`.
- `item/completed` on the active turn triggers `turn/steer` with `expectedTurnId` = active turn and `clientUserMessageId` = `steer-<itemId>`; success → `consumed` broadcast; a later native `userMessage` with that `clientId` emits `replacesMessageId: 'steer-<itemId>'`.
- two queued items with identical text are steered with distinct ids and consumed individually in order.
- steer rejected (rpc error) → item stays `queued`, is not consumed, and is sent via `turn/start` (with the steer id) after `turn/completed`.
- ambiguous timeout: (a) reconciliation finds the clientId → consumed, no resend; (b) not found → not consumed, `session:error` emitted, no resend during the turn; at `turn/completed` reconciliation not found → item recallable again; (c) at `turn/completed` reconciliation finds it → consumed.
- engine loss with pending items → all `recalled`.
- guard: a plain direct `run('x')` while busy still rejects (unchanged behaviour).
  `src/core/codex/__tests__/codex-replica.test.ts` or the birth test: a consumed steer row `steer-<id>` is replaced by identity when the native ack arrives (reducer path), and order is preserved.
  Integration (`src/integration/codex/codex-app-server.integration.test.ts`, run with `CODEX_INTEGRATION=1`): one real same-turn steer through `CodexSession` against the fixture provider: enqueue during a multi-item turn, observe `turn/steer` acceptance and the native user item carrying the steer clientId, and cold history containing that user item. Do not use real credentials.

### Out of scope (do not touch)

Hosted dynamic tools, history mapper extensions, fork, delete/archive, dispatch, cost/metering, docs. Do not change Claude/opencode/pi behaviour.

### Gates to run and report verbatim

```
bun run typecheck
bun run lint
bun run test
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
git diff --check
```

Known unrelated: `vscode-web-service` probeCli fails on darwin; `remote-*.test.ts` flakes ~1 in 4 under load. Rerun in isolation before blaming your diff.

### Report format

1. Changed files, one line each.
2. Per test: the pre-change failing assertion, then the passing result.
3. Gate commands and outcomes.
4. Judgment calls and anything left undone. Terse.

## Slice B: approve a guardian-denied action from the declined tool card

**Landed in `68bcf6e3` (2026-09-12).** Kept as the record of the design; two source facts below were corrected during implementation: the review completes before the target item's `item/completed`, and the shared reducer drops a pending approval when a `tool_result` for its id arrives, so the offer is held until the declined item completes and re-armed after a corrected authoritative replay; and `GuardianCommandSource` values differ in casing (`unifiedExec` vs `unified_exec`), not only the type tag.

Decided by Daniel on 2026-09-12: no pop-up approval card. A guardian denial
already leaves a declined tool card in the transcript; the override action
lives on that card, so it can be clicked when wanted and ignored otherwise.

Depends on: the guardian rows from commit 7022abf3 and the generated
`thread/approveGuardianDeniedAction` method map entry.

### Source facts (`.cache/codex-src`, tag `rust-v0.154.0`)

- `item/autoApprovalReview/completed` carries `threadId`, `turnId`, `reviewId`,
  `targetItemId` (nullable: null for network-policy reviews), `startedAtMs`,
  `completedAtMs`, `decisionSource`, `review {status, riskLevel,
userAuthorization, rationale}` and `action` (v2 `GuardianApprovalReviewAction`,
  camelCase fields, `type` tag). `targetItemId` names the `commandExecution` or
  `fileChange` item the denial belongs to; that item completes with
  `status: 'declined'`, and `event-mapper.ts` already emits its `tool_result`
  with `isError: true`. Its ClaudeUI id is `codexItemId(threadId, turnId,
targetItemId)`, which is the `toolUseId` of the card.
- `app-server/src/request_processors/thread_processor.rs`
  `thread_approve_guardian_denied_action_inner`: `serde_json::from_value(event)`
  into the core `GuardianAssessmentEvent`, `invalid_request("invalid Guardian
denial event")` on a bad shape, `load_thread` (the thread must be live in this
  process), `ensure_direct_input_allowed`, then `Op::ApproveGuardianDeniedAction`.
- `core/src/session/handlers.rs` `approve_guardian_denied_action`: ignores any
  status other than `Denied`; does NOT re-run the action; serializes
  `{action, outcome: "allowed"}` into a `GuardianApprovedAction` user-context
  fragment and `inject_no_new_turn`. The model sees it on its next turn and may
  retry.
- `protocol/src/approvals.rs` `GuardianAssessmentEvent` is snake_case on the
  wire: `id`, `target_item_id`, `turn_id`, `started_at_ms`, `completed_at_ms`,
  `status` (snake_case enum: `denied`), `risk_level`, `user_authorization`,
  `rationale`, `decision_source`, `review_reason`, `plugin_id`, `script_path`,
  `action`. `GuardianAssessmentAction` is `#[serde(tag = "type", rename_all =
"snake_case")]` with snake_case fields: `command {source, command, cwd}`,
  `execve {source, program, argv, cwd}`, `apply_patch {cwd, files}`, and others.
  The v2 notification's `action` is `assessment.action.into()`
  (`app-server-protocol/src/protocol/item_builders.rs`), so the client must map
  camelCase back to snake_case. Read both files before writing the mapper.
- Renderer: `MessageBubble.tsx` binds a `PendingApproval` to a `tool_use` block
  by `toolUseId`; `ToolCard.tsx` renders `ApprovalButtons` when `!isHistorical
&& approval` (a card with a result still qualifies; verify); `FloatingApproval`
  shows only approvals with no matching block. A `PendingApproval` keyed to the
  declined item therefore renders on the card and never floats.

### Design

1. `CodexSession`: on a completed review with `review.status === 'denied'`,
   `targetItemId !== null`, and `action.type` in `command | execve | applyPatch`,
   keep the existing system row and also raise
   `PendingApproval { requestId: 'codex-guardian:<generation>:<codexItemId>:<reviewId>',
toolUseId: codexItemId(threadId, turnId, targetItemId), toolName, input,
decisionReason, codex: { guardianOverride: true } }`. `toolName` and `input`
   come from the already-mapped `tool_use` block in `messageHistory` (the same
   lookup the fileChange approval uses); `decisionReason` is "Codex auto-review
   denied this action." plus the clipped, whitespace-collapsed rationale. No
   `suggestions`. Verify the event order in
   `src/integration/codex/codex-auto-review-probe.integration.test.ts` (review
   before or after `item/started` for the target) and handle both: hold a denial
   until the target's `tool_use` exists in the same turn, then raise. Denials
   with a null `targetItemId` or another action type: row only, no override.
2. Type: `PendingApproval.codex` today is the questions-only
   `CodexApprovalChoices`. Add the override shape without breaking the
   `approval.codex?.questions` checks (make `questions` optional or use a
   discriminated union). Update the doc comment in `src/shared/codex-types.ts`.
3. `ApprovalButtons.tsx`: when `approval.codex?.guardianOverride`, render
   "Dismiss" (`data-testid="ApprovalButtons.dismiss"`, decision `deny`) and
   "Approve anyway" (`data-testid="ApprovalButtons.approveAnyway"`, decision
   `allow`), show `decisionReason`, no `AlwaysAllowSection`. Nothing else in the
   component changes.
4. Resolution in `CodexSession.resolveApproval`: `allow` sends
   `thread/approveGuardianDeniedAction { threadId, event }` with `event` rebuilt
   from the stored notification (snake_case, `status: 'denied'`, `action`
   mapped as above, the wrapped command string exactly as received). Success:
   dismiss (`session:approval-dismiss`) and append a system row keyed
   `codexItemId(threadId, turnId, reviewId) + ':override'`: "You approved
   `<label>` over Codex's auto-review. Codex will see this on its next turn and
   may retry." RPC error: dismiss and `session:error`. `deny`: dismiss only.
   `allowForSession`: throw (unoffered). Keep overrides in their own map, not
   `this.pending`, because there is no native server request to settle and
   `finishTurn` must not clear them.
5. Lifetime: an override survives the end of the turn it belongs to. It is
   cleared on approve, on dismiss, on `disconnected()`, and when the next
   `turn/start` succeeds (the injected context only matters before the model's
   next turn). Test all four.
6. Remote: the reply travels on `session:approval-response` with the `chat`
   capability as today; confirm the shared handler passes an approval whose
   `codex` field lacks `questions`.
7. Capabilities: no new flag.

### Tests (each must fail before the corresponding change)

- `src/core/codex/__tests__/codex-session.test.ts`: denied review plus declined
  item raises the approval bound to the item's id with `guardianOverride`;
  approved review raises nothing; null `targetItemId` raises nothing; both
  orderings of review and item; `allow` sends the exact snake_case params (snap
  them) then dismisses and rows; `deny` dismisses without an RPC; RPC error
  dismisses and errors; `turn/completed` does not dismiss; the next `turn/start`
  does; `disconnected` does.
- Renderer: `ApprovalButtons` with `guardianOverride` renders the two labelled
  buttons and no Allow/Deny, and clicks call `onApproval('allow' | 'deny')`.
  One `MessageBubble`/`FloatingApproval` assertion that the override binds to
  the declined card and does not float.
- Integration (`CODEX_INTEGRATION=1`, real binary, fixture provider, scripted
  deny verdict as in the probe): observe the approval request, resolve `allow`
  through `CodexSession`, assert no RPC error, start the next turn, and assert
  the fixture provider's next request body contains the injected fragment
  (`"outcome": "allowed"`). This is the guard for the event shape.

### Files and boundaries

Owned: `src/core/codex/CodexSession.ts`, `src/shared/codex-types.ts`,
`src/shared/types.ts` only if the union needs it,
`src/renderer/src/components/chat/ApprovalButtons.tsx`, tests under
`src/core/codex/__tests__/`, the renderer chat test directories, and
`src/integration/codex/`. Do not touch `InputBox.tsx`, `stores/replica.ts`,
`event-mapper.ts`, `history.ts`, the queue, or any other engine.
