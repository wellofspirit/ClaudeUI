# Source layout & the service catalog

Part of [architecture/](README.md).

## Source layout

Since the S2/S3 headless arc the tree has three top-level roles: **`src/core`** is the
window-independent service graph (no Electron, lint-enforced), and **`src/main`** and
**`src/server`** are the two HOSTS that wire adapters into it and hand it control
(ADR-058; topology in [sync-core.md](sync-core.md) §Topology).

```
src/
  shared/              — engine-neutral types (types.ts), capability model
                         (model-capabilities.ts), tool-kind taxonomy (tool-kinds.ts),
                         pricing, project-key, engine-meta, permission-modes,
                         remote protocol, E2E crypto, audio/ (PCM16 helpers)
  core/                — the Electron-free service graph. Both hosts boot THIS.
    host.ts            — the host-adapter seams (see §Host seams below)
    boot/              — core-services.ts (the ordered service graph — its order IS
                         its contract) + host-anchor.ts (the ten `remote:*` bodies,
                         callable, never registered on any transport)
    sdk/               — in-house cli.js harness: query(), tool(), createSdkMcpServer()
                         (module map: docs/protocol/01-transport.md §1.13)
    providers/         — engine seam: ISession, BaseSession, EngineRegistry,
                         SpawnPrepRegistry, session-queue, register-engines
    opencode/          — opencode backend: OpencodeServerManager, OpencodeClient,
                         OpencodeSession, event-mapper, model-discovery, config
                         writers, permission compiler, hosted-tools MCP host
    pi/                — pi backend: PiRpcClient (stdio JSONL), PiSession, event-mapper,
                         model-discovery, PiBridgeHost (loopback approval + hosted-tool
                         host), pi-bridge-source (the -e extension), permission-engine,
                         pi-locate, pi-protocol (ADR-035)
    automode/          — engine-neutral auto-mode judge: classifier.ts, rules/,
                         ground-truth.ts, denial-tracker.ts (ADR-023/050)
    auth/              — EngineAuthProvider + opencode/pi implementations; vault/
                         (AuthVault, CredentialSync, codex-oauth — ADR-036/037)
    shared-providers/  — canonical provider/model routing + native projections (ADR-037)
    ipc/               — the registrars (session/terminal/automation/webauthn/authcfg)
                         + command-registry, remote-handlers, the shared command
                         factories (auth/authcfg/webauthn/config/automation) and
                         desktop-transport-binding.ts (the pluggable ipcMain seam)
    sync/              — SyncCore itself: sync-core.ts (canonical state + funnel),
                         event-ring.ts
    shared/sync/       — the wire types both sides fold: channels.ts (the closed
                         channel set), reducer.ts, state.ts, stream.ts, sync-client.ts,
                         sync-decision.ts, client-registry.ts, events.ts
    services/          — ~65 service modules (key ones below)
  main/                — HOST 1: the Electron desktop
    index.ts           — app lifecycle, BrowserWindow setup, SQLite driver install
    boot-core.ts       — the desktop composition root: transport binder, host
                         adapters, the ten `remote:*` ipcMain registrations
    ipc/               — desktop-transport.ts (the ipcMain half of the binder)
    auth/              — ClaudeAuthProvider + EngineAuthRegistry (they stay here:
                         Claude sign-in opens the host browser) + register-auth-
                         providers.ts, side-effect-imported by boot-core.ts to
                         populate the registry
    services/          — the desktop-only RUNTIME remainder: account-manager,
                         auth-manager, plugin-manager, log-viewer, mockup-protocol,
                         sync-port, session-invalidation
    services/__tests__/  — legacy: ~104 specs that did NOT move with their subjects;
                         most test modules that now live in src/core/services/
                         (look here for a core service's tests)
    quit-coordinator.ts
  server/              — HOST 2: `claudeui-server`, the headless entrypoint
    main.ts            — driver selection, headless host adapters, boot, shutdown
    cli.ts             — argument surface (bootstrap + host anchor only)
    first-boot.ts      — the console enrollment chain (security.md §Headless
                         bootstrap chain)
  preload/             — context bridges: window.api (ClaudeAPI), plugin, log viewer
  renderer/src/
    stores/            — Zustand stores (session-store.ts + replica.ts, the reducer
                         projection; sealed-fields.ts names the sealed set)
    sync/              — desktop-transport.ts: client #1 over a MessagePort
    hooks/             — IPC event listeners (useClaudeEvents), git watcher, menus
    components/        — chat/ (incl. tool-registry/), git/, plan/, automation/,
                         terminal/, usage/, auth/, SettingsDialog/, Sidebar/,
                         shared/, plugin/
    lib/diff/          — custom diff viewer (parse-patch, unified/split tables)
  renderer/log-viewer/ — standalone log viewer window
  web/                 — remote-access web client (WebSocket + E2E encryption)
  test/                — shared test infra: TestIpcBridge, electron/sdk/sqlite/pty
                         stubs, factories, helpers, setup (installs the SQLite driver)
  e2e/flows/           — layer-3 E2E tests
  integration/         — layer-4 integration tests (real engine binaries, gated)
vendor/                — rebundled bun-claude + vendored opencode/pi binaries (not checked in)
scripts/               — build-time helpers (extract-cli, rebundle-cli, ensure-opencode,
                         build-server.mjs for the two server artifacts,
                         verify-bun-sqlite.ts for driver conformance,
                         app-shot.mjs for real-app verification)
patch/                 — cli.js content-regex patches (registry: apply-all.mjs)
```

