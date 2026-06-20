# Phase 3a — Operational DB substrate (better-sqlite3) + session-metadata migration

> **Phase 3 is split** (3a here, 3b = config-plane + SettingsDialog re-IA next). 3a stands up the
> operational DB and moves per-session `{engineId, model}` into it. Design: [persistence.md](persistence.md),
> [01-data-model.md](01-data-model.md) §7, ADR-020. **better-sqlite3 is chosen** (native module).

## Verified facts (I de-risked the native build before writing this — don't re-litigate)

- `better-sqlite3@12.11.1` is installed (already in `package.json` dependencies).
- Electron is **41.0.3 / Node 24.14.0**. The app's Node ABI differs from standalone Node.
- **Dual-ABI reality (confirmed by probe):** after `bunx electron-builder install-app-deps` (which runs
  `@electron/rebuild electronVersion=41.0.3`), better-sqlite3 loads in the **Electron main process**
  (`new Database(':memory:')` → query works) but **fails in plain Node/vitest** with `ERR_DLOPEN_FAILED`.
  → **vitest MUST NOT load the native better-sqlite3.** (See Test isolation.)
- **bun wrinkle:** `bun add` / `bun install`'s postinstall left a *Node-ABI* build; only a follow-up
  `electron-builder install-app-deps` produced the Electron-ABI build. The rebuild must run reliably
  after deps are placed (see Build wiring).

## Scope (3a only)

