# ADR-053 — Queued messages: itemized identity in core, Claude-Code-parity take-back on every engine

**Status:** Accepted (2026-08-13) — design; implemented in SyncCore phase 3 per `docs/architecture/sync-core.md` §Queue
**Relates to:** ADR-030 (capability honesty — uniform events over per-engine transports), ADR-035 (pi steer), ADR-038 (event-driven lifecycle, applied to the queue), ADR-051 (the event model this rides on)
**Amends:** ADR-024 (its queue/steer parity for opencode is redefined by the emulation below)

## Context

The 2026-08-13 review traced the ghost-message class to four stacked defects: the renderer coalesces N queued messages into one `\n`-joined string; dequeue matches that blob by full text against cli.js's per-item queue (items have no ids), so with 2+ items it always misses; on `removed: 0` the UI clears anyway; and dequeue is never broadcast, so no other client learns either — the invisible items then execute with the next turn. opencode/pi are worse: they commit-on-post (coalesce/steer), so their take-back window is zero while the UI shows a card implying otherwise.

The owner's original interaction design is Claude Code CLI's, deliberately: queued messages are **live feedback on the running turn** (inject at the next sub-turn boundary), and ArrowUp takes back everything not yet consumed — multiple messages at once, without worrying about sequencing.

## Decision

1. **Behavioral spec = Claude Code CLI, on every engine.** Queued messages inject at the agent's next sub-turn boundary; ArrowUp recalls all not-yet-consumed items into the input, joined with `\n`. **Hold-until-idle is rejected** (it breaks the live-steering workflow); a separate "hold for next turn" affordance is deferred (YAGNI).
2. **Storage is itemized in canonical state** — `{itemId, text, attachments, state: queued|consumed|recalled}[]` per session; **never a pre-joined blob**. The `\n` join happens at take-back time in the client — same gesture, same convenience, per-item correctness. `queued`/`consumed`/`recalled` are domain events; all clients converge, and the consume/recall race resolves honestly ("2 of 3 taken back; 1 already consumed").
3. **Per-engine mechanics** (uniform events, per-engine transports):
   - **claude** — push into cli.js's native queue immediately (exact native timing). Core correlates per item by text over the existing `dequeue_message` / `queued_command_consumed` patch surface — **no patch growth**; duplicate-text items are interchangeable, so the ambiguity is harmless.
   - **opencode / pi** — core holds the item and forwards at the **next observed tool/step boundary** in the engine stream, emulating CC semantics. The commitment point moves from keypress to boundary — up to one tool-call of added delivery latency versus today's instant post, **ratified** as the price of a real take-back window.
4. **Event-driven transitions only.** The renderer's running→idle fallback consume (which painted queued text into the transcript regardless of actual consumption) is deleted — ADR-038's rule applied to the queue.

## Consequences

- Dequeue is authoritative and broadcast; "cancelled but still executes" and "queued here, invisible there" become unrepresentable. Queue state survives resyncs (it is replicated state, in the snapshot).
- opencode/pi gain a genuine cancel window for the first time; the cross-engine UX contract is uniform (ADR-030: the flag is true because the full path works — via emulation core owns, not engine claims).
- cli.js patch surface does not grow, and the steer-side patch (`queue-control`) becomes the claude transport detail behind the uniform events.
- Attachments ride queue items end-to-end (the as-built blob dropped them from display).

## Amended 2026-09-25 — the claude transport is keyed by uuid

Decision §3's claude bullet — correlate by text over the `queue-control` patch surface — is
retired for the claude engine ([ADR-077](adr-077_claude-harness-capability-gating-and-patch-set.md)
§3). The patch is deleted, and Anthropic's official binary never had it: there `dequeue_message`
is rejected, so take-back silently failed, and no consumption signal arrived for a message with no
client id, so the card stayed QUEUED past consumption and the steer bubble landed below its own
answer.

Every claude user frame now carries a client `uuid`, and a queued item's is its `itemId`. cli.js's
native `command_lifecycle` frames name the message by it: `started` consumes the item (at the
tool boundary where the running turn folds it in, or when the between-turns drain makes it the
next turn's prompt), `discarded`/`refused` recall it with a warning, and `cancelled` recalls it
only while it is still queued. Take-back is `cancel_async_message {message_uuid: itemId}`. Items
with duplicate texts are now individually addressable, so the "duplicates are interchangeable"
argument no longer carries any weight for claude. The turn-end `result` flush stays as a safety
net. The rest of this ADR is unchanged — itemized storage, CC-parity timing, recall-all on
ArrowUp, event-driven transitions — and text correlation remains the mechanism for opencode and
pi, whose posts carry no id we choose (Codex correlates by `clientUserMessageId`, ADR-066).
Wire detail: `docs/protocol-cc/03-inbound-messages.md` §3.21 and `07-control-outbound.md`
(`cancel_async_message`).
