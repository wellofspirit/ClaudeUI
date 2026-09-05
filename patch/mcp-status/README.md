# Patch: mcp-status

Fixes `mcp_status` returning an empty/incomplete server list in SDK/headless mode — locally configured MCP servers (from `--mcp-config`, user/project config) are missing from the reported status.

## Affected Component

`@anthropic-ai/claude-code` — rebundled `cli.js` (extracted from the Bun standalone binary).

| Component            | Version                         |
| -------------------- | ------------------------------- |
| At time of discovery | bundled CLI `2.1.87`            |
| Last re-anchored     | bundled CLI `2.1.261` (chunked) |

The CLI is spawned natively (Bun binary), independent of any native `claude` install. This patch operates on `vendor/claude-cli/cli.js`.

## The Problem

**Symptom:** In SDK/headless mode, `mcpServerStatus()` (the `mcp_status` control response) returns an empty or partial array — typically only cloud-configured servers (claude.ai proxy), missing every server declared via `--mcp-config` or user/project config.

**Root cause (two compounding issues):**

1. **Servers never loaded.** MCP servers from config sources are connected by a headless refresh function (the one whose body logs `"Headless MCP refresh"`). In headless/bare mode that refresh is gated and may never run before the `mcp_status` control request is answered, so the appState has no local servers to report.

2. **Plugin refresh is fire-and-forget.** When `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is unset, the plugin-install/refresh runs detached and its promise is discarded, so the handler has no awaitable to block on before reading status.

---

## 2.1.261: the bundle is now 1,631 chunks — read this first

2.1.241 and earlier were ONE monolithic minified CJS bundle. 2.1.261 is a **code-split ESM build**: `vendor/claude-cli/cli.js` is the **concatenation of 1,631 chunks**, each preceded by a delimiter line

```
// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
```

Chunk bodies are verbatim (one huge minified line each, always ending `\n`). Consequences that dominate this patch:

- **Every chunk is its own module scope.** A minified name captured in chunk X means nothing in chunk Y. Both names this patch injects — the headless refresh fn and the plugin-refresh promise var — must be captured **in the same chunk as the injection site**, or the patched branch dies with a `ReferenceError` the first time an `mcp_status` request arrives.
- **Similar code repeats across chunks with different local names.** `"mcp_status"` now appears at **6** places in the concat (was effectively 1 patchable one). Regexes must assert multiplicity, and the site must be chosen by _role_, not by "first match".
- Never write a `[\s\S]*?` span wide enough to bridge a delimiter line. Where a span is needed, exclude `\n` (chunk bodies are single-line) and clamp windows to the enclosing chunk.

`apply.mjs` has helpers for this: `chunkStartAt` / `chunkEndAt` / `chunkNameAt` / `sameChunk`. Every window it searches is clamped to the enclosing chunk, and Part B **hard-fails** if the refresh fn or Part A's promise var landed in a different chunk from the handler.

### Which of the 6 `"mcp_status"` sites is ours

| Offset (2.1.261) | Chunk                   | What it is                                                                                                                                                            | Patch it? |
| ---------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 2378240          | `chunk-nhm4zepz.js`     | Zod schema — `c({subtype:R("mcp_status")}).describe(...)`                                                                                                             | no        |
| 3443284          | `chunk-xvt49yqn.js`     | membership `Set` of subtypes still served while shutting down                                                                                                         | no        |
| 3451207          | `chunk-xvt49yqn.js`     | **`[bridge:repl]`** handler in `cnr(e,t)` — `case"mcp_status":` calling the `onMcpStatus:ke` callback. Serves the **interactive REPL bridge**, not stdin stream-json. | no        |
| 13684937         | `chunk-hz1hp2fa.js`     | cloud-session admission switch (`case"mcp_status":` falls through to "allowed")                                                                                       | no        |
| 20819943         | `chunk-4keb08gw.js`     | SDK **client** helper `async mcpServerStatus(){ ... this.request({subtype:"mcp_status"}) }` — the requester                                                           | no        |
| **22969364**     | **`chunk-gj501zgt.js`** | **`else if(r.request.subtype==="mcp_status")Xe(r,{mcpServers:g_n(e,Hd())});`** — the print.ts headless run loop                                                       | **YES**   |

How `chunk-gj501zgt.js` was proven to be the live stream-json path:

- It carries 40 `[print.ts]` log strings (`print.ts` is the headless entrypoint).
- The responder is `let Xe=function(f,M){wt.enqueue(A5(f.request_id,M))}` and `wt=t.outbound` — `t` is the stream-json output writer that also emits `t.write({type:"system",subtype:"plugin_install",...})` when `v.outputFormat==="stream-json"`.
- Part A's site (`CLAUDE_CODE_SYNC_PLUGIN_INSTALL`), the `"Headless MCP refresh"` fn and the handler are all in this one chunk, inside the same run-loop closure.
- The `[bridge:repl]` handler is a _different_ implementation: it destructures `{transport,sessionId,onMcpStatus:ke,...}` from an options object and returns only `{name,status}` per server. ClaudeUI never reaches it.

---

## Architecture Overview

The relevant code lives in the print.ts run-loop function inside **one** chunk. Two sites matter:

```
chunk-gj501zgt.js  (print.ts headless run loop)
  ├─ startup: if(!uo()) if(<cachedEnv>.CLAUDE_CODE_SYNC_PLUGIN_INSTALL){ ...sync... Is=(async()=>{...})() }
  │                                                                else  Vi=D_(qd)   ← Part A site
  │   qd  = plugin-install/refresh fn (calls the headless MCP refresh xs internally)
  │   D_  = fire-and-forget wrapper: D_(e){ let t={needsRefresh:!1}; return e().then(o=>{t.needsRefresh=o}).catch(h), t }
  │   Is  = awaitable orchestration promise (only assigned in the sync branch)
  │   Vi  = non-awaitable {needsRefresh} object (only assigned in the else branch)
  │
  └─ control loop: ...subtype==="mcp_status") Xe(r,{mcpServers:g_n(e,Hd())});          ← Part B site
       xs  = "Headless MCP refresh" fn — loads all configured servers into appState
       Hd  = serializer that reads current server state
       g_n = imported redaction wrapper (see below)
       Xe  = control-response responder (enqueues onto the outbound stream-json writer)
