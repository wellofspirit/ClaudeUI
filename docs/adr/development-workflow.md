# Development workflow, testing and CI

Governs: `scripts/gates.sh`, `vitest.config.ts`, `src/test/setup/`, `eslint.config.mjs`, `tsconfig.web.json`, `tsconfig.node.json`, `.github/workflows/`, `src/web/`, `src/renderer/src/`, `scripts/app-shot.mjs`, `electron-builder.yml`, `CLAUDE.md`

How work is done in this repository (roles, risk tiers, gates, what counts as a critical area), how decisions are
recorded, how the test suite is run and isolated, the `data-testid` convention that component tests and live
verification share, the lint, format and type-check rules, and what CI builds and releases. Test-pool and process
isolation as-built detail is `docs/testing-strategy.md` ("Test pools and process isolation"). The desktop and web
clients are one UI build (ADR-099, core-and-hosts.md). What a release ships per harness is ADR-082 §8
(harness-installs.md).

## Development workflow: one orchestrator, rigor scaled to risk (ADR-026)

Agents implement quickly but miss their own bugs, so an independent check is load-bearing: every phase since V2
surfaced at least one real bug in review that the implementer's summary did not mention. The opposite failure is
checking everything on every change with no definition of when to stop: two arcs in October 2026 took about nine
hours each, mostly in review rounds past the first, which chased contrived Windows junction and symlink chains and
accepted every hardening finding (one grew to 101 files and about 12,700 lines); in both, the bugs that mattered
were caught by the first independent pass. Related: ADR-027 (test data attributes, the structural tier of live
verification). The procedure, and which agent and model fill each role, live in the user-level `orchestrate` skill
where it is installed; this section keeps the decision and what is specific to this repository.

Every non-trivial change follows the `orchestrate` skill where it is installed, and the roles and rules below
either way. Trivial edits and conversational answers are exempt.

### Roles

| Role                                          | Owns                                                                                                    | Never                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Orchestrator (the session leading the change) | Scope, tiers, design, every ruling, building small slices, slice review, commits, the pull request      | Hands a product decision to anyone but the user |
| Implementer                                   | Code and tests against the spec                                                                         | Commits, or certifies its own work              |
| Reviewer                                      | Design review of Critical slices, review of diffs too big for the orchestrator to hold, the exit review | Edits the change it reviews                     |
| Verifier                                      | Live verification of the running app, when the tier calls for it                                        | Is the agent that built the change              |

Each review and verification comes from a fresh context, never the one that wrote the code. The orchestrator builds
a small slice itself at any tier (as a starting rule, up to about 100 changed lines in up to 3 files) and hands
larger ones to implementers; the size is tuned from experience (changed 2026-11-12).

### Tiers, findings and stopping

Each slice gets a tier from its risk, not its size, stated to the user up front:

- **Light** (a contained change, no contract change): one fresh review of the diff. A test-only or docs-only change
  that running it proves needs no reviewer (changed 2026-11-12).
- **Standard** (a feature across files, or a changed contract such as an API, IPC, wire format, schema or config):
  the orchestrator reviews each slice, and the branch gets one exit review. Live verification only when tests can't
  show the behaviour.
- **Critical** (a trust boundary, deleting or migrating user data, hard to roll back, or an area listed below): the
  design is reviewed before it is built, and live verification is required.

Every finding names a realistic trigger. It is fixed when it breaks the ask, regresses behaviour, loses data or is a
security hole reachable in normal use or by a plausible attacker in one step; otherwise it becomes an issue or a
note. A re-review checks only the fixes. After two review rounds on the same area, what remains goes to the user.

### Critical areas in this repository

A slice touching any of these is Critical:

- the permission ladders and the auto-mode judge;
- path containment and session scratchpads;
- credentials and the auth vault;
- remote server authentication and capabilities;
- anything that deletes user files (worktrees, scratchpads, sessions).

### Gates

- `scripts/gates.sh`, once per commit-ready tree: typecheck, lint, the format of the files the branch changed and
  the whole default suite. A run on a tree that already passed returns at once (changed 2026-11-12). Never pipe a
  gate into a filter before acting on its result: the pipeline takes the filter's exit code.
