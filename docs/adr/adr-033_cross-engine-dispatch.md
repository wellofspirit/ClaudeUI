# ADR-033: Cross-engine agent dispatch — hosted `dispatch_agent` tool, headless subtask-style targets

**Status:** Accepted (M4 claude-target usage-capture cost semantics amended by ADR-034; M1's
synchronous opencode turn transport superseded by the 2026-09-01 amendment below; that amendment's
per-direction liveness split superseded by the 2026-09-18 amendment below)
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
  clock): an INACTIVITY cap (no sign of life from that session — default 15 min) plus an ABSOLUTE
  cap (default 60 min), both configurable per engine as `DispatchConfig.idleTimeoutMs` /
  `turnTimeoutMs` (ms; `0` disables; edited in MINUTES in Settings › opencode › Cross-engine
  dispatch). A slow-but-alive local model can now finish; a wedged one still dies. `DISPATCH_TIMEOUT_MS`
  stays as the claude/pi directions' cap, and the timeout editors are opencode-only in the UI —
  **superseded by the 2026-09-18 amendment below**, which deletes every built-in cap, makes both
  fields mean "no limit" when unset, and applies the same watchdog to all four directions. The
  sentence is kept as the record of what shipped between 2026-09-01 and 2026-09-18.
  **A turn parked on an unanswered approval counts as alive**: a target blocked on `ctx.ask` emits no
  session events whatsoever (the server's keepalives carry no sessionID), so the watchdog refreshes
  the inactivity clock for as long as a forwarded approval for that target is outstanding —
  otherwise a human slower than the cap had the dispatch aborted and their own approval card
  dismissed. Refreshing (rather than suspending the check) also gives the resumed turn a fresh
  window. The absolute cap keeps running while parked, deliberately: an ask nobody ever answers
  still ends the turn.
- **Reconnect reconcile.** Completion now rides the event stream, so a `session.idle` published
  while the subscription was down would strand the turn. Every (re)connect reconciles this
  connection's busy targets against `GET /session/status`, where **absence means idle** (the fork's
  `SessionStatus.set` deletes the entry when a session goes idle). Best-effort and fully swallowed: a
  failed reconcile must never break the loop that also carries approval forwarding.
  **Ordering is load-bearing**: the reconcile hangs off a new
  `OpencodeClient.subscribeEvents(signal, onConnected)` callback, which fires once the subscription
  is provably receiving — reconciling _before_ subscribing would leave its own per-reconnect window
  (status says busy → turn goes idle → stream only then goes live → that idle is lost by both
  paths). After connection-live the coverage is exhaustive: an idle before it is visible in the
  status map, an idle after it arrives as an event, and the overlap where both see it is absorbed by
  settle-once.
  **Absent ≠ finished**, which is the reconcile's sharpest edge. `prompt_async` returns 204 at FORK
  time; the forked `prompt()` writes the user message (`createUserMessage`) and only then enters
  `runLoop`, whose first act is `status.set(busy)` — so a reconcile landing in that window sees an
  absent session for a turn that is about to run. Settling there would return the PREVIOUS turn's
  assistant message and orphan the real turn. The verdict is therefore three-way: present = alive
  (bump the clock); absent + **completion evidence** = ran and ended (settle); absent + no evidence =
  not started yet (skip, leave it to the live stream and the watchdog). Evidence is the newest
  ASSISTANT message in stored history being at least as new as `turnStartedAt`, compared STRICTLY
  (`CLOCK_SKEW_ALLOWANCE_MS` is 0): both timestamps come from the same host clock (the server is a
  local child process) and this turn's assistant message is always written after `turnStartedAt`, so
  a zero allowance never rejects genuine evidence — while any positive allowance admits the PREVIOUS
  turn's assistant on every continuation whose gap is shorter than it (i.e. most of them, one MCP
  round-trip apart), trading a bounded watchdog delay for a silently wrong result plus an orphaned
  live turn. A remote opencode server would need a clock-free anchor rather than a wider allowance.
  The newest message of ANY role would not do either: the pre-busy window already contains this
  turn's own user message. Accepted residual — a turn
  that goes idle without producing an assistant message leaves no evidence and falls to the
  inactivity watchdog; disambiguating it would cost a second delayed status read for a vanishingly
  rare case. Two further guards on the same path: the busy snapshot captures each entry's RESOLVER
  and only settles if it is still installed (a continuation turn started during the status GET must
  not be settled by a verdict about its predecessor — the pi direction's `entry.settled === resolve`
  pattern), re-checked after the evidence read's own await.
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
  (`extractToolResult` + a `${messageId}:${partId}` dedup Set, since the rebuilt message re-emits on
  every part update) — parity with the Claude and pi taps, which always did. Without it the dispatch
  TaskCard's tool chips spun forever. `message.updated` is now routed into the tap too, because
  `mapEvent` needs it to record the message role on the accumulator.