```

**Variable mapping (v2.1.261 — names WILL change; roles won't):**

| Var (2.1.261)       | Role                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `a` (`<cachedEnv>`) | cached env object imported from `chunk-tn5tgwb1.js`; access is `a.CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, **not** `process.env....`    |
| `Is`                | awaitable orchestration promise (sync branch) — also consumed by the existing `if(Is){await Is;Is=null}` join before MCP prewait |
| `Vi`                | fire-and-forget wrapper result (else branch)                                                                                     |
| `D_`                | the fire-and-forget wrapper function                                                                                             |
| `qd`                | plugin install/refresh fn; internally `await xs(...)`                                                                            |
| `xs`                | the Headless MCP refresh fn (Part B calls it) — `async function xs(f,M)`                                                         |
| `Hd`                | reads current MCP server state for the response                                                                                  |
| `g_n`               | imported from `chunk-518jdnfm.js`; **redacts** the payload for restricted sessions                                               |
| `Xe`                | control-response responder                                                                                                       |
| `r`                 | the control-request message in the dispatch chain                                                                                |
| `e`                 | the session object                                                                                                               |

### `g_n` — why the payload is re-emitted verbatim (new in 2.1.261)

```js
function Ov(r) {
  return ser() && Mv.of(r).transportPersists !== !1
}
function g_n(r, e) {
  if (!Ov(r)) return e
  return e.map((t) => ({ name: t.name, status: t.status }))
}
```

`g_n(session, servers)` is a privacy filter: for a restricted/cloud-hosted transport it strips every server down to `{name,status}`; for a local session it returns `Hd()` untouched (full shape, tools included). 2.1.241 had a bare `{mcpServers:K_()}` here.

`apply.mjs` therefore **captures the whole `{mcpServers:…}` payload expression as a group and re-emits it byte-for-byte** rather than reconstructing it from a function name. The patch stays agnostic to the serializer's arity and to future wrappers like `g_n`, and the redaction behaviour is preserved exactly.

## The Patches

