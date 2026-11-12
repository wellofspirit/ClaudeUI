# The engine model: engines, vendors, accounts, capabilities and the session contract

Governs: `src/core/providers/`, `src/shared/model-capabilities.ts`, `src/shared/types/engine.ts`, `src/core/ipc/approval-response.ts`, `src/core/shared/`, `src/core/opencode/`, `src/core/pi/`, `src/core/services/claude-session.ts`, `src/renderer/src/hooks/`

The engine-neutral session seam (`ISession`, `BaseSession`, `EngineRegistry`) and the rules every engine adapter
(Claude Code, opencode 2.x, pi) must follow: capability flags, the disconnect status, approval lifecycle, the
queue of record and the user-stop window. Each engine's own backend is ADR-097 (opencode.md), ADR-035 (pi.md) and
claude-engine.md; task lifecycle events and agent/run identity are ADR-040 and ADR-073 (agents-and-tasks.md);
model references and catalogs are ADR-059 and ADR-092 (providers-and-models.md); sign-in and accounts are ADR-021,
ADR-068 and ADR-080 (auth-and-accounts.md); the engine-neutral session delete and `projectKey` are ADR-025
(persistence-and-settings.md); the replicated event model is ADR-051 (sync-core.md).

## Engines, vendors, accounts, the session seam and computed capabilities (ADR-018, ADR-030)

### Engine, vendor and account are separate layers

"Claude" was three things fused; they stay apart.

- **Engine** (`EngineId`, `src/shared/types/engine.ts`; today `claude | opencode | pi`): the harness that runs the
  agent loop. It owns the session protocol, tool set, permission system, config plane, persistence, slash commands,
  skills and MCP wiring. The word "provider" is not used for it: opencode uses "provider" for the model vendor.
  (The `src/core/providers/` directory name is a leftover.)
- **Vendor** (`VendorId`, open-ended): the model maker; it owns the model list, model capabilities and token
  accounting. Engine to vendor is 1:1 for Claude and 1:N for opencode and pi.
- **Account**: the credential and metering identity per (engine x vendor), the derived `AccountRef`.
- `ModelRef {engineId, vendorId, modelId}` is the universal selection and persistence key. **`engineId` is
  immutable for a session**; model, account, capabilities and metering are mutable mid-session.
- `ContentBlock` and the `session:*` IPC contract are the engine-neutral model. There is no separate
  runtime-event schema: each adapter maps its wire protocol straight into those shapes (a tool call's
  `toolUseId` is synthesized where the engine has none). A new engine therefore must understand the block
  semantics rather than define its own vocabulary.

### The session seam: `ISession`, `BaseSession`, `EngineRegistry`

- `ISession` is the neutral interface every engine implements; IPC handlers call it uniformly and check
  `capabilities.X`, never `instanceof`. Engine-specific features are capability flags, not extra interface methods.
- `BaseSession` owns the engine-neutral plumbing: the routing-id envelope and broadcast (`send`, including extra
  remote windows), message history, the inactivity timer, `baseStatusFields()` (`engineId` and `capabilities` merged
  into every `SessionStatus`), the queue of record, and the user-stop window. Adapters extend it.
- `engineRegistry` (`register-engines.ts`) is the only place a session is constructed; `SessionManager` asks it for
  one by `EngineId`. Adding an engine is an `EngineDescriptor`, a capability declaration, a tool-to-kind map, an
  auth provider, an `ISession` extending `BaseSession`, and one `register` call. The IPC layer is not edited.
- `SessionStatus` carries `engineId` and the resolved capabilities from its first push, so the renderer can gate UI
  from the moment a session exists.

### Capabilities are computed, and a flag is true only when the whole path works

