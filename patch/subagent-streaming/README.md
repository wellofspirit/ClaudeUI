# Patch: subagent-streaming

Sub-agent (Task tool) messages — including thinking tokens, text, and tool
use/results — never reach the SDK consumer. The parent model sees them
internally but the SDK stream only receives the final summarized result.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file (same file patched
by `task-notification`).

The SDK bundles its own copy of Claude Code CLI as `cli.js` in the package
directory. This file is executed by the SDK via `node` or `bun` when you call
`query()`. It is **independent** of the native `claude` binary installed on
your system, and may trail behind in version.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.38 → 0.2.39 → 0.2.41 → 0.2.42 |
| Bundled CLI (`cli.js`) | 2.1.38 → 2.1.39 → 2.1.41 → 2.1.42 |

All versions exhibit the same behavior. Function names change between
versions but the architecture is identical.

## The Problem

When Claude Code spawns a sub-agent via the `Task` tool, the sub-agent runs
a full conversation loop internally (multiple API calls, tool uses, thinking,
text responses). None of these intermediate messages are visible to SDK
consumers. The SDK only receives:

1. The parent's `tool_use` block for the Task tool
2. `tool_progress` elapsed-time ticks
3. The parent's `tool_result` containing a text-only summary

Thinking tokens, streaming text deltas, individual text blocks, and
stream events from the sub-agent are all invisible.

## Architecture Overview

### How the parent streaming loop works

```
TMq() → NMq.submitMessage() generator
  │
  ├─ yields assistant messages     → P.enqueue → SDK stdout
  ├─ yields user messages          → P.enqueue → SDK stdout
  ├─ yields stream_events          → P.enqueue → SDK stdout
  ├─ yields progress messages      → ZhA() converts → P.enqueue → SDK stdout
  └─ yields result                 → P.enqueue → SDK stdout
```

`P` is an `xU1` async queue. Everything enqueued to `P` flows to stdout and
reaches the SDK consumer via `transport.readMessages()`.

### How the Task tool executes a sub-agent

```
NMq.submitMessage() iterates the query loop
  │
  ▼
Tool executor encounters Task tool_use
  │
  ▼
Task.call(input, context, canUseTool, message, progressCallback)
  │
  ├─ Creates dR() generator (sub-agent execution loop)
  ├─ Iterates dR() collecting messages in O1[]
  │     │
  │     ├─ Sub-agent assistant messages (text, thinking, tool_use)
  │     ├─ Sub-agent user messages (tool_result)
  │     └─ Sub-agent stream_events (deltas)
  │
  ├─ Calls progressCallback(j) for SOME messages
  │     └─ Only tool_use and tool_result blocks (see Filter #1)
  │
  └─ Returns UEA() result with text-only content (see Filter #2)
```

The sub-agent's `dR()` generator yields full messages with all content block
types. But these messages are consumed entirely within `Task.call()` — they
are never yielded back to the parent's `NMq.submitMessage()` generator.

### How progress messages flow to the SDK

When the Task tool's progress callback `j` is called:

```
j({toolUseID: `agent_${D.message.id}`, data: {...}})
  │
  ▼
Tool executor wraps via U1q()/O6q():
  {type:"progress", data:..., toolUseID:..., parentToolUseID:...,
   uuid:_f(), timestamp:...}
  │
  ▼
Yielded from tool executor to parent NMq.submitMessage() generator
  │
  ▼
ZhA()/ihA() converts to SDK output format:
  For data.type==="agent_progress":
    → yields {type:"assistant", parent_tool_use_id:..., ...} for assistant msgs
    → yields {type:"user", parent_tool_use_id:..., ...} for user msgs
  │
  ▼
P.enqueue → SDK stdout
```

Key function `U1q()` / `O6q()` wraps progress callback arguments:

```js
// v2.1.38: U1q, char ~10400725
// v2.1.39: O6q, char ~10407267
function O6q({toolUseID:A,parentToolUseID:q,data:K}){
    return{type:"progress",data:K,toolUseID:A,parentToolUseID:q,
           uuid:_f(),timestamp:new Date().toISOString()}
}
```

This is the bridge between the Task tool's progress callback and the parent
generator. Our patches use this existing bridge — we just call `j()` with
new data types, and `U1q()` wraps them automatically.

## Root Cause: Four Filters

### Filter #0 — cR yield filter drops stream_event (RVY)

Location: `RVY()` function, used as the yield gate inside `cR()` (the
sub-agent query loop generator).

```js
// v2.1.39: RVY, char ~7907312
function RVY(A) {
    return A.type === "assistant" ||
           A.type === "user" ||
           A.type === "progress" ||
           A.type === "system" && "subtype" in A && A.subtype === "compact_boundary"
}
```

`cR()` iterates `fR()` (the inner query loop), which yields all message
types including `{type: "stream_event", event: ...}` for every raw API
event (content_block_delta, content_block_start, etc.). But `cR()` only
yields messages that pass `RVY()`:

```js
// Inside cR(), char ~7967730
for await (let $1 of fR({...})) {
    // ...
    if (RVY($1))
        x.push($1), ..., yield $1    // ← only if RVY returns true
}
```

**Effect:** `stream_event` is not in the RVY whitelist, so ALL sub-agent
stream events are silently dropped inside `cR()`. They never reach the
Task tool's for-await loop where Patch B would forward them. This is the
**primary root cause** of missing sub-agent streaming — without fixing
this, Patches B and C have no effect on the sync path.

