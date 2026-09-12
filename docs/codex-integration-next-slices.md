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

## Slice B: approve a guardian-denied action ("approve anyway")

Depends on: the guardian rows from commit 7022abf3 and the generated
`thread/approveGuardianDeniedAction` method map entry.

Source facts (`.cache/codex-src`, tag `rust-v0.154.0`):
`core/src/session/handlers.rs` `approve_guardian_denied_action` does NOT
re-run the action; it injects a "user approved this action" context fragment
(`GuardianApprovedAction`) into the thread without starting a turn, so the
model's next turn knows the human overrode the guardian and may retry. The
request payload is `{ threadId, event }` where `event` is the serialized
`GuardianAssessmentEvent` for the denied review; it is ignored unless
`status == Denied`.

Design:

- When `item/autoApprovalReview/completed` arrives with `status: denied`, in
  addition to the system row, raise a `PendingApproval` card with one action,
  "Approve anyway", and a `codex` payload carrying the review event verbatim
  (the wire shape the method needs back). Identity: `codex-approval:<generation>:<reviewId>`.
- Resolving it calls `thread/approveGuardianDeniedAction` with the stored
  event, dismisses the card (`session:approval-dismiss`), and appends a system
  row "You approved `<action>` over Codex's review; it may retry on its next
  turn." Deny/dismiss just clears the card.
- Cards are invalidated at turn end and on disconnect exactly like other
  pending approvals (ADR-038). Since the turn the denial belonged to has
  usually already ended, decide explicitly whether the card survives turn end
  (recommended: yes, until the next turn starts or the user dismisses it) and
  test both paths.
- Capability: no new flag; `interactiveApprovals` already covers it. Remote:
  the reply goes over `session:approval-response` with `chat` capability.

Tests: unit (card raised only for denied reviews; resolve sends the exact
event; dismissal on disconnect; survives turn end per the decision above),
renderer (card renders the review text and one button), integration
(fixture with a scripted deny verdict, then the override call observed on the
wire and the injected fragment visible in the next turn's request to the
fixture provider).
