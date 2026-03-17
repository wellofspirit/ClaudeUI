# Changelog

All notable changes to ClaudeUI are documented in this file. Entries are grouped by day and ordered chronologically.

---

## 2026-03-18

### fix: remove external Node.js dependency, use Electron's bundled Node.js runtime (`8b3b1f3`)
- Created `getSdkExecutableOpts()` helper in `claude-session.ts` that returns `executable: process.execPath` with `ELECTRON_RUN_AS_NODE=1` so the SDK spawns `cli.js` using Electron's own Node.js binary instead of requiring a system `node` in PATH
- Replaced all `getCliJsPath()` + spread patterns across `session.ipc.ts`, `remote-handlers.ts`, `automation-manager.ts`, and `service-session.ts` with the unified `getSdkExecutableOpts()` call
- Fixes macOS GUI apps (launched from Finder) failing to start sessions because no `node` binary is available in PATH

### fix: fix incorrect historical usage tracking and add historical data backfill (`bdc3417`)
- Rewrote `loadDailyHistory()` to compute daily totals directly from deduplicated JSONL entries (authoritative) instead of from persisted `completedBlocks` which can overlap and double-count across app restarts
- Added `dailySummary` field to `DailyUsageFile` — entry-derived totals are persisted so correct data survives past the 7-day JSONL scan window
- Added `backfillHistoricalSummaries()` that scans all JSONL files once on first recalculation to populate summaries for days beyond the scan window
- Fixed `persistSnapshot()` to route completed blocks to their actual day's file (by `actualEndTime`) instead of dumping all into today's file
- Extended daily chart from 7-day to 30-day history; scans all available daily files instead of a fixed window

---

## 2026-03-16

### fix: fix queued message display and multiple steer message merging (`65d9c9e`)
- Added `willQueue` getter on `ClaudeSession` to check if the session is actively processing before `run()` is called
- IPC `session:send` and remote handler now include `queued` flag in the `session:user-message` broadcast so renderers display the message as pending (not in chat) until consumed
- Added `setQueuedText()` store action for routing-id-specific queue updates; `appendQueuedText()` now merges multiple queued messages with newline separator
- `useClaudeEvents` now routes `session:user-message` with `queued=true` to `setQueuedText()` instead of `addUserMessage()`
- `InputBox` no longer calls `appendQueuedText` locally — the server broadcast is the single source of truth for all renderers (local + remote)
- Added `consumeQueuedText()` fallback when agent transitions running→idle with text still pending

---

## 2026-03-15

### feat: add incomplete-session-resume-fix patch (`a9f4ab3`)
- Created `patch/incomplete-session-resume-fix/` — fixes a bug where resuming sessions with `bash_progress`/`powershell_progress`/`mcp_progress` entries breaks the `parentUuid` chain, causing all messages before the filtered progress entry to be lost
- Part A captures a redirect map (`uuid → parentUuid`) when progress messages are filtered during JSONL loading
- Part B rewires `parentUuid` references through the redirect map after loading, with cycle detection via `_seen` Set
- Includes comprehensive README documenting the root cause (chain walker `Ao6()` gets `undefined` when parent is filtered) and the redirect strategy

---

## 2026-03-14

### chore: upgrade @anthropic-ai/claude-agent-sdk to 0.2.76 (`0ac54a8`)
- Bumped SDK from 0.2.72 to 0.2.76
- Updated `subagent-streaming/apply.mjs` regex patterns for v2.1.76 minified names — added new pattern for refactored sync loop body where push+stats are in a separate `if` from the `bash_progress` check

### feat: support context window size detection for 1M models (`c5e59c0`)
- Added `getContextWindowSize()` function that checks the cached model list for "1m" in the description, returning 1,000,000 or 200,000 as appropriate
- `ClaudeSession.buildStatusLineFromAccumulators()` now uses model-aware context window size for `usedPct` calculation
- `computeTokenMetrics()` in session-history accepts optional `model` parameter for accurate context percentage
- Added `useContextWindowSize()` hook in `InputBox` that derives context window from the selected model's description
- `StatusLine` component recalculates `usedPercentage` from raw `contextWindowSize` and the current model's window size

---

## 2026-03-11

### fix: resolve git paths relative to repo root instead of session cwd (`541682c`)
- Added `repoRoot` field and `ensureRepoRoot()` method to `GitService` — calls `git rev-parse --show-toplevel` and re-initializes `simple-git` at the repo root when the session cwd is a subdirectory
- Fixed `getStatus()`, `getFilePatch()`, `getFileContents()`, and `discardFile()` to resolve paths relative to `repoRoot` instead of `cwd`, fixing broken diffs and file operations for sessions started in subdirectories

### feat: fix incorrect usage block calculation and projection display (`cc837d9`)
- Fixed API reset timestamp jitter: round `resets_at` to nearest second before computing block IDs, preventing dozens of unique block IDs for the same 5-hour window
- Fixed `backfillProjections()` to overwrite with later (more accurate) projections instead of first-wins
- Added `finalApiPercent` field to `UsageBlock` — restored from persisted daily data (the last snapshot recorded while each block was still active)
- Added sanity check: discard projections where `projectedUsage.tokens < actual` block tokens
- Usage panel now gracefully handles `null` usage data (shows "No live API data" instead of crashing)
- Block usage service now always initialized (even in dev mode) since it only reads local JSONL files

---

## 2026-03-10

### feat: notify CLI of permission settings changes for hot-reload (`357f63c`)
- Added `notifySettingsChanged()` method on `ClaudeSession` — sends empty `applyFlagSettings({})` control message to trigger the CLI's settings-change subscriber to re-read all sources from disk
- `claude:save-permissions` IPC handler now calls `notifySettingsChanged()` on all relevant sessions after writing permissions, with scope-aware targeting (user-scope notifies all sessions, project/local-scope only matching cwd)
- Added `applyFlagSettings()` to the `activeQuery` interface; made `cwd` property `readonly` and publicly accessible
- Safe for managed/enterprise policies — no rules injected into the flag layer, the CLI re-evaluates its own setting sources

### feat: skip automation scheduling in dev mode (`f8bde63`)
- Added dev mode check to automation IPC registration, skipping scheduler initialization and returning empty arrays for list/run queries

### fix: adjust cost field lookup order in automation result processing (`87f3c4c`)
- Changed cost extraction from `cost_usd || totalCostUsd` to `total_cost_usd || cost_usd` to match the SDK's actual result message field name

### feat: replace auto-save with explicit save and add inherited permissions display (`c8f6969`)
- Replaced debounced auto-save with explicit Save button that tracks dirty state via `useMemo` comparison against original automation values
- Added `InheritedPermissions` component showing read-only global (user-scope) and directory (project+local scope) permission rules loaded via `loadClaudePermissions()`
- Made permissions section collapsible with chevron toggle and rule count summary
- Added duration formatting (`formatDuration()`) and cost display to automation run history items

### refactor: simplify automation tool permissions to rely on CLI evaluation (`cf925b3`)
- Removed custom `buildCanUseTool()`, `matchesPattern()`, and `formatToolStr()` from `AutomationManager` (60 lines deleted)
- `canUseTool` now simply denies anything the CLI didn't pre-approve — the CLI evaluates its own allow/deny rules from `settingSources` before calling the callback, so only tools needing human approval reach us
- Eliminates redundant permission evaluation that could conflict with the CLI's own rule hierarchy

### chore: upgrade @anthropic-ai/claude-agent-sdk to 0.2.72 (`61674c3`)
- Bumped SDK from 0.2.71 to 0.2.72

---

## 2026-03-09

### chore: upgrade @anthropic-ai/claude-agent-sdk to 0.2.71 (`f642f9f`, `68c4364`)
- Bumped SDK from 0.2.63 to 0.2.71
- Updated `queue-control/apply.mjs` regex to handle v2.1.71+ `priority` field in queue-push pattern
- Updated `subagent-streaming/apply.mjs` with dual-pattern matching: old pattern (push+bash_progress in same `if`) and new v2.1.71+ pattern (push+stats separated from bash_progress check)
- Updated `taskstop-notification/apply.mjs` with two additional regex patterns (`taskVarRe3`, `taskVarRe4`) for v2.1.71+ refactored task variable lookup (no `await`, comma-separated `let`)

