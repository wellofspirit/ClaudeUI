# Patch: team-streaming

Fixes two bugs with in-process teammates (spawned via TeamCreate + Task
with `team_name`):

1. **JSONL fragmentation** — Each turn generates a random agentId, creating
   a separate `agent-<hex>.jsonl` per turn instead of one file per teammate.
2. **No event streaming** — Teammate thinking, text, tool calls, and stream
   deltas never reach the SDK consumer's stdout.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.45 |
| Bundled CLI (`cli.js`) | 2.1.45 |

## The Problems

### Problem 1: JSONL Fragmentation

When the SDK runs an in-process teammate via `KfY`, each AI turn calls
`OR()` (the query runner) to get an async iterator of messages. Inside
`OR()`:

```js
let N = O?.agentId ? O.agentId : Qy()
```

`Qy()` generates a random hex string. `KfY` passes
`override:{abortController:T}` — no `agentId`. So every turn gets a new
random ID, producing `agent-a20745a.jsonl`, `agent-b38cf91.jsonl`, etc.

A 2-agent 3-round debate produces 14 JSONL files instead of 2. This makes
session history reload nearly impossible and forced a 600-line workaround
(`subagent-watcher.ts`) with fuzzy name-keyword matching.

### Problem 2: No Event Streaming

Inside `KfY`'s `for await` loop, messages are collected into arrays and
state is updated via `im()`, but nothing writes to stdout. The progress
callback (`j`) is not called here — it's only wired for the sync Task
tool path. So teammate stream_events, assistant messages, and user
(tool_result) messages are invisible to the SDK consumer.

## Architecture Overview

### KfY — In-process teammate runner

```js
async function KfY(A) {
    let { identity: q, taskId: K, prompt: Y, ... } = A
    //                 ^^^^^^^^
    //  q.agentId = "ts-advocate@lang-debate" (stable name@team identity)

    // ... setup ...

    for await (let _6 of OR({
        // ... query params ...
        override: { abortController: T },  // ← NO agentId!
        // ...
    })) {
        x.push(_6), N.push(_6), R06(p, _6, Q, H.options.tools)
        //  ^^^^^^^^^^^^^^^^^^ collection arrays (stream_event would break these)

        im(K, (k6) => ({
            // ... update appState with token counts, tool results ...
            lastReportedTokenCount: VP8(p)
        }), M)
        //  ^^^ im() updates AppState — runs for assistant/user messages
    }
}
```

### OR — Query runner (creates JSONL file)

```js
async function* OR({ ..., override: O, ... }) {
    let N = O?.agentId ? O.agentId : Qy()  // ← falls through to random hex
    // N flows to: lh(cZ(N)) → "agent-${N}.jsonl" → fs.appendFile
}
```

### Message types in the for-await loop

| Type | Has `.message`? | Has `.uuid`? | Safe for R06/im()? |
|---|---|---|---|
| `stream_event` | No | No | **No** — breaks if pushed to arrays |
| `assistant` | Yes | Yes | Yes |
| `user` | Yes | Yes | Yes |
| `progress` | No | Yes | Handled separately |

## Patch A: Fix agentId Fragmentation

**Marker**: `/*PATCHED:team-streaming-A*/`

### Anchor (unique, 1 match)

```
override:{abortController:T}
```

### Before

```js
override:{abortController:T}
```

### After

```js
/*PATCHED:team-streaming-A*/override:{abortController:T,agentId:q.agentId.replace(/@/g,"--")}
```

The `replace(/@/g,"--")` sanitizes `@` for filenames (Windows-unsafe).
The agentId flows through `lh(cZ(id))` → `agent-${id}.jsonl`, producing
`agent-ts-advocate--lang-debate.jsonl` instead of `agent-a20745a.jsonl`.

### Why this is safe

- `q.agentId` is the stable `"name@team"` identity, already in scope as
  the `identity` parameter of `KfY`.
- `appendEntry` uses `fs.appendFile` — appends, never truncates. Multiple
  turns append to the same file.
- UUID dedup is per-session, no collision risk across turns.
- The `@` → `--` transform is reversible and produces valid filenames on
  all platforms.

## Patch B: Forward Teammate Events to Stdout

**Marker**: `/*PATCHED:team-streaming-B*/`

Two injection points inside the `for await` loop body.

### Dynamic function extraction

`SES` (session ID) and `UUID` (unique ID generator) are extracted from
the bundle at apply time:

