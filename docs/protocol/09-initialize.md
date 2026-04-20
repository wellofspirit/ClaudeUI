# 09 — Initialize

Deep dive on the `initialize` control_request. This is the single most complex message in the protocol — it's both a handshake and a configuration dump. cli.js processes it exactly once per session.

Verified against cli.js 2.1.114. Schemas at char `11908465` (request `sQ1`) and `11909901` (response `L3Y`); handler at `12864378` (`Vs1`).

---

## 9.1 When it's sent

Always exactly once, by us, immediately after spawn and before (or concurrent with) the first `user` message. Our harness sends it unconditionally — even for sessions that ONLY use stream messages and no SDK capabilities, cli.js needs the initialize to transition out of its pre-init state.

**Duplicate initialize** → cli.js replies `{subtype:'error', error:'Already initialized', pending_permission_requests:[...]}`. Never re-send.

---

## 9.2 Request shape

```jsonc
{
  "type": "control_request",
  "request_id": "<id>",
  "request": {
    "subtype": "initialize",

    // Hook bindings. Each callback id is later fired via hook_callback control_request.
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash",                     // optional — tool name glob
          "hookCallbackIds": ["hook_0", "hook_1"],
          "timeout": 10000                        // optional — ms
        }
      ],
      "PostToolUse": [...],
      "UserPromptSubmit": [...],
      "SessionStart": [...],
      // ... any valid HookEventName (see 9.4)
    },

    // In-process SDK MCP server NAMES. NOT descriptors — just strings.
    "sdkMcpServers": ["claude-ui", "claude-ui-mockup"],

    // Structured-output JSON schema. Forces model to reply with JSON matching it.
    "jsonSchema": { "$schema": "...", "type": "object", ... },

    // System prompt override (array form). [""] means "empty prompt".
    "systemPrompt": ["You are a helpful assistant."],

    // Append to the default preset system prompt (string form).
    "appendSystemPrompt": "\n\n<custom>instructions</custom>",

    // Append to subagent system prompts.
    "appendSubagentSystemPrompt": "...",
    // Gate: env var CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT must be truthy.

    // Strip dynamic (per-user) sections from the system prompt.
    // Improves cross-user prompt caching.
    "excludeDynamicSections": true,

    // Custom agent definitions (see 9.5 for the agent config shape).
    "agents": {
      "MyAgent": { description, prompt, tools, model, ... }
    },

    // Custom session title. Skips auto-title-generation.
    "title": "Debugging the payment bug",

    // Emit promptSuggestions events. Default: false.
    "promptSuggestions": true,

    // Emit agent-progress-summary events. Default: false.
    // Gate: feature flag "tengu_slate_prism" must be enabled on the account.
    "agentProgressSummaries": true
  }
}
```

### Fields cli.js READS on the initialize request

| Field | Type | Effect |
|---|---|---|
| `hooks` | `Record<HookEventName, Array<{matcher?, hookCallbackIds, timeout?}>>` | Each `hookCallbackIds` entry is wrapped in `createHookCallback(id, timeout)` so that, when a hook fires, cli.js sends us `control_request { subtype: 'hook_callback', callback_id, input, tool_use_id }` and we dispatch to the stored callback. |
| `sdkMcpServers` | `string[]` | Pre-populates stubs in cli.js's MCP server map. Actual connection (handshake) is deferred until the first `tools/list` or similar. |
| `jsonSchema` | `Record<string, unknown>` | Calls `x76(jsonSchema)` to install structured-output coercion. Model output is forced into this JSON shape. |
| `systemPrompt` | `string[]` | Sets `M.systemPrompt`. The special case `[""]` is mapped to empty string via `vs1()`. |
| `appendSystemPrompt` | `string` | Appended to the preset system prompt. |
| `appendSubagentSystemPrompt` | `string` | Appended to subagent system prompts. Env-gated. |
| `excludeDynamicSections` | `boolean` | Strips `<env>`, `<working_dir>`, `<current_date>`, `<git_status>`, etc. from the system prompt so caches hit across users. |
| `agents` | `Record<string, AgentConfig>` | Registered via `FH8(agents, 'flagSettings')`. If `M.agent` names one, its `prompt`/`model`/`initialPrompt` are applied to the current session. |
| `title` | `string` | `P98(title.trim())` — updates persisted session title + sets the `w8` custom-title flag, which suppresses auto-title generation. Handled BEFORE the main init dispatcher. |
| `promptSuggestions` | `boolean` | Sets `M.promptSuggestions`, also flips app-state `promptSuggestionEnabled: true`. |
| `agentProgressSummaries` | `boolean` | Calls `_76(true)` if the `tengu_slate_prism` feature flag is enabled on the account. |