- **Stale-message gate on the tap.** Aborting a turn does not silence it: the processor waits 250 ms
  for in-flight tool calls and then rewrites each as `status:'error'` / `interrupted`, publishing
  `message.part.updated` for the OLD turn's message — which can land inside a quick continuation
  turn's busy window. The tap therefore snapshots the target's known message ids at turn start
  (`priorMessageIds`) and ignores any output belonging to one, keeping the stale message, its
  already-reported tool results and its tool_use ids off the new turn's card. The dedup Set is
  target-lifetime for the same reason (a per-turn Set would have forgotten those results were
  already reported), matching `OpencodeSession.emittedToolResults`; message ids never repeat, so it
  stays bounded by target life.
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

## Amendment (2026-09-12): Codex as a dispatch source

Codex joined as a SOURCE in `843b4ecf` (ADR-066/067 branch). `dispatch_agent` is declared to Codex as a
native dynamic tool beside the three hosted UI tools (`src/core/codex/codex-hosted-tools.ts`) and called
back as the `item/tool/call` server request; `CodexSession.dispatchAgent` builds the same
`DispatchContext` the pi and Claude sources build, with `toolUseId` set to the mapper's
`dynamicToolCall` id so streams and task events land on the model's own card, `autonomyMode` set to
the user's mode, and `extra.signal` set to the app-server request's abort signal, which `finishTurn`
fires, so an ended turn stops the target as a cli.js interrupt does. The shared permission engine
gates it as kind `task` (ask in default/acceptEdits/auto, deny in plan); an ask is a card bound to the
call's id. `crossEngineDispatchAvailable('codex')` is always true because claude is a bundled target,
the same reasoning as the opencode branch. Codex as a TARGET landed in `749886cc`: a headless `CodexClient` per target, the caller's autonomy mode written into the thread baseline at `thread/start` (plan: untrusted + read-only + writes denied at the gate; default/acceptEdits: untrusted + workspace-write with asks forwarded to the caller; auto: on-request + native reviewer), no dynamic tools (no recursion), model allowlist checked before the thread exists, `turn/interrupt` on stop, continuation only by a thread id this dispatcher created, usage rows carrying the API-rate equivalent cost or null.

## Amendment (2026-09-18): no built-in dispatch time limit

**Ruling (Daniel, 2026-09-18).** A dispatched agent must be able to run indefinitely. The ONLY things
that end a dispatched turn early are the user stopping it, the caller aborting it, a user-configured
time limit, or the user-configured cost cap. An EMPTY or `0` time limit means unlimited. This applies
to every dispatch direction: Claude, opencode, pi and Codex targets.

**What was wrong.** `DISPATCH_TIMEOUT_MS` (10 min) was raced against the turn in the Claude, pi and
Codex directions as a plain `setTimeout` — fixed, not configurable, with `deps.dispatchTimeoutMs`
existing only so tests could shorten it. The opencode direction had the right SHAPE (a polled
watchdog with an absolute and an inactivity cap read from the target engine's `DispatchConfig`) but
the wrong DEFAULTS: 60 min and 15 min when the field was undefined, so "leave it empty" silently
meant "one hour", not "no limit". A legitimately long agent run therefore died on a limit nobody had
asked for, in all four directions.

**One liveness model, four directions.**

- `DISPATCH_TIMEOUT_MS`, `DISPATCH_TURN_TIMEOUT_MS`, `DISPATCH_IDLE_TIMEOUT_MS`,
  `this.dispatchTimeoutMs` and `deps.dispatchTimeoutMs` are DELETED. `resolveTurnLiveness(cfg)` is
  the only source of a cap: `Math.max(0, cfg?.turnTimeoutMs ?? 0)` and the same for
  `idleTimeoutMs`, so undefined, `0` and a hand-edited negative all collapse to the single
  "unlimited" value the watchdog's `> 0` gates read.
- `startTurnWatchdog(entry, caps, turnStartedAt, isApprovalParked)` is the one implementation all
  four directions share (the opencode branch's polled shape, factored out; `DISPATCH_WATCHDOG_INTERVAL_MS`
  stays 10 s on the injectable clock). **With both caps unlimited it arms no interval at all** and
  returns a promise that never resolves — not a very large timer, so there is no far-future deadline
  to reason about and nothing for a fake-timer test to trip over.
- The Claude, pi and Codex directions gained the inactivity clock the opencode one had.
  `entry.lastActivityAt` is bumped from each direction's own event feed, as far upstream as the feed
  goes: `driveClaudeTurn` on every SDK message read off the iterator (`stream_event` deltas
  included); `createPiTarget`'s ambient `onEvent` BEFORE `mapPiEvent` runs, so an event the mapper
  drops as `ignore` still counts as proof of life; `handleCodexTargetNotification` on every
  notification that passes its threadId guard. `hasPendingApprovalFor` lost its `kind: 'opencode'`
  scope — a Claude/pi/Codex target blocked on its gate is exactly as silent as an opencode one
  blocked on `ctx.ask`, so the parked-on-an-approval refresh (and the fresh window an answer starts)
  now applies everywhere. The absolute cap still runs while parked, deliberately, as before.
- Timeout text is built by one helper, `turnTimeoutText(reason, caps, aftermath)`, so every message
  names WHICH cap fired and the minutes the user configured for it: "Dispatch timed out after N
  minutes (absolute limit)" or "... after N minutes with no activity from the target agent", plus the
  direction's own aftermath clause (Claude's process dies with the turn; opencode/pi/Codex targets
  survive for a continuation).