- Add `bun run test:ci` after touching git-service or worktree code, `bun run build` for anything the packaged app
  runs, and `bun run format:check` when the Prettier config or version changed.
- Engine work adds that engine's gated suite (`docs/testing-strategy.md`). A suite that only skipped has not passed.
- Live verification starts from the `verifier-electron` skill, which holds the isolation recipe for this app.
- A change to a seam the engines share is checked to preserve Claude's behaviour. Claude is the daily driver, and an
  auth-detection bug locks the user out.

### Where a new rule goes

A lesson from an incident goes into this repository: `CLAUDE.md`, this section, or the `verifier-electron` skill. It
goes into the shared skill or agents only if it would matter in most projects and the harm it prevents is hard to
undo.

### Decision records

Decisions are recorded in topic records under `docs/adr/`, one file per area. Each current decision is one
section of its topic record, headed by a title and the ADR numbers it holds, for example
`## Judge blocks hold for the user (ADR-091)`. A section states the decision, the reason and the consequences
that still bind, in the present tense and in about a page. It carries no history of how the decision was
reached; git keeps that.

- **Numbers are permanent.** Source and docs cite decisions by number (`ADR-085`, `ADR-082 §8`). A number is
  never reused or renumbered, and a part label that is cited (`§3`, `decision 6`) stays in its section.
- **A changed decision** is edited in place in its section, with one dated line saying what changed. No
  appended amendment sections.
- **A new decision** takes the next free number across every remote branch, not only the current one, and goes
  in as a new section of the topic record for its area. A new topic record is written only for an area none
  covers.
- **A superseded or removed decision** leaves the sections and becomes one line under its topic record's
  `## Retired` heading: the number, the old title, and what replaced it or why it is gone.
- **The index** `docs/adr/adr.md` is generated from the topic records (`node scripts/generate-adr-index.mjs`)
  and never edited by hand. It maps every number to its section or tombstone and lists the source directories
  each topic record governs. A guard test fails when the checked-in index is stale, when a number sits in two
  sections, or when a number or part label cited in `src/` or `docs/` has no entry.
- ADR-037 names two decisions (the engine customization policy and shared provider routing). Both keep the
  number; the index lists both.

Design detail, probe facts, wire shapes and as-built notes belong in `docs/architecture/` or
`docs/protocol-*/`, not in a topic record.

### Work notes

An arc's handoff, specs and reports live in `.work/<arc>/` in the arc's own worktree (gitignored; changed
2026-11-12 from the main checkout, which a session working inside a worktree cannot write). Open items are GitHub
issues labelled `backlog` or `housekeeping`. Research that cannot be public follows the `claudeui-notes` skill where
it is installed, otherwise `.work/<arc>/`. Retiring an arc is part of its merge: lasting facts move, scrubbed, into
ADRs and `docs/`; what is still open becomes issues; `.work/<arc>/` goes with the worktree.

### Rules for all work in this repository

- **Live evidence over source reading.** Source reading finds the candidates; how an engine, a binary or the app
  behaves is settled by probing the real thing.
- **Real-provider testing.** Real model calls only on entry-level or free models; a failure is reported, never
  retried on a bigger model. Credentials are read by a script from ClaudeUI's own store and never echoed. The user's
  real profile only with explicit permission.
- **One worktree per arc** (`.claude/worktrees/<name>`); never switch branches in the main checkout, which other
  sessions and builds use. A fresh worktree has no `vendor/<engine>-src`; read the main checkout's.
- **Settled rulings stay settled.** Check the ADRs before reporting documented behaviour as a bug.
- **Unattended runs delete nothing:** a delete can wait hours on a permission prompt nobody sees.
- **Engine bumps** follow the `bump-harness` skill.
- **Commits:** one per item, explicit paths staged, no AI attribution, the staged diff checked for personal
  identifiers.

Agents' hard constraints in this repository (no dependency installs, formatting only touched files, never killing
`bun-claude` by name) are in `CLAUDE.md` › How work is done here. Claude Code and pi load it; opencode reads only
`AGENTS.md`, so an opencode agent's brief carries that section (ADR-103). Technical rules live
with their subject: the ADR or the `docs/architecture/` and `docs/protocol-*/` page for that area.

Consequences:

