# Patch: rate-limit-relay

Forwards real-time rate limit utilization data (from inference response headers) to the SDK consumer — the CLI emits these events internally but never writes them to the SDK stdout transport.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.81 |
| Bundled CLI (`cli.js`) | 2.1.81 |

The SDK bundles its own `cli.js`, independent of the native `claude` binary.

## The Problem

### User-visible symptom

ClaudeUI cannot display real-time rate limit utilization (5-hour session %, 7-day %) after each inference call. The only way to get this data is polling the `/api/oauth/usage` endpoint, which is rate-limited (429s) and adds latency.

### Root cause

The CLI already parses `anthropic-ratelimit-unified-*` response headers after every inference call and emits `rate_limit_event` messages internally. However, the message never reaches the SDK consumer because:

1. **TUI path**: The event is enqueued into the internal message queue (`f.enqueue(...)`) which feeds the React TUI — but the `sdkMessageAdapter` function (`r26`) explicitly drops it:
   ```js
   case "rate_limit_event":
     return V("[sdkMessageAdapter] Ignoring rate_limit_event message"),
       {type: "ignored"};
   ```

2. **SDK stdout path**: Nobody writes the event to `process.stdout` — the newline-delimited JSON transport that SDK consumers read from. The event only exists in the TUI's internal queue.

Despite the SDK TypeScript types (`SDKRateLimitEvent`, `SDKRateLimitInfo`) being fully defined in `sdk.d.ts`, and the CLI having complete infrastructure to generate these events, the last-mile delivery to stdout is simply missing.

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
  ├── SD4(headers) — parses unified headers into:
  │     { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }
  │     Stored in global `pf8`
  │
  ├── ID4(headers) — parses full status into:
  │     { status, resetsAt, rateLimitType, utilization, isUsingOverage, ... }
  │
  └── dL1(headers) — main handler, called after each inference response:
        1. Calls SD4() → stores in pf8
        2. Calls ID4() → gets full status
        3. Calls QL1(status) → broadcasts to y66 listener Set
                │
                ├── TUI listener: v = (E6) => {
                │     let W6 = TZq(E6);      // transform to clean shape
                │     if (W6) f.enqueue({     // TUI internal queue
                │       type: "rate_limit_event",
                │       rate_limit_info: W6,
                │       uuid: pX(), session_id: E8()
                │     })
                │   }
                │   └── r26() adapter: case "rate_limit_event" → {type:"ignored"} ← DROPPED
                │
                └── [PATCH] process.stdout.write(JSON + "\n")  ← SDK transport
                      │
                      └── sdk.mjs → ClaudeSession → usageFetcher.updateFromRateLimitEvent()
