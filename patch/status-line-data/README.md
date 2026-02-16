# Patch: status-line-data

## Affected Component

- **File**: `cli.js` in `@anthropic-ai/claude-agent-sdk`
- **SDK version**: 0.2.2 (CLI version 2.1.42)
- The SDK bundles its own CLI, independent of the native `claude` binary

## The Problem

The CLI's terminal UI shows a live status line below the input box with session metrics (cost, token usage, lines changed, duration). This data is assembled by `wGz()` and displayed via a configurable `statusLine` hook command. However, **none of this data is exposed through the SDK message stream** — the `sdk.mjs` consumer never sees it.

The result message (`type: "result"`) contains cost and token data, but the SDK consumer has no single coherent "status line" message with all the metrics the terminal displays.

## Architecture Overview

```
                                  CLI Terminal Path
                                  ─────────────────
  n6 state store ──► wGz() ──► oSA() ──► shell command ──► terminal status bar
  (getters: ED,       │           │
   VT, KT1, YT1,     │         JSON.stringify
   x61, b61, F21)    │           via F1()
                      │
                      ▼
               {cost, context_window, model, workspace, ...}

                                  SDK Message Path
                                  ─────────────────
  sdkQuery yields ──► D1 ──► W.enqueue(D1) ──► SDK consumer
                                                  │
                                              ╳ No status line data!
```

After patching:

```
  sdkQuery yields ──► D1 ──► W.enqueue(D1) ──► if D1.type==="result":
                                                  W.enqueue(_slm)   ──► SDK consumer gets both!
                                                  jD().appendEntry(_slm) ──► persisted to JSONL
```

## Root Cause

The status line data is assembled by `wGz()` (char ~11099154 in v2.1.42), which lives in the terminal UI module (Ink/React). It calls the same global getters from the `n6` state store that are used throughout the SDK. But `wGz()` is only invoked by the terminal UI's status bar component (`DVq`), and the SDK's message stream never emits this data in a structured form.

The `result` message has *some* of the data (cost, duration, token usage), but not all of it (missing: lines added/removed), and the data isn't structured as a status line update.

## The Patch

### Location

**Anchor**: `W.enqueue(D1)}LIA(),kIA()` at char ~10862209

This is the end of the `for await` loop in `T0z` that processes all SDK messages. Every message passes through `W.enqueue(D1)` before being delivered to the consumer.

### Before

```js
// In the for-await loop processing SDK messages:
W.enqueue(D1)}LIA(),kIA()
```

### After

```js
W.enqueue(D1);/*PATCHED:status-line-data*/if(D1.type==="result"){
  var _slu=..., _slw=..., _slp=...,
      _slm={type:"system",subtype:"status_line",session_id:g6(),uuid:rN(),
            cost:{...}, context_window:{...}};
  W.enqueue(_slm);         // deliver to SDK consumer stream
  jD().appendEntry(_slm);  // persist to JSONL via SDK's own writer
}LIA(),kIA()
```

### What it does

After each `result` message is enqueued, conditionally emits a supplementary `system` message with `subtype: "status_line"` containing cost, duration, line changes, and token counts — the same data the terminal status bar displays.

The message is both delivered to the SDK consumer stream (`W.enqueue`) **and** persisted to the session JSONL (`jD().appendEntry`). This ensures historical sessions can read status_line data back from disk without needing a separate writer that could race with the SDK's own JSONL writes.

### Why we emit on `result`

- All cost/token counters have been updated by then (accumulated during the turn)
- Fires after each turn (frequent enough for status display)
- The global getters (`ED()`, `VT()`, `KT1()`, `YT1()`, `x61()`, `b61()`, `F21()`) are accessible from `T0z` scope

### Why it's safe

- `system` messages with unknown subtypes are ignored by existing consumers
- The message is enqueued into `W` (the same `ReadableStream` controller), so it follows the same delivery path
- No Zod schema validation is applied to outbound system messages in the stream
- The global getters are read-only — calling them has no side effects
- The extra message is tiny and only emitted once per turn