**Discovery:** We observed that Patch B (which intercepts `stream_event`
in the Task tool's for-await loop) was never triggered — zero
`stream_event` messages appeared in debug logs. Tracing upstream revealed
`cR()` filters via `RVY()` before yielding.

**Pitfall — O1 collection array corruption:** We cannot simply add
`stream_event` to `RVY()` because the yield line also pushes to the
collection array `x[]` and records to transcript via `E51()`. Stream
events lack `.message` and `.uuid` properties that those operations
expect, causing "Cannot read properties of undefined (reading 'type')"
errors in downstream result processing (`_kA`, `dP`). See Patch F for
the safe approach.

### Filter #1 — Progress callback only sends tool_use/tool_result

Location: Task tool sync path, inside the for-await loop that iterates
sub-agent messages.

```js
// v2.1.38: char ~7988696
// v2.1.39: char ~7991000
//
// Variable names change between versions:
//   v2.1.38: $1, _1, G1, j, D, T1, A, z, r
//   v2.1.39: X1, P1, f1, j, D, T1, A, z, r

// Inside the Task tool's sync for-await loop:
for (let z1 of dR({...})) {           // dR = sub-agent generator
    O1.push(z1);                        // collect ALL messages

    if (z1.type === "assistant") {
        let _1 = iO([z1]);             // normalize to individual content blocks
        T1.push(..._1);

        for (let $1 of _1) {
            for (let G1 of $1.message.content) {
                // ↓↓↓ FILTER: only tool_use and tool_result ↓↓↓
                if (G1.type !== "tool_use" && G1.type !== "tool_result") continue;
                if (j) j({
                    toolUseID: `agent_${D.message.id}`,
                    data: {
                        message: $1,
                        normalizedMessages: T1,
                        type: "agent_progress",
                        prompt: A,
                        resume: z,
                        agentId: r
                    }
                });
            }
        }
    }
}
```

**Effect:** Text blocks (`type: "text"`) and thinking blocks
(`type: "thinking"`) are never sent through the progress callback. Only
messages containing tool_use or tool_result blocks trigger progress reports.

The progress callback `j` is the 5th parameter to `Task.call()`. When called,
the progress message flows through `ZhA()` which converts it to SDK-format
messages with `parent_tool_use_id` set, then they're yielded to the parent
generator and enqueued to `P` (SDK stdout).

### Filter #2 — Stream events silently dropped

Location: Same for-await loop, just before Filter #1.

```js
// v2.1.38: char ~7988696 (O1, Y1)
// v2.1.39: char ~7991000 (J1, w1)

let Y1 = z1.value;                    // unwrap the generator result
if (O1.push(Y1),
    Y1.type !== "assistant" && Y1.type !== "user")
    continue;                          // ← stream_events DROPPED here
```

**Effect:** Sub-agent `stream_event` messages (which carry `thinking_delta`,
`text_delta`, `content_block_start`, `content_block_stop`, etc.) are pushed
to the collection array `O1` but then skipped by `continue`. They never
reach the progress callback. The entire streaming experience of the
sub-agent is invisible.

This is separate from Filter #1 — even if we fixed Filter #1, stream events
would still be dropped because they're filtered by message type before the
content-block loop is reached.

### Filter #3 — Task result extracts text-only content

Location: `UEA()` function.

```js
// v2.1.38: char ~7983000
// v2.1.39: similar location

function UEA(A, q, K) {
    let O = GN(A);                     // get last assistant message
    // ↓↓↓ FILTER: only text blocks ↓↓↓
    let _ = O.message.content.filter((D) => D.type === "text");
    // ...
    return {
        agentId: q,
        content: _,                    // text-only
        totalDurationMs: ...,
        totalTokens: ...,
        totalToolUseCount: ...,
        usage: ...
    };
}
```

**Effect:** The final Task tool result returned to the parent model contains
only text blocks. All thinking is stripped. This is what appears in the
`tool_result` message in the SDK stream.

**We intentionally do NOT patch this.** Including thinking tokens in the task
result would waste the parent model's context window. The parent doesn't need
to see the sub-agent's internal reasoning — it just needs the final answer.

### Filter #4 — Output file writer strips non-text

Location: Text extraction function (`FM6` in v2.1.38, `sM6` in v2.1.39)
and the background agent polling loop.

```js
// v2.1.38: FM6, char ~9019631
// v2.1.39: sM6, char ~9022069

function FM6(A, q = "Execution completed") {
    let K = GN(A);                     // get last assistant message
    if (!K) return q;
    // ↓↓↓ FILTER: only text blocks ↓↓↓
    return K.message.content
        .filter((z) => z.type === "text")
        .map((z) => ("text" in z) ? z.text : "")
        .join("\n") || q;
}
```

And in the background agent polling loop:

```js
// v2.1.38: char ~8589577
// v2.1.39: char ~8592091

let j = J.map((M) => {
    if (M.type === "assistant")
        // ↓↓↓ FILTER: only text blocks ↓↓↓
        return M.message.content
            .filter((P) => P.type === "text")
            .map((P) => ("text" in P) ? P.text : "")
            .join("\n");
    return Q1(M);                      // JSON.stringify for non-assistant messages
}).join("\n");
if (j) ZK1(A, j + "\n");             // append to .output file
```

**Effect:** The `.output` file (used for background agents, tailed via `Read`
tool) only contains text from assistant messages. Thinking tokens, tool use
blocks, and tool result details are all discarded for assistant messages.
Non-assistant messages (user, tool_result) are JSON-stringified in full.

## Message Flow Diagram — Before Patching

```
fR() inner query loop (yields ALL message types from API)
  │
  ▼
cR() sub-agent query loop (filters via RVY before yielding)
  │
  ├── stream_event (thinking_delta, text_delta, etc.)
  │     └── DROPPED (Filter #0)       ← RVY() returns false for stream_event
  │                                       Never reaches Task tool's for-await
  │
  ├── assistant msg: [thinking, text, tool_use]
  │     │
  │     ├── RVY() returns true         ← yielded to Task tool
  │     │
  │     └── Task tool for-await:
  │           ├── O1.push(msg)         ← collected
  │           ├── thinking block       ← DROPPED (Filter #1)
  │           ├── text block           ← DROPPED (Filter #1)
  │           └── tool_use block       ← progress callback j()
  │                 │
  │                 ▼
  │               U1q() wraps → {type:"progress", data:{type:"agent_progress",...}}
  │                 │
  │                 ▼
  │               ZhA() converts → {type:"assistant", parent_tool_use_id:...}
  │                 │
  │                 ▼
  │               P.enqueue → SDK stdout    ← only tool_use messages arrive!
  │
  ├── user msg: [tool_result]
  │     │
  │     └── tool_result block         ← progress callback j()
  │           │
  │           ▼
  │         (same path as above)      ← tool_result messages arrive
  │
  └── (loop ends)
        │
        ▼
      UEA(O1, agentId, ...)
        │
        ├── Iterates O1 — expects all items to have .message.content
        ├── Extracts text-only (Filter #3) — NOT PATCHED (by design)
        │
        ▼
      return {status:"completed", content: [text blocks only]}
        │
        ▼
      Parent receives tool_result with text summary only
```

## Message Flow Diagram — After Patching (Sync Path, Patches F+A+B+C)

```
fR() inner query loop (yields ALL message types from API)
  │
  ▼
cR() sub-agent query loop (Patch F: stream_event bypasses RVY)
  │
  ├── stream_event (thinking_delta, text_delta, etc.)
  │     │
  │     ├── (Patch F) yield directly — NOT pushed to x[], NOT recorded
  │     │
  │     └── Task tool for-await:
  │           ├── (Patch B) intercepted BEFORE O1.push — NOT collected
  │           └── j({data:{type:"agent_stream_event", event:...}})
  │                 │
  │                 ▼
  │               O6q() wraps → {type:"progress", data:{type:"agent_stream_event",...}}
  │                 │
  │                 ▼
  │               (Patch C) ZhA() yields → {type:"stream_event", parent_tool_use_id:...}
  │                 │
  │                 ▼
  │               P.enqueue → SDK stdout ✓  ← stream events now arrive!
  │
  ├── assistant msg: [thinking, text, tool_use]
  │     │
  │     ├── O1.push(msg)              ← collected (has .message, safe for UEA)
  │     ├── (Patch A) ALL blocks trigger progress callback
  │     │
  │     ├── thinking block            ← progress callback j() ✓
  │     ├── text block                ← progress callback j() ✓
  │     └── tool_use block            ← progress callback j() ✓
  │           │
  │           ▼
  │         O6q() → ZhA() → P.enqueue → SDK stdout
  │
  ├── user msg: [tool_result]         ← (unchanged, already worked)
  │
  └── (loop ends)
        │
        ▼
      UEA(O1) → text-only result     ← O1 contains only assistant/user msgs (safe)
```

**Critical safety property:** Stream events are excluded from both
collection arrays — `x[]` in `cR()` (Patch F) and `O1[]` in the Task
tool (Patch B). This prevents "Cannot read properties of undefined
(reading 'type')" errors from downstream functions (`UEA`, `_kA`, `dP`)
that iterate these arrays and access `.message.content`.

## Message Flow Diagram — After Patching (Async Path, Patches F+E)

```
Background sub-agent cR() generator (inside q01 async context)
  │  (Patch F applies here too — cR yields stream_events without collecting)
  │
  ├── stream_event
  │     │
  │     └── (Patch E) intercepted BEFORE N1.push — NOT collected
  │           → process.stdout.write(JSON + "\n")
  │           → {type:"stream_event", event:..., parent_tool_use_id:_ptu}
  │           → SDK readline → q4() parse → consumer ✓
  │
  ├── assistant msg
  │     │
  │     ├── N1.push(msg)              ← collected (has .message, safe for _kA)
  │     └── (Patch E) process.stdout.write(JSON + "\n")
  │           → {type:"assistant", message:..., parent_tool_use_id:_ptu}
  │           → SDK readline → q4() parse → consumer ✓
  │
  ├── user msg
  │     │
  │     ├── N1.push(msg)              ← collected
  │     └── (Patch E) process.stdout.write(JSON + "\n")
  │           → {type:"user", message:..., parent_tool_use_id:_ptu}
  │           → SDK readline → q4() parse → consumer ✓
  │
  ├── result                          ← not forwarded (no streaming value)
  │
  └── (loop ends)
        │
        ▼
      _kA(N1) → text-only result     ← N1 contains only assistant/user msgs (safe)
```

Note: `_ptu` is the `parent_tool_use_id`, resolved by searching
`D.message.content` for the `tool_use` block matching this Task call's
description. The progress callback `j()` is dead in the async path, so
Patch E bypasses the entire O6q/ZhA pipeline and writes directly to
stdout.

## The Patches

### Patch F — cR yield — stream_event bypass before RVY

**Fixes Filter #0.** Injects a `stream_event` check before the `RVY()`
gate in `cR()`'s for-await loop, yielding stream_events directly without
collecting them into the results array or recording them to transcript.

We cannot simply add `stream_event` to `RVY()` because the yield line
also pushes to the collection array `x[]` and records to transcript via
`E51()`. Stream events lack `.message` and `.uuid` properties that
those operations expect, causing "Cannot read properties of undefined
(reading 'type')" errors in downstream result processing (`_kA`, `dP`).

Before:

```js
if (RVY($1))
    x.push($1), await E51([$1], f, a).catch(...), a = $1.uuid, yield $1
```

After:

```js
if ($1.type === "stream_event") { yield $1 }
else if (RVY($1))
    x.push($1), await E51([$1], f, a).catch(...), a = $1.uuid, yield $1
```

**Why this approach over modifying RVY:**
- Modifying RVY to include `stream_event` causes stream events to be:
  - Pushed to `x[]` — later processed by `_kA()` which expects `.message.content`
  - Passed to `E51()` which expects a `.uuid` property
  - Setting `a = $1.uuid` to `undefined`, corrupting transcript chain
- By intercepting before `RVY()`, we yield without side effects

**Why this is safe:**
- `stream_event` messages are lightweight (`{type, event}`) — no state
  to track
- They don't need transcript recording (they're transient deltas)
- They don't affect the results array (they're not final messages)
- The Task tool's for-await loop (Patch B) handles them correctly

