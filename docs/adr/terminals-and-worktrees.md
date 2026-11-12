# Terminals, git worktrees and cleanup

Governs: `src/renderer/src/components/terminal/`, `src/renderer/src/hooks/useTerminalColdCleanup.ts`, `src/core/services/pty-manager.ts`, `src/core/services/terminal-service.ts`, `src/core/ipc/terminal.ipc.ts`, `src/core/services/worktree.ts`, `src/core/services/worktree-detect.ts`, `src/core/services/worktree-fs.ts`, `src/core/services/worktree-holders.ts`, `src/core/services/worktree-root.ts`, `src/core/services/worktree-setup.ts`, `src/main/quit-coordinator.ts`, `src/main/services/quit-worktree-removal.ts`, `src/renderer/src/lib/worktree-start.ts`, `src/shared/worktree-start.ts`, `src/shared/worktree-fold.ts`, `src/shared/claude-project-delete.ts`

The integrated terminal (xterm.js in the renderer over node-pty in main): when it stays mounted, how tabs group, what
closing a tab does, and how the phone mirrors it; and git worktrees: the inventory and removal that delete user files,
detection for every engine, and starting a session in a worktree. The remote `shell` capability and step-up are
ADR-052/ADR-054 (remote-access.md); the mobile surface pattern is ADR-048 (ui.md); the transcript a worktree session
moves (home project, locate by id) is ADR-077 (persistence-and-settings.md).

## The terminal panel stays mounted (ADR-002)

`SessionView` always mounts `TerminalPanel` and toggles a wrapper between `display: contents` (open) and
`display: none` (closed); it never conditionally renders it. Unmounting disposes each `XTermInstance`, which destroys
the scrollback and unsubscribes `onTerminalData`, so output emitted while the panel was closed is lost. Kept mounted,
the scrollback survives, listeners stay subscribed and `onTerminalExit` keeps cleaning up exited shells while the
panel is hidden. The cost is each hidden terminal's scrollback memory. Tabs inside the panel use the same
`display: block/none` pattern.

## Terminal tabs group by session cwd, and orphaned groups are reaped after 10 minutes (ADR-003)

Terminal state is `terminalGroups: Record<cwd, { tabs, activeTabId }>` with the cwd normalised (trailing slash
stripped). Switching sessions swaps the visible tab set; sessions sharing a cwd share a group; each group remembers
its active tab; `setActiveTerminal(id, cwd)`. All xterm instances of all groups stay mounted (ADR-002), hidden with
`display: none`. State is in memory only and never persisted.

**Cold cleanup.** `useTerminalColdCleanup` (mounted in `SessionView`) starts a 10-minute timer (`COLD_TIMEOUT_MS`)
for a cwd that has a terminal group but no session; when it fires it calls `killTerminalsByCwd(cwd)`
(`terminal:kill-by-cwd`, `PtyManager.killByCwd`, a `shell`-class verb) and removes the group. A session reappearing
cancels the timer. A cwd counts as held by a session's workdir (`sessionWorkdir`, so a session in a worktree keeps
its terminals alive, ADR-114) and by its spawn cwd. A group with every tab closed still gets a timer, because
closing a tab detaches and a shell can still be running behind it (ADR-062). The sweep only reaps cwds with no
session, never the directory being worked in.

## Closing a terminal tab kills the shell; detaching is the modified action (ADR-062)

Terminals are a shared per-cwd pool: one pty, several attached viewers. The unmodified close kills; the modifier
guards the safe half. Built in `TerminalTab.tsx`, `TerminalMobileView.tsx` and `TerminalPanel.tsx` (`handleCloseTab`).

- **Desktop.** Plain click on the tab's × kills the pty then closes the tab (tooltip "Close (kill) - Shift-click to
  detach, right-click for more"). Shift-click detaches only. The right-click menu lists "Kill shell" (danger) then
  "Detach (keep shell running)". There is no confirm step: it would guard the exact action a plain click performs.
