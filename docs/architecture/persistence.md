# Persistence & settings

Part of [architecture/](README.md).

## Persistence model

Two planes of on-disk state (ADR-020):

- **Config = plain-text files** (hand-editable, no private copies of engine-native config):
  - `~/.claude/ui/settings.json` — APP-tier settings (plane ①).
  - `~/.claude/ui/engines/<id>.json` / `vendors/<id>.json` — launch params: sandbox/proxy, endpoint/modelOverride, dispatch config (plane ③).
  - `~/.claude/ui/automode.json` — the engine-SHARED classifier trust lists (`trustedDomains` / `trustedRegistries` / `protectedPatterns`, ADR-065). OpencodeSession and PiSession derive them into the judge environment at session start; Claude runs cli.js's own classifier and cannot consume them. An empty list is an absent key. A read-time, run-once migration (`ui-config.migrateSharedTrustLists()`) unioned the two engines' old `autoMode` lists into it and stripped them from the engine files.
  - Claude's own `settings.json` / `.mcp.json` and opencode's `opencode.jsonc` / agent files — edited **in place**, never copied (plane ②; ADR-009, ADR-028/031).
- **Operational/derived = SQLite** (`~/.claude/ui/operational.db`, WAL, `user_version` migrations): `session_meta` (per-session engine+model), `account` (metadata), `usage_event` / `usage_window_sample` / `daily_usage` (metering), `dispatched_usage` (cross-engine spend), plus the remote layer's `remote_config`, `webauthn_credential` and the append-only `audit_log`. `src/core/services/db.ts` owns the migrations and the typed repositories; it reaches the engine only through the driver seam below.
- **Credentials = file-based** per-account dirs (ADR-015) — never in the DB.

### The SQLite driver seam (ADR-058)

`db.ts` no longer imports `better-sqlite3` — or any engine. `src/core/services/sqlite-driver.ts` declares a neutral `SqliteDriver` (`open(filename, {readonly?, fileMustExist?})` → a handle with `exec` / `pragma` / `prepare` / `close`), and `src/core/services/sqlite/` holds the three adapters: `better-sqlite3-driver.ts` (**the only importer of the native module**), `bun-sqlite-driver.ts` and `node-sqlite-driver.ts` — the last two taking their engine INJECTED by the entrypoint, because `bun build` hoists a static engine import even down a branch that never runs.

**Selection is explicit and belongs to the entrypoint; nothing sniffs the runtime.** `src/main/index.ts` installs `betterSqlite3Driver()`, `src/server/main.ts` installs `bun:sqlite` under bun and `node:sqlite` under node (an ENTRYPOINT may sniff; the seam may not), and the vitest setup files install the driver too. There is deliberately **no default** — an uninstalled driver throws a message naming the fix, because the failure this seam exists to prevent is "the audit log was written with a different SQLite than it was read with", and a convenient fallback is exactly how that would happen unnoticed. Switching drivers while the DB is open throws rather than silently re-opening.

The reason it exists: better-sqlite3 does not merely fail under bun, it takes the process down with an uncatchable N-API panic at construct time (measured with better-sqlite3 13.0.3 under **bun** 1.3.6 and 1.3.14 — those are BUN versions), while `bun:sqlite` is a builtin a `bun build --compile` executable embeds. That is what makes both `claudeui-server` artifacts native-dependency-free for storage. The three engines are held to ONE conformance spec (`src/core/services/__tests__/sqlite-driver-conformance.ts`), run by vitest against `node:sqlite` and real better-sqlite3 where the ABI permits, and by `bun run verify:sqlite` against `bun:sqlite` (vitest cannot host a bun builtin). Two differences are normalised in the seam rather than at ~40 call sites: a `get()` miss is always `undefined`, and better-sqlite3's bare-body `pragma()` is emulated for the two builtins.

**Dual-ABI gotcha:** better-sqlite3 must be Electron-ABI in the app (`bun run rebuild:native` after any dep change — bun's postinstall leaves a Node-ABI build that crashes boot with `ERR_DLOPEN_FAILED`), while vitest runs in plain Node, so `vitest.config.ts` aliases it to `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite` adapter) — which is what `betterSqlite3Driver()` resolves to under test. Never import an engine outside its driver adapter.

## Settings & config

`SettingsDialog/` renders the **ADR-065 page model**: eleven pages in three rail groups (App / Features / Engines), each page an ordered list of groups, each group a card of rows built from one `SettingRow` vocabulary (`settings-pages.tsx` exports `PAGES`, `RAIL_GROUPS`, `SECTION_TARGET`; `settings-sections.tsx` still holds the per-item render bodies as `SECTIONS`). The phone (≤768px, ADR-048) renders the same model as three tabs, one per rail group, with pages as lazily mounted accordions and the same group cards inside; search goes wide as one flat list of live rows, and the container hands both presentations the same `engineByGroup` / `onSelectEngine` / `navigate`. The old scope tabs (Common / Claude / opencode / pi) are gone from both presentations; a group whose values differ per engine declares `byEngine` item lists and renders an engine segment, a setting that exists for some engines only carries an engine chip, and groups gated on a capability declare `requires: 'sandbox' | 'proxy'` (evaluated against the page's engine). Where a group writes lives on its header as a storage tag; it is information, never navigation. A group's storage tag, note and applies-later badge may each be a function of the selected engine (`storageOf` / `noteOf` / `appliesOnOf`), and a `byEngine` group may declare `engineFrom: '<sibling group id>'` to follow that sibling's engine segment instead of drawing its own (the Dispatch page's Limits card). The dispatch panes share ONE config object per engine through a small reference-counted store, because `config:save-engine-config` replaces the whole file and two independent copies on one page would clobber each other. Deep links are `open-settings` events with `{ page, group? }`.

- **Neutral autonomy modes** — `AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'`, mapped per engine (Claude permission modes; opencode rulesets per ADR-022), gated on `capabilities.autonomyModes`.
- **Claude-owned config** (Sessions & autonomy + Engines › Claude pages) — permission rules (allow/deny/ask at user/project/local scope), sandbox, proxy, dispatch config.
- **opencode-owned config** (Engines › opencode + Models & providers pages) — native opencode config edited in the UI and written to opencode's own files (models, custom providers, agents — ADR-028/029/031), plus dispatch config.
- **Vendors** — the Anthropic form (endpoint + model override) is editable; writes go to `vendors/anthropic.json` and apply at spawn.
- **Spawn wiring** — `session:create` sources launch params from the engine/vendor stores; the vendor derives from the active model's `ModelRef`. `config:save-settings` strips engine/vendor-owned fields from incoming payloads.
- A read-time, idempotent migration (`ui-config.migrateConfigPlane()`) moved legacy flat-settings fields into the engine/vendor stores.
