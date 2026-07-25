# Patch: queue-control

Manages the CLI's output queue mid-agent-turn: dequeue by value, and notification when a queued command is consumed.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component          | Version              |
| ------------------ | -------------------- |
| Last re-anchored   | bundled CLI `2.1.197` |

## Background: Native Steer Mechanism

The CLI natively supports mid-turn message injection via the steer mechanism (see `docs/cli-message-loop-internals.md`):

```
User types mid-turn → sendPrompt() → MessageChannel.push() → CLI stdin
  → queuePush({mode:"prompt", value:..., uuid:...})
  → do-while loop picks it up at next snapshotQueue() call
  → processed as queued_command attachment in submitMessage
```

**`queue_message` is NOT needed** — the native steer path already handles injection. This patch only adds what's missing:

1. **`dequeue_message`** — withdraw a queued item before it's consumed
2. **`queued_command_consumed`** — notification when the CLI processes the steer

## The Problems

### 1. No way to withdraw a queued steer

Once `sendPrompt` pushes a message into the CLI's queue, there's no way to remove it before processing. The user should be able to edit/cancel their queued message.

### 2. No notification when a steer is consumed

The CLI processes queued commands in `submitMessage`'s attachment handler, but only yields a replay user message when `replayUserMessages=true` (which is `false` by default). ClaudeUI gets zero notification that the steer was picked up — the QueuedMessageCard just vanishes silently when the turn ends.

## The Fix

### Part A1: `dequeue_message` control request (cli.js)

Injected before the "Unsupported control request subtype" fallback:

```js
else if (c.request.subtype === "dequeue_message") {
  let { value: Y6 } = c.request;
  let O6 = removeFn((_6) => extractQueueText(_6.value) === Y6);
  successFn(c, { removed: O6.length });
}
```

**Value-based matching**: Queue items don't have stable UUIDs that survive the steer → attachment pipeline. The dequeue matches by text content extracted via the same helper the CLI uses internally.

```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "dequeue_message",
    "value": "Fix the auth bug too"
  }
}
```

Response: `{ "removed": 1 }` (0 if already consumed)

### Part A2: `queued_command_consumed` notification (cli.js)

In `submitMessage`'s attachment handler, the `queued_command` case is modified from:

```js
// Before: only yields when G (replayUserMessages) is true
else if (G && g6.attachment.type === "queued_command") yield { ...isReplay: true };
```

To:

```js
// After: always yields a system notification, replay only when G is true
else if (g6.attachment.type === "queued_command") {
  yield { type: "system", subtype: "queued_command_consumed",
    prompt: g6.attachment.prompt, source_uuid: g6.attachment.source_uuid,
    session_id: Q1(), uuid: Y16() };
  if (G) yield { type: "user", ...isReplay: true };
}
```

The `queued_command_consumed` system message tells ClaudeUI to:

- Add the queued text as a visible user message in the chat
- Clear the QueuedMessageCard

### Part B: `dequeueMessage()` SDK method (sdk.mjs)

Exposes `dequeueMessage(value)` on the query object, which sends a `dequeue_message` control request.

## How It Finds the Code (Pattern Matching)

All minified function names are extracted **dynamically** from content patterns.

| What                         | Stable Anchor / Pattern                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Injection point (A1)         | `else <fn>(c,\`Unsupported control request subtype: ...\`)` — tail-less since v2.1.219 (dispatch chain now wrapped in `try/finally`; ≤ v2.1.207 the anchor included `;continue}else if(c.type==="control_response")`). Do not confuse with v2.1.219's second class-based dispatcher (`processControlRequest`, `throw Error(...)` fallback) — that serves the SDK Query transport, not the stream-json stdin loop. |
| Success response helper      | `),<fn>(c,{})}}catch` — in the stop_task handler                                                          |
| Queue push + loop starter    | `<fn>({mode:"prompt",value:<v>.message.content,uuid:<v>.uuid}),<fn>()`                                    |
| Queue push definition (A1)   | `function <fn>(<A>){<arr>.push({...<A>,priority:<A>.priority??"next",timestamp:` — see v2.1.197 note     |
| Queue remove-by-predicate    | `function <fn>(<v>){let <v>=[];for(let <v>=<queue>.length-1`                                              |
| Extract queue text           | `<fn>(<var>.value)` — near popAllEditable                                                                 |
| queued_command handler (A2)  | `else if(G&&<var>.attachment.type==="queued_command")yield{`                                              |
| Session ID / UUID generators | `session_id:<fn>(),uuid:<fn>()` within the yield                                                          |
| sdk.mjs stopTask             | `async stopTask(<v>){await this.request({subtype:"stop_task",task_id:<v>})}`                              |

### v2.1.197 changes

Two anchors changed between v2.1.97 and v2.1.197:

**1. Success-response-helper search window: 5000 → 8000 chars**

The `stop_task` handler that contains the `),<successFn>(c,{})}}catch` pattern moved to 6578 chars before the "Unsupported" fallback anchor in v2.1.197. The old 5000-char window no longer reached it. The window was extended to 8000 characters to give a comfortable margin. This mirrors the identical change in `background-task/apply.mjs`.

**2. Queue-push regex now anchors on `timestamp:` trailing field**

Before v2.1.197, the push function was:
```js
function <pushFn>(<A>){<arr>.push({...<A>,priority:<A>.priority??"next"}), ...}
```

In v2.1.197, a `timestamp:` field was appended to the push object:
```js
function <pushFn>(<A>){<arr>.push({...<A>,priority:<A>.priority??"next",timestamp:...}), ...}
```

The `apply.mjs` `pushDefRe` now uses `priority:<A>.priority??"next",timestamp:` as its terminal anchor instead of the closing `}`. This is more specific and unique; the old pattern would have matched spuriously without the trailing field.

## Race Condition Window

There's a small window between `sendPrompt` and `snapshotQueue()` where:

- The message is in the queue but not yet consumed
- `dequeue_message` can still withdraw it

Once `snapshotQueue()` runs (at the start of the next sub-turn), the item is moved to the processing pipeline and dequeue returns `{ removed: 0 }`.

## Desired Flow

```
User types mid-turn → sendPrompt (native steer) + appendQueuedText (UI)
  → QueuedMessageCard visible with Edit button
  → CLI processes at next snapshotQueue → queued_command_consumed fires
  → Handler: add user message to chat + clearQueuedText
  → Message shows in chat as sent user message (no longer editable)

Edit before consumption:
  → dequeueMessage(value) returns { removed: 1 }
  → Text returns to input, no message added to chat

Edit after consumption:
  → Card already gone, message already in chat
```

## Verification

1. `node patch/apply-all.mjs` — patches apply with markers
2. `bun run typecheck` — no errors
3. Manual test:
   - Send a prompt that triggers a long tool call
   - Type a steer message mid-turn
   - QueuedMessageCard shows with Edit button
   - When consumed: message appears in chat, card disappears
   - Click Edit before consumption: text returns to input
