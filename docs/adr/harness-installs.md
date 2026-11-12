# Harness sources, installs and engine customization

Governs: `src/core/harness/`, `src/shared/harness-manifests/`, `src/shared/harness-types.ts`, `src/core/ipc/harness-commands.ts`, `src/core/shared-providers/`, `src/core/auth/vault/`, `src/renderer/src/components/SettingsDialog/`, `src/renderer/src/components/Sidebar/`, `scripts/ensure-harness.mjs`, `electron-builder.yml`

How ClaudeUI finds, downloads, verifies, updates and selects the programs it drives (a **harness**: Claude Code,
opencode, pi), what ships in the installer, how a harness that is not installed is treated everywhere else, and the
policy for customizing engines. The Claude Code build pipeline and patch gating are ADR-006 and ADR-079
(claude-engine.md). The release artifact matrix is ADR-061 (development-workflow.md). opencode 2.x specifics (its
credential rows, manifest coordinates) are ADR-097 (opencode.md), and the judge transport is ADR-081
(auto-mode-judge.md). The step-by-step bump procedure is the `bump-harness` skill (`.claude/skills/bump-harness/`).

## Harnesses run from a managed copy or the system install; ClaudeUI downloads and updates its copies (ADR-082)

Claude Code is the one harness that ships in the installer (the patched `bun-claude`). opencode and pi are
downloaded by ClaudeUI into a managed store, `~/.claude/ui/harnesses`, shared by the desktop app and
`claudeui-server` and by every ClaudeUI build on the machine. Each harness can instead run from a **System**
install ClaudeUI detects. One resolver (`src/core/harness/resolve.ts`) decides the executable for every harness.
The Codex engine that once shared this design is gone (2026-10-29).

### §1 Names

A harness is the program ClaudeUI runs. Settings rail group "Engines" is **Harnesses**; its first page is
**Installed** (the per-harness pages follow, "Claude" is "Claude Code"). UI copy says "harness"; "cross-engine
dispatch", the usage dashboard's engine grouping and internal ids keep "engine".

### §2 Two sources per harness

- **Claude Code**: Bundled (the shipped, patched build, version locked) or System. **opencode, pi**: ClaudeUI (a
  managed download: Latest, Tested or one exact version) or System.
- **System** is the newest compatible install detection finds, shown read-only (version, path). ClaudeUI never
  modifies, updates or deletes a system install. **Latest** follows upstream's newest release and is labelled
  untested; **Tested** follows the version this release pins and moves when ClaudeUI updates. Switching to System
  keeps the last ClaudeUI choice, greyed, so switching back restores it. A System segment is disabled when nothing
  usable was found, with the reason (not found, too old, incompatible).
- **Selection** lives in `~/.claude/ui/harnesses.json` as `selections.<harness>: { source, version }`, written
  only by the main process, never in `engines/<harness>.json` (that file is replaced whole by renderer saves, so
  an unrelated save could revert a choice). Unknown keys survive a save. A new or respawned session reads it at
  spawn; a running session keeps its binary. Default is Bundled for Claude Code and managed Tested for the rest;
  a saved `bundled` for opencode or pi reads as that default.
- **Resolution order**: the per-harness environment override (`CLAUDEUI_CLAUDE_CLI`, `CLAUDEUI_OPENCODE_CLI`,
  `CLAUDEUI_PI_CLI`; no UI; must name a file or it is ignored with one warning), then the selection, then (Claude
  Code only) the bundled copy. For opencode and pi a selection that cannot be honoured resolves to nothing with
  the reason ("<Label> <version> is not installed", "No version of <Label> is installed", or the System reason):
  there is no fallback to a vendored copy and an unusable System choice does not fall back to ClaudeUI's copy.
  The answer is cached per harness and recomputed on an install, a selection change or a finished detection, so
  status checks do no disk work. `harnessAvailable`, `engine:is-installed` and dispatch availability read it.
- **A System selection never probes.** It reads the detection cache (`~/.claude/ui/harness-detection.json`) and
  uses a record only while the file that runs (and a disk node for pi) still has the size and mtime detection saw,
  and the cached launch equals the one detection would have built from those files
  (`src/core/harness/system-source.ts`). A stale, missing or mismatched record falls back with the reason and asks
  for a background re-detection. This catches a stale or hand-edited cache; it does not defend against someone who
  can write `~/.claude`.
