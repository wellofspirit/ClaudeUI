# Patch: network-unrestrict

The sandbox network proxy always starts even when no domain restrictions are configured, making it impossible to run sandboxed commands with unrestricted network access.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.59 |
| Bundled CLI (`cli.js`) | 2.1.63 |

## The Problem

### User-visible symptom

When ClaudeUI's sandbox is enabled with `restrictNetwork: false`, outbound network requests from sandboxed commands (e.g. `curl`, Jira CLI) are either blocked or trigger domain approval prompts. The first request always fails (the proxy blocks it while waiting for approval), and only the retry succeeds after the domain is added to the allowlist.

### Root cause

The sandbox network proxy startup decision is based on whether `allowedDomains` exists, not whether it has entries:

```js
// In dg5() — sandbox command wrapper
J = K?.network?.allowedDomains !== void 0 || Q3?.network?.allowedDomains !== void 0
```

- `K` = API sandbox options (from SDK consumer)
- `Q3` = merged config built by `oz1()`

The config builder `oz1()` **always** constructs `network: { allowedDomains: K, ... }` where `K` is an array — even if empty. Since an empty array `!== void 0`, the check always evaluates to `true`, and the HTTP/SOCKS proxy infrastructure always starts.

When the proxy starts with an empty allowlist:
1. Every outbound connection is intercepted
2. The domain matcher `Qz8()` checks the empty allowlist — no match
3. Falls through to the permission callback (if provided) → prompts user
4. Or if no callback → silently denied

There's **no SDK API to disable the proxy**. The `SandboxNetworkConfig` schema has no `restrictNetwork` boolean — only `allowedDomains`, `allowLocalBinding`, etc.

## Architecture Overview

### Network proxy decision flow

```
SDK consumer passes sandbox options (K)
  ↓
oz1(settings) merges settings + API options into Q3:
  Q3.network.allowedDomains = [...settings domains, ...API domains, ...WebFetch(domain:*) rules]
  (always an array, even if empty)
  ↓
dg5(command, shell, K, signal) — sandbox command wrapper:
  J = K?.network?.allowedDomains !== void 0 ||    ← API options (may be undefined)
      Q3?.network?.allowedDomains !== void 0       ← always true (empty array !== void 0)
  D = J  (needsNetworkRestriction)
  X = J  (controls proxy port setup)
  if (X) await dZ7()  ← starts proxy infrastructure
  ↓
LZ7() (macOS) / TZ7() (Linux) — platform sandbox:
  httpProxyPort: X ? FZ7() : undefined     ← proxy port or undefined
  socksProxyPort: X ? pZ7() : undefined
  needsNetworkRestriction: D
  ↓
sandbox-exec (macOS) / landlock (Linux) wraps the command
```

### Domain matching (when proxy is active)

```
Outbound connection from sandboxed process
  → proxy intercepts
  → IZ7(port, domain, callback)
    → check Q3.network.deniedDomains → block if match
    → check Q3.network.allowedDomains → allow if match
    → no match + callback → prompt user (canUseTool)
    → no match + no callback → deny
```

### Domain matcher: `Qz8(domain, pattern)`

```js
function Qz8(A, q) {
  if (q.startsWith("*.")) {
    let K = q.substring(2);
    return A.toLowerCase().endsWith("." + K.toLowerCase())
  }
  return A.toLowerCase() === q.toLowerCase()
}
```

Only supports:
- `*.example.com` — wildcard suffix match
- `example.com` — exact case-insensitive match
- **Does NOT support bare `*` as catch-all** — `"*".startsWith("*.")` is false, and no domain equals `"*"`

### Config builder: `oz1(settings)` — key section

```js
// Collects allowedDomains from two sources:
for (let X of A.sandbox?.network?.allowedDomains || []) K.push(X);  // API options
for (let X of q.allow || []) {
  let M = LX6(X);  // parse permission rule
  if (M.toolName === HX && M.ruleContent?.startsWith("domain:"))
    K.push(M.ruleContent.substring(7))  // WebFetch(domain:*) rules
}
// ...
return {
  network: {
    allowedDomains: K,    // ← always present, even if K is []
    deniedDomains: Y,
    // ...
  }
}
```

### Key variables in `dg5()`

| Variable | Source | Purpose |
|---|---|---|
| `K` (3rd param) | API sandbox options | Consumer-provided config |
| `Q3` | Set by `bg5()` from `oz1()` output | Merged sandbox config (settings + API) |
| `J` | Computed | `true` if network proxy should start |
| `D` | `= J` | `needsNetworkRestriction` — passed to platform sandbox |
| `X` | `= J` | Controls whether proxy ports are requested |
| `H` | `denyRead` paths | Filesystem read deny list |
| `j` | `{ denyOnly: H }` | Read config passed to platform sandbox |

