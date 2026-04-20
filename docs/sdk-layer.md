# SDK Layer — Vendored cli.js + In-House Harness

ClaudeUI no longer depends on `@anthropic-ai/claude-agent-sdk`. Instead, we ship cli.js directly (extracted from the official claude-code Bun binary) and implement the SDK's `query()` surface ourselves in `src/main/sdk/`. This document is the reference for how that works and how to maintain it.

## High-level map

```
downloads.claude.ai/claude-code-releases/<ver>/<plat>/claude.exe   (upstream)
          │
          ▼
scripts/extract-cli.mjs                                            (parse Bun binary)
          │
          ▼
vendor/claude-cli/
  cli.js                           ← Node-runnable, patched
  vendor/ripgrep/<arch-plat>/      ← downloaded separately from BurntSushi releases
  vendor/audio-capture/<arch-plat>/
  vendor/image-processor/<arch-plat>/
  version.json                     ← pinned via package.json#claudeCliVersion
          │
          ▼
src/main/sdk/ (our harness)        ← speaks stream-json, manages child process
          │                          replaces sdk.mjs
          ▼
patch/apply-all.mjs                ← 14 patches, idempotent
```

## Directory layout

| Path | Role |
|---|---|
| `vendor/claude-cli/cli.js` | The extracted, transformed, patched CLI. Never checked in. |
| `vendor/claude-cli/vendor/` | Native addons (audio-capture, image-processor) + ripgrep. |
| `vendor/claude-cli/version.json` | Records upstream version + extraction metadata. |
| `scripts/extract-cli.mjs` | Downloads binary, parses Bun format, transforms cli.js, downloads ripgrep. Cache-hit skip when version.json matches `package.json#claudeCliVersion`. |
| `patch/` | 14 content-regex patches against cli.js. Idempotent, run after every extraction. |
| `src/main/sdk/` | The in-house TypeScript harness. |
| `src/main/sdk/wire-log.ts` | Per-query ring buffer of every ndjson line. Snapshot via `queryHandle.wireLog()`. |

## `src/main/sdk/` files

| File | Responsibility |
|---|---|
| `index.ts` | Public exports: `query`, `tool`, `createSdkMcpServer`, `locateCliJs`, `getCliVersion`, + types. |
| `types.ts` | `QueryOptions`, `QueryHandle`, `SDKMessage`, `McpServerConfig`, `PermissionUpdate`, `HooksConfig`, etc. |
| `locate.ts` | Resolves cli.js path in dev (`vendor/claude-cli/cli.js`) and prod (`<Resources>/claude-cli/cli.js`). |
| `args.ts` | Builds argv. Exact port of sdk.mjs arg-builder (flag order + syntax). `buildEnv()` merges `options.env` overlay onto `process.env`. |
| `protocol.ts` | `NdjsonReader` / `NdjsonWriter` — newline-delimited JSON over stdio. |
| `control.ts` | `ControlChannel` — outbound control_request + response correlation, inbound AbortController registry for cancellation, `onPendingPermissionRequests` hook. |
| `mcp-host.ts` | In-process MCP hosting. Real `McpServer` from `@modelcontextprotocol/sdk` connected via a custom `PairedTransport` that bridges cli.js JSON-RPC ↔ our server. |
| `create-sdk-mcp.ts` | `createSdkMcpServer()` + `tool()` helpers. Zod-raw-shape passes directly through to `McpServer.registerTool()`. |
| `query.ts` | Orchestration: spawn child, wire reader/writer, initialize control_request, inbound dispatch, expose QueryHandle with ~31 methods. |

## Extracting cli.js from the Bun binary

### Binary format (reverse-engineered from `bun` source)