- Capabilities are `ResolvedCapabilities = resolveCapabilities(engine, model)` (`src/shared/model-capabilities.ts`):
  `EngineCapabilities` (vendor-independent: voice, hostedMcp, backgroundTasks, subagents, fork, queue/steer, skills,
  `autonomyModes`, `auth`, ...) merged with `ModelCapabilities` (per model: reasoning as two independent axes
  `{thinking, effort}`, vision, toolCalling, context window, ...). Tool-dependent features AND both sides
  (`canUseMcp = hostedMcp && toolCalling`). They are recomputed on session start and on every model switch, and the
  renderer must react to a mid-session change. Cost is not a capability; it is a billing fact (metering.md).
- **A flag is `true` for an engine only when the end-to-end path behind it is implemented and reachable for that
  engine**: spawn parameters consumed, a real caller for every client method, and any lookup engine-aware (not
  hard-coded to another engine's storage format). A partial scaffold (an unused client method, an ignored
  parameter) does not earn `true`. The renderer shows or hides features purely from the flag, so a `true` flag that
  can only fail is a bug in the declaration. A new engine's checklist: wire the path, then flip the flag.
- The static constant is not always the whole story. The honest per-session value is the static flag ANDed with a
  runtime fact, applied in each adapter's `capabilities` getter before it reaches `SessionStatus`:
  - `voice` on Claude is `static AND harnessHasPatch('voice-server')`: the voice server is ClaudeUI's own cli.js
    patch, and an unpatched Anthropic binary has none. Every mic gate reads that one value. opencode and pi AND the
    host's on-device voice pack availability (ADR-101).
  - `crossEngineDispatch` is `static AND crossEngineDispatchAvailable(engineId)` (`cross-engine-dispatcher.ts`):
    some other engine that can be a dispatch target must be installed.
- `fork` and `forkFromMessage` are `false` for opencode: its path is unwired (`OpencodeSession` ignores the fork
  spawn parameters, `OpencodeClient.forkSession()` has no production caller, and `resolveForkAnchor` reads only
  Claude's JSONL transcripts). `OpencodeClient.forkSession()` stays as a documented, uncalled scaffold. `forkFromMessage`
  in `session-store.ts` re-checks `status.capabilities.forkFromMessage` before resolving the anchor, so a stale `true`
  can never reach the Claude-only path. Pi's flags are `true` because its `clone`/`fork` RPCs are wired.

## Every engine adapter emits `disconnected` (ADR-045)

`session:status` with `state: 'disconnected'` is part of the engine adapter contract. Every `BaseSession`
implementation emits it on every path where the engine can no longer serve the session without a fresh connect or
spawn:

1. the backing process or server dies, including while idle and before any prompt;
2. the transport is lost (stream end, RPC channel close) other than by a deliberate abort;
3. deliberate teardown: `cancel()`, `dispose()`, the idle timeout (pi's `cancel()` sets the flag like opencode's;
   `doStart()` clears it on respawn);
4. a connect for a turn fails.

It is the renderer's only "activity off" signal: it clears `sdkActive` (the green sidebar dot, which is
`status.state === 'running' || sdkActive`) and is stored as `idle`. The renderer never infers disconnection from
anything else (timers, turn shape, `session:error`), because background subagents and long turns make every such
heuristic wrong (ADR-038). A dot that stays green is a contract violation in the adapter, not a renderer bug. An
adapter may keep reporting `disconnected` from its status getter until its next successful connect (pi and opencode
use a persistent flag, Claude a one-shot broadcast).

Consequences for adapters:

- On a loss path, release a shared server by spawn identity, never by key alone: a key-only release can decrement a
  replacement server another session already acquired (`OpencodeServerManager.releaseIfCurrent`).
- A manager of a shared process fans out unexpected exits to sessions that have no active stream
  (`subscribeExit`); a deliberate kill does not fan out.
- Loss teardown clears the adapter's connection references so the next `run()` reacquires.

Rejected: a separate `session:disconnected` event (the status channel already carries the state) and renderer
heuristics such as clearing `sdkActive` on `session:error`.

