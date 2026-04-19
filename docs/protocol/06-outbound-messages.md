# 06 — Outbound messages (us → cli.js)

Every stream-json line we can write to cli.js's stdin. Verified against cli.js 2.1.114 by reading `processLine` at char `11928193`.

Every line is `{JSON}\n`. `JSON.parse` runs inside a `try` — malformed lines are logged to cli.js's stderr (`"Error parsing streaming input line: ..."`) and silently skipped; they do NOT kill the process.

Unknown top-level `type` values are also tolerated — logged as `"Ignoring unknown message type: X"` and dropped. You cannot use an unknown type as a protocol-version sniff.

---

## 6.1 Catalog

cli.js branches on seven top-level `type` values. Anything else is ignored.

| `type` | Schema (cli.js) | Purpose | Response |
|---|---|---|---|
| `user` | `BGK` at `4974365` | User prompt or tool_result reply | Turn generates `assistant` messages + final `result` |
| `control_request` | `PW$` | Host-initiated RPC to cli.js | `control_response` correlated by `request_id` |
| `control_response` | `T87` at `11921367` | Host's reply to an inbound control_request from cli.js | None (one-way) |
| `control_cancel_request` | (direct parse) | Cancel a pending inbound control_request | None |
| `keep_alive` | `v87` at `11921898` | No-op heartbeat | None |
| `update_environment_variables` | `yc1` | Mutate cli.js's `process.env` | None |
| `assistant` | `E.unknown()` (see `mj4`) | Inject assistant message into transcript | None (buffered) |
| `system` | `E.unknown()` (see `pj4`) | Inject system message into transcript | None (buffered) |

---

## 6.2 `user` — user prompt or tool_result reply

The only type that triggers an actual agent turn. All others are control/bookkeeping.

### Shape

```jsonc
{
  "type": "user",
  "message": {                             // required — cli.js checks message.role === "user"
    "role": "user",
    "content": "string" | [<ContentBlock>, ...]
  },
  "parent_tool_use_id": null | "string",   // REQUIRED (nullable). Downstream parsers throw
                                           // if omitted even though processLine's top-level
                                           // check does not enforce it.
  "isSynthetic": false,                    // optional
  "tool_use_result": unknown,              // optional — out-of-band payload
  "priority": "now" | "next" | "later",    // optional — queue priority
  "origin": { ... },                       // optional — Uj4 shape: "human" | team-lead | channel
  "shouldQuery": true,                     // optional — false = transcript-only, no API call
  "timestamp": "2026-01-01T00:00:00.000Z", // optional — defaults to receive time
  "uuid": "uuid-string",                   // optional
  "session_id": "string"                   // optional
}
```

### Field notes

- **`message`** is typed as `E.unknown()` — cli.js does NOT schema-validate the Anthropic-shaped payload. Only `role === 'user'` is enforced at the top level.
- **`message.content`** — accepted as:
  - `string` — treated as prompt text verbatim.
  - `array` of content blocks — cli.js's text extractor `fx()` at char `9291447` concatenates `.text` from `type:'text'` blocks with `\n`. Non-text blocks (images, tool_result, document) pass through untouched into the transcript.
- **`parent_tool_use_id`** — null for a normal user turn. Populated when the message is a tool_result in a subagent context. Despite being checked later (not by `processLine`), leaving it out triggers downstream Zod errors.
- **`shouldQuery: false`** appends the message to the transcript without triggering a model API call. Used for transcript replay / warmup.
- **`priority`** — `"now"` jumps the queue, `"next"` is the default, `"later"` waits until idle. See `docs/cli-message-loop-internals.md` for the full queue semantics.

### Tool_result content block (inside `content` array)

```jsonc
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",              // must match an unresolved tool_use in prior assistant
  "content": "string" | [{type:"text"|"image"|..., ...}],
  "is_error": false
}
```

cli.js passes these through to the Anthropic API verbatim. The API enforces tool_use_id matching — mismatches surface as a 400 error (`"unresolved tool_use_ids"`), visible near char `692021` in cli.js's error handling.

### When we send this

Once per user turn, via `writer.write({type:'user', message:{role:'user', content: prompt}})`. See `src/main/sdk/query.ts` around the first-prompt forwarding block. Tool_result replies typically arrive by a DIFFERENT path — see Section 6.4 — but the wire shape when they come through stdin is the same as above.

---

## 6.3 `control_request` — outbound RPC to cli.js

### Shape

```json
{
  "type": "control_request",
  "request_id": "<13-char random>",
  "request": {
    "subtype": "<subtype>",
    ...subtype-specific fields
  }
}
```

### Field notes

