# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop GUI for Claude Code sessions, built with Electron. Features include multi-session chat, integrated git UI, terminal emulator, automation scheduling, remote web access, voice input, plugin system, and usage analytics.

## Tech Stack

- **Electron** with `electron-vite` (react-ts template)
- **React 19** + **TypeScript**
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin (no postcss/tailwind config files)
- **Zustand** for state management
- **react-markdown** + **remark-gfm** for rendering
- **@anthropic-ai/claude-agent-sdk** (0.2.97) for Claude integration
- **simple-git** for git operations
- **node-pty** + **@xterm/xterm** for terminal emulator
- **mermaid** for diagram rendering
- **cron-parser** for automation scheduling
- **Prism.js** for syntax highlighting in diffs
- **Package manager: bun** (not npm/yarn)

## Commands

- `bun run dev` — start in development mode with hot reload
- `bun run build` — typecheck + build
- `bun run build:mac` — build macOS distributable
- `bun run build:win` — build Windows distributable
- `bun run test` — run Vitest tests
- `bun run test:watch` — run tests in watch mode
- `bun run typecheck` — run TypeScript checks (node + web)
- `bun run lint` — ESLint
- `bun run format` — Prettier
- `bun patch/apply-all.mjs` — apply SDK patches (also runs automatically via `postinstall`)

## Project Structure

```
src/
  shared/
    types.ts               — All shared TypeScript types (ContentBlock, ChatMessage, ClaudeAPI, etc.)
    remote-protocol.ts     — WebSocket message types for remote access
    e2e-crypto.ts          — AES-256-GCM E2E encryption (isomorphic Node + browser)
  main/
    index.ts               — Electron BrowserWindow setup, app lifecycle, service wiring
    ipc/
      session.ipc.ts       — Core IPC: sessions, git, config, MCP, usage, worktrees, voice, proxy
      terminal.ipc.ts      — PTY create/write/resize/kill
      automation.ipc.ts    — Automation CRUD + run management
      remote-handlers.ts   — WebSocket dispatch bridge (same handlers as session.ipc)
    services/              — 29 service modules (see Services section below)
  preload/
    index.ts               — Context bridge (ClaudeAPI → window.api, 280+ lines)
    plugin-preload.ts      — Plugin sandbox bridge (window.pluginApi)
    log-viewer-preload.ts  — Log viewer window bridge
  renderer/src/
    stores/
      session-store.ts     — Primary Zustand store (sessions, settings, git, terminals, etc.)
      automation-store.ts  — Automation scheduling state
    hooks/
      useClaudeEvents.ts   — Master IPC event listener → store actions
      useAutomationEvents.ts — Automation IPC listeners
      useGitWatcher.ts     — Git repo detection + status polling
      useSlashMenu.ts      — Slash command (/) autocomplete
      useFileMention.ts    — File mention (@path) autocomplete with directory browsing
      useTerminalColdCleanup.ts — Orphaned terminal cleanup (10-min timeout)
      useGutterDragSelection.ts — Line selection in diffs
      useTextSelectionComment.ts — Inline comment placement in diffs
      useIsMobile.ts       — Responsive breakpoint detection
    components/
      SessionView.tsx      — Root layout (sidebar + main + right panel + terminal)
      Sidebar.tsx          — Session list, directory browser, pinning, custom titles
      WelcomeScreen.tsx    — Initial folder picker
      SettingsDialog.tsx   — Full settings UI (theme, fonts, diff, sandbox, proxy, voice)
      PermissionsDialog.tsx — Claude permission rule management
      McpDialog.tsx        — MCP server configuration
      SkillsDialog.tsx     — Available skills listing
      RemoteAccessModal.tsx — Remote web client connection
      TodoWidget.tsx       — Floating task list overlay
      TaskDetailPanel.tsx  — Task/subagent detail sidebar
      TeamsView.tsx        — Multi-agent team monitoring
      WindowControls.tsx   — macOS traffic light buttons
      WorktreesModal.tsx   — Git worktree management
      QuitWorktreeModal.tsx — Worktree cleanup on quit
      WorktreeCleanupModal.tsx — Orphaned worktree cleanup
      chat/                — 24 components (ChatPanel, InputBox, MessageBubble, ToolCallBlock,
                             StreamingText, FloatingApproval, FloatingError, ThinkingBlock,
                             SubagentMessages, AgentTabBar, SlashCommandMenu, FileMentionMenu,
                             FileAttachmentBar, MermaidDiagram, MarkdownRenderer, CodeView,
                             ExitPlanModeCard, TaskCard, TodoToolBlock, TerminalView,
                             AskUserQuestionBlock, BtwCard, PermissionSuggestions,
                             SandboxViolationToast)
      git/                 — 11 components (GitPanel, GitFileTree, GitFileDiffView, GitCommitBox,
                             GitBranchDropdown, GitBranchPill, GitChangesPill, WorktreePill,
                             DiffCommentBadge, DiffCommentWidget, ReviewBar)
      plan/                — 4 components (PlanReviewPanel, PlanReviewBar, PlanCommentBadge,
                             PlanCommentWidget)
      automation/          — 5 components (AutomationView, AutomationList, AutomationDetail,
                             AutomationConfig, AutomationRunHistory)
      terminal/            — 2 components (TerminalPanel, XTermInstance)
      usage/               — 4 components + utils (UsageView, BlockTimeline, DailyUsageChart,
                             TokenDonut, usage-utils.ts)
      plugin/              — 1 component (PluginWebView)
    lib/diff/              — Custom diff viewer library (DiffViewer, parse-patch, build-rows,
                             highlight, UnifiedDiffTable, SplitDiffTable, StaticDiffTable, etc.)
    utils/
      content-blocks.ts    — Message content block merging for partial updates
      ipc-timeout.ts       — Promise timeout wrapper for IPC calls
      sanitize-svg.ts      — SVG sanitization for plugin views
  renderer/log-viewer/     — Standalone log viewer window (LogViewer.tsx + filtering)
  web/                     — Remote access web client (WebSocket + E2E encryption)
    main.tsx, connection.ts, api-adapter.ts, components/ConnectionOverlay.tsx
patch/                     — SDK monkey-patches (applied via postinstall)
docs/adr/                  — Architectural Decision Records
```

