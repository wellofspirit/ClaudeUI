# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop GUI for Claude Code sessions, built with Electron. Features include multi-session chat, integrated git UI, terminal emulator, automation scheduling, remote web access, voice input, plugin system, and usage analytics.

## Development Workflow (read this first)

For any **non-trivial change**, follow the loop in **[ADR-026](docs/adr/adr-026_development-workflow.md)** (the full step-by-step + standing constraints live there):

- **The main model (Opus) orchestrates, reviews, and commits; a Sonnet sub-agent implements.** Dispatch the implementer via `Agent` (`subagent_type: general-purpose`, `model: sonnet`) against a written kickoff spec.
- **The implementing agent never self-certifies** and never commits / `git add`s / branches / runs `bun install`. It leaves the working tree for review.
- **Review every single line** of the agent's diff (`git diff <base>`) — read the code, not the summary; re-run gates independently; verify guard tests actually fail pre-fix. Iterate fixes via `SendMessage` to the agent.
- **Verify against the real dev build** before committing: `bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`, then drive the real Electron app (`verifier-electron` skill / `scripts/app-shot.mjs`) — **assert the live DOM by `data-testid` (ADR-027) before reading the screenshot**.
- **Commit precisely** (never blind `git add -A`), one commit per item, no AI attribution.

Trivial one-line/mechanical edits and conversational answers are exempt. Independent slices may run as concurrent Sonnet agents, but each diff is reviewed on its own and gates run on the combined tree before any commit.

## Tech Stack

