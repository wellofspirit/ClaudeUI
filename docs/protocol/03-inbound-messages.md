# 03 — Inbound messages (cli.js → us)

Every top-level `type` cli.js writes to stdout in `--output-format stream-json --verbose` mode. Every line is `{...}\n`.

Verified against cli.js 2.1.114 (patched). Emission architecture detail at `_research_outbound_messages.md` if you need the fine-grained anchors.

---

## 3.1 Emission architecture

cli.js has **three** paths that reach stdout:

1. **Main generator pipeline** (`Ts1` → `M.write(line)`) at char `~12822400`. Everything yielded by the turn generator passes through here.
2. **Control channel** (`h.enqueue`) at char `~12843100+`. Control responses/cancels plus some out-of-band system events (auth_status, rate_limit_event native, permission-mode status, prompt_suggestion, transcript_mirror).
3. **Direct `process.stdout.write`** — used by all ClaudeUI patches (`request-usage`, `rate-limit-relay`, `bash-output-streaming`, subagent-streaming E/G, team-streaming B).

A fourth pseudo-path queues vT-class system subtypes (`task_notification`, `task_started`, `task_updated`, `task_progress`, `notification`) through `JtH`, flushed by `ZtH()` at char `~12838006` / `~12840696` (which injects `uuid` + `session_id` at flush time).

---

## 3.2 Catalog