## The Patch

### Marker

`/*PATCHED:network-unrestrict*/`

### Anchor (unique, 1 match)

The anchor is the `{denyOnly:H}` object literal immediately before the `J=` assignment, combined with the full `allowedDomains!==void 0` check pattern:

```
{denyOnly:<H>},<J>=<K>?.network?.allowedDomains!==void 0||<Q3>?.network?.allowedDomains!==void 0,<D>=<J>,<X>=<J>
```

### Before

```js
{denyOnly:H},J=K?.network?.allowedDomains!==void 0||Q3?.network?.allowedDomains!==void 0,D=J,X=J
```

The check: "does `allowedDomains` exist as a property?" — always true because `oz1()` always creates it.

### After

```js
/*PATCHED:network-unrestrict*/{denyOnly:H},J=K?.network?.allowedDomains?.length>0||Q3?.network?.allowedDomains?.length>0||Q3?.network?.deniedDomains?.length>0,D=J,X=J
```

The check: "do any domain rules actually have entries?" Three conditions:
1. API options have `allowedDomains` with entries → proxy starts (consumer explicitly configured domains)
2. Merged config has `allowedDomains` with entries → proxy starts (settings/permission rules added domains)
3. Merged config has `deniedDomains` with entries → proxy starts (need to enforce deny rules)

If all three are empty, `J = false` → proxy infrastructure is skipped → unrestricted network.

### Why it's safe

- **No behavioral change when domains are configured**: If any `allowedDomains` or `deniedDomains` exist, the proxy starts exactly as before.
- **Only affects the empty case**: When zero domains are configured (no `WebFetch(domain:*)` rules, no `sandbox.network.allowedDomains` in settings, no API options), the proxy is now skipped instead of starting with an empty allowlist.
- **Platform sandbox still active**: The filesystem sandbox (`writeConfig`, `readConfig`) is independent of the network proxy. Skipping the proxy only affects network isolation.
- **macOS early-exit preserved**: `LZ7()` has `if (!K && !M && H === undefined) return q` — when network isn't needed AND no read denies AND no write config, it skips `sandbox-exec` entirely. Our patch makes this path reachable for network-unrestricted cases.

### Dynamic variable extraction

All variables are extracted from the anchor pattern via regex capture groups:

```js
const re = new RegExp(
  `\\{denyOnly:(${V})\\},(${V})=(${V})\\?\\.network\\?\\.allowedDomains!==void 0` +
  `\\|\\|(${V})\\?\\.network\\?\\.allowedDomains!==void 0,(${V})=(${V}),(${V})=(${V})`
)
// Groups: 1=H, 2=J, 3=K, 4=Q3, 5=D, 6=D_value, 7=X, 8=X_value
```

Note: `?.` in the source requires `\\?\\.` in the regex (the `?` is part of optional chaining, not a regex quantifier).

## How to Find This Code

### `dg5()` — sandbox command wrapper (patch site)

```bash
bundle-analyzer find cli.js "allowedDomains!==void 0" --compact
bundle-analyzer find cli.js "needsNetworkRestriction" --compact
```

### `oz1()` — config builder (creates the always-present array)

```bash
bundle-analyzer find cli.js "function oz1" --compact
```

### `IZ7()` — domain check function (proxy runtime)

```bash
bundle-analyzer find cli.js "Denied by config rule" --compact
bundle-analyzer find cli.js "No matching config rule" --compact
```

### `Qz8()` — domain matcher (wildcard logic)

```bash
bundle-analyzer find cli.js 'startsWith("*.")' --compact
```

### `bg5()` — sandbox initialization (sets Q3)

```bash
bundle-analyzer find cli.js "wH.initialize" --compact
```

Fallback: search for the `wH` export object:

```bash
bundle-analyzer find cli.js "initialize:" --near 3302478 --compact
```

### `LZ7()` — macOS sandbox profile builder

```bash
bundle-analyzer find cli.js "sandbox-exec" --compact
```

### `sx6()` — default write-allow paths

```bash
bundle-analyzer find cli.js "/dev/dtracehelper" --compact
```

## Syntax Pitfalls

This patch is a simple in-place replacement (no injected statements), so there are minimal syntax risks. The main pitfall encountered during development:

### Pitfall: `?.` in regex patterns

The optional chaining `?.` in `K?.network?.allowedDomains` requires careful regex escaping. The `?` is NOT a regex quantifier here — it's a literal character in the source.

```js
// WRONG — ? makes the preceding . optional, matches K.network.allowedDomains too
`(${V}).network?.allowedDomains`

// CORRECT — escape the ? as literal
`(${V})\\?\\.network\\?\\.allowedDomains`
```

### Pitfall: bare `*` as catch-all domain