- **System pi runs under Node.** npm, the pi.dev installer and Homebrew install pi as a Node script
  (`dist/bundle/cli.js`). ClaudeUI spawns `<node> <cli.js>` itself, never the `.cmd` or `sh` shim, so node is the
  pi process and signals and tree kills reach it. Node is the install's own (when 22.19+), else the first suitable
  `node` on PATH, else Electron itself with `ELECTRON_RUN_AS_NODE=1` (`claudeui-server` has no Electron, so it
  needs a system node). The resolver's answer carries a launch (`command`, leading `args`, `env`) and every spawn
  site composes its argv from it. A launch's PATH entries are prepended to the spawn site's own PATH at start, never
  captured at detection.
- **`ELECTRON_RUN_AS_NODE` never leaks to pi's children.** The launch also sets `CLAUDEUI_PI_ELECTRON_NODE=1`; the
  bridge extension deletes `ELECTRON_RUN_AS_NODE` when pi loads it, before any tool can run. Host-run children
  (`pi-child-runner.ts`) also load the bridge, so they clean it the same way; the marker stays for nested pi spawns.
- `getCliVersion()` reports the version detection read for a System Claude Code and `version.json` otherwise; it
  never spawns `--version` itself (hot paths).

### §3 Detection classifies, it does not just list

Resolver and detection together (§2-3) mean spawns never wait on a probe. Detection searches PATH, the npm global
prefix and each harness's own install directories (on macOS and Linux also the login shell's PATH, read once). A
Windows npm `.cmd` shim resolves to the real executable (for pi, its `cli.js`). Each candidate runs `--version` in an
isolated environment and gets one label:

- **tested**: equals the pin. **untested**: at or above the floor, below the ceiling, not the pin (older than the
  pin counts); selectable. **too old**: below the floor; listed, not selectable. **incompatible**: at or above the
  ceiling, or not a version; listed, not selectable. A pre-release of the ceiling counts as the ceiling, a
  pre-release of the floor is too old (`src/core/harness/version-gate.ts`).
- Detection runs only in the background (`detect/scheduler.ts`): once for every harness a few seconds after boot,
  and again when the resolver finds a cache missing or stale. One run at a time, requests merged. A run writes the
  cache and invalidates the resolver. `CLAUDEUI_DISABLE_HARNESS_DETECTION=1` turns background detection off.
- **The ceiling is exclusive and is the next major**, so a new major is never "untested but selectable" (opencode
  2.x and 1.x configurations are incompatible). Today: Claude Code 3.0.0, opencode 3.0.0, pi 2.0.0. pi has shipped
  breaking changes in minors, so its ceiling is a judgement call; the untested label is what warns.
- **Every floor equals its tested version** unless a lower one is measured and worth keeping: a bump moves the
  floor with the pin. The floor exists so a release relies on what its pin does without a second code path, and
  ClaudeUI's own copy is always the pin.
- **The store is shared by every build, so "Latest" is the newest installed version THIS build can run**
  (floor ≤ v < ceiling), and retention never removes a version at or past the ceiling (it belongs to a newer
  ClaudeUI). Taking the newest installed outright once let a 1.x build launch an installed opencode 2.x, whose
  binary migrated the user's shared opencode database.

### §4 Downloads

`src/core/harness/install/`. Every install is verified before first use; a mismatch deletes the file and stops, with
no override.

- **Sources are official only**: opencode from `registry.npmjs.org` (`@opencode/cli-<os>-<arch>@<version>`
  metadata names the tarball, which must itself be on `https://registry.npmjs.org/`; only
  `package/bin/opencode[.exe]` is kept); pi from `github.com/<owner>/<repo>/releases/download/...`, whose redirect
  may go only to `release-assets.githubusercontent.com`; pi's version list from `api.github.com`. HTTPS only,
  redirects followed by hand and checked hop by hop, any other host fails the install. Requests use the proxy-aware
  `fetch` of the judge (`services/net-fetch.ts`).
- **Verification**: a tested version is checked against SHA-256 digests reviewed into this repo (the manifest,
  §5); `install.json`'s `verified` is `reviewed` only when every digest matched (opencode: tarball `integrity` and
  `binarySha256`; pi: `archiveSha256` and its `SHA256SUMS` entry). Any other version can only be checked against the
  publisher's own hash (npm `integrity`, pi `SHA256SUMS`): that catches corruption, not a compromised release, is
  recorded `publisher` and the UI labels it untested. A version outside [floor, ceiling) is refused before any
  download. After the hash, the staged executable's isolated `--version` must print the version being installed.
