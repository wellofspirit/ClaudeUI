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

## Code Navigation with LSP

When working with this codebase, **prefer LSP tools over grep/glob** for navigating code. They provide precise, type-aware results:

- **`lsp_symbols <file>`** — Get all exported/internal symbols (functions, classes, interfaces, variables) in a file with hierarchy. Use this first to understand a file's structure.
- **`lsp_definition <file> <line> <col>`** — Jump to where a symbol is defined. Use to follow imports and find source declarations.
- **`lsp_references <file> <line> <col>`** — Find every usage of a symbol across the workspace. Use to understand impact of changes.
- **`lsp_hover <file> <line> <col>`** — Get the full type signature and documentation for a symbol at a position.
- **`lsp_implementations <file> <line> <col>`** — Find concrete implementations of an interface or abstract method.
- **`lsp_incoming_calls <file> <line> <col>`** — Find all callers of a function (who calls this?).
- **`lsp_outgoing_calls <file> <line> <col>`** — Find all functions called by a function (what does this call?).
- **`lsp_workspace_symbols <query>`** — Search for symbols by name across the entire workspace. Great for finding a class/function/interface by name without knowing which file it's in.
- **`lsp_diagnostics <file>`** — Get TypeScript errors and warnings for a file. Use after edits to verify correctness.

**When to use which:**
- Need to understand a file? → `lsp_symbols`
- Need to find where something is defined? → `lsp_definition`
- Need to check what would break if you change something? → `lsp_references`
- Need to find a symbol but don't know the file? → `lsp_workspace_symbols`
- Need to verify your changes compile? → `lsp_diagnostics`

## Detailed File Reference

### `src/shared/types.ts` — Shared Type Definitions

The single source of truth for all TypeScript types shared between main and renderer processes.

**Interfaces:**
- **`ContentBlock`** — Represents a single block of content in a message. Discriminated by `type` field:
  - `'text'` → has `text: string`
  - `'tool_use'` → has `toolName`, `toolInput: Record<string, unknown>`, `toolUseId`
  - `'tool_result'` → has `toolUseId`, `toolResult: string`, `isError: boolean`
  - `'thinking'` → has `text: string`
- **`ChatMessage`** — A message in the conversation: `{ id, role: 'user' | 'assistant', content: ContentBlock[], timestamp }`
- **`SessionStatus`** — Current session state: `{ state: 'idle' | 'running' | 'error', sessionId, model, cwd, totalCostUsd }`
- **`PendingApproval`** — A tool permission request awaiting user decision: `{ requestId, toolName, input }`
- **`SessionResult`** — Final result after a query completes: `{ totalCostUsd, durationMs, result }`
- **`ClaudeAPI`** — The full typed interface exposed to the renderer via `window.api`. Defines all IPC methods (`pickFolder`, `createSession`, `sendPrompt`, `cancelSession`, `respondApproval`) and event listeners (`onMessage`, `onStreamEvent`, `onApprovalRequest`, `onStatus`, `onResult`, `onError`, `onToolResult`). Each `on*` method returns a cleanup function `() => void`.

**Type:** `ApprovalDecision = 'allow' | 'deny'`

---

### `src/main/index.ts` — Electron Main Process Entry

Creates and configures the BrowserWindow, registers IPC handlers, and manages app lifecycle.

**`createWindow()`** — Creates a `BrowserWindow` with:
- Dimensions: 1100x750 (min 600x400)
- `transparent: true` + `vibrancy: 'under-window'` for macOS frosted glass effect
- `titleBarStyle: 'hiddenInset'` with traffic lights at `{ x: 15, y: 10 }`
- `sandbox: false` in webPreferences (required for SDK access)
- Calls `registerSessionIpc(mainWindow)` to set up IPC handlers
- External links open in system browser via `setWindowOpenHandler`
- Loads `ELECTRON_RENDERER_URL` in dev, `../renderer/index.html` in production

**Lifecycle:**
- `app.whenReady()` → sets app user model ID, registers window shortcut optimizer, creates window
- `app.on('activate')` → re-creates window on macOS dock click
- `app.on('window-all-closed')` → quits on non-macOS platforms

---

### `src/main/ipc/session.ipc.ts` — IPC Handler Registration

Registers all `ipcMain.handle` handlers. Maintains a module-level `session: ClaudeSession | null` singleton.