- Most changes run Light or Standard, with one independent check and no live drive unless runtime is the only
  place the behaviour shows.
- Some real but unlikely problems ship as issues instead of being fixed in the arc.
- A misjudged tier is the main risk. The tier is stated up front, the user can override it, and the orchestrator
  escalates on evidence.

Alternatives considered:

- **Keep every check on every change.** Rejected: the 2026-10-25 arcs cost about nine hours each, mostly in review
  rounds past the first, which found only tail cases.
- **No independent check.** Rejected: in the 2026-10-20 replay evaluation, the runs without one shipped a tool
  contract break that consumer suites and review caught in the others.
- **Keep the step-by-step procedure in this section.** Rejected: the procedure is shared across projects and lives in
  the user-level skill; a copy here would drift.

## The test suite runs on `vmForks`, with a per-file home and process guards (ADR-113)

The default suite (`bun run test`: the unit, unit-node, unit-forks, component, e2e and browser projects) must stay
fast enough to be the commit gate (about 30 s; `scripts/gates.sh` about 40 s), and no test may ever reach the
developer's real home. Why `vmForks`: the `forks` pool spawns one Node child per file serially (about 80 ms each on
Windows), a floor of about 75 s however many workers; thread pools resolved the real home (`process.env` is a
per-thread copy while `os.homedir()` reads the real one) and failed files; `isolate: false` leaked module state
between files; Bun cannot host Vitest 5 workers or replace its API (`vi.hoisted`, `vi.waitFor`, `it.runIf`).

1. **Pools** (`vitest.config.ts`). `unit`, `unit-node`, `component` and `e2e` run on `vmForks` (a fresh vm context per
   file in reused processes) with `vmMemoryLimit` at half of V8's heap limit (the default sits above that limit, so
   workers would never recycle). `git`, `integration` and `browser` are unchanged. No thread pool is used.
2. **Opt-out.** The `unit-forks` project runs the files in `FORKS_ONLY` on plain `forks`, one process per file. Only
   these reasons qualify: a native addon (node-pty; the real better-sqlite3), a process-global module hook
   (`module.registerHooks`), or a wall-clock CPU-budget assertion. A file is never listed because it is slow or
   flaky. The config throws at load if an entry is not an existing unit-node test file.
3. **HOME in two layers.** The main process home moves to `<tmpdir>/claudeui-test-home/<runId>/main` before any
   worker exists (`CLAUDEUI_TEST_RUN_ID` is set once and inherited), after capturing the real home in
   `CLAUDEUI_REAL_HOME` (from which the real harness store and, on macOS and Linux, `PLAYWRIGHT_BROWSERS_PATH` are
   derived). `src/test/setup/process-reset.ts`, the first import of `node.setup.ts` and `jsdom.setup.ts`, gives every
   file its own home `<runId>/<pid>-<seq>` and refuses to run unless `os.homedir()` is that path (the tripwire). The
   variables that move a directory the code derives from the home are deleted for the whole run (the `XDG_*_HOME`
   four, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TEST_HOME`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`,
   `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_UI_LOG_DIR`, `CLAUDEUI_HARNESS_STORE`); the `integration` project
   re-adds the store (ADR-082 §8, harness-installs.md). `os.userInfo().homedir` is not redirected. Homes are never
   cleaned per file (a write after teardown must stay visible); run directories older than 7 days are pruned at
   config load, the root is `0700`, and pruning is skipped when the root is a symlink or junction or, on POSIX,
   owned by another user.
4. **Process reset and guards** (`process-reset.ts`), because a vm context does not isolate the process. Restored at
   the start of every file: environment (except `VITEST*`), cwd and `exit` listeners. Under the vm pools only: a file
   fails when its `uncaughtException` or `unhandledRejection` listener count changed or it leaves more
   `FSEventWrap`, `StatWatcher`, `TCPServerWrap` or `ProcessWrap` handles than it started with; `process.dlopen`
   throws and names the file to add to `FORKS_ONLY` (the attempt is recorded, so a file that catches the throw still
   fails in `afterAll`); the context's `Error[Symbol.hasInstance]` also accepts `util.types.isNativeError`, so errors
   from Node's own modules are `instanceof Error` as in production. Not guarded: built-in module state and the
   filesystem outside the per-file home.
