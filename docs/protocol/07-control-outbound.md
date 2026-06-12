# 07 — Control requests (outbound: us → cli.js)

Every `control_request` subtype cli.js accepts from us, grouped by category. Each entry: request fields, response shape, cli.js-side side effects, timing, code anchor.

Verified against cli.js 2.1.114. Main dispatcher at char `~12843876`. Unknown-subtype fallback at `~12860550` emits `"Unsupported control request subtype: <name>"` as an error response and keeps the message loop alive.

---

## 7.1 Envelope

```json
{
  "type": "control_request",
  "request_id": "<13-char random>",
  "request": {
    "subtype": "<name>",
    ...fields
  }
}
```

Response envelope (success):

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<echoed>",
    "response": { ...subtype-specific shape }
  }
}
```

Error:

```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "<echoed>",
    "error": "<message>",
    "pending_permission_requests": [...]?  // only on "Already initialized" (see 09-initialize.md)
  }
}
```

---

## 7.2 Two dispatchers, a bridge, and a gotcha

cli.js has **three** dispatchers. Most subtypes only work on the main one.

| Dispatcher                | Anchor      | Handles                                                                                                                                                                                                                                |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main (stdio message loop) | `~12843876` | 30+ subtypes — the canonical list below                                                                                                                                                                                                |
| REPL bridge (`Pl_`)       | `~11352269` | **Remote-control peer traffic only.** `initialize`, `set_model`, `set_max_thinking_tokens`, `set_permission_mode`, `rename_session`, `file_suggestions`, `interrupt`. Everything else is rejected with "REPL session only supports..." |
| RemoteSessionManager      | `~11747217` | WebSocket bridge side (cli.js hosting remote control peers). Only `can_use_tool` forwarding.                                                                                                                                           |

**Gotcha**: `file_suggestions` and `rename_session` have Zod schemas in the canonical `kc1` union but are ONLY handled in the REPL bridge dispatcher. Sending them on the main stdio channel returns `"Unsupported control request subtype"`. If we want them on stdio, we need an upstream fix or a patch.

---

## 7.3 Session control subtypes

### `initialize`

See `09-initialize.md` for full details. One-shot handshake, sent exactly once per session.

---

### `interrupt`

Abort the current turn. Instant.

**Anchor:** `~12843876`. Schema `tQ1`.

**Request:**

```json
{ "subtype": "interrupt" }
```

**Response (success):** empty `{}`.

**Side effects:**

- Aborts the turn abort-controller (`k.abort()`).
- Aborts the input abort-controller (`y.abortController?.abort()`).
- Clears `y.lastEmitted`, `y.pendingSuggestion`.

**Timing:** instant. Any in-flight API call and tool execution are cancelled.

**QueryHandle:** `q.interrupt()`.

---

### `end_session`

Graceful shutdown — cli.js flushes output, breaks the main read loop, exits.

**Anchor:** `~12843970`. **No Zod schema** — shape is unvalidated.

**Request:**

```json
{
  "subtype": "end_session",
  "reason": "..." // optional; logged; defaults to "unspecified"
}
```

**Response (success):** empty `{}`.

**Side effects:**

- Logs `[print.ts] end_session received, reason=<reason>`.
- Aborts current turn (same as `interrupt`).
- Calls `oH(mH)` — sends success.
- **Breaks out of the message loop.** Subprocess exits shortly after.

**Timing:** fast; then subprocess exits.

**QueryHandle:** `q.endSession()` (timeout 5 s).

**Warning:** Use this for graceful shutdown. SIGTERM is cruder. Never call this twice — the second call races with subprocess exit.

---

### `set_permission_mode`

**Anchor:** `~12844680`. Schema `Hc1`.

**Request:**

```json
{
  "subtype": "set_permission_mode",
  "mode": "default"|"acceptEdits"|"plan"|"bypassPermissions",
  "ultraplan": false                // optional, @internal CCR ultraplan marker
}
```

**Response (success):** empty (no explicit `oH` call — success implied by absence of error).

**Side effects:**

- Updates `toolPermissionContext` in app state via `ks1(req, request_id, prev, h)`.
- Optionally flips `isUltraplanMode`.

**Timing:** instant (synchronous state mutation).

**QueryHandle:** `q.setPermissionMode(mode)`.

**Note:** `"ask"` is a legacy mode name — cli.js may accept it but `"default"` is preferred.

---

### `set_model`

**Anchor:** `~12844820`. Schema `$c1`.

**Request:**

```json
{
  "subtype": "set_model",
  "model": "claude-opus-4-7" | "default" | ...
}
```

**Response (success):** empty `{}`.

**Side effects:**

- Resolves `"default"` → user default via `UW()`.
- Mutates active model `i`.
- Persists via `l2(model)`.
- Emits `sessionState.notifyMetadataChanged({model})` and `HH(old, new)`.

**Timing:** instant.

**QueryHandle:** `q.setModel(model)`.

---

### `set_max_thinking_tokens`

**Anchor:** `~12844910`. Schema `qc1`.

**Request:**

```json
{
  "subtype": "set_max_thinking_tokens",
  "max_thinking_tokens": 24000 // or null to clear
}
```

**Response (success):** empty `{}`.

**Side effects:** Computes new thinking config via `y17(max_thinking_tokens, default)`, assigns to `fH`.

**Timing:** instant.

**QueryHandle:** `q.setMaxThinkingTokens(n | null)`.

---

### `apply_flag_settings`

Merge arbitrary settings into the `flagSettings` layer. `null` values delete keys.

**Anchor:** `~12853700`. Schema `Zc1`.

**Request:**

```json
{
  "subtype": "apply_flag_settings",
  "settings": {
    "model": "claude-sonnet-4-6",
    "effort": "high",
    "theme": null // null deletes
  }
}
```

**Response (success):** empty `{}`.

**Side effects:**

- Merges `{...prev, ...settings}`, deletes null-valued keys.
- Persists via `O76(merged)`.
- `model` key special-cased — updates `l2()`.
- Notifies `LE.notifyChange('flagSettings')`.

**Timing:** fast (disk write).

**QueryHandle:** `q.applyFlagSettings(obj)`.

---

### `get_settings`

Full settings dump — effective + per-source + applied + errors.

**Anchor:** `~12854100`. Schema `Gc1`. Response schema `N3Y`.

**Request:**

```json
{ "subtype": "get_settings" }
```

**Response (success):**

```json
{
  "effective": { /* merged settings */ },
  "sources": [
    { "source": "userSettings",    "settings": {...} },
    { "source": "projectSettings", "settings": {...} },
    { "source": "localSettings",   "settings": {...} },
    { "source": "flagSettings",    "settings": {...} },
    { "source": "policySettings",  "settings": {...} }
  ],
  "applied": {
    "model": "claude-sonnet-4-6",
    "effort": "high" | null
  },
  "errors": [                                  // optional, only when some file failed to parse
    { "file": "...", "path": "...", "message": "..." }
  ]
}
```

**Timing:** instant (all in-memory).

**QueryHandle:** `q.getSettings()`.

---

### `get_context_usage`

Full context-window breakdown. Slow (CPU-bound token counting).

**Anchor:** `~12845190`. Schema `Ac1`. Response schema `G3Y`.

**Request:**

```json
{ "subtype": "get_context_usage" }
```

**Response (success):** `G3Y` shape (exact fields at cli.js char `~11912470`):

```jsonc
{
  "categories": [...],              // per-category token counts
  "totalTokens": 123456,
  "maxTokens": 200000,
  "rawMaxTokens": 210000,
  "percentage": 61.7,
  "gridRows": [...],                // UI display rows
  "model": "claude-opus-4-7",
  "memoryFiles": [...],             // CLAUDE.md + other memory
  "mcpTools": [...],
  "deferredBuiltinTools": [...],
  "systemTools": [...],
  "systemPromptSections": [...],
  "agents": [...],
  "slashCommands": [...],
  "skills": [...],
  "autoCompactThreshold": 0.92,
  "isAutoCompactEnabled": true,
  "messageBreakdown": [...],
  "apiUsage": {...}
}
```

**Timing:** 50–300ms (CPU-bound).

**QueryHandle:** `q.getContextUsage()`.

---

### `rewind_files`

Rewind files to their state at a given user message, or preview the diff.

**Anchor:** `~12845420`. Schema `Yc1`. Response schema `T3Y`.

**Request:**

```json
{
  "subtype": "rewind_files",
  "user_message_id": "<uuid>",
  "dry_run": false // optional; default false
}
```

**Response (success):**

```json
{
  "canRewind": true,
  "error": "...", // only when canRewind=false
  "filesChanged": ["src/foo.ts", "src/bar.ts"],
  "insertions": 42,
  "deletions": 12
}
```

Dry run always responds with the diff. Real run responds with error if `canRewind=false`.

**Side effects (real run):** Files on disk are reverted.

**Timing:** slow for large diffs.

**QueryHandle:** `q.rewindFiles(userMessageId, { dryRun })`.

---

### `cancel_async_message`

Remove a queued message before it's consumed.

**Anchor:** `~12845570`. Schema `Oc1`. Response schema `v3Y`.

**Request:**

```json
{
  "subtype": "cancel_async_message",
  "message_uuid": "<uuid>"
}
```

**Response (success):**

```json
{ "cancelled": true } // false if already dequeued for execution
```

**Side effects:** Removes from command queue via `tNH(item => item.uuid === uuid)`.

**Timing:** instant.

**QueryHandle:** `q.cancelAsyncMessage(uuid)`.

---

### `seed_read_state`

Pre-populate cli.js's Read-tool cache so a subsequent Edit can pass validation without re-Reading.

**Anchor:** `~12845660`. Schema `wc1`.

**Request:**

```json
{
  "subtype": "seed_read_state",
  "path": "/abs/path/to/file",
  "mtime": 1712345678901 // ms since epoch
}
```

**Response (success):** empty `{}`.

**Side effects:** If `mtime(file) <= request.mtime`, loads file content (BOM strip + CRLF normalize) into `g` (readFileState cache). All errors swallowed.

**Timing:** fast.

**QueryHandle:** `q.seedReadState(path, mtime)`.

---

### `stop_task`

Kill a running task by ID.

**Anchor:** `~12854720`. Schema `Jc1`.

**Request:**

```json
{
  "subtype": "stop_task",
  "task_id": "<id>"
}
```

**Response (success):** empty `{}`.

**Side effects:** Calls `yi8(task_id, ...)`:

- `local_bash` task → SIGTERM the shell process.
- `local_agent` task → resolve its stop-signal Promise.

**Timing:** fast.

**QueryHandle:** `q.stopTask(taskId)`.

---

### `generate_session_title`

Generate a session title from a description, optionally persist it.

**Anchor:** `~12854900`. **No Zod schema.** Async IIFE.

**Request:**

```json
{
  "subtype": "generate_session_title",
  "description": "what the session is about",
  "persist": true // when true, writes to session file + sets custom-title flag
}
```

**Response (success):**

```json
{ "title": "Fix the payment flow" } // may be null on soft failure
```

**Side effects:**

- Persists via `A86(sessionId, title)` when `persist:true`.
- Sets `w8 = true` (custom-title flag — suppresses auto-generation).

**Timing:** slow (LLM call, 1–3 s).

**QueryHandle:** `q.generateSessionTitle(description, { persist })`.

---

### `side_question`

Ask a side question that doesn't modify session history and can't use tools.

**Anchor:** `~12855319`. **No Zod schema.** Async IIFE.

**Request:**

```json
{
  "subtype": "side_question",
  "question": "..."
}
```

**Response (success):**

```json
{
  "response": "...",
  "synthetic": false // true if fabricated without a model call
}
```

**Timing:** slow (LLM call).

**QueryHandle:** `q.askSideQuestion(question)` (returns `response.response`, the answer text — `null` when cli.js produces no usable answer).

---

### `ultrareview_launch`

Launch the ultrareview slash command programmatically.

**Anchor:** `~12855922`. **No Zod schema.** Async IIFE.

**Request:**

```json
{
  "subtype": "ultrareview_launch",
  "args": "", // optional; defaults to ""
  "confirm": false // optional; defaults to false
}
```

**Response (success):** result shape varies by review flow.

**Timing:** long (launches a full review turn).

**QueryHandle:** `q.launchUltrareview(args, { confirm })`.

---

### `remote_control`

Enable/disable remote-control bridging (peer-to-peer mirror).

**Anchor:** `~12856154`. **No Zod schema.**

**Request (enable):**

```json
{
  "subtype": "remote_control",
  "enabled": true,
  "name": "my-session" // optional — session name, ignored if already active
}
```

**Response (success, enable):**

```json
{
  "session_url": "...",
  "connect_url": "...",
  "environment_id": "..."
}
```

**Request (disable):**

```json
{ "subtype": "remote_control", "enabled": false }
```

**Response:** empty `{}`.

**Side effects:**

- On enable: wires `setOnControlRequestSent` + `setOnControlRequestResolved` so `can_use_tool` prompts mirror to peers.
- On state change: emits `system/bridge_state` message.

**Timing:** slow on enable (bridge handshake, cloud endpoint registration).

**Gate:** `allow_remote_control` policy must permit it (`Xx1` gate at `~11371936`).

**QueryHandle:** `q.enableRemoteControl(enabled, { name })`.

---

### `dequeue_message` (patched)

Remove a queued command by text match. Added by `patch/queue-control/`.

**Anchor:** `~12857658`. **No Zod schema** (patch-injected).

**Request:**

```json
{
  "subtype": "dequeue_message",
  "value": "the text content" // after m$4() attachment extraction
}
```

**Response (success):**

```json
{ "removed": 2 } // count of matching queue entries removed
```

**Timing:** instant.

**QueryHandle:** `q.dequeueMessage(value)`.

---

### `background_task` (patched)

Convert a running foreground task to background. Added by `patch/background-task/`.

**Anchor:** `~12857897`. **No Zod schema** (patch-injected).

**Request:**

```json
{
  "subtype": "background_task",
  "tool_use_id": "toolu_xxx"
}
```

**Response (success):**

```json
{
  "task_id": "<id>",
  "tool_use_id": "toolu_xxx"
}
```

**Errors:**

- `"No task found with toolUseId: <id>"`
- `"Task <id> is not running"`
- `"Task <id> is already backgrounded"`
- `"Failed to background bash task <id>"`
- `"Unsupported task type for backgrounding"`

**Side effects:**

- Local bash: `shellCommand.background(taskId)` — spills stdout to disk, flips `isBackgrounded:true`.
- Local agent: flips `isBackgrounded:true`, resolves `VuH.get(taskId)` stop-signal.

**Timing:** instant.

**QueryHandle:** `q.backgroundTask(toolUseId)`.

---

### `get_usage` (patched)

Expose cli.js's internal `/api/oauth/usage` API. Added by `patch/usage-relay/`.

**Anchor:** `~12859013`. **No Zod schema** (patch-injected).

**Request:**

```json
{ "subtype": "get_usage" }
```

**Response (success):** raw `/api/oauth/usage` body:

```json
{
  "five_hour": {...},
  "seven_day": {...},
  "seven_day_sonnet": {...},
  "extra": {...}                    // optional
}
```

Empty `{}` when the user isn't OAuth-authenticated.

**Timing:** slow (HTTPS, 5 s timeout inside patch).

**QueryHandle:** `q.getUsage()`.

---

### `voice_server_start` (patched)

Start the internal voice-transcription TCP server. Added by `patch/voice-server/`.

**Anchor:** `~12859247`. **No Zod schema**.

**Request:**

```json
{ "subtype": "voice_server_start" }
```

**Response (success):**

```json
{ "port": 54321 } // 127.0.0.1:<port>, random port. Idempotent.
```

**Protocol (TCP):** newline-delimited JSON. Client sends `{"type":"voice_start","language":"en"}`, `{"type":"audio","data":"<base64 PCM>"}`, `{"type":"voice_stop"}`. Server pushes `{"type":"ready"}`, `{"type":"transcript","text","isFinal"}`, `{"type":"error","message"}`, `{"type":"closed"}`.

**Timing:** fast to bind.

**QueryHandle:** `q.voiceServerStart()`.

---

### `voice_server_stop` (patched)

**Anchor:** `~12860400`. Added by `patch/voice-server/`.

**Request:**

```json
{ "subtype": "voice_server_stop" }
```

**Response (success):**

```json
{ "stopped": true }
```

**QueryHandle:** `q.voiceServerStop()`.

---

## 7.4 MCP subtypes

### `mcp_status`

List all MCP servers with status. **Patched** to await in-flight reconnects.

**Anchor:** `~12845000`. Schema `_c1`. Response schema `J3Y`.

**Request:**

```json
{ "subtype": "mcp_status" }
```

**Response (success):**

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "status": "connected"|"pending"|"failed"|"disabled"|"needs-auth",
      "tools": [...],
      "commands": [...],
      "resources": [...],
      "error": "..."                 // when status=failed
    }
  ]
}
```

