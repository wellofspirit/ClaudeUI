# Patch: mcp-status

## Bug

In SDK/headless mode, `mcpServerStatus()` returns an empty or incomplete array, missing locally configured MCP servers (from `--mcp-config`).

### Root Cause

MCP servers configured via `--mcp-config` are loaded by the headless refresh function `s()`, which is called from `V6()`. However, `V6()` is gated by two conditions:

1. `if(!Y9())` — skipped in bare/SDK mode (`--bare` flag)
2. `if(await BeK())` — only calls `s()` if plugin installation returns truthy

In SDK mode, the CLI runs with `--bare`, so `Y9()` returns true, `!Y9()` is false, and `V6()` never executes. The `--mcp-config` servers are never connected, so `mcpServerStatus()` returns only cloud-configured servers (e.g., claude.ai proxy servers).

Additionally, the plugin refresh promise is only stored when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` env var is set. Otherwise it's fire-and-forget, and the handler has no way to wait for it.

## Fix

### Part A: Always store the plugin refresh promise

Removes the `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` conditional so the promise is always stored (when `V6()` does run in non-bare mode).

**Before:**
```js
z6 = null;
if (!Y9()) {
  if (syncCheck(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) z6 = V6();
  else V6()  // fire-and-forget!
}
```

**After:**
```js
z6 = null;
if (!Y9()) z6 = V6()  // always stored
```

### Part B: mcp_status handler calls the headless refresh function to load servers

Instead of just reading the current state, the handler now calls the headless MCP refresh function (dynamically extracted by searching for the `"Headless MCP refresh"` string anchor) to ensure all configured MCP servers are loaded before reading status. The refresh function:

1. Calls `j46()` to read all MCP server configs from all sources
2. Filters by supported types (stdio, sse, http, sdk)
3. Calls `X6()` (serialized updater) to connect new servers and update appState
4. Is safe to call concurrently — `X6()` uses a promise chain for serialization

Also awaits the plugin refresh promise if available (non-bare mode).

**Before:**
```js
if (h6.request.subtype === "mcp_status")
  E6(h6, { mcpServers: J6() });
```

**After:**
```js
if (h6.request.subtype === "mcp_status") {
  await <refreshFn>();          // load all configured servers (name extracted dynamically)
  if (<pluginVar>) await <pluginVar>;  // wait for plugin refresh (non-bare)
  E6(h6, { mcpServers: J6() });
}
```

> **Important:** The refresh function name is minified and changes between SDK versions
> (e.g., `s` in 0.2.87, `R6` in 0.2.97). The patch dynamically extracts it by finding
> the `"Headless MCP refresh"` string literal and searching backward for the nearest
> `async function <name>()` definition. Hardcoding the function name causes the handler
> to call undefined, which silently breaks the control response and hangs the UI.

## How to find the code

```bash
# Part A: Plugin refresh promise pattern
bundle-analyzer find cli.js "CLAUDE_CODE_SYNC_PLUGIN_INSTALL" --compact

# Part B: mcp_status handler
bundle-analyzer find cli.js "mcp_status" --compact

# Headless MCP refresh function (name changes between versions)
bundle-analyzer find cli.js "Headless MCP refresh" --compact
```

## Stable anchors

- Part A: `process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` string literal
- Part B: `"mcp_status"` string literal in the control request handler
- Headless refresh fn: `"Headless MCP refresh"` log message inside the function body
  (the function name is minified and changes between SDK versions — the patch
  finds it by searching backward from this string anchor)
- Config reader: async function that reads MCP server configs from all sources

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

All these are properly forwarded through the SDK via `control_request` -> `control_response` over the stdio transport.
