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

### Part B: mcp_status handler calls s() to load servers

Instead of just reading the current state, the handler now calls `await s()` to ensure all configured MCP servers (from `--mcp-config`, user/project config, plugins) are loaded before reading status. The `s()` function:

1. Calls `j46()` to read all MCP server configs from all sources
2. Filters by supported types (stdio, sse, http, sdk)
3. Calls `X6()` (serialized updater) to connect new servers and update appState
4. Is safe to call concurrently — `X6()` uses a promise chain for serialization

Also awaits the plugin refresh promise `z6` if available (non-bare mode).

**Before:**
```js
if (h6.request.subtype === "mcp_status")
  E6(h6, { mcpServers: J6() });
```

**After:**
```js
if (h6.request.subtype === "mcp_status") {
  await s();                    // load all configured servers
  if (z6) await z6;             // wait for plugin refresh (non-bare)
  E6(h6, { mcpServers: J6() });
}
```

## How to find the code

```bash
# Part A: Plugin refresh promise pattern
bundle-analyzer find cli.js "CLAUDE_CODE_SYNC_PLUGIN_INSTALL" --compact

# Part B: mcp_status handler
bundle-analyzer find cli.js "mcp_status" --compact

# s() function (headless MCP refresh)
bundle-analyzer find cli.js "Headless MCP refresh" --compact
```

## Stable anchors

- Part A: `process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` string literal
- Part B: `"mcp_status"` string literal in the control request handler
- `s()`: `"Headless MCP refresh"` log message
- `j46()`: async function that reads MCP server configs from all sources

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
