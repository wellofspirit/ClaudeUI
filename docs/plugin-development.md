# ClaudeUI Plugin Development Guide

This guide covers everything you need to build a plugin for ClaudeUI. Plugins run as trusted code in the Electron main process and have full access to ClaudeUI's services — sessions, automations, remote access, and the Claude Agent SDK.

## Table of Contents

- [Quick Start](#quick-start)
- [Plugin Structure](#plugin-structure)
- [Package Manifest](#package-manifest)
- [Plugin Interface](#plugin-interface)
- [PluginContext Reference](#plugincontext-reference)
  - [Identity & Paths](#identity--paths)
  - [Logger](#logger)
  - [Core Services](#core-services)
  - [Event Bus](#event-bus)
  - [IPC Handlers](#ipc-handlers)
  - [Remote Handlers](#remote-handlers)
  - [Views](#views)
  - [SDK Access](#sdk-access)
- [Lifecycle](#lifecycle)
  - [Boot Sequence](#boot-sequence)
  - [Activation](#activation)
  - [Deactivation & Cleanup](#deactivation--cleanup)
  - [Hot Reload](#hot-reload)
  - [Shutdown](#shutdown)
- [Event Reference](#event-reference)
  - [Session Events](#session-events)
  - [Automation Events](#automation-events)
  - [Plugin Lifecycle Events](#plugin-lifecycle-events)
- [Building a Plugin View](#building-a-plugin-view)
  - [Registering a View](#registering-a-view)
  - [View HTML File](#view-html-file)
  - [The `window.pluginApi` Bridge](#the-windowpluginapi-bridge)
  - [Communication Flow](#communication-flow)
- [Debugging](#debugging)
- [Gotchas & Best Practices](#gotchas--best-practices)
- [Complete Example](#complete-example)

---

## Quick Start

Create a minimal plugin in three files:

```
~/.claude/ui/plugins/hello-world/
  package.json
  dist/
    index.js
```

**package.json:**

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "claudeui": {
    "plugin": true,
    "displayName": "Hello World"
  }
}
```

**dist/index.js:**

```js
module.exports = {
  activate(ctx) {
    ctx.logger.info('Hello from plugin!')
  }
}
```

Restart ClaudeUI. Check `~/.claude/ui/logs/` for the log line `[plugin:hello-world] Hello from plugin!`.

---

## Plugin Structure

Plugins live in `~/.claude/ui/plugins/<plugin-id>/`. The directory name is the plugin's **ID** — it must be a valid directory name and is used for IPC namespacing.

```
~/.claude/ui/plugins/
  my-plugin/                   # plugin ID = "my-plugin"
    package.json               # required — manifest with claudeui metadata
    dist/
      index.js                 # entry point (default, configurable)
      view.html                # optional — plugin UI
    data/                      # auto-created — persistent storage
    node_modules/              # optional — plugin dependencies
```

---

## Package Manifest

The `package.json` must contain a `claudeui` object with `plugin: true`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "claudeui": {
    "plugin": true,
    "displayName": "My Plugin",
    "description": "Does something useful",
    "entryPoint": "dist/index.js"
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `claudeui.plugin` | Yes | — | Must be `true` to be recognized as a plugin |
| `claudeui.displayName` | No | `name` field | Human-readable name shown in plugin listings |
| `claudeui.description` | No | — | Short description |
| `claudeui.entryPoint` | No | `"dist/index.js"` | Path to main JS file, relative to plugin dir |

---

## Plugin Interface

The entry point must export (or default-export) a `ClaudeUIPlugin` object:

```typescript
interface ClaudeUIPlugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

**CommonJS:**

```js
module.exports = {
  activate(ctx) { /* ... */ },
  deactivate() { /* ... */ }
}
```

**ESM (compiled to CJS):**

```typescript
export default {
  activate(ctx: PluginContext) { /* ... */ },
  deactivate() { /* ... */ }
}
```

Both `module.exports` and `module.exports.default` are supported.

---

## PluginContext Reference

The `PluginContext` object is passed to `activate()` and is your plugin's gateway to ClaudeUI.

### Identity & Paths

```typescript
ctx.id         // string — plugin ID (directory name)
ctx.pluginDir  // string — absolute path to plugin directory
ctx.dataDir    // string — ~/.claude/ui/plugins/<id>/data/ (auto-created)
ctx.configDir  // string — same as pluginDir
ctx.debug      // boolean — true if CLAUDEUI_PLUGIN_DEBUG=1 env var is set
```

**`dataDir`** is created automatically on activation. Use it for persistent storage (databases, caches, state files). It survives plugin reloads and app restarts.

### Logger

```typescript
ctx.logger.info('Connected to service')
ctx.logger.warn('Retrying in 5s', error)
ctx.logger.error('Connection failed', error)
ctx.logger.debug('Received message payload')
```

All messages are prefixed with `[plugin:<id>]` and written to:
- The Electron main process console
- `~/.claude/ui/logs/YYYYMMDD.log` (same file as core ClaudeUI logs)

Debug messages are only shown when the log level is set to `debug` (via `CLAUDE_UI_LOG=debug` env var or UI settings).

### Core Services

```typescript
ctx.sessions     // SessionManager — manage Claude sessions
ctx.automations  // AutomationManager — manage scheduled automations
ctx.window       // BrowserWindow — the main Electron window
ctx.ipcMain      // Electron.ipcMain — raw IPC for advanced use cases
```

#### SessionManager

The `SessionManager` gives you full control over Claude sessions:

```typescript
// Get an existing session by routing ID
const session = ctx.sessions.get(routingId)

// Check if a session exists
ctx.sessions.has(routingId)

// Create a new session
const session = ctx.sessions.create(
  routingId,      // unique ID (string)
  ctx.window,     // BrowserWindow
  '/path/to/cwd', // working directory
  'high',         // effort level (optional): 'low' | 'medium' | 'high'
  undefined,      // resumeSessionId (optional)
  'auto',         // permission mode (optional): 'default' | 'acceptEdits' | 'plan' | 'auto'
  'claude-sonnet-4-6' // model (optional)
)

// Send a prompt to a session
session.run('Explain this codebase')

// Cancel / interrupt
ctx.sessions.cancel(routingId)
await ctx.sessions.interrupt(routingId)

// Iterate all sessions
ctx.sessions.forEach((session) => { /* ... */ })
```

**Important:** Sessions created by plugins are real SDK sessions. They consume API credits, trigger approval flows, and appear in the UI. Be thoughtful about when to create them.

#### AutomationManager

Access and manage scheduled automations:

```typescript
// The automation manager is the same instance the UI uses.
// Use it to inspect, create, or run automations programmatically.
const automations = ctx.automations
```

### Event Bus

Subscribe to events from sessions, automations, and other plugins:

```typescript
// Subscribe to an event — returns a Disposable
const disposable = ctx.on('session:message', (event) => {
  ctx.logger.info(`Message in session ${event.sessionId}: ${event.role}`)
})

// Unsubscribe manually (optional — auto-cleaned on deactivate)
disposable.dispose()

// Emit a custom event (auto-namespaced to plugin:<id>:<event>)
ctx.emit('status-changed', { connected: true })
```

**Key semantics:**

- `ctx.on(event, handler)` subscribes to events. Session events receive a single object with `{ routingId, sessionId, ...eventData }` (see [Session Events](#session-events) and ADR-005).
- Every `on()` call returns a `Disposable`. You can call `dispose()` to unsubscribe, but you don't have to — **all subscriptions are automatically cleaned up when the plugin is deactivated or reloaded**.
- `ctx.emit(event, ...args)` emits a custom event. The event name is automatically prefixed to `plugin:<id>:<event>`. The event fires on:
  1. The internal event bus (other plugins can listen via `ctx.on('plugin:<id>:<event>', ...)`)
  2. The renderer process (the main window receives it as an IPC event)

### IPC Handlers

Register request/response handlers that the renderer (or plugin views) can call:

```typescript
// Register a handler — auto-namespaced to plugin:<id>:<channel>
const disposable = ctx.registerIpcHandler('get-status', () => {
  return { connected: true, uptime: 12345 }
})

// From the renderer or a plugin view:
// window.api.invoke('plugin:my-plugin:get-status') → { connected: true, ... }
// window.pluginApi.invoke('get-status') → same thing (in plugin views)
```

**Namespacing:** When you register `'get-status'`, the actual IPC channel becomes `plugin:<id>:get-status`. This prevents collisions with core channels and other plugins.

**Return values:** Handlers can return any serializable value or a Promise. Errors thrown in handlers are propagated to the caller.

**Cleanup:** Like event subscriptions, IPC handlers are automatically removed when the plugin deactivates.

### Remote Handlers

Register handlers accessible via the RemoteServer's WebSocket API (for remote clients):

```typescript
ctx.registerRemoteHandler('status', async () => {
  return { connected: true }
})

// Remote clients can invoke: { type: 'invoke', channel: 'plugin:my-plugin:status', args: [] }
```

Same namespacing and auto-cleanup behavior as IPC handlers.

### Views

Register a UI view that appears as a sidebar item and replaces the chat panel when clicked:

```typescript
ctx.registerView({
  label: 'My Dashboard',       // sidebar label
  htmlFile: 'dist/view.html',  // relative to plugin dir, or absolute path
  icon: '<svg width="15" height="15" ...>...</svg>',  // optional SVG for sidebar
  id: 'dashboard'              // optional, defaults to plugin ID
})
```

See [Building a Plugin View](#building-a-plugin-view) for the full view development guide.

### SDK Access

For advanced use cases, you have direct access to the Claude Agent SDK's `query` function:

```typescript
const q = ctx.sdkQuery({
  prompt: 'Summarize this file',
  options: {
    cwd: '/path/to/project',
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto'
  }
})

for await (const event of q) {
  if (event.type === 'assistant') {
    // Process assistant message
  }
}
```

**Warning:** `sdkQuery` is the raw escape hatch. It spawns a CLI subprocess directly, bypassing the session manager's tracking, cost monitoring, and cleanup. Prefer `ctx.sessions.create()` for most use cases.

---

## Lifecycle

### Boot Sequence

ClaudeUI loads plugins during app startup, after all core services are ready:

```
app.whenReady()
  → createWindow()
  → SessionManager ready
  → AutomationManager ready
  → RemoteServer ready
  → PluginManager.loadAll()          ← plugins load here
    → scan ~/.claude/ui/plugins/
    → for each valid plugin (alphabetical order):
        → read package.json
        → require(entryPoint)
        → call plugin.activate(ctx)
    → emit 'plugin:all-loaded'
  → window.show()
```

**Load order:** Plugins are loaded in alphabetical order by directory name. There is no dependency system — if your plugin depends on another plugin, listen for `plugin:all-loaded` and query the other plugin's state via the event bus.

### Activation

`activate(ctx)` is called with a 10-second timeout. If it returns a Promise that doesn't resolve within 10 seconds:

1. The activation is considered failed
2. All resources registered so far (IPC handlers, event listeners, views) are cleaned up
3. The plugin is marked as disabled with an error message
4. The app continues loading other plugins

**Activation must not crash the app.** All activation calls are wrapped in try/catch. A failing plugin is logged and skipped — it never prevents other plugins or the app from loading.

If your activation involves async work (connecting to servers, initializing databases), consider:

```js
module.exports = {
  async activate(ctx) {
    // Fast synchronous setup (always completes within timeout)
    ctx.registerIpcHandler('status', () => this.getStatus())
    ctx.registerView({ label: 'My View', htmlFile: 'dist/view.html' })

    // Slow async work — start but don't await
    this.connectInBackground(ctx)
  },

  connectInBackground(ctx) {
    // This runs after activation completes
    someSlowConnection().then(() => {
      ctx.logger.info('Connected!')
    }).catch((err) => {
      ctx.logger.error('Connection failed', err)
    })
  }
}
```

### Deactivation & Cleanup

When a plugin is deactivated (during reload, shutdown, or on error):

1. All tracked `Disposable` resources are disposed:
   - Event listeners removed from the bus
   - IPC handlers removed via `ipcMain.removeHandler()`
   - Remote handlers unregistered from the dispatcher
   - Views removed from the sidebar
2. `plugin.deactivate()` is called (if defined) with a 5-second timeout
3. The plugin is removed from the active plugins map

**You usually don't need to implement `deactivate()`** — the Disposable pattern handles cleanup of all registered resources. Only implement it if you have external cleanup (closing WebSocket connections, flushing databases, stopping timers):

```js
module.exports = {
  ws: null,

  activate(ctx) {
    this.ws = new WebSocket('wss://example.com')
  },

  deactivate() {
    if (this.ws) this.ws.close()
  }
}
```

### Hot Reload

Plugins can be reloaded without restarting the app:

```typescript
// From the renderer or via IPC
await window.api.reloadPlugin('my-plugin')
```

The reload process:
1. `deactivate()` is called on the old instance
2. All tracked resources are cleaned up
3. `require.cache` is cleared for all files under the plugin directory
4. The entry point is re-`require()`d
5. `activate()` is called on the new instance
6. The sidebar updates to reflect any view changes

**Caveats:**
- Only files under the plugin directory are cleared from `require.cache`. If your plugin `require()`s files from `node_modules` outside the plugin dir, those modules won't be reloaded.
- Any state stored outside the plugin object (global variables, module-level caches) will persist if the module isn't in the plugin directory.

### Shutdown

During app shutdown (`before-quit`):

1. `PluginManager.stopAll()` is called (before other service cleanup)
2. Plugins are deactivated in **reverse load order** (last loaded = first deactivated)
3. All tracked resources are cleaned up
4. `deactivate()` is called synchronously (no async timeout during shutdown)

---

## Event Reference

### Session Events

These events fire for every active Claude session. All handlers receive a single object with `{ routingId: string, sessionId: string | null, ...eventData }` (see ADR-005).

| Event | Data | Description |
|-------|------|-------------|
| `session:message` | `ChatMessage` | Assistant or user message (upserts by ID) |
| `session:stream` | `{ type: 'text' \| 'thinking', text: string }` | Streaming text delta |
| `session:status` | `{ state: string, ... }` | Session state change (active, idle, etc.) |
| `session:result` | `{ costUsd, durationMs, ... }` | Turn completed with cost info |
| `session:error` | `string` | Error message |
| `session:approval-request` | `PendingApproval` | Tool use requires user approval |
| `session:tool-result` | `{ toolUseId, result, isError }` | Tool execution result |
| `session:task-progress` | `{ toolUseId, content }` | Background task progress update |
| `session:task-notification` | `TaskNotification` | Background task completed/failed |
| `session:subagent-message` | `{ toolUseId, message }` | Subagent sent a message |
| `session:subagent-stream` | `{ toolUseId, type, text }` | Subagent streaming delta |
| `session:subagent-tool-result` | `{ toolUseId, ... }` | Subagent tool result |
| `session:background-output` | `{ toolUseId, tail, totalSize, done }` | Background task output chunk |
| `session:permission-mode` | `string` | Permission mode changed |
| `session:slash-commands` | `SlashCommandInfo[]` | Available slash commands updated |
| `session:skills` | `string[]` | Available skill names updated |
| `session:mcp-servers` | `McpServerInfo[]` | MCP server status updated |
| `session:status-line` | `StatusLineData` | Status line metrics updated |
| `session:teammate-detected` | `TeammateInfo` | New teammate/subagent detected |
| `session:team-created` | `{ teamName }` | Team created |
| `session:team-deleted` | `{}` | Team deleted |
| `session:sandbox-violation` | `string` | Sandbox violation detected |
| `session:steer-consumed` | `{ prompt }` | Steer/queue command consumed |

**Example — listening to all assistant messages:**

```js
ctx.on('session:message', (event) => {
  if (event.role === 'assistant') {
    const label = event.sessionId ?? event.routingId
    for (const block of event.content) {
      if (block.type === 'text') {
        ctx.logger.info(`[${label}] Assistant: ${block.text.slice(0, 100)}`)
      }
    }
  }
})
```

**Example — querying session history:**

```js
// Backfill messages when opening a plugin view for an existing session
const messages = ctx.sessions.getMessages(sessionId)
for (const msg of messages) {
  renderMessage(msg)
}
```

### Automation Events

These events fire for automation runs. Handlers receive the data directly (no routingId prefix).

| Event | Data | Description |
|-------|------|-------------|
| `automation:run-update` | `{ automationId, run }` | Automation run status changed |
| `automation:run-message` | `{ automationId, message }` | Message from automation run |
| `automation:stream-event` | `{ automationId, type, text }` | Streaming output from automation |
| `automation:processing` | `{ automationId, isProcessing }` | Processing state changed |
| `automation:changed` | `Automation[]` | Automation list changed |

### Plugin Lifecycle Events

| Event | Data | Description |
|-------|------|-------------|
| `plugin:all-loaded` | (none) | All plugins finished loading |

---

## Building a Plugin View

Plugin views are HTML pages rendered in a `<webview>` element that replaces the main chat panel. They appear as clickable items in the sidebar.

### Registering a View

```js
module.exports = {
  activate(ctx) {
    ctx.registerView({
      label: 'My Dashboard',
      htmlFile: 'dist/view.html',  // relative to plugin directory
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.8">
               <rect x="3" y="3" width="18" height="18" rx="2"/>
             </svg>`
    })
  }
}
```

The view appears in the sidebar after the Automations item. Clicking it replaces the chat panel with your HTML page. Clicking again (or clicking another view/session) switches back to chat.

### View HTML File

Your HTML file is loaded via `file://` protocol in an Electron webview. It has access to `window.pluginApi` (injected by the plugin preload script):

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My Plugin</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      margin: 0;
      padding: 16px;
    }
  </style>
</head>
<body>
  <h2>My Plugin Dashboard</h2>
  <div id="status">Loading...</div>

  <script>
    // pluginApi is injected by ClaudeUI's plugin preload
    async function init() {
      const status = await window.pluginApi.invoke('get-status')
      document.getElementById('status').textContent = JSON.stringify(status)
    }

    // Listen for real-time updates
    window.pluginApi.on('status-update', (data) => {
      document.getElementById('status').textContent = JSON.stringify(data)
    })

    init()
  </script>
</body>
</html>
```

### The `window.pluginApi` Bridge

Every plugin view has `window.pluginApi` injected automatically. It provides:

```typescript
window.pluginApi = {
  /** The plugin ID */
  pluginId: string

  /** Call a plugin IPC handler (auto-namespaced) */
  invoke(channel: string, ...args: any[]): Promise<any>

  /** Listen to plugin events (auto-namespaced) */
  on(event: string, callback: (...args: any[]) => void): () => void

  /** Send a one-way message (auto-namespaced) */
  send(channel: string, ...args: any[]): void
}
```

**Namespacing is automatic.** When your view calls `pluginApi.invoke('get-status')`, it invokes the IPC channel `plugin:<id>:get-status` — which is the same channel your main process code registered with `ctx.registerIpcHandler('get-status', handler)`.

### Communication Flow

```
Plugin View (webview)                    Plugin Main Process
─────────────────────                    ────────────────────

pluginApi.invoke('get-data')  ──IPC──►  ctx.registerIpcHandler('get-data', () => { ... })
                              ◄─────    return value flows back as Promise resolution

ctx.emit('update', payload)   ──IPC──►  fires on event bus AND sends to renderer
pluginApi.on('update', cb)    ◄─────    webview receives plugin:<id>:update event
```

**Important:** `ctx.emit()` sends events to both the internal plugin event bus AND the renderer window. The webview preload routes `plugin:<id>:<event>` events to your `pluginApi.on()` callbacks.

---

## Debugging

### Log Viewer

ClaudeUI has a built-in log viewer window that captures **all** log output in one place — backend logger messages, renderer console output (`console.log`, `console.error`, etc.), and plugin logs. Open it via:

- **Menu:** Help > Open Log Viewer
- **Keyboard:** `Ctrl+Shift+L` (Windows/Linux) or `Cmd+Shift+L` (macOS)
- **Programmatically:** `window.api.openLogViewer()` from the renderer

The log viewer is a standalone window — it survives main window refreshes and page reloads. Features:
- Color-coded log levels (debug, info, warn, error)
- Source-based coloring (main process = purple, renderer = orange, plugins = cyan)
- Level filter toggle buttons
- Source text search
- Auto-scroll with "paused" indicator when scrolled up
- 5000-entry ring buffer — buffered entries are sent on open, so you see recent history

All plugin `ctx.logger.*` calls appear with source `plugin:<id>`, making them easy to filter.

### Log Levels

Set `CLAUDE_UI_LOG=debug` to see all plugin debug messages, or target a specific plugin:

```bash
CLAUDE_UI_LOG=plugin:my-plugin:debug electron .
```

### Event Tracing

Set `CLAUDEUI_PLUGIN_TRACE=1` to log every event that flows through the plugin event bus:

```bash
CLAUDEUI_PLUGIN_TRACE=1 electron .
```

This produces output like:
```
[plugin-manager] [trace] session:message {"role":"assistant"...}
[plugin-manager] [trace] emit plugin:my-plugin:status-changed
```

### Debug Mode

Check `ctx.debug` to enable verbose logging in your plugin:

```bash
CLAUDEUI_PLUGIN_DEBUG=1 electron .
```

```js
activate(ctx) {
  if (ctx.debug) {
    ctx.logger.debug('Verbose mode enabled')
  }
}
```

### Electron DevTools

- Plugin code runs in the main process. `console.log` appears in the main process console.
- Launch with `--inspect` to attach a Node.js debugger (Chrome DevTools or VS Code).
- `electron-vite dev` supports this out of the box for development.
- Plugin views have their own DevTools — right-click the webview and select "Inspect Element" (dev mode only).

---

## Gotchas & Best Practices

### Activation Timeout

Your `activate()` must complete within **10 seconds**. If it doesn't:
- The plugin is marked as failed
- All resources registered during the partial activation are cleaned up
- The error is logged

**Fix:** Start long-running work (server connections, large file reads) in background promises. Register your IPC handlers and views synchronously.

### Disposable Pattern

Every `ctx.on()`, `ctx.registerIpcHandler()`, `ctx.registerRemoteHandler()`, and `ctx.registerView()` call returns a `Disposable` with a `dispose()` method.

You almost never need to call `dispose()` manually — everything is auto-cleaned on deactivation. The return value exists for cases where you want to dynamically unregister something mid-lifecycle:

```js
const d = ctx.on('session:message', handler)
// Later, if you want to stop listening before deactivation:
d.dispose()
```

### IPC Handler Uniqueness

`ipcMain.handle()` throws if you register the same channel twice. This is handled by the plugin system:
- On reload, old handlers are disposed before new ones are registered
- If two plugins try to register the same un-namespaced channel name, namespacing prevents collision (`plugin:a:status` vs `plugin:b:status`)

### Session Event Arguments

Session events pass `(routingId, data)`. The `routingId` identifies which session emitted the event. If your plugin manages multiple sessions, use routingId to route events correctly.

### Windows Path Handling

On Windows, file paths use backslashes. When providing `htmlFile` for views, you can use either format — the plugin system normalizes paths. However, in your plugin code, use `path.join()` for cross-platform compatibility.

### View Lifecycle

- If a plugin deregisters its view (via `dispose()`) while the user is viewing it, the UI automatically switches back to the chat panel.
- Plugin views are destroyed and recreated each time the user navigates to/from them. Don't rely on in-memory state in the view — persist important state via IPC to the main process.
- The webview runs in a separate renderer process with `nodeIntegration: false`. It can only communicate with the main process through `window.pluginApi`.

### Dependencies

Plugins can have their own `node_modules/`. Since plugins are loaded via `require()` in the main process, native modules (compiled addons) must be built for the Electron version ClaudeUI uses.

For pure JS dependencies, just `npm install` or `bun install` in your plugin directory.

### No Cross-Plugin Dependencies

There is no dependency resolution system. Plugins load alphabetically. If plugin B depends on plugin A:

```js
// Plugin B
activate(ctx) {
  ctx.on('plugin:all-loaded', () => {
    // All plugins are now active — safe to interact with plugin A
    ctx.on('plugin:plugin-a:ready', () => { /* ... */ })
  })
}
```

### Error Isolation

Your plugin should never crash the app. The plugin manager wraps activation in try/catch, but runtime errors in event handlers or IPC handlers are your responsibility:

```js
ctx.on('session:message', (event) => {
  try {
    processMessage(event)
  } catch (err) {
    ctx.logger.error('Failed to process message', err)
  }
})
```

The event bus does catch and log errors from listeners, but relying on this is bad practice — it means you miss the error context.

---

## Complete Example

A plugin that logs all session messages to a file and provides a count via IPC:

```
~/.claude/ui/plugins/message-logger/
  package.json
  dist/
    index.js
    view.html
```

**package.json:**

```json
{
  "name": "message-logger",
  "version": "1.0.0",
  "claudeui": {
    "plugin": true,
    "displayName": "Message Logger",
    "description": "Logs all session messages to a file"
  }
}
```

**dist/index.js:**

```js
const fs = require('fs')
const path = require('path')

let logStream = null
let messageCount = 0

module.exports = {
  activate(ctx) {
    // Open log file in data directory
    const logPath = path.join(ctx.dataDir, 'messages.jsonl')
    logStream = fs.createWriteStream(logPath, { flags: 'a' })
    ctx.logger.info(`Logging messages to ${logPath}`)

    // Listen to all session messages
    ctx.on('session:message', (event) => {
      messageCount++
      const entry = {
        timestamp: new Date().toISOString(),
        sessionId: event.sessionId,
        routingId: event.routingId,
        role: event.role,
        contentLength: JSON.stringify(event.content).length
      }
      logStream.write(JSON.stringify(entry) + '\n')

      // Notify the view of the new count
      ctx.emit('count-updated', { count: messageCount })
    })

    // IPC handler for the view to query the count
    ctx.registerIpcHandler('get-count', () => {
      return { count: messageCount }
    })

    // Register a sidebar view
    ctx.registerView({
      label: 'Message Log',
      htmlFile: 'dist/view.html',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
               <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
               <polyline points="14 2 14 8 20 8"/>
               <line x1="16" y1="13" x2="8" y2="13"/>
               <line x1="16" y1="17" x2="8" y2="17"/>
             </svg>`
    })
  },

  deactivate() {
    if (logStream) {
      logStream.end()
      logStream = null
    }
    messageCount = 0
  }
}
```

**dist/view.html:**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #16163a;
      color: #c8c8d4;
      margin: 0;
      padding: 24px;
    }
    .count {
      font-size: 48px;
      font-weight: bold;
      color: #7c6fe0;
      margin: 24px 0;
    }
    .label {
      font-size: 14px;
      color: #8888a0;
    }
  </style>
</head>
<body>
  <div class="label">Messages logged</div>
  <div class="count" id="count">...</div>

  <script>
    async function load() {
      const { count } = await window.pluginApi.invoke('get-count')
      document.getElementById('count').textContent = count
    }

    window.pluginApi.on('count-updated', ({ count }) => {
      document.getElementById('count').textContent = count
    })

    load()
  </script>
</body>
</html>
```
