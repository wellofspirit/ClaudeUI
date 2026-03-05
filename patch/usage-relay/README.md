# Patch: usage-relay

Relays the CLI's internal `/usage` API call through the SDK control message protocol, eliminating 429 rate-limit errors when the UI fetches account usage data independently.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file + `sdk.mjs` wrapper.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.63 |
| Bundled CLI (`cli.js`) | 2.1.63 |

The SDK bundles its own CLI, independent of the native `claude` binary.

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
async function k9q(){
  if(!Y7())return{};           // Not OAuth user → empty object
  let A=z4();                   // Get token state
  if(A&&KB(A.expiresAt))return null;  // Token expired → null
  let q=u_();                   // Get auth headers
  if(q.error)throw Error(`Auth error: ${q.error}`);
  let K={
    "Content-Type":"application/json","User-Agent":jO(),...q.headers
  },Y=`${r7().BASE_API_URL}/api/oauth/usage`;
  return(await g8.get(Y,{headers:K,timeout:5000})).data
}
```

### Auth helper (`u_` in v2.1.63)

```js
function u_(){
  if(Y7()){                     // OAuth path
    let q=z4();
    if(!q?.accessToken)return{headers:{},error:"No OAuth token available"};
    return{headers:{Authorization:`Bearer ${q.accessToken}`,"anthropic-beta":BZ}};
  }
  let A=fk();                   // API key path
  if(!A)return{headers:{},error:"No API key available"};
  return{headers:{"x-api-key":A}};
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
  "extra_usage": { ... }
}
```

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

| Variable | Source | Value |
|---|---|---|
| `r` | Message loop iteration variable | Current control_request message |
| `t` | Success response helper | Writes `{type:"control_response",response:{subtype:"success",...}}` to stdout |
| `O6` | Error response helper | Writes `{type:"control_response",response:{subtype:"error",...}}` to stdout |
| `k9q` | Usage fetcher function | Calls `GET /api/oauth/usage` with managed auth |
| `Z6` | (injected local) | Result from `k9q()` |
| `S6` | (injected local) | Caught error |

## The Patches

### Part A: `get_usage` control request handler (cli.js)

**Marker**: `/*PATCHED:usage-relay*/`

#### Anchor (unique, 1 match)

The "Unsupported control request subtype" fallback in the main message loop:

```
else <errorFn>(<msgVar>,`Unsupported control request subtype: ${<msgVar>.request.subtype}`);continue}else if(<msgVar>.type==="control_response")
```

This is the same anchor used by `queue-control` and `background-task` patches. All three inject `else if` branches before the fallback `else`.

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
// Look backwards for: async function <name>(){
const lookback = src.slice(Math.max(0, usageUrlIdx - 500), usageUrlIdx)
const fnDeclRe = /async function ([\w$]+)\(\)\{/g
// Take the last (closest) match
```

The error/success helpers and message variable are extracted from the anchor regex itself (same technique as `queue-control` and `background-task`).

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

### Usage fetcher function (`k9q`)
```bash
bundle-analyzer find cli.js "api/oauth/usage" --compact
```
Only 1 match in the entire bundle. The enclosing function is the usage fetcher.

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

This patch is simple enough that no syntax traps were encountered. The injection is a straightforward `else if` block with try/catch, matching the existing `background_task` and `queue-control` patterns.

**Always run `node --check cli.js` after applying patches.**

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
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches coexist
5. `node patch/usage-relay/test.mjs` — test harness passes
6. Manual: Start ClaudeUI, verify usage data appears without 429 errors in logs

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

## Key Functions Reference

| Name (v2.1.63) | Purpose | Char offset |
|---|---|---|
| `k9q` | Usage fetcher — `GET /api/oauth/usage` with managed auth | ~9356877 |
| `u_` | Auth header builder (OAuth Bearer / API key) | ~4004237 |
| `Y7` | isOAuthUser check (verifies scopes) | ~10766610 |
| `z4` | Get cached OAuth token state | variable |
| `KB` | Token expiry check | — |
| `jO` | getUserAgent (`claude-code/<version>`) | — |
| `r7` | Config getter (BASE_API_URL, CLIENT_ID, etc.) | — |
| `g8` | Axios-like HTTP client | — |
| `y9q` | React component — `/usage` display UI | ~9358975 |
| `L9q` | React component — individual rate limit bar | ~9357231 |
| `t` | Success control_response helper | extracted dynamically |
| `O6` | Error control_response helper | extracted dynamically |

**Note:** All minified names will change in future SDK versions. Use
content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- `patch/queue-control/` — Uses the same injection anchor (Unsupported control request subtype fallback) and the same `stopTask` anchor in sdk.mjs. Apply order doesn't matter.
- `patch/background-task/` — Also injects at the same anchor. The `usage-relay` injection appears after `background-task` in the `else if` chain.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script (Part A: cli.js, Part B: sdk.mjs) |
| `test.mjs` | Test harness (verifies getUsage() returns data) |
