# 04 — System message subtypes

Every `{type: 'system', subtype: 'X', ...}` variant cli.js emits. Verified against 2.1.114 (patched). Sections 4.20–4.27 and the §4.17 shape were added against 2.1.170 — their anchors are 2.1.170 char offsets.

Every `system` message includes minimally:

```json
{
  "type": "system",
  "subtype": "<name>",
  "session_id": "...",
  "uuid": "..."
}
```

Exception: `session_state_changed` has no `session_id`/`uuid` (raw emit, not through the flush path).

---

## 4.1 Quick catalog

| Subtype                   | Gate                                             | Emitter path                     |
| ------------------------- | ------------------------------------------------ | -------------------------------- |
| `init`                    | Always (first turn)                              | Main generator                   |
| `status`                  | Varies per variant                               | Main generator / control channel |
| `task_notification`       | Always                                           | vT queue                         |
| `task_started`            | Always                                           | vT queue                         |
| `task_updated`            | Always                                           | vT queue                         |
| `task_progress`           | Always                                           | vT queue                         |
| `compact_boundary`        | On conversation compaction                       | Main generator                   |
| `api_retry`               | On API error + auto-retry                        | Main generator                   |
| `queued_command_consumed` | Patch `queue-control`                            | Main generator (patched)         |
| `hook_started`            | `--include-hook-events`                          | Hook subscriber                  |
| `hook_progress`           | `--include-hook-events`                          | Hook subscriber                  |
| `hook_response`           | `--include-hook-events`                          | Hook subscriber                  |
| `bridge_state`            | `remote_control` active                          | Control channel                  |
| `session_state_changed`   | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`        | Direct emit                      |
| `notification`            | Error conditions                                 | vT queue                         |
| `memory_recall`           | Memory feature returns results                   | Main generator                   |
| `plugin_install`          | `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`              | Main generator                   |
| `post_turn_summary`       | @internal background summarizer                  | Main generator                   |
| `model_refusal_fallback`  | On unless `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | Main generator (§4.20)           |
| `model_fallback`          | Fallback model configured + availability error   | Main generator (§4.21)           |
| `thinking_tokens`         | Thinking deltas during streaming                 | Main generator (§4.22)           |
| `commands_changed`        | Mid-session slash-command list change            | stream-json module (§4.23)       |
| `elicitation_complete`    | MCP URL-mode elicitation completes               | stream-json module (§4.24)       |
| `permission_denied`       | Tool call auto-denied without prompt             | Control channel (§4.25)          |
| `mirror_error`            | Transcript-mirror write failure                  | SessionStore mirror (§4.26)      |

Subtypes that exist in the SDK schema union but are **not** emitted on the SDK stdout wire are cataloged in §4.27.

---

## 4.2 `init`

Session-start snapshot. Exactly one per session, immediately after initialize's control_response.

**Anchor:** builder `e86` at char `11322500`; yield at `12800961`.

**Gate:** Always.

**Ordering:** First `system` message. Consumer uses this to resolve temp routingId → real session UUID.

### Shape

```jsonc
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/workdir",
  "session_id": "...",
  "tools": ["Bash", "Read", "Edit", ...],
  "mcp_servers": [
    {
      "name": "filesystem",
      "status": "connected"|"pending"|"failed"|"disabled"
    }
  ],
  "model": "claude-opus-4-7",
  "permissionMode": "default"|"acceptEdits"|"bypassPermissions"|"plan"|"auto"|"dontAsk",
  "slash_commands": ["help", "model", ...],
  "apiKeySource": "api_key"|"oauth"|"none",
  "betas": ["..."],
  "claude_code_version": "2.1.114",
  "output_style": "normal",
  "agents": ["general", "researcher", ...],
  "skills": ["skill-name", ...],
  "plugins": [
    { "name": "...", "path": "...", "source": "..." }
  ],
  "plugin_errors": [
    { "plugin": "...", "type": "...", "message": "..." }
  ],
  "memory_paths": {
    "auto": "~/.claude/...",
    "team": "~/.claude/team-mem/..."
  },
  "fast_mode_state": {...},
  "uuid": "..."
}
```

### Field notes

