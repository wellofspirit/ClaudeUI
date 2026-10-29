# ADR-112: Worktree inventory and cleanup, and worktree detection for every engine

**Status:** Accepted (2026-10-25). Implemented on branch `feat/worktree-cleanup`.
**Amends:** [ADR-077](adr-077_worktree-relocated-transcripts.md) (a project group now carries its linked-worktree
identity).
**Relates to:** [ADR-102](adr-102_invoke-progress-and-navigate-first-session-load.md) (per-call progress), [ADR-105](adr-105_background-dispatch.md)
and [ADR-108](adr-108_dispatch-workdir-and-target-judge-context.md) (an X-Agent whose directory is gone is not
resumed), [ADR-097](adr-097_opencode-v2-only.md) (opencode 2.x events), [ADR-048](adr-048_mobile-surface-pattern.md) (phone
reachability), [ADR-114](adr-114_starting-sessions-in-a-worktree.md) (starting sessions in a worktree, setup, the
working directory following the worktree).

## Context

Git worktrees pile up. Every arc runs in one, Claude Code's `isolation: "worktree"` subagents leave
`.claude/worktrees/agent-<id>` behind whenever they changed something, and opencode and Codex create their own worktrees
outside the repository. A single machine held 22 worktrees and about 20 GiB under one repository.

A "View worktrees" modal already existed (sidebar project menu). It had no sizes, no confirmation and no in-use check.
It was blind to worktrees git records outside `<repo>/.claude/worktrees`. Its delete path had five defects:

- **Leftover folders.** `git worktree remove --force` exits 0 and unregisters the worktree, but leaves a folder holding
  the `node_modules`/`vendor` junctions (git does not follow them). The recursive fallback ran only when git failed, so
  these shells were never cleaned up.
- **Lost registration.** When a file is locked, git unregisters the worktree anyway, so the half-deleted leftover can no
  longer be found.
- **Lost commits.** The worktree's branch was always force-deleted, losing commits found nowhere else.
- **Client-supplied boundary.** The containment root came from the client.
- **Repo-global prune.** `git worktree prune` also dropped every other prunable entry.

Detection was also broken.

- **Claude Code.** Between 2.1.294 and 2.1.306 the `EnterWorktree` result text started quoting the path and branch
  (`Created worktree at “<path>” on branch “<branch>”.`, plus `Entered`, `Reused` and `Resumed` variants). The parser
  stopped matching, silently. A reducer rule also dropped a detected entry as soon as the session's status `cwd`, which
  never changes for any engine, equalled the recorded original directory, so a detected entry never stuck.
- **Other engines.** Nothing marked sessions of other engines, or sessions started in a worktree by any route other
  than ClaudeUI's own toggle.

The engines differ:

| Engine       | Creates worktrees                                      | Where                                      | Branch            | Mid-session directory change                                        |
| ------------ | ------------------------------------------------------ | ------------------------------------------ | ----------------- | ------------------------------------------------------------------- |
| ClaudeUI     | new-session toggle, `session_start`                    | `<repo>/.claude/worktrees/<name>`          | `worktree-<name>` | —                                                                   |
| Claude Code  | `EnterWorktree`, `--worktree`, `isolation: "worktree"` | same folder                                | `worktree-<name>` | `EnterWorktree`/`ExitWorktree` results; a Bash `cd` reaches no wire |
| opencode 2.x | `worktree_create` tool, TUI, `/api/worktree`           | its data dir, `worktree/<project6>/<slug>` | none (detached)   | `session_move` → durable `session.moved`                            |
| Codex        | TUI `/worktree`, `--worktree` (never the app-server)   | `~/.codex/worktrees/<4hex>/<repo>`         | none (detached)   | none on threads ClaudeUI drives                                     |
| pi           | never                                                  | —                                          | —                 | none; subagents share the parent's cwd                              |

## Decision

