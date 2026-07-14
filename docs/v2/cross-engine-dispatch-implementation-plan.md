# Cross-engine dispatch — full implementation plan (M2–M4)

**Status:** M1 + M2 shipped (M2 verified live 2026-07-14: opencode/nemotron caller → approval-gated
`claudeui_dispatch_agent` → headless Claude haiku target answered; plugin-injected caller identity
observed on the wire); **M3/M4 not started.** This is a standalone plan — a fresh session with
no prior context should be able to execute every remaining phase from here. Governing design:
**ADR-033** (`docs/adr/adr-033_cross-engine-dispatch.md`). Workflow: **ADR-026** (Opus orchestrates
+ reviews every line, a Sonnet sub-agent implements against a written kickoff, gates + real-app
verify before each commit). Wire facts for opencode live in **`vendor/opencode-src/`** (pinned
v1.17.14 clone, git-ignored) and the memory `opencode-src-vendor-clone`.

---

## 0. Feature recap & current state

**Feature.** A session on one engine delegates a task to a headless agent on the *other* engine via
a hosted `dispatch_agent` MCP tool, rendered subtask-style in the dispatching chat. It lets a Claude
session get, say, a GPT-5/Gemini opinion through opencode, and vice-versa — free two-way
collaboration across harness-bound models.

**Design decisions already locked (ADR-033 + M1 build):**
- One symmetric tool `dispatch_agent({ engine, prompt, model?, session_id? })`; returns final text +
  a `session_id` for multi-turn continuation.
- Targets are **headless, dispatcher-owned** mini-sessions on engine client primitives — NOT
  `SessionManager`/`ISession`.
- **Subtask parity:** target inherits the dispatching session's autonomy mode; the target's
  approval requests forward into the dispatching chat (`xeng:`-prefixed requestIds).
- Recursion is structurally impossible: dispatcher-created targets never receive the dispatch tool.
- Main-agent-only by policy; per-engine config in `engines/<id>.json` `dispatch` block.

**M1 (Claude → opencode): DONE, verified live** (Haiku → `opencode/nemotron-3-ultra-free`, real
answer returned through the approval-gated tool). Commits on `pre-release`: ADR-033 doc; SDK `extra`
threading; dispatcher core + tool; opencode dispatch settings; turn-error fix; this plan.

### Reusable substrate shipped in M1 (every M2–M4 phase builds on these)

| Area | Symbol / file | Notes |
|---|---|---|
| Dispatcher | `src/main/services/cross-engine-dispatcher.ts` — `CrossEngineDispatcher` + `crossEngineDispatcher` | opencode targets only today; `dispatchInner` rejects `engine !== 'opencode'`. Guards → `activeDispatches++` → `resolveAndRun` (model resolution, target create/reuse, timeout/abort/heartbeat race, result extraction, `info.error` surfacing). |
| Approval forwarding | dispatcher SSE loop + `resolveApproval` | Unfiltered per-cwd `subscribeEvents` loop maps opencode `permission.asked` → `xeng:`-prefixed `PendingApproval` via `ctx.emit`; `resolveApproval` consumes `xeng:` ids → opencode `replyPermission`. Deny cascade reconciled via `permission.replied` → `session:approval-dismiss`. |
| Claude tool host | `src/main/services/collab-tool.ts` — `createCollabServer(ctx)` | `claude-ui-collab` MCP server, NOT auto-allowed (goes through `canUseTool`). `engine` arg enum = `['opencode']` today. Registered in `claude-session.ts` `run()` only when `opencodeServerManager.isBinaryAvailable()`. |
| Context | `DispatchContext { fromEngine, fromRoutingId, cwd, autonomyMode, emit, extra? }`; `DispatchResult { text, sessionId, isError? }` | |
| Config | `EngineConfig.dispatch: DispatchConfig { allowedModels?, defaultModel? }` (`src/shared/types.ts`) | Read per-dispatch via `loadEngineConfig(req.engine).dispatch` — so the Claude direction reads `engines/claude.json` with no dispatcher change. |
| IPC | `session:approval-response` in `session.ipc.ts` + `remote-handlers.ts` | Routes `XENG_REQUEST_PREFIX` ids to `crossEngineDispatcher.resolveApproval` before the session. |
| Dismiss channel | `session:approval-dismiss` | Wired end-to-end: preload, `web/api-adapter.ts`, `useClaudeEvents.ts` → `removePendingApproval`. |
| SDK extra | `src/main/sdk/create-sdk-mcp.ts` — handler `(input, extra?)`, `sendProgress(extra, …)` | `SdkToolExtra { signal, progressToken?, sendNotification }`. Both engines' hosted tools get it. |
| Settings | `OpencodeDispatchSection` in `settings-sections.tsx` | Default model + allowlist; the Claude twin is deferred to M2-C. |

