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

## Project Structure

```
src/
  shared/types.ts              — Shared TypeScript types (ContentBlock, ChatMessage, etc.)
  main/
    index.ts                   — Electron main process, BrowserWindow config
    ipc/session.ipc.ts         — IPC handler registration (session:pick-folder, session:create, etc.)
    services/claude-session.ts — SDK wrapper: query(), canUseTool approval flow, streaming
  preload/
    index.ts                   — contextBridge exposing ClaudeAPI to renderer
    index.d.ts                 — Window type augmentation for window.api
  renderer/
    src/
      App.tsx                  — Root component, renders SessionView
      main.tsx                 — React entry point
      assets/main.css          — Tailwind v4 import, @theme tokens, animations
      stores/session-store.ts  — Zustand store (cwd, messages, status, recentDirs, etc.)
      hooks/useClaudeEvents.ts — IPC event listener hook
      components/
        SessionView.tsx        — Two-column layout: Sidebar + rounded card chat panel
        Sidebar.tsx            — 240px sidebar, recent directories as threads
        chat/
          ChatPanel.tsx        — Main chat area with TopBar, WelcomeState, messages, InputBox
          InputBox.tsx          — Two-section input: textarea + controls bar (plus, model, effort, send)
          MessageBubble.tsx    — User/assistant message rendering
          ToolCallBlock.tsx    — Collapsible tool call display
          ApprovalPrompt.tsx   — Permission request Allow/Deny
          MarkdownRenderer.tsx — react-markdown with remark-gfm
          StreamingText.tsx    — Streaming text with blinking cursor
```

## Architecture Patterns

### IPC Communication
- Main ↔ Renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`
- Typed `ClaudeAPI` interface defined in `shared/types.ts`, exposed on `window.api`
- Fire-and-forget pattern for `session:send` (streams results back via events)

### SDK Integration
- `claude-agent-sdk` is externalized in Vite build (`rollupOptions.external`)
- Bundled via `extraResources` in electron-builder
- `ClaudeSession.query()` uses async generator with `includePartialMessages: true`
- `canUseTool` callback creates a Promise stored in `pendingApprovals` Map
- Tool results arrive via `type: 'user'` messages (not assistant), extracted by `extractToolResults()` and sent via `session:tool-result` IPC channel

### State Management
- Single Zustand store for session state
- Recent directories persisted to localStorage
- Directory order only changes when a session starts (user sends a prompt), not on click
- `addMessage` uses upsert by ID — SDK sends partial messages with the same `betaMessage.id`, so updates replace in place rather than duplicating

## Design

- Dark theme (colors defined as CSS custom properties in `@theme` block)
- Transparent window with `vibrancy: 'under-window'` on macOS
- Sidebar: 240px, semi-transparent (`bg-bg-secondary/80`)
- Chat panel: rounded card (`rounded-l-2xl`) with shadow, floats over sidebar
- Input box: fixed at bottom of chat panel with gradient fade
- Welcome state: centered icon + "Let's build" + directory dropdown

## Known Gotchas

### Tailwind v4 + CSS Reset
Never add a `* { margin: 0; padding: 0; }` reset after `@import "tailwindcss"` in main.css. It will appear **after** Tailwind's utility layer in the built CSS, silently overriding all padding/margin utilities (same specificity, later source order wins). Tailwind v4's preflight already handles this in the correct layer.

### Tailwind Source Scanning
The `@source "../../";` directive in main.css is required so the Tailwind scanner can find renderer source files from the `assets/` directory. Without it, some utility classes may not generate.

### Electron Transparency
Window transparency requires: `transparent: true` + `vibrancy` on BrowserWindow, plus `background: transparent` on html, body, and #root. Any opaque background in the component tree will block the transparency effect.

### SDK canUseTool Return Value
The `canUseTool` callback must return `{ behavior: 'allow', updatedInput: input }` (passing back the original input satisfies Zod validation). The SDK's Zod schema requires `updatedInput` to be a record — despite TypeScript types marking it optional, omitting it causes a ZodError at runtime. For deny: `{ behavior: 'deny', message: '...' }`.

### SDK Message Flow
With `includePartialMessages: true`, the SDK sends messages in this order:
1. `type: 'assistant'` — partial messages as content builds (text, tool_use, thinking)
2. `type: 'user'` — synthetic messages containing `tool_result` blocks after tool execution
3. `type: 'assistant'` — model's response to tool results
4. `type: 'result'` — final cost/duration summary

Assistant messages share the same `betaMessage.id` across partial updates. Tool results must be extracted from user messages separately.