**IPC Channels:**
| Channel | Direction | Purpose |
|---|---|---|
| `session:pick-folder` | renderer → main | Opens native directory picker dialog, returns path or `null` |
| `session:create` | renderer → main | Creates a new `ClaudeSession` instance for the given `cwd` |
| `session:send` | renderer → main | Fire-and-forget: calls `session.run(prompt)`, results stream back via events |
| `session:cancel` | renderer → main | Aborts the running query and denies all pending approvals |
| `session:approval-response` | renderer → main | Resolves a pending tool approval with `'allow'` or `'deny'` |

---

### `src/main/services/claude-session.ts` — Claude SDK Wrapper

The core service class that interfaces with `@anthropic-ai/claude-agent-sdk`.

**Class `ClaudeSession`:**

**Properties:**
- `sessionId: string | null` — Captured from first SDK message for session resumption
- `abortController: AbortController | null` — Non-null while a query is running
- `pendingApprovals: Map<string, PendingApprovalEntry>` — Maps `requestId` → `{ resolve }` for in-flight tool approvals
- `win: BrowserWindow` — Reference to send IPC events to the renderer
- `cwd: string` — Working directory for the Claude session
- `totalCostUsd: number` — Cumulative cost across all queries in this session

**Methods:**
- **`get status(): SessionStatus`** — Derives session status from internal state. `state` is `'running'` if `abortController` exists, otherwise `'idle'`.
- **`run(prompt: string)`** — The main query loop. Calls `sdkQuery()` with the prompt and iterates the async generator. Handles 4 message types:
  - `'assistant'` → transforms via `transformAssistantMessage()`, sends `session:message`
  - `'user'` → extracts tool results via `extractToolResults()`, sends `session:tool-result`
  - `'stream_event'` → extracts `content_block_delta` text/thinking deltas, sends `session:stream`
  - `'result'` → accumulates cost, sends `session:result`
  - Captures `session_id` from first message for session resumption via `resume` option
- **`resolveApproval(requestId, decision)`** — Resolves the Promise for a pending tool approval
- **`cancel()`** — Denies all pending approvals, aborts the controller, sends updated status
- **`transformAssistantMessage(msg)`** *(private)* — Converts raw SDK `BetaMessage` into `ChatMessage`. Maps content blocks to `ContentBlock` types. Uses `betaMessage.id` as message ID for upsert deduplication.
- **`extractToolResults(msg)`** *(private)* — Extracts `tool_result` blocks from synthetic `type: 'user'` messages. Sends each result to the renderer via `session:tool-result` with `{ toolUseId, result, isError }`.
- **`send(channel, data)`** *(private)* — Safe wrapper for `webContents.send`, checks `win.isDestroyed()` first
- **`sendStatus()`** *(private)* — Sends current `status` getter to renderer

**`canUseTool` callback flow:**
1. Generates a UUID `requestId`
2. Sends `session:approval-request` to renderer
3. Creates a Promise, stores `{ resolve }` in `pendingApprovals` map
4. Registers abort signal listener to auto-deny on cancellation
5. On resolution: returns `{ behavior: 'allow', updatedInput: input }` or `{ behavior: 'deny', message: 'User denied' }`

---

### `src/preload/index.ts` — Context Bridge

Implements the `ClaudeAPI` interface using `ipcRenderer.invoke` (for request/response) and `ipcRenderer.on` (for event streams).

**Pattern for event listeners (`on*` methods):**
1. Creates a handler function that wraps the callback
2. Registers it with `ipcRenderer.on(channel, handler)`
3. Returns a cleanup function that calls `ipcRenderer.removeListener(channel, handler)`

**IPC channel mapping:**
| ClaudeAPI method | IPC channel |
|---|---|
| `pickFolder()` | `session:pick-folder` |
| `createSession(cwd)` | `session:create` |
| `sendPrompt(prompt)` | `session:send` |
| `cancelSession()` | `session:cancel` |
| `respondApproval(id, decision)` | `session:approval-response` |
| `onMessage(cb)` | `session:message` |
| `onStreamEvent(cb)` | `session:stream` |
| `onApprovalRequest(cb)` | `session:approval-request` |
| `onStatus(cb)` | `session:status` |
| `onResult(cb)` | `session:result` |
| `onError(cb)` | `session:error` |
| `onToolResult(cb)` | `session:tool-result` |

Exposes via `contextBridge.exposeInMainWorld('api', api)` when context-isolated, falls back to direct `window.api` assignment otherwise.

### `src/preload/index.d.ts` — Window Type Augmentation