## Services

All services live in `src/main/services/`. Key modules:

| Service | Purpose |
|---------|---------|
| `claude-session.ts` | Core SDK wrapper — spawns `sdkQuery()`, handles streaming, approvals, tool results |
| `session-manager.ts` | Maps routingId → ClaudeSession, manages lifecycle, rekey, timeouts |
| `session-history.ts` | Parses JSONL transcripts, loads message history, computes token metrics |
| `session-watcher.ts` | Watches session JSONL files for live updates |
| `service-session.ts` | Lightweight CLI subprocess for background usage polling |
| `automation-manager.ts` | Cron/interval scheduling, per-file storage, run history, SDK execution |
| `git-service.ts` | Wraps simple-git: status, branches, stage/unstage, commit, push/pull, diff |
| `worktree.ts` | Git worktree create/remove/list |
| `pty-manager.ts` | Spawns shell PTYs (pwsh/cmd on Windows, bash/zsh on Unix) |
| `plugin-manager.ts` | Loads plugins from `~/.claude/ui/plugins/`, lifecycle, isolated IPC |
| `remote-server.ts` | HTTP + WebSocket server, token auth, E2E encryption, tunnel support |
| `remote-dispatcher.ts` | Routes WebSocket requests to handlers (same as IPC, with blocklist) |
| `remote-bridge.ts` | Subscribes to session/config events, broadcasts to remote clients |
| `usage-fetcher.ts` | Polls `/api/oauth/usage`, merges rate-limit headers, disk cache |
| `block-usage.ts` | Parses JSONL for token analytics, 5hr billing windows, per-model breakdown |
| `logger.ts` | File + ring buffer logging, per-source levels, subscriber pattern |
| `log-viewer.ts` | Spawns debug window, streams logs |
| `ui-config.ts` | Manages `~/.claude/ui/config/` (settings, sessions, slash commands) |
| `claude-settings.ts` | Claude permission rules (allow/deny/ask) per scope |
| `claude-mcp.ts` | MCP server config merge from `.mcp.json` + `settings.json` |
| `skill-scanner.ts` | Scans project/user/plugin skill directories, YAML frontmatter parser |
| `event-log.ts` | Ring buffer of all events for remote client catchup |
| `mermaid-tool.ts` | MCP server for Mermaid diagram rendering |
| `tunnel-manager.ts` | CloudFlare tunnel management for remote access |
| `socks-bridge.ts` | Local HTTP CONNECT bridge for SOCKS5 proxy support |
| `voice-capture.ts` | Native audio capture wrapper |
| `voice-client.ts` | Streams voice input to transcription server |
| `subagent-watcher.ts` | Watches subagent task files, parses messages |
| `persisted-sessions-dir.ts` | Path constant for `~/.claude/ui/persisted-sessions` |

## Architecture

### IPC Communication
- Main ↔ Renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`
- Typed `ClaudeAPI` interface in `shared/types.ts`, exposed on `window.api`
- Fire-and-forget pattern for `session:send` (streams results back via events)
- `safeHandler()` wrapper returns `{ ok, data, error }` envelopes; `unwrap()` in preload throws on failure
- Same handlers exposed via WebSocket (remote-dispatcher) with a blocklist for desktop-only channels

### Data Flow

```
User types prompt → InputBox.handleSend()
  → addUserMessage() (Zustand)
  → window.api.sendPrompt(prompt, attachments?) (IPC)
  → session.run(prompt) (main process)
  → sdkQuery() async generator
    → stream_event → session:stream → appendStreamingText()
    → assistant    → session:message → addMessage() (upserts by ID)
    → user (tool_result) → session:tool-result → appendToolResult()
    → canUseTool   → session:approval-request → setPendingApproval()
    → result       → session:result (cost tracking)
