# Permissions: modes, rule ladders and path containment

Governs: `src/core/permissions/`, `src/core/pi/permission-engine.ts`, `src/core/pi/pi-path-scope.ts`, `src/core/pi/pi-scratchpad.ts`, `src/core/pi/PiSession.ts`, `src/core/opencode/permission-v2.ts`, `src/core/opencode/permission-compiler.ts`, `src/core/opencode/host-precheck.ts`, `src/core/opencode/session-allows.ts`, `src/core/opencode/broad-bash-globs.ts`, `src/core/opencode/subagent-permissions.ts`, `src/core/automode/allow-rule-skip.ts`, `src/core/automode/allow-rule-gate.ts`, `src/core/automode/agent-control-paths.ts`, `src/core/services/claude-settings.ts`, `src/core/services/dispatch-pi-targets.ts`, `src/core/services/dispatch-opencode-targets.ts`, `src/core/services/dispatch-claude-targets.ts`, `src/core/services/cross-engine-dispatcher.ts`, `src/shared/permission-modes.ts`

What a session may do without asking, on every engine: the four autonomy modes and the default a new session
starts in, how the user's Claude permission rules (`allow`/`ask`/`deny`, `additionalDirectories`) are shared and
compiled per engine, the deny/ask-always ladder with plan mode on top, the auto-mode allow-rule judge skip, and pi's
path containment, scratchpad and judge-off behaviour. The judge itself (stages, read-only bypass ADR-084, judge-block
holds ADR-091, policy ADR-083) is `auto-mode-judge.md`. Claude's own auto-mode verdict on the wire (ADR-076) is
`claude-engine.md`. The opencode 2.x wire shape of the rulesets (`{action, resource, effect}`, child rulesets, the
`claudeui-xeng` tighten-only hook, ADR-097 §3) and opencode subagents (ADR-111) are `opencode.md`. pi subagents
(ADR-089) are `pi.md`. Dispatch-target autonomy (ADR-088) and a target's workdir scope (ADR-108) are `dispatch.md`.

## Auto mode is the default autonomy, set by ClaudeUI (ADR-050)

Four neutral autonomy modes (`plan | ask | autoEdit | full`) map to Claude permission-mode strings
(`plan | default | acceptEdits | auto`) in `src/shared/permission-modes.ts` (`AUTONOMY_TO_PERMISSION`,
`PERMISSION_TO_AUTONOMY`); that file is the single source for both directions. `full` is labelled "Auto mode
(default)", never "Full auto": it is classifier-gated, not approve-everything. The `bypassPermissions` mode has no
session-level equivalent in ClaudeUI.

1. **`settings.defaultAutonomyMode`** is a ClaudeUI-owned, engine-neutral setting defaulting to `full`
   (`DEFAULT_AUTONOMY_MODE`): the mode new sessions start in on Claude, opencode and pi. The Settings picker reads
   and writes it and never touches `~/.claude/settings.json`, so ClaudeUI and the bare `claude` CLI may disagree
   about the startup mode on purpose. ClaudeUI passes `--permission-mode` explicitly on every Claude spawn, so
   cli.js's own default never applies.
2. **Claude's `permissions.defaultMode` seeds it exactly once.** Absence of the setting's key (not a falsy value)
   marks a pre-upgrade profile; the seed is persisted at once so a later edit of Claude's file never re-seeds over a
   deliberate pick (`session-store.ts`). A profile that pinned `defaultMode` keeps it (a pinned `default` keeps manual
   approvals and must opt into auto in Settings, deliberately); a `defaultMode` with no ClaudeUI equivalent
   (`bypassPermissions`, `dontAsk`) seeds the default instead, which only ever de-escalates.
3. **Auto is gated at session creation, not at spawn** (`bootstrapPermissionMode`): for a Claude session `auto`
   degrades to `default` when `autoModeAvailableForEngine()` says it may not be in auto: the account cannot do it
   (the model fetch says no model supports it) or Claude settings carry `disableAutoMode: "disable"`. Both gates are
   Claude's. The opt-out is Claude Code's own setting and binds Claude sessions only (2026-11-12, ratifying the scope
   the code had): opencode and pi implement auto themselves and are not governed by Claude's settings file, so they
   start in auto and are offered Auto with the flag set. The gate applies to every path that starts a Claude run
   (new, reopened, forked, cleared, an engine switch before the first prompt), to the mode picker (2026-11-12:
   Shift+Tab and the mobile sheet no longer offer Auto to a Claude session with the flag set; before, cli.js refused
   the pick with a warning) and to a Claude session the session tools start, a stored proposal included. The
   post-spawn rejection fallback stays as the backstop.
