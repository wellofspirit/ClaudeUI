# Component Split Handoff

Audit of all 66 component files against the [component guide](component-guide.md) FC/View split criteria. Components that read Zustand store state AND call IPC or mutate the store need splitting.

**Already split:** InputBox, ToolCallBlock, FloatingApproval (flat file with internal FC/View split).

## Tier 1: High Priority (large files, many mixed concerns)

### Sidebar.tsx — 1581 lines
**Why:** 15 store selectors, 14 IPC methods, 12 store mutations, 10 inline sub-components. The single worst offender in the codebase.

**Split plan:**
- `Sidebar/Sidebar.tsx` — FC: store reads, session lifecycle handlers (create, switch, load, pin, rename)
- `Sidebar/View.tsx` — layout shell rendering directory list + session list + nav + bottom panel
- `Sidebar/SessionItem.tsx` — extract inline component (currently mixes rename IPC + store mutations)
- `Sidebar/DirectoryItem.tsx` — extract inline component
- `Sidebar/SettingsPanel.tsx` — extract to its own file (reads `settings`, calls `updateSettings`)
- `Sidebar/UsagePanel.tsx` — extract (reads `accountUsage`, `blockUsage`); merge `UsageRing` and `UsageProgressBar` into it
- `Sidebar/utils.ts` — session title-generation/rename flow is a multi-step async state machine worth testing

**Extractable hooks:**
- `useSessionListData(activeSessionId, directories, ...)` — derives visible sessions, pinned/recent ordering

**Test targets:**
- Layer 1: utils (rename flow decisions)
- Layer 2: session switch → store state, pin/unpin → store state, rename → IPC + store

---

### SettingsDialog.tsx — 1680 lines
**Why:** Reads `settings` + `updateSettings`, calls `window.api.getVersionInfo`, `testProxyConnection`, `loadClaudePermissions`. 7 inline sub-components.

**Split plan:**
- `SettingsDialog/SettingsDialog.tsx` — FC: reads `settings`, `updateSettings`, mounts effects
- `SettingsDialog/View.tsx` — tab layout, search filter, scroll tracking, section rendering
- `SettingsDialog/settings-sections.ts` — extract the `SECTIONS` config data structure (~500 lines of section definitions). This is a pure data table mapping setting keys to labels/types/options — no store access needed.
- `SettingsDialog/ProxyTestButton.tsx` — extract (calls `window.api.testProxyConnection`)
- `SettingsDialog/GlobalPermissionsSummary.tsx` — extract (reads `cwd` via `useActiveSession`, calls `window.api.loadClaudePermissions`)

**Notes:** The `SECTIONS` extraction alone removes ~500 lines from the main file. Most sub-components (`SettingsToggle`, `SettingsSlider`, `SettingsSelect`, `InfoTooltip`) are purely presentational helpers — they can stay in View.tsx or a shared `settings-controls.tsx`.

**Test targets:**
- Layer 2: settings update → IPC persistence, proxy test flow

---

### ChatPanel.tsx — 858 lines
**Why:** 10 store selectors, IPC calls (`dequeueMessage`, `createWorktree`, `pickFolder`, `openInVSCode`), 4 store mutations, 5 inline sub-components.

**Split plan:**
- `ChatPanel/ChatPanel.tsx` — FC: store reads, message list derivation, scroll management
- `ChatPanel/View.tsx` — message list rendering, floating overlays, welcome/loading states
- `ChatPanel/TopBar.tsx` — extract (reads session metadata + cwd, calls `openInVSCode`, `createWorktree`)
- `ChatPanel/WelcomeState.tsx` — extract (calls `pickFolder`, `createNewSession`)
- `ChatPanel/QueuedMessageCard.tsx` — extract (calls `dequeueMessage`, mutates `clearQueuedText`)

**Extractable hooks:**
- `useAutoScroll()` — ~100 lines of MutationObserver + scroll position tracking. Pure scroll coordination, reusable.

**Test targets:**
- Layer 1: auto-scroll hook behavior
- Layer 2: dequeue message → IPC + store, folder pick → session creation

---

### TaskDetailPanel.tsx — 572 lines
**Why:** 11 store selectors, IPC calls (`stopTask`, `readBackgroundRange`), 6 store mutations, 5 inline sub-components.

