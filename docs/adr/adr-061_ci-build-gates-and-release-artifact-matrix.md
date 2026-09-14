# ADR-061 — CI build gates and the release artifact matrix

**Status:** Accepted (2026-08-25) — implemented at `452318d` (gates + x64 artifact) and
`0e96475` (arm64 matrix) on `pre-release`. **Amended 2026-09-14** — mac-arm64 and
win-x64 `claudeui-server` zips; see the amendment section, which supersedes the
artifact matrix.
**Relates to:** ADR-006 (the rebundled bun-claude binary — the mechanism whose linux gap
this ADR takes a position on), ADR-058 (the `claudeui-server` artifacts this ADR ships),
ADR-056 (the headless admission model those artifacts serve).

## Context

Three gaps in the pipeline, found while diagnosing the 2026-08-25 mac CI failure:

1. **PRs never built anything.** `ci.yml` ran typecheck / lint / format / `test:ci`, but
   no bundler pass — the release workflows were the first place `electron-vite build` and
   the web bundle ran. Vite-config regressions (mixed static/dynamic chunk errors, chunk
   warnings) therefore surfaced only at push-to-pre-release, after a tag build had
   already started.
2. **The server artifacts were entirely ungated.** `build:server`,
   `build:server:compile` and their `verify:sqlite` conformance arm (ADR-058 §4-5) ran in
   NO workflow. A refactor could break the headless artifact — the deliverable of the
   whole core-extraction campaign — and nothing anywhere would go red.
3. **Releases shipped desktop only** (mac-arm64 + win-x64 zips). `claudeui-server` had
   no released form at all, and its natural deployment target is a linux box.

A fourth gap — cross-OS _tests_ first run at release time, which is how the mac-only
`fs.watch`/FSEvents test failure stayed invisible until a pre-release push — is related
but deliberately not solved here; the `ci.yml` header records the trade-off (add an OS
matrix when it becomes worth the runner cost).

## Decision

### 1. PR gates build everything buildable on ubuntu

`ci.yml`'s gates job, after tests: `bunx electron-vite build`, the web bundle, then
`build:server` + `build:server:compile` + a `--help` boot smoke of the compiled
executable. These are **gates, not artifacts** — nothing is uploaded. On ubuntu the
compile is host-native, so the exact linux-x64 executable the release workflows ship is
proven buildable and bootable on every PR, and `verify:sqlite` finally runs somewhere.

### 2. Releases ship linux server tarballs, x64 and arm64