4. **`disableAutoMode`** is read from user-scope Claude settings both nested under `permissions` and at the top
   level (cli.js honours both) and normalised into one field; `saveClaudePermissions` round-trips the on-disk nested
   value so a permission edit never drops an admin-authored flag. The Claude page of Settings turns it on and off
   (2026-11-12; ADR-009: `saveClaudeDisableAutoMode` edits Claude's file in place, and the new value reaches every
   client at once as `config:claude-auto-mode-changed`). A running session keeps the mode it has: ClaudeUI changes
   none, and cli.js re-reads its rules on a settings change but not the mode, so the flag binds a Claude session
   from its next run while new runs and the picker follow it at once. A full managed/enterprise policy read is not
   done. The flag reaches remote clients as `autoModeDisabledBySettings` (they cannot read the file).
5. **All three engines default to auto, judge cost included.** The cost is accepted because the judge fails closed:
   no judge, an unavailable judge or an unparseable verdict all degrade to asking the human, never to approval, and
   read-only calls skip the judge. The block caps (3 consecutive, 20 total, plus a same-category cap) are in
   `automode/denial-tracker.ts` (see `auto-mode-judge.md`).

## One set of user rules, a mode-to-ruleset mapping per engine (ADR-022)

The user's configured Claude permissions (`ClaudePermissions`: `allow`/`ask`/`deny` `Tool(specifier)` strings plus
`additionalDirectories`, merged from the user, project and local scopes, edited in the existing permissions dialog) are
the one rule source for every engine; there is no second store. Claude consumes them natively; pi evaluates them in
`permission-engine.ts`; opencode gets them compiled (`permission-compiler.ts` parses `Tool(specifier)`,
`permission-v2.ts` composes the session ruleset). A deny rule is never something an autonomy mode may bypass
(pinned by `permissions/__tests__/permission-conformance.test.ts`).

opencode has no mode enum: autonomy is (agent, session ruleset), last match wins, so a user rule placed after the
mode's gates outranks them. Today's mapping (`modeGates` in `permission-v2.ts`; the 2.x shape is ADR-097 §3):

- The session ruleset only **tightens**; there is no `{*: allow}` baseline (each agent starts from its own), so a
  subagent's own narrowing survives. Order: mode gates, then the user's rules (compiled allow, then ask, then deny, so
  deny > ask > allow as in Claude), then plan enforcement, hidden-tool denies, the dispatch and session-tool asks.
- `default` (also `ask`, `bypassPermissions`, and `auto` with the judge off): shell, edit, webfetch (and
  `experimental_image_generate`) ask; reads and the `task`/`subagent` tool stay unasked, so no subagent-spawn prompt.
  MCP tools also run unasked outside auto unless a user rule says otherwise (the agent's own baseline leaves them
  unasked; ADR-085 §3 kept that), whereas pi's default base asks for MCP: a decided difference, not a parity bug.
- `acceptEdits`/`autoEdit`: shell and webfetch ask; edits ask only for agent-control paths (ADR-084 §3).
- `auto` with the judge on: every edit, shell, webfetch, websearch, skill, subagent spawn and every MCP tool asks, so
  every call reaches the host; ClaudeUI clears ordinary edits host-side (agent-control gate) and the judge reads the rest.
  ClaudeUI's own `claudeui_*` hosted tools stay allowed (dispatch and session tools keep their own asks).
- `plan`: shell/webfetch ask; edits, image generation and the `general` subagent are denied server-side after the
  user's rules (`planEnforcement`), robust against saved allows; read-only subagents such as `explore` still work. The session runs opencode's own
  `plan` primary agent (`buildSessionRuleset` returns `agent: 'plan'`); opencode's plan-file edit allow-list
  (`.opencode/plans/*.md`) is deliberately not reproduced, so the plan agent cannot write a plan file.
- `external_directory` asks in every mode, opencode's own directories allowed first; the user's
  `additionalDirectories` become `external_directory` allows after it.
- The renderer's `TaskCard` shows a pending approval for a task call (Allow/Deny), so an ask on `task` can never
  hang silently.

"Always allow" write-back: a ticked Claude-format suggestion on an opencode approval persists the rule through
`saveClaudePermissions` (shared store, visible in the permissions UI, reapplied at the next spawn) and answers the live
ask `once`; ClaudeUI never replies `always` (ADR-085 §3).

## Deny and ask rules hold in every mode on every engine; plan mode wins; narrow allow rules skip the judge (ADR-085)

A user's deny/ask rule means the same on claude, opencode and pi, in every mode, for the session's own calls, for
subagents and for dispatch targets, matched by effect (reordered, wrapped, chained, quoted) rather than by text.
Binding rulings:

1. Auto mode: allow rules skip the judge with Claude Code parity (strip only cli.js's classifier-bypassing shapes)
   plus the safety checks of §4.
2. MCP rules skip at tool and server level.
3. **Deny and ask rules are always respected, in every mode.** Deny refuses; ask goes to the human, never the judge.
4. opencode subagents follow the PARENT session's rules and mode for every gated tool.
5. Non-auto allow behaviour is otherwise unchanged, except pi's allow tier is operator-aware like the others.
6. Plan mode wins (ruling 7 below, §3b).
7. In plan mode, edits/writes and non-read-only commands are refused regardless of allow rules, ask rules and session
   allows (opencode and pi); allow rules still apply to read-only tools.

### §1 One robust deny/ask matcher

`src/core/permissions/shell-rules.ts` (pure, never throws). `denyAskHit(command, {deny, ask})` over-approximates: a false
hit costs one prompt or one clear refusal, a miss lets a command the user said "never" run. A command it cannot
analyse is an ask.

- **Rules.** `Bash(spec)`: `x:*`, trailing ` *`, `*` are prefix; else exact (treated as prefix for deny/ask). Program
  = basename, lower-cased, `.exe` stripped; a word with `*`/`?` is a shell glob whose `*` does not cross `/`.
- **Segments.** A permissive quote-aware tokenizer run twice, bash quoting and PowerShell quoting, a hit in either
  counts. Boundaries: unquoted `&& || ; | &`, CR/LF, `( ) { }`, `<<<`; every `$( )`, backtick, `<( )`, `>( )`,
  `@( )` body is its own segment; heredocs are data unless their command runs them.
- **Program positions.** Token 0 of a segment; after shell keywords and wrappers (`sudo doas xargs env nohup time
nice command builtin exec timeout stdbuf busybox`, their flags and `K=V`, PowerShell `&`); path-qualified and
  quoted spellings; anywhere in the tail of `ssh host`, `docker exec c`, `chroot dir`. Deliberately NOT any position of
  a plain segment: `echo rm -rf`, `git rm -rf dir` and `ls -la rm` do not hit `Bash(rm -rf:*)`.
- **Quoted-content rescan.** Every quoted token is re-split and scanned with the program allowed at any position
  (`sh -c "…"`, `pwsh -Command`, `cmd /c`, decoded `-EncodedCommand`, a script spawning `["git","push","--force"]`),
  minus the data operands of data programs (`echo`, `printf`); depth-capped. A commit message quoting a denied command
  is therefore refused (the model rephrases).
- **Words.** Every rule word matches some later token in any order with any gap (`git -C . push`); `--long` and
  `--long=…`; abbreviations; short clusters as letter sets (`-rf` = `-fr` = `-r -f`); the last word of a prefix rule
  is a prefix only when it begins with `-` (`docker run:*` does not hit `docker build -t runtime`); a small
  program-scoped synonym table (`git push --force` = `-f` = `+refspec` = `--force-with-lease`; `git branch -D`;
  `rm -r`/`-R`/`--recursive`; `rm` and `Remove-Item` and their aliases). Union with the plain text match.
- **Cost.** Linear per rule word, bounded depth and token budget; past 64 KB the command is scanned flat (still
  over-approximate, never skipped). Synchronous on the main process.
- **Allow coverage** (`allowCovers`) under-approximates, in two strengths. **Lenient** (the non-auto allow tier)
  requires every segment of both readings and every substitution body to be covered, allows redirections and data
  heredocs, and lets a rule whose text is the whole command cover it as written. **Strict** (the auto-mode skip, §4)
  uses ADR-084's two-dialect lexer and refuses redirections, newlines, `$` and every construct the dialects split
  differently. Both are word-boundary prefix or exact, case-sensitive, un-normalised (`Bash(git:*)` does not cover
  `git-lfs`; `Bash(bun run test:*)` does not cover `bun run test:unit`).
- **Predicates for §4:** `isClassifierBypassingRule` (cli.js parity over the Bash and PowerShell launcher lists;
  `Agent`/`Task`/`Monitor`/`AppifactRepl`), `isCarvedOut` (same program and one rule's positional words are a prefix of
  the other's, both directions: `git:*` contains `git push --force`), `canLaunchOtherPrograms`,
  `isLauncherShapedSegment` (a segment that runs code its own words do not show: `npx`, `bunx`, `bun x|run|-e`,
  `node -e`, `python -c`, shells with `-c`/`-Command`/`-EncodedCommand`/`/c`, `eval`, `exec`, `env`, `xargs`, `sudo`,
  `ssh`, `docker exec|run`, `git -c`, `find -exec`, `sed … e`, `awk system(`, the PowerShell launchers).

### §2 Host-side enforcement on every path a call reaches the host

Order for a shell call: §1 deny refuses with `Denied by your permission rule <rule>` (a `permission_denial` block on the
card, `source: 'rule'`); §1 ask goes to the human, never the judge; then the engine's own path.

- **pi** (`permission-engine.ts` `decideWithSource`; the dispatcher's pi targets share it): the rungs in order are deny,
  then the containment fences (ADR-110), plan (§3b), hosted auto-allow, ask, human-only path asks, session allow, the
  sensitive-edit ask, allow, and last the mode base. The Bash allow tier is lenient per-segment coverage (every `$(`, backtick, `<(`, `>(` body too).
  `mcp__server__*` is server-level (cli.js). A deny/ask hit on a Bash command with an unanalysable shape asks.
- **opencode** (`host-precheck.ts` `hostPrecheck`, walked by `OpencodeSession.routePermissionAsk` for own and
  child asks before the auto/human split): §1 deny, then the user's compiled deny by glob (rung 1b), then the plan
  refusal (§3b), then §1 ask and the user's ask rules by glob (the union is deliberate), then the host session-allow
  set, then (plan only) a user allow covering a plan-read-only command, then continue (judge in auto, else the card).
  Scopes are read fresh per ask, so a settings edit binds the next ask. An internal failure answers ask, never allow.
- ADR-084's read-only checker re-checks Bash deny/ask rules through §1, so the bypass and the ladders cannot disagree.
- **Dispatch targets:** opencode and pi targets get the user's deny/ask rules (never allow rules; ADR-033, and
  ADR-108 for the union of the dispatcher's and the target's directories); Claude targets get
  `settings.permissions.{deny, ask}` (cli.js honours them even under `bypassPermissions`) plus §1 in
  `awaitClaudeTargetApproval`. Target CHILD sessions are registered so their asks are forwarded and never park.

### §3 Engine-side first lines: an engine-side allow never beats a deny/ask

- **opencode broad globs** (`broad-bash-globs.ts`): every Bash deny/ask compiles to its verbatim pattern plus
  over-approximating globs (program anchored at a token start, the rule's words in order with `*` gaps, cluster
  permutations, token-anchored synonyms; capped), in every mode and after the allows, so a broader user allow
  (`Bash(git:*)`) or a session approval cannot outrank a narrower deny/ask. Glob-word rules keep their verbatim form;
  host §1 covers other word orders for anything that asks.
- **Session approvals** (`session-allows.ts`): ClaudeUI never replies `always`, because the server's saved-allow table
  is shared across chats, subagents and dispatch targets of a project and outranks asks. A per-`OpencodeSession` allow
  set keyed by the ask's own `always` patterns (the arity prefix plus ` *` for shell) is consulted AFTER §1 deny/ask
  and replies `once`; after an addition the chat's pending asks it now covers are answered. Dispatch-target opencode
  replies `once` too. There is no cross-chat allow.
- **opencode MCP rules** compile to opencode permission keys through opencode's own sanitiser, never string surgery
  (`mcp__s__t` is `sanitize(s)_sanitize(t)`, `mcp__s`/`mcp__s__*` is `sanitize(s)_*`); a server-level ALLOW needs a
  server in the live set (bridged Claude servers, `claudeui`, `GET /api/mcp`) and is never emitted when it would match
  a built-in action; a server-level deny/ask also covers that server's MCP-resource actions. Auto mode asks for every
  MCP tool. A compiled MCP deny hides the tool from the model.
- **opencode subagents (ruling 4):** the child runs under the parent's whole ruleset, so a child ask is answered by the
  parent's current rules (allow, refuse with the rule, or the card/judge, which is told the call came from subagent
  `<type>`); `subagent-permissions.ts` restores the child agent's own wholly-denied actions (details in ADR-097 §3).
- **Plan mode on opencode:** no `edit`/`shell`/`subagent` allow reaches the server (`withoutMutatingAllowRulesV2`),
  so those asks always reach the host.
- **Plan wording:** opencode has no `exit_plan` tool, so its plan refusal reads "Plan mode is read-only — present the
  plan and ask the user to leave plan mode to proceed"; pi keeps `exit_plan`.
- Rejected: replying `always` to keep opencode's native memory (cross-chat leak, outranks deny/ask).

### §3b Plan mode wins (ruling 7)

In plan mode edits/writes and non-read-only commands are refused regardless of allow rules, ask rules and session
allows, on opencode and pi; allow rules still apply to read-only tools; a user deny stays first (more specific reason).
One oracle for every engine, `isPlanReadOnlyCommand` = the UNION of pi's plan-safe list and ADR-084's read-only checker
(so PowerShell readers work on Windows); the checker's scope is cwd + additionalDirectories + the user's deny rules
only. On opencode a non-plan-safe command is refused even with no allow rule, and a plan-safe command a user allow
covers is answered `once` host-side. On pi the plan rung sits right after the deny rung. The opencode refusal carries
`source: 'mode'` and `TaskCard` renders it.

### §4 Auto mode: narrow allow rules skip the judge

One shared gate in the hosts (`allow-rule-skip.ts` pure, `allow-rule-gate.ts` engine glue), placed AFTER ADR-084's
read-only bypass and BEFORE the judge is resolved, so it holds even when no judge model does. The engine rulesets still
strip every allow in auto (`withoutAllowRules`, `withoutAllowRulesV2`; `external_directory` allows stay) so every allowed
call reaches the host; the judge environment keeps listing the allow rules (ADR-083 §3).

- **Usable rule.** Unusable when `isClassifierBypassingRule` says so, when user settings carry
  `autoMode.classifyAllShell: true` and the rule is a shell rule, when it would cover the dispatch tool
  (`mcp__claude-ui-collab…`, `mcp__claudeui…`), or, shell rules only and only while any Bash deny/ask exists, when
  `isCarvedOut` names a deny/ask rule it is broader than: `Bash(git:*)` is unusable beside `deny Bash(git push
--force:*)`; `Bash(git status:*)` is usable.
- **Coverage (strict).** Every segment under both readings of ADR-084's lexer must be covered by a usable rule, and
  the command must not hit §1. Anything the strict lexer refuses goes to the judge.
- **Safety checks** (beyond cli.js):
  - a **launcher-shaped segment** is covered only when the rule NAMES what the launcher runs (`Bash(bun run test:*)`
    covers `bun run test --watch`; `Bash(bun:*)` over `bun x foo` does not); wrappers are looked through; shells with
    `-c`/`-Command`/stdin, `node -e`, `python -c`, `docker|podman|kubectl exec|run`, `git -c`, `find -exec`, executing
    `sed`/`awk`, `eval`, `exec`, `source`, `&`, `iex` and the PowerShell launchers are never covered;
  - **write targets** of `rm rmdir Remove-Item` (and aliases), `mv cp touch mkdir tee` (and PowerShell forms),
    `find … -delete`, `sed -i` must pass ADR-084's path rules at every program position: inside cwd +
    additionalDirectories, no secret-shaped component (`rm -rf .git`, `touch .env`), no agent-control target
    (`agent-control-paths.ts`), the user's `Read` deny rules, realpath. Globs are allowed as operands but a glob with a
    literal part may not match a secret-shaped name; deleting a scope root or everything in one (`rm -rf .`, `rm -rf *`,
    `find . -delete`, a `mv` whose source is a root or `*`) goes to the judge; `find -delete` name filters may not be
    secret-shaped, agent-control or glob-only;
  - a **destructive git subcommand** is covered only when the rule NAMES it (`reset --hard`, `clean -f`, `checkout`
    with pathspecs/`--`/`-f`/`-B`, `restore`, `switch -f`, `branch -D|-M|-C`, `stash drop|clear`, `push` with force,
    `--delete`, `--mirror`, `--prune`, `+refspec`, `:refspec`, `rebase`, `filter-branch`, `update-ref -d`, `reflog
expire|delete`, `gc --prune`, `worktree remove -f`, `tag -d`, `remote remove`, `submodule deinit`), found past git's
    global options at every program position; `Bash(git:*)` never names one. Non-destructive forms stay covered;
  - the user's **`Read(...)` deny rules** bind the path arguments of readers (`cat head tail less more type
Get-Content gc grep rg Select-String sls`). Readers get no other scope check: an allow rule is explicit consent to
    read outside the workspace (cli.js parity).
- **Non-shell.** `WebFetch` (bare or `domain:d` by hostname or subdomain), bare `WebSearch`, `Skill`/`Skill(name)`, and
  MCP rules at tool and server level. On opencode the ask's key is translated back through the known server set: exactly
  ONE known server's `sanitize(s)_` may prefix the key, else the server is unknown and it goes to the judge. File
  tools are unchanged (an agent-control edit always sees the gate/judge); `edit`, `task`, `doom_loop`, `read` and
  `external_directory` asks never take this path. A task child's ask takes it with the parent's rules.
- **On allow:** reply allow; the card carries a `tool_review` block (reviewer `auto-mode`, approved, rationale
  `Allowed by your permission rule <rule>`); one info line `auto-mode allow (stage=rule) <tool> — <rule>` carrying the
  rule text, never the command, URL or query; no `recordAllow()` (a static allow never resets the denial caps); no
  usage row. The gate is synchronous, so no verdict outlives a mode switch.

Consequences. Over-refusal is the price in the named shapes: a commit message quoting a denied command, `echo … | (ls);
sh`, any pipe out of a data program into a compound, a command over 64 KB. Plan mode refuses more than the allow rules
alone would (non-plan-safe commands show no card). Every opencode ask costs three synchronous settings reads.

### §5 Residuals (decided, not worth code)

A reader reporting one of these as a bug is reporting a recorded limit.

- **Matcher misses:** text that becomes a command only at run time (`while read l; do $l; done`, `base64 -d | sh`,
  `rg --pre`, `$CMD`, shell/git aliases, scripts written earlier); cmd.exe `^` escapes and `.cmd` shims; past the length cap
  the flat scan does not decode `$'…'` or `--%`; script runners by cli.js parity (`make`, `npm test`, `bun file.ts`,
  `bash x.sh`, `tar --to-command`, `rsync -e`, `tmux`, `go run`) are not launcher-shaped.
- **Accepted over-refusals (pinned by tests):** a pipe out of a data program; a data write to a script/rc/hook/`.git/`/
  agent-control path; a pipe into a compound; a leading assignment (`FOO=1 git status`) is never strictly covered;
  `Bash(npx -y x:*)` is a launcher shape; a wrapper flag that may take a value makes both following words candidates;
  a glob over-refusal (`rm *.md`); a Windows absolute path with backslashes never skips; a reader with a glob operand
  goes to the judge whenever any `Read` deny rule exists (`cat *`); an `mv` destination flag spelled outside `-t`,
  `--target-directory` or `-Destination` is read as a source (the stricter reading); a pi `bash` call whose input carries
  a `workdir` or `cwd` never skips the judge.
- **Broad allows skip the judge by cli.js parity:** `Bash(curl:*)`, `Bash(gh:*)`, `Bash(git:*)` when no git deny/ask
  exists; a named launcher operand is trusted whole; readers under an allow are not scope-checked (only `Read` denies
  bind); `Bash(bun test:*)`-style script runners skip for the code those files hold; a subdirectory delete is not
  inspected for contents; git shapes outside the destructive table (aliases, `stash pop`, `commit --amend`, `merge`).
  The strict lexer unquotes, so `"git" status` is covered by `Bash(git:*)` (a deliberate deviation from cli.js's text
  prefix: the same program runs). A glob-only component is assumed not to match dotfiles (bash semantics) even under PowerShell.
- **opencode:** `webfetch`/`websearch`/MCP allow rules still beat the plan base (only `edit`/`shell`/`subagent`
  allows are withheld); a server-level MCP deny/ask over-matches built-ins when a server is named `external`, `doom`,
  `plan`, `workflow` or `apply`; a session allow on `edit *`/`webfetch *` is whole-category for that chat unless a user
  ask rule matches; a child ask card does not say it came from a subagent; opencode's own `plan_exit` question does not
  change ClaudeUI's mode (the wording tells the model to ask the user).
- **Plan-mode oracle:** commands neither pi's list nor the checker knows stay refused with no card (`cd src && ls`,
  `sed -n`, `bun run test`); the user's `Read` deny rules are not applied to plan-mode bash readers; the plan-safe
  list is quote-blind on chain operators (over-denies `grep "a && b"`) and bash-dialect only.
- **Claude dispatch targets under auto (`bypassPermissions`):** deny/ask are cli.js's own text-prefix matcher only.
- `PowerShell(...)` rules are cli.js's separate tool and are ignored here.

## pi paths are contained to the workspace, a switched-off judge asks like Ask, session allows never stand in for the judge (ADR-110)

pi has no sandbox and no permission system; ClaudeUI gates every pi tool call through the bridge extension's
`tool_call` hook and the shared ladder in `permission-engine.ts`. This section binds pi sessions, their host-run
subagents (the parent's workspace) and pi dispatch targets (the target's directory plus ADR-108's scope). Containment
applies only when the caller passes a scope (`ctx.scope`); `bypassPermissions` ignores it.

### Path containment (pi's path tools: read, edit, write, grep, find, ls) (ADR-110 §1)

The **workspace** is the session's directory and the user's `permissions.additionalDirectories` (resolved against the
directory of the settings listing them), plus two allowances that are not roots: the session **scratchpad** (read and
write) and the project's temp directory (read). The rest of the OS temp directory is outside (rejected as a root:
Accept Edits would overwrite other applications' and sessions' temp files unprompted).

**Placing a path.** The ladder resolves `path` exactly as pi will (unicode spaces, one leading `@`, Git Bash/MSYS/WSL
drive forms on Windows, `~`, `file://`, then `resolve(sessionCwd, p)`, never the host's drive), picks the same `read`
file-name fallback pi picks, then takes the real landing: the deepest existing ancestor's realpath plus the missing
tail. A landing that cannot be determined (permission denied, a link loop, a dangling link in the chain, more than 40
hops, an unreadable link) is **unresolved**.

**Network paths are never touched.** A network path (UNC, WebDAV, `file://host/…`, any `\\?\` or `\\.\` form, local
ones included, whose card says "a device or extended-length path") or a path reaching one through a link gets no
`exists`, `realpath` or `lstat` call (those would open an SMB/WebDAV connection and leak NTLM credentials to a host
the model named, before any decision). The gate walks local ancestors with `lstat`/`readlink` only and treats a link
whose target is a network path as unresolved. A network path listed as an additional directory is not probed. The POSIX
counterpart is the automount and kernel-redirect namespaces, classified from the spelling alone (first component of
the resolved path, case-insensitive, `.`/`..` folded, zero-width and bidi characters ignored): `/net/<host>/…` on every
POSIX platform and, on darwin, `/Network/…`, `/.vol`, `/.file`, `/.nofollow`, `/.resolve`. The link walk follows a link
the way the kernel does and never folds `..` by text (the target's raw text is judged first, its components spliced
in front of the parts still to walk, each new prefix checked again). On win32 the walk refuses what it cannot place:
NT object paths (`\Device\…`, `\GLOBAL??\…`, `\GLOBALROOT\…`) and drive-relative `D:foo` are unreadable, and so is a
relative link target containing `..` (a junction and a symlink read it differently; the over-ask is rare). A session
whose own directory sits under such a namespace asks on every call (no exemption; issue #163 tracks one).

Every spelling (the resolved path and its landing) must lie inside a root, compared lexically and by real path
(Windows case-insensitively, UNC never against a non-UNC root). `grep`, `find`, `ls` without `path` search the session
directory; their `glob`/`pattern` arguments are filters, not roots, so only `path` is gated.

**Decisions**, after deny rules (which match every spelling, landing included; ask rules too) and before everything else:

- A write or edit whose leaf is a symbolic link (or junction, or a dangling link) is **denied** in every mode with
  Claude Code's message ("Refusing to write …: it is a symbolic link. Write to the link's target path instead").
- With `permissions.blockReadsOutsideWorkingDirectories: true` (any settings scope), a read or search outside the
  workspace, or one that cannot be placed, is **denied** in every mode, nothing below lifting it; additional directories
  only project settings list do not count for it (Claude Code parity).
- After the ask tier, a **human-only** ask (never the judge, in every mode, no "always allow" suggestion): an
  unresolved path (every network path included) for read and write alike; a Windows DOS device component (`CON PRN AUX
NUL COM1-9 LPT1-9`, the superscript forms, `CONIN$`, `CONOUT$`, any extension, trailing colon or spaces, also through
  a link whose target text has one) placed from its spelling alone with no filesystem call (even though Windows 11 opens
  `aux.ts` as a file; asking is the safe side); for edits and writes only, a Windows path form that can name another
  object (trailing dot or space, `:` streams, `...` runs) and an edit whose landing a link carried outside the workspace.
  A read of those last forms takes the outside-read row below.
- Otherwise the mode base:

| mode                                          | read/search in | read/search out | edit/write in                    | edit/write out |
| --------------------------------------------- | -------------- | --------------- | -------------------------------- | -------------- |
| Ask (`default`); `auto`/`full` with judge off | allow          | ask             | ask                              | ask            |
| Accept Edits                                  | allow          | ask             | allow; agent-control path asks   | ask            |
| Plan                                          | allow          | ask             | deny                             | deny           |
| `auto`/`full` with the judge on               | allow          | **allow**       | allow; agent-control path: judge | judge          |

Reads outside the workspace are not judged in auto (Read/Grep/Glob are in Claude Code's classifier-safe set and a
judge call per read is too costly; rejected alternative: judge every outside read); `blockReadsOutsideWorkingDirectories`
is the control, and Claude Code's one-time "outside read" prompt is not reproduced. The scratchpad is writable in every
mode but plan; agent-control names inside it still ask (stricter than Claude Code).

**Pinning.** An allowed path-tool call is returned to pi with `path` replaced by the path that was checked, so a drift
between ClaudeUI's copy of pi's resolution and pi's own can only cost a prompt, never open another file. The ladder: the
absolute path when pi's own resolution returns it unchanged; else the cwd-relative spelling when it round-trips and does
not start with `..`; else the model's own spelling, only if pi resolves it to the checked path, it does not climb above
the cwd, is not drive-relative (`C:x`) and on Windows not rooted-driveless; else the call is **denied**, never ungated. A
call that waited on a human is placed again before it runs and is denied ("the path changed while awaiting approval") if
anything that decided the verdict changed (a missing leaf that appeared at the same landing is not a change).

**Boundary.** A permission gate, not a filesystem sandbox: a link swapped in between check and open, hard links to
outside files, mapped network drives (`net use`, `subst`) and exotic Windows junction/symlink combinations are outside
it. Shell commands are not contained (as in Claude Code): the judge in auto, the human otherwise. A caller that passes no scope gets no containment and matches the one spelling.

### Scratchpad (ADR-110 §2)

Each pi session gets `<realpath(tmpdir/claudeui-<uid>)>/<project-key>/<session-key>/scratchpad` (project key = directory
with non-alphanumerics replaced by `-`, capped with a hash; the session key is pi's own session id, stable across
resume). The base carries the uid on POSIX so a second local user is not locked out; on Windows it is `claudeui`. Every
level is created `0700` and checked to be a real directory (not a link or junction) owned by the current user on POSIX;
any failure leaves the session without a scratchpad rather than trust a preplanted path. On Windows the per-user `TEMP`
is assumed private (no owner check). The main agent, its subagents and pi dispatch targets are told the path through
`--append-system-prompt` and to use it instead of `/tmp`. It is deleted when the session (or the X-Agent) is deleted,
never before. A temp dir or home containing a unicode space pi folds makes the scratchpad unreachable by its absolute
spelling, so calls are judged as outside paths (an ask, never an allow: fails safe).

### A switched-off judge asks like Ask (ADR-110 §3)

The ladder takes the user's effective mode and whether a judge is on. `auto`/`full` with the judge on decide from the
Accept Edits base with allow rules stripped; with it off they decide from the `default` base with the user's full rule
set (their allow rules are how they stop being asked). opencode gates a judge-off auto like `default`. A pi dispatch
target keeps its allow-free target rules and, with the judge off, asks like `default`, not allow-all (ADR-088).

### Session allows never stand in for the judge (ADR-110 §4)

Under a judged auto mode a session allow does not answer for sub-agent launches, messages, unclassified tools,
agent-control edits, or paths outside the workspace or unresolved. pi's session allows are scoped to one resolved path
for edit, write, read, grep, find and ls (`read:<path>`; a search without `path` is keyed by the working directory), so
one click on an outside file is not a standing allow for the disk. A human's click is still honoured outside the judge.

"Always allow" suggestions follow the verdict. A call that asked only because its target is outside the workspace
suggests path-scoped rules (`Read(//<dir>/**)`, `Edit(//<dir>/**)`; `//` marks an absolute path), never the bare tool
rule, and none where nothing is safe to scope (a filesystem root, a glob character). An in-workspace edit or write card
suggests `Edit(//<root>/**)` for the narrowest workspace root holding the landing, never bare `Edit`/`Write`; a bash
card keeps its prefix rule. **No suggestion at all** on an edit of an agent-control path, a human-only card, or a pi
path-tool card raised by a user ask rule (a Bash card raised by an ask rule still offers its prefix rule). Each of those is asked before the allow tier, so a saved allow could never silence it.

### The bridge refuses to start without credentials (ADR-110 §5)

The bridge extension throws before registering anything when its URL or token is missing; pi reports the failed load
and exits 1 and the session error quotes pi's credential-free diagnostic. (pi runs every tool ungated if no `tool_call`
handler exists, so an inert load must be impossible.)

### Rule kinds (ADR-110 §5a)

As in Claude Code, an `Edit(...)` rule governs every file change (pi's `edit` and `write`) and a `Read(...)` rule every
read of the file system (pi's `read` and the `path` of `grep`/`find`/`ls`), in every tier; `Write`, `Grep`, `Glob`, `LS`
keep their own tools. A rule on a directory also holds for a search rooted there. (opencode folds `Write` into `edit`
and keeps search tools apart from `read`.)

### `Agent`/`Task` rules (ADR-110 §6)

`Agent`, `Task`, `Agent(<type>)`, `Task(<type>)` match pi's `agent` tool only (not `dispatch_agent`, not
`send_message`); the specifier is a case-sensitive glob over `subagent_type` (default `general-purpose`). Deny and ask
both bypass the spawn shortcut, so an ask rule raises a card in every mode (in auto, the human, never the judge).

### Agent-control list = ours + Claude Code's (ADR-110 §7)

The shared list (`automode/agent-control-paths.ts`) includes Claude Code's sensitive directories (`.idea`, `.cargo`,
`.yarn`, `.mvn`, `.config/git`) and files (git config, shell rc and profile files, package-manager, runtime,
build-tool and hook-runner configs, wrapper properties, `pyrightconfig.json`); an entry may span components. The
predicate, opencode's edit patterns, the redirect scanner and the allow-rule glob guard read one table. opencode
Accept Edits asks for these names too.

**ADR-110 §7a. A sensitive edit asks before the allow tier (pi).** With a path scope, an edit or write whose agent-control match
holds on any spelling (the model's, the canonical one, the link landing), in every mode but plan and
`bypassPermissions`, asks after the session-allow rung and before the allow tier: the judge in a judged auto mode, the
person everywhere else, inside the workspace or out. So a user `Edit(.claude/**)` allow (or bare `Edit`) never writes
there unasked. Deny rules still deny. This mirrors Claude Code's write-permission order.

**ADR-110 §7b. Rules match where the call lands.** Deny and ask rules match EVERY spelling (canonical path, the model's, the
link landing): more asking is the safe side. An allow rule matches where the call really lands (the landing, else the
canonical path), never a link's spelling, which can be re-pointed: `Read(//repo/lnk/**)` does not allow a read through
`lnk`; `Read(//elsewhere/**)` does when `lnk` lands there. The landing also counts under the logical spelling of a scope
root reached through a link (cwd `/logical` to `/physical`), so a cwd-relative `Edit(src/**)` keeps working in a project
reached through a link (macOS `/tmp`, a symlinked `~/code`) without widening. The suggestion on an outside read names the
landing directory.

Consequences. In Ask, Accept Edits and Plan a pi read outside the workspace raises a card; in ClaudeUI's own git
worktrees `node_modules` and `vendor` are junctions into the main checkout, so reads there ask outside auto (Claude Code
behaves the same). Auto spends judge calls on edits outside the workspace and on the extended sensitive names, none on
outside reads. A pi launched without bridge credentials no longer runs (never a supported launch).

## Retired

- ADR-067 — Codex under ClaudeUI's shared permission model — removed with the Codex engine (2026-10-29); the shared ladder it extended is ADR-085 and ADR-110.
