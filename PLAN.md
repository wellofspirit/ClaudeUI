# ClaudeUI — Claude Code GUI

A cross-platform desktop GUI for managing multiple Claude Code sessions, with integrated diff review, terminal, and git workflows.

## Tech Stack

- **Shell**: Electron (same as Codex app)
- **Build**: electron-vite
- **Frontend**: React + TypeScript
- **Styling**: Tailwind CSS (dark theme)
- **Terminal**: xterm.js
- **Diff Viewer**: Monaco Editor (diff mode)
- **Markdown**: react-markdown + remark-gfm
- **State**: Zustand
- **Git**: simple-git
- **Auto-update**: electron-updater (Squirrel on Mac, NSIS on Windows)
- **Claude Integration**: `@anthropic-ai/claude-agent-sdk` — programmatic API via `query()`, no CLI spawning needed

## Phased Delivery

### Phase 1 — Foundation & Single Session

Get a working Electron app that can run one Claude Code session.

**Features:**
- Electron app shell with dark theme (Tailwind)
- Project folder picker (open dialog)
- Single session via SDK `query()` with streaming (`includePartialMessages: true`)
- Chat view — render agent messages (markdown), user messages
- Tool call display — collapsed by default, expandable (file edits, bash commands, reads)
- Input box — send prompts, multi-turn via V2 `session.send()` / `session.stream()`
- Approval flow — `canUseTool` callback renders approve/deny buttons in UI
- Bottom status bar — model name, session status, working directory, cost from `SDKResultMessage`

**Outcome:** A functional single-session Claude Code GUI. Replaces the terminal for basic usage.

---

### Phase 2 — Multi-Session & Sidebar

The core value proposition — manage multiple sessions.

**Features:**
- Session sidebar — list all active/completed sessions
- Create new session (with project folder selection)
- Switch between sessions (preserve scroll, state)
- Session status indicators (active/idle/completed/waiting for approval)
- Kill/cancel a session (`abortController.abort()`)
- Diff stats per session in sidebar (`+156 -54`)
- File change summary block in chat (list of files changed with stats)

**Outcome:** Multi-session management. The main reason to build this tool.

---

### Phase 3 — Diff Review Panel

The right panel — code review workflow.

**Features:**
- Three-panel layout (sidebar | chat | diff review)
- Git diff display using Monaco diff editor
- Scope toggle — Uncommitted / Last turn / All branch changes
- Per-file collapsible diffs with `+N -M` stats
- Hunk-level staging and reverting
- File-level stage/revert
- "Unstaged: N, Staged: M" counter
- Commit from GUI — message input + commit button

**Outcome:** Full code review workflow without leaving the app.

---

### Phase 4 — Integrated Terminal

Per-session terminal for manual commands.

**Features:**
- xterm.js terminal per session, scoped to session's working directory
- Toggle panel (keyboard shortcut)
- Terminal persists across session switches
- Resizable panel (drag to resize)

**Outcome:** No need to switch to external terminal.

---

### Phase 5 — Persistence & History

Sessions survive app restarts.

**Features:**
- Session history stored locally (SQLite or JSON files)
- Browse past sessions, view conversation history
- Resume sessions via SDK (`options.resume = sessionId`)
- Fork sessions (`options.forkSession = true`)
- Archive/unarchive sessions
- Search/filter sessions by project, date, content
- Recent projects quick-access list

**Outcome:** Long-term usability. Sessions aren't lost on restart.

---

### Phase 6 — Worktrees & Parallel Safety

Isolate concurrent sessions from each other.

**Features:**
- Git worktree creation per session
- Worktree status display
- Sync worktree → local (overwrite or apply/patch)
- Branch creation from worktree
- Auto-cleanup of stale worktrees
- Setup scripts per project (run on worktree init)

**Outcome:** Safe parallel work — two sessions can't clobber each other's files.

---

### Phase 7 — Polish & Power Features

Quality of life and advanced workflows.

**Features:**
- Command palette (Ctrl+K / Cmd+K)
- Inline comments on diff lines → send as feedback to agent
- Keyboard shortcuts (new session, switch, toggle panels)
- Notification system (task complete, approval needed)
- Auto-updates (electron-updater / Squirrel)
- Theme customization
- Token/cost tracking per session (from `SDKResultMessage.total_cost_usd` and `modelUsage`)
- Push + create PR from GUI
- File rewind (`query.rewindFiles(messageUuid)` with `enableFileCheckpointing`)

---

## Project Structure