- **`plugin_errors`** — omitted when empty.
- **`memory_paths`** — only when user-memory feature enabled (`uf()` truthy). `memory_paths.team` only when team memory enabled.
- **`uuid`** — new randomUUID per init message; unrelated to `session_id`.
- **`fast_mode_state`** — only emitted when eligible account (see `09-initialize.md`).

This is the authoritative source for session_id, current model, active permissionMode, available tools / commands / skills / agents / plugins / MCP servers. The `initialize` control_response has complementary data (models/commands/agents arrays with more detail). Our harness reads both — init for runtime state, control_response for catalog data.

---

## 4.3 `status`

Three variants, same basic shape.

### Variant A — Stream request start

**Anchor:** `~12806300`.

**Gate:** `--include-partial-messages` (`includePartialMessages: true`).

```json
{
  "type": "system",
  "subtype": "status",
  "status": "requesting",
  "session_id": "...",
  "uuid": "..."
}
```

Fires when a new API request begins streaming.

### Variant B — Permission mode change

**Anchor:** `~12824600`.

**Gate:** Always. Fires on `set_permission_mode` control request or internal mode change.

```jsonc
{
  "type": "system",
  "subtype": "status",
  "status": null,
  "permissionMode": "default"|"acceptEdits"|...,
  "session_id": "...",
  "uuid": "..."
}
```

### Variant C — SDK status callback (compaction)

**Anchor:** `~12837335`.

**Gate:** Always. Fires on arbitrary SDK-status updates, notably compaction results.

```jsonc
{
  "type": "system",
  "subtype": "status",
  "status": "...",
  "compact_result": {...},           // after successful compaction
  "compact_error": "...",            // after failed compaction
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.4 `task_notification`

A task (background agent, Bash shell, subagent, in-process teammate) reached a terminal state.

**Anchors:** `FY` emitter at `3995289`; subagent at `7820041`; team-streaming-C at `8650876`; XML re-emission at `12834859`.

**Gate:** Always.

### Shape

```jsonc
{
  "type": "system",
  "subtype": "task_notification",
  "task_id": "t123abc"|"a123abc"|"r123abc"|"agentname@team",
  "tool_use_id": "toolu_...",
  "status": "completed"|"failed"|"stopped",
  "output_file": "/path/to/output",        // empty string when no file
  "summary": "text summary",
  "usage": {
    "total_tokens": 1234,
    "tool_uses": 5,
    "duration_ms": 6789
  },                                        // may be omitted when no usage data
  "skip_transcript": false,                 // optional; true = don't record in transcript
  "session_id": "...",
  "uuid": "..."
}
```

### `task_id` format by task type

- Background bash: `t` + 6 hex chars (e.g., `tabc123`)
- Background agent (local_agent): `a` + 6 hex chars
- In-process teammate: `name@team` (e.g., `ts-advocate@lang-debate`)
- Remote agent: `r` + 6 hex chars

### `status` values

- `completed` — normal completion
- `failed` — error exit
- `stopped` — user-initiated stop (upstream `killed` is mapped to `stopped` in 2.1.114; the `taskstop-notification` patch is a no-op on recent versions)

---

## 4.5 `task_started`

A task transitions from non-existent to existing (first `setAppState` update).

**Anchor:** `4891300` inside `KD4(H, $)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_started",
  "task_id": "...",
  "tool_use_id": "...",
  "description": "...",
  "task_type": "local_bash"|"local_agent"|"in_process_teammate"|"local_workflow",
  "workflow_name": "...",                  // optional
  "prompt": "...",                          // optional
  "skip_transcript": false,
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.6 `task_updated`

Patch diff of a task's state changes.

**Anchor:** `4890453` inside `$D4(H, $, q)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_updated",
  "task_id": "...",
  "patch": {
    /* fields that changed — subset of task shape */
  },
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.7 `task_progress`

Periodic progress snapshot.

**Anchor:** `7649634` inside `xc8(H)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_progress",
  "task_id": "...",
  "tool_use_id": "...",
  "description": "...",
  "usage": {
    "total_tokens": 123,
    "tool_uses": 4,
    "duration_ms": 5678
  },
  "last_tool_name": "Read",                // optional
  "summary": "...",                         // optional
  "workflow_progress": {...},               // optional — for local_workflow tasks
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.8 `compact_boundary`

