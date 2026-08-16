# Source layout & main-process services

Part of [architecture/](README.md).

## Source layout

```
src/
  shared/              — engine-neutral types (types.ts), capability model
                         (model-capabilities.ts), tool-kind taxonomy (tool-kinds.ts),
                         pricing, project-key, engine-meta, remote protocol, E2E crypto
  main/
    index.ts           — BrowserWindow setup, app lifecycle, service wiring
    sdk/               — in-house cli.js harness: query(), tool(), createSdkMcpServer()
                         (module map: docs/protocol/01-transport.md §1.13)
    providers/         — engine seam: ISession, BaseSession, EngineRegistry,
                         SpawnPrepRegistry, register-engines
    opencode/          — opencode backend: OpencodeServerManager, OpencodeClient,
                         OpencodeSession, event-mapper, model-discovery, config
                         writers, permission compiler, hosted-tools MCP host
    pi/                — pi backend: PiRpcClient (stdio JSONL), PiSession, event-mapper,
                         model-discovery, PiBridgeHost (loopback approval + hosted-tool
                         host), pi-bridge-source (the -e extension), permission-engine,
                         pi-locate, pi-protocol (ADR-035)
    auth/              — EngineAuthProvider + Claude/opencode implementations
    ipc/               — IPC registration (session/terminal/automation) + remote
                         handlers; shared bodies in handlers-core.ts / create-session.ts
    services/          — ~50 service modules (key ones below)
  preload/             — context bridges: window.api (ClaudeAPI), plugin, log viewer
  renderer/src/
    stores/            — Zustand stores (session-store.ts is the primary)
    hooks/             — IPC event listeners (useClaudeEvents), git watcher, menus
    components/        — chat/ (30 components incl. tool-registry/), git/, plan/,
                         automation/, terminal/, usage/, SettingsDialog/, Sidebar/,
                         shared/, plugin/
    lib/diff/          — custom diff viewer (parse-patch, unified/split tables)
  renderer/log-viewer/ — standalone log viewer window
  web/                 — remote-access web client (WebSocket + E2E encryption)
  test/                — shared test infra: TestIpcBridge, electron/sdk/sqlite stubs,
                         factories, helpers
  e2e/flows/           — layer-3 E2E tests
  integration/         — layer-4 integration tests (real engine binaries, gated)
vendor/                — rebundled bun-claude + vendored opencode binary (not checked in)
scripts/               — build-time helpers (extract-cli, rebundle-cli, ensure-opencode,
                         app-shot.mjs for real-app verification)
patch/                 — cli.js content-regex patches (registry: apply-all.mjs)
```

## Main-process services

Key modules in `src/main/services/`:

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
| `auth-manager.ts`           | Native Anthropic OAuth via cli.js control requests (ADR-014)                                            |
| `account-manager.ts`        | Multi-account file-based credentials (ADR-015)                                                          |
| `automation-manager.ts`     | Cron/interval scheduling, run history, cli.js execution                                                 |
| `git-service.ts`            | Wraps simple-git: status, branches, stage/unstage, commit, push/pull, diff                              |
| `worktree.ts`               | Git worktree create/remove/list                                                                         |
| `pty-manager.ts`            | Shell PTYs (pwsh/cmd on Windows, bash/zsh on Unix)                                                      |
| `plugin-manager.ts`         | Plugins from `~/.claude/ui/plugins/`, lifecycle, isolated IPC (ADR-004/005)                             |
| `remote-server.ts`          | HTTP + WebSocket server, token auth, E2E encryption, tunnel support (see [remote.md](remote.md))        |
| `remote-dispatcher.ts`      | Routes WebSocket requests to the same handlers as IPC (with blocklist)                                  |
| `remote-bridge.ts`          | Mirrors session/config `webContents.send` traffic to remote clients (see [remote.md](remote.md))        |
| `usage-fetcher.ts`          | Polls `/api/oauth/usage`, merges rate-limit headers, disk cache                                         |
| `block-usage.ts`            | JSONL → `usage_event` ingestion, 5h billing windows, per-model/per-engine breakdown                     |
| `usage-recorder.ts` / `usage-reconciler.ts` / `usage-aggregation.ts` / `usage-provider.ts` / `usage-windows.ts` | DB-backed metering: live recording, backfill reconcile, SQL aggregation, window identity (ADR-011/020) |
| `opencode-pricing.ts`       | Pricing from opencode's `/config/providers`, persisted supplemental table                               |
| `opencode-session-list.ts`  | Sidebar list for opencode sessions via direct read of opencode's global DB                              |
| `context-window.ts`         | Mirror of cli.js's model context-window resolution (`docs/protocol/13-context-window.md`)               |
| `auto-classifier.ts` (+`-tool.ts`) | LLM permission judge for opencode auto mode (ADR-023)                                            |
| `db.ts`                     | Operational SQLite DB — the ONLY importer of better-sqlite3; migrations + typed repos                   |
| `ui-config.ts`              | Plain-text config: settings.json, engines/vendors JSON, sessions, slash commands                        |
| `claude-settings.ts` / `claude-mcp.ts` | Claude's own settings.json / .mcp.json edited in place (plane ②, ADR-009)                    |
| `skill-scanner.ts`          | Scans project/user/plugin skill directories                                                             |
| `sync-host.ts`              | SyncCore's host adapter: the process-wide core, the extra-window registry, the ONE `webContents.send` fan-out for a replicated event, the dev shadow watch (ADR-051; the core itself is `src/main/sync/`, Electron-free) |
| `sync-seed.ts`              | Seeds canonical state's file/query-sourced fields at boot (settings, session registry, slash commands, sidebar directories) so a `sync-full` is complete before any client connects (phase 4b) |
| `logger.ts` / `log-viewer.ts` | File + ring-buffer logging; debug window                                                              |
| `mermaid-tool.ts` / `mockup-tool.ts` | Hosted MCP tools for diagram + UI-mockup rendering (ADR-007)                                   |
| `tunnel-manager.ts` / `socks-bridge.ts` | Cloudflare tunnel; HTTP CONNECT bridge for SOCKS5 proxies                                   |
| `voice-capture.ts` / `voice-client.ts` | Native (host microphone) audio capture + streaming to the in-cli.js transcription server      |
| `voice-stream-client.ts`     | The cli.js voice-server TCP protocol, shared by the host microphone and a remote browser capture       |
| `remote-voice.ts`            | Remote browser voice: audio in on the `voice-audio` lane frame, transcripts back to that connection    |