### feat: add interrupt capability to gracefully abort active session turns (`d58c3f2`)
- Added `interrupt()` method to `ClaudeSession` that denies all pending approvals and calls `activeQuery.interrupt()`, mirroring pressing Escape in the real CLI
- Changed `InputBox` cancel button from `cancelSession` (kills session) to `interruptSession` (graceful abort, session stays alive)
- `stopTask()` now falls back to `interrupt()` for foreground tasks that don't have a `taskIdMap` entry yet
- Added `interruptSession()` to `ClaudeAPI` interface, preload bridge, IPC handler, and `SessionManager`

### feat: add ad-hoc code signing for macOS builds (`039b2d7`)
- Added ad-hoc signing step to GitHub Actions release workflow for macOS builds

### ci: skip release workflow for documentation and config-only changes (`92cefc2`)
- Added path filter to release workflow to skip runs when only docs, configs, or markdown files change

---

## 2026-03-06

### feat: skip usage fetcher in dev mode to avoid rate limit (`0e6e819`)
- Wrapped usage fetcher, service session, and block usage service initialization in dev mode check with early return guards on IPC handlers
- Logs when dev mode skips these subsystems

### fix: build warnings — replace dynamic imports with static imports in remote handlers (`6766ebb`)
- Replaced dynamic `import()` calls for SDK, claude-session, and persisted-sessions-dir with static imports at the top of `remote-handlers.ts`

### fix: bundle web build as extra resource in electron app (`bffffae`)
- Added `out/web` to electron-builder `extraResources` so web assets are packaged in the distribution
- Added `build:web` step to all platform-specific build scripts

### chore: add Apache 2.0 license and update package metadata (`c0bf5c7`)
- Added `LICENSE` file with Apache 2.0 license text
- Updated `package.json` with license field and author metadata

### chore: add README, move ADRs to docs/adr, remove planning docs (`5f80d38`)
- Created comprehensive `README.md` with feature overview and screenshots
- Moved ADR files from `doc/` to `docs/adr/`
- Deleted `PLAN.md` (393 lines) and `phase1.md` (279 lines) planning documents

### feat: add GitHub Actions release pipeline for Windows and macOS builds (`03a48c4`)
- Created `.github/workflows/release.yml` (144 lines) — triggered on version tags, builds macOS (arm64 + x64) and Windows (x64) distributables, uploads as GitHub release assets

### fix: disable code signing for macOS builds and correct app name casing (`db283cd`)
- Set `identity: null` in electron-builder config to skip code signing
- Updated `build:mac` script to use correct `ClaudeUI` app name casing

---

## 2026-03-05

### refactor: unwrap safeHandler error envelopes in preload API (`28f5de6`)
- Created `unwrap<T>()` helper in preload that normalizes `{ ok, data, error }` response envelopes — throws on `{ ok: false }` so callers can `.catch()` as expected
- Applied to all worktree, git (18 operations), and MCP operations that use `safeHandler`, fixing crashes where renderer code expected direct values but received envelope objects

### fix: prevent Tailwind table utility from breaking code block text flow (`a43a1d2`)
- Added CSS rule `pre .token.table { display: inline !important; }` to override Prism's markdown tokenizer adding "table" as a token class, which caused Tailwind's `table` utility (`display: table`) to break inline text
- Created `WriteResult` component with preview/code tab switcher for Write tool results — markdown files default to preview tab, other files to code tab

### feat: add usage-relay patch to relay usage API through control messages (`e6e05b7`)
- Created `patch/usage-relay/` — adds `get_usage` control request handler in `cli.js` that calls the CLI's internal `k9q()` usage fetcher, and `getUsage()` method on the SDK query class
- Eliminates 429 rate-limit errors by routing through the CLI's managed OAuth session instead of independent UI requests with separate credentials
- Created `ServiceSession` class (141 lines) — keeps a lightweight CLI subprocess alive for usage polling via control messages
- Rewrote `UsageFetcher` to use SDK relay path, removing direct credential reading, token refresh, and HTTP fetch logic
- Includes README (360 lines), apply script, and test harness

### refactor: use dedicated directory for SDK session working paths (`3147714`)
- Created `persisted-sessions-dir.ts` — stable `~/.claude/ui/persisted-sessions/` directory for SDK sessions (title gen, commit msg, model fetch, service session)
- Fixes macOS TCC privacy prompts caused by SDK scanning the entire home directory when `process.cwd()` returns `~` for Finder-launched apps
- Eagerly imports `service-session` to avoid dynamic import in quit handler

### feat: add remote control feature for mobile and browser access (`f04517a`)
- Created `RemoteServer` (476 lines) — HTTP + WebSocket server with token-based authentication, 10-second auth timeout, 5-minute idle disconnect with ping/pong keepalive
- Created `RemoteDispatcher` (60 lines) — routes WebSocket RPC calls to registered handlers with a blocklist for desktop-only channels
- Created `RemoteBridge` (39 lines) — forwards Electron `webContents.send` events to all connected WebSocket clients
- Created `remote-handlers.ts` (293 lines) — registers session lifecycle, control, query, team, config, file listing, and usage handlers on the dispatcher
- Created `EventLog` service (91 lines) — ring buffer of recent IPC events for client catch-up on connect
- Created `remote-protocol.ts` (149 lines) — typed WebSocket message protocol with `WsClientMessage`/`WsServerMessage` discriminated unions
- Created `RemoteAccessModal.tsx` (235 lines) — start/stop server, QR code display, LAN URL with token, network interface picker
- Created web client: `connection.ts` (WebSocket management), `api-adapter.ts` (313 lines, maps `ClaudeAPI` interface to WebSocket RPC), `ConnectionOverlay.tsx`, `main.tsx`, `main.css`, `index.html`
- Added Vite web build config (`vite.web.config.ts`) and `build:web` script
- Settings dialog gained remote access toggle section

### feat: add end-to-end encryption and tunnel support for remote server (`cafb56a`)
- Created `E2ECrypto` class (151 lines) in `shared/e2e-crypto.ts` — AES-256-GCM encryption/decryption with key derivation from hex string via HKDF
- Created `TunnelManager` (315 lines) — downloads and manages `cloudflared` binary, spawns quick tunnel process, auto-restarts on failure with exponential backoff
- `RemoteServer` now supports tunnel mode: generates E2E key on start, activates encryption after auth handshake via `e2e-activate`/`e2e-ack` messages
- Message ordering preserved with per-client `sendQueue` Promise chain for async encryption
- Tunnel URLs include token in query param and E2E key in URL fragment (never sent to server)
- Web client `connection.ts` extended with E2E encryption initialization from URL fragment key

### feat: upgrade cloudflared to 2026.2.0 and improve binary handling (`1e7da2d`)
- Updated cloudflared version to 2026.2.0 with `.tgz` extraction support for macOS (upstream changed packaging format)
- Removes macOS Gatekeeper quarantine attribute after download
- Moved binary storage to `~/.claude/ui/cloudflared/` for better portability across dev/prod environments

### feat: optimise mobile view (`5423fca`)
- Created `useIsMobile` hook (55 lines) with media query detection and `useVisualViewportHeight` for dynamic viewport height tracking (handles mobile keyboard)
- Sidebar renders as a drawer overlay on mobile with slide-in animation and backdrop blur, auto-closes on session select
- Right panels (task detail, git, plan review) and terminal panel hidden on mobile
- Chat panel uses full width, reduced horizontal padding, and respects `safe-area-inset-top` for notch devices
- Added `viewport` meta tag with `viewport-fit=cover` and `100dvh` height overrides for mobile browser chrome
- TopBar shows hamburger menu + new session button instead of sidebar collapse toggle on mobile

---

## 2026-03-04

### fix: pass model parameter through session creation flow (`db4e59d`)
- Added optional `model` parameter to `createSession()` across the full chain: `ClaudeAPI` interface → preload → IPC handler → `SessionManager.create()` → `ClaudeSession` constructor
- `InputBox.handleSend()` now passes `session.selectedModel` so the first query uses the correct model instead of defaulting then switching via `setModel()`

### chore: upgrade @anthropic-ai/claude-agent-sdk to 0.2.63 and add test harnesses (`bd63b97`)
- Bumped SDK from 0.2.59 to 0.2.63 (CLI 2.1.63)
- Created `patch/test-helpers.mjs` (108 lines) — shared test infrastructure for spawning SDK sessions, waiting for events, asserting results
- Created `patch/mcp-test-server.mjs` (107 lines) — mock MCP server for testing MCP patches
- Added test harnesses for `mcp-status`, `mcp-tool-refresh`, and `queue-control` patches
- Updated `subagent-streaming/test.mjs` with improved assertions
- Fixed `mcp-tool-refresh/apply.mjs` regex patterns for 0.2.63 minified names

