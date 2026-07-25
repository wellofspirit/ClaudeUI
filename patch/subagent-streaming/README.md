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

| Component              | Version at time of discovery                                    |
| ---------------------- | --------------------------------------------------------------- |
| SDK package            | 0.2.38 → 0.2.39 → 0.2.41 → 0.2.42 → 0.2.49                    |
| Bundled CLI (`cli.js`) | 2.1.38 → 2.1.39 → 2.1.41 → 2.1.42 → 2.1.49                    |
| Last re-anchored       | 2.1.197                                                         |

All versions exhibit the same behavior. Function names change between
versions but the architecture is stable through v2.1.196. **v2.1.197 introduced a significant refactor** (BVe unification — see below) that required new patches F2 and changes to B and E; the logical problem and fix strategy are identical.

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

**v2.1.196 and earlier:**
```
Task.call(input, context, canUseTool, message, progressCallback)
  │
  ├─ Creates dR()/cR()/Wy() generator (sub-agent execution loop)
  ├─ for-await loop collects messages in O1[]
  │     (Filter #1: only tool_use/tool_result call progressCallback j)
  │     (Filter #2: stream_events dropped by type guard before push)
  │
  └─ Returns UEA()/Mg8() result with text-only content
```

**v2.1.197+ (BVe unification):**
```
Task.call(input, context, canUseTool, message, progressCallback)
  │
  ├─ Creates nt=(MSG)=>{...} onMessage callback in Task.call() scope
  │     nt receives every message from the sub-agent generator
  │
  ├─ Calls BVe({..., onMessage:nt, shouldNotifyOwner:p, toolUseContext:s})
  │     BVe runs the for-await loop internally
  │     BVe calls u?.(ce) (=nt) as first statement for EVERY message
  │     BVe collects messages in h[] for its own processing
  │
  └─ nt callback:
        if(DONE_FLAG)return;
        if(MSG.type==="spinner_mode")return;
        if(MSG.type!=="api_metrics"&&MSG.type!=="set_in_progress_tool_use_ids")Ye.push(MSG);  ← Patch B target
        if(!CALLBACK)return;
        ...bash_progress forward...
        if(MSG.type!=="assistant"&&MSG.type!=="user")return;  ← stream_event dropped here
        ...agent_progress forward...
```

The sub-agent generator yields full messages with all content block types.
In the v2.1.197 architecture, `BVe()` is the unified runner for both sync
and background sub-agents (formerly separate paths). `iu8()` — the standalone
background runner — was merged into `BVe()`.

### BVe function signature (v2.1.197)

```js
async function BVe({
  onMessage: u,           // nt callback from Task.call() — called for EVERY message
  shouldNotifyOwner: d,   // p = () => Fe (returns true when backgrounded)
  toolUseContext: s,      // s.toolUseId = parent_tool_use_id (v2.1.197-v2.1.198: s)
                           // i.toolUseId (v2.1.207+: i — minified name changes)
  // ... other fields
}) {
  for await (let ce of <generator>) {
    u?.(ce)               // ← call nt for every message (Patch E injects here)
    if(W(), ce.type==="system"&&ce.subtype==="api_error")continue;
    h.push(ce)            // ← collection array (Patch E's BVe anchor)
    // ...
  }
}
```

Key variables:
| Variable | Source | Value |
| -------- | ------ | ----- |
| `u` | `BVe` destructured param | `nt` onMessage callback from Task.call() |
| `d` | `BVe` destructured param | `shouldNotifyOwner = () => Fe` |
| `s` (v197-v198) / `i` (v207+) | `BVe` destructured param | toolUseContext; `s.toolUseId` (or `i.toolUseId`) = parent tool use ID |
| `p` (v197–v207) / `m` (v219+) | defaulted alias `let X=d??(()=>!0)` — the Patch E gate | `() => Fe`, or `()=>!0` when no shouldNotifyOwner passed |
| `h` | local to BVe | message collection array |
| `ce` | loop variable | current message from sub-agent generator |
| `W` | watchdog callback | called once per iteration |
| `Fe` | Task.call() local | true when task is backgrounded |
| `nt` | Task.call() local | `(MSG)=>{...}` onMessage callback |
| `Ye` | Task.call() local | collection array fed to Tko/FVe |

**v2.1.219 gate rename (CRITICAL — silent semantic break):** v2.1.219 appended
`onRunSettled:p,onTerminalSuccess:f` to the BVe/`_Ie` signature and renamed the defaulted
shouldNotifyOwner alias from `p` to `m` (`let m=d??(()=>!0)`). A patch that hardcodes `p()` as
the gate still *applies* cleanly but calls `onRunSettled()` instead: the gate is always falsy
(background stream_events silently dropped) and the run-settled callback fires spuriously per
message. The patch now extracts the alias structurally from
`shouldNotifyOwner:(V1)[^)]*){let (V2)=V1??(()=>!0)` and uses `V2()` as the gate. Never
hardcode this name.

**v2.1.219 Task routing + native relay:** two things changed in the runner refactor:

