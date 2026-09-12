# Codex integration: next slice specs

Kickoff specs for the next two implementation slices, preserved here because the orchestrating session's scratchpad expires. Each was written for an Opus implementing subagent under ADR-026: the main model reviews every line, reruns gates, and commits. Adjust HEAD references and file ownership notes before dispatching.

## Slice A: identity-aware held queue via turn/steer (ADR-053 parity)

**Landed in `4050eb0a` (2026-09-12).** Kept as the design record. Two corrections made during implementation: the spec's "keep the item forwarded (unrecallable)" for an ambiguous timeout and "do not override `tryRecallQueuedItem`" were incompatible (the base loop unmarks a still-queued item), so the behaviour won and a three-line `tryRecallQueuedItem` override refuses recall only for ambiguous steers; and boundary signals had to be chained (`queueBoundary`) because the base loop's re-entrancy guard dropped a turn end arriving mid-steer.

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

## Slice C: hosted tools over Codex dynamic tools (render_mermaid, create_mockup, show_mockup)

**Landed in `30421310` (2026-09-12).** Kept as the design record. Deviations made during implementation, both verified in the source: the v2 `dynamicToolCall` item drops the core's `error` field, so a cancelled call arrives as `failed` with empty `contentItems` and the mapper supplies its own no-result text; and no interactive `ask` card was built, because the shared ladder's hosted auto-allow rung sits directly below deny and no Claude rule string maps to the `diagram`/`mockup` kinds, so a non-allow verdict is unreachable today and is answered fail-closed (`success: false` plus the reason) rather than with untestable card machinery. Resume persistence of the specs is confirmed from `core/src/session/mod.rs:721` and live.

Scope: the three ClaudeUI-hosted UI tools only. `dispatch_agent` (cross-engine
dispatch as a source) is M4 and out of scope.

### Source facts (`.cache/codex-src`, tag `rust-v0.154.0`; re-verify each before relying on it)

- `thread/start` takes `dynamicTools?: DynamicToolSpec[]` (`{type:'function', name, description, inputSchema, deferLoading?}` or a namespace). Neither `thread/resume` nor `thread/fork` accepts the field (generated params, 0 matches). Find out from `core/src/thread_manager.rs` / `app-server/src/request_processors/thread_processor.rs` whether definitions given at start persist into the rollout and are restored on resume; the spec's M3 text expects "cold definitions persist; resume cannot override them with an empty list". Report what the source says and, if a resumed thread has NO hosted tools, say so plainly and set the capability accordingly (ADR-030) rather than pretending.
- When the model calls a dynamic tool, `core/src/tools/handlers/dynamic.rs` `request_dynamic_tool` emits `item/started` for a `dynamicToolCall` item (`{id: callId, namespace, tool, arguments, status: inProgress}`), the app-server sends the client a server request `item/tool/call` (`DynamicToolCallParams {threadId, turnId, callId, namespace, tool, arguments}`), and the item completes `completed` or `failed` from the response `{contentItems: [{type:'inputText', text} | {type:'inputImage', imageUrl} | {type:'inputAudio', audioUrl}], success}`. If the turn is aborted before a response, the pending sender is dropped and the item completes `failed` with error "dynamic tool call was cancelled before receiving a response"; a late response is then meaningless. `app-server/src/dynamic_tools.rs` `decode_response` shows what a malformed response turns into.
- `ThreadItem` already has the `dynamicToolCall` variant (`src/core/codex/protocol/v2/ThreadItem.ts` line 79) and `thread/read` returns it in cold history, so one mapper change covers live and cold.
- ClaudeUI reference implementations: `src/core/pi/PiSession.ts` `handleHostedTool` (dispatch by name onto `createMermaidServer()` / `createMockupServer(cwd)` handlers, `unknownHostedTool` fail-closed default) and `src/core/pi/pi-bridge-source.ts` (plain JSON-schema literals for the three tools; copy the shapes, keep field names identical so the shared kind bodies render them: `render_mermaid {source, title?}`, `create_mockup {html, title?}`, `show_mockup {directory}`). Policy: `src/core/pi/permission-engine.ts` lines ~120-180 map the three names onto shared tool kinds and `PI_HOSTED_TOOL_NAMES`; Codex applies the SAME verdicts through `decideWithSource` (the session already has `gate()` and the `Pending` machinery for an `ask`).
- Renderer: `PiEngineToolMap.ts` `kindOf` (`render_mermaid` → `diagram`, `create_mockup`/`show_mockup` → `mockup`) and its `normalize` for those kinds are the model for `CodexEngineToolMap.ts`.

