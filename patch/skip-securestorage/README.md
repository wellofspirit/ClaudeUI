# Patch: skip-securestorage

When the env var `SKIP_SECURESTORAGE` is truthy, cli.js reads and writes OAuth credentials to the plaintext file backend **only**, bypassing the OS secure store entirely — the macOS Keychain or the Windows Credential Manager.

> **The getter shape is PLATFORM-SPECIFIC, not version-specific** (verified on 2.1.177 — both bundles report the same `VERSION`, but the bundled cli.js differs per platform):
>
> | Platform bundle    | Primary backend                       | Getter body                                       |
> | ------------------ | ------------------------------------- | ------------------------------------------------- |
> | macOS (darwin-\*)  | `name:"keychain"`                     | `return COMPOSER(keychain,file)` (unconditional)  |
> | Windows (win32-\*) | `name:"windows-credman"`              | `if(<gate>())return COMPOSER(credman,file);return file` |
>
> The Windows bundle gained a **Windows Credential Manager** backend gated behind a GrowthBook flag (`tengu_windows_credman`) / `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1`. The original patch matched only the macOS unconditional body, so it worked on mac and aborted on Windows (`0 store-getter matches`). The fix no longer matches the exact body — it captures the body and **prepends** a `SKIP_SECURESTORAGE` short-circuit, so it works on both. See **Anchor 2 / Before-After** below.
>
> Note: on a default Windows install the gate is **off**, so `pf()` already returns the bare file backend — file-based credentials happen without the patch. The patch makes it deterministic (immune to the flag flipping on remotely) and, critically, stops the build pipeline from hard-aborting.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file. (ClaudeUI rebundles this into `vendor/claude-cli/bun-claude`; the patch operates on the wrapped `vendor/claude-cli/cli.js` source.)

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| Bundled CLI (`cli.js`) | 2.1.177                      |

The SDK bundles its own `cli.js`, independent of the native `claude` binary.

## The Problem

ClaudeUI's multi-account support (ADR-015) keeps a **separate `.credentials.json` per account** under a per-account `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and switches the active account by pointing cli.js at a different dir. This is impossible while the Keychain is the primary store:

1. **The Keychain is single-item.** cli.js stores one credential under service `Claude Code-credentials` (plus a `-<sha256(configDir)[:8]>` suffix for non-default config dirs). There's no per-account file we can swap.
2. **Cross-process Keychain reads prompt.** When any process other than the one in the item's ACL reads it (e.g. our app shelling out to `security`, or even cli.js under some conditions), macOS shows a "`security` wants to use your confidential information" trust prompt — on **every** read. See ADR-014 for how this bit us already.

cli.js has **no built-in flag** to disable the Keychain. `CLAUDE_SECURESTORAGE_CONFIG_DIR` only relocates the plaintext *fallback* file; the Keychain remains primary. This patch adds the missing flag.

## Architecture Overview

cli.js's credential store is a **facade** composed from two backends:

```
p1()  ──returns──>  ev9( oM8 , lK6 )
 │                    │     │     └── lK6  name:"plaintext"  → <dir>/.credentials.json
 │                    │     └──────── oM8  name:"keychain"   → `security` CLI
 │                    └────────────── ev9  composer: "keychain-with-plaintext-fallback"
 └── p1() is THE store getter — every credential read/write goes through it
```

`ev9(H,_)` builds a store object where **H is primary, `_` is fallback**:

| Method            | Behaviour in the facade                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `read/readAsync`  | try `H` (keychain); if null, fall back to `_` (file)                                 |
| `update(K)`       | write `H` (keychain); on success **delete the `_` file copy**; only on keychain failure write `_` |
| `delete`          | delete both                                                                          |
| `readAsyncStrict` | `H.readAsyncStrict?.() ?? H.readAsync()` — optional-chained                          |
| `invalidateCache` | `H.invalidateCache?.()` — optional-chained                                           |
| `mutate(K)`       | `VyH(q, K)` — read-modify-write helper                                               |

Because keychain `update` succeeds on a normal Mac and then **deletes** the file copy, the plaintext file usually doesn't even exist. That's why relocating only the fallback (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) doesn't give us file-based storage.

### The two backends

`lK6` (the file backend) — the one we want to force:

```js
lK6 = {
  name: "plaintext",
  read()       { /* readFileSync <dir>/.credentials.json */ },
  async readAsync() { /* readFile ... */ },
  mutate(H)    { return VyH(lK6, H) },              // ← present!
  async update(H) { /* mkdir + write 0600 + "Storing credentials in plaintext" */ },
  async delete()  { /* unlink; ENOENT → ok */ }
}
```

`dK6()` resolves the path: `storageDir = CLAUDE_SECURESTORAGE_CONFIG_DIR || CLAUDE_CONFIG_DIR || ~/.claude`, `storagePath = <storageDir>/.credentials.json`.

