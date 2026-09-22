# Agent roster + task-run identity — kickoff spec

**Branch:** `agent-roster` (worktree `.claude/worktrees/agent-roster`, based on `pre-release` @ `22352f8d`).
**Design:** [ADR-073](adr/adr-073_agent-roster-and-task-run-identity.md). Mockup `3bf7d244` is the ratified visual.
**Owner rulings (2026-09-21):** tab AND pill, both settings-gated · tools drop before the pill · no unread state · close the data gaps · probe the wire before designing the fix.

This document is the single source of pending instructions for the arc. Nothing that an implementer
must do lives only in a `SendMessage`. Update the Status table after every slice.

---

## 0. Standing constraints (ADR-026)

The implementing agent:

- **never** commits, `git add`s, creates branches or tags, or runs `bun install` / `bun add` / `bun remove`;
- **never** runs `bun run format` (it reformats the whole repo — 21 files last time) and never runs
  `git checkout --`, `git stash`, `git reset` or any other state-moving git command;
- **never** deletes a file it did not create (by-exclusion cleanup has wiped kickoff specs before);
- **never** self-certifies. Report exact command output, not verdicts, and name every deviation from
  this spec.

Everything else is the orchestrator's: review of every line, the commit, the push.

---

## 1. Verified facts — do not re-derive these

### 1.1 The wire (probed 2026-09-21 against `vendor/claude-cli/bun-claude.exe`, cli.js 2.1.268)

Probe: `scripts/probe-agent-resume.mjs`. Documented at `docs/protocol-cc/04-system-subtypes.md` §4.5.

Resuming a **completed** agent with `SendMessage` emits a **full second lifecycle**:

```
run 1   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…   (the Agent call)
        task_updated      task_id=aec60e185d4e7eb6d  patch={"status":"completed",…}
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…   status=completed
run 2   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…   (the SendMessage call)
        task_updated      task_id=aec60e185d4e7eb6d  patch={"status":"completed",…}
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…   status=completed
```

- `task_id` is stable across runs. `tool_use_id` is the id of **the tool call that started that run**.
- `description` keeps the original spawn's value.
- Run 2's `stream_event` partials carry the **SendMessage** id; run 2's completed `assistant`
  message carries the **original Agent** id. The output is split across both.
- `SendMessage` is a **deferred** tool at this version (needs `ToolSearch` first). Irrelevant to the
  app, relevant to anyone re-running the probe.

### 1.2 Where the current behaviour lives