Augments the global `Window` interface to add `api: ClaudeAPI` for TypeScript support in the renderer.

---

### `src/renderer/src/main.tsx` — React Entry Point

Imports `main.css` (Tailwind), mounts `<App />` inside `<StrictMode>` to `#root`.

### `src/renderer/src/App.tsx` — Root Component

Calls `useClaudeEvents()` hook to register all IPC event listeners, then renders `<SessionView />`.

### `src/renderer/src/env.d.ts` — Vite Client Types

References `vite/client` types for import.meta, asset imports, etc.

---

### `src/renderer/src/stores/session-store.ts` — Zustand State Store

Single store managing all session state. Created with `create<SessionState>()`.

**State fields:**
| Field | Type | Purpose |
|---|---|---|
| `cwd` | `string \| null` | Current working directory |
| `recentDirs` | `string[]` | Recently opened directories (persisted to localStorage under `claudeui-recent-dirs`) |
| `messages` | `ChatMessage[]` | All messages in the current conversation |
| `streamingText` | `string` | Accumulated streaming text from `content_block_delta` events |
| `status` | `SessionStatus` | Current session status (state, model, cost, etc.) |
| `pendingApproval` | `PendingApproval \| null` | Currently pending tool approval, if any |
| `error` | `string \| null` | Current error message |

**Actions:**
- **`setCwd(cwd)`** — Sets `cwd` directly
- **`openDirectory(cwd)`** — Switches to a directory: resets messages/streaming/error/approval, adds to `recentDirs` if new (preserves order if already exists)
- **`addMessage(message)`** — Upserts by `message.id`: if a message with the same ID exists, replaces it in-place (handles SDK partial message updates); otherwise appends. Also clears `streamingText`.
- **`addUserMessage(id, text)`** — Appends a user message and promotes `cwd` to top of `recentDirs` via `addToRecent()`
- **`appendStreamingText(text)`** — Concatenates text to `streamingText`
- **`clearStreamingText()`** — Resets `streamingText` to `''`
- **`setStatus(status)`** — Replaces session status
- **`setPendingApproval(approval)`** — Sets or clears the pending approval
- **`setError(error)`** — Sets or clears error
- **`appendToolResult(toolUseId, result, isError)`** — Searches messages backwards for the assistant message containing a `tool_use` block with matching `toolUseId`, then appends a `tool_result` block to that message's content

**Helper functions (module-level):**
- `loadRecentDirs()` — Reads from localStorage, returns `string[]`
- `saveRecentDirs(dirs)` — Writes to localStorage
- `addToRecent(dir, existing)` — Moves/adds `dir` to front, caps at 20 entries, saves

---

### `src/renderer/src/hooks/useClaudeEvents.ts` — IPC Event Listener Hook

Registers all `window.api.on*` listeners in a single `useEffect`, dispatching events to the Zustand store.

**Event mapping:**
| IPC Event | Store Action |
|---|---|
| `onMessage` | `addMessage(msg)` |
| `onStreamEvent` | `appendStreamingText(text)` |
| `onApprovalRequest` | `setPendingApproval(approval)` |
| `onStatus` | `setStatus(status)` + clears error if not `'error'` state |
| `onResult` | no-op (cost handled via status) |
| `onError` | `setError(error)` |
| `onToolResult` | `appendToolResult(toolUseId, result, isError)` |

Returns cleanup functions on unmount via the collected array.

---

### `src/renderer/src/components/SessionView.tsx` — Root Layout

Two-column layout: `<Sidebar />` (fixed 240px) + main content area containing `<ChatPanel />` inside a rounded card with left shadow.

---

### `src/renderer/src/components/Sidebar.tsx` — Sidebar Navigation

**Exports:** `Sidebar` component + internal `NavItem` component.

**`Sidebar`:**
- 240px fixed-width sidebar with semi-transparent background
- Traffic light clearance div (48px, draggable)
- "New thread" button — opens native folder picker, creates session, calls `openDirectory()`
- "Threads" section — lists `recentDirs` as clickable `NavItem`s showing folder name; active directory highlighted
- Footer with ClaudeUI branding

**`NavItem({ label, icon, active?, onClick? })`:**
- Reusable sidebar row: icon + truncated label, 32px height
- Active state: `bg-bg-tertiary` + primary text; hover state: `bg-bg-hover`

---

### `src/renderer/src/components/WelcomeScreen.tsx` — Initial Welcome