**Split plan:**
- `TaskDetailPanel/TaskDetailPanel.tsx` — FC: store reads, task lifecycle handlers
- `TaskDetailPanel/View.tsx` — panel layout, resize handle, entry list
- `TaskDetailPanel/TaskEntry.tsx` — extract (each entry independently hooks into store + calls IPC)
- `TaskDetailPanel/BashBackgroundEntry.tsx` — extract (calls `readBackgroundRange`, manages watch/unwatch lifecycle)

**Extractable pure logic:**
- `findTaskBlocks(messages)` — pure message-search function, already exists inline

**Test targets:**
- Layer 2: stop task → IPC + store cleanup, watch/unwatch lifecycle

---

## Tier 2: Medium Priority (clear split candidates, moderate size)

### GitBranchDropdown.tsx — 451 lines
**Why:** 5 store selectors, 10 git IPC methods, 5 store mutations. Single-function component with no sub-components — all logic and rendering mixed together.

**Split plan:**
- `git/GitBranchDropdown/GitBranchDropdown.tsx` — FC: store reads, sync handlers
- `git/GitBranchDropdown/View.tsx` — dropdown rendering, branch list, sync status indicators

**Extractable hooks:**
- `useGitSync(cwd, sessionId)` — push/pull/fetch flow with upstream-prompt guard. This is a state machine (idle -> syncing -> success/error/upstreamPrompt) that appears partially duplicated in GitCommitBox.

**Test targets:**
- Layer 2: fetch/pull/push → store state updates, upstream prompt flow

---

### GitCommitBox.tsx — 383 lines
**Why:** Reads `cwd`, `gitCommitMessage`, `gitStatus`, `gitCommitMode`. Calls 10 IPC methods. Mutates 3 store actions.

**Split plan:**
- FC holds store reads + commit/push handlers
- View receives commit message, staged file count, loading/error state, mode toggle

**Extractable hooks:**
- `useGitCommit(cwd, sessionId)` — commit flow with 3 branches (commit-only vs. commit+push vs. upstream-prompt). Shares the upstream-prompt pattern with GitBranchDropdown — candidate for a shared `useUpstreamPrompt` hook.

**Test targets:**
- Layer 2: commit → IPC sequence, push with upstream prompt

---

### GitFileTree.tsx — 498 lines
**Why:** 5 store selectors, 4 git IPC methods, 2 store mutations. Contains `TreeNodeItem` sub-component.

**Split plan:**
- FC: store reads + stage/unstage/discard handlers
- View: receives `files`, `selectedFile`, callbacks. `TreeNodeItem` stays in View as a sub-component.

**Notes:** The pure tree-building utilities (`buildTree`, `flattenSingleChildDirs`, `statusBadge`, `isStaged`, `isUntracked`, `collectFiles`) are already at module level — move them to `utils.ts` and add unit tests.

**Test targets:**
- Layer 1: tree building, status badge, stage/unstage classification
- Layer 2: stage/unstage/discard → IPC + store refresh

---

### AutomationConfig.tsx — 521 lines
**Why:** Reads automation store, calls 9 IPC methods, mutates store on delete.

**Split plan:**
- `AutomationConfig` stays as the outer FC (already selects the automation from store)
- `AutomationConfigForm` becomes a View receiving `automation` as a prop (it already does, but currently calls IPC directly)
- Extract `InheritedPermissions` sub-component (calls `loadClaudePermissions` x3)

**Extractable pure logic:**
- `isDirty` derivation over 8 fields — extract as `isAutomationDirty(original, current)` in utils
- `SCHEDULE_PRESETS` data table

**Test targets:**
- Layer 1: isDirty logic
- Layer 2: save/delete/toggle → IPC calls

---

### ExitPlanModeCard.tsx — 247 lines
**Why:** 6 IPC calls (highest density of any file in the codebase), 4 store mutations, 4-branch action state machine.

**Split plan:**
- FC: store reads + 4 action handlers (`handleStartFresh`, `handleContinueAutoEdit`, `handleContinueManual`, `handleKeepPlanning`)
- View: receives action state (which buttons to show, loading indicator) + the feedback textarea

**Extractable pure logic:**
- `waitForModeChange()` is already a standalone async utility — move to utils
- The 4-branch action dispatch is a state machine worth testing

