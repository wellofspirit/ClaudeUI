# ADR-033: Cross-engine agent dispatch — hosted `dispatch_agent` tool, headless subtask-style targets

**Status:** Accepted (M4 claude-target usage-capture cost semantics amended by ADR-034; M1's
synchronous opencode turn transport superseded by the 2026-09-01 amendment below)
**Date:** 2026-07-14
**Relates to:** ADR-018/019 (engine model), ADR-020 (config plane), ADR-022/023 (opencode permissions), ADR-026 (workflow), ADR-030 (capability honesty), ADR-032 (non-fatal denials)

## Context

ClaudeUI now runs two engines (Claude, opencode) fronting different model vendors. We want a session
on either engine to delegate a task to an agent on the _other_ engine — e.g. a Claude session asks a
GPT-5-backed opencode agent to review a diff — with the same UX as a native subtask: a task card in
the dispatching chat, approvals surfacing in the dispatching session, no separate session to manage.

Both engines already consume ClaudeUI-hosted MCP tools: Claude via in-process SDK MCP servers
(`mcpServers` option in `claude-session.ts`), opencode via the `claudeui` HTTP-MCP host injected
through `OPENCODE_CONFIG_CONTENT` (ADR-019). The subagent/TaskCard rendering pipeline
(`session:subagent-*`, `session:task-*`) is engine-neutral.

De-risked against opencode v1.17.14 source (pinned clone in git-ignored `vendor/opencode-src/`):

- **Abort propagates end-to-end**: session abort → Effect interrupt → turn `AbortController` →
  AI SDK `abortSignal` → `client.callTool({signal})`. In-flight MCP calls are cancelled.
- **opencode natively permission-gates MCP tools**: every MCP tool execution runs
  `ctx.ask({permission: '<server>_<tool>'})` against the merged ruleset (last-match-wins wildcards,
  default `ask`). Our `{*: allow}` baseline is why hosted tools run silently — gating the dispatch
  tool is one appended rule in the ruleset we already `PATCH`.
- **Deny is survivable**: opencode's default kills the turn on a bare reject, but ClaudeUI already
  ships `experimental.continue_loop_on_deny: true` and always rejects with a message
  (→ `CorrectedError`, inherently non-fatal) — ADR-032. Caveat: one reject cascades bare
  auto-rejects to all other pending asks in that session; the forwarding layer must reconcile on
  `permission.replied` events.
- **Timeout**: opencode's `callTool` timeout (per-server config ?? 60s SDK default) resets on
  progress notifications (`resetTimeoutOnProgress: true`).

## Decision

1. **One symmetric tool, `dispatch_agent({ engine, prompt, model?, session_id? })`**, hosted by
   ClaudeUI and injected into both engines. Returns the target's final text plus a `session_id`;
   passing `session_id` back continues the same target (multi-turn collaboration without new
   transport). Registration:
   - Claude: a **separate** in-process server (`claude-ui-collab`) so it does **not** ride the
     auto-allowed `mcp__claude-ui__` prefix — it goes through `canUseTool` like an ordinary tool.
   - opencode: registered on the existing `claudeui` hosted server (appears as
     `claudeui_dispatch_agent`), gated by an appended `ask` rule in the session ruleset.
2. **A single main-process `CrossEngineDispatcher` service** owns all dispatch logic: target
   creation, guards (concurrency cap, per-dispatch timeout, model allowlist), approval forwarding,
   result await, cancellation. Both engines' tool registrations delegate to it.
3. **Targets are headless dispatcher-owned mini-sessions built on engine client primitives, not
   `SessionManager`/`ISession`**: opencode targets use `OpencodeClient` directly (create session →
   patch ruleset → synchronous `POST /session/{id}/message` — the `askSideQuestion`/judge
   precedent; **superseded by the 2026-09-01 amendment**, which drives the turn with `prompt_async`
   plus SSE completion); Claude targets use `sdkQuery()` directly (the `service-session.ts`
   precedent) with a `canUseTool` callback. No sidebar entry, no renderer session, no
   rekey/lifecycle coupling.
4. **Recursion is structurally impossible**: dispatcher-created targets never get the collab server
   registered (and opencode targets additionally get a deny rule for `claudeui_dispatch_agent*`).
   No depth counters. The tool is main-agent-only by policy; Claude-native subagents share the
   parent's MCP channel, so enforcement there is best-effort v1 (documented limitation).