### Part A — make the plugin refresh awaitable in the else branch

**Marker:** `/*PATCHED:mcp-status-store-promise*/`

The sync branch already stores an awaitable in `Is`. The else branch only stores the non-awaitable `Vi`. We rewrite the else branch to start the refresh **once**, expose its promise as `Is` (the same var Part B awaits and the existing join consumes), and hand the wrapper a thunk so it reuses that promise instead of invoking `qd` a second time.

**Anchor (unique, 1 match bundle-wide in 2.1.261):**

```
})()}else Vi=D_(qd);
```

`apply.mjs` does not trust that shape alone. For each `})()}else X=Y(Z);` candidate it requires, **within a 2500-char back-window clamped to the enclosing chunk**:

- a `<V>.CLAUDE_CODE_SYNC_PLUGIN_INSTALL){` anchor, and
- at least one `<V>=(async()=>{` assign — the **last** one is the promise var;

then, **within a 20k forward window clamped to the same chunk**, an `await <promiseVar>` (the join Part B relies on). Multiple qualifying sites abort. The final rewrite additionally asserts the byte offset it is about to splice equals the offset the finder qualified.

**Before (v2.1.261):**

```js
else Vi=D_(qd);
```

**After:**

```js
/*PATCHED:mcp-status-store-promise*/else{let _cuMcpRef=qd();Is=_cuMcpRef;Vi=D_(()=>_cuMcpRef);}
```

Live patched bytes (2.1.261, char 22919015):

```js
...})()}/*PATCHED:mcp-status-store-promise*/else{let _cuMcpRef=qd();Is=_cuMcpRef;Vi=D_(()=>_cuMcpRef);}Xo?.sync("startup");let{deadlineMs:Kd,localOnly:Gd}=gy(v),...
```

**Why it's safe:**

- `qd` is started exactly once. `D_(()=>_cuMcpRef)` calls its arg, which returns the already-started promise — no double refresh, and `D_`'s `{needsRefresh}` contract is untouched.
- `Is` was previously `undefined` in this branch. Its only readers in 2.1.261 are `if(Is)await Is}` (end of the sync install path) and `if(at){if(at=!1,Is){let _e=performance.now();await Is,Is=null,Es("registry_refresh_join_ms",...)}}` (the pre-MCP-prewait join). Setting `Is` here just makes that join also wait for the plugin refresh — the desired behavior — then nulls it. Verified there is exactly one `Is` binding in the chunk (`let Jo=null,Is=null,…`), so it is not shadowed at either site.
- `_cuMcpRef` is block-scoped inside the new `else{}`, so it cannot collide.

> **Historical shapes** (all still handled by `apply.mjs` as fallbacks):
>
> - `<=0.2.105`: `z6=null;if(!Y9())if(S6(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))z6=V6();else V6()` → `z6=null;if(!Y9())z6=V6()`
> - `0.2.112+`: sync stores `V6=W6(...)`, else stores `f6=$X5(W6)` → patch the else to also set the promise var
> - `2.1.144`: `...INSTALL))...TH=A8(...);else mH=Mq4(A8)` → else also sets the promise var
> - `2.1.163`: env access moved `process.env.` → cached `R_.`; sync branch awaitable is an IIFE in `M_`; else branch is `k_=ux4(T_)`
> - `2.1.241`: same shape; three `INSTALL){` sites appeared → the single-regex form misbound (see Discovery Method)
> - `2.1.261`: same shape, chunked bundle; still three `INSTALL){` sites, exactly one `})()}else X=Y(Z);` candidate

### Part B — load all servers before answering `mcp_status`

**Marker:** `/*PATCHED:mcp-status-await-refresh*/`

Before responding, call the Headless MCP refresh fn (loads all configured servers into appState), then await the plugin promise if present.

**Anchor (unique, 1 match):**

```
r.request.subtype==="mcp_status")Xe(r,{mcpServers:g_n(e,Hd())});
```

matched by

```js
new RegExp(
  `(${V})\\.request\\.subtype==="mcp_status"\\)(${V})\\(\\1,(\\{mcpServers:[^;\\n]{1,300}\\})\\);`
)
```