### Engine-neutral subagent/task UI pipeline (M3 rides this — already exists for native subagents)

- **Store** (`src/renderer/src/stores/session-store.ts:397-403`): `taskProgressMap[toolUseId]`,
  `taskNotifications[]`, `subagentMessages[toolUseId]`, `subagentStreamingText[toolUseId]`,
  `subagentStreamingThinking[toolUseId]`. Mutators incl. `addSubagentMessage`,
  `appendSubagentStreamingText/Thinking`, `setTaskProgress`, `addTaskNotification` (verify exact
  names at ~1700-1740).
- **Events** (`useClaudeEvents.ts:299-318`): `onTaskProgress`, `onTaskNotification`,
  `onSubagentStream`, `onSubagentMessage`, `onSubagentMessageBatch`, `onSubagentToolResult` — all
  `(routingId, data)` keyed by `toolUseId`.
- **Payloads** (`src/shared/types.ts:521-543`): `TaskProgress { toolUseId, toolName,
  parentToolUseId, elapsedTimeSeconds }`; `TaskNotification { taskId, toolUseId, status, outputFile,
  summary, usage? { totalTokens, toolUses, durationMs } }`; `SubagentStreamDelta { toolUseId, type:
  'text'|'thinking', text }`; `SubagentMessageData`.
- **Card** (`src/renderer/src/components/chat/TaskCard.tsx`): reads all of the above by `toolUseId`;
  already renders running/progress/subagent output and has a `subagentType` badge slot (lines
  ~307-316, ~403-408). TaskCard renders tool views of `kind: 'task'`.

### Capability model (M4 rides this)

- `EngineCapabilities` (`src/shared/model-capabilities.ts:388`): flat booleans (`voice`, `hostedMcp`,
  `backgroundTasks`, `plan`, …) + `autonomyModes`. `CLAUDE_ENGINE_CAPABILITIES` (~450) all-true;
  `OPENCODE_ENGINE_CAPABILITIES` (~578) partial. `ResolvedCapabilities extends EngineCapabilities`
  (~435) merges model caps; `SessionStatus.capabilities` carries it; renderer gates features on it.

### Usage attribution (M4 must reckon with this)

- ADR-011 analytics (`src/main/services/block-usage.ts`) attributes usage by **scanning JSONL
  transcripts** + merging rate-limit headers into 5h windows keyed by `resets_at`/account.
- **Load-bearing consequence:** a headless dispatched turn does **not** flow through a normal
  persisted session, so this scan will not see it (see M4 analysis). Attribution must be explicit.

---

## M2 — reverse direction (opencode → Claude) — SHIPPED

**As-built deltas from the plan below** (the plan text is kept for context; these corrections are
what actually landed):

- **Zod stripping hazard (plan missed it):** our MCP host validates tool input with `z.object()`,
  which strips unknown keys — the plugin-injected `__xeng_caller_session` is therefore a declared
  optional field of the opencode-side tool schema (described "internal — never set this yourself"),
  read + stripped by the handler.
- **Continuation = persistent process, not `--resume`:** `persistSession: false` means no
  transcript, so `resume` is impossible. Claude targets keep one `sdkQuery()` process alive across
  turns via a pushable input channel, driven by a **manual `iterator.next()` loop** —
  `QueryHandle[Symbol.asyncIterator]().return()` kills the child (sdk/query.ts), so `for await`
  + `break` would kill the target at the end of every turn.
