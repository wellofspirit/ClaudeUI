# Patch: ci-path-remap

Generic runtime interceptor that redirects the Bun-baked `file:///home/runner/work/claude-cli-internal/claude-cli-internal/...` URLs leaking throughout cli.js so they resolve against the real extracted cli.js directory instead of the non-existent CI worker path.

## Affected Component

`@anthropic-ai/claude-code` — bundled `cli.js` file (extracted from the Bun standalone binary by `scripts/extract-cli.mjs`).

| Component | Version at time of discovery |
|---|---|
| CLI package | 2.1.114 |
| Bundled CLI (`cli.js`) | 2.1.114 |

This patch is specific to ClaudeUI's extract-and-run-under-Node deployment. The upstream Bun binary doesn't need it — Bun resolves the virtual `file:///...` URLs against its own embedded-file filesystem.

## The Problem

### What leaks

Anthropic's build-time compilation of cli.js inlines `fileURLToPath("file:///<source.ts>")` expressions that Bun later resolves through its virtual filesystem. The baked URL prefix is always:

```
file:///home/runner/work/claude-cli-internal/claude-cli-internal/
```

In v2.1.114, six unique URLs appear inside cli.js:

| # | CI subpath | Consumer module | Used for |
|---|---|---|---|
| 1 | `src/utils/ripgrep.ts` | `BsH` builtin rg resolver | Locate the bundled ripgrep binary |
| 2 | `vendor/modifiers-napi-src/index.ts` | `Ip6` | Locate `modifiers.node` native addon (modifier-key detection) |
| 3 | `node_modules/open/index.js` | `open` npm pkg | Locate sibling `xdg-open` helper (Linux browser open) |
| 4 | `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js` | `ZH1` | Locate compiled seccomp BPF filter (Linux sandbox) |
| 5 | `src/utils/claudeInChrome/setup.ts` | claudeInChrome MCP | Locate the cli.js file itself to spawn for `--chrome-native-host` |
| 6 | `src/utils/computerUse/setup.ts` | computerUse MCP | Locate the cli.js file itself to spawn for `--computer-use-mcp` |

Under Node, `url.fileURLToPath` just decodes these URLs into literal paths under `/home/runner/...` — a directory that exists only on Anthropic's CI workers.

### User-visible impact

- **#1 (ripgrep)**: Every `Grep` tool call crashes with `spawn ... ENOENT`. This is the breakage that triggered the investigation.
- **#2 (modifiers)**: Modifier-key detection silently returns `null`. Used by `Tab`-hold / `Shift+Esc` interactions in the TTY UI. Degrades UX but doesn't crash — code is wrapped in `try { ... } catch { return null }`.
- **#3 (open)**: `open` package fails to locate bundled `xdg-open` on Linux. Affects URL-open actions. `open` likely falls back to system `xdg-open`.
- **#4 (seccomp)**: Linux sandbox can't locate the seccomp BPF filter. Sandbox either fails to initialize or falls back to a less-restrictive mode.
- **#5, #6 (claudeInChrome / computerUse MCP)**: These MCP servers spawn cli.js as a subprocess with `--chrome-native-host` / `--computer-use-mcp` args. Without the fix, they try to spawn a nonexistent script and fail to initialize.

None of #2–#6 crash cli.js; each is guarded by try/catch. But all of them are time bombs — future features that exercise these paths will silently regress.

### Root cause

Bun's compiled binary treats `file:///CIroot/foo.ts` as a virtual path inside its embedded-file store — its custom `fileURLToPath`/`createRequire` implementations know how to resolve these URLs against modules embedded at compile time. Node has no such knowledge: its `fileURLToPath` is spec-compliant and just decodes the URL into a literal filesystem path.

The Bun-side resolution works because Bun's compiler rewrites the embedded file paths, preserving the semantic relationship between each source and the sibling binaries/helpers it references. When we extract cli.js out of the Bun binary, we lose that mapping entirely.

