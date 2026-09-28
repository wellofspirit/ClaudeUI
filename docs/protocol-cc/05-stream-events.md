# 05 — Stream events

`stream_event` messages are the low-level Anthropic SSE events forwarded from cli.js's streaming layer. They mirror the Anthropic API's streaming shape exactly — if you know how Anthropic's Messages API streams, this is the same thing, wrapped in a stream-json envelope.

Verified against cli.js 2.1.114. Emission at main path char `~12805167`; subagent variants via patches.

---

## 5.1 The envelope

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "message_start"|"content_block_start"|"content_block_delta"|"content_block_stop"|"message_delta"|"message_stop",
    ...event-specific fields
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "ttft_ms": 412                  // only on first stream_event of an assistant turn
}
```

**Gate:** `--include-partial-messages` flag (harness option `includePartialMessages: true`). With it off, no `stream_event` lines appear; only final `assistant` messages do.

**`ttft_ms`** — time-to-first-token. Present only on the FIRST `stream_event` of each assistant turn. Use for startup latency metrics.

**`parent_tool_use_id`** — non-null for subagent stream events (patch `subagent-streaming-C` and friends). Teammate variants use `teammate_id`. A background sub-agent's events also carry `agent_id`, and on an idle self-resume ONLY `agent_id` (§5.11).

---

## 5.2 Anthropic SSE event types

Six `event.type` values, arriving in strict order per assistant message:

```
message_start
  ├─ content_block_start (per block)
  │    └─ content_block_delta (many, per token)
  │    └─ content_block_stop
  ├─ content_block_start (next block)
  │    └─ ...
  ├─ message_delta (final usage + stop_reason)
  └─ message_stop
```

---

## 5.3 `message_start`

Opens a new assistant message. Contains the initial message skeleton.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "id": "msg_XXXX",
      "type": "message",
      "role": "assistant",
      "content": [],
      "model": "claude-opus-4-7",
      "stop_reason": null,
      "stop_sequence": null,
      "usage": {
        "input_tokens": 1234,
        "cache_creation_input_tokens": 890,
        "cache_read_input_tokens": 100,
        "output_tokens": 0 // always 0 here; grows in message_delta
      }
    }
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "ttft_ms": 412
}
```

**Field notes:**

- `event.message.id` — stable across all subsequent `stream_event` and partial `assistant` messages for this turn.
- `event.message.content` — empty array. Content arrives via `content_block_*` events.
- `event.message.usage` — input tokens known at start. `output_tokens` starts at 0 and grows on `message_delta`.

---

## 5.4 `content_block_start`

A new content block (text, thinking, tool_use, citations) begins.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,                          // 0-based position in message.content
    "content_block": {
      "type": "text" | "thinking" | "tool_use" | "citations" | ...,
      ...type-specific initial shape
    }
  },
  "parent_tool_use_id": null,
  ...
}
```

### `content_block.type` variants

#### `text`

```json
{ "type": "text", "text": "" }
```

Initial text is empty; grows via `text_delta` in subsequent `content_block_delta`.

#### `thinking`

```json
{ "type": "thinking", "thinking": "" }
```

Grows via `thinking_delta`. Finalized by `signature_delta` at end.

#### `tool_use`

```json
{
  "type": "tool_use",
  "id": "toolu_XXXX",
  "name": "Bash",
  "input": {} // populated via input_json_delta
}
```

Tool input starts empty; grows via `input_json_delta` (partial JSON strings that must be concatenated and parsed).

#### `citations`

```json
{
  "type": "citations",
  "citations": [...]                     // Anthropic citations blocks
}
```

---

## 5.5 `content_block_delta`

Incremental update to the block at `event.index`. The workhorse event.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "text_delta" | "thinking_delta" | "input_json_delta" | "signature_delta" | "citations_delta",
      ...
    }
  },
  ...
}
```

### `delta.type` variants

#### `text_delta`

```json
{ "type": "text_delta", "text": "the next chunk of text" }
```

Concatenate to the block's `.text`.

#### `thinking_delta`

```json
{ "type": "thinking_delta", "thinking": "next chunk" }
```

Concatenate to the block's `.thinking`.

#### `input_json_delta`

```json
{ "type": "input_json_delta", "partial_json": "{\"cmd\":\"" }
```

Partial JSON string. Concatenate ALL `input_json_delta.partial_json` across all deltas for this block, then `JSON.parse` to get the final `tool_use.input`.

#### `signature_delta`

```json
{ "type": "signature_delta", "signature": "..." }
```

Finalizes the thinking block. Marks the end of thinking content.

#### `citations_delta`

