# Patch: mcp-status

Fixes `mcp_status` returning an empty/incomplete server list in SDK/headless mode — locally configured MCP servers (from `--mcp-config`, user/project config) are missing from the reported status.

## Affected Component

`@anthropic-ai/claude-code` — rebundled `cli.js` (extracted from the Bun standalone binary).

| Component            | Version               |
| -------------------- | --------------------- |
| At time of discovery | bundled CLI `2.1.87`  |
| Last re-anchored     | bundled CLI `2.1.241` |

The CLI is spawned natively (Bun binary), independent of any native `claude` install. This patch operates on the wrapped CJS bytes in `vendor/claude-cli/cli.js`.

## The Problem

**Symptom:** In SDK/headless mode, `mcpServerStatus()` (the `mcp_status` control response) returns an empty or partial array — typically only cloud-configured servers (claude.ai proxy), missing every server declared via `--mcp-config` or user/project config.

**Root cause (two compounding issues):**

1. **Servers never loaded.** MCP servers from config sources are connected by a headless refresh function (the one whose body logs `"Headless MCP refresh"`). In headless/bare mode that refresh is gated and may never run before the `mcp_status` control request is answered, so the appState has no local servers to report.

2. **Plugin refresh is fire-and-forget.** When `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is unset, the plugin-install/refresh runs detached and its promise is discarded, so the handler has no awaitable to block on before reading status.

## Architecture Overview

The relevant code lives in the main run-loop function. Two sites matter:

```
run-loop fn
  ├─ startup: if(!T1()) if(<cachedEnv>.CLAUDE_CODE_SYNC_PLUGIN_INSTALL){ ...sync...  M_=(async()=>{...})() }
  │                                                                else  k_=ux4(T_)   ← Part A site
  │   T_  = plugin-install/refresh fn (calls the headless MCP refresh OH internally)
  │   ux4 = fire-and-forget wrapper: ux4(H){ let _={needsRefresh:!1}; return H().then(q=>{_.needsRefresh=q}).catch(...), _ }
  │   M_  = awaitable orchestration promise (only assigned in the sync branch)
  │   k_  = non-awaitable {needsRefresh} object (only assigned in the else branch)
  │
  └─ control loop: ...subtype==="mcp_status") bH(__,{mcpServers:K_()});             ← Part B site
       OH = "Headless MCP refresh" fn — loads all configured servers into appState
       K_ = serializer that reads current server state for the response
```

**Variable mapping (v2.1.163 — names WILL change):**

| Var                  | Role                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `<cachedEnv>` (`R_`) | cached `process.env` reference; access is `R_.CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, **not** `process.env....`                       |
| `M_`                 | awaitable orchestration promise (sync branch) — also consumed by an existing `if(M_){await M_;M_=null}` join before MCP prewait |
| `k_`                 | fire-and-forget wrapper result (else branch)                                                                                    |
| `ux4`                | the fire-and-forget wrapper function                                                                                            |
| `T_`                 | plugin refresh fn; internally `await OH(...)`                                                                                   |
| `OH`                 | the Headless MCP refresh fn (Part B calls it)                                                                                   |
| `K_`                 | reads current MCP server state for the response                                                                                 |
| `bH`                 | control-response responder                                                                                                      |

## The Patches

### Part A — make the plugin refresh awaitable in the else branch

**Marker:** `/*PATCHED:mcp-status-store-promise*/`

The sync branch already stores an awaitable in `M_`. The else branch only stores the non-awaitable `k_`. We rewrite the else branch to start the refresh **once**, expose its promise as `M_` (the same var Part B awaits and the existing join consumes), and hand the wrapper a thunk so it reuses that promise instead of invoking `T_` a second time.

**Before (v2.1.163):**

```js
else k_=ux4(T_);
```

**After:**

```js
/*PATCHED:mcp-status-store-promise*/else{let _cuMcpRef=T_();M_=_cuMcpRef;k_=ux4(()=>_cuMcpRef);}
```

**Why it's safe:**

- `T_` is started exactly once. `ux4(()=>_cuMcpRef)` calls its arg, which returns the already-started promise — no double refresh.
- `M_` was previously `undefined` in this branch; the only reader is `if(M_){let nK=performance.now();await M_,M_=null,L5("registry_refresh_join_ms",...)}` (a pre-MCP-prewait join). Setting `M_` here just makes that join also wait for the plugin refresh — the desired behavior — then nulls it.
- `_cuMcpRef` is block-scoped inside the new `else{}`, so it cannot collide.

