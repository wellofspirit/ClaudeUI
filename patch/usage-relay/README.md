# Patch: usage-relay

Relays the CLI's internal `/usage` API call through the SDK control message protocol, eliminating 429 rate-limit errors when the UI fetches account usage data independently.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file + `sdk.mjs` wrapper.

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| SDK package            | 0.2.63                       |
| Bundled CLI (`cli.js`) | 2.1.63                       |
| Last re-anchored       | 2.1.261                      |

The SDK bundles its own CLI, independent of the native `claude` binary.

> **2.1.261 is a code-split bundle.** `vendor/claude-cli/cli.js` is the
> concatenation of ~1,631 minified ESM chunks, each preceded by
> `// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js`. The usage fetcher lives in a
> **different chunk** from the dispatch loop this patch injects into, and that
> chunk does not import it — so a bare `SD()` call would apply clean and throw
> `ReferenceError` on the first `get_usage` request. See §"v2.1.261 changes".

## The Problem

The UI needs to display account usage (5-hour session limits, 7-day weekly limits, Sonnet limits, extra usage). Previously, it made independent HTTP requests to `GET https://api.anthropic.com/api/oauth/usage` every 2 minutes using credentials read from `~/.claude/.credentials.json`.

This caused **429 Too Many Requests** errors because:

1. The API rate-limits by OAuth token, and the UI's requests compete with the CLI's own usage checks
2. The UI sent `User-Agent: ClaudeUI` instead of the CLI's `claude-code/2.1.63`, which the API may filter on
3. Polling every 2 minutes accumulated ~30 requests/hour per session on the same token

Meanwhile, the CLI's internal `/usage` command works flawlessly because it:

- Uses the CLI's managed OAuth session (token refresh handled internally)
- Sends the correct `User-Agent` header via `jO()` (e.g., `claude-code/2.1.63`)
- Only calls on-demand (when the user explicitly runs `/usage`)

## Architecture Overview

### CLI's usage fetcher (`k9q` in v2.1.63)

```
k9q()
  ├── Y7() → isOAuthUser check (verifies scopes)
  ├── z4() → get cached OAuth token state
  ├── KB(expiresAt) → check if token expired
  ├── u_() → build auth headers
  │     ├── OAuth: { Authorization: "Bearer <token>", "anthropic-beta": BZ }
  │     └── API key: { "x-api-key": <key> }
  ├── jO() → getUserAgent ("claude-code/2.1.63")
  ├── r7().BASE_API_URL → config base URL ("https://api.anthropic.com")
  └── g8.get(url, { headers, timeout: 5000 }) → axios GET
        └── returns .data (raw API response)
```

### Full function (v2.1.63)

```js
async function k9q() {
  if (!Y7()) return {} // Not OAuth user → empty object
  let A = z4() // Get token state
  if (A && KB(A.expiresAt)) return null // Token expired → null
  let q = u_() // Get auth headers
  if (q.error) throw Error(`Auth error: ${q.error}`)
  let K = {
      'Content-Type': 'application/json',
      'User-Agent': jO(),
      ...q.headers
    },
    Y = `${r7().BASE_API_URL}/api/oauth/usage`
  return (await g8.get(Y, { headers: K, timeout: 5000 })).data
}
```

### Auth helper (`u_` in v2.1.63)

```js
function u_() {
  if (Y7()) {
    // OAuth path
    let q = z4()
    if (!q?.accessToken) return { headers: {}, error: 'No OAuth token available' }
    return { headers: { Authorization: `Bearer ${q.accessToken}`, 'anthropic-beta': BZ } }
  }
  let A = fk() // API key path
  if (!A) return { headers: {}, error: 'No API key available' }
  return { headers: { 'x-api-key': A } }
}
```

### API response shape

```json
{
  "five_hour": {
    "utilization": 0.15,
    "resets_at": "2026-03-05T18:00:00Z",
    "is_throttled": false
  },
  "seven_day": {
    "utilization": 0.42,
    "resets_at": "2026-03-10T00:00:00Z",
    "is_throttled": false
  },
  "seven_day_sonnet": {
    "utilization": 0.30,
    "resets_at": "2026-03-10T00:00:00Z"
  },
  "limits": [
    { "kind": "session", "group": "session", "percent": 39, "resets_at": "...", "scope": null },
    { "kind": "weekly_all", "group": "weekly", "percent": 18, "resets_at": "...", "scope": null },
    {
      "kind": "weekly_scoped",
      "group": "weekly",
      "percent": 32,
      "resets_at": "...",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }
    }
  ],
  "extra_usage": { ... }
}
```