**How to find this code in a new version:**
1. Find the RVY function by its unique type-check pattern:

```
function.*type==="assistant".*type==="user".*type==="progress".*compact_boundary
```

2. Find its call site: `if(RVY(VAR))ARR.push(VAR),` inside `cR()`

### Patch A — Content-block filter removal

**Removes Filter #1.** The inner loop over content blocks and the
`tool_use`/`tool_result` type check are replaced with a simpler loop that
fires the progress callback once per normalized message.

Before:

```js
for (let $1 of _1)
    for (let G1 of $1.message.content) {
        if (G1.type !== "tool_use" && G1.type !== "tool_result") continue;
        if (j) j({toolUseID: `agent_${D.message.id}`, data: {
            message: $1, normalizedMessages: T1,
            type: "agent_progress", prompt: A, resume: z, agentId: r
        }});
    }
```

After:

```js
for (let $1 of _1) {
    if (j) j({toolUseID: `agent_${D.message.id}`, data: {
        message: $1, normalizedMessages: T1,
        type: "agent_progress", prompt: A, resume: z, agentId: r
    }});
}
```

The inner `for (let G1 of $1.message.content)` and the
`if (G1.type !== "tool_use" ...)` filter are both removed. The callback now
fires once per normalized message regardless of what content blocks it
contains.

