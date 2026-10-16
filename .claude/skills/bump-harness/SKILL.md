---
name: bump-harness
description: Bump or adopt a new version of an engine ClaudeUI drives — Claude Code (the vendored, patched cli.js / bun-claude), opencode, pi or Codex. Use whenever asked to "bump <engine> to latest", check whether a new harness release is worth adopting, re-pin a harness, fix patches broken by a Claude Code update, or verify a harness version works. Carries the owner's standing bump contract, the gate order, per-engine checklists and the traps past bumps fell into.
---

# Bump a harness

The owner's bump requests are one line ("bump cc cli to latest version and fix all tests and run
test harness"). Everything below is what that line means. Do not ask the owner to restate it.

The workflow (who reads, implements, verifies, reviews; the gates; the Fable consult and exit
gate) is the `orchestrate` skill with ADR-026 (`docs/adr/adr-026_development-workflow.md`), which
also holds the rules for all work in this repo — live evidence over source reading, real-provider
testing on entry-level or free models with isolated homes, one worktree per arc, settled rulings
stay settled, reporting every gap. Read both first. This skill adds only what is specific to bumps.

## The contract

1. **Scope.** The latest release of the engine named, nothing else. "Bump Claude Code" means
   Claude Code only, and one Claude Code version everywhere (`package.json#claudeCliVersion` =
   `src/shared/harness-manifests/claude.json#tested`). "Check the other harnesses" means a
   compatibility report first, not a bump.
2. **Research first, decide once.** Before changing anything, read the upstream changes between the
   current pin and the target (changelog, release notes, `git diff <old-tag> <new-tag>` in
   `vendor/<engine>-src`) and list every decision the owner must make, all in one message. Re-check
   the latest version right before implementing: upstream moves while decisions wait.
3. **Probe both binaries.** For Claude Code, an engine-behaviour question is probed on Anthropic's
   official binary and on our patched one (ADR-026's live-evidence rule).
4. **Every platform.** A Claude Code bump is applied and checked against the win32-x64, darwin-arm64
   and linux-x64 bundles, not only the host's. cli.js differs per platform within one version.
5. **Each Claude Code patch must still earn its place.** On every bump ask whether upstream now
   offers a surface that replaces a patch; propose removing it if so. The product rule: with an
   unpatched harness the chat still works, streaming degrades, and voice is disabled.
6. **One PR per bump batch.** Several engines bumped together go in one branch and one PR, one
   commit per item.

## Bump gates

These come before ADR-026's own gates (developer test, verifier, orchestrator test, PR + CI, Fable):

| #   | Gate                                  | How                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| 0   | Boot probe — the patched binary boots | runs at the end of `bun run ensure-cli` (`scripts/boot-probe.mjs`); Claude Code only |
| 1   | Cross-platform apply                  | `node scripts/check-patches-cross-platform.mjs`; Claude Code only                    |
| 2   | The engine's own suite                | per engine, in the checklist; zero unexplained skips                                 |
| 3   | Real-app verifier drive               | the engine checklist names what to exercise                                          |

A suite that reports skipped tests has not passed. Find out why each test skipped (missing env
flag, HOME redirected, engine not installed, platform gate) and either run it or name the gap in
the PR.

## Per-engine checklists

- Claude Code → `references/claude-code.md`
- opencode → `references/opencode.md`
- pi → `references/pi.md`
- Codex → `references/codex.md`

Each lists the files that must move with the pin and links to the procedure that already exists
for that engine. Follow the linked procedure; the checklist is what past bumps forgot.

## Before you start

- Read `references/traps.md`. Every item there cost a past bump hours.
- Check out the new tag in `vendor/<engine>-src` before reading upstream code. The checkout is
  gitignored and per machine; the manifest pin is the contract.
- Keep the ADR-026 handoff doc (`docs/<engine>-bump-handoff.md`).

## Briefs

`references/kickoffs.md` says how to fill in the `orchestrate` skill's reader, implementer, verifier
and Fable templates for a bump.

## Reporting to the owner

Version from → to, what broke, what was fixed, which gates ran with their exact counts, and every
gap (platform not run, tests skipped, live path not exercised). Open decisions as a numbered list,
each with a recommendation.