> **Historical shapes** (all still handled by `apply.mjs` as fallbacks):
>
> - `<=0.2.105`: `z6=null;if(!Y9())if(S6(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))z6=V6();else V6()` → `z6=null;if(!Y9())z6=V6()`
> - `0.2.112+`: sync stores `V6=W6(...)`, else stores `f6=$X5(W6)` → patch the else to also set the promise var
> - `2.1.144`: `...INSTALL))...TH=A8(...);else mH=Mq4(A8)` → else also sets the promise var
> - `2.1.163`: env access moved `process.env.` → cached `R_.`; sync branch awaitable is an IIFE in `M_`; else branch is `k_=ux4(T_)` (see above)

### Part B — load all servers before answering `mcp_status`

**Marker:** `/*PATCHED:mcp-status-await-refresh*/`

Before responding, call the Headless MCP refresh fn (loads all configured servers into appState), then await the plugin promise if present.

**Before:**

```js
...request.subtype==="mcp_status")bH(__,{mcpServers:K_()});
```

**After:**

```js
.../*PATCHED:mcp-status-await-refresh*/request.subtype==="mcp_status"){await OH();if(M_)await M_;bH(__,{mcpServers:K_()})}
```

`OH()` is called with no args — safe in 2.1.163 because its body uses `S6?.has(...)` (optional-chained previous-server set) and `caller:G6` (undefined tolerated). The serialized reconcile inside `OH` (`FH=FH.then(...)`) dedupes concurrent calls.

> **The refresh fn name is minified and changes every version** (`s` @0.2.87, `R6` @0.2.97, `OH` @2.1.163). `apply.mjs` extracts it by finding the `"Headless MCP refresh"` string literal and searching **backward** for the nearest `async function <name>(...)`. Hardcoding the name makes the handler call `undefined`, silently breaking the control response and hanging the UI.

> **Backward-window gotcha (added 2.1.163):** the enclosing `async function OH(...)` declaration sits ~540 chars before the `"Headless MCP refresh"` string (its body grew). The original 500-char search window missed it; the window is now **2000**. The last-match-wins logic still resolves to the function that _contains_ the string (no nested `async function` sits between the declaration and the string).

## How to Find This Code