- **Busy guard:** concurrent same-`session_id` dispatches are rejected (`isError` "already running
  a turn") — two drivers on one iterator would steal each other's messages.
- **collab-tool enum NOT widened** (plan's M2-D said add `'claude'`): each side's enum lists only
  the other engine; same-engine is guard-rejected anyway.
- **Plugin file requirements (verified live):** file-source V1 plugins must default-export
  `{ id, server }` (`id` mandatory), absolute path in the injected `plugin` array; ships at
  `resources/opencode/claudeui-xeng-plugin.ts` (asarUnpack'd; `locatePluginFile()`).
- **MCP timeout:** `mcp.claudeui.timeout` = 20 min in `OPENCODE_CONFIG_CONTENT` (schema default is
  5 s) so long Claude-target turns survive even without progress-token resets.
- **Cycle breaks:** hosted tool gets `sessionManager`/dispatcher via setters on
  `OpencodeServerManager` wired in `main/index.ts`; `buildRuleset` extracted to
  `src/main/opencode/permission-ruleset.ts` (re-exported from OpencodeSession for back-compat).
- Gating ask-rule appended after the user's compiled rules in `applyPermissionMode`, so a blanket
  user allow-rule can't silently un-gate dispatch.

**Goal.** An opencode session calls `claudeui_dispatch_agent` (engine `"claude"`) → dispatcher
spawns a **headless Claude target**, runs a turn, returns final text (+ `session_id`). Subtask
parity: the Claude target inherits the calling opencode session's autonomy mode, and its
tool-approval requests forward into that opencode session's chat.

### Analysis — the two hard parts

1. **Caller identity on the shared per-cwd MCP host.** The `claudeui` server is shared by all
   opencode sessions in a cwd, and MCP calls carry no session id; opencode's `permission.asked` for
   MCP tools has **empty metadata** (`vendor/opencode-src/.../session/tools.ts:408`) — no natural
   join key. **RESOLVED mechanism: a ClaudeUI opencode plugin** stamps the caller `sessionID` into
   the tool args in-band. opencode fires `plugin.trigger("tool.execute.before", {tool, sessionID,
   callID}, {args})` immediately before an MCP tool's `execute`, passing the **same `args` by
   reference** (`tools.ts:402-409`); a plugin mutating `args` has the change reach
   `client.callTool({arguments: args})` → our handler. Deterministic, race-free. (Rejected: FIFO
   temporal correlation — racy across concurrent same-cwd sessions; fixed-mode/no-forwarding —
   breaks parity.)
2. **The Claude target is streaming, not synchronous.** Unlike opencode's clean synchronous
   `client.prompt()`, a Claude turn runs via `sdkQuery()` and must be driven message-by-message.
   This is the bulk of M2.

### M2-A — Claude headless target in the dispatcher

Add an `engine === 'claude'` path to `resolveAndRun`.
- **Spawn** via raw `sdkQuery({ prompt, options })` (precedent: `src/main/services/service-session.ts`
  — no `SessionManager`, no `BrowserWindow`). Options: `cwd`, `canUseTool` (M2-B), `abortController`,
  `getSdkExecutableOpts()`, `permissionMode` mapped from inherited autonomy, model env. Drive
  `for await (const msg of q)`; resolve on `msg.type === 'result'` (final text in `msg.result` —
  `src/main/sdk/types.ts` `ResultMessage`).
- **Model** — Claude uses **alias strings** (`haiku`/`sonnet`/…), not opencode's `providerID/modelID`.
  Allowlist/default via `loadEngineConfig('claude').dispatch` (same code path). **Apply model/
  endpoint/proxy env** — the normal path runs `spawnPrepRegistry.require('claude').prep(model,
  engineCfg)` (`src/main/ipc/create-session.ts`); factor a reusable helper rather than duplicating.
  Recall the model-discovery bootstrap gate (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is
  force-set) — gated aliases like Fable need the bootstrap fetch.
- **Continuation** — `session_id` = Claude session UUID from `system/init`. Either keep the process
  alive across turns (persistent `MessageChannel` prompt, like `ClaudeSession`) or re-spawn with
  `--resume-session-id`. Pick the simpler that works; document it.
- **Guards** — reuse `activeDispatches` cap, timeout, `extra.signal` abort race, `sendProgress`
  heartbeats. Abort → `abortController.abort()`.
- **Recursion guard** — do NOT register `claude-ui-collab` for the target (dispatcher controls its
  `sdkQuery` options, so simply omit it).

### M2-B — caller-identity plugin + Claude-target approval forwarding

1. **Ship the opencode plugin.** Small module hooking `tool.execute.before`; for
   `tool === 'claudeui_dispatch_agent'` set `args.__xeng_caller_session = input.sessionID`. **Verify
   from source first** (`vendor/opencode-src/.../plugin/` + `src/shared/opencode-config-schema.
   1.17.14.json`): exact hook/exported-shape, the `plugin` config key, and whether a **local file
   path** loads (vs npm package). Wire via `OPENCODE_CONFIG_CONTENT`
   (`OpencodeServerManager.buildOpencodeConfigContent`). **#1 de-risk of M2** — probe the binary if
   source is ambiguous; documented fallback is FIFO temporal correlation (ADR-033).
2. **Handler reads identity.** In the opencode hosted `dispatch_agent` handler (M2-D), read+strip
   `args.__xeng_caller_session`; look up the live `OpencodeSession` via `SessionManager` (routingId
   == session id post-rekey) for its permission mode (`autonomyMode`) and `send` (`emit`). Missing
   session/id → `isError` explaining the plugin is required (fail loud, never silently misroute).
3. **Gate the dispatch tool.** MCP tools run under opencode's `{*: allow}` baseline (compiler skips
   `mcp__`), so the tool would run un-prompted. Append `{ permission: 'claudeui_dispatch_agent',
   pattern: '*', action: 'ask' }` to the calling session's ruleset (`buildRuleset` is exported).
   opencode then raises a **normal** `permission.asked` that OpencodeSession's existing path shows in
   that session's own chat — the dispatch approval needs no forwarding (the opencode session is the
   visible dispatching session).
4. **Forward the Claude target's approvals.** Target `canUseTool` → `PendingApproval` with `xeng:`
   id → `ctx.emit('session:approval-request', …)` on the OpencodeSession's `send` (shows in its
   chat) → resolution returns through the existing `xeng:` IPC routing →
   `crossEngineDispatcher.resolveApproval`. **M1's `resolveApproval` only maps to opencode
   `replyPermission`** — extend it to dispatch by **target kind**: a Claude-target approval resolves
   the target's `canUseTool` promise (`{behavior, updatedInput?, message?}`). Track pending
   approvals with their kind. Reuse `session:approval-dismiss` on timeout/abort/dispose.

