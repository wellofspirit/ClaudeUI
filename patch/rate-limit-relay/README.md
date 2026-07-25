# Patch: rate-limit-relay

Forwards real-time per-window rate limit utilization data (from inference response headers) to the SDK consumer after every API call — enabling live usage bar updates without polling.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| SDK package            | 0.2.97                       |
| Bundled CLI (`cli.js`) | 2.1.97                       |
| Last re-anchored       | 2.1.197                      |

The SDK bundles its own `cli.js`, independent of the native `claude` binary.

## The Problem

### User-visible symptom

The 5-hour rate limit utilization bar in ClaudeUI's sidebar stays at 0% and only updates when the background `/api/oauth/usage` poll runs (every 30 minutes). It should update in real time after every inference call.

### Root cause

The CLI already parses `anthropic-ratelimit-unified-*` response headers after every inference call and stores per-window utilization in a module-level variable (`kh8`, accessed via getter `LR4()`). However, this data never reaches SDK consumers because:

1. **Dedup gate blocks broadcasts**: The CLI has a `d46` listener Set and a broadcaster function (`BF1`). But `BF1` is only called when the rate limit **status changes** — guarded by a deep-equality check (`NJ(aV, z)`). For normal usage where status stays `"allowed"`, the initial `aV` value `{status:"allowed", unifiedRateLimitFallbackAvailable:false, isUsingOverage:false}` matches the parsed state (once `resetsAt` stabilizes), so `BF1` stops firing after the first request or two.

2. **SDK adapter drops events anyway**: Even when `BF1` does fire, the `sdkMessageAdapter` function explicitly drops `rate_limit_event` messages:

   ```js
   case "rate_limit_event":
     return N("[sdkMessageAdapter] Ignoring rate_limit_event message"),
       {type: "ignored"};
   ```

3. **No direct stdout write**: Nobody writes the per-window utilization to `process.stdout` — the newline-delimited JSON transport that SDK consumers read from.

The header utilization data (`kh8`) IS updated on every request via `hR4(headers)` inside `pF1(headers)`. The problem is purely last-mile delivery — the data exists but is trapped inside the CLI process.

### Previous approach (v1 of this patch, broken in v0.2.97)

The v1 patch piggybacked on the `d46` listener inside `B3A` (the per-session task runner):

```js
let E = (p6) => {
  let k6 = RpK(p6);
  if (k6) v.enqueue({...})/*PATCHED*/,process.stdout.write(...)
};
d46.add(E);
```

This worked when `BF1` fired on every request (older SDK versions where `resetsAt` changed each time, making `NJ` always return false). In v0.2.97+, `SR4` returns a stable state for consecutive `"allowed"` requests, so `NJ(aV, z)` returns true and `BF1` never fires — our listener never executes.

## Architecture Overview

### Rate limit data flow

```
Anthropic API response
  │
  ├── Response headers contain:
  │     anthropic-ratelimit-unified-5h-utilization: 0.35
  │     anthropic-ratelimit-unified-5h-reset: 1711500000
  │     anthropic-ratelimit-unified-7d-utilization: 0.12
  │     anthropic-ratelimit-unified-7d-reset: 1712100000
  │     anthropic-ratelimit-unified-status: allowed
  │
  └── XiK() stream loop completes, calls:
        │
        ├── pF1(U1.headers) — main rate limit handler:
        │     1. I7() → checks OAuth + user:inference scope
        │     2. hR4(headers) → parses 5h/7d utilization → stores in kh8
        │     3. SR4(headers) → parses full status object
        │     4. NJ(aV, z) → deep-equal check (blocks most broadcasts)
        │     5. BF1(z) → only if state changed (rarely fires)
        │           └── d46.forEach(cb => cb(z))  ← rate limit listeners
        │
        ├── k8 = U1.headers  (stores headers locally)
        │
        └── [PATCH] process.stdout.write(JSON + "\n")  ← always runs
              │     Emits: { type: "rate_limit_event", header_utilization: LR4() }
              │     LR4() returns kh8 (freshly set by hR4 inside pF1 above)
              │
              └── sdk.mjs reads line → yields to consumer
                    → ClaudeSession handler → usageFetcher.updateFromHeaderUtilization()
                      → IPC: 'usage:data' → renderer sidebar bar update
```

