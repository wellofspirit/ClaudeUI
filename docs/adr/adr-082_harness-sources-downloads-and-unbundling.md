# ADR-082: Harnesses run from ClaudeUI's managed copy or the system install, ClaudeUI downloads and updates its copies, and the installer stops shipping opencode, pi and Codex

**Status:** Accepted (2026-09-30, confirmed by the owner; arcs 2 and 3 landed; proposed 2026-09-28; §3 and §5 amended 2026-10-06). The design is
owner-ruled from mockups `8bf84c23` (design 1, the Harnesses rows), `04c3853c` (the sidebar update
button) and `b51cb3df` (the upgrade sheet and the download offers). Implementation is arcs 2 and 3
of the 3.6 line, after [ADR-081](adr-081_claudeui-owned-judge-transport.md); arc 3 (§8,
unbundling) is complete: the engines are unbundled (S7a) and ClaudeUI offers them (S7b), and
writes no key into one that is not installed (S7d), and a ChatGPT disconnect takes out only the
sign-ins ClaudeUI put into pi and opencode (S7e), and a provider created in ClaudeUI is usable in a
harness that holds its own key (S7f), all "As built" in §8.
**Amends:** [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (the Engines rail
group becomes Harnesses and gains a first page), [ADR-079](adr-079_claude-harness-capability-gating-and-patch-set.md)
(`CLAUDEUI_CLAUDE_CLI` gets a setting; "respawn follows the configured harness" extends to every
harness), [ADR-061](adr-061_ci-build-gates-and-release-artifact-matrix.md) (release artifacts lose
three engine directories), [ADR-066](adr-066_codex-fourth-engine.md) (Codex is downloaded, not
bundled; ClaudeUI's own copy stays at the pin, and a System Codex from the floor up to the ceiling
runs as untested, §3).
**Amended 2026-10-06 (owner ruling), every floor equals its tested version.** The floor exists
so a release can rely on what its pin does without keeping a second code path for older builds,
and ClaudeUI's own copy (bundled Claude Code, the managed opencode, pi and Codex) is always the
pin, so a lower floor only ever served a System install. Each bump therefore moves the floor with
the pin unless a lower version is measured and worth keeping: Claude Code 2.1.290 (was 2.1.275 —
this also drops 2.1.285–2.1.287, whose background-Bash timeout did not exempt the `claude-desktop`
entrypoint), Codex 0.160.1 (was 0.156.0), pi 1.0.4 (was 0.87.1). opencode stays at floor 1.18.32
below its pin 1.18.34 pending the 2.x decision. pi reached 1.x, so its ceiling is the next major
like the others, 2.0.0; the temporary 1.1.0 of the 1.0.2 bump is retired.
**Amended by:** [ADR-092](adr-092_model-catalogs-per-engine-and-a-clean-boot.md) (2026-10-05) — a harness change re-fetches only that engine's models in the composer (per-engine reload counters), not every engine's.
**Relates to:** [ADR-052](adr-052_remote-auth-passkeys-capabilities.md) (the capability that gates
installs from a remote device), [ADR-035](adr-035_pi-engine-backend.md), [ADR-019](adr-019_opencode-engine-backend.md).
**Amended by:** [ADR-093](adr-093_opencode-v2-only.md) (accepted 2026-10-06; lands with the opencode 2.x arc at S10) — manifest coordinates and ceiling. As built: ADR-093 §1 (S1: `@opencode/cli-<plat>` 2.0.24, floor = tested, ceiling 3.0.0).

## Context

A Windows installer carries about 780 MB of engine binaries. Claude Code's rebundled `bun-claude` is
130 MB of that; opencode (165 MB), pi (109 MB) and Codex (378 MB) are the rest, measured in
`dist/win-unpacked/resources`. Every user downloads all four, whichever they use.

Each engine is found only at its vendored path. `locateBunClaude()` has the `CLAUDEUI_CLAUDE_CLI`
override from ADR-079; opencode, pi and Codex have no override at all, and `codex-locate.ts` says
"vendored paths only, never PATH". A user who already has opencode or Codex installed runs a second
copy they didn't choose.

The engines are coupled to their versions in different ways:

- Claude Code: chat works on any build (ADR-079). Voice and live streaming need the patched build.
- opencode: a hand-written HTTP client and a config schema snapshot. Once ADR-081 lands, nothing
  depends on the fork.
- pi: two `-e` extensions against pi's extension API, and hand-maintained RPC types. Nothing checks
  the version at runtime.
- Codex: protocol types generated from the pinned binary. `CodexAppServerClient.checkVersion` refuses
  anything that doesn't print exactly `codex-cli <pin>`.

So "run whatever is installed" can't be one rule. Codex needs its exact version. The others need a
floor and a tested version.

## Decision

### 1. Names

A **harness** is the program ClaudeUI runs: Claude Code, opencode, pi, Codex. The Settings rail group
"Engines" becomes **Harnesses**. Its first page manages the programs and is named **Installed** (owner, 2026-09-30). The existing
per-harness pages follow it unchanged, with "Claude" renamed "Claude Code". Arc 2 includes a copy
pass so the rest of the UI (welcome picker, dispatch targets, provider engine pills) uses one term.

### 2. Two sources per harness

Each harness row has a segmented control and a version dropdown:

| Harness      | Left segment                           | Right segment                       | Version dropdown                         |
| ------------ | -------------------------------------- | ----------------------------------- | ---------------------------------------- |
| Claude Code  | **Bundled** (the patched `bun-claude`) | **System**                          | Bundled: locked to the shipped version   |
| opencode, pi | **ClaudeUI** (a managed download)      | **System**                          | ClaudeUI: Latest, Tested, or one version |
| Codex        | **ClaudeUI**                           | **System**, tested or untested (§3) | ClaudeUI: locked to the pin              |

- **System** is the newest compatible install detection finds. The row shows its version and path
  read-only. ClaudeUI never modifies, updates or deletes a system install.
- **Latest** follows upstream's newest release and is marked untested. **Tested** follows the version
  this ClaudeUI release pins, so it moves when ClaudeUI updates. Choosing a version keeps it.
- Switching to System keeps the last ClaudeUI choice, greyed out, so switching back restores it.
- A System segment is disabled when nothing usable was found, and the row's description says why
  (not found, too old, incompatible).
- A System Codex newer than the pin is allowed and labelled untested (owner, 2026-09-30). Earlier
  drafts offered System Codex only when it printed the exact pin; Homebrew, scoop and WinGet ship
  newer releases and the standalone installer updates itself, so that segment would almost never
  have been usable. The generated protocol types still describe the pin.
- A System pi runs under Node (owner, 2026-09-30). npm, the pi.dev installer and Homebrew all install
  pi as a Node script (`dist/bundle/cli.js`, `engines.node >=22.19.0`); a native pi exists only
  where someone unpacked a release archive by hand. ClaudeUI spawns `<node> <cli.js>` itself, never
  the `.cmd` or `sh` shim, so node is the pi process and signals and process-tree kills reach it
  directly. The node is chosen in this order: the install's own node (the managed installer's
  `pi-node`, Homebrew's `node`, a `node` beside the npm shim) when it is 22.19 or newer, then the
  first suitable `node` on PATH, then Electron itself with `ELECTRON_RUN_AS_NODE=1` (Electron 43
  embeds Node 24). `claudeui-server` has no Electron, so it needs a system node. The resolver's
  answer carries a launch (`command`, leading `args`, `env`) for this, and every spawn site composes
  its argv from it; the choice of node is arc 2, S2b.
- The setting lives in `~/.claude/ui/harnesses.json` as `selections.<harness>: { source, version }`,
  written only by the main process. It is not a field of `engines/<harness>.json`: that file is
  replaced whole on every save, and renderer screens save their own snapshots of it, so an unrelated
  settings save could revert a harness choice (arc 2, S1). Unknown keys survive a save. A new or
  respawned session reads the choice at spawn; a running session keeps its binary (ADR-079's respawn
  rule, extended).
- One resolver (`src/core/harness/resolve.ts`) decides the executable for every harness: the
  per-harness environment override, then the selection, then the bundled copy. A selection that
  cannot be honoured (a version not installed, no usable System install) falls back to the
  bundled copy and says why. Since §8 only Claude Code has a bundled copy: for opencode, pi and
  Codex such a selection resolves to nothing, with the reason. The answer is cached per harness
  and recomputed on an install, a selection change or a finished detection, so status checks do
  no disk work.
- A System selection reads the detection cache (`~/.claude/ui/harness-detection.json`, §3) and
  never probes. The cache is a file in the user's home, so a record is checked against the files it
  names before it is spawned (`src/core/harness/system-source.ts`). That catches a stale, corrupt or
  hand-edited record; it does not defend against someone who can write `~/.claude`, who could
  equally add a hook to `settings.json`. The resolver takes the newest install whose version is
  still tested or untested under this build's manifest, and uses it only while the file that runs,
  and a disk node for pi, still has the size and mtime detection saw, and while its cached launch
  is the one detection would have built for those files: a native install runs as its fingerprinted
  path; pi runs as the fingerprinted node with `cli.js` as its only leading argument, no environment
  but the pi.dev launcher's `PI_MANAGED_INSTALL_ROOT` (a directory above the script), and at most
  that node's directory on PATH. The launch is rebuilt from those checked fields. For pi on
  Electron's own Node the cached command is ignored and rebuilt from the running app's executable,
  so an app update does not strand it; `claudeui-server` has no Electron, and such an install is
  not usable there. A stale or missing cache, or a record that does not match its files, falls back
  with the reason and asks for a background re-detection; the next resolution after it finishes
  picks up the result.
- A launch's PATH entries (pi.dev's `pi-node`) are prepended to the spawn site's own PATH when the
  process starts, never captured from the PATH detection saw.
