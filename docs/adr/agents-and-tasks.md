# Agents, task runs and the roster

Governs: `src/core/services/agent-identity.ts`, `src/core/services/subagent-watcher.ts`, `src/core/services/claude-session.ts`, `src/core/shared/sync/`, `src/renderer/src/components/agents/`, `src/renderer/src/components/TaskDetailPanel/`, `src/renderer/src/components/chat/task-state.ts`, `src/renderer/src/components/chat/TaskCard.tsx`

How a subagent or background task is known to be running, what its identity is across resumes, and the one roster
(top-bar pill, composer tab, panel list) that answers "is anything still working?". Each engine emits the task
events its own way; this record states the contract and the engine records hold the mechanics. Background dispatch
and `wakesParent` are ADR-105 (dispatch.md). Agent type colour tiles are ADR-094 and the sidebar status dot is
ADR-095 (ui.md). Stream frame ownership, including an agent that resumes itself while idle, is ADR-078
(claude-engine.md). The approval lifecycle that ADR-040 mirrors is ADR-038 (engine-model.md). The wire shapes are
in `docs/protocol-cc/04-system-subtypes.md` §4.4 to §4.6.

## Task running state is a projection of lifecycle events (ADR-040)

A task is running exactly while the store holds a lifecycle record for it. The renderer never infers running from
tool input, tool results or turn state. Claude Code subagents are background-by-default, the model usually omits
`run_in_background`, and an immediate "Async agent launched" `tool_result` arrives at spawn, so every such input
sniff is wrong.

- The engine emits `session:task-started` `{toolUseId, taskId, taskType}` at spawn and `session:task-notification`
  at the terminal state. The store keeps `PerSessionState.activeTasks: Record<toolUseId, {taskId, taskType, ...}>`:
  set by task-started, deleted by task-notification, reset with the session, carried in the remote
  `PerSessionSnapshot` so a client that connects mid-task sees the running state.
- **Predicate.** An `activeTasks` record means RUNNING until the matching notification, regardless of `tool_result`
  or `run_in_background`. It lives in one function, `deriveTaskState` (`chat/task-state.ts`), shared by TaskCard,
  the panel's TaskEntry and the roster. A new surface calls it; it never re-implements the rule.
- **Legacy fallback, on purpose.** An engine or transcript with no lifecycle record (historical transcripts,
  cross-engine dispatch cards driven by synthesized notifications, any engine that does not emit task-started) keeps
  the older heuristic (`isBackground ? !bgNotification : !hasResult`). The new signal only ever adds running-ness.
  opencode (ADR-111) and pi (ADR-089) now emit task-started themselves. A future engine that can report spawn emits
  `session:task-started` rather than inventing its own inference.
- A notification whose `taskIdMap` lookup misses falls back to the wire's own `tool_use_id`.
- "Send to background" shows only for a record with `isBackgrounded === false` (ADR-079): cli.js can move only a
  task it registered as foreground.
- Failure mode if the wire shape changes: no record, so the legacy heuristic, which shows as "a finished card while
  the agent still runs". The lifecycle guard tests in `TaskCard.component.test.tsx` catch it.

## An agent is a `task_id`, a run is a `tool_use_id`, and one roster reads them (ADR-073)

Claude Code can message an agent that already finished and it resumes. The wire then carries a COMPLETE second
lifecycle: `task_started`, `task_updated`, `task_notification`, with the same `task_id` and a new `tool_use_id`
(the id of whichever call started that run: the `Agent` call for run 1, the `SendMessage` call for run 2). The
child's streamed partials carry the SendMessage id; its completed `assistant` message carries the original Agent
id. ADR-040's identity is therefore per run, and a card must be re-armed by a resume.

### §1 `task_id` identifies the agent, `tool_use_id` the run; the session layer normalizes onto the origin id

- `ClaudeSession` keeps `originByTaskId: Map<taskId, originToolUseId>`, set on the FIRST `task_started` for a task
  id and never evicted by a terminal notification (nor by `cancel()`, see §5).
- A later `task_started` for a known task id with a different `tool_use_id` is a RESUME. It emits
  `session:task-started` under the ORIGIN id with `runToolUseId` and a 1-based `runIndex`, and registers an alias
  `runToolUseId -> originToolUseId`. Item streams and subagent messages arriving under an alias are re-owned to the
  origin before they are sent, so run 2 streams live into the card that spawned the agent.
  An agent that resumes ITSELF while the session is idle has no tool_use id at all; its partials carry only
  `agent_id` and are placed on the origin by agent id (ADR-078, claude-engine.md).