5. **The gate never retries.** `scripts/gates.sh` runs typecheck, `eslint --cache .`, a format check of the files
   the branch changed and the default suite, and does
   not retry a failed test run: "failed run, zero failed tests" also matches an unhandled error, which is how a
   cross-file leak appears under `vmForks`.
6. **CI** runs the tests on Linux, macOS and Windows in 3 shards each (every project except `browser`), and the
   `browser` project once on Linux in Playwright's container (§ CI, ADR-061). On Linux and macOS CI the suite uses
   every core up to 16; a Windows runner does not (slow disk made IO-heavy tests time out).

Consequences that still bind:

- A leak fails the file that caused it, not a later one. Tests that depend on order within their file are fixed
  with fresh state per test; pinning an order is not an acceptable fix.
- Host-realm objects differ under `vmForks`: only the `Error` base class is patched back, so `instanceof TypeError`
  on an `fs` or `fetch` error differs. A test that depends on such a check belongs in `FORKS_ONLY`; this is a
  fidelity cost of the pool, not a rule for production code.
- The moved HOME hides the developer's global git config from every `git` a test spawns and from `vitest --changed`.
- Test homes accumulate under `<tmpdir>/claudeui-test-home/` for a week.

## Every rendered component and interactive part carries a `data-testid` (ADR-027)

DOM assertion by test id is the first verification tier, before screenshots: "did it render?" is a structural,
cheap question; a PNG read is the last resort. `data-testid` serves jsdom component tests (Testing Library) and the
Playwright drive of the built app (`scripts/app-shot.mjs`) with one selector vocabulary. It applies to
`src/renderer` and `src/web`.

- **Tier 1, component identity (PascalCase).** Every renderable component stamps its outermost DOM element with
  `data-testid="<ComponentName>"`. The set of `[data-testid]` values in the DOM is the rendered-component inventory.
- **Tier 2, interactive parts (dot-namespaced).** Interactive sub-elements that are not their own component
  (buttons, inputs, selects, tabs, toggles, menu items) get `data-testid="<ComponentName>.<partName>"`, camelCase part
  name naming the role or action (`ProviderAddSheet.search`, `ProviderSheet.done`).
- **Repeated instances: stable testid plus `data-id`.** A list row keeps a stable testid and carries the instance
  identity in a separate `data-id` (`[data-testid="SessionItem"][data-id="<id>"]`), never interpolated into the
  testid, so the testid set stays finite and enumerable.
- **Shared controls forward the id.** A `data-testid` on a custom component is dropped unless it forwards it.
  `SettingsToggle`, `SettingsSelect`, `SettingsSlider`, `ApprovalButtons` and the like take an optional
  `testid?: string` prop and render it as `data-testid` on their root DOM element. Never spread `data-testid` onto a
  component that does not explicitly forward it.
- **Every DOM-producing render path carries the id**, including loading, empty, error and not-installed early
  returns, so a component is assertable in those states. Early returns are mutually exclusive with the main return,
  so reusing the id never duplicates. Only a literal `return null` is exempt; a message nested inside an
  already-stamped root needs no copy.
- **Stable and semantic.** A testid derives from the component's identity or role, never from copy or styling;
  renaming a component updates its testid and every selector for it. Testids are kept in all builds (no production
  stripping: the drive runs the built app) and are read-only metadata, never a hook for CSS or logic.
- **Verification protocol.** `scripts/app-shot.mjs` has `--testids` (print the sorted set of present ids with
  counts) and `--assert-testid <id>` (repeatable; exit non-zero, code 3, if absent). Assert components and parts by
  testid first, drive through testid selectors, read the PNG last.

Rejected: flat kebab-case ids (would migrate the existing PascalCase mock pattern for no gain); interpolating the
instance id into the testid (explodes the set, "is a SessionItem present?" becomes unanswerable); relying on
`text=` and CSS selectors (brittle, ambiguous, no inventory); stripping testids in production (breaks the drive of
the built app).

## Lint and format are separate: ESLint owns code quality, Prettier owns formatting (ADR-013)

`eslint.config.mjs` is the flat config; `eslint .` is expected to report no problems, and genuine violations are
fixed rather than suppressed.