**Why this is safe:**
- `ZhA()` already handles `agent_progress` data type correctly for both
  assistant and user messages
- The `iO()` normalization splits multi-block messages into individual
  messages (one content block each), so each progress callback call contains
  exactly one content block
- The SDK consumer sees the same message structure, just with additional
  content block types it wasn't seeing before (text, thinking)
- The parent model's tool_result (via UEA) is not affected

**How to find this code in a new version:**
Search for the unique pattern of nested for-loops with a `tool_use`/
`tool_result` type check followed by a progress callback call containing
`agent_progress`:

```
type!=="tool_use"&&.*type!=="tool_result".*continue.*agent_progress
```

### Patch B — Stream event forwarding (before O1.push)

**Removes Filter #2.** Intercepts `stream_event` messages **before** the
`O1.push()` call and forwards them through the progress callback as a new
`agent_stream_event` data type. Stream events never enter the `O1`
collection array.

Before:

```js
if (O1.push(Y1),
    Y1.type !== "assistant" && Y1.type !== "user")
    continue;
```

After:

```js
if (Y1.type === "stream_event") {
    if (j) j({
        toolUseID: `agent_${D.message.id}`,
        data: {type: "agent_stream_event", event: Y1.event, agentId: r}
    });
    continue
}
if (O1.push(Y1),
    Y1.type !== "assistant" && Y1.type !== "user")
    continue;
```

The stream_event check is a separate `if` block that runs **before** the
original `if(O1.push(Y1),...)` statement. When a stream_event is
detected, it's forwarded and skipped via `continue` — the `O1.push()`
line is never reached.

**Why stream_events must NOT enter O1:**
- `O1` is passed to `UEA()` when the Task tool finishes
- `UEA()` calls `GN(O1)` to get the last assistant message, then
  iterates `.message.content` to extract text blocks
- Stream events have `{type, event}` structure — no `.message` property
- If stream_events are in O1, downstream processing crashes with
  "Cannot read properties of undefined (reading 'type')" when
  `_kA()` or `dP()` access `.message.content` on a stream_event

**Why this is safe:**
- Stream events are forwarded via the progress callback before being
  skipped — they reach the SDK consumer via Patch C
- All other message types (assistant, user, system, progress) follow the
  original code path and are pushed to O1 normally
- The `U1q()` wrapper adds `uuid`, `timestamp`, and `parentToolUseID`
  automatically

**How to find this code in a new version:**
Search for the comma-expression pattern that pushes to an array and then
checks for assistant/user type:

```
\.push\(.*\.type!=="assistant"&&.*\.type!=="user"\)continue
```

### Patch C — ZhA/ihA handler for agent_stream_event

**Adds a new handler in the message converter.** The `ZhA()` (v2.1.38) /
`ihA()` (v2.1.39) generator function converts internal messages to SDK
output format. We add handling for the new `agent_stream_event` data type
so it yields proper `{type: "stream_event", parent_tool_use_id}` SDK
messages.

Injected before the `bash_progress` handler:

```js
else if (A.data.type === "agent_stream_event") {
    yield {
        type: "stream_event",
        event: A.data.event,
        parent_tool_use_id: A.parentToolUseID,
        session_id: U6(),
        uuid: A.uuid
    }
}
```

**The full ZhA/ihA function structure (for reference):**

```js
// v2.1.38: function*ZhA(A), char ~9069375
// v2.1.39: function*ihA(A), char ~9085100
function* ZhA(A) {
    switch (A.type) {
        case "assistant":
            // Direct assistant messages (from parent model)
            for (let q of iO([A])) {
                if (!et(q)) continue;
                yield {type:"assistant", message:q.message,
                       parent_tool_use_id:null, session_id:U6(), ...};
            }
            return;

        case "progress":
            if (A.data.type === "agent_progress")
                // Sub-agent messages (our Patch A sends more through here)
                for (let q of iO([A.data.message]))
                    switch (q.type) {
                        case "assistant":
                            yield {type:"assistant", parent_tool_use_id:A.parentToolUseID, ...};
                            break;
                        case "user":
                            yield {type:"user", parent_tool_use_id:A.parentToolUseID, ...};
                            break;
                    }

            // ← Patch C injects here ←
            // else if (A.data.type === "agent_stream_event") { yield ... }

            else if (A.data.type === "bash_progress")
                // Bash tool progress (elapsed time)
                yield {type:"tool_progress", ...};
            break;

        case "user":
            // Direct user messages
            ...
    }
}
```