### feat: add patch-test-harness skill documentation (`c83abdf`)
- Created `.claude/skills/patch-test-harness/SKILL.md` (294 lines) — guides agents through writing behavioral tests for SDK patches

### feat: add patch-readme skill documentation (`7c7dc46`)
- Created `.claude/skills/patch-readme/SKILL.md` (404 lines) — guides agents through writing reverse-engineering READMEs for SDK patches

### feat: add sandbox configuration support with violation reporting (`867ad3e`)
- Created sandbox settings UI in `SettingsDialog.tsx` — enable/disable toggle, auto-allow bash, excluded commands list, network settings (restrict domains, allow local binding, unix sockets), filesystem settings (allow-write, deny-write, deny-read paths)
- Created `InfoTooltip` component and `SandboxListSetting` component for managing configurable string lists
- Added `SandboxSettings` type and `sandboxConfig` to `ClaudeSession` — passes full sandbox config to SDK `sdkQuery()` options
- Added sandbox violation detection: parses `<sandbox_violations>` XML from tool results, sends `session:sandbox-violation` IPC events
- Created `SandboxViolationToast.tsx` — ephemeral floating toast for violation notifications
- Added `sandboxSettings`, `sandboxViolations` to session store with related actions

### feat: support permission suggestions in approval workflow (`42064cf`)
- Created `PermissionSuggestions.tsx` (94 lines) — `AlwaysAllowSection` checkbox list with `formatSuggestionLabel()` producing human-readable labels for rule types (setMode, addRules, removeRules, addDirectories, etc.) and redundancy detection
- `FloatingApproval.tsx` and `ToolCallBlock.tsx` both show permission suggestion checkboxes above Allow/Deny buttons
- Selected suggestions sent back via `respondApproval()` and applied by `claude-session.ts` via `applyPermissionSuggestion()`
- Extended `PendingApproval` type with `suggestions` field; extended `ClaudeAPI.respondApproval()` with optional suggestions parameter

### feat: add sandbox-network-fix patch (`17adb59`, `8d5c1d3`)
- Created `patch/sandbox-network-fix/` — fixes SDK sandbox network proxy always starting even when no domain restrictions configured, blocking all traffic through an unnecessary proxy
- Patch modifies proxy startup check to skip initialization when `allowedDomains` includes `"*"` (unrestricted)
- Session-side fix: when `restrictNetwork` is false, omits `network` key entirely from sandbox config so SDK doesn't start domain filtering
- Initially named `network-unrestrict`, renamed to `sandbox-network-fix` with test harness and updated CLAUDE.md patch table

### feat: big refactor to improve code quality (`6a7b1dc`)
- Extracted `hooks/useFileMention.ts` (300 lines) — @ mention autocomplete logic with directory navigation, filtering, keyboard handling, and text insertion pulled out of InputBox
- Extracted `hooks/useSlashMenu.ts` (94 lines) — slash command popup state, filtering, keyboard navigation pulled out of InputBox
- Extracted `utils/content-blocks.ts` (45 lines) — `mergeContentBlocks()` for SDK partial message upsert, preserving tool_use/tool_result blocks across updates, pulled out of session store
- Extracted `utils/ipc-timeout.ts` (21 lines) — `withTimeout()` helper racing IPC calls against configurable timeouts
- Extracted `components/chat/FileAttachmentBar.tsx` (42 lines) — attachment preview bar pulled out of InputBox
- Simplified `preload/index.ts` from ~256 to ~100 lines by extracting IPC event registration into typed helpers
- Restructured `session.ipc.ts` handler registration with consistent error handling
- Reorganized `shared/types.ts` — reordered and grouped related interfaces
- `InputBox.tsx` shrunk dramatically; `SubagentMessages.tsx` simplified rendering; `MessageBubble.tsx` improved tool_use block grouping

### refactor: use isAgentTool helper for Task→Agent tool rename (`a828c16`)
- SDK 0.2.63 renamed `Task` tool to `Agent` (with `Task` as backward-compat alias); model may send either name
- Added `isAgentTool(toolName)` helper in `shared/types.ts` returning true for both `'Agent'` and `'Task'`
- Updated `MessageBubble.tsx` to route both tool names to `<TaskCard>` instead of only `'Task'`
- Updated `ToolCallBlock.tsx` `getSummary()` — handles `Agent`/`Task` → description; added `TaskOutput` → task ID, `TaskStop` → task ID
- Updated teammate detection in `claude-session.ts` and `session-history.ts` to match both tool names
- Updated `PermissionsDialog.tsx` template from `'Task'` to `'Agent'`; updated `AutomationConfig.tsx` default permission

### feat: expose background task feature via SDK control message API (`27cb695`)
- Created `patch/background-task/` — exposes the CLI's `ctrl+b` "send to background" feature via the SDK control message protocol
- **Part A** (`cli.js`): Added `background_task` control request handler accepting `tool_use_id`, searching tasks by `.toolUseId` property. For bash: calls `shellCommand.background()` (spills stdout to disk), sets `isBackgrounded`. For agents: sets `isBackgrounded`, resolves `backgroundSignal` Promise from `Ff6` Map
- **Part B** (`sdk.mjs`): Added `backgroundTask(toolUseId)` method on the Query class
- Six minified symbols (`errorFn`, `msgVar`, `successFn`, `getAppStateFn`/`setAppStateFn`, `wiFn`, `yiFn`, `bgSignalMap`) extracted dynamically from content patterns
- Added `backgroundTask()` to `ClaudeAPI` interface, preload bridge, IPC handler, and `ClaudeSession`
- `ToolCallBlock.tsx` shows "Send to background" button for foreground running Bash commands with accent border
- `TaskCard.tsx` shows "Send to background" button for foreground running Agent tasks
- Uses `tool_use_id` lookup (not `task_id`) because foreground tasks haven't returned results yet — `taskIdMap` is only populated by `detectTaskMapping()` on tool results

### refactor: improve clarity of background task UI labels (`0167d23`)
- Changed button text from "Background" to "Send to background" and spinner text from "backgrounding…" to "sending to background…" in `ToolCallBlock.tsx` and `TaskCard.tsx`

---

## 2026-03-03

### feat: add plan review panel with inline commenting (`6e73522`)
- Created `PlanReviewPanel.tsx` (174 lines) — a resizable right panel (500px default, 350–900px range) that splits plan content into sections at double-newline boundaries, each rendered as markdown
- Created `PlanCommentWidget.tsx` (106 lines) — inline widget for adding comments with quoted selection text, textarea, Cmd+Enter to save, Escape to cancel
- Created `PlanCommentBadge.tsx` (135 lines) — displays existing comments with quoted selection, edit/remove on hover, accent-colored left border
- Created `PlanReviewBar.tsx` (88 lines) — bottom bar showing comment count and "Send Comments" button that composes all comments into structured feedback sent as a `deny` approval response
- Created `useTextSelectionComment.ts` hook (177 lines) — detects text selection within plan content, strips markdown syntax for fuzzy matching, maps rendered text back to source line numbers
- Added `planReview` per-session state with `openPlanPanel`, `closePlanPanel`, `addPlanComment`, `updatePlanComment`, `removePlanComment` store actions
- `ExitPlanModeCard` now has a "Review" button that opens the plan panel with plan content and approval request ID
- `ReviewBar` (git diff) gained Cmd+Shift+Enter keyboard shortcut for sending comments

### fix: improve context menu layout consistency (`d53e2b0`)
- Standardized context menu containers in `Sidebar.tsx` and `GitFileTree.tsx` — replaced `min-w-[160px]` with `grid` layout so items stretch to equal widths without a fixed min-width

### feat: add file discard functionality with context menu (`713a59f`)
- Added `GitService.discardFile()` — runs `git checkout HEAD -- <file>` for tracked files; detects untracked files via `git show HEAD:<file>` failure and deletes them from disk
- Added `git:discard-file` IPC channel and preload API
- Expanded `GitFileTree` context menu: right-click shows "Stage"/"Unstage" toggle and "Discard changes"/"Delete file" for individual files, plus "Discard changes (N files)" for directories
- Added confirmation dialog for destructive discard operations with "This action cannot be undone" warning, rendered via portal with backdrop blur
- Updated `--color-bg-hover` CSS variables across dark, light, and monokai themes for better hover feedback

