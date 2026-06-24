# Cross-cutting — Persistence Substrate

> **Status: DRAFT for discussion.** The split between human-editable config (files) and
> operational data (DB). Cross-cutting: foundations 3 (settings), 4 (auth/accounts),
> 5 (metering), and session metadata all reference this. Builds on
> [01-data-model.md](01-data-model.md). Not part of the numbered 1–6 chain.

## Decision

Three stores, split by *who edits the data, and when*:

| Store | Holds | Why |
| --- | --- | --- |
| **Plain-text config files** (today's `~/.claude/ui/config/`, Claude `settings.json`, `.mcp.json`, …) | App settings, permission rules, MCP server config, slash commands, skills config | Human- and tool-readable; editable **without the app running**; cli.js-consumed config *must* be files (ADR-009); diff-able; portable |
| **Operational DB** (new — SQLite) | Token/usage analytics, account info (metadata, not secrets), engine+model capability cache, session metadata/index | Queryable (esp. usage time-series), structured, app-managed, not meant for hand-editing; volume + relational shape outgrow scattered JSON |
| **Credential files** (unchanged, ADR-015) | Anthropic creds; opencode delegates to its own `auth.json` | Secrets stay file-based & engine-owned; **never** in our DB |

**Principle:** config humans touch → files; operational data the app manages → DB; secrets →
engine-owned files.

## Rationale

**Why settings stay files (not DB).** Moving settings into SQLite would require the app to be
running to read or change any setting, breaks easy hand-editing and external tooling, and
conflicts with ADR-009 (cli.js reads Claude's `settings.json` directly). Plain text wins for
config.

**Why operational data moves to a DB (not files).** Usage analytics is a time-series
aggregation workload (per-window, per-model, per-vendor token sums) that's painful over
JSONL/JSON; session/account/capability metadata is relational and grows. A structured store
fits, and decouples this churny data from the hand-edited config surface.

## DB library — decided: better-sqlite3

| Option | Pros | Cons |
| --- | --- | --- |
| **better-sqlite3** | De-facto Electron standard; synchronous; fast; mature; large ecosystem | **Native module** — needs `electron-rebuild` per Electron/ABI bump + per-platform prebuilds in the installer |
| **node:sqlite** (Node built-in) | No native dependency to ship/rebuild; std-lib | Availability/version depends on Electron's bundled Node runtime — **must verify** in our target Electron; newer/less battle-tested API |
| **@libsql/client** | Prebuilt binaries; optional remote/sync | Heavier; remote features unneeded |

**Decided: `better-sqlite3`** — maturity + ubiquity outweigh the managed native-build cost, and we
already carry a native toolchain for `node-pty`, so it's incremental. Wire `electron-rebuild` +
per-platform prebuilds in the installer. (`node:sqlite` set aside — Electron-Node-version-dependent
and newer.)

## Migration

Today's file-based usage cache and persisted-sessions index import into the DB. **Usage backfill
is ongoing** (out-of-tool sessions are reconciled — see [05-metering-usage.md](05-metering-usage.md)
§5), not a one-time import; keep files as a fallback for one release. Settings/permission/MCP files
are untouched.

## Open questions

1. DB library ✓ — **better-sqlite3** (decided).
2. DB scope/location — one per-user DB under the app data dir with a `project`/`cwd` column,
   vs per-project DBs. Lean: single per-user DB.
3. Backup/portability expectation — settings are trivially portable; the DB less so. Do we need
   an export, or is "settings portable, history local" acceptable?