### M2-C — Claude-side dispatch settings twin

Mirror `OpencodeDispatchSection` for engine `'claude'`: default model + allowlist, models from
`getEngineModels()` filtered `engineId === 'claude'`, saved to `engines/claude.json` `dispatch`
block via `saveEngineConfig('claude', …)`. Register under **Engines › Claude**
(`ENGINE_CLAUDE_SECTION_IDS` + `claude-engine` subgroup). testids per ADR-027
(`ClaudeDispatchSection`, `.defaultModel`, `.allowedModel` + `data-id`). Update
`settings-scopes.unit.test.tsx`. Component test: merged save must not clobber `sandbox`/`proxy`.

### M2-D — widen the tool + register on opencode

- `collab-tool.ts`: widen `engine` enum to `['opencode', 'claude']`, update description. (This
  server runs inside Claude sessions; a Claude→`'claude'` request is same-engine, already rejected
  by the guard.)
- `src/main/opencode/opencode-hosted-tools.ts` `createOpencodeHostedToolsServer(cwd)`: register
  `dispatch_agent` (opencode exposes it as `claudeui_dispatch_agent`), `engine` enum = `['claude']`.
  Thread the dispatcher singleton (import) + caller-identity handling (M2-B.2). The factory closes
  over `cwd` only today.

