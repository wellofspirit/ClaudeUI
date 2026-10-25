# ADR-110: pi file tools are contained to the workspace, a switched-off judge asks like Ask, and session allows never stand in for the judge

**Status:** Accepted (2026-10-25). Implemented on branch `fix/pi-automode-holes`.
**Amends:** [ADR-035](adr-035_pi-engine-backend.md) (the bridge extension fails closed without its credentials; path
rules are evaluated on the path pi opens), [ADR-084](adr-084_read-only-judge-bypass.md) §3 (the agent-control list now
includes Claude Code's sensitive files and directories, and may hold multi-component entries; on pi an allow rule no
longer silences such an edit, §7a), [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) (the same: on pi
the sensitive-edit ask sits above the allow tier, §7a),
[ADR-088](adr-088_dispatch-autonomy-inheritance.md) (a pi dispatch target whose judge is switched off asks like
`default`, not allow-all), [ADR-089](adr-089_pi-subagents-host-run.md) (`Agent`/`Task` rules match pi's `agent` tool).
**Relates to:** [ADR-050](adr-050_auto-mode-as-the-default-autonomy.md), [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md),
[ADR-091](adr-091_judge-blocks-hold-and-session-local-targets.md), [ADR-097](adr-097_opencode-v2-only.md) (opencode's
`external_directory` ask), [ADR-108](adr-108_dispatch-workdir-and-target-judge-context.md) (a target's scope).

## Context

pi has no sandbox and no permission system of its own; ClaudeUI gates every pi tool call through the bridge
extension's `tool_call` hook and its own permission ladder (`src/core/pi/permission-engine.ts`). Five gaps against
Claude Code and against ClaudeUI's opencode integration:

1. **No path containment.** `read`, `edit`, `write`, `grep`, `find` and `ls` reached the mode base with the path
   unexamined. Reads were allowed at any path in every mode but plan; edits and writes at any path in Accept Edits
   and in auto mode (whose base is Accept Edits) — only agent-control paths asked. A read of `~/.ssh/id_rsa` or a
   write to `~/.bashrc` ran with no prompt and no judge call. opencode asks for every out-of-workspace path
   (`external_directory`); Claude Code contains file tools to the working directory and its additional directories.
2. **A switched-off judge allowed everything.** With `autoMode.enabled: false`, pi's `auto`/`full` kept an
   allow-everything base, while the settings copy promised Ask-like prompts and opencode gates like `default`.
3. **Session allows could silence the judge.** "Allow for this session" was keyed by the bare tool name (except
   bash) and consulted before the judge, so one click on any `edit`, `agent` or MCP card would have skipped the judge
   for every later call of that tool. No desktop card offered the button, but the IPC and remote clients accept it.
4. **An inert bridge ran ungated.** Without `CLAUDEUI_PI_BRIDGE_URL`/`TOKEN` the extension registered nothing, and
   pi runs every tool ungated when no `tool_call` handler exists. (A _failed_ extension load already makes pi exit
   in RPC mode.)
5. **`Agent`/`Task` rules never matched pi.** The rule table had no row for them, and the spawn shortcut for `agent`
   honoured only deny verdicts.

## Decision

### 1. Path containment (pi's path tools only)

The **workspace** is the session's directory and the user's `permissions.additionalDirectories` (resolved against
the directory of the settings that list them), plus — as Claude Code's internal allowances, not roots — the
session's **scratchpad** (read and write) and the project's temp directory (read). The rest of the OS temp
directory is outside. Claude Code 2.1.308 has no whole-temp root (`hE()` = cwd + additional working directories;
the scratchpad and project temp are allowlist entries in its read and write paths).

**Placing a path.** The ladder resolves a call's `path` exactly as pi 1.4.0 will (`utils/paths.ts`: unicode
spaces, one leading `@`, Git Bash / MSYS / WSL drive forms on Windows, `~`, `~/`, `file://`, then
`resolve(sessionCwd, p)` — never the host process's drive), and for `read` picks the same file-name fallback pi
picks (AM/PM, NFD, curly quote). It then takes the real landing: the deepest existing ancestor's realpath with the
missing tail appended. A path whose landing cannot be determined (permission denied, a link loop, a dangling link
anywhere in the chain) is **unresolved**. A **network path** — UNC, WebDAV (`\\host@SSL\DavWWWRoot`),
`file://host/…`, any `\\?\` or `\\.\` form (the local `\\?\C:\…` and `\\.\PhysicalDrive0` too: refused wholesale,
nothing legitimate needs them; their card says "a device or extended-length path", not "a network path") — or a
path that reaches one through a link is **never touched**: the gate makes no `exists`, `realpath` or
`lstat` call on it (those would open an SMB/WebDAV connection and send the user's NTLM credentials to a host the
model named, before any decision), walks the local ancestors with `lstat`/`readlink` only, and treats a link whose
target is a network path as unresolved. A network path listed as an additional directory is not probed either.

The POSIX counterpart is the **automount and kernel-redirect namespaces**: `/net/<host>/…` (the autofs `-hosts`
map: a DNS lookup and an NFS mount of whatever host the model named — macOS and Linux autofs alike) on every POSIX
platform and, on darwin, `/Network/…` (the directory-service browse surface) and `/.vol/…`, `/.file/…`,
`/.nofollow/…`, `/.resolve/…` (paths the macOS kernel redirects by volume or file id, which can land on a network
mount). They are classified from the **spelling alone** — the first component of the resolved path, case-insensitively
(macOS volumes are case-insensitive; on Linux the folding only over-asks), `.`/`..` folded, zero-width and bidi
control characters ignored — so they are `unresolved` and `remote` with no `exists`, `realpath` or `lstat` call, for
every tool and on every spelling (the `read` fallback variants, an additional directory, a root). The link walk
(`lstat` and `readlink` only) now runs on POSIX too, and a link whose target text reaches one of these
namespaces is unplaceable before any `realpath`. The walk follows a link the way the kernel does and never folds a
`..` by text: the target's raw text is judged first, its components are spliced in front of the parts still to walk
unnormalised, a `..` is the parent of the prefix reached so far (every prefix before it is known not to be a link),
and every new prefix is checked again. Folding the target up front would take `/net/h/../../tmp` for `/tmp`, or
`a/../b` with `a -> /net/h/q` for a sibling of `a`, and the later `realpath` would then open `/net`. That kernel
order is POSIX only. On win32 the walk refuses what it cannot place. The target's raw text is judged first (`\\…` and
`\??\…` are remote, a DOS device component is a device), and a target whose root is neither empty (relative) nor `X:\`
is unplaceable before any further call: the NT object paths libuv returns unchanged (`\Device\…`, `\GLOBAL??\…`,
`\DosDevices\…`, `\GLOBALROOT\…`, `\Sessions\…`, `\Windows`) and drive-relative `D:foo` are `unreadable`. A **relative
target that contains a `..` component** is `unreadable` too. Windows folds a `..` in a symlink target as text against
the link's directory, but a junction keeps its own spelling (mount-point semantics), and `readlink` returns the same
`X:\…` text for both, so which directory a `..` climbs to depends on a link kind the walk cannot read. With `w\J` a
junction to `real0` and `real0\s -> ..\b` the OS reads `w\b`; with `J` a symlink it reads the folder above `real0`; and
`realpath` could follow a link the walk never read. A relative target without a `..` only descends from the link's
physical parent directory, and that directory is the same under every junction or symlink reading, so it is folded as
text against the link's directory, checked for a UNC result and walked from the root of the result. An absolute `X:\…`
target is folded the same way (`D:\o\q\..\r` is `D:\o\r`): it names its target outright, so there is no link directory
for the two readings to disagree about. The over-ask is a relative `..` symlink on Windows, which is rare (it needs the
symlink privilege, or git `core.symlinks`). Claude Code's own walk follows-then-climbs on win32 too, which we
deliberately do not mirror there. The walk mirrors Claude Code
2.1.308 (`cli.js`) on two fronts. Its permission check `vze` asks, as a
defence-in-depth check on the path and on every resolved spelling of it, for a path "under the /net automount
map" (`Mw`: bare `/net`), "under /.vol, /.file, /.nofollow or /.resolve" (`Rb`: first component, case-insensitive,
`.`/`..` folded), and for a UNC path; in that bundle the standalone `Ka` and `nM` predicates are compiled to
`return false`, so those are its live checks. The rest live in `Iy` (`Pqe`: `/net/<host>` and
`/Network/Servers/<host>`; `iD`: `/Network`), which `Xv` calls inside Claude's link walk, on the text of each
link target. We merge the two sets into one spelling check; its scope of `/Network` and the `/.vol` family to darwin
is a deliberate narrowing (Claude applies them on every platform; on Linux they are ordinary directory names).
Claude also tests its Glob tool's `pattern`; pi's `grep` `glob` and `find` `pattern` are filters over the searched
`path`, never roots, so only `path` is gated here. Claude's `trustedNetworkDirectories` exemption has no counterpart:
the ask is the whole answer. A session whose own directory is under one of these asks on every call.

A link chain the gate cannot read — `lstat` or `readlink` failing with anything but "no such entry" (EACCES, EPERM,
…), or more than 40 hops — is unresolved too, with no `realpath` and the generic "could not be determined" card; it
no longer ends the walk as if nothing past it were a link, and it is no longer called a network path.

Every spelling — the resolved path and its landing — must lie inside a
root (roots are compared by their lexical and real spelling; Windows case-insensitively, UNC never against a
non-UNC root). grep, find and ls without a `path` search the session directory; their patterns are filters, not
roots.

**Decisions**, after deny rules (which match every spelling, landing included; ask rules do too, §7b) and before everything else:

- A write or edit whose leaf is a symbolic link (or junction) is **denied** in every mode, with Claude Code's
  message ("Refusing to write …: it is a symbolic link. Write to the link's target path instead").
- With `permissions.blockReadsOutsideWorkingDirectories: true` (any settings scope), a read or search outside the
  workspace is **denied** in every mode; additional directories that only project settings list do not count for
  it (as Claude Code). A path that cannot be placed is denied too, and the text says why in the human-only card's
  words (a network path, a device) rather than only "could not be determined".
- After the ask tier: an **unresolved** path (every network path included) asks the human for a read and for a
  write alike. A path with a Windows **DOS device** component (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
  `LPT1`-`LPT9`, the superscript forms `COM¹ COM² COM³` / `LPT¹ LPT² LPT³`, `CONIN$`, `CONOUT$`, with or without an
  extension, a trailing colon or spaces) is unresolved too: it is placed from its
  spelling alone, with no filesystem call (opening a device touches hardware), and asks the human for a read as well.
  Windows 11 opens `aux.ts` or `con.js` as an ordinary file; the extension rule still asks for them (it is
  older Windows' behaviour and asking is the safe side).
  So is a path through a link whose target text has such a component (`NUL`, `..\CON.txt`, `NUL\..\src`): the link
  walk judges the target before it looks at it.
  A Windows path form that can name another object (trailing dot or space, `:` streams, `...` runs) and an edit
  whose landing a link carried outside the workspace **ask the human for edits and writes only**. All of these ask
  in every mode — never the judge. A _read_ of one of those last forms is not human-only: it takes the outside-read
  row of the table below. The card for such an ask offers no "always allow" suggestion.
- Otherwise the mode base:

| mode                                              | read/search inside | read/search outside | edit/write inside                 | edit/write outside |
| ------------------------------------------------- | ------------------ | ------------------- | --------------------------------- | ------------------ |
| Ask (`default`); `auto`/`full` with the judge off | allow              | ask                 | ask                               | ask                |
| Accept Edits                                      | allow              | ask                 | allow; agent-control path → ask   | ask                |
| Plan                                              | allow              | ask                 | deny                              | deny               |
| `auto`/`full` with the judge on                   | allow              | **allow**           | allow; agent-control path → judge | judge              |

Reads outside the workspace are not judged in auto mode: Read/Grep/Glob are in Claude Code's classifier-safe set,
and judging every outside read would spend a judge call on each. Claude Code's one-time interactive "outside read"
prompt is not reproduced; `blockReadsOutsideWorkingDirectories` is the control. The scratchpad is writable in
every mode but plan; agent-control names inside it still ask (stricter than Claude Code).

**Pinning.** An allowed path-tool call is returned to pi with `path` replaced by the path that was checked (pi's
hook may rewrite the tool input, which `execute` then uses without re-validation), so a drift between ClaudeUI's
copy of pi's resolution and pi's own can only cost an extra prompt, never open another file. pi re-resolves
whatever it is given, folding unicode spaces across the whole string — a working directory or home with a U+3000 or
U+00A0 in it included — so the pin ladder is: (1) the absolute path when pi's own resolution of it returns it
unchanged; (2) else the working-directory-relative spelling when that round-trips **and does not start with `..`**
(pi resolves a relative path against `process.cwd()`, the _physical_ directory on POSIX, while the gate resolved it
against the logical working directory, so a spelling that climbs out of the cwd can reach another parent when the
cwd is, or sits under, a link); (3) else the model's own spelling, unpinned, only if pi resolves it to the checked
path, it is not a relative spelling that climbs above the cwd after normalisation, it is not drive-relative (`C:x`),
and on Windows it is not rooted-driveless (`\x`, `/x`) — `~/x`, `file://` and absolute spellings qualify;
(4) else the call is **denied** (never an ungated path). For `read`'s file-name fallbacks the resolved spelling is pinned and pi
re-derives the variant. pi's transcript keeps the model's spelling. A call that waited on a human is placed again before it runs; if anything
that decided the verdict changed, it is denied ("the path changed while awaiting approval"); a missing leaf that has
appeared at the same landing is not a change.

**Boundary.** This is a permission gate, not a filesystem sandbox: a link swapped in between the check and pi's
open, and a hard link to a file outside the workspace, are outside what it can see. Mapped network drives (`net use`,
`subst`, `DefineDosDevice` onto `\??\UNC\…`), and links to them, are not detected: they are the user's own mappings, and
telling them apart from a local drive would need a call on the drive. The link walk that keeps network and device
paths untouched is defence in depth behind the judge: it covers direct spellings and ordinary link chains, but exotic
Windows junction/symlink combinations are best-effort, not a guarantee. Shell commands are not
contained (as in Claude Code); they go to the judge in auto mode and to the human otherwise.

**Who gets it.** pi sessions, their host-run subagents (the parent's workspace) and pi dispatch targets (the
target's directory plus ADR-108's scope). The ladder applies containment only when the caller passes a scope;
Codex shares the ladder and passes none, so its behaviour is unchanged (it keeps its own `insideWorkspace`).
`bypassPermissions` ignores the scope.

### 2. Scratchpad

Each pi session gets `<realpath(tmpdir/claudeui-<uid>)>/<project-key>/<session-key>/scratchpad` (project key = the
directory with non-alphanumerics replaced by `-`, capped with a hash; session key stable across resume). Every level
is created `0700` and checked to be a real directory — not a link or junction — owned by the current user on POSIX;
any failure leaves the session without a scratchpad rather than trust a preplanted path. On POSIX the base carries the
uid (`claudeui-<uid>`, as Claude Code's `claude-<uid>`), so a second local user is not locked out by the first
one's `0700` directory; on Windows it is `claudeui`. The main agent, its
subagents and pi dispatch targets are told the path through `--append-system-prompt`, with an instruction to use
it instead of `/tmp`. It is deleted when the session is deleted.

On Windows the directories are not owner-checked (there is no uid to compare): the per-user `TEMP` is assumed to be
private to the user. A temp directory or home whose path holds a unicode space that pi folds (U+3000, U+00A0, …)
makes the scratchpad unreachable by its absolute path — pi folds that spelling to a different directory, which is
outside the scratchpad, so the call is judged as the outside path it then is (an ask, never an allow). It fails safe.

### 3. A switched-off judge asks like Ask

The ladder takes the user's effective mode and whether a judge is on. `auto`/`full` with the judge on decide from
the Accept Edits base with allow rules stripped (unchanged); with it off they decide from the `default` base with
the user's full rule set — the user's allow rules are how they stop being asked. A pi dispatch target keeps its
allow-free target rules. A caller that passes no judge flag (Codex) keeps the raw mode's base.

### 4. Session allows never stand in for the judge

Under a judged auto mode a session allow does not answer for sub-agent launches, messages, unclassified tools,
agent-control edits, or paths outside the workspace or unresolved. pi's edit/write session allows are scoped to
one resolved path, and so are its read, grep, find and ls session allows (`read:<path>`; a search without a `path` is
keyed by the working directory): one click on a file outside the workspace is not a standing allow for the disk.
Codex's keys are unchanged.

The "always allow" suggestions on a card follow the verdict. A call that asked only because its target is outside
the workspace suggests path-scoped rules — `Read(//<dir>/**)` for a read (the file's directory), `Edit(//<dir>/**)`
for an edit or write, the searched path and its contents for grep/find/ls (`//` marks an absolute path in the rule
grammar) — never the bare tool rule; none is offered where there is nothing safe to scope (a filesystem root, a
glob character in the name). An edit or write card inside the workspace (Ask mode: edits ask) suggests
`Edit(//<root>/**)` for the narrowest workspace root (the working directory or an additional directory, spelled as
the user spells it) that holds where the call lands — never the bare `Edit`/`Write`, which would be a standing
allow for every file the tool can reach, the ones outside the workspace included; a bash card keeps its prefix
rule. These cards offer **none**: an edit or write on an agent-control path (inside the workspace or out), a
human-only card, and a card raised by a user ask rule. Each is asked before the allow tier, so a saved allow could
never silence the card; it would only widen what other calls may do.

### 5. The bridge refuses to start without credentials

The extension throws before registering anything when its URL or token is missing; pi reports the failed load and
exits 1, and the session error quotes pi's diagnostic (credential-free). Bridge version 25.

### 5a. Rule kinds

As in Claude Code, an `Edit(...)` rule governs every file change (pi's `edit` and `write`) and a `Read(...)` rule
every read of the file system (pi's `read` and the path of `grep`/`find`/`ls`), in every tier; `Write`, `Grep`,
`Glob` and `LS` keep their own tools. A rule on a directory also holds for a search whose root is that directory.
(opencode folds `Write` into `edit` and keeps its search tools apart from `read`; Codex's file changes are edit
or write calls, so an `Edit` rule now covers both there, which is Claude's reading too.)

### 6. `Agent`/`Task` rules

`Agent`, `Task`, `Agent(<type>)`, `Task(<type>)` match pi's `agent` tool only (not `dispatch_agent`, not
`send_message`); the specifier is a case-sensitive glob over `subagent_type` (default `general-purpose`). Deny and
ask verdicts both bypass the spawn shortcut, so an ask rule raises a card in every mode (in auto, the human, never
the judge).

### 7. Agent-control list = ours ∪ Claude Code's

The shared list (`automode/agent-control-paths.ts`) adds Claude Code 2.1.308's sensitive directories (`.idea`,
`.cargo`, `.yarn`, `.mvn`, `.config/git`) and files (git config, shell rc and profile files, package-manager,
runtime, build-tool and hook-runner configs, wrapper properties, `pyrightconfig.json`). A directory entry may span
components (`.config/git`); the predicate, the opencode edit patterns, the redirect scanner and the allow-rule glob
guard read it from the one table. opencode and Codex Accept Edits now ask for these names too, and more shell-write
globs (`*.toml`, `*rc`) skip allow rules — both toward asking.

### 7a. A sensitive edit asks before the allow tier (pi)

In Claude Code 2.1.308's write-permission check the sensitive-file safety check runs after the session allows and
the ask rules but **before** the acceptEdits allow and before the settings allow rules, so an allow rule never
silences an edit of an agent-control path. pi's ladder follows it: with a path scope, an edit or write whose
agent-control match holds on any spelling of the path (the model's, the canonical one, the link landing), in every
mode but plan and bypassPermissions, **asks** after the session-allow rung and before the allow tier — the judge in
a judged auto mode (`mode-base`), the person everywhere else, in the workspace or out. Deny rules still deny.
Before this, a user's `Edit(.claude/**)` allow rule (or a bare `Edit`) wrote there unasked in Ask, Accept Edits and
auto with the judge off. A human's own "allow for this session" click is still honoured outside the judge (the card
for a sensitive edit offers none). Codex and any caller without a scope are unchanged: the allow rule still wins.

### 7b. Rules match where the call lands; "always allow" suggestions follow

With a path scope, rules meet the path like this. **Deny and ask rules match every spelling** of it (the canonical
path pi opens, the model's own spelling, the symbolic-link landing): more asking is the safe side. **An allow rule
matches where the call really lands** — the landing when there is one (resolved or missing leaf), else the canonical
path — never the spelling of a link, which can be re-pointed: `Read(//repo/lnk/**)` no longer allows a read through
`lnk`, and `Read(//elsewhere/**)` does when `lnk` lands in `/elsewhere`. The suggestion on an outside-workspace read
or search (`Read(//dir/**)`, plus `Read(//dir)` for a search) names that same landing directory, so the rule a card
saves silences the next read through the same link. A caller with no scope (Codex, the session tools'
deny check) matches the one spelling it always did.

The landing also counts **under the logical spelling of a scope root that is itself reached through a link**: for
each root whose real path contains the landing, the landing is re-expressed under the root's own spelling (cwd
`/logical` -> `/physical`: the landing `/physical/src/a.ts` also counts as `/logical/src/a.ts`). It is the same
physical file, spelled the way the user's own rules spell it, so a cwd-relative `Edit(src/**)` keeps working in a
project directory reached through a link (macOS `/tmp` -> `/private/tmp`, a symlinked `~/code`) and never widens
to another file. The raw spelling of a link inside the workspace is never a fallback.

## Consequences

- In Ask, Accept Edits and Plan, a pi read outside the workspace now raises a card. In ClaudeUI's own git worktrees,
  `node_modules` and `vendor` are junctions into the main checkout, so reads there ask outside auto mode (Claude
  Code behaves the same); an issue tracks it.
- Auto mode spends judge calls on edits outside the workspace and on the extended sensitive names, and none on
  outside reads.
- A pi started without the bridge credentials no longer runs; the case was never a supported launch.
- A workspace that itself lives under one of these namespaces (a project at `/net/<host>/…` or on a UNC share) asks
  on every call and has no way out; Claude Code's `trustedNetworkDirectories` is the counterpart, and an exemption
  for the session directory's own `/net/<host>` or `\\host\share` prefix is tracked in issue #163.

## Alternatives considered

- **Judge every outside read in auto** (opencode's effective behaviour): safer against exfiltration-by-read, but a
  judge call per read; Claude Code's choice was followed, with `blockReadsOutsideWorkingDirectories` as the control.
- **The whole OS temp directory as a root**: rejected — Accept Edits would overwrite other applications' and other
  sessions' temp files unprompted, and Claude Code does not do it.
- **Containment inside `modeBaseDecision` for every caller**: rejected — Codex shares the ladder and has its own
  workspace check.
- **A handshake proving the bridge loaded**: unnecessary once an inert load is impossible; pi already exits on a
  failed load.
