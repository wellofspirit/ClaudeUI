# src/core/services

Flat directory of the Electron-free service layer; `src/core/boot/core-services.ts` constructs and starts it for both hosts (ADR-058). Each family's ADRs are cited in its file headers; ADR-033 and ADR-105 govern dispatch, ADR-072 the usage hub.

## What lives here

- `src/core/services/claude-*.ts`: the Claude engine besides `src/core/sdk/` (`claude-session.ts`, settings, MCP, plugins, skills, model catalog, usage API, host-token keeper).
- `src/core/services/dispatch-*.ts`, `cross-engine-dispatcher.ts`, `collab-tool.ts`: X-Agent dispatch; `dispatch-target-ledger.ts` is the `dispatch_target` facade over `db.ts`.
- `src/core/services/session-*.ts`: manager, delete, links, notes, proposals, inbox delivery, hosted session tools (`session-tools*.ts`).
- `src/core/services/usage-*.ts`, `src/core/services/usage-hub/`: metering ledger, windows, dashboard, hub client; `usage-fetcher.ts` polls Claude limits.
- `src/core/services/worktree*.ts`, `git-service.ts`: worktree and git operations. `sync-*.ts`: host side of the sync core.
- `src/core/services/remote-*.ts`, `tailscale-manager.ts`, `tunnel-manager.ts`, `vscode-web-service.ts`: remote access. `pty-manager.ts`, `terminal-service.ts`: shells.
- Hosted tools: `src/core/services/mermaid-tool.ts`, `mockup-tool.ts`, `session-tools-server.ts`. Persistence: `db.ts` (schema, migrations, typed repositories), `sqlite-driver.ts`, `ui-config.ts` (JSON config plane).
- Claude-only despite neutral names: `session-history.ts` and `session-watcher.ts` (`~/.claude/projects` JSONL), `subagent-watcher.ts`, `service-session.ts` (usage-poll CLI fallback), `block-usage.ts`, `context-window.ts` (cli.js rules), `assistant-message.ts` (also used by `dispatch-claude-targets.ts`). Those that read content blocks, tool results or usage fields (`session-history.ts`, `subagent-watcher.ts`, `block-usage.ts`, `assistant-message.ts`, and `claude-session.ts`) decode through `claude-transcript.ts`, a leaf that imports no service but `tool-result-content.ts`.
- Traps: `src/core/services/pi-session-list.ts` is pi's session list, cold load, fork anchor and delete (JSONL under `~/.pi`; the converters are `src/core/pi/history.ts`), `opencode-session-list.ts` is opencode's; two host-token files, `src/core/sdk/host-token.ts` (spawn seam) and `claude-host-token.ts` (the keeper); `src/main/services/` is Electron-only, a different directory.

## Recipes

**A DB column.** Exemplar: the `parent_cwd` column on `dispatch_target`.

1. `src/core/services/db.ts`: append a version to `MIGRATIONS`, then the `...DbRow` and public row types, the mapper, INSERT columns and placeholders, and the UPDATE/patch if mutable. [compiler] for the types, [nothing] for the SQL strings.
2. The facade (`src/core/services/dispatch-target-ledger.ts` for that table) and its fake `src/test/helpers/fake-dispatch-ledger.ts`. [compiler]
3. No version pin to bump: specs read `LATEST_SCHEMA_VERSION` from `src/test/helpers/migration-db.ts`. Add a `*-vN-migration.test.ts` beside `codex-removal-v41-migration.test.ts` (`openRawDb` and `userVersion` come from the same helper) and update the schema paragraph in `docs/architecture/persistence.md`. [nothing] for both.

**A new service started at boot.** Exemplar: `usageHubClient` (`src/core/services/usage-hub/client.ts`).

