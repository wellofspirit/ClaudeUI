# Patch: queue-control

Manages the CLI's output queue mid-agent-turn: dequeue by value, and notification when a queued command is consumed.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component        | Version               |
| ---------------- | --------------------- |
| Last re-anchored | bundled CLI `2.1.261` |

> **2.1.261 is a code-split bundle.** `vendor/claude-cli/cli.js` is no longer one
> minified file — it is the concatenation of ~1,631 minified ESM chunks, each
> preceded by a delimiter line `// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js`.
> Regexes work exactly as before, but a name captured in one chunk is a
> different binding (or none) in another. Everything this patch injects is read
> off the chunk it injects into — see §"2.1.261 changes".

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

Injected before the "Unsupported control request subtype" fallback. As built on
2.1.261 (`U` = queue instance, `Xe` = reply helper, `r` = control message):

```js
/*PATCHED:queue-control-dequeue*/else if(r.request.subtype==="dequeue_message"){
  let{value:Y6}=r.request;
  let O6=U.dequeueAllMatching((_6)=>(typeof _6.value==="string"?_6.value:
    Array.isArray(_6.value)?_6.value.filter((b6)=>b6&&b6.type==="text"&&typeof b6.text==="string")
      .map((b6)=>b6.text).join("\n"):"")===Y6);
  Xe(r,{removed:O6.length})
}
```

**Value-based matching**: Queue items don't have stable UUIDs that survive the steer → attachment pipeline. The dequeue matches by text content, applying cli.js's own queue-text rule **inlined** (the helper lives in another bundle module — see v2.1.241 note 3).

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

In the outbound message normalizer's `attachment` case, the notification is
prepended and the existing `queued_command` branch is left byte-identical.
As built on 2.1.261 (`d` = replayUserMessages, `e` = message, `smn` = the
nullable isReplay builder):

```js
// Before
case"attachment":if(d&&e.attachment.type==="queued_command"){let P=smn(e.attachment,e);if(P)yield{...P,session_id:e.session_id};return}

// After — notification unconditional, replay still gated on d
case"attachment":/*PATCHED:queue-control-consumed*/if(e.attachment.type==="queued_command")yield{type:"system",subtype:"queued_command_consumed",prompt:e.attachment.prompt,source_uuid:e.attachment.source_uuid,session_id:e.session_id,uuid:globalThis.crypto.randomUUID()};if(d&&e.attachment.type==="queued_command"){let P=smn(e.attachment,e);if(P)yield{...P,session_id:e.session_id};return}
```

Pre-2.1.241 the same edit was a full rewrite of an `else if` in
`submitMessage`, with `session_id:<sessionIdFn>()` / `uuid:<uuidFn>()`
extracted from neighbouring yields; those shapes remain in `apply.mjs` as
fallbacks.

The `queued_command_consumed` system message tells ClaudeUI to:

- Add the queued text as a visible user message in the chat
- Clear the QueuedMessageCard

### Part B: `dequeueMessage()` SDK method (sdk.mjs)

Exposes `dequeueMessage(value)` on the query object, which sends a `dequeue_message` control request.

## How It Finds the Code (Pattern Matching)

All minified function names are extracted **dynamically** from content patterns.

| What                         | Stable Anchor / Pattern                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Injection point (A1)         | The stream-json control-request fallback. Four lookalikes exist — see "Picking the right fallback" below.                                                                                                                                                                                                                            |
| Dispatch-chain start         | `<msgVar>.type==="control_request"` — nearest occurrence before the anchor. Every local name A1 injects (reply helper, queue instance) must be captured **between** it and the anchor; that window is what proves the name is in scope.                                                                                              |
| Success response helper      | `),<fn>(c,{})}}catch` — in the stop_task handler, searched only inside the dispatch chain. 2.1.261: `Xe`, defined alongside its error twin as `Xe=function(f,M){wt.enqueue(A5(f.request_id,M))},…,Be=function(f,M){wt.enqueue(_B(f.request_id,M))}`.                                                                                 |
| Queue push + loop starter    | `<fn>({mode:"prompt",value:<v>.message.content,uuid:<v>.uuid}),<fn>()`                                                                                                                                                                                                                                                               |
| Queue push definition        | `function <fn>(<A>…){…<arr>.push({...<A>,priority:<A>.priority??"next",timestamp:` — **cross-check only; nothing injects it.** See the v2.1.197 / v2.1.241 / v2.1.261 notes.                                                                                                                                                         |
| Queue remove-by-predicate    | `function <fn>(<v>){let <v>=[];for(let <v>=<queue>.length-1`                                                                                                                                                                                                                                                                         |
| Queue instance (A1)          | the `cancel_async_message` sibling handler: `subtype==="cancel_async_message"){let <u>=<msgVar>.request.message_uuid,<r>=<Q>.isFoldInFlight(<u>)?[]:<Q>.dequeueAllMatching(` — `<Q>` is the queue. Asserted unique **and** inside the dispatch chain.                                                                                |
| Extract queue text           | `<fn>(<var>.value)` — near popAllEditable. **Not captured any more** — the rule is inlined into the predicate (see v2.1.241 note 3).                                                                                                                                                                                                 |
| queued_command handler (A2)  | 2.1.261: `case"attachment":if(<d>&&<e>.attachment.type==="queued_command"){let <P>=<smn>(<e>.attachment,<e>);if(<P>)yield{...<P>,session_id:<e>.session_id};return}`. 2.1.241: same `case` but `yield{...<seo>(…),session_id:…};return}` (non-nullable builder). Older: `else if(G&&<var>.attachment.type==="queued_command")yield{` |
| Session ID / UUID generators | `session_id:<fn>(),uuid:<fn>()` within the yield. **Not needed since 2.1.241** — the message's own `<e>.session_id` is in scope and uuid uses `globalThis.crypto.randomUUID()`.                                                                                                                                                      |
| sdk.mjs stopTask             | `async stopTask(<v>){await this.request({subtype:"stop_task",task_id:<v>})}`                                                                                                                                                                                                                                                         |