**Why this is safe:**
- `ZhA` is a generator function — our injected `yield` integrates naturally
- The yielded message matches the SDK's `stream_event` Zod schema:
  `{type, event, parent_tool_use_id, uuid, session_id}`
- `A.parentToolUseID` comes from `U1q()` wrapping (set by the tool executor)
- `A.uuid` comes from `U1q()` wrapping (generated by `_f()`)
- `U6()` is the session ID function (same one used by all other yields in
  this function)
- The `else if` placement means it only triggers for the new
  `agent_stream_event` type — existing `agent_progress` and `bash_progress`
  paths are untouched

**How to find this code in a new version:**
Search for a generator function that contains both `agent_progress` and
`bash_progress` string literals, with `parent_tool_use_id` in yields:

```
function\*.*agent_progress.*bash_progress
```

Or search for the `bash_progress` anchor specifically:

```
else if(A.data.type==="bash_progress"){
```

This pattern is unique in the codebase (verified: only 1 occurrence).

### Patch D — .output file thinking inclusion

**Patches Filter #4.** Updates the text extraction function and background
agent output writer to include thinking blocks alongside text blocks.

For the text extraction function:

Before:

```js
.filter((z) => z.type === "text")
.map((z) => ("text" in z) ? z.text : "")
```

After:

```js
.filter((z) => z.type === "text" || z.type === "thinking")
.map((z) => ("text" in z) ? z.text : ("thinking" in z) ? z.thinking : "")
```

The same change is applied to the background agent polling map.

**Note on text extraction function naming:**
- v2.1.38: `FM6` at char ~9019631
- v2.1.39: `sM6` at char ~9022069
- The function structure is stable: `function NAME(A, q="Execution completed")`
  followed by `GN(A)` / `PN(A)` / `HN(A)` call (get-last-assistant-message),
  then `.filter().map().join()`

**How to find this code in a new version:**
Search for the unique function signature with "Execution completed" default:

```
function.*="Execution completed".*\.filter.*type==="text"
```

For the background polling map, search for:

```
\.map.*type==="assistant".*\.filter.*type==="text".*\.join.*return.*\(
```

This pattern is unique — it's the only place that maps over messages,
extracts text from assistant messages, and JSON-stringifies everything else.

### Patch E — Background agent stdout streaming

**Bypasses the dead progress callback for async (background) agents.**
When the Task tool runs with `run_in_background: true`, the tool executor
returns immediately with an `async_launched` result. The actual sub-agent
runs inside a `q01()` async context. At this point the progress callback
`j()` is dead — its output queue has been closed by the tool executor.

Patch E injects code into the background agent's `for await` loop to
write sub-agent messages directly to stdout as newline-delimited JSON.
Like Patch B, stream_events are intercepted **before** the collection
array push (`N1.push`) to prevent downstream crashes.

Before (async for-await body is a single statement):

```js
for await (let D1 of cR({...}))
    N1.push(D1), s01(...), s0A(agentId, ...);
```

After (wrapped in block with stdout writes):

```js
for await (let D1 of cR({...})) {
    if (D1.type === "stream_event") {
        // Stream events: forward directly, do NOT push to N1
        let _ptu = null;
        for (let _b of D.message.content) {
            if (_b.type === "tool_use" && _b.input && _b.input.description === K) {
                _ptu = _b.id; break;
            }
        }
        process.stdout.write(JSON.stringify({
            type: "stream_event", event: D1.event,
            parent_tool_use_id: _ptu, session_id: p6(), uuid: _f()
        }) + "\n");
    } else {
        // Non-stream: original push + stats + state, then forward
        N1.push(D1), s01(...), s0A(agentId, ...);

        let _ptu = null;
        for (let _b of D.message.content) {
            if (_b.type === "tool_use" && _b.input && _b.input.description === K) {
                _ptu = _b.id; break;
            }
        }
        if (D1.type === "assistant")
            process.stdout.write(JSON.stringify({
                type: "assistant", message: D1.message,
                parent_tool_use_id: _ptu, session_id: p6(), uuid: _f()
            }) + "\n");
        else if (D1.type === "user")
            process.stdout.write(JSON.stringify({
                type: "user", message: D1.message,
                parent_tool_use_id: _ptu, session_id: p6(), uuid: _f()
            }) + "\n");
    }
}
```

There are **two** async for-await loops patched — one in the initial
async launch path, and one in the "backgrounded from sync" path (where
a sync task transitions to background mid-execution).

**Key design decisions and pitfalls:**

#### stdout transport: newline-delimited JSON, NOT binary framing

The CLI has a binary transport function (`fY1` in v2.1.39) that writes
a 4-byte UInt32LE length header followed by the message body:

```js
function fY1(A) {
    let q = Buffer.from(A, "utf-8"),
        K = Buffer.alloc(4);
    K.writeUInt32LE(q.length, 0),
    process.stdout.write(K),
    process.stdout.write(q)
}
```

**Do NOT use this function.** The SDK's `readMessages()` in `sdk.mjs`
reads stdout as **newline-delimited JSON lines**, not binary-framed:

```js
async* readMessages() {
    let X = WV({input: this.processStdout}); // readline interface
    for await (let Q of X)
        if (Q.trim())
            yield q4(Q)  // JSON.parse + Zod validation
}
```

Using `fY1()` corrupts the stream — the 4-byte binary header is
interpreted as text. For example, a message of length 597 (0x00000255)
produces header bytes `55 02 00 00`, where `0x55` = ASCII `U`. The SDK
sees `U{"type":"assistant",...}` and throws:

```
Error: CLI output was not valid JSON. This may indicate an error during
startup. Output: U{"type":"assistant",...}
```

The correct approach is `process.stdout.write(JSON.stringify(msg) + "\n")`.

The `fY1()` binary transport appears to be used for a different purpose
(possibly the interactive TUI mode or tmux pane communication), not for
SDK stdout communication.

#### parent_tool_use_id: finding the right tool_use block