| Type | Emitted by | Gate | See |
|---|---|---|---|
| `assistant` | Generator | Always | §3.3 |
| `user` | Generator (synthetic tool_result + replays) | Always | §3.4 |
| `stream_event` | Generator | `--include-partial-messages` | §3.5, and `05-stream-events.md` for deltas |
| `system` | Generator + vT queue + control channel | Varies per subtype | §3.6 + `04-system-subtypes.md` |
| `result` | Generator | Always (once per turn) | §3.7 |
| `tool_progress` | Generator | `CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID` for bash/pwsh; always for REPL | §3.8 |
| `tool_use_summary` | Generator | Always when tool_use_summary attachment produced | §3.9 |
| `request_usage` | Patch `request-usage` (direct stdout) | Always (when patched) | §3.10 |
| `rate_limit_event` | Patch `rate-limit-relay` or native G_H listener | Patched path: always; native: rare | §3.11 |
| `bash_output` | Patch `bash-output-streaming` (direct stdout) | Rate-limited ≤1/200ms per tool | §3.12 |
| `auth_status` | Control channel | `--enable-auth-status` flag | §3.13 |
| `prompt_suggestion` | Control channel | `promptSuggestions: true` in initialize | §3.14 |
| `transcript_mirror` | Direct write from file watcher | `sessionMirror: true` (ClaudeUI doesn't use) | §3.15 |
| `control_request` | Control channel | Per inbound subtype — see `08-control-inbound.md` | §3.16 |
| `control_response` | Control channel | One per inbound outbound control_request | §3.17 |
| `control_cancel_request` | Control channel | On abort of pending inbound control_request | §3.18 |

---

## 3.3 `assistant`

Anthropic-shaped assistant message. Fires on every assistant response, including partial streaming updates (same `message.id` shared across partials).

**Anchors:** main `DB8` transformer at char `6309065`; subagent variants at `7817076` (E), `7656339` (G); teammate at `8648903` (B).

**Gate:** Always (when `outputFormat === 'stream-json' && verbose`). Subagent/team paths need their patches applied.

### Shape (top-level assistant)

```jsonc
{
  "type": "assistant",
  "message": {
    "id": "msg_XXXX",                 // shared across partial updates — upsert by this id
    "role": "assistant",
    "content": [...],                 // Anthropic content blocks: text, thinking, tool_use, citations
    "model": "claude-opus-4-7",
    "stop_reason": "end_turn"|"tool_use"|"max_tokens"|"stop_sequence"|"tool_deferred"|"tool_deferred_unavailable",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 890,
      "cache_read_input_tokens": 100
    }
  },
  "parent_tool_use_id": null,         // null for top-level; tool_use_id of parent Task when subagent
  "session_id": "...",
  "uuid": "...",
  "error": null                       // populated when assistant generation itself errored
}
```

### Subagent variant (`parent_tool_use_id` non-null)

```jsonc
{
  "type": "assistant",
  "message": {...},
  "parent_tool_use_id": "toolu_parent",   // points to the parent's Task tool_use block
  "session_id": "...",
  "uuid": "..."
}
```

### Teammate variant (patch `team-streaming-B`)

```jsonc
{
  "type": "assistant",
  "message": {...},
  "teammate_id": "agent-name@team-name",
  "parentUuid": "...",                     // links to parent teammate message
  "session_id": "...",
  "uuid": "..."
}
```

### Field notes

- **`message.id`** is stable across partial updates. A single assistant reply emits multiple `assistant` lines, all sharing `message.id`, each with a progressively fuller `content`. Consumer should upsert by id (replace in place).
- **`content` blocks** may include `text`, `thinking`, `tool_use`, `citations`. Thinking blocks only present when thinking is enabled.
- **`stop_reason`**:
  - `end_turn` — model ended the turn normally.
  - `tool_use` — model wants to call a tool (tool_use block present; wait for `user` tool_result).
  - `max_tokens` — hit output limit (may recover with continue).
  - `stop_sequence` — hit a configured stop sequence.
  - `tool_deferred` — hook deferred a tool; see `result` subtype.
  - `tool_deferred_unavailable` — MCP tool vanished.
- **Ordering** — parent `assistant` (with Task `tool_use`) arrives first; subagent messages interleave with `parent_tool_use_id`; parent's synthetic `user` tool_result arrives last for that Task. For teams, `system/task_notification` arrives when teammate completes.

---

## 3.4 `user`

Four distinct triggers, all top-level `user` messages.

### Trigger 1 — Synthetic `tool_result` (the common case)

After every tool execution finishes, cli.js synthesizes a `user` message whose `content` is an array containing one or more `tool_result` blocks. Yielded from `DB8` at char `~6310878`.

```jsonc
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_xxx",
        "content": "<tool output>" | [<content blocks>],
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-...",
  "isSynthetic": false,                  // true when from MCP meta-annotation
  "tool_use_result": <raw>,              // populated for tool_result containers
  "origin": "..."
}
```

### Trigger 2 — Replay of prior user messages

When `shouldQuery=false` or during session resume, cli.js re-yields past user messages (char `~12802210`, `~12803763`).

```jsonc
{
  "type": "user",
  "message": {...},
  "isReplay": true,                      // present only on replay paths
  "file_attachments": [...],             // may be present
  "session_id": "...",
  "uuid": "..."
}
```

### Trigger 3 — Queued command consumed (patch `queue-control`)

When a mid-turn steer is consumed, cli.js re-emits the prompt as a `user` message with `isReplay: true` (char `~12805950`).

Shape same as Trigger 2.

### Trigger 4 — Duplicate message ACK

When a `user` with a pre-existing `uuid` arrives, cli.js emits an `isReplay: true` ack to preserve client ordering (char `~12861187`).

### Subagent variant (`parent_tool_use_id`)

```jsonc
{
  "type": "user",
  "message": {...},
  "parent_tool_use_id": "toolu_parent",
  "session_id": "...",
  "uuid": "..."
}
```

### Teammate variant (`teammate_id`)

Per patch `team-streaming-B` at char `8648903`:

```jsonc
{
  "type": "user",
  "message": {...},
  "teammate_id": "agent-name@team-name",
  "session_id": "...",
  "uuid": "..."
}
```

### Field notes

- **`isSynthetic`** — true when message was synthesized by cli.js (e.g., MCP `setVisibleInTranscriptOnly` annotations).
- **`tool_use_result`** — raw tool result payload (before wrapping in the tool_result block). For MCP tools, shape is `{content, ...mcpMeta}`.
- **`origin`** — carried through from upstream (remote control path).
- **`isReplay`** — present and `true` only on replay/ack/queued-command paths. Absent on live synthetic tool_result messages.
- **`parent_tool_use_id`** — null for top-level; non-null when the user message is inside a subagent's tool execution.

---

## 3.5 `stream_event`

Low-level Anthropic SSE events forwarded from the streaming layer. Raw building blocks of partial assistant updates.

**Anchors:** main path at char `~12805167`; `DB8` subagent progress at `6310167`; subagent patches E/G at `7816704`/`7656163`; teammate patch B at `8648236`.

**Gate:** `--include-partial-messages` (option `includePartialMessages: true`). Subagent/team variants need their ClaudeUI patches.

### Shape

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "message_start"|"content_block_start"|"content_block_delta"|"content_block_stop"|"message_delta"|"message_stop",
    ...
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "ttft_ms": 412                        // only on first stream_event of an assistant turn
}
```

Teammate variant has `teammate_id` instead of `parent_tool_use_id`.

### `event.type` values

See `05-stream-events.md` for complete delta shapes. Summary:
- `message_start` — skeleton with initial message id, role, model, empty content, input-token usage
- `content_block_start` — new content block starts (text, thinking, tool_use, citations)
- `content_block_delta` — incremental update to the current block
- `content_block_stop` — block finished
- `message_delta` — running output token count + cache hits
- `message_stop` — message finished

### Field notes

- **`ttft_ms`** — time-to-first-token. Present only on the first `stream_event` of an assistant turn. Useful for startup latency metrics.
- **`parent_tool_use_id`** non-null for subagent stream events (via patches).

---

## 3.6 `system`

Umbrella type with 14+ subtypes. See `04-system-subtypes.md` for each subtype's shape.

Every system message contains minimally:
```json
{
  "type": "system",
  "subtype": "...",
  "session_id": "...",
  "uuid": "..."
}
```

Notable: `session_id` and `uuid` are injected by `ZtH()` at flush time for vT-class subtypes (not always set at inner emit site); they're always present on main-generator subtypes.

---

## 3.7 `result`

Emitted exactly once per turn, last message of the turn.

**Anchors:** `12802423` (early shouldQuery=false exit), `12810124` (normal end), others by subtype — see table.

**Gate:** Always (one per turn).

### Shape (common)

```jsonc
{
  "type": "result",
  "subtype": "success"|"error_max_budget_usd"|"error_max_structured_output_retries"|"error_max_turns"|"error_during_execution",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 4567,
  "duration_api_ms": 2345,
  "num_turns": 3,
  "result": "<final assistant text>",
  "stop_reason": "end_turn"|"tool_use"|"max_tokens"|"stop_sequence"|"tool_deferred"|"tool_deferred_unavailable",
  "session_id": "...",
  "total_cost_usd": 0.0045,
  "usage": {...},
  "modelUsage": {...},
  "permission_denials": [...],
  "structured_output": {...},            // when --json-schema is used
  "terminal_reason": "...",              // from terminator (max-turns hook, cost gate, etc.)
  "fast_mode_state": {...},
  "uuid": "...",
  "errors": ["..."],
  "deferred_tool_use": { "id", "name", "input" }   // on tool_deferred* stop_reasons
}
```

### Subtype detail

| Subtype | Trigger | Key fields |
|---|---|---|
| `success` | Normal turn completion | `is_error:false`, `result` = last assistant text |
| `success` + `stop_reason:"tool_deferred"` | Hook deferred a tool | `deferred_tool_use` populated |
| `success` + `stop_reason:"tool_deferred_unavailable"` | MCP tool vanished mid-turn | `deferred_tool_use` populated |
| `error_max_budget_usd` | `--max-budget-usd` exceeded | `errors: ["Reached maximum budget ($N)"]`, `is_error:true` |
| `error_max_structured_output_retries` | JSON schema validation failed too many times | `errors: ["Failed to provide valid structured output after N attempts"]` |
| `error_max_turns` | `--max-turns` limit hit | `errors: ["Reached maximum number of turns (N)"]`, `num_turns` = exact count |
| `error_during_execution` | Stop-reason / content mismatch, or sandbox startup failure | `errors: ["[ede_diagnostic] result_type=... last_content_type=... stop_reason=...", ...]` |

### Ordering

The `result` is the LAST message of a turn. All other messages (stream_events, assistant, user, system) arrive before it. Consumer can treat `result` arrival as the turn-complete signal.

---

## 3.8 `tool_progress`

Periodic elapsed-time tick from a tool execution. Two variants.

**Anchors:** `6309812` (REPL), `6310593` (Bash/PowerShell).

### Bash/PowerShell variant

**Gate:** `CLAUDE_CODE_REMOTE=1` OR `CLAUDE_CODE_CONTAINER_ID` set. In stock local use, these do NOT fire. Rate-limited to ≤1 per `wV4` ms, LRU-bounded to `OV4` entries.

```jsonc
{
  "type": "tool_progress",
  "tool_use_id": "toolu_xxx",
  "tool_name": "Bash"|"PowerShell",
  "parent_tool_use_id": "...",
  "elapsed_time_seconds": 3.5,
  "task_id": "...",
  "session_id": "...",
  "uuid": "..."
}
```

### REPL variant

**Gate:** Always when REPL tool is in use.

```jsonc
{
  "type": "tool_progress",
  "tool_use_id": "...",
  "tool_name": "REPL",
  "parent_tool_use_id": "...",
  "elapsed_time_seconds": 0,
  "repl_call": {
    "inner_tool_name": "Read",
    "inner_tool_input": {...},
    "inner_tool_use_id": "...",
    "phase": "start"|"in_progress"|"complete"
  },
  "session_id": "...",
  "uuid": "..."
}
```

---

## 3.9 `tool_use_summary`

Summary of a tool-use sequence. Emitted when a `tool_use_summary` attachment flows through the main stream loop.

**Anchor:** `12806949`.

**Gate:** Always when the summary attachment is produced (typically after long tool sequences).

```jsonc
{
  "type": "tool_use_summary",
  "summary": "text",
  "preceding_tool_use_ids": ["toolu_...", "toolu_..."],
  "session_id": "...",
  "uuid": "..."
}
```

**Note:** Not currently typed in our `SDKMessage` union. May be dropped by the harness's type discriminator. Handle explicitly if needed.

---

## 3.10 `request_usage` (PATCHED)

Emitted after every `message_stop` — i.e., after each API call finishes within a turn.

**Anchor:** `12804937` (patched by `patch/request-usage/`).

**Gate:** Requires the `request-usage` ClaudeUI patch. Always fires when patched.

```jsonc
{
  "type": "request_usage",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_creation_input_tokens": 890,
    "cache_read_input_tokens": 100,
    "cache_creation": {...},
    "server_tool_use": {...}
  },
  "model": "claude-opus-4-7",
  "uuid": "...",
  "session_id": "..."
}
```

**Ordering:** Arrives before the corresponding `assistant` line with `stop_reason`. Consumer can attribute per-call token costs incrementally.

---

## 3.11 `rate_limit_event`

Two shape variants.

### Patched variant (`patch/rate-limit-relay`) — primary path in ClaudeUI

**Anchor:** `11176048`.

**Gate:** Patch applied. Always fires after streaming API calls.

```jsonc
{
  "type": "rate_limit_event",
  "header_utilization": {
    "five_hour": { "utilization": 0.35, "resets_at": 1711500000 },
    "seven_day": { "utilization": 0.12, "resets_at": 1712100000 }
  }
}
```

- `utilization` is **fractional (0.0–1.0)**, NOT percent.
- `resets_at` is epoch seconds.
- Omits `uuid`/`session_id`.

### Native variant (G_H listener)

**Anchor:** `12825090`.

**Gate:** OAuth user + unified rate-limit change. Rarely fires (dedup-gated).

```jsonc
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed"|"throttled"|...,
    "resetsAt": 1711500000,
    "rateLimitType": "...",
    ...
  },
  "uuid": "...",
  "session_id": "..."
}
```

**Handle both.** Consumer must check which shape is present.

---

## 3.12 `bash_output` (PATCHED)

Live Bash output from patched `onProgress` callback. Rate-limited ≤1 per 200ms per tool.

**Anchor:** `9180620` (patched by `patch/bash-output-streaming/`).

**Gate:** Patch applied. Rate-limited.

```jsonc
{
  "type": "bash_output",
  "tool_use_id": "toolu_xxx",
  "output": "<larger window, last ~100 lines>",     // larger window
  "full_output": "<smaller window, last ~5 lines>", // smaller window (naming is misleading)
  "total_lines": 42,
  "total_bytes": 1234
}
```

- Field names are misleading (inherited from `onProgress` arg positions).
- No `session_id` / `uuid`.
- Note: older patch README mentions `bash_output_init` — not present in current bundle; patch now uses `bash-early-poll` (calls `I3.startPolling()` directly).

---

## 3.13 `auth_status`

Authentication-status stream event.

**Anchors:** initial at `~12866602`; subscription updates at `~12824916`.

**Gate:** `--enable-auth-status` CLI flag (NOT the initialize payload field — see `02-cli-flags.md` and `09-initialize.md`).

```jsonc
{
  "type": "auth_status",
  "isAuthenticating": false,
  "output": "human-readable status",
  "error": null,
  "uuid": "...",
  "session_id": "..."
}
```

Fires once after initialize (if enabled) plus additional times when auth state changes.

---

## 3.14 `prompt_suggestion`

Prompt auto-suggest feature.

**Anchor:** `12838769`.

**Gate:** `promptSuggestions: true` in initialize payload + non-null suggestion from generator.

```jsonc
{
  "type": "prompt_suggestion",
  "suggestion": "text",
  "uuid": "...",
  "session_id": "..."
}
```

---

## 3.15 `transcript_mirror`

File-watching transcript mirror.

**Anchor:** `12823846`.

**Gate:** `sessionMirror: true` CLI flag (`--session-mirror`). **ClaudeUI does NOT use this** — documented here for completeness.

```jsonc
{
  "type": "transcript_mirror",
  "filePath": "/path/to/transcript.jsonl",
  "entries": [...]
}
```

---

## 3.16 `control_request`

cli.js initiating a request to us. Handled by `ControlChannel` — see `08-control-inbound.md`.

```jsonc
{
  "type": "control_request",
  "request_id": "<13-char random>",
  "request": { "subtype": "...", ... }
}
```

---

## 3.17 `control_response`

cli.js replying to a request WE initiated. Correlated by `request_id`. Consumed by `ControlChannel.handleResponse()`.

```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "success"|"error",
    "request_id": "<echoed>",
    "response": {...},                // on success
    "error": "...",                   // on error
    "pending_permission_requests": [...]  // side-channel on "Already initialized" error
  }
}
```

---

## 3.18 `control_cancel_request`

cli.js cancelling a pending request IT sent us. One-way, no response expected.

```jsonc
{
  "type": "control_cancel_request",
  "request_id": "<id>"
}
```

Handler fires the AbortController we registered via `beginInbound(request_id)`. See `11-cancellation.md`.

---

## 3.19 Per-turn ordering (stream-json + verbose mode)

Typical sequence within one user turn:

```
1.  system/init                         (first turn of session only)
2.  system/status (status:"requesting")       [gate: includePartialMessages]
3.  stream_event message_start                [gate: includePartialMessages]
4.  assistant                           (partial, shared id with stream_event)
5.  stream_event content_block_* (many)       [gate: includePartialMessages]
6.  assistant                           (partial, refined)
7.  request_usage                       [PATCHED, after message_stop]
8.  stream_event message_stop                 [gate: includePartialMessages]
9.  rate_limit_event                    [PATCHED]
10. user (synthetic tool_result)        (per tool_use in assistant)
11. tool_progress (possibly many)       [gated]
12. bash_output (possibly many)         [PATCHED]
13. system/task_started, task_updated,  (if tools spawn tasks)
    task_progress
14. (loop to step 3 for additional API turns in multi-turn tool sequence)
15. system/task_notification            (when tasks complete)
16. system/compact_boundary             (if compaction triggered)
17. result                              (terminal; EXACTLY ONE per turn)
```

Subagent messages nest inside step 10 (each with `parent_tool_use_id`). Teammate messages use `teammate_id`.

Control-channel messages (`control_request`/`control_response`/`control_cancel_request`, `auth_status`, `prompt_suggestion`, `bridge_state`) interleave freely — no turn-boundary correlation.

---

## 3.20 Patches vs. unpatched

Messages that exist ONLY because of ClaudeUI patches:
- `request_usage` — `patch/request-usage`
- `rate_limit_event` (header_utilization variant) — `patch/rate-limit-relay`
- `bash_output` — `patch/bash-output-streaming`
- `system/queued_command_consumed` — `patch/queue-control`
- Subagent `stream_event` with `parent_tool_use_id` — `patch/subagent-streaming` (filter 0 unblock)
- All teammate-tagged messages — `patch/team-streaming`

An unpatched upstream cli.js omits these. If the harness ever runs against unpatched cli.js, don't assume these exist.
