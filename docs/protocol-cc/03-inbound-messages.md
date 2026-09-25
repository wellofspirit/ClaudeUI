# 03 — Inbound messages (cli.js → us)

Every top-level `type` cli.js writes to stdout in `--output-format stream-json --verbose` mode. Every line is `{...}\n`.

Verified against cli.js 2.1.114 (patched). Emission architecture detail at `_research_outbound_messages.md` if you need the fine-grained anchors.

---

## 3.1 Emission architecture

cli.js has **three** paths that reach stdout:

1. **Main generator pipeline** (`Ts1` → `M.write(line)`) at char `~12822400`. Everything yielded by the turn generator passes through here.
2. **Control channel** (`h.enqueue`) at char `~12843100+`. Control responses/cancels plus some out-of-band system events (auth_status, rate_limit_event native, permission-mode status, prompt_suggestion, transcript_mirror).
3. **Direct `process.stdout.write`** — used by the ClaudeUI patches that emit messages (`bash-output-streaming`, subagent-streaming E/G; formerly the retired team-streaming B).

A fourth pseudo-path queues vT-class system subtypes (`task_notification`, `task_started`, `task_updated`, `task_progress`, `notification`) through `JtH`, flushed by `ZtH()` at char `~12838006` / `~12840696` (which injects `uuid` + `session_id` at flush time).

---

## 3.2 Catalog

