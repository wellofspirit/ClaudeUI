# ADR-006: Rebundle Bun standalone binary instead of running cli.js under Node

**Status:** Accepted
**Date:** 2026-04-20

## Context

ClaudeUI ships Anthropic's Claude Code CLI as `cli.js`, extracted from the
official claude-code Bun standalone binary at build time. Until this ADR, we
took the extracted `cli.js`, **unwrapped** its Bun CJS IIFE, injected a
`Module._resolveFilename` shim to redirect Bun's virtual paths
(`B:/~BUN/root/<name>.node`) to paths under `vendor/claude-cli/`, vendored
ripgrep and the native addons separately, and spawned the result under
Electron's own Node runtime via `ELECTRON_RUN_AS_NODE=1`.

This worked, but the impedance mismatch between Node and Bun kept biting us:

- `cli.js` carries absolute `file:///` URLs baked in by Anthropic's per-OS
  CI runner (`/home/runner/work/...` on Linux/macOS, `D:\a\...` on Windows).
  Under Bun these resolve to embedded files via Bun's module graph; under
  Node they decode to literal paths that don't exist on any user machine.
- We had a `ci-path-remap` patch that monkey-patched `url.fileURLToPath` to
  remap **one** CI root (`file:///home/runner/work/claude-cli-internal/...`).
  Anthropic's Windows CI uses a different workspace root (`D:\a\...`), which
  the patch missed — producing `spawn D:\a\claude-cli-internal\...\rg.exe
ENOENT` on every Grep tool invocation from Windows builds.
- Every Anthropic CI layout change (new runner, new repo name) is a silent
  regression risk.
- The per-build pipeline maintained two custom shims (Bun-path shim + CI-path
  remap), each a maintenance tax against upstream minifier changes.

The alternative is to stop fighting Bun's runtime and run `cli.js` inside it.
Shipping Anthropic's binary verbatim isn't an option — we apply 13 behavioral
patches to `cli.js` (subagent streaming, control subtypes, sandbox fixes,
etc.), and Anthropic's signed binary embeds a signed `cli.js`.

## Decision

**Extract `cli.js` from Anthropic's Bun standalone binary, apply our patches
to it, and re-inject the patched `cli.js` back into the Bun binary.** Ship the
resulting `bun-claude[.exe]` and spawn it natively — no Electron-as-Node, no
Node-compatibility shims, no separately vendored ripgrep/addons.

The rebundle (`scripts/rebundle-cli.mjs`) is a surgical edit of the Bun
binary's payload section. It:

1. Parses the container (`.bun` section on PE, `__BUN,__bun` section on
   Mach-O) to locate the 8-byte LE blob-size header + serialized module graph
2. Walks the module graph, replaces `cli.js`'s `contents` bytes with our
   patched version, preserves everything else (the native addons, helper
   scripts, argv, entry point) byte-for-byte
3. Drops each module's baked-in JSC bytecode. Bun recompiles from source on
   first run — costs ~160 ms of cold-start, saves ~100 MB in the output
4. On Windows: shrinks the `.bun` section to fit the new blob, strips the
   now-invalid Authenticode cert table, truncates the file. 235 MB → 137 MB.
5. On macOS: keeps the `__BUN` section at its original size via zero-padding,
   so `__LINKEDIT` and the code-signature blob stay at their original
   offsets. Then auto-runs `codesign --force --sign -` (ad-hoc) and
   `xattr -c` so the binary runs on Apple Silicon without Gatekeeper prompts.

The format details are reverse-engineered from Bun's
`src/StandaloneModuleGraph.zig`. No integrity check / SHA / compression is
applied to the serialized graph; the only alignment constraint is that
non-empty bytecode must start at `offset % 128 == 120`, which we sidestep by
dropping bytecode entirely.

## Consequences

### Retired

- `patch/ci-path-remap/` — Bun natively resolves its own baked `file:///`
  URLs via the virtual module graph
- `ELECTRON_RUN_AS_NODE=1` env dance in `getSdkExecutableOpts`
- Injected `Module._resolveFilename` shim in `scripts/extract-cli.mjs`
- CJS-IIFE-unwrap transform in the extract pipeline
- Separately vendored `ripgrep`, `audio-capture.node`, `image-processor.node`
  (and on Mac: `computer-use-swift.node`, `computer-use-input.node`,
  `url-handler.node`) — all stay embedded in the rebundled binary
- `NODE_PATH` injection to help the unwrapped `cli.js` find `ws`/`undici`/etc.

### New pipeline

```
downloads.claude.ai/...../claude[.exe]   (upstream Bun binary)
      │
      ▼
scripts/extract-cli.mjs                  (extract wrapped cli.js bytes)
      │
      ▼
vendor/claude-cli/cli.js                 (Bun CJS IIFE, ready for patching)
      │
      ▼
patch/apply-all.mjs                      (14 behavioral patches, idempotent)
      │
      ▼
scripts/rebundle-cli.mjs                 (re-inject patched cli.js, re-sign)
      │
      ▼
vendor/claude-cli/bun-claude[.exe]       (shipped artifact)
```

### Spawn model

Before:

```ts
spawn(electronHelper, [cliJsPath, ...buildArgs()], {
  env: { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: appNodeModules }
})
```

After:

```ts
spawn(bunClaudePath, [...buildArgs()])
```

`src/main/sdk/query.ts` takes a new `standaloneExecutable?: boolean` option
(defaults to `true`) that skips injecting `cliPath` as the first argv entry
— the executable is self-contained.

### Trade-offs

- **Cold-start**: +160 ms on first launch for JIT recompile (was free when
  bytecode shipped). Acceptable; measured on Windows 10/11, arm64 Mac
  expected similar.
- **Installer size on Windows**: +124 MB vs the old 13 MB `cli.js` alone
  (after extraResources filter drops the redundant `cli.js` copy). Worth it
  — we stop reassembling `ripgrep`/`audio-capture`/`image-processor` ourselves
  and absorb whatever else Anthropic bundles on each version bump for free.
- **Installer size on Mac**: no change (~195 MB). Mach-O path keeps the
  `__BUN` section at original size via padding; shrinking would require
  rewriting `__LINKEDIT` offsets and the code-signature descriptor. Optimize
  later if size becomes an issue.
- **Wrapped `cli.js`**: the extracted `cli.js` at `vendor/claude-cli/cli.js`
  is now the Bun CJS IIFE form, not a Node-runnable script. Still readable
  by `/bundle-analyzer` and text patches, but no longer runnable via
  `node cli.js` for ad-hoc testing. Rebundling takes ~270 ms, so the
  iteration loop is still fast (`node patch/<name>/apply.mjs && node
scripts/rebundle-cli.mjs`).
- **Rebundler is platform-specific.** PE (Windows) and Mach-O (macOS)
  implemented. ELF (Linux) is a follow-up; the extract path already works
  cross-platform via `lastIndexOf(BUN_MAGIC)`, but the writer doesn't.
- **Binary is unsigned after modification.** Windows never required signing
  to execute. macOS needs at minimum ad-hoc signing on Apple Silicon; the
  rebundler invokes `codesign --force --sign -` automatically when running on
  darwin. The existing `build:mac` script's `codesign --deep` on the final
  `.app` bundle re-signs our binary as part of the app's own signature.

### Regression history

This ADR supersedes the approach documented via the `ci-path-remap` patch
(added 2026-04-19, retired 2026-04-20). That patch was a band-aid over a
fundamental mismatch; this ADR addresses the root cause.
