# Patch: subprocess-proxy-strip

Strip proxy env vars from the env handed to cli.js subprocesses (Bash tool, MCP stdio servers, LSP, shell snapshot, subagent status line) so the proxy ClaudeUI configures for Claude's API traffic does not also route `git push` / `curl` / `npm install` / etc. through the same proxy.

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component | Version |
|---|---|
| At time of discovery | bundled CLI `2.1.114` |
| Last re-anchored | bundled CLI `2.1.163` |

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

**There are 3–4 `return` statements.** The first (`return process.env`) is the load-bearing one for ClaudeUI — none of the scrub gates fire for us (entrypoint is `sdk-cli`, no `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), so the function returns the raw proxied env.

## The Fix

**Marker:** `/*PATCHED:subprocess-proxy-strip*/`

Define a proxy-strip helper once at the top of the function and wrap **every** `return <expr>` with it. The helper deletes the four proxy vars (upper + lower case) unless the parent set `CLAUDEUI_PROXY_SUBPROCESSES=1`:

```js
let __cuPS = (E) => {
  if (process.env.CLAUDEUI_PROXY_SUBPROCESSES) return E
  let R = { ...E }
  delete R.HTTP_PROXY; delete R.HTTPS_PROXY; delete R.ALL_PROXY; delete R.NO_PROXY
  delete R.http_proxy; delete R.https_proxy; delete R.all_proxy; delete R.no_proxy
  return R
}
```

`return process.env` → `return __cuPS(process.env)`, `return <merged>` → `return __cuPS(<merged>)`, etc. The patch captures every minified identifier in the matched body and **rebuilds the whole function verbatim** with the helper inserted — this guarantees no return path is missed.

### Why it's safe

- The helper clones (`{...E}`) before deleting, so it never mutates `process.env`.
- The gate is read from `process.env` on every call (not cached) — toggling the user's setting takes effect on the next spawn.
- All of cli.js's own scrub/merge logic is preserved byte-for-byte; we only wrap the return values.

## Version evolution

The body grows roughly every few releases. `apply.mjs` carries one regex+rebuild per shape, tried newest-first; older shapes remain as fallbacks.

| Shape | Name (then) | What it added |
|---|---|---|
| v114 | `Qk` | 2-source merge (`process.env` + user env); scrub list = API keys only |
| v118 | `uv` | + remote-env merge gated on `CLAUDE_CODE_REMOTE` (3-source) |
| v119 | `PV` | + `CLAUDE_BG_*` / `CLAUDE_CODE_SESSION_KIND` scrub |
| v129 | `sy` | + OAuth-token scrub flag, + `OTEL_*` strip loop, + unconditional `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` delete |
| v143 | `VS` | + extra global env source (`ifq`), + `CLAUDE_BG_AUTH_SNAPSHOT_PATH` |
| v150 | `dT` | + `CLAUDE_BG_SESSION_PERMISSION_RULES`, `CLAUDE_BG_MEMORY_TOGGLED_OFF` |
| **v163** | **`wN`** | **+ one unconditional `delete <merged>.CLAUDE_CODE_RESUME_PROMPT`** (inserted after `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`; no matching `!==void 0` detection check, not in the early-return guard) |

The v163 delta vs v150 is exactly one extra line in the delete chain — see the inline header comment in `apply.mjs` for the full v163 verbatim shape.

## Locating the function in a new CLI version

Do NOT search by name (minified, changes every release). Search by structural landmarks:

```bash
# Best single anchor — the block-list loop's template literal is unique in the whole file:
bundle-analyzer find cli.js 'INPUT_${' --compact

# Confirm via the newest session-var tokens (present only in this function's scrub chain):
bundle-analyzer find cli.js "CLAUDE_BG_MEMORY_TOGGLED_OFF" --compact
bundle-analyzer find cli.js "CLAUDE_CODE_RESUME_PROMPT" --compact

# The combo of CLAUDE_CODE_REMOTE + startsWith("OTEL_") + INPUT_${ is unique to this fn.
```

When the body changes again: extract the verbatim `function <name>(){...}` (from `function` to the `return <merged>}`), diff it against the v163 shape in `apply.mjs`, add a new `fnReV<NNN>` regex + rebuild block, and register it as the first branch in the `if/else` chain. Keep older shapes as fallbacks.

## Gate env vars

| Env var | Set by | Effect |
|---|---|---|
| `CLAUDEUI_PROXY_SUBPROCESSES=1` | ClaudeUI when `ProxySettings.proxySubprocesses === true` | Helper no-ops; subprocesses inherit proxy |
| (unset) | default | Helper strips proxy from subprocess env |

## What's NOT changed

- The early-return guard expression, the source-merge order, the auth/session/OTEL delete chain, and the block-list loop are all reproduced verbatim — we only wrap return values.
- The CLI's own scrub list (`CLAUDE_CODE_OAUTH_TOKEN`, etc.) is untouched; proxy stripping is additive and orthogonal.

## Risk / side effects

- **MCP stdio servers** that legitimately need the corporate proxy stop working under the default. User flips `proxySubprocesses=true` to restore.
- **LSP servers** typically make no network calls — impact nil.
- **Shell snapshot** (one-shot shell env dump at startup) — edge case if the user's profile fetches over HTTP.
- If a future cli.js version adds a new `return` path inside the env-builder that a stale regex misses, that path would leak the proxy. Mitigated by rebuilding the whole function (all returns covered) and the uniqueness check that aborts on a multi-match.

## Verification

1. `node patch/subprocess-proxy-strip/apply.mjs` — reports `Found <fn>() [v163 shape]` and wraps every return.
2. Run again — reports "Patch already applied. Nothing to do."
3. `node patch/apply-all.mjs` — `node --check` passes.
4. `node patch/subagent-streaming/test.mjs` / `bash-output-streaming/test.mjs` — confirm subprocesses still spawn (indirect coverage; there is no dedicated proxy-strip behavioral harness yet).

Always run `node --check cli.js` after applying.

## Discovery Method (2.1.163 re-anchor)

1. **Apply failed:** `Cannot locate env-builder function by v114/v118/v119/v129/v143/v150 structural shape`.
2. **Located via `INPUT_${`** (unique template literal) → `function wN(){...}`.
3. **Diffed against v150:** identical control flow; the only change is one extra unconditional `delete Y.CLAUDE_CODE_RESUME_PROMPT` between `...RESUME_INTERRUPTED_TURN` and `...BG_SESSION_PERMISSION_RULES`. (Initial agent report claimed "two new" deletes, but `RESUME_INTERRUPTED_TURN` already existed in v150 — verified by extracting both bodies.)
4. **Added `fnReV163`** (clone of v150 + the inserted delete in both regex and rebuild), placed first in the branch chain.
5. **Applied cleanly**, `node --check` passed, full rebundle + codesign succeeded.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script (per-version shapes v114→v163, newest-first) |