Full-screen welcome shown before any directory is selected (used when no `cwd` is set). Shows ClaudeUI icon, title, and an "Open a project folder" button that triggers the native folder picker.

---

### `src/renderer/src/components/chat/ChatPanel.tsx` — Main Chat Area

The primary chat interface. Contains several internal components:

**`ChatPanel` (exported):**
- Reads `messages`, `streamingText`, `pendingApproval`, `status`, `error` from store
- Auto-scrolls to bottom when near bottom (< 400px threshold), smooth scroll with 50ms delay
- Three view states:
  1. **Empty + idle** → renders `<WelcomeState />` centered
  2. **Empty + running** → renders `<LoadingState />` centered
  3. **Has content** → renders message list with `<MessageBubble>`, `<StreamingText>`, `<TypingIndicator>`, `<ApprovalPrompt>`
- Error banner displayed above `<InputBox />` when error is set
- Input area fixed at bottom with gradient fade overlay

**`TopBar({ hasContent, cost })` (internal):**
- 48px drag region at top, shows "New thread" or "Thread" label, cost display when > 0

**`WelcomeState` (internal):**
- Centered icon + "Let's build" text + directory dropdown
- Dropdown shows `recentDirs` with folder picker option at bottom
- Clicking a directory creates a session and calls `openDirectory()`

**`LoadingState` (internal):**
- Three pulsing dots + "Thinking..." text

**`TypingIndicator` (internal):**
- Three bouncing dots in a rounded bubble (shown when running but no streaming text)

---

### `src/renderer/src/components/chat/InputBox.tsx` — Message Input

**Constants:**
- `MODELS` — Array of `{ id, label }` for model selection: sonnet-4-5, opus-4-6, haiku-4-5
- `EFFORT_LEVELS` — `['low', 'medium', 'high']`

**`InputBox` (exported):**
- Auto-growing `<textarea>` (max 200px height)
- Disabled when no `cwd` or session is running
- Enter sends, Shift+Enter for newline, Escape cancels running session
- Auto-focuses textarea when session stops running
- Closes all dropdowns on outside click

**Controls bar (bottom of input):**
- **Plus button** — dropdown with "Attach image" option (UI-only, not wired up yet)
- **Model picker** — dropdown to select from `MODELS` array
- **Effort level** — dropdown to select low/medium/high
- **Send button** — circular button with arrow icon, disabled when empty/disabled; switches to Stop button when running

**`handleSend()`** — Trims text, creates user message via `addUserMessage(uuid(), prompt)`, resets textarea, calls `window.api.sendPrompt(prompt)`

---

### `src/renderer/src/components/chat/MessageBubble.tsx` — Message Rendering

**`MessageBubble({ message })` (exported):**
- **User messages** → right-aligned dark bubble with `whitespace-pre-wrap` text
- **Assistant messages** → left-aligned, renders content blocks in order:
  - Builds a `resultMap: Map<toolUseId, ContentBlock>` to pair `tool_result` blocks with their `tool_use`
  - `tool_result` blocks are skipped (rendered inline with their `tool_use` via `ToolCallBlock`)
  - `tool_use` blocks → `<ToolCallBlock block={block} result={resultMap.get(toolUseId)} />`
  - `text` / `thinking` blocks → `<ContentBlockView />`

**`ContentBlockView({ block })` (internal):**
- `text` blocks → `<MarkdownRenderer content={block.text} />`
- `thinking` blocks → collapsible `<details>` with italic "Thinking" summary, content capped at 160px height

---

### `src/renderer/src/components/chat/ToolCallBlock.tsx` — Tool Call Display

Collapsible panel showing a tool invocation and its result.

**`ToolCallBlock({ block, result })` (exported):**
- Header: status icon (spinner/check/X) + tool name (monospace, accent color) + summary text + expand chevron
- Border color changes based on result status: `border-danger/30` (error), `border-success/30` (success), `border-border` (pending)
- Expanded view has two sections:
  - **Input** — rendered by `<ToolInput />`
  - **Result** — rendered by `<ToolResult />` (only shown when result exists)

**`ToolInput({ block })` (internal):**
- Tool-specific rendering:
  - `Bash` → shows `$ {command}` in a code block
  - `Edit` → shows file path + `<DiffView>` for old/new strings
  - `Read`/`Write` → shows shortened file path
  - Default → JSON pretty-print