The `D` parameter (4th arg to `Task.call()`) is the **full, un-normalized**
assistant message from the parent model. The tool executor does NOT pass
an iO-normalized single-block message — `D.message.content` contains ALL
content blocks from the assistant turn.

When the model outputs text before tool calls (common pattern), the
content array looks like:

```js
D.message.content = [
    {type: "text", text: "I'll launch 5 tasks..."},   // NO .id
    {type: "tool_use", id: "toolu_01K...", name: "Task", input: {...}},
    {type: "tool_use", id: "toolu_01C...", name: "Task", input: {...}},
    // ...
]
```

**Do NOT use `D.message.content[0].id`** — `content[0]` is often a text
or thinking block, which has no `id` property. The result is `undefined`,
which gets omitted by `JSON.stringify`, causing the SDK's Zod validation
to reject the message (the `parent_tool_use_id` field is required, though
nullable).

Instead, find the matching `tool_use` block by matching the `description`
field from the destructured input (variable `K` in the minified code):

```js
let _ptu = null;
for (let _b of D.message.content) {
    if (_b.type === "tool_use" && _b.input && _b.input.description === K) {
        _ptu = _b.id; break;
    }
}
```

This correctly identifies the specific Task tool_use block even when
multiple Task calls coexist in the same message (e.g., 5 parallel
background tasks).

#### Tool executor architecture (for reference)

The tool executor chain for understanding how `D` and `parentToolUseID`
flow:

```
sdY(tool, toolUseId, input, context, canUseTool, message, ...)
  │
  ├─ Wraps progress callback:
  │    (X) => O6q({toolUseID: X.toolUseID, parentToolUseID: toolUseId, ...})
  │
  └─ tdY(tool, toolUseId, input, context, canUseTool, message, ...)
       │
       └─ tool.call(input, context, canUseTool, message, progressCallback)
```

- `O6q` (v2.1.39) = `U1q` (v2.1.38) — wraps progress data with
  `parentToolUseID`, `uuid`, `timestamp`
- The `parentToolUseID` is the tool_use_id from the executor (correct)
- But `call()` only receives `D` (the message), not the tool_use_id
  directly — hence the need to search `D.message.content`

**How to find this code in a new version:**

Search for async for-await loops that use `cR({` (the sub-agent execution
function) and contain `s0A` (the task state updater):

```
for await.*cR\(\{.*\.push\(.*s0A\(
```

Or search for the push+stats+state pattern after `))`:

```
\)[\w$]+\.push\([\w$]+\),[\w$]+\([\w$]+,[\w$]+,[\w$]+,[\w$]+\.options\.tools\),[\w$]+\(
```

**v2.1.42 gotcha — initial async loop `isAsync` is a variable:**

In v2.1.42, the initial async path (where `run_in_background: true` from
the start) builds an `n` object containing `isAsync:g` (where `g` is a
variable), then spreads `{...n,...}` into the `Wy()` call. The literal
`isAsync:!0` does NOT appear near this loop. Only the "backgrounded from
sync" loop passes `isAsync:!0` directly.

The `apply.mjs` filter was originally checking for literal `isAsync:!0`
within 500 chars before the loop body. In v2.1.42, the `isAsync:g` is
~713 chars before the loop body pattern, so the initial async loop was
silently skipped. This caused:

1. Stream events from `Wy()` entering the collection array `N1`
2. `uRA(N1)` → `pCY(N1)` → `j$(N1)` where the normalize function
   has no `case "stream_event"` in its switch, returning `undefined`
   from the `flatMap` callback
3. Downstream code accessing `.type` on `undefined` → crash:
   `Cannot read properties of undefined (reading 'type')`

Fix: Changed the filter to use a 1000-char window and only require
`for await` (dropping the `isAsync` literal check). The `for await` +
`))ARR.push(MSG),STATS(...)` pattern is specific enough to only match
the two background agent loops.

## What's NOT Changed

**UEA (task result)** — The final result returned to the parent model from
a sub-agent still contains text-only content. Thinking tokens are not
included in the task result, as they would waste the parent model's context
window. The parent doesn't need the sub-agent's internal reasoning — it
just needs the final answer.

## What the SDK Consumer Now Receives

For a sub-agent that thinks, writes text, calls Read tool, then responds:

```
 1. {type:"assistant", content:[{type:"tool_use", name:"Task",...}]}
      ← parent calls Task

 2. {type:"stream_event", parent_tool_use_id:"X",
      event:{type:"content_block_delta", delta:{type:"thinking_delta",...}}}
      ← sub-agent thinking delta (NEW, Patch B+C)

 3. {type:"stream_event", parent_tool_use_id:"X",
      event:{type:"content_block_delta", delta:{type:"text_delta",...}}}
      ← sub-agent text delta (NEW, Patch B+C)

 4. {type:"assistant", parent_tool_use_id:"X",
      content:[{type:"thinking", thinking:"..."}]}
      ← sub-agent thinking block (NEW, Patch A)

 5. {type:"assistant", parent_tool_use_id:"X",
      content:[{type:"text", text:"..."}]}
      ← sub-agent text block (NEW, Patch A)

 6. {type:"assistant", parent_tool_use_id:"X",
      content:[{type:"tool_use", name:"Read",...}]}
      ← sub-agent tool call (already worked)

 7. {type:"user", parent_tool_use_id:"X",
      content:[{type:"tool_result",...}]}
      ← sub-agent tool result (already worked)

 8. {type:"tool_progress", tool_name:"Task", elapsed_time_seconds:5}
      ← progress ticks (unchanged)

 9. {type:"user", content:[{type:"tool_result",
      text:"Agent completed: ...text-only summary..."}]}
      ← final result, text only (unchanged, UEA not patched)

10. {type:"assistant", content:[...]}
      ← parent continues with sub-agent's text summary
```

Messages from sub-agents carry `parent_tool_use_id` for attribution.