Conversation compaction boundary. Emitted when cli.js compacts the transcript and inserts a boundary marker.

**Anchors:** `12801876` (compact-only turn early exit), `12806585` (main stream loop).

**Gate:** Always (when compaction triggers).

```jsonc
{
  "type": "system",
  "subtype": "compact_boundary",
  "session_id": "...",
  "uuid": "...",
  "compact_metadata": {
    "preservedSegment": { "tailUuid": "..." },
    ...
  }
}
```

**Field notes:** `compact_metadata` goes through `te8()` normalizer — preserve the entire object for replays.

---

## 4.9 `api_retry`

API error triggered automatic retry inside the streaming layer.

**Anchor:** `12806731`.

**Gate:** Always (when API error triggers retry).

```jsonc
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 2,
  "max_retries": 5,
  "retry_delay_ms": 1500,
  "error_status": 529, // HTTP status, null if non-HTTP
  "error": {
    /* normalized via U9K() */
  },
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.10 `queued_command_consumed` (PATCHED)

Mid-turn queued steer consumed as an attachment.

**Anchor:** `12805826` (patched by `patch/queue-control`).

**Gate:** Requires `queue-control` patch.

```jsonc
{
  "type": "system",
  "subtype": "queued_command_consumed",
  "prompt": "the queued user text",
  "source_uuid": "...",
  "session_id": "...",
  "uuid": "..."
}
```

**Ordering:** Followed by a `user` message with `isReplay: true` when `replayUserMessages=true`. UI uses this to dismiss the "queued" card and show the text as a normal user message.

---

## 4.11 Hook lifecycle — `hook_started`, `hook_progress`, `hook_response`

Internal hook events transformed by the `KGK` subscriber at char `4914613`. A dispatcher at char `12819444` subscribes when `--include-hook-events` + stream-json verbose.

**Anchors:**

- Dispatcher: `12819444`
- `hook_started` transformer: `12819588`
- `hook_progress` transformer: `12819602`
- `hook_response` transformer: `12819795`

**Gate:** `--include-hook-events` flag. Without it, `KGK` is never subscribed and these don't fire.

### `hook_started`

```jsonc
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "...",
  "hook_name": "PreToolUse",
  "hook_event": "...",
  "uuid": "...",
  "session_id": "..."
}
```

### `hook_progress`

```jsonc
{
  "type": "system",
  "subtype": "hook_progress",
  "hook_id": "...",
  "hook_name": "...",
  "hook_event": "...",
  "stdout": "partial stdout...",
  "stderr": "...",
  "output": "combined...",
  "uuid": "...",
  "session_id": "..."
}
```

### `hook_response`

```jsonc
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "hook_name": "...",
  "hook_event": "...",
  "output": "full output",
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "outcome": "allow"|"deny"|...,
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.12 `bridge_state`

Remote-control bridge state changes.

**Anchor:** `12856963`.

**Gate:** `remote_control` is actively enabled on the session. No-op otherwise.

```jsonc
{
  "type": "system",
  "subtype": "bridge_state",
  "state": "connecting"|"connected"|"failed"|...,
  "detail": "human-readable reason",       // optional
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.13 `session_state_changed`

Session state machine transition.

**Anchor:** `11924745`.

**Gate:** `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. Off by default.

```jsonc
{
  "type": "system",
  "subtype": "session_state_changed",
  "state": "idle"|"running"|"waiting"|...
}
```

**Field notes:** No `session_id` / `uuid` — raw emit, not flushed via `ZtH`.

---

## 4.14 `notification`

Error-condition notifications.

**Anchors:**

- `auto-mode-gate-plan-exit-fallback` at `~8376881`
- `stop-hook-error` at `~8610623`
- `error-compacting-conversation` at `~8914817`

**Gate:** Always (conditional on the respective error).

