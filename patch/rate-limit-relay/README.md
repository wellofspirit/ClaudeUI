# Patch: rate-limit-relay

Forwards real-time per-window rate limit utilization data (from inference response headers) to the SDK consumer after every API call — enabling live usage bar updates without polling.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| SDK package            | 0.2.97                       |
| Bundled CLI (`cli.js`) | 2.1.97                       |
| Last re-anchored       | 2.1.261                      |

The SDK bundles its own `cli.js`, independent of the native `claude` binary.

### Bundle shape: 2.1.261 is a concat of ESM chunks, not a monolith

Up to 2.1.241 `vendor/claude-cli/cli.js` was ONE minified CJS bundle. 2.1.261 is built
with code-splitting: **1,631 separate minified ESM chunks**, which the repo's extract step
concatenates in module-graph order into the same `vendor/claude-cli/cli.js` path. Each chunk
is preceded by a delimiter line:

```
// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
```

Two consequences this patch has to respect:

1. **Regexes must not bridge a chunk boundary.** Chunk bodies are single lines, so
   `apply.mjs` bars `\n` from every argument/parameter span (`argPat`, `paramPat`). That
   makes bridging structurally impossible rather than merely unlikely.
2. **Each chunk is its own module scope.** The injected code calls the utilization getter by
   name, so that name must be bound _in the chunk being edited_ — either because the getter
   is declared there, or via that chunk's `import{…}from"<defining chunk>"` (possibly under
   an alias). `apply.mjs` builds a chunk index, resolves the local binding, and **aborts** if
   the getter is not reachable rather than emitting a call that would `ReferenceError`.

In 2.1.261 the getter (`SL`) and the stream-loop injection site are both in
`chunk-9c0rs7w4.js` (a 5.6 MB chunk holding most of the API client), so the local name is
just `SL`. Do not assume that stays true.

## The Problem

### User-visible symptom

The 5-hour rate limit utilization bar in ClaudeUI's sidebar stays at 0% and only updates when the background `/api/oauth/usage` poll runs (every 30 minutes). It should update in real time after every inference call.

### Root cause