### docs: add ADR-002 and ADR-003 for terminal panel persistence and cwd grouping (`13e3a27`)
- **ADR-002:** Always mount `TerminalPanel` in the DOM (`display: contents/none`) to preserve xterm.js scrollback buffers — changed from conditional rendering
- **ADR-003:** Group terminal tabs by session cwd with 10-minute cold cleanup for orphaned groups
- Refactored store from flat `terminalTabs`/`activeTerminalId` to `terminalGroups: Record<string, { tabs, activeTabId }>` with per-group selectors
- Created `useTerminalColdCleanup.ts` hook (58 lines) — starts 10-minute timer when a terminal group has no active session, then kills PTYs and removes the group
- Added `PtyManager.killByCwd()` method exposed via `terminal:kill-by-cwd` IPC
- Added session inactivity timeout (default 15 min) with configurable dropdown in SettingsDialog (5/15/30/60 min or Never)

### feat: add architectural decision records system and preserve @ mentions in prompts (`2920ceb`)
- Added ADR framework to `CLAUDE.md` with guidance to check for superseding decisions
- Created `doc/adr.md` registry index and `doc/adr-001_preserve-at-mentions-in-user-prompt.md`
- Fixed `InputBox` @ mention insertion: paths with spaces become `@"path with spaces"` (quoted), simple paths become `@path` (unquoted)

---

## 2026-03-02

### Support worktree and fix displaced collapse sidebar button on different zoom level (`2fc507b`)
- Created `worktree.ts` service (161 lines) with `createWorktree`, `getWorktreeStatus`, `removeWorktree`, `listWorktrees` — creates worktrees under `.claude/worktrees/<name>`, copies `settings.local.json`, configures git hooks path
- Reworked app quit lifecycle: `before-quit` now prevents default, sends `app:before-quit` to renderer, with 5-second fallback timeout for worktree cleanup prompts
- Created three new modals: `QuitWorktreeModal` (keep all/remove all on quit), `WorktreeCleanupModal` (per-session worktree cleanup with status), `WorktreesModal` (list all worktrees with individual remove)
- Created `WorktreePill.tsx` — pill shown in ChatPanel header when in a worktree, showing name and branch
- **Zoom fix:** Sidebar collapse button now divides position by `uiFontScale`, context menu positions also zoom-adjusted via `contextMenuPosition()` helper
- Git service bugfix: added `stat.isFile()` check before reading untracked files

### feat: add git push with upstream tracking support (`e6c8a09`)
- Added `GitService.pushWithUpstream(branch)` — runs `git push --set-upstream origin <branch>`
- Push button no longer disabled when there's no upstream tracking; shows inline "Push with -u" prompt on upstream errors
- Consolidated `GitCommitBox` error/feedback into a `toast` object with `{ message, type: 'success' | 'error' }`, error toasts display for 5 seconds (vs 2.5s for success)

---

## 2026-03-01

### feat: add direct MCP disabled state management without session (`9117547`)
- Added `writeDisabledMcpServers()` to `claude-mcp.ts` — writes disabled server list directly to `~/.claude.json` project entry
- Two new IPC channels: `mcp:read-disabled` and `mcp:toggle-disabled`
- McpDialog now has two-path toggle: SDK path when session active, direct config write otherwise

### Fix MCP server management (`372f953`)
- Created `mcp-status` SDK patch — fixes `mcpServerStatus()` returning empty array by awaiting plugin MCP server refresh promise
- Created `mcp-tool-refresh` SDK patch — ensures tools are refreshed after server reconnection
- Created `claude-mcp.ts` service (182 lines) — reads MCP server configs from multiple scopes (user `~/.claude.json`, project `.mcp.json`, local `.mcp.json`), merges them, manages disabled servers list
- Created `McpDialog.tsx` (921 lines) — full dialog for managing MCP servers with status indicators, toggle/reconnect/edit capabilities, server grouping by scope, and JSON config editors
- Added 6 MCP-related IPC channels (`mcp:status`, `mcp:toggle`, `mcp:reconnect`, `mcp:set-servers`, `mcp:load-servers`, `mcp:save-servers`)

---

## 2026-02-27

### feat: add skill scanning and IPC endpoints for skills management (`b391959`)
- Created `skill-scanner.ts` (155 lines) — scans project, user, and plugin skill directories, parses `SKILL.md` frontmatter (regex-based YAML parser)
- Created `SkillsDialog.tsx` (367 lines) — grouped display by source with expandable skill cards and source badges
- Added `SkillInfo` type and `session:load-skill-details` IPC handler
- Skills button added to ChatPanel header

### feat: add directory autocomplete to permissions dialog (`2b03927`)
- Enhanced `file:list-dir` IPC to return `{ entries, resolvedPath, isRoot }` with Windows drive letter handling
- Added 140 lines to `PermissionsDialog.tsx` implementing directory autocomplete: reuses `FileMentionMenu`, Tab for subdirectory navigation, Enter to confirm, arrow keys for list navigation
- Refactored InputBox @ mention logic with improved directory listing integration

### refactor: downgrade info logs to debug level for verbose operations (`2971dd2`)
- Added `debug()` method to logger with `debugEnabled` flag (default false) — debug messages only go to console, never to log file
- Replaced 14 `logger.info()` calls with `logger.debug()` for routine operations (title generation, commit messages, CLI paths, automation lifecycle, etc.)

### feat: add git pull/fetch and sync UI to branch dropdown (`d8f0122`)
- Added `pull()` and `fetch()` (with `--all --prune`) methods to GitService
- Added `trackingBranch` to git status output
- Expanded `GitBranchDropdown.tsx` (+272 lines): sync section with Pull/Push/Fetch buttons, auto-fetch on open with 30-second cooldown, ahead/behind commit counts, success/error messages
- Added `gitSyncOperation`, `gitSyncError`, `gitLastFetchTime` to session store

### Refactor: remove debug console.log statements (`281f5a6`)
- Removed 10 `console.log` statements from queue-control feature debugging across ChatPanel, InputBox, and session store

### fix: constrain diff comment widgets to viewport with container queries (`5782228`)
- Set `.diff-scroll-container` as `container-type: inline-size`; capped comment widget/badge width to `min(600px, calc(100cqi - 1rem))`

---

## 2026-02-26

### Merge branch 'sdk-bump' (`59e9592`)
- Merge commit bringing SDK 0.2.59 upgrade into main branch

### refactor: migrate automations storage and SDK session management (`896bfba`)
- Converted automation storage from single `automations.json` to per-automation JSON files (`{id}.json`)
- Added `fs.watch()` file watcher on automation directory with 500ms debounce for multi-instance support
- Replaced `MessageChannel` async iterable with stateless one-shot SDK queries
- Added `reloadFromDisk()` reconciliation and `dismissRun()` for orphaned runs

### chore: upgrade SDK to 0.2.59 and remove upstreamed patches (`a4a00f6`)
- Bumped `@anthropic-ai/claude-agent-sdk` from 0.2.50 to 0.2.59
- Deleted `task-notification-usage` patch (upstreamed in 0.2.49)
- Deleted `team-dowhile-fix` patch (upstreamed in 0.2.59)
- Updated remaining patches (`subagent-streaming`, `taskstop-notification`, `team-streaming`, `queue-control`) for new minified names

### feat: add --dir flag to windows build for faster iteration (`1244134`)
- Changed `build:win` script to use `--dir` flag for unpacked directory output instead of installer

### remove: delete NoisyMusicButton component (`0c85b95`)
- Deleted novelty Web Audio API component (white noise + chaotic oscillators) and removed from SessionView

### feat: add comprehensive logging to usage fetcher (`af87312`)
- Added 16 `logger.warn()`/`logger.error()` calls at key failure points: missing credentials, token refresh failure, HTTP errors, retry exhaustion