**`ToolResult({ block, result })` (internal):**
- Tool-specific rendering:
  - `Write` → shows the written content (from `block.toolInput.content`) in green
  - `Edit` → shows `<DiffView>` of old/new strings
  - `Read` → shows file content (truncated to 2000 chars)
  - `Bash` → shows command output (truncated to 2000 chars)
  - Error/default → shows result text with red styling if error

**`DiffView({ oldStr, newStr })` (internal):**
- Side-by-side diff display: old lines with red `-` prefix, new lines with green `+` prefix

**Helper functions:**
- `getSummary(block)` — Generates one-line summary for the header based on tool name (file path for Read/Write/Edit, command for Bash, pattern for Glob/Grep)
- `shorten(path)` — Truncates path to last 2 segments with `.../ prefix`
- `trunc(s, n)` — Truncates string to `n` chars with `...` suffix

---

### `src/renderer/src/components/chat/ApprovalPrompt.tsx` — Permission Request UI

**`ApprovalPrompt` (exported):**
- Returns `null` if no `pendingApproval` in store
- Shows a warning-bordered card with:
  - "PERMISSION" label + tool name
  - JSON preview of tool input (truncated to 500 chars)
  - Two-button footer: "Deny" (red) | "Allow" (green)
- `handleRespond(decision)` — calls `window.api.respondApproval(requestId, decision)` then clears `pendingApproval` in store

---

### `src/renderer/src/components/chat/MarkdownRenderer.tsx` — Markdown Rendering

**`MarkdownRenderer({ content })` (exported):**
- Wraps `react-markdown` with `remark-gfm` plugin
- Custom component overrides for consistent dark-theme styling:
  - `pre` → dark background, border, monospace
  - `code` → inline: accent-colored with bg; in code block: plain
  - `a` → accent-colored with hover underline, opens in new tab
  - `p`, `ul`, `ol`, `li`, `h1`-`h3`, `blockquote`, `hr` → spacing and typography
  - `table`, `thead`, `th`, `td` → bordered table with header background
  - `strong` → semibold

---

### `src/renderer/src/components/chat/StreamingText.tsx` — Live Streaming Display

**`StreamingText` (exported):**
- Reads `streamingText` from store, returns `null` if empty
- Renders accumulated text via `<MarkdownRenderer />`
- Appends a blinking cursor (2px wide, accent-colored, `animate-cursor-blink`)

---

### `src/renderer/src/assets/main.css` — Styles & Theme

**Tailwind v4 setup:**
- `@import "tailwindcss"` — loads Tailwind v4 (preflight + utilities)
- `@source "../../"` — tells scanner to find classes in renderer source files

**`@theme` block — CSS custom properties:**
| Token | Value | Purpose |
|---|---|---|
| `--color-bg-primary` | `#0d1117` | Main background |
| `--color-bg-secondary` | `#111318` | Sidebar / secondary areas |
| `--color-bg-tertiary` | `#1a1d24` | Cards, user bubbles, code blocks |
| `--color-bg-hover` | `#1a1d24` | Hover state backgrounds |
| `--color-bg-input` | `#161921` | Input field background |
| `--color-border` | `#23272f` | Default borders |
| `--color-border-bright` | `#343a46` | Focus / highlighted borders |
| `--color-text-primary` | `#d1d5db` | Primary text |
| `--color-text-secondary` | `#8b929e` | Secondary text |
| `--color-text-muted` | `#4b5261` | Muted / placeholder text |
| `--color-accent` | `#6c9eff` | Accent (links, icons, cursor) |
| `--color-success` | `#4ade80` | Success states (green) |
| `--color-danger` | `#f87171` | Error states (red) |
| `--color-warning` | `#fbbf24` | Warning states (amber) |
| `--font-mono` | SF Mono, Fira Code, ... | Monospace font stack |

**Animations:**
- `fade-in` — 0.15s ease-out opacity + translateY(4px→0)
- `pulse-dot` — opacity pulsing for loading dots
- `cursor-blink` — step-end blink for streaming cursor
- `spin-slow` — 1.5s linear rotation for spinners
- `typing-bounce` — bounce + opacity for typing indicator dots

**Global styles:** transparent backgrounds on html/body/#root, custom scrollbar styling, text selection color.

## Architecture Patterns