**Timing:** slow — awaits `D8()` refresh and patched `ZH` promise. Multi-second under heavy MCP contention.

**QueryHandle:** `q.mcpServerStatus()`.

---

### `mcp_toggle`

Enable/disable an MCP server. **Does** propagate to the model's tool list (patched via `patch/mcp-tool-refresh/`).

**Anchor:** `~12848500`. Schema `Lc1`.

**Request:**

```json
{
  "subtype": "mcp_toggle",
  "serverName": "filesystem",
  "enabled": true
}
```

**Response (success):** empty `{}`.

**Errors:** `"Server not found: <name>"`, connection failure string on enable.

**Side effects:**

- Persists via `MIH(name, enabled)`.
- Disable: marks `{type:"disabled", config}`, removes tools/commands/resources from app state.
- Enable: `DF(name, config)` connect + merge.

**Timing:** slow (enable = MCP handshake).

**QueryHandle:** `q.toggleMcpServer(name, enabled)`.

---

### `mcp_reconnect`

**Anchor:** `~12846950`. Schema `Xc1`.

**Request:**

```json
{
  "subtype": "mcp_reconnect",
  "serverName": "filesystem"
}
```

**Response (success):** empty `{}`.

**Errors:** `"Server not found: <name>"`, connection error.

**Timing:** slow.

