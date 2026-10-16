# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ClaudeUI

A desktop client for coding agents, built with Electron + React 19 + TypeScript. Runs four engines side by side behind an engine-neutral session layer: Claude Code (rebundled, patched `bun-claude` binary, in-house stream-json harness — no agent SDK), opencode 2.x (`opencode serve --stdio`, HTTP + one SSE feed; 1.x unsupported, ADR-097), pi (`pi --mode rpc` over stdio JSONL, ADR-035) and Codex (`codex app-server` over stdio JSON-RPC, ADR-066/069). Package manager: **bun**.

## How work is done here (read this first)

Every non-trivial change follows the owner's **`orchestrate`** skill (the step-by-step procedure and brief templates) with this repository's roles, gates and rules from **ADR-026** (`docs/adr/adr-026_development-workflow.md`). In short:

| Role                                                                                                                                                                              | Model                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Orchestrator — makes every judgment call, writes the spec, reviews every line of each sub-agent's diff and the finished branch, runs the orchestrator test, commits, opens the PR | Opus (whichever model drives the session takes this role) |
| Reader (evidence only) · implementer (+ developer test) · verifier (a separate agent, real app)                                                                                   | Sonnet                                                    |
| Consultant for complicated / large-blast-radius designs · exit reviewer of the open PR                                                                                            | Fable                                                     |

Gates in order: developer test → verifier → orchestrator test + review → PR + CI → Fable exit review → the owner merges. A Fable finding the orchestrator disagrees with is argued with Fable, then put to the owner, who is the final judge. Implementers never commit, `git add`, branch, or run `bun install`/`add`/`remove`. Trivial one-line edits and conversational answers are exempt.

Engine bumps (Claude Code, opencode, pi, Codex) follow the **`bump-harness`** skill (`.claude/skills/bump-harness/`).

## Documentation

Full documentation index: [docs/README.md](docs/README.md)

Architecture, services, persistence, multi-engine design → `docs/architecture/` (README.md is the index; sync/replication/queue/headless in `sync-core.md` — phases 0-5 and the headless follow-on as built; remote transport + auth in `remote.md`; security model — passkeys, policy modes, capabilities, audit — in `security.md`; Codex in `codex.md`). cli.js wire protocol + build pipeline + patches → `docs/protocol-cc/` (authoritative — consult before theorizing about cli.js behavior). opencode 2.x wire protocol, generated types and contract suite → `docs/protocol-opencode/` (ADR-097). pi wire protocol → `docs/protocol-pi/` (+ version-exact docs in `vendor/pi-src/packages/coding-agent/docs/` at the pinned tag). Codex app-server protocol → `docs/protocol-codex/`. Design decisions → `docs/adr/` (index `adr.md`). Discover these while working; read the one that matches the task.

**Engine source trees live under `vendor/`:** upstream checkouts in `vendor/<engine>-src/` (`vendor/codex-src`, `vendor/opencode-src`, `vendor/pi-src`), checked out at the tag matching that engine's pin (`src/shared/harness-manifests/<engine>.json#tested`). The engines themselves are not vendored: only Claude Code is (`vendor/claude-cli`); opencode, pi and Codex install into ClaudeUI's managed store `~/.claude/ui/harnesses` (ADR-082 §8). No engine is forked any more: opencode is the upstream npm release, digest-checked by the harness installer (ADR-081, ADR-082 §4). Claude Code has no public source — use `vendor/claude-cli/cli.js` + `docs/protocol-cc/`. The source trees are gitignored (`/vendor/*-src/`), so a fresh worktree has none: read them from the main checkout. They are excluded from ESLint and electron-builder. Never clone source into `.cache/` (build caches only), `/tmp` or the scratchpad. Read the source before black-box probing an engine's behavior, cite paths as `vendor/<engine>-src/...`, and bump the checkout together with the pin.

## Commands

