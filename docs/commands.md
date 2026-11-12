# Commands

Build, setup, packaging and whole-suite test commands. The inner loop (one spec, one test, the specs for a
source file, incremental typecheck) is in the root `CLAUDE.md`, "Fast loop".

## Develop and check

- `bun run dev` — development mode with hot reload (main-process changes need an app restart)
- `bun run typecheck` / `bun run lint` / `bun run format:check` — `bun run format` rewrites the **whole repo**; format only the files you touched (`bunx prettier --write <files>`)
- `scripts/gates.sh` — the commit gate: typecheck (`src/server` included), lint, the format of the files the branch changed, and the whole default suite (about 45 s); works in a git worktree. A green run records the hash of the tree it ran on, and a later run on an identical tree says so and exits at once. The hash cannot see what git ignores: after `bun install`, `bun run update-cli` or anything else that changes `node_modules` or `vendor/`, pass `--force`. Never pipe a gate into `grep`/`tail` before `&& git commit`; the pipeline takes the filter's exit code

## Build and package

- `bun run build` — Claude Code binary (`ensure-cli`) + electron-vite build, no typecheck (run `bun run typecheck` separately); `build:win` / `build:mac` / `build:linux` add the typecheck (not on linux) and an electron-builder package (`--dir`, unpacked, on win/mac)
- `bun run build:server` — `claudeui-server` pure-asset bundle → `dist/server/` (needs `bun run build` first)
- `bun run build:server:compile` — bun-compiled `claudeui-server` executable → `dist/server-bin/`; run it from source instead with `bun src/server/main.ts --help`
- `bun run verify:sqlite` — SQLite driver conformance against `bun:sqlite` (the arm vitest can't host); both `build:server*` targets run it first

## Engines and native modules

- `bun run ensure` — the Claude Code binary and the tested opencode and pi, together; `postinstall` runs it after the native rebuild
- `bun run ensure-cli` / `update-cli` — (re)build the patched `bun-claude` binary and boot-probe it; version pinned by `package.json#claudeCliVersion`, which must equal `src/shared/harness-manifests/claude.json#tested`
- `bun run ensure-opencode` / `ensure-pi` — install the tested version (`src/shared/harness-manifests/<id>.json#tested`) into the managed store through the app's own installer (`CLAUDEUI_HARNESS_STORE` moves the store); `update-*` reinstalls it
- `bun run rebuild:native` — rebuild native modules (node-pty) for the Electron ABI; `postinstall` already does this

Only Claude Code is vendored (`vendor/claude-cli`). opencode and pi install into ClaudeUI's managed store
`~/.claude/ui/harnesses` (ADR-082 §8). No engine is forked: opencode is the upstream npm release, digest-checked by
the harness installer (ADR-081, ADR-082 §4). The upstream source checkouts in `vendor/<engine>-src/` are gitignored
and excluded from ESLint and electron-builder; the rules for reading them are in the root `CLAUDE.md`,
"Documentation". Engine bumps follow the `bump-harness` skill (`.claude/skills/bump-harness/`).

## Test suites

- `bun run test` — default local run: the unit, unit-node, unit-forks, component, e2e and browser projects (about 35 s on a fast Windows box; the unit, unit-node, component and e2e projects share worker processes, see `docs/testing-strategy.md`, "Test pools and process isolation"). The browser project needs Playwright's Chromium (`bunx playwright install --only-shell chromium`)
- `bun run test:ci` — adds the slow git project. The pull-request workflow (`.github/workflows/ci.yml`, pull requests only) runs the same projects as `test:ci:no-browser` shards plus a separate `bun run test:browser` job; pushes to `pre-release`/`main` run the release builds, which test with `test:ci:no-browser`
- `bun run test:git:changed` — after touching git-service/worktree code
- `bun run test:integration` — real engine binaries (Claude Code from `vendor/`, the others from the managed store). Each suite is opt-in and skips without its flag: `CLAUDE_INTEGRATION_TESTS=1`, `OPENCODE_V2_INTEGRATION=1`, `PI_INTEGRATION_TESTS=1`; it also skips when its engine is not installed. A run that only skipped has not passed
- `OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode` — the opencode 2.x contract suite (managed-store binary, isolated homes, a refusing proxy for outbound traffic); run on every opencode pin bump with `bun run check-opencode-protocol`
- `bun run test:patch` — the Claude Code patches' live behavioural suites against the rebuilt `bun-claude` (`patch-test-harness` skill)

Layers, infrastructure and conventions: `docs/testing-strategy.md`.
