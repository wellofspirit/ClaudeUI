# Component Test Handoff — Status: **Core complete, follow-ups open**

All components with business logic have the FC/View split + Layer 2 component tests. Two review rounds hardened the coverage and fixed several bugs. A small list of deliberate follow-ups is tracked in [Outstanding work](#outstanding-work) at the bottom of this file.

Latest `bun run test:ci`: **2182 / 2182 passing** (137 test files).

## Testing Pattern

Every FC/View split component follows this pattern:

1. Mock the View module to capture props (`vi.mock('../View', ...)`)
2. Render the FC with `@testing-library/react`
3. Call View prop callbacks (`viewProps.onSend()`, etc.)
4. Assert IPC calls (via TestIpcBridge) + Zustand store mutations

Low-value components (minimal logic, no FC/View split) use **Option B — DOM interaction**: render the component, `screen.getByText()` / `fireEvent.click()` to trigger handlers.

## Completed (all 29 components)

### High Value — FC/View split + component test

| Component            | Test File                                                                          | Tests |
| -------------------- | ---------------------------------------------------------------------------------- | ----- |
| Sidebar              | `Sidebar/__tests__/Sidebar.component.test.ts`                                      | 20    |
| SettingsDialog       | `SettingsDialog/__tests__/SettingsDialog.component.test.ts`                        | 6     |
| PermissionsDialog    | `PermissionsDialog/__tests__/PermissionsDialog.component.test.ts`                  | 11    |
| McpDialog            | `McpDialog/__tests__/McpDialog.component.test.ts`                                  | 12    |
| AutomationConfig     | `automation/AutomationConfig/__tests__/AutomationConfig.component.test.ts`         | 7     |
| AutomationList       | `automation/AutomationList/__tests__/AutomationList.component.test.ts`             | 6     |
| AutomationRunHistory | `automation/AutomationRunHistory/__tests__/AutomationRunHistory.component.test.ts` | 6     |
| RemoteAccessModal    | `RemoteAccessModal/__tests__/RemoteAccessModal.component.test.ts`                  | 7     |
| ToolCallBlock        | `chat/ToolCallBlock/__tests__/ToolCallBlock.component.test.ts`                     | 9     |

### Medium Value — FC/View split + component test

| Component            | Test File                                                                    | Tests |
| -------------------- | ---------------------------------------------------------------------------- | ----- |
| WorktreesModal       | `WorktreesModal/__tests__/WorktreesModal.component.test.ts`                  | 3     |
| QuitWorktreeModal    | `QuitWorktreeModal/__tests__/QuitWorktreeModal.component.test.ts`            | 4     |
| WorktreeCleanupModal | `WorktreeCleanupModal/__tests__/WorktreeCleanupModal.component.test.ts`      | 4     |
| WelcomeScreen        | `WelcomeScreen/__tests__/WelcomeScreen.component.test.ts`                    | 3     |
| TaskDetailPanel      | `TaskDetailPanel/__tests__/TaskDetailPanel.component.test.ts`                | 4     |
| TerminalPanel        | `terminal/TerminalPanel/__tests__/TerminalPanel.component.test.ts`           | 5     |
| XTermInstance        | `terminal/__tests__/XTermInstance.component.test.ts`                         | 4     |
| PlanReviewPanel      | `plan/PlanReviewPanel/__tests__/PlanReviewPanel.component.test.ts`           | 5     |
| PlanReviewBar        | `plan/PlanReviewBar/__tests__/PlanReviewBar.component.test.ts`               | 4     |
| AskUserQuestionBlock | `chat/AskUserQuestionBlock/__tests__/AskUserQuestionBlock.component.test.ts` | 3     |
| SkillsDialog         | `SkillsDialog/__tests__/SkillsDialog.component.test.ts`                      | 5     |
| WindowControls       | `WindowControls/__tests__/WindowControls.component.test.ts`                  | 4     |

### Low Value — DOM interaction tests only (no FC/View split)

| Component      | Test File                                           | Tests | Notes                                                       |
| -------------- | --------------------------------------------------- | ----- | ----------------------------------------------------------- |
| BtwCard        | `chat/__tests__/BtwCard.component.test.tsx`         | 3     | `clearBtw` store action                                     |
| FloatingError  | `chat/__tests__/FloatingError.component.test.tsx`   | 2     | Error dismiss via store                                     |
| AgentTabBar    | `chat/__tests__/AgentTabBar.component.test.tsx`     | 5     | `setFocusedAgent`, stop task, monitor, non-running negative |
| TodoWidget     | `__tests__/TodoWidget.component.test.tsx`           | 3     | Reads todos, expand toggle                                  |
| GitChangesPill | `git/__tests__/GitChangesPill.component.test.tsx`   | 3     | `openGitPanel` / `closeGitPanel` toggle                     |
| PluginWebView  | `plugin/__tests__/PluginWebView.component.test.tsx` | 3     | WebView lifecycle, preload path                             |

### Skipped (no meaningful logic beyond store read)

- **MermaidDiagram** — only reads `settings.theme` from store; zoom state is pure UI. Snapshots/unit tests cover render.
- **SessionItem** — context menu actions (rename, pin, watch) are fully exercised by `Sidebar.component.test.ts`.

### Pre-existing (unchanged)

| Component         | Test File                                                             | Tests |
| ----------------- | --------------------------------------------------------------------- | ----- |
| InputBox          | `chat/InputBox/__tests__/InputBox.component.test.ts`                  | 34    |
| GitCommitBox      | `git/__tests__/GitCommitBox.component.test.ts`                        | 29    |
| ExitPlanModeCard  | `chat/__tests__/ExitPlanModeCard.component.test.ts`                   | 16    |
| FloatingApproval  | `chat/__tests__/FloatingApproval.component.test.tsx`                  | 20    |
| GitFileTree       | `git/GitFileTree/__tests__/GitFileTree.component.test.ts`             | 12    |
| GitBranchDropdown | `git/GitBranchDropdown/__tests__/GitBranchDropdown.component.test.ts` | 18    |
| GitFileDiffView   | `git/GitFileDiffView/__tests__/GitFileDiffView.component.test.ts`     | 9     |
| GitPanel          | `git/GitPanel/__tests__/GitPanel.component.test.ts`                   | 8     |
| TeamsView         | `TeamsView/__tests__/TeamsView.component.test.ts`                     | 5     |
| ReviewBar         | `git/ReviewBar/__tests__/ReviewBar.component.test.ts`                 | 17    |

## Test Infrastructure Reference

- **TestIpcBridge:** `src/test/bridges/test-ipc-bridge.ts` — `handle()` uses `Map.set`, so re-registering a channel handler silently overrides the earlier one (last-wins). Keep this in mind when a test re-registers on top of a `beforeEach` stub.
- **bootTestApp:** `src/test/helpers/boot-test-app.ts` — creates bridge + `window.api`
- **Factories:** `src/test/factories/messages.ts` — `makePendingApproval`, `resetFactoryCounter`
- **Git IPC envelope:** All `git:*` channels use `unwrap` → handlers must return `{ ok: true, data: ... }`
- **Session IPC:** `session:*` channels return values directly (no envelope)
- **Worktree/MCP IPC:** `worktree:*`, `mcp:toggle`, `mcp:reconnect`, `mcp:set-servers` use `unwrap` envelope
- **Vitest config:** Component tests in `vitest.config.ts` → project `component`, jsdom, globals=true

## Notes from the refactor

- **PermissionsDialog useEffect bug fix:** The original `activeTab` dependency in the tab-reset effect forced the tab back to `initialTab` whenever the user changed tabs. Fixed by removing `activeTab` from the effect's dependency array.
- **PermissionsDialog listDir IPC lift:** `AddRuleInput` previously called `window.api.listDir` directly from within `View.tsx` (guide violation). Lifted to FC via an `onListDir` prop threaded through `RuleSection` / `DirectoriesSection`. Also replaced the `RulePill` `setState`-in-effect with an explicit `startEditing` handler.
- **TaskDetailPanel resolveEntry lift:** The View's `PanelEntry` previously did its own `useActiveSession((s) => s.messages)` + `findTaskBlocks` to pick between `BashBackgroundEntry` / `TaskEntry`. FC now resolves a `TaskEntryDescriptor[]` (`{ toolUseId, kind: 'bash-background' | 'task' | 'missing' }`) and passes it as a prop.
- **TaskDetailPanel `findTaskBlocks` bug fix:** The helper filtered out `role !== 'assistant'` messages, which meant `resultBlock` was always null because `tool_result` blocks live in synthetic `role: 'user'` messages (see `session-store.addToolResult`). `TaskEntry`'s "completed" rendering never fired. Fixed to accept `tool_result` from either role while still restricting `tool_use` to assistant. Regression test lives in `TaskDetailPanel/__tests__/utils.test.ts`.
- **SkillsDialog stale-skills regression fix:** The FC now clears `skills` state on close and on cwd change so a reopen with a different cwd can't flash the previous cwd's list.
- **ToolCallBlock theme prop:** `LiveBashOutput` previously called `useSessionStore` directly inside the View. Threaded `theme` as a prop from FC. `BackgroundBashOutput` still owns its store reads and `readBackgroundRange` IPC — documented escape valve since its lifecycle (watch / unwatch, chunked load-earlier paging) is tightly self-contained.
- **SettingsDialog split inversion fix:** `search`, `activeSection`, and `filteredSections` moved to the FC so they're testable. DOM refs + scroll-spy effect + `scrollIntoView` stay in the View (they need refs).
- **AutomationList / AutomationRunHistory silent-IPC-failure fix:** Both now `.catch()` failed IPC calls and fall back to empty-state (`setRuns([])`, `setRunMessages([])`) so the UI escapes the "Loading..." state. Failure paths tested.
- **TerminalPanel directory:** Moved from flat `terminal/TerminalPanel.tsx` to `terminal/TerminalPanel/` to host the FC/View split.
- **boot-test-app.ts additions:** Added `deleteSession` and `deleteProject` to the test `ClaudeAPI` so Sidebar's delete flow is exercisable.
- **ToolCallBlock sub-components:** `LiveBashOutput`, `BackgroundBashOutput`, `ToolInput`, `ToolResult`, `WriteResult` stay inline in `View.tsx`. `BackgroundBashOutput` owns its own store reads and IPC calls — pragmatic escape valve (see above).
- **AutomationList effect escape valve:** The View's `AutomationListItem` has a `useEffect` that calls `onLoadRuns()` when `expanded` flips. The IPC lives in the FC, but the trigger is bound to local UI state. Documented inline with a comment citing `BackgroundBashOutput`'s pattern.
- **XTermInstance:** No meaningful FC/View split possible; it's a thin xterm wrapper. Instead, the component test mocks `@xterm/xterm` and `@xterm/addon-fit` to verify the IPC wiring (writeTerminal on input, term.write on event, resizeTerminal on fit).

## Outstanding work

Items deliberately not addressed in this refactor pass. Each has a rationale and an estimated effort.

### Guide violations (low priority / pre-existing)

1. **`InputBox/View.tsx` `StatusLine` sub-component reads store directly.** Same anti-pattern as `BackgroundBashOutput` (independent subscription to `availableModels`, `selectedModel`, `statusLineAlign`, `statusLineTemplate`) but without a documented escape-valve justification. Pre-existing; discovered mid-review and out of scope here. Fix options: thread the four fields as props from the InputBox FC, or add an explicit comment matching the `BackgroundBashOutput` pattern.

2. **`PermissionsDialog/View.tsx` `AddRuleInput` still has `setState` inside a `useEffect`** for the directory-listing response (`setDirEntries`, `setDirIsRoot`, `setSelectedIndex` at lines ~170–185). This is lint-flagged as `react-hooks/set-state-in-effect` but is the canonical "synchronize state with external async result" pattern. The effect responds to prop changes (`dirPortion`, `isAbsolutePath`) and there's no cleaner rewrite without adopting a `useQuery`-style hook. Left as-is.

3. **`AutomationRunHistory.tsx:17–24`** — `setRunMessages` appears in `useEffect` deps. Zustand action refs are stable, so this is harmless, but eslint may continue to flag it. Swap to `useAutomationStore.getState().setRunMessages` inside the effect if the noise becomes annoying.

### Architectural follow-ups (not correctness bugs)

4. **No `React.memo` on any `View.tsx`.** With FCs passing arrays, objects, and inline callbacks through, every store tick that the FC subscribes to triggers a full View re-render. `ToolCallBlock/View.tsx` is the biggest offender because streaming chat ticks the FC constantly. Needs a profiling pass to identify which Views actually thrash; the fix (wrap in `memo` + `useCallback` the handlers) is mechanical once the hot Views are known.

5. **`TaskDetailPanel/View.tsx` resize state machine.** `ratios`, `handleResizeMouseDown` with `MIN_RATIO` clamping, mousemove/mouseup lifecycle all live in the View. Arguably business logic; the guide explicitly allows layout/animation state in Views so this is borderline. Tests currently don't cover the clamp arithmetic or pointer-capture cleanup — worth extracting the clamp into a pure helper if that branch ever breaks.

6. **`PlanReviewPanel/View.tsx` `handleStartComment` / `handleSaveComment`.** Orchestrate text selection → `commentingSelection` draft → parent `onSaveComment`. The draft-widget open/close state is UI; the orchestration around it is borderline business logic. FC-level tests cover `onSaveComment` directly via View prop, so no test gap, but a purist split would lift these two handlers.

### Tests not written

7. **`ToolCallBlock` 10s stop-timeout test** is wrapped with `vi.useFakeTimers()` and passes, but an integration-style test verifying the full "stop notification arrives in 9s, timer never fires" path is not written. Low value — the notification path is exercised via `useClaudeEvents` tests.

### Known pre-existing behavior not flagged by the refactor

8. **Many `react-refresh/only-export-components` warnings** remain across View files that also export types/constants. Pattern matches the existing codebase (e.g. `GitPanel/View.tsx` exports `GitPanelViewProps` alongside the component). Fix would mean shunting types to `types.ts` or `utils.ts` per component, which is more churn than it's worth. Warnings are consistent across pre- and post-refactor files.