- pi on Electron's own Node needs `ELECTRON_RUN_AS_NODE=1`, which no child of pi may inherit: an
  Electron app pi's bash tool opens would start as plain Node. The launch also sets the marker
  `CLAUDEUI_PI_ELECTRON_NODE=1`. ClaudeUI's bridge extension deletes `ELECTRON_RUN_AS_NODE` when
  pi loads it, before any tool runs, and the subagent extension puts it back only in the
  environment of the pi it spawns. A subagent pi loads no extensions, so its own children still
  inherit the variable.

### 3. Detection classifies, it doesn't just list

Detection searches PATH, the npm global prefix, and each harness's own install directories. On macOS
and Linux it also reads the login shell's PATH once, because an app started from the Finder doesn't
get it. A Windows npm `.cmd` shim resolves to the real executable, because signals and process-tree
kills need the real process; for pi that is its `cli.js`, run under node (§2).

Each candidate runs `--version` in an isolated environment and gets one of four labels:

- **tested**: equals the pin.
- **untested**: at or above the floor and below the ceiling, and not the pin. This includes versions
  older than the pin. Selectable.
- **too old**: below the floor. Listed, not selectable.
- **incompatible**: at or above the ceiling, or output that is not a version. Listed, not
  selectable. A pre-release of the ceiling counts as the ceiling.

Detection runs in the background, never on a spawn (`src/core/harness/detect/scheduler.ts`):
once for every harness a few seconds after the app or `claudeui-server` starts, and again for a
harness when the resolver finds its cache missing or stale. One run is in flight at a time, and
requests made during it are merged into one follow-up. Each run writes the cache and invalidates
the resolver for the harnesses it detected, so the next spawn reads the new answer and nothing waits
on a `--version` probe.

Each harness declares its floor and ceiling in the release manifest (§5). The ceiling is exclusive
and is the next major version, so a new major is never "untested but selectable": opencode 2.x
(`@opencode/cli`) ships an executable named `opencode` whose configuration is incompatible with
1.x. The ceilings are Claude Code 3.0.0, opencode 3.0.0 (2.0.0 until the ADR-093 arc moved it to
2.x), pi 2.0.0 and Codex 1.0.0. Codex is
0.x, where a minor release may break in semver terms; its ceiling is set at 1.0.0 anyway, because
what ClaudeUI depends on (Codex's app-server protocol) is what the tested version is checked
against. pi has shipped breaking changes in minor and even patch releases, so its next-major
ceiling is no stronger a promise. This is a judgement call, not a guarantee; the untested label is
what warns.

Every floor equals its tested version unless a lower one is measured and worth keeping (owner,
2026-10-06; see the amendment above): a bump moves the floor with the pin. The Claude Code floor
was 2.1.275 until then (owner, 2026-09-30), the build the protocol docs relied on
(`--forward-subagent-text` from 2.1.211, subagent and skill fixes through 2.1.275). opencode was
the one exception (floor 1.18.32 below tested 1.18.34) until ADR-093 moved it to 2.x with floor =
tested.

### 4. Downloads

- Sources are official only: the npm registry for opencode (`@opencode/cli-<os>-<arch>`), GitHub releases
  for pi and Codex. The pipelines `ensure-*.mjs` use today are the reference.
- Every download is checked before first use. A tested version is checked against a SHA-256 reviewed
  into this repo, in the harness's release manifest (§5). Any
  other version can only be checked against the publisher's own hash (npm's `integrity`, pi's
  `SHA256SUMS`). That catches corruption but not a compromised release, and the UI labels it
  untested. A mismatch deletes the file and stops. There is no override.