**Test targets:**
- Layer 2: each action path → IPC sequence + store state

---

### AutomationRunHistory.tsx — 185 lines
**Why:** Reads 8 store selectors, calls 4 IPC methods, mutates 3 store actions.

**Split plan:**
- FC: store reads, message loading, send/stop handlers
- View: message list + input box

**Test targets:**
- Layer 2: send message → IPC, stop/dismiss → IPC

---

### AutomationList.tsx — 221 lines
**Why:** 3-level nesting (List -> ListItem -> RunHistoryItem), each level mixes store reads with IPC.

**Split plan:**
- `AutomationList` FC stays
- `AutomationListItem` extracted to own file (reads `runs[id]`, calls `listAutomationRuns`)
- `RunHistoryItem` can stay inside `AutomationListItem` (small, tightly coupled)

**Test targets:**
- Layer 2: create automation → IPC, run history load on expand

---

### TeamsView.tsx — 182 lines
**Why:** Complex async loader in useEffect (fetch team info -> per-teammate JSONL load -> bulk store set). `AgentCard` and `MessageLine` are pure display components defined inline.

**Split plan:**
- FC: store reads + team loading effect
- View: receives `teammates`, `messages` as props. Move `AgentCard` and `MessageLine` into View.

**Extractable hooks:**
- `useTeamLoader(routingId)` — the mount effect that fetches team info + subagent history

**Test targets:**
- Layer 2: team load → store population

---

## Tier 3: Small but Meets Criteria

These components are small (80-170 lines) but technically meet the split criteria. Whether to split them is a consistency vs. pragmatism trade-off. I'd recommend splitting only if you're already touching the file for another reason.

| Component | Lines | Why it qualifies | Split worth it? |
|-----------|-------|-----------------|-----------------|
| SessionView.tsx | 298 | Store reads + `setPermissionMode` IPC + terminal creation. 4 keyboard shortcut effects. | **Yes** — extract `useResizablePanel`, `useResizableBottomPanel` hooks and keyboard shortcut effects |
| GitFileDiffView.tsx | 262 | Store reads + `gitGetFilePatch`/`gitGetFileContents` IPC + 4 store mutations | **Yes** — extract `useDiffFetch(cwd, file)` hook |
| GitPanel.tsx | 143 | Store reads + `gitGetStatus` IPC + 5 store mutations. `FilterTabs` is an embedded second violation. | **Yes** — `FilterTabs` is a hidden FC inside the file |
| XTermInstance.tsx | 169 | Store reads `theme` + 5 IPC calls (`resizeTerminal`, `writeTerminal`, `onTerminalData`). | **Partial** — extract `buildXtermTheme()` (87 lines of pure data) to `xterm-themes.ts` |
| TerminalPanel.tsx | 107 | 5 store mutations + 2 IPC calls. Tab bar JSX is a clear View extraction. | Marginal — small file, split would roughly double it |
| ReviewBar.tsx | 111 | Store reads + `createSession`/`sendPrompt` IPC + 2 store mutations. `composeReviewPrompt` is already a standalone pure function. | **Yes** — move `composeReviewPrompt` to utils, FC/View split is straightforward |
| AgentTabBar.tsx | 113 | Store reads + `stopTask`/`openTeamsViewWindow` IPC + `setFocusedAgent` mutation | Marginal — `TabButton`/`StatusDot` are already pure |
| PlanReviewPanel.tsx | 174 | Store reads + 4 store mutations (no IPC). | Marginal — store-only mutations, no IPC |
| QuitWorktreeModal.tsx | 81 | Store reads + `removeWorktree`/`confirmQuit` IPC + 2 store mutations | No — too small, split would add more overhead than clarity |

## Does Not Need Splitting

These components are either purely presentational, read store without mutating/calling IPC, or are too small.

