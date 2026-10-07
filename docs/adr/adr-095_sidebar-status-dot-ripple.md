# ADR-095: The sidebar status dot ripples for activity, and turns violet while only subagents work

**Status:** Accepted (2026-10-06). Amended 2026-10-07: ripple retuned (softer dip, 2s cycle, 13px 2px
ring, mockup `62a33e2c`); the rules live in the shared `app.css`, which the web client lacked until then.
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
| subagents | `sdkActive` and a running subagent          | violet ripple |
| idle      | `sdkActive`                                 | solid green   |
| watching  | `isWatching`                                | solid blue    |
| inactive  | otherwise                                   | muted         |

`needsAttention` keeps its existing meaning (an approval is waiting, or a turn ended while you were not
looking); only its look changes. When the main agent and subagents are both working, the main agent wins and
the tooltip adds "· N subagents running".

**A running subagent is a live `activeTasks` record of an auto-continuing type**: `local_agent`,
`remote_agent`, `in_process_teammate`, `local_workflow`. That is the set the turn-end notification already
uses, and upstream's own busy predicate. Background shells (`local_bash`) and monitors are excluded: a dev
server would otherwise keep a session violet for its whole life. The records, not the transcript, are the
source: they are exact for Claude and pi, cleared on disconnect (ADR-045), and cannot be fooled by a
transcript that lost its terminal events (the fork bug fixed alongside this, where history-derived rows read
"running").

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