- **Limits**: 400 MB per install, 30 s for a response and 30 s without data; streamed to disk and hashed as it
  arrives. One dependency-free reader unpacks tar.gz and zip (`archive.ts`); an absolute path, drive letter, `..`
  segment, symlink, hardlink or duplicate entry anywhere fails the archive.
- **Layout and atomicity**: built in `<store>/.staging/<harness>-<version>-<random>/`, `install.json` (harness,
  version, platform, arch, time, `verified`) written last, then renamed to `<store>/<harness>/<version>/`. A
  directory without a valid `install.json` is not an install; an invalid one is renamed into `.trash/` first. A
  version directory is never overwritten (a running `opencode serve` holds its binary; Windows returns EPERM). Any
  failure removes the staging directories; `.staging` and `.trash` entries untouched for an hour are removed.
- **Concurrency**: one install per harness and version at a time (requests share it), at most two at once;
  progress per phase at most four times a second (`harness:install-progress`).
- **Retention**: a version directory is removed when it is not the tested version, not the version the selection
  names (for Latest the newest installed; this holds while the source is System), not the version the resolver
  runs now, not at or past the ceiling (§3), and its `last-used` (touched once per resolution; else `installedAt`)
  is over seven days old. Removal renames into `.trash/` first; a failed rename is retried next run. It runs in the
  background after the boot detection, never on a spawn. Known gap: on Windows a rename of a running executable's
  directory succeeds, so a successful rename does not prove a version unused (open follow-up).