| Component | Lines | Reason |
|-----------|-------|--------|
| MessageBubble.tsx | 352 | Purely presentational — no store, no IPC |
| BlockTimeline.tsx | 771 | Purely presentational — chart math only |
| MermaidDiagram.tsx | 582 | Reads store (theme) but no IPC/mutations. Extract `THEME_CONFIGS` to `mermaid-themes.ts` for size. |
| UsageView.tsx | 370 | Reads store (blockUsage, accountUsage) but no IPC/mutations |
| DailyUsageChart.tsx | 233 | Purely presentational |
| TokenDonut.tsx | — | Purely presentational |
| McpDialog.tsx | 997 | No store reads — IPC-only with local state. Could benefit from `useMcpServers()` hook but doesn't meet FC/View criterion. |
| PermissionsDialog.tsx | 706 | No store reads — IPC-only with local state |
| SkillsDialog.tsx | 367 | No store reads — IPC-only |
| RemoteAccessModal.tsx | 320 | No store reads — IPC-only |
| WorktreesModal.tsx | 134 | No store reads — IPC-only |
| WorktreeCleanupModal.tsx | 83 | No store reads — IPC-only |
| TodoWidget.tsx | 124 | Reads store but no IPC/mutations |
| SubagentMessages.tsx | 72 | Purely presentational |
| TodoToolBlock.tsx | 42 | Purely presentational |
| AutomationDetail.tsx | 41 | Store reads only, no mutations, routing wrapper |
| AutomationView.tsx | 46 | Too small |
| PlanCommentBadge.tsx | 135 | No store, no IPC |
| PlanCommentWidget.tsx | 106 | No store, no IPC |
| StreamingText.tsx | — | Purely presentational |
| ThinkingBlock.tsx | — | Purely presentational |
| BtwCard.tsx | — | Purely presentational |
| SandboxViolationToast.tsx | — | Purely presentational |
| SlashCommandMenu.tsx | — | Purely presentational |
| FileMentionMenu.tsx | — | Purely presentational |
| FileAttachmentBar.tsx | — | Purely presentational |
| CodeView.tsx | — | Purely presentational |
| TerminalView.tsx | — | Purely presentational |
| WindowControls.tsx | — | Purely presentational |
| WelcomeScreen.tsx | — | Purely presentational |
| DiffCommentBadge.tsx | — | Purely presentational |
| DiffCommentWidget.tsx | — | Purely presentational |
| GitBranchPill.tsx | — | Purely presentational |
| GitChangesPill.tsx | — | Purely presentational |
| WorktreePill.tsx | — | Purely presentational |
| PlanReviewBar.tsx | — | Purely presentational |
| PluginWebView.tsx | — | Purely presentational |

## Cross-Cutting Patterns Worth Extracting

These patterns appear in multiple components and could become shared hooks:

| Pattern | Appears in | Proposed hook |
|---------|-----------|---------------|
| Lazy SDK session creation (check `sdkActive`, create if needed, then send) | InputBox, ReviewBar, ExitPlanModeCard | `useEnsureSession(sessionId)` |
| Upstream push prompt (push fails with no-upstream error → prompt user → `pushWithUpstream`) | GitBranchDropdown, GitCommitBox | `useUpstreamPrompt(cwd, sessionId)` |
| Git status refresh after mutation (stage/unstage/commit/discard → re-fetch status) | GitFileTree, GitCommitBox, GitBranchDropdown, GitPanel | `useGitRefresh(cwd, sessionId)` |
| Task stop flow (setTaskStopping → stopTask IPC → clearTaskStopping on timeout) | TaskCard, TaskDetailPanel, ToolCallBlock | `useTaskStop(sessionId, toolUseId)` |
| Background output watch/unwatch lifecycle | TaskDetailPanel (BashBackgroundEntry), ToolCallBlock (BackgroundBashOutput) | `useBackgroundOutput(sessionId, toolUseId)` |

## Recommended Execution Order

Work by area to minimize context switching:

1. **Git area:** GitBranchDropdown, GitCommitBox, GitFileTree, GitFileDiffView, GitPanel, ReviewBar — share `useGitSync`, `useUpstreamPrompt`, `useGitRefresh` hooks
2. **Chat area:** ChatPanel (+ TopBar, WelcomeState, QueuedMessageCard extractions), TaskCard, ExitPlanModeCard, AskUserQuestionBlock
3. **Sidebar** — biggest single file, do after the pattern is established on smaller components
4. **SettingsDialog** — mostly data extraction (`SECTIONS`), can be done independently
5. **Task/Teams area:** TaskDetailPanel, TeamsView, AgentTabBar
6. **Automation area:** AutomationConfig, AutomationList, AutomationRunHistory
7. **Terminal area:** SessionView (resize hooks), XTermInstance (theme extraction), TerminalPanel
