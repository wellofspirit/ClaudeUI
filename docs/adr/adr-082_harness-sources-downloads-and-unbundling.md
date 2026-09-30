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
bundled; the exact-version gate stays).
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
"Engines" becomes **Harnesses**. Its first page manages the programs. The working name is
**Installed**; the owner's alternative is "Engines", and the choice is open until arc 2. The existing
per-harness pages follow it unchanged, with "Claude" renamed "Claude Code". Arc 2 includes a copy
pass so the rest of the UI (welcome picker, dispatch targets, provider engine pills) uses one term.

### 2. Two sources per harness

Each harness row has a segmented control and a version dropdown:

| Harness      | Left segment                           | Right segment                                 | Version dropdown                         |
| ------------ | -------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| Claude Code  | **Bundled** (the patched `bun-claude`) | **System**                                    | Bundled: locked to the shipped version   |
| opencode, pi | **ClaudeUI** (a managed download)      | **System**                                    | ClaudeUI: Latest, Tested, or one version |
| Codex        | **ClaudeUI**                           | **System**, only when it prints the exact pin | ClaudeUI: locked to the pin              |

- **System** is the newest compatible install detection finds. The row shows its version and path
  read-only. ClaudeUI never modifies, updates or deletes a system install.
- **Latest** follows upstream's newest release and is marked untested. **Tested** follows the version
  this ClaudeUI release pins, so it moves when ClaudeUI updates. Choosing a version keeps it.
- Switching to System keeps the last ClaudeUI choice, greyed out, so switching back restores it.
- A System segment is disabled when nothing usable was found, and the row's description says why
  (not found, too old, wrong Codex version).
- The setting lives in `engines/<harness>.json` as `harness: { source, version }`. A new or respawned
  session reads it at spawn; a running session keeps its binary (ADR-079's respawn rule, extended).

### 3. Detection classifies, it doesn't just list

Detection searches PATH, the npm global prefix, and each harness's own install directories. On macOS
and Linux it also reads the login shell's PATH once, because an app started from the Finder doesn't
get it. A Windows npm `.cmd` shim resolves to the real executable, because signals and process-tree
kills need the real process.

Each candidate runs `--version` in an isolated environment and gets one of three labels: **tested**
(equals the pin), **untested** (newer, selectable), **too old** (below the floor, listed but not
selectable). Each harness declares its floor in the release manifest (§5). For Claude Code the floor
is the first release that accepts every flag and control request ClaudeUI always sends
(`--forward-subagent-text`, `background_tasks`, `command_lifecycle`, `reload_plugins`). Arc 2
measures it; nobody has checked it yet.

### 4. Downloads

- Sources are official only: the npm registry for opencode (`opencode-<os>-<arch>`), GitHub releases
  for pi and Codex. The pipelines `ensure-*.mjs` use today are the reference.
- Every download is checked before first use. A tested version is checked against a SHA-256 reviewed
  into this repo, following the `scripts/codex-digests.json` model, extended to opencode and pi. Any
  other version can only be checked against the publisher's own hash (npm's `integrity`, pi's
  `SHA256SUMS`). That catches corruption but not a compromised release, and the UI labels it
  untested. A mismatch deletes the file and stops. There is no override.
- After the hash, `--version` must print the expected version.
- Installs go to `~/.claude/ui/engines/<harness>/<version>/` by atomic directory rename. A version
  directory is never overwritten, because a running `opencode serve` holds its binary open (Windows
  returns EPERM). Versions no session uses are removed after seven days. The desktop app and
  `claudeui-server` share the directory.
- The page shows the active download as a progress pill in its top-right corner; several downloads
  show a count that opens the list.

### 5. The release manifest

Each ClaudeUI release carries one manifest per harness: the tested version, the floor, the download
coordinates per platform, and the reviewed digests. It replaces the `package.json` pins
(`opencodeCliVersion`, `piCliVersion`, `codexCliVersion`) as the source of truth for what "Tested"
means. `claudeCliVersion` stays, because Claude Code stays bundled.

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

## Consequences

- The installer shrinks by about 650 MB. A first run needs one download per extra harness a user
  wants; the welcome picker and this page both offer it.
- `engine:is-installed` and `crossEngineDispatchAvailable()` become event-driven, because a harness
  can appear or disappear while the app runs.
- A System opencode or pi can be newer than anything ClaudeUI tested. The untested label is the
  honest answer; ADR-081 removes the judge's dependency on engine internals, which was the largest
  version-sensitive piece.
- Codex users get a download even when they already have Codex installed, unless their version
  matches the pin exactly.
- `getCliVersion()` must read `--version` for a non-bundled Claude Code instead of returning
  `unknown`.

## Open questions (defaults proposed, owner to confirm)

1. The page name: Installed or Engines.
2. Whether a custom file path (outside detection) gets UI, or stays an environment variable for
   development. Default: environment variable only, generalised from `CLAUDEUI_CLAUDE_CLI` to each
   harness.
3. The retention window for unused versions. Default: seven days.

## Rejected alternatives

- **One expanded row per harness with every candidate listed** (mockup `eb22e639`). Too heavy for a
  page that is usually four quiet lines.
- **A switch instead of a segmented control** (mockup `8bf84c23` design 2). "System off" doesn't say
  what runs instead.
- **A split button holding both sources** (design 4). Compact, but a control that exists nowhere
  else in Settings.
- **Keep bundling everything.** Costs every user about 650 MB and keeps a second copy of tools many
  already have.
