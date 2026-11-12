# Plugins

Governs: `src/main/services/plugin-manager.ts`, `src/preload/plugin-preload.ts`, `src/shared/types/plugins.ts`, `src/shared/types/api/plugin.ts`, `src/renderer/src/components/plugin/`

The desktop app's extension model: trusted, in-process plugins loaded from the user's plugin directory, and the
session-scoped event and history API they get. The developer reference (manifest, `PluginContext` members, event
table, view bridge) is `docs/plugin-development.md`; it is not repeated here. The remote lane that plugin session
events must keep working across is ADR-055 (sync-core.md). Plugin channels are registered through the command
registry, whose capability model is in `docs/architecture/security.md`.

## Plugins are trusted, unsandboxed, in-process code (ADR-004)

ClaudeUI loads extensions the way VS Code does: a plugin is trusted code running in the Electron main process with
full Node.js access. This is a ruling, not a defect. There is no sandbox, no permission prompt, no signature check:
installing a plugin means trusting it, and a plugin can read anything the app can. Private or sensitive integrations
(messaging bridges, personal automation) live outside the open-source repo as plugins; the core carries no
plugin-specific logic.

- **Location and discovery.** `~/.claude/ui/plugins/<dir>/`; at startup every subdirectory (or symlink to one) whose
  `package.json` has `"claudeui": {"plugin": true}` is loaded, in sorted order. `claudeui.entryPoint` defaults to
  `dist/index.js`. The entry is `require()`d and must export (or default-export) an object with `activate(ctx)`
  and optionally `deactivate()`. The plugin's id is its directory name. Plugins are never auto-updated: the user
  installs or updates by placing files there.
- **Failure is isolated.** A plugin that throws, lacks `activate`, has a missing entry or exceeds the 10 s activation
  timeout is logged and recorded as `enabled: false` with its `error`; the app boots regardless. `plugin:all-loaded`
  fires after the scan.
- **Everything registered is a `Disposable`** and tracked per plugin: `on`, `registerIpcHandler`,
  `registerRemoteHandler`, `registerView`. Deactivation (reverse load order, on quit) disposes them all, and
  `reloadPlugin(id)` re-activates after clearing the plugin's `require.cache` entries (path-normalized for Windows).
- **Namespacing.** Plugin IPC and remote channels are always prefixed `plugin:<id>:` by the helper, and a plugin's
  `emit` goes out as `plugin:<id>:<event>` to the bus and the renderer, so a plugin cannot shadow a core channel.
- **Remote reach.** A plugin's remote handler is registered in the command registry with capability `config`, kind
  `command` (so every invocation is audit-logged). `config` UNDER-states the authority of unsandboxed code; it is the
  capability a remote connection already holds, and `admin` would silently remove a working surface. Plugins
  declaring their own capability is unbuilt.
- **Logging and debug.** A plugin's logger writes through the core logger with source `plugin:<id>`, into the same
  logs as the app. `CLAUDEUI_PLUGIN_TRACE=1` traces bus events; `CLAUDEUI_PLUGIN_DEBUG=1` sets `ctx.debug`. Mock and
  dry-run modes are plugin-specific and not enforced.
- **Views.** A plugin view renders in a `<webview>` in the main panel (`webviewTag: true`), only with ClaudeUI's own
  `plugin-preload` (the main process forces it; a plugin cannot choose another).
- **No API stability promise.** The context hands out live core services (the session manager, the automation
  manager, the window, `ipcMain`, the SDK `query`), so a change to those can break plugins; that is accepted.

Not built, and not a binding promise: a renderer debug panel for a `plugin:debug-event` channel, plugin manifest
signing, a stable versioned plugin API.

## Plugins key sessions by session id, and events are objects (ADR-005)

A plugin that manages sessions needs an identifier that is stable and resumable, not the internal `routingId`
(transient, not stable across restarts). The plugin session API therefore works in `sessionId` (the engine's
session UUID, which maps to disk-level history) and keeps `routingId` only for the early window.

- **Events are objects carrying both ids.** Every session event the plugin bus delivers is one object
  `{routingId, sessionId, ...eventData}`, never positional arguments (self-documenting, and adding a field does not
  break handlers). `sessionId` is `null` until the first engine response; the plugin keys by `routingId` until it
  appears, then re-keys. The core does not buffer, replay or hide that gap.
- **The plugin contract survives the sync and volatile lanes.** The legacy event names (`session:message`,
  `session:stream`, `session:subagent-stream`, `session:item-delta`, ...) are re-materialized in process from the
  canonical state and the volatile stream lane (`PluginManager`), gated on a plugin actually listening, so the
  token firehose costs nothing on a machine with no plugins. A change to the lanes must not change what a plugin
  receives.
- **History and id lookup.** `ctx.sessions.getMessages(sessionId, cwd)` returns the in-memory messages of an active
  session or loads them from disk; `ctx.sessions.getSessionId(routingId)` returns the id or `null`.
- **Plugins render their own session views.** The core offers no "switch the main UI to this session" call: it would
  hijack the main UI and couple plugins to core routing. `session:message` carries full `ChatMessage` content blocks
  (text, tool_use, tool_result, thinking), which is enough to render a rich view in a plugin webview.
