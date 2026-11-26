# ClaudeUI's own updates, relaunch and rebuild (as built)

The decisions are ADR-119 to ADR-122 (`docs/adr/app-updates.md`); harness updates are ADR-082 §6. This page is the
as-built map: modules, the files they write, the protocols between them, and the signing-key runbook.

## Modules

| Area                  | Code                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build identity        | `scripts/stamp-build-info.mjs` → `out/build-info.json`; reader `src/shared/build-info.ts`, `src/core/services/build-info.ts`                                         |
| Install marker        | `scripts/stamp-install-marker.mjs` → `claudeui-install.json`; reader `src/shared/install-marker.ts`                                                                  |
| Release manifest      | `scripts/release/update-manifest.mjs` (release job); schema `src/shared/update-manifest.ts`; pinned keys `src/shared/update-keys.ts`                                 |
| Update service (core) | `src/core/services/app-update.ts` (checks, download, state), `app-update-feed.ts` (GitHub feed, manifest checks); commands `src/core/ipc/app-update-commands.ts`     |
| Host seams            | `AppUpdateHost` and `HostRelaunch` in `src/core/host.ts`                                                                                                             |
| Desktop staging       | `src/main/services/app-update-host.ts`, `src/main/services/app-update/` (zip vetting, extract container, codesign policy, boot sweep)                                |
| Desktop relaunch      | `src/main/services/relaunch/` (service, helper scripts, job files, lock, deletion gate, health, reconcile); commands `src/core/ipc/app-relaunch-commands.ts`         |
| Rebuild               | `src/main/services/rebuild/` (trees, the build runner, progress parsing, downloads gate); `build:stage` in `scripts/lib/build-targets.mjs`                           |
| Server                | `src/server/monitor.ts`, `worker-host.ts`, `server-layout.ts`, `server-versions.ts`, `server-records.ts` (see [remote.md](remote.md), the `claudeui-server` section) |
| UI                    | `src/renderer/src/components/Updates/` (button, panel, store, relaunch notice), `SettingsDialog/UpdatesSettings.tsx`                                                 |

## Files on disk (`~/.claude/ui`)

- `app-update.json`: the skipped version and the staged build (`{ schema: 1, skippedVersion?, staged? }`).
- `updates/desktop/<version>/<asset>` and `updates/server/…`: downloaded archives; `updates/desktop/rebuild-<t8>/` and
  `.log`: a rebuild's output and log (swept after 7 days).
- `relaunch/`: per job `<token>.job.json` + `.job.sh`, `.ready`, `.result.json`, `.log`; `lock/` (one restart at a
  time); `health/<installKey>.json` (written by every healthy boot of that install); `restore.json` (one-shot);
  server results `server-<token>.result.json`.
- Next to a desktop install (hidden, all carrying the install basename and a token): `.<base>.extract-<v>-<t8>`
  (an unpack in progress, with `.claudeui-staging.json`), `.<base>.update-<v>-<t8>` (staged), `.<base>.old-<v>-<t8>`
  (the previous build, kept 7 days), `.<base>.failed-<v>-<t8>` (a build that did not start, kept 7 days).
- A server root: `versions/<v>/`, `versions/.partial-<v>-<t8>/` (with `.claudeui-staging`), `current`, `pending`.

## Flows

- **Check → download → stage.** The service asks the GitHub API for releases, picks the newest on the channel that
  carries both manifest files, verifies the manifest (signature under a pinned key, tag, version, channel, never a
  downgrade, asset for this target), downloads the asset through the harness download machinery (host allowlist,
  size cap, sha256), and hands it to the host. The desktop vets a mac zip's central directory (no absolute or `..`
  names, nothing outside `ClaudeUI.app`, no symlink escaping the bundle) before `ditto`, unpacks into an extract
  container, checks the marker and version (and on macOS `codesign --verify --deep --strict` plus the running app's
  designated requirement when it is certificate-signed), then renames it to the staging name.