- **Electron** with `electron-vite` (react-ts template)
- **React 19** + **TypeScript**
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin (no postcss/tailwind config files)
- **Zustand** for state management
- **react-markdown** + **remark-gfm** for rendering
- **Claude Code CLI** integrated directly — we rebundle Anthropic's official Bun standalone binary with our patched cli.js, producing `vendor/claude-cli/bun-claude[.exe]` at build time. Handles PE (Windows `.bun` section) and Mach-O (macOS `__BUN,__bun` section + ad-hoc codesign); ELF (Linux) is a follow-up. Spawned natively (no `ELECTRON_RUN_AS_NODE`, no cli.js arg injection). No `@anthropic-ai/claude-agent-sdk` dependency. See **[docs/protocol/](docs/protocol/)** (build pipeline in [01-transport.md §1.12](docs/protocol/01-transport.md); rationale in [ADR-006](docs/adr/adr-006_rebundle-bun-binary.md)).
- **@modelcontextprotocol/sdk** for in-process MCP server hosting
- **simple-git** for git operations
- **node-pty** + **@xterm/xterm** for terminal emulator
- **better-sqlite3** for the operational DB (`~/.claude/ui/operational.db`) — native module, Electron-ABI. Holds operational/derived state (currently per-session `{engineId, model}`). See **[Persistence model](#persistence-model)** and ADR-020.
- **mermaid** for diagram rendering
- **cron-parser** for automation scheduling
- **Prism.js** for syntax highlighting in diffs
- **Package manager: bun** (not npm/yarn)

## Commands

- `bun run dev` — start in development mode with hot reload (runs `ensure-cli` first)
- `bun run build` — typecheck + build
- `bun run build:mac` — build macOS distributable
- `bun run build:win` — build Windows distributable
- `bun run ensure-cli` — extract wrapped cli.js, apply patches, rebundle into `bun-claude[.exe]` (cache-hit skip on matching version)
- `bun run update-cli` — force re-extract, re-patch, and re-rebundle (use after bumping `claudeCliVersion`)
- `bun run test` — run Vitest tests
- `bun run test:watch` — run tests in watch mode
- `bun run typecheck` — run TypeScript checks (node + web)
- `bun run lint` — ESLint
- `bun run format` — Prettier
- `bun run rebuild:native` — rebuild native modules (better-sqlite3) to the **Electron ABI** via `electron-builder install-app-deps`. **Run after every `bun install`/`bun add`/`bun remove`** — bun's postinstall leaves a Node-ABI build of better-sqlite3, which crashes the app on boot with `ERR_DLOPEN_FAILED`. Fresh clones: `bun install && bun run rebuild:native`.

The upstream CLI version is pinned via `package.json#claudeCliVersion`. `ensure-cli` is wired into `postinstall`, `dev`, and every `build:*` script.

## Project Structure

```
src/
  shared/
    types.ts               — All shared TypeScript types (ContentBlock, ChatMessage, ClaudeAPI,
                             EngineConfig/VendorConfig for the config-plane stores, etc.)
    model-capabilities.ts  — Capability model (EngineCapabilities/ResolvedCapabilities), AutonomyMode,
                             effort/thinking/context-window helpers
    remote-protocol.ts     — WebSocket message types for remote access
    e2e-crypto.ts          — AES-256-GCM E2E encryption (isomorphic Node + browser)
  main/
    index.ts               — Electron BrowserWindow setup, app lifecycle, service wiring
    sdk/                   — In-house cli.js harness, replaces @anthropic-ai/claude-agent-sdk
                             query(), tool(), createSdkMcpServer() + 9 modules
                             Full details: docs/protocol/ (module map in 01-transport.md §1.13)
    providers/             — Engine abstraction layer (ADR-016 → ADR-018)
      ISession.ts          — Engine-neutral session interface + EngineSessionFactory type
      BaseSession.ts       — Abstract base: extraWindows, send(), inactivity timer, getMessages()
      EngineRegistry.ts    — Singleton factory (engineRegistry.createSession)
      register-engines.ts  — Side-effect bootstrap: registers the 'claude' factory
    ipc/
      session.ipc.ts       — Core IPC: sessions, git, config, MCP, usage, worktrees, voice, proxy
      terminal.ipc.ts      — PTY create/write/resize/kill
      automation.ipc.ts    — Automation CRUD + run management
      remote-handlers.ts   — WebSocket dispatch bridge (same handlers as session.ipc)
    services/              — 30 service modules (see Services section below)
      db.ts                — Operational SQLite DB (better-sqlite3) — the ONLY importer of the native module
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
      SettingsDialog/      — Settings UI, organized as a tier tree (App / Engines › Claude /
                             Vendors › Anthropic / Accounts). SettingsDialog.tsx (FC, loads
                             engine/vendor config), View.tsx (two-level nav + scroll-spy),
                             settings-sections.tsx (SECTIONS + NAV_GROUPS + autonomy-mode picker
                             + vendor display-only), settings-controls.tsx. See Settings & Config.
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
  test/                      — Shared test infrastructure
    bridges/                 — TestIpcBridge (Electron IPC replacement)
    stubs/                   — electron-shim, sdk-stub, better-sqlite3-stub (node:sqlite adapter — see Persistence)
    factories/               — messages.ts, sdk-events.ts (test data builders)
    helpers/                 — boot-test-app.ts, wait-for-store.ts, render-with-store.ts
    setup/                   — jsdom.setup.ts, node.setup.ts
  e2e/flows/                 — Layer 3 E2E tests
  integration/               — Layer 4 integration tests
vendor/claude-cli/         — Rebundled bun-claude[.exe] + wrapped cli.js source (not checked in)
scripts/                   — Build-time helpers (extract-cli.mjs, rebundle-cli.mjs, ...)
patch/                     — cli.js content-regex patches applied before rebundle
docs/adr/                  — Architectural Decision Records
docs/protocol/             — cli.js wire-protocol manual + build pipeline + harness reference
```

## Services

All services live in `src/main/services/`. Key modules:

| Service                     | Purpose                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `claude-session.ts`         | Core cli.js wrapper — spawns `sdkQuery()` from `src/main/sdk`, handles streaming, approvals, tool results |
| `session-manager.ts`        | Maps routingId → ClaudeSession, manages lifecycle, rekey, timeouts                                        |
| `session-history.ts`        | Parses JSONL transcripts, loads message history, computes token metrics                                   |
| `session-watcher.ts`        | Watches session JSONL files for live updates                                                              |
| `service-session.ts`        | Lightweight CLI subprocess for background usage polling                                                   |
| `automation-manager.ts`     | Cron/interval scheduling, per-file storage, run history, cli.js execution                                 |
| `git-service.ts`            | Wraps simple-git: status, branches, stage/unstage, commit, push/pull, diff                                |
| `worktree.ts`               | Git worktree create/remove/list                                                                           |
| `pty-manager.ts`            | Spawns shell PTYs (pwsh/cmd on Windows, bash/zsh on Unix)                                                 |
| `plugin-manager.ts`         | Loads plugins from `~/.claude/ui/plugins/`, lifecycle, isolated IPC                                       |
| `remote-server.ts`          | HTTP + WebSocket server, token auth, E2E encryption, tunnel support                                       |
| `remote-dispatcher.ts`      | Routes WebSocket requests to handlers (same as IPC, with blocklist)                                       |
| `remote-bridge.ts`          | Subscribes to session/config events, broadcasts to remote clients                                         |
| `usage-fetcher.ts`          | Polls `/api/oauth/usage`, merges rate-limit headers, disk cache                                           |
| `block-usage.ts`            | Parses JSONL for token analytics, 5hr billing windows, per-model breakdown                                |
| `logger.ts`                 | File + ring buffer logging, per-source levels, subscriber pattern                                         |
| `log-viewer.ts`             | Spawns debug window, streams logs                                                                         |
| `db.ts`                     | Operational SQLite DB (better-sqlite3): versioned migrations + `session_meta` repo. ONLY native importer  |
| `ui-config.ts`              | Plain-text config: `settings.json` (plane ①), `engines/<id>.json` + `vendors/<id>.json` (plane ③), sessions, slash commands; session metadata is DB-backed |
| `claude-settings.ts`        | Claude permission rules (allow/deny/ask) per scope — engine-native config (plane ②)                       |
| `claude-mcp.ts`             | MCP server config merge from `.mcp.json` + `settings.json` — engine-native config (plane ②)               |
| `skill-scanner.ts`          | Scans project/user/plugin skill directories, YAML frontmatter parser                                      |
| `event-log.ts`              | Ring buffer of all events for remote client catchup                                                       |
| `mermaid-tool.ts`           | MCP server for Mermaid diagram rendering                                                                  |
| `tunnel-manager.ts`         | CloudFlare tunnel management for remote access                                                            |
| `socks-bridge.ts`           | Local HTTP CONNECT bridge for SOCKS5 proxy support                                                        |
| `voice-capture.ts`          | Native audio capture wrapper                                                                              |
| `voice-client.ts`           | Streams voice input to transcription server                                                               |
| `subagent-watcher.ts`       | Watches subagent task files, parses messages                                                              |
| `persisted-sessions-dir.ts` | Path constant for `~/.claude/ui/persisted-sessions`                                                       |

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
  → sdkQuery() from src/main/sdk — spawns bun-claude[.exe] (Bun runtime with cli.js embedded), speaks stream-json over stdio
    → stream_event → session:stream → appendStreamingText()
    → assistant    → session:message → addMessage() (upserts by ID)
    → user (tool_result) → session:tool-result → appendToolResult()
    → can_use_tool control_request → session:approval-request → setPendingApproval()
    → result       → session:result (cost tracking)
```

### Key Patterns

- **Message upsert by ID** — cli.js sends partial messages with the same `betaMessage.id`; updates replace in place rather than duplicating
- **Approval Promise** — `canUseTool` callback creates a Promise stored in `pendingApprovals` Map, resolved when user clicks Allow/Deny
- **Tool result extraction** — Tool results arrive via synthetic `type: 'user'` messages (not assistant), extracted by `extractToolResults()`
- **Scoped child env** — historically `ELECTRON_RUN_AS_NODE=1` rode in the spawn `env` overlay only to avoid poisoning Electron's GPU/renderer children. Retired when cli.js moved into the rebundled Bun binary; the `env` overlay mechanism in `query.ts` remains for any future per-spawn env isolation
- **Multi-session routing** — Each session has a `routingId`; IPC events are routed by this ID so multiple sessions can coexist
- **Session rekey** — When the cli.js session starts, the temporary routingId is rekeyed to the session UUID from the first `system/init` event
- **Git status polling** — `useGitWatcher` starts/stops `GitService.startPolling()` based on active session's cwd
- **Terminal grouping** — Terminals are grouped by normalized cwd, survive session switching, cleaned up after 10 min inactivity (ADR-003)
- **Remote dual-mode** — Same handlers serve both Electron IPC and WebSocket clients (remote-handlers.ts mirrors session.ipc.ts)
- **cli.js integration details** — see **[docs/protocol/](docs/protocol/)** for wire protocol, control subtypes, MCP hosting, cancellation tiers, and the extraction/rebundle pipeline

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

Four-layer testing architecture. Full details in **[docs/testing-strategy.md](docs/testing-strategy.md)**.

| Project         | Command                    | What it tests                         | File pattern                               |
| --------------- | -------------------------- | ------------------------------------- | ------------------------------------------ |
| **unit**        | `bun run test:unit`        | Pure rendering, pure functions        | `*.test.ts`, `*.unit.test.tsx`             |
| **component**   | `bun run test:component`   | Business logic (events → store state) | `*.component.test.ts`                      |
| **e2e**         | `bun run test:e2e`         | Full pipeline (bridge events → store) | `*.e2e.test.ts`                            |
| **git**         | `bun run test:git`         | Real simple-git / filesystem (slow)   | `git-service*.test.ts`, `worktree.test.ts` |
| **integration** | `bun run test:integration` | Real cli.js event contracts (gated)   | `*.integration.test.ts`                    |

- **Default local run:** `bun run test` — unit + component + e2e (no git, no integration). Snappy — ~14s.
- **After editing git-service.ts / worktree.ts / simple-git helpers:** `bun run test:git:changed` — uses vitest `--changed` to run only git tests whose import graph includes a modified file. `bun run test:git` always runs the whole git project.
- **CI runs:** `bun run test:ci` — unit + component + e2e + git (no integration). ~38s.
- **Watch mode:** `bun run test:watch` (unit only)
- **Framework:** Vitest 4.x with jsdom, `@testing-library/react`, workspace projects in `vitest.config.ts`
- **Test infra:** `src/test/` — TestIpcBridge, electron shim, SDK stub, factories, helpers

**Why `git` is its own project:** On Windows each `simple-git` subprocess call costs ~150-200ms. The 48 git-backed tests add ~23s to a default run and dominate cumulative time. Excluding them from `test` keeps iteration fast while still guaranteeing coverage in CI and when developers touch git-adjacent code.

### Test data attributes (`data-testid`)

Components are attributed with `data-testid` so the rendered UI is **assertable structurally** (and driveable by stable selectors) — see **[ADR-027](docs/adr/adr-027_test-data-attributes.md)**. Convention (two-tier, PascalCase):

- **Component root** → `data-testid="<ComponentName>"` (the rendered-component inventory).
- **Interactive parts** → `data-testid="<ComponentName>.<partName>"` (e.g. `ModelAllowlistDialog.save`).
- **Dynamic rows** → stable testid + a separate discriminator: `data-testid="SessionItem" data-id="<id>"` (never interpolate the id into the testid).
- **Shared controls** (`SettingsToggle`, `SettingsSelect`, …) take an optional `testid` prop and forward it to their root DOM node — a `data-testid` on a component that doesn't forward it is dropped.

**Verification order:** assert components/parts by testid first (jsdom `getByTestId`, or `scripts/app-shot.mjs --testids` / `--assert-testid <id>` against the real app), drive via testid selectors, and **read the screenshot last** to confirm the visual — not as the first resort.

## Windows Path Format in Bash Commands

On Windows (Git Bash), cli.js's working directory uses POSIX format (`/d/WorkPlace/ClaudeUI`), not Windows format (`D:\WorkPlace\ClaudeUI` or `D:/WorkPlace/ClaudeUI`). This matters for permission checks:

- **Never prefix Bash commands with `cd D:/...`** — it's redundant (already in the working dir) and causes permission prompts because cli.js filters `cd <cwd>` by exact string match, and `D:/WorkPlace/ClaudeUI` ≠ `/d/WorkPlace/ClaudeUI`.
- When a path **must** be specified in a command argument, use POSIX format: `/d/WorkPlace/ClaudeUI` not `D:\WorkPlace\ClaudeUI`. This matches what cli.js sees as the working directory and ensures `cd` auto-filtering and permission rules work correctly.

## Known Gotchas

### Tailwind v4 + CSS Reset

Never add a `* { margin: 0; padding: 0; }` reset after `@import "tailwindcss"` in main.css. It will appear **after** Tailwind's utility layer in the built CSS, silently overriding all padding/margin utilities. Tailwind v4's preflight already handles this.

### Tailwind Source Scanning

The `@source "../../";` directive in main.css is required so the Tailwind scanner finds renderer source files. Without it, some utility classes won't generate.

### Electron Transparency

Requires `transparent: true` + `vibrancy` on BrowserWindow, plus `background: transparent` on html, body, and #root. Any opaque background in the component tree blocks the effect.

### canUseTool Return Value

Must return `{ behavior: 'allow', updatedInput: input }` (passing back the original input). For deny: `{ behavior: 'deny', message: '...' }`. The `context.signal` is a real AbortSignal now — observe `.aborted` to dismiss the UI when cli.js sends a `control_cancel_request` for the pending prompt.

### cli.js Message Flow

With `includePartialMessages: true`, messages arrive in order: `assistant` (partial updates) → `user` (synthetic tool_result) → `assistant` (response) → `result` (cost). Assistant messages share the same `betaMessage.id` across partial updates.

### Terminal Panel Always Mounted

The terminal panel uses `display: none` (closed) / `display: contents` (open) instead of conditional rendering. Unmounting destroys xterm scrollback buffers. See ADR-002.

### Usage Utilization Scales

The `/api/oauth/usage` API returns utilization as 0–100 (percentage), while rate-limit HTTP headers return 0–1 (fraction). Both are stored as 0–100 in `RateWindow.usedPercent`. The `toUsedPercent()` helper in `usage-fetcher.ts` makes this conversion explicit.

## Engine Abstraction

ClaudeUI uses an engine-neutral session layer (`src/main/providers/`) as scaffolding for future engine backends. The V2 re-platform design is recorded in ADR-018/019/020/021 (the detailed `docs/v2/` design + phase docs were removed after V2 shipped — recoverable from git history).

- **`src/main/providers/`** — `ISession`/`BaseSession`/`EngineRegistry`. `SessionManager` holds `Map<routingId, ISession>`; all backends implement `ISession`. The renderer consumes the same `session:*` events regardless of engine.
- **`EngineId`** — `'claude' | 'opencode'`. Only `'claude'` has a registered factory in Phase 1; opencode backend arrives in Phase 5. **`ModelRef`** — vendor-qualified model identity `{ engineId, vendorId, modelId }`; `SessionStatus.model` is `ModelRef | null`. `claudeModel(id)` builds anthropic-vendored refs.
- Persisted: per-session `{ engineId, model? }` lives in the **operational DB** (`session_meta` table, Phase 3a) — not `sessions.json` anymore. The renderer-facing contract is unchanged: `loadSessionConfig()` still returns `sessionEngines?: Record<sessionId, { engineId; model? }>`, but it's sourced from `db.allSessionMeta()`. Legacy `sessions.json.sessionEngines` is imported once on first DB open (codex/unknown → `'claude'`), then left as a one-release fallback. See [Persistence model](#persistence-model).
- **Capabilities** — `EngineCapabilities` (static per-engine) + `ResolvedCapabilities` (merged with the model's caps), in `shared/model-capabilities.ts` (Phase 2). `SessionStatus.capabilities` carries the resolved set; the renderer gates features on it. `CLAUDE_ENGINE_CAPABILITIES` is all-true with `autonomyModes: ['plan','ask','autoEdit','full']`.
- The Codex backend (`codex-sup` branch) was removed in Phase 0 — it is recoverable from git history and documented as a dormant fallback in ADR-019.

## Auth / Accounts (Phase 4 — ADR-021)

**`EngineAuthProvider`** (`src/main/auth/`) is the per-engine auth abstraction, mirroring `EngineRegistry` for auth. The interface has three optional capability-gated method groups: `probe()` (always), `signIn/submitCode/cancelSignIn` (canDriveLogin), and `addAccount/switchAccount/deleteAccount` (multiAccount).

**`ClaudeAuthProvider`** (`src/main/auth/ClaudeAuthProvider.ts`) wraps `AuthManager` + `AccountManager` with **no behavior change** — it is registered as `'claude'` in `engineAuthRegistry`. IPC channels `auth:sign-in / auth:submit-code / auth:cancel / account:add / account:switch / account:delete` route through `engineAuthRegistry.require('claude')`. `account:get / account:set-enabled` delegate directly to `AccountManager` (not on the `EngineAuthProvider` interface).

**Probe / detection** — `ClaudeAuthProvider.probe()` returns `VendorAuthMap { anthropic: AuthStatus }`. It derives its `authState` (`'authenticated' | 'unauthenticated' | 'unknown'`) from the cached `session:auth-source` signal set by `ClaudeSession` at init — **no credential-file reads** (preserves ADR-014 Keychain-prompt avoidance). `ClaudeSession` calls `claudeAuthProvider.updateAuthSource(authSource, oauthAccount)` after `initializationResult()` resolves. The `fetchModels()` model-detection query also calls `updateAuthSource` so the probe is warm before any chat session opens.

**`AuthBanner`** reads `vendorAuth.anthropic.authState` (from the store) instead of the raw `authSource` string — **identical banner states and actions**. The `onAuthSource` event handler in `useClaudeEvents.ts` mirrors the raw source into `vendorAuth` via `setVendorAuth()` so both store fields remain consistent.

**`session.account: AccountRef | null`** is populated on every `SessionStatus` emission by `ClaudeSession.status` getter, built from `claudeAuthProvider.buildAccountRef(activeAccountId)`. It is re-emitted on model switch via `sendStatus()`.

**`AuthState` → `AuthFlowState` rename** — the login-flow object `{ status, account, error }` is now `AuthFlowState`. `AuthState` is the new tri-state `'authenticated' | 'unauthenticated' | 'unknown'` (used by `AuthStatus.authState` and `AccountRef.authState`).

**Account metadata → DB** — Phase 4 adds a DB v2 migration (`account` table with `id / email / subscription_type / organization / created_at`). `AccountManager` reads/writes via `getAllAccounts / upsertAccount / deleteAccountRow / importAccountsOnce` from `db.ts`. One-time import from `accounts.json` runs if the DB table is empty. `enabled` / `activeId` pointer stays in `accounts.json` (lightweight; avoids a DB read on the hot spawn-env path). `accounts.json` is kept as a one-release fallback (legacy `accounts` array in the pointer file). Credentials stay file-based per-account dirs (ADR-015 — never in the DB).

## Persistence model

Two distinct planes of on-disk state (Phase 3a/3b — persistence.md, ADR-020):

- **Config = plain-text files** (hand-editable, no private copies of engine-native config):
  - `~/.claude/ui/settings.json` — APP-tier (cosmetic + ClaudeUI's own behavior) + session app-consumed fields. **Plane ①.**
  - `~/.claude/ui/engines/<engineId>.json` — ENGINE launch params `{ sandbox, proxy }` (e.g. `claude.json`). **Plane ③.**
  - `~/.claude/ui/vendors/<vendorId>.json` — VENDOR launch params `{ endpoint, modelOverride }` (e.g. `anthropic.json`). **Plane ③.**
  - Claude's own `settings.json` / `.mcp.json` (user/project/local scopes) — permissions, MCP servers, cleanup period. ClaudeUI edits these in place via `claude-settings.ts`/`claude-mcp.ts`; keeps **no** private copy. **Plane ②** (engine-native).
- **Operational / derived = the SQLite DB** (`~/.claude/ui/operational.db`, better-sqlite3):
  - The DB holds operational state, not config. Currently: `session_meta(session_id, engine_id, vendor_id, model_id, updated_at)` — per-session engine + model; `account(id, email, subscription_type, organization, created_at)` — account metadata (Phase 4). Later phases add tables (usage = Phase 7) via the migrations framework.
  - `src/main/services/db.ts` is the **only** importer of better-sqlite3. Lazy singleton, `journal_mode=WAL`, `foreign_keys=ON`, versioned migrations keyed off SQLite's `user_version` pragma (an ordered `[{version, up(db)}]` list; apply those above the current version, bump after each). Exposes typed repositories: session repo (`getSessionMeta`/`setSessionMeta`/`deleteSessionMeta`/`allSessionMeta`/`renameSessionMeta`/`importSessionEnginesOnce`) and account repo (`getAllAccounts`/`upsertAccount`/`deleteAccountRow`/`importAccountsOnce`) — never the raw db.
- **Credentials = file-based** when multi-account is on (ADR-015, SKIP_SECURESTORAGE patch) — separate from the OS keychain.

**Dual-ABI gotcha (better-sqlite3).** The app runs under Electron (its Node ABI ≠ standalone Node's). better-sqlite3 must be built **Electron-ABI** to load in the main process; `bun install`/`bun add`/`bun remove` leave a **Node-ABI** build that crashes the app on boot with `ERR_DLOPEN_FAILED`. **Always run `bun run rebuild:native` (`electron-builder install-app-deps`) after touching deps.** Conversely, vitest runs in plain Node and **cannot** load the Electron-ABI binary, so `vitest.config.ts` aliases `better-sqlite3` → `src/test/stubs/better-sqlite3-stub.ts`, a ~thin adapter over Node 24's built-in `node:sqlite` (`DatabaseSync`). Tests therefore exercise the real DB/migration/repository logic against an in-memory SQLite without ever loading the native `.node`. **Never import `better-sqlite3` from renderer or shared code** — main process only; if a test transitively pulls in `db.ts`, it must hit the stub. electron-builder `asarUnpack` includes `node_modules/better-sqlite3/**` so the packaged app ships the unpacked binary.

## Settings & Config

The SettingsDialog (`src/renderer/src/components/SettingsDialog/`) is organized as a **tier tree** (Phase 3b — ADR-018/ADR-020), not a flat list. Two orthogonal axes: **tier** (who the setting conceptually belongs to: App / Engine / Vendor / Session) and **config plane** (who stores + consumes it: ① app store / ② engine-native / ③ launch params — see [Persistence model](#persistence-model)).

```
Settings
├── App            appearance, chat, session, tool output, diff, git, status line, usage, logging,
│                  voice, remote, mockups        (plane ①, always present, engine-agnostic)
├── Engines
│   └── Claude     permissions (+ neutral autonomy modes), sandbox, proxy   (plane ③ + plane ② permissions)
├── Vendors
│   └── Anthropic  endpoint + model override (DISPLAY-ONLY in v1), effort defaults (editable)
└── Accounts       multi-account (ADR-015)
```

- **`settings-sections.tsx`** exports `SECTIONS` (flat list, drives the scroll content + search filter) and `NAV_GROUPS` (the two-level nav tree: top-level groups + children like Claude/Anthropic). `SettingItem.render` takes `(settings, update, engineConfig, updateEngineConfig, vendorConfig, updateVendorConfig)` — App items use only the first pair; Engine items use the engine pair; the vendor section is display-only and ignores the setters.
- **`SettingsDialog.tsx`** (FC) loads engine config (`window.api.loadEngineConfig('claude')`) and vendor config (`loadVendorConfig('anthropic')`) on mount; saves engine edits via `saveEngineConfig`. **`View.tsx`** renders the nav tree + scroll-spy + search.
- **Engine/Vendor branches are gated to installed engines** — only Claude/Anthropic render now (opencode = Phase 5). Per-*section* capability-gating (hiding e.g. sandbox on a no-sandbox engine) is **deferred to Phase 5**: the Phase-2 `EngineCapabilities` model has no `sandbox`/`proxy` flags and is all-true for Claude, so gating today is zero-benefit until that model grows.
- **Neutral autonomy modes** — ClaudeUI owns the labels; internal ids `AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'`. Mapped to Claude's permission mode: `plan↔plan`, `ask↔default`, `autoEdit↔acceptEdits`, `full↔auto`. The available set is gated on `capabilities.autonomyModes`. The picker reads/writes user-scope Claude permissions (`loadClaudePermissions`/`saveClaudePermissions`), generalizing the mode picker so opencode (`[plan,ask,full]`) drops in.
- **Vendor display-only (§8.5)** — Vendors › Anthropic shows endpoint + modelOverride **read-only**; the edit forms were removed. Values still migrate and apply at spawn; users hand-edit `vendors/anthropic.json` until full vendor editing ships. `saveVendorConfig` exists in the IPC/preload (used by migration) but the UI never calls it — `handleUpdateVendorConfig` in `SettingsDialog.tsx` is wired but intentionally unused (a Phase-5 stub).
- **Spawn rewiring** — `session.ipc.ts session:create` sources `sandbox`/`proxy` from `loadEngineConfig(engineId ?? 'claude')` and `endpoint`/`modelOverride` from `loadVendorConfig('anthropic')` (vendor derivation from the model's ModelRef is a Phase-5 TODO). The `sdk/{proxy,endpoint-env,model-env}.ts` consumers are unchanged — only the source moved. `config:save-settings` strips the four engine/vendor-owned fields from any incoming payload and re-applies env from the engine/vendor stores.
- **Migration (read-time, one-time, idempotent)** — `ui-config.migrateConfigPlane()` runs on `loadSettings()`: moves `sandbox`/`proxy` from the flat `settings.json` → `engines/claude.json`, `anthropicEndpoint`/`modelOverride` → `vendors/anthropic.json`, deleting them from `settings.json`. Skips fields already present in the target (won't clobber hand-edits). ClaudeUI-consumed settings (`logLevel`/`logFilter`/`usageRefreshSecs`/`analyticsRefreshSecs`) are APP-tier and stay in `settings.json`.

## cli.js Integration

Everything about how ClaudeUI talks to cli.js — the Bun binary extraction pipeline, the stream-json wire protocol, control request subtypes, MCP hosting, cancellation tiers, the patches — lives in **[docs/protocol/](docs/protocol/)**. Read the relevant chapter before touching anything under `src/main/sdk/`, `scripts/extract-cli.mjs`, or `patch/`.

### Wire protocol reference — read this before theorizing

Authoritative, version-pinned catalog of every stream-json message cli.js emits and accepts lives in **[docs/protocol/](docs/protocol/)**. When asking "does cli.js emit X?", "what's the shape of Y?", or "what triggers Z?", start here — it's cheaper than grep and more reliable than reading minified cli.js. Especially **[04-system-subtypes.md](docs/protocol/04-system-subtypes.md)** for `{type:'system', subtype:X}` variants: every subtype (including the `task_started` / `task_updated` / `task_progress` lifecycle) has shape, gate, and recommended consumer behavior in §4.19. If ClaudeUI isn't following the consumer guidance there, the gap is in `src/main/services/claude-session.ts`, not the docs.

Keep in sync via **[12-maintenance.md](docs/protocol/12-maintenance.md)** when bumping `claudeCliVersion`. If observed wire traffic disagrees with the docs, the docs are stale — update them.

### Analyzing cli.js

cli.js is ~13MB minified. Use the `/bundle-analyzer` skill to navigate it — standard grep/read tools are ineffective. Workflow: `find` by string literals → `extract-fn` → `strings --near` → `refs` → `decompile` → `patch-check` for uniqueness. Never search by minified variable names — they change between versions.

### Patches

14 content-regex patches under `patch/` (registry: `patch/apply-all.mjs`), applied by `bun run ensure-cli` between the extract and rebundle steps. Three auto-detect upstream fixes and no-op on recent cli.js versions (`taskstop-notification`, `incomplete-session-resume-fix`, `mcp-tool-refresh`). The active 11:

| Patch                    | What it adds to cli.js                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent-streaming`     | Forwards subagent stream_events + messages that would otherwise be swallowed by internal aggregation                                                                                                        |
| `queue-control`          | `dequeue_message` control subtype + `queued_command_consumed` notification                                                                                                                                  |
| `mcp-status`             | Awaits MCP refresh before responding so `mcpServerStatus()` returns the full list                                                                                                                           |
| `background-task`        | `background_task` control subtype — convert foreground task to background                                                                                                                                   |
| `usage-relay`            | `get_usage` control subtype — exposes cli.js's internal /usage API                                                                                                                                          |
| `request-usage`          | Emits per-request token usage events after each API call                                                                                                                                                    |
| `rate-limit-relay`       | Emits rate limit headers after each API call                                                                                                                                                                |
| `voice-server`           | Adds internal TCP voice-transcription server, control subtypes `voice_server_start`/`stop`                                                                                                                  |
| `bash-output-streaming`  | Pushes Bash output to stream_event immediately instead of buffering 2s                                                                                                                                      |
| `subprocess-proxy-strip` | Strips `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` from env handed to bash/MCP/LSP/etc. subprocesses so cli.js's own proxy doesn't leak into shell tools (gated off via `CLAUDEUI_PROXY_SUBPROCESSES=1`)     |
| `skip-securestorage`     | When `SKIP_SECURESTORAGE` is set, forces the credential store to the plaintext file backend (bypassing macOS Keychain) so per-account `.credentials.json` files can be managed/swapped. Enables multi-account (ADR-015) |

Retired: `ci-path-remap` (obsolete once cli.js runs inside its native Bun runtime — ADR-006), `sandbox-network-fix` (upstream's "no allowed domains = no network" semantics kept deliberately), `team-streaming` (dir removed).

Patches operate on the wrapped Bun CJS IIFE bytes at `vendor/claude-cli/cli.js`; they run identically on the wrapped form since every anchor targets content inside the IIFE body. When the minifier changes variable names between versions, a patch fails with "cannot locate anchor" — update that patch's regex using its README's bundle-analyzer anchors. See **[ADR-006](docs/adr/adr-006_rebundle-bun-binary.md)** for why the pipeline now rebundles instead of unwrapping.

Skills for patch work:

- `/bundle-analyzer` — locate patch targets in minified cli.js.
- `/patch-readme` — generate/update per-patch README with anchors.
- `/patch-test-harness` — behavioral tests for a patch.

`apply.mjs` conventions:

1. Read `vendor/claude-cli/cli.js`, check for `/*PATCHED:<name>*/` marker (idempotency).
2. Find code by **content patterns/string literals** — never char offsets or minified names.
3. Extract minified variable names dynamically from regex captures.
4. Use `const V = '[\\w$]+'` for matching minified identifiers.
5. Verify pattern matches exactly once, apply replacement with marker, write back.

Register new patches in the `patches` array in `patch/apply-all.mjs`.

## Architectural Decision Records

ADRs live in `docs/adr/`. See `docs/adr/adr.md` for the index.

| ADR | Title                                                                                              | Status                |
| --- | -------------------------------------------------------------------------------------------------- | --------------------- |
| 001 | Preserve `@` file mentions in user prompt text sent to SDK                                         | Accepted              |
| 002 | Always mount TerminalPanel to preserve xterm scrollback buffers                                    | Accepted              |
| 003 | Group terminal tabs by session cwd with 10-minute cold cleanup                                     | Accepted              |
| 004 | VS Code-style plugin system for extensibility                                                      | Accepted              |
| 005 | Plugin session API — sessionId-based events and history                                            | Accepted              |
| 006 | Rebundle Bun standalone binary instead of running cli.js under Node                                | Accepted              |
| 007 | Serve mockup previews over HTTP with a sandboxed iframe for the remote web client                  | Accepted              |
| 008 | Type-check the remote web client (`src/web`) against `ClaudeAPI`                                   | Accepted              |
| 009 | Store cli.js-consumed settings in Claude's settings.json, not UISettings                           | Accepted              |
| 010 | Fork ("branch off") sessions via cli.js's native `--resume-session-at` + `--fork-session`          | Accepted              |
| 011 | Canonical 5h-window identity from `resets_at` + time-based account attribution for usage analytics | Accepted              |
| 012 | Mermaid HTML labels (`antiscript` + DOMPurify `html` profile) and dark-theme ER contrast           | Accepted              |
| 013 | ESLint flat-config rework — Prettier decoupling, scoped React rules, pragmatic strictness          | Accepted              |
| 014 | Native Anthropic OAuth via cli.js control requests, hosted on the service session                  | Accepted              |
| 015 | Multiple-account support via file-based credentials (SKIP_SECURESTORAGE patch)                     | Accepted              |
| 016 | Provider abstraction — ISession / BaseSession / ProviderRegistry (Strategy B)                      | Superseded by ADR-018 |
| 017 | Codex backend via app-server protocol — bundled binary, generated types, delegated auth            | Superseded by ADR-019 |
| 018 | V2 multi-engine model — engine / vendor / account split + capability model                         | Accepted              |
| 019 | opencode engine backend — multi-vendor meta-harness replaces Codex as second backend               | Accepted              |
| 020 | V2 persistence + config-plane — per-session ModelRef, engine config, account attribution           | Accepted              |
| 021 | V2 auth / account model — EngineAuthProvider abstraction, multi-account per engine                 | Accepted              |
| 022 | opencode permission model — autonomy-mode → last-match-wins ruleset mapping                        | Accepted              |
| 023 | opencode auto-mode — LLM permission gatekeeper (parity w/ Claude), configurable judge model        | Accepted              |
| 024 | opencode interaction parity — slash/skills, /btw + question.asked, queue/steer, subagents          | Accepted              |
| 025 | projectKey as derived render-identity + engine-neutral persisted-session delete dispatcher          | Accepted              |
| 026 | Development workflow — Opus orchestrates + reviews every line, Sonnet implements, gates + real-app verify | Accepted              |
| 027 | Test data attributes — two-tier `data-testid` convention + DOM-assert-before-screenshot verification | Accepted              |
| 028 | opencode engine-native config written to opencode's own files in place (jsonc, comment-safe) — implements ADR-020 | Accepted              |
| 029 | opencode custom-agent CRUD — markdown agent files (global/project), opt-in permissions, AI-assisted authoring | Accepted              |
| 030 | Capability honesty — a capability flag is only true when the full end-to-end path works for that engine (opencode fork demoted) | Accepted              |
| 031 | opencode config writes are diff-driven leaf merges, never subtree replacements — preserves unmodelled hand-edits (attachment, apiKey, npm, agent prompt) | Accepted              |
| 032 | opencode tool-experience parity from the wire — bash streaming, patch diffs, reasoned non-fatal denials; no fork | Accepted              |
| 033 | Cross-engine agent dispatch — hosted `dispatch_agent` tool, headless subtask-style targets, dispatcher-owned approval forwarding | Accepted              |
| 034 | Session time & per-model cost accounting — active-turn duration semantic, base+overlay cost (cumulative wire fields), dispatched spend in breakdown only | Accepted              |

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR entry. When adding a new ADR, proactively scan existing ADRs to check if the new decision supersedes or conflicts with a previous one — if so, update the old ADR's status to "Superseded by ADR-XXX" and note it in the new ADR.