Group 3 is the payload, re-emitted verbatim. The `[^;\n]` class is bounded and newline-free, so the span can neither run past the statement nor bridge a `// @bun-chunk` delimiter. This one regex subsumes the pre-2.1.261 `{mcpServers:K_()}` shape, so no alternation is needed.

**Before:**

```js
...else if(r.request.subtype==="mcp_status")Xe(r,{mcpServers:g_n(e,Hd())});else if(r.request.subtype==="get_binary_version")...
```

**After (live patched bytes, 2.1.261, char 22969448):**

```js
...}}else if(/*PATCHED:mcp-status-await-refresh*/r.request.subtype==="mcp_status"){await xs();if(Is)await Is;Xe(r,{mcpServers:g_n(e,Hd())})}else if(r.request.subtype==="get_binary_version")...
```

**Why it's safe:**

- `xs()` with no args is safe: the body uses `f?.has(q)` (optional-chained previous-server set) and passes `caller:M` straight through to telemetry, where `undefined` is tolerated.
- The reconcile inside `xs` goes through `Nd(...)`, which ends with `return Go=Go.then(de,de),Go` — a serialized promise chain, so concurrent `xs()` calls queue rather than race.
- The enclosing dispatch chain is already `async` — the sibling `set_cwd` branch does `await import(...)` and `await xs(_e,"set_cwd")` ~850 chars earlier. That sibling call is also the strongest evidence `xs` is in scope at the handler.
- Converting the statement branch to a block keeps the `else if` chain intact; the response call and payload are unchanged.

> **The refresh fn name is minified and changes every version** (`s` @0.2.87, `R6` @0.2.97, `OH` @2.1.163, `xs` @2.1.261). `apply.mjs` extracts it by finding the `"Headless MCP refresh"` string literal (asserted unique) and searching **backward** for the nearest `async function <name>(...)`. Hardcoding the name makes the handler call `undefined`, silently breaking the control response and hanging the UI.

> **Backward-window gotcha:** the enclosing `async function` declaration sits well before the log string (~540 chars @2.1.163, ~766 chars @2.1.261). The original 500-char window missed it; the window is **2000**, and since 2.1.261 it is also clamped to the enclosing chunk. Last-match-wins still resolves to the function that _contains_ the string (no nested `async function` sits between the declaration and the string; the two decls that precede it in-window, `Gi` and `Qd`, are farther back).

## How to Find This Code

`bundle-analyzer` still works on the concat (it is plain text search + function extraction), but it may not resolve inside a scratch worktree. Plain `rg` / small node scripts work everywhere and are what the 2.1.261 re-anchor actually used.

```bash
# Part A site — the conditional. `INSTALL){` (closing-if-paren + block-open) narrows
# 13 raw hits to 3; only one of those 3 has a `})()}else X=Y(Z);` after it.
bundle-analyzer.cmd find vendor/claude-cli/cli.js "CLAUDE_CODE_SYNC_PLUGIN_INSTALL" --compact
rg -o '.{40}CLAUDE_CODE_SYNC_PLUGIN_INSTALL\)\{' vendor/claude-cli/cli.js

# Part A candidate shape (expect exactly 1)
rg -c '\}\)\(\)\}else [\w$]+=[\w$]+\([\w$]+\);' vendor/claude-cli/cli.js

# Part B handler — 6 hits; the patchable one is the `.request.subtype===` + responder form
bundle-analyzer.cmd find vendor/claude-cli/cli.js "mcp_status" --compact
rg -o '[\w$]+\.request\.subtype==="mcp_status"\).{0,80}' vendor/claude-cli/cli.js

# Headless MCP refresh fn (name changes; find by the log string, walk backward)
bundle-analyzer.cmd find vendor/claude-cli/cli.js "Headless MCP refresh" --compact
rg -o '.{60}Headless MCP refresh' vendor/claude-cli/cli.js
```

Chunk-aware navigation (2.1.261+) — build a chunk index and map an offset to its chunk:

```js
// node -e / small .mjs helper
const src = require('fs').readFileSync('vendor/claude-cli/cli.js', 'utf-8')
const chunks = []
for (const m of src.matchAll(/^\/\/ @bun-chunk (.+)$/gm))
  chunks.push({ name: m[1], start: m.index })
chunks.forEach((c, i) => (c.end = i + 1 < chunks.length ? chunks[i + 1].start : src.length))
// then binary-search `start` to find the chunk containing any offset
```