`limits[]` generalizes the per-window keys; `percent` is 0-100 like `utilization`.
ClaudeUI parses the `weekly_scoped` entries (the only place a weekly per-model
bucket appears once `seven_day_opus` / `seven_day_sonnet` go null) into one
sidebar bar each, labelled from the server's `scope.model.display_name`.

For non-subscription accounts (API key auth), `k9q` returns `{}` (empty object).
For expired tokens, it returns `null`.

### Control message flow (after patch)

```
UI calls query.getUsage()
  → sdk.mjs: this.request({subtype:"get_usage"})
    → writes control_request JSON to cli.js stdin
      → cli.js message loop reads control_request
        → subtype==="get_usage" branch
          → calls k9q() (internal usage fetcher)
          → successFn(msg, result) writes control_response to stdout
    ← sdk.mjs resolves Promise with response data
  ← UI receives { five_hour, seven_day, ... }
```

### Variable mapping (injection site)

| Variable | Source                          | Value                                                                         |
| -------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `r`      | Message loop iteration variable | Current control_request message                                               |
| `t`      | Success response helper         | Writes `{type:"control_response",response:{subtype:"success",...}}` to stdout |
| `O6`     | Error response helper           | Writes `{type:"control_response",response:{subtype:"error",...}}` to stdout   |
| `k9q`    | Usage fetcher function          | Calls `GET /api/oauth/usage` with managed auth                                |
| `Z6`     | (injected local)                | Result from `k9q()`                                                           |
| `S6`     | (injected local)                | Caught error                                                                  |

Same table for 2.1.261 (injection chunk is `chunk-gj501zgt.js`):

| Variable       | Origin                                                                   | Reaches the injection site as                           |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `r` (msgVar)   | local to the dispatch loop                                               | itself                                                  |
| `Xe` (success) | local to the dispatch loop                                               | itself                                                  |
| `Be` (error)   | local to the dispatch loop                                               | itself                                                  |
| `SD` (fetcher) | `chunk-9c0rs7w4.js`, exported but **NOT** imported by the dispatch chunk | `(await import("B:/~BUN/root/chunk-9c0rs7w4.js")).SD()` |

## The Patches

### Part A: `get_usage` control request handler (cli.js)

**Marker**: `/*PATCHED:usage-relay*/`

#### Anchor (unique, 1 match)

The "Unsupported control request subtype" fallback in the main message loop:

```
// ≤2.1.241
else <errorFn>(<msgVar>,`Unsupported control request subtype: ${<msgVar>.request.subtype}`)
// 2.1.261 — the interpolation gained a sanitizer wrapper
else <errorFn>(<msgVar>,`Unsupported control request subtype: ${<san>(String(<msgVar>.request.subtype))}`)
```

This is the same anchor used by `queue-control`, `background-task`, and `voice-server` patches. All inject `else if` branches before the fallback `else`.

Version notes:

- ≤ v2.1.207 the fallback tail was ``...subtype}`);continue}else if(<msgVar>.type==="control_response")`` and the anchor regex included it.
- v2.1.219 wrapped the dispatch chain in `try{...}finally{...}` (the tail became ``...subtype}`)}finally{...}continue}...``), so the anchor is now matched tail-less — still globally unique.
- v2.1.219 also introduced a **second**, class-based dispatcher (`async processControlRequest(e,t)` ending in `throw Error("Unsupported control request subtype: "+e.request.subtype)`). That one serves the SDK `Query` transport, NOT the stream-json stdin loop ClaudeUI drives — do not anchor there. The correct loop is recognizable by its tail `else if(<msgVar>.type==="control_response"){if(<opts>.replayUserMessages)...`.
- v2.1.261 added `${<san>(String(…))}` around the interpolated subtype. `anchorRe` admits both forms. It also brought two more decoys (`RemoteSessionManager` and the device-hooks `default:` case), for four in total — the discriminator remains that only the stdin loop's is `else <fn>(<msgVar>,` **with the same `<msgVar>` backreferenced inside the template**.

#### Before

```js
// (end of background_task handler)
}
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`);
```

#### After

```js
// (end of background_task handler)
}
/*PATCHED:usage-relay*/else if(r.request.subtype==="get_usage"){
  try{
    let Z6=await k9q();
    t(r,Z6??{})
  }catch(S6){
    O6(r,S6 instanceof Error?S6.message:String(S6))
  }
}
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`);
```