1. **DB substrate**: a single per-OS-user SQLite DB at **`~/.claude/ui/operational.db`** (operational/
   derived data — distinct from the plain-text config files; the user OK'd `~/.claude/ui/*.db`). A small
   DB module + a **versioned migrations framework** (a `schema_migrations`/`user_version` mechanism).
2. **Session-metadata table + migration**: move per-session `{engineId, model}` from `sessions.json`
   (`sessionEngines`) into a `session_meta` table; read/write through the DB. **File fallback for one
   release**: if the DB has no rows but `sessions.json.sessionEngines` exists, import it once.
3. **Build/test wiring** for the native module (below).

**Out of 3a:** config-plane refactor + SettingsDialog re-IA (that's 3b). Usage tables (Phase 7),
account tables (Phase 4) — **do not create them now**; the migrations framework lets later phases add
tables. Only `session_meta` this phase.

## DB module design

- `src/main/services/db.ts` (or `db/index.ts`) — the **only** file that imports `better-sqlite3`.
  - Opens `~/.claude/ui/operational.db` (create dir if missing), sets sane pragmas (`journal_mode=WAL`,
    `foreign_keys=ON`), runs migrations to the latest version on first open. Lazy singleton.
  - Exposes a typed repository API, NOT the raw db, e.g.:
    `getSessionMeta(sessionId): { engineId: EngineId; model?: ModelRef } | undefined`,
    `setSessionMeta(sessionId, meta)`, `deleteSessionMeta(sessionId)`, `allSessionMeta(): Record<...>`,
    `renameSessionMeta(oldId, newId)` (for rekey).
  - Migrations: an ordered list of `(version, up(db))`; apply those above `user_version`; bump it. v1 =
    create `session_meta(session_id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, vendor_id TEXT, model_id TEXT, updated_at INTEGER)`.
- **`ModelRef` mapping**: store `engine_id`, `vendor_id`, `model_id` columns; reconstruct `ModelRef` on
  read (a row with a `model_id` → `{engineId, vendorId, modelId}`; null model_id → no model). Keep
  `claudeModel()` semantics.

## Wire session metadata through the DB

`src/main/services/ui-config.ts` currently owns `sessionEngines` in `sessions.json` (loadSessionConfig
migrates/clamps it; saveSessionConfig writes it). Move that to the DB:
- `loadSessionConfig()` no longer returns `sessionEngines` from the file — instead expose session
  metadata via the DB repository (the renderer still receives `sessionEngines` as today through the
  existing IPC shape, but sourced from the DB). Keep the renderer/store contract unchanged.
- **One-time import**: on first DB open, if `session_meta` is empty and `sessions.json.sessionEngines`
  exists, import each entry (`'codex'`/unknown → `'claude'`, per the Phase-1 clamp) then leave the
  file alone (fallback for one release; don't delete it).
- The store's `saveSessionConfig`/rekey/createNewSession paths that touch `sessionEngines` now go
  through the DB-backed IPC (keep the renderer code path; change only what the main side persists to).

> Keep the renderer-facing contract (`UISessionConfig.sessionEngines`, the store's `sessionEngines`)
> **unchanged** — 3a only swaps the main-process storage from JSON file to DB. Behavior-preserving.

## Build wiring (native module must be Electron-ABI in the app, reliably)

- `postinstall` already has `electron-builder install-app-deps`; ensure the Electron rebuild reliably
  runs **after** deps land. If bun ordering leaves a Node-ABI build, add an explicit
  `"rebuild:native": "electron-builder install-app-deps"` script and run it where needed (and document
  `bun install && bun run rebuild:native` for fresh clones). The `build:*` scripts already build the
  app; confirm the packaged app gets the Electron-ABI binary (electron-builder rebuilds on pack).
- electron-builder `asarUnpack` already unpacks `node_modules/node-pty/**`; **add
  `node_modules/better-sqlite3/**`** so the `.node` is unpacked in the packaged app.

## Test isolation (CRITICAL — the native module is Electron-ABI, breaks vitest)

vitest runs in Node and **cannot** load the Electron-ABI better-sqlite3. Pick the robust path:
- **Preferred:** a vitest stub/alias for `better-sqlite3` (mirror the existing `src/test/stubs/`
  pattern — electron-shim, sdk-stub) that maps to a thin shim over **`node:sqlite`** (built into Node
  24 — verified available; flagless). `node:sqlite`'s `DatabaseSync` API is close to better-sqlite3
  (`prepare().run/get/all`, `exec`); a ~30-line adapter gives tests a **real in-memory SQLite** with
  the better-sqlite3 surface, so the DB/migration/repository logic is genuinely tested without the
  native ABI. (Alternatively: an in-memory JS fake — less coverage.)
- Wire the alias in `vitest.config.ts` (the workspace projects). Confirm no test process loads the
  native `.node`.
- Add tests: migration runs to latest `user_version`; `session_meta` round-trip (`set`/`get`/`delete`/
  `rename`); the one-time `sessions.json` import (incl. `'codex'`→`'claude'`); ModelRef reconstruct.

## Step-by-step

1. **Branch** `v2-phase-3a-db-substrate` (already created off Phase 2; better-sqlite3 already added).
   Don't commit; leave the tree for review.
2. `db.ts` + migrations framework + `session_meta` (v1).
3. Test isolation (better-sqlite3 → node:sqlite adapter stub) wired in vitest; `bun run test` green.
4. Route session metadata through the DB in `ui-config.ts` + the one-time import; keep the
   renderer/store contract identical.
5. electron-builder `asarUnpack` += better-sqlite3; confirm/strengthen the native-rebuild wiring.
6. Tests (above) + update any `sessions.json`/`sessionEngines` persistence tests.
7. `CLAUDE.md`: note the operational DB (`~/.claude/ui/operational.db`), better-sqlite3, the dual-ABI
   test isolation, and the persistence split.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- `test`/`test:ci` MUST be green — proving the native module is isolated from vitest.
- **Runtime smoke (verifier-electron) is now load-bearing**: it launches the built/real app, which
  must `require('better-sqlite3')` successfully (Electron-ABI) and round-trip session metadata. Open a
  session, switch model, reopen → model persists (now via the DB). Read the screenshot. If the app
  errors on boot with `ERR_DLOPEN_FAILED`, the rebuild wiring is wrong.

## Gotchas

- **Never import `better-sqlite3` from renderer or shared code** — main process only.
- **vitest + native = crash.** The whole suite depends on better-sqlite3 never entering the Node test
  graph. If a test imports a module that transitively requires `db.ts` → it must hit the stub.
- **Behavior-preserving**: the model-persist/seed loop from Phase 1 must still work end-to-end, now
  DB-backed. Don't change the renderer contract.
- **Don't delete `sessions.json`** — keep it as the one-release fallback.

## Commit
Branch off `v2-phase-2-capability-model`; no AI attribution. Suggested:
`feat(v2): operational SQLite DB (better-sqlite3) + session-metadata migration (Phase 3a)`.