1. **Ignore generated and vendored trees explicitly** (flat config does not read `.gitignore`): `node_modules`,
   `dist`, `out`, `vendor`, `.cache` (a minified cli check file there once OOM'd the parser), `.claude` (agent
   worktrees are full repo copies), `.work`, `.notes`, `coverage`.
2. **Prettier is not an ESLint rule.** `eslint-config-prettier` comes last and only disables conflicting rules;
   formatting is `bun run format` (rewrites the whole repo; agents format only the files they touched) and
   `bun run format:check`.
3. **React, Hooks and Refresh rules are scoped to `src/renderer` and `src/web`**, the only React trees (the
   `REACT_FILES` glob).
4. **§4. `react-hooks` recommended is not adopted wholesale**: it bundles React Compiler lints (`purity`, `refs`,
   `set-state-in-effect`, `immutability`) and this codebase does not target the compiler. Only `rules-of-hooks`
   (error) and `exhaustive-deps` (warn) are on; the React rule set from `@eslint-react` is enumerated one rule at a
   time for the same reason, never via its `recommended-typescript` preset. They can be opted into if the compiler is
   adopted.
5. **`react-refresh/only-export-components` is off** (dev Fast Refresh only; co-locating small helpers with their
   component is a kept pattern). **`explicit-function-return-type` is off** (never adopted). `no-unused-vars`
   ignores `_`-prefixed symbols and unused `catch` bindings; `prefer-const` uses `destructuring: 'all'`.
6. **Relaxed override for tests, stubs, fixtures, build and patch scripts and config files** (`TEST_AND_SCRIPT_FILES`):
   `no-explicit-any`, `no-unsafe-function-type`, `no-empty-function`, `no-require-imports` and `no-empty` are off
   there; app code stays strict.

Lint, format check and typecheck are CI gates (§ CI, ADR-061), and `scripts/gates.sh` runs lint. Other fences live in
the same file under their own decisions (the `src/core` no-Electron import fence, ADR-058; the viewport-unit zoom
trap, ADR-093).

## The web client is type-checked against `ClaudeAPI` (ADR-008)

`src/web/api-adapter.ts` returns a `ClaudeAPI`, a hand-maintained mirror of the desktop preload
(`src/preload/index.ts`) over the WebSocket. A bundler strips types without checking them, so a method added to
`ClaudeAPI` and not to the adapter was `undefined` at runtime and crashed the React subtree on first call (the
mockup preview shipped that way).

- `src/web/**/*` is in `tsconfig.web.json`'s `include`, so `bun run typecheck` (`typecheck:node` then
  `typecheck:web`, both `tsc --noEmit`) enforces `ClaudeAPI` conformance: adding a method the web adapter does not
  implement fails the typecheck. Neither `build` nor CI may skip it. `src/web` shares that tsconfig's `@renderer/*`
  and `@test/*` aliases and the DOM lib.
- Methods that are desktop-only are stubbed in the adapter rather than omitted; routed methods need their server
  handler registered (`src/core/ipc/remote-handlers.ts`). Remote-client parity is a standing requirement, see
  remote-access.md.
- The web client is part of the one renderer build (ADR-099); there is no separate `build:web` pass, and the
  type-check is unchanged by that.

## CI type-checks, lints and builds every PR, and releases are built from `pre-release` and `main` (ADR-061)

`.github/workflows/`: `ci.yml` (pull requests and manual dispatch), `pre-release.yml` (push to `pre-release`) and
`release.yml` (the mirrored release workflow for `main`). The two release workflows are kept in sync by hand; there
is no unit test for a workflow, a YAML parse of both and a diff of their divergence is the check.

### §1 PR gates build everything buildable on Linux

