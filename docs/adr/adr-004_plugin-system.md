# ADR-004: Plugin System

**Status:** Accepted
**Date:** 2026-04-10

## Context

ClaudeUI is an open-source desktop GUI for Claude Code sessions. Users have asked for extensibility — the ability to add custom integrations (messaging platforms, external triggers, custom services) without modifying the core codebase. Some extensions involve sensitive or niche functionality that shouldn't live in the open-source repo (e.g., enterprise messaging bridges, personal automation).

The existing architecture already has clean service boundaries:
- `SessionManager` — manages multiple Claude sessions by `routingId`
- `AutomationManager` — cron/interval scheduling with headless SDK execution
- `RemoteServer` — WebSocket server with auth, event replay, remote dispatch
- `RemoteBridge` — event relay to external consumers
- All services are created in `index.ts` during boot and passed around via function args

This proposal adds a plugin system that lets external code hook into these services at runtime.

## Decision

### Plugin Discovery & Loading

**Location:** Plugins live in `~/.claude/ui/plugins/<plugin-id>/`

**Discovery:** On app startup, scan the plugins directory for subdirectories containing a `package.json` with `"claudeui"` metadata:

```json
{
  "name": "wecom-assistant",
  "version": "1.0.0",
  "claudeui": {
    "plugin": true,
    "displayName": "WeCom Assistant",
    "description": "WeChat messaging bridge via WeCom",
    "entryPoint": "dist/index.js"
  }
}
```

If `claudeui.entryPoint` is omitted, default to `"dist/index.js"`. The entry point is resolved relative to the plugin directory.

**Loading:** `require()` the entry point. It must export a `ClaudeUIPlugin` object (or default-export one):

```typescript
export interface ClaudeUIPlugin {
  id: string
  activate(ctx: PluginContext): Promise<void>
  deactivate?(): Promise<void>
}
```

### PluginContext

Plugins receive near-full access to the main process. This is deliberate — like VS Code extensions, plugins are trusted code that runs in-process.

```typescript
export interface PluginContext {
  // --- Core services (live instances) ---
  sessions: SessionManager
  automations: AutomationManager
  remoteServer: RemoteServer

  // --- Electron ---
  window: BrowserWindow
  ipcMain: typeof Electron.ipcMain

  // --- SDK ---
  sdkQuery: typeof sdkQuery      // Direct Claude Agent SDK access

  // --- Plugin storage ---
  dataDir: string                 // ~/.claude/ui/plugins/<id>/data/   (auto-created)
  configDir: string               // ~/.claude/ui/plugins/<id>/        (plugin root)

  // --- Logging ---
  logger: Logger                  // Pre-configured with source = plugin id

  // --- Event bus ---
  on(event: string, handler: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  // Plugins can emit custom events; other plugins or the core can listen.
  // Core lifecycle events: 'app:before-quit', 'app:window-ready', 'plugin:all-loaded'

  // --- Registration helpers ---
  registerIpcHandler(channel: string, handler: IpcHandler): void
  removeIpcHandler(channel: string): void
  registerRemoteHandler(channel: string, handler: RemoteHandler): void
  removeRemoteHandler(channel: string): void
  // Tracked for automatic cleanup on deactivate.
}
```

### Lifecycle

**Boot sequence (in `index.ts`):**

```
app.whenReady()
  → createWindow()
  → registerSessionIpc()       → SessionManager
  → registerTerminalIpc()      → PtyManager
  → registerAutomationIpc()    → AutomationManager
  → RemoteServer setup
  → PluginManager.loadAll(ctx)               ← NEW
  →   for each plugin dir:
  →     validate package.json
  →     require(entryPoint)
  →     call plugin.activate(ctx)
  →     log success/failure (non-fatal)
  → emit('plugin:all-loaded')                ← NEW
  → window.show()
```

**Shutdown:**

```
app.before-quit
  → emit('app:before-quit')                  ← NEW
  → PluginManager.deactivateAll()            ← NEW
  →   for each active plugin (reverse order):
  →     call plugin.deactivate()
  →     clean up tracked IPC/remote handlers
  → automationManager.stopAll()
  → remoteServer.stop()
```

**Error handling:** A plugin that throws during `activate()` is logged and skipped — it must not crash the app. A timeout (10s default) prevents hung activations.

### PluginManager

New file: `src/main/services/plugin-manager.ts`

```typescript
class PluginManager {
  private plugins: Map<string, { plugin: ClaudeUIPlugin, ctx: PluginContext }>

  async loadAll(baseCtx: Omit<PluginContext, 'dataDir' | 'configDir' | 'logger'>): Promise<void>
  async deactivateAll(): Promise<void>
  getPlugin(id: string): ClaudeUIPlugin | undefined
  listPlugins(): Array<{ id: string, name: string, active: boolean }>
}
```

### File Layout

