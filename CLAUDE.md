# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop client for coding agents, built with Electron + React 19 + TypeScript. Runs Claude Code (rebundled `bun-claude` binary, in-house stream-json harness — no agent SDK), opencode (`opencode serve` over HTTP+SSE), and pi (`pi --mode rpc` over stdio JSONL) side by side behind an engine-neutral session layer. Package manager: **bun**.

## Documentation

Full documentation index: [docs/README.md](docs/README.md)

Architecture, services, persistence, multi-engine design → `docs/architecture/` (README.md is the index; sync/replication/queue/headless in `sync-core.md` — phases 0-4 as built, phase 5 + follow-ons as designed; remote transport + auth as-built in `remote.md`; security model as-built — passkeys, policy modes, capabilities, audit — in `security.md`). cli.js wire protocol + build pipeline + patches → `docs/protocol-cc/` (authoritative — consult before theorizing about cli.js behavior). pi wire protocol → `docs/protocol-pi/` (+ version-exact docs in `vendor/pi-cli/docs/`; ADR-035). Design decisions → `docs/adr/`. Discover these while working; read the one that matches the task.

## Development Workflow (read this first)

For any **non-trivial change**, follow the loop in `docs/adr/adr-026_development-workflow.md` (full step-by-step + standing constraints live there):

- **The main model (Fable) orchestrates, reviews, and commits; an Opus sub-agent implements** (`Agent` tool, `subagent_type: general-purpose`, `model: opus`, against a written kickoff spec). The implementing agent never self-certifies and never commits / `git add`s / branches / runs `bun install`.
- **Review every single line** of the agent's diff — read the code, not the summary; re-run gates independently; verify guard tests fail pre-fix.
- **Verify against the real dev build** before committing: all gates below, then drive the real Electron app (`verifier-electron` skill / `scripts/app-shot.mjs`) — assert the live DOM by `data-testid` (ADR-027) before reading the screenshot.
- **Commit precisely** (never blind `git add -A`), one commit per item, no AI attribution.

Trivial one-line/mechanical edits and conversational answers are exempt.

## Commands

- `bun run dev` — development mode with hot reload (main-process changes need an app restart)
- `bun run build` — typecheck + build; `build:win` / `build:mac` for distributables
- `bun run typecheck` / `bun run lint` / `bun run format`
- `bun run rebuild:native` — **run after every `bun install`/`add`/`remove`**; bun leaves a Node-ABI `better-sqlite3` that crashes the app on boot (`ERR_DLOPEN_FAILED`)
- `bun run ensure-cli` / `update-cli` — (re)build the patched `bun-claude` binary; version pinned via `package.json#claudeCliVersion`
- `bun run ensure-pi` / `update-pi` — vendor the pinned pi binary (`package.json#piCliVersion`); `ensure-opencode` / `update-opencode` likewise for opencode
- `bun run build:server` — `claudeui-server` pure-asset bundle → `dist/server/` (needs `build:web` first)
- `bun run build:server:compile` — bun-compiled `claudeui-server` executable → `dist/server-bin/`; run it from source instead with `bun src/server/main.ts --help`
- `bun run verify:sqlite` — SQLite driver conformance against `bun:sqlite` (the arm vitest can't host); both `build:server*` targets run it first

## Testing

- `bun run test` — default local run: unit + component + e2e (~15 s)
- `bun run test:ci` — adds the slow git project (what CI runs)
- `bun run test:git:changed` — after touching git-service/worktree code
- `bun run test:integration` — gated, real engine binaries

Layers, infra, and conventions: `docs/testing-strategy.md`. Components carry two-tier `data-testid` attributes (ADR-027) — assert structurally first, screenshot last.

## Windows Path Format in Bash Commands

cli.js's working directory uses POSIX format (`/d/WorkPlace/ClaudeUI`) on Windows Git Bash. **Never prefix Bash commands with `cd D:/...`** (redundant + causes permission prompts — cli.js filters `cd <cwd>` by exact string match). When a path must appear in a command argument, use POSIX format: `/d/WorkPlace/ClaudeUI`.

## ADRs

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR in `docs/adr/`. When adding one, check whether it supersedes or conflicts with an existing ADR — if so, update the old ADR's status and cross-reference both ways.
