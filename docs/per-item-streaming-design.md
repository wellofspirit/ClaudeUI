# Per-item volatile streaming

**Status:** Accepted by Daniel and implemented, 2026-09-17. Verification recorded below.
Scope: shared protocol and all clients, with Codex root/direct-child adoption first. Roadmap item 2 in
[the Codex handoff](codex-integration-handoff.md). Extends
[ADR-055](adr/adr-055_volatile-stream-lane.md) and
[SyncCore contract 3](architecture/sync-core.md#the-four-wire-contracts-closed-set).
The architecture and ADR-055 now include this extension.

## Meaning and motivation

An item is an individually identified piece of a transcript: an assistant answer,
a reasoning summary, or a plan. A message can eventually contain multiple growing
blocks, so the protocol must address the block as well as the message.

Volatile means individual typing updates are not put in SyncCore's event ring or
replayed as historical events. Core still accumulates their text in memory and
includes it in snapshots. Completion travels through the reliable event lane.
This does not add disk persistence or make unfinished output survive a core crash.

Before this change there were two different paths:

| Path                                 | Identity                                             | Delivery                                                                              |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Existing text/thinking streams       | Session + kind; child streams add parent tool-use id | Small volatile deltas; canonical accumulation and watch replay                        |
| Codex root text, reasoning, and plan | Native thread + turn + item                          | The entire growing message is upserted on every delta through the reliable event lane |

The former Codex path preserved item identity but made each typing update a ring entry.
For chunks `Hello`, ` there`, and `!`, it sends growing bodies `Hello`,
`Hello there`, and `Hello there!`. The implemented path sends each chunk once during
ordinary streaming, then sends the authoritative completed item. Reconnects may
still resend an accumulation. For similarly sized chunks, repeatedly serializing
all prefixes grows quadratically with chunk count; sending deltas grows linearly.
This is a transport/ring improvement, not a claim of measured UI speed or lower
model latency. It also does not eliminate the cost of accumulating/rendering text.

Per-item identity allows interleaved output to update the correct existing row.
Completing one item must never clear another item's preview. The visible goal is
stable cards and consistent desktop/web reconnect behavior, not a new chat layout.

## Baseline facts (before implementation)

- `src/core/shared/sync/stream.ts`: `StreamFrame` carries `streamId`, numeric
  `turnId` (a stream generation, NOT a native turn id), `offset` in JS string units,
  and `chunk`. Its identity addresses only text/thinking at session or child-card
  scope. Offset zero also means replacement/replay. Text can clear thinking.
- `src/core/codex/CodexSession.ts`: the root delta handler accumulates text,
  thinking, and plan bodies in `deltas`, then dispatches a complete `ChatMessage`
  each time. `dispatch` updates local history and emits `session:message`.
  Children instead emit `session:subagent-stream`, losing item identity there;
  the child delta handler currently forwards text/thinking, not plan deltas.
- `src/core/shared/sync/channels.ts`: `session:message` is canonical and ringed.
  `src/core/shared/sync/reducer.ts` clears the session text buffer on that event.
  An ordinary message upsert cannot be treated as an item-completion signal:
  existing engines also upsert items while they are running.
- `src/core/sync/sync-core.ts`: volatile frames are applied to canonical state
  before fan-out, without taking a ring sequence.
- `src/core/services/sync-host.ts` and `src/core/ipc/stream-watch.ts`: subscriptions
  are per connection and per session. Rewatch pushes canonical accumulations.
  The current replay API returns individual frames, not an atomic item-set reset.
- `src/core/shared/sync/sync-client.ts`: pre-ready stream frames are dropped;
  the subsequent watch heals them. `src/renderer/src/stores/replica.ts` applies
  the same stream fold as core and debounces mismatch-triggered rewatch by 50 ms.
- `src/core/shared/sync/state.ts` snapshots the four current accumulation fields.
  `ChatPanel`, `TaskCard`, and `TaskDetailPanel/TaskEntry` consume them. The main
  chat currently puts the generic session preview after its message list.
- F13/F19 preserve streamed reasoning when an empty completion maps to no message;
  nonempty final reasoning applies headline normalization. F18 review blocks and
  tool results survive item upserts through `mergeContentBlocks`.

## Accepted scope and migration

Build an engine-neutral item protocol and adopt it for Codex root and direct-child
text, reasoning, and plan streams first. Update every client in the same release.
Keep the existing session stream path for engines that still emit it; each
producer uses exactly one path for a given output. This is staged engine migration,
not dual emission or support for cached old bundles.

Then migrate Claude, opencode, and pi separately after verifying their native
message/block identities and lifecycle boundaries. Do not invent those mappings
from Codex's protocol. Retire the session buffers only after their last consumer
migrates. Cross-engine dispatch consumers and plugin observers must be included
in each producer migration.

Out of scope: grandchild rendering, metering, tool-result images, permission
behavior, changing native engine protocols, and migrating PTY/bash/automation
tails. Those tails have their own semantics under ADR-055.

## Accepted contract

### Identity and canonical state

Use a structured target: session routing id, transcript owner (root or direct-child
parent tool-use id), message id, block key, and field kind (`text`, `thinking`, or
`plan`). Use a collision-safe encoding if a string key is needed; do not extend
slash splitting with opaque native ids. Codex message ids already use
`codexItemId(threadId, turnId, itemId)`.

Keep native turn identity distinct from stream generation. Core assigns each open
stream a generation, and a frame cannot create a stream merely by supplying an id.
Only an explicit reliable open can create it. Duplicate opens are idempotent;
adapter completion/ended-turn guards prevent an old notification reopening it.

Add an active-item map to canonical session state and the snapshot. Each entry
contains target, generation, accumulated value, and stable presentation metadata.
The reliable open establishes a message/card scaffold in transcript order. The
active value overlays only its named field for display; committed content and
attached results/reviews remain intact. Shared pure presentation helpers combine
the scaffold with the replicated active map at render time. Do not store a second,
client-computed transcript or let renderer code mutate canonical fields.

### Lifecycle and lanes

The as-built names and representation are recorded below.

1. **Open, reliable:** announce the target, generation, initial value, and scaffold
   once. Preserve the original timestamp and ordering. If the first native signal
   is a delta, the adapter emits open before that delta. Empty reasoning must not
   produce a visible bare Thought row; defer its open until meaningful content.
2. **Append, volatile:** carry target, generation, offset, and new text only. Apply
   to core before delivery. Require the active target and matching generation and
   offset. A rejected frame must not mutate state. Validate offsets as nonnegative
   safe integers and use JS string lengths consistently, including Unicode.
3. **Seal, reliable:** in ONE reducer application, merge the final message and
   retire exactly the named stream(s). A nonempty authoritative final body replaces
   the preview even when it differs. Run the existing mapper/merge rules, including
   reasoning normalization and preservation of tool reviews/results. An empty
   reasoning completion preserves and commits the accumulated reasoning, as today.
   The event must contain the resolved final content: an unwatched client cannot
   compute it from deltas it never received. Completion without a prior open works.
4. **Cancel/retract, reliable:** remove the affected stream(s) explicitly. A normal
   interrupted/failed turn should retain available partial output and stop its
   activity indication; an explicit transcript retraction/clear removes it.
   Resolve partial content in core/the adapter and carry it in the reliable event.
   Native history remains authoritative on cold reload; do not fabricate a saved
   native item when the engine never persisted it.

Opening, appending, and sealing item A never implicitly clears item B. A generic
session idle transition must not retire children that can outlive the parent turn.
Host death closes affected active streams explicitly. Authoritative turn replay,
repeated completions, and late deltas must be idempotent. Clear/delete/retraction
and session rekey must update item identities, active state, and subscriptions.

### Recovery and backpressure

Keep session-level `stream:watch`: clients should not have to discover item ids to
subscribe. Retain its capability, replace-set semantics, and connection lifetime.

Rewatch needs an explicit **replace-all active-item set for a session**, including
the empty set. Unlike today's fixed pair of buffers, a dynamic set cannot be
reconciled by replaying only streams that still exist. A set replacement removes
stale active entries and atomically restores current entries and their values.
It does not delete completed messages.

Separate append and replay operations; do not infer replay from offset zero.
Replay carries the event watermark at which it was captured. Apply only after
events through that watermark, and reject/re-request a replay made obsolete by
later lifecycle events. Full snapshots carry active entries and generations and
restore them without guessing from string lengths.

Events and stream frames share an ordered transport today. The new client path
must also preserve that order when readiness/catchup delays event application.
Test a completion racing replay explicitly: a late replay or delta must never
resurrect a sealed preview. A missing open requests event synchronization before
rewatch; terminal/old-generation traffic is discarded without a rewatch loop.

Retain the current 1 MB WebSocket backpressure policy for volatile traffic, with
final lifecycle events on the reliable lane. If a replay is dropped, recovery
must remain pending until delivered: use a bounded/coalesced retry on transport
drain (cancelled on unwatch/disconnect), not a dependency on another model token.
An idle but unfinished item may produce no next token to reveal the loss. Desktop
MessagePort remains exempt from the WebSocket buffered-byte threshold.

Retire active entries promptly at seal and avoid an unbounded tombstone ledger.
Stale-frame rejection uses active generation/lifecycle knowledge and the ordered
event seam. Large replay payloads need explicit sizing/backpressure tests; do not
silently truncate authoritative text or bypass the connection budget.

## Implementation sequence and file map

1. Settle scope and lifecycle/recovery rules in discussion. Turn this draft into
   the kickoff specification; record accepted ADR-055 amendments with cross-links.
2. Shared model and lifecycle reducer: `src/core/shared/sync/{stream,state,reducer,
events,channels}.ts`, plus `src/shared/{types,remote-protocol}.ts`. Cover snapshot
   restoration, block-target validation, item order, and seal merge semantics.
3. Core and delivery: `src/core/sync/sync-core.ts`,
   `src/core/services/{sync-host,remote-server}.ts`, and stream-watch registration.
   Add atomic replay and backpressure recovery without changing event-ring rules.
4. All clients: shared `sync-client.ts`, desktop MessagePort/preload wiring,
   `src/web/connection.ts`, and renderer `stores/replica.ts`, sealed-field/type
   definitions, and watch handling. Audit every frame-union consumer.
5. Presentation: `ChatPanel`, `MessageBubble`, plan/thinking blocks, `TaskCard`, and
   `TaskDetailPanel/TaskEntry`. Overlay the correct item in place and preserve
   stable React keys, activity indicators, galleries, and scroll behavior.
6. Codex adapter: `CodexSession.ts` and `event-mapper.ts`, root and child lifecycle,
   local message history, interrupted turn handling, authoritative turn replay,
   and plugin/dispatch observer contracts. Remove per-delta root message emission;
   retain whatever local accumulation is actually needed to resolve final events.
7. Verify and update the handoff/as-built docs. Subsequent engine migrations get
   their own protocol reconnaissance, spec, and regression verification.

## Acceptance evidence

- Interleave two text items, reasoning, and a plan; verify exact destinations,
  stable order, and no clearing of unrelated items. Include two children with the
  same native item id in different threads and multiple blocks in one message.
- Run thousands of deltas: ring growth depends on lifecycle events, not delta
  count, and ordinary wire bodies contain chunks rather than repeated prefixes.
- Compare canonical state, desktop replica, and web replica after live streaming,
  full snapshot, catchup, watch switching, and injected offset/generation gaps.
- Cover empty active-set replay, lost replay under backpressure without another
  token, stale replay after seal, Unicode offsets, malformed targets, pre-ready
  frames, and no endless recovery loop after deletion.
- Cover completion without deltas, final content differing from preview, empty
  final reasoning after nonempty deltas, F19 normalization, and preservation of
  reviews/tool results. Verify an unwatched client gets the complete final body.
- Cover interruption, host death, parent ending while a child continues, rekey,
  retraction, clear/delete, resumed history, and late/duplicate notifications.
- Preserve existing stream-lane reconnect, snapshot-invariant, and subagent tests.
  Verify Claude/opencode/pi behavior while they still use the session protocol.
- Run typecheck, lint, unit/component/e2e and CI gates, protocol check, build,
  formatting and diff checks. Run gated isolated-provider integration where the
  platform supports it; no real credentials needed.
- Verify the built desktop and web UI with deterministic fixtures: interleaved
  items, mid-stream reconnect, plan growth, child output, and interruption.
  Record DOM assertions and screenshots and review them before marking landed.

## Approval

Approved first slice: shared protocol + all clients + Codex root/direct-child
adoption, with the other engines migrated separately. Daniel approved this scope and the lifecycle/recovery design on 2026-09-17.

Approved interruption behavior: retain visible partial output, end its activity
indicator, and allow native history to determine what survives a cold reload.
Approved recovery behavior: explicit atomic set replay and reliable lifecycle
events, rather than extending the current offset-zero convention.

## As built, 2026-09-17

- `src/core/shared/sync/item-stream.ts` owns the wire types, validators, lifecycle
  fold, volatile fold and pure render projection. The session routing id stays
  outside the target; the target contains `messageId`, stable `blockIndex`,
  `kind` and optional `ownerToolUseId`. Its key is a JSON tuple, so opaque ids
  cannot collide through separators. Block slots are established by the scaffold
  and must not move while active; opening another field preserves existing slots,
  including attached results/reviews. Presentation metadata lives on the scaffold.
- `session:item-open` establishes the scaffold and active entry reliably. Its
  event sequence becomes the stream generation. `session:item-delta` becomes an
  `item-stream` append carrying the target, generation, UTF-16 offset, chunk and
  current reliable-event watermark. It changes canonical state without advancing
  the event ring. `session:item-seal` carries resolved final content, merges it
  through the shared message-commit helper, including duration stamping and
  root-derived todos/sent files. A targeted seal retires only its named field;
  a targetless seal explicitly retires every active field of that message/owner.
  A targeted seal commits only its addressed block; the surrounding scaffold
  cannot overwrite another field that completed earlier. A targetless seal
  commits the full authoritative message.
  The targeted payload is a resolved message with its target at the declared
  `blockIndex`, using the same scaffold addressing as open. A single-block
  payload is not implicitly relocated to a different slot; invalid addressed
  content is rejected without committing or retiring anything. Surviving fields
  keep their block positions. A targeted seal may repair a
  missing preview when its scaffold still exists; removal of the scaffold by
  clear/retraction prevents that late seal from resurrecting the message.
- `itemStreams` and `itemStreamRevision` are snapshot fields and sealed replica
  fields. A watch sends an explicit `replace` frame for the entire session's
  active set, including empty. Clients wait for the reliable watermark and require
  the known open generation; stale frames cannot resurrect a retired item.
  Offset mismatch schedules a coalesced rewatch. Active sessions cannot be evicted
  from the replica's cold-history cache.
- Desktop MessagePort and browser WebSocket feed the same SyncClient and reducer.
  Root chat, task cards and task detail panels overlay only the addressed block.
  Root thinking uses its own start time while active. Legacy session buffers stay
  in place for Claude, opencode and pi.
- Codex root and direct children use this path for text, reasoning and plans.
  Completion uses the existing mapper, including F19 reasoning normalization;
  an empty reasoning completion retains the accumulated partial. Interruption,
  disconnect and child termination seal available partials. Parent completion
  leaves a still-running child's streams alone. Local adapter history remains
  current for queries and dispatch; cold history still comes from native Codex.
- Plugin observers retain their prior message/child-delta shapes. Growing root
  messages are reconstructed in process only when a plugin listens, never ringed.
  Plugins can also observe item deltas directly.

### Backpressure detail

The existing WebSocket **1 MB buffered-amount high-water mark** still gates every
volatile send, including replay. It is not a maximum frame size: one frame can
cross that watermark, as in the existing transport. Large replay values are sent
intact once the connection drains; they are not truncated or split. Dropped item
traffic records only the watched session id in a pending set. One coalesced
timer per connection retries a fresh canonical replacement, even without another
token. Delays are 100, 200, 400, 800, 1,600 and then at most 2,000 ms
during sustained congestion; clearing the pending set resets the next delay to
100 ms. The public watch limit bounds that set to 32 sessions. Unwatch/disconnect
cancels pending work. Polling the public buffered amount avoids reliance on private
WebSocket drain APIs. Reliable lifecycle events retain their existing delivery.

### Verification record

- Full CI suite: 694 files, 12,999 tests passed, eight skipped, before two added
  edge-case tests. The final default suite passed 692 files / 12,912 tests
  (eight skipped), including those additions. The focused protocol/adapter suite
  passed 216 tests, covering a child outliving its parent and an intact 2 MB replay.
  Typecheck, lint, pinned protocol check, production build, repository-wide
  Prettier check and `git diff --check` passed.
- Shared tests cover thousands of interleaved deltas without ring growth,
  owner/block isolation, snapshots, lost chunks, stale generations, unwatched
  completion, empty replay, rekey, clear/retraction, preserved results/reviews,
  safe offsets and recovery from backpressure without a later token.
- Real WebSocket e2e covers more than 5,500 deltas, catchup without ring overflow,
  rewatch recovery and final content delivered to an unwatched connection.
  Component tests drive actual task-card/detail-panel components through the
  production replica and verify two owners with identical message ids.
- The built Electron app was driven against the pinned native Codex binary and
  a paced localhost fixture, in fresh isolated homes, with no real credentials
  or paid turns. Live DOM assertions passed for growing text, rewatch recovery,
  exact final content, normalized reasoning, plan growth and Stop retaining a
  partial answer. Both drives reported zero renderer errors. Screenshots reviewed:
  `.cache/screenshots/item-default-live.png`, `item-default-final.png`,
  `item-plan-live.png`, `item-plan-final.png`, `item-interrupted.png`.
- Windows host-session integration: three passed; the selected lifecycle and
  interrupted-tool suites are platform-gated (five skipped). Browser delivery is
  covered by actual WebSocket tests and the shared renderer tests; no standalone
  browser UI drive was performed.

The remaining engine migrations are explicit unfinished steps of roadmap item 2:
Claude, opencode and pi each require a native identity/lifecycle investigation,
producer migration and plugin/dispatch-consumer audit. After the last consumer
migrates, remove the old session text-stream frame family, accumulation fields and
client plumbing. Independent pass-through tails remain. Metering follows this
closure. This slice does not add
unfinished-output disk persistence, grandchild rendering, or new metering behavior.

### Review corrections and final gates, 2026-09-17

Daniel approved the four departure recommendations in the ADR-055 amendment.
GPT-5.6 Sol implemented the corrections, with main-model code review and a fresh
Sol review of the adapter, commit path and transport. A separate Sol verifier
owns the rebuilt-app drive; the main model reviews its screenshots.

- Child completions racing a parent terminal notification remain authoritative;
  after the child's own final turn replay, late item notifications are ignored.
  Restoring the old `child.notified` guard made the new race regression fail;
  restoring the fix made it pass.
- Missing active previews no longer discard valid finals when their scaffold
  remains. Retractions/clears still prevent targeted resurrection; empty
  retractions leave unrelated active items intact. Reopening starts with the
  preserved scaffold value. Item fold exceptions use SyncCore's existing fence.
- Targeted seals mutate and retire exactly their addressed field, preserving
  completed siblings and auxiliary blocks even if surrounding payload content
  is stale. Targeted thinking duration applies only to that thinking block.
  Full-message seals share ordinary message commit rules and root derivations;
  child commits cannot alter root todos/sent files, and item seals do not clear
  legacy buffers. Codex user acknowledgements retain native replacement ids.
- Retry delays cap at two seconds and reset after recovery. Tests cover the cap,
  cancellation and multiple pending sessions draining in one retry; the last
  successful replay cancels any already-rearmed timer. ChatPanel computes active
  thinking slots above the bubbles; bubbles no longer scan every stream per token.
- S1-S3 comment/import/contract documentation issues were cleaned up. M2 describes
  a focused-child ChatPanel path that does not exist: `useFocusedAgentData` always
  returns the main transcript. M3's empty session replacements remain deliberate
  to keep replay independent of producer/engine guesses. M4 is covered by backoff.
- Main-model rerun: `bun run test:ci` **694 files / 13,013 passed**, eight skipped;
  `bun run test` **692 files / 12,924 passed**, eight skipped. Typecheck, lint,
  repository-wide formatting and pinned-protocol checks passed. Windows isolated
  native integration passed three tests; two selected suites/five tests remain
  platform-gated. No real credentials or paid provider turns were used.
- The production build passed all six stages. A separate GPT-5.6 Sol verifier
  drove that final build against the pinned native Codex binary, an isolated home
  and the paced localhost fixture. Both default and plan drives passed live DOM,
  canonical projection, unwatch/rewatch growth, exact final content, normalized
  reasoning and empty-stream completion assertions, with zero renderer page errors.
  The default drive also verified Stop retains a nonempty partial answer.
- The main model reviewed all five fresh screenshots:
  `.cache/screenshots/f21-reviewed-default-live.png`,
  `f21-reviewed-default-final.png`, `f21-reviewed-default-interrupted.png`,
  `f21-reviewed-plan-live.png` and `f21-reviewed-plan-final.png`.
  No standalone browser UI drive or native Claude live drive was performed;
  WebSocket and shared-renderer behavior are covered by the automated suite.