- **Restart.** `requestRelaunch` refuses unless eligible and nothing is in flight, takes the lock, writes the job,
  spawns the helper and waits for `.ready` (5 s, 15 s on Windows; otherwise it cancels and the app keeps running;
  on Windows an attached launcher starts the helper with `Start-Process` from `<t>.helper-args`), collects the restore
  record from the window, and confirms the quit. The helper waits for the old pid (Windows: and for processes running
  from the install), swaps when asked, launches the install with the same arguments (macOS: `open -n` plus an
  allowlist of identity, mode and proxy variables), and waits for a health record newer than the job. A swap without
  health after 90 s is rolled back. Results are reconciled by the next boot of that install.
- **Built in place** (a macOS workflow: on Windows a build cannot overwrite the folder of a running app). When the
  install's marker `buildId` differs from the running process's (`bun run build:mac` wrote into the folder ClaudeUI
  runs from), `app:relaunch-availability` carries `newBuild` (version, build time, and the short commit when it is
  not the running one: an uncommitted rebuild is named by its build time) and a relaunch job names that build
  (`toVersion`, `toBuild`, `source: 'rebuild'`), so the notice reads "Relaunched into the new build <commit>", or
  warns when it never reported healthy. There is no backup, so no rollback. A refused eligibility reading is not
  cached, so Relaunch is offered as soon as the build lands. On macOS a marker newer than
  `_CodeSignature/CodeResources` is a build not yet signed (the build stamps the marker before `codesign`): a
  relaunch, and a swap (whose backup would be that build), is refused until the seal lands, for at most 5 minutes
  after the marker (`build:unpack` never signs). A swap names the install's build as `fromBuild` (what it backs up
  and rolls back to); a relaunch names the running process's.
- **Rebuild.** A tree from the host's list is built with `bun scripts/build.mjs build:stage` (no `ensure-cli`) into
  `updates/desktop/rebuild-<t8>`, copied through an extract container to the staging name, and applied as a swap with
  `source: 'rebuild'` (an equal or older version is allowed; no codesign identity check).
- **Server.** See [remote.md](remote.md): the monitor restarts the worker on exit code 75; an update lands in
  `versions/<v>/`, `current` switches, and a worker that is not healthy within 90 s is replaced by the previous one.

## Signing-key runbook

The release workflows sign `update-manifest.json` with an Ed25519 key; clients trust only the keys pinned in
`src/shared/update-keys.ts`. Never paste the private key into a chat, a log or a command line.

1. **Generate** (offline machine):
   ```sh
   umask 077
   openssl genpkey -algorithm ed25519 -out update-signing.pem
   openssl pkey -in update-signing.pem -pubout -outform DER | base64 | tr -d '\n' > update-public.spki.b64
   openssl pkey -in update-signing.pem -pubout -outform DER | openssl dgst -sha256 -r | cut -c1-16   # key id
   ```
2. **Pin** the public key: `UPDATE_PUBLIC_KEYS = [{ id: '<key id>', spki: '<update-public.spki.b64>' }]`, and ship it
   in a release before relying on signed manifests (the release job refuses a key no pinned key verifies).
3. **Store** the private key: GitHub → Settings → Environments → `release` (required reviewers, deployment branches
   `main` and `pre-release`), environment secret `UPDATE_SIGNING_KEY` = the full PEM. Not a repository secret.
4. **Back up** the PEM encrypted, offline, in two places the owner controls; then delete the plaintext.
5. **Rotate**: add the new key beside the old one, ship a release signed with the old key, switch the secret, drop
   the old key in a later release. A leaked key: ship the new pinned key at once (signed with the old one) and revoke
   the old secret; clients that missed that release need a manual reinstall.

Until a key is pinned and the secret exists, releases publish no manifest and no client is offered an update.

## Verified, and what is not

Driven live on macOS 27 with a packaged local build in an isolated profile (`verifier-electron`, 2026-11-25):
relaunch (result `ok` in about 1 s), Rebuild & relaunch with a swap (`updated`, backup kept beside the install),
rollback of a build that exits at start (one retry at 15 s, rolled back at 90 s, the previous build relaunched and the
notice shown), and the boot sweep keeping both the 7-day backup and the failed build. Not driven live yet: restoring an
open session after a relaunch (component tests only), the Windows helper and Windows staging (unit and integration
tests; the PowerShell specs run on the Windows CI runners), the server monitor under systemd, launchd and NSSM, and the
download path, which the first signed pre-release after a key is pinned exercises end to end.
