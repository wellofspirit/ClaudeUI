# ADR-114: Starting sessions in a worktree, and how ClaudeUI sets one up

**Status:** Accepted (2026-10-29). Implemented in PRs #176, #177, #178 and #185.
**Relates to:** [ADR-112](adr-112_worktree-inventory-and-cleanup.md) (inventory, cleanup and detection),
[ADR-077](adr-077_worktree-relocated-transcripts.md) (worktree transcripts), [ADR-102](adr-102_invoke-progress-and-navigate-first-session-load.md)
(per-call progress).

## Context

Claude Code lets its agent move a conversation into a worktree mid-session (`EnterWorktree`). opencode and pi offer no
supported equivalent that ClaudeUI can drive:

- opencode can move a session to another directory, but ClaudeUI's permission rules then still judge paths from the
  spawn directory.
- pi fixes a session's working directory when it starts. Its RPC has no way to change it, and upstream has declined
  the requests for one.

A worktree from the first message works the same for every engine.

ClaudeUI's own worktree creation (`createWorktree`) also diverged from Claude Code's:

- It tried to set `core.hooksPath` to the wrong folder. simple-git refused the write, so it never took effect.
- It copied only `.claude/settings.local.json`.
- It always branched from the main checkout's HEAD.
- In repositories that don't ignore `.claude/worktrees/`, the new worktree showed in the main checkout's status as an
  untracked embedded repository.

## Decision

1. **Start in a worktree.**
   - A global setting, "Start new sessions in a worktree" (`startInWorktree`, Settings › Sessions & autonomy ›
     Worktrees).
   - A per-project override, Use default / Always / Never (`worktreeByProject`, keyed by the sidebar project key),
     set from the project's menu. The project value wins.
   - Both live in app settings: replicated, readable on the host, and the same on the web client.
   - The new-session toggle starts from the effective value and decides for that one session.
   - A session whose directory is already under `.claude/worktrees/` starts with it off.
2. **Created at the first send**, not when the directory is picked, so an abandoned new session leaves nothing behind.
   - Creation runs once per session.
   - A second send while it runs is ignored.
   - A colliding auto-generated name is re-rolled (up to three tries); a typed name is not.
   - A failure holds the message: nothing spawns and the draft is kept, with Retry and Send without a worktree.
     ClaudeUI never falls back silently to the main checkout.
   - `worktree:create` reports progress, so the web client's invoke timeout does not cut a slow fetch short.
3. **Base: the remote's default branch** for the toggle and the setting.
   - `git fetch origin`, then `origin/<default>`, verified with `rev-parse --verify`.
   - The fetch has a 15 s timeout and never prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`).
   - The branch is created with `--no-track`, so it has no upstream until it is published. Otherwise a plain push
     would target the default branch.
   - It falls back to HEAD without a remote, on a failed fetch, or when `origin/HEAD` is dangling.
   - `session_start`'s own `worktree` option keeps HEAD: an agent mid-arc wants its current state.
   - The local branch name is left as created; the agent may rename it or push it under another name.
4. **Set up like Claude Code** (its `hrt` / `njr`), every step best-effort:
   - A relative `core.hooksPath` (husky v9's `.husky/_`, generated and gitignored, so absent from a fresh worktree) is
     pinned to the absolute path it already means in the main checkout. This is written to the shared config, the
     same write Claude Code makes. Unset, absolute and `~/` values are left alone.
   - `.claude/worktrees/` is added to the repository's `info/exclude` unless it is already ignored.
   - `.worktreeinclude` (gitignore syntax, read from the main checkout) copies untracked, gitignored files.
     - Ignored folders are entered only when a pattern can reach them.
     - Symlinked sources are skipped, as are destinations that are themselves links or that a committed link
       redirects outside the worktree.
     - Nothing under `.claude/worktrees/` is copied.
5. **The session's working directory follows its worktree.**
   - `sessionWorkdir` gives the worktree path when the session works in one (Claude `EnterWorktree`, opencode
     `session.moved`), otherwise the spawn `cwd`. A session spawned in the worktree, or in a folder inside it, keeps
     that folder.
   - The git pills, the git panel, the terminal and the VS Code button use it. In a worktree, the VS Code button opens
     the worktree and also offers the parent repository.
   - `cwd` itself is unchanged for spawn, permissions and the sidebar.

## Consequences

- One toggle gives every engine a worktree per session, and nothing is created for sessions that never send.
- Hooks run in ClaudeUI-made worktrees, and listed local files such as `.env` come along.
- A repository opened under another path spelling (WSL `/mnt/...`, a devcontainer mount, a moved checkout) loses
  husky hooks there, because the pinned absolute path does not exist. This is accepted for parity with Claude Code.
- On macOS/Linux, Claude Code resolves a worktree's local settings to the main checkout, while ClaudeUI uses the
  worktree's copy (issue #175).
- An agent cannot yet move a pi or opencode conversation into a worktree mid-session (issue #186). The supported pi
  route (`SessionManager.forkFrom` + `ctx.switchSession`) and the permission work it needs are recorded there.

## Alternatives considered

- **Engine-native worktree tools for opencode and pi mid-session.** Deferred. Start-in-worktree covers the common case
  at a fraction of the cost.
- **Create the worktree when the directory is picked.** Rejected: it leaves an empty worktree behind for every
  abandoned new session.
- **Branch from the main checkout's HEAD for the setting.** Rejected: a main checkout parked on an old branch would
  seed every new session from it.
- **Delete the hooks-path step.** Rejected: hooks would silently never run in worktrees of husky v9 repositories.
