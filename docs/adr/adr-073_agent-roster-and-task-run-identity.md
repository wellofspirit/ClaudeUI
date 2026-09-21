# ADR-073: An agent is a `task_id`, a run is a `tool_use_id` — and the roster that reads them

**Status:** Proposed (2026-09-21). Drafted from the owner's rulings of 2026-09-21 and mockups `3bf7d244` (final), `8addd12a`, `e4ba1fac`.
**Amends:** [ADR-040](adr-040_engine-neutral-task-lifecycle-events.md) — `activeTasks` is no longer keyed only by the spawning tool call, and the `taskId → toolUseId` mapping is no longer evicted on a terminal notification.
**Relates to:** [ADR-027](adr-027_test-data-attributes.md) (the `data-testid` tiers the new surfaces carry), [ADR-033](adr-033_cross-engine-dispatch.md) (dispatch cards share the `task` ToolView), [ADR-035](adr-035_pi-engine-backend.md) / [ADR-036](adr-036_unified-auth-vault.md) (pi subagents), [ADR-070](adr-070_one-auth-surface.md) (the measured top-bar tiers this adds a control to), `docs/protocol-cc/04-system-subtypes.md` §4.4/§4.5/§4.6 (the wire shapes, amended by the probe below)

## Context

### 1. A resumed agent is invisible

Claude Code can send a message to an agent that has already finished, and the agent resumes work.
ClaudeUI does not notice. The card keeps saying "complete" for the whole second run, and a session
that has fanned out several agents gives the user no way to answer "is anything still working?"
other than scrolling back up the transcript hunting for cards.

The cause was probed against the shipped binary (`vendor/claude-cli/bun-claude.exe`, cli.js 2.1.268,
2026-09-21; probe at `scripts/probe-agent-resume.mjs`). Resuming a completed agent emits a **complete
second lifecycle**, not a patch to the first:

```
run 1   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…   (the Agent call)
        task_updated      task_id=aec60e185d4e7eb6d  patch={"status":"completed",…}
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…   status=completed
run 2   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…   (the SendMessage call)
        task_updated      task_id=aec60e185d4e7eb6d  patch={"status":"completed",…}
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…   status=completed
```

`task_id` and `description` are stable across runs. `tool_use_id` is **the id of whichever tool call
started that run** — the `Agent` call for run 1, the `SendMessage` call for run 2. This contradicts
§4.5's "non-existent → existing" reading of `task_started`; the doc is amended alongside this ADR.

The child's own output is split between the two ids, which is where the visible bug comes from:

| run 2 signal | carries the tool_use_id of |
| --- | --- |
| `task_started` / `task_updated` / `task_notification` | the SendMessage call |
| `stream_event` partials (item streams) | the SendMessage call |
| the completed `assistant` message | **the original Agent call** |

So today: `activeTasks` is armed under the SendMessage id, which renders as a `detail` card and shows
no running state; `TaskCard`'s `overlayItemStreams(subagentMsgs[id], itemStreams, id)` looks up the
original id and finds none of run 2's partials; and the final message alone lands on the original
card, arriving with no warning after a period in which nothing appeared to be happening.
`TaskCard` also reads `taskNotifications.find(…)` — the **first** terminal event — so run 1's summary
and usage are what it shows even after run 2 ends.

The eviction is what closes the loop: `handleTaskNotification` deletes `taskIdMap[taskId]`, so by the
time run 2's events arrive the session layer has forgotten which agent they belong to and falls back
to the wire's own `tool_use_id`.

### 2. There is no list

`TaskDetailPanel` is a detail surface with no roster: it shows exactly the entries the user has
already clicked into (`openedTaskToolUseIds`), and the only way in is a `TaskCard` in the transcript.
An agent card that has scrolled away is unreachable — the panel cannot be opened for it at all.

### 3. The state is there, the shape is not

`activeTasks`, `taskNotifications` and `taskProgressMap` already carry everything a roster needs, and
all four engines already normalize their spawn tools to the `task` ToolView kind (Claude
`Task`/`Agent`, opencode `task`, pi `subagent`, Codex `collab:spawnAgent`, plus `dispatch_agent` on
every engine). Three things are missing: the agent's **name** (dropped by every engine tool map, so a
fan-out reads "Explore, Explore, Explore" and nothing can link a `SendMessage{to}` to a row), the
**live usage** the wire already sends (`task_progress.usage` and `last_tool_name` are discarded by
`TaskProgress`), and a **single predicate** — ADR-040's running rule is copy-pasted at
`TaskCard.tsx:118` and `TaskEntry.tsx:119`, and a roster would be the third copy.

## Decision

### 1. `task_id` identifies the agent; `tool_use_id` identifies the run

The session layer normalizes runs onto the **origin** tool_use id — the one that spawned the agent —
so the renderer's tool_use-id keying is untouched everywhere.

- `ClaudeSession` keeps `originByTaskId: Map<taskId, originToolUseId>`, set on the **first**
  `task_started` for a task id and **not evicted** by a terminal notification. It is cleared with the
  session, like the other per-session maps.
- A later `task_started` for a known `taskId` with a different `tool_use_id` is a **resume**. It
  emits `session:task-started` under the **origin** id, carrying `runToolUseId` and a 1-based
  `runIndex`, and registers an alias `runToolUseId → originToolUseId`.
