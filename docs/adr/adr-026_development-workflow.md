# ADR-026 — Development workflow: Opus orchestrates and decides, Sonnet builds, Fable advises and gates the PR

**Status:** Accepted. Amended 2026-10-16 (Daniel): one workflow for every change — Opus orchestrates and
makes every judgment call; Sonnet reads, implements and verifies; Fable is the design consultant and the
PR's exit gate; work lands as a pull request. The step-by-step procedure lives in the owner's user-level
`orchestrate` skill and the roles are his user-level custom agents (`orch-reader`, `orch-implementer`,
`orch-verifier`, `orch-design-reviewer`, `orch-pr-reviewer`), shared across his projects (and, once ADR-103
lands, loaded by ClaudeUI into pi and opencode too); this ADR keeps the decision and what is specific to this
repository. Replaces the driver pairings of 2026-09-17 (Fable → Opus, GPT-6 → GPT-5.6 Sol) and the 2026-10-01
Sonnet/Opus split. Kept from earlier amendments: the separate verifier
(2026-09-16), delegated gates and the fresh reviewer for large diffs (2026-09-21).
**Relates to:** ADR-027 (test data attributes — the structural-verification tier this workflow leans on)

## Context

Every phase built since V2 used one division of labour: **the main model orchestrates and reviews; a
cheaper sub-agent writes the code.** Every phase surfaced at least one real bug _in review_ — a
model-picker regression, dead persisted data, a vacuous migration test, an `acquire()` race, a per-frame
token overcount, a wrong auth-source mapping — that the implementing agent's own summary did not mention.
The lesson: **the implementing agent never self-certifies; correctness is owned by the reviewer who reads
every line and re-runs the gates independently.**

The models filling the roles changed several times (Opus → Sonnet, then Fable → Opus, then GPT-6 → Sol
alongside it). On 2026-10-16 Daniel consolidated them: Opus is strong enough to orchestrate every change,
Sonnet does the volume work, and Fable is kept for the two places where a stronger second view pays for
itself — a design with a large blast radius, and the finished pull request.

## Decision

Every non-trivial change in this repository (anything beyond a one-line or mechanical edit: features,
refactors touching shared seams, anything with a native or external dependency — an engine binary, the
cli.js wire, the DB driver — anything user-visible) follows the owner's `orchestrate` skill, with the
roles, gates and repository rules below. Trivial edits and conversational answers are exempt.

### Roles