```
src/main/
  services/
    plugin-manager.ts          ← NEW: discovery, loading, lifecycle
  shared/
    types.ts                   ← Add: ClaudeUIPlugin, PluginContext interfaces

~/.claude/ui/plugins/          ← Plugin install directory
  wecom-assistant/             ← Example plugin
    package.json
    dist/
      index.js
    data/                      ← Auto-created, plugin's persistent storage
```

### Debugging Support

Cross-app debugging is a first-class concern. Plugins run in the Electron main process but may interact with external services, spawn sessions, and handle async message flows.

#### 1. Structured Logging

Every plugin gets a namespaced `Logger` instance. All plugin logs flow through the same logging infrastructure as the core app:

```typescript
// Inside a plugin:
ctx.logger.info('wecom', 'Connected to WeCom, corp=xxx')
ctx.logger.error('wecom', 'WebSocket disconnected', { code, reason })
ctx.logger.debug('router', 'Routing message to session', { routingId, from })
```

Logs are written to `~/.claude/ui/logs/` alongside core logs, with the plugin ID as a prefix. This means **all app + plugin logs are in one place**, grep-able, tail-able.

#### 2. Plugin DevTools IPC Channel

Plugins can register a debug panel by emitting structured events on a well-known channel:

```typescript
// Plugin emits debug events
ctx.window.webContents.send('plugin:debug-event', {
  pluginId: 'wecom-assistant',
  type: 'message-received',          // or 'session-created', 'reply-sent', etc.
  timestamp: Date.now(),
  data: { from: 'wife', text: '下载三体' }
})
```

The renderer can display these in a debug panel (future UI work). In the meantime, they show up in the Electron DevTools console.

#### 3. Debug Mode & Mock Services

Plugins should support a `debug` flag in their config that enables:
- Verbose logging (all message payloads, API calls, session events)
- Mock mode for external services (e.g., fake WeCom connection that reads from a local file or stdin)
- Dry-run mode for actions (log what would happen without actually calling Claude or WeCom)

This is plugin-specific, not enforced by the plugin system, but strongly recommended.

#### 4. Electron DevTools

Since plugins run in the main process:
- `console.log` in plugin code appears in the Electron main process console
- Launch with `--inspect` to attach Node.js debugger (Chrome DevTools or VS Code)
- `electron-vite dev` already supports this for development

#### 5. Event Tracing

The `PluginContext.emit()` / `on()` event bus should optionally log all events when a `CLAUDEUI_PLUGIN_TRACE=1` env var is set. This gives a full trace of:
- Incoming messages from external services
- Session lifecycle events
- Outgoing responses
- Cross-plugin communication

### IPC Channel Namespacing

To avoid collisions with core channels, plugin-registered IPC channels **must** be prefixed with `plugin:<pluginId>:`. The `registerIpcHandler` helper enforces this:

```typescript
// Plugin calls:
ctx.registerIpcHandler('status', handler)
// Actually registers: 'plugin:wecom-assistant:status'
```

### Security Considerations

- Plugins are **trusted code** — they run with full Node.js access in the main process.
- No sandboxing. If you install a plugin, you trust it.
- Plugin directory (`~/.claude/ui/plugins/`) is user-writable only.
- Plugins are not auto-updated. User manually installs/updates by placing files in the directory.
- Future: optional plugin manifest signing for distribution.

## Consequences

- ClaudeUI gains a VS Code-style extension model without any plugin-specific logic in the core UI.
- Private/sensitive integrations (WeCom, enterprise tools) stay out of the open-source repo.
- Plugin authors get full access to the same services the core UI uses.
- Debugging is handled through structured logging + event tracing + standard Electron DevTools.
- The plugin system itself is minimal (~200-300 lines for PluginManager) and doesn't complicate the core.
- Breaking changes to core services (SessionManager API, etc.) will break plugins — this is acceptable given the early stage. Stable plugin API versioning is future work.

## Implementation Notes (2026-04-11)

Refinements made during implementation:

1. **View refactor**: Replaced ad-hoc `showUsageView`/`showAutomationView` boolean flags with a discriminated union `ActiveView` type (`'chat' | 'usage' | 'automations' | 'plugin'`).
2. **Disposable pattern**: All `registerIpcHandler`, `registerRemoteHandler`, `registerView`, and `on()` return `Disposable` objects. Auto-cleaned on deactivate.
3. **Event bus via ExtraWindow**: `PluginBridge` (like `RemoteBridge`) registered as ExtraWindow on `ClaudeSession`. All session events flow to plugins via `ctx.on('session:message', ...)`.
4. **Plugin views**: Plugins can register views via `ctx.registerView()`. Rendered as `<webview>` in the main panel, replacing ChatPanel. Plugin UI communicates via `plugin-preload.ts` bridge.
5. **Hot reload**: `PluginManager.reloadPlugin(id)` clears `require.cache` (Windows path-normalized) and re-activates.
6. **RemoteDispatcher.unregister()**: Added for plugin cleanup.
7. **`webviewTag: true`**: Enabled in BrowserWindow webPreferences for plugin views.