> Names in this section are the v2.1.97 ones from the original investigation. The _shape_ of
> the problem has not changed since; only the minified names and their container have. See
> [Key functions](#key-functions) for the current mapping — the class-based 2.1.231+ layout
> reads `kh8`→`QS.rawUtilization`, `LR4()`→`SL()`, `pF1`→`Iot`, `hR4`→`Dwn`,
> `BF1`→`QS.emitStatusChange`, `NJ`→`Qs`, `d46`→`QS.statusChanged`.

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
  └── stream loop completes (right after the tengu_streaming_stall_summary
      telemetry), then runs one comma chain under `if(<resp>)`:
        │
        ├── Gie(<retryState>, <now>)              (low-priority wait accounting)
        ├── rEn(<resp>.headers, …)                → QS.extractGraceStatusFromHeaders
        │
        ├── Iot(<resp>.headers, …) — the header-ingest fn (was pF1):
        │     → QS.extractQuotaStatusFromHeaders(e,t,r,o,d,f)
        │        1. isFromPreviousAccount(d) → bail if the account rotated
        │        2. gt()/_8()  → OAuth + user:inference scope check
        │                        (fails → rawUtilization reset to {}, bail)
        │        3. _le(headers) → normalize; KPe(…) → full status object
        │        4. isStaleObservation(o) → skip if an older response landed late
        │        5. recordRawUtilization(Dwn(headers), o)
        │                        → parses 5h/7d/7d_oi/overage → QS.rawUtilization
        │        6. Qs(currentLimits, v) → deep-equal check (blocks most broadcasts)
        │        7. emitStatusChange(v) → only if state changed (rarely fires)
        │              └── statusChanged.emit(v)  ← rate limit listeners
        │
        ├── Iar(<resp>.headers, …)                (2.1.261: unrelated header notice check)
        ├── <hdr> = <resp>.headers                (stores headers locally)
        │
        └── [PATCH] process.stdout.write(JSON + "\n")  ← always runs
              │     Emits: { type: "rate_limit_event", header_utilization: SL() }
              │     SL() = eEn(QS.rawUtilization) — freshly set at step 5 above
              │
              └── the harness reads the line → yields to consumer
                    → ClaudeSession handler → usageFetcher.updateFromHeaderUtilization()
                      → IPC: 'usage:data' → renderer sidebar bar update
```

**2.1.261 note — the getter now filters.** `SL()` is no longer a raw store read: it is
`eEn(QS.rawUtilization)`, and `eEn` keeps only windows that pass `g6` (finite `utilization`
_and_ `resets_at`) **and** whose `resets_at` is in the future and less than a year out.
So a window whose reset time has already passed is dropped instead of relayed stale — an
improvement, and harmless downstream (`updateFromHeaderUtilization` skips absent windows,
and an all-empty payload sets `updated = false` so nothing is pushed).

**2.1.261 note — more windows.** The window list `YPe` is now
`[["five_hour","5h"],["seven_day","7d"],["seven_day_overage_included","7d_oi"],["overage","overage"]]`,
so the emitted `header_utilization` can carry four keys. The consumer maps only
`five_hour`/`seven_day` and ignores the rest — no consumer change needed.

### Key functions

| Role                                   | v2.1.97  | v2.1.197       | v2.1.261 (all in `chunk-9c0rs7w4.js`)        |
| -------------------------------------- | -------- | -------------- | -------------------------------------------- |
| Utilization getter (what we call)      | `LR4()`  | `r5e()`        | `SL()` → `eEn(QS.rawUtilization)`            |
| Utilization store                      | `kh8`    | `n5e`          | `QS.rawUtilization` (class field)            |
| Header parser (`…-utilization/-reset`) | `hR4(q)` | `zda(q)`       | `Dwn(e)`                                     |
| Header-ingest fn (our anchor)          | `pF1(q)` | `xBn(e,t,n,r)` | `Iot(e,t,r=!1,o=Date.now(),d,f)`             |
| Ingest implementation                  | —        | —              | `QS.extractQuotaStatusFromHeaders(…)`        |
| Status parser                          | `SR4(q)` | `Jda(q)`       | `KPe(hdrs, graceActive)`                     |
| Broadcaster                            | `BF1(q)` | `Q3t(q)`       | `QS.emitStatusChange(e)` (+ `q3e` wrapper)   |
| Deep equality (dedup gate)             | `NJ`     | `YDe`          | `Qs` (imported into the chunk, not declared) |
| Singleton / class                      | —        | —              | `var QS=new Xwn`                             |
| Stream loop (injection site)           | `XiK(…)` | —              | unnamed async generator, ~char 9506089       |

**Name map v2.1.97 → v2.1.197:** `pF1→xBn`, `LR4→r5e`, `kh8→n5e`, `hR4→zda`, `SR4→Jda`, `BF1→Q3t`, `d46→YDe`.

**v2.1.231 restructured this area from module-level state into a class** (`Xwn`) with a
module singleton (`QS`) and thin module-level wrapper functions. Since then the durable
anchors are the **property names** — `rawUtilization`, `extractQuotaStatusFromHeaders` —
which minifiers do not rename. Bind to those; the function/singleton names fall out.

**All minified names will change again in future versions.** Use content patterns, not names.

### Why listener piggybacking doesn't work

Still true in 2.1.261 — only the names moved (v2.1.97 names in the diagram, current ones in
brackets):

```
      pF1 [Iot] (headers) called on EVERY request
                        │
                  hR4 [Dwn] (headers)
      kh8 [QS.rawUtilization] = { five_hour:{…}, seven_day:{…} }  ← ALWAYS updated
                        │
                  SR4 [KPe] (headers)
        z = { status: "allowed", resetsAt: 1711500000, ... }
                        │
   NJ [Qs] (aV, z) === true?  ───── YES (usual) ──→  return (no broadcast)
                        │                             the store has fresh data
                        NO (first request             but nobody reads it
                         or status change)
                        │
   BF1 [QS.emitStatusChange] (z) → listeners fire
   aV [QS.currentLimits] = z  (stored for next comparison)
```

The store is updated unconditionally by the header parser, but the broadcast is gated by the
deep-equal check. Our v2 patch reads the getter directly from the stream loop, bypassing the
broadcast entirely. **Whatever the names become, verify this gate still exists before
concluding a listener-based approach would be simpler.**

### Variable mapping at injection site (v2.1.261 names)

| Variable | Source                             | Value                                                         |
| -------- | ---------------------------------- | ------------------------------------------------------------- |
| `Sp`     | `let Sp = zs`                      | Raw `Response` object from `fetch()` in the API client        |
| `zs`     | set when the stream response lands | Response stored for post-streaming header access              |
| `Lb`     | local to the stream generator      | Cached headers (used elsewhere in the function)               |
| `Iot`    | module-level fn (same chunk)       | Header-ingest wrapper → `QS.extractQuotaStatusFromHeaders`    |
| `SL`     | module-level fn (same chunk)       | Getter: `function SL(){return eEn(QS.rawUtilization)}`        |
| `QS`     | module-level `var QS = new Xwn`    | Rate limit state singleton                                    |
| `eEn`    | module-level fn (same chunk)       | Validity filter over the window map (see below)               |
| `Xwn`    | class                              | Holds `rawUtilization`, `currentLimits`, `lastSeenWindows`, … |

All of the above live in `chunk-9c0rs7w4.js` in 2.1.261, which is why the injected
`SL()` call resolves. `SL` is a function _declaration_, so it is hoisted to the top of the
chunk's module scope and is callable from the injection site regardless of source order.

### `Dwn` — header parser (what feeds `QS.rawUtilization`)

```js
var YPe = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_overage_included', '7d_oi'],
  ['overage', 'overage']
]
function Dwn(e) {
  let t = {}
  for (let [r, o] of YPe) {
    let d = e.get(`anthropic-ratelimit-unified-${o}-utilization`),
      f = e.get(`anthropic-ratelimit-unified-${o}-reset`)
    if (d !== null && f !== null)
      t[r] = { utilization: Number(d), resets_at: Math.round(Number(f)) }
  }
  return t
}
```

### `eEn` / `g6` — the validity filter `SL()` applies (new in 2.1.261)

```js
function g6(e) {
  return e !== void 0 && Number.isFinite(e.utilization) && Number.isFinite(e.resets_at)
}
function eEn(e) {
  let t = Date.now() / 1000,
    r = t + 31536000,
    o = {}
  for (let [d] of YPe) {
    let f = e[d]
    if (g6(f) && f.resets_at > t && f.resets_at < r) o[d] = f
  }
  return o
}
function SL() {
  return eEn(QS.rawUtilization)
}
```

Utilization values are **fractional** (0.0–1.0), not percentages. The consumer (`updateFromHeaderUtilization`) multiplies by 100.

## The Patch

Single injection — writes `rate_limit_event` to stdout after every streaming API call.

**Marker**: `/*PATCHED:rate-limit-relay*/`

### Anchor (unique, 1 match)

The header-ingest call site in the stream loop, after streaming completes. The whole match
spans from the ingest call to the trailing headers assignment that closes the comma chain:

```
<pF1>(<resp>.headers,<args...>)[,<fn>(<args...>)]*,<hdr>=<resp>.headers
```

Content pattern (`<pF1>` is extracted dynamically; `%V%` = `[\w$]+`):

```
<pF1>\((%V%)\.headers,<argPat>\)(?:,%V%\(<argPat>\)){0,8},(%V%)=\1\.headers
```

**Why the `(?:,fn(...)){0,8}` run exists.** Upstream keeps adding siblings into this comma
chain, on both sides of the ingest call:

- v2.1.97: `if(<U1>)<pF1>(<U1>.headers),<k8>=<U1>.headers` — nothing else in the chain.
- v2.1.219 **prepended** a call, so `if(<resp>)` is no longer directly followed by the
  ingest call (`if(as)EDu(as.headers,ke,Qe),hpo(as.headers,...)`). The anchor dropped the
  leading `if(<resp>)` at that point.
- v2.1.261 also **appended** one _between_ the ingest call and the headers assignment
  (`Iar(Sp.headers,f,Zw)`), so neither neighbour is contiguous with the ingest call any
  more. Hence the bounded run of intervening sibling calls.

The combination is still unique: the other ingest call site (the non-streaming interceptor
path, ~char 9441894 in 2.1.261) passes a headers _object_ directly — `Iot(ke,t.model,…)` —
so it has neither `<var>.headers` as the first argument nor a trailing assignment.
`apply.mjs` asserts exactly 1 match and aborts otherwise.

### Before (v2.1.261)

```js
let Sp = zs
if (Sp)
  (Gie(Ru, bf),
    rEn(Sp.headers, xs, bf, tl),
    Iot(
      Sp.headers,
      f.model,
      (tc(f.model) || gg(f.model)) &&
        Ll.input_tokens + Ll.cache_read_input_tokens + Ll.cache_creation_input_tokens > UN,
      bf,
      tl,
      f.storageV5
    ),
    Iar(Sp.headers, f, Zw),
    (Lb = Sp.headers))
