# ADR-058 — `src/core` and `claudeui-server`: one service graph, two hosts

**Status:** **Accepted** — as-built record (2026-08-18/19). Three series on `v3`: S2 `c61c9d8` (the physical extraction), S3 stage 1 `f007525` (the SQLite driver seam + the registrar move behind a pluggable desktop binder), S3 stages 2-3 `a0d0f90` (the entrypoint and its distributions). As-built mechanics live in [sync-core.md](../architecture/sync-core.md) (§Topology, §Headless specifics, §Follow-ons), [source-layout.md](../architecture/source-layout.md) (the tree and the seam table) and [persistence.md](../architecture/persistence.md) (the driver seam); this ADR keeps the decisions and the reasoning that the code does not carry on its face.
**Relates to:** ADR-051 (this realizes its decision 5, "Headless-first" — the core split it anticipated; the topology prose is [sync-core.md](../architecture/sync-core.md) §Topology), ADR-054 (the host anchor, whose meaning this generalizes), ADR-056 (the admission model the first-boot chain bootstraps), ADR-057 (vendor OAuth — why `HostAuth` is data-only), ADR-006 (the rebundled `bun-claude` binary the core still spawns).

## Context

ADR-051 declared a topology — a window-independent core, a desktop shell, and a headless
entrypoint — and phase 4d proved the behaviour half of it: the Electron app boots, syncs
and serves with **no `BrowserWindow` at all** (`CLAUDEUI_NO_WINDOW=1`). What it did not
prove is that the graph can run with no Electron at all, because the files still lived in
`src/main` and the registrars still called `ipcMain.handle`.

Three things stood in the way, and each is a decision below: the code was in the wrong
place and touched Electron in ~a dozen scattered spots; the ~2,200 lines of IPC registrar
were the only reason those spots existed; and the operational DB could not open at all
outside Electron, because `better-sqlite3` is a native addon.

## Decisions

### 1. The extraction is a MOVE, not a rewrite

`src/main/sync/**`, `src/shared/sync/**`, the engine adapters, the PTY manager, the
HTTP/WS server, the command registry and the services they need moved to `src/core`
**whole**. No module was redesigned on the way, and the review of S2 was a review of
imports, not of behaviour. That was the point: the graph had just been rewritten by
phases 4a-4d, and stacking a redesign on a move would have made every regression
ambiguous between the two.

The Electron-free constraint is **lint-enforced, not documented** —
`no-restricted-imports` on `src/core/**` against `electron`, `electron/*`, `@electron/*`
and `@electron-toolkit/*`. **Type-only imports are blocked too**, deliberately: a
`BrowserWindow` in a signature makes core's API Electron-shaped even when nothing is
emitted at runtime, and the failure mode this fence exists to stop is precisely the
convenient `import type` that nobody notices. `**/__tests__/**` under `src/core` is
EXEMPT (`ignores` on the same config block), so a spec may still reach for an Electron
stub — the fence guards the shipped graph, not its tests.

### 2. Seven host seams, and `HostAuth` is DATA-ONLY by hard constraint

Everything genuinely host-shaped is injected through `src/core/host.ts`:
`HostWindowHandle`, `HostPaths`, `hostIsPackaged`, `HostPicker`, `HostNotifier`,
`HostAuth`, `HostMockup`. Five landed in S2; the packaged-build flag and the picker were
added in S3. Every seam **tolerates absence** and documents what absence means, so
"headless" is a real mode rather than a stubbed one — `pickHostDirectory()` with nothing
wired returns `null`, which is the same answer a cancelled dialog gives.

Two of them carry a rule that is not obvious from their types:

- **`HostAuth` exposes reads, probes and reports — never a flow.** No sign-in, no
  `shell.openExternal`, no code submission. The desktop auth subsystem
  (`account-manager`, `ClaudeAuthProvider`, `EngineAuthRegistry`) stays in `src/main`
  because it opens the host browser. A core module that needs a flow method is scope
  creep into ADR-057's territory, not a missing feature — and `src/server` registers
  **nothing** for it rather than stubbing, because a fabricated account state would make
  the session layer believe a Claude account is active.
- **`HostMockup` is injected PURE.** `mockup-protocol.ts` splits: `routeHttpMockup` +
  `serveMockup` are ordinary functions handed to core; the Electron
  `protocol.register*` half stays desktop-only.

### 3. The registrars move whole; only the ipcMain BIND is pluggable

The obvious split — "service construction" to core, "channel registration" stays in main
— is not achievable. In `registerSessionIpc` the two are **interleaved**: the manager is
built, ~100 channels register, then `gitWatchRegistry.init()` / the projects and config
watchers / `seedCanonicalAppState()` / `usageFetcher.startPolling()` run, then nine more
channels register. Splitting on that axis would REORDER side effects, which is exactly
what a behaviour-equivalent refactor may not do.

