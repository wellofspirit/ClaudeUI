# Persistence & settings

Part of [architecture/](README.md).

## Persistence model

Two planes of on-disk state (ADR-020):

- **Config = plain-text files** (hand-editable, no private copies of engine-native config):
  - `~/.claude/ui/settings.json` — APP-tier settings (plane ①).
  - `~/.claude/ui/engines/<id>.json` / `vendors/<id>.json` — launch params: sandbox/proxy, endpoint/modelOverride, dispatch config (plane ③).
  - Claude's own `settings.json` / `.mcp.json` and opencode's `opencode.jsonc` / agent files — edited **in place**, never copied (plane ②; ADR-009, ADR-028/031).
- **Operational/derived = SQLite** (`~/.claude/ui/operational.db`, WAL, `user_version` migrations): `session_meta` (per-session engine+model), `account` (metadata), `usage_event` / `usage_window_sample` / `daily_usage` (metering), `dispatched_usage` (cross-engine spend), plus the remote layer's `remote_config`, `webauthn_credential` and the append-only `audit_log`. `src/core/services/db.ts` owns the migrations and the typed repositories; it reaches the engine only through the driver seam below.
- **Credentials = file-based** per-account dirs (ADR-015) — never in the DB.

### The SQLite driver seam (ADR-058)

`db.ts` no longer imports `better-sqlite3` — or any engine. `src/core/services/sqlite-driver.ts` declares a neutral `SqliteDriver` (`open(filename, {readonly?, fileMustExist?})` → a handle with `exec` / `pragma` / `prepare` / `close`), and `src/core/services/sqlite/` holds the three adapters: `better-sqlite3-driver.ts` (**the only importer of the native module**), `bun-sqlite-driver.ts` and `node-sqlite-driver.ts` — the last two taking their engine INJECTED by the entrypoint, because `bun build` hoists a static engine import even down a branch that never runs.

**Selection is explicit and belongs to the entrypoint; nothing sniffs the runtime.** `src/main/index.ts` installs `betterSqlite3Driver()`, `src/server/main.ts` installs `bun:sqlite` under bun and `node:sqlite` under node (an ENTRYPOINT may sniff; the seam may not), and the vitest setup files install the driver too. There is deliberately **no default** — an uninstalled driver throws a message naming the fix, because the failure this seam exists to prevent is "the audit log was written with a different SQLite than it was read with", and a convenient fallback is exactly how that would happen unnoticed. Switching drivers while the DB is open throws rather than silently re-opening.

The reason it exists: better-sqlite3 does not merely fail under bun, it takes the process down with an uncatchable N-API panic at construct time (measured with better-sqlite3 13.0.3 under **bun** 1.3.6 and 1.3.14 — those are BUN versions), while `bun:sqlite` is a builtin a `bun build --compile` executable embeds. That is what makes both `claudeui-server` artifacts native-dependency-free for storage. The three engines are held to ONE conformance spec (`src/core/services/__tests__/sqlite-driver-conformance.ts`), run by vitest against `node:sqlite` and real better-sqlite3 where the ABI permits, and by `bun run verify:sqlite` against `bun:sqlite` (vitest cannot host a bun builtin). Two differences are normalised in the seam rather than at ~40 call sites: a `get()` miss is always `undefined`, and better-sqlite3's bare-body `pragma()` is emulated for the two builtins.

**Dual-ABI gotcha:** better-sqlite3 must be Electron-ABI in the app (`bun run rebuild:native` after any dep change — bun's postinstall leaves a Node-ABI build that crashes boot with `ERR_DLOPEN_FAILED`), while vitest runs in plain Node, so `vitest.config.ts` aliases it to `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite` adapter) — which is what `betterSqlite3Driver()` resolves to under test. Never import an engine outside its driver adapter.

## Settings & config

`SettingsDialog/` renders **scope tabs** — Common / Claude / opencode — each with a scoped section list and a single focused section pane (`settings-sections.tsx` exports `SECTIONS` + `SCOPES`; the old tier-tree/scroll-spy IA is gone). Sections are **capability-gated** per scope engine (`SECTION_CAPABILITY` + `isSectionVisible`; e.g. sandbox/proxy hide for engines without them).

- **Neutral autonomy modes** — `AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'`, mapped per engine (Claude permission modes; opencode rulesets per ADR-022), gated on `capabilities.autonomyModes`.
- **Claude scope** — permission rules (allow/deny/ask at user/project/local scope), sandbox, proxy, dispatch config.
- **opencode scope** — native opencode config edited in the UI and written to opencode's own files (models, custom providers, agents — ADR-028/029/031), plus dispatch config.
- **Vendors** — the Anthropic form (endpoint + model override) is editable; writes go to `vendors/anthropic.json` and apply at spawn.
- **Spawn wiring** — `session:create` sources launch params from the engine/vendor stores; the vendor derives from the active model's `ModelRef`. `config:save-settings` strips engine/vendor-owned fields from incoming payloads.
- A read-time, idempotent migration (`ui-config.migrateConfigPlane()`) moved legacy flat-settings fields into the engine/vendor stores.
