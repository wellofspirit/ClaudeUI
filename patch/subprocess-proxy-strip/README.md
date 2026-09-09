# Patch: subprocess-proxy-strip

Strip proxy env vars from the env handed to cli.js subprocesses (Bash tool, MCP stdio servers, LSP, shell snapshot, subagent status line) so the proxy ClaudeUI configures for Claude's API traffic does not also route `git push` / `curl` / `npm install` / etc. through the same proxy.

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component            | Version               |
| -------------------- | --------------------- |
| At time of discovery | bundled CLI `2.1.114` |
| Last re-anchored     | bundled CLI `2.1.261` |

## The Problem

### User-visible symptom

When a user sets a proxy in ClaudeUI's settings (e.g. for a corporate egress that only allows Anthropic's API), every bash command Claude runs also routes through that proxy. Git, npm, curl, and shell commands inherit `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and either fail (the proxy rejects them) or leak credentials to the proxy operator.

### Root cause

cli.js funnels every subprocess spawn through a single env-builder function. It returns either `process.env` verbatim (the typical ClaudeUI path) or a scrubbed clone. The scrub list it applies covers API keys / OAuth tokens / session vars — **never the proxy vars** — so in our path the proxy env is passed straight through to every child process.

## Architecture Overview

The env-builder is a zero-arg `function <name>(){...}`. Its body has grown across versions but the skeleton is stable:

```
function <fn>() {
  let <H> = <userEnvGetter>(),                 // optional hook-injected env (usually empty)
      ...flags for "does this source have keys",
      <remote> = <gate>(process.env.CLAUDE_CODE_REMOTE) ? <remoteFn>(...) : {},
      <scrub> = <blockListGate>(),             // true iff CLAUDE_CODE_SUBPROCESS_ENV_SCRUB / local-agent
      ...detection flags for OAuth/session/OTEL vars;
  if (<nothing-to-do>) return process.env;     // ← typical ClaudeUI path: returns env VERBATIM
  let <merged> = { ...process.env, ...sources };
  delete <merged>.CLAUDE_CODE_OAUTH_TOKEN, ... ; // unconditional scrub of auth/session vars
  for (k of keys) if (k.startsWith("OTEL_")) delete <merged>[k];
  if (!<scrub>) return <merged>;
  for (<x> of <blockList>) delete <merged>[<x>], delete <merged>[`INPUT_${<x>}`];
  return <merged>;
}
```

**There are 3–4 `return` statements.** The first (`return process.env`) is the one ClaudeUI usually takes — the scrub gates typically don't fire for us (entrypoint is `sdk-cli`, no `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), so the function returns the raw proxied env.

Which return fires is not something to rely on, and the patch does not: **every** return
is wrapped. That matters more with each release — 2.1.261's early-bail guard has thirteen
terms (`if(!n&&!c&&!_&&!R&&!s&&!f.length&&!K.length&&!X&&!p&&!M&&!W&&!D&&!L)`), several of
which sniff the _ambient_ environment (`s` is true if any `process.env` key matches a
credential-shaped deny-set), so a real user's shell can easily push execution onto the
merged path. See the verbatim 2.1.261 shape at the bottom for how far the body has drifted
from the skeleton above; the skeleton is a mental model, not a matching target.

## The Fix

**Marker:** `/*PATCHED:subprocess-proxy-strip*/`

Define a proxy-strip helper once at the top of the function and wrap **every** `return <expr>` with it. The helper deletes the four proxy vars (upper + lower case) unless the parent set `CLAUDEUI_PROXY_SUBPROCESSES=1`:

```js
let __cuPS = (E) => {
  if (process.env.CLAUDEUI_PROXY_SUBPROCESSES) return E
  let R = { ...E }
  delete R.HTTP_PROXY
  delete R.HTTPS_PROXY
  delete R.ALL_PROXY
  delete R.NO_PROXY
  delete R.http_proxy
  delete R.https_proxy
  delete R.all_proxy
  delete R.no_proxy
  return R
}
```

`return process.env` → `return __cuPS(process.env)`, `return <merged>` → `return __cuPS(<merged>)`, etc. The patch captures every minified identifier in the matched body and **rebuilds the whole function verbatim** with the helper inserted — this guarantees no return path is missed.

### Why it's safe

- The helper clones (`{...E}`) before deleting, so it never mutates `process.env`.
- The gate is read from `process.env` on every call (not cached) — toggling the user's setting takes effect on the next spawn.
- All of cli.js's own scrub/merge logic is preserved byte-for-byte; we only wrap the return values.

## How apply.mjs finds the function (read this before adding anything)

`apply.mjs` has **two** mechanisms, and they are not equal:

1. **The generic path (primary — use this).** Find the function by one unique anchor
   literal, brace-match its body, and mechanically rewrite `return <ident>` →
   `return __cuPS(<ident>)`. It never transcribes the body, so upstream can rewrite the
   whole thing and the patch still applies. Guard rails (see below) make it decline
   rather than guess. **This is where a re-anchor belongs: add a new anchor candidate to
   `genericAnchorFinders`, not a new regex.**