`ci.yml` runs on pull requests only (a push to any other branch runs nothing until it is opened as a PR; pushes to
`pre-release` and `main` run the release workflows, which carry their own test step before any tag is published).
Its `gates` job on `ubuntu-latest`: `bun run typecheck`, `bun run lint`, `bun run format:check` (Prettier cache keyed
on content), `bunx electron-vite build` (the one renderer build), then `build:server`, `build:server:compile` and a
`--help` boot smoke of the compiled `claudeui-server`. These are **gates, not artifacts**: nothing is uploaded, and
no workflow else runs `build:server*` and its `verify:sqlite` arm. A `tests` matrix runs `test:ci:no-browser` in 3
shards on `ubuntu-latest`, `macos-latest` and `windows-2022` (not `windows-latest`: node-gyp cannot find VS2026 to
rebuild node-pty), with `fail-fast: false`; a separate `browser` job runs `test:browser` once on Linux in Playwright's
container image (layout is pinned to Linux fonts; the image tag must match the playwright version in `bun.lock`; no
postinstall there, so no engine install). A vite-config or server-build regression therefore fails the PR, not the
tag build. Cross-OS tests run before merge, so an OS-specific regression (a mac-only `fs.watch` failure was the
original incident) is caught early.

### §2 Release artifacts

| Platform    | Desktop (Electron)         | Headless (`claudeui-server`)                |
| ----------- | -------------------------- | ------------------------------------------- |
| mac-arm64   | released zip (Claude Code) | released zip (Claude Code)                  |
| win-x64     | released zip (Claude Code) | released zip (Claude Code)                  |
| linux-x64   | none                       | released tar.gz (the executable, no engine) |
| linux-arm64 | none                       | released tar.gz (the executable, no engine) |

- The mac and Windows server zips are steps appended to the desktop `build` matrix job (host-native
  `build:server:compile`, which carries `verify:sqlite`, a stage directory and an archive); they stage
  `vendor/claude-cli`. The Linux tarballs are a `server` matrix job (`ubuntu-latest` for x64, `ubuntu-24.04-arm` for
  arm64, everything host-native, so no cross-compilation). The `release` job needs `[version, build, server]`.
- Every cache key in the Linux job carries `runner.arch`; the Claude CLI source-binary cache has no cross-arch
  fallback (an x64 ELF restored onto the arm runner would extract as if native).
- Tarballs, not bare uploads, because `actions/upload-artifact` strips the executable bit; the mac zip carries it in
  the zip entry's unix mode (the release notes say to unpack with `unzip` or Finder). Windows has no bit to lose.
- No artifact carries `vendor/opencode-cli` or `vendor/pi-cli` (ADR-082 §8): a fresh server has none until an admin
  installs them from Settings › Harnesses › Installed. `packaging.test.ts` holds this (it parses
  `electron-builder.yml` and the workflows). CI's `bun install` postinstall installs opencode and pi into the
  runner's managed store, so CI exercises the download path.
- The server artifact's layout is the executable beside `out/renderer` (the one UI build, ADR-099); the server
  resolves its app path to the directory holding it, and `locateBunClaude()` reads
  `<appPath>/vendor/claude-cli/bun-claude[.exe]` whenever the path is not an `app.asar` path.
- The headless server wires `setHostAuth(null)` on purpose: no multi-account machinery, so cli.js reads the
  deployment box's own `claude` credential store and the session status shows no account. The release notes say the
  zip is not self-contained in that respect.

### §3 The Claude engine is absent from the Linux artifacts, stated not silent

No Linux `bun-claude` can exist today (bun's ELF standalone layout is unimplemented, `rebundle-cli.mjs` skips ELF
fail-closed), and the engine spawn hard-requires the rebundled binary (ADR-006, claude-engine.md), so nothing can
silently spawn an unpatched cli.js. The release notes state "the Claude Code engine is desktop-only for now" (a
System Claude Code can be selected instead, ADR-082 §2). The recorded way to lift it is a probe of running the
patched `cli.js` under a plain bun runtime on Linux, with a spawn-path change in `src/core/sdk/locate.ts`
(`docs/protocol-cc/` build pipeline first); implementing bun's ELF layout ourselves is ruled out.

### §4 `build-server.mjs compile` takes `--target=bun-<os>-<arch>`

Cross-targets make bun download that platform's runtime; probed from a Windows host on bun 1.3.14, every foreign
target failed extraction, so cross-building works from Linux and macOS hosts only. The release path never needs the
flag (each runner compiles its own platform).

Deliberately not done: no pure-asset bundle release (`dist/server/` stays a build target and CI gate); no
`node-pty` in the tarball (everything but `terminal:*` works without it); no mac-x64, Windows-ARM or Linux desktop
build, and no code signing of the server binary.
