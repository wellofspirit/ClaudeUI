# ADR-073: An agent is a `task_id`, a run is a `tool_use_id` — and the roster that reads them

**Status:** Accepted (2026-09-22, with §4 below recording the code as built). Amended 2026-09-23 by §5: agent identity outlives the parent process. Proposed 2026-09-21 from the owner's rulings of that day and mockups `3bf7d244` (final), `8addd12a`, `e4ba1fac`.
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

| run 2 signal                                          | carries the tool_use_id of  |
| ----------------------------------------------------- | --------------------------- |
| `task_started` / `task_updated` / `task_notification` | the SendMessage call        |
| `stream_event` partials (item streams)                | the SendMessage call        |
| the completed `assistant` message                     | **the original Agent call** |

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
  `task_started` for a task id and **not evicted** by a terminal notification. It belongs to the
  conversation, not to the cli.js process — see §5.
- A later `task_started` for a known `taskId` with a different `tool_use_id` is a **resume**. It
  emits `session:task-started` under the **origin** id, carrying `runToolUseId` and a 1-based
  `runIndex`, and registers an alias `runToolUseId → originToolUseId`.
- Item streams and subagent messages arriving under an aliased id are re-owned to the origin before
  they are sent, so run 2 streams live into the card that spawned the agent.
- `task_updated` and `task_notification` resolve through the origin; their `toolUseId` is always
  the origin's. A non-terminal `task_updated` does **not** re-arm `activeTasks`: the probe showed
  `task_started` is re-emitted on every resume, so that second path is redundant — and not harmless,
  because `task_updated` is a patch diff that fires on transitions this code does not enumerate, and
  a non-terminal patch arriving after a notification (or out of order) would strand a finished card
  as running. The authoritative signal is handled; the speculative one is not. _Amended by
  [ADR-077](adr-077_claude-harness-capability-gating-and-patch-set.md) (2026-09-25): the one
  non-terminal patch that does re-arm is `is_backgrounded: true` — cli.js's own report that a
  foreground task moved to the background — re-sent as the same run (same `runIndex`) with
  `isBackgrounded: true`, and only while the task is still live._
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
floor by a measured 93.6px (`AgentPill` 81.6 + its gap), which moved tier 1's threshold from 1000
to 1100. That was measured on 2026-09-21 by the Chromium layout harness the repository had at the
time; the harness was removed with its CI job on 2026-09-22, so the comment block in
`top-bar-tiers.ts` is now the record of the numbers. The post-tier-2 floor stays far below the 768px
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

### 4. As built

What the implementation found that the design above did not know, recorded here because the kickoff
spec that first held it did not ship (the ADR and the protocol doc are the durable record):

- `system/task_progress` had **no handler at all** — what the session consumed was the unrelated
  `tool_progress` message, which carries the elapsed clock and nothing else. Both now feed
  `session:task-progress`, each with the half of the row it knows (usage and last tool; the clock),
  and the reducer **merges** rather than replaces, so a usage tick cannot blank the clock. A resumed
  run's `tool_progress` is reported against the SendMessage call, so its `tool_name` is withheld and
  the origin's is kept.
- The legacy user-message `<task-notification>` XML path, kept for pre-2.1.241 binaries, resolves
  through the origin exactly as the system-message path does.
- `deriveTaskState` settles a **foreground** task on a terminal notification too (ADR-040 calls it
  authoritative; the old foreground branch ignored it and left such a task running forever), and
  takes `isError` from the notification whenever there is one — the panel's `TaskEntry` previously
  missed a failed async-launched agent.
- `stopTask` checks origins as well as `taskIdMap`; before, a resumed agent's Stop found no task id,
  fell through to `interrupt()` and aborted the whole turn.
- The transcript walk behind `useAgentRoster` is cached by message-array identity and shared by the
  three surfaces, so a streaming delta walks the transcript once, not once per surface.
- `AgentPill` measured 81.6px; tier 1 moved 1000 → 1100 (see §2).
- One terminal event per run in `taskNotifications`. cli.js reports a run's end twice — the
  `task_updated` patch (forwarded with an empty summary and no usage) and then the
  `task_notification` with the full record — and the wire does not promise that order. The reducer
  folds a second event for the same tool_use id and run index into the first, keeping whichever
  side has the summary, output file and usage; a different run index appends. Live verification
  surfaced this: two agents and one resume produced six entries, correct only by arrival order.
- Live-verified 2026-09-22 against cli.js 2.1.268 in the built Electron app: two named Haiku 4.5
  agents spawned in parallel, then one resumed with `SendMessage`. The pill, tab, overlay and panel
  roster, the re-armed card with `resumed ×1`, the origin-keyed `runIndex: 2` notification, and the
  two Appearance toggles all asserted by `data-testid` before the screenshots were read.

### 5. Identity outlives the process (amendment, 2026-09-23)

