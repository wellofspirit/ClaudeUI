# 08 — Control requests (inbound: cli.js → us)

Every `control_request` subtype cli.js emits to us. We MUST respond (or cli.js stalls). Handlers live in `src/main/sdk/query.ts::handleControlRequest()`.

Verified against cli.js 2.1.114. All outbound control requests originate from `MessageChannel.sendRequest` at char `~11929636`. Total of 6 subtypes.

---

## 8.1 Envelope

cli.js sends:
```json
{
  "type": "control_request",
  "request_id": "<uuid or id>",
  "request": { "subtype": "<name>", ...fields }
}
```

We respond with `control_response`:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<echoed>",
    "response": { ...subtype-specific }
  }
}
```

Or error:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "<echoed>",
    "error": "<message>"
  }
}
```

**Response shape is schema-validated by cli.js.** Mismatches cause Zod parse errors on cli.js's side. For `can_use_tool`, a ZodError becomes a deny decision with `message: "Tool permission request failed: <zodError>"` — the tool call returns as denied.

---

## 8.2 Retry / cancellation semantics (from cli.js side)

- **No retry.** If we never respond, the Promise in cli.js stays pending forever. `oauth_token_refresh` uses `AbortSignal.timeout(30000)` to self-abort.
- **Per-request cancellation:** cli.js sends `{type:"control_cancel_request", request_id}` in two cases:
  1. An AbortSignal tied to the request fires (e.g., turn interrupted, tool abandoned).
  2. Belt-and-suspenders cleanup after it receives our response — this is harmless and expected. Our harness's `cancelInbound` already handles "abort AC that's no longer in the map" silently.

Our side fires the AbortController we registered via `beginInbound(request_id)`. The `signal` threaded through callback contexts transitions to aborted — callbacks MUST check `signal.aborted` and bail.

---

## 8.3 `can_use_tool`

Permission prompt for a tool invocation. The most common inbound subtype. Races against a hook-based decision path (`pc1`/`dc1`) — whichever resolves first wins; the loser is cancelled.

**Anchor:** emission at `~11931856`. Request schema `eQ1` at `~11910500`. Response union `rA8` at `~11923650`.

**Gate:** always — any tool subject to permission checks.

### Request fields (from cli.js)

```jsonc
{
  "subtype": "can_use_tool",
  "tool_name": "Edit",                          // required
  "display_name": "Edit",                       // human label from F98(tool_name)
  "input": {                                    // required — full tool input
    "file_path": "...",
    ...
  },
  "permission_suggestions": [                   // optional — rule suggestions
    { "type": "addRules", "rules": [...], "behavior": "allow", "destination": "localSettings" }
  ],
  "blocked_path": "/abs/path",                  // optional — path that triggered denial
  "decision_reason": "...",                     // optional — stringified reason
  "title": "...",                               // from MCP _meta['anthropic/permissionDisplay'].title
  "description": "...",                         // from MCP _meta or synthetic
  "tool_use_id": "toolu_xxx",                   // REQUIRED (2.1.114)
  "agent_id": "..."                             // optional — set when invoked from a subagent
}
```

### Response (success) — discriminated union

**Allow branch:**
```jsonc
{
  "behavior": "allow",
  "updatedInput": {...},                        // required on allow. Empty {} = use original.
  "updatedPermissions": [                       // optional
    { "type": "addRules", "rules": [...], "behavior": "allow", "destination": "localSettings" }
  ],
  "toolUseID": "toolu_xxx",                     // optional, but STRONGLY recommend echoing request.tool_use_id
  "decisionClassification": "user_temporary"    // optional — telemetry only
                                                // "user_temporary"|"user_permanent"|"user_reject"|null
}
```

**Deny branch:**
```jsonc
{
  "behavior": "deny",
  "message": "Reason for denial",               // REQUIRED. Empty string passes Zod but bad UX.
  "interrupt": false,                           // optional. true → aborts the whole turn.
  "toolUseID": "toolu_xxx",                     // optional
  "decisionClassification": "user_reject"       // optional
}
```

### Schema strictness

