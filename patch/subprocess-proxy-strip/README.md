# Patch: subprocess-proxy-strip

Strip proxy env vars from the env handed to cli.js subprocesses (Bash tool, MCP stdio servers, LSP, shell snapshot, subagent status line) so the proxy ClaudeUI configures for Claude's API traffic does not also route `git push` / `curl` / `npm install` / etc. through the same proxy.

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component | Version at time of discovery |
|---|---|
| Bundled CLI (`cli.js`) | 2.1.114 |

## The Problem

### User-visible symptom

When a user sets a proxy in ClaudeUI's settings (e.g. for a corporate egress that only allows Anthropic's API), every bash command Claude runs also routes through that proxy. Git, npm, curl, and shell commands inherit `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and either fail (the proxy rejects them) or leak credentials to the proxy operator.

### Root cause

cli.js funnels every subprocess spawn through the `Qk()` env helper:

```js
function Qk() {
  let H = QE_(), _ = Object.keys(H).length > 0, q = Y_1()
  if (!_ && !q && !0) return process.env        // ← typical ClaudeUI path
  let O = { ...process.env, ...H }
  if (!q) return O
  for (let T of D_1) delete O[T], delete O[`INPUT_${T}`]   // D_1 = API-key scrub list
  return O
}
```

- `QE_()` — optional hook-injected env map (usually empty)
- `Y_1()` — returns true only when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` **or** `CLAUDE_CODE_ENTRYPOINT==="local-agent"`. Neither applies to us (entrypoint is `sdk-cli`).
- `D_1` — scrub list contains `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, OAuth tokens, etc. **Does not include proxy vars.**

In our path (`!_ && !q && !0`) cli.js returns `process.env` verbatim. That env carries the proxy vars ClaudeUI set on the cli.js spawn, and every subprocess inherits them.

## Fix

Wrap every `return` in `Qk()` with a proxy-strip helper that deletes the four proxy env vars (upper + lower case) unless `CLAUDEUI_PROXY_SUBPROCESSES=1` is set by the parent (user's opt-in to "proxy everything").

The helper is defined once at the top of `Qk()`:

```js
let __cuPS = (E) => {
  if (process.env.CLAUDEUI_PROXY_SUBPROCESSES) return E
  let R = { ...E }
  delete R.HTTP_PROXY; delete R.HTTPS_PROXY; delete R.ALL_PROXY; delete R.NO_PROXY
  delete R.http_proxy; delete R.https_proxy; delete R.all_proxy; delete R.no_proxy
  return R
}
```

Every `return` path (`return process.env`, `return O` early, `return O` after scrub) is rewritten to `return __cuPS(...)`.

## Locating the function in a new CLI version

`Qk()` has a distinctive shape — do NOT search by name (minified names change). Search for the structural body:

```
function <fn>() {
  let <H> = <QE_>(), <_> = Object.keys(<H>).length > 0, <q> = <Y_1>()
  if (!<_> && !<q> && !0) return process.env
  let <O> = { ...process.env, ...<H> }
  if (!<q>) return <O>
  for (let <T> of <D_1>) delete <O>[<T>], delete <O>[`INPUT_${<T>}`]
  return <O>
}
```

The patch regex captures the nine minified identifiers and rebuilds the function body verbatim with the `__cuPS` wrapper inserted at the top and around each return.

Landmarks near `Qk()`:
- Preceded by `function QE_() { return M39?.() ?? {} }` — the env-hook accessor
- Followed by `function uB6()` — MCP allowlist env check
- Neighboring constant `D_1` (API-key scrub list) lives ~2 KB later in the same var block. Strings inside `D_1`: `"ANTHROPIC_API_KEY"`, `"AWS_SECRET_ACCESS_KEY"`, `"ACTIONS_RUNTIME_TOKEN"`.

## Gate env vars

| Env var | Set by | Effect |
|---|---|---|
| `CLAUDEUI_PROXY_SUBPROCESSES=1` | ClaudeUI when `ProxySettings.proxySubprocesses === true` | Patch no-ops; subprocesses inherit proxy |
| (unset) | default | Patch strips proxy from subprocess env |

The gate is read from `process.env` **inside each subprocess spawn call**, not cached — toggling the user's setting takes effect on the next subprocess that cli.js spawns.

## Risk / side effects

- **MCP stdio servers** that legitimately need the corporate proxy (e.g. a remote MCP server behind the same egress) will stop working under the default. User can flip `proxySubprocesses=true` to restore.
- **LSP servers** typically don't make network calls, so impact is nil.
- **Shell snapshot** (one-shot shell env dump at startup) — if the user's shell profile reads something over HTTP, it'd no longer go through the proxy. Edge case.
- If a future cli.js version adds a new return path inside `Qk()` that the patch misses, subprocesses from that path would still leak the proxy. Low likelihood since the function body is small and stable.

## Tests

See `patch/subprocess-proxy-strip/*.test.ts` (if added) — exercises `Qk()` behavior by spawning a test fixture and verifying `HTTP_PROXY` is absent from the child env under default mode and present under opt-in mode.