### Design

1. New `src/core/codex/codex-hosted-tools.ts`: `codexDynamicToolSpecs(): DynamicToolSpec[]` (three function specs, JSON-schema literals) and `runCodexHostedTool(name, args, cwd, signal): Promise<ToolResultContent>` reusing the mermaid/mockup handlers exactly as pi does. Pure, no session import.
2. `CodexSession`: pass `dynamicTools` on `thread/start`. Add `item/tool/call` to `serverMethods` and handle it in `requestApproval`'s dispatcher (or a sibling): refuse unless `threadId === this.threadId`, `turnId === this.turnId`, the turn has not ended, `namespace === null`, `tool` is one of the three, and `callId` has not been seen this process generation (one-shot: a repeated `callId` is refused, never re-executed). Gate through the shared engine like pi (`ask` raises the standard card bound to `codexItemId(thread, turn, callId)`; `deny` answers `{success:false}` with the reason as `inputText` and a `session:error`). Execute with `context.signal`; `finishTurn` already aborts server requests for the ended turn and `disconnected()` for all, so an aborted signal must stop the handler (pass it through to the mermaid/mockup handlers' `extra.signal`) and a result that arrives after abort is dropped. Map `ToolResultContent` → `contentItems`: text → `inputText`; image → `inputImage` with `data:<mime>;base64,<data>`; `success = !isError`.
3. `event-mapper.ts` `case 'dynamicToolCall'`: `tool_use {toolUseId: codexItemId(thread, turn, item.id), toolName: item.tool, toolInput: item.arguments}`; when completed, `toolResult` with the `inputText` items joined by newlines, `isError: item.status !== 'completed' || item.success === false`, plus `item.error` when present. Images from `inputImage` are out of scope for this slice; say so in a comment.
4. `CodexEngineToolMap.ts`: `kindOf` and `normalize` for the three names, mirroring pi's (the mockup `directory` is extracted from the result text there; do the same).
5. `CODEX_ENGINE_CAPABILITIES.hostedMcp = true` only if start AND resume both work end to end (ADR-030); otherwise leave `false` and report.

### Tests (each must fail before the corresponding change)

