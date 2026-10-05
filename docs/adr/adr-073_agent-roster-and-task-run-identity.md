# ADR-073: An agent is a `task_id`, a run is a `tool_use_id` — and the roster that reads them

**Status:** Accepted (2026-09-22, with §4 below recording the code as built). Amended 2026-09-23 by §5: agent identity outlives the parent process. Amended 2026-09-29 by §6: the panel roster opens on Running, folds by section, scrolls on its own, and a row click toggles its entry. Amended 2026-09-30 by §7: nested agents are listed at every depth, background shells only while they run, and the pill and tab show a dot and a bare number. Amended 2026-10-01 by §8: an opencode run's terminal status comes from its `task` part, and a `session.error` is never terminal. Amended 2026-10-06 by §9: the overlay is bounded by the composer, not the viewport, and a roster narrower than 480px lays its rows out on two lines. Amended by [ADR-078](adr-078_stream-frame-ownership-and-truncated-calls.md): an agent that resumes ITSELF while the session is idle runs with no tool_use id at all; its partials carry only `agent_id` and are placed on the origin by agent id. Proposed 2026-09-21 from the owner's rulings of that day and mockups `3bf7d244` (final), `8addd12a`, `e4ba1fac`.
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
  [ADR-079](adr-079_claude-harness-capability-gating-and-patch-set.md) (2026-09-25): the one
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
  _Amended by §7:_ a shell is listed only while it runs, and agents are listed at every depth.

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
  _Correction (2026-09-27, `a3c5d1c7`):_ in stock local use `tool_progress` carries **no clock for an
  agent**. Its producers in 2.1.280 are Bash/PowerShell progress (only under `CLAUDE_CODE_REMOTE`),
  REPL, API-retry frames (`elapsed_time_seconds: 0`), and a 30 s main-agent heartbeat keyed
  `<id>-heartbeat-N`, which matches no card. A usage-only `task_progress` then left the reducer's
  default `0`, and a running Task card read "0s" for its whole run. `session:task-started` now
  carries the run's `startedAt`, stamped by the emitter; a re-reported start keeps it and a resume
  starts a new one. The card and the Tasks panel count live from it and show the run's duration once
  it ends.
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

### 6. A long roster stays usable (amendment, 2026-09-29)

In a long session the panel roster was unusable: it sat in a `shrink-0` box above the entry stack,
so twenty-odd rows pushed the entries off the panel and the list itself could not scroll. The
owner's rulings of 2026-09-29:

- **Running is the default filter** (the buttons read Running | All). Finished rows are most of a
  long session's list and bury the ones that still matter. Under Running, a finished row that is
  open in the panel stays listed, because clicking it again is how it is put away. With nothing
  running, the empty state offers "Show all N".
- **Each section folds.** "Agents" and "Background shells" always carry a heading, even alone,
  because the heading is the fold control; it keeps the row count when folded. The filter and the
  folds stay local component state, for the reason the filter already was: they are a way of
  looking, not a preference.
- **The roster scrolls on its own** (`TaskDetailPanel.roster`). Alone it fills the panel; with
  entries open it is capped at 40% of the panel so they stay in view. Its header is sticky, and a
  row that becomes selected scrolls into view, since the cap can otherwise push the row just
  clicked below the fold.
- **A row click in the panel toggles** its entry (`toggleTaskInPanel`). Putting the last entry away
  leaves the panel open on the roster, unlike an entry's own close button
  (`removeTaskFromPanel`), which closes the panel with it. The composer overlay still only opens:
  it is a door into the panel, not the panel.

### 7. Nested agents, running-only shells, and a bare number (amendment, 2026-09-30)

In session `4dc0e3dc` a depth-1 background agent spawned a depth-2 implementer, handed back and went
idle. The roster showed sixteen finished rows and nothing running, the pill read a grey "17 agents"
(sixteen agents plus a background shell that had long finished), and all twelve depth-2 agents in the
session were missing. The roster scanned only the main transcript, while a nested spawn call lives in
its parent agent's bucket (`subagentMessages[<parent origin id>]`). The owner's rulings of
2026-09-30, from mockup `6be482b8`:

**Wire facts** (S0 probe, cli.js 2.1.280, `scripts/probe-nested-agents.mjs`;
`docs/protocol-cc/04-system-subtypes.md` §4.5). A nested agent's `task_started` is on the top-level
stream, keyed by its own spawn call's id, with `spawn_depth: 2`, so ClaudeSession already records it
like any task. Its snapshots carry its own call id as `parent_tool_use_id`. Its spawn call and that
call's result arrive in the parent's bucket. Its sidecar names `parentAgentId`. A subagent's
**foreground** Bash registers `is_backgrounded: false`, like the main agent's.