As actually built on 2.1.261 (auth-error branch included, cross-chunk fetcher
call, `Xe`/`Be` reply helpers):

```js
/*PATCHED:usage-relay*/else if(r.request.subtype==="get_usage"){
  try{
    let Z6=await (await import("B:/~BUN/root/chunk-9c0rs7w4.js")).SD();
    Xe(r,Z6??{})
  }catch(S6){
    let X6=S6 instanceof Error?S6.message:String(S6);
    if(typeof X6==="string"&&X6.indexOf("Auth error:")===0){Xe(r,{})}else{Be(r,X6)}
  }
}
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
```

#### Why it's safe

- `k9q()` is a pure read-only function — no side effects, no state mutation
- Returns `{}` for non-OAuth users, `null` for expired tokens (we coalesce with `??{}`)
- 5-second internal timeout prevents blocking the message loop indefinitely
- Errors are caught and returned as `control_response` error subtypes
- No Zod schema validation on the response — the success helper passes the raw object through `x.record(x.string(), x.unknown()).optional()`

#### Dynamic function extraction

The usage fetcher function name is extracted by searching backwards from the unique `api/oauth/usage` string:

```js
const usageUrlIdx = src.indexOf('api/oauth/usage')
// Look backwards for: async function <name>(…){
const lookback = src.slice(Math.max(0, usageUrlIdx - 500), usageUrlIdx)
const fnDeclRe = /async function ([\w$]+)\([^)\n]{0,120}\)\{/g
// Take the last (closest) match; keep its offset — it is the input to the
// chunk-scope resolution below.
```

The parameter list is now matched loosely rather than as "empty or one
identifier": ≤2.1.231 the fetcher took none, 2.1.241 took `credentials`, and
2.1.261 takes `(e,{atWall:t=!1}={})`. Both params default, so the patch's
zero-arg call keeps its original meaning (ambient credentials, plain
`/api/oauth/usage` rather than the `?at_wall=1&skip_spend=1` variant).

The error/success helpers and message variable are extracted from the anchor regex itself (same technique as `queue-control` and `background-task`).

#### Chunk-scope resolution (2.1.261+)

Finding the fetcher's name is no longer enough — it has to be a **binding at the
injection point**. `resolveCall()` in `apply.mjs`:

1. If the fetcher and the anchor are in the same chunk (or the file has no
   chunk delimiters at all — a pre-split monolith) → emit a plain `SD()` call.
2. Otherwise read the defining chunk's `export{…}` clause for the published
   name, then scan the **injection chunk's** `import{…}from"<defining chunk>"`
   for it → emit the local alias.
3. If the injection chunk does not import it → emit
   `(await import("<defining chunk>")).<exported>()`, the form the bundle
   itself uses in this very chunk (`await import("B:/~BUN/root/chunk-wdwcp2mj.js")`
   in the `workflow_launch` branch).
4. If the defining chunk does not export it at all → **abort loudly**.

On 2.1.261 this lands on case 3: `chunk-9c0rs7w4.js` exports `SD`, and
`chunk-gj501zgt.js` imports ~1,149 bindings from 178 chunks — but not that one.

### Part B: `getUsage()` method on query (sdk.mjs)

**Marker**: `/*PATCHED:usage-relay-sdk*/`

#### Anchor

```
async stopTask(<var>){await this.request({subtype:"stop_task",task_id:<var>})}
```

#### Injection (after stopTask)

```js
/*PATCHED:usage-relay-sdk*/async getUsage(){return(await this.request({subtype:"get_usage"})).response}
```

This uses `this.request()` which:

1. Generates a unique `request_id`
2. Writes `{type:"control_request", request_id, request:{subtype:"get_usage"}}` to stdin
3. Returns a Promise that resolves when the matching `control_response` arrives
4. The resolved value is `{subtype:"success", request_id:"...", response:{...}}` — the full envelope
5. `.response` unwraps to the inner data (e.g., `{five_hour:{...}, seven_day:{...}}`)

Note: `this.request()` returns the full control_response envelope. Methods like `initialize()` and `rewindFiles()` also unwrap with `.response`. Without the unwrap, consumers would see `{subtype, request_id, response}` instead of the actual usage data.

## How to Find This Code

### Usage fetcher function (`k9q` → `t5e` → `SD`)

