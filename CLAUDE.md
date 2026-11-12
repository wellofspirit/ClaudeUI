# ClaudeUI

A desktop client for coding agents: Electron + React 19 + TypeScript, package manager **bun**. Three engines run side by side behind an engine-neutral session layer: Claude Code (a rebundled, patched `bun-claude` binary driven by an in-house stream-json harness; no agent SDK), opencode 2.x (`opencode serve --stdio`, HTTP plus one SSE feed; 1.x unsupported, ADR-097) and pi (`pi --mode rpc` over stdio JSONL, ADR-035).

## Rules for every agent, whatever its role

- Every non-trivial change follows the user-level **`orchestrate`** skill, with this repository's gates and rules from **ADR-026** (the ADR index is `docs/adr/adr.md`). Trivial one-line edits and conversational answers are exempt. Engine bumps (Claude Code, opencode, pi) also follow the **`bump-harness`** skill (`.claude/skills/bump-harness/`).
- Unless you are the orchestrator: never commit, `git add`, branch, stash, checkout, reset or switch, and never run `bun install` / `bun add` / `bun remove` (the orchestrator does that deliberately; `postinstall` then rebuilds natives and installs the engines).
- Format with `bunx prettier --write <files you touched>`; `bun run format` rewrites the whole repo.
- `bun-claude.exe` / `bun-claude` also runs the agent sessions themselves: never kill it by process name.
- One worktree per arc, under `.claude/worktrees/<name>`; never switch branches in the main checkout. A worktree's `node_modules` and `vendor` are usually junctions to the main checkout's: never delete recursively through them; unlink the junction itself.
- Work notes (ADR-026 "Work notes"): open items (backlog features, housekeeping bugs, an arc's leftover follow-ups) are GitHub issues on this repo, labelled `backlog` or `housekeeping`. An arc's working files (handoff, specs, implementer/reviewer reports, live-drive logs) go in `.work/<arc>/` in the **main checkout** (worktrees are deleted at merge): gitignored, never committed. Research that can't be public (probe captures, reverse-engineering notes, third-party excerpts): follow the `claudeui-notes` skill if it's installed; otherwise keep it in `.work/<arc>/`.
- Commit gate: `scripts/gates.sh`, once per commit-ready tree. Never judge a gate from output piped into `grep`/`tail`: the pipeline takes the filter's exit code.
- Bash on Windows: the working directory is in POSIX form (`/d/WorkPlace/ClaudeUI`). Never prefix a command with `cd D:/...` (redundant, and it causes a permission prompt: cli.js filters `cd <cwd>` by exact string match). A path in a command argument uses the POSIX form too.
- When a conversation changes or makes a design decision, ask the user whether to record it. The rules are in ADR-026 "Decision records"; a new ADR takes the next free number across every remote branch.

## Source map

- `src/core/` — the Electron-free service graph that both hosts boot (lint-enforced, ADR-058):
  - `providers/` — the engine session seam: `ISession`, `BaseSession`, `EngineRegistry`, the prompt queue.
  - `services/` — one flat directory: the Claude engine (`claude-*.ts`), cross-engine dispatch (`dispatch-*.ts`, `cross-engine-dispatcher.ts`), the database (`db.ts`), sessions, usage, worktrees, the remote server.
  - `sdk/` — the Claude stream-json harness. `opencode/` and `pi/` — those engines: session, client, event mapper, config.
  - `ipc/` — command families, registrars, the capability registry, remote handlers. `sync/` — `SyncCore`: canonical state and the event funnel. `shared/sync/` — the sync contract the host and every client fold: channels, events, reducer.
  - `automode/` — the auto-mode judge. `permissions/` — the shell rule matcher. `auth/` — per-engine sign-in and the credential vault. `shared-providers/` — model providers shared across engines. `boot/` — the composition root (`core-services.ts`). `host.ts` — the host seams. `harness/` — detecting, installing and selecting engine binaries. `voice/` — on-device speech-to-text. `agents/` — reading agent definition files.
- `src/main/` — host 1, the Electron desktop (`index.ts`, `boot-core.ts`, the Electron-only services in `src/main/services/`). `src/server/` — host 2, the headless `claudeui-server`.
- `src/preload/` — the desktop bridge that builds `window.api`. `src/web/` — the browser client: the same renderer over a WebSocket (`api-adapter.ts`).
- `src/renderer/src/` — the React UI: `components/`, `stores/` (`session-store.ts`, and `replica.ts`, which makes the store a replica of host state), `hooks/`, `lib/`.
- `src/shared/` — types and pure helpers every process imports (`types/`, `api-invoke-table.ts`, `tool-kinds.ts`, `model-capabilities.ts`, `app-settings.ts`: the app-settings schema). `src/test/` — test infrastructure (bridges, factories, helpers, setup). `src/e2e/flows/` — end-to-end flows. `src/integration/` — gated suites against real engine binaries.

These directories carry their own `CLAUDE.md` (what lives there, the recipes for the common small changes, the invariants that live only in comments, the fast test): `src/core/ipc/`, `src/core/shared/sync/`, `src/core/providers/`, `src/core/pi/`, `src/core/automode/`, `src/core/services/`, `src/renderer/src/`, `src/renderer/src/components/chat/tool-registry/`. Read the note before editing there. Claude Code loads it when it reads a file in that directory; pi loads only this root file and opencode reads only `AGENTS.md`, so a brief for those agents names the note, and an opencode brief also carries the rules above (ADR-103). A change that alters a recipe or an invariant a note states updates the note in the same change.

## Name traps

- Claude has no directory of its own: its engine code is `src/core/services/claude-*.ts` plus `src/core/sdk/`.
- `src/core/pi/permission-engine.ts` is the rule ladder every engine shares; opencode and the dispatcher import it. `src/core/permissions/` holds only the shell rule matcher.
- pi's cold history, fork anchor and session delete are in `src/core/services/pi-session-list.ts`; opencode's session list, cold load and delete are in `src/core/services/opencode-session-list.ts`, over the converters in `src/core/opencode/history.ts`.
- "Provider" means three things: `src/core/providers/` is the engine session seam, `src/core/shared-providers/` is model providers, and `EngineAuthProvider` in `src/core/auth/` is per-engine sign-in. Two unrelated files are named `provider-registry.ts` (`src/shared/provider-registry.ts`, `src/core/shared-providers/provider-registry.ts`).
- `src/core/shared/` (the sync contract and `tool-review.ts`) is not `src/shared/`. `src/core/harness/` (engine binaries) is not `src/core/sdk/harness.ts` (which patches a Claude build carries).

## Fast loop

- One spec: `bunx vitest run <spec file>` (`--project '!browser'` is harmless and skips the browser project's startup). One test: add `-t "<test name>"`. The specs that cover a source file: `bunx vitest related --run <source file>` (about ten seconds).
- Types: `bun run typecheck:node` or `bun run typecheck:web` (incremental, a few seconds). Lint: `bunx eslint --cache <files>`; always pass `--cache`.
- `scripts/gates.sh` is not the inner loop: run it once, on the commit-ready tree. Run `bun run format:check` before pushing (CI runs it).

## Critical areas (ADR-026)

A slice that touches any of these is Critical whatever its size: its design is reviewed before it is built and it is verified live. A change to a seam the engines share must preserve Claude's behaviour.

- the permission ladders and the auto-mode judge (`src/core/pi/permission-engine.ts`, `src/core/permissions/`, `src/core/automode/`, the rulesets in `src/core/opencode/`);
- path containment and session scratchpads;
- credentials and the auth vault (`src/core/auth/`);
- remote server authentication and capabilities (`src/core/services/remote-server.ts`, `src/core/ipc/command-registry.ts`);
- anything that deletes user files (worktrees, scratchpads, sessions).

## Documentation

- Index: [docs/README.md](docs/README.md); read the page that matches the task. `docs/architecture/` is the as-built structure (sync in `docs/architecture/sync-core.md`, the remote transport in `docs/architecture/remote.md`, the security model in `docs/architecture/security.md`); `docs/adr/adr.md` indexes the decisions. Wire protocols: `docs/protocol-cc/` for cli.js (authoritative: consult it before theorizing about cli.js behaviour), `docs/protocol-opencode/`, `docs/protocol-pi/`.
- Build, setup, packaging and whole-suite test commands: [docs/commands.md](docs/commands.md). Test layers and infrastructure: `docs/testing-strategy.md`. A gated suite that only skipped has not passed. Components carry two-tier `data-testid` attributes (ADR-027): assert structurally first, screenshot last.
- Engine source: upstream checkouts are in `vendor/<engine>-src/` (`vendor/opencode-src`, `vendor/pi-src`) at the tag matching the pin (`src/shared/harness-manifests/<engine>.json#tested`); Claude Code has no public source, so use `vendor/claude-cli/cli.js` with `docs/protocol-cc/`. The trees are gitignored, so a fresh worktree has none: read them from the main checkout. Never clone source into `.cache/` (build caches only), `/tmp` or the scratchpad. Read the source before black-box probing an engine's behaviour, cite paths as `vendor/<engine>-src/...`, and bump the checkout together with the pin.