### How to find this code in a new version

1. Search for the anchor pattern: `.enqueue(VAR)}FUNC(),FUNC()` followed by `};do{` (the do-while loop for queued commands)
   ```
   bundle-analyzer find cli.js ".enqueue(" --regex "[\w$]+\.enqueue\([\w$]+\)\}[\w$]+\(\),[\w$]+\(\)"
   ```
   Then filter to the match followed by `};do{`.

2. Verify getters still exist by their function bodies:
   ```
   bundle-analyzer find cli.js "return n6.totalCostUSD"
   bundle-analyzer find cli.js "return n6.totalAPIDuration"
   bundle-analyzer find cli.js "return n6.totalLinesAdded"
   bundle-analyzer find cli.js "return n6.totalLinesRemoved"
   bundle-analyzer find cli.js "return n6.sessionId"
   bundle-analyzer find cli.js "Date.now()-n6.startTime"
   ```

3. Token aggregators use `B21(Object.values(n6.modelUsage), "inputTokens")`:
   ```
   bundle-analyzer find cli.js "n6.modelUsage" --regex 'Object\.values\(n6\.modelUsage\),"inputTokens"'
   bundle-analyzer find cli.js "n6.modelUsage" --regex 'Object\.values\(n6\.modelUsage\),"outputTokens"'
   bundle-analyzer find cli.js "n6.modelUsage" --regex 'Object\.values\(n6\.modelUsage\),"cacheReadInputTokens"'
   bundle-analyzer find cli.js "n6.modelUsage" --regex 'Object\.values\(n6\.modelUsage\),"cacheCreationInputTokens"'
   ```
   **Important**: `total_input_tokens` must sum all three input aggregators (base + cache_read + cache_creation) to match user expectations. The base `inputTokens` alone is typically tiny (e.g. 3) because most tokens are cached.

4. Find the persistence singleton getter (for `jD().appendEntry()`):
   ```
   bundle-analyzer find cli.js "ensureCurrentSessionFile"
   bundle-analyzer find cli.js "appendEntry"
   bundle-analyzer find cli.js "enqueueWrite"
   ```
   The getter function has a unique shape: `function XX(){if(!YY){if(YY=new ZZ,!WW)vq(async()=>{await YY?.flush()}),WW=!0}return YY}`. The apply.mjs finds it by matching this pattern with backreferences.

5. Verify `appendEntry` still falls through for `type:"system"` — check the if-else chain in `appendEntry` to ensure `system` is NOT in the explicit type list (it should hit the `else` branch with UUID dedup).

## What's NOT Changed

- **`wGz()` itself**: We don't modify or redirect the terminal status bar builder. It continues to work for the CLI's own display.
- **Result message structure**: We don't add fields to the existing `result` message — we emit a separate message. This keeps the result message compatible with any downstream consumers.
- **Model/workspace/context-window-size fields**: The consumer (main process) already tracks these. We only emit cost, duration, lines, and token totals.

## What the Consumer Receives

After patching, when a turn completes, the SDK consumer receives in order:

1. `{type: "result", subtype: "success", ...}` — **existing**, unchanged
2. `{type: "system", subtype: "status_line", session_id, uuid, cost: {...}, context_window: {...}}` — **NEW**

### Status line message structure

```js
{
  type: "system",
  subtype: "status_line",
  session_id: "uuid-string",
  uuid: "uuid-string",
  cost: {
    total_cost_usd: 0.42,       // from ED() → n6.totalCostUSD
    total_duration_ms: 204000,   // from F21() → Date.now() - n6.startTime
    total_api_duration_ms: 8500, // from VT() → n6.totalAPIDuration
    total_lines_added: 45,       // from x61() → n6.totalLinesAdded
    total_lines_removed: 12      // from b61() → n6.totalLinesRemoved
  },
  context_window: {
    total_input_tokens: 299000,  // KT1() + QR6() + gR6() (base + cache_read + cache_creation)
    total_output_tokens: 8100,   // from YT1() → B21(modelUsage, "outputTokens")
    context_window_size: 200000, // from xG(model, betas)
    used_percentage: 85,         // from ZiA(usage, windowSize).used
    remaining_percentage: 15     // from ZiA(usage, windowSize).remaining
  }
}
```