### feat: add automation scheduling with cron and interval support (`478800a`)
- Created `AutomationManager` service (668 lines) — scheduling with cron expressions (via `cron-parser`) and intervals, persistent storage, per-automation JSONL run history
- Implements tool permission filtering with glob-style allow/deny patterns
- Desktop notifications on run completion/failure
- Created IPC handlers for list/upsert/delete/run/cancel/send-message/get-runs/get-run-messages
- Created renderer components: `AutomationView.tsx`, `AutomationList.tsx` (199 lines), `AutomationConfig.tsx` (418 lines), `AutomationRunHistory.tsx` (183 lines)
- Created `automation-store.ts` Zustand store and `useAutomationEvents.ts` hook

---

## 2026-02-23

### feat: add Claude permissions management API (`1603d51`)
- Created `claude-settings.ts` (117 lines) — loads/saves permissions across three scopes (user, project, local), preserves non-permission keys
- Created `PermissionsDialog.tsx` (576 lines) — tabbed UI for user/project/local scopes, rule pills with delete/edit, add-rule input with template suggestions, default mode selector
- Added `permissions:load` and `permissions:save` IPC handlers

### docs: improve queue-control patch documentation (`9ccf9a2`)
- Major rewrite of README and patch script (409 lines from 250)
- Added Part B: `queued_command_consumed` notification when CLI consumes a queued message
- Improved `dequeueMessage` to match by text content, added steer-consumed event handling

### docs: add comprehensive Claude Agent SDK CLI internals documentation (`0ae19c5`)
- Created `docs/cli-message-loop-internals.md` (894 lines) — deep reverse-engineered documentation of the CLI's message loop, output queue, steer handling, sub-turn lifecycle, and control-request protocol

### chore: upgrade claude-agent-sdk to 0.2.50 with dynamic pattern matching (`a5bfe31`)
- Updated queue-control patch to use dynamic regex-based extraction of minified names instead of hardcoded values
- Uses generic `const V = '[\\w$]+'` pattern for version-resilient matching

### feat: add queue-control patch for mid-turn message injection (`969c87f`)
- Created SDK patch (250 lines) adding `queue_message` and `dequeue_message` control-request subtypes to the CLI's message loop
- `queue_message` pushes a prompt into the output queue and kicks the turn loop
- `dequeue_message` removes a queued item by UUID
- Added `queueMessage()`/`dequeueMessage()` IPC handlers and preload API
- Updated InputBox to use `queueMessage` when SDK is actively running
- Added `QueuedMessageCard` in ChatPanel showing pending queued message

### fix: synthesize task-stopped notification when SDK doesn't deliver it (`0b1c3c2`)
- After `stopTask()`, manually calls `markBackgroundDone()`, updates teammate statuses to "stopped", cleans up `taskIdMap`, and sends synthetic `session:task-notification` via IPC

### feat: add @ file mention autocomplete with directory browsing (`cda8955`)
- Created `FileMentionMenu.tsx` (70 lines) — dropdown with folder/file SVG icons, scroll-into-view, mousedown handling
- Added `file:list-dir` IPC handler filtering hidden files and build directories
- InputBox tracks @ mention state with directory traversal, ".." parent navigation, path segment filtering, and keyboard navigation

### chore: upgrade claude-agent-sdk to 0.2.50 and fix patching logic (`da99c41`)
- Updated `team-dowhile-fix` test timeout detection
- Revised `team-streaming` patch regex patterns for intermediate function calls in 0.2.50

### feat(usage-fetcher): add macOS Keychain fallback for credentials (`c2acbdb`)
- Added `readCredentialsFromKeychain()` using macOS `security find-generic-password` for OAuth credentials
- Replaced multiple auto-scroll triggers with single `MutationObserver` watching `childList`, `characterData`, and `subtree`

### fix: prevent IPC handler memory leaks from duplicate registrations (`5570951`)
- Added `ipcMain.removeHandler()` calls before each registration to prevent accumulation on window recreation
- Extracted channel names as constants: `SESSION_IPC_CHANNELS` (39 channels), `TERMINAL_IPC_CHANNELS` (4 channels)

---

## 2026-02-22

### Add comprehensive logging throughout main process and services (`2878298`)
- Created `logger.ts` (86 lines) — file-based logging to `~/.claude/ui/logs/YYYYMMDD.log` with `error()`, `warn()`, `info()` methods
- Replaced `console.log`/`console.error` across all services with structured logger calls
- Added global `uncaughtException` and `unhandledRejection` handlers
- Renderer errors forwarded via `log:error` IPC

### Add .npmrc config and optimize build performance (`969ec11`)
- Created `.npmrc` with `msbuild_args=-p:SpectreMitigation=false` to fix Windows native module builds
- Set `npmRebuild: false` in electron-builder to prevent redundant rebuilds

### feat: add integrated terminal support with xterm and node-pty (`91847d0`)
- Added `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` dependencies
- Created `PtyManager` service (104 lines) — spawns pseudo-terminals preferring PowerShell 7 on Windows
- Created `terminal.ipc.ts` (39 lines) bridging PTY I/O to renderer
- Created `XTermInstance.tsx` (169 lines) — xterm.js wrapper with theme-aware colors, FitAddon, ResizeObserver
- Created `TerminalPanel.tsx` (99 lines) — multi-tab terminal manager
- Configured electron-builder to unpack `node-pty` native modules

### Fix build (`ed10c3f`)
- Removed unused `padB` parameter from `AreaChart`/`BarChart` components in `BlockTimeline.tsx`

### feat: add weighted least squares regression for usage projection (`5ac351e`)
- Replaced simple single-point projection with WLS regression model: `tokens = k * apiPercent`
- Ring buffer of 30 samples with 5-minute exponential decay half-life
- Falls back to single-point when fewer than 3 samples exist

### feat: add block usage analytics with token tracking per 5hr window (`43c3c81`)
- Created `BlockUsageService` (794 lines) — scans JSONL transcripts, groups into 5-hour billing blocks, per-model token breakdowns with pricing tiers
- Persists time-series snapshots to `~/.claude/ui/usage/` as daily JSON files
- Created `BlockTimeline.tsx` (773 lines, SVG area/bar charts), `DailyUsageChart.tsx`, `TokenDonut.tsx`, `UsageView.tsx`

### feat: add account usage polling via OAuth API (`efa1eac`)
- Created `UsageFetcher` (264 lines) — reads OAuth credentials, calls Anthropic usage API, handles token refresh, configurable polling interval
- Added usage percentage display in Sidebar and refresh interval slider in SettingsDialog

---

## 2026-02-20

### feat: improve auto-scroll logic for streaming content and resize events (`3eb953c`)
- Smooth scroll guard now uses recursive `requestAnimationFrame` loop checking scroll settlement
- Content auto-scroll uses instant scroll to prevent streaming outrunning smooth animation
- `ResizeObserver` now watches the scroll container itself with `lastScrollHeight` tracker

### feat: always show bash tool input and remove command truncation (`9fbbfab`)
- Bash tool input always renders even when `hideToolInput` is true (only label hidden)
- Removed `trunc()` calls for Bash commands, Grep patterns, and Task descriptions in summaries

### upgrade claude-agent-sdk to 0.2.49 and remove upstreamed patches (`ecf6e0f`)
- Bumped SDK from 0.2.47 to 0.2.49
- Commented out `task-notification-usage` patch (upstreamed)
- Updated all remaining patch scripts for new minified names
- Added patch test infrastructure: `test-helpers.mjs`, `test-all.mjs`, and per-patch `test.mjs` files

### feat: add comprehensive settings dialog with search and live preview (`7847f50`)
- Created `SettingsDialog.tsx` (728 lines) with reusable `SettingsToggle`, `SettingsSlider`, `SettingsSelect` components
- Organized settings into searchable categories (Appearance, Chat, Diff, Git, etc.) with SVG icons
- Real-time search across all settings using keyword matching
- Smooth section scrolling with `IntersectionObserver` active state tracking
- Moved diff and commit settings from inline popup to full dialog

---

## 2026-02-19

### feat: support PDF attachments alongside images (`3b4fc48`)
- Generalized `ImageAttachment` to `FileAttachment` with `fileType: 'image' | 'pdf'` discriminator
- PDFs sent as `type: 'document'` content blocks with base64 source
- File picker now accepts `application/pdf`; PDF previews show as file icon + truncated filename

### feat: add image attachment support to chat input (`ab258f2`)
- Image processing: reads as data URLs, checks dimensions, resizes via canvas if >2048px or 4MB
- Supports multiple images via plus menu file picker or clipboard paste
- 64x64 thumbnail previews above textarea with remove button
- SDK receives `ContentBlockParam[]` with `type: 'image'` + base64 source