1. **Inventory.** Per repository, from the project's menu (a visible ⋯ button opens the menu on touch devices). The
   inventory lists every linked worktree `git worktree list --porcelain` reports for the repository, wherever it lives,
   plus orphan folders directly under `<repo>/.claude/worktrees/`.
   - Each entry carries its kind (worktree / orphan / missing), location (managed / opencode / Codex / other), branch
     or detached, and lock.
   - It also shows what holds the entry: live and cold sessions, X-Agents and terminals, matched by path containment
     lexically and by real path.
   - Each row loads its size, uncommitted files, commits found nowhere else and newest modification lazily.
   - Entries are addressed by their normalised path, re-resolved against a fresh inventory on the server. Nothing the
     client sends is trusted as a boundary.
2. **What can be removed.**
   - Allowed: a linked worktree of this repository whose `.git` file and git's `gitdir` record point at each other
     (backlink), or a direct child of a verified, non-linked `<repo>/.claude/worktrees`.
   - Never: anything equal to or containing the repository root, its common dir, the home directory or a filesystem
     root.
   - Orphans: a folder that is itself a checkout, or belongs to another repository, is refused. An orphan holding real
     files counts as dirty.
   - Refused: a worktree held by a live session, running X-Agent or live terminal (holders re-checked just before each
     entry), a locked worktree, and a worktree that contains another entry unless that entry is removed with it.
   - Allowed after a confirmation that lists what is lost: dirty worktrees and worktrees with commits found nowhere
     else. "Select safe" excludes them, and also excludes anything modified in the last 10 minutes.
   - A registered worktree whose folder is already gone ("missing") is inspected like any other. Its detached HEAD or
     branch may hold the only copy of some commits, so it is safe only with none. Only a provably absent path
     (ENOENT/ENOTDIR) counts as gone. A path that cannot be read fails its removal and is never handed to git.
   - "Select safe" replaces the current selection.
   - A row that contains other entries can be selected only together with them.
   - The manager cannot be closed while a removal runs, and the background size and status scan stops for the run.
   - Removed rows stay on screen with their result until the next refresh.
3. **How it is removed.** A link-safe walk runs first: links and junctions are unlinked and never entered, read-only
   entries are retried writable, and locked entries are collected. Only a clean walk goes on to unlink `.git`, remove
   the folder and run `git worktree remove --force <path>` for that entry. A partial walk leaves the entry registered,
   so it stays listed and can be retried. `git worktree prune` is never run.
4. **Branches.** A branch is deleted only when every commit on it is reachable from another branch, a remote-tracking
   ref or a tag (`rev-list --count refs/heads/<b> --not --exclude=<b> --branches --remotes --tags`). Otherwise it is
   kept and reported, as are `main`, `master`, the current and default branch, and a branch checked out elsewhere.
   A branch is also kept if its tip moved after the count, which is taken before the walk. This holds for every
   removal path.
5. **Other removal paths.**
   - The session-delete prompt goes through the same routine, including the holder check.
   - The quit prompt removes the chosen worktrees in the main process after sessions and engines are torn down, so no
     engine holds them, and the before-quit fallback timer does not cut that short.
   - Both prompts offer only worktrees ClaudeUI created (`WorktreeInfo.origin`). A detected worktree may be the user's
     own long-lived one. The server enforces the same rule on both paths, so a crafted call cannot remove anything
     else through them.
   - The renderer acknowledges that the quit prompt is showing. The coordinator then drops its 5-second fallback, so a
     user who takes time to decide no longer gets a silent "keep all". The fallback still covers a hung renderer.
   - At quit, holders are stopped first: sessions, X-Agents (background ones included) and terminals. Then removal
     retries a busy directory after 0.75, 2 and 5 seconds, within a 120-second bound.
   - After teardown the Codex host registry is shut down and refuses new hosts, and the quit path only forgets entries
     without re-listing projects, so nothing spawns an engine after teardown.