**QueryHandle:** `q.reconnectMcpServer(name)`.

---

### `mcp_set_servers`

Replace the entire dynamic MCP server set.

**Anchor:** `~12845880`. Schema `Pc1`. Response schema `V3Y`.

**Request:**

```json
{
  "subtype": "mcp_set_servers",
  "servers": {
    "foo": { "type": "stdio", "command": "npx", "args": [...] },
    "bar": { "type": "http", "url": "..." }
  },
  "sdkMcpServers": ["claude-ui"]    // NAMES only — our harness appends this
}
```

**Response (success):**

```json
{
  "added": ["foo"],
  "removed": ["old-server"],
  "errors": { "bar": "connection refused" }
}
```

**Timing:** slow (spawn/kill subprocesses).

**QueryHandle:** `q.setMcpServers(map)`.

---

### `channel_enable`

Subscribe to a plugin-sourced MCP channel. cli.js forwards `notifications/claude/channel` into the command queue as injected prompts.

**Anchor:** call at `~12850046`, handler `Ns1` at `12868063`.

**Request:**

```json
{
  "subtype": "channel_enable",
  "serverName": "<plugin-sourced server>"
}
```

**Response (success):** empty `{}`.

**Errors:**

- `"server <name> is not connected"`
- `"server <name> is not plugin-sourced; channel_enable requires a marketplace plugin"`
- Reason from `i48(...)` when server lacks notification capabilities.

