# Persistence & settings

Part of [architecture/](README.md).

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