- Everything else on the give-up paths is unchanged: the server-side interrupt, `dismissPendingForTarget`,
  the `failed` usage row for a timeout and none for a stop, the settle-first ordering, pi's bounded
  abort-drain grace, Codex's `turn/interrupt` waits, and each direction's entry-survival rule.

**Config and UI.** `DispatchConfig.turnTimeoutMs` / `idleTimeoutMs` keep their names and units (ms)
and are now documented as applying to every direction with no built-in default. The two editors are
drawn in EVERY engine's "Cross-engine dispatch › Limits" group (`showTurnTimeouts` is gone), with
placeholder `no limit` and descriptions ending "Empty or 0 means no limit."; testids
(`<Engine>DispatchSection.turnTimeout` / `.idleTimeout` and their rows) are unchanged, as are the
minutes↔milliseconds round-trip and the install-gating messages.

**Caller-side survey (2026-09-18) — what could still cut a long dispatch short from the CALLER's
end.** None of these needed a change.

- **opencode as caller.** Confirmed in the vendored source that the MCP tool call path resets its
  timeout on progress: `McpCatalog.convertTool` (`vendor/opencode-src/packages/opencode/src/mcp/catalog.ts:53-67`)
  calls `client.callTool(..., { resetTimeoutOnProgress: true, timeout, onprogress: () => {} })` —
  the `onprogress` hook is what makes the MCP SDK attach a progress token at all, and it is the tool
  factory `session/tools.ts:391` uses for every MCP tool. It passes NO `maxTotalTimeout`, and in the
  SDK that field is the only absolute ceiling (`@modelcontextprotocol/sdk@1.29.0`
  `dist/esm/shared/protocol.js:177-195`, `:434-439`, `:712-714`). So the 20-minute
  `DISPATCH_MCP_TIMEOUT_MS` we write into `mcp.claudeui.timeout`
  (`src/core/opencode/OpencodeServerManager.ts:96-163`) is an IDLE cap, reset by the dispatcher's
  15 s `sendProgress` heartbeat, which does carry a token (`extra._meta.progressToken` →
  `SdkToolExtra.progressToken`, `src/core/opencode/opencode-hosted-tools.ts:269-273`;
  `sendProgress` no-ops only when the token is absent, `src/core/sdk/create-sdk-mcp.ts:94-106`).
  Left at 20 minutes: raising it would change nothing, since no reachable absolute cap exists. Its
  doc comment now says "exceeds the heartbeat interval by orders of magnitude" instead of pointing at
  the deleted `DISPATCH_TIMEOUT_MS`.
