# ClaudeUI's own updates, relaunch and rebuild

Governs: `src/core/services/app-update.ts`, `src/core/services/app-update-feed.ts`, `src/core/services/build-info.ts`, `src/core/services/claudeui-checkout.ts`, `src/core/ipc/app-update-commands.ts`, `src/core/ipc/app-relaunch-commands.ts`, `src/main/services/relaunch/`, `src/main/services/app-update/`, `src/main/services/rebuild/`, `src/main/services/app-update-host.ts`, `src/server/monitor.ts`, `src/server/worker-host.ts`, `src/server/server-layout.ts`, `src/server/server-versions.ts`, `src/server/server-records.ts`, `src/shared/build-info.ts`, `src/shared/update-manifest.ts`, `src/shared/update-keys.ts`, `src/shared/install-marker.ts`, `src/shared/relaunch.ts`, `src/renderer/src/components/Updates/`, `scripts/stamp-build-info.mjs`, `scripts/stamp-install-marker.mjs`, `scripts/release/`

How ClaudeUI finds, verifies and installs a newer build of itself, how it restarts (with or without a new build),
how the headless server does the same, and how a source tree can be rebuilt into the running install. Harness
updates are ADR-082 §6 (harness-installs.md); the release workflows are ADR-061 (development-workflow.md).

## ClaudeUI updates itself from signed GitHub releases (ADR-119)

ClaudeUI ships portable zips (a macOS arm64 `.app` signed with a self-signed identity, a Windows x64 folder, server
archives), so the updater is in-house: electron-updater needs an NSIS installer on Windows and Squirrel.Mac on macOS
and covers neither local builds nor the server.

- **Build identity.** Every build writes `out/build-info.json` (`src/shared/build-info.ts`): `release` (CI, with its
  channel) or `local` (git describe, commit, dirty, source path); an unpackaged run is `dev` and never updates. A local
  build compares as its base tag, so it is offered only releases newer than the tag it was built on.
- **Feed and trust.** Each release carries `update-manifest.json` (version, tag, channel, per-target asset name, size,
  sha256) and an Ed25519 signature over its exact bytes. The key is the `UPDATE_SIGNING_KEY` secret of the `release`
  environment; public keys are pinned in `src/shared/update-keys.ts` (a list, for rotation). The release step verifies
  its own signature against the pinned keys and fails on a mismatch; with no key it publishes no manifest. A client
  accepts a release only when: the signature verifies under a pinned key; the manifest's tag and version match the
  release; the channel matches (stable takes stable only); the version is newer than the running build (never a
  downgrade, so no replay); the asset for its target exists, is at most 1 GiB and is listed by the release on
  github.com; the download matches size and sha256. On macOS a certificate-signed running app also requires the staged
  bundle to pass `codesign --verify --deep --strict` and its own designated requirement (or one pinned in
  `UPDATE_ACCEPTED_REQUIREMENTS`). Mac release builds fail instead of falling back to ad-hoc signing.
- **Behaviour.** Checks run 30 s after boot, every 6 h and on Check now, through the GitHub API (rate limits hold the
  next check until the reset). Settings `appUpdateMode` (download automatically, ask, off; default automatically) and
  `appUpdateChannel` (follow the build, stable, pre-release). Nothing installs or restarts without a click. A skipped
  version stays hidden until a newer one appears. Mode, channel and the rebuild source are host-owned: a client's
  settings save keeps the host's values, and only `app-update:set-settings` / `app-update:set-source` (`admin`) change
  them. Every write command is `admin`; `app-update:state` is `config` and carries no local path.
- **One Updates panel** in the sidebar footer serves the app and the harnesses (ADR-082 §6): a click opens it and never
  installs; every item has its own action, Later (this client, until the next check) and Skip <version> (host-side).

Consequences: the first build with the updater is installed by hand. Until a signing key is pinned, no client is
offered an update. Rotating the key ships the new public key in a release signed with the old one first.

## Restarts go through a detached helper that waits for health and rolls back (ADR-120)

- **Relaunch** (no new build) and **swap** (a staged build replaces the install) use one helper per platform
  (`/bin/bash -p` on macOS, Windows PowerShell 5.1 via `-EncodedCommand`), spawned before the quit and required to
  report ready within 5 s, or the restart is cancelled and the app keeps running. The quit goes through the quit
  coordinator without the worktree prompt. The helper waits for the old process (and on Windows for every process
  running from the install), renames the install aside and the staged build in, launches it, and waits up to 90 s for
  a health record that any boot of that install writes once its window loaded and the remote start settled. No health
  after a swap → it rolls back and relaunches the previous build. No exit path leaves the user with nothing running.
- **Ownership.** Every packaged build carries an install marker (`claudeui-install.json`: product, kind, version, build
  id; on Windows the folder's top-level entries). A Windows folder holding anything else is not eligible (a zip
  extracted into Downloads must never be renamed). One deletion gate is the only recursive delete: a sibling of the
  install, a name we generate (with the job's token), a real directory, and a marker or our staging record.
- **Picking up.** The desktop window's open session and drafts are restored after the restart; a web client reloads
  when the host's build id changes and restores its session. A packaged Windows app moves its working directory off
  the install folder. The previous build is kept 7 days.
- **Stores.** A credential vault written by a newer ClaudeUI is read-only to an older one (a rollback must not wipe
  accounts); the database already tolerates newer schemas (its migrations are additive and never rewind a newer
  `user_version`, `src/core/services/db.ts`).

## Rebuild & relaunch builds a host-listed source tree into the running install (ADR-121)

An admin can rebuild ClaudeUI from source and restart into it, so a change made with an agent on a remote host can be
tried without touching that machine. Trees are the host's own list: the source checkout of a local build (or the
admin-set source) and its git worktrees; a client never supplies a path. The build (`build:stage`) never runs
`ensure-cli` (a worktree's `vendor/` is the main checkout's), is refused when the tree's Claude Code or lockfile
differ from what is installed, writes into a staging directory (never the running install or the tree's `dist/`) and
is applied through the same swap, health and rollback as an update.

## The headless server supervises itself and keeps one folder per version (ADR-122)

`claudeui-server serve` runs a small monitor that starts the real server as a child and restarts it on exit code 75
(a relaunch, or an update). Updates land in `<root>/versions/<v>/`; `current` names the version to run and `pending`
the update in flight; a worker that does not report healthy within 90 s is killed and the previous version restarted,
also after the monitor itself was stopped mid-window. A flat install adopts the layout on its first update. The
monitor protocol (exit 75, the env variables, `versions/<v>/` plus a server marker, `current` and `pending`, the health
and result files, the 90 s window) is a stable contract: a newer worker runs under an older monitor until the next
reinstall, and a worker accepts a set of protocol versions. `--no-monitor`, containers and installs without a marker
get the notice only. `--disable-auth` reaches the first worker only.

## Retired
