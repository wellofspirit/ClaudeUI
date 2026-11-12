# Core, the two hosts and the one UI build

Governs: `src/core/`, `src/core/host.ts`, `src/core/boot/`, `src/core/ipc/desktop-transport-binding.ts`, `src/core/services/sqlite-driver.ts`, `src/core/services/sqlite/`, `src/main/`, `src/server/`, `src/renderer/web.html`, `electron.vite.config.ts`, `scripts/build-server.mjs`, `src/web/`

Where code lives and what builds it: one service graph in `src/core` that boots under two sibling hosts (`src/main` for
the Electron app, `src/server` for `claudeui-server`), and one renderer build that serves both the desktop and the web
client. How state replicates is ADR-051 (sync-core.md). Type-checking the web client (ADR-008) and the CI build gates and
release artifacts (ADR-061) are in development-workflow.md; the headless admission model (ADR-056) and the host anchor
(ADR-054) are in remote-access.md; the persistence planes (ADR-020) are in persistence-and-settings.md.

## `src/core` is one service graph with two hosts (ADR-058)

`src/core` holds the engine adapters, the PTY manager, the HTTP/WS server, the command registry, the sync layer and
the IPC registrars. `src/main` (Electron) and `src/server` (`claudeui-server`) are siblings: both wire host adapters and
hand control to the same graph; neither is "the real one". The desktop is unchanged by the split: same native SQLite,
same registrar order, same dispatch closure, same audit choke point.

### The extraction is a move behind seams, and the fence is lint

- Modules moved whole; none was redesigned on the way, so a regression is attributable to the move or to a change,
  never both. Specs live next to their subjects: specs for `src/core` modules are under `src/core/**/__tests__/`;
  `src/main/**/__tests__/` keeps only desktop-only modules and the build, script and patch specs.
- **Core imports no Electron, enforced by lint**: `no-restricted-imports` on `src/core/**` against `electron`,
  `electron/*`, `@electron/*`, `@electron-toolkit/*` (`eslint.config.mjs`). Type-only imports are blocked too: a
  `BrowserWindow` in a signature makes core's API Electron-shaped even when nothing is emitted. `__tests__` under
  `src/core` are exempt (the fence guards the shipped graph). An Electron import in a service is a lint error when
  written.
- **Everything host-shaped is injected through `src/core/host.ts`** (window handle, paths, packaged flag, accounts dir,
  app version, directory picker, notifier, OAuth-loopback flag, auth, mockup serving; see the `setHost*` functions).
  Every seam tolerates absence and documents what absence means, so "headless" is a real mode, not a stub:
  `pickHostDirectory()` with nothing wired returns `null`, the same answer a cancelled dialog gives.
- **`HostAuth` is data-only: reads, probes and reports, never a flow.** No sign-in, no `shell.openExternal`, no code
  submission. The desktop auth subsystem (`account-manager`, `ClaudeAuthProvider`, `EngineAuthRegistry`) stays in
  `src/main` because it opens the host browser. A core module that needs a flow method is scope creep into the vendor
  OAuth decision's territory (ADR-057, auth-and-accounts.md), not a missing feature; `src/server` registers nothing for
  it rather than stubbing, because a fabricated account state would make the session layer believe an account is
  active.
- **`HostMockup` is injected pure**: `routeHttpMockup` and `serveMockup` are ordinary functions handed to core; the
  Electron `protocol.register*` half stays desktop-only.
- The Electron-only remainder under `src/main/services` is the services that need the host browser, window or process
  (auth and account management, the plugin manager, log viewer, mockup protocol, `sync-port`, session invalidation,
  and similar); anything that does not need Electron belongs in core.
- **Runtime detection exists in exactly one file**: `src/server/main.ts` asks "am I bun or node". An entrypoint may
  sniff; a library may not.

### The registrars live in core; only the `ipcMain` bind is pluggable

Service construction and channel registration are interleaved in the registrars (a manager is built, channels
register, watchers start, more channels register), so splitting them would reorder side effects. The registrar bodies
live in `src/core/ipc/**` whole and in order, and the one Electron-shaped act, binding a channel to `ipcMain`, is an
injected `DesktopTransportBinder` (`src/core/ipc/desktop-transport-binding.ts`; the ipcMain half is
`src/main/ipc/desktop-transport.ts`). `src/server` installs no binder.

- **Registration still happens headless, and that is load-bearing.** With no binder `handleIpc` registers the channel in
  the registry and binds it to nothing. A channel's declaration (capability, kind, `sessionIdArg`, `withConnection`) is
  channel-global and `CommandRegistry.register` throws when two transports disagree; registering the desktop side
  unconditionally keeps that cross-check alive in every deployment, so a headless build cannot drift into a different
  capability for a channel. Do not skip it.