- `bun run dev` — development mode with hot reload (main-process changes need an app restart)
- `bun run build` — Claude Code binary (`ensure-cli`) + electron-vite build, no typecheck (run `bun run typecheck` separately); `build:win` / `build:mac` / `build:linux` add the typecheck (not on linux) and an electron-builder package (`--dir`, unpacked, on win/mac)
- `bun run typecheck` / `bun run lint` / `bun run format:check` — `bun run format` rewrites the **whole repo**; format only the files you touched (`bunx prettier --write <files>`)
- `scripts/gates.sh` — the commit gate: typecheck, lint, `bun run test`. Never pipe a gate into `grep`/`tail` before `&& git commit`; the pipeline takes the filter's exit code
- `bun run ensure` — the Claude Code binary and the tested opencode, pi and Codex, together; `postinstall` runs it after the native rebuild
- `bun run ensure-cli` / `update-cli` — (re)build the patched `bun-claude` binary and boot-probe it; version pinned by `package.json#claudeCliVersion`, which must equal `src/shared/harness-manifests/claude.json#tested`
- `bun run ensure-opencode` / `ensure-pi` / `ensure-codex` — install the tested version (`src/shared/harness-manifests/<id>.json#tested`) into the managed store through the app's own installer (`CLAUDEUI_HARNESS_STORE` moves the store); `update-*` reinstalls it
- `bun run rebuild:native` — rebuild native modules (node-pty) for the Electron ABI; `postinstall` already does this
- `bun run build:server` — `claudeui-server` pure-asset bundle → `dist/server/` (needs `bun run build` first)
- `bun run build:server:compile` — bun-compiled `claudeui-server` executable → `dist/server-bin/`; run it from source instead with `bun src/server/main.ts --help`
- `bun run verify:sqlite` — SQLite driver conformance against `bun:sqlite` (the arm vitest can't host); both `build:server*` targets run it first

## Testing

- `bun run test` — default local run: the unit, unit-node, component, e2e and browser projects (about a minute on a fast Windows box). The browser project needs Playwright's Chromium (`bunx playwright install --only-shell chromium`)
- `bun run test:ci` — adds the slow git project (what the PR workflow runs; `ci.yml` runs on pull requests only, while pushes to `pre-release`/`main` run the release builds, which test with `test:ci:no-browser`)
- `bun run test:git:changed` — after touching git-service/worktree code
- `bun run test:integration` — real engine binaries (Claude Code from `vendor/`, the others from the managed store). Each suite is opt-in and skips without its flag: `CLAUDE_INTEGRATION_TESTS=1`, `OPENCODE_V2_INTEGRATION=1`, `PI_INTEGRATION_TESTS=1`, `CODEX_INTEGRATION=1`; it also skips when its engine is not installed. A run that only skipped has not passed
- `OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode` — the opencode 2.x contract suite (managed-store binary, isolated homes, a refusing proxy for outbound traffic); run on every opencode pin bump with `bun run check-opencode-protocol`
- `bun run test:patch` — the Claude Code patches' live behavioural suites against the rebuilt `bun-claude` (`patch-test-harness` skill)

Layers, infra, and conventions: `docs/testing-strategy.md`. Components carry two-tier `data-testid` attributes (ADR-027) — assert structurally first, screenshot last.

## Windows Path Format in Bash Commands

cli.js's working directory uses POSIX format (`/d/WorkPlace/ClaudeUI`) on Windows Git Bash. **Never prefix Bash commands with `cd D:/...`** (redundant + causes permission prompts — cli.js filters `cd <cwd>` by exact string match). When a path must appear in a command argument, use POSIX format: `/d/WorkPlace/ClaudeUI`.

## ADRs

When a design or implementation decision is made during a conversation, prompt the user about whether it should be recorded as a new ADR in `docs/adr/`. When adding one, check whether it supersedes or conflicts with an existing ADR — if so, update the old ADR's status and cross-reference both ways. Take the next free number across every remote branch, not just yours: numbers have collided (there are two ADR-037s).