- **Upstream versions** (`upstream.ts`): stable releases in [floor, ceiling), newest first (pi: only releases with
  this host's asset and `SHA256SUMS`); cached an hour, failures five minutes.

### §5 The release manifest

Each release carries `src/shared/harness-manifests/<harness>.json`: tested version, floor, ceiling, download
coordinates per platform and the reviewed digests. It is the source of truth for what "Tested" means; the
`ensure-*` scripts and CI read it. `claudeCliVersion` in `package.json` stays and equals the Claude manifest's
`tested`. Floors equal tested versions (§3). Claude's manifest has no download coordinates.

### §6 Updates

- Global setting **Install updates: Automatically | Ask me**, default Ask me: `updates: 'auto' | 'ask'` at the top
  level of `harnesses.json` (missing or unrecognised reads `ask`), written only through `harness:set-update-mode`.
- **What counts as an update** (`computeUpdates`): a managed selection whose ClaudeUI choice is Latest or Tested,
  when the version it names is newer than the newest one in the store and the store holds one. An exact version, a
  System selection (even with a kept ClaudeUI version) and Claude Code never count; an empty store is not an
  update (a first install is not). Bundled Claude Code moves only with ClaudeUI releases; System installs update
  themselves.
- **Checks** run after the boot detection and every six hours; Latest asks upstream, Tested needs no network.
  `harness:check-updates` accepts an answer at most a minute old; a failed answer keeps the last good one. The
  update set is recomputed from memory on every `harness:state` read, with no network in the snapshot.
- **Runs** are one at a time, one install after another; Update all during a run joins it. Automatically starts a
  run when a check finds updates and when the setting is switched to it; Ask me installs nothing until Update all.
  Selections never change (Latest and Tested already point at the new version); the old version stays until
  retention removes it.
- **UI contract**: in Ask me a sidebar-footer button (left of Remote Access) shows a count badge, a spinner while
  updating or while any harness install is in flight, a check that fades after five seconds, and amber after an
  undismissed failure; its panel names each harness, `from → to`, progress and failures. Automatically never shows
  the count. Latest with Automatically is allowed, with the row note "Installs untested releases automatically".
  A connection without `admin` sees the same state with actions disabled.

### §7 Remote devices

Installing a binary from a phone is close to remote code execution. Every write (`harness:set-selection`,
`install`, `install-cancel`, `detect`, `set-update-mode`, `update-all`, `check-updates`, `answer-upgrade-prompt`)
declares the `admin` capability and is pinned in `PINNED_CAPABILITIES`, so no later edit can relabel one `config`
(`src/core/ipc/harness-commands.ts`). A base remote connection never holds `admin`; a passkey or break-glass one
does, and at the strong tier a write also needs the mutation window. The reads (`harness:state`,
`harness:versions`) are `config`, free on every tier: every device sees the page read-only. The desktop renderer
holds every capability. Results are discriminated by `status` or `kind`, never an `ok` key (preload/web `unwrap`
would treat it as its own envelope). See remote-access.md for the capability model.

### §8 Unbundling

The installer, release zips and Linux server tarball carry no `vendor/opencode-cli` or `vendor/pi-cli`;
`electron-builder.yml` ships `vendor/claude-cli` (the Bun binary and `version.json`) only, and
`src/core/harness/__tests__/packaging.test.ts` fails if a package or workflow carries an unbundled engine. Voice
needs no loose native addon (voice-capture is in the renderer, ADR-098).

- **Dev and CI use the same path.** `scripts/ensure-{opencode,pi}.mjs` wrap `scripts/ensure-harness.mjs`, which
  calls `installHarness(id, <tested>)` under bun into the managed store (`CLAUDEUI_HARNESS_STORE` moves it); a valid
  install is kept. `update-*` (`--force`) moves the installed tested version into `.trash/` and installs again,
  failing, changing nothing, only when the move is refused; close sessions first (a running pi loads assets relative
  to its executable). `ensure-*` skips a harness `harnessInstallable` says no to (no release for this platform).
  Only `postinstall` runs them. The integration project names the real store; each real-binary suite skips when its
  engine is not installed. pi's version-exact docs are read from the upstream checkout `vendor/pi-src/`.
- **`claudeui-server` gets no special path**: a fresh server has no opencode or pi until an admin installs them
  from Settings › Harnesses › Installed in its web UI.
- **Installable** (`harnessInstallable`): opencode and pi when the manifest has a release for the host's platform
  key; Claude Code never.
- **Upgrade from a bundled release**: on the first launch without bundled engines one sheet lists the harnesses
  this profile has used, with one Install for their Tested versions. "Used" means a `session_meta` row for that
  engine (past sessions only; a sign-in or config file does not count). A harness is offered only when nothing
  runs for it, its selection is ClaudeUI's copy, no usable System install exists and it is installable here;
  evaluation waits for the boot detection. Nothing downloads without the click; the answer is
  `upgradePrompt: "answered"` in `harnesses.json` (`harness:answer-upgrade-prompt`, `admin`, audited). The sheet
  shows on the desktop and on a web connection holding `admin`; "Not now" answers without installing; a harness the
  sheet skipped is offered again when a session on it is opened (composer banner). Rows start unchecked.
- **Readiness** (`harnessReadiness`, `harness-view.ts`): `ready`, `missing` (ClaudeUI's copy selected, installable
  here), `system-unusable`, `unavailable-here` (not installable, or an unusable environment override) or `unknown`
  (no snapshot yet; callers behave as before). One reading serves every rule below; Claude Code always runs.
- **A harness that does not run** (missing, system-unusable, unavailable-here):
  - The harness picker lists it with a "Not installed" chip and it can be picked; unavailable-here is disabled
    ("Not available on this computer"). A new session keeps a remembered non-running harness with no model seeded;
    the opencode-to-Claude fallback applies only to an opencode that runs (or is `unknown`) and has no usable model;
    unavailable-here falls back to Claude Code. When it starts to run, the composer reloads models.
  - The composer banner offers Install, shows progress, failure with Retry, the resolver's reason with "Use
    ClaudeUI's copy" for an unusable System choice, or "Ask an admin to install it" without `admin`. Send, Enter and
    voice are off meanwhile.
  - Its Settings page cannot be opened (rail item greyed; deep links, remembered pages and `open-settings` land on
    Harnesses › Installed); search returns none of its rows; on shared pages its parts are hidden by one rule in the
    page model (`settings-pages.tsx`: a `byEngine` group drops its segment, a group naming `harnesses` is hidden
    while none runs). The dispatch target is the exception: greyed, not hidden. The API providers group is hidden
    while neither opencode nor pi runs. Providers stay listed and saved routes are untouched, so installing brings
    the parts back as they were.
- **No key is written into a harness that does not run** (`harnessWritable(id)`, injected as `harnessRuns` into
  `SharedProviderService` and `CredentialSync` at the boot seam, so the headless server honours it). While pi or
  opencode cannot run, every WRITE into its own files (shared API keys, provider blocks, the default model in
  opencode's own config, the ChatGPT feed) is skipped with one info line and is not a route error. ClaudeUI's own
  records (vault, definitions, curation in `engines/*.json`) are saved as before. CredentialSync does not arm its
  watcher for such a harness; a legacy-vault recovery still reads it.
- **Removals are not writes and happen at once**, running or not, deleting only ClaudeUI's own entry and never
  creating a file: pi's `auth.json` key and `models.json` block, opencode's config-file block and default model are
  file edits (`PiAuthProvider.removeVendorAuth` returns before writing when the vendor has no entry). opencode's
  keys and ChatGPT rows are ClaudeUI's own `cred_claudeui_*` credential rows (ADR-097 §5, opencode.md); while
  opencode is not installed there is no file to edit, so that removal waits in ClaudeUI's record until it is.
- **A catalog route's key is removed only while the slot holds ClaudeUI's key** (the vault key, or the key matching
  the slot's delivered fingerprint: `holdsOurKey`, one check in `removeRouteCredential`, for switch-off, route off,
  remove provider, disconnect and reclaim, pi and opencode alike). Any other credential there (the user's own key, a
  sign-in) stays and only the fingerprint is forgotten. A custom definition's native id is ClaudeUI's own, so its
  entry always goes. Removing a provider also clears its model list from `engines/<engine>.json` allowlists, except
  for a catalog vendor an engine still holds a credential for.
- **Arrival** (`harness/arrivals.ts`): only a not-running to running transition counts (an install, a selection
  change, or boot detection finding a System install). `SharedProviderService.harnessArrived(route)` syncs every
  definition to that route alone, then `CredentialSync.harnessArrived(engine)` feeds the active ChatGPT credential
  once and arms its watcher. The other harness is not rewritten, so pi arriving does not recycle a running opencode.
- **Delivered-key fingerprints** (`~/.claude/ui/delivered-key-fingerprints.json`, 0600): per harness slot, the
  SHA-256 of each delivered key, never the key; a removal forgets it. A harness "holds its own key" when it holds a
  credential for the vendor that is neither the vault key nor the fingerprinted one, so a key replaced while the
  harness was away is ClaudeUI's. A slot with no fingerprint has only the vault key as ClaudeUI's.
- **An automatic delivery never replaces a harness's own key** (boot sync, Retry, arrival; `keepsOwnKey`): the route
  is skipped and reports "has its own key ... it was kept" with `ownKeyKept`; the list shows "Own key kept in
  <route>" (warning tone; a failed delivery stays "Not delivered", danger tone). The sheet offers **Use the stored
  key** (`shared-provider:use-stored-key`, `config`, both transports) after the same confirm as switching on. Other
  explicit actions (switching on, adopting, turning a route on) replace after their own confirm. Switching a
  provider on ignores a harness that does not run.
- **A provider created in ClaudeUI is usable in opencode and pi even where the harness holds its own key** (ADR-074
  §12, providers-and-models.md). The Add sheet offers every unmanaged catalog provider with each running harness as
  a target; creating with one that holds an own key asks once: **Overwrite and manage from ClaudeUI**
  (`shared-provider:set-key` with `replaceOwn: [<harnesses asked about>]`) or **Keep <harness>'s own key** (that
  route is created off). Closing cancels with nothing written.
  - Every own-key question asks the host who holds an own key NOW (`shared-provider:own-key-holders`, `config`
    query, both transports; `SharedProviderService.ownKeyHolders`), because the registry's native rows come from a
    catalog cached until ClaudeUI itself writes. A failed read falls back to the screen, and the service still
    refuses an own key the question did not name.
  - **`replaceOwn` is per harness**: `setApiKey` decides which enabled catalog routes hold an own key BEFORE the
    vault takes the new key, keeps every one `replaceOwn` does not name (`ownKeyKept`), and still stores the key and
    delivers every other route. `setDisabled(id, false, replaceOwn)` throws while a harness it does not name holds
    an own key. IPC handlers accept only a list of harness ids (`confirmedHarnesses`; `true` or anything else is
    refused, never read as "all").
  - Native rows name whose credential they are (`ownedBy`; "OpenRouter · pi's own key"); a native row whose vendor
    has a ClaudeUI catalog provider that is off for that harness offers **Use ClaudeUI's <provider> here instead**.
- **A ChatGPT disconnect takes out only what ClaudeUI put in** and ClaudeUI does not sign itself back in from what
  stays. `CredentialSync.disconnectChatgpt` and the last-account removal remove an engine's ChatGPT entry (pi
  `openai-codex`, opencode `openai`) only when its refresh token is one of the vault's ChatGPT accounts (active or
  not) or is in that engine's fed-token history; any other entry is a sign-in made in the harness itself and stays,
  with one info line (never token material). The same helper (`removeManagedCopy`) serves the start-time clean-up of
  a disabled route's copy and an arrival.
  - **A stale copy of ClaudeUI's is still ClaudeUI's**: the fed-token history
    (`auth/vault/fed-token-history.ts`, `~/.claude/ui/chatgpt-fed-token-fingerprints.json`, 0600) keeps the SHA-256
    of the last 32 refresh tokens ClaudeUI fed or adopted as a rotation, per engine, never a token. It decides
    removals only (feeding and adoption never read it), is best-effort (a failure logs, never fails a feed or
    removal) and is forgotten once ClaudeUI's copy is out of the engine. A disconnect first flushes pending watcher
    reconciles (`flushPendingWatches`) so a just-made rotation is recognised, not kept as a direct sign-in.
  - **The disconnect marker**: both paths first record `disconnected: ["chatgpt"]` in the vault file
    (`~/.claude/ui/auth-vault.json`, `AuthVault.setDisconnected` / `isDisconnected`; never token material, written
    before the accounts go). While the vault holds no ChatGPT account and the marker is set, `reconcileOnStart`
    does not bootstrap from an engine's entry, and the legacy-vault recovery is blocked too. A sign-in through
    ClaudeUI (`applyCompletedLogin`: desktop loopback, remote paste-back, device code) clears it.
  - **A harness's ChatGPT switch decides whose sign-in its slot holds.** Switched ON the slot is ClaudeUI's
    (fed, a newer sign-in found there is a rotation, a disconnect removes it); switched OFF it is the harness's own
    and ClaudeUI never writes, adopts or removes a sign-in there. So a sign-in made directly in pi survives a
    disconnect where that harness's ChatGPT is off, and the disconnect copy says so (`chatgptDisconnectText`).
    Telling accounts apart with the switch on was rejected: the harness would run on a different account than
    ClaudeUI shows. opencode 2.x vends access-only rows it owns by id and keeps no fed-token history of its own
    (ADR-097 §5).