| Role              | Model (Claude Code; each agent file carries its model per harness)                  | Owns                                                                                                                                                                                               | Never                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator**  | Opus (the default session driver; whichever model drives a session takes this role) | Scope, design, the spec, **every judgment call** within the owner's rulings, line-by-line review of each sub-agent's diff and of the finished branch, the orchestrator test, commits, push, the PR | Implements beyond docs, specs and trivial edits; drives the app by hand; decides a genuine product fork (that is the owner's) |
| **Reader**        | Sonnet                                                                              | Collecting evidence — quotes with `path:line`, diffs, changelogs, logs, test counts                                                                                                                | Decides what the evidence means                                                                                               |
| **Implementer**   | Sonnet                                                                              | Code against the written spec, and the developer test                                                                                                                                              | Commits, `git add`s, branches, installs dependencies, self-certifies                                                          |
| **Verifier**      | Sonnet, a **separate** agent (fresh context, never the implementer)                 | The real-app drive (`verifier-electron` skill / `scripts/app-shot.mjs`, DOM assertions by `data-testid` first — ADR-027 — then screenshots) or a gated smoke for infra                             | Edits source, commits, certifies                                                                                              |
| **Consultant**    | Fable                                                                               | Advice on complicated designs or designs with a large blast radius, before implementation                                                                                                          | Is overruled silently                                                                                                         |
| **Exit reviewer** | Fable                                                                               | The final check and code review of the open PR                                                                                                                                                     | Merges — the owner does                                                                                                       |

**Consult Fable** when a change alters a shared seam (session layer, IPC, persistence, sync), credentials
or the security model, the build/install pipeline or CI, an engine's wire contract, or this workflow; or
is hard to reverse; or the orchestrator is unsure between designs.

**Disagreeing with Fable.** The orchestrator accepts a finding or argues it with Fable, with evidence. A
disagreement that survives goes to the owner, who is the final judge. No Fable finding is dropped
silently.

**Gates, in order:** developer test (implementer) → verifier (separate agent) → orchestrator test and
per-slice review → overall review of the branch → push + PR → CI → Fable exit review → the owner merges.
CI runs on pull requests only (`.github/workflows/ci.yml`), so a change that skips the PR skips CI.

**Handoff docs.** Long arcs keep an untracked `docs/<arc>-handoff.md` with a RESUME HERE block, current
after every slice; every instruction to an agent goes into it, never only into a message.

### This repository's gates

- `scripts/gates.sh` — typecheck, `eslint --cache`, `bun run test` (retried once for the known vitest
  fork-pool teardown crash). It exists because `bun run test 2>&1 | grep … && git commit` takes grep's
  exit code: **never pipe a gate into a filter before acting on its result.** The orchestrator runs it
  itself before recording "gates green" anywhere; a tree was once handed over as green with five
  typecheck errors in it.
- Add `bun run test:ci` (the git project) after touching git-service or worktree code, `bun run build`
  for anything the packaged app runs, and `bun run format:check` (CI enforces it).
- `bun run test` includes the `browser` project, which needs Playwright's Chromium
  (`bunx playwright install --only-shell chromium`).
- Engine work adds that engine's gated suite (`docs/testing-strategy.md`); a suite that only skipped has
  not passed.

### This repository's additions to the agents' constraints

The role agents carry the generic constraints. The repository's own additions are in the "How work is done
here" section of `CLAUDE.md`, which Claude Code and pi load for every agent (opencode loads only `AGENTS.md`:
until ADR-103 covers it, the orchestrator appends that section to briefs for opencode agents): format with `bunx prettier --write <files you touched>`
(`bun run format` is the repo-wide one), never kill `bun-claude` by process name (it also runs the agent sessions),
and `scripts/gates.sh` is the commit gate. Keep that section free of the names of the models and harnesses
that run the agents: every agent reads it.

### Rules for all work in this repository

- **Live evidence over source reading.** A claim about how an engine, a binary or the app behaves is
  settled by probing the real thing; source reading finds candidates, the probe decides.
