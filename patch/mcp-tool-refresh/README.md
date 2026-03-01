# Patch: mcp-tool-refresh

**MCP server enable/disable (`mcp_toggle`) does not update the model's tool list in the SDK query path.**

When a user toggles an MCP server on/off via the MCP dialog, the SDK correctly updates internal state (`state.mcp.tools`) and kills/reconnects the MCP subprocess — but the model's actual tool definitions (sent in the API request) remain frozen at query creation time. The model can still call disabled tools, and newly enabled tools are invisible until the session is disconnected and resumed.

## Affected Component

`@anthropic-ai/claude-agent-sdk` bundled `cli.js` — tested on SDK version **2.1.59**.

## Symptoms

1. **Disable an MCP server** → model still calls its tools → tool calls succeed (subprocess may already be dead → error) or the model reports the tools as available
2. **Enable an MCP server** → model does not see the new tools → only after disconnect+resume do the tools appear
3. `mcp_status` control request correctly shows the toggled state (disabled/connected) — the bug is only in the API tool list

## Architecture Overview

### Two query paths in the SDK

The SDK has two distinct code paths for running queries:

```
┌─────────────────────────────────────────────────────────────┐
│  CLI React UI Path (ink-based terminal UI)                  │
│                                                             │
│  React component creates toolUseContext with:               │
│    options.tools = h4  (initial tools)                      │
│    options.refreshTools = () => {                           │
│      let state = r.getState()  // sync Zustand store       │
│      return Zf6(state.toolPermissionContext, state.mcp.tools)│
│    }                                                        │
│                                                             │
│  → refreshTools called after each turn in iR               │
│  → tools updated live when MCP servers toggled              │
│  → ✅ WORKS                                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  SDK Query Path (sdkQuery() / kVq class)                    │
│                                                             │
│  kVq.submitMessage creates toolUseContext with:             │
│    options.tools = z  (initial tools from sdkQuery params)  │
│    options.refreshTools = undefined  ← BUG                  │
│                                                             │
│  → refreshTools check in iR skipped (undefined)             │
│  → tools frozen at query creation time                      │
│  → ❌ BROKEN                                                │
└─────────────────────────────────────────────────────────────┘
```

### The query loop (iR) and refreshTools mechanism

`iR` (`async function*iR(...)`) is the multi-turn query loop. It handles the conversation's tool-use cycle:

```
iR enters while(true) loop
  ├── Build system prompt, compact messages
  ├── Call API via oW6() with tools: w.options.tools
  ├── Process assistant response
  ├── Execute tool calls
  ├── After tool execution:
  │   ├── if (X6.options.refreshTools) {        ← CLI React path
  │   │     let s = X6.options.refreshTools()
  │   │     if (s !== X6.options.tools)
  │   │       X6 = {...X6, options: {...X6.options, tools: s}}
  │   │   }
  │   └── else → nothing (tools stay frozen)    ← SDK path (BUG)
  └── Continue to next turn with updated X6
```

Where:
- `w` = original toolUseContext parameter
- `X6` = current toolUseContext (may be updated during tool execution)
- After each turn, `X6` is wrapped into `G6` and passed to the next iteration

### How mcp_toggle updates state

When `mcp_toggle` fires (from the MCP dialog), the handler in the main message loop:

1. Persists to `~/.claude.json` via `zW6(serverName, enabled)`
2. Kills MCP subprocess via `Bk(serverName, config)` (if disabling)
3. Reconnects via `$c(serverName, config)` (if enabling)
4. Updates app state via `H(state => ...)`:
   - `state.mcp.clients` → marks client as `disabled` or replaces with new connected client
   - `state.mcp.tools` → removes tools with server prefix, or adds freshly-fetched tools
   - `state.mcp.commands` → same for commands
   - `state.mcp.resources` → same for resources

**But it does NOT update `options.tools`** on the active query's toolUseContext. The tools in `options.tools` are a snapshot taken at query creation time (in `kVq.submitMessage`).

### Why CLI React UI works but SDK doesn't

The CLI React UI component sets `refreshTools` on the toolUseContext options:

```
// CLI React path (char ~11676065 in cli.js v2.1.59)
refreshTools: () => {
  let state = r.getState()                              // sync Zustand store
  let merged = Zf6(state.toolPermissionContext, state.mcp.tools)
  let tools = $Q8(baseTools, merged, state.toolPermissionContext.mode)
  return tools
}
```

This is called synchronously after each turn in `iR`. It reads the latest MCP tools from the Zustand store (which `mcp_toggle` updates) and returns the fresh tool list.

The SDK query path (`kVq` class at char ~11182341) creates the toolUseContext without `refreshTools`:

```
// SDK path (char ~11183500 in cli.js v2.1.59)
$6 = {
  options: {
    tools: z,               // frozen at sdkQuery() creation time
    // refreshTools: ???     // NOT SET!
    ...
  },
  getAppState: W,
  setAppState: G,
  ...
}
```

## The Fix (Two Parts)

The fix requires two patches because tools are frozen at two levels:

1. **Between messages** — `w6` (the tools list) is built once at session start and passed to every `EVq` call
2. **Between turns within a message** — `iR`'s `refreshTools` check only fires for the CLI React path

### Part A: Refresh tools before each EVq call

In the main message loop, `w6` is computed once:
```js
let w6 = hZ([...Y, ...e, ...p, ...x.tools], "name")  // ONCE at session start
```

Then for each user message, EVq is called with `tools: w6` (frozen). We inject a refresh
right before the `for await(... of EVq({` call.

#### Before

```js
// In the main message loop (char ~11213100 in cli.js v2.1.59):
W = rK();
let v6 = void 0, _6 = {};
for await (let C6 of EVq({ commands: q6, prompt: I6, ..., tools: w6, ... }))
```

#### After

```js
W = rK();
let v6 = void 0, _6 = {};
/*PATCHED:mcp-tool-refresh-A*/ {
  let _st = await $();  // $ = getAppState in this scope
  if (_st && _st.mcp && _st.mcp.tools) {
    let _base = w6.filter(function(_t) { return !_t.isMcp; });
    let _merged = [..._base, ..._st.mcp.tools];
    let _seen = new Set();
    w6 = _merged.filter(function(_t) {
      if (_seen.has(_t.name)) return false;
      _seen.add(_t.name); return true;
    });
  }
}
for await (let C6 of EVq({ commands: q6, prompt: I6, ..., tools: w6, ... }))
```

### Part B: iR refreshTools fallback

Even after Part A refreshes tools for each new message, multi-turn tool-use cycles
within a single message still use frozen tools. The `refreshTools` check in `iR` only
fires when the CLI React UI sets the callback.

#### Before

```js
// In iR, after tool execution (char ~9187131 in cli.js v2.1.59):
if (X6.options.refreshTools) {
  let s = X6.options.refreshTools();
  if (s !== X6.options.tools) {
    X6 = { ...X6, options: { ...X6.options, tools: s } };
  }
}
```

#### After

```js
if (X6.options.refreshTools) {
  let s = X6.options.refreshTools();
  if (s !== X6.options.tools) {
    X6 = { ...X6, options: { ...X6.options, tools: s } };
  }
} else /*PATCHED:mcp-tool-refresh-B*/ {
  let _st = await X6.getAppState();
  if (_st && _st.mcp && _st.mcp.tools) {
    let _base = X6.options.tools.filter(function(_t) { return !_t.isMcp; });
    let _merged = [..._base, ..._st.mcp.tools];
    let _seen = new Set();
    let _deduped = _merged.filter(function(_t) {
      if (_seen.has(_t.name)) return false;
      _seen.add(_t.name); return true;
    });
    if (_deduped.length !== X6.options.tools.length
      || _deduped.some(function(_t, _i) {
           return _t.name !== (X6.options.tools[_i] || {}).name;
         }))
      X6 = { ...X6, options: { ...X6.options, tools: _deduped } };
  }
}
```

### Why this is safe

1. **`await` is valid**: Part A is in an `async` closure (the main message loop handler). Part B is in `async function*iR(...)`. Both support `await`.
2. **No performance concern**: `getAppState()` is already called frequently in the same code paths. One more call per turn is negligible.
3. **Only affects SDK path**: Part A targets the single `EVq` call site (SDK/headless mode only). Part B's `else` branch only fires when `refreshTools` is NOT set (SDK path). The CLI React path continues to use its own `refreshTools` mechanism.
4. **`isMcp` is a stable property**: MCP tool objects have `isMcp: true` set at creation time (char ~5706959). It's used in 66+ places in the bundle. Non-MCP tools always have `isMcp` falsy.
5. **Deduplication matches SDK semantics**: The `hZ([...], "name")` function used throughout the SDK deduplicates by keeping the first occurrence of each name. Our `Set`-based filter does the same thing.
6. **`w6` is `let`**: Reassignment in Part A is valid (not `const`).
7. **`w6` scope**: `w6` is declared in the outer closure and referenced by the `EVq` call. Updating it before the call means the new tool list is used for that message.

## How to Find This Code in a New SDK Version

### Finding the refreshTools check (patch target)

