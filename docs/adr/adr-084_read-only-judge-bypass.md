# ADR-084: Plainly read-only shell commands skip the auto-mode judge; repo-armed git config and edits to agent-control paths do not

**Status:** Accepted (2026-09-29). Built on branch `harnesses` in the 3.6 line.
**Amends:** [ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) (a static path in
front of the judge), [ADR-022](adr-022_opencode-permission-mapping.md) (the auto-mode base ruleset
gains edit asks for agent-control paths).
**Relates to:** [ADR-023](adr-023_opencode-automode-classifier.md),
[ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (Trust & protection gains a row).

## Context

In auto mode ClaudeUI strips the user's allow rules from the engine ruleset, so every bash call
reaches the judge: about 1.5 s when stage 1 clears it, 5–7 s when it goes to stage 2. About 30 % of
the owner's 784 historical opencode bash calls are plainly read-only (`git status`, `git diff`,
`Get-ChildItem`, `Select-Object`, `ls`, `rg`). The owner ruled that such commands may skip the judge,
**but only when they don't affect others**. PowerShell must be supported: neither harness can be
pinned to one shell, remote-machine tasks are planned, and some users are on Windows.

Prior art, verified at source:

- **Claude Code 2.1.280** allows read-only commands before its classifier. For Bash it keeps
  per-command tables of _allowed_ flags with a typed argument. For PowerShell it parses with
  PowerShell's own AST, and keeps per-cmdlet safe-flag and path-parameter tables. A pipeline passes
  only if every element does.
- **Codex up to 0.140** had `is_safe_command.rs` and `windows_safe_commands.rs`. Bash commands were
  checked against allowlists, git's dangerous global and subcommand options were refused, and so
  were `rg --pre` and `find -exec`. PowerShell was checked by cmdlet name only. 0.156 removed both
  in favour of its sandbox and guardian.
- Neither checks where a read goes or whether it exposes a secret. That part is ours.

A design consult (Fable, two rounds) found the pitfalls by probing git 2.55, pwsh 7.6.6, WinPS 5.1
and Git-for-Windows coreutils:

- flags that execute or write: `rg --pre`, `git --output`, `git blame --contents`, `sort -o`,
  `uniq IN OUT`;
- PowerShell syntax: a lone CR separates statements, `env:` provider paths, comma lists, globs
  that apply even when quoted, smart quotes and en-dashes as live syntax;
- the unknowable shell dialect, and opencode's per-call `workdir`;
- bash backslash handling, where `cat .e\nv` reads `.env`;
- **repo-local git config that turns `git diff` / `git status` into code execution** with no flags
  at all (`diff.external`, textconv, `filter.*.clean`, `core.fsmonitor`). A cloned repo can arrive
  armed like this, and the judge allows these commands without seeing the config;
- auto mode's opencode base (`{*: allow}` for edits) lets the agent **edit `.git/config`,
  `.claude/` and hooks without any review**, which arms the above.

## Decision

### 1. A static read-only path in front of the judge

A pure module, `src/core/automode/read-only.ts`, exports
`readOnlyVerdict(action, scope) → { ok: true, summary, needsGitCheck } | { ok: false, reason }`.

- **Placement.** Both engine wirings call it right after the existing category fast path and before
  the judge is set up. It is not inside `classify()`. It runs even when no judge model resolves.
- **On `ok` it:**
  - allows the call;
  - logs one info line, `auto-mode allow (stage=static) bash — read-only: …`;
  - puts a `tool_review` block with a fixed rationale on the card.
- **On `ok` it does not:**
  - call `recordAllow()`, so a static allow never resets the denial cap;
  - write a usage row.
- Refusal reasons go to the debug log, and the allowlist grows from them.
- **"Plainly read-only"** is decided from the text alone and fails closed.
  - _Token rules:_
    - no expansion, substitution, grouping or redirection (only the exact `2>&1`);
    - no backgrounding;
    - no CR, LF, NUL or DEL;
    - no Unicode quote, dash or space look-alikes;
    - no `VAR=` prefix, and none of `eval`/`source`/`exec`;
    - no provider or scheme tokens (`^[A-Za-z]{2,}:`), no UNC paths;
    - no unbalanced quotes.
  - _Segments:_ split at unquoted `| || && ;`. Every segment must pass.
  - _Allowlists:_ every segment names an allowlisted command. Every flag must be in that command's
    **typed flag allowlist**; anything unlisted refuses the whole command.
- **Both dialects.** Because the shell is unknowable, a path token must be safe under **both** the
  bash reading (backslash as escape) and the Windows reading. PowerShell aliases (`ls`, `cat`,
  `type`, `dir`, …) apply the intersection of the two meanings. There is no PowerShell parser
  dependency; anything outside the literal subset goes to the judge.
- **The allowlist is small, about 25 tables sized to observed use.** It grows from the refusal log.
  - Commands: `pwd echo wc cat head tail grep rg find ls date`.
  - git: `status log diff show branch(list) rev-parse ls-files merge-base remote(bare|-v)`, with
    global options only `--no-pager -P --no-optional-locks`.
  - PowerShell: `Get-ChildItem Get-Content Select-String Test-Path Get-Location Get-Command`, plus
    the pipe formatters `Select-Object`, `Where-Object` (comparison form), `Measure-Object`,
    `Format-Table`, `Write-Output`, `Write-Host`.
  - Refused by name: `sed awk xargs jq env printenv`, network tools, interpreters.