```

### After

```js
  …
  Iar(Sp.headers, f, Zw),
  (Lb = Sp.headers) /*PATCHED:rate-limit-relay*/,
  process.stdout.write(
    JSON.stringify({ type: 'rate_limit_event', header_utilization: SL() }) + '\n'
  ))
```

### Dynamic name extraction

Three names are extracted at apply time. `apply.mjs` tries the shapes newest-first and
keeps the older ones so a rolled-back `claudeCliVersion` still builds.

1. **Utilization getter** — the function the injected code calls.

   ```
   Shape A1 (v2.1.231):  function (%V%)\(\)\{return (%V%)\.rawUtilization\}
   Shape A2 (v2.1.261+): function (%V%)\(\)\{return %V%\((%V%)\.rawUtilization\)\}
   Shape B  (≤2.1.220):  function (%V%)\(\)\{return (%V%)\}function %V%\(%V%\)\{let %V%=\{\};
                         for\(let\[%V%,%V%\]of\[\["five_hour","5h"\],\["seven_day","7d"\](,\["…","…"\])*\]\)
   ```

   A1/A2 both capture `[1]` = getter name, `[2]` = singleton var. A2 is A1 wrapped in the
   new `eEn` validity filter. The `rawUtilization` **property name survives minification**,
   which is what makes these anchors durable. Asserted unique.

2. **Header-ingest fn** — the anchor for the call site. Bound to the _same_ singleton the
   getter reads, so the two can never drift apart:

   ```js
   const wrapperRe = new RegExp(
     `function (%V%)\\(${paramPat}\\)\\{${singleton}\\.extractQuotaStatusFromHeaders\\(`
   )
   ```

   The param list is matched generically on purpose — it grew 1 → 4 → 5 → 6 params across
   2.1.97 / 2.1.197 / 2.1.231 / 2.1.261 and will keep growing. Pinning the arity is what
   broke the 2.1.231 shape against 2.1.261. Asserted unique.

   Shape B (≤2.1.220) has no class, so it instead anchors on the store reset inside the
   scope guard: `function (%V%)(…){let %V%=%V%();if(!%V%(%V%)){if(<store>={} …`.

3. **The getter's local binding at the injection site** — new in 2.1.261, see
   [Bundle shape](#bundle-shape-21261-is-a-concat-of-esm-chunks-not-a-monolith).
   `apply.mjs` builds a chunk index from the `// @bun-chunk …` delimiters, and:
   - same chunk (or no delimiters at all → pre-2.1.261 monolith) → use the name as-is;
   - different chunk → read the injection chunk's `import{…}from"<defining chunk>"` and use
     the local alias (`X as y` → `y`);
   - not importable there → **abort**, rather than emit a call that would `ReferenceError`.

   In 2.1.261 both are in `chunk-9c0rs7w4.js`, so the emitted call is plain `SL()`.

### Why it's safe

1. **Comma expression**: The injected code uses `,` (not `;`) after `Lb=Sp.headers`, making
   it the last element of the same expression inside the `if(Sp)` guard. If `Sp` is falsy
   (no response), none of it executes.

2. **The getter is always fresh**: `Iot(Sp.headers,…)` runs earlier in the same comma
   chain, and inside it `recordRawUtilization(Dwn(headers), …)` updates
   `QS.rawUtilization`. `Iar(...)` runs in between but only reads headers, so the value we
   read is the one just parsed from this response. (2.1.261 added an `isStaleObservation`
   guard: an out-of-order older response will not clobber newer data — the getter still
   returns the freshest state, which is what we want.)

3. **Injection is offset-spliced, not `String#replace`d**: minified identifiers can contain
   `$`, and `$&`/`$'` in a replacement string would corrupt the output. `apply.mjs` splices
   by `match.index`, so replacement-pattern expansion cannot happen.

4. **Lightweight message**: The JSON payload is ~120–250 bytes (four windows at most). Well
   under the atomic write threshold.

5. **No TUI interference**: In headless/stream-json mode, stdout is the transport — exactly
   where we want it. In TUI mode, Ink redirects stdout to the alternate screen buffer; the
   write is invisible.

6. **One write per API call**: The injection site is inside the streaming try block, right
   after the `tengu_streaming_stall_summary` telemetry that follows stream drain. It runs
   exactly once per successful streaming API call.

7. **Chunk-local**: the emitted call names a binding that `apply.mjs` proved is in scope in
   the chunk it edited, and a post-write check confirms the marker landed in the chunk that
   was anchored on.

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
- Any window may be absent — the header was missing, or (2.1.261+) the getter's validity
  filter dropped it because `resets_at` was already in the past
- 2.1.261+ may additionally carry `seven_day_overage_included` and `overage`; the consumer
  ignores keys it doesn't map

**Note:** This message intentionally omits `uuid` and `session_id` (present in the CLI's internal `rate_limit_event` schema) since the consumer doesn't need them. The SDK's `readMessages()` in `iX` class yields all parsed JSON from stdout without schema validation — unknown fields or missing fields are fine.

## How to Find This Code

All commands run against `vendor/claude-cli/cli.js` (the concat). On Git Bash call the
analyzer with its extension: `bundle-analyzer.cmd`.

### The rate limit state class + its singleton (start here, 2.1.231+)

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "rawUtilization" --compact
bundle-analyzer.cmd find vendor/claude-cli/cli.js "extractQuotaStatusFromHeaders" --compact
```

Both are class property/method names, so they survive minification. The first hit is the
class declaration (`class Xwn{currentLimits={…};rawUtilization={};…}`); scan forward past
the method bodies for `var <singleton>=new <Class>` — everything after that is the set of
module-level wrapper functions, including the getter and the ingest fn.

### Header utilization getter (the function the patch calls)

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "return eEn(QS.rawUtilization)" --compact
# name-independent version:
bundle-analyzer.cmd find vendor/claude-cli/cli.js ".rawUtilization)}" --compact
```

Expect `function <G>(){return <filter>(<singleton>.rawUtilization)}` (2.1.261+) or the
unwrapped `function <G>(){return <singleton>.rawUtilization}` (2.1.231).

Do **not** confuse it with the sibling `function <q>(){…lastSeenWindows…}` accessor, which
reports the last-seen windows within a 30-minute staleness budget rather than the current
response's values.

### Header parser + window list

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js '"five_hour","5h"' --compact
```

Finds `var YPe=[["five_hour","5h"],…]` and the parser `Dwn(e)` that iterates it building
`{ <window>: { utilization, resets_at } }`. Also finds the validity filter `eEn`, which
iterates the same list.

### Header-ingest fn (the anchor)

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "extractQuotaStatusFromHeaders" --compact
```

Three hits in 2.1.261: the `probeQuotaStatus` internal call (`this.…`), the method
declaration, and the module-level wrapper `function Iot(…){QS.extractQuotaStatusFromHeaders(…)}`.
The wrapper is the one to bind to — it is what the stream loop calls.

### Status parser

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "anthropic-ratelimit-unified-status" --compact
```

`function KPe(e,t)` reads it plus `-reset`, `-fallback`, `-representative-claim`,
`-overage-status`, and returns the full status object.

### Broadcaster / dedup gate

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "tengu_claudeai_limits_status_changed" --compact
```

Inside `emitStatusChange(e)`, which is called only when `!Qs(this.currentLimits, v)` — the
deep-equal gate that is the reason this patch does not piggyback on the listener path.

### Stream loop injection site

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "tengu_streaming_stall_summary" --compact
```

The comma chain is ~400 chars after this telemetry: `let <resp>=<x>;if(<resp>)…,<hdr>=<resp>.headers`.
Alternatively grep for the shape directly:

```bash
rg -o '[\w$]+\([\w$]+\.headers,[^;]{0,300}?\),[\w$]+=[\w$]+\.headers' vendor/claude-cli/cli.js
```

### Which chunk am I in? (2.1.261+)

```bash
rg -n '^// @bun-chunk ' vendor/claude-cli/cli.js | head
```

`apply.mjs` prints the getter chunk and the injection chunk on every run — if they differ,
it resolves the import alias or aborts. To do it by hand, take the byte offset of the site
and find the last `// @bun-chunk` delimiter before it.

### sdkMessageAdapter (context — not patched)

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js "sdkMessageAdapter" --compact
```

The `case "rate_limit_event"` branch returns `{type:"ignored"}`. This is why the internal
listener → TUI queue path never reaches stream-json consumers.

## Syntax Pitfalls

### Pitfall: Comma expression inside `if()` body

```js
// CORRECT — comma expression, every element executes under the if() guard
if(Sp)Iot(Sp.headers,...),Lb=Sp.headers,process.stdout.write(...)

// WRONG — semicolon terminates the if, stdout always executes
if(Sp)Iot(Sp.headers,...),Lb=Sp.headers;process.stdout.write(...)
```

The `if(Sp)` has no braces — it's a single-statement body. The comma operator keeps all
expressions inside the guard. A semicolon would make the `process.stdout.write`
unconditional and execute it even when the response is null.

### Pitfall (2.1.261+): calling a binding that isn't in the edited chunk's scope

Each chunk in the concat is an independent ES module. Emitting `SL()` into a chunk that
neither declares nor imports `SL` produces a `ReferenceError` at runtime — and it will
_not_ be caught by a syntax check, because the code parses fine. `apply.mjs` resolves the
local binding (or aborts) before emitting; do not shortcut that if you re-anchor by hand.

### Pitfall (2.1.261+): regexes that bridge a chunk boundary

Wide `[\s\S]*?` spans can silently match across the `// @bun-chunk …` delimiter, producing
an edit that the rebundler then writes into the wrong chunk. Every argument/parameter span
in `apply.mjs` excludes `\n` for exactly this reason (chunk bodies are single lines).

**Always syntax-check after applying.** The full concat is not valid standalone JS, so
`node --check` on it is meaningless — check the _chunk_ instead: slice from the marker's
`// @bun-chunk` delimiter to the next one, write it to a `.mjs`, and run `node --check` on
that. The repo's rebundler does the equivalent with esbuild for every modified chunk.

## What's NOT Changed

**The rate limit listener path** — `statusChanged` / `emitStatusChange` and their
subscribers are untouched. We don't inject into them — the dedup behaviour that blocked v1
of this patch remains as-is.

**Broadcaster gating** — `emitStatusChange` still only fires when the deep-equal check
detects a status change. The TUI status line and telemetry continue to work normally.

**`sdkMessageAdapter`** — Still drops `rate_limit_event` with `{type:"ignored"}`. Irrelevant
since our stdout write bypasses the adapter entirely.

**Ingest internals** — `extractQuotaStatusFromHeaders` is not modified. We only add code
after it runs, reading its side effect (`QS.rawUtilization` via `recordRawUtilization`).

**The other calls in the comma chain** — `Gie(…)`, the grace-status extractor, and the
2.1.261 `Iar(…)` header notice check all run unchanged, in their original order. Our write
is appended strictly last.

**`/api/oauth/usage` endpoint** — The `usage-relay` patch's background poll still works independently. This patch provides real-time updates _between_ polls, using data that arrives for free with inference responses.

## Consumer-Side Integration

### ClaudeSession

In `src/core/services/claude-session.ts`, the harness message handler routes
`rate_limit_event` to `handleRateLimitEvent`:

```typescript
private handleRateLimitEvent(msg: RateLimitEventMessage): void {
  if (msg.header_utilization) {
    usageFetcher.updateFromHeaderUtilization(msg.header_utilization)
  }
}
```

### UsageFetcher

In `src/core/services/usage-fetcher.ts`, `updateFromHeaderUtilization()`:

1. Maps `five_hour` → `fiveHour`, `seven_day` → `sevenDay` (other keys ignored)
2. Converts fractional utilization (0–1) → percentage (0–100)
3. Converts `resets_at` (epoch seconds) → ISO string
4. Merges into `lastUsage` (preserving other windows from the last full API response)
5. Pushes to renderer via IPC (`usage:data` event)
6. Schedules a debounced disk cache write

An empty `header_utilization` (every window filtered out) leaves `updated = false`, so
nothing is pushed and the last known values stay on screen.

### Full round-trip

```
Inference response headers
  → cli.js: Iot(headers,…) → recordRawUtilization(Dwn(headers)) updates QS.rawUtilization
    → [PATCH] process.stdout.write({ header_utilization: SL() })
      → harness stdout reader → JSON.parse → message stream
        → ClaudeSession: type === 'rate_limit_event' → handleRateLimitEvent
          → usageFetcher.updateFromHeaderUtilization(headerUtil)
            → IPC: window.webContents.send('usage:data', usage)
              → useClaudeEvents hook → setAccountUsage()
                → Sidebar re-renders with updated progress bar
```

## Verification

1. `node patch/rate-limit-relay/apply.mjs` — should apply successfully, and print the getter
   chunk, the injection chunk, and the patched region
2. Run again — should report "Patch already applied. Skipping."
3. Syntax-check the modified **chunk** (not the whole concat — it isn't standalone-valid JS):
   slice from its `// @bun-chunk` delimiter to the next one into a `.mjs` and `node --check`
   it. `bun run ensure-cli` does the equivalent via the rebundler's per-chunk esbuild check.
4. `node patch/apply-all.mjs` — all patches pass
5. Send a message in a session
6. Check `~/.claude/ui/logs/` for:
   - `[DEBUG] [ClaudeSession] rate_limit_event: header_util={"five_hour":{"utilization":...},...}`
   - `[DEBUG] [UsageFetcher] header_utilization: five_hour → XX.X% (resets ...)`
7. Observe the sidebar's 5-hour usage bar updating after each assistant response

`test.mjs` drives a real prompt through the rebundled binary and asserts a `rate_limit_event`
with a well-formed `header_utilization` arrives; it needs a built binary and live
credentials, so it is not runnable from a bare patch worktree.

## Discovery Method

1. **User reported** the usage bar was stuck at 0% and only updated from the background API poll.

2. **Verified patches applied**: Both `PATCHED:rate-limit-relay` (cli.js) and `PATCHED:usage-relay-sdk` (sdk.mjs) markers were present. OAuth credentials had `user:inference` scope.

3. **Checked logs**: Zero `rate_limit_event` entries in `~/.claude/ui/logs/`, meaning events never reached our handler in `claude-session.ts`.

4. **Traced the old patch's injection site**: The v1 patch was inside a `d46` listener callback (`E`), which only fires when `BF1` is called.

5. **Found the dedup gate**: `pF1` calls `BF1(z)` guarded by `!NJ(aV, z)` — a lodash deep-equality check. The initial `aV` is `{status:"allowed", unifiedRateLimitFallbackAvailable:false, isUsingOverage:false}`. After the first request updates `aV` with `resetsAt`, subsequent requests with the same `resetsAt` produce identical state objects → `NJ` returns true → `BF1` never fires → our `d46` listener is dead.

6. **Identified the fix**: `kh8` (the per-window utilization store) IS updated unconditionally by `hR4` inside `pF1`. The data is always fresh — the problem is that nobody reads it when `BF1` is suppressed. The fix: inject a stdout write right after `pF1(U1.headers)` in the stream loop (`XiK`), reading `LR4()` (= `kh8`) directly.

7. **Verified the injection point**: `if(U1)pF1(U1.headers),k8=U1.headers` appears exactly once in cli.js and runs after every successful streaming API call.

### 2.1.261 re-anchor (chunked bundle)

8. **Failure**: `apply.mjs` aborted with _"Cannot locate the header utilization getter in
   either shape"_ — both the 2.1.231 class shape and the ≤2.1.220 module-var shape missed.

9. **The literals still existed**: `rg -c rawUtilization` → 21 hits,
   `rg -c extractQuotaStatusFromHeaders` → 3. So the feature was intact and only the
   _shapes_ had moved. Never conclude "removed upstream" from a failing regex when the
   property names are still there.

10. **Two independent shape changes**, both found by printing ±400 chars around the literals:
    - the getter gained a filter wrapper: `function SL(){return eEn(QS.rawUtilization)}`
      (was `function lCn(){return bne.rawUtilization}`);
    - the ingest wrapper gained a 6th param:
      `function Iot(e,t,r=!1,o=Date.now(),d,f){…}` (was 5). The old regex pinned the arity
      literally, so it could never match. **Fixed by matching the param list generically** —
      arity has changed in 4 consecutive versions and pinning it is a recurring trap.

11. **Third change, found only by running the fixed script**: with the getter and ingest fn
    resolved, the _call site_ regex still missed. Diffing the region showed upstream had
    inserted `Iar(Sp.headers,f,Zw)` between the ingest call and `Lb=Sp.headers` — so the
    anchor's two halves were no longer adjacent. Fixed with a bounded run of intervening
    sibling calls (`(?:,fn(...)){0,8}`), keeping the whole thing a single unique match.

12. **New hazard class — chunk scope.** The 2.1.261 concat is 1,631 independent ES modules.
    A call emitted into a chunk that doesn't bind the callee parses fine and fails at
    runtime, which no syntax check catches. `apply.mjs` now indexes the chunk delimiters and
    resolves the getter's local binding name at the injection site, aborting if unreachable.
    In 2.1.261 both sites are in `chunk-9c0rs7w4.js`, so the emitted call is plain `SL()` —
    but that was verified, not assumed.

13. **Verified the patched output by hand**: sliced `chunk-9c0rs7w4.js` out of the concat,
    `node --check`ed it as ESM (passes), and confirmed by grep that `SL` has exactly one
    declaration in that chunk (no shadowing) and that the injection sits ~440 chars after
    `tengu_streaming_stall_summary`, i.e. in the stream loop and not the interceptor path.

## Version Progression

| What changed             | v2.1.97                             | v2.1.197                      | v2.1.231                           | v2.1.261                                                            |
| ------------------------ | ----------------------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| Bundle shape             | one CJS bundle                      | one CJS bundle                | one CJS bundle                     | **1,631 ESM chunks**, concatenated with `// @bun-chunk` delimiters  |
| State storage            | module var `kh8`                    | module var `n5e`              | class field `bne.rawUtilization`   | class field `QS.rawUtilization` (class `Xwn`)                       |
| Getter                   | `LR4(){return kh8}`                 | `r5e(){return n5e}`           | `lCn(){return bne.rawUtilization}` | `SL(){return eEn(QS.rawUtilization)}` — **filters expired windows** |
| Ingest fn arity          | 1 (`(q)`)                           | 4 (`(e,t,n=!1,r=Date.now())`) | 5 (`…,o`)                          | 6 (`(e,t,r=!1,o=Date.now(),d,f)`) → apply.mjs stopped pinning arity |
| Windows tracked          | 5h, 7d                              | 5h, 7d                        | + overage                          | 5h, 7d, 7d_oi, overage                                              |
| Comma chain at call site | `pF1(…),k8=…`                       | `pF1(…,args),Je=…`            | `EDu(…),pF1(…),…=…` (prepend)      | `Gie(…),rEn(…),Iot(…),Iar(…),Lb=…` (**prepend + append**)           |
| Patch injection shape    | trailing `,process.stdout.write(…)` | same                          | same                               | same, plus a chunk-scope check on the emitted getter name           |

## Key Functions Reference (v2.1.261, all in `chunk-9c0rs7w4.js`)

| Name                                     | Purpose                                                                      | Char offset         |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `class Xwn`                              | Rate limit state: `currentLimits`, `rawUtilization`, `lastSeenWindows`, …    | ~7109819            |
| `var QS = new Xwn`                       | The module singleton every wrapper delegates to                              | ~7118949            |
| `SL()`                                   | Getter the patch calls → `eEn(QS.rawUtilization)`                            | ~7119002            |
| `eEn(e)` / `g6(e)`                       | Validity filter / finite-fields predicate                                    | ~7119261 / ~7103340 |
| `qdn()`                                  | **Not** the one we want — `lastSeenWindows` within a 30-min staleness budget | ~7119062            |
| `Dwn(e)`                                 | Header parser → `{ <window>: { utilization, resets_at } }`                   | ~7103022            |
| `var YPe`                                | Window list `[["five_hour","5h"],…]` — the durable string anchor             | ~7102913            |
| `Iot(e,t,r,o,d,f)`                       | Header-ingest wrapper (our anchor) → `QS.extractQuotaStatusFromHeaders`      | ~7119828            |
| `QS.extractQuotaStatusFromHeaders`       | The ingest itself: scope check → parse → record → maybe emit                 | ~7112475            |
| `KPe(e,t)`                               | Unified status parser → `{ status, resetsAt, rateLimitType, … }`             | ~7104843            |
| `QS.emitStatusChange(e)`                 | Broadcaster + `tengu_claudeai_limits_status_changed` telemetry               | ~7111113            |
| `Qs`                                     | Deep equality gating the broadcast (imported into this chunk)                | —                   |
| stream loop injection site               | Unnamed async generator; `let Sp=zs;if(Sp)…,Lb=Sp.headers`                   | ~9506089            |
| non-streaming ingest call (do not patch) | `if(ke)Iot(ke,t.model,…)` — headers passed directly, no trailing assignment  | ~9441894            |

**Note:** All minified names will change in future SDK versions, and offsets shift with any
upstream edit. Use content patterns (property names, string literals, structural shapes) to
relocate code — the offsets above are only a sanity check that you're in the right region.

### How to re-find the ingest fn when names change

It is uniquely identified by being the **module-level function whose entire body is a call
to `<singleton>.extractQuotaStatusFromHeaders(…)`**, where `<singleton>` is the same
variable the utilization getter reads. Binding both to one singleton is what keeps them from
drifting apart across versions.

```bash
# 1. Getter + singleton (property name survives minification):
bundle-analyzer.cmd find vendor/claude-cli/cli.js "rawUtilization" --compact
# 2. The wrapper that delegates to the singleton's ingest method:
bundle-analyzer.cmd find vendor/claude-cli/cli.js "extractQuotaStatusFromHeaders" --compact
# 3. The call site is the one where arg 1 is `<var>.headers` AND the comma chain ends
#    `,<hdr>=<var>.headers`. The other call site passes a bare headers object.
```

Pre-2.1.231 bundles have no class: there the ingest fn is the function that resets the store
var to `{}` inside its scope guard, and it reaches `"anthropic-ratelimit-unified-status"`
through the status parser. `apply.mjs` keeps that shape as a fallback.

## Related Patches

- **`patch/usage-relay/`** — Relays the CLI's `/api/oauth/usage` endpoint through SDK control messages. Provides the full usage breakdown (5hr, 7-day, 7-day-sonnet, extra*usage) but requires an API call. This `rate-limit-relay` patch provides real-time updates \_between* those API polls, using data that arrives for free with inference response headers.

## Files

| File        | Purpose                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `README.md` | This document                                                                                         |
| `apply.mjs` | Patch script — single injection; extracts the getter + ingest fn names and the getter's chunk binding |
| `test.mjs`  | Behavioural test — needs a rebundled binary and live credentials                                      |