### feat: add webkit app region styling for window drag behavior (`5c6122c`)
- Added `[-webkit-app-region:drag]` to TaskDetailPanel and GitPanel headers
- Added `[-webkit-app-region:no-drag]` to interactive elements within headers

### upgrade claude agent sdk to 0.2.47 (`1c520ab`)
- Bumped SDK from 0.2.45 to 0.2.47
- Updated all 5 patch scripts for new minified variable names

### fix: use endLineNumber for comment positioning in diffs (`10581ac`)
- Changed comment widget/badge positioning from `lineNumber` to `endLineNumber` so comments render after the last selected line

### Add diff viewer comment support with gutter selection and inline widgets (`f66568c`)
- Created `useGutterDragSelection.ts` (280 lines) — click/drag on line numbers to select ranges with CSS highlighting
- Created `DiffCommentWidget.tsx` — inline textarea below selected lines
- Created `DiffCommentBadge.tsx` — persistent comment badges with delete button
- Created `ReviewBar.tsx` — comment count display with "Clear all" button
- DiffViewer extended with `extendData` API for injecting custom comment rows
- Added `diffComments` and `activeCommentInput` to per-session state

### Fix auto-scroll observer lifecycle to handle state transitions (`bba6b99`)
- Replaced `ResizeObserver` dependency on `[messages, hasStreamingText]` with `MutationObserver` watching `childList`
- Dynamic attach/detach of `ResizeObserver` when content wrapper changes

### Increase panel header height for better visual balance (`b8c51d8`)
- Changed header height from `h-10` to `h-12` on TaskDetailPanel and GitPanel

### refactor: fix TypeScript discriminated union issues in DiffViewer (`d36c003`)
- Extracted discriminated union fields into local variables with `'prop' in props` guards
- Added auto-select next file after commit and auto-select first file on panel open
- GitFileDiffView shows "All clean" message when no files

### style: move diff compacting overrides to main.css (`c42b105`)
- Moved inline Tailwind override selectors from DiffViewer component to proper CSS rules in `main.css`

### feat: add default commit mode setting (`c9ad6f2`)
- Added `gitCommitMode` setting with `'commit'`/`'commit-push'` options
- Primary button and Ctrl+Enter action use configured mode; dropdown shows the opposite

### feat: add resizable commit box with auto-expand on content change (`43d91c9`)
- Added drag handle for manual height adjustment (80–600px)
- Auto-expand when content (e.g., AI-generated messages) exceeds current height

### feat: add AI-powered commit message generation (`d328049`)
- Backend: `generateCommitMessage()` calls Claude Haiku with conventional commit format system prompt
- Gathers patches for all staged files (up to 8KB) and passes to the generator
- Sparkle icon button in commit textarea triggers generation with loading spinner

---

## 2026-02-18

### adjust display of cwd and session id (`9ab383e`)
- Replaced inline cwd/session ID display with hover-triggered info popover (info circle icon)
- 150ms leave timer; each field independently shows "Copied!" on click

### Change toast location (`f193cf4`)
- Changed toast from `createPortal` with fixed positioning to relatively-positioned element within commit box container

### Update git commit message display (`1919f11`)
- Replaced inline success message with floating toast notification
- Added `toast-in`/`toast-out` CSS keyframe animations (slide up with fade)

### Further adjust title bar (`18bb516`)
- Shrunk VS Code and git branch icons to 11x11; branch name now `font-mono`; removed dropdown chevron

### Disable line wrap of git pill (`1beeaec`)
- Added `whitespace-nowrap` to both git pill states

### Adjust git pill (`be54f07`)
- Replaced checkmark icon + "Clean" text with just "No Changes" text

### Update git pill to line add/del instead of files modified/added (`8cdab98`)
- `GitService.getStatus()` now computes `linesAdded`/`linesRemoved` via `git diff --numstat`
- GitChangesPill redesigned to show `+<lines> | -<lines>` in green/red with monospace font
- Changed multiple elements from `items-center` to `items-baseline` for title bar alignment

### Optimise diff load time for large files and display git pill on all sessions (`e063650`)
- Split diff loading into two phases: fast `gitGetFilePatch` (patch string) then background `gitGetFileContents` (full file content)
- DiffViewer refactored with `ContentProps`/`PatchProps` discriminated union
- Synthetic unified diff for untracked files; ignore whitespace support with `-w` flag
- Added global `gitStatusCache` for instant status on new sessions with same cwd

### Add diff view feature (`9a0fb37`)
- Created `GitService` wrapping `simple-git` with 15+ operations (status, stage, unstage, commit, push, branches, file diff)
- Created 6 git components: `GitPanel`, `GitFileTree`, `GitFileDiffView`, `GitCommitBox`, `GitBranchPill`, `GitBranchDropdown`, `GitChangesPill`
- Added git IPC handlers with 3-second polling watcher via `git:start-watching`/`git:stop-watching`
- Added `useGitWatcher` hook for automatic git repo detection and status polling
- Added CSS custom properties for diff theming (10+ variables per theme)

### Capture error display and fix windows build (`b06cef1`)
- Added `signAndEditExecutable: false` for Windows build (no signing certificate)
- Collects stderr throughout session; appends last 20–30 stderr lines as context on errors
- CLI path existence check before launch; structured error messages for crashes

### Remove debugging files (`3cf9327`)
- Deleted accidentally committed `checkpoint1.md` and `test-prompt.md`

### Properly handle agent team feature, detecting member stop and team deletion (`a019700`)
- Added Patch C to `team-streaming`: emits `task_notification` to stdout when teammate finishes
- Added teammate status tracking with `session:teammate-status` events

### Fix team streaming and update UI to use it (`317c4d5`)
- Fixed missing semicolon in B2 injection causing syntax error
- Added `resolveTeammateToolUseId()` method and `teammateIdToToolUse` map for routing
- Subagent watcher tries stable filenames first (`agent-<name>--<team>.jsonl`)
- Replaced JSONL file watching with live stdout events from team-streaming patch

### Add teams streaming patch (`0f6ffb3`)
- **Patch A:** Fixes JSONL fragmentation by injecting stable `agentId` (sanitized `name@team`) so all turns write to a single file
- **Patch B:** Forwards teammate `stream_event`, `assistant`, and `user` messages to stdout with `teammate_id` routing

### Add agent teams patch and teams feature (`0f080ab`)
- Created `team-dowhile-fix` SDK patch — excludes `in_process_teammate` tasks from headless mode's do-while loop
- Created `SubagentWatcher` service — tails subagent JSONL files with `fs.watch` + debounced read + polling fallback
- Added teammate detection in `ClaudeSession` monitoring `TaskTool` calls with `team_name` parameter
- Created `AgentTabBar.tsx` — tab bar showing team lead and each teammate with status badges
- Created `TeamsView.tsx` for team overview
- Added `session:get-team-info`, `session:send-to-teammate`, `session:delete-team`, `session:write-to-mailbox` IPC handlers

### Bump SDK to 0.2.45 (`b0dc296`)
- Pinned `@anthropic-ai/claude-agent-sdk` at 0.2.45

---

## 2026-02-17

### Allow queueing messages up (`644b1d3`)
- Pressing send while agent is running now queues the message via `appendQueuedText()`
- `QueuedMessageCard` component shows queued text with truncated preview and edit button
- Auto-send on idle: effect watches `isRunning` transition from true→false
- Up-arrow on empty textarea retrieves queued text for editing
- Send and stop buttons now coexist; placeholder changes to "Type to queue a message..."

### Fix auto scroll and status line presentation (`92508d0`)
- Replaced distance-based scroll check with flag-based system (`shouldAutoScroll` ref)
- Added `ResizeObserver` on scroll container's first child for in-place element growth
- Multi-frame scroll on session switch (`requestAnimationFrame` + `setTimeout(80ms)`)
- Status line now sends accumulator-based data immediately, then reconciles from JSONL after 500ms delay
- Fixed project key derivation to replace dots (not just slashes)
- Added `rekeyMap` for status line routing during session rekey race conditions

---

## 2026-02-16

### Add support of slash commands with caching (`bd975c9`)
- Extracts `slash_commands` from SDK `system` message with `subtype:"init"`
- Filters out CLI-only commands (`context`, `cost`, `login`, etc.)
- Commands cached to `~/.claude/ui/slash-commands.json` and loaded at startup
- Created `SlashCommandMenu.tsx` — filtered autocomplete dropdown above input box
- Opens when typing `/` at start of input; keyboard navigation with up/down/Enter/Tab/Escape
- `/clear` handled client-side: creates new session with same working directory