### IPC Communication
- Main ↔ Renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`
- Typed `ClaudeAPI` interface defined in `shared/types.ts`, exposed on `window.api`
- Fire-and-forget pattern for `session:send` (streams results back via events)

### SDK Integration
- `claude-agent-sdk` is externalized in Vite build (`rollupOptions.external`)
- Bundled via `extraResources` in electron-builder
- `ClaudeSession.run()` uses async generator with `includePartialMessages: true`
- `canUseTool` callback creates a Promise stored in `pendingApprovals` Map
- Tool results arrive via `type: 'user'` messages (not assistant), extracted by `extractToolResults()` and sent via `session:tool-result` IPC channel

### State Management
- Single Zustand store for session state
- Recent directories persisted to localStorage
- Directory order only changes when a session starts (user sends a prompt), not on click
- `addMessage` uses upsert by ID — SDK sends partial messages with the same `betaMessage.id`, so updates replace in place rather than duplicating

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
      → user clicks Allow/Deny → respondApproval() → resolveApproval()
    → result       → session:result (cost tracking)
```

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

### Model/Effort Selection Not Wired
The `InputBox` model picker and effort level dropdowns manage local state only — they are not yet passed through to the SDK `query()` call. The session always uses `claude-sonnet-4-5-20250929` and default effort.

### Plus Menu Not Wired
The "Attach image" option in the plus menu is UI-only — no file attachment logic is implemented yet.

## Analyzing the SDK Bundle

The SDK ships a minified `cli.js` (~11 MB) at `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. **Always use the `bundle-analyzer` skill** (invoke via `/bundle-analyzer`) to navigate this code. Standard grep/read tools are ineffective on minified single-line bundles.

### Typical workflow

1. `bundle-analyzer find cli.js "<string>"` — locate code by string literals (never by minified variable names)
2. `bundle-analyzer extract-fn cli.js <offset>` — pull out the enclosing function
3. `bundle-analyzer strings cli.js --near <offset>` — see nearby string landmarks
4. `bundle-analyzer refs cli.js <offset>` — what external variables does this function use?
5. `bundle-analyzer calls cli.js <offset>` — call graph (incoming + outgoing)
6. `bundle-analyzer decompile cli.js <offset>` — readable version with annotations
7. `bundle-analyzer patch-check cli.js <pattern>` — verify patch pattern uniqueness

### Key minified identifiers (version 2.1.39)

| Identifier | Purpose |
|---|---|
| `ihA(A)` | Generator that converts internal progress events → SDK messages |
| `VlY` | bash_progress rate limit interval (30000ms) |
| `flY` | bash_progress map size cap (100) |
| `wp1` | bash_progress throttle map (toolUseId → lastTimestamp) |
| `p6()` | Returns current session ID |
| `X6()` | Boolean coerce/check utility |

## SDK Patches

Patches live in `patch/` and fix limitations in the bundled `cli.js`. Run `node patch/apply-all.mjs` after install or SDK update.

### Writing a new patch

Each patch is a directory under `patch/` with two files:

| File | Purpose |
|---|---|
| `apply.mjs` | Node script that reads `cli.js`, finds the target code, applies the fix, verifies |
| `README.md` | Documents the bug, the fix, how to find the code in new versions |

#### `apply.mjs` conventions

1. **Read cli.js** from `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
2. **Check idempotency** — look for a `/*PATCHED:<name>*/` marker; exit early if found
3. **Find code by content patterns** — use unique string literals as anchors, never char offsets or minified variable names directly. Extract variable names dynamically from regex captures.
4. **Verify uniqueness** — ensure the match pattern appears exactly once
5. **Apply the patch** — string replacement with the marker included
6. **Write and verify** — write back, re-read, confirm marker and key strings are present
7. **Use `const V = '[\\w$]+'`** for matching minified identifiers (they can contain `$`)

#### `README.md` structure

1. **Title + one-line summary** of what the patch does
2. **Affected Component** — package name, version at time of discovery
3. **The Bug** — what's wrong, with code snippets from the minified source
4. **The Fix** — before/after code showing the change
5. **How the code was found** — which `bundle-analyzer` commands were used (helps reproduce for new versions)
6. **Applying the Patch** — `node patch/<name>/apply.mjs`
7. **How to find this code in a new version** — stable anchors to search for

#### Register in `apply-all.mjs`

Add the new patch to the `patches` array in `patch/apply-all.mjs`.

### Current patches

| Patch | Purpose |
|---|---|
| `task-notification` | Forwards task_notification system messages to SDK consumer |
| `subagent-streaming` | Forwards subagent stream events + messages to SDK consumer |
| `task-notification-usage` | Extracts `<usage>` data from task-notification XML |