## Where Thinking Tokens Exist After Patching

| Location | Has thinking? | Accessible? |
|---|---|---|
| Sub-agent `dR()` yield (sync) | Yes | Yes — forwarded via Patch A |
| Sub-agent stream_events (sync) | Yes | Yes — Patch F unblocks cR, B+C forward |
| Sub-agent messages (async/bg) | Yes | Yes — forwarded via Patch E |
| SDK stdout stream | Yes | Yes — `parent_tool_use_id` set |
| `.output` file (background) | Yes | Yes — included via Patch D |
| Sub-agent transcript (`.jsonl`) | Yes | Yes — always had it |
| Main session transcript (`.jsonl`) | Yes | Yes — via progress messages |
| Task tool_result (UEA) | No | N/A — intentionally excluded |

## Applying the Patch

```bash
node patch/subagent-streaming/apply.mjs
```

The script locates functions by **content pattern** rather than minified
names, since function names change between versions. It will:

1. Find `cli.js` in the SDK package
2. Locate the cR yield filter function by type-check pattern (Patch F)
3. Locate the content-block filter by nested for-loop pattern (Patch A)
4. Locate the type filter by push+type-check pattern (Patch B)
5. Locate the message converter by `bash_progress` anchor (Patch C)
6. Locate the text extraction function by "Execution completed" pattern (Patch D)
7. Locate the background polling map by assistant/text/stringify pattern (Patch D)
8. Locate the session ID function from ZhA/ihA yields (Patch E)
9. Locate async for-await+cR loops by body pattern (Patch E)
10. Apply all patches and verify markers

### Re-applying after SDK updates

After running `bun install` or updating `@anthropic-ai/claude-agent-sdk`, the
patch needs to be re-applied since `cli.js` will be replaced. Run:

```bash
node patch/task-notification/apply.mjs
node patch/subagent-streaming/apply.mjs
```

Both patches coexist safely. Apply order doesn't matter.

The script is idempotent — it detects if patches are already applied and
skips them.

### When the patch breaks

If a future SDK version changes the code structure enough that pattern
matching fails, the script will exit with an error explaining what it
couldn't find. In that case:

1. Check if the bug is fixed upstream — test if sub-agent thinking/text/
   stream events appear in the SDK stream without patching
2. If not fixed, extract and inspect the new `cli.js` to find equivalent
   functions using the search patterns listed in each patch section above
3. Update the regex patterns in `apply.mjs`

## Verification

After patching, launch a session and ask the model to use the Task tool
(e.g., "use the Task tool to read file X"). In the console you should see:

```
[SDK msg] type=stream_event event.type=content_block_delta
```

With `parent_tool_use_id` set (indicating it's from a sub-agent, not the
parent). You should also see assistant messages with thinking content:

```
[SDK msg] type=assistant subkeys=[type,message,parent_tool_use_id,session_id,uuid]
```

Where the message content includes `type:"thinking"` blocks.

## Key Functions Reference

| Name (v2.1.38 → v2.1.39 → v2.1.41 → v2.1.42) | Purpose |
|---|---|
| `RVY()` → `RVY()` → `BRY()` → `myY()` | cR/jy/Wy yield filter (gates what the generator yields to callers) |
| `dR()` → `dR()` → ? → (merged into Wy) | Sub-agent execution generator |
| `UEA()` → `UEA()` → `NR8()` → `uRA()` | Extract text-only result from agent messages |
| `FM6()` → `sM6()` → `QW6()` → `tW6()` | Extract text from last assistant message |
| `ZhA()` → `ihA()` → `mI8()` → ? | Convert internal messages to SDK output format |
| `U1q()` → `O6q()` → ? → ? | Wrap progress data into progress message format |
| `iO()` → `rO()` → `lO()` → `j$()` | Normalize messages to individual content blocks |
| `_f()` → `_f()` → `Gf()` → `Zf()` | UUID generator for message wrapping |
| `cR()` → `cR()` → `jy()` → `Wy()` | Sub-agent query function (async generator) |
| `s0A()` → `s0A()` → `XW8()` → `kWA()` | Task state updater (in async loops) |
| `s01()` → `s01()` → `QM1()` → `tM1()` | Stats updater (in async loops) |

**Note:** Names change between versions — always use content patterns, not
names. Use `bundle-analyzer find` with string literals as anchors.

## Broader Analysis

### Sub-agent transcript is independent

The sub-agent writes its own transcript to a `.jsonl` file at:
```
~/.claude/projects/<project-hash>/<session-id>/subagents/agent-<agent-id>.jsonl
```

This transcript is written by the sub-agent's own recording logic (via
`insertMessageChain`) and is **not affected by our patches**. It already
contains full messages including thinking blocks. Our patches affect what
flows through the SDK stream to the consumer, not what the sub-agent records.

### Main session transcript behavior

The main session's transcript (via `bI()` → `EJq()` → `insertMessageChain()`)
records progress messages. The `EJq()` filter clears `normalizedMessages`
arrays from progress messages to save space, but preserves everything else.

After Patch A, the progress messages contain more content (text, thinking
blocks), and these flow through to the transcript. The normalizedMessages
clearing is still correct — it prevents duplicate storage of accumulated
messages.

### Stream event volume considerations

Forwarding sub-agent stream events (Patches F+B+C) significantly increases the
volume of SDK output. Each thinking token and text token generates a separate
`content_block_delta` event. For a sub-agent with extensive thinking, this
can be thousands of additional messages.

SDK consumers should handle the volume. Our app already handles stream events
efficiently (appending deltas to streaming text in the Zustand store).

### Background agents (async path) use a different code path

The async Task path (background agents) runs detached from the parent's
tool executor. By the time the background agent's `for await` loop
executes, the tool executor has returned the `async_launched` result and
the progress callback `j()` is dead (its output queue is closed).