- After the hash, `--version` must print the expected version.
- Installs go to `~/.claude/ui/harnesses/<harness>/<version>/` by atomic directory rename. The
  directory holds the payload in the same layout as the bundled `vendor/<harness>-cli` directory,
  plus an `install.json` (harness, version, platform, arch, install time, and whether it was checked
  against a reviewed digest or only the publisher's) written last; a directory without a valid one
  is not an install. A version directory is never overwritten, because a running `opencode serve` holds its binary open (Windows
  returns EPERM). Versions no session uses are removed after seven days. The desktop app and
  `claudeui-server` share the directory.
- The page shows the active download as a progress pill in its top-right corner; several downloads
  show a count that opens the list.

As built (arc 2, S3; `src/core/harness/install/`):

- Hosts. opencode comes from `registry.npmjs.org` only: the metadata of
  `@opencode/cli-<os>-<arch>@<version>` (1.x: `opencode-<os>-<arch>`; ADR-093 §1) names the
  tarball, which must itself be on
  `https://registry.npmjs.org/`, and only `package/bin/opencode[.exe]` is kept. pi and Codex come
  from `github.com/<owner>/<repo>/releases/download/...`, whose redirect may go only to
  `release-assets.githubusercontent.com` (the one host those assets redirected to when this was
  written). The Codex LICENSE comes from `raw.githubusercontent.com` at the pinned commit. pi's
  version list comes from `api.github.com`. Every request is HTTPS, redirects are followed by hand
  and checked hop by hop, and any other host fails the install. Requests go through the same
  proxy-aware `fetch` as the judge (`services/net-fetch.ts`).
- `verified` in `install.json` is `reviewed` when the version is the manifest's tested one and every
  reviewed digest matched: opencode's tarball `integrity` and `binarySha256`; pi's `archiveSha256`
  and its `SHA256SUMS` entry; Codex's `archiveSha256` and `binarySha256` for `codex` and
  `codex-code-mode-host`, and `licenseSha256`. Any other version is `publisher`: npm's `integrity`
  or pi's `SHA256SUMS` only. Codex installs its tested version only; any other version is refused
  before anything is downloaded. A version outside [floor, ceiling) is refused the same way.
- Limits: 400 MB of downloads per install, 30 s for a response to arrive and 30 s without data
  while a body streams. Downloads stream to disk and are hashed as they arrive. Archives are
  unpacked by one dependency-free reader (`archive.ts`, tar.gz and zip); an absolute path, a drive
  letter, a `..` segment, a symlink or hardlink, or a duplicate entry anywhere in an archive fails
  it. After the checks, the staged executable's isolated `--version` must print the version being
  installed.
- Staging. An install is built in `<store>/.staging/<harness>-<version>-<random>/`, with its
  archives in a sibling `.downloads` directory that is removed first. `install.json` is written
  last and the directory is renamed to `<store>/<harness>/<version>/`. An existing valid version
  satisfies the request without a download; an invalid one (no or a bad `install.json`, no
  executable) is renamed into `<store>/.trash/` first. Any failure or cancellation removes the
  staging directories. `.staging` and `.trash` entries untouched for an hour are removed at the
  next install or retention run.
- One install per harness and version runs at a time, and concurrent requests share it; at most
  two installs run at once. Progress is reported per phase (resolving, downloading, verifying,
  extracting, checking, done or failed), at most four times a second.
- Retention. When the resolver picks a managed version it touches `<version>/last-used` (once per
  resolution; resolutions are cached, so not per spawn). A version directory is removed when it is
  not the tested version, not the version the selection names (an exact version, or for Latest the
  newest installed; this holds while the source is System too), not the managed version the
  resolver runs now (a session spawned from it may still be running), and `last-used`, or else
  `install.json`'s `installedAt`, is more than seven days old. Removal renames the directory into
  `.trash/` first; a rename that fails because a process holds a file is skipped and retried at the
  next run. Retention runs in the background after the boot detection run (`afterBoot` of
  `startDetectionScheduler`), never on a spawn path, and logs one line with its counts.
- Upstream versions (`upstream.ts`) are stable releases in [floor, ceiling), newest first: opencode
  from the registry's abbreviated document of this host's platform package, pi from GitHub's
  release list (no drafts or prereleases, and only releases carrying this host's asset and
  `SHA256SUMS`), Codex always its tested version. Answers are cached for an hour, failures for five
  minutes.

### 5. The release manifest

Each ClaudeUI release carries one manifest per harness, `src/shared/harness-manifests/<harness>.json`:
the tested version, the floor, the ceiling, the download coordinates per platform, and the reviewed
digests. It replaces the `package.json` pins (`opencodeCliVersion`, `piCliVersion`,
`codexCliVersion`) and the `scripts/*-digests.json` files as the source of truth for what "Tested"
means; the `ensure-*` scripts and CI cache keys read it. `claudeCliVersion` stays, because Claude
Code stays bundled; the Claude manifest's `tested` matches it. Floors equal tested versions (§3).

### 6. Updates

- A global setting, **Install updates: Automatically | Ask me**, defaults to Ask me.
- In Ask me mode, a button appears in the main sidebar's footer, to the left of Remote Access,
  when a ClaudeUI-managed harness on Latest or Tested has something newer. It takes the footer's
  `ml-auto` so Remote and Settings stay right-aligned. One click updates every such harness. Its
  states are a count badge, a spinner while updating, a check that fades after five seconds, and
  amber after a failure. Clicking during or after an update opens a small panel naming each harness,
  its versions, and any failure with its reason.
- Bundled Claude Code and Codex move only with ClaudeUI releases. System installs update themselves.
  Neither counts toward the button. (Superseded for Codex by resolved question 6: a release that
  moves the pin offers it as an update; see §8 "As built".)
- Latest combined with Automatically is allowed, with a warning on the row.

As built (arc 2, S6; `src/core/harness/install/updater.ts`, `Sidebar/HarnessUpdateButton.tsx`):

- The setting is `updates: 'auto' | 'ask'` at the top level of `~/.claude/ui/harnesses.json`,
  beside `selections`; missing or unrecognised reads as `ask`. It is written only through
  `harness:set-update-mode`, and a selection save keeps it (and every other unknown key). On the
  Installed page it is its own **Updates** group under the harness rows: a segmented control and a
  "Check for new versions" row with Check now.
- What counts as an update (`computeUpdates`, pure): a harness whose selection is `managed` and
  whose ClaudeUI choice is Latest or Tested, when the version that choice names is newer than the
  newest version of that harness in the store, and the store holds at least one. Latest names
  upstream's newest as last checked; Tested names the manifest's `tested`. An exact version, a
  System selection (even with a ClaudeUI version kept for switching back) and Claude Code never
  count; Codex counts for Tested only (since arc 3, S7a: resolved question 6). An empty store is
  not an update: a first install is not.
- Checks. After the boot detection (`afterBoot`, after retention) and every six hours on an
  unref'd timer, the updater asks upstream (`upstream.ts`, cached an hour) for the newest version
  of each harness on Latest with something installed; Tested needs no network. Check now
  (`harness:check-updates`) accepts an upstream answer at most a minute old, so it reaches
  upstream without repeated clicks hammering it. A failed answer keeps the last good one. The
  background checks are off under `CLAUDEUI_DISABLE_HARNESS_DETECTION=1`, like detection; the
  commands still work.
- The update set is recomputed from memory on every `harness:state` read (the last upstream
  answers, the selections, the store): the snapshot's `updates` carries the mode, the available
  updates and the updater's status (`running`, `lastCheckedAt`, `lastRunAt`, which names the
  current or last run, and that run's results). No network in the snapshot.
- Runs. One at a time, one install after another, through the S3 installer; Update all during a
  run joins it. Automatically: a check that finds updates starts a run itself, and so does
  switching the setting to Automatically. Ask me: nothing installs until Update all. One info line
  per update. A run's results stay until the next run starts; a failure whose version was
  installed some other way is dropped. Selections never change: Latest and Tested already point
  at the new version. The old version stays until retention removes it (§4).
- Clients hear `harness:changed` for every harness whose update entry changed after a check, and
  for a run's harnesses when it starts and ends; progress rides `harness:install-progress`.
- Commands, all `admin` and pinned (§7): `harness:set-update-mode {mode}`, `harness:update-all`
  (resolves when the run ends, answering `harness:state`; a remote invoke that times out at 30 s
  is a run still going, and the client says so), `harness:check-updates`.
- The footer button follows mockup `04c3853c`: a count badge (Ask me with updates; one click
  installs them all and opens the panel), a spinner (a run, this client's Update all, or an install
  of an available update in flight), a check for five seconds after a run that installed
  everything, then a fade, and amber while a failure is not dismissed. Automatically never shows
  the count. The panel lists each harness with `from → to`, its install phase and progress, a
  check, or the failure's reason with a dismiss; Update all (Ask me) or Retry (after a failure),
  Check now, and "Harness settings", which opens Settings › Harnesses › Installed. Dismissing a
  failure is per client and per run, so a retry that fails again shows again. A connection
  without `admin` sees the same state with the actions disabled.
- Latest with Automatically shows "Installs untested releases automatically", warning-toned, on
  that harness's row.

### 7. Remote devices

Installing a binary from a phone is close to remote code execution. Download, update and source
changes need the admin capability (ADR-052). Other devices see the page and the footer state
read-only.

### 8. Unbundling (arc 3)

After arc 2 ships, the installer, the release zips and the Linux server tarball drop
`vendor/opencode-cli`, `vendor/pi-cli` and `vendor/codex-cli`. `postinstall` and CI fetch into the
same managed store, so development and integration tests exercise the download path. Claude Code
stays bundled, and so does `audio-capture.node`, which voice loads from `claude-cli/vendor`.

Upgrading from a bundled release (owner, 2026-09-30): on the first launch without the bundled
engines, ClaudeUI shows one sheet listing the harnesses this profile has used, with one Install
button for their Tested versions. "Used" means past sessions only (owner, 2026-09-30, resolved
question 8): ClaudeUI's own database records every session's harness (`session_meta.engine_id`), so
the count needs no harness installed; a sign-in or a config file alone does not count. Nothing downloads without that click;
the sheet does not come back once answered. A harness the sheet skipped is offered again when a
session on it is opened.

As built (arc 3, S7a; the upgrade sheet and the per-session download offers are S7b):

- The resolver. `bundledRoots` became Claude Code's alone (`bundledClaudeVersion`,
  `bundledClaudePath`). For opencode, pi and Codex the order is the environment override, then
  the selection — `managed` from the store, `system` from detection — then nothing: `path: null`
  with the selection's reason: "<Label> <version> is not installed", "No version of <Label> is
  installed" for Latest with an empty store, or the System reason. There is no fallback to a
  vendored or packaged copy, even one an older checkout left in `vendor/`, and an unusable System
  choice does not fall back to ClaudeUI's copy either: the row says why nothing runs. A saved
  `bundled` selection for them (never offered) reads as the default, Tested.
  `harnessAvailable`, `engine:is-installed` and dispatch availability follow, since they read
  the resolver. `harnessUnavailableMessage` names `bun run ensure-<id>` in a development tree
  (not for a System choice, which that copy would not serve).