### Why `total_input_tokens` includes cache tokens

The SDK's `n6.modelUsage` tracks tokens in separate buckets per API call:
- `inputTokens` += `usage.input_tokens` (base, non-cached — typically very small, e.g. 3)
- `cacheReadInputTokens` += `usage.cache_read_input_tokens` (cached context — bulk of tokens)
- `cacheCreationInputTokens` += `usage.cache_creation_input_tokens` (newly cached)

`BR6(cost, usage, model)` accumulates these on each API response via `C76` → `BR6`. The CLI's terminal component (`JJq`) displays `Y.inputTokens` per-model, which is **only** the non-cached base — a misleadingly small number.

The CLI's `statusLine` hook command receives the full JSON from `wGz()` including `current_usage` (raw usage from last assistant message), so custom scripts typically sum all three fields to show meaningful "In" numbers.

Our `total_input_tokens` sums all three aggregators: `KT1() + QR6() + gR6()` — giving the true cumulative input tokens including cache. This matches what users expect to see.

## Key Functions Reference Table

All names are from CLI v2.1.42. **Names WILL change in future versions.**

| Name | Purpose | Char offset | Stable anchor |
|------|---------|-------------|---------------|
| `T0z` | Main SDK session runner (outer) | ~10856547 | `function T0z(A,q,K,Y,z,w,H,$,O,_,J,X){` |
| `wGz` | Builds status line data object | ~11099154 | `function wGz(` near `statusLine` refs |
| `oSA` | Executes status line hook command | ~8790811 | `async function oSA(` near `StatusLine` string |
| `ED` | Returns `n6.totalCostUSD` | ~33444 | `return n6.totalCostUSD` |
| `VT` | Returns `n6.totalAPIDuration` | ~33481 | `return n6.totalAPIDuration` |
| `F21` | Returns `Date.now() - n6.startTime` | ~33522 | `Date.now()-n6.startTime` |
| `x61` | Returns `n6.totalLinesAdded` | ~33820 | `return n6.totalLinesAdded` |
| `b61` | Returns `n6.totalLinesRemoved` | ~33861 | `return n6.totalLinesRemoved` |
| `KT1` | Aggregates base input tokens from modelUsage | ~33904 | `modelUsage),"inputTokens"` |
| `QR6` | Aggregates cache read tokens from modelUsage | ~34045 | `modelUsage),"cacheReadInputTokens"` |
| `gR6` | Aggregates cache creation tokens from modelUsage | ~34116 | `modelUsage),"cacheCreationInputTokens"` |
| `YT1` | Aggregates output tokens from modelUsage | ~33974 | `modelUsage),"outputTokens"` |
| `g6` | Returns `n6.sessionId` | ~32023 | `return n6.sessionId` |
| `rN` | `crypto.randomUUID` (in T0z scope) | ~10852498 | `import{randomUUID as` before `T0z` |
| `jD` | Session persistence singleton getter | ~10499022 | `if(!VAR){if(VAR=new CLASS` + `.flush()` pattern |
| `n6` | Global state store singleton | — | Created by `EiA()` |

## Broader Analysis

### Zod schema validation
System messages in the outbound stream are not validated against a Zod schema. The SDK passes them through as-is. Custom subtypes are safe.

### JSONL Persistence Architecture

**Why we can't just `fs.appendFile` from the Electron main process:**

The SDK writes to the session JSONL from within `cli.js` using its own persistence singleton. If we also write to the same file from our Electron process via `fs.appendFile`, we have two concurrent writers — a corruption risk (interleaved partial lines, etc.). We must use the SDK's own writer.

**How the SDK writes to JSONL — the full chain:**