**Timing:** fast.

**QueryHandle:** `q.enableChannel(serverName)`.

---

### `mcp_authenticate`

Start an MCP OAuth flow. Long-lived — resolves once the URL is known, but the full flow spans multiple control requests.

**Anchor:** `~12849940`. **No Zod schema.**

**Request:**

```json
{
  "subtype": "mcp_authenticate",
  "serverName": "<sse or http server>"
}
```

**Response (success):**

```json
{ "authUrl": "https://...", "requiresUserAction": true }
```

OR (auto-completed via existing session):

```json
{ "requiresUserAction": false }
```

**Errors:** `"Server not found"`, `Server type "<type>" does not support OAuth authentication`.

**Timing:** response is fast, but flow lives on until `mcp_oauth_callback_url`.

**QueryHandle:** `q.mcpAuthenticate(serverName)` (timeout disabled).

**Gate:** only `sse` and `http` server types.

---

### `mcp_oauth_callback_url`

Submit OAuth callback URL back to cli.js. Completes a pending `mcp_authenticate`.

**Anchor:** `~12851477`.

**Request:**

```json
{
  "subtype": "mcp_oauth_callback_url",
  "serverName": "...",
  "callbackUrl": "https://.../cb?code=xyz"
}
```

**Response (success):** empty `{}`.