```
claude-hub/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
│
├── resources/                    # App icons, static assets
│   └── icon.png
│
├── src/
│   ├── main/                     # Electron main process
│   │   ├── index.ts              # App entry, window creation
│   │   ├── ipc/                  # IPC handler registration
│   │   │   ├── index.ts          # Register all handlers
│   │   │   ├── session.ipc.ts    # Session CRUD, start/stop/send
│   │   │   ├── git.ipc.ts        # Git operations (diff, stage, commit)
│   │   │   └── config.ipc.ts     # Settings, project config
│   │   ├── services/
│   │   │   ├── session-manager.ts    # Manage multiple SDK query() instances
│   │   │   ├── claude-session.ts     # Single session: query lifecycle, message buffer, canUseTool
│   │   │   ├── git-manager.ts        # simple-git wrapper
│   │   │   ├── worktree-manager.ts   # Git worktree operations (Phase 6)
│   │   │   ├── config-manager.ts     # App settings persistence
│   │   │   └── history-manager.ts    # Session history storage (Phase 5)
│   │   └── utils/
│   │       └── paths.ts              # Platform-aware path helpers
│   │
│   ├── preload/                  # Electron preload scripts
│   │   └── index.ts              # Expose IPC API to renderer
│   │
│   └── renderer/                 # React frontend
│       ├── index.html
│       ├── main.tsx              # React entry
│       ├── App.tsx               # Root layout (3-panel)
│       │
│       ├── components/
│       │   ├── layout/
│       │   │   ├── Sidebar.tsx           # Left panel
│       │   │   ├── ChatPanel.tsx         # Center panel
│       │   │   ├── DiffPanel.tsx         # Right panel (Phase 3)
│       │   │   ├── StatusBar.tsx         # Bottom bar
│       │   │   └── ResizeHandle.tsx      # Draggable panel dividers
│       │   │
│       │   ├── sidebar/
│       │   │   ├── SessionList.tsx       # Session entries
│       │   │   ├── SessionItem.tsx       # Single session row
│       │   │   ├── NewSessionButton.tsx
│       │   │   └── ProjectList.tsx       # Recent projects
│       │   │
│       │   ├── chat/
│       │   │   ├── MessageList.tsx       # Scrollable message container
│       │   │   ├── MessageBubble.tsx     # Single message (user or agent)
│       │   │   ├── ToolCallBlock.tsx     # Collapsed tool call display
│       │   │   ├── FileChangeSummary.tsx # "9 files changed" card
│       │   │   ├── ApprovalPrompt.tsx    # Approve/deny buttons
│       │   │   ├── MarkdownRenderer.tsx  # react-markdown wrapper
│       │   │   └── InputBox.tsx          # Prompt input + send
│       │   │
│       │   ├── diff/                     # Phase 3
│       │   │   ├── DiffViewer.tsx        # Monaco diff editor wrapper
│       │   │   ├── DiffFileList.tsx      # File list with stats
│       │   │   ├── DiffFileEntry.tsx     # Single file diff
│       │   │   ├── ScopeToggle.tsx       # Uncommitted/Last turn/Branch
│       │   │   ├── StageControls.tsx     # Stage/revert buttons
│       │   │   └── InlineComment.tsx     # Phase 7
│       │   │
│       │   ├── terminal/                 # Phase 4
│       │   │   └── Terminal.tsx          # xterm.js wrapper
│       │   │
│       │   └── common/
│       │       ├── Button.tsx
│       │       ├── Badge.tsx
│       │       ├── Spinner.tsx
│       │       └── CommandPalette.tsx    # Phase 7
│       │
│       ├── stores/                # Zustand stores
│       │   ├── session-store.ts   # Sessions state, active session
│       │   ├── ui-store.ts        # Panel visibility, sizes, theme
│       │   └── git-store.ts       # Diff data, staging state (Phase 3)
│       │
│       ├── hooks/
│       │   ├── useSession.ts      # Session lifecycle helpers
│       │   ├── useClaudeStream.ts # Subscribe to stream events via IPC
│       │   └── useGit.ts          # Git operations (Phase 3)
│       │
│       ├── types/
│       │   ├── session.ts         # Session, Message, ToolCall types
│       │   ├── claude-events.ts   # Re-export SDK types for renderer
│       │   └── git.ts             # Diff, Hunk, FileChange types
│       │
│       └── styles/
│           └── globals.css        # Tailwind base + custom dark theme
│
└── test/
    ├── main/                     # Main process unit tests
    │   └── claude-session.test.ts
    └── renderer/                 # Component tests
        └── MessageBubble.test.ts
```

---

## Investigation Findings

### 1. SDK vs CLI Spawning — SDK Wins

The `@anthropic-ai/claude-agent-sdk` (formerly `@anthropic-ai/claude-code`) provides a complete programmatic API. **No need to spawn CLI processes.**

**Install:** `npm install @anthropic-ai/claude-agent-sdk`