- **Mobile chip.** The chip's × kills. On a read-only surface (ADR-054: reads allowed, act window decayed) it
  detaches instead, with the title saying the shell keeps running, because the act gate would refuse the kill.
- **The kill is sequenced and a refusal keeps the tab.** `terminal:kill` first; the tab is dropped only once it
  resolves. `needs-step-up` on the web surface marks the act refused and opens the ceremony; any other error is
  logged and the tab stays. There is deliberately no fallback to a detach: a tab that vanished while the process kept
  running makes "I stopped it" false. Killing an already-gone id resolves without error, so a shell that died on its
  own still closes cleanly.
- **The safety property is sequencing, not modifiers**: a close never lies.
- **Does not move.** `closeTerminalTab` in the store stays a pure tab-state drop (a store action that killed would
  also fire on detach and on non-user callers). The pool/attach/replay machinery, the re-attach badge and
  `terminal:pool`, window-close `killAll` and the panel-level dismissal (back button or panel ×, which kills nothing)
  are unchanged. No capability or main-process change: the kill is an act-class verb (`shell`).
- **Accepted.** A second attached viewer can lose its shell to someone else's plain click: the pty's own `exit`
  reaches every attached surface, and the clicker is the person who wanted it stopped.

## The phone mirrors the pty's grid, pans it, and scrolls by touch (ADR-060)

A narrow Electron window runs the mobile fork too, so everything below applies to it. The phone stops competing for
the pty's width, because resize is last-writer-wins on a shared pty (clamping to the smallest viewport, tmux
`aggressive-resize off`, makes the desktop unusable; letting the phone win smeared PSReadLine repaints).

- **Geometry is on the wire.** `PtyManager` tracks `cols`/`rows` (`sizeOf`); `resize()` reports whether the grid
  changed. A real change fans a `resized` notice to attached remote connections as the server-to-client frame
  `term-resized { termId, cols, rows }` on the volatile lane (output class: no gate, no ring, no audit; a
  reconnecting client re-reads the grid from its attach reply), and raises the host-local `terminal:resized` event.
  The client-to-server `term-resize` keeps its meaning. `terminal:attach` answers `{ ok: true, cols, rows }`
  (`{ ok: false }` for a gone terminal) on both lanes.
- **Spawn default is 100x30** (`DEFAULT_PTY_COLS` / `DEFAULT_PTY_ROWS`): the phone never pushes cols, so a pty it
  created keeps that width, and 80 is unusable for a PowerShell prompt plus a path.
- **Mobile sizing: mirror cols, push rows** (`XTermInstance` `mirrorGrid`). On attach it resizes to
  `(ptyCols, fittedRows)` and pushes only when the rows differ; nothing is pushed before the attach reply (xterm's
  80-column default would shrink the desktop). Own-box changes push rows only. The desktop fits both axes and ignores
  the event. **A notice whose cols are unchanged is not acted on at all**: that is the termination argument; without
  it two mirroring surfaces of different heights counter-push forever. Residual accepted: after a rows-only change
  elsewhere each surface renders its own rows (the pre-existing last-resize-wins contract in sync-core.md).
- **Touch scroll by synthesised wheel events** (`terminal-touch-scroll.ts`). A one-finger vertical drag becomes
  `WheelEvent`s at the element under the touch: 8px slop before the gesture is claimed (a tap stays a tap and raises
  the keyboard), then every `touchmove` is `preventDefault`ed; no momentum. xterm 6 scrolls by wheel only, and
  reusing its wheel path gives scrollback, the alt-buffer wheel-to-arrow conversion (pagers, vim), DECCKM encoding
  and mouse reporting for free. The arrow keys go through `Terminal.onData`, so the ADR-054 read-only gate applies
  with no extra code. **The event must be shaped like a real wheel**: `wheelDeltaY = -deltaY x 1.2` is installed
  explicitly, because Chromium's default synthetic `wheelDeltaY === deltaY` has the opposite sign and the two xterm
  read paths would disagree. `deltaY = -2 x fingerTravel` makes content track the finger 1:1. An xterm bump can
  change the gain or sign; the header comment names the upstream code that decides both.
