# ADR-077: A session belongs to its home project; its transcript is found by id, never derived from cwd

**Status:** Accepted (2026-09-24). Implemented in `f7c1944b` (grouping, locator, project delete) and `b557d29b` (a resume target with no transcript spawns fresh).
**Amends:** [ADR-025](adr-025_project-key-identity-and-engine-neutral-delete.md) §1. A Claude group's key and the `projectKey` of each session in it are no longer always the same string.
**Relates to:** [ADR-026](adr-026_development-workflow.md) (how this was built and verified), [ADR-027](adr-027_test-data-attributes.md) (the testids the verification asserted)

## Context

cli.js's `EnterWorktree` tool runs `relocateSessionTranscript`. That function moves the live transcript (`<sid>.jsonl` and its `<sid>/` folder of subagents and tool results) out of the project dir of the session's cwd and into the project dir of the worktree path: `…/<repo>/.claude/worktrees/<name>` maps to `-…-<repo>--claude-worktrees-<name>`. It also appends a `{"type":"relocated","relocatedCwd":…}` line, and one more on every later spawn. `ExitWorktree` moves the file back the same way. The transcript's first user entry keeps the original cwd.

This is not new. Every cached build from 2.1.219 to 2.1.280 moves the file when run in a scratch repo, and a July 2.1.219 transcript carries the same stamps; it is back in its home dir only because that session later ran `ExitWorktree`. cli.js's own `--resume <sid>`, started from the original cwd, still finds the moved file, switches back into the worktree and keeps appending there.

ClaudeUI assumed a Claude transcript lives at `~/.claude/projects/<cwdToProjectKey(cwd)>/<sid>.jsonl`, in two places:

- **Grouping.** `listDirectories` built one group per project dir and labelled it with the first prompt's cwd. A session still inside its worktree therefore appeared as a second project with the same name as its real one (seen with `dp360-iac`).
- **Reading.** The resume cost and identity seeds, the post-turn reconcile, the canonical resume seed, the manager's disk fallback and the fork anchor all built the path from cwd. For a moved session each of these found nothing: the cost seed logged `Resume seed found no usable transcript`, and branching failed with `transcript-not-found`.

A separate failure showed up in the same investigation. When a spawned cli.js dies before it writes anything, no transcript exists, but the renderer's respawn paths (`doSend`, `ensureSession`, `restartSdkSession`, `retrySend`) still ask to resume it. cli.js then exits with `No conversation found with session ID …` on every attempt, and the session can never be used again.

## Decision

### 1. A session is grouped under its home project

A Claude session's **home** is `cwdToProjectKey` of the cwd on its first user entry. It falls back to the dir the file lives in when that cwd is unknown. `listDirectories` builds each group under the home key, so a session inside a worktree stays in the project it was started in, as the user expects. A home group can exist with all its members moved away and no directory of its own on disk.

The comparison is purely between keys and never goes through git. A session whose first prompt already ran inside a worktree (ClaudeUI's "new session in worktree" option) has the worktree as its home and keeps its own project. Grouping by the git common dir was considered and left out of scope.

### 2. `SessionInfo.projectKey` is where the file IS; the group key is where the session BELONGS

ADR-025 made `projectKey` "the on-disk directory name for Claude's own file ops". That remains true of **`SessionInfo.projectKey`**, which is always the dir the file currently sits in. It is **not** true of `DirectoryGroup.projectKey` any more: that key names the home, and may name a directory that doesn't exist.

The rule for callers: anything that touches one session's file (load history, watch, rename, delete, the remote-resume cold seed) uses the **session's** `projectKey` and never its group's. Two renderer call sites read the group's key and were fixed. One was the rename target: `writeCustomTitle` appends, so the group key would have created a stray one-line transcript in the home dir.

### 3. Find a transcript by session id, never derive it from cwd

`locateClaudeTranscript(sessionId, cwdHint)` (`src/core/services/claude-transcript-locator.ts`) checks the cwd-derived path first, which costs one stat in the common case. Only when that misses does it scan `~/.claude/projects/*/<sid>.jsonl`. Every Claude transcript read listed in the Context goes through it, and `claudeProjectKeyFor` gives callers that need a key rather than a path the dir it found. A live session is re-located on every call, because `EnterWorktree` can move its file mid-session.

New code that reads a Claude transcript uses the locator. Building `~/.claude/projects/<cwdToProjectKey(cwd)>/…` directly is a bug unless the file is about to be created.

### 4. Project delete removes what the project lists, and nothing it doesn't

Deleting a project also deletes its moved members one session at a time, using each session's own `projectKey`, so they don't come back on the next listing. The whole directory is removed only when no other project lists a session stored in it. When one does, each member is deleted individually and the directory stays. Otherwise, deleting a worktree-born project would silently take a moved session that the sidebar shows under a different project. The delete confirmation lists exactly these paths.

### 5. A resume target with no transcript spawns fresh

`ClaudeSession`'s constructor decides this once, instead of each renderer call site deciding it. When the resume target is not a fork and the locator finds no transcript, it logs a warning and drops the resume. cli.js then mints a new id, and the existing post-init rekey moves the session onto it, the same as for any new session. Forks are exempt, because a missing fork source is a real error and turning a branch into an unrelated empty session would hide it.

## Alternatives considered

- **Root the moved session's project at the worktree path.** This means taking the last cwd, or `relocatedCwd`, as the home. Rejected: the user thinks of the session as belonging to the repo, and the group would break (a project whose cwd no longer exists) the moment the worktree is removed.
- **Look up the transcript through the `relocated` stamps.** Reading them means parsing the transcript, which is the file we are trying to find. A directory scan is simpler and also covers anything else that moves a file.
- **Guard resume in each renderer call site.** Rejected: four sites, plus remote clients, would each need the same disk check, and the renderer cannot see the disk. The main-process constructor is the one place every spawn passes through.
- **Detect "relocated" only when a transcript contains a `relocated` line.** This would stop false positives for cwds longer than 200 characters, which cli.js truncates and hashes and `cwdToProjectKey` does not. Deferred: it adds a field to the directory cache, and the long-path case still lists and deletes correctly under the key-comparison rule.

## Consequences

- One project per repo in the sidebar, whether or not a session is currently inside a worktree.
- Resume seeding, the post-turn reconcile, canonical seeding and branching all work for moved sessions.
- A session left without a transcript no longer ends in a dead-end loop of "No conversation found".
- Known gap: when a cwd is longer than 200 characters, cli.js truncates and hashes its project dir name. Those sessions group under an untruncated key with no directory on disk. They still list and delete correctly, but a project hidden under its old dir-name key shows again.
