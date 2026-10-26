# Bump briefs

Dispatch `Explore` for evidence (ask for quotes with `path:line`, not conclusions) and the orchestrate role agents
`orch-implementer`, `orch-verifier` and `orch-reviewer`, which carry their own instructions and constraints. For a
bump, the brief adds:

## `Explore` — compatibility evidence (one per engine; they can run in parallel)

- Question: what changed between **<old>** and **<new>** of **<engine>** that ClaudeUI depends on.
- Sources: every changelog / release-note entry in (<old>, <new>]; `git diff <old-tag> <new-tag>` in the main
  checkout's `vendor/<engine>-src` (fetch tags first; a diff between tags does not need the checkout moved) over
  the paths the engine checklist names.
- Dependencies: grep `src/` for every removed or renamed field, flag, route, event, argument rule and default;
  quote ClaudeUI's line next to upstream's.
- Commands: the engine's offline tests against both the current pin and the candidate where a binary override
  exists (e.g. `OPENCODE_V2_BIN` + `OPENCODE_V2_ALLOW_VERSION_MISMATCH=1`).
- Fetching tags into `vendor/<engine>-src` is the only git write allowed.

## `orch-implementer` — the bump itself

- Spec: the handoff doc's slice — the pin files from the engine checklist and the owner's rulings from the
  compatibility round.
- Developer test: the engine checklist's gates plus `scripts/gates.sh`; for Claude Code also `bun run update-cli`
  (boot probe) and `node scripts/check-patches-cross-platform.mjs`.

## `orch-verifier` — the real app on the new version

- Record the engine path the app spawned (app log + child argv) and its `--version`.
- Isolated home unless the owner allowed the real profile; never a second app on the real profile with opencode
  (its quit removes the shared credential).
- Claims: the checklist's real-app items (a tool turn, a subagent, reload/reopen keeping model and effort, plus the
  engine-specific one).

## `orch-reviewer`

- Design review when the bump adopts a behaviour change (a new default, a permission change, a protocol change) rather
  than a drop-in.
- Exit review extras: every file the engine checklist says must move with the pin did move; nothing is left at the
  old version; each upstream change in the compatibility report is handled or consciously accepted — and look for
  one the report missed in `vendor/<engine>-src` between the tags.