| Type                     | Emitted by                                      | Gate                                                                              | See                                        |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `assistant`              | Generator                                       | Always                                                                            | §3.3                                       |
| `user`                   | Generator (synthetic tool_result + replays)     | Always                                                                            | §3.4                                       |
| `stream_event`           | Generator                                       | `--include-partial-messages`                                                      | §3.5, and `05-stream-events.md` for deltas |
| `system`                 | Generator + vT queue + control channel          | Varies per subtype                                                                | §3.6 + `04-system-subtypes.md`             |
| `result`                 | Generator                                       | Always (once per turn)                                                            | §3.7                                       |
| `tool_progress`          | Generator                                       | `CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID` for bash/pwsh; always for REPL | §3.8                                       |
| `tool_use_summary`       | Generator                                       | Always when tool_use_summary attachment produced                                  | §3.9                                       |
| `rate_limit_event`       | Native, print loop (builder `bKe`, at 22241254) | OAuth sessions; when a window's rounded percentage or reset time moves            | §3.11                                      |
| `bash_output`            | Patch `bash-output-streaming` (direct stdout)   | Rate-limited ≤1/200ms per tool                                                    | §3.12                                      |
| `auth_status`            | Control channel                                 | `--enable-auth-status` flag                                                       | §3.13                                      |
| `prompt_suggestion`      | Control channel                                 | `promptSuggestions: true` in initialize                                           | §3.14                                      |
| `transcript_mirror`      | Direct write from file watcher                  | `sessionMirror: true` (ClaudeUI doesn't use)                                      | §3.15                                      |
| `command_lifecycle`      | Native lifecycle forwarder (`mw`, at 22677075)  | The inbound `user` frame carried a `uuid` (ClaudeUI: every frame)                 | §3.21                                      |
| `control_request`        | Control channel                                 | Per inbound subtype — see `08-control-inbound.md`                                 | §3.16                                      |
| `control_response`       | Control channel                                 | One per inbound outbound control_request                                          | §3.17                                      |
| `control_cancel_request` | Control channel                                 | On abort of pending inbound control_request                                       | §3.18                                      |

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

### Teammate variant (patch `team-streaming-B` — retired)

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

- **`message.id`** is stable across partial updates. A single assistant reply emits ONE `assistant` line per content block: each carries a single-block `content`, all share `message.id`, and each arrives after that block's last `content_block_delta` but BEFORE its `content_block_stop`. The `tool_use` line already carries the fully parsed `input`. Consumer should upsert by id (replace in place) and place each line's block by index/type — see `05-stream-events.md` §5.9. Verified on 2.1.268, 2026-09-18, localhost SSE fixture.
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

### Trigger 3 — Echo of a user frame we sent (`--replay-user-messages` only)

With `--replay-user-messages`, an inbound `user` frame that carried a `uuid` is echoed back as
`{type:"user", message, uuid: <client uuid>, isReplay: true, …}` as soon as cli.js accepts it
into its command queue (2.1.280, `.cache/pristine-cli.js` @22833639). ClaudeUI does not pass the
flag; it learns what happened to a message from `command_lifecycle` (§3.21).

Shape same as Trigger 2.

### Trigger 4 — Duplicate message ACK

An inbound `user` frame whose `uuid` cli.js has already received in this process, or finds
already persisted in the session transcript, is skipped as a duplicate (`skipDuplicate` @22456715,
called from the stdin loop @22829853). With `--replay-user-messages` the skip is acknowledged by
an `isReplay: true` echo; a duplicate that was persisted but not received by this process also
gets a `command_lifecycle` `completed`. The one exception: a persisted message whose turn went
unanswered is re-run when nothing else is queued. A host must therefore never reuse a uuid.

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

Per patch `team-streaming-B` (retired) at char `8648903`:

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

### Cumulative vs per-turn fields (probed 2026-07-15 against the pinned binary)

- **`total_cost_usd` and `modelUsage` are CUMULATIVE within one cli.js process** —
  turn 2's values include turn 1's. They reset to zero when a process is
  respawned with `--resume` (a resumed process reports only post-resume usage;
  no restore of the prior tracker). Consumers must REPLACE, never `+=`, per
  process, and fold across process boundaries (see claude-session.ts's
  `costBaseUsd`/`liveTotalCostUsd` split and cross-engine-dispatcher.ts's
  `lastReportedTotalCostUsd` delta baseline).
- **`usage`, `duration_ms`, `duration_api_ms` are PER-TURN.**
- `modelUsage` entry shape (per model id key):
  `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
webSearchRequests, costUSD, contextWindow, maxOutputTokens }` — `costUSD` is
  the authoritative per-model cost (cumulative, as above).
- **`result` records are NOT persisted to transcript JSONL** (verified across
  46 real transcripts) — cost/duration are not recoverable from a transcript;
  ClaudeUI reconstructs duration from line-timestamp turn spans and cost from
  per-message `model` + `usage` × pricing tables (session-history.ts).

### Subtype detail

| Subtype                                               | Trigger                                                    | Key fields                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `success`                                             | Normal turn completion                                     | `is_error:false`, `result` = last assistant text                                          |
| `success` + `stop_reason:"tool_deferred"`             | Hook deferred a tool                                       | `deferred_tool_use` populated                                                             |
| `success` + `stop_reason:"tool_deferred_unavailable"` | MCP tool vanished mid-turn                                 | `deferred_tool_use` populated                                                             |
| `error_max_budget_usd`                                | `--max-budget-usd` exceeded                                | `errors: ["Reached maximum budget ($N)"]`, `is_error:true`                                |
| `error_max_structured_output_retries`                 | JSON schema validation failed too many times               | `errors: ["Failed to provide valid structured output after N attempts"]`                  |
| `error_max_turns`                                     | `--max-turns` limit hit                                    | `errors: ["Reached maximum number of turns (N)"]`, `num_turns` = exact count              |
| `error_during_execution`                              | Stop-reason / content mismatch, or sandbox startup failure | `errors: ["[ede_diagnostic] result_type=... last_content_type=... stop_reason=...", ...]` |

### Ordering

The `result` is the LAST message of a turn. All other messages (stream_events, assistant, user, system) arrive before it. Consumer can treat `result` arrival as the turn-complete signal — but **turn-complete ≠ conversation-idle**, see below.

### `result` vs background tasks (probed 2026-08-26 against 2.1.241)

A `result` marks the end of the MAIN agent's turn only. It carries **no field** indicating that
background tasks are still running, and it fires even while they are:

- **Launch + end turn:** `assistant` (Agent tool_use) → `system/task_started` (`local_agent`) →
  synthetic tool_result ("Async agent launched successfully") → assistant text → `result`
  (`stop_reason: "end_turn"`), all while the subagent keeps streaming (its `assistant`/`stream_event`
  messages with `parent_tool_use_id` continue AFTER this `result`).
- **Idle-time completion** (task finishes while the main agent is between turns): cli.js
  auto-continues the conversation — `system/task_notification` → a **fresh `system/init`** →
  assistant message(s) → that turn's own `result` (`num_turns` restarts at 1). No user-role
  `<task-notification>` XML message was observed on the wire for `local_agent` completions in
  2.1.241 — the prompt injection is internal to cli.js (older versions re-emitted it; the
  claude-session.ts handler for that shape is kept for compatibility).
- **Mid-turn completion** (task finishes while the main turn is still running): the notification is
  absorbed into the CURRENT turn — `system/task_notification` arrives before the turn's single
  `result`, and no intermediate `result` exists.

Consequence for consumers: "the conversation is waiting for the user" must be derived by tracking
`task_started`/`task_notification` (§4.5/§4.4) and checking for active auto-continuing task types at
`result` time. Because mid-turn completions are absorbed, that tracked state is always accurate at
the moment a `result` is observed. cli.js's own interactive UI uses the same rule (busy predicate
`S3e`/`rsi`, `cli.js@char3683025` in 2.1.241): active tasks of type `local_agent`, `remote_agent`
(unless `isLongRunning`), `in_process_teammate` (unless `isIdle`), or `local_workflow` ⇒ busy;
`local_bash` shows as idle-with-shell; monitor types never count as busy. ClaudeUI mirrors this in
the `session:result` observer (`useClaudeEvents.ts`) to gate the "Ready for input" notification.

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

