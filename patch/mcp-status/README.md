# Patch: mcp-status

## Bug

In SDK/headless mode, `mcpServerStatus()` returns an empty array even though MCP servers are loaded by the CLI process.

### Root Cause

Plugin-provided MCP servers (e.g., `lsphub` from `typescript-lsp` plugin) are loaded asynchronously after the initial app state is created:

1. `zg()` starts loading MCP configs from files (async) — no plugin servers yet
2. `await cW8()` installs and configures plugins
3. `await m6` gets `zg()` result — but `zg()` started before plugins were installed
4. Initial state is created with empty `mcp.clients`
5. Inside `IWz`, `J6()` fires (fire-and-forget) to re-load MCP configs after plugins
6. SDK sends `mcp_status` request → handler reads state → all sources empty → `[]`
7. `J6()` eventually completes, populates dynamic servers — but too late

The `J6()` promise is only stored when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` env var is set. Otherwise it's fire-and-forget, and the `mcp_status` handler has no way to wait for it.

## Fix

### Part A: Always store the J6 promise

**Before:**
```js
X6 = null;
if (_1(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) X6 = J6();
else J6()  // fire-and-forget!
```

**After:**
```js
X6 = J6()  // always stored
```

### Part B: mcp_status handler awaits the refresh

**Before:**
```js
if (e.request.subtype === "mcp_status") {
  await d();
  let w6 = await $(), ...
```

**After:**
```js
if (e.request.subtype === "mcp_status") {
  await d();
  if (X6) await X6;  // wait for plugin MCP refresh
  let w6 = await $(), ...
```

## How to find the code

```bash
# Part A: J6 fire-and-forget pattern
bundle-analyzer find cli.js "CLAUDE_CODE_SYNC_PLUGIN_INSTALL" --compact

# Part B: mcp_status handler
bundle-analyzer find cli.js "mcp_status" --compact
```

## Stable anchors

- Part A: `process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` string literal
- Part B: `"mcp_status"` string literal in the control request handler

## MCP lifecycle events reference

The SDK supports these MCP control request subtypes (all handled in the same message loop):

| Subtype | Purpose | Response |
|---|---|---|
| `mcp_status` | Get all server statuses | `{mcpServers: [...]}` |
| `mcp_set_servers` | Add/remove dynamic servers | `{added, removed, errors}` |
| `mcp_reconnect` | Reconnect a named server | success/error |
| `mcp_toggle` | Enable/disable a named server | success/error |
| `mcp_authenticate` | Start OAuth for SSE/HTTP server | `{authUrl?, requiresUserAction}` |
| `mcp_clear_auth` | Clear OAuth credentials | success/error |
| `mcp_message` | Forward message to MCP transport | success |

All these are properly forwarded through the SDK via `control_request` → `control_response` over the stdio transport. The toggle, reconnect, and authenticate handlers correctly update the app state's `mcp.clients` in-place, so the UI will see changes on the next `mcp_status` call.
