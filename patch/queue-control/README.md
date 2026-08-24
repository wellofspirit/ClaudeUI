# Patch: queue-control

Manages the CLI's output queue mid-agent-turn: dequeue by value, and notification when a queued command is consumed.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component          | Version              |
| ------------------ | -------------------- |
| Last re-anchored   | bundled CLI `2.1.241` |

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
| queued_command handler (A2)  | 2.1.241+: `case"attachment":if(<n>&&<e>.attachment.type==="queued_command"){yield{...<seo>(<e>.attachment,<e>),session_id:<e>.session_id};return}` — see v2.1.241 note. Older: `else if(G&&<var>.attachment.type==="queued_command")yield{` |
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

### v2.1.241 changes

**1. Queue-push guard/return shape widened**

The push function became `function ne(Ze){if(!Z(Ze))return!1;return n.push({...GPf(Ze),priority:Ze.priority??"next",timestamp:...` — the admission guard now rejects with `return!1` (was bare `return;`) and the push itself became a `return` expression (enqueue reports success). `pushDefRe` admits both: `return(?:!1)?;` for the guard and an optional `return ` before the `.push(`.

**2. queued_command handler (A2) moved out of submitMessage**

The `else if` chain the A2 patch replaced no longer exists. The handler now lives in the outbound message-normalization switch:

```js
// function*gGy(e,t,r,{replayUserMessages:n,includePartialMessages:o}){switch(e.type){...
case"attachment":if(n&&e.attachment.type==="queued_command"){yield{...seo(e.attachment,e),session_id:e.session_id};return}yield*WTn([e],e.session_id);return;
```

`seo(att,msg)` is the isReplay user-message builder (`{type:"user",message:{role:"user",content:att.prompt},...,isReplay:!0,...}`). A new first-choice pattern (`qcReSwitch`) matches this shape and rewrites it to: always yield the `queued_command_consumed` system notification (using the in-scope `e.session_id` — no session-id generator extraction needed — and `globalThis.crypto.randomUUID()` for uuid, precedent subagent-streaming), then keep the replay yield gated on `n` and the non-queued/replay-off fallthrough (`yield*WTn`) byte-identical. Find it via `bundle-analyzer find cli.js '"queued_command"){yield{' --compact`. The legacy else-if patterns remain as fallbacks for older bundles.

**BUT the gGy site alone is NOT enough** — live testing (harness) showed the notification never fired. `gGy` serves the **SDK-hosted transport** (its only caller is the `zPr`/`S$o` query writer). The stdin stream-json loop that ClaudeUI drives consumes mid-turn queued_command attachments at a SECOND site — the true descendant of the old submitMessage else-if chain, where the yield became a **builder call**, not an object literal (which is why every legacy `yield{` pattern missed it):

```js
else if(Sr.attachment.type==="hook_system_message")yield*WTn([Sr],Vt());
else if(C&&Sr.attachment.type==="queued_command")yield seo(Sr.attachment,Sr);
```

(`C` = replayUserMessages, from the enclosing options destructure.) A2 now patches BOTH sites in one pass — the stdin site is REQUIRED (loud abort if absent); notification unconditional, replay stays gated on `C`, session id from the `session_id:Vt()` generator the adjacent cases use (extracted from forward context). Find it via `bundle-analyzer find cli.js 'queued_command")yield ' --compact`.

**3. dequeue_message (A1): the module-level `dequeueAllMatching` binding is gone**

≤2.1.231 A1 captured `MODLOCAL=FACTORY.dequeueAllMatching`. In 2.1.241 the first `X=Y.dequeueAllMatching` match in the bundle is an unrelated **local holding a result array** (`let o=e.dequeueAllMatching(...)` in a drain helper) — the injected handler called a non-function at runtime (applies-but-misbinds; only the live harness catches this). The queue is an instance in the dispatch scope; A1 now reads its name off the native `cancel_async_message` sibling handler in the same else-if chain (`Zo=S.isFoldInFlight(Yn)?[]:S.dequeueAllMatching(...)`) — in-scope by construction. The match predicate no longer captures the text-rule helper by name either (`g1S` in 2.1.241 lives in a different bundle module than the dispatch scope); the three-line rule (string verbatim; else `text` blocks joined with `"\n"` — docs/protocol-cc §4.10) is inlined into the predicate instead.

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