### Add session cache and always display status line (`76e5f2d`)
- Replaced in-memory `session-summary-cache.ts` with disk-based cache at `~/.claude/ui/directory-cache.json`
- Single streaming pass through JSONL extracting title, cwd, timestamp, custom-title, summary, `hasConversation` flag
- Mtime-based cache invalidation; stale files parsed in parallel
- Status line now always displays (with zeros when no data)

### Optimise status line calculation in live session (`f2547f3`)
- Added in-memory token accumulators (`accInputTokens`, `accOutputTokens`, `accCachedTokens`, etc.) to `ClaudeSession`
- `accumulateUsage()` extracts usage from each assistant message's `betaMessage`
- `scheduleStatusLineUpdate()` with 50ms throttle; reconciles from JSONL after each result

### Fix status line calculation (`d41115b`)
- Removed `status-line-data` SDK patch entirely
- Replaced with JSONL-based `computeTokenMetrics()` that streams through entire file summing usage
- Added `cachedTokens` and `{cached}` template interpolation

### Add status line patch (`6a97015`)
- Created `status-line-data` SDK patch injecting `system` message with `subtype:"status_line"` after each result
- Created `ui-config.ts` — manages app settings and session config in `~/.claude/ui/` as JSON files (migrated from localStorage)
- Added `StatusLineData` type with cost, duration, token counts, context window usage
- InputBox gained status line bar with configurable template (`{cost}`, `{in}`, `{out}`, `{total}`, `{ctx_pct}`)
- Added `rekeySession()` for re-keying when SDK assigns real session ID

### Add different themes and build release script (`67abb14`)
- Added three themes: dark (default), light, monokai — implemented via CSS custom properties on `[data-theme]` selectors
- Each theme defines 20+ color variables
- Theme selector buttons in settings panel
- TerminalView dynamically computes colors from current theme CSS variables

---

## 2026-02-15

### Fix loading existing sub agent output (`41ca699`)
- Session history parser now returns `agentIdToToolUseId` map
- Historical sessions load subagent JSONL files in parallel using this map

### Fix agent streaming patch (`afdf118`)
- Expanded search window from 500 to 1000 chars for initial async path in SDK v2.1.42
- Dropped `isAsync:!0` literal check, relying on `for await` pattern only

---

## 2026-02-14

### remove virtualisation (`a2843ac`)
- Removed `@tanstack/react-virtual` virtualizer from ChatPanel (caused layout issues with dynamic content)
- TaskDetailPanel upgraded with flexbox resizable vertical split panes and `HResizeHandle` component
- Added CSS `content-visibility: auto` for message elements

### Remove web tsbuild info (`1754783`)
- Deleted `tsconfig.web.tsbuildinfo` build artifact

### Add code view, diff view and terminal view (`634d3fd`)
- Added `@tanstack/react-virtual` for virtualized message list (estimated 250px rows, overscan 5)
- MarkdownRenderer memoized with `React.memo`, components/plugins hoisted to module scope
- Input box moved from absolute overlay to normal flow with gradient fades
- Added custom `chat-scroll` scrollbar CSS

### Add code view, diff view and xterm render (`e0098e3`)
- Created `CodeView.tsx` using `prism-react-renderer` for syntax-highlighted code display with line numbers
- Created `DiffViewer.tsx` using `@git-diff-view/react` + `diff` library for unified/split diffs
- Created `TerminalView.tsx` using `@xterm/xterm` for ANSI escape code rendering
- Replaced old inline renderers: Bash→xterm, Read→syntax highlighting, Write→syntax highlighting, Edit→unified diffs
- Added JetBrains Mono font files

### Tweak UI components, tool calls, adding additional settings (`833a5e2`)
- Added "Open in VS Code" button to chat panel top bar
- New settings: `expandReadResults`, `uiFontScale` (1x–1.5x root zoom), `chatFontScale` (1x–1.5x chat zoom)
- Read tool results strip `cat -n` line-number prefixes
- Added "Watching" section to sidebar; scroll-to-bottom floating button

### Fix windows UI and tweak settings panel (`9a6c604`)
- Created `.claude/settings.json` with comprehensive tool permissions
- Added "Windows Path Format in Bash Commands" section to CLAUDE.md
- Settings panel moved from floating popover to inline expandable section
- Windows title bar buttons height increased; sidebar collapse button position made platform-aware

### Update .gitignore (`fb88875`)
- Added `test-prompt.txt` and `.claude` directory to `.gitignore`

### Remove settings.local.json (`5656061`)
- Deleted accidentally committed `.claude/settings.local.json`

### Ensure effort change is done mid-session (`e53a062`)
- Effort changes now cancel current session, create new one with same `activeSessionId` as `resumeSessionId`, passing new effort and restoring selected model
- Model selection stored per-session instead of local component state

### Allow disconnect session, move permission mode and effort to per session (`c395c62`)
- Made `permissionMode` and `effort` per-session instead of global
- Added `draftText` and `selectedModel` to per-session state
- `cancel()` now sends `disconnected` status (distinct from `idle`)
- Traffic light position adjusted on macOS

### Auto session name generation (`041eeac`)
- AI-powered title generation using Claude Haiku with "1-3 word title" system prompt
- Custom titles persisted to JSONL via `{"type":"custom-title","customTitle":"..."}` entries
- Sidebar inline rename (double-click) and context menu (Rename, Auto-name)

### Add settings, pinned session, and remove recent session (`a6d013b`)
- Pinned sessions with HTML5 drag-and-drop reordering
- "Remove from recent" button; max recent sessions slider
- Settings panel with toggles: expand tool calls, hide tool input, expand thinking
- Desktop notifications for sessions needing attention (permission required, ready for input)
- `cleanupEmptySession()` removes sessions with no messages when switching away

### Refine new session (`b4f9f22`)
- "New thread" renamed to "New session"; single-click shows welcome screen, double-click opens folder picker
- Welcome screen shows random motivational phrase from list of 10 with project folder dropdown

### bump to 0.2.42 (`d4496f8`)
- Consolidated three old patches into single `taskstop-notification` patch with Part A (killed→stopped mapping) and Part B (notification injection into TaskStop)

### add session loading and watching (`c9ffe27`)
- Created `session-watcher.ts` — monitors JSONL files for live external CLI sessions via `fs.watch`
- Created `session-summary-cache.ts` — mtime-based caching reading tail 8KB of JSONL for `type:"summary"` entries
- Added `startProjectsWatcher` watching `~/.claude/projects/` recursively with 500ms debounce
- Sessions show status indicators: green animated (running), green solid (SDK active), blue (watching), gray (inactive)
- Built `buildTodosFromMessages()` for reconstructing todo state from historical sessions

---

## 2026-02-13

### Add multi session support (`3933fa2`)
- Created `SessionManager` class mapping `routingId` strings to `ClaudeSession` instances
- Created `session-history.ts` (721 lines) — loads JSONL session logs, reconstructs `ChatMessage[]` including tool_use/tool_result correlation, thinking blocks, content block merging
- All IPC handlers refactored to accept `routingId` as first parameter
- Store refactored to manage multiple sessions via `sessions` Record keyed by `routingId`
- Sidebar expanded to show session tabs with active highlight, close button, directory switching
- All 20+ renderer components updated for new per-session store shape

### Trim CLAUDE.MD (`570307b`)
- Condensed verbose documentation into concise project guide (506 lines removed, 64 added)

### refine plan content display (`001289b`)
- Plan content now read from `~/.claude/plans/<slug>.md` via `getPlanContent()`
- ExitPlanModeCard refactored as collapsible card with markdown-rendered plan content
- User messages with `planContent` render as read-only plan blocks

### Update sub agent stream to work with 0.2.41 (`dac2ff9`)
- Updated subagent streaming patch regex patterns for SDK 0.2.41 minified names

### Update sdk to 0.2.41 and fix task stop send notification patch (`0dc1275`)
- Bumped SDK from 0.2.39 to 0.2.41
- Deleted `task-stop-direct` patch — SDK 0.2.41 natively supports `stopTask()`
- `stopTask()` now calls `this.activeQuery.stopTask(taskId)` directly