- **pi as caller.** No tool-call deadline beyond the bridge's own, which is handled: bridge v6
  (`docs/protocol-pi/README.md` § "Long-poll protocol") turns each exchange into a sequence of
  bounded requests — a 45 s hold, then `200 {"pending": true}`, then unbounded re-polls on
  `/tool-call/wait` — precisely so pi's embedded-Bun 300.6 s `fetch` idle timeout can never close a
  long call. The only other clock is `abandonMs` (30 s), and it runs ONLY while nobody is parked,
  i.e. it fires when the pi child is gone, not when the dispatched agent is slow.
  `vendor/pi-cli/docs/` documents no execution deadline for an extension-registered tool
  (`settings.md`'s `retry.provider.timeoutMs` / `httpIdleTimeoutMs` are provider-request clocks;
  `rpc.md`'s `timeout` belongs to UI dialogs).
- **Codex as caller.** No deadline on a dynamic tool call response. `bespoke_event_handling.rs:1129-1137`
  sends `item/tool/call` and spawns `dynamic_tools::on_call_response`, whose first line is a bare
  `receiver.await` on the oneshot (`.cache/codex-src/codex-rs/app-server/src/dynamic_tools.rs:18-24`)
  — no `tokio::time::timeout` anywhere in that file, and every `timeout` in `outgoing_message.rs` is
  inside its `#[cfg(test)] mod tests` (from line 843). A pending server request is resolved early
  only on a TURN TRANSITION (`TURN_TRANSITION_PENDING_REQUEST_ERROR_REASON`,
  `outgoing_message.rs:204`), which is the interrupt/turn-end path the dispatcher already rides via
  `extra.signal`.
- **Claude as caller.** Nothing to change — the resolved "Still-open questions" item above:
  cli.js's MCP callTool timeout is OFF by default, exists only under `MCP_TOOL_TIMEOUT` or a
  per-server `timeout`, and is idle-reset by the `onprogress` cli.js always passes. `grep -rn
MCP_TOOL_TIMEOUT src/` finds nothing: ClaudeUI never sets it on a spawn, so only a user's own
  environment could introduce one, exactly as that item records.

**Tests.** The three directions that had no watchdog gained, per direction, (a) a no-config turn that
keeps producing events and runs past 10 AND 60 minutes on fake timers before completing normally,
(b) an absolute cap firing with its configured minutes in the text even while the target streams,
(c) an inactivity cap that fires only after real silence and is reset both by an event and by a
pending forwarded approval, and (d) both caps `0` arming no 10 s interval (asserted by spying on
`setInterval` — the progress heartbeat is an interval too, so a bare timer count cannot tell them
apart). Every test that used to inject `deps.dispatchTimeoutMs` now configures the cap through the
mocked `loadEngineConfig(...).dispatch` and runs on fake timers. **Fake-timer gotcha, learned the
hard way:** `vi.useFakeTimers()` must be installed BEFORE the dispatcher is constructed —
`this.now` defaults to a captured reference to `Date.now`, so a later install leaves the watchdog
reading real wall time and no cap ever fires. The gated real-binary suites
(`src/integration/{pi,codex}/*-dispatch-target.integration.test.ts`) now set `turnTimeoutMs`
explicitly, so a wedged binary fails them instead of hanging them.

**Concurrency (same-day ruling).** The app-wide slot count is a setting too: "the slot can be a
configuration as well, so we can have more slots. not saying I want to hide the effect, but in
certain cases we will need more dispatches" (Daniel, 2026-09-18). `const MAX_CONCURRENT = 3` and
`deps.maxConcurrent` are replaced by `deps.resolveMaxConcurrent?: () => number`, called AT THE GATE
on every `dispatch()` rather than once in the constructor — so raising the cap in Settings binds the
very next dispatch, with no restart, the same re-read-per-call contract the per-target cost and
timeout gates already have. The value is the new app-level setting
`AppSettings.dispatchMaxConcurrent` (ClaudeUI's own `settings.json`, NOT any
`engines/<engine>.json` — the gate counts every in-flight dispatch in the process, whatever engine
it went to). `resolveDispatchMaxConcurrent` (`src/shared/dispatch-concurrency.ts`) is the single
resolution rule, imported by both the dispatcher and the Settings row so the field and the gate
cannot drift: **unset → 3** (the old constant stays the default, so the effect is opt-in and nobody's
behaviour moves until they raise it), **`0` → `Infinity`, i.e. no limit**, `n` → `n` floored to a
whole agent and never below 1; a negative or non-finite value reads as unset, never as `0`. The
refusal text now names the EFFECTIVE cap and where to change it — a model told "max 3" by an app
configured to 1 would just retry into the same wall — and says that `0` means no limit. The UI is a
new FIRST group "Concurrency" on the Cross-engine dispatch page (`DispatchConcurrencySection`, row
testids `.maxConcurrentRow` / `.maxConcurrent`), app-level: no storage tag, no engine segment and no
applies-later badge, since a cap over all engines belongs to none of them and a change binds
immediately. Empty renders the placeholder `3` and Reset CLEARS the key rather than writing 3, so the
default stays a default.