- **`request_id`** — locally unique. Our harness uses `randomUUID().slice(0, 13)` — uniqueness is only required within one cli.js process lifetime. cli.js echoes it in its response envelope.
- **`request`** — must contain a valid `subtype`. See `07-control-outbound.md` for every subtype + its field schema.

### Response

cli.js replies with a `control_response` (see Section 6.4), correlated by `request_id`. Default timeout on our side is 30 s; individual subtypes override (`initialize: 60s`, long-lived OAuth: `0/disabled`).

---

## 6.4 `control_response` — our reply to an inbound control_request

Sent when cli.js initiated a request. See `08-control-inbound.md` for the inbound subtypes.

### Shape (success)

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

### Shape (error)

```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "<echoed>",
    "error": "<error message>"
  }
}
```

**`pending_permission_requests`** — this field is sent from cli.js TO us on error responses for some control_request subtypes (notably `set_permission_mode`). We never emit it.

---

## 6.5 `control_cancel_request` — cancel a pending inbound control_request

Sent from us to cli.js when we want to cancel a request **cli.js sent us**. The symmetric of what cli.js sends to cancel one of ours.

### Shape

```json
{
  "type": "control_cancel_request",
  "request_id": "<id of the inbound request to cancel>"
}
```

### When we send this

Currently — NEVER. Our harness does not cancel inbound requests; we always respond (including with `{behavior: 'cancelled'}` for unhandled dialogs). Future reason we might: a UI component unmounts mid-dialog and we want to silently drop the pending response instead of answering.

---

## 6.6 `keep_alive` — heartbeat

### Shape

```json
{ "type": "keep_alive" }
```

### Behavior

cli.js's `processLine` returns immediately. Not yielded to any loop. No response.

**Gotcha:** keep_alive does NOT flush anything — it's a pure no-op. Don't use it to synchronize state.

We currently don't send keep_alive. It's documented here for completeness.

---

## 6.7 `update_environment_variables` — mutate cli.js's process.env

### Shape

```json
{
  "type": "update_environment_variables",
  "variables": { "FOO": "bar", "BAZ": "qux" }
}
```

### Behavior

Iterates `Object.entries(variables)` and sets `process.env[K] = V` inside cli.js. Logs `[structuredIO] applied update_environment_variables: ...` at debug level.

### Gotchas

- **Does NOT propagate to already-spawned child processes.** PTYs, Bash tool invocations already running — those inherited the old env at spawn time. New spawns see the update.
- **Useful for refreshing tokens** — e.g. rotating `CLAUDE_CODE_SESSION_ACCESS_TOKEN` at runtime without restarting cli.js.
- **Not currently used by our harness.** Flagged as a capability if we ever expose a token-refresh path that doesn't go through OAuth control subtypes.

---

## 6.8 `assistant` — inject assistant message into transcript

### Shape

```jsonc
{
  "type": "assistant",
  "message": <Anthropic-shaped assistant message>
}
```

### Behavior

cli.js appends to the in-memory transcript via `se8([mH])`. If `replayUserMessages` is on (an SDK-session flag), cli.js also echoes it back on stdout.

### When would we use this?

Transcript replay — pre-seeding a session with prior conversation state. Our harness does NOT currently do this; resume-from-JSONL goes through the `--resume <id>` CLI path instead. Documented for completeness.

---

## 6.9 `system` — inject system message into transcript

### Shape

```jsonc
{
  "type": "system",
  ...system-shaped
}
```

Same treatment as `assistant` stdin type — folded into transcript via `se8`. No rebroadcast.

### When would we use this?

Pre-seeding session context. Not used by our harness.

---

## 6.10 Validation behavior summary

| Case | cli.js response |
|---|---|
| Valid known type | Processed per type |
| Unknown `type` string | Logged, dropped |
| Missing `type` | Logged, dropped |
| Malformed JSON (parse error) | Logged, dropped; process continues |
| `user` without `message` | Thrown error inside parser; dropped |
| `user` with `message.role !== 'user'` | Thrown error; dropped |
| `control_request` without `request` | Error control_response emitted |
| `control_request` with unknown `subtype` | Error control_response emitted (cli.js validates against `kc1` union) |
| `control_response` without matching pending `request_id` | Calls `unexpectedResponseCallback` (if set); otherwise silently dropped |

---

## 6.11 Quick reference

Outbound writer API (ours):

```ts
import { NdjsonWriter } from 'src/main/sdk/protocol'

writer.write({ type: 'user', message: { role: 'user', content: 'hello' } })
writer.write({ type: 'control_request', request_id, request: {...} })
writer.write({ type: 'control_response', response: { subtype: 'success', request_id, response: {} } })
writer.write({ type: 'control_cancel_request', request_id })  // never used today
writer.write({ type: 'keep_alive' })                           // never used today
writer.write({ type: 'update_environment_variables', variables: {...} })  // never used today
```
