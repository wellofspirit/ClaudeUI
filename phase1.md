# ClaudeHub Phase 1 — Implementation Plan

## Context

We're building a cross-platform Electron GUI ("ClaudeHub") for managing Claude Code sessions. Phase 1 delivers a **single-session** app: open a project folder, chat with Claude, see streaming responses, view tool calls, and approve/deny permissions — all in a dark-themed desktop app.

The key architectural insight from our investigation: use `@anthropic-ai/claude-agent-sdk` directly (not CLI spawning). The SDK provides `query()` as an async generator, `canUseTool` callback for approvals, and full TypeScript types.

---

## Tech Stack

- **Scaffold**: `npm create @quick-start/electron@latest . -- --template react-ts`
- **Claude**: `@anthropic-ai/claude-agent-sdk`
- **UI**: React + TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), Zustand
- **Markdown**: `react-markdown` + `remark-gfm`

## Multi-Turn Strategy

Use `resume` with `session_id` for each user message. Each `session.run(prompt)` call creates a new `query()` with `options.resume = sessionId`. This is simpler and more stable than the AsyncIterable streaming input mode or the unstable V2 API.

## Architecture Overview

```
Main Process                    IPC Bridge              Renderer (React)
─────────────                   ──────────              ────────────────
ClaudeSession                   contextBridge           Zustand Store
  query() → SDKMessage stream   session:message  ──→    messages[]
  canUseTool() ─────────────→   session:approval ──→    pendingApproval
  ←───────────────────────────  session:response ──←    user clicks approve
  abortController.abort()  ←──  session:cancel   ──←    user clicks cancel
```

---

## Implementation Steps

### Step 1: Scaffold & Config

**Commands:**
```bash
cd D:\WorkPlace\ClaudeHub
npm create @quick-start/electron@latest . -- --template react-ts
npm install @anthropic-ai/claude-agent-sdk zustand react-markdown remark-gfm uuid
npm install -D tailwindcss @tailwindcss/vite @types/uuid
```

