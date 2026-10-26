# ADR-026 — Development workflow: one orchestrator, rigor scaled to risk

**Status:** Accepted. Amended 2026-10-26: rigor scales with each slice's risk tier; one independent check per
risk instead of every check on every change; every review finding is triaged by realistic likelihood, with a
two-round stop; four roles instead of six. The procedure, and which agent and model fill each role, live in the
user-level `orchestrate` skill where it is installed; this ADR keeps the decision and what is specific to this
repository. Supersedes the 2026-10-16 amendment's model assignments, gate order, consult list and its rule that the
orchestrator reads every line of every change.
**Relates to:** ADR-027 (test data attributes — the structural tier of live verification)

## Context

Agents implement quickly but miss their own bugs, so an independent check is load-bearing: every phase since V2
surfaced at least one real bug in review that the implementer's summary did not mention.

The 2026-10-25 arcs showed the opposite failure. Every check ran on every change, and nothing defined when to
stop. The pi auto-mode arc took 2h40m to build and then 6h30m of review rounds. From the third round on, those
rounds chased Windows junction and symlink chains that need Developer Mode and a contrived setup. The worktree
cleanup arc grew to 101 files and about 12,700 lines, because a design consult's and per-slice reviews'
hardening findings were all accepted. In both arcs the bugs that mattered were caught by the first independent
pass.

## Decision

Every non-trivial change follows the `orchestrate` skill where it is installed, and the roles and rules below
either way. Trivial edits and conversational answers are exempt.

### Roles

| Role                                          | Owns                                                                                                    | Never                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Orchestrator (the session leading the change) | Scope, tiers, design, every ruling, slice review, commits, the pull request                             | Hands a product decision to anyone but the user |
| Implementer                                   | Code and tests against the spec                                                                         | Commits, or certifies its own work              |
| Reviewer                                      | Design review of Critical slices, review of diffs too big for the orchestrator to hold, the exit review | Edits the change it reviews                     |
| Verifier                                      | Live verification of the running app, when the tier calls for it                                        | Is the agent that built the change              |

Each review and verification comes from a fresh context, never the one that wrote the code.

### Tiers, findings and stopping

Each slice gets a tier from its risk, not its size, stated to the user up front:

- **Light** (a contained change, no contract change): one fresh review of the diff.
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

- `scripts/gates.sh`, once per commit-ready tree: typecheck, lint and the whole default suite. Never pipe a gate
  into a filter before acting on its result: the pipeline takes the filter's exit code.
- Add `bun run test:ci` after touching git-service or worktree code, `bun run build` for anything the packaged app
  runs, and `bun run format:check`.
- Engine work adds that engine's gated suite (`docs/testing-strategy.md`). A suite that only skipped has not passed.
- Live verification starts from the `verifier-electron` skill, which holds the isolation recipe for this app.
- A change to a seam the engines share is checked to preserve Claude's behaviour. Claude is the daily driver, and an
  auth-detection bug locks the user out.

### Where a new rule goes

A lesson from an incident goes into this repository: `CLAUDE.md`, this ADR, or the `verifier-electron` skill. It
goes into the shared skill or agents only if it would matter in most projects and the harm it prevents is hard to
undo.

### Decision records

An ADR records one decision in about a page: the context, the decision, its consequences. When a decision changes,
edit that ADR in place and add one dated line saying what changed; git keeps the history, so no appended amendment
sections and no stack of "amended by" headers. Write a new ADR only for a decision area no ADR covers yet. Design
detail, probe facts and as-built notes belong in `docs/architecture/` or `docs/protocol-*/`, not in an ADR.

### Work notes

An arc's handoff, specs and reports live in `.work/<arc>/` in the main checkout (gitignored; worktrees are deleted
at merge). Open items are GitHub issues labelled `backlog` or `housekeeping`. Research that cannot be public follows
the `claudeui-notes` skill where it is installed, otherwise `.work/<arc>/`. Retiring an arc is part of its merge:
lasting facts move, scrubbed, into ADRs and `docs/`; what is still open becomes issues; `.work/<arc>/` is deleted.

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

## Consequences

- Most changes run Light or Standard, with one independent check and no live drive unless runtime is the only
  place the behaviour shows.
- Some real but unlikely problems ship as issues instead of being fixed in the arc.
- A misjudged tier is the main risk. The tier is stated up front, the user can override it, and the orchestrator
  escalates on evidence.

## Alternatives considered

- **Keep every check on every change.** Rejected: the 2026-10-25 arcs cost about nine hours each, mostly in review
  rounds past the first, which found only tail cases.
- **No independent check.** Rejected: in the 2026-10-20 replay evaluation, the runs without one shipped a tool
  contract break that consumer suites and review caught in the others.
- **Keep the step-by-step procedure in this ADR.** Rejected: the procedure is shared across projects and lives in
  the user-level skill; a copy here would drift.