### Why returning the bare file backend is safe

`p1()` consumers only ever call `.read()`, `.readAsync()`, and `.mutate()` (44 call sites, all three present on `lK6`). The two methods `lK6` lacks — `readAsyncStrict` and `invalidateCache` — are **only ever called through optional chaining** inside the mutate helper `VyH`:

```js
function VyH(H,_){return SP5(async()=>{
  H.invalidateCache?.();                          // ?. tolerates absence
  let q=await(H.readAsyncStrict?.()??H.readAsync()); // falls back to readAsync
  ...
})}
```

So a bare `lK6` is a complete, working store. No consumer requires the two missing methods.

| Variable | Meaning                                   |
| -------- | ----------------------------------------- |
| `p1`     | store getter (patched)                    |
| `ev9`    | facade composer (`H`+`_` → fallback store) |
| `oM8`    | keychain backend (`name:"keychain"`)      |
| `lK6`    | plaintext file backend (`name:"plaintext"`) |
| `VyH`    | mutate (read-modify-write) helper         |

## The Patch

**Marker**: `/*PATCHED:skip-securestorage*/`

### Anchor 1 — facade composer name (unique, 1 match)

Located by its template-literal signature (content-stable across versions):

```
let q={name:`${H.name}-with-${_.name}-fallback`
```

Regex captures the composer fn name (`ev9`):

```
function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=\{name:`\$\{[\w$]+\.name\}-with-\$\{[\w$]+\.name\}-fallback`
```

### Anchor 2 — the store getter (unique once the composer is known)

The getter is the only **zero-arg** function whose **brace-free** body contains `COMPOSER(primary,file)`. Two shapes observed:

```js
// old (macOS, ≤ pre-credman):
function p1(){return ev9(oM8,lK6)}
// new (v2.1.177, credman-gated):
function pf(){if(v21())return cy$(OXq,s_6);return s_6}
```

Regex (composer interpolated; `cy$` shown escaped):

```
function ([\w$]+)\(\)\{([^{}]*?cy\$\(([\w$]+),([\w$]+)\)[^{}]*?)\}
```

→ `$1`=getter, `$2`=**original body** (verbatim), `$3`=primary secure store, `$4`=**file (fallback, the one we force)**. The `[^{}]*` bounds keep the match inside the one-line getter and exclude the composer **definition** (which takes args and has a braced body). Asserting exactly 1 match guards uniqueness.

### Before

```js
function pf(){if(v21())return cy$(OXq,s_6);return s_6}
```

### After

```js
function pf(){/*PATCHED:skip-securestorage*/if(process.env.SKIP_SECURESTORAGE)return s_6;if(v21())return cy$(OXq,s_6);return s_6}
```

The short-circuit is **prepended** to the captured body (`$2`) — `$4` is returned directly when the flag is set; otherwise the original body runs unchanged. This is shape-agnostic: it works for the old unconditional `return COMPOSER(...)` body and the new `if(<gate>())…` body alike. When `SKIP_SECURESTORAGE` is unset/empty → byte-identical original behaviour. When truthy → the bare file backend, so all credential I/O goes to `<CLAUDE_SECURESTORAGE_CONFIG_DIR || CLAUDE_CONFIG_DIR || ~/.claude>/.credentials.json`.

> Note: `$2` interpolates the captured body **verbatim** via `String.prototype.replace` — its literal `$` characters (e.g. `cy$`) are not re-interpreted as replacement patterns, so no `$`-escaping of the body is needed. Only the literal `$n` group refs in the replacement template are special.

### Why it's safe

- **Opt-in.** Default (no env) path is byte-identical in behaviour.
- **Interface-complete.** `lK6` has read/readAsync/mutate/update/delete; the two missing methods are optional-chained (see Architecture).
- **No write-delete bug.** We return the bare `lK6`, not `ev9(lK6,lK6)` — the facade's "delete the other copy on success" logic (which would delete the just-written file if both backends were identical) never runs.
- **File perms preserved.** `lK6.update` writes mode `0600` and chmods — same as cli.js's own fallback path.

## How to Find This Code

### Facade composer (`ev9`)