```bash
# Primary: search for refreshTools string literal
bundle-analyzer find cli.js "refreshTools" --compact

# The refreshTools check is in iR (async function*iR({...}))
# Nearby strings (within ±2000 chars):
#   "query_recursive_call"
#   "max_turns_reached"
#   "query_tool_execution_start"
#   "query_api_loop_start"
#   "tengu_query_after_attachments"
```

### Finding kVq (where the bug is — no refreshTools set)

```bash
# The SDK query class — search for its unique constructor shape
bundle-analyzer find cli.js "isNonInteractiveSession:!0,customSystemPrompt" --compact

# Or search for the class by its submitMessage method
bundle-analyzer find cli.js "querySource:\"sdk\",maxTurns" --compact
```

### Finding the React UI refreshTools (reference implementation)

```bash
# The React path sets refreshTools in a useCallback
bundle-analyzer find cli.js "refreshTools:()=>" --compact

# Nearby strings:
#   "tengu_streaming_idle_timeout"   (not this one)
#   Tools builder uses Zf6() and $Q8() functions
bundle-analyzer find cli.js "Zf6(" --compact
```

### Finding mcp_toggle handler (what updates state.mcp.tools)

```bash
bundle-analyzer find cli.js "mcp_toggle" --compact

# The handler updates state.mcp via setAppState:
#   state.mcp.tools  → mT() removes tools by prefix
#   state.mcp.clients → marks as disabled or replaces with new client
```

### Verifying isMcp property on MCP tools

```bash
bundle-analyzer find cli.js "isMcp" --compact --limit 5
# Should show 60+ matches — this is a stable, widely-used property
```

## Key Functions Reference

| Minified Name (v2.1.59) | Purpose | Char Offset |
|---|---|---|
| `iR` | Multi-turn query loop (`async function*`). Contains the refreshTools check. | 9178311 |
| `gAq` | Parent function containing iR's scope. Handles query setup/teardown. | 9069002 |
| `oW6` | Streaming query wrapper — calls `D0q` which sends API request with `tools: w.options.tools` | 9369874 |
| `D0q` | Builds API request params, filters tools by schema. Takes `Y` (4th param) as tools. | 10371473 |
| `kVq` | SDK query class. `submitMessage()` creates toolUseContext without `refreshTools`. | 11182341 |
| `EVq` | SDK query entry — creates `kVq` and calls `submitMessage()`. Called from main message loop. | 11192358 |
| `lR` | Agent loop. Builds tool list via `hZ([...resolvedTools, ...mcpTools], "name")` — called once per user message from REPL. | 8377192 |
| `hZ` | Deduplicate array by key (`name`). Equivalent to lodash `uniqBy`. | (utility) |
| `Zf6` | Merges base tools with MCP tools: `hZ([...sM(ctx), ...AT6(mcpTools, ctx)], "name")` | 9141108 |
| `SuY` | Loads agent-specific MCP server tools from agent definitions. | 8376040 |
| `hc` | Resolves tool list from agent definition, filtering by allowed/disallowed tools. | 5987322 |
| `mT` | Lodash `reject()` — removes items matching predicate. Used by mcp_toggle to strip tools. | (utility) |
| `Bk` | Kills MCP subprocess: `client.cleanup()` + clears connection cache. | 5683031 |
| `$c` | Reconnects MCP server: creates new client, fetches fresh tools/commands/resources. | (utility) |
| `zW6` | Persists MCP disabled state to `~/.claude.json` (`disabledMcpServers` list). | 5615556 |
| `TR` | Checks if server is disabled: `disabledMcpServers.includes(name)`. | 5615493 |

## Data Flow: mcp_toggle → tool list update

### Before patch (broken)

```
User clicks "Disable" in MCP dialog
  → window.api.mcpToggleServer(routingId, name, false)
  → ClaudeSession.mcpToggleServer()
  → query.toggleMcpServer(name, false)           [control request to subprocess]
  → mcp_toggle handler in main message loop
    → zW6(name, false)                            [persist to ~/.claude.json]
    → Bk(name, config)                            [kill MCP subprocess]
    → H(state => {                                [update app state]
        mcp.clients: mark as disabled
        mcp.tools:   remove matching tools        ← STATE UPDATED ✅
      })
  → response sent back

User sends next message
  → Main message loop: `for await(... of EVq({ tools: w6 }))`
  → w6 was built ONCE at session start             ← FROZEN ❌
  → EVq creates kVq with tools: w6
  → kVq.submitMessage creates $6 with tools: z (= w6)
  → iR while loop starts
  → oW6({ tools: w.options.tools })               ← STILL OLD TOOLS ❌
  → Model sees disabled MCP tools, can call them
  → If model responds without tool use → iR exits
  → refreshTools check never reached!              ← NEVER FIRES ❌
```