## Architecture Overview

### Extracted layout

```
vendor/claude-cli/
├── cli.js                                  ← CLI_DIR (__dirname)
├── version.json
└── vendor/
    ├── audio-capture/<archPlat>/audio-capture.node
    ├── computer-use-input/<archPlat>/computer-use-input.node
    ├── computer-use-swift/<archPlat>/computer-use-swift.node
    ├── image-processor/<archPlat>/image-processor.node
    ├── ripgrep/<archPlat>/rg                ← #1 target
    └── url-handler/<archPlat>/url-handler.node
```

Note that files from the CI source tree (`src/utils/...`, `vendor/modifiers-napi-src/...`, `node_modules/...`) are **not** mirrored — the extract script flattens binaries into `vendor/<name>/<archPlat>/`.

### Interception strategy

Every CI-baked URL in cli.js goes through `<mod>.fileURLToPath(<URL>)` where `<mod>` is `require("url")`. Property access happens at each call site, not at destructure time — so monkey-patching `url.fileURLToPath` on the shared `url` module object intercepts every call.

```
                          ┌─── url.fileURLToPath(CI URL) ──┐
cli.js call site  ────────┤                                 ├──> Node's real fileURLToPath
                          └─── [our shim intercepts here]   │
                                  │                         │
                                  ├── URL starts with CI_ROOT?
                                  │   ├── yes: look up override[subpath]
                                  │   │   ├── override hit → CLI_DIR/<synthetic>
                                  │   │   └── miss → CLI_DIR/<sub> (naive prefix swap)
                                  │   └── no: fall through to origFileURLToPath
                                  │
                                  └── return resolved path
```

The shim chooses synthetic paths such that the **downstream** `path.join` / `path.dirname` / `path.resolve` navigation in the consumer code lands on the real extracted binary. Different consumers do different navigation relative to the `fileURLToPath` result, so each override value is hand-picked.

### Override rationale

| CI subpath | Consumer navigation | Real file | Synthetic value | Why |
|---|---|---|---|---|
| `src/utils/ripgrep.ts` | `join(P, "../", "vendor", "ripgrep", <arch>, "rg")` | `<CLI_DIR>/vendor/ripgrep/<arch>/rg` | `ripgrep.ts` | Makes `dirname(P) == CLI_DIR`, so the downstream resolve lands on `vendor/ripgrep/...` |
| `src/utils/claudeInChrome/setup.ts` | `join(P, "..", "cli.js")` | `<CLI_DIR>/cli.js` | `claudeInChrome-setup.ts` | Same: `dirname(P) == CLI_DIR`, so `"../cli.js"` → `<CLI_DIR>/cli.js` |
| `src/utils/computerUse/setup.ts` | `join(P, "..", "cli.js")` | `<CLI_DIR>/cli.js` | `computerUse-setup.ts` | Same |

### Prefix-swap fallback

Unknown CI subpaths fall through to `path.resolve(CLI_DIR, <sub>)` — e.g., `vendor/modifiers-napi-src/index.ts` → `<CLI_DIR>/vendor/modifiers-napi-src/index.ts`. Downstream nav then lands on `<CLI_DIR>/vendor/modifiers-napi/<arch>/modifiers.node`, which doesn't exist (not extracted), but the consumer is wrapped in `try { ... } catch { return null }` so it fails cleanly.

The fallback is chosen to be maximally compatible with the CI source-tree navigation idioms — most consumers do `dirname(URL) + "../sibling"` or `dirname(URL) + "subfolder/..."`, and the prefix-swap preserves the relative structure. Future CI-baked URLs that follow the same convention get handled without a new override.

### Variable map in the injected shim