**The roster lists every depth.** `useAgentRoster` walks the main transcript, then, depth-first, the
bucket of every agent it finds, with a visited set so a malformed bucket cannot loop. Each walk is
cached by the bucket array's identity, and the reducer replaces only the bucket it touched, so a
streaming delta in one agent re-walks that bucket alone. A nested row sits directly under the agent
that spawned it, in the parent's spawn order, indented 14px per level with a file-tree guide.
Top-level rows keep transcript order. There is no per-parent fold.

**Context ancestors.** Under the Running filter, a finished ancestor of a running (or open) row is
kept, dimmed (`data-context="true"`), so an indented row never floats without its parent. The whole
chain is kept. A context row is not counted as running, not counted in the section's number, and
offers no Stop, but still opens on click.

**Dot and number.** The pill and the composer tab show a dot and a bare number, no noun. While
anything runs the number is the running count: running agents at every depth plus running shells, so
a lone shell lights the pill. Otherwise the pill shows the session's agent total. The panel header
counts the same way. The tooltip and `aria-label` carry the breakdown, for example
`1 agent, 1 shell running · 28 agents in this session`. This supersedes the 2026-09-22 "N agents"
label ruling. The tab adds the longest clock, and it now appears when only a nested agent or a shell
runs. The top-bar tier thresholds are unchanged: a narrower pill only frees room.

**Background shells: running only.** A shell row exists only while the shell runs. Nobody reads a
finished shell's output from the roster, and the row's real value is a Stop that does not depend on
scrolling. This amends §2's "Background shells" section and reverses the roster half of `1b484442`,
which listed finished and moved shells from the transcript (its Bash-card and entry-panel half
stays). Shell rows come from the live lifecycle records, not from a transcript scan: a shell is
listed when `activeTasks[id]` exists, its `taskType` is `local_bash` and its `isBackgrounded` is
`true`, at any depth. The kickoff first needed a second clause, because protocol-cc said cli.js
registers every subagent Bash as backgrounded. S0 showed otherwise: a foreground Bash registers
`false` at every depth, and only `run_in_background` or a later move flips it, so the flag alone means
"running in the background", including a nested command a timeout moves. Rows are flat, in a section
that renders only while it has rows and that the Running filter does not touch. The one exception
follows §6: a finished shell whose entry is open stays listed until the entry is put away. It is
recognized the way the panel recognizes a background Bash (a terminal event, plus
`run_in_background` or the moved-to-background result). A reopened session lists no shells. Only
Claude reports shell lifecycles, so only Claude lists shells. A subagent's background command now
also gets its output file recorded (`recordBackgroundOutput`, split out of `detectTaskMapping`), so
its entry can tail it; the identity half of that function stays main-agent only, since
`task_started` maps nested tasks.

**Opening a nested row.** `findTaskBlocks` takes the buckets: it searches the main transcript, then
the first bucket that holds the call, and takes the result from that bucket. A nested entry then
renders `subagentMessages[<its id>]`, its own transcript, like any agent.

**Stop guard.** A nested row, and a nested entry in the panel, offers Stop only when
`activeTasks[id]` exists. Without a lifecycle record the engine has nothing to target, and Claude's
`stopTask` would fall back to `interrupt()` and abort the main turn.

**A nested row with no lifecycle record cannot outlive its parent.** It runs only by ADR-040's
legacy heuristic (no result yet), and on some engines the result never comes. In tree assembly,
evaluated top-down so a parent's final state decides its children's: a row at depth > 0 with no
`activeTasks` entry and no terminal event, whose parent is not running, is not running, and without a
result it settles as neutral (`isLoaded`), not "done". A row nothing reported on must not claim it
finished. A row WITH a record is never touched: a Claude agent running on after its parent went idle
is exactly what this section exists to show. Nested rows without lifecycle events are best-effort.

**History.** `loadSessionHistory` reads every sidecar in the flat `subagents/` directory
(`readNestedAgentOrigins`, through `readAgentSidecar`'s id validation) and adds each one that names a
`parentAgentId` to `agentIdToToolUseId`, so the Sidebar loads its transcript like any other. A
notification the main transcript holds for a nested agent is attributed to its origin. Agents
without a sidecar (older CLIs) stay unlisted. Historical rows never read running.

**Per engine.** The renderer is engine-neutral; engine plumbing changed only where nested content
was delivered and dropped.

- **Claude:** as above.
- **opencode:** a subagent may call `task` when `subagent_depth` > 1 (default 1) and its agent's
  permissions allow it (`vendor/opencode-src/packages/opencode/src/tool/task.ts:104-117,145-149`;
  ClaudeUI exposes the setting). `handleChildEvent` now registers a child's own `task` call the way
  the own-session path does, so a grandchild's messages reach a bucket under its call id and its
  `session.idle` becomes that call's task-notification. _(Superseded by §8: the terminal notification
  now comes from the child's `task` part, and the grandchild's idle only seals its streams.)_