### After patch (fixed)

```
User clicks "Disable" in MCP dialog
  → ... same as above, state.mcp.tools updated ...

User sends next message
  → Main message loop reaches EVq call
  → Part A fires: await $() reads current state
    → w6 rebuilt: base tools + current MCP tools   ← FRESH TOOLS ✅
  → EVq({ tools: w6 }) gets updated tools
  → kVq.submitMessage creates $6 with tools: z (= refreshed w6)
  → iR while loop starts
  → oW6({ tools: w.options.tools })               ← UPDATED TOOLS ✅
  → Model no longer sees disabled MCP tools

If model makes tool calls (multi-turn):
  → Tool execution completes
  → Part B fires: await X6.getAppState()
    → Rebuilds tool list from current MCP state    ← ALSO FRESH ✅
  → Next API turn uses updated tools
```

## MCP Lifecycle Control Requests

For context, here are all MCP-related control request subtypes handled in the main message loop:

| Subtype | Purpose | Handler char offset (v2.1.59) |
|---|---|---|
| `mcp_status` | Returns list of MCP servers with status, tools, config | 11219037 |
| `mcp_toggle` | Enable/disable an MCP server (kills subprocess on disable) | 11221287 |
| `mcp_authenticate` | Initiates OAuth flow for SSE/HTTP MCP servers | (after mcp_toggle) |
| `mcp_reconnect` | Reconnects a failed or disconnected MCP server | (after mcp_authenticate) |
| `mcp_set_servers` | Adds new MCP servers from config (used by Add Server form) | (after mcp_reconnect) |

## Discovery Method

### Step 1: Observed the symptom

In ClaudeUI, disabling an MCP server via the dialog did not remove its tools from the model's view. The model could still call disabled tools. Enabling a server didn't make its tools visible until disconnect/resume.

Console logs confirmed: `mcp_status` correctly returned `status: 'disabled', tools: 0` — but the model's API calls still included the old tools.

### Step 2: Compared CLI vs SDK behavior

Tested the same toggle in CLI mode (using `/mcp` command). In CLI, enable worked immediately (model saw new tools). Disable also worked (model couldn't call tools). This pointed to a difference between the CLI React UI and the SDK query path.

### Step 3: Traced the API call tool list

Found where tools are passed to the API at char 9180562:
```js
for await(let o of oW6({...tools:w.options.tools...}))
```
This reads from `w.options.tools` — the toolUseContext's options.

### Step 4: Found refreshTools mechanism

Searched for `refreshTools` and found it's checked at char 9187131 in `iR` after each turn. The CLI React UI sets this callback; the SDK path does not.

### Step 5: Confirmed the root cause

Traced `kVq.submitMessage` (the SDK query entry) — it creates `$6` (toolUseContext) with `tools: z` but never sets `refreshTools`. The React UI path at char 11676065 does set it, using `r.getState()` (sync Zustand store) to read live MCP tools.

### Step 6: First fix attempt (Part B only — insufficient)

Patched the `refreshTools` check in `iR` with an `else` branch. This reads from `getAppState()` and rebuilds the tool list. However, this only fires AFTER tool execution — if the model responds with text only (no tool calls), `iR` exits its while loop before reaching the refreshTools check. Tools remain frozen for that message.

### Step 7: Root cause at the main message loop level (Part A)

Traced `w6` (the tools variable) to the main message loop where it's computed ONCE at session start:
```js
let w6 = hZ([...Y, ...e, ...p, ...x.tools], "name")  // char ~11210884
```
Then passed to every `EVq` call as `tools: w6`. Even Part B can't fix this because `EVq` → `kVq.submitMessage` recreates the toolUseContext with `tools: z` (= the original `w6`).

Added Part A: inject tool refresh code right before the `for await(... of EVq({` call. This reads current MCP tools from `await $()` (getAppState) and rebuilds `w6` by filtering out old MCP tools and merging with the current ones.

## Verification

1. Apply the patch: `node patch/mcp-tool-refresh/apply.mjs`
2. Run `bun run dev` to start ClaudeUI
3. Start a session with at least one MCP server connected
4. Verify the model can see and call MCP tools
5. Open MCP dialog → Disable the server
6. Send a message asking the model what tools it has → disabled tools should NOT appear
7. Open MCP dialog → Enable the server
8. Send a message → enabled tools should appear without disconnect/resume

## Related Patches

- **mcp-status**: Fixes `mcp_status` returning empty servers (ensures MCP state is loaded before status query). This patch complements mcp-status by ensuring the tool list is also refreshed.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script |