### Key functions

| Function (v2.1.97) | Function (v2.1.197) | Char offset (v2.1.97) | Purpose                                                                                       |
| ------------------ | ------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `LR4()`            | `r5e()`             | ~6485791              | Getter for `kh8` / `n5e` (cached parsed header utilization)                                   |
| `hR4(q)`           | `zda(q)`            | ~6485817              | Parses `anthropic-ratelimit-unified-*-utilization/reset` headers → `{ five_hour, seven_day }` |
| `pF1(q)`           | `xBn(e,t,n,r)`      | ~6488865              | Main handler: calls `hR4` + `SR4` + conditionally `BF1` (4-param in v2.1.197)                |
| `SR4(q)`           | `Jda(q)`            | ~6487750              | Full unified rate limit status parser → status object                                         |
| `BF1(q)`           | `Q3t(q)`            | ~6486087              | Broadcaster: updates `aV`, calls `d46.forEach(cb => cb(q))`, fires telemetry                  |
| `NJ`               | `YDe`               | (lodash isEqual)      | Deep equality — gates `BF1`                                                                    |
| `XiK(...)`         | —                   | ~11714504             | Async generator stream loop — calls `pF1` after streaming completes                           |

**Name map v2.1.97 → v2.1.197:** `pF1→xBn`, `LR4→r5e`, `kh8→n5e`, `hR4→zda`, `SR4→Jda`, `BF1→Q3t`, `d46→YDe`.

**All minified names will change again in future versions.** Use content patterns, not names.

### Why `d46` piggybacking doesn't work

```
                 pF1(headers) called on EVERY request
                        │
                    hR4(headers)
                    kh8 = { five_hour: {...}, seven_day: {...} }  ← ALWAYS updated
                        │
                    SR4(headers)
                    z = { status: "allowed", resetsAt: 1711500000, ... }
                        │
                    NJ(aV, z) === true?  ───── YES (usual) ──→  return (no broadcast)
                        │                                         kh8 has fresh data
                        NO (first request                         but nobody reads it
                         or status change)
                        │
                    BF1(z) → d46 listeners fire
                    aV = z  (stored for next comparison)
```

The `kh8` store is updated unconditionally by `hR4`, but the `d46` broadcast is gated by `NJ`. Our v2 patch reads `LR4()` (= `kh8`) directly from the stream loop, bypassing the broadcast entirely.

### Variable mapping at injection site

| Variable | Source                | Value                                                           |
| -------- | --------------------- | --------------------------------------------------------------- |
| `U1`     | `let U1 = l`          | Raw `Response` object from `fetch()` in the API client          |
| `l`      | set in `xE8` callback | Response stored for post-streaming header access                |
| `k8`     | local to `XiK`        | Cached headers (used elsewhere in the function)                 |
| `pF1`    | module-level function | Rate limit handler (calls `hR4` → stores in `kh8`)              |
| `LR4`    | module-level function | Getter: `function LR4(){return kh8}`                            |
| `kh8`    | module-level var      | `{ five_hour: { utilization, resets_at }, seven_day: { ... } }` |

### `hR4` — header parser (what `kh8` / `LR4()` contains)

```js
function hR4(q) {
  let K = {}
  for (let [_, z] of [
    ['five_hour', '5h'],
    ['seven_day', '7d']
  ]) {
    let Y = q.get(`anthropic-ratelimit-unified-${z}-utilization`),
      A = q.get(`anthropic-ratelimit-unified-${z}-reset`)
    if (Y !== null && A !== null) K[_] = { utilization: Number(Y), resets_at: Number(A) }
  }
  return K
}
```

Utilization values are **fractional** (0.0–1.0), not percentages. The consumer (`updateFromHeaderUtilization`) multiplies by 100.

## The Patch

Single injection — writes `rate_limit_event` to stdout after every streaming API call.

**Marker**: `/*PATCHED:rate-limit-relay*/`

### Anchor (unique, 1 match)

The `pF1` call site in the stream loop, after streaming completes:

```
<pF1>(<resp>.headers,<args...>),<hdr>=<resp>.headers
```