**Errors:** `"Invalid callback URL: missing authorization code..."`, `"No active OAuth flow for server: <name>"`.

**Timing:** slow (completes token exchange + reconnect).

**QueryHandle:** `q.mcpSubmitOAuthCallbackUrl(serverName, callbackUrl)`.

---

### `mcp_clear_auth`

Clear stored OAuth credentials for an MCP server; reconnects unauthenticated.

**Anchor:** `~12853376`. **No Zod schema.**

**Request:**

```json
{
  "subtype": "mcp_clear_auth",
  "serverName": "..."
}
```

**Response (success):** empty `{}`.

**Errors:** `"Server not found"`, `Cannot clear auth for server type "<type>"`.

**Timing:** slow (reconnect).

**QueryHandle:** `q.mcpClearAuth(serverName)`.

---

### `reload_plugins`

Reload plugins + commands + agents + MCP from disk.

**Anchor:** `~12846070`. Schema `Wc1`. Response schema `k3Y`.

**Request:**

```json
{ "subtype": "reload_plugins" }
```

**Response (success):**

```json
{
  "commands": [...],                 // shape matches initialize.commands
  "agents":   [...],                 // matches initialize.agents
  "plugins":  [...],                 // NOT in initialize response — only here
  "mcpServers": [...],
  "error_count": 0
}
```