**Modify `electron.vite.config.ts`:**
- Add `tailwindcss()` plugin to renderer
- Mark `@anthropic-ai/claude-agent-sdk` as external in main process build (SDK has native binaries that can't be Vite-bundled)

**Modify `electron-builder.yml`:**
- Add `node_modules/@anthropic-ai/claude-agent-sdk/**` to files array

**Replace renderer CSS with Tailwind + dark theme variables:**
- `@import "tailwindcss"`
- Custom `@theme` with dark colors: bg-primary (#0d1117), bg-secondary (#161b22), etc.

**Verify:** `npm run dev` shows dark Electron window

---

### Step 2: Preload / IPC Bridge

**File: `src/preload/index.ts`**

Expose typed API via contextBridge:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `pickFolder()` | R→M | Open native folder dialog |
| `createSession(cwd)` | R→M | Initialize ClaudeSession for a directory |
| `sendPrompt(prompt)` | R→M | Send user message (non-blocking) |
| `cancelSession()` | R→M | Abort running query |
| `respondApproval(requestId, decision)` | R→M | Resolve pending tool approval |
| `onMessage(cb)` | M→R | Complete assistant/user messages |
| `onStreamEvent(cb)` | M→R | Token-level streaming deltas |
| `onApprovalRequest(cb)` | M→R | Tool needs user permission |
| `onStatus(cb)` | M→R | Session state changes |
| `onResult(cb)` | M→R | Query completed (cost, stats) |
| `onError(cb)` | M→R | Error occurred |

Each `on*` returns a cleanup `() => void` for React useEffect.

**File: `src/preload/index.d.ts`** — Window type augmentation for `window.api`.

**Verify:** `console.log(window.api)` in renderer shows all methods

---

### Step 3: Main Process — ClaudeSession + IPC

**File: `src/main/services/claude-session.ts`**

Core class wrapping the SDK:

```
ClaudeSession
  Properties:
    sessionId: string | null       — captured from init message
    abortController: AbortController
    pendingApprovals: Map<requestId, { resolve }>
    status: { state, sessionId, model, cwd, totalCostUsd }

  Methods:
    run(prompt)      — creates query() with resume if sessionId exists
    resolveApproval(requestId, decision) — resolves pending promise
    cancel()         — aborts controller, denies all pending approvals
    getStatus()      — returns current status
```

Key patterns:
- `canUseTool` callback creates a Promise, stores it in `pendingApprovals` Map keyed by uuid, sends IPC `session:approval-request`, returns the Promise. Resolved when renderer responds.
- All SDKMessages forwarded to renderer via `mainWindow.webContents.send()`
- `stream_event` messages sent on separate channel for performance

**File: `src/main/ipc/session.ipc.ts`**

Registers ipcMain handlers. Holds a single `ClaudeSession` instance (Phase 1 = single session).

Important: `session:send` handler does NOT await `session.run()` — it fires and forgets, since `run()` is a long-running async loop. Results stream back via `webContents.send()`.

**Modify: `src/main/index.ts`**
- Set `backgroundColor: '#0d1117'` on BrowserWindow (prevent white flash)
- Call `registerSessionIpc(mainWindow)` after window creation
- Set reasonable min window size (600x400)

**Verify:** Renderer can call `pickFolder()` and get a path back

---

### Step 4: Zustand Store

**File: `src/renderer/src/stores/session-store.ts`**

```typescript
State:
  cwd: string | null
  messages: ChatMessage[]        // { id, role, content: ContentBlock[], timestamp }
  streamingText: string          // Accumulates partial deltas, separate from messages
  status: SessionStatus          // { state, sessionId, model, cwd, totalCostUsd }
  pendingApproval: PendingApproval | null  // { requestId, toolName, input }

ContentBlock:
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?, toolName?, toolInput?, toolUseId?, toolResult?, isError?
```

Design: `streamingText` is separate from `messages[]` so token deltas only re-render `StreamingText`, not the entire message list. When full `assistant` message arrives → clear `streamingText` + add to `messages[]`.

---

### Step 5: Event Hook + Message Transform

**File: `src/renderer/src/hooks/useClaudeEvents.ts`**

Single hook that subscribes to all IPC channels and dispatches to store:

- `onMessage` → transform SDKMessage → `addMessage()`
- `onStreamEvent` → extract `content_block_delta.text_delta` → `appendStreamingText()`
- `onApprovalRequest` → `setPendingApproval()`
- `onStatus` → `setStatus()`
- `onResult` / `onError` → handle completion

Transform function maps SDK content blocks (text, tool_use, tool_result, thinking) to our simplified `ContentBlock` type.

---

### Step 6: UI Components

**File: `src/renderer/src/App.tsx`** — Root layout:
- No `cwd` → show `WelcomeScreen`
- Has `cwd` → show `SessionView`

**File: `src/renderer/src/components/WelcomeScreen.tsx`**
- App title, "Open Folder" button
- Calls `api.pickFolder()` → `api.createSession(cwd)` → `setCwd(cwd)`

**File: `src/renderer/src/components/SessionView.tsx`**
- Flex column: ChatPanel (grows) + StatusBar (fixed bottom)

**File: `src/renderer/src/components/chat/ChatPanel.tsx`**
- Scrollable container, auto-scrolls on new messages
- Renders `MessageList` + `StreamingText` + `ApprovalPrompt` + `InputBox`

**File: `src/renderer/src/components/chat/MessageBubble.tsx`**
- User messages: right-aligned, simple text
- Assistant messages: left-aligned, renders content blocks:
  - `text` → `MarkdownRenderer`
  - `tool_use` → `ToolCallBlock` (collapsed)
  - `tool_result` → inline result display
  - `thinking` → collapsible thinking block

**File: `src/renderer/src/components/chat/ToolCallBlock.tsx`**
- Collapsed by default: shows tool name + one-line summary
- Expandable: shows full input JSON
- Color-coded by tool type

**File: `src/renderer/src/components/chat/ApprovalPrompt.tsx`**
- Shows when `pendingApproval !== null`
- Displays tool name + input JSON preview
- Approve (green) / Deny (red) buttons
- Calls `api.respondApproval()` → `setPendingApproval(null)`

**File: `src/renderer/src/components/chat/MarkdownRenderer.tsx`**
- Wraps `react-markdown` with `remark-gfm`
- Custom renderers for code blocks (syntax highlighting can come later)

**File: `src/renderer/src/components/chat/StreamingText.tsx`**
- Reads `streamingText` from store
- Renders markdown + blinking cursor
- Only visible while streaming

**File: `src/renderer/src/components/chat/InputBox.tsx`**
- Textarea + Send button (or Cancel when running)
- Enter to send, Shift+Enter for newline
- Calls `api.sendPrompt()` and adds user message to store

**File: `src/renderer/src/components/StatusBar.tsx`**
- Model name, status indicator (dot with color), cwd (truncated), cost

---

### Step 7: Polish & Edge Cases

- Auto-scroll to bottom on new messages
- Handle empty responses, error states
- Loading spinner while waiting for first response
- Truncate long tool outputs in collapsed view
- Escape key to cancel running session

---

## Build Order (Dependencies)

```
Step 1: Scaffold & Config
  ↓
Step 2: Preload Bridge
  ↓
Step 3: Main Process (ClaudeSession + IPC)  ←── core logic
  ↓
Step 4: Zustand Store
  ↓
Step 5: Event Hook
  ↓
Step 6: UI Components
  ├── WelcomeScreen (needs: pickFolder IPC)
  ├── InputBox (needs: sendPrompt IPC)
  ├── MessageBubble + MarkdownRenderer (needs: store messages)
  ├── StreamingText (needs: store streamingText)
  ├── ToolCallBlock (needs: store messages with tool_use)
  ├── ApprovalPrompt (needs: store pendingApproval + respondApproval IPC)
  └── StatusBar (needs: store status)
  ↓
Step 7: Polish
```

## Verification

1. `npm run dev` → dark Electron window with welcome screen
2. Click "Open Folder" → native dialog → select a project directory
3. Type a prompt → see streaming text appear token-by-token
4. Ask Claude to read a file → see ToolCallBlock with "Read" tool, collapsed
5. Ask Claude to edit a file → see ApprovalPrompt → click Approve → edit proceeds
6. Status bar shows model, "running"/"idle", cwd, cost after completion
7. Send a follow-up message → session resumes (same context)
8. Click Cancel while running → query aborts gracefully

## Critical Files

| File | Purpose |
|------|---------|
| `src/main/services/claude-session.ts` | Core: wraps SDK query(), approval promises, message forwarding |
| `src/main/ipc/session.ipc.ts` | Wires IPC handlers to ClaudeSession |
| `src/preload/index.ts` | Typed contextBridge API surface |
| `src/renderer/src/hooks/useClaudeEvents.ts` | IPC→Zustand dispatcher |
| `src/renderer/src/stores/session-store.ts` | All UI state |
| `electron.vite.config.ts` | Tailwind plugin + SDK external |