- `task_updated` and `task_notification` resolve through the origin. A non-terminal `task_updated` does NOT re-arm
  `activeTasks`: it is a patch diff that fires on transitions the code does not enumerate, and one arriving after a
  notification would strand a finished card as running. The one exception is `is_backgrounded: true` (ADR-079):
  re-sent as the same run (same `runIndex`) with `isBackgrounded: true`, and only while the task is live.
- The renderer reads the LAST notification for a tool_use id, never the first (`latestNotification`), and keeps
  `runIndex` so a card says "resumed x2".
- Rejected: re-keying the renderer by `task_id`. `subagentMessages`, `itemStreams`, `activeTasks`,
  `taskProgressMap`, `bashOutputs`, `openedTaskToolUseIds` and the stop path are keyed by tool_use id and other
  engines emit no task id; normalizing at the seam that owns the wire keeps a Claude-only identifier out of the store.
- `stopTask` resolves origins as well as `taskIdMap`; without that a resumed agent's Stop fell through to
  `interrupt()` and aborted the whole turn.

### Three surfaces over one roster

One `useAgentRoster()` selector, one row component, three placements. The transcript walk is cached by message-array
identity (and, per agent bucket, by the bucket array's identity), so a streaming delta does not re-scan the
transcript once per surface or per agent.

- **Pill** in the top bar's right cluster: visible whenever the session has spawned an agent, including after they
  all finish (muted, total count), because it is the panel's only scroll-independent entry. It toggles the panel,
  never the overlay. It is never dropped by the top-bar tier system (like `GitChangesPill`) and so has no `...`
  menu row. Adding it raised the never-dropped width floor; the measured numbers are the comment block in
  `chat/ChatPanel/top-bar-tiers.ts`, which is where the next never-dropped control must be re-measured.
- **Tab** on the composer's top-right edge, visible only while an agent or shell runs. It adds no layout height and
  expands upward into a floating overlay, so the chat never reflows. The overlay only opens the panel entry; it is
  a door, not the panel.
- **Panel**: the `rightPanel === 'task'` dock gains the roster above the entry stack.

Pill and tab are gated by two app settings, `showAgentPill` and `showAgentTab` (Settings > Appearance > Agents),
default on. With both off the transcript card remains the way in. There is no unread state: running or not running
is the whole model, with no per-agent storage and nothing extra on the remote snapshot.

### §3 The roster is engine-neutral by construction

Rows come from scanning messages for tool_use blocks whose `engineToolMap(engineId).kindOf()` is `task`, joined to
the shared lifecycle state, not from `activeTasks` alone. Claude, pi and opencode report lifecycle events;
anything else falls to the legacy heuristic. Accepted costs:

- pi spawns N agents behind one tool_use id (`subagent` takes `{tasks: [...]}`): one row naming its members, not N
  rows, because splitting would need a synthetic id scheme through the whole task pipeline.
- On opencode each run is its own call, so a resume is a new row with a higher run index (ADR-111).

### §4 One predicate, names and live usage

- The `task` ToolView carries `name?`, filled per engine (Claude `input.name` then `subagent_type`, opencode
  `subagent_type`, pi `tasks[].agent`); it is what lets a `SendMessage{to}` card point at its agent.
- `TaskProgress` carries the wire's `usage` and `last_tool_name` into the store, which MERGES progress ticks rather
  than replacing them, so a usage tick cannot blank the clock.
- **As built.** `system/task_progress` had no handler before this: the session consumed only `tool_progress`, which
  carries no clock for an agent in stock local use. `session:task-started` therefore carries the run's `startedAt`,
  stamped by the emitter (a re-reported start keeps it, a resume starts a new one); the card and the panel count
  live from it and show the run's duration once it ends. A resumed run's `tool_progress` is reported against the
  SendMessage call, so its `tool_name` is withheld and the origin's kept.
- `deriveTaskState` also settles a FOREGROUND task on a terminal notification and takes `isError` from the
  notification whenever there is one.
- `taskNotifications` holds ONE terminal event per run: cli.js reports a run's end twice (the `task_updated` patch
  with an empty summary, then `task_notification` with the full record) and the wire does not promise the order.
  The reducer folds a second event for the same tool_use id and run index into the first, keeping whichever side
  has summary, output file and usage; a different run index appends.
- The legacy user-message `<task-notification>` XML path (pre-2.1.241 binaries) resolves through the origin too.

### §5 Identity outlives the process

`cancel()` ends a process, not the conversation: the user's Stop, the idle reaper and an account switch all call
it and the next send `--resume`s the same conversation, so agents outlive the process.

- The identity maps (`originByTaskId`, run aliases, run counts) are NEVER cleared on `cancel()`; they live as long
  as the `ClaudeSession` object. A new object that resumes a transcript rebuilds them from it
  (`core/services/agent-identity.ts`): a spawn result's `agentId` names the origin and each SendMessage result
  carrying `resumedAgentId` adds one run (a message to a running agent answers "queued" and starts no run). The
  seed fills gaps only, is merged before the first wire message is handled (the reap arrives before
  `system/init`), and forks are seeded too.