**Core usage:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug in auth.py",
  options: {
    model: "claude-opus-4-6",
    cwd: "/path/to/project",
    permissionMode: "default",
    includePartialMessages: true,
    settingSources: ["user", "project", "local"],  // Load CLAUDE.md, settings.json
    systemPrompt: { type: "preset", preset: "claude_code" },  // Use Claude Code's system prompt
    canUseTool: async (toolName, input) => {
      // Route to UI for approval
      return { behavior: "allow", updatedInput: input };
      // or: { behavior: "deny", message: "User denied" }
    }
  }
})) {
  // Handle each message type
}
```

**V2 preview (simpler multi-turn):**
```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("First message");
for await (const msg of session.stream()) { /* handle */ }
await session.send("Follow-up");
for await (const msg of session.stream()) { /* handle */ }
```

### 2. Message Types (SDKMessage)

| Type | `type` field | When | Key data |
|------|-------------|------|----------|
| `SDKSystemMessage` | `"system"` (subtype `"init"`) | First message | `session_id`, `tools[]`, `model`, `permissionMode`, `cwd`, `mcp_servers[]` |
| `SDKAssistantMessage` | `"assistant"` | Each Claude turn | `message.content[]` — text, tool_use, thinking blocks. `message.usage` for tokens |
| `SDKUserMessage` | `"user"` | Tool results | `message.content[]` — tool_result blocks |
| `SDKPartialAssistantMessage` | `"stream_event"` | Token-level streaming | `event` — raw Anthropic stream events (content_block_delta, etc.) |
| `SDKResultMessage` | `"result"` | Final message | `total_cost_usd`, `duration_ms`, `num_turns`, `usage`, `modelUsage`, `permission_denials[]` |
| `SDKCompactBoundaryMessage` | `"system"` (subtype `"compact_boundary"`) | Context compaction | `compact_metadata` |

### 3. Permission / Approval Flow

Three-layer system:

1. **Permission modes**: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`
2. **`canUseTool` callback**: Receives `(toolName, input)`, returns `{ behavior: "allow" | "deny" }`. This is where the GUI shows approve/deny buttons.
3. **Hooks**: 12 lifecycle events (`PreToolUse`, `PostToolUse`, `Notification`, etc.)

The `AskUserQuestion` tool also routes through `canUseTool` — present questions to the user and return their selections.

### 4. Session Management

| Feature | How |
|---------|-----|
| Resume session | `options.resume = "session-uuid"` |
| Continue latest | `options.continue = true` |
| Fork session | `options.forkSession = true` (with resume) |
| Cancel | `abortController.abort()` |
| Change model mid-session | `query.setModel("sonnet")` |
| Change permissions mid-session | `query.setPermissionMode("acceptEdits")` |
| Interrupt | `query.interrupt()` |
| File rewind | `query.rewindFiles(messageUuid)` (needs `enableFileCheckpointing: true`) |

### 5. Key SDK Options

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | Model name or alias (`"opus"`, `"sonnet"`, `"haiku"`) |
| `cwd` | `string` | Working directory |
| `permissionMode` | `string` | Permission behavior |
| `canUseTool` | `function` | Custom approval callback |
| `maxTurns` | `number` | Turn limit |
| `maxBudgetUsd` | `number` | Cost cap |
| `includePartialMessages` | `boolean` | Token-level streaming |
| `allowedTools` | `string[]` | Auto-approved tools |
| `disallowedTools` | `string[]` | Blocked tools |
| `mcpServers` | `Record` | MCP server configs |
| `agents` | `Record` | Subagent definitions |
| `enableFileCheckpointing` | `boolean` | Track file changes for rewind |
| `settingSources` | `string[]` | Load user/project/local settings |
| `systemPrompt` | `string \| preset` | Custom or Claude Code default |
| `hooks` | `Record` | Lifecycle hooks |
| `abortController` | `AbortController` | Cancellation |
| `env` | `Dict<string>` | Environment variables |

### 6. Architecture Diagram (Updated)

```
┌──────────────────────────────────────┐
│         Electron Main Process        │
│                                      │
│  SessionManager                      │
│   ├─ Map<id, ClaudeSession>          │
│   └─ create / resume / kill          │
│                                      │
│  ClaudeSession                       │
│   ├─ query() from SDK               │
│   ├─ canUseTool → IPC → renderer    │
│   ├─ message buffer (SDKMessage[])   │
│   ├─ abortController for cancel     │
│   └─ session_id for resume           │
│                                      │
│  GitManager (simple-git)             │
│  ConfigManager                       │
├──────────────────────────────────────┤
│          Electron IPC Bridge         │
│  session:create, session:send,       │
│  session:cancel, session:message,    │
│  session:approval-request,           │
│  session:approval-response,          │
│  git:diff, git:stage, git:commit     │
├──────────────────────────────────────┤
│        Renderer (React + TS)         │
│                                      │
│  ┌──────────┬──────────┬──────────┐  │
│  │ Sidebar  │  Chat    │  Diff    │  │
│  │ Sessions │  View    │  Review  │  │
│  │ List     │  xterm   │  Monaco  │  │
│  └──────────┴──────────┴──────────┘  │
│                                      │
│  Zustand Store                       │
│   ├─ sessions (id, messages, status) │
│   ├─ activeSessionId                 │
│   ├─ pendingApprovals                │
│   └─ ui (panel sizes, theme)         │
└──────────────────────────────────────┘
```

### 7. IPC Flow for Approval

```
1. Main: ClaudeSession.canUseTool(toolName, input) fires
2. Main → Renderer: ipc "session:approval-request" { sessionId, toolName, input, requestId }
3. Renderer: Shows ApprovalPrompt component with approve/deny buttons
4. User clicks approve
5. Renderer → Main: ipc "session:approval-response" { requestId, behavior: "allow" }
6. Main: Resolves the canUseTool promise → SDK continues
```