## Approval lifecycle is event-driven, never inferred from turn state (ADR-038)

The renderer's pending-approval list is an exact mirror of the owning session's `pendingApprovals` map.

- Cards are added only by `session:approval-request`.
- Cards are removed only by explicit resolution: `session:approval-dismiss {requestId}`; a matching `tool_result`
  (`removePendingApprovalByToolUse`, the call already ran or failed); the user's answer; or `disconnected` (the
  session is gone and its `cancel()` already denied everything, so a blanket clear is faithful).
- Approval lifetime is never derived from `idle`, `result` or `running`. cli.js ends the parent turn while background
  subagents still run, and a subagent's permission request can arrive or stay unanswered after the parent turn is
  over. Wiping cards at idle left an unanswerable approval and a hung subagent. Status and approval state are
  independent axes, so a session can show `idle` with approvals outstanding.

**The emission duty.** Every adapter emits `session:approval-dismiss` at every point it resolves a pending approval
without a renderer click (abort, `cancel()`, `interrupt()`, expiry). For `ClaudeSession`: the per-request abort
listener (`control_cancel_request`), the deny-all loops in `cancel()` and `interrupt()`, and an echo after normal
resolution. A resolution path that skips the emit leaks a permanently stale card; check this first when adding any
resolution path. Dismiss is keyed by uuid `requestId` and idempotent in the renderer, so a double emit is harmless,
and a disposed session sharing a `routingId` with its replacement cannot clobber the replacement's approvals. A new
engine implements both halves (request on park, dismiss on every internal resolution); renderer cleanup tied to
status transitions other than `disconnected` is prohibited.

**A human answer retires the card on every client.** Pending approvals are replicated canonical state. Both
`session:approval-response` handlers (desktop and remote) call one function, `answerApproval`
(`src/core/ipc/approval-response.ts`), which routes the answer (a reserved `xeng:` id goes to the cross-engine
dispatcher, ADR-033, anything else to the session) and then emits `session:approval-dismiss {requestId}` on the
routing id the client named, whatever the engine or card kind. It also emits when the resolve throws (a stale or
unknown id is a card nobody can answer). The one exception is `ApprovalAnswerRejected`: the engine refused a
malformed answer and is still waiting, so the card stays. The engines' own echoes stay; removal is idempotent.

## Queued messages have identity in core; take-back works the same on every engine (ADR-053)