§1 cleared the identity maps "with the session", and `cancel()` was where that happened. But
`cancel()` ends a **process**, not the conversation. The user's Stop, the idle reaper and an account
switch all call it, and the next send `--resume`s the same conversation, either on the same object or
on a new one after an app restart. The agents outlive the process. Probed against 2.1.280
(`scripts/probe-agent-respawn.mjs`; protocol-cc §4.5):

```
[p1] Agent            toolu_019e…  → task_started task_id=acb38d…  (mid-run when p1 is killed)
[p2] task_notification task_id=acb38d… tool_use_id=—  status=stopped   ← the reap, before system/init
[p2] SendMessage to=acb38d…        → task_started task_id=acb38d… tool_use_id=<the SendMessage>
[p2] child/assistant parent=toolu_019e…                            ← the ORIGINAL Agent call, from p1
```

A session without the maps can attribute neither event, and the owner hit both on 2026-09-23:

- **Stuck running.** Three agents were mid-run when the session was killed. An agent spawned with
  `run_in_background: true` stays running until a terminal event matches its card, and the reap
  carries only the task id, so it matched no card and the agents read "running" forever, including
  after they were resumed and finished.
- **Resumed agent reads complete.** The resume armed the SendMessage call's id, which no card
  renders as a task. The agent's own card read "complete" with a frozen token count, while its
  output kept streaming into it through the original id.

**Decision.** The identity maps (`originByTaskId`, the run aliases, the run counts) are never
cleared on `cancel()`; they live as long as the `ClaudeSession` object. A new object that resumes a
transcript rebuilds them from it (`core/services/agent-identity.ts`): a spawn result's `agentId`
(structured `toolUseResult.agentId`, falling back to the `agentId:` text the live path matches)
names the origin, and each SendMessage result carrying `resumedAgentId` adds one run. A SendMessage
to a running agent answers "queued" and starts no run, exactly as the live counter sees it. The seed
fills gaps only, and is merged at the top of the message loop before the first wire message is
handled, because the reap arrives before `system/init`. Waiting there delays only that process's
first message and cannot reorder concurrent `run()` calls. Forks are seeded too: an agent spawned
before the anchor can be resumed from the fork.

**Settled when the process ends.** An agent dies with its process, but cli.js says so only in the
reap, and only if the session is resumed. Until then, a `run_in_background` card read "running", and
it stayed that way for good if the session was never resumed. `ClaudeSession` now tracks the tasks
the current process has started and not ended (`liveTasks`). When a run's process goes (cancel,
crash, idle reaper) it reports each one as `stopped` against its card and run index. A superseded
run leaves them to its successor, whose `--resume` reaps them. A disposed object stays silent on the
shared routing id. When the reap does come, it has the same tool_use id and run index, and the
reducer folds the two into one entry.

**Stopped reads as stopped.** `deriveTaskState` returns `isStopped`. The roster dot (`stopped`,
warning) and the transcript card (a stop glyph, warning border, `data-status="stopped"`) now draw a
stop differently from a finish, as the panel's `TaskEntry` badge already did. An agent that was
stopped never got to answer, so drawing it as "done" was wrong.

**History says `unfinished`, never `stopped`.** The history loader folds the transcript's spawns,
resumes and `<task-notification>`s (`foldAgentIdentity`). An agent whose last run starts (an async
launch or a resume) and never ends gets a synthetic entry with `status: 'unfinished'` and its run
index. A foreground spawn ends with its own result. A notification whose `<tool-use-id>` names an
earlier run does not close the current one. The reap, which carries no id, closes whatever run is
current. `unfinished` is deliberately not `stopped`: session-watcher runs the same loader over
sessions another CLI is still running, where the agent may well be working. It renders neutral:
`isLoaded`, the muted dot, and the card's "unfinished" label. A live resume replaces it with the
real reap.

**Not addressed:** after a respawn, `SendMessage{to: <name>}` fails ("No agent named … is
reachable") and only the raw agent id resumes. That is cli.js's name registry and nothing ClaudeUI
can change.

## Consequences

- A resumed agent re-arms its own card, streams into it live, and reports the run that actually
  finished. The fix lands once, at the extraction seam, rather than in each view.
- "Is anything running?" is answerable without scrolling, from a surface that cannot scroll away.
- The top bar's measured tier thresholds move for the first time since ADR-070. The measuring
  harness no longer exists, so the record is the comment block in `top-bar-tiers.ts`; the next
  never-dropped control will need a one-off measurement the same way.
- `originByTaskId` grows by one entry per agent per session and is never pruned within a session.
  That is bounded by how many agents a session spawns and is not worth an eviction policy; it lives
  as long as the session object and is rebuilt from the transcript when a new object resumes (§5).
- If cli.js ever stops re-emitting `task_started` on resume, the failure mode is today's behaviour —
  the card reads complete during run 2 — caught by the guard tests this arc adds, and by
  `scripts/probe-agent-resume.mjs` re-run against the new binary at the next CLI bump.
- The ADR-040 invariant is unchanged in spirit: running state still mirrors explicit lifecycle
  events. What changes is that a task's identity is the task id, and one task can have several runs.