**Timing:** slow (disk walk + MCP reconnect). Multi-second under load.

**QueryHandle:** `q.reloadPlugins()`.

**Note:** This is the ONLY source of `plugins` (and the authoritative refresh source for `skills` which aren't in initialize response either).

---

## 7.5 Claude OAuth subtypes

All three are long-lived (user-driven). Always pass `timeoutMs: 0` to disable the 30 s default.

### `claude_authenticate`

**Anchor:** `~12851790`. **No Zod schema.**

**Request:**

```json
{
  "subtype": "claude_authenticate",
  "loginWithClaudeAi": true // optional, default true
}
```

**Response (success):**

```json
{
  "manualUrl": "https://...",
  "automaticUrl": "https://..."
}
```

**Errors:** OAuth flow exceptions wrapped via `uH()`.

**Side effects:** Creates `Nt` OAuth service, stores flow in `d8` global. Concurrent calls replace the previous flow (cleanup).

**Timing:** fast to produce URLs.

**QueryHandle:** `q.claudeAuthenticate(loginWithClaudeAi)`.

---

### `claude_oauth_callback`

**Anchor:** `~12852869`.

**Request:**

```json
{
  "subtype": "claude_oauth_callback",
  "authorizationCode": "<code>",
  "state": "<state>"
}
```

**Response (success):**

```json
{
  "account": {
    "email": "...",
    "organization": "...",
    "subscriptionType": "...",
    "tokenSource": "...",
    "apiKeySource": "...",
    "apiProvider": "firstParty"|"bedrock"|"vertex"|"foundry"|"anthropicAws"|"mantle"
  }
}
```

**Errors:** `"No active claude_authenticate flow"`, OAuth flow exception.

**Timing:** slow (token exchange).

**QueryHandle:** `q.claudeOAuthCallback(code, state)`.

---

### `claude_oauth_wait_for_completion`

Wait for browser-based OAuth flow to auto-complete via local loopback. No code required.

**Anchor:** `~12852984`.

**Request:**

```json
{ "subtype": "claude_oauth_wait_for_completion" }
```

**Response:** same as `claude_oauth_callback`.

**Timing:** long (awaits user in browser).

**QueryHandle:** `q.claudeOAuthWaitForCompletion()`.

---

## 7.6 Other

### `rename_session` (REPL bridge only)

**Anchor:** REPL dispatcher `Pl_` at `~11352269`. Schema `Kc1`.

Only works on the REPL bridge. Sending to the main dispatcher → `"Unsupported control request subtype"`.

**Request:**

```json
{
  "subtype": "rename_session",
  "title": "New session title"
}
```

Our harness does NOT expose this — it's not usable on the main stdio channel without an upstream fix.

---

### `file_suggestions` (REPL bridge only)

**Anchor:** REPL dispatcher. Schema `fc1`.

Same caveat as `rename_session` — not usable on stdio.

---

## 7.7 Unknown subtypes — behavior

Any subtype not matched by the else-if chain → error response:

```json
{
  "subtype": "error",
  "request_id": "<echoed>",
  "error": "Unsupported control request subtype: <subtype>"
}
```

The message loop continues. Unknown subtypes never terminate the session.

---

## 7.8 Stall detection

cli.js arms a 5-minute (`Fc1 = 300000` ms) timer per non-result message. If fired while in `"running"` state, emits telemetry `tengu_sdk_stall` with:

- last message type
- `pending_control_requests` count

**No automatic recovery.** The host is expected to observe and intervene.

---

## 7.9 QueryHandle → subtype quick reference

| Method                                      | Subtype                               |
| ------------------------------------------- | ------------------------------------- |
| `interrupt()`                               | `interrupt`                           |
| `endSession()`                              | `end_session`                         |
| `setPermissionMode(mode)`                   | `set_permission_mode`                 |
| `setModel(model?)`                          | `set_model`                           |
| `setMaxThinkingTokens(n\|null)`             | `set_max_thinking_tokens`             |
| `applyFlagSettings(obj)`                    | `apply_flag_settings`                 |
| `getSettings()`                             | `get_settings`                        |
| `getContextUsage()`                         | `get_context_usage`                   |
| `rewindFiles(uuid, {dryRun})`               | `rewind_files`                        |
| `cancelAsyncMessage(uuid)`                  | `cancel_async_message`                |
| `seedReadState(path, mtime)`                | `seed_read_state`                     |
| `enableRemoteControl(enabled, {name})`      | `remote_control`                      |
| `generateSessionTitle(desc, {persist})`     | `generate_session_title`              |
| `askSideQuestion(q)`                        | `side_question`                       |
| `launchUltrareview(args, {confirm})`        | `ultrareview_launch`                  |
| `stopTask(id)`                              | `stop_task`                           |
| `backgroundTask(toolUseId)`                 | `background_task`                     |
| `dequeueMessage(value)`                     | `dequeue_message`                     |
| `voiceServerStart()`                        | `voice_server_start`                  |
| `voiceServerStop()`                         | `voice_server_stop`                   |
| `getUsage()`                                | `get_usage`                           |
| `mcpServerStatus()`                         | `mcp_status`                          |
| `toggleMcpServer(n, enabled)`               | `mcp_toggle`                          |
| `reconnectMcpServer(n)`                     | `mcp_reconnect`                       |
| `setMcpServers(map)`                        | `mcp_set_servers`                     |
| `enableChannel(n)`                          | `channel_enable`                      |
| `mcpAuthenticate(n)`                        | `mcp_authenticate`                    |
| `mcpClearAuth(n)`                           | `mcp_clear_auth`                      |
| `mcpSubmitOAuthCallbackUrl(n, url)`         | `mcp_oauth_callback_url`              |
| `claudeAuthenticate(flag)`                  | `claude_authenticate`                 |
| `claudeOAuthCallback(code, state)`          | `claude_oauth_callback`               |
| `claudeOAuthWaitForCompletion()`            | `claude_oauth_wait_for_completion`    |
| `reloadPlugins()`                           | `reload_plugins`                      |
| `initializationResult()`                    | (reads cached initialize response)    |
| `supportedModels() / Commands() / Agents()` | (reads cached initialize response)    |
| (no method)                                 | `rename_session` — REPL bridge only   |
| (no method)                                 | `file_suggestions` — REPL bridge only |