- **pi:** ClaudeUI's child processes load no `-e` extension, so its own `subagent` tool cannot
  recurse. A user-installed extension discovered in the child could spawn one; its content stays
  inside that extension's tool result and is not shown. Such a row settles through the rule above.
- **Codex:** nesting stays refused (one warning), but the grandchild's spawn card is still published
  into the child's bucket, live and in history. A v2 `started` card never gets a result and settles
  as `isLoaded` through the rule above. A v1 spawn call returns at once, so its row reads "done"
  while the grandchild runs on natively. That is accepted: Codex refuses nesting and says so.

### 8. An opencode run ends when its `task` part ends (amendment, 2026-10-01)

In session `ses_f0ad4e70fffeKSjL66R1MCNhnz` a subagent ran past its model's context window. opencode
treats `ContextOverflowError` as recoverable: the processor's `halt`
(`vendor/opencode-fork-src/packages/opencode/src/session/processor.ts` ~620-631) sets
`needsCompaction`, **publishes `session.error` anyway**, compacts, replays the prompt and carries on.
ClaudeUI read that `session.error` as the end of the run. The card flipped to "failed" and
`childSessions` dropped the child. After compaction the child's next `bash` raised `permission.asked`
for a session ClaudeUI no longer knew, so the ask was ignored as foreign. The tool waited forever,
the parent's `task` never returned, and the main session read "running" for 76 minutes until the
user aborted. The owner's rulings of 2026-10-01:

**`session.error` is not terminal.** It is a report, not a lifecycle event. For a child it is
ignored, whatever its name. For the session itself, a `ContextOverflowError` is ignored (the turn
ends via `session.idle` either way); other errors keep their banner. The same applies to a
cross-engine dispatch target: its overflow no longer settles the dispatched turn. A turn that really
died of an overflow (`compaction.auto: false`) is caught at idle by the existing check of the last
assistant message's `info.error`.

**The parent's `task` part is the one source of a run's terminal notification.** Only the part knows
the outcome. opencode's task tool fails with `Subagent failed (task_id: …): <message>` exactly when
the child ended on an error (`tool/task.ts` ~213-222), and completes when the child recovered. When the
part reaches a terminal state (`settleTaskChildren`, for the session's own `task` calls and for a
child's), ClaudeUI sends exactly one notification:

- `completed`: the part completed.
- `stopped`: the part errored because it was aborted, either `metadata.interrupted` (the processor
  aborting an in-flight tool, `processor.ts` ~602) or the error `Task cancelled` (`task.ts:340`,
  which sets no metadata). This matches Claude (`killed` → `stopped`) and Codex
  (`interrupted`/`shutdown` → `stopped`).
- `failed`: any other error.

A child's `session.idle` now only seals the child's streams. The exception is a **background** call
(`metadata.background`, opencode's experimental background subagents, which ClaudeUI does not
enable). Its part completes while the child runs on, so the child's idle sends the notification.

**The child mapping lives as long as the call.** A `childSessions` entry is removed when the call's
part settles, matched by callID, so a child resumed with `task_id` under a newer call keeps its
routing. A child is registered only from a live (pending or running) part. Compaction's prune
republishes old completed tool parts, and that must not revive a removed entry or overwrite a newer
callID.

**The failure reason is shown.** A failed TaskCard with subagent output shows the tool result's
error text in `TaskCard.failureSummary`. The result body still shows the subagent's output. Before,
the reason was only visible when the subagent produced nothing.

### 9. The roster on a narrow screen (amendment, 2026-10-06)

On the owner's phone (Samsung S25 Ultra, Edge, 412 x 728 CSS px, `uiFontScale` 1.1) the overlay hung 15px
off the left edge, each row lost its description, and Stop was clipped. Two causes, both layout, neither
visible to jsdom. The rule that came out of the first is [ADR-092](adr-092_zoom-trap-no-viewport-units.md).

**The zoom trap.** The overlay was `w-[min(420px,calc(100vw-32px))]`. SessionView renders the app under
CSS `zoom: uiFontScale`, and inside a zoomed subtree `vw` lengths are multiplied by the zoom: that box
measured 380px at zoom 1, 418px at 1.1 and 570px at 1.5, on a 412px screen. It is now
`w-[420px] max-w-full`: a percentage resolves against the composer, which is already laid out in zoomed
px (`shared/use-anchored-menu.ts` has the long account of the same trap). `max-w-full` is relative to
the composer box because that is the overlay's containing block (the nearest positioned ancestor,
`InputBox/View.tsx`).