cli.js parses via `rA8` (discriminated union over `behavior`). Malformed shapes fail Zod parse → cli.js synthesizes a deny with `message: "Tool permission request failed: <zodError>"`. The legacy `{permitted: boolean, ...}` shape from old SDKs is FULLY REMOVED in 2.1.114 — sending it deny-fails the tool.

`updatedPermissions` entries that fail individual schema parse are silently logged and dropped — the rest succeed.

### Side effects after cli.js receives response

- **Allow:** tool executes with `updatedInput` (or original `input` if `updatedInput={}`). `updatedPermissions` persisted via `uC(...)` + app-state update + config refresh.
- **Deny:** tool call aborts; error message surfaces as synthetic `tool_result`.
- **Deny + `interrupt:true`:** entire turn is aborted (`K.abortController.abort()`).

### Pseudo-tool: `SandboxNetworkAccess`

When the sandbox denies a network connection, cli.js sends a `can_use_tool` with:
```jsonc
{
  "tool_name": "SandboxNetworkAccess",
  "input": { "host": "example.com" },
  "description": "Allow network connection to example.com?",
  "permission_suggestions": [{ "type": "addRules", ... }]
}
```

Not a real tool — just a permission prompt for network egress. Handle it the same way as any other.

### Cancellation

cli.js sends `control_cancel_request` when:
- The turn's abort signal fires (user pressed interrupt, etc.)
- The tool is abandoned before the user decides

Our `canUseTool(name, input, {signal})` context's `signal.aborted` fires. The UI should dismiss the dialog.

### Hook race

If a `PermissionRequest` hook returns a decision BEFORE we respond, cli.js uses the hook's decision and aborts our request. Race fairness is wall-clock: fast host = host wins; slow host = hook wins.

### Our harness implementation

See `src/main/sdk/query.ts::handleCanUseTool()`. Pass-through plus:
- Coerces missing `message` on deny to `"Denied"` (avoids ZodError).
- Echoes `tool_use_id` as `toolUseID` in response.

---

## 8.4 `mcp_message`

JSON-RPC message destined for an in-process SDK MCP server.

**Anchor:** emission at `~11934105`. Schema `jc1`.

**Gate:** only fires for servers registered via `initialize.sdkMcpServers[]` (type `"sdk"`).

### Request fields

```json
{
  "subtype": "mcp_message",
  "server_name": "claude-ui",
  "message": { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
}
```

`message` is `E.unknown()` — cli.js does not inspect it.

### Response (MUST be wrapped)

```json
{ "mcp_response": { "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } } }
```

Validated by `E.object({mcp_response: E.any()})`. Missing `mcp_response` wrapper → Zod error on cli.js side → MCP client layer receives nothing → stall.

### Notifications (no id)

For JSON-RPC notifications (no `id`), we synthesize:
```json
{ "mcp_response": { "jsonrpc": "2.0", "result": {}, "id": 0 } }
```

Gives cli.js a well-formed reply; MCP client layer doesn't need the result.

### Bidirectional

cli.js's `mcp_message` handler on the inbound side (char `~12845809`) also accepts us SENDING this subtype (e.g., `notifications/tools/list_changed`). See `06-outbound-messages.md` and `10-mcp-hosting.md` for the pattern.

### Timing

Medium — depends on our in-process MCP server. Long-running tool calls (`tools/call` taking minutes) block cli.js's MCP client request queue for that specific server only.

### Our harness implementation

`McpHost.dispatch(server_name, message)` routes through `PairedTransport`. See `10-mcp-hosting.md`.

---

## 8.5 `hook_callback`

A matcher-registered hook fires.

**Anchor:** emission at `~11932710`. Schema `Dc1`.

**Gate:** fires when a hook matcher registered via `initialize.hooks` triggers. Each hook's `hookCallbackIds` entry is an individual callback.

### Request fields

```jsonc
{
  "subtype": "hook_callback",
  "callback_id": "hook_0",                      // id from initialize.hooks.X[*].hookCallbackIds
  "input": {...},                               // hook-event-specific payload
  "tool_use_id": "toolu_xxx"                    // optional, for tool-related events
}
```