### Fix plan mode handling (`5400a7f`)
- Created `ExitPlanModeCard.tsx` (218 lines) — four options: start fresh with auto-accept edits, continue with auto-accept, continue with manual approval, keep planning with feedback textarea
- `canUseTool` deny response now includes `answers.feedback` as deny message
- Added `clearConversation()` store action

### Use SDK's model names (`9a8d55b`)
- Replaced hardcoded model list with `supportedModels()` fetched from SDK
- Models cached after first fetch; dropdown shows `shortName` extracted from description

### Allow adjust effort (`1633610`)
- Wired `setEffort()` through IPC to `ClaudeSession`

### Allow set model (`075751b`)
- Added `setModel()` delegating to `activeQuery.setModel()`
- Handles `system` messages with `subtype:"status"` for SDK-initiated permission mode changes
- Filters `EnterPlanMode`/`ExitPlanMode` tool blocks from message display

### Support modes (`c3e6434`)
- Added permission mode switching (Normal/Auto-edit/Plan) to InputBox
- Input box border color changes by mode: purple for auto-edit, teal for plan
- `Shift+Tab` cycles through modes
- Added CSS custom properties for mode colors

### Tweak stop button (`f268154`)
- Moved Stop button from collapsed footer to always-visible header row in TaskCard

### Allow killing commands directly (`09f26cf`)
- Created three SDK patches: `task-stop-direct`, `task-notification-killed-mapping`, `taskstop-send-notification`
- Added `stopTask(toolUseId)` method looking up agentId and sending `control_request`
- Added Stop buttons on TaskCard, TaskDetailPanel, and ToolCallBlock (for background Bash)
- Added `stoppingTaskIds` tracking in store

---

## 2026-02-12

### Support displaying background bash (`ce991e9`)
- File-tailing system for background command output files (polling every 500ms)
- ToolCallBlock "Background Output" viewer with terminal-style display and watch/unwatch lifecycle
- Ref-counted watchers to prevent duplicate polling

### display background agent usage info (`83a1543`)
- Created `task-notification-usage` SDK patch extracting `<usage>` data from task-notification XML
- TaskCard shows usage (totalTokens, toolUses, durationMs) from notifications

### auto scroll on task detail (`af8e7ca`)
- Replaced naive auto-scroll with `following` state pattern and `isAutoScrolling` ref
- Floating "scroll to bottom" button when not following

### Add auto scroll on task details and give it a height limit (`b0917f0`)
- Added `max-h-[60vh]` to task detail body with scroll-to-bottom behavior

### Add SDK error display (`b90123a`)
- Created `FloatingError.tsx` (96 lines) — floating error cards with expand/collapse for stack traces and dismiss button
- Changed `error: string | null` to `errors: string[]` in store

### Fix agent stream patch (`0aea736`)
- Discovered and patched "Filter #0" (`RVY()` function) that dropped `stream_event` types
- Expanded search window and updated README documentation

### auto apply patches (`01ee5a8`)
- Created `patch/apply-all.mjs` (23 lines) — master patch runner applying all patches in order
- Chained into `postinstall` script

### Update sub agent stream patch and display from events (`ee6a89d`)
- **Architectural shift:** replaced JSONL file polling with real-time SDK streaming events
- Deleted `jsonl-parser.ts`; removed all file-polling code
- Messages now route based on `parent_tool_use_id`: subagent messages go to dedicated channels
- Renamed `BackgroundMessages.tsx` to `SubagentMessages.tsx`
- Added `SubagentStreamDelta`, `SubagentMessageData`, `SubagentToolResultData` types

### Patch sdk to send agent thinking tokens and text (`25921a6`)
- Bumped SDK from 0.2.38 to 0.2.39
- Complete rewrite of `subagent-streaming` patch (336 lines) patching four filter points in `cli.js`
- README (765 lines) documents all four filters and dynamic variable extraction approach

---

## 2026-02-11

### Add proposal for sub agent event streaming (`9b28647`)
- Documentation-only: deep analysis of three SDK filters dropping sub-agent messages
- Complete message flow diagram, 16 key minified function names with offsets, proposed fix

### Fix task complete notification not getting sent issue (`236fb5c`)
- Created `task-notification` SDK patch injecting drain logic into headless mode
- Major refactor: introduced `MessageChannel<T>` push-based async iterable for persistent CLI subprocess
- Streaming input mode keeps CLI alive between user messages for background agent reporting
- Added stderr callback, error result detection, `<task-notification>` XML parsing from synthetic user messages

### Add sdk doc (`d8a90ad`)
- Added 23 markdown files in `docs/claude-agent-sdk/` (+12,026 lines) covering SDK API documentation

### Add background log parsing (`7cbbcd4`)
- Created `jsonl-parser.ts` (123 lines) parsing background agent JSONL transcript files
- Background task detection via regex scanning for `output_file:`/`agentId:` patterns
- Polling every 2 seconds via `setInterval`; cleanup on task notification or cancel
- Created `BackgroundMessages.tsx` for rendering parsed agent messages
- Added `backgroundTaskToolUseIds`, `backgroundOutputs` to store

### Fix windows window control (`8382782`)
- Platform-conditional BrowserWindow: macOS (transparent + vibrancy), Windows (frameless + acrylic)
- Created `WindowControls.tsx` (48 lines) — minimize/maximize/close styled like Windows 11
- Fixed path splitting for Windows backslash paths (`dir.split(/[\\/]/)`)

### Support displaying tasks on side panel (`2cd0f8a`)
- Added handlers for `tool_progress` and `task_notification` SDK messages
- Created `TodoWidget` (123 lines) — floating widget with circular progress and completion counter
- Created `TaskDetailPanel` (193 lines) — 400px right panel with task status, elapsed time, results
- Created `TaskCard` (229 lines) — inline chat component for Task tool calls
- Created `FloatingApproval` (107 lines) — floating approval cards for sub-agent tool permissions

### Support AskUserQuestion tool call (`84c89ec`)
- Created `AskUserQuestionBlock` (309 lines) — wizard-style multi-step questionnaire UI
- Supports single-select (radio), multi-select (checkboxes), and "Other" free-text option
- Back/Next navigation for multi-question flows; collapsed summary when complete
- Extended approval flow to pass `answers` through `updatedInput`

### Remove empty blinking cursor before agent returns tokens (`c6b67f0`)
- Removed always-rendered `<span className="animate-cursor-blink" />` from StreamingText

### Update UI, tweaking approval and grouping, thinking process (`4008d96`)
- Added thinking support: `thinking: { type: 'enabled', budgetTokens: 10000 }` to SDK options
- Created `ThinkingBlock.tsx` (93 lines) — wave text animation, live timer, expandable content
- Changed `pendingApproval` (singular) to `pendingApprovals` (array) for concurrent approvals
- Added `mergeContentBlocks()` preserving tool_use/tool_result across partial message updates
- Message grouping: consecutive `tool_use` blocks grouped in bordered containers
- Tool approval moved inline to ToolCallBlock (was separate ApprovalPrompt component)

### [Stage 1] Single session with UI (`cc429f8`)
- **Full application scaffold** — 46 files, +3,887 lines
- Electron BrowserWindow with transparent background, macOS vibrancy, hidden inset title bar
- `ClaudeSession` class wrapping `sdkQuery()` with async generator handling 4 message types
- `canUseTool` callback with UUID-keyed Promise stored in `pendingApprovals` Map
- `ClaudeAPI` interface with 7 methods and 7 event listeners via `contextBridge`
- Zustand store with `addMessage` upserting by ID for SDK partial message deduplication
- UI components: SessionView, Sidebar, ChatPanel, InputBox (model/effort pickers), MessageBubble, ToolCallBlock (collapsible, tool-specific rendering), ApprovalPrompt, MarkdownRenderer, StreamingText
- Tailwind v4 dark theme with 15+ CSS custom property color tokens, 5 custom animations
- `CLAUDE.md` documenting tech stack, architecture, and known gotchas

---

## 2026-02-10

### Init (`44d14a1`)
- Renamed project from "ClaudeHub" to "ClaudeUI" in planning documents

### Init (`09167ee`)
- Created `PLAN.md` (393 lines) — full project vision across 7 phases with tech stack, architecture, SDK investigation findings
- Created `phase1.md` (279 lines) — detailed Phase 1 implementation plan broken into 7 steps