6. **Detection, every engine.**
   - A project group carries `linkedWorktree` when its directory is a linked git worktree. This is read from the
     filesystem (`.git` file → `gitdir` → `commondir`) without spawning git.
   - Every engine's session in such a directory shows the worktree icon, the pill and a faint purple backdrop at the
     right edge of its sidebar row. (2026-10-29: the worktree pill is merged into the branch pill, which shows the
     worktree mark in a worktree.)
   - Claude Code's four `EnterWorktree` variants are parsed tolerantly, with the tool input as a fallback.
     `ExitWorktree` clears the entry. The status-cwd drop rule is gone.
   - opencode's `session.moved` marks or clears the session's worktree. The session's own `cwd` is unchanged:
     permissions keep the spawn directory. (2026-10-29: the terminal, git pills, git panel and VS Code follow the
     worktree instead, ADR-114 §5.)
   - A detected entry is recorded only when its worktree belongs to the same repository as the session's spawn
     directory, because the entry widens `session_start`'s allowed roots.
   - (2026-10-29) The sidebar folds each marked worktree group under its parent repository's group, synthesising the
     parent when it has none. This happens in the view only: the listing stays one group per directory, so
     permissions, proposals and markers are unchanged. Delete project and Hide project act on the folded group, and
     the server derives the same set from the listing. A synthesised parent never removes the repository's
     `~/.claude/projects/<key>/` folder, which holds Claude Code's per-repository memory, and neither does a key the
     listing no longer knows or a worktree's own key: their sessions' files go one by one, and a worktree's key folder
     is removed only when it is empty. Live sessions belong by directory, not by the lossy key. Worktree folders are
     never touched.
7. **Remote parity.** Every verb is declared once for both transports under the `git` capability, the same capability
   as the existing discard and remove verbs. Removal and size reports use per-call progress, which also keeps the web
   client's invoke alive during large deletes. Removal is serialised per repository. Each removal is logged with its
   path and outcome, because audit rows carry no arguments.
8. **Codex host.** The shared Codex app-server always runs with the home directory as its cwd, so a host shared across
   sessions can never pin a worktree. Its bootstrap config therefore no longer picks up the first session's project
   `.codex/config.toml`. Per-thread config, MCP servers and exec still use the thread's cwd, which ClaudeUI always
   sends on `thread/start|resume|fork` and `config/read`.

## Consequences

- Disk can be reclaimed safely from the UI on desktop and the web client. A failed delete is visible and can be
  retried instead of leaving an untracked shell.
- Worktree removal keeps commits that exist nowhere else. A kept branch costs no disk space.
- Known gaps:
  - A Claude Code agent that `cd`s into a worktree is neither marked nor seen as a holder (no wire signal; issue #161).
  - Orphan folders in opencode's and Codex's own roots are not scanned, and there is no cross-repository overview
    (issue #162).
  - opencode's own worktree table keeps a row for a removed folder until opencode refreshes it.
  - A VS Code serve-web tab or an outside tool holding files makes a delete partial, which is reported.
  - At quit on Windows, processes started by an engine (Claude Code's Bash children and background tasks, stdio MCP
    servers) can outlive their engine for a while and keep the directory busy. A quit-time removal then ends
    `partial`, and the leftover shows in the inventory on the next launch.
  - Node has no `openat`-style no-follow walk, so a folder swapped for a junction between the check and the walk is a
    residual risk. It is narrowed by re-checking the real path just before each walk.
- A brand-new session's marker appears with the next project-listing refresh.

## Alternatives considered

- **Only `<repo>/.claude/worktrees`.** Rejected: opencode and Codex worktrees of the same repository would stay invisible.
  Git's registration plus the backlink proves membership wherever they live.
- **Refuse dirty worktrees; always delete or always keep branches.** Rejected in favour of a confirm listing the loss and
  keeping only branches whose commits would otherwise be lost.
- **Stop the holders and then remove.** Rejected: a larger blast radius than naming the holder and letting the user stop it.
- **A replicated map of linked-worktree cwds.** Rejected: the project listing already has one group per directory, so a
  field on it needs no new state, channel classification or snapshot field.
- **Mark worktree sessions from the folder name (`.claude/worktrees`).** Rejected: it misses opencode's and Codex's
  worktrees and is fooled by a non-repository path containing that name.