The `input` shape is a discriminated union keyed on hook event type (schema `CGK`). Variants for PreToolUse, PostToolUse, Notification, Stop, SubagentStop, UserPromptSubmit, SessionStart, SessionEnd, PreCompact. See cli.js for exact fields per variant.

### Response shape

Generic `Record<string, unknown>` (schema `XmH` is permissive). cli.js reads these fields:

```jsonc
{
  "continue": true,                             // false → terminates current operation
  "stopReason": "...",                          // optional — paired with continue:false
  "decision": "approve"|"block",                // for PermissionRequest etc.
  "reason": "...",                              // paired with decision
  "systemMessage": "...",                       // injected as system-level note visible to model
  "hookSpecificOutput": {                       // shape varies per event
    "additionalContext": "..."                  // UserPromptSubmit — adds context to the prompt
  }
}
```

### Error behavior

On catch, cli.js logs `Error in hook callback <id>:` and returns `{}` (no-op decision). Host-side errors do NOT propagate as tool failures — the hook just becomes a noop.

### Per-hook timeout

Respected from `initialize.hooks.X[*].timeout`. cli.js aborts the request when it fires. Our `signal.aborted` flips.

### Our harness implementation

`hookCallbacks.get(callback_id)` looked up, invoked with `(input, tool_use_id, {signal})`.

---

## 8.6 `elicitation`

MCP server is asking the user for input.

**Anchor:** emission at `~11932934`. Schema `Tc1`. Response schema `J87`.

**Gate:** fires when an MCP server emits `elicitation/create` request AND the host has advertised elicitation support.

### Request fields

```jsonc
{
  "subtype": "elicitation",
  "mcp_server_name": "filesystem",
  "message": "Please provide X",                // prompt text from MCP server
  "mode": "form"|"url",                         // optional — form=inline structured, url=external
  "url": "https://...",                         // when mode=url
  "elicitation_id": "<id>",                     // identifier for this elicitation round
  "requested_schema": { /* JSON Schema */ },    // optional — expected response shape
  "title": "...",                               // from MCP _meta
  "display_name": "...",                        // from MCP _meta
  "description": "..."                          // from MCP _meta
}
```

### Response

```jsonc
{
  "action": "accept"|"decline"|"cancel",
  "content": { /* shape from requested_schema */ }  // only on accept
}
```

- **`accept`**: `content` is forwarded to the MCP server as the elicitation response.
- **`decline`**: MCP server receives decline; its tool typically fails.
- **`cancel`**: same flow as decline, treated as user cancellation.

### Error handling

On our catch, cli.js internally defaults to `{action: "cancel"}` — the MCP server sees a cancelled elicitation.

### Our harness implementation

Dispatches to `options.onElicitation(params, {signal})`. Default when no handler: `{action: 'decline'}`.

### Timing

Long-lived (awaits user).

---

## 8.7 `oauth_token_refresh`

cli.js needs a fresh OAuth token.

**Anchor:** emission at `~11934264`. Schema `Vc1`. Response schema `G87`.

**Gate:** env-gated. Fires only when BOTH:
- `process.env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` is truthy
- `process.env.CLAUDE_CODE_ENTRYPOINT` is in the allow-set `IR6` (typically SDK entry points)

Neither is set by our harness by default — this subtype is effectively dormant for us today.

### Request fields

```json
{ "subtype": "oauth_token_refresh" }
```

No payload.

### Response

```json
{ "accessToken": "<jwt>" | null }
```

`null` means we don't have a fresh token. cli.js surfaces this as an auth error downstream.

### Timing

cli.js self-times out via `AbortSignal.timeout(30_000)`. If we don't respond in 30 s, the request aborts and cli.js gets an auth error.

### Our harness implementation

Dispatches to `options.getOAuthToken({signal})`. Returns `{accessToken: null}` if not configured — cli.js treats as auth failure.

---

## 8.8 `request_user_dialog`

Generic user dialog — dormant in 2.1.114 but reserved for future flows (iTerm2 setup, computer-use approval).

**Anchor:** method at `~11933210`. Schema `vc1`. Response schema `Z87`.