## 3.10 `request_usage` (retired)

Emitted only by the deleted `request-usage` patch; no build since 2.1.280 writes it. The same per-request numbers arrive natively on `stream_event` `message_start` (`message.usage`) and `message_delta` (`usage`) — see `05-stream-events.md`.

---

## 3.11 `rate_limit_event`

Subscription rate-limit state, parsed from the `anthropic-ratelimit-unified-*` headers of the
inference responses. Native; the `rate-limit-relay` patch that used to add a
`header_utilization` field was deleted at 2.1.280.

**Anchor (2.1.280, `.cache/pristine-cli.js`):** `rate_limit_info` schema `nSr` @2128537; the
builder `bKe` (@22241254) fills `unifiedWindows` from the account state via `Xr`, and the print
loop enqueues the event (`let I=bKe(h);if(!I)return;if(Ee.enqueue(I),…` @22708343).

**Gate:** OAuth subscription sessions. `unifiedWindows` is absent until the first response
carrying the headers, and always absent for API-key, Bedrock and Vertex sessions.

```jsonc
// probes/rate-limit-relay/official.three-turn.jsonl:7 (official 2.1.280, Haiku 4.5)
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed", // "allowed" | "allowed_warning" | "rejected" — the LIMITING window
    "resetsAt": 1790209200, // epoch seconds, limiting window
    "rateLimitType": "five_hour", // which window is limiting
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled_until",
    "isUsingOverage": false,
    "unifiedWindows": {
      "five_hour": { "utilization": 0.77, "resetsAt": 1790209200 },
      "seven_day": { "utilization": 0.29, "resetsAt": 1790398800 }
      // "seven_day_overage_included": {…} — per-model weekly bucket, only for accounts that have one
    }
  },
  "uuid": "...",
  "session_id": "..."
}
```

- `unifiedWindows.<window>.utilization` is a **fraction**, usually 0–1. The schema says values
  above 1 occur "when usage legitimately runs past a window's cap". `resetsAt` is epoch seconds.
  cli.js drops a window whose `resetsAt` has already passed (`va` @13719730).
- The top-level `status` / `resetsAt` / `rateLimitType` / `utilization` describe only the
  currently limiting window. `utilization` there is present only in some states.
  `unifiedWindows` tracks every window on every observation.

**When it fires.** The schema describes it as: "events are emitted when a window's rounded
percentage or reset time moves, not only on status transitions". Observed on the official binary
(`probes/rate-limit-relay/probe-change.out.txt`): four turns 45 s apart, five-hour utilization
0.78 → 0.79 → 0.79 → 0.80, produced three events. The turn that left every window at the same
rounded percentage produced none. So expect at most one event per turn, and none for most turns
of a long session.

**Consumer:** `ClaudeSession.handleRateLimitEvent` → `usageFetcher.updateFromRateLimitWindows`
(`five_hour` → `fiveHour`, `seven_day` → `sevenDay`, fraction × 100, epoch → ISO). The other
windows keep their values from the last `/api/oauth/usage` read.

---

## 3.12 `bash_output` (PATCHED)

Live Bash output from patched `onProgress` callback. Rate-limited ≤1 per 200ms per tool.

**Anchor:** `9180620` (patched by `patch/bash-output-streaming/`).

**Gate:** Patch applied. Rate-limited.