Content pattern (stable — uses the `pF1` function name extracted dynamically):

```
<pF1>\((%V%)\.headers,<argPat>\),(%V%)=\1\.headers
```

v2.1.219 note: the anchor no longer includes the leading `if(<resp>)` guard. Upstream
prepended another call inside the guard (`if(as)EDu(as.headers,ke,Qe),hpo(as.headers,...)`),
so `if(<resp>)` is not directly followed by the pF1 call anymore. The pF1-call + trailing
`,<hdr>=<resp>.headers` assignment is still unique to the stream loop — the other pF1 call
sites (startup refresh, non-stream interceptor) pass a headers object directly and lack the
trailing assignment.

The `pF1` function name itself is found via its unique definition pattern:

```
function %V%(%V%){let %V%=%V%();if(!%V%(%V%)){if(<kh8>={} ...
```

where `<kh8>` is extracted from the `LR4` getter found by:

```
function %V%(){return %V%}function %V%(%V%){let %V%={};for(let[%V%,%V%]of[["five_hour","5h"],["seven_day","7d"]])
```

### Before

```js
let U1 = l
if (U1) (pF1(U1.headers), (k8 = U1.headers))
```

### After

```js
let U1 = l
if (U1)
  (pF1(U1.headers),
    (k8 = U1.headers) /*PATCHED:rate-limit-relay*/,
    process.stdout.write(
      JSON.stringify({ type: 'rate_limit_event', header_utilization: LR4() }) + '\n'
    ))
```

### Dynamic function extraction

Two minified names are extracted at apply time:

1. **`LR4`** (header utilization getter) — found by matching the getter adjacent to `hR4`:

   ```js
   const lr4Re =
     /function (%V%)(){return (%V%)}function %V%(%V%){let %V%={};for(...["five_hour","5h"]...)/
   // Captures: [1]=LR4 fn name, [2]=kh8 var name
   ```