- The Installed page (`harness-view.ts`). "Bundled with ClaudeUI" and "running the bundled copy"
  are Claude Code's alone. An empty store reads "<tested> is not installed · Install" (the
  row's actionable state, checked before the unavailable line); a System choice that cannot run
  is the unavailable line with its reason; Codex installed reads "Exact version this ClaudeUI
  release speaks · <pin>". An environment override runs instead and offers no Install.
- Codex updates (resolved question 6). `computeUpdates` counts Codex for its Tested choice when
  the pin is newer than the newest Codex in the store and the store holds one; a saved Latest
  never follows upstream for Codex, and the updater never asks upstream about it.
- `ensure-*`. `scripts/ensure-{opencode,pi,codex}.mjs` are thin wrappers over
  `scripts/ensure-harness.mjs`, which calls `installHarness(id, <tested>)` from
  `src/core/harness/install/installer.ts` under bun (`scripts/build.mjs` spawns `bun`), so the
  target is the managed store, `CLAUDEUI_HARNESS_STORE` honoured. A valid install is kept.
  `update-*` (`--force`) moves the installed tested version aside (`moveToTrash`: renamed into
  the store's `.trash/` and removed there at once; a locked file stays until released) and
  installs it again; it fails, changing nothing, only when the move is refused. On Windows 11 the
  move succeeds even while a session runs that copy — the directory of a running executable can
  be renamed — so a running session loses every file it has not opened yet (pi loads assets
  relative to its executable). §4's retention has the same gap: a successful rename-to-trash does
  not prove a version unused (open follow-up). Codex on a host without reviewed digests skips with one line and exit 0. The old
  scripts' own download, extraction and cache checks, and their `--archive` / `--license`
  offline inputs, are gone. No build target runs `ensure-opencode/pi/codex` any more; only
  `postinstall` does.
- The Codex scripts. `scripts/codex-tooling.mjs` holds what `generate-codex-protocol.mjs` and
  `codex-native-status.mjs` share; both run the pinned Codex from the store (the tested
  version's directory, not the resolver's answer, which a System selection could make another
  version), and the generator re-hashes it against this host's reviewed digest. Both run under
  bun.
- Packaging. `electron-builder.yml` ships `vendor/claude-cli` (with `vendor/**/*.node`) and no
  other engine; the release workflows' server zips carry `vendor/claude-cli` only and the Linux
  tarball carries no engine (ADR-061's 2026-09-30 amendment). CI's `vendor/codex-cli` cache is a
  cache of the store's `codex/<version>` directory. `claudeui-server` copied no engine itself
  (`scripts/build-server.mjs`); it resolves engines through the resolver, so a fresh server has
  none until an admin installs them (resolved question 5).
  `src/core/harness/__tests__/packaging.test.ts` fails if a package or workflow carries an
  unbundled engine again.
- Tests. The integration project names the real store (`CLAUDEUI_HARNESS_STORE`, set in
  `vitest.config.ts`, since its setup moves HOME), and each suite skips when its engine is not
  installed. The Codex suites copy the store's pinned binary into their fixture and point the
  resolver at the copy through `CLAUDEUI_CODEX_CLI`.
- Documentation. pi's version-exact docs are read from the upstream checkout
  `vendor/pi-src/packages/coding-agent/docs/` at the tested tag (CLAUDE.md's rule for engine
  sources), no longer from the vendored payload.

As built (arc 3, S7b; mockup `b51cb3df`):

- Installable. `harnessInstallable` (`src/core/harness/installable.ts`) says whether ClaudeUI can
  install its own copy on this host: opencode and pi when the manifest has a release for the
  host's platform key, Codex on a host with reviewed digests, Claude Code never. The state
  snapshot carries it per harness (`HarnessStateEntry.installable`), and `ensure-harness.mjs`
  skips a harness it says no to.
- The upgrade sheet's candidates (`src/core/harness/upgrade-prompt.ts`). A harness is offered
  when it is not Claude Code, this profile has at least one `session_meta` row for it, nothing
  runs for it, its selection is ClaudeUI's copy, detection found no usable System install, and it
  is installable here. A System selection that cannot run is left to the composer banner. The
  first evaluation runs after the boot detection (or at once when detection is off), so a usable
  System install found at boot is not offered; when it finds nothing to offer, it marks the prompt
  answered without showing anything, so a profile that used none never sees the sheet. Until the
  prompt is answered, the candidates are recomputed on every `harness:state` read (one
  `session_meta` count per read); a failed count offers nothing that read and does not answer.
- The answer is `upgradePrompt: "answered"` at the top level of `harnesses.json`, written
  read-modify-write like the rest (unknown keys survive). `harness:answer-upgrade-prompt` records
  it: `admin`, pinned, on both transports, and audited like the other writes. The snapshot's
  `upgradePrompt` is `{ pending, candidates }`; the evaluation and the answer nudge clients with
  `harness:changed`.
- The sheet (`HarnessUpgradeSheet`, mounted once in `SessionView`) shows while `pending` holds,
  on the desktop and on a web connection that holds `admin`; a refusal hides it for that client
  without answering. Rows (logo, label, the version the install fetches, "N sessions") start
  unchecked; Install is disabled until one is checked and then reads "Install N". "Not now"
  answers without installing; Install starts `harness:install` for each checked harness (the
  version its selection names) and answers; the progress continues in the sidebar footer's
  button, the Installed page's pill and the composer banner. Escape only closes it for this run, and it returns on the next launch. No
  download sizes anywhere: the manifests do not record them, and the pill shows the bytes as they
  arrive.
- One reading of whether a harness runs (`harnessReadiness`, `harness-view.ts`): `ready`,
  `missing` (ClaudeUI's copy selected, installable here), `system-unusable` (a System selection
  that cannot run, installable here), `unavailable-here` (not installable, or an environment
  override that cannot run) and `unknown` (no snapshot yet, which every caller treats as before).
- The harness picker lists every harness, Codex included (it was hidden when it had no models): a
  `missing` or `system-unusable` harness carries a "Not installed" chip and can be picked; an
  `unavailable-here` one is disabled, titled "Not available on this computer". The mobile sheet
  follows the same rule.
- New sessions. `createNewSession` keeps a remembered harness that does not run selected, with no
  model seeded (an empty catalog resolves to a phantom default) and no stale-default error; the
  opencode→claude fallback applies only to an opencode that runs (or is `unknown`) and has no
  usable model, and an `unavailable-here` harness falls back to Claude Code. Switching a session
  to a harness that does not run does the same. When the harness starts to run, the composer
  reloads the models (discovery answers nothing for a harness that does not run, and main caches
  only non-empty answers) and `seedUnsetModel` gives the session the model a new one would get.
- The composer banner (`HarnessInstallBanner`) sits above the input while the session's harness
  does not run and no process runs for it: offer (Install and Settings…, which opens Settings ›
  Harnesses › Installed), installing (the shared progress, Cancel), failed (the reason, Retry),
  system-unusable (the resolver's reason, "Use ClaudeUI's copy": the selection becomes ClaudeUI's
  Tested copy, then it installs), a connection without `admin` ("Ask an admin to install it from
  Settings › Harnesses › Installed", no button) and unavailable-here (the reason, no button). A
  selected version that is installed yet cannot run (Codex without its code-mode host) gets its
  reason, not an Install the installer would treat as already satisfied.
  Meanwhile Send, Enter and voice are off and the model picker reads "Install <label> to choose a
  model". The placeholder names the session's harness ("Ask pi anything"), with ", / for
  commands" where the harness has slash commands.
- A session that never spawned shows its harness's logo in the sidebar: its in-memory row takes
  the engine from `sessionEngines` instead of reading as Claude Code.
- Settings for a harness that does not run (owner ruling 2026-09-30, resolved question 10;
  replaces S7b's not-installed rows). "Does not run" is `harnessReadiness` `missing`,
  `system-unusable` or `unavailable-here`; `ready` and `unknown` behave as before. One reading
  serves every rule: `useEngineRuns` (`harness-store.ts`), with Claude Code always running.
  - The harness's page cannot be opened. Its rail item (desktop) and page row (phone) are greyed,
    `aria-disabled`, out of the tab order and inert to clicks, with no chevron or expanded state,
    titled "<Label> is not installed · install it from Harnesses › Installed". A deep link or `open-settings` to it, a cross-link, the
    page remembered from the last open, and the page being open when the harness goes all land on
    Harnesses › Installed (`pageOpens`, `openableTarget`); the phone folds it. The item lights up
    when the snapshot says the harness runs.
  - Search returns no rows from such a page, and none from a hidden segment or group.
  - On shared pages its parts are hidden, by one rule in the page model (`settings-pages.tsx`):
    a `byEngine` group drops the segments of a harness that does not run (Default models, the
    Auto-mode judge) and is itself hidden when none is left; a group or row that names the
    harnesses it serves (`harnesses`) is hidden while none of them runs — Trust & protection
    (`automode.json`, read only by the opencode and pi judges) and the Permissions group's
    "opencode and pi" row. A group with no row left is not drawn, and a segment left with one
    option is not drawn either: the group shows that engine's rows (Default models with only
    Claude, the judge with only one harness).
  - The dispatch page is the exception: its target segment (`dispatchTargets`, on both the
    Dispatch into and Limits groups) greys a target that cannot run instead of hiding it, with the
    same title; the Claude target is greyed while no caller (opencode, pi, Codex) runs, titled "No
    harness that can call Claude is installed · install one from Harnesses › Installed". A selected
    target that cannot be chosen shows the first one that can; with none, both groups are hidden.
  - Models & providers: the API providers group (header, note, rows and "+ Add provider") is
    hidden, and out of search, while neither opencode nor pi runs — nothing else can use an API
    provider — by the group's `harnesses: ['opencode', 'pi']`, the one rule above (owner,
    2026-10-01; this replaced a gate on the header action alone, `actionShown`, which is gone).
    The provider list has no chip or delivery-failure pill for a harness that
    does not run, and no "not installed" row; the provider sheet has no engine row, delivery row,
    default-model row, curation or model-setup row (opencode models, pi models, pi overrides) or
    model editor for it, and no key conflict or "use it for both" between opencode and pi while
    either does not run; the ChatGPT card has no pill for it, and with no pill at all no
    "Harnesses" label (Manage stays). With none of Codex, opencode and pi running, the
    ChatGPT card draws no Harnesses box at all: Manage sits beside "+ Add account" (owner,
    2026-10-01). The card's copy names only the harnesses that run: the signed-out subtitle and
    sign-in line ("used by …", "Sign in once; … use the same account"; nothing named when none
    runs), and removing the last account says "disconnected from every harness" only while one
    runs. Its Options fold holds one option, Codex's per-session pinning, so it waits for Codex
    to run (and for a second account, as before); the option's "pi and opencode always follow the
    active account" names only those that run. The sheet's "Sync now" is offered only while
    opencode or pi, the harnesses it syncs to, runs. The Add provider sheet reads no catalog from it. A custom
    endpoint and a second key go to opencode and pi only: their "Enable for" / "Harnesses" chips
    leave out one that does not run (a new endpoint is saved with no route to it; an existing
    one's saved route is kept); with neither running, the Add sheet offers no custom endpoint, the
    sheet offers no second key, and the "+ Add provider" header action is not drawn. Providers
    stay listed and saved routes are not changed, so installing the harness brings its parts back
    as they were. The registry's `opencodeInstalled` stays for main's own decisions; the renderer
    does not read it.
  - The panes do not ask whether their harness is installed: they mount only for one that runs.
    A Codex that runs but whose `config.toml` cannot be read still says so in every section.
- Installs outside the update flow show on the sidebar footer's update button (§6), so a sheet
  install is visible outside Settings. Any harness install in flight makes it spin, with a
  tooltip naming the harness, its version and its progress; one that finishes shows the same
  check that fades; a failure turns it amber. Its panel lists these installs under the update
  rows, each with its progress and a Cancel, a check once installed, or the failure's reason and
  a dismiss. An install that is an available update, or one the current or last run tried, stays
  an update row (`isUpdateInstall`); update behaviour is otherwise unchanged. What finished is
  kept per client (`completedInstalls`) until the check has faded and the panel is shut.

As built (arc 3, S7d; resolved question 11): no key is written into a harness that does not run.

- One predicate, `harnessWritable(id)` (`resolve.ts`, today `harnessAvailable`), injected as
  `harnessRuns` into `SharedProviderService` (composition root `shared-providers/index.ts`) and
  `CredentialSync` (`configure` at the boot seam, `core-services.ts`, so the headless server
  honours it too). While pi or opencode cannot run, every WRITE into its own files is skipped with
  one info line ("<route> not installed — skipping …") and is not a route error: shared API keys
  (`vendRouteCredential`), provider blocks (`applyRoute` for a route that is on), opencode's
  default model (its own `opencode.json`; pi's default is ClaudeUI's `engines/pi.json` and is
  still written), and the ChatGPT feed (`feedOne`). ClaudeUI's own records — vault, definitions,
  curation in `engines/*.json` — are saved as before. `syncChatgpt` does not blame a route whose
  feed was skipped for not running.
- REMOVALS are not writes of a key (orchestrator ruling, 2026-10-01), and every one happens at
  once, whether or not the harness runs. Each deletes only ClaudeUI's own entry where it is there,
  and never creates a file or directory:

  | Removal                                              | Harness runs                                                         | Harness does not run                               |
  | ---------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
  | pi `auth.json` key (shared provider, ChatGPT)        | file edit                                                            | the same file edit                                 |
  | pi `models.json` block                               | file edit                                                            | the same file edit                                 |
  | opencode config-file block (`removeDefinitionRoute`) | file edit                                                            | the same file edit                                 |
  | opencode key (shared provider, ChatGPT)              | through its server (`removeVendorAuth`, recycles the live processes) | direct `auth.json` edit (`removeVendorAuthDirect`) |
  | default model ClaudeUI set in `opencode.json`        | file edit                                                            | the same file edit                                 |

  `PiAuthProvider.removeVendorAuth` returns before writing when the vendor has no entry (it used
  to rewrite, and so create, `auth.json`); the two block removals write only after matching
  ClaudeUI's own block, which needs the file; `OpencodeAuthProvider.removeVendorAuthDirect` sits
  beside `feedOauthCredential`, the other direct write, and keeps its read-modify-write
  discipline: an unreadable file is refused (backed up once, then it throws) rather than
  overwritten, every other vendor entry and unknown field survives, and an absent file or entry
  writes nothing. With opencode not running there is no server whose in-memory provider map
  could go stale, and none is spawned for a file edit. The shared-provider service
  (`removeRouteCredential`, which reclaim and disconnect go through) and CredentialSync's
  `removeOne` pick the path by `harnessRuns`. So a removed key or a disconnected ChatGPT copy is
  gone at once, and nothing — the boot adoption scan, CredentialSync's reconcile-on-start — can
  adopt it back later.

  A CATALOG route's key is taken out only while the slot holds ClaudeUI's key (orchestrator
  ruling, 2026-10-01, after the real-app check found a switch-off deleting an opencode's own key
  under a route that was on while opencode was missing): the vault key, or the key matching the
  slot's delivered fingerprint (`holdsOurKey`). Any other credential there — the user's own key,
  a sign-in — stays, and only the fingerprint is forgotten. This holds for every such removal
  (switch-off, route off, remove provider, disconnect, the reclaim of a stranded key), for pi and
  opencode alike, running or not, through one check in `removeRouteCredential`; the callers take
  the vault key out only after it, since the check reads it. A custom definition's native id is
  ClaudeUI's own, so its entry always goes. Removing a provider also clears its model list from
  ClaudeUI's `engines/<engine>.json` allowlists, except for a catalog vendor an engine still holds
  a credential for, whose list now curates that engine's own provider.

  ChatGPT is not a catalog route; its removals match the entry's refresh token against the
  vault's accounts instead (S7e, below).

- CredentialSync neither arms the fs watcher for a harness that does not run nor reads its store
  at boot for a credential to adopt; a legacy-vault recovery still reads it, since it may hold the
  only copy.
- Arrival (`harness/arrivals.ts`, `watchHarnessArrivals`, subscribed at boot before the boot
  sync): the resolver's `onHarnessChanged` fires on every invalidation, so each harness's last
  availability is kept and only a not-running → running transition counts — an install, a
  selection change, or the boot detection finding a System install. On arrival,
  `SharedProviderService.harnessArrived(route)` syncs every definition to that route alone; then `CredentialSync.harnessArrived(engine)` feeds that engine
  the active ChatGPT credential once and arms its watcher (or takes a disabled route's copy
  back). The other harness is not rewritten, so pi arriving does not recycle a running opencode.
- Delivered-key fingerprints (`shared-providers/delivered-keys.ts`,
  `~/.claude/ui/delivered-key-fingerprints.json`): each successful delivery records the SHA-256
  of the key — never the key — per harness slot (harness + the vendor id its auth store uses;
  keyed by slot rather than by definition so a definition removed and re-added, or a recorded
  removal applied by vendor id, lands on the same record); a removal forgets it. A harness "holds
  its own key" when it holds a credential for the vendor that is neither the vault key nor the
  fingerprinted one, so a key replaced while the harness was away is ClaudeUI's and is delivered
  on arrival. Migration: a slot with no fingerprint (every slot of an install from before the
  file) has only the vault key as ClaudeUI's — the rule before — and the first delivery after the
  upgrade (the boot sync re-delivers every slot that holds the vault key) records it.
- An automatic delivery — the boot sync, Retry (`syncProvider`), an arrival — never replaces a
  harness's own key: such a catalog route (`keepsOwnKey`: a vault key exists and the engine holds
  its own) is skipped and reports "<route> has its own key for <provider>; it was kept." as its
  route error with `ownKeyKept` (status and registry facts); the list shows "Own key kept in
  <route>" in the warning tone (a failed delivery stays "Not delivered to <route>" in the danger
  tone), and the sheet's route shows the reason with a **Use the stored key** action that
  replaces it after the same confirm as switching on ("<route>’s own key for <provider> will be
  replaced by the stored one.") — `shared-provider:use-stored-key` (`config`, both transports,
  like every shared-provider write), which delivers that one route with `keepOwnKeys: false`.
  Other explicit actions still replace: switching on (after its own-key confirm), adopting,
  turning a route on (after its confirm). A key write (`setApiKey`) replaces one only when the user
  confirmed it (S7f, below). A custom provider's native id is ClaudeUI's own and has no such key.
- Switching a provider on (`setDisabled`, `ownCredentialRoutes`) and its confirm
  (`ownKeysReplacedOnSwitchOn(entry, runs)` in the sheet and the list) ignore a harness that does
  not run: nothing is replaced there, and its arrival keeps any own key instead of asking.

As built (arc 3, S7e; resolved question 12): a ChatGPT disconnect takes out only what ClaudeUI
put in, and ClaudeUI does not sign itself back in from what stays.

- `CredentialSync.disconnectChatgpt` and `removeAccount`'s last-account path remove an engine's
  ChatGPT OAuth entry (pi `openai-codex`, opencode `openai`) only when it is ClaudeUI's: its
  refresh token is one of the vault's ChatGPT accounts' now — any account, active or not, since
  a background account was the active one when it was fed — or is in that engine's fed-token
  history (below). Both read the vault's tokens before the vault empties, then remove. Any other
  entry is a sign-in made in the harness itself and stays, with one info line ("<context>:
  <engine> holds a ChatGPT sign-in ClaudeUI did not make — kept"; never token material). One
  helper does it (`removeManagedCopy` over `managedRefreshTokens` and the history), for pi and
  opencode, running or not, and it goes through `removeOne`, so S7d's direct file edit for a
  harness that does not run stays. The start-time clean-up of a disabled route's copy and an
  arrival's use the same helper. Removing an account that is not the last is unchanged: the
  promoted account is fed.
- A STALE copy of ClaudeUI's is still ClaudeUI's (orchestrator ruling, 2026-10-01, closing the
  first review's gap). The fed-token history (`auth/vault/fed-token-history.ts`,
  `~/.claude/ui/chatgpt-fed-token-fingerprints.json`, 0600, atomic writes, beside S7d's
  delivered-key fingerprints and in their style) keeps per engine the SHA-256 of every refresh
  token ClaudeUI put into it (`feedOne`, recorded before the write) or adopted from it as a
  rotation of its own copy (`persistAdopted` with a prior credential: reconcile-on-start and the
  watcher) — never a token — the last 32 per engine. So a harness that did not run while the
  vault rotated, and so still holds an older token ClaudeUI fed it, loses that copy on a
  disconnect. Once ClaudeUI's copy is out of an engine (removed, or found absent), that engine's
  history is forgotten. It decides removals only: feeding and adoption never read it. The class
  defaults to an in-memory history; the boot seam (`core-services.ts`) wires the file for both
  hosts. Migration: an engine with no history is judged by the vault's tokens alone, the rule
  before it. A disconnect (or the last account's removal) first runs any watcher reconcile still
  waiting out its debounce (`flushPendingWatches`), so a rotation the engine made just before is
  adopted, and recognised, rather than kept as a direct sign-in. The history is best-effort: a
  failure logs, never fails a feed or a removal, and an unreadable history recognises nothing.
- The disconnect marker: both paths first record `disconnected: ["chatgpt"]` in ClaudeUI's vault
  file (`~/.claude/ui/auth-vault.json`, `AuthVault.setDisconnected` / `isDisconnected`) — a flag
  beside the accounts it speaks about, written by the vault's one atomic writer, never token
  material, and written before the accounts go so no crash leaves an empty vault unmarked. An
  emptied vault keeps its file while the marker is there. While the vault holds no ChatGPT
  account and the marker is set, `reconcileOnStart` does not bootstrap from an engine's entry;
  the fs watcher never adopts into an empty vault anyway. The marker is cleared by a sign-in
  through ClaudeUI: `applyCompletedLogin`, the one tail of the desktop loopback, the remote
  paste-back and the device code. The legacy unreadable-vault recovery is blocked too (the
  disconnect happened after that vault existed; writing the marker replaces the legacy file, so
  the two do not meet on disk). Adoption of a rotation while the vault holds an account is
  unchanged: a marker beside an account is inert.
- The copy says it: the ChatGPT card's last-account removal and the sheet's armed Disconnect
  read "ClaudeUI’s ChatGPT sign-in is removed from <harnesses that run>; one made directly in
  <pi or opencode, those that run> stays." (`chatgptDisconnectText`, `harness-view.ts`).

As built (arc 3, S7f; resolved question 14): a provider created in ClaudeUI is usable in opencode and
pi even where the harness already holds its own key for the vendor
([ADR-074](adr-074_provider-surfaces-v3.md) §12).

- The Add sheet offers every catalog provider ClaudeUI does not manage yet, with every running
  harness that offers it as a target; one holding its own key carries "<harness> has its own key
  for <provider>". Creating with such a harness picked asks once (`own-key-question.ts`, the one
  helper for the wording): "<harness> already has its own <provider> key. Overwrite it and manage
  the key from ClaudeUI?" — **Overwrite and manage from ClaudeUI** sends `shared-provider:set-key`
  with `replaceOwn: [<the harnesses asked about>]` (the explicit-action delivery, fingerprinted);
  **Keep <harness>’s own key** creates the definition with that route off. Closing the sheet
  cancels; nothing is written before the answer.
- Every own-key question asks the host who holds an own key RIGHT NOW (S7f round 3, after the
  real-app check found a key written into opencode's `auth.json` while the sheet was open missing
  from the question: the registry's opencode rows come from a catalog cached until ClaudeUI itself
  writes). `shared-provider:own-key-holders(id)` (`config` query, both transports; the id checked by
  `validateVendorId`; harness ids only) answers `SharedProviderService.ownKeyHolders` from the
  harnesses' auth files: the running harnesses (S7d) holding a credential for the provider that is
  not ClaudeUI's — for a definition's id (or a vendor a catalog definition's route lands on) by the
  switch-on rule `holdsOwnKey`, for a vendor with no definition any credential there; a custom or
  subscription slot is ClaudeUI's own. The Add sheet's Save, "Use ClaudeUI’s … here instead", and
  the list's and the sheet's switch-on all read it before asking, so a key given to a harness after
  the screen was read is asked about rather than refused, and one removed meanwhile is not. A failed
  read falls back to what the screen showed; the service still refuses an own key the question did
  not name. Opening the list's switch-on question clears an earlier switch error. opencode's cached
  catalog itself is not invalidated on an outside `auth.json` change, so the list's native rows
  still lag until a ClaudeUI write (a live opencode server does not re-read the file either, so
  dropping the cache alone would not refresh them).
- `replaceOwn` is PER HARNESS (orchestrator ruling, S7f round 2, after a stale-snapshot Overwrite
  named only pi while opencode also held a key): `SharedProviderService.setApiKey` (its
  `replaceOwn` a list of harnesses, empty by default) decides which enabled catalog routes hold an own key
  (`ownCredentialRoutes`, running harnesses only) BEFORE the vault takes the new key — so a slot
  holding the previous vault key, from before fingerprints, stays ClaudeUI's — and keeps every one
  `replaceOwn` does not name: the route reports `ownKeyKept` with "Use the stored key", as an
  automatic delivery does, while the key is stored and reaches every other route.
  `setDisabled(id, false, replaceOwn: Route[])` refuses (throws) while a harness it does not name
  holds an own key; the list's and the sheet's switch-on confirms pass the harnesses they named.
  The IPC handlers accept only a list of harness ids (`confirmedHarnesses`; anything else — `true`
  included — is refused, never read as "all"), and the argument travels only when the list is
  non-empty, on both transports.
- The registry names a native row by the provider and whose credential it is: `ownedBy` on an
  opencode key, sign-in or env-var key and on a pi built-in vendor's key or sign-in;
  `providerEntryTitle` renders "OpenRouter · pi’s own key" on the list and the sheet. A pi vendor's
  name is opencode's catalog name when known, else its id title-cased (`vendorDisplayName`); a pi
  provider the user declared keeps its id. A native row whose vendor has a ClaudeUI catalog
  provider that is off for that harness (switched off, or its route off) offers **Use ClaudeUI’s
  <provider> here instead** (`UseClaudeUiInstead.tsx`): the same question, naming every harness the
  switch-on replaces a key in, then the route on (if off) and the provider on with `replaceOwn`
  naming exactly those.
- The Providers list names every harness that kept its own key in one warning pill ("Own key kept
  in opencode and pi"), beside a danger pill for a harness whose delivery failed.

## Consequences

- The installer shrinks by about 650 MB. A first run needs one download per extra harness a user
  wants; the welcome picker and this page both offer it.
- `engine:is-installed` and `crossEngineDispatchAvailable()` become event-driven, because a harness
  can appear or disappear while the app runs.
- A System opencode or pi can be newer than anything ClaudeUI tested. The untested label is the
  honest answer; ADR-081 removes the judge's dependency on engine internals, which was the largest
  version-sensitive piece.
- A System Codex newer than the pin runs against protocol types generated from the pin, which do not
  describe what a newer app-server added or changed. The untested label says so.
  `CodexAppServerClient.checkVersion` refuses anything below the floor or at or above the ceiling.
- `getCliVersion()` reports the version detection read with `--version` for a System Claude Code,
  and `version.json` otherwise. It never spawns `--version` itself, because it sits on hot paths.

## Resolved questions (owner, 2026-09-30)

1. The page is named **Installed**.
2. A custom file path gets no UI: it stays an environment variable for development, generalised from
   `CLAUDEUI_CLAUDE_CLI` to one variable per harness: `CLAUDEUI_CLAUDE_CLI`, `CLAUDEUI_OPENCODE_CLI`,
   `CLAUDEUI_PI_CLI`, `CLAUDEUI_CODEX_CLI`. It must name a file, or it is ignored with one warning.
   A Codex override still needs `codex-code-mode-host` beside it to count as installed.
3. Unused versions are kept for seven days (the proposed default, not challenged).
4. Upgrades from a bundled release prompt once (§8).
5. `claudeui-server` gets no special path (owner, 2026-09-30): its web UI shows the same one-time
   sheet and Installed page to an admin connection; a fresh server has no opencode, pi or Codex
   until an admin installs them.
6. When a ClaudeUI release moves Codex's pin, the new pin is an update (owner, 2026-09-30): Codex
   joins §6's update rule for its Tested choice, so Ask me offers it on the footer button and
   Automatically installs it. Until then ClaudeUI's Codex is unavailable, because the exact-pin gate
   refuses the old version.
7. In a development checkout, `postinstall` installs the tested opencode, pi and Codex into the real
   managed store, `~/.claude/ui/harnesses` (owner, 2026-09-30), as §8 says.
8. The upgrade sheet counts past sessions only (owner, 2026-09-30): a harness is "used" when
   `session_meta` holds a session on it. Sign-ins and config files are not a second signal.
9. The Installed page as built is kept (owner, 2026-09-30), with its departures from design 1: with
   System selected the version box keeps the ClaudeUI choice greyed (the System version sits in
   the row's line); the version menu scrolls, with no "Older versions…" entry; the real harness
   logos replace the mockup's squares and are hidden at phone width; the rows sit under a
   "Sources" group heading. §1's "engine" → "harness" wording pass is kept as built too, the
   composer's picker label ("Harness") included; "Cross-engine dispatch", the usage dashboard's
   engine grouping and internal ids keep "engine".
10. The settings of a harness that is not installed are not shown (owner, 2026-09-30, revising a
    first ruling that showed them disabled): its settings page cannot be opened (its rail item is
    greyed and routes to it land on Harnesses › Installed), search does not return it, and its
    parts on other pages are hidden, except the dispatch target, which is greyed in its segment.
    §8 "As built (arc 3, S7b)" describes it.
11. While pi or opencode is not installed, ClaudeUI does not write a key into it (owner, 2026-10-01):
    not a shared key, not the ChatGPT credential, not a provider block or default model; its routes
    are recorded, and it gets the current state when it arrives, without silently replacing a key
    it holds of its own. Deleting ClaudeUI's own entries is not writing a key: it happens at once,
    as a file edit where the harness's own removal would need its process. Switching a provider on does not name a harness that does not run among the keys it would
    replace. §8 "As built (arc 3, S7d)" describes it.
12. Disconnecting ChatGPT signs out of pi and opencode only where ClaudeUI injected the sign-in
    (owner, 2026-10-01): "Disconnect should sign out from both when the credential was injected by
    us. But one directly connected in pi can stay." ClaudeUI then does not sign itself back in from
    the sign-in that stayed until the user signs in through ClaudeUI. §8 "As built (arc 3, S7e)"
    describes it.
13. A harness's ChatGPT switch decides whose sign-in its ChatGPT slot holds (owner, 2026-10-01).
    Switched ON, the slot is ClaudeUI's: ClaudeUI feeds it, a newer sign-in found there is taken as
    a rotation of ClaudeUI's own, and a disconnect removes it. Switched OFF, the slot is the
    harness's own: ClaudeUI never writes, adopts or removes a sign-in there that it did not put
    there. So a sign-in made directly in pi or opencode survives a disconnect where that harness's
    ChatGPT is switched off; the disconnect note says so. Telling accounts apart with the switch on
    was rejected: the harness would then run on a different account than ClaudeUI shows.
14. A provider created in ClaudeUI must be usable in opencode and pi (owner, 2026-10-01): "when I
    create an OpenRouter provider in ClaudeUI, I want it to be usable in opencode/pi." A harness
    that already holds its own key for the vendor is offered, and creating asks whether to
    overwrite it and manage the key from ClaudeUI, or keep it (that route is then off). §8 "As
    built (arc 3, S7f)" describes it.

## Rejected alternatives

- **One expanded row per harness with every candidate listed** (mockup `eb22e639`). Too heavy for a
  page that is usually four quiet lines.
- **A switch instead of a segmented control** (mockup `8bf84c23` design 2). "System off" doesn't say
  what runs instead.
- **A split button holding both sources** (design 4). Compact, but a control that exists nowhere
  else in Settings.
- **Keep bundling everything.** Costs every user about 650 MB and keeps a second copy of tools many
  already have.
