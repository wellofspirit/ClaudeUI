# Phase 8e — opencode subagent permission surfacing (+ child-event race verification)

> Follow-up to Phase 8d (ADR-024). Fixes a **real turn-hang**: a subagent (task child session) that hits
> an `ask`-gated tool emits `permission.asked` under the child's sessionID, which `handleChildEvent`
> currently drops → the child blocks → the synchronous parent turn hangs. **Claude untouched.** Branch
> `v2-phase-8e-opencode-subagent-permissions` (off 8d). opencode source: `D:\WorkPlace\opencode-src` (v1.17.9).

## Verified facts (the hang is real)

From opencode 1.17.9 source:
- opencode's **default agent ruleset has explicit `ask` actions** (`agent/agent.ts` defaults): `doom_loop:ask`, `external_directory.*:ask` (minus a whitelist), `read["*.env"]:ask`, `read["*.env.*"]:ask`. The built-in `general`/`explore` subagents inherit these.
- `agent/subagent-permissions.ts deriveSubagentSessionPermission` builds the child's ruleset from the parent's **deny** rules + external_directory rules + `todowrite:deny`,`task:deny` — **parent `allow` rules are NOT propagated**. So even a fully-permissive/`full` parent yields a child that still asks on `doom_loop` / `.env` / uncovered tools.
- `permission/index.ts ask()`: a matched `deny` short-circuits before publish, but an `ask` (or the `evaluate()` default-`ask` when no rule matches) **publishes `permission.asked` and blocks the fiber** on a deferred. → the hang.

ClaudeUI seam:
- `event-mapper.ts handleChildEvent` switch has NO `permission.asked` case → `default: ignore` (the drop). The own-session `permission.asked` case (~lines 227–246) builds `PendingApproval { requestId:id, toolUseId: tool?.callID, toolName: permission, input: metadata, suggestions:[suggestOpencodeAllowRule(...)] }`.
- Downstream is **engine-neutral + requestId-keyed**: `dispatchMapperOutput` 'approval' case (auto-mode-or-human), `resolveApproval` → `replyPermission(requestId, reply)` → `POST /permission/{requestId}/reply` (opencode routes by requestId globally — no child-session handle needed). `FloatingApproval` renders per `requestId` and gates visibility on `toolUseId` not being in the rendered **main** message blocks.

## Scope (locked)

### Part 1 — surface child `permission.asked` (the fix)
Add a `case 'permission.asked'` to `handleChildEvent` (`event-mapper.ts`) that builds the SAME approval shape as the own-session case, with two deliberate differences:
1. `toolUseId = tool?.callID` — the **child tool's own callID**, NOT the parent task part's toolUseId. (The parent task toolUseId is already in the rendered main assistant blocks, so `FloatingApproval`'s unmatched-approval filter would immediately hide the card; the child tool's callID only appears inside the subagent blocks, so the card shows.)
2. **OMIT the `suggestions` (persist-rule) field.** An "always allow" persists to the shared Claude permission store → compiles into the **parent's** ruleset next spawn, but `deriveSubagentSessionPermission` only copies parent *deny* rules to children, so the persisted allow would NOT stop the child re-asking → misleading. Child approvals are once/allow-for-session/deny only. (Comment this.)

Return `{ kind: 'approval', approval }`. **No downstream changes** — the dispatch routes it (toolName ≠ 'AskUserQuestion' → permission path → auto-mode classifier in `full`/auto, else human), and `resolveApproval` replies via `replyPermission(requestId, …)` exactly as for own-session permissions. In `full`/auto mode the classifier (`handleAutoModeApproval`) judges with the parent's `messageHistory` — acceptable (the parent conversation is the available context; there's no separate child transcript in scope).

### Part 2 — child-event race: VERIFY, then document or fix
The Phase-8d spec flagged a race (child events arriving before the parent task-part registers the child → dropped). **Verify whether it can actually happen** before adding machinery:
- In `D:\WorkPlace\opencode-src/packages/opencode/src/tool/task.ts`: confirm the order — `sessions.create(child)` → `ctx.metadata({ metadata:{ sessionId } })` (which publishes the parent task part's `message.part.updated`, the event our `handleOwnEvent` registers the child from) → `ops.prompt(child)` (which produces the child's transcript events). Confirm `ctx.metadata`'s publish is synchronous and precedes `ops.prompt`. The server `/event` SSE is a single FIFO stream.
- **If confirmed** (metadata published before the child is prompted, single FIFO stream): child *transcript* events are always published AFTER the registration event → our registration always precedes them → **no transcript drop, no buffering needed**. The only pre-registration child events are its `session.created`/`session.updated` (which we don't render). **Document** with a clear comment at the child-registration site explaining the ordering guarantee, and add a unit test asserting the happy-path order (a task-part event registers the child, then a child `message.part.updated` → routes to `subagent-message`, not dropped).
- **If NOT confirmed** (metadata async / can reorder): implement a **bounded** buffer in `OpencodeSession.consumeEvents` — buffer events for not-yet-known sessions (cap ~50, evict oldest; do NOT buffer foreign sessions indefinitely), and after processing an own-session event that grew `childSessions`, drain+replay that child's buffered events through `mapEvent`+dispatch. Report which path you took + the evidence.

Report the Part-2 verdict (ordering confirmed → documented, or not → buffered) with the `task.ts` citation.

## File / seam map
- `src/main/opencode/event-mapper.ts` — `handleChildEvent` `permission.asked` case (Part 1); registration-ordering comment (+ buffer if Part 2 needs it, but that lives in OpencodeSession).
- `src/main/opencode/OpencodeSession.ts` — only if Part 2 needs the buffer; otherwise unchanged (the approval flows through existing dispatch/resolveApproval).
- Tests under `src/main/opencode/__tests__/`.
- No capability change (subagents already true).

## Tests (mocked, no binary)
- `event-mapper`: a CHILD `permission.asked` (sessionID = a registered child) → `{kind:'approval'}` with `toolUseId === tool.callID`, `toolName === permission`, `input === metadata`, and **no `suggestions`**. A child permission for an UNregistered session → ignore (unknown foreign).
- `OpencodeSession`: dispatch a child approval in **ask/default** mode → `session:approval-request` emitted; `resolveApproval(requestId,'allow')` → `replyPermission(requestId,'once')`; `('deny')` → `'reject'`. In **full/auto** mode → `handleAutoModeApproval` is invoked (classifier path) for the child approval (assert it's NOT auto-sent to the human when auto-mode is on).
- Part 2: the ordering happy-path test (or the buffer-replay test if implemented).
- Keep existing 8d subagent tests green.

## Verify
```
bun run typecheck && bun run test:ci && bun run lint && bun run build
```
(Gate via a verification subagent. Live opencode drive is a separate task.)

## Gotchas
- **toolUseId = child tool callID**, not the parent task toolUseId (else FloatingApproval hides the card).
- **No persist suggestion** for child approvals (won't reach the child's derived ruleset — misleading).
- **Don't break Claude** / own-session permissions — only ADD the child `permission.asked` case; the own-session case + dispatch + resolveApproval are unchanged.
- A child approval is a PERMISSION (toolName = category like 'read'/'bash'/'doom_loop'), so it must flow through the permission path (auto-mode/human), NOT the AskUserQuestion path.
- No `bun install`/`add`. Main-process-only.

## Commit
One commit, no AI attribution. Includes the phase-7 deferred-list edit (subagent metering) already staged on this branch. Suggested subject:
`fix(v2/opencode): surface subagent permission prompts + verify child-event ordering (Phase 8e)`.