```json
{ "type": "citations_delta", "citation": { ... } }
```

Appends a citation entry to the block's `citations` array.

---

## 5.6 `content_block_stop`

Closes the block at `event.index`.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "content_block_stop",
    "index": 0
  },
  ...
}
```

After `content_block_stop`, no more deltas for this block will arrive. Consumer can finalize the block (e.g., parse tool_use JSON, freeze text).

---

## 5.7 `message_delta`

Final message-level delta. Carries the final usage counts and stop_reason.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": {
      "stop_reason": "end_turn"|"tool_use"|"max_tokens"|"stop_sequence"|null,
      "stop_sequence": null
    },
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 890,
      "cache_read_input_tokens": 100
    }
  },
  ...
}
```

**Field notes:**

- `event.delta.stop_reason` — populated here. This is the authoritative stop reason.
- `event.usage.output_tokens` — final count (was 0 at message_start).

---

## 5.8 `message_stop`

Closes the assistant message. No fields beyond `type`.

```jsonc
{
  "type": "stream_event",
  "event": {
    "type": "message_stop"
  },
  ...
}
```

After `message_stop`, no more stream_events for this `message.id` arrive. The next stream sequence (if any) has a new `message_start` with a fresh id.

---

## 5.9 Ordering within a turn

```
stream_event message_start            {message: {id, ..., content: []}}
stream_event content_block_start      {index: 0, content_block: {type:"text", text:""}}
stream_event content_block_delta      {index: 0, delta: {type:"text_delta", text:"Hello"}}
stream_event content_block_delta      {index: 0, delta: {type:"text_delta", text:", world"}}
stream_event content_block_stop       {index: 0}
stream_event content_block_start      {index: 1, content_block: {type:"tool_use", id, name, input:{}}}
stream_event content_block_delta      {index: 1, delta: {type:"input_json_delta", partial_json:"{\""}}
stream_event content_block_delta      {index: 1, delta: {type:"input_json_delta", partial_json:"cmd\":\"ls\"}"}}
stream_event content_block_stop       {index: 1}
stream_event message_delta            {delta: {stop_reason:"tool_use"}, usage: {...}}
stream_event message_stop             {}
```

Interleaved with (if partial messages enabled) — one `assistant` line per content block, shown
here with its neighbouring stream events:

```
stream_event content_block_delta      {index: 0, delta: {type:"text_delta", text:", world"}}
assistant                             {message: {id, content: [text(full)], ...}}
stream_event content_block_stop       {index: 0}
stream_event content_block_delta      {index: 1, delta: {type:"input_json_delta", partial_json:"cmd\":\"ls\"}"}}
assistant                             {message: {id, content: [tool_use(input parsed)], stop_reason: null}}
stream_event content_block_stop       {index: 1}
```

`content` holds exactly ONE block — the block the line is reporting — every line shares
`message.id` with `message_start`, and each line arrives after its block's last
`content_block_delta` but BEFORE that block's `content_block_stop`. The `tool_use` line already
carries the fully parsed `input`, so a consumer of the snapshots never has to concatenate
`input_json_delta`. `stop_reason` is `null` on every per-block line — `message_delta` has not
arrived yet, so the final stop reason is only on that stream event. The same one-line-per-block
shape holds with `includePartialMessages: false`. Consumers upsert by `message.id` and place each line's single block by
index/type.

Verified on 2.1.268, 2026-09-18, localhost SSE fixture. `src/integration/sdk-contract/stream-order.integration.test.ts`
re-checks this on every CLI bump (`12-maintenance.md` §12.1).

### A `tool_use` cut off mid-stream gets no snapshot

When the output limit ends a message while a `tool_use` block is still streaming, that block
never gets its per-block `assistant` line — and never runs. Observed in session
`efa47532-932f-4598-b750-5263dea1c46d`: message `dn74DfqZ` ended with `message_delta
{stop_reason:"max_tokens"}` mid-`Write`, and its only snapshots were its two thinking blocks.
The transcript on disk never contains the call, so a reload is already correct. A stream cut by an
interrupt or abort (no `message_delta` at all) is treated the same way; that case is inferred, not
yet observed on the wire.

A consumer that shows a `tool_use` at `content_block_start` (ClaudeUI does, so a result always has
a call to attach to) must take it back. `ClaudeItemStreamLifecycle` records `message_delta`'s
`stop_reason` and every `tool_use` id any snapshot of the message carried. When the message ends
with a stop reason other than `"tool_use"` (including none), each unconfirmed `tool_use` is removed
before the final seal and reported as `session:tool-uses-retracted { messageId, toolUseIds,
ownerToolUseId? }` (`docs/architecture/sync-channels.md`). A message that stopped for `"tool_use"`
never retracts anything: every call in it runs, and a sub-agent's snapshot can lag `message_stop`
because Patch E's stream events and the native relay's snapshots take different paths (§5.11).

