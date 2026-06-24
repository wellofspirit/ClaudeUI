# Phase 8d — opencode Subagents

> Final Phase-8 sub-phase, the biggest adapter. Makes opencode's `task`-tool child sessions render in
> the existing engine-neutral subagent UI (TaskCard / SubagentMessages / TaskDetailPanel). **Claude
> untouched.** Branch `v2-phase-8d-opencode-subagents` (off 8c). opencode source `D:\WorkPlace\opencode-src` (v1.17.9).

## Verified facts (build on these)

**opencode wire:**
- The `task` tool creates a CHILD SESSION (`sessions.create({ parentID: ctx.sessionID, … })`). The child's transcript streams on the **same `/event` SSE** with the CHILD's `sessionID` in `properties`.
- Correlation: the parent's `task` tool part carries `state.metadata.sessionId` = the child sessionID (present on the running + completed states). The tool part's `callID` = the toolUseId of the parent tool_use block.
- No dedicated "subagent started" event — the `task` tool part flipping to `running` with `state.metadata.sessionId` IS the signal. (The child also emits `session.created`/`session.updated` with `parentID`, but those don't carry the parent `callID`, so the task part is the authoritative registration source.)
- Synchronous (background off, per Phase-8 scope): the parent's task tool blocks until the child completes; the parent turn's single `session.idle` fires after everything. The child fires its OWN `session.idle` when it finishes.
- Task result: the parent task tool part completes with `state.output` = `<task id="…" state="completed|error"><task_result>…</task_result></task>` (already flows as the normal parent tool result).

**ClaudeUI contract to emit (exact — keyed by the parent task part's `callID` = `toolUseId`):**
- `session:subagent-message` → `{ toolUseId: string, message: ChatMessage }` (renderer `addSubagentMessage`; upserts by `message.id`, clears the streaming buffers — so emit stream deltas first, then the committing message).
- `session:subagent-stream` → `{ toolUseId, type: 'text' | 'thinking', text }` (renderer `appendSubagentStreamingText/Thinking`).
- `session:subagent-tool-result` → `{ toolUseId, toolResultToolUseId, result, isError }` (renderer `appendSubagentToolResult`).
- `session:task-notification` → `TaskNotification { taskId, toolUseId: string|null, status: 'completed'|'failed'|'stopped', outputFile, summary, usage?: { totalTokens, toolUses, durationMs } }` (renderer `addTaskNotification`; TaskCard resolves completion via `taskNotifications.find(n => n.toolUseId === toolUseId)`).
- All fire with `(routingId, payload)` — routingId is the PARENT session's id (the normal `this.send` target). No preload/renderer/store changes needed.
- `OpencodeEngineToolMap` already maps `'task' → 'task'` kind → TaskCard; the tool_use block's `toolUseId = callID` (event-mapper `buildChatMessage`). `canUseSubagents = subagents && toolCalling` is **not checked by any render component** — flip `subagents` for correctness; no renderer change needed.
- `subagent-message-batch` is NOT needed live (historical-replay only). Skip it.

## Scope decisions (locked)

### 1. event-mapper restructure — own / child / ignore
Add a `childSessions: Map<childSessionId, parentToolUseId>` param (caller-owned + mutated, like `accumulators`). Restructure the top of `mapEvent`:
```
const eventSessionId = props.sessionID as string | undefined
if (eventSessionId === ownSessionId) { return handleOwnEvent(...) }            // existing switch, + child registration
if (eventSessionId && childSessions.has(eventSessionId)) { return handleChildEvent(...) }  // NEW
return { kind: 'ignore' }                                                       // unknown foreign session
```
**Critical:** the child branch must be reached BEFORE the generic `case 'session.idle' → {kind:'result'}`. A child's `session.idle` must emit a task-notification, NOT end the parent turn. (Today the filter only lets the own session through, so `session.idle → result` is safe; once children pass the filter, route them in the child branch, never the own switch.)

### 2. Child registration (in the own-session handler)
In the own `message.part.updated` handling, when `part.type === 'tool' && part.tool === 'task'` and `part.state?.metadata?.sessionId`, do `childSessions.set(metadata.sessionId, part.callID)` (callID = the parent toolUseId). The parent tool_use block is still built normally (`toolName:'task'`, `toolUseId:callID`) → TaskCard. (Race note: if a child event arrives before the task part registers — ordering not pinned in opencode source — those early child events are dropped; acceptable for MVP, note as a possible follow-up to buffer/early-register from `session.updated.parentID`.)

### 3. Child event handling (new `handleChildEvent`)
`toolUseId = childSessions.get(eventSessionId)!`. Reuse the existing accumulation helpers (`ensureAccumulator`/`buildChatMessage`/`extractToolResult`) — child messages share the `accumulators` map (distinct messageIds, no collision):
- `message.part.delta` (field text/reasoning) → `{ kind: 'subagent-stream', toolUseId, streamType, delta }`.
- `message.part.updated` → accumulate the part; **skip child user-role messages** (acc.role==='user' → ignore, mirroring the own path — the task prompt isn't part of the subagent transcript); else build the child ChatMessage → `{ kind: 'subagent-message', toolUseId, message }`. (The dispatch then extracts newly-completed child tool parts → subagent-tool-result, mirroring the own path.)
- `message.updated` → record role (so part.updated can gate on it) + accumulate tokens (best-effort for the notification usage); return `{kind:'ignore'}` (no per-message cost emit for children).
- `session.idle` → `{ kind: 'task-notification', toolUseId, taskId: eventSessionId, status: 'completed', usage? }`; then the dispatch deletes the child mapping (tidy). (We can't easily distinguish completed/failed from idle alone — default `'completed'`; a child `session.error` could map to `'failed'` if cheap.)
- default → ignore.

### 4. New `MapperOutput` kinds + dispatch
Add to `MapperOutput`: `{kind:'subagent-message', toolUseId, message}`, `{kind:'subagent-stream', toolUseId, streamType:'text'|'thinking', delta}`, `{kind:'subagent-tool-result', toolUseId, toolResultToolUseId, result, isError}`, `{kind:'task-notification', notification: TaskNotification}`. In `OpencodeSession.dispatchMapperOutput`:
- `subagent-message` → `send('session:subagent-message', {toolUseId, message})`; then iterate the child accumulator for newly-completed tool parts (mirror the own 'message' case's `extractToolResult` + `emittedToolResults` dedup) → `send('session:subagent-tool-result', {toolUseId, toolResultToolUseId, result, isError})`.
- `subagent-stream` → `send('session:subagent-stream', {toolUseId, type: streamType, text: delta})`.
- `task-notification` → `send('session:task-notification', notification)`; delete the child mapping from `childSessions`.

### 5. OpencodeSession state + capability
- Add `private childSessions = new Map<string, string>()`; pass it into `mapEvent` (alongside `accumulators`). Clear it in `cancel()`/`dispose()` (with the other per-session state).
- Flip `OPENCODE_ENGINE_CAPABILITIES.subagents = true`; update the comment. (canUseSubagents becomes true via `subagents && toolCalling`.)

**Out of scope:** background/detached subagents (experimental flag — skipped per Phase-8 scope); buffering child events that arrive pre-registration (note as follow-up); rich notification usage metrics (best-effort/omit); subagent-issued questions/permissions surfacing in the parent UI (child permission.asked is filtered — a child needing approval would block; note as a follow-up — opencode subagents typically inherit auto-allow for reads).

## File / seam map
- `src/main/opencode/event-mapper.ts` — `childSessions` param; own/child/ignore restructure; child registration on task parts; `handleChildEvent`; new `MapperOutput` kinds.
- `src/main/opencode/OpencodeSession.ts` — `childSessions` field; pass to `mapEvent`; dispatch the 4 new kinds (+ child tool-result extraction); clear in cancel/dispose; cap already resolved via shared.
- `src/shared/model-capabilities.ts` — flip `subagents`; update comment.
- Tests under `src/main/opencode/__tests__/` (event-mapper + OpencodeSession + capability).

## Tests (mocked, no binary)
- event-mapper: an own-session task `message.part.updated` with `state.metadata.sessionId` registers `childSessions[childId]=callID` and still returns the parent `{kind:'message'}` (parent tool_use block has `toolUseId=callID`).
- A child `message.part.updated` (assistant) → `{kind:'subagent-message', toolUseId: callID, message}`. A child `message.part.delta` → `{kind:'subagent-stream', toolUseId, streamType, delta}`. A child **user** message → ignore. A child `session.idle` → `{kind:'task-notification', toolUseId, status:'completed'}` (NOT `result`). An UNKNOWN foreign session → ignore.
- **Guard:** the parent's `session.idle` still → `{kind:'result'}` (a child idle must not end the parent turn).
- OpencodeSession dispatch: `subagent-message` → `session:subagent-message` + child tool-result extraction → `session:subagent-tool-result`; `subagent-stream` → `session:subagent-stream`; `task-notification` → `session:task-notification` + child mapping deleted.
- capability: opencode `subagents`/`canUseSubagents` true.
- Keep all existing opencode tests green (esp. the cross-session filter test — update it: a KNOWN child is no longer ignored, an unknown foreign session still is).

## Verify
```
bun run typecheck && bun run test:ci && bun run lint && bun run build
```
Then a **cross-phase app-shot** (see below) — this is the most visible renderer behavior of the 4 phases.

## Gotchas
- **Child `session.idle` ≠ parent result.** Route children in the child branch before the generic `session.idle` case. Getting this wrong ends the parent turn early (the worst bug here).
- **Stream-then-commit ordering** — `addSubagentMessage` clears the streaming buffers, so emit `subagent-stream` deltas before the committing `subagent-message` (same as the own path).
- **toolUseId = the parent task part's `callID`**, NOT the child sessionID. The child sessionID is only the correlation handle in `childSessions`.
- **Don't break Claude** — all changes are in the opencode mapper/session + the cap flip. The renderer/store/preload subagent contract is unchanged and shared.
- **opencode optional / no regressions** — the own-session path (plain turns, no task) must behave exactly as before; `childSessions` empty → the restructure is a no-op for non-subagent turns.
- No `bun install`/`add`. Main-process-only.

## Commit
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): subagent (task) child-session rendering (Phase 8d)`.