### Fields NOT in the initialize request (common mistakes)

- **`enableAuthStatus`** — this is a **CLI flag**, not an initialize field. cli.js's Zod `.object()` schemas strip unknown keys, so putting `enableAuthStatus` in the initialize payload is a silent no-op. Use the `--enable-auth-status` CLI flag (or equivalent; see `02-cli-flags.md`).

---

## 9.3 Response shape

```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<echoed>",
    "response": {
      "commands": [
        { "name": "review", "description": "Review a pull request", "argumentHint": "<pr-number>" },
        ...
      ],
      "agents": [
        { "name": "Explore", "description": "Fast agent...", "model": "claude-sonnet-4-6" },
        ...
      ],
      "output_style": "normal",
      "available_output_styles": ["normal", "concise", "debug", ...],
      "models": [
        {
          "value": "claude-opus-4-7",
          "displayName": "Opus 4.7",
          "description": "Most capable",
          "supportsEffort": true,
          "supportedEffortLevels": ["low","medium","high","xhigh","max"],
          "supportsAdaptiveThinking": true,
          "supportsFastMode": false,
          "supportsAutoMode": true
        },
        ...
      ],
      "account": {
        "email": "user@example.com",
        "organization": "org-id",
        "subscriptionType": "max",
        "tokenSource": "oauth",
        "apiKeySource": "oauth",
        "apiProvider": "firstParty"       // "firstParty"|"bedrock"|"vertex"|"foundry"|"anthropicAws"|"mantle"
      },
      "pid": 12345,                       // optional — cli.js process id, for tmux socket isolation
      "fast_mode_state": "off"            // optional — "off"|"cooldown"|"on". Only when A7() && mP().
    }
  }
}
```

### Field notes