```
[binary data] [Offsets: 32 bytes] [Magic: 16 bytes "\n---- Bun! ----\n"] [optional Authenticode cert (Windows)]

Offsets:
  byte_count         : u64         // size of the data region
  modules_ptr.off    : u32         // offset into data region
  modules_ptr.len    : u32
  entry_point_id     : u32
  argv_ptr.off       : u32
  argv_ptr.len       : u32
  flags              : u32

Module table entries (52 bytes each):
  name                       : StringPointer (u32 off, u32 len)
  contents                   : StringPointer
  sourcemap                  : StringPointer
  bytecode                   : StringPointer
  module_info                : StringPointer
  bytecode_origin_path       : StringPointer
  encoding                   : u8
  loader                     : u8
  module_format              : u8
  side                       : u8
```

All offsets are **relative to `data_start`** where `data_start = magic_offset - 32 - byte_count`.

Windows PE binaries append an Authenticode certificate table after the Bun trailer — scan backwards for the magic rather than assuming EOF.

### Transform: Bun CJS → Node-runnable

Bun compiles cli.js wrapped as:
```js
// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) { BODY })
```

This doesn't self-invoke. The extraction script:

1. Strips the leading `// @bun` comment line
2. Unwraps the outer `(function(...){ BODY })` to leave bare BODY
3. Prepends `#!/usr/bin/env node` shebang + provenance header
4. **Injects a `Module._resolveFilename` shim** that redirects Bun's virtual paths (`B:/~BUN/root/audio-capture.node`, `B:/~BUN/root/image-processor.node`) to our vendored locations under `./vendor/<name>/<arch-platform>/<name>.node`

The result behaves identically to what Node's own CJS loader would produce when `require()`-ing a file.

### What ripgrep, addons come from

- **cli.js's native addons** (audio-capture, image-processor) are embedded in the Bun binary and extracted in the same pass.
- **Ripgrep** is statically linked into Bun itself, not extractable. The script downloads it separately from `github.com/BurntSushi/ripgrep/releases/latest` for the current platform and places it at `vendor/claude-cli/vendor/ripgrep/<arch-platform>/rg[.exe]`.

### Cache-hit skip

`extract-cli.mjs` reads `package.json#claudeCliVersion` and compares against `vendor/claude-cli/version.json#version`. Match → skip everything. Mismatch or missing → full re-download + parse + transform + patch.

`bun run ensure-cli` is the invocation; it's gated into `postinstall`, `dev`, `build`, `build:mac`, `build:linux`. Cache hit ≈ 2s, full extract ≈ 4-30s depending on binary cache state.

## Wire protocol: stream-json over stdio

We spawn cli.js as:
```
<executable> <executableArgs>... <cliPath> --output-format stream-json --verbose --input-format stream-json <more flags>
```

where `<executable>` is typically Electron's helper binary with `ELECTRON_RUN_AS_NODE=1` in its env overlay (scoped only to this child; never on the main process's env — that would poison Electron's GPU/renderer children).

Both directions are newline-delimited JSON. Every line is exactly `{...}\n`.

### Outbound (we → cli.js)

- **User message** (string prompt):
  ```json
  { "type": "user", "message": { "role": "user", "content": "…" } }
  ```
  Or streaming input: each `next()` on the `AsyncIterable<SDKMessage>` is JSON-serialized and written.

- **Control request**:
  ```json
  { "type": "control_request", "request_id": "<13-char-random>",
    "request": { "subtype": "…", ... } }
  ```