2. **The `fnReV*` version ladder (legacy fallback).** Ten regexes, each transcribing one
   version's _entire_ function body verbatim and rebuilding it identifier-by-identifier.
   Any upstream edit anywhere inside the body — even one irrelevant to proxy stripping —
   invalidates a rung. This is exactly why the generic path exists. The last rung is
   v198; **2.1.231, 2.1.241 and 2.1.261 all went through the generic path and deliberately
   added no rungs.** Do not add an eleventh: the generic path runs first and always wins,
   so a new rung would be dead code, and the 2.1.261 body (a ~2.1 KB function with
   destructuring, a `Set`, five loops and a 6-branch redaction pass) would need ~40
   capture groups to transcribe.

The ladder is kept only so the patch still applies to older pinned CLIs.

### Generic-path guard rails

The generic path refuses (and falls through to the ladder) unless **all** hold:

- the anchor literal is **unique in the whole bundle**;
- the innermost enclosing `function NAME(...)` brace-matches cleanly;
- the body contains **no nested function declaration** (a nested `return` is not an env
  return; arrow callbacks are fine, they are expression-bodied here);
- **every** return operand is a bare identifier or `process.env`, and the count of
  rewritable returns equals the count of `return` keywords — a return it cannot classify
  aborts rather than being silently left unwrapped (an unwrapped return leaks the proxy);
- at least two returns are rewritten (the early bail + the final one).

### Anchor candidates (`genericAnchorFinders`, tried in order)

| #   | Anchor                                                                            | Lived in the builder | Status                              |
| --- | --------------------------------------------------------------------------------- | -------------------- | ----------------------------------- |
| 1   | `INPUT_${` deletion                                                               | ≤ 2.1.231            | **dead** — 8 occurrences in 2.1.261 |
| 2   | `delete <m>.CLAUDE_CODE_SUBSCRIPTION_TYPE,delete <m>.CLAUDE_CODE_RATE_LIMIT_TIER` | v150 – 2.1.241       | **dead** — 0 occurrences in 2.1.261 |
| 3   | `for(let o of Object.keys(d))if(o.startsWith("OTEL_"))delete d[o]`                | v129 – 2.1.261       | **live** — hits in 2.1.261          |
| 4   | `delete <m>.CLAUDE_CODE_OTEL_DIAG_STDERR`                                         | v197 – 2.1.261       | live (spare)                        |

Candidates 3 and 4 are `delete`s on the **merged clone**, i.e. welded to this function's
scrub pass rather than to any one version's variable set — that is what makes them
durable. Candidate 3 is backreferenced (loop var and merged-object name must agree) so it
cannot latch onto an unrelated "strip OTEL\_ keys" helper.

A dead candidate is skipped with a `[generic] anchor not usable` line, so a future
total failure names which anchors died instead of falling silently through to a
misleading "no shape matched".

## Version evolution (legacy ladder)

The body grows roughly every few releases. `apply.mjs` carries one regex+rebuild per shape, tried newest-first; older shapes remain as fallbacks.