Both release workflows (`pre-release.yml`, `release.yml`, kept mirrored) gained a
`server` matrix job — `ubuntu-latest` for x64, `ubuntu-24.04-arm` for arm64 (arm64
hosted runners are free for public repos) — each producing
`claudeui-server-<version>-linux-<arch>.tar.gz`:

    claudeui-server            (bun-compiled, host-native on the runner)
    out/web/…                  (beside the executable — ADR-058 §5)
    vendor/opencode-cli/…      (arch-native binaries, vendored by the runner's postinstall)
    vendor/pi-cli/…
    README.md                  (emitted by build-server.mjs)

Everything is host-native on both legs — compile, engine vendoring (`ensure-opencode` /
`ensure-pi` key off `process.arch` and have explicit linux-arm64 branches), and the
`--help` boot smoke — so no cross-compilation or emulation is involved. `runner.os` is
`Linux` on both legs, so every cache key in the job carries `runner.arch`; the claude
CLI source-binary cache deliberately has no cross-arch fallback (one fixed path per
version — restoring an x64 ELF onto the arm runner would extract it as if native).

The tarball is **runnable as shipped**: `resolveAppPath()` resolves to the directory
holding `out/web` (the tarball root), and every engine locator reads
`vendor/<engine>-cli` under that same root — so the engines ride along instead of being
an undocumented operator exercise. It is a _tarball_ because `actions/upload-artifact`
strips the executable bit; file modes survive only inside the archive, which is uploaded
and attached to the release as one opaque file.

The `release` job now `needs: [version, build, server]`.

### 3. The Claude engine is desktop-only in the linux artifact — stated, not silent

`vendor/claude-cli` is deliberately absent from the tarball. The Claude engine spawn
hard-requires the rebundled `bun-claude` standalone (ADR-006; `locateBunClaude()`, no
fallback), and no linux `bun-claude` can exist today: bun's ELF standalone layout is
unimplemented, so `rebundle-cli.mjs` skips ELF input fail-closed — no output binary,
nothing can silently spawn an unpatched cli.js. The release notes state the limitation
("the Claude Code engine is desktop-only for now") rather than shipping a server whose
flagship engine dies on first spawn.

**The recorded path to lifting it:** probe running the _patched_ `cli.js` under a plain
bun runtime on linux (`bun cli.js` with the extracted assets beside it) as an alternative
spawn shape to the standalone. That needs (a) a probe against the real linux 2.1.241
binary — extract+patch already works on linux CI; the open question is whether the
store-less linux layout leaves cli.js with everything it needs (ripgrep, native addons,
helper scripts) when run un-rebundled — and (b) a spawn-path change in
`locate.ts`/`getSdkExecutableOpts()` to support an interpreter+script pair. Consult
`docs/protocol-cc/` (build pipeline) before designing it. Implementing bun's ELF layout
ourselves is strictly harder for the same outcome and is ruled out.

### 4. `build-server.mjs compile` takes `--target=bun-<os>-<arch>`

Cross-targets make bun download that platform's runtime on first use. Probed 2026-08-25
from a Windows host on bun 1.3.14: **every** foreign target (`bun-linux-x64`,
`bun-linux-x64-baseline`, `bun-darwin-arm64`) fails extraction ("Failed to extract
executable … The download may be incomplete"), so cross-building works from linux and
mac hosts only — the script comment and the shipped README both say so. The release path
never needs the flag: the ubuntu runner compiles its own platform.

## Deliberately not done

- **No pure-asset bundle release.** `dist/server/` stays a build target and a CI gate;
  releasing it alongside the executable tarball would mean two artifacts whose
  difference (bring-your-own-bun vs embedded) most downloaders don't care about. Revisit
  if someone actually asks for it.
- **No `node-pty` in the tarball.** ADR-058's limitation stands: everything but
  `terminal:*` works without it; installing it beside the artifact enables terminals.
- **No mac/windows server executables and no linux desktop build.** The desktop app
  covers mac/windows hosts; `build:linux` exists in scripts if desktop-linux demand
  appears. Each is one matrix entry away when wanted.
- **No PR-time cross-OS test matrix** — gap 4 above, a separate cost decision.

## The artifact matrix, as of this ADR

| Platform    | Desktop (Electron) | Headless (`claudeui-server`)         |
| ----------- | ------------------ | ------------------------------------ |
| mac-arm64   | released zip       | — (build from source / cross-target) |
| win-x64     | released zip       | — (build from source)                |
| linux-x64   | —                  | released tar.gz (opencode + pi)      |
| linux-arm64 | —                  | released tar.gz (opencode + pi)      |

Superseded by the 2026-09-14 amendment below; kept as the state this ADR decided.

## Amendment — 2026-09-14: server zips for mac-arm64 and win-x64

Two things changed after this ADR was written. Codex joined the engine set and the
linux tarballs gained `vendor/codex-cli` (`e86e758a`). And the "no mac/windows server
executables" line under _Deliberately not done_ — "each is one matrix entry away when
wanted" — came due: the useful headless host is whatever box the operator already
has, which is often a Mac or a Windows machine, and building the server from source
there means reproducing `ensure-cli`/`ensure-opencode`/`ensure-pi`/`ensure-codex`
by hand.

**Ruling (Daniel, 2026-09-14).** macOS ships one server artifact, arm64 only, as a
zip. Windows ships one, x64 only, as a zip. Linux keeps its two `tar.gz` legs
unchanged. No ARM Windows, no x64 mac, no code-signing of the server binary.

The two new legs are **steps appended to the existing desktop `build` matrix job**,
not a second matrix. By the time they run, that job has already installed
dependencies (whose postinstall vendored all four engines), built `out/web`, and
packaged and uploaded the desktop zip — so a server artifact costs one host-native
`build:server:compile` (which carries `verify:sqlite`), a stage directory and an
archive, with no extra runner, no extra checkout and no extra `bun install`. The
matrix entries gained a `server_name` so the archive name lives in one place.

`zip`/`Compress-Archive` rather than `tar.gz` because those are the tools these two
hosts already use for the desktop artifact. On mac the executable bit rides in the
zip entry's unix mode, which `unzip` and Finder restore and Python's `zipfile` drops
— the release notes say so. On Windows there is no executable bit to lose.

**The Claude engine ships in these two, and only these two.** §3 above stands for the
linux tarballs exactly as written — no linux `bun-claude` can exist yet — but it was
never a statement about mac or windows: `rebundle-cli.mjs` produces a patched
`bun-claude[.exe]` on both, which is why the desktop app has a Claude engine at all.
It resolves from the staged layout for the same reason every other engine does:
`resolveAppPath()` (`src/server/main.ts`) settles a compiled executable on the
directory holding `out/web` — the stage root — and `locateBunClaude()`
(`src/core/sdk/locate.ts`) reads `<appPath>/vendor/claude-cli/bun-claude[.exe]`
whenever the app path is not an `app.asar` path, which a server's never is.

What does NOT come with it is a Claude sign-in. The headless server wires
`setHostAuth(null)` on purpose (`installHostAdapters()` in `src/server/main.ts`),
so `accountState()` and `buildClaudeAccountRef()` return null — the multi-account
machinery is desktop-only and `resolveActiveAccountId()` degrades to null, which is
single-account mode. cli.js then reads the deployment box's own credential store,
the same one `claude` itself uses. Nothing in the spawn path gates on the host auth
seam, so the engine runs; only the account shown in session status is absent. The
release notes state this rather than implying the zip is self-contained.

### The artifact matrix, amended

| Platform    | Desktop (Electron) | Headless (`claudeui-server`)                               |
| ----------- | ------------------ | ---------------------------------------------------------- |
| mac-arm64   | released zip       | released zip (opencode + pi + Codex + Claude Code)         |
| win-x64     | released zip       | released zip (opencode + pi + Codex + Claude Code)         |
| linux-x64   | —                  | released tar.gz (opencode + pi + Codex; bubblewrap needed) |
| linux-arm64 | —                  | released tar.gz (opencode + pi + Codex; bubblewrap needed) |

Consequence, on top of those below: the mirrored-workflow tax grows again — five more
steps in each of the two files, still kept in sync by hand. A YAML parse of both plus
a diff proving the only divergence is the pre-existing release-note wording is the
check that replaces a test here; there is no unit test for a workflow.

## Consequences

- A vite-config or server-build regression now fails the PR, not the tag build.
- Every release carries a runnable headless server for linux with two of three engines;
  closing the Claude gap is a probe-shaped follow-on, not a packaging afterthought.
- The mirrored `server` job is one more place `pre-release.yml` and `release.yml` must
  be kept in sync by hand — the price of the existing two-file structure, unchanged.