### M2 verification
Component tests mirroring M1's fake-client/fake-SSE patterns: Claude-target happy path (fake
`sdkQuery` yielding assistant + result), timeout/abort, allowlist, mode inheritance, approval
forwarding resolving `canUseTool` both ways, unknown-caller `isError`; plugin unit test (injects id
for the dispatch tool, leaves others untouched). Gates: typecheck/test/test:ci/lint/build.
**Real-app E2E** (verifier-electron): drive an existing **opencode** session (reach via sidebar —
Playwright can't drive the OS folder picker; filter operational DB `engine_id='opencode'`), call
`dispatch_agent` (engine `claude`, `haiku`), approve in the opencode chat, confirm the Claude
target's answer returns. Reuse the M1 Playwright `_electron` + transcript-JSONL-read pattern.

---

## M3 — dispatched-work UX (live streaming + engine badge), both directions

### Analysis
Today the dispatcher returns the target's whole turn as a single `tool_result` string; the user sees
a plain MCP tool card with the final text (M1 screenshot). No live view of the target's work, no
indication it ran on another engine/model, no elapsed/token progress, no way to watch or stop the
sub-turn. The **engine-neutral subagent pipeline already exists** (§0) and TaskCard already renders
it for native subagents — M3 routes dispatched work through the same pipeline.

**Three gaps to close:**
1. **Card kind.** `dispatch_agent` renders as a generic `ToolCard`, not a `TaskCard` (which is
   `kind: 'task'`). To get subagent streaming + progress, map the dispatch tool's `ToolKind` to
   `'task'` (or a new `'dispatch'` kind that reuses TaskCard) in the tool-kind registry.
2. **Keying.** Subagent/task events key by the **dispatching tool_use id**. The dispatcher doesn't
   currently have it — `SdkToolExtra` carries `signal`/`progressToken`/`sendNotification`, not the
   tool_use id. **Thread it in:** on the Claude side, `canUseTool` receives `toolUseId` for the same
   call that then executes; capture and pass it to the dispatcher (or verify whether the MCP request
   `_meta` carries it). On the opencode side, the tool part has a call id available via the plugin
   hook (`callID` in `tool.execute.before`) — inject it alongside the session id.
3. **Streaming source.**
   - **Claude target** already produces assistant/thinking deltas in its `sdkQuery` loop (M2-A) —
     forward them as `SubagentStreamDelta`/`SubagentMessageData` keyed by the dispatching tool_use
     id, on the dispatching session's routing (`ctx.emit`).
   - **opencode target** — the dispatcher's per-cwd SSE loop (M1) *already sees* the target session's
     `message.part.updated`/`message.part.delta` events. Tap them (filter by the target session id
     already in the registry) and forward as subagent deltas — **no switch away from synchronous
     `prompt()` needed**, the SSE is already subscribed.

### Design & slices
- **M3-A — routing + card.** Thread the dispatching tool_use id into `DispatchContext`. Map
  `dispatch_agent`/`claudeui_dispatch_agent` to a task-style `ToolKind` so it renders via TaskCard.
  Add an **engine + model badge** to TaskCard (reuse the `subagentType` badge slot; extend the tool
  view with `dispatchEngine`/`dispatchModel`). Both engines' tool renderers.
- **M3-B — streaming.** Dispatcher emits, keyed by the dispatching tool_use id on `ctx.emit`:
  `session:subagent-stream` (text/thinking deltas), `session:subagent-message` (assistant messages
  + the target's own tool calls/results), `session:task-progress` (elapsed — piggyback the existing
  heartbeat), and `session:task-notification` on completion (`status`, and `usage` populated in M4).
  Claude target: forward from the `sdkQuery` loop. opencode target: forward from the existing SSE
  loop (`message.part.*` for the registry's target session ids).
- **M3-C — stop control.** TaskCard already renders a Stop affordance for background/running tasks.
  Wire it to abort a running dispatch: a dispatch registry keyed by the dispatching tool_use id + an
  IPC (`session:dispatch-stop` or reuse the existing task-stop path) → `abortSession` (opencode) /
  `abortController.abort()` (Claude). Confirms the M1 known-limit (turn-interrupt vs in-flight
  dispatch) is at least user-driven-stoppable.

### M3 verification
Component tests: dispatcher emits the subagent/progress/notification sequence keyed by the tool_use
id (fake target loops for both engines); TaskCard renders a dispatch card with the engine/model
badge and streamed text (jsdom, assert by testid). Real-app E2E: watch a dispatch stream live in the
card and stop it mid-flight.

---

## M4 — usage attribution, capability honesty, hardening

### Analysis
1. **Usage is currently invisible.** Dispatched turns spend real tokens on the target engine's
   active account/vendor, but headless targets don't flow through a normal persisted session, so the
   JSONL-scanning analytics (block-usage.ts, ADR-011) never count them. Claude targets likely run
   `persistSession: false` (service-session precedent → no transcript); opencode targets are
   throwaway sessions deleted after the turn. **So dispatched cost must be captured explicitly, not
   discovered.**
2. **Attribution question.** Whose cost is a delegated turn? Decision: **attribute to the
   dispatching session** (so a user sees the true total of their conversation, delegated work
   included), tagged `dispatched: true` + `targetEngine`/`targetModel`, so UsageView can also break
   out "delegated" cost. (Alternative — attribute to the target account/vendor only — hides it from
   the conversation view; rejected.)
3. **Capability honesty (ADR-030).** The tool is gated today on `opencodeServerManager
   .isBinaryAvailable()` — a proxy. Replace with a real capability flag set true per engine only when
   its full dispatch path works end-to-end.

### Design & slices
- **M4-A — capability flag.** Add `crossEngineDispatch: boolean` to `EngineCapabilities`
  (`model-capabilities.ts:388`) + both engine cap constants + `ResolvedCapabilities` passthrough.
  Semantics: "this engine can host the dispatch tool AND at least one *other* installed engine can be
  a target." Gate on it: collab-tool registration in `claude-session.ts` (replace the
  `isBinaryAvailable` proxy), opencode hosted-tool registration, and BOTH settings sections
  (`OpencodeDispatchSection`/`ClaudeDispatchSection` render only when the flag is set). Per ADR-030,
  flip the flag true for a direction only after that direction is verified working (Claude→opencode
  now; opencode→Claude after M2). Consider whether one flag or a per-direction computed value is
  cleaner — availability is inherently asymmetric (needs a *target* engine installed).
- **M4-B — usage capture + attribution.** In the dispatcher, capture per-turn usage from each
  target's result: Claude `ResultMessage.total_cost_usd` + `usage`; opencode `AssistantMessage`
  `info.tokens`/`info.cost` (the same `WithParts.info` M1's turn-error fix reads). (a) Populate
  `TaskNotification.usage` so M3's card shows tokens/cost; (b) record a "dispatched usage" entry
  attributed to the dispatching session + `targetEngine`/`targetModel`. Storage: prefer the
  operational DB (ADR-011 Phase-7 usage tables) — if those don't exist yet, add a minimal
  `dispatched_usage` table via the `db.ts` migration framework; surface in UsageView as a "delegated"
  breakdown. Keep it additive to existing analytics (don't double-count).
- **M4-C — hardening.**
  - **cli.js in-process `mcp_message` timeout** (still-open in ADR-033): verify whether cli.js
    bounds an in-process tool call; long Claude-target turns are the risk. If bounded, mitigate via
    the spawn `env` (`QueryOptions.env`) or by ensuring `sendProgress` heartbeats reset it. Probe
    per the "probe cli/wire first" convention.
  - **Orphan reaping** (M1 known-limit): if cli.js does NOT abort an in-flight `mcp_message` when its
    turn is interrupted, a dispatch can outlive the dispatching turn. Tie target lifetime to the
    dispatching session's `isProcessing`/teardown (`disposeFor` exists) and reap orphans on a timer.
  - **Optional per-dispatch cost/step cap** in `DispatchConfig` (e.g. `maxCostUsd`) — enforce in the
    dispatcher; reject/stop when exceeded.

### M4 verification
Component tests: capability flag flips gate the tool + sections (assert not-registered when a target
engine is absent); usage capture from both target result shapes → notification.usage + a dispatched
usage record attributed to the dispatching session. Real-app: UsageView shows delegated cost after a
dispatch; a bounded-cost dispatch stops at the cap. Update ADR-030's capability table + add the flag
to its honesty ledger.

---

## Cross-phase sequencing, risks, ADRs

- **Order:** M2 → M3 → M4. M3 depends on M2 only for the reverse direction's streaming (M3 can land
  Claude→opencode streaming first if desired). M4-A (capability flag) can precede M4-B/C but is most
  honest once M2 makes the reverse direction real.
- **Top risks, verify early per phase:** (M2) opencode local-file plugin loading via
  `OPENCODE_CONFIG_CONTENT`; Claude headless-target env (model/endpoint/proxy outside
  create-session); `canUseTool` on a bare `sdkQuery`. (M3) getting the dispatching tool_use id to the
  dispatcher. (M4) whether headless turns are capturable at all + the cli.js mcp_message timeout.
- **ADRs:** M2 completes ADR-033's opencode→Claude scope (update its status notes). M4-A updates
  **ADR-030** (add `crossEngineDispatch` to the capability ledger) and **ADR-022** if the dispatch
  gating rule formalizes MCP-tool permission mapping. M4-B relates to **ADR-011** (usage
  attribution) and **ADR-020** (DB migration if a usage table is added). Prompt the user to record
  each as its own ADR entry or as amendments, per the project's ADR convention.
- **Standing constraints (ADR-026):** the implementing agent never self-certifies, never
  git/`bun install`; Opus reviews every line, re-runs gates independently, verifies guard tests fail
  pre-fix, and drives the real app (assert `data-testid` before screenshot) before each precise,
  single-item commit. No AI attribution in commits.