So the split is on the other axis. The registrar bodies live in `src/core/ipc/**` whole
and in order — ordering is preserved by construction — and the one Electron-shaped act,
binding a channel to `ipcMain`, becomes an injected `DesktopTransportBinder`
(`src/core/ipc/desktop-transport-binding.ts`), whose ipcMain half is
`src/main/ipc/desktop-transport.ts`. `src/server` installs no binder at all.

**Registration still happens headless, and that is load-bearing.** With no binder,
`handleIpc` registers the channel in the registry and binds it to nothing. It would be
tempting to skip the registration too; don't — a channel's DECLARATION (capability, kind,
`sessionIdArg`, `withConnection`) is channel-global and `CommandRegistry.register` throws
on a per-transport disagreement. Registering the desktop side unconditionally keeps that
cross-check alive in every deployment, so a headless-only build cannot quietly drift into
a different capability for a channel than the desktop build has.

`core/boot/core-services.ts` owns the ordered graph (**its order is its contract**, with
one `afterSessionGraph` hook for the three steps that are genuinely the desktop's, because
a caller that gets to choose the order is a caller that can get it wrong).
`core/boot/host-anchor.ts` exposes the ten `remote:*` bodies as ordinary callable
functions — registered on **neither** transport, by construction: the module is never
handed to `registerRemoteHandlers` and nothing puts those names in the registry. That is
what lets "host anchor" stop meaning "the Electron renderer" and start meaning "whoever is
at the machine", which is what ADR-054's name always claimed.

### 4. Storage is a driver seam, dual-builtin, with NO default

`db.ts` used to `import BetterSqlite3 from 'better-sqlite3'` statically, which made the
operational DB — and therefore most of `src/core` — loadable only under a runtime that can
`dlopen` a Node addon. S3 stage 0 measured the alternative and found it worse than
expected: under bun (1.3.6 and 1.3.14), `require('better-sqlite3')` does not fail, it
**panics the process** with an uncatchable N-API fatal error at construct time, even for
`:memory:`. No try/catch fallback could ever have rescued it.

`src/core/services/sqlite-driver.ts` is therefore the storage API and
`src/core/services/sqlite/` holds three adapters: `better-sqlite3-driver.ts` (the only
importer of the native module — desktop behaviour is byte-identical), plus
`bun-sqlite-driver.ts` and `node-sqlite-driver.ts` over the two runtimes' BUILTINS. Both
builtins take their engine **injected by the entrypoint** rather than importing it
themselves, because `bun build` hoists a module's static engine import to evaluation time
even when the module is reachable only down a branch that never runs — a bundled server
would then die at startup on the other runtime's builtin. Only the entrypoint's two
branch-guarded `await import`s are lazy in a way the bundler respects, and
`scripts/build-server.mjs` externalises `node:sqlite`/`bun:sqlite` for the same reason.

**Selection is explicit and there is deliberately no default.** The seam never sniffs the
runtime; the ENTRYPOINT declares its driver (`src/main/index.ts` → better-sqlite3,
`src/server/main.ts` → bun/node builtin, vitest setup → the test driver), and an
uninstalled driver throws a message naming the fix. The failure this prevents is "the
desktop wrote its audit log with a different SQLite than it read it with", and a
convenient fallback is exactly how that would happen unnoticed. Switching drivers while
the DB is open throws rather than re-opening — two handles on one WAL through different
engines is a corruption story, not a configuration change.

Equivalence is pinned, not assumed: one conformance spec
(`src/core/services/__tests__/sqlite-driver-conformance.ts`) runs under vitest against
`node:sqlite` and real better-sqlite3 where the ABI permits, and under `bun run
verify:sqlite` against `bun:sqlite` (vitest cannot host a bun builtin), which
`build-server.mjs` runs before producing either artifact. Two divergences are normalised
in the seam rather than at ~40 call sites in `db.ts`: a `get()` miss is always `undefined`
(bun returns `null`), and `emulatePragma` reproduces better-sqlite3's bare-body `pragma()`
— measured against the real engine, which is how a long-standing vitest shim's invented
write/read split was found and deleted. BLOB typing is deliberately NOT normalised
(`db.ts` already coerces).

### 5. Two artifacts, both native-dependency-free for storage — with the limits stated

`bun run build:server` produces a pure-asset bundle (`dist/server/`); `bun run
build:server:compile` produces a single-file executable (`dist/server-bin/`). Neither
needs `better-sqlite3` rebuilt per platform or per ABI. Three limitations are documented
in the generated dist README rather than smuggled past the reader:

- **`node-pty` ships beside the artifact.** It is a native addon so `--compile` cannot
  embed it, but it loads fine under bun and `pty-manager` `require()`s it lazily, inside
  the spawn path. The server boots, serves and runs sessions without it; only `terminal:*`
  needs it.
- **The web assets ship beside the executable.** A bun single-file executable exposes
  embedded files through `Bun.file`, not `fs` against a real path, so genuinely embedding
  `out/web` would mean changing `RemoteServer`'s static serving — a core change, out of
  scope for a build stage. `resolveAppPath()` probes candidates for an actual `out/web`
  directory rather than detecting the packaging, because guessing is how you silently
  serve a stale bundle.
- **The pure-asset bundle targets bun.** A `--target=node` build is blocked by
  `jsonc-parser`, which ships a UMD `main` and an ESM `module` with no `exports` map; the
  node target resolves the UMD entry, whose internal `require("./impl/format")` does not
  survive bundling. Fixing it needs a resolver alias driven through `Bun.build()` with a
  plugin — a build rework, not a flag. The `node:sqlite` driver stays fully live and
  tested for anyone running from source under node.

### 6. Flags are bootstrap and host anchor ONLY; everything else is DB-resident

`claudeui-server`'s CLI surface is deliberately tiny, and the rule is stated rather than
merely followed: a flag exists only for something a setting cannot cover.

- **Bootstrap** — `--port`, `--bind`, `--tls`. You cannot edit a setting on a server you
  cannot reach yet. `--tls` is a **tri-state**: absent leaves the persisted `tlsMode`
  alone, because an absent flag must not silently turn TLS off for a server whose stored
  config asked for it.
- **Host anchor** — `--disable-auth` (policy `off`) and the `show-link` subcommand. On a
  headless box the console IS the host anchor (ADR-054/056), and these are the two things
  no remote client may ever do: disable authentication, and mint a fresh enrollment link
  when the only one you had expired. `--disable-auth` is deliberately not
  `--disable-auth=false` — re-enabling is a Settings action, because a flag that can
  silently re-enable is a flag that can silently disable on the next restart when someone
  edits the unit file — and it warns on **every** start, not just the one where the switch
  was flipped.
- **Everything else is a DB setting**, editable from the web UI once connected: passkeys,
  the break-glass password, step-up tiers, the terminal toggle, audit retention.

`--disable-auth` routes through the SAME host-anchor writer `remote:set-config` uses, so
the validation, the audit row and the disconnect-every-client reaction are one
implementation on both host surfaces.

The first-boot console chain (`src/server/first-boot.ts`) is what makes ADR-056's
"nothing can connect to a fresh install" a bootstrap rather than a brick: it prints a
one-time enrollment link, and **re-prints on every start until a credential exists**,
because a one-time print that scrolled off the screen is a bricked deployment while
re-printing costs nothing (the state that gates it is exactly the state in which the link
is useless to anyone who cannot already read the console). The link is HTTPS-or-nothing —
a WebAuthn credential binds to the RP ID of the origin that created it, so
`mintEnrollToken()` refuses without an active `tailscale serve` rather than minting a
credential bound to a name that will not exist tomorrow.

## Consequences

- **`src/main` and `src/server` are siblings.** Both are HOSTS that wire adapters and hand
  control to the same graph; neither is "the real one". The RUNTIME remainder in
  `src/main/services` is exactly the Electron seven — `auth-manager`, `account-manager`,
  `plugin-manager`, `log-viewer`, `mockup-protocol`, `sync-port`, `session-invalidation`.
  The legacy `__tests__` trees did NOT move with their subjects: `src/main/services/__tests__/`
  still holds ~104 specs, most of them testing modules that now live in
  `src/core/services/` (`remote-server`, `db*`, `git-watch-registry`, …), and
  `src/main/auth/vault/__tests__/` likewise tests `src/core/auth/vault/`. That is known
  residue, deliberately deferred — `vitest.config.ts` still names the old path for the git
  project, and relocating the specs is a mechanical follow-up, not part of the S2 move.
- **The desktop is unchanged, and that is the acceptance criterion.** Same native SQLite,
  same registrar order, same dispatch closure, same audit choke point. Every S2/S3 change
  is either a moved file, an injected seam, or a build script.
- **A headless-only capability drift is structurally impossible** — see decision 3's
  unconditional desktop registration.
- **`src/core` is now the fence that catches design drift early.** Anything that reaches
  for Electron in a service is a lint error at the moment it is written, not a discovery
  made when someone tries to run the server.
- **Runtime detection exists in exactly one file.** `src/server/main.ts` asks "am I bun or
  node" and nothing else in the codebase does. An entrypoint may sniff; a library may not.