- Item streams and subagent messages arriving under an aliased id are re-owned to the origin before
  they are sent, so run 2 streams live into the card that spawned the agent.
- `task_updated` and `task_notification` resolve through the alias; their `toolUseId` is always the
  origin. A non-terminal `task_updated` for a known task id re-arms `activeTasks` (the terminal-only
  filter in `handleTaskUpdated` stays as it is for the states it already handles).
- The renderer reads the **last** notification for a tool_use id, never the first, and keeps
  `runIndex` so a card can say "resumed ×2".

**Why not re-key the renderer by `task_id`.** `subagentMessages`, `itemStreams`, `activeTasks`,
`taskProgressMap`, `bashOutputs`, `openedTaskToolUseIds` and the stop path are all keyed by tool_use
id, and three of the four engines emit no task id at all. Normalizing at the seam that owns the wire
keeps one concept in one place; re-keying would spread a Claude-only identifier through the store.

### 2. Three surfaces over one roster

One `useAgentRoster()` selector, one row component, three placements:

- **Pill** — top bar, right cluster. Visible whenever the session has spawned at least one agent,
  **including after they all finish** (muted form, total count), because it is the panel's only
  scroll-independent entry point. It toggles the panel and never opens the overlay.
- **Tab** — a corner tab on the composer's top-**right** edge, the mirror of the existing mode tab
  (`InputBox/View.tsx:526`, `absolute bottom-full left-3`). Visible only while at least one agent is
  running; it occupies the gutter that already exists, adds no layout height, and expands **upward**
  into a floating overlay over the transcript, the way `SlashCommandMenu` and `FileMentionMenu`
  already do. The chat never reflows.
- **Panel** — the existing `rightPanel === 'task'` dock gains a roster header above the entry stack,
  in two sections: **Agents** and **Background shells**. It keeps its scope: a background Bash is
  lost to scrolling for the same reason and already has `local_bash` lifecycle events.

The pill is **never dropped** by the tier system, for the same reason `GitChangesPill` is not: it is
a panel's only entry point. It therefore has no `⋯` row — the bar's rule is that a menu row is the
exact complement of the bar form, one row per control, never two. Adding it raises the never-dropped
floor by roughly 110px, which moves tier 1's threshold from 1000 to about 1110;
`src/layout/TopBar.layout.test.tsx` re-measures. The post-tier-2 floor stays far below the 768px
mobile breakpoint, so the five tools keep dropping before the pill does, which is the ordering the
owner asked for.

Both surfaces are gated by app settings — **Settings → Appearance → Agents**, two toggles, default
on. With both off the transcript card remains the way in, exactly as today.

**No unread state.** Running and not-running is the whole model: no read tracking, no per-agent
storage, nothing new on the remote snapshot.

### 3. The roster is engine-neutral by construction

Rows come from scanning messages for tool_use blocks whose `engineToolMap(engineId).kindOf()` is
`task`, joined to the shared lifecycle state — not from `activeTasks` alone. Claude contributes exact
lifecycle events; opencode, pi and Codex fall through to ADR-040's legacy heuristic, the same split
`TaskCard` already lives with. Two consequences are accepted rather than engineered around:

- **pi spawns N agents behind one tool_use id** (`subagent` takes `{tasks: [{agent, task}…]}`). That
  is one row naming its members, not N rows. Splitting it would need a synthetic id scheme through
  the whole task pipeline.
- **Only Claude can show live usage and a resume count.** Other engines' rows show elapsed time.

The derivation is memoized on `messages` identity (or backed by a reducer-maintained `taskOrder`), so
a `task_progress` tick does not re-scan a long transcript once per agent per tick.

### 4. The three gaps close with the arc

- `name?: string` on the `task` ToolView, filled per engine: Claude `input.name` then
  `subagent_type`, opencode `subagent_type`, pi `tasks[].agent`, Codex the leaf of `agentPath`. It is
  also what lets a `SendMessage{to}` card point at its agent.
- `TaskProgress` carries the wire's `usage` and `last_tool_name` through to the store.
- `deriveTaskState()` is extracted from `TaskCard`/`TaskEntry` **first**; the resume fix and the
  roster then read one predicate instead of three copies.

## Consequences

- A resumed agent re-arms its own card, streams into it live, and reports the run that actually
  finished. The fix lands once, at the extraction seam, rather than in each view.
- "Is anything running?" is answerable without scrolling, from a surface that cannot scroll away.
- The top bar's measured tier thresholds move for the first time since ADR-070; the layout test is
  the record of that, as before.
- `originByTaskId` grows by one entry per agent per session and is never pruned within a session.
  That is bounded by how many agents a session spawns and is not worth an eviction policy; it is
  cleared with the session.
- If cli.js ever stops re-emitting `task_started` on resume, the failure mode is today's behaviour —
  the card reads complete during run 2 — caught by the guard tests this arc adds, and by
  `scripts/probe-agent-resume.mjs` re-run against the new binary at the next CLI bump.
- The ADR-040 invariant is unchanged in spirit: running state still mirrors explicit lifecycle
  events. What changes is that a task's identity is the task id, and one task can have several runs.