- **"Doesn't affect others."**
  - _Scope:_ every path resolves inside the session cwd or the user's `additionalDirectories`. That
    means against `input.workdir` when set, which must itself be in scope, and then `realpath` via
    an injected capability (no realpath, no bypass). Temp roots are not in scope.
  - _No network:_ URLs, UNC paths and `git remote show` are refused.
  - _No secret-shaped file:_
    - matched on path components, case-insensitive on every platform: `.env*`, key and cert
      stores, `.ssh .aws .kube .docker .gnupg`, `.npmrc .pypirc .git-credentials .netrc`, history
      files, `*.tfstate`/`*.tfvars`, `auth*.json`, credentials, secrets;
    - also `.git` itself (`.git/config` holds URL credentials);
    - the user's `Read(...)` deny rules on the resolved path;
    - `Bash(...)` deny and ask rules re-checked per segment, since pi's matcher is a prefix on the
      whole command.
- **Opt-out.** `readOnlyBypass: false` in `automode.json`, one row under Trust & protection. It is on
  by default.

### 2. No git bypass in an armed repo; the judge sees it too

When the verdict has `needsGitCheck`, the caller runs `git config --list --show-scope --includes`
(`shell:false`, about 25 ms) and keeps only the `local | worktree | command` scopes. The user's own
global config, such as difftastic as `diff.external`, is theirs.

- It refuses the bypass on any of: `diff.external`, `diff.*.command`, `diff.*.textconv`,
  `filter.*.clean|smudge`, a non-boolean `core.fsmonitor`, `core.hooksPath`, `gpg.program`,
  `gpg.*.program`, `log.showSignature`, `core.pager`, `pager.*`.
- A failed capture also refuses.
- The same capture feeds the judge a `{"meta":{"gitConfigArmed":[…keys]}}` line for git commands, so
  the judge no longer allows `git diff` in an armed repo blind.

### 3. Edits to agent-control paths go to the judge

In auto mode, file edits under these paths raise an ask instead of being auto-accepted, so the judge
sees them (Self-Modification, Instruction Poisoning, and Unauthorized Persistence, which now names
the repo git config keys that execute programs). This matches `cli.js`, which treats these as
sensitive for its acceptEdits fast path.

The list lives in one pure module, `src/core/automode/agent-control-paths.ts`, which both engines
use:

- directories, matched as any path component at any depth: `.git` (also as a file, which is what a
  linked worktree has), `.claude`, `.husky`, `.githooks`, `.vscode`, `.devcontainer` (VS Code tasks
  can run on folder open), `.opencode`, `.pi`, and `.agents` (pi's Agent Skills);
- files, matched as the last component: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `AGENTS.override.md` (pi's replacement for AGENTS.md), `.mcp.json`, `opencode.json`,
  `opencode.jsonc`, `.devcontainer.json`.

The matcher does not trust the spelling:

- case folds on every platform;
- `\` and `/` are the same;
- an ADS suffix (`CLAUDE.md:x`) and trailing dots or spaces are dropped;
- any component shaped like an 8.3 short name (`GIT~1`) matches.

A path is resolved against the session cwd. Inside cwd it is matched relative to cwd, so a session
in `<repo>/.claude/worktrees/<name>` does not match `.claude` on every edit. Outside cwd it is matched
absolute, so `../../settings.json` from that worktree still matches the parent repo's `.claude/`.

- **pi** checks the path in its `acceptEdits` mode base, which is also auto mode's base. A matching
  edit asks: the judge in auto mode, the human in plain `acceptEdits`. **Codex** shares pi's
  evaluator, so a file change Codex escalates to a control path now asks in `acceptEdits` too.
- **opencode, plain `acceptEdits`/`autoEdit`:** the list is rendered into `edit` ask patterns after
  the base rules, and the human is asked. The rules are matched by opencode's own `Wildcard.match`.
- **opencode, auto mode:** the ruleset asks for every edit. `handleAutoModeApproval` then runs a
  host-side gate after G9 and the read fast path. The gate collects every target the ask names:
  - its patterns;
  - the edit/write path;
  - apply_patch move destinations, which opencode leaves out of the patterns.

  If the matcher clears all of them, it replies `once` with no judge call. A control path, or a
  target it cannot determine, goes to the judge.

## Consequences

- About 29 % of historical bash calls skip the judge, saving about 1.5 s each. On Fable's 49-case
  adversarial corpus the design gives 0 wrong verdicts; the first draft gave 38.
- The bypass gives up the judge's reading of chat boundaries and `judgeBlock` guidance for these
  reads. Ask rules (`Bash(git log:*)`) remain the precise tool, and the settings copy says so.
- **Accepted residuals:**
  - `Get-ChildItem -Recurse` follows an in-tree junction, but lists names only.
  - Committed secrets are reachable by blob SHA, since repo content is in scope by definition.
  - In the non-auto modes, a human "allow for session" on one control-path edit allows every later
    edit in that session (opencode's `always` on `edit *`, pi's bare `edit` session key). It is the
    human's own choice. The judge always replies `once`.
  - Paths are matched by text, so a symlink into `.git/` is not seen.
  - Non-auto opencode off Windows matches the rendered patterns case-sensitively, because
    `Wildcard.match` folds case on win32 only. Auto mode does not depend on those patterns.
  - opencode's bash path sources `~/.bashrc` with aliases enabled, which is the user's own doing.
- The realpath and git-config captures must run where the command executes. That is the host today;
  for remote tasks it will be the remote host. The module stays filesystem-free so it can move with
  the core.