- **Horizontal pan container** (mobile only): a wrapper with `overflow-x: auto`, `overflow-y: hidden` and
  `touch-action: pan-x` around the grid. The browser owns horizontal panning, the handler owns vertical, and its
  axis lock stops a diagonal from fighting the pan.
- **Version skew** is handled in one direction: a pre-060 host answers attach with `true` and never sends
  `terminal:resized`, and the client falls back to fitting both axes.
- Alt-buffer scroll speed is xterm's (0.3x factor under 50px of delta); changing it would mean reimplementing the
  machinery this design reuses. Rejected: scrolling through `term.scrollLines()` or arrow injection (re-derives
  three encodings and keeps them in step forever; the documented fallback if xterm starts rejecting untrusted
  wheel events); a per-surface pty (the shared pool is the feature).

## Worktree inventory and cleanup delete only what is proven removable (ADR-112)

Worktrees pile up (every arc, Claude Code's `isolation: "worktree"` subagents, opencode's own). Removal deletes user
files, so every rule below is a safety rule; none may be relaxed to make a delete succeed. Code:
`worktree.ts`, `worktree-fs.ts`, `worktree-holders.ts`, `worktree-root.ts`.

### 1. Inventory

Per repository, from the project's menu (a visible ⋯ button on touch). It lists every linked worktree
`git worktree list --porcelain` reports, wherever it lives, plus orphan folders directly under
`<repo>/.claude/worktrees/`. Each entry carries its kind (worktree, orphan, missing), location (`managed`,
`opencode`, `other`), branch or detached, and lock; it shows what holds it (live and cold sessions, X-Agents,
terminals, matched by path containment lexically and by real path) and loads size, uncommitted files, commits found
nowhere else and newest modification lazily. Entries are addressed by their normalised path and **re-resolved against
a fresh inventory on the server: nothing the client sends is trusted as a boundary.** Rejected: only
`<repo>/.claude/worktrees` (opencode's would be invisible); git's registration plus the backlink proves membership
wherever a worktree lives.

### 2. What can be removed

- **Allowed:** a linked worktree of this repository whose `.git` file and git's `gitdir` record point at each other
  (backlink), or a direct child of a verified, non-linked `<repo>/.claude/worktrees`.
- **Never:** anything equal to or containing the repository root, its common dir, the home directory or a filesystem
  root.
- **Orphans:** a folder that is itself a checkout, or belongs to another repository, is refused; an orphan holding
  real files counts as dirty.
- **Refused:** a worktree held by a live session, running X-Agent or live terminal (holders re-checked just before each
  entry), a locked worktree, and one that contains another entry unless that entry is removed with it (inner entries
  go first). A row containing others can be selected only together with them. Rejected: stopping the holders and then
  removing (a larger blast radius than naming the holder).
- **Allowed after a confirmation listing what is lost:** dirty worktrees and worktrees with commits found nowhere
  else. "Select safe" (which replaces the selection) excludes both and anything modified in the last 10 minutes.
- **Missing** (registered, folder gone) is inspected like any other: its detached HEAD or branch may hold the only copy
  of some commits, so it is safe only with none. Only a provably absent path (ENOENT/ENOTDIR) counts as gone; an
  unreadable path fails its removal and is never handed to git.
- The manager cannot be closed while a removal runs and the background size scan stops for it. Removal is serialised
  per repository (lock key is the canonical common dir). Removed rows stay on screen with their result until refresh.

### 3. How it is removed

A **link-safe walk** runs first: links and junctions are unlinked and never entered, read-only entries are retried
writable, locked entries are collected. The walk removes everything but `.git`, then the `.git` file and the root (the
pointer is put back if the root cannot go, so the entry still verifies and a retry works). A partial walk leaves the
entry registered, listed and retryable. Only after the folder is provably gone does `git worktree remove --force
<path>` run, purely to unregister, and it is skipped if the path has reappeared. **`git worktree prune` is never run**:
it is repo-global and would drop other prunable entries. Every check (registration, lock, live holders, real path
unchanged, backlink) is repeated immediately before each walk. Residual risk accepted: Node has no no-follow
`openat` walk, so a folder swapped for a junction between check and walk is narrowed by the real-path recheck, not
closed.

### 4. Branches

A branch is deleted only when every commit on it is reachable from another branch, a remote-tracking ref or a tag
(`rev-list --count refs/heads/<b> --not --exclude=<b> --branches --remotes --tags`). Otherwise it is kept and
reported, as are `main`, `master`, the current and default branch and a branch checked out elsewhere. It is also kept
if its tip moved after the count (taken before the walk), or could not be read. This holds for every removal path. A
kept branch costs no disk. Rejected: always deleting or always keeping branches.

### 5. Other removal paths

- The session-delete prompt goes through the same routine, including the holder check.
- The quit prompt removes the chosen worktrees in the main process after sessions and engines are torn down, so no
  engine holds them; the before-quit fallback timer does not cut it short. The renderer acknowledges the prompt is
  showing, and the coordinator then drops its 5-second fallback (so a user taking time to decide never gets a silent
  "keep all"); the fallback still covers a hung renderer. At quit, holders (sessions, background X-Agents,
  terminals) are stopped first, then a busy directory is retried after 0.75, 2 and 5 seconds, within a 120-second
  bound (`quit-worktree-removal.ts`, `quit-coordinator.ts`). The quit path only forgets entries and never re-lists
  projects, so nothing spawns an engine after teardown.
- **Both prompts offer only worktrees ClaudeUI created** (`WorktreeInfo.origin`): a detected worktree may be the
  user's own long-lived one. The server enforces the same rule, so a crafted call cannot remove anything else through
  them.

### §6 Detection, every engine

- A project group carries `linkedWorktree` when its directory is a linked git worktree, read from the filesystem
  (`.git` file, `gitdir`, `commondir`) without spawning git (`worktree-root.ts`). Every engine's session in such a
  directory shows the worktree mark (the branch pill shows it in a worktree). Rejected: marking from the folder name
  `.claude/worktrees` (misses opencode's worktrees; fooled by a non-repository path containing that name).
- Claude Code's four `EnterWorktree` result variants (Created, Entered, Reused, Resumed; the text quotes path and
  branch) are parsed tolerantly with the tool input as a fallback; `ExitWorktree` clears the entry. There is no rule
  dropping a detected entry when the status `cwd` (which never changes for any engine) equals the original directory.
- opencode's durable `session.moved` marks or clears the session's worktree; the session's own `cwd` (its identity) is
  unchanged. Its permissions follow its location: ClaudeUI leases the new directory, re-checks the plugin guard there
  and rebuilds the ruleset (moves come from ClaudeUI's `claudeui_enter_worktree` / `claudeui_exit_worktree` tools,
  docs/protocol-opencode/README.md "Worktree moves"). pi never changes directory.
- **A detected entry is recorded only when its worktree belongs to the same repository as the session's spawn
  directory**, because the entry widens `session_start`'s allowed roots.
- **The sidebar folds** each marked worktree group under its parent repository's group, synthesising the parent when
  it has none, in the view only (`worktree-fold.ts`; the listing stays one group per directory, so permissions,
  proposals and markers are unchanged). Delete project and Hide project act on the folded group and the server derives
  the same set from the listing (`projectScope`). **A synthesised parent never removes the repository's
  `~/.claude/projects/<key>/` folder** (Claude Code's per-repository memory lives there), nor does a key the listing no
  longer knows or a worktree's own key: their sessions' files go one by one, and a worktree's key folder only when
  empty. Live sessions belong by directory, not by the lossy key. Worktree folders are never touched. What a project
  delete removes in full is under ADR-077 (persistence-and-settings.md).

### 7. Remote parity

Every worktree verb is declared once for both transports under the `git` capability (the same as discard and remove).
Removal and size reports use per-call progress, which also keeps the web client's invoke alive during large deletes.
Each removal is logged with path and outcome, because audit rows carry no arguments.

Known gaps, not bugs: a Claude Code agent that `cd`s into a worktree is neither marked nor seen as a holder (no wire
signal, issue #161); orphans in opencode's own root are not scanned and there is no cross-repository overview (issue
#162); opencode keeps a row for a removed folder until it refreshes; an outside tool (a VS Code serve-web tab) holding
files makes a delete partial, which is reported; at quit on Windows an engine's child processes can keep a directory
busy, so the removal ends `partial` and the leftover shows in the inventory next launch.

## New sessions can start in a worktree, created at the first send (ADR-114)

pi fixes its working directory at start and opencode's permission rules judge from the spawn directory, so a worktree
from the first message is the one route that works for every engine.

1. **Setting.** `startInWorktree` (Settings, Sessions & autonomy, Worktrees; absent means off) plus a per-project
   override `worktreeByProject` (Use default / Always / Never, keyed by the sidebar project key, set from the
   project's menu; the project value wins). Both are app settings (replicated, readable on the host, same on the web
   client). The new-session toggle starts from the effective value and decides for that one session; a session whose
   directory is already under `.claude/worktrees/` starts with it off (`shared/worktree-start.ts`).
2. **Created at the first send**, not when the directory is picked, so an abandoned session leaves nothing behind.
   Once per session; a second send while it runs is ignored; a colliding auto-generated name is re-rolled (up to
   three attempts), a typed one is not. **A failure holds the message**: nothing spawns, the draft is kept, with Retry
   and "Send without a worktree". ClaudeUI never silently falls back to the main checkout. `worktree:create` reports
   progress so the web client's invoke timeout does not cut a slow fetch short.
3. **Base is the remote's default branch** for the toggle and the setting: `git fetch origin` (15 s timeout, never
   prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), then `origin/<default>` verified with
   `rev-parse --verify`; the branch is created `--no-track` (otherwise a plain push targets the default branch). It
   falls back to HEAD without a remote, on a failed fetch or when `origin/HEAD` is dangling. `session_start`'s own
   `worktree` option keeps HEAD (an agent mid-arc wants its current state). Rejected: branching from a parked main
   checkout's HEAD for the setting.
4. **Set up like Claude Code**, every step best-effort (`worktree-setup.ts`): a relative `core.hooksPath` (husky v9's
   `.husky/_`, gitignored, so absent in a fresh worktree) is pinned to the absolute path it means in the main
   checkout, written to the shared config as Claude Code does (unset, absolute and `~/` values are left alone);
   `.claude/worktrees/` is added to the repository's `info/exclude` unless already ignored; `.worktreeinclude`
   (gitignore syntax, read from the main checkout) copies untracked, gitignored files, entering ignored folders only
   when a pattern can reach them, skipping symlinked sources and destinations that are links or that a committed
   link redirects outside the worktree, and copying nothing under `.claude/worktrees/`. Accepted: a repository
   opened under another path spelling (WSL `/mnt`, a devcontainer, a moved checkout) loses husky hooks there.
5. **The session's working directory follows its worktree.** `sessionWorkdir` gives the worktree path when the
   session works in one (Claude `EnterWorktree`, opencode `session.moved`), otherwise the spawn `cwd`; a session
   spawned in a folder inside a worktree keeps that folder. The git pills, git panel, terminal (its group key,
   above) and VS Code button use it; in a worktree the VS Code button opens it and also offers the parent
   repository. `cwd` itself is unchanged for spawn, permissions and the sidebar.

Known gaps: on macOS/Linux Claude Code resolves a worktree's local settings to the main checkout while ClaudeUI uses
the worktree's copy (issue #175); an agent cannot move a pi or opencode conversation into a worktree mid-session
(issue #186).
