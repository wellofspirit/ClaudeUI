# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop client for coding agents, built with Electron + React 19 + TypeScript. Runs Claude Code (rebundled `bun-claude` binary, in-house stream-json harness — no agent SDK), opencode 2.x (`opencode serve --stdio`, HTTP + one SSE feed; 1.x unsupported, ADR-097), and pi (`pi --mode rpc` over stdio JSONL) side by side behind an engine-neutral session layer. Package manager: **bun**.

## Documentation

Full documentation index: [docs/README.md](docs/README.md)

Architecture, services, persistence, multi-engine design → `docs/architecture/` (README.md is the index; sync/replication/queue/headless in `sync-core.md` — phases 0-4 as built, phase 5 + follow-ons as designed; remote transport + auth as-built in `remote.md`; security model as-built — passkeys, policy modes, capabilities, audit — in `security.md`). cli.js wire protocol + build pipeline + patches → `docs/protocol-cc/` (authoritative — consult before theorizing about cli.js behavior). opencode 2.x wire protocol, generated types and contract suite → `docs/protocol-opencode/` (ADR-097). pi wire protocol → `docs/protocol-pi/` (+ version-exact docs in `vendor/pi-src/packages/coding-agent/docs/` at the pinned tag; ADR-035). Design decisions → `docs/adr/`. Discover these while working; read the one that matches the task.

**Engine source trees live under `vendor/`:** upstream checkouts in `vendor/<engine>-src/` (`vendor/codex-src`, `vendor/opencode-src`, `vendor/pi-src`), checked out at the tag matching that engine's pin (`src/shared/harness-manifests/<engine>.json#tested`). The engines themselves are not vendored: only Claude Code is (`vendor/claude-cli`); opencode, pi and Codex install into ClaudeUI's managed store `~/.claude/ui/harnesses` (ADR-082 §8). No engine is forked any more: opencode is the upstream npm release, digest-checked by the harness installer (ADR-081, ADR-082 §4). Claude Code has no public source — use `vendor/claude-cli/cli.js` + `docs/protocol-cc/`. The source trees are gitignored (`/vendor/*-src/`) and excluded from ESLint and electron-builder. Never clone source into `.cache/` (build caches only), `/tmp` or the scratchpad. Read the source before black-box probing an engine's behavior, cite paths as `vendor/<engine>-src/...`, and bump the checkout together with the pin.

## Development Workflow (read this first)

For any **non-trivial change**, follow the loop in `docs/adr/adr-026_development-workflow.md` (full step-by-step + standing constraints live there):

- **The main model orchestrates, reviews, and commits; delegation follows the driver:** Fable delegates implementation to Opus; GPT-6 delegates to GPT-5.6 Sol (explicitly select `gpt-5.6-sol`), against a written kickoff spec (Daniel, 2026-09-17). The implementing agent never self-certifies and never commits / `git add`s / branches / runs `bun install`.
- **Review every single line** of the agent's diff — read the code, not the summary; re-run gates independently; verify guard tests fail pre-fix.
- **Verify against the real dev build** before committing: all gates below, then have a separate verifier (Opus for Fable; GPT-5.6 Sol for GPT-6) drive the real Electron app (`verifier-electron` skill / `scripts/app-shot.mjs`) — assert the live DOM by `data-testid` (ADR-027) before reading the screenshot.
- **Commit precisely** (never blind `git add -A`), one commit per item, no AI attribution.

Trivial one-line/mechanical edits and conversational answers are exempt.

## Commands

- `bun run dev` — development mode with hot reload (main-process changes need an app restart)
- `bun run build` — build only (no typecheck — run `bun run typecheck` separately); `build:win` / `build:mac` for distributables
- `bun run typecheck` / `bun run lint` / `bun run format`
- `bun run rebuild:native` — **run after every `bun install`/`add`/`remove`**; bun leaves a Node-ABI `better-sqlite3` that crashes the app on boot (`ERR_DLOPEN_FAILED`)
- `bun run ensure-cli` / `update-cli` — (re)build the patched `bun-claude` binary; version pinned via `package.json#claudeCliVersion`
- `bun run ensure-opencode` / `ensure-pi` / `ensure-codex` — install the tested version (`src/shared/harness-manifests/<id>.json#tested`) into ClaudeUI's managed store `~/.claude/ui/harnesses` through the app's own installer (`CLAUDEUI_HARNESS_STORE` moves the store); `update-*` reinstalls it. `postinstall` runs all three
- `bun run build:server` — `claudeui-server` pure-asset bundle → `dist/server/` (needs `build:web` first)
- `bun run build:server:compile` — bun-compiled `claudeui-server` executable → `dist/server-bin/`; run it from source instead with `bun src/server/main.ts --help`
- `bun run verify:sqlite` — SQLite driver conformance against `bun:sqlite` (the arm vitest can't host); both `build:server*` targets run it first

## Testing

- `bun run test` — default local run: unit + component + e2e (~100 s on a 16-core Windows box)
- `bun run test:ci` — adds the slow git project (what CI runs)
- `bun run test:git:changed` — after touching git-service/worktree code
- `OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode` — the opencode 2.x contract suite (real binary from the managed store, isolated homes, no network); run on every opencode pin bump with `bun run check-opencode-protocol`
- `bun run test:integration` — gated, real engine binaries (Claude Code from `vendor/`, the others from the managed store; a suite skips when its engine is not installed)

Layers, infra, and conventions: `docs/testing-strategy.md`. Components carry two-tier `data-testid` attributes (ADR-027) — assert structurally first, screenshot last.

## Windows Path Format in Bash Commands

cli.js's working directory uses POSIX format (`/d/WorkPlace/ClaudeUI`) on Windows Git Bash. **Never prefix Bash commands with `cd D:/...`** (redundant + causes permission prompts — cli.js filters `cd <cwd>` by exact string match). When a path must appear in a command argument, use POSIX format: `/d/WorkPlace/ClaudeUI`.

## ADRs

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR in `docs/adr/`. When adding one, check whether it supersedes or conflicts with an existing ADR — if so, update the old ADR's status and cross-reference both ways.