- **Control response** (our reply to cli.js's inbound requests):
  ```json
  { "type": "control_response",
    "response": { "subtype": "success"|"error", "request_id": "…",
                  "response": {…} | "error": "…" } }
  ```

### Inbound (cli.js → we)

Message types we handle:
- `assistant`, `user`, `stream_event`, `system`, `result`, `tool_progress`, `request_usage`, `rate_limit_event`, `task_notification`, `queued_command_consumed`, `bash_output` — forwarded to the consumer's async iterator.
- `auth_status` — only emitted when `options.enableAuthStatus: true` is set in the initialize payload. Forwarded to the consumer as-is. Fields: `isAuthenticating`, `output`, `error`, `uuid`, `session_id`. Off by default — opt in only if the consumer knows what to do with it.
- `control_response` — correlated by `request_id` to resolve a pending outbound request.
- `control_request` — dispatched to our inbound handler (see below).
- `control_cancel_request` — fires `AbortController` for the matching request_id (see "Cancellation" below).

`system` subtype values that appear on stdout: `init`, `status`, `task_notification`, `queued_command_consumed`, `compact_boundary` (emitted when conversation compaction crosses a boundary on long sessions — fields include `compact_metadata`). Dev-only / feature-gated subtypes we don't consume: `hook_started`/`hook_progress`/`hook_response` (print-mode + verbose only), `bridge_state` (only when `remote_control` is active), `session_state_changed` (gated on `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`).

cli.js also *accepts* two inbound stdin types we don't currently send: `keep_alive` (no-op heartbeat) and `update_environment_variables` (`{variables: Record<string,string>}` mutates `process.env` inside cli.js — deliberately left unused; flagged as a capability to be aware of if the stdin channel is ever exposed to third parties).

## CLI argv flags

Flags emitted by `args.ts/buildArgs()`, in SDK-matching order. Everything reflects `sdk.mjs`'s `initialize()` arg-builder at ~char 222824. Never reorder or change syntax without re-checking against SDK.

```
--output-format stream-json  --verbose  --input-format stream-json
--thinking adaptive|disabled  [value-enabled-without-budget → adaptive; disabled/adaptive literal]
--max-thinking-tokens N       [enabled+budget OR adaptive+budget]
--thinking-display <display>  [when type !== 'disabled']
--effort <level>
--max-turns N
--max-budget-usd N
--task-budget N               [from taskBudget.total]
--model <name>
--agent <x>                   [singular --agent; custom agents go in initialize payload]
--betas <csv>
--json-schema <json>          [ALSO forwarded in initialize payload]
--debug-file <p>  |  --debug
--debug-to-stderr             [when env DEBUG_CLAUDE_AGENT_SDK is set]
--permission-prompt-tool stdio|<name>   [stdio when canUseTool is set; name otherwise; throws if both]
--continue
--resume <x>
--assistant
--channels <a> <b> <c>
--allowedTools <csv>
--disallowedTools <csv>
--tools ""|<csv>|default      [array empty → "", array populated → csv, non-array → "default"]
--mcp-config <json>           [only CLI-type servers; SDK-type servers go via initialize payload]
--setting-sources=<csv>       [single arg with '='; NOT two separate args]
--strict-mcp-config
--permission-mode <m>
--allow-dangerously-skip-permissions
--fallback-model <w>          [throws if equal to model]
--include-hook-events
--include-partial-messages
--session-mirror
--add-dir <d> (per directory in additionalDirectories)
--plugin-dir <p> (per local plugin)
--fork-session
--resume-session-at <x>
--session-id <x>
--no-session-persistence      [persistSession === false]
--settings <json>             [inline object: JSON; string: path]
                              [sandbox config merges into settings at spawn time via QV() port]
--<flag> [value]              [each entry in extraArgs flag-bag]
```

## Control-request subtypes (outbound)

Every QueryHandle method maps to one control_request. 31 total. Grouped for readability:

### Session control
`interrupt`, `end_session`, `set_permission_mode`, `set_model`, `set_max_thinking_tokens`, `apply_flag_settings`, `get_settings`, `rewind_files`, `cancel_async_message`, `seed_read_state`, `remote_control`, `generate_session_title`, `side_question`, `ultrareview_launch`, `stop_task`, `background_task`, `dequeue_message`, `voice_server_start`, `voice_server_stop`, `get_usage`, `get_context_usage`

`end_session` (added 2026-04-19) is a graceful counterpart to `interrupt` — cli.js `break`s its main read loop after flushing pending output, then exits on its own. Prefer it over SIGTERM on clean shutdown paths; SIGTERM still works as a fallback.

### MCP servers
`mcp_status`, `mcp_toggle`, `mcp_reconnect`, `mcp_set_servers`, `channel_enable`, `mcp_authenticate`, `mcp_clear_auth`, `mcp_oauth_callback_url`

### Claude OAuth
`claude_authenticate`, `claude_oauth_callback`, `claude_oauth_wait_for_completion`

### Plugins
`reload_plugins`

### Initialize
`initialize` — sent exactly once at session start. Response is cached in a promise; `initializationResult()`, `supportedModels()`, `supportedCommands()`, `supportedAgents()` read from it. cli.js does NOT expose those as separate subtypes.

## Control-request subtypes (inbound)

cli.js sends these to us. Every subtype must be handled or cli.js may stall waiting for our response.

### `can_use_tool`
Permission prompt for a tool invocation. Dispatched to `options.canUseTool(name, input, { signal, suggestions, blockedPath, decisionReason, title, displayName, description, toolUseId, agentId })`. Response shape is a discriminated union keyed on `behavior` (cli.js Zod schema `iC5` at ~char 4957497 — strict parse, a non-matching shape ZodErrors and the tool call hangs):
```
{ behavior: 'allow', updatedInput?, updatedPermissions?, toolUseID? }
{ behavior: 'deny',  message: string (required), interrupt?, toolUseID? }
```
`message` is required on the deny branch. A `CanUseToolResult` with `behavior: 'deny'` but no `message` is coerced to a default string to keep the channel moving. The earlier `{permitted: boolean, ...}` shape (legacy stdin-tool permission format) was wrong — kept around accidentally after the move off the official SDK and only surfaced when a consumer actually exercised a permission prompt.

### `mcp_message`
JSON-RPC message destined for an in-process SDK MCP server. Routed to `McpHost.dispatch(server_name, message)`. Response MUST be wrapped:
```json
{ "mcp_response": <jsonrpc-message> }
```
For notifications (no `id`), we synthesize a dummy `{jsonrpc:'2.0', result:{}, id:0}` so cli.js sees a well-formed reply. Port of SDK's `handleMcpControlRequest`.

### `hook_callback`
Fires a matcher-registered hook. `options.hooks` gets transformed at initialize-time — callbacks get ids (`hook_0`, `hook_1`, …), id-table sent in initialize payload, original callbacks stored in a Map. When cli.js fires `hook_callback { callback_id, input, tool_use_id }`, we look up the id and call `cb(input, tool_use_id, { signal })`.

### `elicitation`
MCP server asking the user for input. Dispatched to `options.onElicitation(params, { signal })`. Default when no handler: respond `{ action: 'decline' }`.

### `oauth_token_refresh`
cli.js needs a fresh token. Dispatched to `options.getOAuthToken({ signal })`. Response `{ accessToken: string|null }`. Throws (matching SDK) when no callback provided.

### `request_user_dialog`
Generic user-facing dialog prompt (e.g. tool-use disambiguation). Dispatched to `options.onUserDialog({dialogKind, payload, toolUseId}, {signal})`. When no handler is registered we auto-respond `{behavior: 'cancelled'}` immediately so cli.js doesn't hang waiting for a timeout. Added 2026-04-19 after RE-finding it in cli.js's bridge class.

### Unknown subtypes
Respond with benign `{ subtype: 'success', response: {} }` so cli.js doesn't stall. Under `DEBUG_SDK=1` we also log the unknown subtype + request_id to stderr so new upstream subtypes surface quickly during development. Add explicit handlers as new subtypes appear in cli.js.

## Initialize control request

Always sent at session start. Response is cached in a `Promise<Record<string, unknown>>` and exposed via `initializationResult()` + the three `supported*` accessors.

### Outbound payload fields

```jsonc
{
  "subtype": "initialize",
  "sdkMcpServers": ["claude-ui", "claude-ui-mockup"],  // array of NAME STRINGS, not objects (critical)
  "hooks": { "PreToolUse": [...], "PostToolUse": [...], ... },  // id-table form, see above
  "jsonSchema": <any>,
  "systemPrompt": [<string> | <string>, ...],  // bare string auto-wrapped in array
  "appendSystemPrompt": "…",                    // from systemPrompt.append on preset form
  "appendSubagentSystemPrompt": "…",
  "excludeDynamicSections": true|false,
  "agents": {…},                                // custom agent definitions (object, not string)
  "promptSuggestions": true|false,
  "agentProgressSummaries": true|false
}
```

### Response fields (observed)

```jsonc
{
  "models": [...],           // supportedModels()
  "commands": [...],         // supportedCommands()
  "agents": [...],           // supportedAgents()
  "skills": [...],
  "plugins": [...],
  "account": {...},
  "output_style": "normal",
  "available_output_styles": [...],
  "pid": 12345
}
```

## MCP hosting

`McpHost` holds one `McpServer` (from `@modelcontextprotocol/sdk`) per SDK-type server, each connected to its own `PairedTransport`:

```
cli.js     ← control_request{subtype: mcp_message, server_name, message} →
 our side:
   McpHost.dispatch(server_name, message)
     → PairedTransport.inject(message)          // feeds transport.onmessage
       → McpServer processes (via @modelcontextprotocol/sdk)
         → server.send(response)                 // goes to our transport.send
           → PairedTransport correlates by id, resolves inject()'s Promise
   → wrap as { mcp_response: jsonrpc-message }
   → respondSuccess
```

Each server's transport has an independent `pending` map keyed by jsonrpc `id` — no cross-server collisions.

Lazy connection: `ensureStarted()` is called on first dispatch so sessions that never invoke an SDK tool pay no MCP startup cost.

## Cancellation (three tiers)

| Tier | Trigger | Effect |
|---|---|---|
| **Query-wide** | `options.abortController.abort()` | Child receives SIGTERM. Downstream: pending control_requests reject, iterator finishes, in-flight inbound handlers abort. |
| **Per-inbound-request** | `control_cancel_request{request_id}` from cli.js | Fires the `AbortController` registered in `control.inbound` Map for that id. The signal is what we pass into `canUseTool({signal})`, hook callbacks, `onElicitation({signal})`, `getOAuthToken({signal})`. |
| **Cleanup** | Query teardown (exit, error) | `rejectAll()` → also `abortAllInbound()`. Every outstanding inbound handler's signal fires. |

Concrete scenario: user starts a turn, agent requests Bash, we show UI prompt. Agent interrupt → cli.js sends `control_cancel_request` → our canUseTool context's `signal` fires → UI handler dismisses the dialog without user action.

## `pending_permission_requests`

cli.js can return an error response with a side-channel:

```json
{
  "subtype": "error", "request_id": "xyz", "error": "…",
  "pending_permission_requests": [
    { "type": "control_request", "request_id": "abc",
      "request": { "subtype": "can_use_tool", ... } }
  ]
}
```

These are `can_use_tool` prompts that were queued waiting for whatever we tried to change (e.g. `set_permission_mode`). Without re-dispatch they're silently dropped and the tool call hangs forever.

`ControlChannel`'s `onPendingPermissionRequests` hook, wired in `query.ts`, feeds each one back through `handleControlRequest` exactly as if cli.js had sent it fresh. Port of SDK's `processPendingPermissionRequests`.

## Typed message surface

`SDKMessage` is a discriminated union over `type`, exported from `src/main/sdk/types.ts`. Each variant describes the fields ClaudeUI reads off that shape; an index signature (`[k: string]: unknown`) keeps every variant forward-compatible with fields cli.js may add at a version bump.

```ts
import type { SDKMessage, AssistantMessage } from 'src/main/sdk'

function onMessage(msg: SDKMessage) {
  switch (msg.type) {
    case 'assistant':
      // msg is AssistantMessage — msg.message, msg.parent_tool_use_id typed
      break
    case 'result':
      // msg.total_cost_usd, msg.subtype, msg.errors typed
      break
  }
}
```

Variants exported alongside the union: `AssistantMessage`, `UserMessage`, `StreamEventMessage`, `SystemMessage`, `ResultMessage`, `ToolProgressMessage`, `RequestUsageMessage`, `RateLimitEventMessage`, `BashOutputMessage`, `AuthStatusMessage`, `ControlRequestMessage`, `ControlResponseMessage`, `ControlCancelRequestMessage`. `UnknownSDKMessage` is exported but NOT part of `SDKMessage` — it's for raw stream-json parsing (wire log, tests) where unknown types may appear.

## Wire log

Every query owns a bounded ring buffer (`WireLog`, `src/main/sdk/wire-log.ts`) that captures every ndjson line read from / written to cli.js. Access via `queryHandle.wireLog()`:

```ts
const q = query({...})
// ...later, during a bad-state investigation:
const entries = q.wireLog()  // WireEntry[] — seq, t (ms since query start), dir ('in'|'out'), line
fs.writeFileSync('debug.jsonl', entries.map(e => JSON.stringify(e)).join('\n'))
```

Capacity defaults to 1000 entries; override with `options.wireLogCapacity` when a debug dump genuinely needs longer history (stream_event deltas are the dominant line rate). No CPU cost beyond one Map-shift-and-push per line.

## Robustness guarantees

A few things the harness is careful about — written down so they don't regress:

- **Per-request timeouts.** `ControlChannel.request(payload, {timeoutMs})` defaults to 30 s. Long-lived subtypes — `mcp_authenticate`, `claude_authenticate`, `claude_oauth_callback`, `claude_oauth_wait_for_completion` — opt out with `{timeoutMs: 0}`. `initialize` runs with a 60 s bound. Without the timeout a stuck cli.js silently hangs the UI.
- **MCP start race.** `McpHost.ensureStarted()` gates both callers on a shared Promise so a second concurrent `dispatch()` can't slip past the guard before `transport.onmessage` is wired by the MCP SDK.
- **AbortController listener cleanup.** `query.ts` adds the abort listener with `{once: true}` and explicitly removes it on `child.exit`/`child.error`. Callers can reuse a single AbortController across multiple `query()` calls without leaking.
- **Child-teardown races.** A `childClosed` flag short-circuits the streaming-input `for await` loop and suppresses the inevitable EPIPE from a write into a closed stdin. Those aren't user-facing failures.
- **Initialize errors surface.** If cli.js rejects the init payload we log to stderr (+ consumer's `options.stderr`) instead of returning empty arrays for `supportedModels/Commands/Agents` with no clue why.
- **Session-ended rejection for waiters.** `ClaudeSession.ensureActiveQuery()` awaits a Promise that run()'s teardown rejects, instead of polling with a 15 s deadline.

## Debugging

Two stderr-logging env vars:

| Var | Scope | What it logs |
|---|---|---|
| `DEBUG_SDK=1` | Our harness | Spawn / first-byte / first-assistant / first-user timestamps, plus every outbound control_request + matching response or error (with request_id + first 200 chars of payload). |
| `DEBUG_CLAUDE_AGENT_SDK=1` | cli.js itself | Passes `--debug-to-stderr`; cli.js dumps its internal event trace to stderr. Also sets `DEBUG=1` in the child env matching SDK behavior. |

Run both together for end-to-end tracing:
```bash
DEBUG_SDK=1 DEBUG_CLAUDE_AGENT_SDK=1 bun run dev
```

## Patches

Patches apply to `vendor/claude-cli/cli.js` (post-transform). All use content-regex anchors — never char offsets or minified names. `patch/apply-all.mjs` is idempotent; safe to re-run.

16 patches. 3 auto-detect upstream fixes and no-op on recent cli.js versions (`taskstop-notification`, `incomplete-session-resume-fix`, `mcp-tool-refresh`). The other 13 actively add capabilities or fix extraction-specific regressions:

| Patch | What it adds to cli.js |
|---|---|
| `subagent-streaming` (A-G) | Forwards subagent stream_events + messages that would otherwise be swallowed by internal aggregation |
| `team-streaming` (A-C) | Same for teammates + emits task_notification on completion |
| `queue-control` | `dequeue_message` control subtype + `queued_command_consumed` notification |
| `mcp-status` | Awaits MCP refresh before responding so mcpServerStatus() returns full list |
| `sandbox-network-fix` | Skips proxy startup when no domain restrictions configured |
| `background-task` | `background_task` control subtype — convert foreground task to background |
| `usage-relay` | `get_usage` control subtype — exposes cli.js's internal /usage API |
| `request-usage` | Emits per-request token usage events after each API call |
| `rate-limit-relay` | Emits rate limit headers after each API call |
| `voice-server` | Adds internal TCP voice-transcription server, control subtypes `voice_server_start`/`stop` |
| `bash-output-streaming` | Pushes Bash output to stream_event immediately instead of buffering 2s |
| `ci-path-remap` | Runtime `url.fileURLToPath` interceptor — redirects all `file:///home/runner/.../` URLs leaking from the Bun build to paths under the extracted cli.js dir. Fixes Grep (ripgrep path resolution) plus 5 other latent leaks (modifiers-napi, open, seccomp, claudeInChrome, computerUse) for ClaudeUI's extract-and-run-under-Node deployment |

When the SDK minifier changes variable names between versions, patches fail with "cannot locate anchor". Symptoms: `apply-all.mjs` errors out at a specific patch; that patch's regex needs updating for the new minifier output. See individual patch READMEs for bundle-analyzer anchors.

## Coverage vs the SDK

| Feature | Status |
|---|---|
| Public API surface (`query`, `tool`, `createSdkMcpServer`) | Drop-in compatible |
| CLI argv flags | All SDK-emitted flags, exact order and syntax |
| Initialize payload | All fields |
| Control request subtypes (outbound) | 26 methods (incl. `endSession`) + 6 initialize-backed accessors = 32 |
| Control request subtypes (inbound) | can_use_tool, mcp_message, hook_callback, elicitation, oauth_token_refresh, request_user_dialog, control_cancel_request |
| Three-tier cancellation | Full |
| `pending_permission_requests` re-dispatch | Full |
| MCP hosting | Full (via `@modelcontextprotocol/sdk`) |
| Hook callback dispatch | Full |
| Elicitation + OAuth token refresh callbacks | Full |
| Sandbox/settings merging (QV helper) | Full |
| `spawnClaudeCodeProcess` hook | Full |
| `systemPrompt` as `string[]` with boundary marker | Full |

Intentionally not ported:

- `transcriptMirror` — transcript replication batcher. Nothing uses it.
- `isSingleUserTurn` accounting — fine-grained turn accounting. Our `interrupt()` is whole-query.

## Maintenance checklist

When upstream cli.js bumps (package.json#claudeCliVersion):

1. Bump the version field and run `bun run ensure-cli` — will download new binary, extract, re-apply patches, syntax-check.
2. If a patch's anchor fails to match, use `/bundle-analyzer` on the new cli.js to locate the moved pattern. Update the regex. Make it tolerant of both old and new forms when practical.
3. If a new control_request subtype appears that our unknown-handler falls back to, consider adding explicit handling if it's a capability we want.
4. Watch for new init payload fields in the SDK's `sdk.mjs` — if ClaudeUI starts using an option, make sure our harness forwards it.

When the SDK surface changes (new QueryHandle methods, new subtypes):

1. Add the type to `QueryHandle` in `types.ts`.
2. Add the implementation to `makeHandle()` in `query.ts`. One-line control.request mapping for most.
3. If it's a new inbound subtype, extend `handleControlRequest()` in `query.ts`.

## Appendix: research trail

The reverse-engineering that produced this harness came from:

- Reading `sdk.mjs` via the `bundle-analyzer` skill (it's ~600KB minified ESM; standard grep is ineffective).
- Hash-comparing our extracted cli.js against the SDK's bundled cli.js at matching versions (they differ — SDK's version has Anthropic's post-processed Node paths; Bun's embedded version has `B:/~BUN/root/*.node` and `x64-win32` hardcoded).
- Wire-observation via `DEBUG_SDK=1` during dev.

Keep those tools handy when diagnosing wire-format issues.