| Variable | Purpose |
|---|---|
| `origFileURLToPath` | Captured reference to the real `url.fileURLToPath` — used as the fallthrough for non-CI URLs |
| `CI_ROOT` | The baked CI root prefix (constant across SDK versions so far) |
| `CLI_DIR` | `__dirname` of cli.js — the actual extracted directory |
| `overrides` | Per-subpath synthetic filename map (documented above) |
| `sub` | Tail of the URL after stripping `CI_ROOT` |
| `synth` | Final name used in the resolve — either the override value or `sub` itself |

## The Patch

### Marker

`/*PATCHED:ci-path-remap*/`

### Anchor (unique, 1 match)

```
// ─── end Bun shim ──────────────────────────────────────────────────────────
```

This comment is injected by `scripts/extract-cli.mjs` right after the Bun `Module._resolveFilename` redirect IIFE. We inject our shim immediately after it so both redirect shims sit together at the top of the file. The regex matches on `// ... end Bun shim ...` to tolerate any rewording of the surrounding dashes.

### Before

```js
})();
// ─── end Bun shim ──────────────────────────────────────────────────────────
// (original cli.js code follows)
```

### After

```js
})();
// ─── end Bun shim ──────────────────────────────────────────────────────────
/*PATCHED:ci-path-remap*/
// ─── CI path remap (injected by patch/ci-path-remap) ───────────────────────
// The official cli.js bakes "file:///home/runner/work/claude-cli-internal/..."
// URLs from Anthropic's build host. Under Bun these resolve to embedded
// files; under Node they're just broken literal paths. Intercept
// url.fileURLToPath to redirect them to the real extracted layout.
(function () {
  const url = require('url')
  const path = require('path')
  const origFileURLToPath = url.fileURLToPath
  const CI_ROOT = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/'
  const CLI_DIR = __dirname
  const overrides = {
    'src/utils/ripgrep.ts': 'ripgrep.ts',
    'src/utils/claudeInChrome/setup.ts': 'claudeInChrome-setup.ts',
    'src/utils/computerUse/setup.ts': 'computerUse-setup.ts',
  }
  url.fileURLToPath = function fileURLToPathShim(input) {
    const s = typeof input === 'string' ? input : input && input.href
    if (s && s.startsWith(CI_ROOT)) {
      const sub = s.slice(CI_ROOT.length)
      const synth = Object.prototype.hasOwnProperty.call(overrides, sub)
        ? overrides[sub]
        : sub
      return path.resolve(CLI_DIR, synth)
    }
    return origFileURLToPath.apply(this, arguments)
  }
})();
// ─── end CI path remap ─────────────────────────────────────────────────────
// (original cli.js code follows)
```

### Why it's safe

- **Non-CI URLs untouched.** The `startsWith(CI_ROOT)` guard means any other `file:///...` URL falls through to the real `origFileURLToPath`. `createRequire("file:///some-other-url")` calls, user-supplied URLs, etc. all work as before.
- **Single module reference.** `require("url")` returns the same cached module object for every caller. Monkey-patching `url.fileURLToPath` is visible to all 6 CI-URL call sites in cli.js because each does property access on the cached reference (`L39.fileURLToPath(...)`, `$bq.fileURLToPath(...)`, etc.). No caller uses destructured `const { fileURLToPath } = require('url')` syntax for any of the 6 URLs.
- **`__dirname` is the real CLI dir.** The extract script emits a CJS module, so `__dirname` inside the IIFE resolves to the extracted cli.js directory — matching how the existing Bun shim already uses `__dirname`.
- **Override map is additive.** Unknown CI subpaths fall through to naive prefix swap. Adding a new override never breaks existing ones.
- **No mutation of `url` methods other than `fileURLToPath`.** `pathToFileURL`, `URL`, `domainToASCII`, etc. are all left alone.
- **Idempotent via marker.** `apply.mjs` exits early if `/*PATCHED:ci-path-remap*/` is already present.

### Anchor fallback strategy