Consequences:

- opencode and pi (about 275 MB) are not in the installer; a first run needs one download per extra harness,
  offered by the welcome picker and the Installed page.
- `engine:is-installed` and `crossEngineDispatchAvailable()` are event-driven (`harness:changed { id }`, a replicated
  sync event), because a harness can appear or disappear while the app runs.
- A System opencode or pi can be newer than anything ClaudeUI tested; the untested label is the honest answer.

Rejected: one expanded row per harness listing every candidate (too heavy for a page of four quiet lines); a switch
instead of a segmented control ("System off" does not say what runs instead); a split button holding both sources
(a control that exists nowhere else in Settings); bundling everything (every user downloads engines they may not use, plus a second
copy of tools many already have).

## Engine customization: extend pi through its bridge extension, never fork; no upstreaming (ADR-037)

This is the engine customization policy ADR-037; the other ADR-037, shared provider routing, is in
providers-and-models.md.

- **pi: extend, don't patch.** New capabilities ride pi's extension API (the `-e` bridge extension, ClaudeUI-owned,
  loaded per spawn; `src/core/pi/pi-bridge-source.ts`). The escalation ladder is extension hooks, then spawn flags
  or ephemeral processes, then an upstream feature request, then a fork as a last resort; nothing has needed to go
  past the second rung. ClaudeUI's own extensions must never load into the security judge: the auto-mode judge pi
  spawn keeps `--no-tools --no-extensions --no-skills --no-context-files` (`PiSession.ts`).
- **opencode: no fork.** ClaudeUI does not patch or fork opencode and does not upstream patches (upstream is
  commercializing its own desktop product, and ClaudeUI's needs need not align with it). opencode is the upstream
  npm release, digest-checked by the installer (ADR-082 §4); its judge transport is ADR-081, so nothing depends on
  engine internals.
- Claude Code is the exception that is patched, at the minified cli.js level: ADR-006 and ADR-079 (claude-engine.md).