```
┌─ submitMessage (hWq class, char ~10835244) ─────────────────────────────┐
│                                                                         │
│  for await (K6 of iR(...)) {                                           │
│    switch (K6.type) {                                                  │
│      case "assistant": this.mutableMessages.push(K6); yield K6; break; │
│      case "user":      this.mutableMessages.push(K6); yield K6; break; │
│      case "system":    this.mutableMessages.push(K6); ...;     break;  │
│      case "attachment": ... yield {type:"result",...}; return;          │
│    }                                                                   │
│  }                                                                     │
│                                                                         │
│  // At compaction or eager-flush points:                               │
│  if (y) await eI(P1);  // y = recording flag, P1 = messages snapshot   │
│                                                                         │
│  // Final result yield (6 sites for success/error variants):           │
│  if (y) await eI(P1);  // persist before yielding result               │
│  yield {type:"result", subtype:"success", ...};                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
          │
          │  yields D1
          ▼
┌─ T0z outer loop (async()=> at char ~10860681) ─────────────────────────┐
│                                                                         │
│  for await (D1 of IWq({mutableMessages: V, ...})) {                    │
│    N.push(D1);     // N = local transcript (NOT mutableMessages)        │
│    W.enqueue(D1);  // W = consumer stream controller                    │
│                                                                         │
│    // ← OUR PATCH GOES HERE                                            │
│  }                                                                      │
│  LIA(), kIA();     // profiling only, NOT persistence                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key variables at the patch injection point:**

- `N` = `d2q(V)` — a **local derived copy** of messages for the consumer stream. NOT the persistence-tracked array. Pushing to `N` does NOT trigger JSONL writes.
- `V` = `this.mutableMessages` (from the outer `T0z` scope). This IS the persistence-tracked array, but `eI(P1)` is only called inside `submitMessage`, not from the outer loop.
- `W` = `ReadableStream` controller — delivers messages to the SDK consumer (our Electron main process).
- `D1` = the current message yielded by `submitMessage`.

**The persistence singleton (`jD()`):**

```
jD()  →  returns singleton of class Ijq
  .appendEntry(msg)  →  routes by msg.type
    if known type (summary, custom-title, tag, ...): enqueueWrite(file, msg)
    else: deduplicate by uuid, then enqueueWrite(file, msg)
  .enqueueWrite(file, msg)  →  queued write
    → appendFileSync(file, JSON.stringify(msg) + '\n', {mode: 384})
```

For our `type: "system"` message, `appendEntry` takes the `else` path: it checks UUID dedup (our UUID is fresh, so it passes), then calls `enqueueWrite` which uses the same serialized write queue as all other JSONL entries. **Single writer, no corruption.**

**Why we can't inject inside `submitMessage` instead:**

The `result` message is yielded from 6 different sites in `submitMessage` (success, error_max_turns, error_max_budget, error_max_retries, error_during_execution, and a JSON-schema success path). Patching all 6 is fragile. The outer `T0z` loop is the single funnel point where all results pass through, making it the ideal injection site. Since `jD()` is a module-level function accessible from the outer loop scope, we can call it directly.

**How to find the persistence singleton in a new SDK version:**

```bash
# The singleton getter has a unique pattern: creates instance + registers flush on exit
bundle-analyzer find cli.js "flush" --regex 'function [\w$]+\(\)\{if\(![\w$]+\)\{if\([\w$]+=new [\w$]+,![\w$]+\)vq'

# The appendEntry method routes by type with a long if-else chain
bundle-analyzer find cli.js "appendEntry"

# The enqueueWrite method uses appendFileSync with mode 384
bundle-analyzer find cli.js "enqueueWrite"
```

### Interactive vs headless mode
The getters (`ED`, `VT`, `KT1`, etc.) are always populated regardless of display mode. They read from `n6`, which is the SDK's internal state store. No terminal/Ink dependency.

### Performance
One extra `W.enqueue()` call + one `jD().appendEntry()` call per turn. The message object is small (~200 bytes). The appendEntry goes through the same queued write pipeline, adding one line to the JSONL. Negligible impact.

### Error result paths
We check `D1.type === "result"` which covers both success and error results. The getters return 0/empty for fresh sessions, which is fine.

## Verification

After `node patch/apply-all.mjs`:
```
>>> Applying .../status-line-data/apply.mjs