```

### Key Patterns
- **Message upsert by ID** — SDK sends partial messages with the same `betaMessage.id`; updates replace in place rather than duplicating
- **Approval Promise** — `canUseTool` callback creates a Promise stored in `pendingApprovals` Map, resolved when user clicks Allow/Deny
- **Tool result extraction** — Tool results arrive via synthetic `type: 'user'` messages (not assistant), extracted by `extractToolResults()`
- **SDK externalization** — `claude-agent-sdk` is externalized in Vite build (`rollupOptions.external`), bundled via `extraResources` in electron-builder
- **Multi-session routing** — Each session has a `routingId`; IPC events are routed by this ID so multiple sessions can coexist
- **Session rekey** — When the SDK session starts, the temporary routingId is rekeyed to the SDK's session UUID
- **Git status polling** — `useGitWatcher` starts/stops `GitService.startPolling()` based on active session's cwd
- **Terminal grouping** — Terminals are grouped by normalized cwd, survive session switching, cleaned up after 10 min inactivity (ADR-003)
- **Remote dual-mode** — Same handlers serve both Electron IPC and WebSocket clients (remote-handlers.ts mirrors session.ipc.ts)

### Views
The app has four main views switchable via sidebar:
- **Chat** — Primary Claude conversation interface
- **Usage** — Token analytics dashboard (5hr blocks, daily charts, per-model breakdown)
- **Automations** — Cron/interval scheduled prompt execution with run history
- **Plugin** — Embedded plugin WebView (when a plugin registers a view)

### Design
- Three themes: **dark** (default), **light**, **monokai** — CSS custom properties in `@theme` block of `main.css`
- Transparent window with `vibrancy: 'under-window'` on macOS, acrylic on Windows
- Resizable sidebar (240–480px) + main content area + optional right panel (git/tasks/plan)
- Bottom terminal panel (resizable, 120–600px), always-mounted to preserve xterm scrollback (ADR-002)

## Testing

- **Framework:** Vitest with jsdom environment (node override via `@vitest-environment node` comment)
- **Config:** `vitest.config.ts` — globals enabled, setup file loads `@testing-library/jest-dom`
- **Pattern:** `src/**/__tests__/**/*.test.{ts,tsx}`
- **Coverage areas:** Logger, diff library (parse/build/highlight), content block merging, todo building, usage formatting, block-usage pricing/grouping, e2e-crypto, automation store, session-store, session-manager, skill-scanner, usage-fetcher, session-history, preload unwrap, IPC timeout

## Windows Path Format in Bash Commands

On Windows (Git Bash), the SDK's working directory uses POSIX format (`/d/WorkPlace/ClaudeUI`), not Windows format (`D:\WorkPlace\ClaudeUI` or `D:/WorkPlace/ClaudeUI`). This matters for permission checks:

- **Never prefix Bash commands with `cd D:/...`** — it's redundant (already in the working dir) and causes permission prompts because the SDK filters `cd <cwd>` by exact string match, and `D:/WorkPlace/ClaudeUI` ≠ `/d/WorkPlace/ClaudeUI`.
- When a path **must** be specified in a command argument, use POSIX format: `/d/WorkPlace/ClaudeUI` not `D:\WorkPlace\ClaudeUI`. This matches what the SDK sees as the working directory and ensures `cd` auto-filtering and permission rules work correctly.

## Known Gotchas

### Tailwind v4 + CSS Reset
Never add a `* { margin: 0; padding: 0; }` reset after `@import "tailwindcss"` in main.css. It will appear **after** Tailwind's utility layer in the built CSS, silently overriding all padding/margin utilities. Tailwind v4's preflight already handles this.

### Tailwind Source Scanning
The `@source "../../";` directive in main.css is required so the Tailwind scanner finds renderer source files. Without it, some utility classes won't generate.

### Electron Transparency
Requires `transparent: true` + `vibrancy` on BrowserWindow, plus `background: transparent` on html, body, and #root. Any opaque background in the component tree blocks the effect.

### SDK canUseTool Return Value
Must return `{ behavior: 'allow', updatedInput: input }` (passing back the original input). The SDK's Zod schema requires `updatedInput` despite TypeScript marking it optional — omitting it causes a ZodError. For deny: `{ behavior: 'deny', message: '...' }`.

### SDK Message Flow
With `includePartialMessages: true`, messages arrive in order: `assistant` (partial updates) → `user` (synthetic tool_result) → `assistant` (response) → `result` (cost). Assistant messages share the same `betaMessage.id` across partial updates.

### Terminal Panel Always Mounted
The terminal panel uses `display: none` (closed) / `display: contents` (open) instead of conditional rendering. Unmounting destroys xterm scrollback buffers. See ADR-002.

### Usage Utilization Scales
The `/api/oauth/usage` API returns utilization as 0–100 (percentage), while rate-limit HTTP headers return 0–1 (fraction). Both are stored as 0–100 in `RateWindow.usedPercent`. The `toUsedPercent()` helper in `usage-fetcher.ts` makes this conversion explicit.

## Analyzing the SDK Bundle

The SDK ships a minified `cli.js` (~11 MB) at `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. **Always use the `bundle-analyzer` skill** (invoke via `/bundle-analyzer`) to navigate this code. Standard grep/read tools are ineffective on minified bundles.