```bash
bundle-analyzer find cli.js "api/oauth/usage" --compact
# or, tool-free:
rg -o '.{300}api/oauth/usage.{200}' vendor/claude-cli/cli.js
```

1 match ≤2.1.231; 2 adjacent matches since 2.1.241 (2.1.261: the plain path and
the `?at_wall=1&skip_spend=1` variant, both in the same ternary). The clustering
check in `apply.mjs` (all occurrences within 500 chars) is what guarantees they
are still one function. The enclosing function is the usage fetcher.

Then find which chunk it lives in, and whether the dispatch chunk can see it:

```bash
node -e 'const s=require("fs").readFileSync("vendor/claude-cli/cli.js","utf8");
const i=s.indexOf("api/oauth/usage"), b=s.lastIndexOf("// @bun-chunk",i);
console.log("fetcher chunk:", s.slice(b, s.indexOf("\n",b)));
const d=s.indexOf("// @bun-chunk B:/~BUN/root/chunk-gj501zgt.js");
const e=s.indexOf("// @bun-chunk", d+1);
console.log("imported by dispatch chunk?",
  [...s.slice(d,e).matchAll(/import\{([^}]*)\}from"([^"]+)"/g)]
    .some(m => m[2].includes("9c0rs7w4") && /(^|,)SD(,|$)/.test(m[1])))'
```

### Auth helper (`u_`)

```bash
bundle-analyzer find cli.js "No OAuth token available" --compact
```

### OAuth check (`Y7`)

```bash
bundle-analyzer find cli.js "function Y7()" --compact
# Or by content:
bundle-analyzer find cli.js "if(!PJ())return!1;return qB" --compact
```

### Control-request fallback (injection point)

```bash
bundle-analyzer find cli.js "Unsupported control request subtype" --compact
```

Multiple matches — the one in the main message loop (the `async()=>` function near char ~11337000) is the correct target.

### Usage display component (`y9q` — for reference)

```bash
bundle-analyzer find cli.js "Loading usage data" --compact
bundle-analyzer find cli.js "/usage is only available for subscription plans" --compact
```

### Config base URL (`r7`)

```bash
bundle-analyzer find cli.js "BASE_API_URL" --compact
```

## Syntax Pitfalls

The injection is a straightforward `else if` block with try/catch, matching the existing `background_task` and `queue-control` patterns — no comma-expression or ASI traps.

### Pitfall (2.1.261+): `node --check` cannot validate the concat

The patch target is a concatenation of ESM chunks; `node --check cli.js` on the
whole file is meaningless because it is not one valid module. Extract the chunk
you edited and check that:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("vendor/claude-cli/cli.js","utf8");
const i=s.indexOf("// @bun-chunk B:/~BUN/root/chunk-gj501zgt.js");
const j=s.indexOf("// @bun-chunk", i+1);
fs.writeFileSync("/tmp/c.mjs", s.slice(s.indexOf("\n",i)+1, j))'
node --check /tmp/c.mjs
```

### Pitfall (2.1.261+): the `await import(…)` needs an async enclosing scope

The dynamic-import call form only works because the dispatch handler is inside
an `async` function — the neighbouring native handlers already `await` (e.g.
`let e=await xi(T,ie,{distrust:!0})` in the rewind branch), and the injected
code lives in the same `try{…}`. If a future bundle makes this dispatch
synchronous, the resolution must move to a static import instead.

**Always syntax-check the modified chunk after applying patches.**

## What's NOT Changed

**The CLI's `/usage` command** — Still renders its own React UI (`y9q`) when the user runs `/usage` in the terminal. This patch adds a parallel SDK-accessible path, not a replacement.

**Token management** — The CLI continues to manage its own OAuth tokens. The UI no longer needs to read `~/.claude/.credentials.json` or refresh tokens independently.

**Rate limiting** — The API's rate limits still apply. The difference is that requests now go through the CLI's managed session with the correct User-Agent, which is the expected usage pattern. The UI should still poll at reasonable intervals (30s–2min).

**Error handling** — `k9q()` can return `{}` (non-OAuth), `null` (expired token), or throw (auth error / network failure). All cases are handled:

- `null` → coalesced to `{}` via `??{}`
- `{}` → returned as-is (consumer checks for `five_hour` field presence)
- throw → caught and returned as `control_response` error

## Consumer-Side Integration

### Before (direct API call)

```
UsageFetcher.fetch()
  → readCredentials() from ~/.claude/.credentials.json / Keychain
  → refreshToken() if expired
  → fetch("https://api.anthropic.com/api/oauth/usage", { headers })
  → parseResponse()
  → pushToRenderer('usage:data', AccountUsage)