```js
const sessFnRe = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
const uuidFnRe = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+)\(\),timestamp:new Date/
```

Currently `p1()` and `Gf()` respectively.

### B1: Stream event bypass (before collection arrays)

**Anchor** (unique, 1 match):

```
x.push(_6),N.push(_6),R06(p,_6,Q,H.options.tools)
```

**Injection** (prepended before anchor):

```js
/*PATCHED:team-streaming-B*/if(_6.type==="stream_event"){
  process.stdout.write(JSON.stringify({
    type:"stream_event",event:_6.event,
    teammate_id:q.agentId,
    session_id:SES(),uuid:UUID()
  })+"\n");continue}
```

`stream_event` messages lack `.message`/`.uuid` and would break `R06()`
/ `im()`. The `continue` skips collection entirely (same pattern as
Patch F in subagent-streaming).

### B2: Assistant/user forwarding (after im() update)

**Anchor** (unique, 1 match):

```
lastReportedTokenCount:VP8(p)}},M)
```

**Injection** (appended after anchor):

```js
if(_6.type==="assistant"||_6.type==="user")
  process.stdout.write(JSON.stringify({
    type:_6.type,message:_6.message,
    teammate_id:q.agentId,
    session_id:SES(),uuid:UUID()
  })+"\n");
```

This runs AFTER the existing `im()` update, so AppState is already
updated before we forward.

### Message format

```json
{"type":"stream_event","event":{...},"teammate_id":"ts-advocate@lang-debate","session_id":"...","uuid":"..."}
{"type":"assistant","message":{...},"teammate_id":"ts-advocate@lang-debate","session_id":"...","uuid":"..."}
{"type":"user","message":{...},"teammate_id":"ts-advocate@lang-debate","session_id":"...","uuid":"..."}
```

Uses `teammate_id` (the unsanitized `name@team` identity) instead of
`parent_tool_use_id`. The consumer maps this to the detected teammate's
`toolUseId` for UI routing.

## How to Find This Code

### KfY function (in-process teammate runner)

```bash
# Find by unique parameter pattern
bundle-analyzer find cli.js "teammateContext" --compact

# Or by the override anchor
bundle-analyzer find cli.js "override:{abortController:T}" --compact
```

### The for-await loop body

```bash
# Collection push + R06 call
bundle-analyzer find cli.js "x.push(_6),N.push(_6),R06" --compact

# im() update with VP8
bundle-analyzer find cli.js "lastReportedTokenCount:VP8(p)" --compact
```

### OR function (agentId assignment)

```bash
# The agentId fallback to Qy()
bundle-analyzer find cli.js "agentId?O.agentId:Qy()" --compact
```

### Session ID and UUID functions

```bash
# session_id function (used in multiple patches)
bundle-analyzer find cli.js "session_id:p1()" --compact

# UUID function
bundle-analyzer find cli.js "uuid:Gf()" --compact
```

## What's NOT Changed

**Collection arrays** — `x.push(_6)` and `N.push(_6)` still operate on
assistant/user messages. Only `stream_event` skips them (via `continue`).

**im() state updates** — Still run for assistant/user messages before we
forward them. AppState is always up-to-date.

**R06 (stats tracking)** — Still called for all non-stream_event messages.

**Subagent-streaming patches** — Those handle the Task tool's sync/async
paths (progress callback + ZhA handler). This patch handles the teammate
path (KfY), which uses a different loop and has no progress callback.

**Consumer-side routing** — The SDK consumer (`claude-session.ts`) needs
to map `teammate_id` → `toolUseId` for UI display. That's a follow-up.

## Verification

1. `node patch/team-streaming/apply.mjs` — should apply both patches
2. Run again — should report "already applied"
3. `node patch/apply-all.mjs` — all patches pass
4. Launch a team session, verify:
   - Only 1 JSONL per teammate in `subagents/` (named `agent-<name>--<team>.jsonl`)
   - Stream events arrive via stdout (visible in ClaudeUI debug log)
   - Assistant/user messages arrive with `teammate_id`

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script — run after install or SDK update |

## Related Patches

- `patch/subagent-streaming/` — Forwards sub-agent stream events + messages
  via progress callback and ZhA handler. Handles the Task tool's sync/async
  paths. This patch handles the teammate path (KfY) which bypasses those.

- `patch/team-dowhile-fix/` — Fixes the do-while loop deadlock that prevents
  team inbox polling. Required for teams to function at all. This patch
  addresses what happens once the team is running.
