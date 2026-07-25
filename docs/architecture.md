# Architecture

How ClaudeUI is put together: process model, source layout, services, the multi-engine seam, IPC/data flow, persistence, and settings. Design rationale lives in [`docs/adr/`](adr/adr.md); the cli.js wire protocol in [`docs/protocol/`](protocol/README.md).

## Overview

ClaudeUI is an Electron app. The **main process** owns the engines (spawning Claude Code's `bun-claude` binary, driving `opencode serve` over HTTP+SSE, driving `pi --mode rpc` over stdio JSONL), git, terminals, persistence, and the remote-access server. The **renderer** is a React 19 app fed exclusively through typed IPC events; it never touches an engine directly. A **web client** (`src/web/`) mirrors the renderer's API surface over an E2E-encrypted WebSocket.

## Tech stack

Electron (`electron-vite`), React 19 + TypeScript, Tailwind CSS v4 (via `@tailwindcss/vite`, no config files), Zustand, `react-markdown` + `remark-gfm`, `@modelcontextprotocol/sdk` (in-process MCP hosting), `simple-git`, `node-pty` + `@xterm/xterm`, `better-sqlite3` (operational DB), `mermaid`, `cron-parser`, Prism.js. Package manager: **bun**.

Claude Code is integrated by rebundling Anthropic's official Bun standalone binary with patched `cli.js` (`vendor/claude-cli/bun-claude[.exe]`) and speaking stream-json to it from an in-house harness — no `@anthropic-ai/claude-agent-sdk` dependency. Pipeline and patches: `docs/protocol/01-transport.md` §1.12; rationale: ADR-006.

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
| `remote-server.ts`          | HTTP + WebSocket server, token auth, E2E encryption, tunnel support                                     |
| `remote-dispatcher.ts`      | Routes WebSocket requests to the same handlers as IPC (with blocklist)                                  |
| `remote-bridge.ts`          | Broadcasts session/config events to remote clients                                                      |
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
| `event-log.ts`              | Ring buffer of events for remote-client catchup                                                         |
| `logger.ts` / `log-viewer.ts` | File + ring-buffer logging; debug window                                                              |
| `mermaid-tool.ts` / `mockup-tool.ts` | Hosted MCP tools for diagram + UI-mockup rendering (ADR-007)                                   |
| `tunnel-manager.ts` / `socks-bridge.ts` | Cloudflare tunnel; HTTP CONNECT bridge for SOCKS5 proxies                                   |
| `voice-capture.ts` / `voice-client.ts` | Native audio capture + streaming to the in-cli.js transcription server                       |

## Multi-engine architecture

The V2 model (ADR-018) separates **Engine** (harness: `claude` | `opencode` | `pi`) × **Vendor** (model maker) × **Account** (billing/auth identity). `ModelRef {engineId, vendorId, modelId}` is the universal selection/persistence key; `engineId` is immutable per session, model/account/capabilities re-resolve on model switch.

- **Session seam** — `src/main/providers/`: all backends implement `ISession`; `SessionManager` holds `Map<routingId, ISession>`; the renderer consumes the same `session:*` events regardless of engine. `SpawnPrepRegistry` applies per-engine spawn env (unknown engine throws). `shared/engine-meta.ts` is the per-engine descriptor table — adding an `EngineId` is a compile error until its meta exists.
- **Capabilities** — `EngineCapabilities` × `ModelCapabilities` → `ResolvedCapabilities` (`shared/model-capabilities.ts`), recomputed on session start and model switch; the renderer gates every feature on it. Per ADR-030, a flag is only `true` when the full end-to-end path works.
- **opencode backend** (ADR-019) — a shared, ref-counted `opencode serve` per cwd (HTTP + SSE `/event`, v1 API, Basic auth); `OpencodeSession` maps events to the neutral ContentBlock/`session:*` contract in `event-mapper.ts`. Permissions compile autonomy modes to opencode rulesets (ADR-022); auto mode uses an LLM judge (ADR-023); interaction parity (slash/skills, questions, queue/steer, subagents) per ADR-024; engine-native config is written to opencode's own files, diff-driven (ADR-028/031); custom agents per ADR-029; tool-experience parity per ADR-032.
- **pi backend** (ADR-035) — a `pi --mode rpc` child process per session (LF-framed JSONL over stdio, no server — the claude-shaped lifecycle); `PiSession` maps events to the neutral contract in `src/main/pi/event-mapper.ts`. pi has no native permissions and no MCP client, so a ClaudeUI-owned `-e` bridge extension (`pi-bridge-source.ts`) POSTs `tool_call` decisions to a per-session loopback `PiBridgeHost` (evaluated by the pure `permission-engine.ts` against the SAME `~/.claude` rules Claude/opencode use — ADR-022 parity), and registers the hosted tools + `dispatch_agent` via `pi.registerTool()` over the same host. Auth reads/writes pi's own `auth.json` (ADR-021); shared skills via the extension's `resources_discover`. Details + verified wire facts: `docs/protocol-pi/`.
- **Cross-engine dispatch** (ADR-033) — a hosted `dispatch_agent` tool lets a session on any engine delegate to a headless target on another, with subtask-style TaskCard streaming, forwarded approvals, cost cap, and usage attributed to the dispatching session. pi participates both directions (ADR-035): as a source via a `registerTool` dispatch tool, as a target via a headless `PiRpcClient` + per-target `PiBridgeHost` (recursion structurally impossible — a target's child never gets the dispatch tool).
- **Tool rendering** — engine tool names map to a neutral `ToolKind` taxonomy (`shared/tool-kinds.ts`); kind bodies under `renderer/.../tool-registry/kinds/` consume an engine-neutral `ToolView`. The per-engine `kindOf` switches in `ClaudeEngineToolMap.ts` / `OpencodeEngineToolMap.ts` / `PiEngineToolMap.ts` are the canonical mapping tables.

## Auth / accounts

`EngineAuthProvider` (`src/main/auth/`, ADR-021) is the per-engine auth abstraction with capability-gated method groups: `probe()` (always), sign-in driving (`canDriveLogin`), and account CRUD (`multiAccount`).

- **`ClaudeAuthProvider`** wraps `AuthManager` + `AccountManager`: native OAuth rides cli.js control requests on the service session (ADR-014); multi-account uses per-account file credentials via the `skip-securestorage` patch (ADR-015). `probe()` derives auth state from the cached `session:auth-source` signal — **no credential-file reads** (avoids Keychain prompts). Account metadata lives in the DB (`account` table); the `enabled`/`activeId` pointer stays in `accounts.json`; credentials stay file-based, never in the DB.
- **`OpencodeAuthProvider`** probes by merging `/config/providers` + `/provider/auth`; per-vendor API-key and OAuth flows via `vendor-auth:*` IPC (opencode owns `auth.json`).
- `session.account: AccountRef | null` rides every `SessionStatus`; `AuthState` is the tri-state `'authenticated' | 'unauthenticated' | 'unknown'`, while the login-flow object is `AuthFlowState`.

## IPC & data flow

- Main ↔ renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`; typed `ClaudeAPI` in `shared/types.ts`, exposed as `window.api`.
- `safeHandler()` wraps handlers in `{ ok, data, error }` envelopes; `unwrap()` in preload throws on failure.
- The same handlers serve WebSocket clients through `remote-dispatcher` (desktop-only channels blocklisted); shared handler bodies live in `ipc/handlers-core.ts`.
- `session:send` is fire-and-forget; results stream back as events:

```
User prompt → InputBox → addUserMessage() (Zustand) → window.api.sendPrompt (IPC)
  → session.run(prompt) → engine backend
    → stream_event   → session:stream          → appendStreamingText()
    → assistant      → session:message         → addMessage() (upsert by ID)
    → user (tool_result) → session:tool-result → appendToolResult()
    → can_use_tool   → session:approval-request → setPendingApproval()
    → result         → session:result           (cost tracking)
```

### Key patterns

- **Message upsert by ID** — partial messages share one `betaMessage.id`; updates replace in place.
- **Approval Promise** — `canUseTool` stores a Promise in a `pendingApprovals` Map, resolved on Allow/Deny. Return `{ behavior: 'allow', updatedInput: input }` or `{ behavior: 'deny', message }`; observe `context.signal` to dismiss the UI on cancellation.
- **Tool results arrive as synthetic `type: 'user'` messages**, extracted by `extractToolResults()`.
- **Multi-session routing** — every session has a `routingId`; events are routed by it. On engine init the temporary routingId is **rekeyed** to the engine's session UUID.
- **cli.js message order** (with partial messages on): `assistant` (partials) → `user` (tool_result) → `assistant` → `result`; `result` cost fields are **cumulative per process** and reset on `--resume`.
- **Git status polling** — `useGitWatcher` starts/stops `GitService.startPolling()` per active session cwd.
- **Terminal grouping** — terminals group by normalized cwd, survive session switches, cleaned up after 10 min cold (ADR-003).
- **projectKey** — a derived one-way render/identity token from `shared/project-key.ts`; both engines' sessions for one cwd group under one sidebar project (ADR-025).

## Views & design

Four main views via the sidebar: **Chat**, **Usage** (5h blocks, daily charts, per-model/per-engine breakdown, delegated section), **Automations**, **Plugin** (embedded WebView). Three themes (dark/light/monokai) as CSS custom properties in `main.css`'s `@theme` block. Transparent window (`vibrancy` on macOS, acrylic on Windows). Resizable sidebar + main area + optional right panel (git/tasks/plan) + bottom terminal panel that is **always mounted** (`display: none`/`contents`) to preserve xterm scrollback (ADR-002).

## Persistence model

Two planes of on-disk state (ADR-020):

- **Config = plain-text files** (hand-editable, no private copies of engine-native config):
  - `~/.claude/ui/settings.json` — APP-tier settings (plane ①).
  - `~/.claude/ui/engines/<id>.json` / `vendors/<id>.json` — launch params: sandbox/proxy, endpoint/modelOverride, dispatch config (plane ③).
  - Claude's own `settings.json` / `.mcp.json` and opencode's `opencode.jsonc` / agent files — edited **in place**, never copied (plane ②; ADR-009, ADR-028/031).
- **Operational/derived = SQLite** (`~/.claude/ui/operational.db`, better-sqlite3, WAL, `user_version` migrations): `session_meta` (per-session engine+model), `account` (metadata), `usage_event` / `usage_window_sample` / `daily_usage` (metering), `dispatched_usage` (cross-engine spend). `src/main/services/db.ts` is the **only** importer of the native module and exposes typed repositories.
- **Credentials = file-based** per-account dirs (ADR-015) — never in the DB.

**Dual-ABI gotcha:** better-sqlite3 must be Electron-ABI in the app (`bun run rebuild:native` after any dep change — bun's postinstall leaves a Node-ABI build that crashes boot with `ERR_DLOPEN_FAILED`), while vitest runs in plain Node, so `vitest.config.ts` aliases it to `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite` adapter). Never import better-sqlite3 outside `db.ts`.

## Settings & config

`SettingsDialog/` renders **scope tabs** — Common / Claude / opencode — each with a scoped section list and a single focused section pane (`settings-sections.tsx` exports `SECTIONS` + `SCOPES`; the old tier-tree/scroll-spy IA is gone). Sections are **capability-gated** per scope engine (`SECTION_CAPABILITY` + `isSectionVisible`; e.g. sandbox/proxy hide for engines without them).

- **Neutral autonomy modes** — `AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'`, mapped per engine (Claude permission modes; opencode rulesets per ADR-022), gated on `capabilities.autonomyModes`.
- **Claude scope** — permission rules (allow/deny/ask at user/project/local scope), sandbox, proxy, dispatch config.
- **opencode scope** — native opencode config edited in the UI and written to opencode's own files (models, custom providers, agents — ADR-028/029/031), plus dispatch config.
- **Vendors** — the Anthropic form (endpoint + model override) is editable; writes go to `vendors/anthropic.json` and apply at spawn.
- **Spawn wiring** — `session:create` sources launch params from the engine/vendor stores; the vendor derives from the active model's `ModelRef`. `config:save-settings` strips engine/vendor-owned fields from incoming payloads.
- A read-time, idempotent migration (`ui-config.migrateConfigPlane()`) moved legacy flat-settings fields into the engine/vendor stores.

## cli.js integration

Everything about the wire — message shapes, control subtypes, MCP hosting, cancellation, the build pipeline, patches — is in **[`docs/protocol/`](protocol/README.md)**. Consult it before theorizing, and before touching `src/main/sdk/`, `scripts/extract-cli.mjs`, or `patch/`. cli.js itself is ~13 MB minified: use the `/bundle-analyzer` skill to navigate it (find by string literals, never by minified names).

## Gotchas

- **Tailwind v4 reset** — never add `* { margin: 0; padding: 0 }` after `@import "tailwindcss"` in main.css; it lands after the utility layer and silently kills padding/margin utilities. Preflight already handles it.
- **Tailwind source scanning** — the `@source "../../";` directive in main.css is required for the scanner to find renderer sources.
- **Electron transparency** — needs `transparent: true` + `vibrancy` on the BrowserWindow **and** transparent backgrounds on html/body/#root; any opaque background in the tree blocks it.
- **Usage utilization scales** — the `/api/oauth/usage` API returns 0–100, rate-limit headers return 0–1; both are stored as 0–100 in `RateWindow.usedPercent` (`toUsedPercent()` in usage-fetcher.ts).
- **Dev main-process staleness** — hot reload updates the renderer only; main-process changes need an app restart, or you get new UI labels over old main logic.
