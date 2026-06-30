# ADR-020: V2 persistence & config-plane — files for config, SQLite for operational data

**Status:** Accepted (V2 design; sequenced in `docs/v2/implementation-plan.md`)
**Date:** 2026-06-19
**Amends:** [ADR-009](adr-009_claude-settings-vs-uisettings.md), [ADR-011](adr-011_canonical-usage-windows-and-account-attribution.md)

## Context

V2 spans multiple engines (ADR-018/019), each with its own config files and credential stores, and
adds structured operational data (multi-engine usage, account info, capability cache, session
metadata) that outgrows scattered JSON. ADR-009 (cli.js-consumed settings live in Claude's
`settings.json`) generalizes into a config-plane principle; ADR-011's usage windows fold into a
broader metering store. Detail: `docs/v2/persistence.md`, `03-settings-config.md`, `05-metering-usage.md`.

## Decision

- **Two stores, split by who edits the data:**
  - **Plain-text config files** — settings, permission rules, MCP config, slash commands. Human- and
    tool-editable **without the app running**; engine-consumed config stays here.
  - **Operational DB (`better-sqlite3`)** — usage time-series, account info (metadata, not secrets),
    engine/model capability cache, session metadata. Queryable; app-managed; not hand-edited.
  - **Credentials stay file-based & engine-owned** (ADR-015) — never in the DB.
- **Config-plane principle (generalizes ADR-009):** ClaudeUI keeps **no private copy** of config an
  engine consumes natively — it reads/writes the engine's own files (`settings.json`/`.mcp.json`,
  `opencode.json`). The narrow exception is **launch params** (proxy, custom endpoint, sandbox,
  hosted-MCP injection) ClaudeUI applies at spawn (env/flags), not shared with the standalone CLI.
- **Settings tiers** (foundation 3): **app / engine / vendor / session**; the SettingsDialog re-IA's
  into App / Engines / Vendors / Accounts, engine+vendor branches gated to what's installed +
  capabilities. Reclassifications: logging/refresh intervals → app; custom endpoint/model-override →
  vendor.
- **DB library = `better-sqlite3`** (native; `electron-rebuild` + per-platform prebuilds —
  incremental given the existing `node-pty` toolchain). `node:sqlite` set aside.
- **Usage** recorded from **live events + ongoing backfill** of out-of-tool sessions (foundation 5).

## Consequences

- New main-process DB layer; usage analytics become SQL queries rather than in-memory JSONL passes.
- SettingsDialog restructured by tier; some current settings move tiers (no semantic loss).
- The existing Claude JSONL parse is repurposed as the Claude usage **backfill reconciler** (not retired).

## Relation to existing ADRs

- **Amends ADR-009** — its "store engine-consumed settings where the engine reads them" rule is
  generalized to all engines as the config-plane principle; Claude's `settings.json` becomes one
  engine-native config plane among several.
- **Amends ADR-011** — the canonical 5h-window identity + account attribution is preserved but moves
  into the operational DB and becomes **one subscription usage provider** behind the per-account
  metering interface (foundation 5); windows generalize to any subscription vendor.
- Implements **ADR-018** (foundations 3/5 + persistence).