To syntax-check just the edited chunk (much faster than the whole concat, and `node --check` handles the ESM chunk when written with an `.mjs` extension):

```bash
# slice out chunk-gj501zgt.js into /tmp/c.mjs with the helper above, then
node --check /tmp/c.mjs
```

## Stable anchors

- Part A: `.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)\{` — the `)\{` (if-close + block-open) disambiguates from the timeout/return/`||` variants. The env object prefix is a cached ref, **not** `process.env`.
- Part A shape: `})()}else <V>=<V>(<V>);` — plus the back-window/forward-window qualification described above.
- Part B: `<V>.request.subtype==="mcp_status")<V>(<same>,{mcpServers:…});` in the print.ts dispatch chain.
- Headless refresh fn: `"Headless MCP refresh"` log message inside the body (name minified; search backward).

## Syntax Pitfalls

### Pitfall: `String.replace(needle, replacementString)` eats `$`

Minified identifiers can contain `$` (`V = '[\\w$]+'` — 2.1.241's promise var was literally `$l`). In a **replacement string**, `$&`, `` $` ``, `$'`, `$1`…`$9` and `$$` are substitution patterns, so a captured name or payload containing them is silently corrupted.

```js
// WRONG — the replacement string is interpreted
src = src.replace(oldMcp, newMcp)

// CORRECT — offset splice
src = src.slice(0, idx) + newMcp + src.slice(idx + oldMcp.length)
```

All three rewrite sites in `apply.mjs` now splice by offset.

### Pitfall: statement branch → block

`else if(cond)stmt;` becomes `else if(cond){...;stmt}`. Dropping the trailing `;` inside the new block is fine, but the `}` must replace it — leaving both (`...});}`) inserts an empty statement into the `else if` chain and detaches the following `else`.

### Pitfall: unbounded `[\s\S]*?` spans

They never fail loudly — they match _something_, a megabyte away, in another chunk. This exact failure class shipped once (see Discovery Method 2.1.241). Bound every span, exclude `\n`, clamp to the chunk.

Always run `node --check` on the edited chunk (and `node patch/apply-all.mjs`, which syntax-checks the whole file) after applying.

## What's NOT Changed

- The sync branch (`Is=(async()=>{...})()`) is left intact — it already produced an awaitable.
- `Hd()` (the state reader), `g_n` (the redaction wrapper) and the response shape `{mcpServers:[...]}` are unchanged — the payload expression is re-emitted verbatim.
- `D_`'s contract (returns `{needsRefresh}`) is preserved — only the argument it is handed changes.
- The `[bridge:repl]` `mcp_status` handler in `chunk-xvt49yqn.js` is deliberately **not** patched: it serves the interactive REPL bridge, returns a `{name,status}`-only shape, and is never on ClaudeUI's stdin stream-json path.
- The SDK-client requester (`async mcpServerStatus()` in `chunk-4keb08gw.js`) is untouched — it is the caller, not the handler.

## Verification

1. `node patch/mcp-status/apply.mjs` — Part A + Part B apply against a pristine `vendor/claude-cli/cli.js`.
2. Run again — both report "Already applied".
3. `node patch/apply-all.mjs` — full-file syntax check passes.
4. `node patch/mcp-status/test.mjs` — behavioral harness (7/7): spawns the rebundled binary with `--mcp-config`, sends an `mcp_status` control request, asserts the configured server appears in the response **connected and with tools**. (The tools assertion depends on `g_n` not redacting — true for local sessions, where `Ov(session)` is false.)

Expected 2.1.261 apply output:

```
Found v163 pattern at char 22919010 (chunk B:/~BUN/root/chunk-gj501zgt.js)
  Promise variable: Is
  Fire-forget variable: Vi
  Wrapper function: D_
  Refresh function: qd
  Headless MCP refresh function: xs (at char 22919848)
