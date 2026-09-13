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

**Landed in `5e92e52f` (2026-09-12).** Kept as the design record. Confirmed on the real binary: a fork carries `forkedFromId` and a null `parentThreadId`, preserves the source turn ids, and `thread/list` omits it. One thing the spec missed, found on the real app: the fork's canonical seed goes through the shared history reader WITH the turn anchor, and the codex reader refused every anchor as a Claude line uuid; it now truncates the source history through that turn.

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

**Landed in `843b4ecf` (2026-09-12).** Kept as the design record. Three departures from the text, all deliberate: the dispatcher's blanket `fromEngine === 'codex'` refusal had to go (one line outside the "availability branch only" boundary) or nothing could run; `CodexEngineToolMap` gained the `task` mapping so the call renders as a TaskCard rather than an unknown tool; and turn end relies on the abort signal alone rather than also calling `stopDispatch`, which would have logged a user stop the user did not make. `crossEngineDispatchAvailable('codex')` is always true because claude is a bundled target, the same reasoning as the opencode branch.

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

## Slice F: native children as subagent transcripts

**Landed in `5452d3c5` (2026-09-13).** Kept as the design record. Findings that changed it, all verified in the source and on the binary: the model, not the feature flag, picks the collab surface (`multi_agent_version_for_model`), and v2 (Astra, Sol, Terra, Daybreak) puts `subAgentActivity` items in the transcript instead of the spawn's `collabAgentToolCall`, so both are mapped; no `thread/started` is ever emitted for a spawned child (three emit sites: start, fork, detached review), so a child's early notifications are held until its spawn item binds it; a v2 `completed` activity arrives after the parent turn ended and is the one item honoured for an ended turn; parent interrupt does not cascade natively; children do not inherit `dynamicTools`. Additive shared change: `SessionHistoryResult.subagentMessages`.

Scope: render the child threads a Codex root spawns through its collab tools
(`spawnAgent`, `sendInput`, `wait`, `closeAgent`, ...) as ClaudeUI subagent
transcripts under the parent's tool card, with approvals from children routed
to the human, cancellation on interrupt, and cold reconstruction. No new
control surface (the user does not drive children directly).

### Source facts (`.cache/codex-src`, tag `rust-v0.154.0`; re-verify each)

- `features/src/lib.rs`: `Feature::Collab` (key `multi_agent`) is `Stage::Stable`, `default_enabled: true`; `MultiAgentV2` (`multi_agent_v2`) is stable but default off; `MultiAgentMode` is removed. So a stock 0.154.0 thread already has the collab tools and can spawn children without any config from us.
- `core/src/tools/handlers/multi_agents_common.rs` `thread_spawn_source`: a child is a thread with `SessionSource::SubAgent(SubAgentSource::ThreadSpawn {parent_thread_id, depth, agent_path, agent_nickname, agent_role})`; the v2 `Thread` exposes `parentThreadId`, `agentNickname`, `agentRole`, `source`, `threadSource`.
- Parent transcript item: `ThreadItem` variant `collabAgentToolCall {id, tool: CollabAgentTool, status: CollabAgentToolCallStatus, senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agentsStates: {[threadId]: {status, message}}}` (`src/core/codex/protocol/v2/ThreadItem.ts`). For `spawnAgent`, `receiverThreadIds` is the new child. `CollabAgentStatus`: `pendingInit | running | interrupted | completed | errored | shutdown | notFound`.
- Delivery: `app-server/src/lib.rs` ~1174: on every thread the manager creates (children included), the server calls `try_attach_thread_listener(thread_id, <all initialized connection ids>)`, so OUR one stdio connection receives the child's `thread/started` (`{thread}`, with `parentThreadId` set), `thread/status/changed`, and every `item/*` and delta notification carrying the child's `threadId`, plus any server request (approvals, `item/tool/call`) the child raises. `CodexSession.notification()` currently drops anything whose `threadId !== this.threadId` (line ~880) and `requestApproval` rejects foreign threads; that is the seam.
- ClaudeUI's neutral contract (`src/core/shared/sync/reducer.ts` ~758-800, `OpencodeSession.ts` ~1240-1275): `session:subagent-stream {toolUseId, type, text}`, `session:subagent-message {toolUseId, message}`, `session:subagent-message-batch`, `session:subagent-tool-result {toolUseId, toolResultToolUseId, result, isError, fileDiffs?, images?}`, all keyed by the PARENT's `toolUseId`; the renderer's TaskCard/subagent view hangs off the parent tool_use block with that id. `session:task-notification` (see `TaskNotification` in `src/shared/types.ts`) marks completion with usage.
- Cold history: `thread/read` of the parent returns the `collabAgentToolCall` items; the child's own transcript is `thread/read` of the child id (children are listed by `thread/list` with `parentThreadId` set and are filtered OUT of the sidebar by `listCodexSessions`, correctly).
- Lifecycle rules already pinned: children live in the root's process; root teardown must clean descendants (verify what `dispose()`/process exit does to running children in the source, `thread_manager.rs`); a child that outlives its parent's turn (`spawnAgent` without `wait`) keeps running.