```bash
bundle-analyzer find vendor/claude-cli/cli.js 'name:`\$\{[\w$]+\.name\}-with-' --regex --compact
# or by the telemetry strings emitted on write:
bundle-analyzer find vendor/claude-cli/cli.js "plaintext_fallback_used" --compact
```

### Store getter (`p1`) — composition site

```bash
# after capturing the composer name (e.g. ev9):
bundle-analyzer find vendor/claude-cli/cli.js 'return ev9(' --compact
```

### Backends

```bash
bundle-analyzer find vendor/claude-cli/cli.js 'name:"plaintext"' --compact   # lK6 (file)
bundle-analyzer find vendor/claude-cli/cli.js 'name:"keychain"'  --compact   # oM8 (keychain)
```

### Path resolver / consumers

```bash
bundle-analyzer find vendor/claude-cli/cli.js "claudeAiOauth" --compact      # who reads the cred
bundle-analyzer find vendor/claude-cli/cli.js "CLAUDE_SECURESTORAGE_CONFIG_DIR" --compact
```

## Syntax Pitfalls

- **Escaping the composer name in the match regex.** Minified names can contain `$`. In `apply.mjs` the composer is escaped with `replace(/[$]/g,'\\$&')` before being interpolated into the match regex. The replacement template no longer interpolates the composer name (we re-use the captured body `$2` verbatim), so the old `'$$$$'` replacement-escape dance is gone — but never put a captured name into a replacement string without `replace(/[$]/g,'$$$$')`.
- **Don't return `COMPOSER(file,file)`.** It type-checks but hits the facade's "delete the other copy on success" branch on first write — deleting the credential you just wrote. Return the **bare** file backend (we prepend `return $4` where `$4` is the bare backend).
- Always run `node --check vendor/claude-cli/cli.js` after applying.

## What's NOT Changed

- **The keychain backend (`oM8`) and the facade (`ev9`) are untouched.** Default builds (no env) use them exactly as before.
- **The path resolver `dK6()` is untouched.** We rely on its existing `CLAUDE_SECURESTORAGE_CONFIG_DIR` support to point per-account dirs — no patch needed for that.
- **The auth-source precedence (`B0`) is untouched.** Env tokens (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, …) still outrank the stored credential; this patch only changes *where the stored credential lives*.

## Consumer-Side Integration

ClaudeUI sets `SKIP_SECURESTORAGE=1` (and per-account `CLAUDE_SECURESTORAGE_CONFIG_DIR`) in the cli.js spawn env via `buildEnv()` when multi-account mode is enabled. The account manager owns the per-account dirs (`~/.claude/ui/accounts/<id>/.credentials.json`), the OAuth login flow writes into the active account's dir, and switching accounts re-points the env and respawns sessions. See ADR-015.

## Verification

1. `node patch/skip-securestorage/apply.mjs` — applies; prints the captured `getter()/file/keychain` names.
2. Run again — reports "Already patched (marker found) — skipping."
3. `node --check vendor/claude-cli/cli.js` — no syntax errors.
4. `node patch/apply-all.mjs` — all patches pass + syntax check.
5. Behavioural: `node patch/skip-securestorage/test.mjs` (see test harness) — asserts file-only read/write under the flag and keychain-primary without it.

## Discovery Method

1. **Goal**: support multiple accounts without `security` prompts. Established (ADR-014) that the macOS store is keychain-primary with a plaintext fallback, and that there's no disable flag.
2. **Located the facade** via the write-path telemetry strings `plaintext_fallback_used` / `primary_and_fallback_failed`, which sit inside the composer `ev9(H,_)`. Confirmed write order: `H.update` (keychain) first, deletes the `_` file copy on success.
3. **Found the single store getter** `p1(){return ev9(oM8,lK6)}` via `return ev9(` — the one chokepoint every credential op flows through.
4. **Checked consumer method usage**: `p1().` call sites use only `read`/`readAsync`/`mutate`. Verified `readAsyncStrict`/`invalidateCache` are optional-chained inside `VyH`, so the bare file backend `lK6` suffices — avoiding a more invasive facade rewrite.
5. **Rejected `ev9(lK6,lK6)`**: the facade deletes the "redundant" copy on first successful write, which would erase the just-written file when both backends are the file. Returning the bare `lK6` sidesteps this.
6. **Patched `p1()`** with an env-gated ternary; verified `node --check` and idempotency.

## Key Functions Reference

| Name (v2.1.177) | Purpose                                              | Char offset |
| --------------- | --------------------------------------------------- | ----------- |
| `pf`            | credential store getter (patched)                   | ~2325860    |
| `v21`           | credman gate (`tengu_windows_credman` / force-env)  | ~2325490    |
| `cy$`           | facade composer (secure store + file fallback)      | ~2316152    |
| `OXq`           | Windows Credential Manager backend (`name:"windows-credman"`) | ~2324132 |
| `s_6`           | plaintext file backend (`name:"plaintext"`)         | ~2318776    |

(On a macOS-flavoured bundle the primary backend object is `name:"keychain"` instead of `windows-credman`; the patch captures whichever appears as the composer's first arg.)

**Note:** All minified names change between SDK versions. Relocate via the content patterns above (string literals + structural shapes), never by name.

## Related Patches

- None directly. Complements the native OAuth login flow (ADR-014) and underpins multi-account support (ADR-015).

## Files

| File        | Purpose       |
| ----------- | ------------- |
| `README.md` | This document |
| `apply.mjs` | Patch script  |
| `test.mjs`  | Behavioural test harness |
