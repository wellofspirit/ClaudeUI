# ADR-078: Every Claude stream frame has one owner, and a call that never ran is taken back

**Status:** Accepted (2026-09-27). Built on `pre-release`: §1 in `f24cc1dd` (ClaudeSession + Patch E), `6911024a` (dispatcher) and `fbbecd2b` (restart, pinned by test); §2 in `7bef7f2b`; §3 in `d22610dc`. Both gaps the first version left open are closed: `5a448a0e` and `98280889`.
**Amends:** [ADR-073](adr-073_agent-roster-and-task-run-identity.md) §1. Its table of which id each run-2 signal carries gains a third case: an agent that resumes **itself**. §5's identity seed is now also what places such a run's partials after a restart.
**Relates to:** [ADR-055](adr-055_volatile-stream-lane.md) (item seals, which the retraction in §3 now precedes), [ADR-033](adr-033_cross-engine-dispatch.md) (the dispatcher's Claude-target lane, which follows §1 and §3 too), [ADR-006](adr-006_rebundle-bun-binary.md) (the patch pipeline Patch E lives in), [ADR-076](adr-076_claude-automode-verdict-on-the-wire.md) (whose verdict badges made the §1 leak visible, and did not cause it), `docs/protocol-cc/05-stream-events.md` §5.9 / §5.11

## Context

Two live sessions on 2026-09-24 showed tool cards spinning "running" forever with `{}` input, after
the calls had plainly finished. Both came from the same gap: the item lane shows a `tool_use` when
its `content_block_start` arrives, and only a completed per-block `assistant` snapshot fills in its
input. A result then attaches to that call. When the snapshot never reaches the owner that opened
the scaffold, nothing ever replaces or clears it.

1. **A partial on the wrong owner** (session `176bc5a7`). cli.js 2.1.280 lets a background agent
   stop while its own background children are still running, and resumes it when a child reports.
   With the session idle, that resume runs on `_buildIdleToolUseContext()`, which has no `toolUseId`.
   Patch E stamped `parent_tool_use_id` from that context, so the resumed run's stream events arrived
   with no owner, and the consumer opened them on the **main** transcript. The native relay still
   parents that run's completed snapshots and results to the origin Agent call (it reads the
   agent's sidecar), so they went to the agent's card. The main-transcript scaffolds were never
   filled in. The auto-mode verdicts (ADR-076) then attached to those copies, because verdict
   binding searches the main transcript first.
2. **A partial with no snapshot at all** (session `efa47532`). The output limit cut a message while
   a `Write` was still streaming (`stop_reason: "max_tokens"`). cli.js neither snapshots nor runs a
   `tool_use` whose input never completed. Both reducer merges (`mergeItemContent`'s preserved
   native slots, `mergeContentBlocks`'s preserved absent `tool_use`) keep the scaffold on purpose.
   They do this so that a separately attached block survives later upserts, and the same rule keeps
   the phantom call too.

## Decision

### 1. A stream frame's owner comes from the wire, and a sub-agent frame never falls back to the main transcript

- **Patch E stamps `agent_id`** (the background runner's `taskId`, which equals
  `task_started.task_id`) on every stream event it writes, next to the unchanged
  `parent_tool_use_id`. If Patch E is already in the file without `agent_id`, the apply step fails
  instead of skipping it.
- **The owner is resolved in this order:**
  1. `parent_tool_use_id`, through `resolveTaskOwner`.
  2. Otherwise `agent_id`: agent id → origin Agent call (`originByTaskId`, then `taskIdMap`), through
     `resolveTaskOwner`. This is the same owner the relay's snapshots resolve to, which is the whole
     point: a partial and its snapshot must meet in one item-lane state.
  3. Otherwise, a frame carrying an `agent_id` that nothing can place is **dropped**, never routed
     to the main transcript. A lost partial costs a card some live typing. A leaked one costs a
     spinner in the main transcript that nothing will ever clear.
  4. A frame with neither field belongs to the main agent.
- **Wherever a Claude item lane is fed, this rule applies.** The cross-engine dispatcher's
  Claude-target lane learns agent id → origin from that target's own `task_started` frames (the
  first id wins).
- **After a restart**, ADR-073 §5's transcript seed fills `originByTaskId` before the first frame is
  handled, so an agent spawned by the previous process is placeable at once. No sidecar lookup is
  needed for nested agents either: cli.js 2.1.280 emits `task_started` from the one task registry
  every spawn depth shares (`spawn_depth` N+1 for a spawn inside a depth-N agent), so a live nested
  agent is in the maps like any other.

### 2. Only the main agent's frames start a main turn

A frame with a `parent_tool_use_id` or an `agent_id` belongs to a sub-agent. It must not flip the
session to processing, start the turn clock or push the status line. A background agent working
while the main agent is idle is roster state (ADR-073), not a main turn. Before this, such a frame
made an idle session read "running": the Stop button and typing indicator showed, the turn clock
started, and the next prompt was queued behind a turn that did not exist.

### 3. A streamed call that no snapshot confirmed, in a message that did not stop for `tool_use`, is retracted

- `ClaudeItemStreamLifecycle` records `message_delta.stop_reason`. It also records every `tool_use`
  id carried by any snapshot of the message, counting one that fell through to the ordinary upsert
  (`'none'`) as well.
- When the message finishes, if its stop reason is anything other than `"tool_use"` (including
  none, for a stream cut by an interrupt or abort), each unconfirmed `tool_use` is removed from the
  state. It is reported **before** the final seal, on a new replicated channel:
  `session:tool-uses-retracted { messageId, toolUseIds, ownerToolUseId? }`.
- The reducer removes the call and every block keyed to it (`tool_result`, `tool_review`,
  `permission_denial`) from the main transcript or the owner's sub-agent bucket. It drops a message
  left empty, retires any item stream at or after the first removed slot, and treats a replay as a
  no-op that keeps object identity. `ClaudeSession` trims its kept history in the same way.
- **A message that stopped for `"tool_use"` never retracts anything.** Every call in it runs, and a
  sub-agent's snapshot can arrive after `message_stop`, because Patch E's stream events and the
  relay's snapshots reach stdout by different paths. The guard is what makes that race harmless.

## Consequences

- The two stuck-card symptoms are gone, and the fix does not depend on how the relay and Patch E
  order their writes.
- A Claude sub-agent frame that cannot be attributed is now visible only in the debug log, not as a
  card. If one ever goes missing that should not have, look for `dropping stream events of unknown agent` in the debug log, not at
  the transcript.
- The retraction is block-level: a message loses only the calls that never ran. Everything else in
  it, and every other message, is untouched, unlike `session:messages-retracted`, which removes whole
  messages.
- A small race remains. A sub-agent call can be retracted if an interrupt or a terminal
  `sealOwner(owner, true)` lands after the call's `content_block_start`, before its `message_delta`,
  and while its snapshot is still in flight. The late snapshot comes back as `'none'` and its
  ordinary upsert restores the call, so the card recovers. A result that arrived inside that window
  would have found nothing to attach to. This is accepted as vanishingly rare.
- A session whose only activity is a background agent now reads idle everywhere the main-turn flag
  is read, the sidebar spinner included. If that spinner is wanted, it belongs on the roster
  (`activeTasks`), not on the main turn.
- Two neighbouring gaps are closed. The dispatcher's Claude lane now aliases a SendMessage-resumed
  run onto its origin, learned from a second `task_started` for the same task (`5a448a0e`, mirroring
  `ClaudeSession`'s `runAliasByToolUseId`). In a session resumed from a transcript, an agent the
  seed does not know, such as a nested agent whose spawn lives in a sub-agent's transcript, gets its
  origin from its `.meta.json` sidecar (`readAgentSidecar`, `98280889`). The lookup happens at most
  once per agent, and fresh sessions never read the disk. A run resumed this way reports
  `runIndex` 2 even if the agent had earlier resumes: nothing records those.
- Reload from JSONL needs no change: cli.js never persists a truncated call, and a resumed run's
  messages are already under the origin.

## Alternatives considered

- **Patch E stamps the origin id itself.** It would read the agent's sidecar, as the relay does.
  Rejected: that means async I/O inside the runner's hot loop and a second chunk's helper to anchor
  on every bump. The runner already holds `taskId`, and the consumer already owns the agent-id maps.
- **Route `agent_id`-less, parent-less frames by "the main agent is idle, so it must be a background
  agent".** Rejected: it guesses, and a queued prompt starting a main turn looks exactly like it.
- **Stop the merges from preserving an absent `tool_use`.** Rejected: that preservation is what
  keeps a separately attached block and an early result alive across upserts (ADR-055). Removing it
  would trade one stuck card for a class of vanishing ones.
- **Retract every unconfirmed call at seal time, whatever the stop reason.** Rejected: the
  sub-agent snapshot-lag race would take back real calls.
- **Retract only on `max_tokens`.** Rejected: a stream cut by an interrupt leaves the same phantom
  call.