Read .../cli.js (11.4 MB)
CLI version: 2.1.42
Found anchor at char 10862209
  Enqueue: W.enqueue(D1)
  Post-fns: LIA(), kIA()
Locating getters:
  totalCostUSD → ED()
  totalAPIDuration → VT()
  totalLinesAdded → x61()
  totalLinesRemoved → b61()
  sessionId → g6()
  totalDuration → F21()
  inputTokens (aggregated) → KT1()
  outputTokens (aggregated) → YT1()
  uuid → rN()

Patch applied to .../cli.js
Verified: patch is in place.
```

To trigger: start a session, send any prompt. After the assistant response completes, a `system` message with `subtype: "status_line"` will appear in the SDK stream immediately after the `result` message.

## Discovery Method

### Status line data (stream delivery)

1. **Find status line rendering**: `bundle-analyzer find cli.js "statusLine"` — found `wGz()` (the data builder) and `DVq` (the React component)
2. **Extract `wGz`**: Read at char ~11099154 — discovered it calls `ED()`, `VT()`, `F21()`, `KT1()`, `YT1()`, `x61()`, `b61()` from the `n6` state store
3. **Verify getters are global**: All defined at ~33xxx (module scope), accessible from anywhere including `T0z`
4. **Find injection point**: `bundle-analyzer find cli.js "enqueue"` filtered by the `};do{` pattern to find the main message loop in `T0z`
5. **Verify `D1` content**: Traced the `for await (let D1 of ...)` loop to confirm `D1` carries the yielded SDK messages including `type: "result"`
6. **Verify uuid availability**: Confirmed `rN` (randomUUID) is imported before `T0z` definition and accessible in scope

### JSONL persistence (how the SDK writes to disk)

7. **Find JSONL writer**: `bundle-analyzer find cli.js "appendFileSync"` — found `Yl(file, obj)` which does `appendFileSync(file, JSON.stringify(obj) + '\n')`, plus a buffered writer `Cjz` and the persistence class methods
8. **Find persistence singleton**: `bundle-analyzer find cli.js "ensureCurrentSessionFile"` — found the `Ijq` class with `appendEntry`, `enqueueWrite`, `trackWrite`, `insertMessageChain` methods
9. **Trace message flow in `submitMessage`**: The `hWq` class's `submitMessage` (char ~10835244) processes messages from `iR()` generator. Each message type is switch/cased:
   - `assistant`, `user`, `system` → pushed to `this.mutableMessages`
   - `attachment` (contains result yields) → yield result, return
   - At compaction + eager-flush points: `eI(P1)` is called to persist
10. **Understand `eI` function**: `eI(messages)` at char ~10504240 calls `Bjq(messages)` to transform, deduplicates by UUID via `hQA()`, then calls `jD().insertMessageChain(newMessages)` for the batch write
11. **Verify outer loop doesn't persist**: `T0z`'s `for await` loop pushes to `N` (a local derived array via `d2q(V)`) and `W` (consumer stream). `N.push(D1)` does NOT trigger persistence. The `LIA()`, `kIA()` calls after the loop are profiling only.
12. **Verify `jD()` is accessible**: `jD` is a module-level function defined in the same bundle scope. Although it lives in a different lazy-init block (`T8` at ~10495972) than the `T0z` block (`TUA`/`pWq`), all `v()` lazy initializers share the module scope. `eI()` (which calls `jD()`) is already used inside `submitMessage` — same code region.
13. **Verify `appendEntry` handles our message type**: For `type: "system"` (not in the explicit type list), `appendEntry` falls through to the `else` branch which does UUID dedup + `enqueueWrite`. Our message has a fresh `uuid` from `rN()`, so it passes dedup and gets written.