### Picking the right fallback (A1 injection point)

The anchor is the `else` arm that closes the stream-json control-request
dispatch chain:

```js
// 2.1.261
else <fn>(<msgVar>,`Unsupported control request subtype: ${<san>(String(<msgVar>.request.subtype))}`)
// ≤2.1.241
else <fn>(<msgVar>,`Unsupported control request subtype: ${<msgVar>.request.subtype}`)
```

Matched tail-less since v2.1.219, when the dispatch chain was wrapped in
`try/finally` (≤ v2.1.207 the anchor included
`;continue}else if(<msgVar>.type==="control_response")`).

Four other places emit the same sentence, and none of them is the loop ClaudeUI
drives:

| Decoy                                        | Shape                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Class-based SDK `Query` transport dispatcher | `throw Error("Unsupported control request subtype: "+e.request.subtype)` |
| `RemoteSessionManager`                       | logs, then `sendResponse({…error:\`Unsupported…\`})`                     |
| `DirectConnect` WebSocket router             | `else <log>(\`[DirectConnect] Unsupported…\`),this.sendErrorResponse(…)` |
| Device-hooks request handler                 | `default:return{kind:"error",error:\`Unsupported…\`}`                    |

(Plus several call-site classifiers that merely
`startsWith("Unsupported control request subtype")`.)

What excludes all of them: only the stdin loop's is `else <fn>(<msgVar>,` **with
the same `<msgVar>` backreferenced inside the template**.

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

### v2.1.261 changes

**0. The bundle is now code-split — read this first**

`vendor/claude-cli/cli.js` is the concatenation of 1,631 minified ESM chunks in
module-graph order, each preceded by `// @bun-chunk B:/~BUN/root/chunk-….js`.
Consequences for this patch:

- Every regex still runs over the whole concat unchanged. Just never write a
  `[\s\S]*?` span wide enough to bridge a delimiter; `[^\n]` bounds are free
  insurance, since chunk bodies are one long line each.