```

### Key functions

| Function (v2.1.81) | Char offset | Purpose |
|---|---|---|
| `SD4(A)` | ~6608884 | Parses `anthropic-ratelimit-unified-*` headers → `{ five_hour, seven_day }` |
| `ID4(A)` | ~6610816 | Full unified rate limit status parser → `SDKRateLimitInfo` shape |
| `dL1(A)` | ~6611785 | Main handler: calls SD4 + ID4 + QL1 after each inference response |
| `QL1(A)` | ~6609103 | Broadcasts rate limit state change to `y66` listener Set |
| `TZq(A)` | ~10389157 | Transforms internal state → clean `SDKRateLimitInfo` (strips undefined fields) |
| `hD4()` | ~6608807 | Getter for `pf8` (cached parsed headers for status line) |
| `r26(A,q)` | ~11565365 | `sdkMessageAdapter` — converts CLI messages for TUI, drops `rate_limit_event` |

### Variable mapping at injection site

| Variable | Source | Value |
|---|---|---|
| `v` | local arrow function | Rate limit listener, added to `y66` Set |
| `E6` | `QL1()` callback param | Full rate limit state (internal `_v` shape) |
| `W6` | `TZq(E6)` return | Cleaned `SDKRateLimitInfo` (undefined fields stripped) |
| `f` | enclosing scope | TUI message queue (`{ enqueue(msg) }`) |
| `pX` | enclosing scope | UUID generator function |
| `E8` | enclosing scope | Session ID getter function |
| `y66` | module-level `Set` | Rate limit change listeners |

### TZq transform (rate limit info → clean shape)

```js
function TZq(A) {
  if (!A) return;
  return {
    status: A.status,
    ...A.resetsAt !== void 0 && { resetsAt: A.resetsAt },
    ...A.rateLimitType !== void 0 && { rateLimitType: A.rateLimitType },
    ...A.utilization !== void 0 && { utilization: A.utilization },
    ...A.overageStatus !== void 0 && { overageStatus: A.overageStatus },
    ...A.overageResetsAt !== void 0 && { overageResetsAt: A.overageResetsAt },
    ...A.overageDisabledReason !== void 0 && { overageDisabledReason: A.overageDisabledReason },
    ...A.isUsingOverage !== void 0 && { isUsingOverage: A.isUsingOverage },
    ...A.surpassedThreshold !== void 0 && { surpassedThreshold: A.surpassedThreshold }
  }
}
```

This runs *before* both the `f.enqueue()` and our injected `process.stdout.write()`, so the data is already in the correct shape.

## The Patch

Single patch — adds a `process.stdout.write` alongside the existing TUI enqueue.

**Marker**: `/*PATCHED:rate-limit-relay*/`

### Anchor (unique, 1 match)

```
if(<W6>)<f>.enqueue({type:"rate_limit_event",rate_limit_info:<W6>,uuid:<pX>(),session_id:<E8>()})
```

Content pattern (stable across versions — the `type:"rate_limit_event"` string literal is the anchor):

```
if(%V%)%V%.enqueue({type:"rate_limit_event",rate_limit_info:%V%,uuid:%V%(),session_id:%V%()})
```

### Before

```js
if(W6)f.enqueue({type:"rate_limit_event",rate_limit_info:W6,uuid:pX(),session_id:E8()})
```

### After

```js
if(W6)f.enqueue({type:"rate_limit_event",rate_limit_info:W6,uuid:pX(),session_id:E8()})/*PATCHED:rate-limit-relay*/,process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:W6,uuid:pX(),session_id:E8()})+"\n")
```

### Dynamic function extraction

All four minified names are extracted from the single anchor pattern:

```js
const enqueueRe = new RegExp(
  `if\\((${V})\\)(${V})\\.enqueue\\(\\{type:"rate_limit_event",rate_limit_info:\\1,uuid:(${V})\\(\\),session_id:(${V})\\(\\)\\}\\)`
)
// Captures: [1]=infoVar(W6), [2]=queueVar(f), [3]=uuidFn(pX), [4]=sessionFn(E8)
```

The backreference `\\1` ensures the `rate_limit_info` value matches the same variable as the `if()` guard — a strong structural constraint.

### Why it's safe

1. **Comma expression**: The injected code uses `,` (not `;`) after the `enqueue()` call, making it part of the same expression inside the existing `if(W6)` guard. If `W6` is falsy, neither the enqueue nor the stdout write executes.

2. **Identical message shape**: The stdout write emits the exact same JSON object as the TUI enqueue — `{type, rate_limit_info, uuid, session_id}`. This matches the `SDKRateLimitEvent` Zod schema already defined in the CLI.

3. **Single-threaded execution**: The `y66` listener fires synchronously from `QL1()` inside the event loop. No concurrent stdout writes are possible. The JSON payload is ~150 bytes — well under the atomic write threshold.

4. **No TUI interference**: In TUI mode, the `f.enqueue()` feeds the React render loop. The extra `process.stdout.write()` goes to stdout, which Ink redirects to the alternate screen buffer — it's invisible. In SDK mode, stdout is the transport, which is exactly where we want the message.

5. **Schema-validated**: The message shape matches the Zod schema `sq_` (see below) — if the CLI ever adds validation to outbound SDK messages, this will pass.

## Message Format

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "rateLimitType": "five_hour",
    "utilization": 0.35,
    "resetsAt": 1711500000
  },
  "uuid": "msg_...",
  "session_id": "..."
}
```

### Zod schema (CLI internal, `aq_` / `sq_`)

```js
// aq_ — SDKRateLimitInfo
h.object({
  status: h.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: h.number().optional(),
  rateLimitType: h.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]).optional(),
  utilization: h.number().optional(),
  overageStatus: h.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  overageResetsAt: h.number().optional(),
  overageDisabledReason: h.enum([
    "overage_not_provisioned", "org_level_disabled", "org_level_disabled_until",
    "out_of_credits", "seat_tier_level_disabled", "member_level_disabled",
    "seat_tier_zero_credit_limit", "group_zero_credit_limit", "member_zero_credit_limit",
    "org_service_level_disabled", "org_service_zero_credit_limit",
    "no_limits_configured", "unknown"
  ]).optional(),
  isUsingOverage: h.boolean().optional(),
  surpassedThreshold: h.number().optional()
})

// sq_ — SDKRateLimitEvent
h.object({
  type: h.literal("rate_limit_event"),
  rate_limit_info: aq_(),
  uuid: ww(),
  session_id: h.string()
})
```

