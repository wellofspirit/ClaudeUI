# Component Test Handoff — Monolithic Components

Status: **Pending** — these components have business logic worth testing but no FC/View split yet.

## Testing Pattern

All FC/View split components now have component tests following this pattern:

1. Mock the View module to capture props (`vi.mock('../View', ...)`)
2. Render the FC with `@testing-library/react`
3. Call View prop callbacks (`viewProps.onSend()`, etc.)
4. Assert IPC calls (via TestIpcBridge) + Zustand store mutations

For monolithic components (no View.tsx), two approaches:

- **Option A — Split first**: Extract View.tsx, then test with the same mock-View pattern. Cleaner tests, more files touched.
- **Option B — DOM interaction**: Render the component, use `screen.getByText()` / `fireEvent.click()` to trigger handlers. Faster to write, couples tests to button labels.

## Already Tested (10 components)

| Component | Test File | Tests |
|-----------|-----------|-------|
| InputBox | `chat/InputBox/__tests__/InputBox.component.test.ts` | 34 |
| GitCommitBox | `git/__tests__/GitCommitBox.component.test.ts` | 29 |
| ExitPlanModeCard | `chat/__tests__/ExitPlanModeCard.component.test.ts` | 16 |
| FloatingApproval | `chat/__tests__/FloatingApproval.component.test.tsx` | 20 |
| GitFileTree | `git/GitFileTree/__tests__/GitFileTree.component.test.ts` | 12 |
| GitBranchDropdown | `git/GitBranchDropdown/__tests__/GitBranchDropdown.component.test.ts` | 18 |
| GitFileDiffView | `git/GitFileDiffView/__tests__/GitFileDiffView.component.test.ts` | 9 |
| GitPanel | `git/GitPanel/__tests__/GitPanel.component.test.ts` | 8 |
| TeamsView | `TeamsView/__tests__/TeamsView.component.test.ts` | 5 |
| ReviewBar | `git/ReviewBar/__tests__/ReviewBar.component.test.ts` | 17 |

---

## High Value — Heavy IPC / Store Mutations

### 1. Sidebar (`components/Sidebar/Sidebar.tsx`)

**IPC calls:**
- `window.api.loadSessionHistory(sessionId, projectKey)`
- `window.api.writeCustomTitle(sessionId, projectKey, title)`
- `window.api.listWorktrees(cwd)`
- `window.api.watchSession(routingId, sessionId, projectKey)`
- `window.api.unwatchSession(routingId)`

**Store mutations:**
- `createNewSession`, `switchSession`, `pinSession`, `unpinSession`
- `setCustomTitle`, `removeSession`, `showWelcome`
- `reorderPinnedSessions` (drag-and-drop)

**Key flows to test:**
- Create new session from directory
- Switch between sessions
- Pin/unpin sessions
- Rename session (custom title)
- Delete session
- Drag-reorder pinned sessions

---

### 2. SettingsDialog (`components/SettingsDialog/SettingsDialog.tsx`)

**IPC calls:**
- `window.api.getVersionInfo()`

**Store mutations:**
- `updateSettings(partialSettings)` — covers theme, font size, diff options, sandbox, proxy, voice, status line, git commit mode, etc.

**Key flows to test:**
- Toggle each setting category
- Search/filter settings sections
- Version info display on mount
- Settings persistence (updateSettings called with correct shape)

---

### 3. PermissionsDialog (`components/PermissionsDialog.tsx`)

**IPC calls:**
- `window.api.loadClaudePermissions(scope, cwd?)`
- `window.api.saveClaudePermissions(scope, permissions, cwd?)`

**Key flows to test:**
- Load permissions on mount for each scope (project, user)
- Add new permission rule
- Remove permission rule
- Edit permission rule
- Switch scope tabs
- Save triggers IPC with correct scope + rules

---

### 4. McpDialog (`components/McpDialog.tsx`)

**IPC calls:**
- `window.api.loadMcpServers(scope, cwd?)`
- `window.api.saveMcpServers(scope, servers, cwd?)`
- `window.api.removeMcpServer(scope, serverName, cwd?)`
- `window.api.mcpToggleServer(routingId, serverName, enabled)`
- `window.api.mcpReconnectServer(routingId, serverName)`

**Key flows to test:**
- Load server list on mount
- Toggle server enabled/disabled
- Add new server config
- Remove server
- Reconnect server
- Scope switching (project vs user)

---

### 5. AutomationConfig (`components/automation/AutomationConfig/AutomationConfig.tsx`)

**IPC calls:**
- `window.api.getModels()`
- `window.api.saveAutomation(automation)`
- `window.api.deleteAutomation(id)`
- `window.api.toggleAutomation(id, enabled)`
- `window.api.runAutomationNow(id)`
- `window.api.cancelAutomationRun(id)`
- `window.api.dismissAutomationRun(automationId, runId)`
- `window.api.pickFolder()`
- `window.api.loadClaudePermissions(scope, cwd?)`

**Store mutations:**
- `useAutomationStore` — `selectAutomation`

**Key flows to test:**
- Save automation (new + edit)
- Delete automation with confirmation
- Toggle enabled/disabled
- Run now
- Cancel running automation
- Folder picker for cwd
- Dirty state detection (unsaved changes)

---

### 6. AutomationList (`components/automation/AutomationList/AutomationList.tsx`)

**IPC calls:**
- `window.api.saveAutomation(automation)`
- `window.api.listAutomationRuns(automationId)`

**Store mutations:**
- `useAutomationStore` — `selectAutomation`, `selectRun`, `setRuns`