- **Scope is per chunk.** A name captured at its definition site is not a
  binding at an injection site in another chunk. This patch is unaffected only
  because everything it injects (`Xe`, `U`, `r`, and A2's `e`/`d`/`smn`) is read
  out of the same chunk it edits — `chunk-gj501zgt.js`, whose exports are
  `runHeadless` & co. `apply.mjs` asserts that rather than assuming it.
  (`background-task` and `usage-relay`, which anchor on the same fallback, DO
  need cross-chunk resolution — see their READMEs.)

Locate the chunk of any offset with:

```bash
node -e 'const s=require("fs").readFileSync("vendor/claude-cli/cli.js","utf8");
const i=+process.argv[1], b=s.lastIndexOf("// @bun-chunk",i);
console.log(s.slice(b, s.indexOf("\n", b)))' <char-offset>
```

**1. The fallback anchor gained a sanitizer — this is what broke all three patches**

```js
// 2.1.241
else Be(r,`Unsupported control request subtype: ${r.request.subtype}`)
// 2.1.261
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
```

`anchorRe` now admits either interpolation:

```js
;`\\$\\{(?:\\2\\.request\\.subtype|${V}\\(String\\(\\2\\.request\\.subtype\\)\\))\\}`
```

Still exactly 1 match. Find it with:

```bash
rg -o '.{60}Unsupported control request subtype.{60}' vendor/claude-cli/cli.js
```

which also shows the four decoys the backreference excludes.

**2. A2: the two sites collapsed back into ONE, and the builder went nullable**

2.1.241 needed two edits (`gGy` for the SDK transport, plus a separate stdin
site). In 2.1.261 the headless loop and the SDK transport share one normalizer,
`function*Au(e,t,o,{replayUserMessages:d,includePartialMessages:y})`, which
lives **in the same chunk as the control-request dispatch**:

```js
case"attachment":if(d&&e.attachment.type==="queued_command"){let P=smn(e.attachment,e);if(P)yield{...P,session_id:e.session_id};return}
if(e.attachment.type==="tool_host_result_lines"){yield imn(e.attachment,e.uuid,e.session_id);return}
yield*Al([e],e.session_id);return;
```

`smn(att,msg)` is the isReplay builder and is now **nullable** — it returns
`undefined` when `Jfe(att)` holds (a queued command carrying a
`forwardedIntent`), hence the `let P=…;if(P)yield` shape that every 2.1.241
pattern missed.

The patch no longer rewrites the branch; it **prepends** the notification and
leaves the original branch byte-identical behind it:

```js
case"attachment":/*PATCHED:queue-control-consumed*/if(e.attachment.type==="queued_command")yield{type:"system",subtype:"queued_command_consumed",prompt:e.attachment.prompt,source_uuid:e.attachment.source_uuid,session_id:e.session_id,uuid:globalThis.crypto.randomUUID()};if(d&&e.attachment.type==="queued_command"){let P=smn(e.attachment,e);…}
```

Replay stays gated on `d`; the nullable-builder guard, the `return`, the
`tool_host_result_lines` case and the `yield*Al` fallthrough are untouched.
The notification is deliberately **not** gated on `Jfe` — ClaudeUI correlates it
against its own queue by text, so an uncorrelated notification is a no-op while
a missing one strands a queue card.

_How the 2.1.241 "which site is the real one?" trap is now machine-checked:_
`apply.mjs` requires the A2 site to sit in the same chunk as the control-request
fallback. That chunk's only exports are `runHeadless`,
`endHeadlessSessionOnEscapedError`, `explicitMcpConfigRequestsWait` — i.e. it
_is_ the stdin stream-json path ClaudeUI drives. Patching a normalizer in any
other chunk now aborts loudly instead of shipping a notification that never
fires.

Find the site with:

```bash
rg -o 'case"attachment":.{0,200}queued_command.{0,120}' vendor/claude-cli/cli.js
```

**3. A1: the sibling-derived queue instance survived; the guardrails grew**

`cancel_async_message` still yields the queue instance, now `U`:

```js
else if(r.request.subtype==="cancel_async_message"){let T=r.request.message_uuid,F=U.isFoldInFlight(T)?[]:U.dequeueAllMatching((ue)=>ue.uuid===T);…
```

Two assertions were added around it, both cheap and both aimed at the 2.1.241
misbind class: the match must be **unique**, and it must fall **between the
dispatch-chain start and the anchor**. "In scope by construction" is only true
if the handler really is a sibling; a same-shaped match in another function
would name a local that does not exist at the injection point. The reply-helper
window is clamped to the same range for the same reason.

**4. The queue-push cross-check needed re-anchoring (and is otherwise dead)**

```js
// 2.1.241
function ne(Ze){if(!Z(Ze))return!1;return n.push({...GPf(Ze),priority:Ze.priority??"next",timestamp:…
// 2.1.261
function Cn(Fo,{receipt:Wo="coalesced"}={}){let _s=$n(Fo,Wo);if(!_s.admitted)return _s;if(d.push({...u7t(Fo),priority:Fo.priority??"next",timestamp:…
```

A second destructured parameter, and the admission guard now returns a **result
object** rather than a boolean. Instead of enumerating guard shapes,
`pushDefRe` admits any bounded single-line preamble and keeps only the two
identifying parts: the push spreads the function's own parameter (bare or
normalizer-wrapped) and stamps `priority:<param>.priority??"next"`.

**Note for whoever bumps this next:** `pushFn`/`queueArr` are never used by the
injection — they are a structural cross-check that the enqueue path still
exists. If re-anchoring them costs more than the assertion is worth, **delete
the block**; do not loosen it into something that can match the `"later"`
sibling.

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

1. `node patch/queue-control/apply.mjs` against a fresh pristine `cli.js` — exits 0,
   both markers reported OK. Run it again — both parts report "already applied".
2. **Read the patched region** (apply.mjs prints the offsets); on a chunked
   bundle also syntax-check the chunk you edited, which the whole-file
   `node --check` cannot do (the concat is not one valid module):

   ```bash
   node -e 'const fs=require("fs");const s=fs.readFileSync("vendor/claude-cli/cli.js","utf8");
   const i=s.indexOf("// @bun-chunk B:/~BUN/root/chunk-gj501zgt.js");
   const j=s.indexOf("// @bun-chunk", i+1);
   fs.writeFileSync("/tmp/c.mjs", s.slice(s.indexOf("\n",i)+1, j))'
   node --check /tmp/c.mjs
   ```

3. `node patch/apply-all.mjs` — patches apply with markers
4. `bun run typecheck` — no errors
5. Manual test:
   - Send a prompt that triggers a long tool call
   - Type a steer message mid-turn
   - QueuedMessageCard shows with Edit button
   - When consumed: message appears in chat, card disappears
   - Click Edit before consumption: text returns to input