### SDK TypeScript types (sdk.d.ts)

```typescript
export declare type SDKRateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID;
  session_id: string;
};

export declare type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string; // 13 enum values
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
};
```

## How to Find This Code

### Rate limit event enqueue (injection site)

```bash
bundle-analyzer find cli.js "rate_limit_event" --compact
```

Look for the match inside a `let v=(<var>)=>{` arrow function near `y66.add(v)`.

### sdkMessageAdapter (the drop site — not patched, just context)

```bash
bundle-analyzer find cli.js "sdkMessageAdapter" --compact
```

The `case "rate_limit_event"` branch returns `{type:"ignored"}`.

### Rate limit header parser (SD4)

```bash
bundle-analyzer find cli.js "ratelimit-unified" --compact
```

Look for the function that iterates over `["five_hour","5h"],["seven_day","7d"]`.

### Rate limit broadcaster (QL1)

```bash
bundle-analyzer find cli.js "tengu_claudeai_limits_status_changed" --compact
```

The function that calls `y66.forEach((K)=>K(A))` right before the telemetry event.

### Rate limit info transformer (TZq)

```bash
bundle-analyzer find cli.js "surpassedThreshold" --compact
```

Look for the function with the chain of `...A.field !== void 0 && { field: A.field }` spreads.

### Main inference handler (dL1 caller)

```bash
bundle-analyzer find cli.js "dL1" --compact
# Or find by the pattern where headers are passed:
bundle-analyzer find cli.js "W8.headers" --compact
```

In the stream loop function (`ayq`), look for `if(W8)dL1(W8.headers)` after streaming completes.

## Syntax Pitfalls

### Pitfall: Comma expression inside `if()` body

The injected code appends to the `if(W6)` body using a comma expression:

```js
// CORRECT — comma expression, both sides execute under the if() guard
if(W6)f.enqueue({...}),process.stdout.write(...)

// WRONG — semicolon terminates the if, stdout always executes
if(W6)f.enqueue({...});process.stdout.write(...)
```

The comma expression is required because the `if(W6)` has no braces — it's a single-statement body. Adding `;` would make the `stdout.write` unconditional.

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

**sdkMessageAdapter (`r26`)** — The TUI adapter still drops `rate_limit_event` with `{type:"ignored"}`. This is intentional — the TUI doesn't need rate limit events through the adapter pathway (it uses React hooks on `y66` directly). We bypass it entirely via stdout.

**`pf8` / `hD4()`** — The parsed header cache used by the status line hook is untouched. The status line data (`KZY`) reads `hD4()` directly for the `rate_limits` field in the hook JSON.

**`/api/oauth/usage` endpoint** — The `sHq()` function still exists and is used by the `/usage` command UI and our `usage-relay` patch. This patch provides real-time updates *between* API polls, not a replacement.

**QL1 listener registration** — The `y66.add(v)` call is unchanged. Our stdout write piggybacks on the same listener callback.

## Consumer-Side Integration

### ClaudeSession (main process)

In `src/main/services/claude-session.ts`, the message handler checks for `rate_limit_event`:

```typescript
} else if (type === 'rate_limit_event') {
  const info = msg.rate_limit_info as Record<string, unknown> | undefined
  logger.debug('ClaudeSession', `rate_limit_event received: ${JSON.stringify(info)}`)
  if (info) {
    usageFetcher.updateFromRateLimitEvent(info)
  }
}
```

### UsageFetcher (main process)

In `src/main/services/usage-fetcher.ts`, `updateFromRateLimitEvent()`:

1. Extracts `utilization`, `rateLimitType`, `resetsAt` from the info object
2. Maps `rateLimitType` to `AccountUsage` fields (`five_hour` → `fiveHour`, etc.)
3. Merges into `lastUsage` (preserving other windows from the last full API response)
4. Pushes to renderer via IPC (`usage:data` event)
5. Schedules a debounced disk cache write

### Renderer (Zustand store → Sidebar)