- **Real-provider testing.** Real model calls only on entry-level or free models (verify a "free" model
  is free before using it); a failure is reported, never retried on a bigger model. Which providers and
  accounts may be used is the owner's call and is never written into this public repository.
  Credentials are read by a script from ClaudeUI's own store, never echoed and never refreshed by a
  test. The owner's real profile only with explicit permission; otherwise an isolated home
  (HOME/USERPROFILE/APPDATA and the engine's own directory variable), with a sha256 of any real
  credential file taken before and after.
- **One worktree per arc** (`.claude/worktrees/<name>`); never switch branches in the main checkout,
  which other sessions and the owner's builds use. A fresh worktree has no `vendor/<engine>-src`; read
  the main checkout's.
- **Settled rulings stay settled.** Before reporting behaviour as a bug, check the relevant ADR and
  handoff docs: several reported "bugs" were documented decisions.
- **Report the gaps.** Lead with the answer; name every gate that did not run, every skip, every
  platform not exercised.
- **Unattended runs delete nothing** — a delete can wait hours on a permission prompt nobody sees.
- **Engine bumps** follow the `bump-harness` skill (`.claude/skills/bump-harness/`).

### Standing constraints (they have bitten us)

- **Implementers never run `bun install` / `bun add` / `bun remove`.** `postinstall`
  (`scripts/build.mjs postinstall`) downloads Electron, rebuilds node-pty for the Electron ABI
  (`electron-builder install-app-deps`), rebuilds the patched Claude Code binary and installs the tested
  opencode, pi and Codex into the managed store — side effects an implementer must not trigger. (The old
  "bun leaves a Node-ABI better-sqlite3" trap is gone: better-sqlite3 13 ships prebuilt binaries that load
  under both Node and Electron.)
- **Database code is tested through the driver seam.** vitest aliases `better-sqlite3` to a
  `node:sqlite`-backed stub (`vitest.config.ts`); only the driver adapter
  (`src/core/services/sqlite/better-sqlite3-driver.ts`) imports `better-sqlite3`.
- **Don't break Claude.** Claude is the daily driver and the live login path — an auth-detection bug is a
  lockout. Every change touching shared seams is confirmed behaviour-preserving for Claude in the
  verifier's real-app drive.
- **opencode (2.x only, ADR-097).** The binary lives in ClaudeUI's managed store
  (`~/.claude/ui/harnesses/opencode/<version>/`) and is never packaged (ADR-082 §8). Every route is under
  `/api/*`; one SSE feed per server (`/api/event`) carries every session — filter by the event's session
  id. HTTP Basic auth, password via `OPENCODE_PASSWORD`. Wire facts: `docs/protocol-opencode/`.
- **cli.js wire.** For any cli.js question consult `docs/protocol-cc/` first, then probe the real
  `bun-claude` binary — cheaper and more reliable than reading minified cli.js. Navigate the bundle with
  the bundle-analyzer tooling, not grep over the concat.
- **pi wire (ADR-035).** Consult `docs/protocol-pi/` and the version-exact docs at the pinned tag
  (`vendor/pi-src/packages/coding-agent/docs/`), then probe the managed store's pi binary. The bridge
  extension (`pi-bridge-source.ts`) stays **import-free** and **fail-closed**; its file lives under
  `~/.claude/ui/pi-ext`. Product code writes under `~/.pi/agent/` only through its documented writers
  (`PiAuthProvider`'s `auth.json` api_key merge, the native settings editor's `settings.json`, the shared
  provider adapter's `models.json`).
- **Commits.** One per item, after review and verification; stage precisely; no AI attribution, no
  Co-Authored-By; grep the staged diff for personal identifiers.

## Consequences

- **Correctness is structurally owned by review**, not by the implementer's confidence — the single most
  load-bearing rule; it has caught a real bug nearly every phase.
- The procedure lives once, in the owner's `orchestrate` skill, and serves every project of his; this
  ADR binds the roles, the gates and the repository's own rules. `CLAUDE.md` points here.
- Fable's cost is spent where it pays: a bad large design and a bad merge are the two most expensive
  mistakes. Small designs go straight from spec to Sonnet.
- An agent without the owner's skills and agents (another machine, another person) still gets the roles,
  gates and rules from this ADR and `CLAUDE.md`, but not the step-by-step procedure or the role agents.

## Alternatives considered

- **Let the implementing agent self-certify.** Rejected: every phase proved the implementer misses its
  own bugs and its summary overstates correctness.
- **The orchestrator drives the real app itself** (until 2026-09-16). Rejected: it burns the
  orchestrator's context on harness mechanics, and the evidence was read by the model that produced it.
- **The orchestrator implements directly.** Viable for small changes (and used for specs, ADRs and docs),
  but it burns the orchestrator's context on mechanical edits and loses the fresh-eyes separation.
- **Fable orchestrates every change** (2026-07-30 to 2026-10-16). Superseded: Opus orchestrates as well
  for most work, and Fable's review is worth more at the design and exit points than spread across every
  step.
- **Driver-specific pairings (GPT-6 → GPT-5.6 Sol).** Retired from this ADR with the consolidation; the agent
  files carry any per-harness model.
- **Keep the full step-by-step loop in this ADR.** Rejected (owner, 2026-10-16): the procedure is the
  owner's common work pattern across projects, so it lives in his user-level skill; a copy here would
  drift.