5. **Subtask-identical UX**: the target inherits the dispatcher's autonomy mode (mapped through the
   ADR-022 `buildRuleset` for opencode; permission mode for Claude — auto-mode judge is _not_
   spun up for targets in v1, `full` maps to allow-all). Target approval requests are re-emitted as
   `session:approval-request` under the **dispatching** session's routing with a reserved requestId
   prefix (`xeng:`); the approve IPC handler routes that prefix to the dispatcher instead of the
   session. Output streams into the dispatching chat through the existing
   `session:subagent-*`/`session:task-*` events keyed by the dispatching `toolUseId` (TaskCard
   renders it; engine badge added).
6. **Config (plane ③, ADR-020)**: `engines/<engineId>.json` gains
   `dispatch?: { allowedModels?: string[]; defaultModel?: string }` governing dispatches **into**
   that engine, edited in a per-engine SettingsDialog section (Engines › Claude / Engines ›
   opencode).
7. **Long-call survival**: `create-sdk-mcp.ts` threads the MCP SDK `extra` parameter
   (cancellation `signal`, `sendNotification`) through to tool handlers — backward-compatible; the
   dispatch tool sends progress heartbeats (resets opencode's timeout, feeds TaskCard progress) and
   observes `extra.signal` to interrupt the target. The injected `mcp.claudeui` block also sets an
   explicit generous `timeout`.

## Consequences

- New `src/main/services/cross-engine-dispatcher.ts` (+ tool registrations in `claude-session.ts`
  and `opencode-hosted-tools.ts`); `SessionManager` stays untouched.
- `create-sdk-mcp.ts` handler signature gains an optional second `extra` argument; existing tools
  (mermaid/mockup/auto-classifier) unaffected.
- Approval IPC gains prefix routing; renderer approval UI unchanged in v1 (approvals appear as
  ordinary tool approvals on the dispatching session).
- Dispatched turns consume tokens on the target engine's active account — SHIPPED (M4-B): every
  completed/failed dispatched turn is captured explicitly (per-turn cost/tokens/duration from the
  target's own result) into the operational DB's `dispatched_usage` table (migration v6),
  attributed to the DISPATCHING session, surfaced in UsageView's "Delegated" section and in
  `TaskNotification.usage`. Headless turns are structurally invisible to ADR-011's JSONL scan
  (Claude targets have no transcript; opencode targets bypass OpencodeSession's metering), so
  this explicit capture is additive with no double-counting. A per-target cumulative
  `dispatch.maxCostUsd` cap (M4-C) rejects continuation turns once exceeded.
- Per ADR-030, the `crossEngineDispatch` capability flag is SHIPPED (M4-A): statically true for
  both engines (both directions live-verified), ANDed at session level with the runtime
  target-engine-installed check (`crossEngineDispatchAvailable`) — the collab-server registration
  and both settings sections gate on it.

## M2–M4 — decisions + as-built record

(The full standalone implementation plan, `docs/v2/cross-engine-dispatch-implementation-plan.md`,
was removed with the V2 docs post-ship — recoverable from git history. The as-built deltas that
matter for maintenance are folded in below.)

- **Caller-session identity on the shared opencode MCP host** — RESOLVED & SHIPPED (M2): a
  ClaudeUI-provided opencode **plugin** (`resources/opencode/claudeui-xeng-plugin.ts`, injected as
  an absolute path via `OPENCODE_CONFIG_CONTENT`'s `plugin` array) stamps the caller `sessionID`
  into the dispatch tool's args via `tool.execute.before` (deterministic; opencode passes `args`
  by reference before `execute`, so the mutation reaches our MCP handler —
  `vendor/opencode-src/.../session/tools.ts:398-409`). Chosen over FIFO temporal correlation off
  `permission.asked` (racy across concurrent same-cwd sessions) and over fixed-mode/no-forwarding
  (breaks subtask parity). Local-file plugin loading was probed live against the vendored binary
  before implementation and the full path verified in the real app (caller id visible in the tool
  args on the wire). Two implementation constraints discovered: the injected arg must be a
  **declared optional field** of the tool's zod schema (unknown keys are stripped), and file-source
  V1 plugins must default-export an `id`.
- **M2 shipped (opencode → Claude).** Headless Claude targets are one persistent `sdkQuery()`
  process per target (pushable streaming-input channel; `persistSession: false` rules out
  `--resume` continuation), driven by a manual `iterator.next()` loop — the handle's
  `asyncIterator.return()` kills the child, so `for await`+`break` is forbidden. Concurrent
  same-`session_id` dispatches are busy-rejected (one iterator per target). Target approvals
  forward as `xeng:` `PendingApproval`s resolved back into the target's `canUseTool` promise.
  `full`/`auto` callers map to `bypassPermissions` on the target (no judge for targets in v1,
  per §5); `plan` maps to `default`.

- **M3 shipped (subtask-parity UX).** Dispatched work renders via TaskCard ('task' kind; engine ·
  model badge in the subagent slot), streams live keyed by the dispatching tool_use id (Claude
  side: cli.js's `_meta["claudecode/toolUseId"]`, present on every MCP tools/call; opencode side:
  plugin-stamped `__xeng_call_id`), and is stoppable. Stop rides `session:stop-task` with an
  `isDispatch` flag; a registry miss arms a 60s **pending stop-intent** consumed at dispatch
  registration — closes the live-verified race where the renderer's Stop is clickable before the
  MCP call reaches the dispatcher (SSE beats the tools/call round-trip).

### As-built deltas (what differed from the plan)

- **Zod stripping hazard (M2):** our MCP host validates tool input with `z.object()`, which strips
  unknown keys — the plugin-injected `__xeng_caller_session` (and M3's `__xeng_call_id`) are
  therefore **declared optional fields** of the opencode-side tool schema (described "internal —
  never set this yourself"), read + stripped by the handler.
- **Collab-tool enum NOT widened (M2):** each side's `engine` enum lists only the _other_ engine;
  same-engine dispatch is guard-rejected anyway.
- **MCP timeout (M2):** `mcp.claudeui.timeout` = 20 min in `OPENCODE_CONFIG_CONTENT` (opencode's
  schema default is 5 s) so long Claude-target turns survive even without progress-token resets.
- **Cycle breaks (M2):** the hosted tool gets `sessionManager`/dispatcher via setters on
  `OpencodeServerManager` wired in `main/index.ts`; `buildRuleset` extracted to
  `src/core/opencode/permission-ruleset.ts`. The gating ask-rule is appended **after** the user's
  compiled rules in `applyPermissionMode`, so a blanket user allow-rule can't silently un-gate
  dispatch.
- **Card kind (M3):** no new ToolKind — `hostedMcpKind` maps `mcp__claude-ui-collab__dispatch_agent`
  → `'task'` (before the generic `mcp__` fallback); both engine tool-maps discriminate the dispatch
  input by its `engine` field, putting "engine · model" in the existing `subagent` badge slot.
  Dispatch cards suppress the meaningless "Send to background" affordance.
- **Streaming (M3):** Claude targets run `includePartialMessages`; the dispatcher forwards
  stream_event deltas / assistant messages via `transformAssistantMessage` (factored to
  `src/main/services/assistant-message.ts`, shared with ClaudeSession) / tool_results. opencode
  targets are tapped from the existing per-cwd SSE loop reusing `event-mapper.ts`'s `mapEvent`,
  gated on the entry's `busy` flag. All emits byte-match claude-session.ts's payload shapes and
  no-op when the tool_use id is unknown.
- **Stopped dispatch surfaces to the CALLER as an isError tool result** ("Dispatch stopped by
  user.") — on opencode that's a model-visible corrected error (ADR-032), not an error-state part,
  so the card ends neutral, not danger-bordered. Expected.
- **Usage capture (M4):** per-turn — Claude targets from `result.usage` + `total_cost_usd` +
  `duration_ms` (per-turn, not cumulative — but see ADR-034's amendment); opencode targets from
  `info.tokens {input,output,reasoning}` + `info.cost`. `toolUses` = per-turn Set of **unique**
  tool_use ids (partial/re-emitted messages re-carry the same blocks — a counter overcounts).
  Recording is failure-isolated (`safeRecordUsage`) — a DB error drops the row with a warn, never
  fails the dispatch.

## Amendment (2026-09-01) — the opencode direction moves to `prompt_async` + SSE completion

**M1's synchronous `POST /session/{id}/message` per turn (Decision §3) is superseded for the
opencode direction.** Claude and pi dispatch are unchanged.

**Root cause.** The endpoint sends no response headers until the whole turn finishes. In Electron
main, global `fetch` is Node's undici, whose default `headersTimeout`/`bodyTimeout` are 300 s
(`node_modules/undici/lib/dispatcher/client.js`, same default in Node's bundled copy) — so EVERY
dispatched turn longer than five minutes died client-side with a bare `TypeError: fetch failed`,
regardless of `OpencodeClient`'s own 15-minute cap or the dispatcher's 10-minute one. Live evidence:
three dispatched qwen3.8:27b turns failed at 5m02–03s each. Worse, the error path never called
`abortSession`, so the SERVER-side turn kept running — and editing files — unsupervised.

**As built.**

- **Turn start** is `POST /session/{id}/prompt_async` → 204 No Content, turn forked server-side
  (`startImmediately: true`). **Turn end** is the shared per-cwd SSE loop: `session.idle` settles it
  (the same completion signal the interactive `OpencodeSession` has always used), `session.error`
  fails it. Neither is routed through `mapEvent` — the dispatcher's tap passes a DUMMY cost ref and
  start time, so it settles `OpencodeTargetEntry.settled` directly and mirrors event-mapper's
  message derivation by hand.
- **Result + usage** come from `GET /session/{id}/message`'s LAST assistant `StoredMessage` — its
  `{info, parts}` is exactly what the synchronous prompt used to resolve with, so the turn-error /
  cost-cap / usage-record handling is unchanged. A turn that idles with no assistant message gets
  the pre-existing empty-text fallback.
- **Liveness** replaces the fixed absolute cap with a polled watchdog (10 s, on the injectable
  clock): an INACTIVITY cap (no SSE event at all for that session — default 15 min) plus an ABSOLUTE
  cap (default 60 min), both configurable per engine as `DispatchConfig.idleTimeoutMs` /
  `turnTimeoutMs` (ms; `0` disables; edited in MINUTES in Settings › opencode › Cross-engine
  dispatch). A slow-but-alive local model can now finish; a wedged one still dies. `DISPATCH_TIMEOUT_MS`
  stays as the claude/pi directions' cap, and the timeout editors are opencode-only in the UI.
- **Reconnect reconcile.** Completion now rides the event stream, so a `session.idle` published
  while the subscription was down would strand the turn. Every (re)connect reconciles this
  connection's busy targets against `GET /session/status`, where **absence means idle** (the fork's
  `SessionStatus.set` deletes the entry when a session goes idle) — an absent session settles as a
  normal completion; a present one just bumps the activity clock. Best-effort and fully swallowed: a
  failed reconcile must never break the loop that also carries approval forwarding.
  **Ordering is load-bearing**: the reconcile hangs off a new
  `OpencodeClient.subscribeEvents(signal, onConnected)` callback, which fires once the subscription
  is provably receiving — reconciling _before_ subscribing would leave its own per-reconnect window
  (status says busy → turn goes idle → stream only then goes live → that idle is lost by both
  paths). After connection-live the coverage is exhaustive: an idle before it is visible in the
  status map, an idle after it arrives as an event, and the overlap where both see it is absorbed by
  settle-once.
- **Zombie guard.** A rejected `promptAsync` now also fires a best-effort `abortSession` (the fork
  starts the turn before responding, and a dropped socket on an accepted request is
  indistinguishable out here), and every give-up path nulls `settled` so the `session.idle` opencode
  publishes after our own abort is a no-op.
- **`disposeFor` settles in-flight turns.** With the synchronous prompt, disposing a dispatching
  session while a turn ran let the pending POST reject and end the dispatch. `prompt_async` has no
  such promise, and the disposed entry is out of `this.targets` before its `session.idle` could
  arrive — so `disposeFor` now settles the turn itself, rather than leaving it to hang on its
  concurrency slot until the watchdog fires.
- **Tool results.** The opencode stream tap now forwards `session:subagent-tool-result`
  (`extractToolResult` + a per-turn `${messageId}:${partId}` dedup Set, since the rebuilt message
  re-emits on every part update) — parity with the Claude and pi taps, which always did. Without it
  the dispatch TaskCard's tool chips spun forever. `message.updated` is now routed into the tap too,
  because `mapEvent` needs it to record the message role on the accumulator.
- **`OpencodeClient.prompt()` is deliberately retained** for judge / `askSideQuestion` /
  agent-generate / `runCommand`. Those are short single-shot turns, so the same undici 300 s ceiling
  is latent there rather than live; it is documented on the client so the next long-turn caller does
  not rediscover it the hard way.

## Still-open questions

- ~~Whether cli.js imposes a timeout on in-process (`mcp_message`) tool calls~~ **RESOLVED
  (bundle-verified, M3/M4):** cli.js's MCP callTool timeout is OFF by default — it exists only
  when `MCP_TOOL_TIMEOUT` (env) or the per-server config `timeout` is set, and it is an IDLE
  timeout that resets on progress notifications; cli.js always passes `onprogress`, so the
  dispatcher's 15s heartbeats keep even a configured timeout at bay. Caveat: a user-set
  `MCP_TOOL_TIMEOUT` in the app's environment applies to dispatch like any other MCP tool.
  cli.js also threads an abort signal into every MCP call — a turn interrupt cancels the
  in-flight call (fires our `extra.signal`), so dispatches do not outlive an interrupted
  dispatching turn (no orphan-reaper needed).