2. **`pF1`** (rate limit handler) — the function signature changed between versions:

   ```
   v2.1.97 signature:
   function <pF1>(<q>){let <K>=<I7>();if(!<mN6>(<K>)){if(<kh8>={} ...
   (1 param, "let K = I7()" pattern)

   v2.1.197 signature:
   function <pF1>(<e>,<t>,<n>=!1,<r>=Date.now()){let <o>=<Eo>();if(!<ndt>(<o>)){if(<kh8>={} ...
   (4 params, 2 defaulted; uses kh8 var name found from step 1 as a stable discriminator)
   ```

   The `apply.mjs` pattern for v2.1.197 matches the 4-param+defaults signature anchored on the `kh8` reset inside the guard:
   ```js
   const pf1DefRe = new RegExp(
     `function (%V%)(%V%,%V%,%V%=!1,%V%=Date\\.now\\(\\))\\{let %V%=%V%\\(\\);if\\(!%V%\\(%V%\\)\\)\\{if\\(<kh8>=\\{\\}`
   )
   ```

3. **Call site** — also changed in v2.1.197. The `pF1` call site gained additional arguments with nested parens:

   ```
   v2.1.97:  if(<U1>)<pF1>(<U1>.headers),<k8>=<U1>.headers
   v2.1.197: if(<Hn>)<pF1>(<Hn>.headers,<model>,(fg(model)||Sx(model))&&...,<we>),<Je>=<Hn>.headers
   ```

   The call-site regex was updated to allow a variable-length argument list after `.headers,` using a nested-paren-tolerant pattern (up to 2 levels deep):
   ```js
   const argPat = `(?:[^)(]|\\((?:[^)(]|\\([^)(]*\\))*\\))*`
   const callSiteRe = new RegExp(
     `if\\((%V%)\\)<pF1>\\(\\1\\.headers,${argPat}\\),(%V%)=\\1\\.headers`
   )
   ```

   This matches both the old 1-arg call and the new multi-arg call with nested parens. The injected `process.stdout.write(...)` is appended as an additional comma-expression at the end of the existing `if(U1)` guard — the overall shape is unchanged.

### Why it's safe

1. **Comma expression**: The injected code uses `,` (not `;`) after `k8=U1.headers`, making it part of the same expression inside the `if(U1)` guard. If `U1` is falsy (no response), none of it executes.

2. **`LR4()` is always fresh**: `pF1(U1.headers)` runs immediately before our injection. Inside `pF1`, `hR4(headers)` unconditionally updates `kh8`. So when we call `LR4()` (which returns `kh8`), it always contains the just-parsed data from the current response.

3. **Lightweight message**: The JSON payload is ~120 bytes (`{type, header_utilization: {five_hour: {utilization, resets_at}, seven_day: {...}}}`). Well under the atomic write threshold.

4. **No TUI interference**: In SDK mode, stdout is the transport — exactly where we want it. In TUI mode, Ink redirects stdout to the alternate screen buffer; the write is invisible.

5. **One write per API call**: The injection site is inside the streaming try-catch, after `for await(let d1 of q6)` completes. It runs exactly once per successful streaming API call.

## Message Format

```json
{
  "type": "rate_limit_event",
  "header_utilization": {
    "five_hour": {
      "utilization": 0.35,
      "resets_at": 1711500000
    },
    "seven_day": {
      "utilization": 0.12,
      "resets_at": 1712100000
    }
  }
}
```

- `utilization` is fractional (0.0–1.0), from `anthropic-ratelimit-unified-5h-utilization` header
- `resets_at` is Unix epoch seconds, from `anthropic-ratelimit-unified-5h-reset` header
- Either window may be absent if the corresponding headers are missing from the response

**Note:** This message intentionally omits `uuid` and `session_id` (present in the CLI's internal `rate_limit_event` schema) since the consumer doesn't need them. The SDK's `readMessages()` in `iX` class yields all parsed JSON from stdout without schema validation — unknown fields or missing fields are fine.

## How to Find This Code

### Header utilization getter (`LR4`) and parser (`hR4`)

```bash
bundle-analyzer find cli.js '"five_hour","5h"' --compact
```

Look for the function with the `[["five_hour","5h"],["seven_day","7d"]]` iteration. The getter is the tiny function immediately before it: `function <name>(){return <var>}`.

### Rate limit handler (`pF1`)

```bash
bundle-analyzer find cli.js "anthropic-ratelimit-unified-status" --compact
```

Look for the function that reads this header via `.get(...)`. Its caller `pF1` is the function that calls `hR4` and the status parser, and conditionally calls `BF1`.

### Rate limit broadcaster (`BF1`)

```bash
bundle-analyzer find cli.js "tengu_claudeai_limits_status_changed" --compact
```

The function that calls `d46.forEach(...)` right before this telemetry event.

### Stream loop injection site (`XiK`)

```bash
bundle-analyzer find cli.js "pF1" --compact
# Or search for the surrounding context:
bundle-analyzer find cli.js "tengu_streaming_stall_summary" --compact
```

The `pF1(<var>.headers)` call is near the end of the streaming try block in `XiK`, after the stall summary telemetry.

### sdkMessageAdapter (context — not patched)

```bash
bundle-analyzer find cli.js "sdkMessageAdapter" --compact
```

The `case "rate_limit_event"` branch returns `{type:"ignored"}`. This is why the `d46` → TUI queue path never reaches SDK consumers.

### `NJ` (deep equality — the dedup gate)

```bash
bundle-analyzer find cli.js ";NJ=" --compact
# Resolves to lodash isEqual: NJ = SC5 = eP6 = $X7
```

### Initial `aV` value

```bash
bundle-analyzer find cli.js 'status:"allowed",unifiedRateLimitFallbackAvailable:!1,isUsingOverage:!1}' --compact
```

Look for the `var rQ=L(()=>{...})` lazy initializer block that sets `aV`, `kh8`, and `d46`.

## Syntax Pitfalls

### Pitfall: Comma expression inside `if()` body

```js
// CORRECT — comma expression, all three sides execute under the if() guard
if(U1)pF1(U1.headers),k8=U1.headers,process.stdout.write(...)

// WRONG — semicolon terminates the if, stdout always executes
if(U1)pF1(U1.headers),k8=U1.headers;process.stdout.write(...)
```

The `if(U1)` has no braces — it's a single-statement body. The comma operator keeps all expressions inside the guard. A semicolon would make the `process.stdout.write` unconditional and execute it even when `U1` is null.

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

**`d46` listener Set** — The internal rate limit change listener mechanism is untouched. We don't inject into it anymore — the dedup behavior that blocked v1 remains as-is.

**`BF1` broadcaster** — Still only fires when `NJ(aV, z)` detects a status change. The TUI status line and telemetry continue to work normally.

**`sdkMessageAdapter`** — Still drops `rate_limit_event` with `{type:"ignored"}`. This is irrelevant since our stdout write bypasses the adapter entirely.

**`pF1` internals** — The handler itself is not modified. We only add code after it runs, reading its side effect (`kh8` update via `hR4`).

**`/api/oauth/usage` endpoint** — The `usage-relay` patch's background poll still works independently. This patch provides real-time updates _between_ polls, using data that arrives for free with inference responses.

## Consumer-Side Integration

### ClaudeSession (main process)

In `src/main/services/claude-session.ts`, the SDK message handler routes `rate_limit_event`:

```typescript
} else if (type === 'rate_limit_event') {
  const headerUtil = msg.header_utilization as Record<string, { utilization: number; resets_at: number }> | undefined
  if (headerUtil) {
    usageFetcher.updateFromHeaderUtilization(headerUtil)
  }
}
```

### UsageFetcher (main process)

In `src/main/services/usage-fetcher.ts`, `updateFromHeaderUtilization()`:

1. Maps `five_hour` → `fiveHour`, `seven_day` → `sevenDay`
2. Converts fractional utilization (0–1) → percentage (0–100)
3. Converts `resets_at` (epoch seconds) → ISO string
4. Merges into `lastUsage` (preserving other windows from the last full API response)
5. Pushes to renderer via IPC (`usage:data` event)
6. Schedules a debounced disk cache write

### Full round-trip

```
Inference response headers
  → cli.js: pF1(headers) → hR4() updates kh8
    → [PATCH] process.stdout.write({ header_utilization: LR4() })
      → sdk.mjs ProcessTransport reads line → JSON.parse → yields
        → iX.readMessages() → inputStream.enqueue() → consumer iterates
          → ClaudeSession: type === 'rate_limit_event'
            → usageFetcher.updateFromHeaderUtilization(headerUtil)
              → IPC: window.webContents.send('usage:data', usage)
                → useClaudeEvents hook → setAccountUsage()
                  → Sidebar re-renders with updated progress bar
```

## Verification

1. `node patch/rate-limit-relay/apply.mjs` — should apply successfully
2. Run again — should report "Patch already applied. Skipping."
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches pass
5. Send a message in a session
6. Check `~/.claude/ui/logs/` for:
   - `[DEBUG] [ClaudeSession] rate_limit_event: header_util={"five_hour":{"utilization":...},...}`
   - `[DEBUG] [UsageFetcher] header_utilization: five_hour → XX.X% (resets ...)`
7. Observe the sidebar's 5-hour usage bar updating after each assistant response

## Discovery Method

1. **User reported** the usage bar was stuck at 0% and only updated from the background API poll.

2. **Verified patches applied**: Both `PATCHED:rate-limit-relay` (cli.js) and `PATCHED:usage-relay-sdk` (sdk.mjs) markers were present. OAuth credentials had `user:inference` scope.

3. **Checked logs**: Zero `rate_limit_event` entries in `~/.claude/ui/logs/`, meaning events never reached our handler in `claude-session.ts`.

4. **Traced the old patch's injection site**: The v1 patch was inside a `d46` listener callback (`E`), which only fires when `BF1` is called.

5. **Found the dedup gate**: `pF1` calls `BF1(z)` guarded by `!NJ(aV, z)` — a lodash deep-equality check. The initial `aV` is `{status:"allowed", unifiedRateLimitFallbackAvailable:false, isUsingOverage:false}`. After the first request updates `aV` with `resetsAt`, subsequent requests with the same `resetsAt` produce identical state objects → `NJ` returns true → `BF1` never fires → our `d46` listener is dead.

6. **Identified the fix**: `kh8` (the per-window utilization store) IS updated unconditionally by `hR4` inside `pF1`. The data is always fresh — the problem is that nobody reads it when `BF1` is suppressed. The fix: inject a stdout write right after `pF1(U1.headers)` in the stream loop (`XiK`), reading `LR4()` (= `kh8`) directly.

7. **Verified the injection point**: `if(U1)pF1(U1.headers),k8=U1.headers` appears exactly once in cli.js and runs after every successful streaming API call.

## Version Progression

| What changed                | v2.1.97                                 | v2.1.197                                                                                              |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pF1` param count           | 1 (`(q)`)                               | 4 (`(e,t,n=!1,r=Date.now())`) — model, boolean flag, timestamp added                                 |
| `pF1` scope init            | `let K=I7()` (assigns then guards)      | `let o=Eo()` (same structure, different names)                                                        |
| `pF1` call site args        | `pF1(U1.headers)` (1 arg)               | `pF1(Hn.headers,<model>,(fg(model)\|\|Sx(model))&&...,<we>)` (4 args, nested parens)                |
| `kh8` store name            | `kh8` / `LR4()` getter                  | `n5e` / `r5e()` getter (content patterns still unique)                                               |
| Patch injection shape       | `,process.stdout.write(...)` appended   | Same — appended as trailing comma-expression inside `if(Hn)` guard; unchanged                        |

## Key Functions Reference

| Name (v2.1.97) | Name (v2.1.197) | Purpose                                                                     | Char offset (v2.1.97) |
| -------------- | --------------- | --------------------------------------------------------------------------- | --------------------- |
| `LR4()`        | `r5e()`         | Getter for `kh8`/`n5e` (parsed header utilization)                          | ~6485791              |
| `hR4(q)`       | `zda(q)`        | Header parser → `{ five_hour: {utilization, resets_at}, seven_day: {...} }` | ~6485817              |
| `pF1(q)`       | `xBn(e,t,n,r)`  | Main rate limit handler (calls `hR4`, `SR4`, conditionally `BF1`)           | ~6488865              |
| `SR4(q)`       | `Jda(q)`        | Unified status parser → `{ status, resetsAt, rateLimitType, ... }`          | ~6487750              |
| `BF1(q)`       | `Q3t(q)`        | Broadcaster: `aV=q, d46.forEach(cb => cb(q))` + telemetry                   | ~6486087              |
| `NJ`           | `YDe`           | Deep equality (lodash `isEqual`) — gates `BF1`                              | (lazy var)            |
| `XiK(...)`     | —               | Async generator stream loop — injection site                                | ~11714504             |
| `I7()`         | —               | OAuth + `user:inference` scope check                                        | ~3493920              |

**Note:** All minified names will change in future SDK versions. Use content patterns (string literals, structural shapes) to relocate code.

### How to re-find `pF1` when names change

The function is uniquely identified by two properties:
1. It is the function that resets `kh8`/`n5e` to `{}` inside its guard body
2. It contains the string `"anthropic-ratelimit-unified-status"` (via its call to `SR4`/`Jda`)

Search strategy:
```bash
# Primary: find the status-header string (in SR4/Jda), then navigate to pF1's caller
bundle-analyzer find cli.js "anthropic-ratelimit-unified-status" --compact

# The kh8 store is found via the getter+parser pair:
bundle-analyzer find cli.js '"five_hour","5h"' --compact
# The tiny getter function immediately before this is LR4/r5e; its return value is kh8/n5e.

# The call site is unique: pF1(<var>.headers,<args...>),<headers_var>=<response_var>.headers
# Use the dynamic extraction in apply.mjs (searches for pF1 name extracted above + .headers pattern)
```

## Related Patches

- **`patch/usage-relay/`** — Relays the CLI's `/api/oauth/usage` endpoint through SDK control messages. Provides the full usage breakdown (5hr, 7-day, 7-day-sonnet, extra*usage) but requires an API call. This `rate-limit-relay` patch provides real-time updates \_between* those API polls, using data that arrives for free with inference response headers.

## Files

| File        | Purpose                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `README.md` | This document                                                          |
| `apply.mjs` | Patch script — single injection, extracts 2 minified names dynamically |