- **`src/core/boot/core-services.ts` is the composition root and its order is the contract.** One
  `afterSessionGraph` hook covers the few steps that are genuinely the desktop's, because a caller that chooses the
  order can get it wrong.
- **`src/core/boot/host-anchor.ts` exposes the host-anchor `remote:*` bodies as ordinary callable functions**,
  registered on neither transport: the module is never handed to `registerRemoteHandlers` and nothing puts those names
  in the registry. "Host anchor" therefore means whoever is at the machine, not "the Electron renderer".

### Storage is a driver seam with no default

`better-sqlite3` is a native addon; under bun, requiring it panics the process with an uncatchable N-API error even
for `:memory:`, so no try/catch fallback can rescue it. `src/core/services/sqlite-driver.ts` is the storage API;
`src/core/services/sqlite/` has three adapters: `better-sqlite3-driver.ts` (its only importer; desktop behaviour is
unchanged), `bun-sqlite-driver.ts`, `node-sqlite-driver.ts` (over the runtimes' builtins).

- **The entrypoint declares its driver; the seam never sniffs the runtime and has no default** (`src/main/index.ts`
  better-sqlite3, `src/server/main.ts` the bun or node builtin, vitest setup the test driver). An uninstalled driver
  throws a message naming the fix. The failure prevented: the desktop writing its audit log with one SQLite and
  reading it with another.
- **Switching drivers while the DB is open throws** rather than re-opening: two handles on one WAL through different
  engines is corruption, not configuration.
- The builtin drivers take their engine **injected by the entrypoint**: `bun build` hoists a static engine import to
  evaluation time, so a bundled server would die at startup on the other runtime's builtin. Only the entrypoint's two
  branch-guarded `await import`s are lazy in a way the bundler respects; `scripts/build-server.mjs` externalises
  `node:sqlite`/`bun:sqlite` for the same reason.
- Equivalence is pinned by one conformance spec (`sqlite-driver-conformance.ts`): vitest runs it against `node:sqlite`
  and real better-sqlite3 where the ABI allows, and `bun run verify:sqlite` against `bun:sqlite` (vitest cannot host
  it); `build-server.mjs` runs that first. Two divergences are normalised in the seam, not at call sites: a `get()`
  miss is always `undefined` (bun returns `null`), and `emulatePragma` reproduces better-sqlite3's bare-body
  `pragma()`. BLOB typing is not normalised (`db.ts` coerces).

### Two server artifacts, with stated limits

`bun run build:server` produces a pure-asset bundle (`dist/server/`); `bun run build:server:compile` a single-file
executable (`dist/server-bin/`). Neither needs `better-sqlite3` rebuilt. Limits are documented in the dist README, not
hidden (distribution and CI gating are ADR-061):

- **`node-pty` ships beside the artifact**: a native addon a compiled executable cannot embed. `pty-manager` requires
  it lazily in the spawn path, so the server boots and runs sessions without it; only `terminal:*` needs it.
- **The web assets ship beside the executable**, not embedded: a bun single-file executable exposes embedded files
  through `Bun.file`, not `fs`, and embedding would change `RemoteServer`'s static serving. `resolveAppPath()` probes
  candidates for a real `out/renderer/web.html` instead of detecting the packaging; guessing silently serves a stale
  bundle.
- **The pure-asset bundle targets bun.** A `--target=node` build is blocked by `jsonc-parser` (UMD `main`, no
  `exports` map); the `node:sqlite` driver stays live for running from source under node.

### Flags are bootstrap and host anchor only; everything else is a DB setting

`claudeui-server`'s CLI is deliberately tiny: a flag exists only for something a setting cannot cover (`src/server/cli.ts`).

- **Bootstrap**: `--port`, `--bind`, `--tls`. You cannot edit a setting on a server you cannot reach. `--tls` is a
  tri-state: absent leaves the persisted `tlsMode` alone, so a missing flag never silently turns TLS off.
- **Host anchor** (the console IS the host anchor on a headless box, ADR-054/056): `--disable-auth` (policy `off`) and
  the `show-link` and `set-password` subcommands, the things no remote client may ever do.
  - `--disable-auth` is deliberately not `--disable-auth=false`: re-enabling is a Settings action, because a flag that
    can re-enable can silently disable on the next restart when a unit file is edited. It warns on every start.
  - `set-password` provisions and never clears (a console clear on a passkey-less box is a self-brick; Settings can
    clear once connected). The secret arrives on **stdin only**, never argv or an environment variable, asked twice
    with echo off on a terminal and taken as one unconfirmed line on a pipe; `process.stdin.isTTY` decides, not a flag.
  - **`set-password` must open a database and boot nothing else.** Its writer `provisionBreakGlassPassword`
    (`src/core/services/break-glass.ts`, `provisionPassword` plus `auditSettingsChange`) is in its own module, not in
    `boot/host-anchor.ts` (which reaches `remote-server.ts`) and not in `remote-auth.ts` (a thin credential module
    whose unit tests mock `db` narrowly). Routing it through `startCoreServices` would install a recursive `fs.watch`,
    start the usage poller, arm automation timers and let credential sync write engine files, then exit mid-way.
  - Both host anchors (desktop `HostAnchor.setPassword`, which then sweeps clients holding the dead credential with
    4008, and the console) share one writer, so there is one strength rule, one KDF and one `auth:settings-change` row.
    `--disable-auth` goes through the same host-anchor writer `remote:set-config` uses (one validation, audit row and
    disconnect-everyone reaction).
  - The audit identity method for these writes is `host`; the surface is its `label`: `desktop-renderer` in Electron,
    `server-console` in `claudeui-server` (a construction-time `actor` on `createHostAnchor`). `via` names the verb.
    Only the success row is common: a refused attempt leaves a dispatch error row on the web path and nothing on the
    desktop and console paths (raw host-anchor calls). Accepted.
- **First-boot chain** (`src/server/first-boot.ts`): a fresh install admits nobody, so the console prints a one-time
  enrollment link and **re-prints on every start until a credential exists** (a one-time print that scrolled away is a
  bricked deployment, and re-printing is harmless because the gating state is exactly the state where the link is
  useless to anyone who cannot read the console). The link is HTTPS-or-nothing: a WebAuthn credential binds to the
  origin's RP ID, so `mintEnrollToken()` refuses without an active `tailscale serve`.
- Everything else (passkeys, break-glass password, step-up tiers, terminal toggle, audit retention) is a DB setting
  edited from the web UI.

## The desktop and web clients are one UI build (ADR-099)

One renderer build serves both clients. electron-vite's renderer build has three HTML inputs, `index.html` (desktop),
`log-viewer.html` (desktop) and `web.html` (`src/renderer/web.html`, whose script is `src/web/main.tsx`); Rollup shares
hashed chunks and one CSS file across them. There is no `out/web`, no `vite.web.config.ts`, no `build:web` (ADR-008's
type-check of the web client is unchanged). Shared code decides its platform at runtime (`isWebClient()`); only the
edges differ (startup script, per-page CSP and viewport, page background).

- **One stylesheet.** `app.css` is the only Tailwind root; both startup scripts import it. The page background is keyed
  on `<html data-shell="desktop|web">`, set statically in each HTML file. A unit test fails when a second file imports
  Tailwind or an entry stops importing `app.css`. Two copies drifted before (the web client lacked rules that existed
  in the desktop's), so do not reintroduce a per-platform stylesheet.
- **`RemoteServer` serves `out/renderer`** in dev and packaged alike (packaged: `app.asar/out/renderer`, through
  Electron's asar-aware `fs`). It serves `web.html` at `/` and `/remote` and only `/assets/*` besides, confined to the
  `assets` directory with a path separator check so a sibling sharing the prefix cannot pass. The desktop `index.html`
  and `log-viewer.html` beside it are never reachable over HTTP; there is no catch-all for other `.js`/`.css` paths.
- **Compression is part of the build.** A renderer-build plugin writes `.br`/`.gz` siblings into
  `out/renderer/assets` after every build, so local, CI and release all ship them.
- **The renderer is minified with linked source maps** (`minify: 'oxc'`, `sourcemap: true`), because the same chunks
  now go to phones. The maps ship and are served like any asset (the repository is public); Chromium does not apply
  maps to `Error.stack`, so logged stacks stay minified and `scripts/decode-stack.mjs` decodes them against the maps.
- **The headless server copies `out/renderer`**: `build-server.mjs` stages it beside the bundle or executable and
  `resolveAppPath()` looks for `out/renderer/web.html`. A hand-assembled layout with `out/web` stops resolving.
- `electron-builder.yml` keeps excluding `out/web/**` so a stale pre-one-bundle `out/web` in an old checkout cannot ride
  into the asar; a stale `out/web` is otherwise inert.
- **Accepted**: each client's bundle contains the other's lazy or entry-only startup chunks (bytes on disk, never
  loaded); in dev the web client is served from the built `out/renderer` (`bun run build`), not the Vite dev server (no
  hot reload; its HMR socket does not survive a phone on the LAN).
- Rejected: one HTML page choosing its platform at runtime (a single CSP would have to allow what either platform needs,
  weakening both; doing it properly means moving the desktop from `file://` to a custom protocol); keeping two builds
  and sharing only the stylesheet (keeps two pipelines that drift and the stale-bundle trap).