```

### After (via SDK)

```
ClaudeSession has active query (q)
  → q.getUsage()                          // control_request → cli.js → k9q() → control_response
  → returns { five_hour, seven_day, ... }  // raw API response
  → parseResponse()                        // same parsing as before
  → pushToRenderer('usage:data', AccountUsage)
```

The `UsageFetcher` class can be simplified to remove:

- `readCredentials()` / `readCredentialsFromFile()` / `readCredentialsFromKeychain()`
- `refreshToken()`
- Direct `fetch()` calls
- All retry logic (the CLI handles its own 5s timeout)

It becomes a thin wrapper that calls `session.getUsage()` on a timer and parses the response.

## Verification

1. `node patch/usage-relay/apply.mjs` — should apply both patches
2. Run again — should report "already applied" (idempotent)
3. **Check the apply log's `Call expression:` line** — it must name a binding
   the injection chunk can actually see (a plain name, or an
   `(await import("chunk-….js")).<name>` form)
4. Syntax-check the modified chunk (see Syntax Pitfalls) — the whole-file
   `node --check` is not a valid test on a chunked bundle
5. `node patch/apply-all.mjs` — all patches coexist
6. `node patch/usage-relay/test.mjs` — test harness passes
7. Manual: Start ClaudeUI, verify usage data appears without 429 errors in logs

## Discovery Method

1. **Observed the symptom**: UI's usage fetcher getting 429 Too Many Requests from `GET /api/oauth/usage`, while the CLI's `/usage` command worked fine.

2. **Found the CLI's implementation**: `bundle-analyzer find cli.js "api/oauth/usage"` → found `k9q()` at char 9356877. Single match, easy to locate.

3. **Compared headers**: CLI sends `User-Agent: claude-code/2.1.63` via `jO()`, UI sends `User-Agent: ClaudeUI`. CLI uses `u_()` for auth headers which includes the `anthropic-beta` header. The API likely rate-limits or filters by User-Agent.

4. **Considered alternatives**:
   - Mimicking the CLI's User-Agent → would work but feels fragile and deceptive
   - Reducing poll frequency → would help but not eliminate the issue
   - Using the CLI's internal function via control message → cleanest solution, no credential management needed

5. **Chose control message approach**: Modeled after `queue-control` and `background-task` patches — add `else if` branch at the "Unsupported control request subtype" fallback, expose via `sdk.mjs` method.

6. **First attempt failed**: Regex `async function (${V})\\(\\)\\{[^}]*api/oauth/usage` didn't match because the function body contains `}` characters (object literals). Fixed by searching for the string index first, then scanning backwards for the enclosing function declaration.

7. **2.1.241 re-anchor**: the fetcher grew an optional credentials parameter and a telemetry wrapper — `async function t5e(e){return mp("api_usage_fetch",async()=>{…_s.get("/api/oauth/usage",{…,refreshOAuth:!0,credentials:e})…})}`. The backward-scan declaration regex was widened to `async function (V)\((?:V)?\)\{` (parameter optional). The patch's zero-arg call is still correct: the API client treats a nullish per-request `credentials` as "resolve from ambient config" (client ctor: `let l=i.credentials??null;if(l)…else if(i.config!=null)…`), which is exactly what the old zero-arg fetcher did. Note `api/oauth/usage` now appears twice (a debug log line + the `_s.get` call), both inside the same fetcher — the existing clustering check covers this.

### v2.1.261 changes

8. **Symptom**: `ERROR: Cannot locate control-request fallback anchor.` — shared
   with `queue-control` and `background-task`, which anchor on the same
   fallback. Cause: `${r.request.subtype}` became
   `${Xn(String(r.request.subtype))}`. Widening the interpolation to an
   alternation restored a single unique match.

9. **The fetcher signature moved again**:

   ```js
   async function SD(e,{atWall:t=!1}={}){return br(t?"api_usage_fetch_at_wall":"api_usage_fetch",
     async()=>{ …let r=t?"/api/oauth/usage?at_wall=1&skip_spend=1":"/api/oauth/usage"… })}
   ```

   The 2.1.241 regex (`\((?:V)?\)`) could not match a destructured second
   parameter. Widened to `\([^)\n]{0,120}\)`. Both parameters default, so the
   zero-arg call still means "ambient credentials, plain endpoint".

10. **The real trap: the fetcher is in another chunk, and the dispatch chunk
    does not import it.** 2.1.261 is code-split. `SD` is defined and exported in
    `chunk-9c0rs7w4.js`; the control-request dispatch is in
    `chunk-gj501zgt.js`. Emitting `await SD()` there would have applied clean,
    passed every syntax check, and thrown `ReferenceError: SD is not defined`
    the first time the UI polled usage — a failure only a live session shows.

    Three options were considered:
    - _Add `SD` to the dispatch chunk's existing static import from
      `chunk-9c0rs7w4.js`_ — works, but edits a second site and risks a
      name collision inside a 346 KB chunk.
    - _Call through some already-imported wrapper_ — none exists; every `SD`
      caller is in a different chunk again.
    - **Dynamic import** — self-contained, no second edit site, no collision
      risk, and already used by upstream code **inside this very chunk**
      (`let{handleWorkflowLaunchEvent:kt}=await import("B:/~BUN/root/chunk-wdwcp2mj.js")`
      in the `workflow_launch` branch). Chosen.

    Beware the mirror-image mistake: `SD` is _also_ a local function name in
    `chunk-r705mjp8.js` (`return U4.toolPermissionContext.mode`) and
    `chunk-bab5vngb.js` (a React cursor setter). Resolving by name globally
    rather than by chunk would happily pick one of those.

11. **Verified** by reading the patched bytes, extracting `chunk-gj501zgt.js`
    from the concat and `node --check`ing it, and re-running the whole ordered
    patch chain from pristine.

## Key Functions Reference

| Name (v2.1.63) | Purpose                                                  | Char offset           |
| -------------- | -------------------------------------------------------- | --------------------- |
| `k9q`          | Usage fetcher — `GET /api/oauth/usage` with managed auth | ~9356877              |
| `u_`           | Auth header builder (OAuth Bearer / API key)             | ~4004237              |
| `Y7`           | isOAuthUser check (verifies scopes)                      | ~10766610             |
| `z4`           | Get cached OAuth token state                             | variable              |
| `KB`           | Token expiry check                                       | —                     |
| `jO`           | getUserAgent (`claude-code/<version>`)                   | —                     |
| `r7`           | Config getter (BASE_API_URL, CLIENT_ID, etc.)            | —                     |
| `g8`           | Axios-like HTTP client                                   | —                     |
| `y9q`          | React component — `/usage` display UI                    | ~9358975              |
| `L9q`          | React component — individual rate limit bar              | ~9357231              |
| `t`            | Success control_response helper                          | extracted dynamically |
| `O6`           | Error control_response helper                            | extracted dynamically |

Names as of v2.1.261 (all in `chunk-9c0rs7w4.js` unless noted):

| Name | Purpose                                                             | Chunk               |
| ---- | ------------------------------------------------------------------- | ------------------- |
| `SD` | Usage fetcher — `br("api_usage_fetch", …)` → `GET /api/oauth/usage` | `chunk-9c0rs7w4.js` |
| `Xe` | Success control_response helper (`wt.enqueue(A5(id,data))`)         | `chunk-gj501zgt.js` |
| `Be` | Error control_response helper (`wt.enqueue(_B(id,err))`)            | `chunk-gj501zgt.js` |
| `r`  | Control message loop variable                                       | `chunk-gj501zgt.js` |
| `Xn` | Subtype sanitizer in the fallback template (imported)               | `chunk-gj501zgt.js` |

**Note:** All minified names will change in future SDK versions. Use
content patterns (string literals, structural shapes) to relocate code — **and
on a chunked bundle, resolve the name into the chunk you are editing before
injecting a call to it.**

## Related Patches

- `patch/queue-control/` — Uses the same injection anchor (Unsupported control request subtype fallback) and the same `stopTask` anchor in sdk.mjs. Apply order doesn't matter.
- `patch/background-task/` — Also injects at the same anchor. The `usage-relay` injection appears after `background-task` in the `else if` chain.

## Files

| File        | Purpose                                         |
| ----------- | ----------------------------------------------- |
| `README.md` | This document                                   |
| `apply.mjs` | Patch script (Part A: cli.js, Part B: sdk.mjs)  |
| `test.mjs`  | Test harness (verifies getUsage() returns data) |