1. The Task tool now *non-deterministically* routes even foreground (no `run_in_background`)
   sub-agents through the spawned/async path (`_Ie` call without `onMessage`; the Task result
   says `async_launched`). On that route the `nt`/Gr callback (Patches A/B) never sees the
   sub-agent's messages, so Patch E's BVe-loop forwarding is the ONLY stream_event source —
   this is why the gate bug above manifested as ~50% flaky FG streaming.
2. A native relay now forwards spawned/background sub-agent **assistant/user** messages to the
   SDK stream with `parent_tool_use_id` (verified live: with Patch E inert, backgrounded runs
   still delivered tagged assistants; with Patch E also writing them, the same `message.id`
   arrived twice). **stream_events are still not natively forwarded.** Patch E therefore skips
   its assistant/user stdout writes when the signature contains `onRunSettled:` (relay-capable
   builds) and keeps them for v2.1.197–v2.1.207 shapes.

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
function O6q({ toolUseID: A, parentToolUseID: q, data: K }) {
  return {
    type: 'progress',
    data: K,
    toolUseID: A,
    parentToolUseID: q,
    uuid: _f(),
    timestamp: new Date().toISOString()
  }
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
  return (
    A.type === 'assistant' ||
    A.type === 'user' ||
    A.type === 'progress' ||
    (A.type === 'system' && 'subtype' in A && A.subtype === 'compact_boundary')
  )
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

function FM6(A, q = 'Execution completed') {
  let K = GN(A) // get last assistant message
  if (!K) return q
  // ↓↓↓ FILTER: only text blocks ↓↓↓
  return (
    K.message.content
      .filter((z) => z.type === 'text')
      .map((z) => ('text' in z ? z.text : ''))
      .join('\n') || q
  )
}
```

And in the background agent polling loop:

```js
// v2.1.38: char ~8589577
// v2.1.39: char ~8592091

let j = J.map((M) => {
  if (M.type === 'assistant')
    // ↓↓↓ FILTER: only text blocks ↓↓↓
    return M.message.content
      .filter((P) => P.type === 'text')
      .map((P) => ('text' in P ? P.text : ''))
      .join('\n')
  return Q1(M) // JSON.stringify for non-assistant messages
}).join('\n')
if (j) ZK1(A, j + '\n') // append to .output file
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

## Message Flow Diagram — After Patching (Async Path, Patches F+F2+E)

### v2.1.196 and earlier (legacy re-background loops)

```
Background sub-agent cR()/Wy() generator (inside q01 async context)
  │  (Patch F applies here too — cR yields stream_events without collecting)
  │
  ├── stream_event
  │     │
  │     └── (Patch E legacy) intercepted BEFORE N1.push — NOT collected
  │           → process.stdout.write(JSON + "\n")
  │           → {type:"stream_event", event:..., parent_tool_use_id:_ptu}
  │           → SDK readline → q4() parse → consumer ✓
  │
  ├── assistant/user msg
  │     │
  │     ├── N1.push(msg)              ← collected (has .message, safe for _kA)
  │     └── (Patch E legacy) process.stdout.write(JSON + "\n") → consumer ✓
  │
  └── (loop ends) → _kA(N1) → text-only result
```

### v2.1.197+ (BVe unified path)

```
Sub-agent generator → BVe() for-await loop
  │
  │  BVe calls u?.(ce) (=nt) first for EVERY message
  │  nt = Task.call()'s onMessage callback
  │
  ├── stream_event
  │     │
  │     ├── (Patch F2) yield MSG past IVe/fHo pre-filter in sub-agent generator
  │     │     (without F2, IVe catches stream_event first, fHo() consumes it, continues — dead)
  │     │
  │     ├── BVe calls u?.(ce) → nt receives MSG
  │     │     (Patch B) nt: intercept BEFORE Ye.push → forward via CALLBACK → continue/return
  │     │
  │     └── (Patch E BVe) BVe for-await: injected BEFORE h.push:
  │           if(ce.type==="stream_event"){if(GATE())try{process.stdout.write(...)}catch{}; continue}
  │           → {type:"stream_event", event:..., parent_tool_use_id:s.toolUseId}
  │           → SDK readline → q4() parse → consumer ✓  (backgrounded/spawned: GATE()=true)
  │
  ├── assistant/user msg
  │     │
  │     ├── BVe calls u?.(ce) → nt receives MSG
  │     │     (Patch B) nt: forwarded via CALLBACK (agent_progress path)
  │     │
  │     ├── (Patch E BVe, pre-v2.1.219 only) if(GATE()) process.stdout.write(...) → consumer ✓
  │     │     (v2.1.219+: native relay forwards these — Patch E skips to avoid duplicates)
  │     │
  │     └── h.push(ce) ← collected (has .message, safe for downstream processing)
  │
  └── (loop ends) → text-only result
```

Note: In v2.1.197+:
- `p` = `shouldNotifyOwner` = `() => Fe`. Returns `true` when `Fe=true` (backgrounded); `false` when sync.
- `s.toolUseId` = parent_tool_use_id (no description-search needed — available directly from `toolUseContext`).
- Patch G is no longer needed: `iu8()` was merged into `BVe()`, which Patch E's BVe injection already covers.

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

3. Sanity check: the call site must be inside an async generator (the injected
   `yield` binds to the nearest enclosing generator). The patch verifies an
   `async function*` declaration appears in a lookback window before the call
   site. v2.1.219 grew the generator body — the decl now sits ~10.9k chars
   before the RVY gate (was <10k), so the window is 20000 chars.

### Patch A — Content-block filter removal

**Removes Filter #1.** The inner loop over content blocks and the
`tool_use`/`tool_result` type check are replaced with a simpler loop that
fires the progress callback once per normalized message.

Before:

```js
for (let $1 of _1)
  for (let G1 of $1.message.content) {
    if (G1.type !== 'tool_use' && G1.type !== 'tool_result') continue
    if (j)
      j({
        toolUseID: `agent_${D.message.id}`,
        data: {
          message: $1,
          normalizedMessages: T1,
          type: 'agent_progress',
          prompt: A,
          resume: z,
          agentId: r
        }
      })
  }
```

After:

```js
for (let $1 of _1) {
  if (j)
    j({
      toolUseID: `agent_${D.message.id}`,
      data: {
        message: $1,
        normalizedMessages: T1,
        type: 'agent_progress',
        prompt: A,
        resume: z,
        agentId: r
      }
    })
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

### Patch F2 — Yield stream_event past IVe/fHo streaming pre-filter (v2.1.197+)

**New in v2.1.197.** Fixes a pre-filter ABOVE Patch F's RVY gate that caused Patch F to become dead code for stream_events.

**Marker**: `/*PATCHED:subagent-F2*/`

**Background:** In v2.1.197, the sub-agent query generator gained a pre-filter loop body:

```js
for await (let MSG of b4({...})) {
  if(CB?.(), IVe(MSG)) {
    FHO(MSG, CFG, N), yield*BUF, BUF.length=0; continue
  }
  // ... rest of loop including Patch F's RVY gate
}
```

`IVe(MSG)` = `Bam.has(MSG.type)` where `Bam` is a set that **includes `"stream_event"`**. So stream_events hit the `IVe` branch first: `FHO()` (the streaming display handler) consumes them for side effects (`onStreamingText`, etc.) and the branch `continue`s — stream_events never reach Patch F's `yield`. Patch F became dead code for stream_events on v2.1.197+.

**Fix:** Inside the `IVe` branch, after the `FHO()` side-effect call and before the BUF flush, yield the message when it is a `stream_event`. This lets it flow through to `nt`/BVe as designed.

**Anchor** (unique, 1 match):
```
if(CB?.(),IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}
```

More precisely as a regex (minified names vary):
```
if(<CB>?.(),<IVe>(<MSG>)){<FHO>(<MSG>,<CFG1>,<CFG2>),yield*<BUF>,<BUF>.length=0;continue}
```

**Before:**
```js
if(CB?.(), IVe(MSG)){FHO(MSG, CFG, N), yield*BUF, BUF.length=0; continue}
```

**After:**
```js
if(CB?.(), IVe(MSG)){/*PATCHED:subagent-F2*/FHO(MSG, CFG, N),
  MSG.type==="stream_event"&&(yield MSG),
  yield*BUF, BUF.length=0; continue}
```

The `(yield MSG)` expression is valid inside a generator body. It is wrapped in `&&` short-circuit so it only runs when `MSG.type==="stream_event"`.

**Safety check:** `apply.mjs` verifies that Patch F's marker is within 6000 chars downstream of the F2 injection site (confirms we're inside the correct sub-agent generator, not a different for-await loop).

**Applicability:** F2 auto-skips on pre-2.1.197 CLIs where the `IVe/fHo` pre-filter does not exist. Patch F alone was sufficient there.

**How to find this code:**
```bash
bundle-analyzer find cli.js "IVe(MSG)){FHO" --compact
# Or search for the buffer flush pattern unique to this generator:
bundle-analyzer find cli.js "yield*BUF,BUF.length=0;continue" --compact
```

The `IVe` function is `Bam.has(MSG.type)` — find it by:
```bash
bundle-analyzer find cli.js '"stream_event"' --compact
# Look for a Set that includes "stream_event" among other streaming message types
```

---

### Patch B — Stream event forwarding (before O1.push / Ye.push)

**Removes Filter #2.** Intercepts `stream_event` messages **before** the
collection array push and forwards them through the progress callback as a
new `agent_stream_event` data type. Stream events never enter the collection
array.

**Marker**: `/*PATCHED:subagent-B*/`

#### v2.1.196 and earlier (for-await with push)

Before:
```js
if (O1.push(Y1),
    Y1.type !== "assistant" && Y1.type !== "user")
    continue;
```

After:
```js
/*PATCHED:subagent-B*/
if (Y1.type === "stream_event") {
    if (j) j({
        toolUseID: `agent_${D.message.id}`,
        data: {type: "agent_stream_event", event: Y1.event, agentId: r}
    });
    continue  // ← continue: valid in for-loop body
}
if (O1.push(Y1),
    Y1.type !== "assistant" && Y1.type !== "user")
    continue;
```

#### v2.1.197+ (nt-callback architecture)

In v2.1.197, the old for-await loop is gone. Instead `Task.call()` creates an `nt=(MSG)=>{...}` arrow-function callback and passes it as `onMessage:nt` to `BVe()`. The callback receives every message. The Patch B target is now the `Ye.push()` statement inside `nt`:

```
nt callback structure (v2.1.197):
  if(DONE_FLAG)return;
  if(MSG.type==="spinner_mode")return;
  if(MSG.type!=="api_metrics"&&MSG.type!=="set_in_progress_tool_use_ids")Ye.push(MSG);  ← TARGET
  if(!CALLBACK)return;
  ...bash_progress forward...
  if(MSG.type!=="assistant"&&MSG.type!=="user")return;  ← stream_event dropped here
  ...agent_progress forward...
```

The `ntCallbackRe` pattern matches the push line:
```js
const ntCallbackRe = new RegExp(
  `if\\((%V%)\\.type!=="api_metrics"&&\\1\\.type!=="set_in_progress_tool_use_ids"\\)(%V%)\\.push\\(\\1\\)`
)
```

After (v2.1.197 nt-callback shape):
```js
/*PATCHED:subagent-B*/
if (MSG.type === "stream_event") {
    if (CALLBACK) CALLBACK({type:"progress",toolUseID:`agent_${parentVar.message.id}`,
        data:{type:"agent_stream_event",event:MSG.event,agentId:agentVar}});
    return  // ← return: arrow function, not a loop body — NOT continue
}
if(MSG.type!=="api_metrics"&&MSG.type!=="set_in_progress_tool_use_ids")Ye.push(MSG);
```

**Critical:** the old path used `continue` (valid in a for-loop). The v2.1.197 path uses `return` (arrow function body, no loop). `apply.mjs` detects which shape was matched (`isNtCallback` flag) and selects the correct exit keyword.

**Why stream_events must NOT enter Ye:**

`Ye[]` (formerly `O1[]`) is passed to `Tko`/`FVe` (formerly `UEA`) which calls `NAe()` on the last non-system/progress message. `NAe` accesses `.message.content` — stream_events have `{type, event}` structure with no `.message`. Downstream crash: "Cannot read properties of undefined (reading 'type')".

**How to find this code in a new version:**

For v2.1.197+ nt-callback:
```bash
bundle-analyzer find cli.js '"api_metrics"&&' --compact
# The nt callback is the only location that checks both api_metrics AND
# set_in_progress_tool_use_ids before a .push() call
```

For older for-await loop shape:
```bash
bundle-analyzer find cli.js '.push\(.*bash_progress' --regex --compact
# Or:
bundle-analyzer find cli.js '.type!=="assistant"&&.*type!=="user")continue' --regex --compact
```

### Patch C — ZhA/ihA handler for agent_stream_event

**Adds a new handler in the message converter.** The `ZhA()` (v2.1.38) /
`ihA()` (v2.1.39) generator function converts internal messages to SDK
output format. We add handling for the new `agent_stream_event` data type
so it yields proper `{type: "stream_event", parent_tool_use_id}` SDK
messages.

Injected before the `bash_progress`/`powershell_progress` handler:

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

**The full ZhA/ihA/if8 function structure (for reference):**

```js
// v2.1.38: function*ZhA(A), char ~9069375
// v2.1.39: function*ihA(A), char ~9085100
// v2.1.49: function*if8(A), char ~5971430
function* if8(A) {
    switch (A.type) {
        case "assistant":
            // Direct assistant messages (from parent model)
            for (let q of W_([A])) {
                if (!Zt(q)) continue;
                yield {type:"assistant", message:q.message,
                       parent_tool_use_id:null, session_id:U1(), ...};
            }
            return;

        case "progress":
            if (A.data.type === "agent_progress")
                // Sub-agent messages (our Patch A sends more through here)
                for (let q of W_([A.data.message]))
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

            else if (A.data.type === "bash_progress" || A.data.type === "powershell_progress")
                // Bash/PowerShell tool progress (elapsed time)
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
  `agent_stream_event` type — existing `agent_progress` and
  `bash_progress`/`powershell_progress` paths are untouched

**How to find this code in a new version:**
Search for a generator function that contains both `agent_progress` and
`bash_progress` string literals, with `parent_tool_use_id` in yields:

```
function\*.*agent_progress.*bash_progress
```

Or search for the `bash_progress` anchor specifically:

```
else if(A.data.type==="bash_progress"||A.data.type==="powershell_progress"){
```

(Older versions may only have `bash_progress` without `powershell_progress`.)

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

### Patch E — Background agent streaming (BVe injection in v2.1.197+, legacy re-background loops in v2.1.196-)

**Bypasses the dead progress callback for async (background) agents.**
When the Task tool runs with `run_in_background: true` or is backgrounded
mid-execution, the progress callback `j()` is dead (output queue closed).
Patch E writes sub-agent messages directly to stdout as newline-delimited JSON.

**Marker**: `/*PATCHED:subagent-E*/`

#### v2.1.197+ — BVe for-await injection

In v2.1.197, `iu8()` and both re-background loops were unified into `BVe()`.
BVe takes `shouldNotifyOwner:d`, defaulted into a local alias — `let p=d??(()=>!0)` in
v2.1.197–v2.1.207, `let m=d??(()=>!0)` in v2.1.219+ (new `onRunSettled:p,onTerminalSuccess:f`
params claimed the old letters). The gate returns `Fe` (the done/backgrounded flag) on the
sync Task path, or `true` when no shouldNotifyOwner was passed (spawned/background path).
**The alias name MUST be extracted structurally** from
`shouldNotifyOwner:(V1)[^)]*){let (V2)=V1??(()=>!0)` — hardcoding it caused a silent semantic
break on v2.1.219 (`p()` called `onRunSettled` instead: gate always falsy → background
stream_events dropped, run-settled callback fired per message).

**Anchor** (unique in BVe's for-await body):
```
if(WATCHDOG(), MSG.type==="system"&&MSG.subtype==="api_error")continue;ARR.push(MSG)
```

Injection is inserted **before** the watchdog call (`GATE` = the extracted alias):
```js
/*PATCHED:subagent-E*/
if(ce.type==="stream_event"){
  if(GATE())try{process.stdout.write(JSON.stringify({
    type:"stream_event", event:ce.event,
    parent_tool_use_id:CTX.toolUseId, session_id:<sessFn>(), uuid:globalThis.crypto.randomUUID()
  })+"\n")}catch(_e){}
  continue  // ← skip h.push for stream_events regardless of sync/async state
}
// Only on builds WITHOUT the native relay (no `onRunSettled:` in the signature — v2.1.197–v2.1.207):
if(ce.type==="assistant"||ce.type==="user")
  if(GATE())try{process.stdout.write(JSON.stringify({
    type:ce.type, message:ce.message,
    parent_tool_use_id:CTX.toolUseId, session_id:<sessFn>(), uuid:globalThis.crypto.randomUUID()
  })+"\n")}catch(_e){}
// Original: if(W(),ce.type==="system"&&ce.subtype==="api_error")continue; h.push(ce) follows
```

- **stream_events**: always `continue` (skip `h.push`) to prevent `NAe` crash; write stdout only when `GATE()=true`.
- **assistant/user**: only injected when the signature LACKS `onRunSettled:` (pre-v2.1.219). On
  v2.1.219+ a native relay already forwards spawned/background sub-agent assistant/user messages
  with `parent_tool_use_id`; writing them here too duplicates the same `message.id` (verified live).
- **When sync** (`Fe=false`, gate false): no stdout writes — `nt`/progress-callback handles it. Stream events still skip `h[]` via `continue`.

`s.toolUseId` (v2.1.197-v2.1.198) / `i.toolUseId` (v2.1.207+) provides `parent_tool_use_id` directly from `toolUseContext` — no description-search lookup needed (unlike legacy Patch E).

**How `apply.mjs` extracts the variable name (v2.1.207+):** It does NOT scan for `<ident>.toolUseId` in a prefix window (fragile — can match closures from unrelated scopes). Instead, it locates `toolUseContext:` in the BVe function's destructured parameter list within ~15KB before the anchor:

```
async function BVe({...toolUseContext:VAR,...})
```

The captured `VAR` (shown as `CTX` above; `i` in v2.1.207) is then used for `.toolUseId` in the injection. The patch requires exactly one matching signature in the bounded prefix and fails closed if the binding is absent or ambiguous.

**Verify anchor uniqueness:**
```bash
bundle-analyzer find cli.js 'ce.type==="system"&&ce.subtype==="api_error")continue' --compact
# Should match exactly once (inside BVe's for-await loop body)
```

Then verify `toolUseContext:` appears in the function signature ~3.5KB before the anchor, capturing the minified variable name after the colon.

#### v2.1.196 and earlier — Legacy re-background for-await loops

```js
// Old shape (one of two loops, braced or unbraced):
for await (let D1 of cR({...}))
    N1.push(D1), s01(...), s0A(agentId, ...);

// After patching (stream_event: forward + skip push; assistant/user: original + forward):
for await (let D1 of cR({...})) {
  /*PATCHED:subagent-E*/
  if (D1.type === "stream_event") {
    // _ptu lookup by description match (no toolUseContext available in old path)
    let _ptu=null; for(let _b of D.message.content){
      if(_b.type==="tool_use"&&_b.input&&_b.input.description===K){_ptu=_b.id;break}
    }
    process.stdout.write(JSON.stringify({type:"stream_event",event:D1.event,
      parent_tool_use_id:_ptu,session_id:<sessFn>(),uuid:globalThis.crypto.randomUUID()})+"\n")
  } else {
    N1.push(D1), s01(...), s0A(agentId, ...);
    // ... assistant/user stdout writes ...
  }
}
```

Two patterns tried (newest-first): `bracedAsyncBodyRe` (v2.1.76+, uses braces), `unbracedAsyncBodyRe` (v2.1.41+, single-statement). Both require `for await` in the 1000-char prefix context to avoid false matches.

**Key design decisions and pitfalls:**

#### stdout transport: newline-delimited JSON, NOT binary framing

The CLI has a binary transport function (`fY1` in v2.1.39) that writes
a 4-byte UInt32LE length header followed by the message body:

```js
function fY1(A) {
  let q = Buffer.from(A, 'utf-8'),
    K = Buffer.alloc(4)
  ;(K.writeUInt32LE(q.length, 0), process.stdout.write(K), process.stdout.write(q))
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
let _ptu = null
for (let _b of D.message.content) {
  if (_b.type === 'tool_use' && _b.input && _b.input.description === K) {
    _ptu = _b.id
    break
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

### Patch G — iu8() background agent stdout streaming (≤v2.1.196 only)

**Covers agents launched with `run_in_background: true` from the start.**
**In v2.1.197+, `iu8()` was merged into `BVe()`. Patch G auto-skips gracefully on v2.1.197+; Patch E's BVe injection covers this path.**

**Marker**: `/*PATCHED:subagent-G*/`

**Applicability flag**: `patchGApplicable` in `apply.mjs`. Set to `false` when `iu8()` signature is not found. Final marker verification only requires Patch G when `patchGApplicable=true`.

#### v2.1.196 and earlier: standalone iu8() function

Patch E targets the _re-background_ path (foreground agent backgrounded mid-execution). Agents launched directly as background (`run_in_background: true`) took a completely different path: `Task.call()` returned `{ isAsync: true, status: "async_launched" }` immediately and delegated to `iu8()`.

`iu8()` was a standalone async function whose `for await` loop collected messages but never forwarded anything to stdout.

**Anchor** (the `iu8` function signature — no longer present in v2.1.197+):
```
async function iu8({taskId:VAR,abortController:VAR,makeStream:VAR,metadata:VAR,description:VAR,toolUseContext:VAR,taskRegistry:VAR,agentIdForCleanup:VAR,enableSummarization:VAR,getWorktreeResult:VAR})
```

Find it with:
```bash
bundle-analyzer find cli.js "taskId:.*abortController:.*makeStream:.*metadata:.*description:.*toolUseContext:.*taskRegistry:.*agentIdForCleanup" --regex --compact
# Returns nothing in v2.1.197+ (merged into BVe)
```

**Before** (≤v2.1.196, loop body just collects):
```js
for await (let G of _(P)) {
    J.push(G), O.update(q, ...), G36(X, G, M, A.options.tools), q78(q, ...);
    let f = cu8(G); if (f) lu8(X, q, A.toolUseId, Y, z.startTime, f)
}
```

**After** (stream_event forwarded + continue, assistant/user forwarded then fall through):
```js
for await (let G of _(P)) {
    /*PATCHED:subagent-G*/
    if (G.type === "stream_event") {
        try { process.stdout.write(JSON.stringify({
            type: "stream_event", event: G.event,
            parent_tool_use_id: A.toolUseId,
            session_id: E8(), uuid: globalThis.crypto.randomUUID()
        }) + "\n") } catch(_ge) {}
        continue
    }
    if (G.type === "assistant" || G.type === "user")
        try { process.stdout.write(JSON.stringify({
            type: G.type, message: G.message,
            parent_tool_use_id: A.toolUseId,
            session_id: E8(), uuid: globalThis.crypto.randomUUID()
        }) + "\n") } catch(_ge) {}
    // Original body follows
    J.push(G), O.update(q, ...), G36(X, G, M, A.options.tools), ...
}
```

**Key differences from legacy Patch E (≤v2.1.196):**

| Aspect                      | Patch E (legacy)                                   | Patch G                                                    |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Code path                   | Re-background loop (after `backgroundSignal`)       | `iu8()` (agents launched directly as background)           |
| `parent_tool_use_id` source | Looked up from parent message by description match  | Direct: `toolUseContext.toolUseId` (parameter available)   |
| Loop pattern                | `for await` with `isAsync:!0` in context            | `for await(let G of _(P))` in standalone function          |

In v2.1.197+: Patch E's BVe injection handles all paths (sync, re-background, and directly-backgrounded agents). `patchGApplicable=false` so the final marker check is skipped.

## What's NOT Changed

**UEA/Tko/FVe (task result)** — The final result returned to the parent model from
a sub-agent still contains text-only content. Thinking tokens are not
included in the task result, as they would waste the parent model's context
window. The parent doesn't need the sub-agent's internal reasoning — it
just needs the final answer.

**BVe collection array `h[]`** — Patch E's BVe injection makes stream_events `continue` past `h.push(ce)`. Non-stream-event messages (assistant, user) still fall through to `h[]` normally. `h[]` is used by BVe's downstream processing and must only contain messages with `.message` structure.

**Patch F (cR RVY gate)** — Still present and required for pre-v2.1.197 CLIs. In v2.1.197+, the Patch F2 fix is what makes stream_events survive the IVe pre-filter; F's RVY injection is then no longer reachable for stream_events but is harmless (its marker is still verified).

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

| Location                           | Has thinking? | Accessible?                            |
| ---------------------------------- | ------------- | -------------------------------------- |
| Sub-agent `dR()` yield (sync)      | Yes           | Yes — forwarded via Patch A            |
| Sub-agent stream_events (sync)     | Yes           | Yes — Patch F unblocks cR, B+C forward |
| Sub-agent messages (async/bg)      | Yes           | Yes — forwarded via Patch E            |
| SDK stdout stream                  | Yes           | Yes — `parent_tool_use_id` set         |
| `.output` file (background)        | Yes           | Yes — included via Patch D             |
| Sub-agent transcript (`.jsonl`)    | Yes           | Yes — always had it                    |
| Main session transcript (`.jsonl`) | Yes           | Yes — via progress messages            |
| Task tool_result (UEA)             | No            | N/A — intentionally excluded           |

## Applying the Patch

```bash
node patch/subagent-streaming/apply.mjs
```

The script locates functions by **content pattern** rather than minified
names, since function names change between versions. It will (v2.1.197 order):

1. Find `cli.js` in the vendor directory
2. **Patch F** — RVY gate bypass (cR stream_event yield before type filter)
3. **Patch F2** — IVe/fHo pre-filter bypass (v2.1.197+; auto-skip if not found)
4. **Patch A** — Content-block filter removal in nt-callback / for-await
5. **Patch B** — stream_event intercept before Ye.push (nt-callback shape in v2.1.197+)
6. **Patch C** — agent_stream_event handler in ZhA/ihA/ATt
7. **Patch D** — .output file thinking inclusion
8. **Patch E** — Background agent stdout (BVe anchor in v2.1.197+; legacy loops in v2.1.196-)
9. **Patch G** — iu8() background agent (≤v2.1.196; auto-skips in v2.1.197+)
10. Verify all applicable markers present

### Re-applying after CLI version bumps

After running `bun run ensure-cli` or `bun run update-cli`, re-apply patches:

```bash
node patch/apply-all.mjs
```

The script is idempotent — detects if patches are already applied and skips them.

### When the patch breaks

If a future CLI version changes the code structure enough that pattern
matching fails, the script exits with an error. In that case:

1. Check if the bug is fixed upstream — test if sub-agent thinking/text/stream events appear in the SDK stream without patching.
2. If not fixed, use `/bundle-analyzer` to find equivalent functions using the search patterns in each patch section above.
3. Update regex patterns in `apply.mjs`. Follow the conventions: `const V = '[\\w$]+'` for minified identifiers, content-pattern anchors not name-based.
4. Update this README with the new shapes and version progression.

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

| Name (v2.1.38 → v2.1.49 → v2.1.197)              | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `RVY()` → `T7z()` → (still present, RVY-gate)    | cR/jy/Wy yield filter (gates what the generator yields to callers) |
| `dR()` → (merged) → BVe()                         | Sub-agent execution generator / unified runner (v2.1.197+)         |
| `UEA()` → `Mg8()` → `Tko()`/`FVe()`              | Extract text-only result from agent messages                       |
| `FM6()` → `r_1()` → (varies)                      | Extract text from last assistant message                           |
| `ZhA()` → `if8()` → `ATt()`                       | Convert internal messages to SDK output format                     |
| `U1q()` → `O6q()` → (varies)                      | Wrap progress data into progress message format                    |
| `iO()` → `W_()` → (varies)                        | Normalize messages to individual content blocks                    |
| `_f()` → `nk()` → `globalThis.crypto.randomUUID` | UUID generator for message wrapping (web crypto in v2.1.197+)      |
| `iu8()` → `iu8()` → (merged into BVe)             | Standalone background agent runner (removed in v2.1.197)           |
| `IVe()` / `Bam`                                   | Pre-filter in sub-agent generator (v2.1.197+): `Bam.has(MSG.type)` |
| `FHO()` / `fHo()`                                 | Streaming display handler called inside IVe branch (v2.1.197+)     |
| `BVe()`                                           | Unified sub-agent runner (sync + background) (v2.1.197+)           |

**v2.1.197 patch inventory (A–G + F2):**

| Patch | Marker | What it does | v2.1.197 notes |
| ----- | ------ | ------------ | -------------- |
| F     | `subagent-F` | RVY gate bypass — yield stream_event before it's filtered in cR | Still present; now unreachable for stream_events (F2 catches them upstream), but harmless |
| F2    | `subagent-F2` | Yield stream_event past IVe/fHo pre-filter in sub-agent generator | NEW in v2.1.197; auto-skips on older CLIs |
| A     | `subagent-A` | Remove content-block type filter from progress callback | No structural change in v2.1.197 |
| B     | `subagent-B` | Intercept stream_event before Ye.push in nt-callback / O1.push in for-await | v2.1.197: targets nt-callback (`ntCallbackRe`); uses `return` not `continue` |
| C     | `subagent-C` | Add agent_stream_event handler in ZhA/ihA/ATt | No structural change in v2.1.197 |
| D     | `subagent-D` | Include thinking blocks in .output file | No structural change in v2.1.197 |
| E     | `subagent-E` | Background agent stdout (BVe for-await in v2.1.197+; legacy loops in v2.1.196-) | v2.1.197: targets BVe anchor; uses `s.toolUseId` |
| G     | `subagent-G` | iu8() standalone background stdout (≤v2.1.196) | Auto-skips in v2.1.197+ (iu8 merged into BVe) |

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
background agents. Instead, **Patches E and G** write messages directly to
stdout using `process.stdout.write(JSON + "\n")`, bypassing the progress
callback / `O6q()` / ZhA pipeline entirely. Like Patch B, these patches
intercept stream_events before the collection array push to prevent
downstream crashes.

- **Patch E** covers agents that start foreground and are _re-backgrounded_
  mid-execution (via the `backgroundSignal` race in the sync path).
- **Patch G** covers agents launched directly with `run_in_background: true`
  (the `iu8()` function, a separate async execution path).

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
  type: u.literal('stream_event'),
  event: SZY, // permissive event schema
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
  if (A.type === 'progress' || A.type === 'attachment' || A.type === 'system') return true
  if (typeof A.message.content === 'string') return A.message.content.trim().length > 0
  if (A.message.content.length === 0) return false
  if (A.message.content.length > 1) return true
  if (A.message.content[0].type !== 'text') return true // non-text always passes
  return A.message.content[0].text?.trim().length > 0
}
```

This means:

- Thinking-only messages pass (`type !== "text"` → returns true)
- Text messages with empty text are filtered out
- Messages with tool_use blocks pass

After Patch A, more messages flow through `ZhA()`, but `et()` correctly
handles all content types. No change needed to `et()`.

## Files

| File        | Purpose                                        |
| ----------- | ---------------------------------------------- |
| `README.md` | This document                                  |
| `apply.mjs` | Patch script — run after install or SDK update |

## Related Patches

- `patch/task-notification/` — Fixes task completion notifications not
  reaching headless/SDK mode. That patch makes `Z_6()` drain HST into
  queuedCommands. This patch addresses a different problem: the sub-agent's
  individual messages (thinking, text, stream events) never being forwarded
  through the progress callback.

## Discovery Method (v2.1.197 re-anchor)

1. **Applied patch, tests failed** — behavioral tests reported zero `stream_event` messages from sub-agents despite patches appearing to apply. All existing markers (A–G) were present.
2. **Found the pre-filter** — searched for `IVe` and `Bam` near the sub-agent generator. Found a new branch `if(CB?.(),IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}` above Patch F's RVY gate. `IVe=Bam.has` and `Bam` includes `"stream_event"` — so stream_events were consumed by `FHO()` and `continue`d before reaching Patch F. Patch F was dead code for stream_events.
3. **Added Patch F2** — injects `MSG.type==="stream_event"&&(yield MSG)` inside the `IVe` branch, after FHO() side-effects, before the BUF flush. Stream_events now flow through to `nt`/BVe.
4. **Found BVe unification** — the old for-await loop in Task.call() with `O1.push()` was gone. Task.call() now creates `nt=(MSG)=>{...}` and calls `BVe({...,onMessage:nt,...})`. BVe runs the for-await loop internally and calls `u?.(ce)` (=nt) for every message.
5. **Updated Patch B for nt-callback** — the old push+bash_progress patterns no longer exist. New anchor: `if(MSG.type!=="api_metrics"&&MSG.type!=="set_in_progress_tool_use_ids")Ye.push(MSG)` (unique to nt). Injection uses `return` not `continue` (arrow function body). `isNtCallback` flag selects the correct exit keyword.
6. **Updated Patch E for BVe** — the old `bracedAsyncBodyRe`/`unbracedAsyncBodyRe` patterns didn't match. Found BVe's for-await body via unique anchor: `if(W(),ce.type==="system"&&ce.subtype==="api_error")continue;h.push(ce)`. Verified `s.toolUseId` in nearby context (BVe has toolUseContext directly — no description-search needed). Injection before the watchdog call; `p()` guards stdout writes.
7. **Patch G auto-skips** — `iu8()` signature (`async function iu8({taskId:...}`) not found; `patchGApplicable=false`; final marker check skips G. Log: `iu8() not found — merged into BVe() in v2.1.197+`.
8. **Applied cleanly**, all behavioral tests pass.

## Discovery Method (original, v2.1.38–v2.1.49)

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
