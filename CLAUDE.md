# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop GUI for Claude Code sessions, built with Electron.

## Tech Stack

- **Electron** with `electron-vite` (react-ts template)
- **React 19** + **TypeScript**
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin (no postcss/tailwind config files)
- **Zustand** for state management
- **react-markdown** + **remark-gfm** for rendering
- **@anthropic-ai/claude-agent-sdk** for Claude integration
- **Package manager: bun** (not npm/yarn)

## Commands

- `bun run dev` — start in development mode with hot reload
- `bun run build` — typecheck + build
- `bun run build:mac` — build macOS distributable
- `bun run typecheck` — run TypeScript checks (node + web)
- `bun run lint` — ESLint
- `bun run format` — Prettier
- `node patch/apply-all.mjs` — apply SDK patches (also runs automatically via `postinstall`)

## Code Navigation with LSP

**Prefer LSP tools over grep/glob** for navigating code. Use `lsp_symbols` to understand a file, `lsp_definition` to follow imports, `lsp_references` to check impact, `lsp_workspace_symbols` to find symbols by name, and `lsp_diagnostics` to verify edits compile.

## Project Structure

```
src/
  shared/types.ts          — All shared TypeScript types (ContentBlock, ChatMessage, ClaudeAPI, etc.)
  main/
    index.ts               — Electron BrowserWindow setup + app lifecycle
    ipc/session.ipc.ts     — IPC handler registration (session singleton)
    services/claude-session.ts — Core SDK wrapper (ClaudeSession class)
  preload/index.ts         — Context bridge (ClaudeAPI → window.api)
  renderer/src/
    stores/session-store.ts — Single Zustand store for all session state
    hooks/useClaudeEvents.ts — Registers all IPC event listeners → store actions
    components/
      SessionView.tsx      — Root layout (sidebar + chat panel)
      Sidebar.tsx          — Directory list, new thread button
      chat/
        ChatPanel.tsx      — Main chat area (messages, streaming, input)
        InputBox.tsx       — Textarea + model/effort pickers + send/stop
        MessageBubble.tsx  — Renders user/assistant messages with content blocks
        ToolCallBlock.tsx  — Collapsible tool call display with input/result
        StreamingText.tsx  — Live markdown rendering with blinking cursor
        FloatingApproval.tsx — Tool permission request UI
        ExitPlanModeCard.tsx — Plan mode approval UI
        SubagentMessages.tsx — Background agent message display
patch/                     — SDK monkey-patches (applied via postinstall)
```

## Architecture

### IPC Communication
- Main ↔ Renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`
- Typed `ClaudeAPI` interface in `shared/types.ts`, exposed on `window.api`
- Fire-and-forget pattern for `session:send` (streams results back via events)

### Data Flow

```
User types prompt → InputBox.handleSend()
  → addUserMessage() (Zustand)
  → window.api.sendPrompt(prompt) (IPC)
  → session.run(prompt) (main process)
  → sdkQuery() async generator
    → stream_event → session:stream → appendStreamingText()
    → assistant    → session:message → addMessage() (upserts by ID)
    → user (tool_result) → session:tool-result → appendToolResult()
    → canUseTool   → session:approval-request → setPendingApproval()
    → result       → session:result (cost tracking)
```

### Key Patterns
- `addMessage` upserts by ID — SDK sends partial messages with the same `betaMessage.id`, so updates replace in place rather than duplicating
- `canUseTool` callback creates a Promise stored in `pendingApprovals` Map, resolved when user clicks Allow/Deny
- Tool results arrive via synthetic `type: 'user'` messages (not assistant), extracted by `extractToolResults()`
- `claude-agent-sdk` is externalized in Vite build (`rollupOptions.external`), bundled via `extraResources` in electron-builder

### Design
- Dark theme with colors defined as CSS custom properties in `@theme` block of `main.css`
- Transparent window with `vibrancy: 'under-window'` on macOS
- Sidebar (240px, semi-transparent) + rounded card chat panel with left shadow

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

### Plus Menu Not Wired
The "Attach image" option in the plus menu is UI-only — no file attachment logic is implemented yet.

## Analyzing the SDK Bundle

The SDK ships a minified `cli.js` (~11 MB) at `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. **Always use the `bundle-analyzer` skill** (invoke via `/bundle-analyzer`) to navigate this code. Standard grep/read tools are ineffective on minified bundles.

Typical workflow: `find` by string literals → `extract-fn` → `strings --near` → `refs` → `decompile` → `patch-check` for uniqueness. Never search by minified variable names — they change between versions.

## SDK Patches

Patches live in `patch/` and fix limitations in the bundled `cli.js`. Each patch is a directory with `apply.mjs` + `README.md`.

**Current patches:**

| Patch | Purpose |
|---|---|
| `subagent-streaming` | Forwards subagent stream events + messages to SDK consumer |
| `taskstop-notification` | Sends task_notification on TaskStop (Part A killed→stopped mapping upstreamed in 0.2.49) |
| `team-streaming` | Forwards teammate stream events + messages to SDK consumer |
| `queue-control` | Adds `dequeue_message` control request and `queued_command_consumed` notification |
| `mcp-status` | Fixes `mcp_status` returning empty array by awaiting plugin MCP server refresh |
| `mcp-tool-refresh` | Refreshes MCP tool list after server reconnection |
| `sandbox-network-fix` | Fixes sandbox network proxy always starting even when no domain restrictions are configured |
| `usage-relay` | Relays CLI's internal `/usage` API through SDK control messages (avoids 429s) |

**Upstreamed (removed):**
- ~~`task-notification-usage`~~ — upstreamed in SDK 0.2.49
- ~~`team-dowhile-fix`~~ — upstreamed in SDK 0.2.59

### Writing a new patch

`apply.mjs` conventions:
1. Read `cli.js`, check for `/*PATCHED:<name>*/` marker (idempotency)
2. Find code by **content patterns/string literals** — never char offsets or minified names directly
3. Extract minified variable names dynamically from regex captures
4. Use `const V = '[\\w$]+'` for matching minified identifiers
5. Verify pattern matches exactly once, apply replacement with marker, write back and verify

`README.md` should document: the bug, the fix (before/after), which `bundle-analyzer` commands find the code, and stable anchors for future versions.

Register new patches in the `patches` array in `patch/apply-all.mjs`.

## Architectural Decision Records

ADRs live in `doc/`. See `doc/adr.md` for the index.

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR entry. When adding a new ADR, proactively scan existing ADRs to check if the new decision supersedes or conflicts with a previous one — if so, update the old ADR's status to "Superseded by ADR-XXX" and note it in the new ADR.