### Design

1. `event-mapper.ts`: `case 'collabAgentToolCall'` → `tool_use {toolUseId: codexItemId(thread, turn, item.id), toolName: 'collab:' + item.tool (or the bare tool name; pick one and use it in the tool map), toolInput: {prompt, model, reasoningEffort, receiverThreadIds, agentsStates}}`; when completed, `toolResult` summarising `agentsStates` (status + message per child), `isError` for `errored`/`notFound`/failed status. `CodexEngineToolMap`: map it to the existing subagent/task kind Claude's `Task` and opencode's `task` use (find the kind name in `shared/tool-kinds.ts` and the pi/opencode maps; reuse, do not invent).
2. `CodexSession`: a `children: Map<childThreadId, {parentToolUseId, turnId}>` filled from `collabAgentToolCall` items with `tool === 'spawnAgent'` (`receiverThreadIds`) and cross-checked against `thread/started` notifications whose `thread.parentThreadId === this.threadId` (a `thread/started` for an unknown child before its item arrives is held briefly, as guardian denials are). `notification()` accepts `value.threadId` in `children` and routes: child `item/*` through `mapCodexItem(childThreadId, ...)` into `session:subagent-message` (whole-message upserts, as the parent's own path does) with `toolUseId = parentToolUseId`; child deltas into `session:subagent-stream`; child `tool_result`s into `session:subagent-tool-result`; child `turn/completed` and `thread/status/changed` into the parent item's `agentsStates` refresh only (the `collabAgentToolCall` item's own completion is what ends the card). Grandchildren (depth > 1) are routed to the nearest known ancestor's card or dropped with a `session:error` once; say which and why.
3. Approvals from a child (`item/commandExecution/requestApproval` etc. with a child `threadId`): route through the SAME `requestApproval` gate with the child's thread id accepted when it is in `children`, `requestId` including the child thread id, and the card's `toolUseId` set to the CHILD item's id so it renders inside the subagent transcript if the renderer supports id-bound approvals there (verify; otherwise fall back to the parent tool card's id and say so). Under `auto` nothing arrives, as for the root. `item/tool/call` from a child: refuse (hosted tools are declared on the root only; verify whether children inherit `dynamicTools` from the parent's SessionMeta; if they do, allow with the same one-shot/allowlist rules and the child's id).
4. Interrupt: `interrupt()` on the root sends `turn/interrupt` for the root turn only; check in the source whether that also stops children spawned in that turn (collab `wait` semantics) and, if not, send `turn/interrupt` for each running child's active turn (track child `turn/started` ids). `dispose()`/`disconnected()` settle child pendings and emit a terminal `session:task-notification` for each open card.
5. Cold reconstruction (`history.ts` `loadCodexHistory`): for each `collabAgentToolCall` item with children, read the child thread(s) and return their mapped messages in `SessionHistoryResult` under the parent tool_use id in whatever field the shared type uses for subagent transcripts (find how Claude's history loader populates `agentIdToToolUseId` and subagent messages; mirror it). Bound the depth and the number of child reads.
6. Metering: child usage arrives as the child's `thread/tokenUsage/updated` (or equivalent) notifications; fold into the root's metering under the same account, and mark the task notification's usage. Do not double count with the root's own usage; state how you distinguished them.
7. Capability: `CODEX_ENGINE_CAPABILITIES.subagents = true` only when live and cold both work (ADR-030).

### Tests (each must fail before the corresponding change)

- Mapper: `collabAgentToolCall` in progress and completed; `agentsStates` summary; error statuses.
- Session: a `spawnAgent` item registers the child; a child `item/completed` emits `session:subagent-message` under the parent id; child deltas stream; a child approval request raises a card with the child's thread in its request id and answering it replies on the wire; an unknown thread is still dropped; `thread/started` arriving before the item is held then bound; interrupt reaches running children (per the source finding); dispose settles child pendings and closes the cards.
- History: cold load reconstructs the child transcript under the parent tool id.
- Integration (`CODEX_INTEGRATION=1`, real binary, fixture provider): script the provider to call `spawn_agent` (find the exact tool name and arguments the collab tool expects from `multi_agents.rs`), then `wait`; observe the child's `thread/started` with `parentThreadId`, child items on the same connection, the subagent events under the parent card, the completed `collabAgentToolCall`, and the cold read of both threads. Quote the wire facts.

### Files and boundaries

Owned: `src/core/codex/event-mapper.ts`, `src/core/codex/CodexSession.ts`, `src/core/codex/history.ts`, `src/renderer/src/components/chat/tool-registry/CodexEngineToolMap.ts`, `src/shared/model-capabilities.ts` (codex block), their tests, `src/integration/codex/`. Do not touch other engines, the reducer, the renderer's subagent views, or docs. If the reducer or the shared subagent types need a change, stop and report.

## Slice G: delete a Codex session by walking its branch tree, with confirmation

**Landed in `01f38172` (2026-09-13).** Departures and findings: spawned collab children need no walk (`thread/delete` removes the spawn subtree itself, confirmed live); the "await disconnected" barrier does not exist (the writer lock is released when the app-server PROCESS exits), so a refused delete of a just-stopped node is retried for 3 s instead; `locateCodexBinary()` gates the delete rather than `codexBinaryAvailable()`; a fork that has run a turn IS listed by `thread/list` without lineage, so adoption (now generation v3) and the plan sweep read metadata for every codex `session_meta` id and never trust the listing; `-32600` from `thread/read` is confirmed by a second spaced read before it counts as gone.

Decided by Daniel on 2026-09-13: delete walks the tree leaf-first after a
confirmation that lists what will be removed, and stops non-destructively at
the first refusal. Archive stays unused (ClaudeUI's own "hidden" sessions cover
that need).

### As-built facts (re-verify)

- Native rules pinned by `src/integration/codex/codex-lifecycle.integration.test.ts`: `thread/delete` and `thread/archive` are refused while a process holds the thread; a thread with a surviving descendant fork is refused even when unloaded; archiving the descendant does not lift that, only deleting it does; a fork's deletion is ordinary once its holder is stopped. EVERY refusal is the same JSON-RPC `-32600`, so a caller cannot tell "held" from "has a branch" from "no such thread". `CodexService.deleteThread` says "callers must stop the owning root process first".
- `src/core/ipc/handlers-core.ts` `deleteSession(manager, sessionId, projectKey, engineId)` refuses Codex today, and for the other engines does: `unwatchForDelete`, `manager.cancel(sessionId)` (a live session's routing id IS the thread id after rekey), `syncCore.removeSession`, `deleteSessionByEngine` → `engine-history.ts` `delete`, then `refreshCanonicalDirectories()`. `deleteProject` sweeps a project's sessions through the same path.
- The renderer's Sidebar already owns a confirmation modal (`deleteTarget` / `confirmDelete`, `Sidebar.tsx` ~600-640) and calls `window.api.deleteSession(sessionId, projectKey, engineId)`.
- The fork registry (follow-up A of the 2026-09-13 Codex agent, in the same session as this spec) records each fork's id and `forkedFromId`; native children (collab agents) carry `parentThreadId` and are never listed or shown as sessions. Whether deleting a root that has spawned children is refused for the children's sake must be probed (the fixture can spawn one).

### Design

1. **Plan query.** New core query `codex:delete-plan(threadId)` returning `{nodes: [{threadId, title, live: boolean, depth}], order: threadId[]}`: the subtree from the fork registry (a fork's forks included), leaf-first order, each node's title from the sidebar listing when known, `live` when `SessionManager` holds it. Exposed through the same command surface as `deleteSession` (desktop IPC and remote, `chat` capability, read-only so it can be a query).
2. **Confirmation.** The Sidebar's existing modal, when the target is a Codex session, fetches the plan and lists the branches that will go with it ("Also deletes 2 branches: …"), marking live ones as "will be stopped". A single "Delete all" confirms. No plan needed for a leaf: the existing text stands.
3. **Walk.** `handlers-core.deleteSession` for Codex: compute the plan again (never trust the renderer's copy), then for each node leaf-first: `unwatchForDelete`, `manager.cancel` if live and await its `disconnected` status (bounded wait), `syncCore.removeSession`, `service.deleteThread`. On success remove the node's `session_meta`, overrides and fork-registry rows. On the FIRST refusal stop: nothing after it is touched, everything before it is gone; throw an error naming the node that refused and what was already deleted, and `refreshCanonicalDirectories()` so every client's sidebar is truthful. Because the refusal code is ambiguous, retry a refused delete exactly once after a short delay only when the node was live a moment ago (the holder may still be exiting); otherwise do not retry.
4. **Children.** If the probe shows a root with spawned children is refused for them, include children in the walk (they are threads with `parentThreadId`; discover them via `thread/list` since children ARE listed) and say so in the confirmation ("and 1 helper agent"). If not refused, do nothing special.
5. **`deleteProject`** for a directory containing Codex sessions goes through the same walk per root; a branch whose root is elsewhere is just a node.
6. **Capabilities:** none new; `engine-history.ts` `delete` for codex stops being `unsupported`.

### Tests (each must fail before the corresponding change)

- Plan: registry with root → fork → fork-of-fork yields leaf-first order and marks the live one.
- Walk: mocked service deletes in order; a refusal at node 2 leaves node 3 untouched, removes node 1's rows, throws naming node 2; a live node is cancelled and awaited before its delete; rows and canonical entries removed only for deleted nodes.
- Renderer: the modal lists branches for a Codex target and not for a leaf.
- Integration (`CODEX_INTEGRATION=1`): real root with two forks, one fork held by a live session: the walk stops the holder, deletes leaf-first, the root is gone from `thread/list` and refused by `thread/read`; a second case where a holder cannot be stopped (a separate service process holds a fork) shows the non-destructive stop; and the children probe.

### Files and boundaries

Owned: `src/core/ipc/handlers-core.ts` (the codex branch of `deleteSession`/`deleteProject`), a new `src/core/codex/delete.ts`, `src/core/codex/history.ts` (registry reads), `src/core/services/engine-history.ts` (codex `delete`), `src/core/services/db.ts` (registry reads/removals only), the command registration for the plan query, `src/renderer/src/components/Sidebar/Sidebar.tsx` (modal contents) and its tests, `src/integration/codex/`. Do not touch other engines' delete paths.

## Slice H: Codex as a cross-engine dispatch target

**Landed in `749886cc` (2026-09-13).** Departures from the text, all deliberate: an unknown `session_id` is refused rather than resumed (a model-authored id must not reopen arbitrary threads); a model is optional for a Codex target because the catalog is readable before the thread exists, so the allowlist stays enforceable; the usage row's cost is null, not zero, for an unpriced model; `auto` is allow-all at the target's gate because a target has no human and the native reviewer is the decider; the `acceptEdits` outside-workspace narrowing is duplicated in the dispatcher; `maxCostUsd` is enforced on the equivalent. Fixture findings: a `[model_providers.openai]` table in config.toml is ignored (only `openai_base_url` redirects the built-in provider) and the built-in provider attempts a WebSocket upgrade first, so an HTTP fixture must answer 426.

Decided by Daniel on 2026-09-13: build it. A Claude, opencode or pi session
(and, once the same-engine guard allows it, another engine only, never Codex
itself) can hand a task to a headless Codex thread through `dispatch_agent`.

### As-built facts (re-verify)

- `src/core/services/cross-engine-dispatcher.ts`: `dispatchInner` routes by `req.engine` to `resolveAndRunClaude` / `resolveAndRunPi` / the opencode path; `TargetEntry` is a union of per-engine entries kept in `this.targets` by target session id; a target lives across continuation calls (`req.sessionId`) until `disposeFor(fromRoutingId)` or its own exit. The pi target (`createPiTarget`, `drivePiTurn`, `forwardPiTargetMessage`, `gatePiTargetToolCall`, ~lines 3255-3560) is the closest template: a headless process per target, events mapped into `session:subagent-stream/-message/-tool-result` under `ctx.toolUseId`, a `settled` resolver per turn, a `busy` reject for a second call mid-turn, `turnToolUseIds`/`turnTotalTokens` for the task notification, `recordDispatchedUsage` per turn, `draining` to refuse late asks after a stop, and a gate that runs the shared permission engine with EMPTY rules against the target's fixed `autonomyMode` so only `ask` reaches the human (forwarded as a `PendingApproval` bound to the target item's own id, which floats on the caller's client). Injectable spawn functions (`SpawnPiTargetFn`) keep the unit suite off real binaries.
- Codex pieces to reuse, not copy: `CodexClient` (one process, `start`, `request`, `onNotification`, `onServerRequest`, `abortServerRequests`, `dispose`), `mapCodexItem`/`mapCodexDelta`/`codexItemId` (`event-mapper.ts`), `unwrapShellCommand`, `selectCodexModel`/`assertCodexProvider` (`model-selection.ts`), the mode→native policy table and `turnInput` in `CodexSession.ts` (export them or lift them into a small `codex-turn-policy.ts`; do not duplicate), `decideWithSource` (`pi/permission-engine.ts`), `equivalentCostUsd` with the OpenAI entries (follow-up B). `codexBinaryAvailable()` (`codex-locate.ts`) is the availability test.
- ADR-066 rules for this direction: a separate target factory, never a fake `ISession`; caller-bound one-shot identity; target/model allowlists (`loadEngineConfig('codex').dispatch` if the config shape already has it; otherwise report); a restriction-preserving policy envelope, never the legacy auto→bypass or plan→ask mapping; child approval forwarding; real cancellation; late-result suppression; no recursion (a target must not be able to dispatch).

### Design

1. **`CodexTargetEntry`** (`kind: 'codex'`): `threadId`, `client: CodexClient`, `ctx`, `autonomyMode` fixed at creation, `busy`, `turnId`, `settled`, `draining`, `turnToolUseIds`, `turnUsage: TokenUsageBreakdown | null`, `model`, `completedItems` fingerprint map (as the session keeps). Registered in `this.targets` by `threadId` once `thread/start` returns.
2. **Create.** `createCodexTarget(ctx, model)`: spawn via an injectable `SpawnCodexTargetFn` (default: `new CodexClient({cwd: ctx.cwd, serverMethods: [the four approval methods], onNotification, onServerRequest, onDisconnect})`), `start` with `clientInfo.name 'claudeui_dispatch'`, `config/read` + `assertCodexProvider`, `model/list` and `selectCodexModel` for the requested model (allowlist from the codex engine config; refuse a model outside it with the same isError text the other targets use), then `thread/start {cwd, model, approvalPolicy, sandbox, approvalsReviewer, historyMode 'paginated', allowProviderModelFallback false}` with NO `dynamicTools` (that is the recursion scrub: a target has no `dispatch_agent` and no hosted tools). Continuation: `req.sessionId` names an existing entry → reuse it; if unknown, `thread/resume` in a fresh client and register.
3. **Policy envelope** from `ctx.autonomyMode` using the session's own mode table: plan → `untrusted` + read-only sandbox, and the gate denies every write/command ask; default/acceptEdits → `untrusted` + workspace-write, gate as below; auto → `on-request` + `auto_review` (native guardian; no client asks). Never bypass. Say in a comment which table row each mode maps to.
4. **Gate** (`onServerRequest`): the same request shapes `CodexSession.requestApproval` handles (command, file change, user input, permissions). Unwrap the shell wrapper, run `decideWithSource` with EMPTY rules and an empty session-allow set against the fixed mode; `allow` → accept; `deny` → decline; `ask` → forward a `PendingApproval {requestId: XENG_REQUEST_PREFIX + uuid, toolUseId: <target item id>, toolName, input}` to the caller through `ctx.emit` and resolve through the dispatcher's existing `pendingApprovals` map with a `kind: 'codex'` variant mirroring `PiPendingApproval`; `requestUserInput` → decline (no question UI across dispatch) unless the Claude target already forwards questions, in which case mirror it. `draining` refuses late asks. `item/tool/call` never arrives (no dynamic tools) and is rejected if it does.
5. **Drive a turn.** `turn/start {threadId, clientUserMessageId, input: turnInput(prompt)}`; `busy` until `turn/completed`; items and deltas for the target thread mapped with the existing mapper and forwarded exactly as `forwardPiTargetMessage` does (collect tool_use ids; skip `commandDelta`). Notifications for OTHER thread ids (native children a target spawns) are dropped; note it. `thread/tokenUsage/updated` → `turnUsage`. On `turn/completed`: result text = the last `agentMessage` text (or the turn's error), `sessionId = threadId`, and `recordDispatchedUsage` with input/output/total tokens and `costUsd = equivalentCostUsd('openai', model, …) ?? 0` (say which field means "unknown" in that row; do not invent a price).
6. **Stop and teardown.** `stopDispatch` / `ctx.extra.signal` abort → `turn/interrupt {threadId, turnId}` and settle the turn as stopped; `draining = true`; the process stays for a possible continuation. `disposeFor(fromRoutingId)` disposes every Codex entry the caller owns (`client.dispose()`); `onDisconnect` mid-turn settles as error, as pi's `onExit` does. The per-turn absolute timeout uses `dispatchTimeoutMs` like Claude and pi.
7. **Availability and guards.** `crossEngineDispatchAvailable` counts Codex as a target for claude/opencode/pi sources when `codexBinaryAvailable()`; `dispatchInner`'s unsupported-target guard admits `'codex'`; the same-engine guard still rejects codex → codex. The source-side spec descriptions (`opencode-hosted-tools.ts`, `pi-bridge-source.ts`, `collab-tool.ts`) list target engines; add codex where the target list is enumerated and its model hint from `describeDispatchModels`.
8. **Capabilities:** nothing new on Codex; the other engines' `crossEngineDispatch` already exists. Document in the dispatcher header that codex is a target.

### Tests (each must fail before the corresponding change)

- Dispatcher unit (`src/main/services/__tests__/cross-engine-dispatcher.component.test.ts` or a sibling): with an injected fake `SpawnCodexTargetFn`, a claude-sourced dispatch to codex starts a thread with the plan/default/auto envelopes as specified; streams reach the caller's channels under `ctx.toolUseId`; an `ask` becomes a caller-side `PendingApproval` and `resolveApproval` answers the native request; plan mode denies a write without asking; a second call with `sessionId` reuses the entry; `stopDispatch` interrupts and settles stopped; `disposeFor` disposes; a late ask after stop is refused; `recordDispatchedUsage` row shape; unknown model refused; codex → codex still refused; `crossEngineDispatchAvailable('claude')` true when only the codex binary is present.
- Integration, new file `src/integration/codex/codex-dispatch-target.integration.test.ts` (`CODEX_INTEGRATION=1`, real binary, fixture provider): a real dispatch from a fake caller context into a Codex target: the fixture provider answers the target's request, the result text comes back, the usage row is recorded, and a second dispatch with the returned `sessionId` resumes the same thread; a stop mid-turn interrupts it.

### Files and boundaries

Owned: `src/core/services/cross-engine-dispatcher.ts` (new codex target path and the availability/guard lines), new `src/core/codex/codex-dispatch-target.ts` (or the policy/turn-input extraction module), `src/core/codex/CodexSession.ts` ONLY to export or lift the shared policy table and `turnInput` (no behaviour change; its tests must pass unchanged), the three source-side tool descriptions for the target list, the dispatcher tests, the new integration file. Do not touch `history.ts`, `db.ts`, `handlers-core.ts`, the Sidebar (slice G owns them), other engines' target paths, or docs.

## Slice I: approvals from nested agents render inline as well as floating

**Landed in `4be947f9` (2026-09-13).** Store-side binding inside `SubagentMessages`; floating kept. Finding: the opencode dispatch target's forwarded approvals carry no tool id, so they float only until a core change adds `props.tool.callID`.

Decided by Daniel on 2026-09-13: keep the floating card, and ALSO bind the same
approval to the matching tool block inside the nested subagent view.

### As-built facts (re-verify)

- `src/renderer/src/components/chat/FloatingApproval.tsx` `useUnmatchedApprovals` floats every pending approval whose `toolUseId` matches no `tool_use` block in the session's TOP-LEVEL `messages`. Nested transcripts live in `subagentMessages[parentToolUseId]`, so an approval raised by a Codex child agent (bound to the child item's id), or by a dispatched claude/opencode/pi target (bound to the target's inner tool call id, see `gatePiTargetToolCall`), always floats and never renders next to the command it concerns.
- `MessageBubble.tsx` (~268-295) binds `pendingApprovals` to tool blocks by `toolUseId` and hands the match to `ToolCard` as `approval`, which renders `ApprovalButtons`. `SubagentMessages.tsx` / `SubagentOutputBody.tsx` render the nested transcript without any approval binding.

### Design

1. `SubagentMessages` (and whatever it delegates tool rendering to) receives the session's `pendingApprovals` and binds them to nested `tool_use` blocks by `toolUseId` exactly as `MessageBubble` does, passing the match down so the nested `ToolCard` shows the same `ApprovalButtons`. Same `onApproval` path (`window.api.resolveApproval` or the store action the top level uses); one `requestId`, so answering either surface dismisses both.
2. `useUnmatchedApprovals` is NOT changed: an approval bound to a nested block still floats, by decision. Add a comment there saying so.
3. Works for all producers: Codex child agents, and dispatched targets on any engine (verify the dispatcher's forwarded approvals use the inner tool call id that the nested `tool_use` block carries; the Claude and pi target gates do, check opencode's).
4. No core change; if a core change is needed, stop and report.

### Tests (each must fail before the corresponding change)

- Component: a nested subagent transcript with a `tool_use` block and a pending approval bound to it renders `ApprovalButtons` inside the nested view AND the floating card; clicking Allow in the nested view calls the same resolve with the same `requestId`; an approval for a top-level block does not render in the nested view.
- Real-app check by the reviewer: a Codex child agent asking for approval in default mode shows both surfaces.

### Files and boundaries

Owned: `src/renderer/src/components/chat/SubagentMessages.tsx`, `SubagentOutputBody.tsx`, `FloatingApproval.tsx` (comment only), their tests. Do not touch core, the reducer, or other renderer components; do not touch the Sidebar (slice G).

## Follow-ups landed on 2026-09-13 without a doc spec (kickoffs were inline)

- **Queue (`d4d5bf60`)**: `patch/queue-control` Part A3 announces the between-turns drain pickup (`docs/protocol-cc/04-system-subtypes.md` §4.10 has both emit sites); `BaseSession.flushQueuedItems` remembers a mid-flush boundary and runs one more pass. Live harness 10/10.
- **Codex follow-ups (`76453c7f`)**: fork registry (db v16 `codex_forks`, one-time adoption of pre-registry forks, prune only on `-32600`), API-rate equivalent cost for the Codex catalog models (prices in `src/shared/pricing.ts`, sources cited), a child's failed/interrupted turn closes its card, the v2 wait card is filled from the session's child registry.