```bash
# Part A site — the conditional. `INSTALL){` (closing-if-paren + block-open) is
# unique; other hits are _TIMEOUT_MS, )return, ||, )L_=, )TT().
bundle-analyzer find cli.js "CLAUDE_CODE_SYNC_PLUGIN_INSTALL" --compact

# Part B handler
bundle-analyzer find cli.js "mcp_status" --compact

# Headless MCP refresh fn (name changes; find by the log string, walk backward)
bundle-analyzer find cli.js "Headless MCP refresh" --compact
```

## Stable anchors

- Part A: `.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)\{` — the `)\{` (if-close + block-open) disambiguates from the timeout/return/`||` variants. Note the env object prefix is now a cached ref, **not** `process.env`.
- Part B: `"mcp_status"` string literal in the control-request handler.
- Headless refresh fn: `"Headless MCP refresh"` log message inside the body (name minified; search backward).

## What's NOT Changed

- The sync branch (`M_=(async()=>{...})()`) is left intact — it already produced an awaitable.
- `K_()` (the state reader) and the response shape `{mcpServers:[...]}` are unchanged.
- `ux4`'s contract (returns `{needsRefresh}`) is preserved — we only change the argument it's handed.

## Verification

1. `node patch/mcp-status/apply.mjs` — Part A + Part B apply.
2. Run again — both report "Already applied".
3. `node patch/apply-all.mjs` — syntax check (`node --check`) passes.
4. `node patch/mcp-status/test.mjs` — behavioral harness (7/7): spawns the rebundled binary with `--mcp-config`, sends an `mcp_status` control request, asserts the configured server appears in the response.

Always run `node --check cli.js` after applying.

## Discovery Method (2.1.163 re-anchor)

1. **Apply failed** with `Cannot locate SYNC_PLUGIN_INSTALL pattern (tried old and new)`.
2. **Found via bundle-analyzer** that the env access changed from `process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` to a cached `R_.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` — so every prior regex anchored on `process.env.` missed.
3. **Disambiguated** the 5 `R_.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` hits: only the run-loop conditional is `INSTALL){`; the rest are `_TIMEOUT_MS`, `)return`, `||`, `)L_=`, `)TT()`.
4. **Inspected the block:** sync branch now stores the awaitable in an IIFE `M_`; else branch is `k_=ux4(T_)` where `ux4` is a fire-and-forget wrapper.
5. **First instinct (rejected):** `else{M_=T_();k_=ux4(T_);}` — but that invokes `T_` twice. Checked whether `T_` is serialized; the inner reconcile is, but the plugin-install step isn't guaranteed to be. Switched to the thunk form `k_=ux4(()=>tmp)` so `T_` runs exactly once.
6. **Verified `M_` readers** before reusing it: the only consumer is the `if(M_){await M_;M_=null}` pre-prewait join — awaiting the plugin refresh there is correct, not harmful.
7. **Hit a second failure in Part B:** the `async function OH(` declaration is 540 chars before `"Headless MCP refresh"`, outside the 500-char backward window. Widened to 2000.
8. **Confirmed** `OH()` with no args is safe (`S6?.has`, `caller:G6` undefined-tolerant).
9. **Behavioral test passed 7/7** against the rebundled binary.

## Discovery Method (2.1.241 re-anchor — the cross-site capture bug)

**This one APPLIED cleanly and then broke every session at boot** — the exact applies-but-misbinds failure class the live harness exists for. Read this before ever writing another unbounded `[\s\S]*?` anchor.

1. **Symptom**: every `test:patch` harness failed with `result subtype=error_during_execution`; the binary died at boot (duration 0, pre-API) with `l is not a function. (In 'l()', 'l' is an instance of Promise)`. Reproduced with `printf '' | bun-claude.exe -p hi --output-format stream-json` — no auth needed.
2. **Bisected** by applying patches one at a time (rebundle + boot probe with `ANTHROPIC_BASE_URL=http://127.0.0.1:1` so a healthy boot fails fast with a connection error instead of hanging in API retries). First breaking patch: mcp-status.
3. **Root cause**: 2.1.241 has THREE `CLAUDE_CODE_SYNC_PLUGIN_INSTALL){` sites (was effectively one qualifying). The old single-regex v163 anchor — `INSTALL){ [\s\S]*? (V)=(async()=>{ [\s\S]*? })()}else (V)=(V)((V));` — anchored `.exec` at the FIRST site (~char 7.5M), captured an unrelated `l=(async()=>{` a megabyte later as the "promise var", then lazily spanned **~18MB** to the real else-branch at ~26.46M. The else-rewrite then emitted `l=<promise>` at a site where `l` is the **appState getter**, consumed two expressions later as `If=l().mcp.clients.length`. Unbounded lazy spans don't fail loudly — they match *something*.
4. **Fix (structural, not another rung)**: find else-branch candidates `})()}else (V)=(V)((V));` globally, then require within a **bounded 2500-char back-window**: the `INSTALL){` anchor AND the last `(V)=(async()=>{` assign (that capture is the promise var — `$l` in 2.1.241). Extra guard: the captured promise var must appear as `await <var>` in a 20k forward window (the `if(M){await M;M=null}` join Part B relies on); refuse the capture loudly otherwise. Multiple qualifying sites abort.
5. **Verified**: patched else now reads `$l=_cuMcpRef` (was `l=`); boot probe prints a clean `init`; live suite green.

| Name (v2.1.163) | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `OH`            | Headless MCP refresh — loads all configured servers (Part B calls it) |
| `T_`            | plugin install/refresh; calls `OH` internally                         |
| `ux4`           | fire-and-forget wrapper returning `{needsRefresh}`                    |
| `K_`            | reads current MCP server state for the response                       |
| `bH`            | control-response responder                                            |

**Note:** all minified names change between versions. Relocate by string literals / structural shape.

## MCP control request subtypes reference

| Subtype            | Purpose                          | Response                         |
| ------------------ | -------------------------------- | -------------------------------- |
| `mcp_status`       | Get all server statuses          | `{mcpServers: [...]}`            |
| `mcp_set_servers`  | Add/remove dynamic servers       | `{added, removed, errors}`       |
| `mcp_reconnect`    | Reconnect a named server         | success/error                    |
| `mcp_toggle`       | Enable/disable a named server    | success/error                    |
| `mcp_authenticate` | Start OAuth for SSE/HTTP server  | `{authUrl?, requiresUserAction}` |
| `mcp_clear_auth`   | Clear OAuth credentials          | success/error                    |
| `mcp_message`      | Forward message to MCP transport | success                          |

## Files

| File        | Purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `README.md` | This document                                           |
| `apply.mjs` | Patch script (Part A + Part B, multi-version fallbacks) |
| `test.mjs`  | Behavioral harness                                      |