Patches A–C (progress callback based) therefore do **not** work for
background agents. Instead, **Patch E** writes messages directly to
stdout using `process.stdout.write(JSON + "\n")`, bypassing the progress
callback / `O6q()` / ZhA pipeline entirely. Like Patch B, Patch E
intercepts stream_events before the collection array push to prevent
downstream crashes.

Patch D handles the `.output` file writer (used by background agents for
the `Read` tool to tail output).

Background agent completion notifications are handled by the separate
`task-notification` patch.

### SDK transport protocol

The CLI-to-SDK communication uses **newline-delimited JSON** on stdout.
Each message is a single JSON object followed by `\n`. The SDK reads
lines via a `readline` interface (`WV({input: processStdout})`), trims
whitespace, and parses with `JSON.parse` + Zod validation (`q4()`).

The CLI also has a **binary transport** function (`fY1` in v2.1.39) that
writes a 4-byte UInt32LE length header followed by the message body.
This is used for a different communication channel (possibly interactive
TUI mode or tmux pane IPC) — NOT for SDK stdout communication.

**Critical:** Never use `fY1()` (or its equivalent) for writing messages
intended for the SDK consumer. The binary header bytes corrupt the
newline-delimited JSON stream.

### Zod schema validation

The SDK validates messages against Zod schemas before passing them to
consumers. The relevant schema for stream events:

```js
// v2.1.39
gZY = u.object({
    type: u.literal("stream_event"),
    event: SZY,                        // permissive event schema
    parent_tool_use_id: u.string().nullable(),
    uuid: oD,
    session_id: u.string()
})
```

Our Patch C yields messages matching this schema:
- `type: "stream_event"` ✓
- `event: A.data.event` ✓ (raw API event, matches SZY)
- `parent_tool_use_id: A.parentToolUseID` ✓ (string, from U1q wrapping)
- `uuid: A.uuid` ✓ (from U1q wrapping via `_f()`)
- `session_id: U6()` ✓

### `et()` filter for empty messages

The `ZhA()` function calls `et(q)` to filter empty messages before yielding
assistant messages. `et()` checks:

```js
function et(A) {
    if (A.type === "progress" || A.type === "attachment" || A.type === "system")
        return true;
    if (typeof A.message.content === "string")
        return A.message.content.trim().length > 0;
    if (A.message.content.length === 0) return false;
    if (A.message.content.length > 1) return true;
    if (A.message.content[0].type !== "text") return true;  // non-text always passes
    return A.message.content[0].text?.trim().length > 0;
}
```

This means:
- Thinking-only messages pass (`type !== "text"` → returns true)
- Text messages with empty text are filtered out
- Messages with tool_use blocks pass

After Patch A, more messages flow through `ZhA()`, but `et()` correctly
handles all content types. No change needed to `et()`.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script — run after install or SDK update |

## Related Patches

- `patch/task-notification/` — Fixes task completion notifications not
  reaching headless/SDK mode. That patch makes `Z_6()` drain HST into
  queuedCommands. This patch addresses a different problem: the sub-agent's
  individual messages (thinking, text, stream events) never being forwarded
  through the progress callback.

## Discovery Method

1. Traced the Task tool's `call()` function in `cli.js` by searching for
   `agent_progress` string literal (3 occurrences — one in forked slash
   commands, two in the Task tool sync path)
2. Found the progress callback `j` only fires for `tool_use` and
   `tool_result` content blocks (Filter #1)
3. Found stream events are dropped before reaching the content-block loop
   by the `type !== "assistant" && type !== "user"` check (Filter #2)
4. Traced `ZhA()`/`ihA()` to confirm it correctly handles `agent_progress`
   type messages — the converter works, it just never receives thinking/text
5. Verified `UEA()` strips thinking from the final result (Filter #3) —
   intentionally NOT patched
6. Found `.output` file writer and `FM6()`/`sM6()` strip to text-only
   (Filter #4)
7. Confirmed `U1q()` wraps progress callback arguments with uuid, timestamp,
   and parentToolUseID — this is the bridge that makes our progress callback
   calls flow through the existing architecture
8. Checked `readMessages()` in `sdk.mjs` — discovered it reads
   newline-delimited JSON (via `readline`), NOT binary-framed protocol.
   The binary transport function `fY1()` is for a different purpose.
9. Confirmed thinking tokens exist in the sub-agent's transcript `.jsonl`
   file but not in the SDK stream (before patching)
10. Verified the Zod schema for `stream_event` messages accepts our
    yielded structure
11. Tested on both v2.1.38 and v2.1.39 — function names changed but
    architecture identical
12. Traced tool executor chain: `sdY()` → `tdY()` → `tool.call()`.
    The 4th parameter `D` (message) is the full un-normalized assistant
    message — `D.message.content` contains ALL blocks (text, thinking,
    tool_use), not just the relevant tool_use block
13. Discovered `O6q()` (v2.1.39 rename of `U1q()`) wraps progress
    callback data with `parentToolUseID` from the executor context.
    Background agents bypass this entirely since `j()` is dead.
14. After deploying Patches A–E, observed that sub-agent text blocks
    arrived as complete `assistant` messages but zero `stream_event`
    messages appeared in debug logs. Traced the chain:
    `fR()` → yields `stream_event` → `cR()` → `RVY()` filter → dropped.
    `RVY()` only whitelists `assistant`, `user`, `progress`, and
    `compact_boundary` system messages. Found at char ~7907312 using
    `bundle-analyzer find`. This is Filter #0 — the **primary root cause**
    that made Patches B+C ineffective on the sync path.
15. First Patch F attempt simply yielded stream_events from cR, but
    the Task tool's for-await loop still pushed them to `O1` via the
    comma expression `if(O1.push(Y1),...)`. When `UEA(O1)` later
    iterated O1 and accessed `.message.content` on stream_events,
    it crashed: "Cannot read properties of undefined (reading 'type')".
    Fix: modified Patch B to intercept stream_events **before** O1.push,
    and Patch E to do the same for background agent loops.