## Host seams

`src/core/host.ts` holds every host-shaped concern as a neutral, absence-tolerant seam.
Seven of them, each with a documented headless behaviour:

| Seam | Desktop implementation | Headless |
| ---- | ---------------------- | -------- |
| `HostWindowHandle` | the real `BrowserWindow` (read at USE time via `services/host-window.ts`) | `null` — a real mode |
| `HostPaths` | `app.getAppPath()` | the directory containing `out/web` (`resolveAppPath`) |
| `hostIsPackaged` | `app.isPackaged` | `true` — a deployed server is not a dev build |
| `HostPicker` | `dialog.showOpenDialog` | unset; `pickHostDirectory()` resolves `null` (the channel is `host`-capability, so no remote client can reach it anyway) |
| `HostNotifier` | Electron `Notification`, passed to `startCoreServices({ notifier })` and handed to `AutomationManager` — a bare type, NOT one of the five `setHostX` module-level seams | omitted — no desktop to notify |
| `HostAuth` | account/Claude-auth **reads only** | unset — a fabricated account state would be worse than none |
| `HostMockup` | `mockup-protocol`'s pure `routeHttpMockup` + `serveMockup` | unset |

`HostAuth` is DATA/STATUS-ONLY by hard constraint: no sign-in, no `shell.openExternal`,
no code submission. Vendor OAuth from a browserless host is ADR-057's paste-back flow,
not a seam method.

## Service catalog

Key modules in `src/core/services/`:

| Service                     | Purpose                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `claude-session.ts`         | Core cli.js wrapper — spawns `sdkQuery()`, handles streaming, approvals, tool results                   |
| `session-manager.ts`        | Maps routingId → ISession, lifecycle, rekey, timeouts                                                   |
| `session-history.ts`        | Parses JSONL transcripts, loads history, computes token metrics                                         |
| `session-watcher.ts`        | Watches session JSONL files for live updates                                                            |
| `service-session.ts`        | Lightweight CLI subprocess for background usage polling + OAuth hosting (ADR-014)                       |
| `session-delete.ts`         | Engine-neutral session/project delete dispatcher (ADR-025)                                              |
| `subagent-watcher.ts`       | Watches subagent task files, parses messages                                                            |
| `assistant-message.ts`      | Shared assistant-message transform (used by ClaudeSession + the dispatcher)                             |
| `cross-engine-dispatcher.ts`| Headless cross-engine dispatch targets, approval forwarding, usage capture (ADR-033)                    |
| `collab-tool.ts`            | Hosted `dispatch_agent` MCP tool registration (ADR-033)                                                 |
| `automation-manager.ts`     | Cron/interval scheduling, run history, cli.js execution                                                 |
| `git-service.ts`            | Wraps simple-git: status, branches, stage/unstage, commit, push/pull, diff                              |
| `git-watch-registry.ts`     | One `startPolling` callback per cwd, shared by every watcher (desktop + remote)                         |
| `worktree.ts` / `worktree-detect.ts` | Git worktree create/remove/list; `EnterWorktree` detection observed at the funnel (4c)          |
| `pty-manager.ts` / `terminal-service.ts` | Shell PTYs (pwsh/cmd on Windows, bash/zsh on Unix); the per-cwd indexed pool shared by both transports |
| `remote-server.ts`          | HTTP + WebSocket listener, admission + E2E encryption, tunnel/TLS front ends (see [remote.md](remote.md)) |
| `remote-dispatcher.ts`      | Routes WebSocket `invoke` frames to the same handlers as IPC; what is reachable is decided by CAPABILITY GRANTS in the command registry |
| `remote-auth.ts` / `auth-policy.ts` / `step-up-tier.ts` / `webauthn-service.ts` | Password provisioning+verification, policy-mode resolution, the post-login freshness table, passkey ceremonies (ADR-052/054/056; see [security.md](security.md)) |
| `remote-config-view.ts`     | The one sanitized view of the remote config (never leaks credential material)                           |
| `tunnel-manager.ts` / `tailscale-manager.ts` / `socks-bridge.ts` | cloudflared quick tunnel; `tailscale serve` on a pinned HTTPS port (ADR-042); HTTP CONNECT bridge for SOCKS5 proxies |
| `usage-fetcher.ts`          | Polls `/api/oauth/usage`, merges rate-limit headers, disk cache                                         |
| `block-usage.ts`            | JSONL → `usage_event` ingestion, 5h billing windows, per-model/per-engine breakdown                     |
| `usage-recorder.ts` / `usage-reconciler.ts` / `usage-aggregation.ts` / `usage-provider.ts` / `usage-windows.ts` | DB-backed metering: live recording, backfill reconcile, SQL aggregation, window identity (ADR-011/020) |
| `opencode-pricing.ts`       | Pricing from opencode's `/config/providers`, persisted supplemental table                               |
| `opencode-session-list.ts` / `pi-session-list.ts` | Sidebar lists for opencode / pi sessions, read from those engines' own stores       |
| `context-window.ts`         | Mirror of cli.js's model context-window resolution (`docs/protocol/13-context-window.md`)               |
| `db.ts`                     | Operational SQLite DB — migrations + typed repos, on the driver seam (below)                            |
| `sqlite-driver.ts` + `sqlite/` | The storage seam: one API, three engines (`better-sqlite3-driver`, `bun-sqlite-driver`, `node-sqlite-driver`); the ENTRYPOINT installs one (ADR-058) |
| `ui-config.ts`              | Plain-text config: settings.json, engines/vendors JSON, sessions, slash commands                        |
| `claude-settings.ts` / `claude-mcp.ts` | Claude's own settings.json / .mcp.json edited in place (plane ②, ADR-009)                    |
| `skill-scanner.ts` / `custom-command-scanner.ts` | Scans project/user/plugin skill and slash-command directories                  |
| `sync-host.ts`              | SyncCore's host adapter: the process-wide core, the subscriber registry (every client is one sink), the stream registry, and `emitEvent` — the ONE place a domain event leaves the process (ADR-051) |
| `host-window.ts`            | The desktop window handle, or `null` — read at use time, never captured (phase 4d)                      |
| `sync-seed.ts`              | Seeds canonical state's file/query-sourced fields at boot (settings, session registry, slash commands, sidebar directories) so a `sync-full` is complete before any client connects (phase 4b) |
| `logger.ts`                 | File + ring-buffer logging (the debug WINDOW is `src/main/services/log-viewer.ts`)                       |
| `mermaid-tool.ts` / `mockup-tool.ts` | Hosted MCP tools for diagram + UI-mockup rendering (ADR-007)                                   |
| `voice-capture.ts` / `voice-client.ts` | Native (host microphone) audio capture + streaming to the in-cli.js transcription server      |
| `voice-stream-client.ts`     | The cli.js voice-server TCP protocol, shared by the host microphone and a remote browser capture       |
| `remote-voice.ts`            | Remote browser voice: audio in on the `voice-audio` lane frame, transcripts back to that connection    |

What deliberately stayed in `src/main/services/` — every RUNTIME module that is Electron
or is the desktop's own. (Tests are the exception, and the honest caveat: the legacy
`src/main/services/__tests__/` and `src/main/auth/vault/__tests__/` trees did not move
with their subjects, so most of those ~104 specs exercise `src/core/**` from a
`src/main` path — `vitest.config.ts` still names it for the git project. Known residue,
deferred as a mechanical follow-up to the S2 move.)

| Service | Why it stays |
| ------- | ------------ |
| `auth-manager.ts` / `account-manager.ts` | Native Anthropic OAuth opens the host browser (ADR-014); multi-account file credentials (ADR-015). `HostAuth` exposes only their READS to core |
| `plugin-manager.ts` | Plugins from `~/.claude/ui/plugins/`, lifecycle, isolated IPC (ADR-004/005) — `BrowserWindow`-hosted |
| `log-viewer.ts` | Drives a `BrowserWindow`; ruled desktop-forever (S1b) and pinned at `admin` as the belt |
| `mockup-protocol.ts` | The Electron `protocol.register*` half; its pure routing/serving half is injected into core as `HostMockup` |
| `sync-port.ts` | The renderer's `MessagePortMain` transport — client #1 (phase 4c) |
| `session-invalidation.ts` | "The credential these engine processes hold is stale", main-side |