**Key flows to test:**
- Create new automation
- Select automation from list
- Load run history on selection
- Filter/search automations

---

### 7. AutomationRunHistory (`components/automation/AutomationRunHistory/AutomationRunHistory.tsx`)

**IPC calls:**
- `window.api.loadAutomationRunHistory(automationId, runId)`
- `window.api.sendAutomationMessage(id, prompt)`
- `window.api.cancelAutomationRun(id)`
- `window.api.dismissAutomationRun(automationId, runId)`

**Store mutations:**
- `useAutomationStore` — `setRunMessages`, `clearStreamingText`

**Key flows to test:**
- Load history on mount
- Send message to running automation
- Cancel run
- Dismiss completed run
- Streaming text display

---

### 8. RemoteAccessModal (`components/RemoteAccessModal.tsx`)

**IPC calls:**
- `window.api.startRemoteServer(opts?)`
- `window.api.stopRemoteServer()`
- `window.api.getRemoteStatus()`
- `window.api.getNetworkInterfaces()`
- `window.api.onRemoteStatus(callback)` — event subscription

**Key flows to test:**
- Start server → status transitions
- Stop server
- Network interface selection
- QR code generation from server URL
- Status polling / event subscription

---

### 9. ToolCallBlock (`components/chat/ToolCallBlock/ToolCallBlock.tsx`)

**IPC calls:**
- `window.api.openFile(path)`
- `window.api.showFile(path)`
- `window.api.copyToClipboard(text)`
- `window.api.openInBrowser(url)`
- Various git operations for inline diff display

**Key flows to test:**
- File open/reveal actions
- Clipboard copy
- Diff rendering for Edit/Write tool results
- Approval card integration (delegates to FloatingApproval pattern)

---

## Medium Value

### 10. WorktreesModal (`components/WorktreesModal.tsx`)

**IPC:** `listWorktrees`, `getWorktreeStatus`, `removeWorktree`
**Test:** List loading, removal flow, status display

### 11. QuitWorktreeModal (`components/QuitWorktreeModal.tsx`)

**IPC:** `removeWorktree`, `confirmQuit`
**Store:** `setQuitWorktrees`, `clearWorktreeInfo`
**Test:** Worktree cleanup before quit, skip cleanup path

### 12. WorktreeCleanupModal (`components/WorktreeCleanupModal.tsx`)

**IPC:** `getWorktreeStatus`, `removeWorktree`
**Test:** Status loading, removal, skip cleanup

### 13. WelcomeScreen (`components/WelcomeScreen.tsx`)

**IPC:** `pickFolder`
**Store:** `createNewSession`
**Test:** Folder picker → session creation

### 14. TaskDetailPanel (`components/TaskDetailPanel/TaskDetailPanel.tsx`)

**Store:** Task list management, panel resize, task selection
**Test:** Panel open/close, task selection, resize

### 15. TerminalPanel (`components/terminal/TerminalPanel.tsx`)

**IPC:** `createTerminal`
**Store:** `addTerminalTab`, `removeTerminalTab`, `setActiveTerminal`
**Test:** Terminal creation, tab switching, PTY exit handling

### 16. XTermInstance (`components/terminal/XTermInstance.tsx`)

**IPC:** `writeTerminal`, `onTerminalData`, `onTerminalExit`
**Test:** Input sending, output streaming, exit cleanup

### 17. PlanReviewPanel (`components/plan/PlanReviewPanel.tsx`)

**Store:** `addPlanComment`, `updatePlanComment`, `removePlanComment`, `closePlanPanel`
**Test:** Comment CRUD, section management

### 18. PlanReviewBar (`components/plan/PlanReviewBar.tsx`)

**IPC:** `createSession`, `sendPrompt`
**Store:** `markSdkActive`
**Test:** Review submission with lazy SDK init (same as ReviewBar)

### 19. AskUserQuestionBlock (`components/chat/AskUserQuestionBlock.tsx`)

**IPC:** `respondApproval`
**Store:** `removePendingApproval`
**Test:** Answer submission, approval removal

### 20. SkillsDialog (`components/SkillsDialog.tsx`)

**IPC:** `loadSkillDetails`
**Test:** Skill list loading and display

### 21. WindowControls (`components/WindowControls.tsx`)

**IPC:** `minimizeWindow`, `maximizeWindow`, `closeWindow`, `onMaximizeChange`
**Test:** Window state tracking, button actions

---

## Lower Value (minimal logic)

| # | Component | Logic |
|---|-----------|-------|
| 22 | `BtwCard` | `clearBtw` store action |
| 23 | `FloatingError` | Error display lifecycle |
| 24 | `AgentTabBar` | `setFocusedAgent` store action |
| 25 | `MermaidDiagram` | Zoom state management |
| 26 | `TodoWidget` | Reads todos from store |
| 27 | `GitChangesPill` | `openGitPanel` / `closeGitPanel` toggle |
| 28 | `SessionItem` | Context menu actions (rename, pin, watch) |
| 29 | `PluginWebView` | WebView lifecycle, message bridging |

---

## Test Infrastructure Reference

- **TestIpcBridge:** `src/test/bridges/test-ipc-bridge.ts`
- **bootTestApp:** `src/test/helpers/boot-test-app.ts` — creates bridge + window.api
- **Factories:** `src/test/factories/messages.ts` — `makePendingApproval`, `resetFactoryCounter`
- **Git IPC envelope:** All `git:*` channels use `unwrap` → handlers must return `{ ok: true, data: ... }`
- **Session IPC:** `session:*` channels return values directly (no envelope)
- **Vitest config:** Component tests in `vitest.config.ts` → project `component`, jsdom, globals=true