```jsonc
{
  "type": "system",
  "subtype": "notification",
  "key": "auto-mode-gate-plan-exit-fallback"|"stop-hook-error"|"error-compacting-conversation",
  "text": "human-readable message",
  "priority": "immediate"|...,
  "color": "warning"|"error"|...,
  "timeout_ms": 10000,
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.15 `memory_recall`

Emitted when cli.js loads relevant memories as an attachment (via `relevant_memories` attachment type).

**Anchors:** builder `Y17` at `12792370`; yield at `12805290`.

**Gate:** Always (when memory feature returns results).

```jsonc
{
  "type": "system",
  "subtype": "memory_recall",
  "mode": "synthesize"|"select",
  "memories": [
    {
      "path": "~/.claude/memory/ctx.md",
      "scope": "personal"|"project"|"team",
      "content": "..."                     // only present on synthesize mode entries
    }
  ],
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.16 `plugin_install`

Progress updates from plugin-install flow.

**Anchor:** `12831306`.

**Gate:** `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` env var.

```jsonc
{
  "type": "system",
  "subtype": "plugin_install",
  "status": "started"|"installed"|"failed"|...,
  "name": "plugin-name",
  "error": "error message",               // only on failed
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.17 `post_turn_summary`

Background post-turn summary emitted after each assistant turn (marked `@internal` in the SDK schema).

**Anchor (2.1.170):** schema `RF8` at `~7077561`.

```jsonc
{
  "type": "system",
  "subtype": "post_turn_summary",
  "summarizes_uuid": "...", // assistant message this summarizes
  "status_category": "...",
  "status_detail": "...",
  "needs_action": "...",
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.18 Filter behavior

The outer filter at char `12822512` lists subtypes excluded from `--output-format json` aggregation:

- `session_state_changed`
- `task_notification`
- `task_started`, `task_updated`, `task_progress`
- `notification`
- `post_turn_summary`

**In stream-json + verbose (our mode), the filter is a no-op** — every system message reaches stdout.

---

## 4.19 Consumer guidance

- **`init`** — always handle. First-message parsing for session metadata.
- **`status`** — handle all three variants. Differentiate by presence of `permissionMode` vs `compact_result` vs bare `status: "requesting"`.
- **`task_*`** — correlate by `task_id` in the client. `task_started` → `task_progress` (many) → `task_notification`.
- **`compact_boundary`** — preserve `compact_metadata` for session replay.
- **`api_retry`** — show in UI if visible. `retry_delay_ms` tells the user how long they're waiting.
- **`queued_command_consumed`** — dismiss the corresponding queued-card UI element.
- **`hook_*`** — expose in a debug panel; not typically user-facing.
- **`bridge_state`** — update remote-control status UI.
- **`session_state_changed`** — only handle when your workflow enables the env var; otherwise ignore.
- **`notification`** — surface as a toast / banner per `priority`/`color`/`timeout_ms`.
- **`memory_recall`** — log or show which memories were loaded.
- **`plugin_install`** — show install progress UI when the env var is set.
- **`model_refusal_fallback`** — render a persistent warning banner (the model switch is sticky for the session); evict `retracted_message_uuids` from transcript state; update any model indicator. See §4.20.
- **`model_fallback`** — render a warning for the current turn only (turn-scoped swap). See §4.21.
- **`thinking_tokens`** — optional spinner/pill progress; not authoritative token counts.
- **`commands_changed`** — REPLACE the cached slash-command list with the payload (a re-fetch returns the stale init list).
- **`elicitation_complete`** — dismiss any pending MCP elicitation UI.
- **`permission_denied`** — render the auto-denial on the tool call instead of only showing an `is_error` tool_result.
- **`mirror_error`** — log; surfaces transcript-mirror data loss.

Unknown subtypes: log and pass through. Don't silently drop.

---

## 4.20 `model_refusal_fallback`

Emitted when the primary model ends the stream with `stop_reason: "refusal"` and the CLI retries the turn once on a fallback model. **The swap is persistent for the rest of the session** (`direction: "retry"`). The enum values `"revert"` and `"sticky"` are retained for SDK-consumer compat and are no longer emitted.

This fires without any user-configured fallback model — it's a built-in safety-refusal recovery path (e.g. Fable 5 refusal → Opus 4.8).

**Anchors (2.1.170):**

- Gate fn `ed()` at `2535147`: `return !$_.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`
- Schema `WkO` at `~7083170`
- Internal builder `dxK` at `10478678`
- SDK emitter yields at `16271622` / `16271675` (inside the main generator's `case "system"`)
- Push-channel variant at `16088919`

**Gate:** On by default; disabled only by `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` env var.

### Shape (wire, snake_case)

```jsonc
{
  "type": "system",
  "subtype": "model_refusal_fallback",
  "trigger": "refusal",
  "direction": "retry", // "revert"|"sticky" legacy, no longer emitted
  "original_model": "claude-fable-5[1m]",
  "fallback_model": "claude-opus-4-8",
  "request_id": "req_...", // nullable
  "api_refusal_category": "cyber", // nullable/absent; open string ("cyber", "bio", …)
  "api_refusal_explanation": "...", // nullable/absent; unstable prose — display only
  "retracted_message_uuids": ["..."], // optional; see below
  "content": "…safety measures flagged this message… Switched to Opus 4.8…",
  "session_id": "...",
  "uuid": "..."
}
```

### Ordering (with `--include-partial-messages`)

If a partial assistant message was mid-stream when the refusal hit, the CLI first **retracts** it by synthesizing closing stream events:

1. `stream_event` `content_block_stop` (only if a block was open)
2. `stream_event` `message_delta` with `delta.stop_reason: "refusal"` + usage
3. `stream_event` `message_stop`
4. the `model_refusal_fallback` system message
5. the turn replays on the fallback model — subsequent `assistant` messages carry `model: <fallback_model>`

### Field notes

- **`retracted_message_uuids`** — wire uuids of the messages this fallback retracted (the refused partial as the consumer received it, one uuid per normalized SDK message, plus any tombstoned tool_results). Emitted AFTER the retraction: remove these from transcript state on receipt. Eviction is idempotent — unknown/already-removed uuids are a no-op. Absent on older CLIs.
- **Transcript JSONL form is camelCase** (`originalModel`, `fallbackModel`, `requestId`, `apiRefusalCategory`, `retractedMessageUuids`) and adds `level: "warning"` — don't reuse wire parsing for transcript parsing.
- The retried assistant message in the transcript may carry a `{"type": "fallback", "from": {"model": ...}, "to": {"model": ...}}` content block recording the swap.
- **Usage attribution:** all post-fallback API calls record `message.model = fallback_model`. A session that started on Fable and fell back bills as the fallback model from that point — usage analytics will (correctly) show the fallback model.

---

## 4.21 `model_fallback`

Availability fallback — the current turn is switched to the **configured** fallback model because the primary failed with an availability error. Unlike §4.20 this is **turn-scoped**: the primary is re-tried on the next user turn. Marked `@internal` / "not yet in the public SDKMessage union" in the schema, but it IS yielded by the SDK emitter, ungated.

**Anchors (2.1.170):** schema `VIA` at `~7084860`; emitter yield at `16272124`.

**Gate:** Requires a configured fallback model (`--fallback-model` / settings); fires on availability errors.

```jsonc
{
  "type": "system",
  "subtype": "model_fallback",
  "trigger": "model_not_found"|"permission_denied"|"overloaded",
  "original_model": "...",
  "fallback_model": "...",
  "content": "human-readable render text",
  "session_id": "...",
  "uuid": "..."
}
```

`model_not_found`: model retired/unknown. `permission_denied`: org lacks access. `overloaded`: repeated 529s.

---

## 4.22 `thinking_tokens`

Live thinking-token estimate, digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase (where the API otherwise streams only pings). Also recomputed from signature length on `signature_delta`.

**Anchors (2.1.170):** schema `xkO` at `~7092092`; yields at `16266973` / `16267340` (stream-event digestion in the main generator).

**Gate:** Emitted while thinking deltas stream (practically: sessions with extended thinking).

```jsonc
{
  "type": "system",
  "subtype": "thinking_tokens",
  "estimated_tokens": 1234, // running total for the current thinking block
  "estimated_tokens_delta": 56, // increment carried by this frame
  "session_id": "...",
  "uuid": "..."
}
```

Approximate progress for spinners/pills — not the authoritative billed `output_tokens`.

---

## 4.23 `commands_changed`

Fire-and-forget push of the **full** slash-command list after a mid-session change (e.g. skills discovered dynamically as the agent works in a subdirectory).

**Anchors (2.1.170):** schema `CkO` at `~7090713`; emit at `16316834` (stream-json module).

**Gate:** Always (when the command list changes mid-session).

```jsonc
{
  "type": "system",
  "subtype": "commands_changed",
  "commands": [
    {
      /* same command shape as initialize's supportedCommands */
    }
  ],
  "session_id": "...",
  "uuid": "..."
}
```

**Consumer:** REPLACE the cached command list. `supportedCommands()` is captured once at initialize and never reflects mid-session changes, so a client re-fetch would return the stale init list.

---

## 4.24 `elicitation_complete`

Emitted when an MCP server confirms that a URL-mode elicitation is complete.

**Anchors (2.1.170):** schema `pkO` at `~7094043`; emit at `16307841` (stream-json module).

```jsonc
{
  "type": "system",
  "subtype": "elicitation_complete",
  "mcp_server_name": "...",
  "elicitation_id": "...",
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.25 `permission_denied`

Emitted when a tool call is **auto-denied without an interactive permission prompt** (auto-mode classifier, `dontAsk` mode, headless-agent auto-deny, or a deny rule). The "ask" path surfaces via a `can_use_tool` control_request; this event covers the "deny" short-circuit so SDK hosts can render the denial instead of only seeing an `is_error` tool_result. PreToolUse hook denies bypass `canUseTool` and are NOT covered.

**Anchors (2.1.170):** schema `BkO` at `~7094308`; emit at `7156177` (control-channel area).

```jsonc
{
  "type": "system",
  "subtype": "permission_denied",
  "tool_name": "Bash",
  "tool_use_id": "toolu_...",
  "agent_id": "...", // optional; subagent ID when denied inside a subagent
  "decision_reason_type": "rule", // optional; 'classifier'|'asyncAgent'|'mode'|'rule'|…
  "decision_reason": "...", // optional human-readable reason
  "message": "...", // the rejection message returned to the model
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.26 `mirror_error`

Emitted when `SessionStore.append()` rejects or times out for a transcript-mirror batch after bounded retry (3 attempts with short backoff; timeouts are not retried). The batch is then dropped — this surfaces the failure so consumers are not silent on data loss.

**Anchors (2.1.170):** schema `XkO` at `~7082241`; emit at `12946429`.

```jsonc
{
  "type": "system",
  "subtype": "mirror_error",
  "error": "...",
  "key": { "projectKey": "...", "sessionId": "...", "subpath": "..." }, // subpath optional
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.27 Schema-only / internal subtypes (not on the SDK stdout wire)

The SDK schema union (region `~7060000–7100000` in 2.1.170) declares more subtypes than the wire emits. The main generator's `case "system"` forwards exactly four internal system messages — `compact_boundary`, `api_error`→`api_retry`, `model_refusal_fallback`, `model_fallback` — and the emitter switch explicitly `break`s (drops) others, e.g. `api_metrics`. The subtypes below are mapped from internal `SystemMessage`s for the **transcript-mirror channel** (desktop LocalSessionManager / SessionStore), so they can appear in session JSONL transcripts but should not be expected on stdout in SDK mode:

| Subtype                | Internal meaning                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `task_summary`         | Mid-turn progress line from the debounced classifier; `detail` null on idle clear          |
| `informational`        | Generic loop text banner (`level`: info/notice/suggestion/warning; `prevent_continuation`) |
| `permission_retry`     | Tool execution retried after permission-mode change allowed denied commands                |
| `stop_hook_summary`    | Stop/SubagentStop hook execution summary at turn end                                       |
| `memory_saved`         | Memory subsystem wrote `written_paths`                                                     |
| `agents_killed`        | Background agents terminated (e.g. on interrupt)                                           |
| `away_summary`         | Summary of what happened while the user was away                                           |
| `thinking`             | Rendered thinking text (not the token estimate — that's §4.22)                             |
| `file_snapshot`        | Snapshot of session files (plan, todo) captured for rewind                                 |
| `scheduled_task_fire`  | Scheduled (cron) task fired                                                                |
| `api_metrics`          | Per-turn TTFT + output-tokens/sec line (distinct from top-level `api_metrics` message)     |
| `local_command_output` | Output from a local slash command (e.g. `/usage`)                                          |
| `files_persisted`      | Attachment-file persistence results                                                        |

If one of these is observed on stdout in a future CLI version, promote it to a numbered section.