If `scripts/extract-cli.mjs` is ever rewritten to emit a different end-of-shim comment, `apply.mjs` will fail loudly with "Cannot locate the 'end Bun shim' anchor comment." The fix is to update either the anchor regex in `apply.mjs` or the comment in the extract script — both live in this repo so drift is visible.

## How to Find This Code

### Find all CI-baked URLs in cli.js

```bash
grep -oE 'fileURLToPath\("file:///home/runner[^"]+"\)|createRequire\("file:///home/runner[^"]+"\)' \
  vendor/claude-cli/cli.js | sort -u
```

Current (v2.1.114) output — 6 unique entries. Any new entry in a future SDK version indicates a new leak that should be analyzed and potentially added to the override map.

### Find context around a specific URL

```bash
bundle-analyzer find cli.js 'src/utils/ripgrep.ts' --compact
bundle-analyzer find cli.js 'vendor/modifiers-napi-src/index.ts' --compact
bundle-analyzer find cli.js 'claudeInChrome/setup.ts' --compact
bundle-analyzer find cli.js 'computerUse/setup.ts' --compact
bundle-analyzer find cli.js 'sandbox-runtime/dist/sandbox/generate-seccomp-filter.js' --compact
bundle-analyzer find cli.js 'open/index.js' --compact
```

### Find the anchor site (end of Bun shim)

```bash
grep -n 'end Bun shim' vendor/claude-cli/cli.js
```

## Syntax Pitfalls

### Pitfall: inserting inside an expression

Our shim is a standalone top-level IIFE — it's injected between existing top-level statements (after the Bun shim IIFE's `})();`). That's safe.

If a future rewrite moves the injection inside an expression context, be aware that a full `(function(){...})();` statement won't parse there. Stick to top-level insertion.

### Pitfall: property-assignment vs `Object.defineProperty`

We use plain property assignment: `url.fileURLToPath = function ... { ... }`. Node's `url` module exports `fileURLToPath` as a writable property, so this works. If a future Node version locks down the `url` module exports, we'd need `Object.defineProperty(url, 'fileURLToPath', { value: shim, writable: true, configurable: true })` instead. Not a current concern (tested on Node 22).

### Pitfall: destructured imports would bypass the shim

```js
// If cli.js ever does this, the shim won't catch the call:
const { fileURLToPath } = require('url')
fileURLToPath(CI_URL)  // calls the original, not our shim
```

As of v2.1.114, none of the 6 CI-baked URLs use destructured imports — every site does `<mod>.fileURLToPath(...)` where `<mod>` is a module reference. If a future version introduces a destructured site, we'd need to fall back to targeted per-site source patches (replace the call at the source with `__dirname`-derived paths) or pre-populate the destructured reference inline.

**Always run `node --check cli.js` after applying patches.** `patch/apply-all.mjs` does this via node/bun/esbuild.

## What's NOT Changed

**`url.pathToFileURL`** — only the inverse direction is monkey-patched. No known code path needs `pathToFileURL` interception.

**`createRequire` return values.** One of the CI-URL sites does `require('module').createRequire(CI_URL)`. `createRequire` calls `fileURLToPath` internally (on Node ≥14), so it picks up our shim and constructs a `require` function rooted at our synthetic path. The synthetic path for `vendor/modifiers-napi-src/index.ts` is `<CLI_DIR>/vendor/modifiers-napi-src/index.ts` — a file that doesn't exist, but `createRequire` doesn't verify the file's existence. The returned require works for absolute paths (which is what the consumer passes anyway), so no breakage.

**The original CI-URL string literals in cli.js.** We don't strip them — they stay inert. If a future developer audits cli.js for home/runner paths, they'll still see them, but runtime resolution is handled by the shim.

**Per-site source patches.** We don't rewrite individual call sites to use `__dirname`. Our approach is strictly runtime-only, which means we don't have to maintain per-site regex patterns across SDK versions.

## Consumer-Side Integration

None required. Entirely runtime-only inside cli.js.

## Verification

