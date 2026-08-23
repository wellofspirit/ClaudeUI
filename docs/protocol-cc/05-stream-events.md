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

**`parent_tool_use_id`** — non-null for subagent stream events (patch `subagent-streaming-C` and friends). Teammate variants use `teammate_id`.

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

Interleaved with (if partial messages enabled):

```
assistant                             {message: {id, content: [text(partial)], ...}}
assistant                             {message: {id, content: [text(full), tool_use(partial)], ...}}
assistant                             {message: {id, content: [text(full), tool_use(full)], stop_reason: "tool_use"}}
```

The assistant messages upsert by `message.id`. Each carries a progressively fuller snapshot of `content`.

---

## 5.10 Consumer guidance

### When `includePartialMessages: false`

You'll never see `stream_event` at all. Only `assistant` messages — one per "complete enough" snapshot. Easier to consume, but no token-by-token streaming.

### When `includePartialMessages: true`

You'll see both stream events AND periodic `assistant` snapshots. Typical pattern:

1. Show a skeleton on `message_start`.
2. Append text on `text_delta` for real-time streaming UX.
3. On `content_block_start` with `tool_use`, show a "pending tool" indicator.
4. Concatenate `input_json_delta.partial_json`; parse on `content_block_stop`.
5. On `message_delta`, you have the final usage + stop_reason.
6. On `message_stop`, consider the message done.

OR use the `assistant` snapshots as the source of truth and treat stream_events as advisory (only show them for the "typewriter" UX).

ClaudeUI uses a hybrid: stream_events drive the typewriter effect; assistant snapshots provide authoritative content blocks for rendering.

### Common mistakes

- **Don't rely on any stream_event being atomic with its assistant snapshot.** Event arrival is interleaved. Use `message.id` to correlate.
- **Don't assume `input_json_delta` always produces valid JSON mid-stream.** Only the concatenation after `content_block_stop` is guaranteed parseable.
- **Don't forget `signature_delta`.** Thinking blocks need the signature to be valid when re-sent to the API in a follow-up.
- **`ttft_ms` is only on the first event.** Not every stream_event — just the first.

---

## 5.11 Subagent and teammate variants

Via patches (see `patch/subagent-streaming/` and `patch/team-streaming/`):

### Subagent (patches C, E, G)

`parent_tool_use_id` non-null:

```jsonc
{
  "type": "stream_event",
  "event": {...},
  "parent_tool_use_id": "toolu_parent_Task",
  "session_id": "...",
  "uuid": "..."
}
```

### Teammate (patch team-streaming-B)

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