An earlier attempt passed `allowedDomains: ['*']` from the UI when `restrictNetwork` was false. This silently fails — `Qz8()` only handles `*.suffix` and exact matches. A bare `*` matches nothing, making the proxy block everything without even prompting.

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

**`oz1()` config builder** — still always creates `network.allowedDomains` as an array. The patch doesn't modify `oz1`; it only changes how `dg5` interprets the result. This is intentional — `oz1` serves other consumers that may depend on the array always existing.

**`IZ7()` domain check logic** — the proxy's runtime domain matching is unchanged. When the proxy IS started (because domains are configured), it behaves identically.

**`Qz8()` domain matcher** — no change to wildcard matching logic. The bare `*` limitation is a known SDK behavior, not something this patch addresses.

**Filesystem sandbox** — completely independent. Read/write restrictions still apply regardless of network proxy state.

## Consumer-Side Integration

In `claude-session.ts`, when `restrictNetwork` is false:

```typescript
// Only pass network config when restrictions are needed.
// Omitting allowedDomains lets the SDK skip domain filtering.
...(this.sandboxConfig.network.restrictNetwork ? {
  network: {
    allowLocalBinding: ...,
    allowedDomains: this.sandboxConfig.network.allowedDomains,
    ...
  }
} : {
  // No network restrictions — only pass binding/socket options if set
  ...(needsBindingOrSockets ? { network: { allowLocalBinding, ... } } : {})
})
```

The key: when `restrictNetwork` is false, `allowedDomains` is NOT passed in the API options. Combined with this patch, if the user's settings files also have no domain rules, `oz1()` builds an empty `allowedDomains` array, the `.length > 0` check fails, and the proxy doesn't start.

## Verification

1. `node patch/network-unrestrict/apply.mjs` — should apply patch
2. Run again — should report "already applied"
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches pass
5. Manual test:
   - Enable sandbox in ClaudeUI settings
   - Set "Restrict network access" to OFF
   - Start a new session
   - Run `curl -s -o /dev/null -w "%{http_code}" https://www.google.com`
   - Should return a HTTP status code (200/301/302) without prompting for domain approval
   - Enable "Restrict network access", add `google.com` to allowed domains
   - Start a new session, curl google → should work
   - Curl a non-whitelisted domain → should be blocked/prompted

## Discovery Method

1. **Observed the symptom**: User reported that setting `restrictNetwork: false` in ClaudeUI settings still triggered domain approval prompts when the Jira CLI made network requests. The first call always failed even after approval; only the retry succeeded.

2. **Initial (wrong) diagnosis**: Assumed the issue was that we weren't passing `allowedDomains` when `restrictNetwork` was false, and the SDK defaulted to "prompt for everything." Fixed by passing `allowedDomains: ['*']`.

3. **First fix failed**: `['*']` made things worse — `Qz8()` only handles `*.suffix` patterns and exact matches. Bare `*` matches nothing, so the proxy silently blocked everything without even prompting.

4. **Second attempt — omit `network` entirely**: Tried not passing the `network` key at all when `restrictNetwork` is false. This should have let the SDK use its defaults. Still failed.

5. **Traced to `oz1()`**: Used `bundle-analyzer decompile` on `oz1()` and discovered it always builds `network: { allowedDomains: K }` even when `K` is empty. The existence check in `dg5()` (`!== void 0`) always passes because an empty array is not `void 0`.

6. **Identified the root cause**: The check in `dg5()` tests for property existence, not for content. Since `oz1()` always creates the property, the proxy always starts.

7. **Correct fix**: Changed `!== void 0` to `?.length > 0` with an additional `deniedDomains?.length > 0` check to ensure deny rules still trigger the proxy. Verified via `curl` that the proxy no longer starts when no domains are configured.

## Key Functions Reference

| Name (v2.1.63) | Purpose | Char offset |
|---|---|---|
| `dg5` | Sandbox command wrapper — decides whether to start proxy | ~3298700 |
| `oz1` | Config builder — merges settings + API into sandbox config | ~3313101 |
| `bg5` | Sandbox initialization — calls `oz1`, stores as `Q3` | ~3295778 |
| `IZ7` | Domain check — runtime allow/deny decision per connection | ~3294371 |
| `Qz8` | Domain matcher — `*.suffix` and exact match logic | ~3294208 |
| `LZ7` | macOS sandbox profile builder (`sandbox-exec`) | ~3290964 |
| `TZ7` | Linux sandbox builder (landlock) | ~3279420 |
| `sx6` | Default write-allow paths (`/dev/stdout`, etc.) | ~3266035 |

**Note:** All minified names will change in future SDK versions. Use content patterns (string literals, structural shapes) to relocate code.

## Related Patches

None — this patch is independent. It modifies a sandbox infrastructure function that no other patches touch.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script |