- **Settled when the process ends.** `ClaudeSession` tracks the tasks the current process started and not ended
  (`liveTasks`); when the process goes (cancel, crash, idle reaper) it reports each as `stopped` against its card
  and run index. A superseded run leaves them to its successor, a disposed object stays silent. The later reap has
  the same tool_use id and run index, so the reducer folds the two.
- **Stopped reads as stopped.** `deriveTaskState` returns `isStopped`: the roster dot, the card (stop glyph,
  `data-status="stopped"`) and the panel badge draw a stop differently from a finish; an agent that was stopped never
  got to answer.
- **History says `unfinished`, never `stopped`.** The history loader (`foldAgentIdentity`) gives an agent whose last
  run starts and never ends a synthetic notification with `status: 'unfinished'` and its run index. It is
  deliberately not `stopped`: session-watcher runs the same loader over sessions another CLI may still be running.
  It renders neutral (`isLoaded`, muted dot, "unfinished"); a live resume replaces it with the real reap. A
  foreground spawn ends with its own result; a notification naming an earlier run does not close the current one.
- Not fixable here: after a respawn `SendMessage{to: <name>}` fails ("No agent named ... is reachable") and only the
  raw agent id resumes. That is cli.js's name registry.

### §6 A long roster stays usable

Running is the default filter (buttons Running | All); under it a finished row that is open in the panel stays
listed, and an empty Running state offers "Show all N". The filter is local component state, a way of looking and
not a preference. The roster scrolls on its own (`TaskDetailPanel.roster`): alone it fills the panel, with entries
open it is capped at 40% of the panel, its header is sticky and a selected row scrolls into view. A row click in the
panel TOGGLES its entry (`toggleTaskInPanel`); putting the last entry away leaves the panel open on the roster,
unlike an entry's own close button (`removeTaskFromPanel`), which closes the panel with it.

### §7 Nested agents, running-only shells and a bare number

- **Every depth is listed.** A nested agent's `task_started` is on the top-level stream with `spawn_depth: 2`, but its
  spawn call lives in its parent agent's bucket (`subagentMessages[<parent origin id>]`). `useAgentRoster` walks the
  main transcript, then depth-first the bucket of every agent it finds, with a visited set against malformed
  buckets. A nested row sits under its spawner in spawn order, indented per level with a tree guide.
- **Context ancestors.** Under the Running filter a finished ancestor of a running or open row is kept
  (`data-context="true"`, drawn like any row) so a row never floats without its parent; it is not counted as running
  and offers no Stop, but opens on click.
- **Dot and number.** The pill and the tab show a dot and a BARE number, no noun: while anything runs, the running
  count (agents at every depth plus running shells, so a lone shell lights the pill); otherwise the session's agent
  total. The tooltip and `aria-label` carry the breakdown. The tab adds the longest clock.
- **Background shells: running only.** A shell row exists only while it runs: its `activeTasks[id]` exists, its
  `taskType` is `local_bash` and `isBackgrounded` is `true` (a foreground Bash registers `false` at every depth, so
  the flag alone means "running in the background"). Only Claude reports shell lifecycles, so only Claude lists
  shells; a reopened session lists none. A finished shell whose entry is open stays listed until it is put away.
  A subagent's background command also records its output file (`recordBackgroundOutput`) so its entry can tail it.
- **Opening a nested row.** `findTaskBlocks` searches the main transcript, then the first bucket holding the call; a
  nested entry renders `subagentMessages[<its id>]`.
- **Stop guard.** A nested row or entry offers Stop only when `activeTasks[id]` exists; without a record Claude's
  `stopTask` would fall back to `interrupt()` and abort the main turn.
- **A nested row with no lifecycle record cannot outlive its parent.** In tree assembly, top-down: a row at depth > 0
  with no `activeTasks` entry and no terminal event whose parent is not running is not running, and without a
  result it settles neutral (`isLoaded`), never "done": a row nothing reported on must not claim it finished. A row
  WITH a record is never touched (a Claude agent running on after its parent went idle is what this shows). Nested
  rows without lifecycle events are best-effort.
- **History.** `loadSessionHistory` reads every sidecar in `subagents/` and attributes each nested agent that names
  a `parentAgentId`; agents without a sidecar (older CLIs) stay unlisted; historical rows never read running.
- **Per engine.** opencode: a subagent may call the `subagent` tool when `experimental.subagent_depth` > 1 (default 1) and its
  agent's permissions allow. pi: ClaudeUI's child processes load no `-e` extension, so pi's `subagent` cannot recurse; an
  extension-spawned grandchild stays inside that extension's tool result and its row settles by the rule above.