**A row has two shapes, chosen by the roster's own width.** `AgentRosterList` is a named container
(`@container/roster`). Below **480px** of roster width a row is two lines: status dot, then a column
holding name, resumed chip and metrics over badge and description, then Stop, centred at the right with a
taller touch target. At 480px and above it is one line. The threshold was first 400, which left the
420px desktop overlay on one line; in the real app a Claude row (name, badge, resumed chip, `Bash · 2m 15s ·
8720.9k`, Stop) cannot be read there, and the shrink weights left a name of "m13…" and a badge of "g.". So the
420px overlay is two-line too, and only a panel wider than 480px keeps one line. It is a container query, not
a viewport one, so the zoom cannot fool it and the panel's roster, which can also be narrow, gets the same
behaviour.

**What each shape protects.** Narrow, line 1 gives the name a floor (`min-w-[4.5rem]`) and lets the metrics
truncate before the name does (to a 3rem floor, so a 43-character name cannot take the clock and the tokens too); line 2 keeps the badge whole and lets the description give way; under
**400px** the metrics also drop the current tool (`Bash`, `Read`), leaving `2m 15s · 2270.0k` (every phone list is under 400px: about 350px at uiFontScale 1.1, where the token count was being cut to `872…`; the 420px overlay keeps the tool), as one
`AgentRow.metrics` element with the tool in its own hidden-when-narrow span. Wide, Stop and the metrics never
shrink and the description gives way first (to a 3rem floor), then the badge, then the name (still capped at
140px). These are flex-shrink weights (description 10000, badge 10, name 1), large enough apart that the
description absorbs the cut before the badge loses a pixel.

**Option A, not "drop by priority".** The alternative was to keep one line on the phone and drop the
badge, the current tool and the Stop label. It is denser but throws information away and leaves a
20px Stop. Two lines keep everything, and the dot stays vertically centred so the nested rows' tree
elbow (`h-1/2`) still meets it.

**One DOM, CSS only.** Both shapes come from the same elements: no `ResizeObserver`, no measured widths,
no element rendered twice with one copy hidden. The exceptions are text variants inside one element: the
`resumed x N` text has a `↻N` variant inside the same chip, and the metrics' tool name is its own span. Line
wrappers are `display: contents` when wide, and the wide order is carried by `order-*`, which also puts each
element on its own narrow line.

The Task card has the same trap and the same cure (`@container/taskcard`, 480px): its header sheds the word
"Task" under 480px and the clock under 300px (one row, never wrapped; under 300px the description floor drops from 3rem to 2rem, which a blocked review's chip plus Approve needs), and its footer turns "Open in panel" into
an icon and keeps the model chip at least 5rem wide. Narrow, the footer may wrap whole chips; `flex-wrap` breaks
a line on the items' basis sizes before anything shrinks, so the model chip's basis is its 5rem floor
(`basis-[5rem] grow max-w-fit`), not its text.

**Two zooms, two surfaces.** The roster (the composer's overlay, the panel) lives under the app zoom,
`uiFontScale`. A Task card lives in the chat's message list, which ChatPanel zooms again by
`chatFontScale / uiFontScale`, so the card's own zoom is `chatFontScale` and `uiFontScale` does not touch it.
The card is also narrower than the window by more than a margin: scroller `mr-2`, column `px-3`, and, when a
message holds two or more tool calls, the bordered `p-2` group. On a 412px phone that is
`(412 - 8) / chatFontScale - 42` CSS px: 362, 325, 282 and 228px at chat scale 1, 1.1, 1.25 and 1.5. A layout
test uses the zoom and the container chain of the surface it tests. The browser layout tests (`docs/testing-strategy.md`,
Layer 2b) assert readability, not just containment: the roster at uiFontScale 1, 1.1, 1.25 and 1.5, the card
at the same four values of chatFontScale.

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
- §7 follow-ups, not addressed: a reopened nested agent that died mid-run reads "done", not
  "unfinished" (the `unfinished` fold covers only the main transcript's agents); and a reopened
  opencode session loads no child transcripts at all.
- §8 depends on opencode wording in two places: the `Task cancelled` string, and the
  `ContextOverflowError` name. Re-check both, and `processor.ts` `halt`, at every opencode bump. If
  two calls ever mapped to the same child at once (a resume registered before the old part settled),
  the older call would get no notification. The foreground flow can't produce that, because the
  parent blocks on `task`.