| What                                                                 | Where                                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskIdMap` (agentId → toolUseId), evicted on terminal               | `src/core/services/claude-session.ts:239`, evictions at `:1431`, `:1460`, `:2488`                                                                                      |
| `handleTaskStarted` / `handleTaskUpdated` / `handleTaskNotification` | `claude-session.ts:1396` / `:1416` / `:1448`                                                                                                                           |
| subagent message emit (owner tool_use id)                            | `claude-session.ts:228`, `:1242`; tool results `:2613`                                                                                                                 |
| item-stream ownership (`ownerToolUseId`, `sealOwner`)                | `src/core/shared/sync/item-stream.ts`                                                                                                                                  |
| sync channels for the three task events                              | `src/core/shared/sync/channels.ts:216`, `:222`, `:228`                                                                                                                 |
| reducer arms/disarms `activeTasks`                                   | `src/core/shared/sync/reducer.ts:1009` (started), `:1021` (progress), `:1030` (notification)                                                                           |
| replicated state shape                                               | `src/core/shared/sync/state.ts:54-56`, `:143-145`, `:218-220`, `:285-287`                                                                                              |
| wire types                                                           | `src/shared/types.ts:960` `TaskProgress`, `:979` `TaskStartedData`, `:985` `TaskNotification`                                                                          |
| **the duplicated running predicate**                                 | `src/renderer/src/components/chat/TaskCard.tsx:118` and `src/renderer/src/components/TaskDetailPanel/TaskEntry.tsx:119`                                                |
| `.find()` on notifications                                           | `TaskCard.tsx:104`, `TaskEntry.tsx` (`bgNotification`), `ToolCallBlock.tsx:69` (background **Bash** only — single-run, unaffected, but should use the same helper)     |
| the panel and its entries                                            | `src/renderer/src/components/TaskDetailPanel/{TaskDetailPanel,View,TaskEntry,BashBackgroundEntry,utils}.tsx`                                                           |
| panel open/close + `openedTaskToolUseIds`                            | `src/renderer/src/stores/session-store.ts:2591-2609`, `rightPanel` union at `:789`                                                                                     |
| top bar + its tiers                                                  | `src/renderer/src/components/chat/ChatPanel/TopBar.tsx`, `…/top-bar-tiers.ts`, measured by `src/layout/TopBar.layout.test.tsx`                                         |
| the composer's mode tab (the pattern the agent tab mirrors)          | `src/renderer/src/components/chat/InputBox/View.tsx:525-541` (`absolute bottom-full left-3`)                                                                           |
| composer stack above the input                                       | `ChatPanel.tsx:370-372` (`QueuedMessageCard`, `BtwCard`, `InputBox`)                                                                                                   |
| `AppSettings` + defaults                                             | `session-store.ts:389` / `:463`; persisted via `saveSettings` (`:513`) into `UISettings`, which is `[key: string]: unknown` — **no migration needed for new keys**     |
| settings pages/sections                                              | `SettingsDialog/settings-pages.tsx:356-369` (Appearance groups), `settings-sections.tsx:1867+` (the Appearance section), section→page map at `settings-pages.tsx:1012` |

### 1.3 Engine coverage (all four already produce the `task` ToolView kind)

| Engine   | Spawn tool                            | Name source                    | Lifecycle events                           |
| -------- | ------------------------------------- | ------------------------------ | ------------------------------------------ |
| claude   | `Task` / `Agent`                      | `input.name` → `subagent_type` | exact (`task_started`/`task_notification`) |
| opencode | `task`                                | `subagent_type`                | none — legacy heuristic                    |
| pi       | `subagent` (`{tasks:[{agent,task}]}`) | `tasks[].agent`                | none — legacy heuristic                    |
| codex    | `collab:spawnAgent`                   | leaf of `agentPath`            | none — legacy heuristic                    |
| any      | `dispatch_agent` (ADR-033)            | `engine · model`               | synthesized notifications                  |

Normalizers: `ClaudeEngineToolMap.ts:191-204`, `OpencodeEngineToolMap.ts:154-161`,
`PiEngineToolMap.ts:204-230`, `CodexEngineToolMap.ts:141-160`.

### 1.4 Top-bar budget (from `top-bar-tiers.ts`, all measured)

Full cluster 852.4px; left floor 96px; tier 1 (worktree + branch) drops at 1000; tier 2 (the five
tools) drops at 768 = `MOBILE_BREAKPOINT`; post-tier-2 cluster 301.8px. `GitChangesPill` is never
dropped **because it is the git panel's only entry point**.

---

## 2. Out of scope

- Re-keying renderer state by `task_id` (ADR-073 §1 says why not).
- Splitting pi's N-agents-per-tool_use into N rows.
- Any cross-session view (sidebar badges) — a later slice if the owner asks.
- Unread / read tracking of any kind.
- Replying to an agent from the roster (a `SendMessage` composer). Design later; do not build.
- Touching `usage-v2`'s metering work. This branch is based on `pre-release` on purpose.
- Renaming the `rightPanel === 'task'` union member or its persisted panel-width key.

---

## 3. Slices

Each slice is one commit. Do not start the next until the orchestrator has reviewed the previous.

### S1 — Extract the lifecycle predicate (pure refactor + one real fix)

**Why first:** three call sites will otherwise each grow a resume rule.

1. New `src/renderer/src/components/chat/task-state.ts` (or `src/shared/` if the server replica needs
   it — check before choosing; renderer-only is fine if nothing in `src/core` derives it):
   ```ts
   export interface TaskLifecycleInput {
     isHistorical: boolean
     hasActiveTask: boolean
     isBackground: boolean
     hasResult: boolean
     notification?: TaskNotification
   }
   export function latestNotification(
     list: TaskNotification[],
     toolUseId: string
   ): TaskNotification | undefined
   export function deriveTaskState(input: TaskLifecycleInput): {
     isRunning: boolean
     isError: boolean
     isLoaded: boolean
   }
   ```
2. `latestNotification` returns the **last** match, not the first. This is a behaviour change and it
   is the point: it is what makes a resumed agent report the run that actually finished.
3. Rewrite `TaskCard.tsx` and `TaskEntry.tsx` to call both. Byte-for-byte same behaviour for
   single-run tasks — the legacy heuristic branch must survive unchanged (opencode/pi/codex and
   historical transcripts depend on it).
4. `ToolCallBlock.tsx:69` switches to `latestNotification` too (background Bash is single-run, so no
   behaviour change; this is about having one helper).

**Tests:** unit tests for `deriveTaskState` covering the ADR-040 matrix (active-task wins; background
without notification; foreground without result; historical) and for `latestNotification` with two
notifications for one id. Existing `TaskCard.component.test.tsx` lifecycle guards must still pass
untouched — if one needs editing, stop and report why.

### S2 — Lifecycle normalization: an agent is a `task_id`

1. `claude-session.ts`: add `originByTaskId = new Map<string, string>()`. Cleared with the session
   alongside the other per-session maps — find where `taskIdMap` is cleared and match it.
2. `handleTaskStarted`:
   - first `task_started` for a `taskId` → record origin, behave exactly as today;
   - subsequent one with a different `tool_use_id` → **resume**: register `runToolUseId → origin`
     in a `runAliasByToolUseId` map, and emit `session:task-started` with `toolUseId = origin`,
     plus new payload fields `runToolUseId: string` and `runIndex: number` (1-based).
3. `taskIdMap` keeps its current role, but `handleTaskNotification` / `handleTaskUpdated` /
   `stopTask` must **not** evict `originByTaskId`. Re-read `:1431`, `:1460`, `:2488` and change only
   the origin map's lifetime — `taskIdMap`'s eviction stays as it is unless a test proves otherwise.
4. Alias on the way out: wherever a subagent message, subagent tool result or item-stream owner is
   emitted with a tool_use id (`:228`, `:1242`, `:2613`, and the item-stream owner path), resolve
   through `runAliasByToolUseId` first so run 2 lands on the origin card. `sealOwner` likewise.
5. `handleTaskUpdated`: a **non-terminal** status for a task id with a known origin re-arms the task.
   Keep the terminal-only early return for the states it already handles; add the re-arm before it.
6. Types + channels + reducer: `TaskStartedData` gains `runToolUseId?`/`runIndex?`;
   `channels.ts` entries updated; the reducer stores `runIndex` on the `activeTasks` value (and keeps
   the last one seen for a finished task so the card can still say "resumed ×2"). `state.ts` snapshot
   fields follow — a remote client that syncs mid-resume must see the running state.
7. `TaskCard` renders a `resumed ×N` marker when `runIndex > 1`. The `SendMessage` detail card gets
   no running state (it is not a task); leave it alone this slice.

**Tests (guard tests — each must be shown failing against the pre-fix code):**

- a second `task_started` for a known task id arms `activeTasks` under the **origin** id, not the new one;
- a subagent message arriving under the run id is stored under the origin id;
- `task_notification` for run 2 disarms the origin id and is the one `latestNotification` returns;
- a **first** `task_started` for an unknown task id behaves exactly as before (no aliasing);
- opencode/pi/codex tasks (no `task_started` at all) are untouched.

Write them as component/unit tests against the session layer and reducer — not integration.

### S3 — Close the data gaps

1. `ToolView` `task` gains `name?: string` (`src/shared/tool-kinds.ts:72-79`). Fill it in all four
   normalizers per §1.3. Claude: `input.name` first, then `subagent_type`. pi: join `tasks[].agent`.
   Codex: the leaf segment of `agentPath`. Do not change the existing `subagent` field's meaning.
2. `TaskProgress` (`types.ts:960`) gains `usage?: {totalTokens; toolUses; durationMs}` and
   `lastToolName?: string`; populate from `task_progress`'s `usage` / `last_tool_name` in the
   handler that builds it. Claude-only; other engines simply never set it.
3. `TaskCard`'s header may show the name when present. Keep it subordinate to the description.

**Tests:** normalizer unit tests per engine asserting `name`; one reducer test that a `task_progress`
with usage lands in `taskProgressMap`.

### S4 — The roster: selector, row, panel

1. `useAgentRoster()` (renderer hook, next to the store): scans `messages` for `tool_use` blocks
   whose `engineToolMap(engineId).kindOf(toolName)` is `task`, in transcript order, joins each to
   `activeTasks` / `latestNotification` / `taskProgressMap`, and returns
   `{ agents: AgentRow[]; shells: AgentRow[]; runningCount: number; totalCount: number }`.
   **Memoize on `messages` identity** — a `task_progress` tick must not re-scan the transcript.
   Background shells = `kindOf === 'command'` with `run_in_background` (same test
   `TaskDetailPanel.tsx:24` already uses).
2. `AgentRow` component — one component used by the panel roster and the overlay. Status dot,
   name (fallback `subagent_type`), engine chip, description, `lastToolName · elapsed`, Stop when
   running. Mockup `3bf7d244` §"Shared: the agent row" is the reference, minus every amber element.
3. `TaskDetailPanelView` gains a roster header above the entry stack: counts, an All/Running segmented
   toggle (local `useState`, not persisted), then the two sections. A row click calls the existing
   `openTaskPanel`/selection path so the entry opens below. Empty sections render nothing.

**Tests:** component tests for the selector (mixed engines, a resumed agent, a background shell) and
for the panel roster's filter toggle. `data-testid`s per ADR-027: `AgentRoster`, `AgentRoster.row`,
`AgentRoster.filter`, `AgentRow.status`, `AgentRow.stop`.

### S5 — The two surfaces

1. **Tab** — `AgentTab` rendered inside `InputBox/View.tsx`'s relative wrapper as the mirror of the
   mode tab: `absolute bottom-full right-3`, same padding/rounding/type scale. Visible only when
   `runningCount > 0` **and** the setting is on. Click toggles an overlay anchored
   `absolute bottom-full right-0` — follow `SlashCommandMenu`/`FileMentionMenu`'s positioning, and
   close on Escape and outside click. A row click closes the overlay and opens the panel on that agent.
2. **Pill** — `AgentPill` in `TopBar.tsx`'s right cluster, beside `GitChangesPill`, **with no tier
   class and no `⋯` row** (it is never dropped, like the changes pill). Visible when
   `totalCount > 0` and the setting is on; accent + live count while running, muted total when not.
   Click toggles the panel (`rightPanel === 'task'`).
3. `top-bar-tiers.ts`: update the measured-numbers comment block with the pill's real measured width
   and the new tier-1 threshold, then change `TIER1_HIDE`/`TIER1_ROW_HIDE` to match. **Measure, do not
   guess** — `TopBar.layout.test.tsx` renders the real bar in Chromium; extend its fixture with the
   pill, read the number it reports, and write that number. If the measured cluster says a different
   threshold than ~1110, the measurement wins and this spec is wrong.

**Tests:** `TopBar.layout.test.tsx` extended (pill present at every width down to the mobile
breakpoint; tier-1 members still gone below the new threshold); component tests for tab visibility
(running vs not, setting off) and the overlay's open/close/row-click. `data-testid`s: `AgentPill`,
`AgentPill.count`, `AgentTab`, `AgentOverlay`, `AgentOverlay.row`.

### S6 — Settings

Two booleans in `AppSettings` (`session-store.ts:389`) + `DEFAULT_SETTINGS` (`:463`), both `true`:
`showAgentPill`, `showAgentTab`. A new `agents` section in `settings-sections.tsx` and a matching
group on the Appearance page in `settings-pages.tsx` (after `layout`), section→page entry at
`settings-pages.tsx:1012`. Copy from mockup `3bf7d244` §3. No persistence work — `UISettings` is an
open bag.

**Tests:** a settings-dialog component test that both rows render under Appearance and toggle the
store; a test that each surface disappears when its setting is off.

---

## 4. Gates

Per slice: `bun run typecheck && bun run test && bun run lint`.
Before the arc's final commit: add `bun run test:ci` and `bun run build`.
Report exact output. The orchestrator re-runs `typecheck` itself and at least one guard check per slice.

Real-app verification (orchestrator dispatches a separate verifier, `verifier-electron`): spawn two
agents in a live Claude session, assert `AgentPill`/`AgentTab` in the live DOM, open the overlay and
the panel, then resume a finished agent with `SendMessage` and assert the card re-arms. Screenshots
last, DOM first.

---

## 5. Gotchas

- The dev main process goes stale behind the hot-reloaded renderer: **restart the app** after any
  `src/core` / `src/main` change or you will be testing new UI against old lifecycle logic.
- `vendor/` is gitignored and absent in a fresh worktree — `bun run ensure-cli` before running the
  probe or any integration test that spawns Claude. (Do **not** run `bun install`.)
- Never `taskkill bun-claude.exe` by name; you will kill the session driving the work.
- `activeTasks` rides the remote snapshot. Any field added to it must be added in all four places in
  `state.ts` or a remote client silently loses it.
- The legacy heuristic is load-bearing for three engines and every historical transcript. A refactor
  that "simplifies" it away will look green in tests written around Claude.
- pi's parallel `subagent` call is one tool_use id for N agents — one row, by design (ADR-073 §3).

---

## 6. Suggested commits (one per slice)

- `refactor(chat): one task-lifecycle predicate, and read the latest notification`
- `fix(claude): a resumed agent re-arms the card that spawned it`
- `feat(chat): agent names and live task usage reach the view layer`
- `feat(chat): an agent roster in the task panel`
- `feat(chat): an agent pill and a composer tab for the roster`
- `feat(settings): appearance toggles for the agent pill and tab`

---

## 6b. What is left

**Real-app verification has not been run.** Every gate that can run without installed dependencies
is green, but driving the actual Electron app needs `electron` and a correctly-ABI'd
`better-sqlite3` in THIS worktree. Node's ancestor resolution covers imports — which is why
typecheck, vitest and `electron-vite build` all work here with no local `node_modules` — but not
`node_modules/.bin` lookups, which is also why `bun run build`'s `ensure-cli` stage cannot run here.
Two ways forward, both needing an owner decision:

- junction the main checkout's `node_modules` into the worktree: instant, but the two checkouts
  would then share `node_modules/.vite`, and the main checkout is where the metering arc is live;
- `bun install` in the worktree followed by `bun run rebuild:native` (mandatory — bun leaves a
  Node-ABI `better-sqlite3` that crashes the app on boot).

The brief when it runs: assert `AgentPill`, `AgentTab`, `AgentOverlay`, `AgentRoster` and `AgentRow`
in the live DOM; spawn two agents; then resume a finished one with `SendMessage` and check the card
re-arms and shows `TaskCard.resumed`.

## 6a. Deviations from this spec, and why

- **S2 does not re-arm on a non-terminal `task_updated`.** The spec asked for it as a second path
  into the re-arm. The probe then showed `task_started` IS re-emitted on every resume, making the
  `task_updated` path redundant — and it is not harmless: `task_updated` is a patch diff that fires
  on transitions we do not enumerate, so a non-terminal patch arriving after a notification (or out
  of order) would strand a finished card as "running" forever, which is worse than the bug being
  fixed. The authoritative signal is handled; the speculative one is not.
- **S3 was larger than written.** The spec said `TaskProgress` "discards" the wire's usage. In fact
  `system/task_progress` had no handler at all — what the session consumes is the unrelated
  `tool_progress` message. Handling it meant a new handler plus a merging reducer.

## 7. Status

| Slice                           | State        | Commit                 | Notes                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probe + ADR-073 + protocol §4.5 | done         | `411d5250`, `4331bc21` |                                                                                                                                                                                                                                                               |
| S1 predicate extraction         | done         | `231f37b1`             | Also fixed TaskEntry's isError, which missed a failed async-launched agent                                                                                                                                                                                    |
| S2 lifecycle normalization      | done         | `d0ce1773`             | DEVIATION: no `task_updated` re-arm — see below. Also fixed `stopTask`, which after a resume missed and aborted the whole turn                                                                                                                                |
| S3 data gaps                    | done         | `6d8bf24b`             | `system/task_progress` was not handled AT ALL; the progress reducer now merges two sources                                                                                                                                                                    |
| S4 roster                       | done         | `b54116c5`             | Also made a terminal notification settle a FOREGROUND task (ADR-040 calls it authoritative; the foreground branch ignored it)                                                                                                                                 |
| S5 pill + tab                   | done         | `cb4f8d80`             | Tier 1 re-measured 1000 → 1100; `AgentPill` is 81.6px; cluster floor 302 → 396                                                                                                                                                                                |
| S6 settings                     | done         | `1e434353`             |                                                                                                                                                                                                                                                               |
| Gates                           | green        | —                      | typecheck, lint, `test:ci` (772 files / 14398 tests), layout (16), `electron-vite build`                                                                                                                                                                      |
| Rebase onto pre-release         | done         | 2026-09-22             | typecheck, lint, `test:ci` (786 files / 14948 tests) re-run green after the rebase; the layout project S5 measured with was removed from pre-release with its CI job, so `TopBar.layout.test.tsx` is gone and the measured numbers live in `top-bar-tiers.ts` |
| Real-app verification           | **NOT DONE** | —                      | needs deps in this worktree — see §6b                                                                                                                                                                                                                         |