| Shape    | Name (then) | What it added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v114     | `Qk`        | 2-source merge (`process.env` + user env); scrub list = API keys only                                                                                                                                                                                                                                                                                                                                                                                                                          |
| v118     | `uv`        | + remote-env merge gated on `CLAUDE_CODE_REMOTE` (3-source)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| v119     | `PV`        | + `CLAUDE_BG_*` / `CLAUDE_CODE_SESSION_KIND` scrub                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| v129     | `sy`        | + OAuth-token scrub flag, + `OTEL_*` strip loop, + unconditional `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` delete                                                                                                                                                                                                                                                                                                                                                                                  |
| v143     | `VS`        | + extra global env source (`ifq`), + `CLAUDE_BG_AUTH_SNAPSHOT_PATH`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| v150     | `dT`        | + `CLAUDE_BG_SESSION_PERMISSION_RULES`, `CLAUDE_BG_MEMORY_TOGGLED_OFF`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| v163     | `wN`        | + one unconditional `delete <merged>.CLAUDE_CODE_RESUME_PROMPT` (inserted after `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`; no matching `!==void 0` detection check, not in the early-return guard)                                                                                                                                                                                                                                                                                                 |
| v170     | `ek`        | + 3 background-session auth vars (`CLAUDE_BG_SOCKET_TOKENS_PATH`, `CLAUDE_BG_RV_AUTH`, `CLAUDE_BG_PTY_AUTH`) — appended to the OAuth detection flag and to the unconditional delete chain after `CLAUDE_BG_AUTH_SNAPSHOT_PATH`                                                                                                                                                                                                                                                                 |
| **v197** | **`oM`**    | **Major refactor** — flagBg detection changed from hardcoded `\|\|`-chain to `DYr.some(...)` (array), per-var deletes replaced by loop, OTEL check extended, guard before block-list loop changed — see below                                                                                                                                                                                                                                                                                  |
| **v198** | **`pD`**    | **+ host-managed-provider scrub array** — a new dynamic term `a=iyn(process.env)` computes an array of env-var names to strip (`[]` unless `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set, else `["ANTHROPIC_CUSTOM_HEADERS", ...blockList, hostAuthEnvVar, "CLAUDE_CODE_HOST_CREDS_FILE"]`), gates the early-return guard via `!a.length`, and is drained via its own `for(let x of a)delete merged[x]` loop (placed before the BG-array delete loop). Otherwise identical to v197 — see below |

**v170 gotcha:** the three new detection terms read off a **module-level env-snapshot global** (`$_` in 2.1.170: `$_.CLAUDE_BG_SOCKET_TOKENS_PATH!==void 0||...`), NOT `process.env` like every other term in the flag. The regex captures this global as its own group and the rebuild re-emits it by captured name. See the inline header comment in `apply.mjs` for the full v170 verbatim shape.

### v2.1.197 shape — `oM()` — major refactor

The v197 shape is a substantial refactor of the background-session detection and delete chain. The env-builder function in v2.1.197 is named `oM()`. Key differences from v170:

**a) `flagBg` detection: `||`-chain → `DYr.some()`**

Old (v170 and earlier): a hardcoded `||`-chain of `process.env.CLAUDE_CODE_SESSION_KIND!==void 0||process.env.CLAUDE_BG_TASK_TASK_ID!==void 0||...` for each background-session variable.

New (v197): a module-level array `DYr` holds all background-session var names. Detection is:

```js
a = DYr.some((u) => process.env[u] !== void 0)
```

The `DYr` array name (captured as `bgArray`) is used for both the detection `.some()` and the delete loop below.

**b) Per-var BG deletes: individual `delete` → `for` loop**

Old (v170): individual `delete <merged>.CLAUDE_CODE_SESSION_KIND, delete <merged>.CLAUDE_BG_TASK_TASK_ID, ...` for each name.

New (v197): a single loop over the same `DYr` array:

```js
for (let u of DYr) delete c[u]
```

**c) OTEL `.some()` check extended**

Old (v170): `Object.keys(process.env).some((u) => u.startsWith("OTEL_"))`

New (v197): `Object.keys(process.env).some((u) => u.startsWith("OTEL_") || u === "CLAUDE_CODE_OTEL_DIAG_STDERR")`

**d) Guard before block-list loop changed**

Old (v170): `if(!T)return Y` (simple boolean guard)

New (v197): `if(delete c.CLAUDE_CODE_OTEL_DIAG_STDERR,!s)return c`

The `CLAUDE_CODE_OTEL_DIAG_STDERR` delete is now part of the guard expression (comma operator), ensuring it's always deleted when this code path is reached.

**Verbatim v197 shape (for reference):**

```js
function oM() {
  let e = Zit(),
    t = Object.keys(e).length > 0,
    n = Object.keys(LYr).length > 0,
    r = ct(process.env.CLAUDE_CODE_REMOTE) ? R2i(t ? { ...process.env, ...e } : process.env) : {},
    o = Object.keys(r).length > 0,
    s = v$d(),
    i =
      process.env.CLAUDE_CODE_OAUTH_TOKEN !== void 0 ||
      process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE !== void 0 ||
      process.env.CLAUDE_CODE_RATE_LIMIT_TIER !== void 0 ||
      process.env.CLAUDE_BG_AUTH_SNAPSHOT_PATH !== void 0 ||
      Ne.CLAUDE_BG_SOCKET_TOKENS_PATH !== void 0 ||
      Ne.CLAUDE_BG_RV_AUTH !== void 0 ||
      Ne.CLAUDE_BG_PTY_AUTH !== void 0,
    a = !1
  a = DYr.some((u) => process.env[u] !== void 0)
  let l = Object.keys(process.env).some(
    (u) => u.startsWith('OTEL_') || u === 'CLAUDE_CODE_OTEL_DIAG_STDERR'
  )
  if (!t && !o && !s && !a && !i && !l && !n) return process.env
  let c = { ...process.env, ...LYr, ...e, ...r }
  ;(delete c.CLAUDE_CODE_OAUTH_TOKEN,
    delete c.CLAUDE_CODE_SUBSCRIPTION_TYPE,
    delete c.CLAUDE_CODE_RATE_LIMIT_TIER,
    delete c.CLAUDE_BG_AUTH_SNAPSHOT_PATH,
    delete c.CLAUDE_BG_SOCKET_TOKENS_PATH,
    delete c.CLAUDE_BG_RV_AUTH,
    delete c.CLAUDE_BG_PTY_AUTH)
  for (let u of DYr) delete c[u]
  for (let u of Object.keys(c)) if (u.startsWith('OTEL_')) delete c[u]
  if ((delete c.CLAUDE_CODE_OTEL_DIAG_STDERR, !s)) return c
  for (let u of k$d) (delete c[u], delete c[`INPUT_${u}`])
  return c
}
```

The patch replaces the whole function verbatim (same strategy as all prior shapes), wrapping every `return <expr>` with `return __cuPS(<expr>)` and inserting the strip helper at the top. The v197 pattern `fnReV197` is tried first (newest-first dispatch); v170, v163, … remain as fallbacks.

**v197 variable map:**

| Captured group      | Example name | Role                                                                  |
| ------------------- | ------------ | --------------------------------------------------------------------- |
| `H`                 | `e`          | User env binding (`Zit()` result)                                     |
| `flagUserNotEmpty`  | `t`          | `Object.keys(e).length > 0`                                           |
| `extraGlobal`       | `LYr`        | Module-level extra env global                                         |
| `flagExtraNotEmpty` | `n`          | `Object.keys(LYr).length > 0`                                         |
| `qRemote`           | `r`          | Remote env merge result                                               |
| `flagScrub`         | `s`          | `v$d()` block-list gate                                               |
| `flagOAuth`         | `i`          | OAuth/session token detection                                         |
| `envSnap`           | `Ne`         | Module-level env snapshot (reads `CLAUDE_BG_SOCKET_TOKENS_PATH` etc.) |
| `flagBg`            | `a`          | Background-session detection                                          |
| `bgArray`           | `DYr`        | Module-level array of BG session var names                            |
| `flagOtel`          | `l`          | OTEL flag                                                             |
| `merged`            | `c`          | Merged env object                                                     |
| `blockList`         | `k$d`        | Block-list array for scrub loop                                       |

### v2.1.198 shape — `pD()` — adds host-managed-provider scrub array

The v198 shape is additive on top of v197 — same BG-session `.some()`/loop refactor, same OTEL/guard-comma structure — plus one new dynamic scrub source inserted between the OAuth flag and the BG flag:

**a) New term: `hostArray = iyn(process.env)`**

```js
function iyn(e) {
  if (!ct(e.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) return []
  return [
    'ANTHROPIC_CUSTOM_HEADERS',
    ...d7,
    e.CLAUDE_CODE_HOST_AUTH_ENV_VAR,
    'CLAUDE_CODE_HOST_CREDS_FILE'
  ].filter((t) => !!t)
}
```

`iyn` (found separately via `bundle-analyzer find cli.js "function iyn"`) returns `[]` unless the CLI is running under a host-managed-provider integration, in which case it returns a small list of env vars (an `ANTHROPIC_CUSTOM_HEADERS` literal, a spread of the same `blockList` array (`d7`/`GGd`/`k$d` depending on version) used by the pre-existing block-list loop, plus two more host-specific vars). This is orthogonal to proxy stripping — it's Anthropic's own scrub for a different sensitive-data category — but it changes the _shape_ of the env-builder function we're patching, so it has to be captured and reproduced verbatim.

**b) Early-return guard gains `!hostArray.length`**

Old (v197): `if(!t&&!o&&!s&&!a&&!i&&!l&&!n)return process.env;`

New (v198): `if(!t&&!o&&!s&&!l&&!i&&!a.length&&!c&&!n)return process.env;` — note `a` is now the host array (checked via `.length`) and the old `a` (BG flag) became `l`, the old `l` (OTEL flag) became `c`. **Every single-letter name shifts when a new term is inserted mid-sequence — always re-derive full capture-group numbering, never assume a name carries the same role across versions.**

**c) New delete loop, placed before the BG-array loop**

```js
for (let d of a) delete u[d] // NEW — host array delete loop (v198)
for (let d of RQr) delete u[d] // BG array delete loop (existed in v197 as DYr)
for (let d of Object.keys(u)) if (d.startsWith('OTEL_')) delete u[d]
```

**Verbatim v198 shape (for reference):**

```js
function pD() {
  let e = nlt(),
    t = Object.keys(e).length > 0,
    n = Object.keys(LQr).length > 0,
    r = st(process.env.CLAUDE_CODE_REMOTE) ? y3i(t ? { ...process.env, ...e } : process.env) : {},
    o = Object.keys(r).length > 0,
    s = jGd(),
    i =
      process.env.CLAUDE_CODE_OAUTH_TOKEN !== void 0 ||
      process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE !== void 0 ||
      process.env.CLAUDE_CODE_RATE_LIMIT_TIER !== void 0 ||
      process.env.CLAUDE_BG_AUTH_SNAPSHOT_PATH !== void 0 ||
      Le.CLAUDE_BG_SOCKET_TOKENS_PATH !== void 0 ||
      Le.CLAUDE_BG_RV_AUTH !== void 0 ||
      Le.CLAUDE_BG_PTY_AUTH !== void 0,
    a = iyn(process.env),
    l = !1
  l = RQr.some((d) => process.env[d] !== void 0)
  let c = Object.keys(process.env).some(
    (d) => d.startsWith('OTEL_') || d === 'CLAUDE_CODE_OTEL_DIAG_STDERR'
  )
  if (!t && !o && !s && !l && !i && !a.length && !c && !n) return process.env
  let u = { ...process.env, ...LQr, ...e, ...r }
  ;(delete u.CLAUDE_CODE_OAUTH_TOKEN,
    delete u.CLAUDE_CODE_SUBSCRIPTION_TYPE,
    delete u.CLAUDE_CODE_RATE_LIMIT_TIER,
    delete u.CLAUDE_BG_AUTH_SNAPSHOT_PATH,
    delete u.CLAUDE_BG_SOCKET_TOKENS_PATH,
    delete u.CLAUDE_BG_RV_AUTH,
    delete u.CLAUDE_BG_PTY_AUTH)
  for (let d of a) delete u[d]
  for (let d of RQr) delete u[d]
  for (let d of Object.keys(u)) if (d.startsWith('OTEL_')) delete u[d]
  if ((delete u.CLAUDE_CODE_OTEL_DIAG_STDERR, !s)) return u
  for (let d of GGd) (delete u[d], delete u[`INPUT_${d}`])
  return u
}
```

The patch replaces the whole function verbatim, same strategy as v197: wraps every `return <expr>` with `return __cuPS(<expr>)`, and adds the new host-array delete loop unmodified (proxy stripping is additive/orthogonal to it, same as the BG/OTEL/block-list loops). The `fnReV198` pattern is tried first (newest-first dispatch); v197, v170, v163, … remain as fallbacks.

**v198 variable map (27 capture groups total — every later group shifted by +2 vs v197's 24, due to the two new `hostArray`/`hostArrayFn` captures inserted at positions 15–16):**

| Captured group      | Example name | Role                                                                  |
| ------------------- | ------------ | --------------------------------------------------------------------- |
| `H`                 | `e`          | User env binding (`nlt()` result)                                     |
| `flagUserNotEmpty`  | `t`          | `Object.keys(e).length > 0`                                           |
| `extraGlobal`       | `LQr`        | Module-level extra env global                                         |
| `flagExtraNotEmpty` | `n`          | `Object.keys(LQr).length > 0`                                         |
| `qRemote`           | `r`          | Remote env merge result                                               |
| `flagScrub`         | `s`          | `jGd()` block-list gate                                               |
| `flagOAuth`         | `i`          | OAuth/session token detection                                         |
| `envSnap`           | `Le`         | Module-level env snapshot (reads `CLAUDE_BG_SOCKET_TOKENS_PATH` etc.) |
| `hostArray`         | `a`          | **NEW (v198)** — host-managed-provider scrub array                    |
| `hostArrayFn`       | `iyn`        | **NEW (v198)** — computes `hostArray`                                 |
| `flagBg`            | `l`          | Background-session detection                                          |
| `bgArray`           | `RQr`        | Module-level array of BG session var names                            |
| `flagOtel`          | `c`          | OTEL flag                                                             |
| `merged`            | `u`          | Merged env object                                                     |
| `blockList`         | `GGd`        | Block-list array for scrub loop                                       |

## Locating the function in a new CLI version

Do NOT search by name (minified, changes every release). Search by structural landmarks.
From 2.1.261 the patch target `vendor/claude-cli/cli.js` is a **concatenation of ~1,600
minified ESM chunks**, each preceded by a `// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js`
delimiter line. `bundle-analyzer` and plain `rg` work on it unchanged (it is just JS
text), but **uniqueness is now much weaker** — helpers get duplicated across chunks, which
is precisely how the `INPUT_${` anchor died.

```bash
# The two live anchors (both are deletes on the merged clone — see the candidates table):
bundle-analyzer.cmd find vendor/claude-cli/cli.js 'startsWith("OTEL_"))delete' --compact
bundle-analyzer.cmd find vendor/claude-cli/cli.js 'CLAUDE_CODE_OTEL_DIAG_STDERR' --compact

# Cross-check you have the right function — it is the ONE that both merges
# {...process.env, ...} and is called for every subprocess spawn:
bundle-analyzer.cmd find vendor/claude-cli/cli.js '{...process.env,...' --compact
bundle-analyzer.cmd extract-fn vendor/claude-cli/cli.js <char-offset>
```

**Confirm by callers, not by shape.** The builder is exported from its chunk and imported
by every spawn site. Grab its exported name, then grep the importing chunks:

```bash
# 2.1.261: `export{…,Pi,…}` from chunk-94p9gg95.js, imported by 12 chunks.
rg -o 'import\{[^}]*\}from"[^"]*chunk-94p9gg95\.js"' vendor/claude-cli/cli.js | head
```

Call sites that must show up (this is the patch's whole surface area): the Bash-tool
spawn env builder, MCP stdio server spawn, the shell snapshot (`["-c","-l", …]` with
`SHELL:`/`GIT_EDITOR:"true"`), plugin-command source, spellcheck, and the `gh` helper.
If your candidate function is not what those call, you have the wrong function.

**Then add an anchor, not a regex.** Pick a landmark inside the body that is unique in the
whole concat and structurally tied to the function's job (a `delete` on the merged clone
is the best kind), append it to `genericAnchorFinders` in `apply.mjs`, and run. The
generic path handles the rest; the guard rails above will refuse rather than mangle if
you picked a landmark in the wrong function.

Only if the generic path genuinely cannot work (e.g. upstream introduces a nested function
declaration, or a return whose operand is a call expression) does the legacy ladder come
back into play — in that case extract the verbatim `function <name>(){...}`, diff against
the v198 shape in `apply.mjs`, add a `fnReV<NNN>` regex + rebuild block as the first
branch, and watch the group numbering: any new capture inserted mid-pattern shifts every
later backreference (`\\14`, `\\15`, …) — renumber both the regex backrefs and the
destructuring.

## Gate env vars

| Env var                         | Set by                                                   | Effect                                    |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| `CLAUDEUI_PROXY_SUBPROCESSES=1` | ClaudeUI when `ProxySettings.proxySubprocesses === true` | Helper no-ops; subprocesses inherit proxy |
| (unset)                         | default                                                  | Helper strips proxy from subprocess env   |

## What's NOT changed

- The early-return guard expression, the source-merge order, the auth/session/OTEL delete chain, and the block-list loop are all reproduced verbatim — we only wrap return values.
- The CLI's own scrub list (`CLAUDE_CODE_OAUTH_TOKEN`, etc.) is untouched; proxy stripping is additive and orthogonal.

## Risk / side effects

- **MCP stdio servers** that legitimately need the corporate proxy stop working under the default. User flips `proxySubprocesses=true` to restore.
- **LSP servers** typically make no network calls — impact nil.
- **Shell snapshot** (one-shot shell env dump at startup) — edge case if the user's profile fetches over HTTP.
- If a future cli.js version adds a new `return` path inside the env-builder that a stale regex misses, that path would leak the proxy. Mitigated by rebuilding the whole function (all returns covered) and the uniqueness check that aborts on a multi-match.

## Verification

1. `node patch/subprocess-proxy-strip/apply.mjs` — on 2.1.261 reports
   `Found Pi() [generic shape] at char 2902824` / `Wrapped 3 return(s) with __cuPS()`
   (older pinned CLIs report `[v198 shape]`, `[v197 shape]`, …). Two `[generic] anchor
not usable` lines before it are expected — candidates 1 and 2 are dead on 2.1.261.
2. Run again — reports "Patch already applied. Nothing to do."
3. `node patch/apply-all.mjs` — the rebundler splits the concat back into chunks and
   esbuild-syntax-checks every chunk that changed.
4. `node patch/subprocess-proxy-strip/test.mjs` — the dedicated behavioral harness: spawns
   the real rebundled `bun-claude` and probes a subprocess env in both modes (default
   strips `ALL_PROXY`; `CLAUDEUI_PROXY_SUBPROCESSES=1` preserves it). Requires the built
   binary, so it does **not** run in a bare patch worktree.

Static verification (works anywhere, no binary needed) — worth doing on every re-anchor,
because a green exit code only proves the marker landed, not that it landed correctly:

- extract the patched function and read it: every `return` wrapped, the helper declared
  at the top of the body, all captured identifiers bound in that chunk's scope;
- `node --check` the **modified chunk in isolation** (slice it out by its `// @bun-chunk`
  delimiters). Do not `node --check` the whole concat — it is a concatenation of 1,631
  ESM modules and is not parseable as a single script by design;
- round-trip: strip the marker, the helper and the `__cuPS(...)` wrappers, and assert the
  result is byte-identical to the pristine function, with the rest of the file untouched.
  On 2.1.261 this holds exactly, at +306 bytes total.

## Discovery Method (2.1.163 re-anchor)

1. **Apply failed:** `Cannot locate env-builder function by v114/v118/v119/v129/v143/v150 structural shape`.
2. **Located via `INPUT_${`** (unique template literal) → `function wN(){...}`.
3. **Diffed against v150:** identical control flow; the only change is one extra unconditional `delete Y.CLAUDE_CODE_RESUME_PROMPT` between `...RESUME_INTERRUPTED_TURN` and `...BG_SESSION_PERMISSION_RULES`. (Initial agent report claimed "two new" deletes, but `RESUME_INTERRUPTED_TURN` already existed in v150 — verified by extracting both bodies.)
4. **Added `fnReV163`** (clone of v150 + the inserted delete in both regex and rebuild), placed first in the branch chain.
5. **Applied cleanly**, `node --check` passed, full rebundle + codesign succeeded.

## Discovery Method (2.1.170 re-anchor)

1. **Apply failed:** `Cannot locate env-builder function by ... structural shape`.
2. **Located via `CLAUDE_BG_MEMORY_TOGGLED_OFF`** (4 occurrences; first two are this function's flag line + delete chain) → `function ek(){...}`.
3. **Diffed against v163:** three new vars (`CLAUDE_BG_SOCKET_TOKENS_PATH`, `CLAUDE_BG_RV_AUTH`, `CLAUDE_BG_PTY_AUTH`) in the OAuth flag and the delete chain. The flag terms read off a module global `$_` instead of `process.env` — required a new capture group (14), shifting all later backrefs by one vs the v163 pattern.
4. **Added `fnReV170`** as the first branch; v163 kept as fallback.
5. **Applied cleanly** (`Found ek() [v170 shape]`), `node --check` passed, rebundle + codesign succeeded.

## Discovery Method (2.1.197 re-anchor)

1. **Apply failed:** `Cannot locate env-builder function by v114, v118, v119, v129, v143, v150, v163, or v170 structural shape`.
2. **Located via `INPUT_${`** (unique template literal) → `function oM(){...}`.
3. **Diffed against v170:** the function was substantially refactored:
   - Background-session variable detection changed from a hardcoded `||`-chain to `DYr.some((u)=>process.env[u]!==void 0)` where `DYr` is a module-level array.
   - Per-var `delete c[VARNAME]` statements replaced by `for(let u of DYr)delete c[u]`.
   - OTEL `.some()` extended to include `||u==="CLAUDE_CODE_OTEL_DIAG_STDERR"`.
   - Guard before block-list loop changed from `if(!T)return Y` to `if(delete c.CLAUDE_CODE_OTEL_DIAG_STDERR,!s)return c`.
4. **Added `fnReV197`** as the first (newest) branch. Pattern uses 24 capture groups; group numbering must match the destructuring in the rebuild block exactly. Backreferences `\\14`–`\\24` shift accordingly vs the v170 pattern.
5. **Applied cleanly** (`Found oM() [v197 shape]`), `node --check` passed, rebundle + codesign succeeded.

**Tip for next re-anchor:** extract the function with `bundle-analyzer find cli.js 'INPUT_${'` to get the offset, then `bundle-analyzer extract-fn cli.js <offset>` to get the full body. Diff against the v197 verbatim shape in this README. If a new scrub variable was added to the `DYr` array, only the array itself needs updating — the loop-based delete logic adapts automatically.

## Discovery Method (2.1.198 re-anchor)

1. **Apply failed** (as part of the same `claudeCliVersion` bump that also broke `taskstop-notification`): `Cannot locate env-builder function by v114, v118, v119, v129, v143, v150, v163, v170, or v197 structural shape`.
2. **Located via `INPUT_${`** (unique template literal, still unique in 2.1.198) → `function pD(){...}`.
3. **Diffed against v197 verbatim shape in this README:** the function gained exactly one new term inserted between the OAuth flag (`i`) and the (renamed) BG flag:
   - `a=iyn(process.env)` — a new array-valued term, where `iyn(e)` returns `[]` unless `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set (traced `iyn` separately via `bundle-analyzer find cli.js "function iyn"` to confirm it wasn't the BG-array or block-list again under a new name).
   - Early-return guard gained a `!a.length` term (renaming every flag after it: v197's `a`→v198's `l`, v197's `l`→v198's `c`).
   - A new `for(let d of a)delete u[d]` loop appears immediately before the (renamed) BG-array delete loop.
   - Everything else — BG `.some()` detection/delete-loop structure, OTEL `.some()` check, the `if(delete u.CLAUDE_CODE_OTEL_DIAG_STDERR,!s)return u` guard-comma trick, the block-list loop — reproduced byte-for-byte from v197, just with fresh minified names.
4. **Added `fnReV198`** as the first (newest) branch, placed before `fnReV197` in the `if/else` chain. Pattern uses 27 capture groups (2 more than v197's 24, for `hostArray`/`hostArrayFn`); every backreference at position ≥15 shifts by +2 vs the v197 pattern's numbering. Double-checked the rebuild's destructuring array lines up positionally with the regex's capture-group order before running.
5. **Applied cleanly** (`Found pD() [v198 shape] at char 3458177`), `node --check` passed. Verified statically (raw slice showing every `return` wrapped in `__cuPS(...)` with all original logic — including the new host-array loop — reproduced verbatim) and dynamically: `patch/subprocess-proxy-strip/test.mjs` passed 7/7 against the rebundled `bun-claude.exe` (default mode strips `ALL_PROXY` from a real subprocess env probe; opt-in mode via `CLAUDEUI_PROXY_SUBPROCESSES=1` preserves it).
6. **Full chain re-verified end-to-end**: `bun run ensure-cli` and `bun run update-cli --force` (fresh re-download + re-extraction) both completed all 14 patches + rebundle without error, run twice for idempotency.

## Discovery Method (2.1.241 re-anchor — generic path gets anchor candidates)

1. **Apply failed** through the generic path AND the whole version ladder. The generic path (added for 2.1.231) anchors on `INPUT_${` being unique — still unique in 2.1.241, but **no longer inside the env-builder**: the INPUT_ variants moved into the scrub array's own definition (`Hqo=crb.flatMap((e)=>[e,`INPUT_${e}`])`, a module initializer), so the anchor walk found a module wrapper, tripped the nested-function guard, and declined; the ladder had no v241 rung.
2. **Located the real builder** via `delete m[h]` loops: the env-builder's tail is now `if(!a)return m;for(let h of Hqo)delete m[h];return m}` — the old `delete $[A],delete $[`INPUT_${A}`]` pair collapsed to a single delete because the array itself now carries the INPUT_ variants. The 2.1.241 builder is `function nP(){let e=kBn.of(ar().host),t=e.getAgentProxyEnv?.()??{},…}` (host-binder proxy env + `settingsColorEnv`; 3 returns: early `process.env` bail, `if(!a)return m`, final `return m`; no nested function declarations — generic-rewrite eligible).
3. **Fix**: the generic path now tries an ordered list of anchor candidates (each must be globally unique and still pass every guard): `INPUT_${` first (works ≤2.1.231), then the auth-identity scrub pair `delete <m>.CLAUDE_CODE_SUBSCRIPTION_TYPE,delete <m>.CLAUDE_CODE_RATE_LIMIT_TIER` (inside the builder since the v150 shape, unique in 2.1.241). Find it via `bundle-analyzer find cli.js 'CLAUDE_CODE_SUBSCRIPTION_TYPE,delete' --compact`.
4. **Verified**: `Found nP() [generic shape] at char 3709852, wrapped 3 return(s)`; `node --check` passed; live `test.mjs` default/opt-in subprocess probes pass.

## Discovery Method (2.1.261 re-anchor — chunked bundle, both anchors died at once)

1. **Apply failed** with `Cannot locate env-builder function by v114 … v198 structural
shape` and — the real tell — **zero `[generic]` output**, because the anchor loop
   `continue`d silently on both candidates. (Fixed: dead candidates now log.)
2. **Both anchors were invalid, for different reasons:**
   - `INPUT_${` → **8** occurrences. 2.1.261 splits the bundle into 1,631 ESM chunks,
     and the GitHub-Actions secret-name helpers in `chunk-ay65a202.js` and
     `chunk-9c0rs7w4.js` each build their own `INPUT_`-prefixed name lists
     (``Tge=Or.flatMap((e)=>[e,`INPUT_${e}`])``, plus `B8t`, `$Kr`, `jKr`, `di`, `qCe`).
     None are in the builder.
   - `delete <m>.CLAUDE_CODE_SUBSCRIPTION_TYPE,delete <m>.CLAUDE_CODE_RATE_LIMIT_TIER` →
     **0** occurrences. The builder no longer deletes auth-identity vars one by one; it
     collects scrub names into a `Set` and drains it with
     `for(let o of Object.keys(d))if(F.has(o.toUpperCase()))delete d[o]`.
3. **Located the builder** by walking the 11 hits of the string literal
   `"CLAUDE_CODE_SUBSCRIPTION_TYPE"` and brace-matching the enclosing function:
   `function Pi()` in `B:/~BUN/root/chunk-94p9gg95.js` (char 2902824–2904927 in the concat).
   **Confirmed by callers**, not by shape: `Pi` is exported from that chunk and imported
   by 12 chunks — Bash-tool spawn (`uso({shellType,binShell,…})`), MCP stdio spawn,
   shell snapshot, plugin-command source, spellcheck, `gh`. That is exactly the patch's
   surface.
4. **Generic path was already eligible** — the guard rails all pass on `Pi()`: no nested
   function declaration, 3 `return` keywords, all 3 of a rewritable shape
   (`return process.env`, `if(!_)return d`, `return d`).
5. **Fix**: two new anchor candidates appended to `genericAnchorFinders` — the `OTEL_`
   strip loop (backreferenced; in the builder since the v129 shape) and the
   `delete <m>.CLAUDE_CODE_OTEL_DIAG_STDERR` scrub (since v197). No new ladder rung.
6. **Verified**: `Found Pi() [generic shape] at char 2902824, wrapped 3 return(s)`;
   re-run reports "Patch already applied"; `node --check` passes on the modified chunk
   in isolation (the _concat as a whole_ is not parseable as one script — check the chunk,
   not the file); and a round-trip proof — stripping the marker, the helper and the three
   `__cuPS(...)` wrappers reproduces the pristine function **byte-for-byte**, with the
   other 30.9 MB of bundle byte-identical and a total delta of +306 bytes.

**2.1.261 note — cli.js now has a proxy env of its own.** The builder opens with
`t=e.getAgentProxyEnv?.()??{}` (host-binder "agent proxy env") and `{settingsColorEnv:r}=e`.
`getAgentProxyEnv` is only ever registered inside the `Pe(process.env.CLAUDE_CODE_REMOTE)`
branch of init (`registerAgentProxyEnvFn(d)` from `chunk-1er1x92g.js`), so under ClaudeUI's
local spawn it stays `undefined` → `t={}` → `n=false`, and the early
`return __cuPS(process.env)` is still our path. If a future ClaudeUI ever sets
`CLAUDE_CODE_REMOTE`, that host-injected proxy env would be stripped by default too —
consistent with the patch's intent, but worth knowing.

**Verbatim 2.1.261 shape (`Pi()`, pristine — diff against this at the next re-anchor):**

```js
function Pi() {
  let e = m.of(B().host),
    t = e.getAgentProxyEnv?.() ?? {},
    n = Object.keys(t).length > 0,
    { settingsColorEnv: r } = e,
    p = Object.keys(r).length > 0,
    i = a.CLAUDE_CODE_REMOTE === !0,
    l = i ? y(n ? { ...process.env, ...t } : process.env) : {},
    c = Object.keys(l).length > 0,
    _ = L4t(),
    s =
      Object.keys(process.env).some((o) => te.has(o.toUpperCase())) ||
      Object.keys(process.env).some((o) => p7e(o.toUpperCase())) ||
      process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE !== void 0 ||
      process.env.CLAUDE_CODE_RATE_LIMIT_TIER !== void 0,
    f = Mge(process.env),
    K = wRn(),
    R = !1
  R = dme.some((o) => process.env[o] !== void 0)
  let X = Object.keys(process.env).some((o) =>
      /^(INPUT_)?(OTEL_|CLAUDE_CODE_OTEL_DIAG_STDERR$)/i.test(o)
    ),
    M = a.CLAUDE_CODE_PLUGIN_ATTRIBUTION !== void 0 || a.CLAUDE_CODE_SKILL_ATTRIBUTION !== void 0,
    W = a.CLAUDE_CODE_QUESTION_EXTENDED,
    D = !1,
    L = i && Object.keys(process.env).some(I)
  if (!n && !c && !_ && !R && !s && !f.length && !K.length && !X && !p && !M && !W && !D && !L)
    return process.env // ← wrapped
  let d = { ...process.env, ...r, ...t, ...l },
    F = new Set(
      [
        ...U4t(),
        'CLAUDE_CODE_SUBSCRIPTION_TYPE',
        'CLAUDE_CODE_RATE_LIMIT_TIER',
        'CLAUDE_CODE_QUESTION_EXTENDED'
      ].map((o) => o.toUpperCase())
    )
  for (let o of Object.keys(d)) if (F.has(o.toUpperCase())) delete d[o]
  for (let o of dme) delete d[o]
  for (let o of Object.keys(d)) if (o.startsWith('OTEL_')) delete d[o] // ← anchor 3
  if (
    (delete d.CLAUDE_CODE_OTEL_DIAG_STDERR, // ← anchor 4
    delete d.CLAUDE_CODE_PLUGIN_ATTRIBUTION,
    delete d.CLAUDE_CODE_SKILL_ATTRIBUTION,
    D)
  ) {
    for (let o of Object.keys(d)) if (ne(o)) delete d[o]
  }
  if (L) {
    for (let o of Object.keys(d)) if (I(o)) delete d[o]
  }
  if (!_) return d // ← wrapped
  let J = re(),
    z = qCe().length > 0
  for (let [o, E] of Object.entries(d)) {
    /* value-level redaction pass: placeholder passthrough, unix-socket
       exemption, deny-set/regex deletes, header truncation, generic scrub */
  }
  return d // ← wrapped
}
```

## Files

| File        | Purpose                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `README.md` | This document                                                                       |
| `apply.mjs` | Patch script — generic anchor path first, legacy `fnReV114`…`fnReV198` ladder after |
| `test.mjs`  | Behavioral harness (spawns the REAL rebundled `bun-claude`; needs the main repo)    |