**Gate:** **currently never fires** in 2.1.114. Zero call sites in cli.js. Reserved for future use by tools that previously rendered Ink JSX via `setToolJSX`.

### Request fields (when it will fire)

```jsonc
{
  "subtype": "request_user_dialog",
  "dialog_kind": "it2_setup"|"computer_use_approval"|<string>,  // open union
  "payload": { /* dialog-specific */ },         // opaque to the protocol
  "tool_use_id": "..."                          // optional
}
```

Known reserved `dialog_kind` values (not yet active): `"it2_setup"` (iTerm2 setup flow, macOS-specific), `"computer_use_approval"`.

### Response

```jsonc
{
  "behavior": "completed"|"cancelled",
  "result": { /* dialog-specific */ }           // only on completed
}
```

### Error handling

On our catch, cli.js internally defaults to `{behavior: "cancelled"}`.

### Our harness implementation

If `options.onUserDialog` is set, dispatches to it. Otherwise auto-responds `{behavior: "cancelled"}` immediately — prevents stall when the handler is unwired.

---

## 8.9 `control_cancel_request` (one-way from cli.js)

Not a request — a one-way cancel signal. Documented here because it comes through the same channel.

```json
{ "type": "control_cancel_request", "request_id": "<id of the request to cancel>" }
```

**When cli.js sends it:**
1. The AbortSignal attached to a pending outbound request from cli.js fires.
2. As belt-and-suspenders cleanup after cli.js receives our success response — this is harmless and expected; our `cancelInbound()` already treats "no matching AC" as a silent no-op.

**Our response:** NONE. This is fire-and-forget.

**What we do:** `ControlChannel.cancelInbound(request_id)` fires the AbortController we registered for that request_id. Any callback with `{signal}` observes `signal.aborted`.

---

## 8.10 Unknown inbound subtypes

Our harness at `src/main/sdk/query.ts::handleControlRequest()` falls back to:
```ts
if (process.env.DEBUG_SDK) {
  console.error(`[sdk] unknown inbound control subtype: ${subtype}`)
}
ctx.control.respondSuccess(request_id, {})
```

Benign `{subtype:'success', response:{}}` response — cli.js doesn't stall. If a new subtype appears in an upstream bump, we see it in DEBUG_SDK and add an explicit handler.

---

## 8.11 Callback signatures (harness-facing)

```ts
// Permission prompt
canUseTool: (
  toolName: string,
  input: Record<string, unknown>,
  ctx: {
    signal: AbortSignal,
    suggestions?: PermissionUpdate[],
    blockedPath?: string,
    decisionReason?: string,
    title?: string, displayName?: string, description?: string,
    toolUseId?: string, agentId?: string,
  }
) => Promise<{ behavior: 'allow', updatedInput?, updatedPermissions?, ... } |
              { behavior: 'deny', message: string, interrupt?, ... }>

// Hook callback (registered per-id via initialize.hooks)
hookCallback: (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  ctx: { signal: AbortSignal }
) => Promise<Record<string, unknown>>

// MCP elicitation
onElicitation: (
  params: { serverName, message, mode?, url?, elicitationId?, requestedSchema?, ... },
  ctx: { signal: AbortSignal }
) => Promise<{ action: 'accept'|'decline'|'cancel', content?: Record<string, unknown> }>

// OAuth token refresh
getOAuthToken: (ctx: { signal: AbortSignal }) => Promise<string | null>

// User dialog (currently dormant)
onUserDialog: (
  req: { dialogKind?, payload?, toolUseId? },
  ctx: { signal: AbortSignal }
) => Promise<{ behavior: 'completed'|'cancelled', result?: unknown }>
```

---

## 8.12 `pending_permission_requests` re-dispatch

Cross-reference: `09-initialize.md`. cli.js bundles in-flight `can_use_tool` requests onto the `"Already initialized"` error response. Our harness's `ControlChannel.onPendingPermissionRequests` hook re-feeds each bundled envelope through `handleControlRequest` exactly as if cli.js had sent it fresh.

**Only emission site:** `Vs1` initialize handler, "Already initialized" branch. No other subtype bundles this field.