**§1.** The behaviour is Claude Code CLI's, on every engine: a message typed while a turn runs is live feedback,
injected at the agent's next sub-turn boundary, and ArrowUp takes back everything not yet consumed into the input,
joined with `\n` at take-back time in the client. Hold-until-idle is rejected (it breaks live steering); a separate
"hold for next turn" affordance is deferred. Agent and session-tool deliveries into a pi session are not queue items
(pi's own steer queue gives them boundary timing and there is nothing to take back, ADR-089).

Storage is itemized and replicated: `QueuedItem {itemId, text, attachments, state: queued | consumed | recalled}`
per session in `SessionQueue` (`src/core/providers/session-queue.ts`, composed into `BaseSession`), never a
pre-joined blob. Attachments ride the item as blob refs; the engine-bound bytes stay core-side
(`queuedUploads`). Every terminal transition is broadcast once; the consume-versus-recall race resolves honestly
(some items taken back, one already consumed). Transitions are event-driven only: the renderer has no
running-to-idle fallback that paints queued text into the transcript (ADR-038 applied to the queue).

**§engine.** Per-engine transports behind the uniform events:

- **Claude**: every user frame carries a client `uuid`, and a queued item's is its `itemId`. cli.js's native
  `command_lifecycle` frames name the message by it: `started` consumes the item, `discarded` and `refused` recall
  it with a warning, `cancelled` recalls it only while still queued. Take-back is
  `cancel_async_message {message_uuid: itemId}` (`src/core/sdk/query.ts`); the turn-end `result` flush is a safety
  net. Duplicate texts are individually addressable. Wire detail: `docs/protocol-cc/03-inbound-messages.md` and
  `07-control-outbound.md`.
- **opencode**: the item is posted to opencode's inbox at once with `delivery: 'steer'` (`QUEUE_ITEM_DELIVERY`, the
  next step boundary, which is §1's timing) and stays cancellable until delivered; take-back is the inbox `DELETE`.
  The host-held forward of opencode 1.x is gone (ADR-097 §9, opencode.md).
- **pi**: core holds the item (the `BaseSession.onPromptQueued` default) and forwards it at the next observed tool
  or step boundary and at turn end (`flushQueuedItems`), emulating Claude Code. The commitment point moves from
  keypress to boundary, up to one tool call of added latency: ratified as the price of a real take-back window,
  because pi's steer post is unrecallable.
- **Engine death**: when the engine is lost, every item still queued is recalled (`recallQueuedOnEngineLoss`), since
  nothing is left to serve it. Every adapter's loss path calls it.

## A user stop is not an error (ADR-090)

A turn error that follows a user stop is not shown. One rule, implemented once in `BaseSession`:

- `beginUserStop()` opens a per-session user-stop window. Each adapter calls it as the FIRST step of `interrupt()`,
  before the abort request is sent (the engine's error can arrive before the request's reply), and only when a turn
  is live (a window opened at idle would swallow the next turn's genuine error). A user stop is reached only through
  the `session:interrupt` IPC, so the window is user-initiated by construction.
- `suppressedAfterUserStop(tag, message)` is true while the window is open. Every turn-error emission asks it; when
  true the adapter sends no turn-error `session:error` and the helper logs the engine's text at info. Turn-end
  bookkeeping (processing state, status, inactivity timer, queue boundary) runs unchanged.
- `endUserStop()` closes it: when the stopped turn ends, when a fresh turn starts, and when the session goes away.
  A steer while the stopped turn drains does not close it.
- Per engine: pi opens on `isProcessing` and suppresses the `error` output (`message_end` with
  `stopReason: 'error'`, "The operation was aborted."; pi has no structural marker and upstream's `lazy.ts` is the
  cause); opencode (2.x) opens in `interrupt()` when `isProcessing`, then calls `client.interrupt(..., {resume: true})`, and suppresses the mapper's `error` output; a user stop normally ends as a `stopped` output (reason user) with no banner at all, so the window only covers an error that still follows.
  Claude keeps its own `wasInterrupted` (non-`success` results), which predates the helper and works.

The window is the rule, not the error's shape: an opencode `error` output or a pi "aborted" error OUTSIDE a user stop
is unexplained and still shows (another client or an engine-side cancel). Rejected: matching the error's text or
structure alone (it would hide an abort the user did not cause).

**Never suppressed:** `auth-required` (an expired credential is still news after a stop), a failed prompt ack, the
transport-loss and disconnect banners (ADR-045), the stale-judge banners, and pi's `send_message_error` and
`delivery_error`.

**Children.** No child path raises `session:error` on the parent. While `PiChildRunner` is `draining` (the host
aborted the turn: a per-agent Stop, `task_stop`, the interrupt cascade, a dispatch stop or timeout), an `error`
output still settles the turn but is not streamed as a row; `draining` is cleared by the next `sendTurn`, so a
resumed run is unaffected. opencode: a child's outcome is the subagent call's own terminal notification, not a banner (ADR-111 §3, opencode.md).

## Retired

- ADR-016 — Provider abstraction: ISession / BaseSession / ProviderRegistry — superseded by ADR-018; the seam lives on as `EngineRegistry`.
- ADR-017 — Codex backend via app-server protocol — removed with the Codex engine (2026-10-29).
- ADR-066 — Codex as a fourth engine — removed with the Codex engine (2026-10-29).
- ADR-069 — One Codex app-server host per home and account — removed with the Codex engine (2026-10-29).