1. `node patch/ci-path-remap/apply.mjs` — should apply the patch.
2. Run again — should report "already applied."
3. `node --check vendor/claude-cli/cli.js` — no syntax errors.
4. `node patch/apply-all.mjs` — all patches pass.
5. `node patch/ci-path-remap/test.mjs` — runs a standalone shim probe (no API key required) and asserts all 6 CI URLs resolve to expected paths. Then runs an end-to-end Grep session to cover the user-visible regression.
6. Manual test:
   - Restart ClaudeUI (or spawn a fresh session) so the patched cli.js loads.
   - Use the Grep tool from the chat.
   - Should succeed without any `spawn ... ENOENT` errors in the tool result.

## Discovery Method

1. **Started from the ripgrep regression.** Every `Grep` tool call was crashing with `spawn /home/runner/.../vendor/ripgrep/<arch>/rg ENOENT` — a CI-worker path baked into cli.js at build time.

2. **Grepped for other CI-baked URLs in cli.js:**
   ```bash
   grep -oE 'fileURLToPath\("file:///home/runner[^"]+"\)' vendor/claude-cli/cli.js | sort -u
   ```
   Six unique URLs surfaced — one already fixed (ripgrep), five latent.

3. **Traced the downstream navigation for each URL.** Extracted 150–200 chars of context around each call site and analyzed how the resolved path is used: `dirname(P) + "../..."`, `join(P, "cli.js")`, etc.

4. **Characterized two consumer patterns:**
   - **CI-layout-mirroring navigation**: e.g., `modifiers-napi-src` → `../modifiers-napi/`. A naive prefix-swap (CI_ROOT → CLI_DIR) preserves the relative structure; downstream works if extracted files mirror CI source tree, or fails gracefully via try/catch if not.
   - **CI-layout-inconsistent navigation**: e.g., ripgrep expects `src/utils/vendor/ripgrep/`, but our extract flattens to `vendor/ripgrep/`. Same for claudeInChrome/computerUse, which expect a sibling `cli.js` at `src/utils/<name>/cli.js`. These need per-URL overrides.

5. **Picked the interception point.** Two options:
   - Per-site source patches — replace each call site individually. Pro: explicit. Con: one patch per site, all need re-verification across SDK versions.
   - Runtime interceptor monkey-patching `url.fileURLToPath`. Pro: one site, scales to new URLs automatically with the override map. Con: slightly more indirection, requires confirming no destructured imports.

   Chose the runtime interceptor after verifying all 6 existing sites use property access (not destructured imports), so a single monkey-patch covers all of them.

6. **Designed synthetic paths so downstream nav lands correctly.** For each override, traced the consumer's `path.join` / `dirname` chain and worked backwards to find a synthetic base such that the chain resolves to the real extracted file.

7. **Validated with a standalone probe.** Built a small test that loads just the shim region of cli.js and exercises `url.fileURLToPath` with each known CI URL, asserting the resolved path matches the expected target (and for ripgrep, that the real binary exists on disk). All 7 cases (6 CI URLs + 1 pass-through) passed.

8. **Confirmed syntax safety.** `node --check cli.js` after patching. Re-ran `apply.mjs` for idempotency.

## Key Functions Reference

| Name (v2.1.114) | Purpose | Char offset |
|---|---|---|
| `BsH` | Builtin ripgrep path resolver | ~3832900 |
| `Ip6` | Modifiers-napi loader | ~3640000 |
| `ZH1` | Seccomp filter path builder | ~3840000 |
| `nN6` | `open` package xdg-open dir | ~2040000 |
| (inline, claudeInChrome) | Spawns `cli.js --chrome-native-host` | ~38825000 |
| (inline, computerUse) | Spawns `cli.js --computer-use-mcp` | — |

**Note:** All minified names will change in future SDK versions. Use the content searches in "How to Find This Code" to relocate.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script |
| `test.mjs` | Probe + end-to-end test |
