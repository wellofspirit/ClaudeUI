# ADR-095: The sidebar status dot ripples for activity, and turns violet while only subagents work

**Status:** Accepted (2026-10-06). Amended 2026-10-07: ripple retuned (softer dip, 2s cycle, 13px 2px
ring, mockup `62a33e2c`); the rules live in the shared `app.css`, which the web client lacked until then. Amended 2026-10-17: every dot colour is a theme token holding 3:1 on the panel in dark, light and Monokai (running and idle use `--color-success`, inactive is the solid grey `--color-dot-inactive`, light watching is darker), and the agent roster's rows use this same dot, with a `failed` state (ADR-073 §11). Amended 2026-10-19: every record that will wake the agent counts (`wakesParent`), shells, monitors and X-Agent runs included ([ADR-105](adr-105_background-dispatch.md) §2); `needsAttention` gains a precise definition (below). Amended 2026-10-20: an X-Agent's record keeps a disconnected or reopened parent violet (ADR-105 §5).
**Relates to:** [ADR-073](adr-073_agent-roster-and-task-run-identity.md) (the lifecycle records, `activeTasks`, this reads), [ADR-045](adr-045_engine-disconnect-status-contract.md) (a disconnect clears `activeTasks`, which is what keeps the violet state honest), [ADR-027](adr-027_test-data-attributes.md) (the test ids), mockups `97726c29` → `5dd637c3` → `28209383` → `2bbc3158` (the approved one) → `62a33e2c` (2026-10-07 retune).

## Context

The dot in front of each session in the sidebar pulsed only while `status.state === 'running'`, that is,
while the MAIN agent's turn was in flight. Since cli.js 2.1.219 an agent runs in the background by
default: the main turn ends at the launch acknowledgement, the agents keep working, and the dot went solid
green, the same as an idle session. A session with five agents busy looked finished.

The pulse itself was the second complaint: an opacity blink on a 6px dot is easy to miss, including the
amber "needs attention" one, which is arguably the state that most needs to be seen.

## Decision

**Six states, first match wins.**

| state     | condition                                   | look          |
| --------- | ------------------------------------------- | ------------- |
| attention | `needsAttention` and not the active session | amber ripple  |
| running   | `status.state === 'running'`                | green ripple  |
| subagents | a running background task (see below)       | violet ripple |
| idle      | `sdkActive`                                 | solid green   |
| watching  | `isWatching`                                | solid blue    |
| inactive  | otherwise                                   | muted         |

`needsAttention` is raised by an approval that is waiting (a re-raised one for a disconnected parent's
X-Agent is listed but raises nothing), by a turn that ended while you were not looking, and by an X-Agent
result that is held for a parent that is not live (`session:dispatch-result-held`, ADR-105 §3). A turn end
raises it only when no record that will wake the agent is live, no queued prompt is about to go out (unless a
sign-in holds the queue) and no hand-back wake is pending; an agent-started session is not flagged at birth;
Codex raises the turn-end signal too. When the main agent and background
tasks are both working, the main agent wins and the tooltip adds "· N background tasks running" (the state
label is "Background tasks working").

**A running subagent is a live `activeTasks` record that will wake the main agent** (`wakesParent`, stamped
by the emitter): `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, an X-Agent's run
(task type `dispatch`, [ADR-105](adr-105_background-dispatch.md) §2), and — since 2026-10-19 — background shells (`local_bash`),
monitors and `mcp_task`, because a finished shell starts an auto-continued turn on cli.js 2.1.293 just as an
agent does. Originally shells and monitors were excluded so a dev server would not keep a session violet for
its whole life; that cost is now accepted. The records, not the transcript, are the source: they are exact for
Claude and pi, cleared on disconnect (ADR-045), and cannot be fooled by a
transcript that lost its terminal events (the fork bug fixed alongside this, where history-derived rows read
"running").

**A dispatched X-Agent counts, and outlives its parent's process** ([ADR-105](adr-105_background-dispatch.md)
§2, §5). A background `dispatch_agent` run is a `wakesParent` record (task type `dispatch`) like any agent's. The
other records need a live engine: `subagents` therefore no longer requires `sdkActive`, and the sidebar counts
`activeTasks` through `countDotTasks`: with a live engine every waking record, with a disconnected or reopened
one only the `dispatch` records. The reducer clears every native record on a disconnect, so a native record on
a dead engine is stale; the dispatcher re-raises the dispatch records of the X-Agents that still run, so the
parent's dot stays violet while they work.

**The ripple.** A drop lands on the dot: the dot dips (scale .8 → 1.05 → 1), its glow blooms and settles
to a faint halo that stays between drops, and one 2px ring leaves it and fades. One cycle is 2s.
Each dot starts at a random point in the cycle, so a list of busy sessions does not ripple in unison.

**Compositor-only.** Only `transform` and `opacity` animate. The glow is a fixed blurred layer whose opacity
breathes; the ring is drawn at its final size (13px) and scaled up from 0.45×, so its 2px line starts at
about 0.9px and thickens as it spreads.
The first build animated `box-shadow` and `inset`, which repaint on the renderer's main thread every frame
for as long as a session is busy; the owner compared the two side by side and found the compositor version
smoother as well as cheaper. Chromium already stops CSS animations in a hidden or fully covered window.

**Reduced motion** shows the halo steady and no ring.

## Consequences

- The ring (13px) nearly fills the dot's 14px slot, and its glow and the dot's halo reach past it. Nothing
  clips them and they do not move layout, because they are absolutely positioned pseudo-elements and
  box-shadows. Do not add `overflow: hidden` to that slot.
- No class may be called `ring`: Tailwind's `ring` utility draws a 3px box-shadow and silently changes the
  look (it did, in a mockup).
- A missed terminal event leaves a record behind, and the dot then stays violet until the process
  disconnects. The agent pill has the same exposure; the remedy is the record's, not the dot's.
- Watched sessions (an external CLI) never ripple violet: no lifecycle records reach us for them.