Found mcp_status handler (inline form) at char 22969448 (chunk B:/~BUN/root/chunk-gj501zgt.js)
  Status payload: {mcpServers:g_n(e,Hd())}
  Scope check OK: refresh fn, Part A promise var and handler all in B:/~BUN/root/chunk-gj501zgt.js
```

Sanity check that only the intended chunk moved: diff the patched concat against pristine chunk-by-chunk — exactly **1 of 1631** chunks should differ (`chunk-gj501zgt.js`, +143 bytes), and the delimiter count must be unchanged.

## Discovery Method (2.1.163 re-anchor)

1. **Apply failed** with `Cannot locate SYNC_PLUGIN_INSTALL pattern (tried old and new)`.
2. **Found via bundle-analyzer** that the env access changed from `process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` to a cached `R_.CLAUDE_CODE_SYNC_PLUGIN_INSTALL` — so every prior regex anchored on `process.env.` missed.
3. **Disambiguated** the 5 hits: only the run-loop conditional is `INSTALL){`; the rest are `_TIMEOUT_MS`, `)return`, `||`, `)L_=`, `)TT()`.
4. **Inspected the block:** sync branch stores the awaitable in an IIFE `M_`; else branch is `k_=ux4(T_)` where `ux4` is a fire-and-forget wrapper.
5. **First instinct (rejected):** `else{M_=T_();k_=ux4(T_);}` — invokes `T_` twice. Switched to the thunk form `k_=ux4(()=>tmp)` so `T_` runs exactly once.
6. **Verified `M_` readers** before reusing it: the only consumer is the `if(M_){await M_;M_=null}` pre-prewait join.
7. **Second failure in Part B:** the `async function OH(` declaration is 540 chars before `"Headless MCP refresh"`, outside the 500-char backward window. Widened to 2000.
8. **Confirmed** `OH()` with no args is safe (`S6?.has`, `caller:G6` undefined-tolerant).
9. **Behavioral test passed 7/7.**

## Discovery Method (2.1.241 re-anchor — the cross-site capture bug)

**This one APPLIED cleanly and then broke every session at boot** — the exact applies-but-misbinds failure class the live harness exists for. Read this before ever writing another unbounded `[\s\S]*?` anchor.

1. **Symptom**: every `test:patch` harness failed with `result subtype=error_during_execution`; the binary died at boot (duration 0, pre-API) with `l is not a function. (In 'l()', 'l' is an instance of Promise)`. Reproduced with `printf '' | bun-claude.exe -p hi --output-format stream-json` — no auth needed.
2. **Bisected** by applying patches one at a time (rebundle + boot probe with `ANTHROPIC_BASE_URL=http://127.0.0.1:1` so a healthy boot fails fast with a connection error instead of hanging in API retries). First breaking patch: mcp-status.
3. **Root cause**: 2.1.241 has THREE `CLAUDE_CODE_SYNC_PLUGIN_INSTALL){` sites (was effectively one qualifying). The old single-regex v163 anchor — `INSTALL){ [\s\S]*? (V)=(async()=>{ [\s\S]*? })()}else (V)=(V)((V));` — anchored `.exec` at the FIRST site (~char 7.5M), captured an unrelated `l=(async()=>{` a megabyte later as the "promise var", then lazily spanned **~18MB** to the real else-branch at ~26.46M. The else-rewrite then emitted `l=<promise>` at a site where `l` is the **appState getter**, consumed two expressions later as `If=l().mcp.clients.length`. Unbounded lazy spans don't fail loudly — they match _something_.
4. **Fix (structural, not another rung)**: find else-branch candidates `})()}else (V)=(V)((V));` globally, then require within a **bounded 2500-char back-window**: the `INSTALL){` anchor AND the last `(V)=(async()=>{` assign. Extra guard: the captured promise var must appear as `await <var>` in a 20k forward window; refuse the capture loudly otherwise. Multiple qualifying sites abort.
5. **Verified**: patched else read `$l=_cuMcpRef` (was `l=`); boot probe printed a clean `init`; live suite green.

## Discovery Method (2.1.261 re-anchor — the chunked bundle)

1. **Apply failed** at Part B only: `ERROR: Cannot locate mcp_status handler pattern.` Part A applied unchanged — the 2.1.241 structural finder survived the split intact.
2. **Indexed the concat by chunk** (1,631 `// @bun-chunk` delimiters) so every hit could be attributed to a module. This is the first thing to do on any 2.1.261+ re-anchor; nothing else about the site choice makes sense without it.
3. **Enumerated all 6 `"mcp_status"` hits** and classified each by role (table above). Two were plausible handlers. Resolved by reading the enclosing functions: `cnr(e,t)` destructures `{transport,sessionId,onMcpStatus:ke,…}` and logs `[bridge:repl]` — the interactive bridge; the `chunk-gj501zgt.js` site is inside the run loop that carries 40 `[print.ts]` strings and whose responder feeds `wt=t.outbound`. Picked the latter.
4. **Root cause of the Part B miss**: the payload shape changed from `{mcpServers:K_()}` to `{mcpServers:g_n(e,Hd())}` — a two-arg imported serializer. The old regex hardcoded `\{mcpServers:(V)\(\)\}` (nullary).
5. **Rejected** re-hardcoding the new arity. Instead captured the whole `{mcpServers:…}` expression with a bounded newline-free class and re-emit it verbatim, so a third shape change costs nothing. Checked `g_n` first to be sure re-emitting it verbatim was semantically correct (it is: a redaction wrapper, `Ov(session)` false for local sessions).
6. **Added chunk-scope guards** — the specific new hazard of a split bundle. Part B now hard-fails if the refresh fn or Part A's promise var is in a different chunk from the handler, and every search window is clamped to the enclosing chunk. Verified by doctoring a copy with an injected `// @bun-chunk` delimiter between `xs` and the handler: the patch aborts with `… are in DIFFERENT chunks — xs is not in scope at the handler.`
7. **Verified multiplicity guards** by cloning the handler fragment into another chunk: `ERROR: mcp_status inline pattern matched multiple times. Aborting.`
8. **Verified scope by construction, not distance**: `xs` is called from a sibling branch of the same dispatch chain (`await xs(_e,"set_cwd")`, 845 chars earlier), and the chunk has exactly one `Is` binding, so neither injected name is shadowed. The old 50k-char "scope check" heuristic was replaced by the same-chunk assertion plus this call-proximity warning.
9. **Found a latent bug while rewriting**: `src.replace(oldMcp, newMcp)` — a `$`-bearing capture in the replacement string is a substitution pattern. `$l` was literally 2.1.241's promise var. All three rewrite sites now splice by offset.
10. **Verified the output**: single chunk changed (1/1631, +143 bytes), delimiter count unchanged, `node --check` clean on the edited chunk (and on the pristine chunk as a baseline).

## Key Functions Reference

| Name (v2.1.261) | Purpose                                                               | Char offset |
| --------------- | --------------------------------------------------------------------- | ----------- |
| `xs`            | Headless MCP refresh — loads all configured servers (Part B calls it) | 22919768    |
| `qd`            | plugin install/refresh; calls `xs` internally                         | 22917392    |
| `D_`            | fire-and-forget wrapper returning `{needsRefresh}`                    | 22852430    |
| `Hd`            | reads current MCP server state for the response                       | 22916053    |
| `g_n`           | redaction wrapper around the server list (imported)                   | 4399046     |
| `Nd`            | serialized MCP reconcile (`Go=Go.then(...)`)                          | 22912985    |
| `Xe`            | control-response responder (`wt.enqueue(A5(...))`)                    | 22949354    |
| `Is`            | plugin-refresh promise var                                            | 22917927    |

**Note:** all minified names and offsets change between versions. Relocate by string literals / structural shape, then confirm the chunk.

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

## Related Patches

- `patch/mcp-tool-refresh/` — keeps the tool list fresh across turns; complements this patch, which is about the _status_ response. Both live in the same run-loop chunk.
- `patch/queue-control/` — injects into the tail of the same control-request dispatch chain (anchored on the `Unsupported control request subtype` fallback, which sits after the `mcp_status` branch). The two patches do not overlap textually; apply order between them is irrelevant.

## Files

| File        | Purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `README.md` | This document                                           |
| `apply.mjs` | Patch script (Part A + Part B, multi-version fallbacks) |
| `test.mjs`  | Behavioral harness                                      |