### §8 An opencode run's end

On opencode 2.x a run's terminal notification comes from the ADR-111 §3 task lifecycle mapper (opencode.md), not
from a session error. A failed TaskCard with subagent output shows the tool result's error text
(`TaskCard.failureSummary`), with the subagent's output still in the body.

### §9 The roster on a narrow screen

The overlay and cards never use viewport units: under the app's CSS `zoom` (`uiFontScale`) `vw` lengths are
multiplied by the zoom, so the overlay is `w-[420px] max-w-full` (a percentage resolves against the composer, which
is already laid out in zoomed px; ADR-093). The Task card (`@container/taskcard`, 480px) sheds the word "Task"
under 480px and its clock under 300px, turns "Open in panel" into an icon and shows the yellow "background" chip as
an icon, all by container query, never a viewport one. The card lives in the chat list, which is zoomed by
`chatFontScale`, so layout tests use the zoom and container chain of the surface they test (roster at `uiFontScale`
1, 1.1, 1.25, 1.5; card at the same `chatFontScale` values). The roster's two-shape row and 480px split are
superseded by §10; the type badge became a letter tile (ADR-094).

### §10 One tree, one line

- **One tree, no sections.** The list has no headings and no per-section folds. A background shell sits under the
  agent whose transcript holds its Bash call (`findTaskBlocks` returns `ownerToolUseId`; `listShells` carries it),
  one level deeper. Order within a parent: child agents each followed by their own subtree, then that parent's
  shells. Shells launched by the main session, or whose owner is not a row, come after all top-level agents at depth 0. `rows` is the unified depth-first list; `agents`, `shells` and the counts are unchanged. Under Running a running
  shell under a finished agent keeps that agent and its ancestors as context rows; the header counts running rows
  only.
- **Label.** An agent's label is its `name` when the spawn call gave one that differs from the type (or it is a
  dispatch), recorded as `hasExplicitName`; otherwise the description labels the row, because the `name` is only a
  shared type fallback ("Explore"). A shell's label is its whole command in monospace. `agentRowLabel` is the one
  place these rules live. The description line is gone; it is the label's `title` tooltip.
- **One line at every width**, in this order: tree guide, dot, a 16px type column (tile for a typed agent, empty for
  the default type, a `$` glyph for a shell), label, `resumed` chip (always the `N` form), spacer, Stop (running rows
  only), metrics. Shrink priority when narrow: dot, type column, chip and Stop never shrink; metrics first (3rem
  floor), the label last (4.5rem, 3rem under 300px of roster width). Under 360px of roster width (the container's,
  never the viewport's) the metrics drop the current tool name; 400 was wrong because the default side panel is
  399px wide. A row must not overflow at any roster width of 240px or more, and every row has the same height
  whether or not it runs.
- **Stop is inline before the metrics, red** (`bg-danger/10 text-danger`), 16px tall. Accepted cost: Stop has no
  fixed x, so a column of Stops cannot be run down by eye; a reserved column would cost every finished row ~42px.
  Its show condition: running, not context, depth 0 or a lifecycle record; it stops propagation.
- **A running shell has a live clock** counted from its record's `startedAt` (`useTicker`, `taskElapsedLabel`),
  ticking once a second only while a running shell is listed. The shell entry (`BashBackgroundEntry`) shows the whole
  command, a "launched by" button that opens the owning agent's entry, the call's description and a Copy button.

### §11 The row's dot is the session dot, and a row knows its model

- **Dot.** A row's dot is the sidebar's `StatusDot` (ADR-095): the agent's own work in progress ripples green; a
  finished agent with something still running below it (`runningDescendants`: nested agents or nested shells) is
  steady green, with a title saying how many still run; finished with nothing below, stopped by the user and loaded
  from history are steady grey (told apart by title and `data-status`); failed is steady red. There is NO yellow: a
  stop is not a warning and a permission ask raises its own prompt. A failed or stopped agent keeps its own dot
  whatever runs below it. A dispatch queued behind an earlier unfinished call of the same assistant message (Claude
  Code runs MCP calls one at a time) is a `queued` row with a grey dot. Rows are never dimmed for being finished or
  for being context rows. Running descendants need lifecycle records, so they appear for Claude Code and pi; opencode
  rows without any stay green while anything under them runs.
- **Model.** A subagent's assistant messages carry the model they ran on (`ChatMessage.model` as the engine reports
  it), set by every builder of a message id, live and on history load, because the reducer keeps a re-sent message's
  own fields and merges only `content`. The roster and Task card resolve a row's model, first match wins: the newest
  subagent message that has one (an error row without one does not clear it); the task view's model; a dispatch row
  uses its actual model, else the requested `dispatch.model`.
