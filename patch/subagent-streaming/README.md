# Patch: subagent-streaming

Sub-agent (Task tool) messages — including thinking tokens, text, and tool
use/results — never reach the SDK consumer. The parent model sees them
internally but the SDK stream only receives the final summarized result.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file (same file patched
by `task-notification`).

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.38 |
| Bundled CLI (`cli.js`) | 2.1.38 |

## The Problem

When Claude Code spawns a sub-agent via the `Task` tool, the sub-agent runs
a full conversation loop internally (multiple API calls, tool uses, thinking,
text responses). None of these intermediate messages are visible to SDK
consumers. The SDK only receives:

1. The parent's `tool_use` block for the Task tool
2. `tool_progress` elapsed-time ticks
3. The parent's `tool_result` containing a text-only summary

Thinking tokens, streaming text, individual tool calls, and tool results from
the sub-agent are all invisible.

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

## Root Cause: Three Filters

### Filter #1 — Progress callback only sends tool_use/tool_result

Location: Task tool sync path, `cli.js` char ~7988696

```js
// Inside the Task tool's sync for-await loop:
for (let z1 of dR({...})) {
    O1.push(z1);  // collect ALL messages

    if (z1.type === "assistant") {
        let _1 = iO([z1]);   // normalize to individual content blocks
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

### Filter #2 — Task result extracts text-only content

Location: `UEA()` function, `cli.js` char ~7983000

```js
function UEA(A, q, K) {
    let O = GN(A);  // get last assistant message
    // ↓↓↓ FILTER: only text blocks ↓↓↓
    let _ = O.message.content.filter((D) => D.type === "text");
    // ...
    return {
        agentId: q,
        content: _,          // text-only
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

### Filter #3 — Output file writer strips non-text

Location: Remote agent polling loop, `cli.js` char ~8589577

```js
let j = J.map((M) => {
    if (M.type === "assistant")
        // ↓↓↓ FILTER: only text blocks ↓↓↓
        return M.message.content
            .filter((P) => P.type === "text")
            .map((P) => ("text" in P) ? P.text : "")
            .join("\n");
    return Q1(M);  // JSON.stringify for non-assistant messages
}).join("\n");
if (j) ZK1(A, j + "\n");   // append to .output file
```

**Effect:** The `.output` file (used for background agents, tailed via `Read`
tool) only contains text from assistant messages. Thinking tokens, tool use
blocks, and tool result details are all discarded.

## Message Flow Diagram

```
Sub-agent dR() generator
  │
  ├── assistant msg: [thinking, text, tool_use]
  │     │
  │     ├── O1.push(msg)              ← collected internally
  │     │
  │     ├── thinking block            ← DROPPED (Filter #1)
  │     ├── text block                ← DROPPED (Filter #1)
  │     └── tool_use block            ← progress callback j()
  │           │
  │           ▼
  │         ZhA({type:"progress", data:{type:"agent_progress",...}})
  │           │
  │           ▼
  │         yield {type:"assistant", parent_tool_use_id: "...", ...}
  │           │
  │           ▼
  │         P.enqueue → SDK stdout    ← only tool_use messages arrive!
  │
  ├── user msg: [tool_result]
  │     │
  │     └── tool_result block         ← progress callback j()
  │           │
  │           ▼
  │         (same path as above)      ← tool_result messages arrive
  │
  ├── stream_event (thinking_delta, text_delta, etc.)
  │     │
  │     └── DROPPED entirely          ← never sent to progress callback
  │
  └── (loop ends)
        │
        ▼
      UEA(O1, agentId, ...)
        │
        ├── Extracts text-only (Filter #2)
        │
        ▼
      return {status:"completed", content: [text blocks only]}
        │
        ▼
      Parent receives tool_result with text summary only
```

## What the SDK Consumer Currently Receives

For a sub-agent that thinks, writes text, calls Read tool, then writes more:

```
1. {type:"assistant", content:[{type:"tool_use", name:"Task", ...}]}     ← parent calls Task
2. {type:"tool_progress", tool_name:"Task", elapsed_time_seconds:1}       ← ticks
3. {type:"tool_progress", tool_name:"Task", elapsed_time_seconds:2}
4. {type:"assistant", parent_tool_use_id:"X", content:[{type:"tool_use", name:"Read",...}]}  ← sub-agent Read (via progress)
5. {type:"user", parent_tool_use_id:"X", content:[{type:"tool_result",...}]}                  ← sub-agent Read result
6. {type:"tool_progress", tool_name:"Task", elapsed_time_seconds:5}
7. {type:"user", content:[{type:"tool_result", text:"Agent completed..."}]}                   ← final result (text only)
8. {type:"assistant", content:[...]}                                                           ← parent continues
```

**Missing from the stream:**
- Sub-agent thinking tokens (never sent)
- Sub-agent text responses (never sent)
- Sub-agent stream_events / deltas (never sent)
- Sub-agent thinking in final result (stripped by UEA)

## What the Output File Contains

The `.output` file (for background agents) contains even less:

```
(text content from assistant messages only, concatenated with newlines)
```

No JSON structure, no message boundaries, no thinking, no tool calls.

## Where Thinking Tokens DO Exist

| Location | Has thinking? | Accessible? |
|---|---|---|
| Sub-agent `dR()` yield | Yes | No — consumed inside Task.call() |
| `O1[]` array in Task.call() | Yes | No — local variable, discarded after UEA() |
| Sub-agent transcript (`.jsonl`) | Yes | Yes — but requires knowing the path and parsing JSONL |
| Sub-agent stream_events | Yes | No — never forwarded to progress callback |
| SDK stdout stream | No | N/A |
| `.output` file | No | N/A |

The transcript path follows the pattern:
```
~/.claude/projects/<project-hash>/<session-id>/subagents/agent-<agent-id>.jsonl
```

Each line is a JSON object. Assistant messages contain full `content` arrays
with `thinking`, `text`, `tool_use`, etc.

## Proposed Fix

Patch the progress callback invocation in the Task tool's sync path to send
ALL sub-agent messages to the parent, not just tool_use/tool_result. This
would make thinking tokens, text blocks, and stream_events visible in the SDK
stream with `parent_tool_use_id` set.

### Approach: Patch the progress callback filter

The current filter:
```js
if (G1.type !== "tool_use" && G1.type !== "tool_result") continue;
```

Should be removed or relaxed to allow all content block types through. This
means the progress callback `j()` would fire for every assistant message
content block, sending full sub-agent messages (including thinking) to the
parent's `ZhA()` converter and out through the SDK stream.

### Considerations

1. **`ZhA()` already handles `agent_progress`** — it converts them to
   proper SDK messages with `parent_tool_use_id`. No changes needed there.

2. **Stream events** — The sub-agent's `stream_event` messages (deltas) are
   a separate type. The current progress callback is only called for
   `assistant` and `user` type messages. To get streaming deltas, we'd need
   to also forward `stream_event` messages through progress. This requires
   adding a new case in `ZhA()` or a new message type.

3. **Bandwidth** — Forwarding all sub-agent messages significantly increases
   the volume of SDK output. Thinking tokens in particular can be very large.
   SDK consumers should be prepared for this.

4. **Background agents** — The async (background) Task path has a different
   code structure. The background agent collects messages via `Qj1()` and
   writes summaries via `RjA()`. The progress callback is not used. For
   background agents, we'd also need to patch the output file writer
   (Filter #3) or add a separate streaming mechanism.

5. **The `includePartialMessages` flag** — The parent loop passes this flag
   to `TMq()`. It controls whether `stream_event` messages are yielded. The
   sub-agent's stream_events are independent of this flag since they never
   reach the parent loop at all.

6. **Sync vs Async paths** — The sync path (foreground Task) can be patched
   at the progress callback. The async path (background Task) needs a
   different approach since it runs detached and writes to the `.output` file.

## Key Functions Reference

| Minified name | Purpose | Location (char offset) |
|---|---|---|
| `dR()` | Sub-agent execution generator | ~7904721 |
| `UEA()` | Extract text-only result from agent messages | ~7983000 |
| `ZK1()` | Write to `.output` file | ~5257061 |
| `ww()` | Generate `.output` file path | ~5257005 |
| `ZhA()` | Convert internal messages to SDK output format | ~9069375 |
| `NMq` | Main query class (parent loop) | ~10786784 |
| `TMq()` | Main query generator wrapper | ~10796462 |
| `RJz()` | Headless streaming entry point | ~10808000 |
| `Qj1()` | Progress tracking (token/tool counts) | ~5276596 |
| `RjA()` | Update task progress state | ~5278384 |
| `vK1()` | Task completion notification (→ HST) | ~5277508 |
| `iO()` | Normalize messages to individual content blocks | ~10401417 |
| `JT6()` | Transform content blocks (parse tool input) | ~10410482 |
| `Ij1()` | Create symlink for output file | ~5257819 |
| `kh()` | Generate transcript path for subagent | ~10451189 |

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |

## Related Patches

- `patch/task-notification/` — Fixes task completion notifications not
  reaching headless/SDK mode. That patch makes `Z_6()` drain HST into
  queuedCommands. This patch addresses a different problem: the sub-agent's
  individual messages (thinking, text, stream events) never being forwarded
  through the progress callback.

## Discovery Method

1. Traced the Task tool's `call()` function in `cli.js`
2. Found the progress callback `j` only fires for `tool_use` and
   `tool_result` content blocks
3. Traced `ZhA()` to confirm it correctly handles `agent_progress` type
   messages — the converter works, it just never receives thinking/text
4. Verified `UEA()` strips thinking from the final result
5. Confirmed the `.output` file writer also strips to text-only
6. Checked `readSdkMessages()` in `sdk.mjs` — no filtering there, everything
   that reaches stdout flows through to the SDK consumer
7. Confirmed thinking tokens exist in the sub-agent's transcript `.jsonl`
   file but nowhere in the SDK stream