- `codex-session.test.ts`: `thread/start` params carry the three specs; a valid `item/tool/call` runs the handler (mock the mermaid/mockup modules) and answers `{contentItems, success:true}`; unknown tool, foreign thread, stale turn, non-null namespace, and repeated `callId` are refused without executing; `turn/completed` aborts an in-flight call's signal and a late handler result is not sent; plan-mode verdicts match pi's for each tool.
- `event-mapper.test.ts`: `dynamicToolCall` in progress → `tool_use` only; completed success → result text; failed with `error` → `isError` and the error text.
- Renderer: `CodexEngineToolMap` tests (find pi's equivalents and mirror them).
- Integration (`CODEX_INTEGRATION=1`, real binary, fixture provider): script the provider to return a function call to `render_mermaid` with a small diagram; observe `item/tool/call` on the wire, answer it, see the `dynamicToolCall` item complete `completed`, and find the tool output text in the provider's next request. Second case: resume the same thread in a fresh `CodexSession` and check whether the provider's request still advertises the tool (this is the resume-persistence answer).

### Files and boundaries

Owned: `src/core/codex/codex-hosted-tools.ts` (new), `src/core/codex/CodexSession.ts`, `src/core/codex/event-mapper.ts`, `src/renderer/src/components/chat/tool-registry/CodexEngineToolMap.ts`, `src/shared/model-capabilities.ts` (the codex block only), their tests, `src/integration/codex/`. Do not touch pi/opencode/claude code, the queue, history listing, or docs.

## Slice D: completed-turn fork

### Source facts and as-built facts

- `thread/fork {threadId, lastTurnId?, beforeTurnId?, cwd?, model?, approvalPolicy?, sandbox?, approvalsReviewer?, excludeTurns?, ...}` (generated `ThreadForkParams.ts`): copies the source thread through `lastTurnId` inclusive into a NEW thread; the referenced turn cannot be in progress; the source is not modified. The returned `Thread` carries `forkedFromId` (the source) and `parentThreadId` (null for a fork; set for native CHILD threads). The lifecycle probe (`src/integration/codex/codex-lifecycle.integration.test.ts`) pinned: `thread/list` never lists forks; a thread with a surviving fork cannot be deleted. Re-verify `forkedFromId` vs `parentThreadId` on a real fork before relying on the distinction.
- ClaudeUI fork flow as built: renderer `session-store.ts` (~1780-1840) calls `session:resolve-fork-anchor` with `(sourceSessionId, cwd, messageId, engineId, messageIndex)`, expects `ForkAnchorResult {anchorUuid, reason?}`, seeds the branch optimistically with the source's messages up to the anchor, then `createSession({resumeSessionId: source, resumeSessionAt: anchorUuid, forkSession: true, engineId})`. `engine-history.ts` routes `forkAnchor` per engine (codex: `unsupported`); `create-session.ts` (~line 123) refuses codex fork; `CodexSession.start()` (~line 427) throws on `forkSession`/`resumeSessionAt`; `CODEX_ENGINE_CAPABILITIES.fork` and `forkFromMessage` are false, and the renderer shows "This engine does not support branching" when `forkFromMessage` is false.
- Codex message ids are `codexItemId(threadId, turnId, itemId)` = `codex:` + JSON array, so the turn id is recoverable from any transcript message id, including guardian rows (`codex:[thread, turn, reviewId]`).
- Fork granularity is the TURN. A fork "from message N" keeps the whole turn containing N. The renderer's optimistic seed slices at N; live, the new session's ids all carry the fork's thread id, so the seed and new turns never collide, and a cold reload replaces the seed with the fork's own history. Accept the seed/turn-boundary mismatch as cosmetic and note it in the report; do not change the shared renderer flow.
- Listing: since `thread/list` never returns forks, a fork would vanish from the sidebar after restart. `setSessionMeta(threadId, {engineId:'codex', ...})` already runs for every started Codex thread (`CodexSession.start()`), so the set of codex ids in `session_meta` minus the natively listed ids is exactly the forks plus deleted threads. `listCodexSessions` reads each such id with the service (`thread/read`, or `history()` if no lighter read exists), skips ids the binary refuses, and includes the rest with the same `SessionInfo` shape. Bound concurrency (four at a time) and never let one failure fail the list.

### Design

1. `engine-history.ts` codex `forkAnchor(id, cwd, messageId)`: parse the turn id out of `messageId`; `thread/read` the source through `CodexService`; return `{anchorUuid: turnId}` when that turn exists and its status is not `inProgress`, else `{anchorUuid: null, reason: 'turn-in-progress' | 'turn-not-found' | 'not-a-codex-message'}`. No JSONL, no Claude anchor.
2. `create-session.ts`: remove the codex refusal (keep the engine-identity check).
3. `CodexSession.start()`: when `forkSession && resumeSessionAt`, call `thread/fork {threadId: resumeSessionId, lastTurnId: resumeSessionAt, cwd, model?, approvalPolicy, sandbox, approvalsReviewer, excludeTurns: true}` instead of `thread/resume`; the response thread's `forkedFromId` must equal the source, its id becomes `this.threadId`, saved overrides are copied from the source id to the new id, `setSessionMeta` and `ensureCodexSessionOverrides` run for the new id. Keep the `parentThreadId` guard (a fork must have `parentThreadId === null`; if the real binary sets it on forks, stop and report). `resumeSessionAt` without `forkSession` (resume-at) stays unsupported and throws with a clear message.
4. `history.ts` `listCodexSessions`: add the fork discovery described above.
5. Capabilities: `fork: true`, `forkFromMessage: true` for codex once the real-binary test passes end to end.

### Tests (each must fail before the corresponding change)

- `engine-history.test.ts` / a codex history test: anchor from a live-turn message → null with reason; from a completed turn → the turn id; from a non-codex id → null with reason.
- `codex-session.test.ts`: fork spawn sends `thread/fork` with the exact params, rekeys to the new id, copies overrides, and refuses a response whose `forkedFromId` differs; resume-at without fork throws.
- `codex-discovery-history.test.ts`: listing includes a session_meta-only codex id that `thread/read` resolves, skips one the binary refuses, and does not read natively listed ids twice.
- Integration (`CODEX_INTEGRATION=1`, real binary, fixture provider): two turns on a root, fork at turn 1 → the fork's cold history has exactly turn 1's items, the source still has both turns, `thread/list` omits the fork, and `listCodexSessions` includes it. Also assert the fork's `parentThreadId` and `forkedFromId` values and quote them in the report.

### Files and boundaries

Owned: `src/core/services/engine-history.ts` (codex entry only), `src/core/ipc/create-session.ts` (the one refusal), `src/core/codex/CodexSession.ts` (`start()` only), `src/core/codex/history.ts`, `src/core/codex/CodexService.ts` (a read method if needed), `src/shared/model-capabilities.ts` (codex block), their tests, `src/integration/codex/`. Do not touch delete/archive, the renderer fork flow, or other engines.

## Slice E: Codex as a cross-engine dispatch source (`dispatch_agent`)

Scope: Codex SENDS work to a headless claude, opencode or pi target through the
existing `crossEngineDispatcher` (ADR-033). Codex as a dispatch TARGET is a
separate slice (the dispatcher needs a Codex target factory; M4).

### As-built facts (re-verify before relying on them)

- `src/core/services/cross-engine-dispatcher.ts`: `DispatchRequest {engine, prompt, model?, sessionId?}`, `DispatchContext {fromEngine, fromRoutingId, cwd, autonomyMode, emit, addDispatchedCost?, toolUseId?, extra?}`, `DispatchResult {text, sessionId, isError?}`; `crossEngineDispatcher.dispatch(req, ctx)`, `stopDispatch(toolCallId, routingId)`, `disposeFor(routingId)`. `crossEngineDispatchAvailable(engineId)` (~line 107) returns `false` for `codex` unconditionally; read its doc comment for what the function means before changing the branch.
- The model implementation for a NON-MCP source is `PiSession.handleDispatchAgent` (`src/core/pi/PiSession.ts`, ~line 2422 onward, plus `inFlightDispatchIds`, `interrupt()` calling `stopDispatch` for each, and `disposeFor(this.routingId)` on teardown). Copy its validation, `DispatchContext` construction, result text (the `[dispatch session_id: …]` suffix) and lifecycle verbatim in spirit; do not import from pi.
- Hosted-tool transport on Codex is slice C (`src/core/codex/codex-hosted-tools.ts`, `CodexSession.hostedToolCall`): a fourth function spec and a fourth handler branch ride the same channel. The `item/tool/call` params carry `callId`, so `toolUseId` for the `DispatchContext` is `codexItemId(threadId, turnId, callId)`, which is exactly the `tool_use` id the mapper emits for the `dynamicToolCall` item, so the dispatcher's subagent-stream and task events land on the right card.
- The pi permission engine treats `dispatch_agent` as a hosted tool that is NOT auto-allowed (`PI_HOSTED_TOOL_NAMES` minus `PI_AUTO_ALLOW_HOSTED_TOOLS`), so the shared ladder answers `ask` in default/acceptEdits and `deny` in plan; `CodexSession.gate()` already maps `auto` to `default` for anything that reaches this client, and Codex's own guardian never sees a dynamic tool call, so under `auto` a Codex dispatch asks the human. Read `decideWithSource` and confirm the verdicts per mode before writing the tests.
- Slice C answered every non-allow hosted verdict fail-closed because none was reachable. Dispatch makes `ask` reachable, so this slice adds the card: a `PendingApproval` bound to the call's `toolUseId` (`toolName: 'dispatch_agent'`, `input: {engine, prompt, model?, session_id?}`), resolved through the existing `pending` map (`resolveApproval` `allow`/`deny`; `allowForSession` adds the session-allow key exactly as commands do). `finishTurn` settles it with the turn; disconnect settles all. The card renders on the `dynamicToolCall` tool card, like every other id-bound approval.
- The dispatched turn's spend is folded into the source session with `addDispatchedCost` (`BaseSession`), and `dispatched_usage` rows are the dispatcher's own.

### Design

1. `codex-hosted-tools.ts`: add the `dispatch_agent` spec (engine enum `claude | opencode | pi`, `prompt`, optional `model`, optional `session_id`; descriptions carry the model hints from `dispatch-model-hint.ts` like opencode's schema does). Keep `CODEX_HOSTED_TOOL_NAMES` as the allowlist and extend it. Do not add dispatch to `runCodexHostedTool`; dispatch is a session concern (it needs routing id, cwd, mode, emit, cost sink and the abort signal), so `CodexSession.hostedToolCall` branches on the name before calling the pure module.
2. `CodexSession`: gate `dispatch_agent` through `gate()`; on `ask` raise the card described above and await it; on allow call `crossEngineDispatcher.dispatch(req, ctx)` with `ctx.extra = { signal: context.signal, sendNotification }` so an aborted turn stops the target (read how the dispatcher consumes `extra.signal` and `stopDispatch` before choosing between the two; pi uses `stopDispatch` because its bridge has no signal, Codex HAS one). Track in-flight ids; `interrupt()` and `disconnected()` call `stopDispatch` for each; `dispose()` calls `disposeFor(routingId)`. Map the `DispatchResult` to `{contentItems: [{type:'inputText', text}], success: !isError}`.
3. `crossEngineDispatchAvailable('codex')`: return whether at least one target engine is available, consistent with the function's documented meaning for the other sources.
4. Capabilities: `CODEX_ENGINE_CAPABILITIES.crossEngineDispatch = true` once the real-binary test passes (ADR-030).
5. Same-engine dispatch (codex → codex) is rejected by the dispatcher's engine guard today because there is no Codex target; keep it rejected with a clear tool result.

### Tests (each must fail before the corresponding change)

- `codex-session.test.ts`: the fourth spec is declared; a `dispatch_agent` call in default mode raises the card bound to the call id and runs nothing until `allow`; `deny` answers `{success:false}` with the reason; plan mode denies without a card; `auto` asks; a valid allowed call invokes a mocked `crossEngineDispatcher.dispatch` with the exact `DispatchRequest` and a `DispatchContext` whose `toolUseId` is the call's id and whose `autonomyMode` is the session's mode; the result text and `isError` map onto `contentItems`/`success`; `turn/completed` mid-dispatch aborts the signal and calls `stopDispatch`; `dispose` calls `disposeFor(routingId)`; `addDispatchedCost` is wired.
- `cross-engine-dispatcher` test file: `crossEngineDispatchAvailable('codex')` follows target availability.
- Integration (`CODEX_INTEGRATION=1`, real Codex binary, fixture provider scripting a `dispatch_agent` function call): with the dispatcher's target stubbed at the `DispatchTargetClient` seam (no real second engine), observe the card, resolve `allow`, and see the dispatched text returned to the provider on the next request as the tool output; a second run under `plan` sees the denial text instead.

### Files and boundaries

Owned: `src/core/codex/codex-hosted-tools.ts`, `src/core/codex/CodexSession.ts` (`hostedToolCall`, lifecycle hooks), `src/core/services/cross-engine-dispatcher.ts` (the availability branch only), `src/shared/model-capabilities.ts` (codex block), their tests, `src/integration/codex/`. Do not touch pi/opencode/claude dispatch code beyond reading it, the dispatcher's target machinery, or docs.
