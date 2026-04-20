# 04 — System message subtypes

Every `{type: 'system', subtype: 'X', ...}` variant cli.js emits. Verified against 2.1.114 (patched).

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

| Subtype | Gate | Emitter path |
|---|---|---|
| `init` | Always (first turn) | Main generator |
| `status` | Varies per variant | Main generator / control channel |
| `task_notification` | Always | vT queue |
| `task_started` | Always | vT queue |
| `task_updated` | Always | vT queue |
| `task_progress` | Always | vT queue |
| `compact_boundary` | On conversation compaction | Main generator |
| `api_retry` | On API error + auto-retry | Main generator |
| `queued_command_consumed` | Patch `queue-control` | Main generator (patched) |
| `hook_started` | `--include-hook-events` | Hook subscriber |
| `hook_progress` | `--include-hook-events` | Hook subscriber |
| `hook_response` | `--include-hook-events` | Hook subscriber |
| `bridge_state` | `remote_control` active | Control channel |
| `session_state_changed` | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | Direct emit |
| `notification` | Error conditions | vT queue |
| `memory_recall` | Memory feature returns results | Main generator |
| `plugin_install` | `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` | Main generator |
| `post_turn_summary` | (referenced in filter; shape not observed) | — |

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
  "error_status": 529,                     // HTTP status, null if non-HTTP
  "error": { /* normalized via U9K() */ },
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

Referenced in the outer JSON-aggregate filter at char `12822512` but shape not observed in the current bundle. Documented here for completeness so a future session doesn't re-research.

If observed in the wild, update this doc.

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

Unknown subtypes: log and pass through. Don't silently drop.