---

## 5.10 Consumer guidance

### When `includePartialMessages: false`

You'll never see `stream_event` at all. Only `assistant` messages — one per content block. Easier to consume, but no token-by-token streaming.

### When `includePartialMessages: true`

You'll see both stream events AND one `assistant` snapshot per content block. Typical pattern:

1. Show a skeleton on `message_start`.
2. Append text on `text_delta` for real-time streaming UX.
3. On `content_block_start` with `tool_use`, show a "pending tool" indicator.
4. Concatenate `input_json_delta.partial_json`; parse on `content_block_stop`.
5. On `message_delta`, you have the final usage + stop_reason.
6. On `message_stop`, consider the message done.

OR use the `assistant` snapshots as the source of truth and treat stream_events as advisory (only show them for the "typewriter" UX).

ClaudeUI uses a hybrid: stream_events drive the typewriter effect; assistant snapshots provide authoritative content blocks for rendering. Because each snapshot is single-block (§5.9), `ClaudeItemStreamLifecycle` places it onto the live block matched by index/type; a snapshot it cannot place falls back to the ordinary `session:message` upsert rather than being dropped.

### Common mistakes

- **Don't rely on any stream_event being atomic with its assistant snapshot.** Event arrival is interleaved. Use `message.id` to correlate.
- **Don't assume `input_json_delta` always produces valid JSON mid-stream.** Only the concatenation after `content_block_stop` is guaranteed parseable.
- **Don't forget `signature_delta`.** Thinking blocks need the signature to be valid when re-sent to the API in a follow-up.
- **`ttft_ms` is only on the first event.** Not every stream_event — just the first.

---

## 5.11 Subagent and teammate variants

Via patches (see `patch/subagent-streaming/`; `team-streaming`, which produced the teammate variant, is retired and its directory removed — 01 §1.12):

### Subagent (patches C, E, G)

`parent_tool_use_id` non-null:

```jsonc
{
  "type": "stream_event",
  "event": {...},
  "parent_tool_use_id": "toolu_parent_Task",
  "agent_id": "ab9368ec953c764ac",   // Patch E (background runner) only, v2.1.280+
  "session_id": "...",
  "uuid": "..."
}
```

**`agent_id`** — the background runner's `taskId` (= the agent id, = `task_started.task_id`). Patch E stamps it on every frame it writes; the foreground path (Patches B/C) does not.

**Idle self-resume: `agent_id` without `parent_tool_use_id`.** A background agent may stop while its own background children still run; when a child reports while the session is idle, cli.js resumes the agent itself with `_buildIdleToolUseContext()` — a main-loop context with **no `toolUseId`**. Patch E's `parent_tool_use_id:CTX.toolUseId` is then `undefined` and `JSON.stringify` drops the key, so the frame looks like the main agent's except for `agent_id`. That run's completed `assistant`/`user` frames (the native relay) are NOT affected: the relay stamps the `toolUseId` the agent's sidecar recorded at spawn, i.e. the ORIGIN Agent call's id (ADR-073), and cli.js's own task-notifications for such a run lack `<tool-use-id>`. A consumer must therefore place such a stream_event by `agent_id` on the same owner the snapshots use — `ClaudeSession.handleStreamEvent` maps it through `originByTaskId` → `resolveTaskOwner` — and must never treat a frame that carries `agent_id` as the main agent's (an unknown `agent_id` is dropped). Evidence and char offsets: `patch/subagent-streaming/README.md`, Patch E § "v2.1.280 — `agent_id`".

### Teammate (patch team-streaming-B — retired)

`teammate_id` instead of `parent_tool_use_id`:

```jsonc
{
  "type": "stream_event",
  "event": {...},
  "teammate_id": "agent-name@team-name",
  "session_id": "...",
  "uuid": "..."
}
```

### Gate

Subagent/teammate variants require both:

- `--include-partial-messages` (the normal gate)
- The corresponding ClaudeUI patch applied

Without the patch, subagent stream events are swallowed by upstream's internal aggregation.

On a harness without `subagent-streaming` (Anthropic's unpatched binary, ADR-079) ClaudeUI still gets a foreground subagent's text and thinking as complete `assistant` messages with `parent_tool_use_id` set, because it always passes `--forward-subagent-text` (02); only the token deltas are missing.