The `usage:data` event triggers `setAccountUsage()` in the session store, which updates the sidebar's 5-hour rate limit progress bar in real time.

### Full round-trip

```
Inference response headers
  → cli.js: SD4() parses → QL1() broadcasts → y66 listener
    → [PATCH] process.stdout.write(JSON + "\n")
      → sdk.mjs reads line from stdout → yields to consumer
        → ClaudeSession message handler: type === 'rate_limit_event'
          → usageFetcher.updateFromRateLimitEvent(info)
            → IPC: window.webContents.send('usage:data', usage)
              → useClaudeEvents hook → setAccountUsage()
                → Sidebar re-renders with updated progress bar
```

## Verification

1. `node patch/rate-limit-relay/apply.mjs` — should apply successfully
2. Run again — should report "Patch already applied. Skipping."
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches pass
5. Set log filter to `ClaudeSession,UsageFetcher` in Settings → Logging
6. Send a message in a session
7. Check dev console / `~/.claude/ui/logs/` for:
   - `[DEBUG] [ClaudeSession] rate_limit_event received: {...}`
   - `[DEBUG] [UsageFetcher] rate_limit_event: five_hour → XX.X% (resets ...)`
8. Observe the sidebar's 5-hour usage bar updating after each assistant response

## Discovery Method

1. **User noticed** the CLI status line shows usage data and suspected it comes from inference response headers (free, no API call needed).

2. **Searched for `status_line`** and `utilization` in cli.js. Found the `KZY` function that builds the status line JSON, which reads `hD4()` (returns `pf8`, the parsed header cache).

3. **Traced the header parsing chain**: `SD4(headers)` parses `anthropic-ratelimit-unified-*-utilization/reset` headers → stored in `pf8`. Called by `dL1(headers)` which is invoked from the stream loop after each inference response.

4. **Found `QL1`** — the broadcaster that fires `y66.forEach((K)=>K(A))` when rate limit state changes. This is the notification mechanism.

5. **Found the TUI listener** at char ~12224520 — an arrow function `v` that calls `TZq(state)` (cleans the object) and enqueues a `{type:"rate_limit_event"}` message into the TUI queue `f`.

6. **Checked the SDK message adapter** (`r26` / `sdkMessageAdapter`) — found that `rate_limit_event` is explicitly in the ignore list, returning `{type:"ignored"}`.

7. **Verified SDK TypeScript types** — `SDKRateLimitEvent` and `SDKRateLimitInfo` are fully defined in `sdk.d.ts`, proving the SDK authors intended this to be a consumer-visible event but never wired the stdout transport.

8. **Confirmed no stdout write exists** — searched all `process.stdout.write` sites. No existing code writes `rate_limit_event` to stdout. The TUI queue is the only destination.

9. **Chose injection strategy**: Add `process.stdout.write(JSON + "\n")` as a comma expression after the existing `f.enqueue()`, inside the same `if(W6)` guard. This mirrors how `subagent-streaming` and `team-streaming` patches forward messages.

10. **Verified** with `node --check` and manual testing with debug log filter.

## Key Functions Reference

| Name (v2.1.81) | Purpose | Char offset |
|---|---|---|
| `SD4(A)` | Parse unified rate limit headers → `{five_hour, seven_day}` | ~6608884 |
| `ID4(A)` | Full rate limit status from headers → `SDKRateLimitInfo` shape | ~6610816 |
| `dL1(A)` | Main handler: SD4 + ID4 + QL1, called after inference | ~6611785 |
| `QL1(A)` | Broadcast rate limit change to `y66` Set | ~6609103 |
| `TZq(A)` | Clean rate limit state → strip undefined fields | ~10389157 |
| `hD4()` | Getter for `pf8` (cached parsed headers) | ~6608807 |
| `r26(A,q)` | `sdkMessageAdapter` — drops `rate_limit_event` for TUI | ~11565365 |
| `pX()` | UUID generator | (extracted dynamically) |
| `E8()` | Session ID getter | (extracted dynamically) |

**Note:** All minified names will change in future SDK versions. Use content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- **`patch/usage-relay/`** — Relays the CLI's `/api/oauth/usage` endpoint through SDK control messages. Provides the full usage breakdown (5hr, 7-day, 7-day-sonnet, extra_usage) but requires an API call. This `rate-limit-relay` patch provides real-time updates *between* those API polls, using data that arrives for free with inference responses.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script — single injection, extracts 4 minified names dynamically |