Typical workflow: `find` by string literals → `extract-fn` → `strings --near` → `refs` → `decompile` → `patch-check` for uniqueness. Never search by minified variable names — they change between versions.

## SDK Patches

Patches live in `patch/` and fix limitations in the bundled `cli.js`. Each patch is a directory with `apply.mjs` + `README.md`.

**Current patches (13 registered in `apply-all.mjs`):**

| Patch | Purpose |
|---|---|
| `subagent-streaming` | Forwards subagent stream events + messages to SDK consumer |
| `taskstop-notification` | Sends task_notification on TaskStop (Part A killed→stopped mapping upstreamed in 0.2.49) |
| `team-streaming` | Forwards teammate stream events + messages to SDK consumer; emits task_notification on completion |
| `queue-control` | Adds `dequeue_message` control request and `queued_command_consumed` notification |
| `mcp-status` | Fixes `mcp_status` returning empty array by awaiting headless MCP server refresh |
| `mcp-tool-refresh` | Refreshes MCP tool list after server reconnection before each API call |
| `sandbox-network-fix` | Fixes sandbox network proxy always starting even when no domain restrictions are configured |
| `background-task` | Exposes CLI's background task feature via SDK control message API |
| `usage-relay` | Relays CLI's internal `/usage` API through SDK control messages (avoids 429s) |
| `request-usage` | Emits per-request token usage data from cli.js after message_stop event |
| `rate-limit-relay` | Forwards per-window rate limit utilization data to SDK stdout after inference calls |
| `incomplete-session-resume-fix` | Fixes broken parentUuid chain when resuming with filtered progress messages |
| `voice-server` | Adds lightweight TCP voice server for streaming audio transcription |

**Not registered (on disk only):**
- `webfetch-headers` — exists in `patch/` but not in `apply-all.mjs`

**Upstreamed (removed):**
- ~~`task-notification-usage`~~ — upstreamed in SDK 0.2.49
- ~~`team-dowhile-fix`~~ — upstreamed in SDK 0.2.59

### Writing a new patch

**Skills for patch work:**
- `/bundle-analyzer` — Navigate the minified `cli.js`. Find code by string literals, extract functions, trace references, decompile to readable output. Essential for locating patch targets.
- `/patch-readme` — Generate or update a patch's `README.md` as a reverse-engineering guide that enables rebuilding the patch from scratch when the SDK updates.
- `/patch-test-harness` — Write and run behavioral tests that verify a patch is functioning correctly.

`apply.mjs` conventions:
1. Read `cli.js`, check for `/*PATCHED:<name>*/` marker (idempotency)
2. Find code by **content patterns/string literals** — never char offsets or minified names directly
3. Extract minified variable names dynamically from regex captures
4. Use `const V = '[\\w$]+'` for matching minified identifiers
5. Verify pattern matches exactly once, apply replacement with marker, write back and verify

`README.md` should document: the bug, the fix (before/after), which `bundle-analyzer` commands find the code, and stable anchors for future versions.

Register new patches in the `patches` array in `patch/apply-all.mjs`.

## Architectural Decision Records

ADRs live in `docs/adr/`. See `docs/adr/adr.md` for the index.

| ADR | Title | Status |
|-----|-------|--------|
| 001 | Preserve `@` file mentions in user prompt text sent to SDK | Accepted |
| 002 | Always mount TerminalPanel to preserve xterm scrollback buffers | Accepted |
| 003 | Group terminal tabs by session cwd with 10-minute cold cleanup | Accepted |
| 004 | VS Code-style plugin system for extensibility | Accepted |
| 005 | Plugin session API — sessionId-based events and history | Accepted |

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR entry. When adding a new ADR, proactively scan existing ADRs to check if the new decision supersedes or conflicts with a previous one — if so, update the old ADR's status to "Superseded by ADR-XXX" and note it in the new ADR.
