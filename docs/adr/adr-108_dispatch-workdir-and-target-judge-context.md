# ADR-108: A dispatched agent can run in its own working directory, and its judge knows the user's granted directories

**Status:** Accepted (2026-10-23). Implemented on branch `fix/judge-hardening`.
**Amends:** [ADR-033](adr-033_cross-engine-dispatch.md) (a target ran in the dispatcher's working directory),
[ADR-088](adr-088_dispatch-autonomy-inheritance.md) (the target judge's environment),
[ADR-105](adr-105_background-dispatch.md) §1 (the ledger's working directory),
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) (a target's deny/ask rules).
**Relates to:** [ADR-084](adr-084_read-only-judge-bypass.md) (the read-only gate's scope is unchanged),
[ADR-097](adr-097_opencode-v2-only.md) (opencode target rulesets keep no allows or additional directories),
[ADR-106](adr-106_judge-calibration-measured-facts.md) (redirect facts measured against the judge's scope).

## Context

A dispatched X-Agent always ran in the dispatching session's working directory, and its judge counted only that
directory as local (targets get no additional directories, ADR-033/085). Agents that work in a sibling git worktree
(`…/project-wt/_work/x` while the parent is in `…/project`) therefore `cd` out of their working directory on every
command. Since ADR-106 tracks `cd`, the judge is told — correctly — that their builds write outside the working tree,
and a directory the user granted for exactly this work was invisible to it.

## Decision

1. **`dispatch_agent` takes an optional `workdir`** (all four hosts: Claude, opencode, Codex — on its approval card —
   and pi, bridge v24): absolute, or relative to the dispatcher's working directory. The dispatcher resolves it (a
   leading `~` too), realpaths both sides, and accepts it only inside the dispatcher's working directory or one of the
   user's additional directories (the settings merge for the dispatcher's directory). Containment is decided before
   existence, so a refusal never reveals whether an outside path exists. It must be an existing directory. The target
   starts in the canonical real path, so a link swapped in after the check cannot redirect it. A continuation (a
   message to an existing X-Agent) cannot change its directory.
2. **Ledger:** `cwd` is the target's own directory (every resume path already read it so); a new nullable
   `parent_cwd` column (migration v40; NULL on older rows means "same as `cwd`") keeps the dispatcher's. A resume or
   message whose stored directory no longer exists (a removed worktree) is refused with a clear message before
   anything spawns; restoring the directory makes it resumable again.
3. **Rules union:** a target's deny and ask rules are the union of the rules for the dispatcher's directory and for
   the target's, parent first. They only tighten; a worktree target never loses the parent's
   `.claude/settings.local.json` rules. Allow rules and additional directories stay empty in every target ruleset.
4. **Judge context, context only:** the target's judge counts as local its own working directory, the dispatcher's
   directory when different, and the user's additional directories (read fresh per call), in the environment text and
   in the redirect-fact scope. They never reach the static gates (the read-only bypass, the allow-rule gate) or any
   engine ruleset, so they grant nothing; this holds with or without a `workdir`.
5. **Out of reach:** Claude targets are judged by Claude Code itself and Codex targets by Codex's reviewer; both run in
   the `workdir`, but neither gets the context-only directories.

## Consequences

Worktree-based delegation no longer looks like writing outside the working tree to the judge, once the user grants
the worktree root. A target in a worktree keeps every deny/ask rule the parent's directory has. The stored directory
is the canonical real path, not the caller's spelling.