1. Module exporting a singleton with `start()` and `stop()`, or a `start*`/`watch*` function taking its collaborators as arguments; take them as parameters, not by importing the session manager (cycle). See the cycle note in `src/core/boot/core-services.ts`.
2. `src/core/boot/core-services.ts` `startCoreServices`: construct and start at the right point in the order. [nothing] for the order.
3. If it holds timers, sockets or children, stop it in the one sequence both hosts run: add it to `CoreStopDeps` in `src/core/boot/core-stop.ts`, call it in `stop()` (or in `prepareStop()` when it needs the other services alive), and pass it where `startCoreServices` calls `createCoreStop`. [compiler] for the dep, [nothing] for calling it; the order is pinned in `src/core/boot/__tests__/core-stop.test.ts`. Skipped, timers or children outlive quit. Host-only teardown (the desktop's log viewer and plugins) stays in `src/main/index.ts`.
4. The boot specs mock the composition root's imports: add the new module to `src/core/boot/__tests__/harness-arrival-boot.test.ts`, `usage-poll-boot-order.test.ts` and `src/e2e/flows/windowless-boot.e2e.test.ts`. [test: those three]

**The host half of a hosted MCP tool, all three engines.** Exemplar: `render_mermaid`. Claude wire reference: `docs/protocol-cc/10-mcp-hosting.md`.

1. `src/core/services/mermaid-tool.ts`: `createMermaidServer` with the tool's schema and handler (a new module, a new `createSdkMcpServer`). [nothing]
2. Claude: `src/core/services/claude-session.ts` creates the server and passes it in `mcpServers`; `canUseTool` auto-allows the `mcp__claude-ui__` prefix: put a tool on that server only when it has no side effects; one that needs normal gating goes on its own server, as `dispatch_agent` does (`collab-tool.ts`). [nothing]
3. opencode: `src/core/opencode/opencode-hosted-tools.ts` registers a server's tools in a loop (a tool added to `createMermaidServer` rides along; a new module is registered by hand). [test: opencode-hosted-tools.test.ts]
4. pi: `src/core/pi/pi-bridge-source.ts` (a `pi.registerTool` entry, and bump `PI_BRIDGE_VERSION`). [test: pi-bridge-source.test.ts]
5. pi: `src/core/pi/PiSession.ts` `handleHostedTool` case, `src/core/pi/permission-engine.ts`: `PI_HOSTED_TOOL_NAMES` always, and `PI_AUTO_ALLOW_HOSTED_TOOLS` only for a tool with no side effects (a deliberate strict subset). [test: permission-engine.test.ts]
6. `src/shared/hosted-tools.ts`: one `HOSTED_TOOLS` row (`claudeServer`, `kind`, `label`). It gives the tool its kind and header label in all three spellings, in the renderer and in the permission ladder (`piToolKind`), so the kind is a permission input (Critical area) [test: tool-kind-matrix.test.ts fails until the name is in its list]. Dispatch targets get no hosted tools (`dispatch-pi-targets.ts`). Renderer half: `src/renderer/src/components/chat/tool-registry/CLAUDE.md`.

## Invariants

- The order of `startCoreServices` is a contract: prices before sessions, the host-token keeper before any cli.js spawn, `usageFetcher.startPolling()` after `afterSessionGraph`, `usageHubClient.start()` after the credential wiring.
- Migrations are additive: guard on table existence, never drop a table or column an older build sharing `operational.db` reads, one transaction per version, a newer `user_version` is never rewound (`db.ts` `runMigrations`).

## Fast test

- DB: `bunx vitest run src/core/services/__tests__/db.test.ts src/core/services/__tests__/dispatch-target-ledger.test.ts`.
- Boot: `bunx vitest run src/core/boot/__tests__ src/e2e/flows/windowless-boot.e2e.test.ts`; unknown specs: `bunx vitest related --run <source file>`.
- Hosted tool: `bunx vitest run src/core/pi/__tests__/pi-bridge-source.test.ts src/core/opencode/__tests__/opencode-hosted-tools.test.ts src/shared/__tests__/hosted-tools.test.ts src/renderer/src/components/chat/tool-registry/__tests__/tool-kind-matrix.test.ts`.
