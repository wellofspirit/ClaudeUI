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
