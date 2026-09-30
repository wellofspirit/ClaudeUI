# ADR-082: Harnesses run from ClaudeUI's managed copy or the system install, ClaudeUI downloads and updates its copies, and the installer stops shipping opencode, pi and Codex

**Status:** Proposed (2026-09-28). The design is owner-ruled from mockups `8bf84c23` (design 1, the
Harnesses rows) and `04c3853c` (the sidebar update button). Implementation is arcs 2 and 3 of the
3.6 line, after [ADR-081](adr-081_claudeui-owned-judge-transport.md). This ADR moves to Accepted
when arc 2 lands.
**Amends:** [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (the Engines rail
group becomes Harnesses and gains a first page), [ADR-079](adr-079_claude-harness-capability-gating-and-patch-set.md)
(`CLAUDEUI_CLAUDE_CLI` gets a setting; "respawn follows the configured harness" extends to every
harness), [ADR-061](adr-061_ci-build-gates-and-release-artifact-matrix.md) (release artifacts lose
three engine directories), [ADR-066](adr-066_codex-fourth-engine.md) (Codex is downloaded, not
bundled; ClaudeUI's own copy stays at the pin, and a System Codex from the floor up to the ceiling
runs as untested, §3).
**Relates to:** [ADR-052](adr-052_remote-auth-passkeys-capabilities.md) (the capability that gates
installs from a remote device), [ADR-035](adr-035_pi-engine-backend.md), [ADR-019](adr-019_opencode-engine-backend.md).

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
  bundled copy and says why. The answer is cached per harness and recomputed on an install, a
  selection change or a finished detection, so status checks do no disk work.
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
(`@opencode/cli`) already ships an executable named `opencode` whose configuration is incompatible
with 1.x. The ceilings are Claude Code 3.0.0, opencode 2.0.0, pi 1.0.0 and Codex 1.0.0. pi and Codex
are 0.x, where a minor release may break in semver terms; their ceilings are set at 1.0.0 anyway,
because what ClaudeUI depends on (pi's RPC and extension API, Codex's app-server protocol) is what
the tested version is checked against. This is a judgement call, not a guarantee.

The Claude Code floor is 2.1.275 (owner, 2026-09-30). `--forward-subagent-text`, which ClaudeUI
always passes, first appeared in 2.1.211; older builds exit on it with `unknown option`. The
behaviour the protocol docs describe also depends on later fixes: nested subagent forwarding
(2.1.219), headless `/reload-plugins` (2.1.260), forked skills streaming (2.1.265), a subagent's
final messages after it moves to the background (2.1.273) and `context: fork` skill subagents
(2.1.275). opencode, pi and Codex keep floor = tested until someone measures lower.

### 4. Downloads

- Sources are official only: the npm registry for opencode (`opencode-<os>-<arch>`), GitHub releases
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

### 5. The release manifest

Each ClaudeUI release carries one manifest per harness, `src/shared/harness-manifests/<harness>.json`:
the tested version, the floor, the ceiling, the download coordinates per platform, and the reviewed
digests. It replaces the `package.json` pins (`opencodeCliVersion`, `piCliVersion`,
`codexCliVersion`) and the `scripts/*-digests.json` files as the source of truth for what "Tested"
means; the `ensure-*` scripts and CI cache keys read it. `claudeCliVersion` stays, because Claude
Code stays bundled; the Claude manifest's `tested` matches it. The Claude Code floor is below its
tested version (§3); the other floors equal their tested versions until measured.

### 6. Updates

- A global setting, **Install updates: Automatically | Ask me**, defaults to Ask me.
- In Ask me mode, a button appears in the main sidebar's footer, to the left of Remote Access,
  when a ClaudeUI-managed harness on Latest or Tested has something newer. It takes the footer's
  `ml-auto` so Remote and Settings stay right-aligned. One click updates every such harness. Its
  states are a count badge, a spinner while updating, a check that fades after five seconds, and
  amber after a failure. Clicking during or after an update opens a small panel naming each harness,
  its versions, and any failure with its reason.
- Bundled Claude Code and Codex move only with ClaudeUI releases. System installs update themselves.
  Neither counts toward the button.
- Latest combined with Automatically is allowed, with a warning on the row.

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
engines, ClaudeUI shows one sheet listing the harnesses this profile has used (past sessions or
config), with one Install button for their Tested versions. Nothing downloads without that click;
the sheet does not come back once answered. A harness the sheet skipped is offered again when a
session on it is opened.

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

## Rejected alternatives

- **One expanded row per harness with every candidate listed** (mockup `eb22e639`). Too heavy for a
  page that is usually four quiet lines.
- **A switch instead of a segmented control** (mockup `8bf84c23` design 2). "System off" doesn't say
  what runs instead.
- **A split button holding both sources** (design 4). Compact, but a control that exists nowhere
  else in Settings.
- **Keep bundling everything.** Costs every user about 650 MB and keeps a second copy of tools many
  already have.