```jsonc
{
  "type": "bash_output",
  "tool_use_id": "toolu_xxx",
  "output": "<larger window, last ~100 lines>", // larger window
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
7.  stream_event message_delta (usage)        [gate: includePartialMessages]
8.  stream_event message_stop                 [gate: includePartialMessages]
9.  rate_limit_event                    [only when a window moved]
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

A user frame that carried a `uuid` adds `command_lifecycle` frames (§3.21): `queued` + `started`
ahead of step 1 when it starts the turn, and `started` right after a step-10 tool_result when a
running turn folds it in.

Control-channel messages (`control_request`/`control_response`/`control_cancel_request`, `auth_status`, `prompt_suggestion`, `bridge_state`) interleave freely — no turn-boundary correlation.

---

## 3.20 Patches vs. unpatched

Messages that exist ONLY because of ClaudeUI patches:

- `bash_output` — `patch/bash-output-streaming`
- Subagent `stream_event` with `parent_tool_use_id` — `patch/subagent-streaming` (filter 0 unblock)

(Teammate-tagged messages came from `team-streaming`, retired with its directory — 01 §1.12.)

An unpatched upstream cli.js omits these. The app does run against unpatched cli.js — Anthropic's own binary, via `CLAUDEUI_CLAUDE_CLI` (ADR-077) — so never assume these exist: the cards render what arrives and fall back to complete messages and the final tool result. The `voice_server_*` control subtypes (07) are the other patch-only surface; the app gates them on `version.json` `patches` (01 §1.12).

---

## 3.21 `command_lifecycle`

What happened to one inbound `user` frame, named by the client `uuid` that frame carried. Native;
it replaced the `queue-control` patch's `system/queued_command_consumed` (04 §4.10) for ClaudeUI
on 2026-09-25. cli.js emits **nothing** for a frame sent without a `uuid` — which is why, on the
official binary, a uuid-less queued message sat QUEUED on the card past the point the model read
it. It also emits frames for commands it enqueues itself (cron triggers, teammate shutdown
prompts, deferred-turn resume): those mint a fresh uuid and emit `started` and a terminal state
without `queued`.

**Anchors (2.1.280, `.cache/pristine-cli.js`):** schema `Ev` @2234189 (described as "@internal
Fate of a queued command"); the stdout forwarder `mw` @22677075, which stamps the frame's own
`uuid` and `session_id`; mid-turn fold `started` @14791535; between-turns drain `startBatch`
@22454143.

**Gate:** the inbound `user` frame carries `uuid` (06 §6.2). The inbound schema types it as a plain
string (`ns` @2125908, `uuid: m().optional()` with `m = o()`), so nothing checks its format; it
must be unique (§3.4 Trigger 4).

```jsonc
{
  "type": "command_lifecycle",
  "command_uuid": "d6a3baa8-e2c7-4b64-89ae-87dd294bece0", // the uuid OUR user frame carried
  "state": "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused",
  "uuid": "504cc05e-ef36-48fc-bf70-8f81b19fcc30",         // this frame's own id
  "session_id": "903d5166-8025-4343-b927-eddd67c69bfb"
}
```

| `state`     | Meaning (from the schema description)                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | The message entered the command queue.                                                                                                                                                                                                                                |
| `started`   | It drained into a turn: folded into the running turn at a tool boundary, or taken as the prompt of a fresh turn. **The consumption signal.**                                                                                                                          |
| `completed` | The turn that consumed it ended cleanly. For a fold, before that turn's `result`; for a message that started a turn, after it.                                                                                                                                        |
| `cancelled` | Removed by `cancel_async_message`, swept by an `interrupt` with `cancel_queued: true`, caught by a pending cancel just before dispatch (07, `cancel_async_message`), or consumed into a turn that was aborted or died on a hard failure — so it can FOLLOW `started`. |
| `discarded` | The session ended (`end_session`) with the message still queued.                                                                                                                                                                                                      |
| `refused`   | Declined by the session's receive-side policy before entering the queue. Never preceded by `queued`; it will not run.                                                                                                                                                 |

Not a strict pairing: a terminal state can arrive without a `started`, and a turn that fails by
throwing can leave `started` without a terminal state.

**Observed ordering** (official 2.1.280, Haiku, 2026-09-24; `probes/queue-control/official.uuid.jsonl`):

```
mid-turn — sent while a foreground Bash ran
t=5817   → user {uuid: d6a3…}
t=5818   command_lifecycle queued        (1 ms after the frame)
t=17199  user (tool_result of that Bash)
t=17204  command_lifecycle started       (the fold, 5 ms after the tool_result)
         … assistant, answering it
t=20052  command_lifecycle completed
t=20054  result

between turns — sent 1.5 s after the previous result
t=21554  → user {uuid: 8c3b…}
t=21555  command_lifecycle queued
t=21556  command_lifecycle started
t=21561  system/init
         … the turn
t=23615  result
t=23616  command_lifecycle completed
```

A message still queued when a turn ends — the turn reached no further tool boundary to fold it at —
is drained the same way immediately after that turn's `result`, so its `started` follows the
`result`.

**Consumer hazard.** The frames carry `session_id`, and `queued`/`started` precede the turn's
`system/init`. A bootstrap latch keyed on "the first message carrying a `session_id`" is tripped by
them (04 §4.2).

**Transcript.** A message drained as a fresh turn is persisted as the `user` line, with `uuid` = the
client uuid. A message folded mid-turn is persisted at the fold as
`{type:"attachment", attachment:{type:"queued_command", prompt, source_uuid: <client uuid>, commandMode:"prompt", …}}`,
where `prompt` is the frame's `message.content` (a string, or a block array when it carried images
or a PDF).

**ClaudeUI.** `ClaudeSession` sends a queued item under its `itemId` and every other prompt under a
fresh uuid. `handleCommandLifecycle`: `started` → `SessionQueue.consumeById(command_uuid)`, which
places the steer bubble at the true consumption point; `cancelled` → `recallById` (no-op for an
item already consumed); `discarded`/`refused` → `recallById` + `session:warning`; `queued` and
`completed` change nothing. A uuid the queue never saw — every ordinary send, every command cli.js
enqueues itself — is a no-op.