- **`commands`** — slash commands the session supports. `name` excludes the leading `/`. `argumentHint` is a hint string like `"<file>"` that our UI shows inline.
- **`agents`** — subagents invokable via the `Task` tool. `model` is optional (when absent, the agent inherits the parent turn's model).
- **`models`** — ordered by cli.js's preference. Our harness exposes this via `supportedModels()`.
- **`output_style`** — active style. Affects formatting / verbosity.
- **`available_output_styles`** — enumerated styles. Can be changed via `apply_flag_settings` control subtype.
- **`account`** — authenticated principal. `apiProvider` discriminates API vendor.
- **`pid`** — internal. Used for tmux socket deconfliction when multiple cli.js instances share a machine.
- **`fast_mode_state`** — Opus fast-mode status. Emitted only when the account is eligible (`A7()`) AND fast-mode is enabled (`mP()`). Absent on most accounts.

### Fields NOT in the initialize response (common mistakes)

- **`skills`** — NOT in initialize response. Available only via `reload_plugins` control_response (see `07-control-outbound.md`).
- **`plugins`** — same. Come via `reload_plugins`.

---

## 9.4 Hook event names

The keys of `request.hooks` must match one of (enum `pD4` at char `4958206`):

```
PreToolUse, PostToolUse, PostToolUseFailure
Notification, UserPromptSubmit
SessionStart, SessionEnd
Stop, StopFailure
SubagentStart, SubagentStop
PreCompact, PostCompact
PermissionRequest, PermissionDenied
Setup, TeammateIdle
TaskCreated, TaskCompleted
Elicitation, ElicitationResult
ConfigChange
WorktreeCreate, WorktreeRemove
InstructionsLoaded, CwdChanged, FileChanged
```

Unknown event names are rejected by cli.js's Zod parse (triggers a `control_response` error and the whole initialize fails).

---

## 9.5 AgentConfig shape (each entry in `agents`)

Schema `mGK` at char `4970938`:

```jsonc
{
  "description": "When to use this agent",         // required
  "prompt": "System prompt for the agent",         // required
  "tools": ["Read", "Grep", "Glob"],               // optional — allowlist; inherit all if omitted
  "disallowedTools": ["Bash"],                     // optional — denylist (applied after tools)
  "model": "claude-sonnet-4-6",                    // optional — full id, alias
                                                   //   ("sonnet"/"opus"/"haiku"), or "inherit"
  "mcpServers": [
    "claude-ui",                                   // reference an existing server by name
    { "custom-server": { "type": "stdio", ... } }  // or inline a server config
  ],
  "criticalSystemReminder_EXPERIMENTAL": "...",    // optional — pinned reminder
  "skills": ["skill-name-1", "skill-name-2"],      // optional — auto-load skills
  "initialPrompt": "Start by reading X",           // optional — auto-submit on agent becomes main
  "maxTurns": 20                                   // optional — positive int
}
```

All fields are passed through to the agent runtime when Task tool invokes it. See upstream SDK docs on agents for execution semantics.

---

## 9.6 Error response (initialize-specific)

```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "<id>",
    "error": "<message>",
    "pending_permission_requests": [...]  // can_use_tool requests that queued up during init
  }
}
```

Common error messages:
- `"Already initialized"` — duplicate initialize. Never re-send.
- `"Invalid hook event: X"` — unknown `hookEventName` in `hooks`.
- `"Invalid agent config"` — agent config fails schema validation.

The `pending_permission_requests` array carries any `can_use_tool` requests that were queued while waiting for initialize to succeed. Our harness re-dispatches them through `handleControlRequest` via the `onPendingPermissionRequests` hook in `ControlChannel`. Without re-dispatch, those tool calls hang forever.

---

## 9.7 Side-channel: `auth_status` event

When the CLI was spawned with the `--enable-auth-status` flag (not an initialize field!), `Vs1` enqueues a standalone `auth_status` stream event **after** the initialize response:

```json
{
  "type": "auth_status",
  "isAuthenticating": false,
  "output": "...",
  "error": "...",
  "uuid": "...",
  "session_id": "..."
}
```

Schema `AP4` at char `4984268`.

This is a stream event, not part of the initialize response. Our harness handles it via the normal message queue.

---

## 9.8 Timing

- **Timeout (our side):** 60 s — set in `src/main/sdk/query.ts` at the initialize promise.
- **Typical latency:** 100–500ms on warm cache, up to several seconds on first-run (plugin install triggered, models listed from server).
- **Do NOT await before sending user prompt.** cli.js queues incoming `user` messages and processes them after init completes. Blocking on init adds unavoidable user-visible latency to every first turn.

---

## 9.9 Our initialize payload (current)

See `src/main/sdk/query.ts` in the `initPayload` build. Summary:

```ts
const initPayload: Record<string, unknown> = { subtype: 'initialize' }
if (mcpHost.names().length) initPayload.sdkMcpServers = mcpHost.names()
if (initHooks) initPayload.hooks = initHooks
if (options.jsonSchema !== undefined) initPayload.jsonSchema = options.jsonSchema
if (options.appendSubagentSystemPrompt !== undefined)
  initPayload.appendSubagentSystemPrompt = options.appendSubagentSystemPrompt
if (options.excludeDynamicSections !== undefined)
  initPayload.excludeDynamicSections = options.excludeDynamicSections
if (options.agents !== undefined) initPayload.agents = options.agents
if (options.promptSuggestions !== undefined) initPayload.promptSuggestions = options.promptSuggestions
if (options.agentProgressSummaries !== undefined)
  initPayload.agentProgressSummaries = options.agentProgressSummaries
// NOTE: enableAuthStatus is still included in the payload here — cli.js ignores it.
// Should be moved to CLI flag path. See 02-cli-flags.md.
if (options.enableAuthStatus) initPayload.enableAuthStatus = true

// systemPrompt — string wrapped into [str], array passed through, preset/append handled separately:
if (typeof sp === 'string') initPayload.systemPrompt = [sp]
else if (Array.isArray(sp)) initPayload.systemPrompt = sp
else if (sp?.type === 'preset' && sp.append) initPayload.appendSystemPrompt = sp.append
```

### Known discrepancies with the spec above

- `enableAuthStatus` in initialize payload is a no-op. The harness currently still sends it but cli.js strips it. Will be fixed in a follow-up task.
- Our harness doesn't currently pass `title` — auto-title generation runs.

---

## 9.10 Cached accessors

The response is stored once in a `Promise<Record<string, unknown>>`. These `QueryHandle` methods read from it:

| Method | Returns field |
|---|---|
| `initializationResult()` | Full response object |
| `supportedModels()` | `response.models ?? []` |
| `supportedCommands()` | `response.commands ?? []` |
| `supportedAgents()` | `response.agents ?? []` |

Calling these before initialize resolves returns a still-pending Promise (safe — they all return Promises). After the 60 s timeout, they return `[]` and a stderr log explains the failure.

**Do not cache the result elsewhere** — refresh it via `reload_plugins()` if you need fresh `commands`/`agents`/`plugins`/`skills` after runtime changes.
