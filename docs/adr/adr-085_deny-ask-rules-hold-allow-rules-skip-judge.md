# ADR-085: The user's deny and ask rules hold in every mode on every engine, subagents follow the parent, plan mode wins, and narrow allow rules skip the auto-mode judge

**Status:** Accepted (2026-09-30). Built on branch `harnesses` in the 3.6 line, five slices (S1–S5).
**Amends:** [ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) §3 (the "strip every
allow rule" deviation is retired for narrow rules — §4 here), [ADR-022](adr-022_opencode-permission-mapping.md)
(the compiled ruleset, session approvals, subagents, plan mode), [ADR-033](adr-033_cross-engine-dispatch.md)
§5 (dispatch targets now carry the user's deny/ask rules; `full` is no longer allow-all),
[ADR-084](adr-084_read-only-judge-bypass.md) §1 (a second static path runs after the read-only one).
**Relates to:** [ADR-023](adr-023_opencode-automode-classifier.md) (the judge), [ADR-067](adr-067_codex-shared-permission-model.md)
(Codex's gate shares pi's ladder), [ADR-076](adr-076_claude-automode-verdict-on-the-wire.md),
`docs/protocol-cc/14-auto-mode-classifier.md` §3.0 (the cli.js predicate mirrored here).

## Context

The owner's permission rules did not mean the same thing on every engine, and not in every mode. Five
holes, each verified at source before this ADR was designed (`vendor/opencode-src` @ v1.18.32,
`vendor/codex-src` @ rust-v0.156.0, pi 0.87.1):

- **H1 — opencode session `always` outranks deny/ask.** opencode evaluates `findLast` over the
  ruleset and the instance-wide `approved` list (`permission/index.ts`), and its shell `always` pattern
  is the arity prefix plus ` *` (`git push *`). ClaudeUI replied `always` on a ticked "always allow"
  suggestion. Worse, `approved` is per opencode instance — per directory — not per session: one
  "always" in chat A, default mode, was honoured server-side for chat B in auto mode, for every task
  child and every dispatch target in that folder, until the server process exited.
- **H2 — opencode MCP rules were inert.** The compiler skipped every `mcp__…` rule and the base
  ruleset's `{*: allow}` covered every MCP key silently, in every mode. Nothing asked, so the judge
  never saw an MCP call either.
- **H3 — opencode subagents ran unguarded.** A task child's session copies only the parent's `deny`
  and `external_directory` rules; `general` is `{*: allow}` and `explore` allows bash on its own. In
  every parent mode a child ran bash, edited, fetched and called MCP tools with no ask; in plan mode
  `explore` ran `hostname` unasked (live).
- **H4 — Codex allow rules skipped everything.** `rules-sync.ts` compiled every `Bash(x:*)` allow to an
  execpolicy `allow`, and `Decision::Allow` is `ExecApprovalRequirement::Skip` (`exec_policy.rs`): no
  sandbox, no guardian, no ClaudeUI gate. `forbidden` rules are argv-prefix only.
- **H5 — text-prefix matching everywhere.** pi's `bashSpecifierMatches` was `startsWith` on the whole
  command and opencode's globs were text over each statement, so `git push origin main --force`,
  `git -C . push --force`, `sudo git push --force`, `sh -c "git push --force"` and a chained
  `ls && git push --force` all evaded `deny Bash(git push --force:*)`. This is the evasion ADR-083
  §3 cited for stripping every allow rule in auto mode.

And two further findings during the build: in plan mode a user `Edit`/`Bash(git:*)` allow compiled
server-side beat the plan base (last-match-wins), so plan-mode edits and commits never asked; and
opencode's session PATCH appends, so the stored ruleset grew by a whole copy per turn (116 → 2705 rules
in 21 turns) and its `DeniedError` dumped every matching rule — the user's own included — into the tool
result the model reads.

Prior art: Claude Code 2.1.280 keeps ordinary allow rules as direct allows in auto mode and strips only
the shapes that would bypass its classifier wholesale (`ZIe`: bare/`*`, interpreter and launcher
prefixes, `Agent`/`Monitor`, or everything shell under `autoMode.classifyAllShell`); its normal
permission result also applies safety checks (dangerous removal, `sed` targets, path constraints) that
an allow does not override, and its "User Deny Rules" line tells the classifier to catch the same
effect reached another way.

### Owner rulings (binding)

1. Auto mode: allow rules skip the judge with **Claude Code parity** (strip only cli.js's
   classifier-bypassing shapes) **plus safety checks** (§4).
2. MCP rules skip at tool and server level.
3. **Deny and ask rules are always respected, in every mode** — crucial commands always get deny/ask.
4. opencode subagents follow the PARENT session's rules and mode for every gated tool.
5. Non-auto allow behaviour is otherwise unchanged (no UX regression), except pi's allow tier becomes
   operator-aware like the other engines.
6. Codex ask rules stay as they are (not compiled; the guardian decides in auto) — a documented residual.
7. **Plan mode wins**: in plan mode, edits/writes and non-read-only commands are refused regardless of
   allow rules (opencode and pi); allow rules still apply to read-only tools.

## Decision

### 1. One robust deny/ask matcher (`src/core/permissions/shell-rules.ts`, pure, never throws)

`denyAskHit(command, {deny, ask})` over-approximates: a false hit costs one prompt or one clear refusal,
a miss lets a command the user said "never" run.

- **Rules.** `Bash(spec)`: `x:*`, trailing ` *`, `*` → prefix; else exact (treated as prefix for
  deny/ask). Program = basename, lower-cased, `.exe` stripped; a word with `*`/`?` is a shell glob
  whose `*` does not cross `/` (`rm -rf /*` covers `/etc`, not `/d/work/x/dist`).
- **Segments.** A permissive quote-aware tokenizer that never refuses, run TWICE — bash quoting and
  PowerShell quoting (`''`/`""`, backtick escapes and continuations, `$'…'`, `--%`) — with a hit in
  either reading counting. Boundaries: unquoted `&& || ; | &`, CR/LF, `( ) { }`, `<<<`; every
  `$( … )`, backtick, `<( )`, `>( )`, `@( )` body is a segment of its own; heredocs are data unless
  their command runs them.
- **Program positions.** Token 0 of a segment or body; after shell keywords (`do`, `then`, `!`, …) and
  wrappers (`sudo doas xargs env nohup time nice command builtin exec timeout stdbuf busybox`, their
  flags and `K=V`, PowerShell `&`); path-qualified and quoted spellings (`/usr/bin/git`, `git.exe`,
  `"git"`); anywhere in the tail of `ssh host`, `docker exec c`, `chroot dir`. Deliberately NOT any
  position in a plain segment: `echo rm -rf`, `git rm -rf dir` and `ls -la rm` do not hit
  `Bash(rm -rf:*)`.
- **Quoted-content rescan.** Every quoted token in the whole command is re-split on whitespace and
  punctuation and scanned with the program allowed at ANY position (`sh -c "…"`, a `bun -e` script
  spawning `["git","push","--force"]`, `echo "git push --force" | sh`, `pwsh -Command "…"`,
  `cmd /c "…"`, `-EncodedCommand` decoded), minus the data operands of data programs (`echo`,
  `printf`; a commit message is still refused when it quotes a denied command — the model
  rephrases). Depth-capped.
- **Words.** Every rule word matches some later token of the segment, in any order, any gap (global
  options: `git -C . push`, `git -c k=v push`, `docker --context x run`). `--long` ↔ `--long=…`;
  `--lo…` abbreviation; short clusters as letter sets (`-rf` ↔ `-fr`, `-r -f`, `-Rf`); the last
  word of a prefix rule is a prefix only when it begins with `-` (`--force` → `--force-with-lease`;
  `docker run:*` does not hit `docker build -t runtime`); glob words by shell glob; a small
  program-scoped synonym table (`git push --force` ≡ `-f` ≡ any `+<refspec>` ≡ `--force-with-lease`;
  `git branch -D` ≡ `--delete --force`; `rm -r` ≡ `-R` ≡ `--recursive`, `-f` ≡ `--force`; program
  aliases `rm` ↔ `Remove-Item ri del erase rd rmdir` with `-Recurse`/`-Force`). Union with today's text
  match — a hit by either counts.
- **Cost.** Linear per rule word; a bounded nesting depth and token budget; past 64 KB the command is
  scanned flat (still over-approximate, never skipped). Runs synchronously on the main process;
  worst measured shape 72 ms.
- **Allow coverage** (`allowCovers`) under-approximates, in two strengths: **lenient** (the non-auto
  allow tier) splits at the operators of both dialects, requires every segment of both readings and
  every substitution body to be covered, allows redirections and data heredocs, and lets a rule whose
  text is the whole command cover it as written — so Claude's `git commit -m "$(cat <<'EOF' … EOF)"`
  is covered when `git` and `cat` are; **strict** (the auto-mode skip, §4) uses ADR-084's two-dialect
  lexer, which refuses redirections, newlines, `$` and every construct the dialects split
  differently. Both are word-boundary prefix or exact, case-sensitive, un-normalised (`Bash(git:*)`
  does not cover `git-lfs`; `Bash(bun run test:*)` does not cover `bun run test:unit`).
- **Predicates** for §4 and Codex: `isClassifierBypassingRule` (cli.js `ZIe` parity over the union of
  the Bash and PowerShell launcher lists, `python -m dotted.module:*` excepted, `Agent`/`Task`/
  `Monitor`/`AppifactRepl`), `isCarvedOut` (positional: same program and one rule's positional words
  are a prefix of the other's — `git:*` ⊃ `git push --force`, both directions; program strength for
  Codex: any deny/ask on the same program family), `canLaunchOtherPrograms`, `isLauncherShapedSegment`
  (a segment that runs code its own words do not show: `npx`, `bunx`, `bun x|run|-e`, `node -e`,
  `python -c`, shells with `-c`/`-Command`/`-EncodedCommand`/`/c`, `eval`, `exec`, `env`, `xargs`,
  `sudo`, `ssh`, `docker exec|run`, `git -c`, `find -exec`, `sed … e`, `awk system(`, the PowerShell
  launchers, …).

### 2. Host-side enforcement on every path a call reaches the host, in every mode

Order for a shell call: §1 deny → refuse `Denied by your permission rule <rule>` (a
`permission_denial` block on the card, `source: 'rule'`); §1 ask → the human, never the judge; then
the engine's existing path.

- **pi** (`permission-engine.ts` `decideWithSource`, shared by Codex's `gate()` and the dispatcher's
  pi and Codex targets): the Bash deny and ask tiers use §1; the Bash allow tier is lenient coverage
  per segment (any `$(`, backtick, `<(`, `>(` body must be covered too); `mcpRuleMatches` treats
  `mcp__server__*` as server-level (cli.js). The ladder is deny → plan (§3b) → hosted auto-allow → ask
  → session allow → allow → mode base.
- **opencode** (`host-precheck.ts` `hostPrecheck`, walked by `OpencodeSession.routePermissionAsk` for
  own and task-child asks alike, before the auto/human split): §1 deny → plan refusal (§3b) → §1 ask,
  then the user's ask rules by opencode glob (G9 moved out of the judge path; the union is
  deliberate) → the host session-allow set → (plan only) a user allow rule over a plan-read-only
  command → (child only) the parent's ruleset (§3) → continue (judge in auto mode, else the card).
  It reads the three permission scopes fresh per ask, so a settings edit binds the next ask.
- **ADR-084's read-only checker** re-checks Bash deny/ask rules through §1, so the bypass and the
  ladders cannot disagree.
- **Dispatch targets** (`cross-engine-dispatcher.ts`): §1 deny/ask in the target-ask forwarding path
  for opencode targets; pi and Codex targets get `{deny, ask, allow: []}` instead of empty rule sets;
  Claude targets get `settings.permissions.{deny, ask}` (cli.js honours ask and deny rules under
  `bypassPermissions` — verified in 2.1.280 `kNt`: the ask-rule returns precede the mode-allow) plus
  §1 in `awaitClaudeTargetApproval`. Target allow rules stay out (ADR-033). Target CHILD sessions are
  now registered (a per-target `childSessions` map for `mapEvent`; child `permission.asked` is
  forwarded, child `session.idle` never settles the turn) — before this they parked forever.

### 3. Engine-side first lines, so an engine-side allow can never beat a deny/ask

- **opencode broad globs.** Every Bash deny/ask rule compiles to its verbatim pattern (as before) PLUS
  over-approximating globs, in every mode: the program anchored at a token start / after `/` / after a
  quote, the rule's words in order with `*` gaps, cluster permutations and token-anchored synonyms
  (` -f`, ` +*`), capped. They compile after the allows, so under last-match-wins a broader user allow
  (`Bash(git:*)`) or a session approval can no longer outrank a narrower deny/ask — live: `git push
origin main --force` and `sudo git push --force` are denied server-side under `Bash(git:*)` + `deny
Bash(git push --force:*)`, where before they ran with no card. Glob-word rules keep their verbatim
  form; word order follows the rule (the host §1 covers other orders for anything that asks).
- **opencode session approvals (H1).** ClaudeUI never replies `always`. A per-`OpencodeSession`
  session-allow set, keyed by the ask's own `always` patterns (opencode's arity prefix — today's UX),
  is consulted AFTER §1 deny/ask, replying `once`; after an addition, this chat's pending asks that it
  now covers are answered `once` (the vendor's cascade, limited to one ClaudeUI session). The persist
  path (a ticked "always allow" suggestion) writes the rule and replies `once`. The dispatcher's
  opencode targets reply `once` too. A cross-chat `always` no longer exists.
- **opencode MCP (H2).** MCP rules compile to opencode permission keys via opencode's own sanitiser,
  never by string surgery: `mcp__s__t` → `sanitize(s)_sanitize(t)`, `mcp__s` / `mcp__s__*` →
  `sanitize(s)_*`; a server-level ALLOW only for a server in the live set (`collectClaudeMcpForOpencode`
  - `claudeui` + `GET /mcp` keys, new `OpencodeClient.mcpStatus()`) whose `s_*` matches no built-in
    permission key. Auto mode adds a base `ask` per server prefix (never `*_*` — built-in keys contain
    `_`; `claudeui` excluded: its hosted tools stay allowed and dispatch keeps its own ask), so every MCP
    call reaches the host: the allow skip (§4) or the judge. Non-auto MCP base behaviour is unchanged
    (owner ruling). A compiled MCP deny hides the tool from the model (opencode `disabled()`).
- **opencode subagents (H3, ruling 4).** opencode's config is per cwd server and mode-less, and
  patching a running child is too late (its `runLoop` snapshots the session once), so at spawn
  `OPENCODE_CONFIG_CONTENT` gets per-agent STRING `ask`s for every gated category the agent would
  otherwise allow — `general`: bash/edit/webfetch/each bridged MCP `<server>_*`; `explore`:
  bash/webfetch; file-backed and config-inline agents from the same scan opencode makes (global and
  project config files, agent markdown) minus their own string denies; never top-level `edit`/MCP
  (it would turn `explore`'s denies into asks) and never an unknown agent name (a phantom agent
  appears). Every child ask is then answered host-side with the PARENT's CURRENT effective ruleset:
  allow → `once` silently, deny → refused with the rule, ask → today's path (the card, or in auto mode
  the fast path, the agent-control gate, the read-only bypass, §4 and the judge — which is told the
  call came from subagent `<type>` with the parent's `task` prompt). Backstop: after acquire and on
  every mode patch, `GET /agent` is read (cached per session) and any non-primary agent whose gated
  categories still resolve to allow gets a `task:<name>` ask in the parent, after the user rules; a
  failing `GET` fails closed with `task * ask`. Child approvals carry a child marker, `always` and the
  tool part's input.
- **Plan mode's server-side denies become asks.** opencode's PATCH appends and a child copies every
  deny, so plan's `edit` and `task:general` denies used to outlive plan mode and bind every later
  subagent. They are `ask` server-side now and refused host-side with the plan reason (`source:
'mode'`); a plan → default switch leaves nothing behind. `TaskCard` renders the refusal (chip and
  strip) and a refused spawn does not count in the agent roster.
- **Ruleset hygiene.** `applyPermissionMode` skips the PATCH when the ruleset is unchanged for this
  opencode session (growth is now bounded by mode switches, not turns).
- **Plan wording.** opencode and Codex have no `exit_plan` tool, so their plan refusal reads "Plan mode
  is read-only — present the plan and ask the user to leave plan mode to proceed"; pi keeps
  `exit_plan`.
- **Codex (H4).** `rules-sync.ts` does not emit an execpolicy `allow` for a Bash allow rule that any
  Bash deny/ask rule carves into (program strength — an emitted `allow` never reaches the matcher
  again), nor for one that can launch other programs while any Bash deny/ask exists; Codex then
  escalates those and `gate()` decides through pi's ladder (in auto mode Codex's guardian). Ask rules
  are still not compiled (ruling 6). `CodexRulesStatus` and the file header list the withheld rules.
  `forbidden` remains prefix-only.

### 3b. Plan mode wins (ruling 7)

In plan mode, edits/writes and non-read-only commands are refused regardless of the user's allow
rules, ask rules and session allows, on opencode and pi; allow rules still apply to read-only tools.

- One plan-read-only oracle for every engine, `isPlanReadOnlyCommand` = the UNION of pi's plan-safe
  list and ADR-084's read-only checker (so PowerShell readers such as `Get-ChildItem`, `Get-Content`,
  `Select-String` work in plan mode on Windows). The checker's scope is cwd + additionalDirectories +
  the user's deny rules only — read-only-ness never depends on ask/allow rules.
- **opencode**: plan mode sends no `edit`/`bash`/`task` allow rule to the server
  (`withoutMutatingAllowRules`; a `task` allow could re-allow the mutating `general` subagent, whose
  child would then edit unasked), so those asks always reach the host; the plan rung refuses any
  `edit`, `task:general` and any shell command the oracle cannot vouch for, and answers a plan-safe
  command a user allow covers with `once` host-side. Literal consequence: a non-plan-safe command is
  refused even with no allow rule (before, it showed a card).
- **pi**: the plan rung sits right after the deny rung, so an ask rule or a session allow no longer
  surfaces a card for a mutating call in plan mode. Codex's `gate()` inherits it.

### 4. Auto mode: narrow allow rules skip the judge (rulings 1–2)

One shared gate in both hosts (`src/core/automode/allow-rule-skip.ts`, pure; `allow-rule-gate.ts`, the
engine glue), placed AFTER ADR-084's read-only bypass and BEFORE the judge is resolved — so it holds
even when no judge model does. Codex's native reviewer is untouched. The engine rulesets still strip
every allow in auto mode (`withoutAllowRules`, both modules), so every allowed call still reaches the
host, which now decides skip-judge versus judge; the judge environment keeps listing the allow rules
(ADR-083 §3).

- **Usable rule.** An allow rule is unusable when `isClassifierBypassingRule` says so (cli.js `ZIe`
  parity), when `autoMode.classifyAllShell: true` is set in the USER Claude settings and the rule is
  a shell rule (cli.js reads user/flag/policy scopes; ClaudeUI has no flag/policy layer), when it would
  cover the dispatch tool (`mcp__claude-ui-collab…`, `mcp__claudeui…`), or — shell rules only, and
  only while the user has any Bash deny/ask rule — when `isCarvedOut` (positional) names a deny/ask
  rule it is broader than: `Bash(git:*)` is unusable beside `deny Bash(git push --force:*)`, so every
  git command keeps going to the judge; `Bash(git status:*)` is usable beside it.
- **Coverage (strict).** Every segment of the command, under both readings of ADR-084's lexer, must be
  covered by a usable rule (word-boundary prefix or exact); the command must not hit §1 (defensive —
  both hosts already refused or asked). Anything the strict lexer refuses (`$`, redirections,
  newlines, unbalanced quotes) goes to the judge as before.
- **Safety checks** (cli.js does not make these; the owner asked for them):
  - a **launcher-shaped segment** is covered only when the rule NAMES what the launcher runs:
    `Bash(bun run test:*)` covers `bun run test --watch`, `Bash(npx prettier:*)` covers `npx prettier
--write src`, an exact rule covers its exact command, and a wrapper (`sudo`, `env`, `timeout`, …)
    is looked through to the wrapped program; `Bash(bun:*)`, `Bash(npm:*)`, `Bash(uv run:*)` over
    `bun x foo`, `npm exec -- git push --force`, `uv run pytest` do not. Shells with `-c` / `-Command`
    / `-EncodedCommand` / stdin, `node -e`, `python -c`, `docker|podman|kubectl exec|run`, `git -c`,
    `find -exec`, an executing `sed`/`awk`, `eval`, `exec`, `source`, `&`, `iex` and the other
    PowerShell launchers are never covered (the code is a string, or the operand is not the rule's
    business) → judge;
  - **write targets** of `rm rmdir Remove-Item` (and the alias family), `mv cp touch mkdir tee`
    (and `Move-Item`, `Copy-Item`, `New-Item`), `find … -delete` and `sed -i` must pass ADR-084's
    path rules at every program position the §1 matcher finds (`sudo rm …`, `timeout 5 rm …`) —
    inside cwd + additionalDirectories (opencode's `workdir` honoured), no secret-shaped component
    (`rm -rf .git`, `touch .env` go to the judge), no agent-control target (`.claude/…`, `.husky/…`,
    `CLAUDE.md`, … — `agent-control-paths.ts`), the user's `Read` deny rules, realpath — else judge.
    Globs are allowed as operands (`rm -rf dist/*`, `rm -rf *.log`), but a glob component with a
    literal part may not match a secret-shaped name (`.*`, `.gi*`, `.env*` → judge), a delete of a
    scope root or of everything in one goes to the judge (`rm -rf .`, `rm -rf <cwd>`, `rm -rf *`,
    `find . -delete`, and a `mv` whose SOURCE is a scope root or `*` — the destination is an
    ordinary write), and a `find … -delete` name filter (`-name`, `-path`, …) may not be
    secret-shaped, agent-control or glob-only (`-regex` → judge);
  - a **destructive git subcommand** is covered only when the rule NAMES the subcommand (the
    launcher principle): `reset --hard`, `clean -f`, `checkout` with pathspecs / `--` / `-f` / `-B`,
    `restore`, `switch -f|--discard-changes`, `branch -D|-M|-C` (or `-d -f`), `stash drop|clear`,
    `push` with force / `--delete` / `--mirror` / `--prune` / `+refspec` / `:refspec`, `rebase`,
    `filter-branch`, `update-ref -d`, `reflog expire|delete`, `gc --prune=now|all`, `worktree remove
-f`, `tag -d`, `remote remove|rm`, `submodule deinit -f|--all` — the subcommand found past git's
    value-taking global options (`git -C . reset --hard`), at every program position, short
    clusters letter-wise. `Bash(git reset --hard:*)`, `Bash(git clean:*)`, `Bash(git push:*)`,
    `Bash(git -C . reset:*)` and an exact rule name theirs (the rule's words reach the subcommand);
    `Bash(git:*)` never does → judge. Non-destructive forms (`git reset file`, `git clean -n`, `git
checkout main`, `git checkout -b feat origin/main`, `git branch -d x`, `git push origin main`, `git
tag v1`) stay covered;
  - the user's **`Read(...)` deny rules** bind the path arguments of readers (`cat head tail less
more type Get-Content gc grep rg Select-String sls`), resolved against the effective cwd and its
    realpath. Readers get no scope or secret-name check beyond that: an allow rule is the user's
    explicit consent to read outside the workspace (cli.js parity).
- **Non-shell.** `WebFetch` (bare, or `domain:d` = hostname equals `d` or ends with `.d`, WHATWG
  `URL`), a bare `WebSearch`, `Skill` / `Skill(name)`, and MCP rules at tool and server level —
  `mcp__s`, `mcp__s__*`, `mcp__s__t` — matched on pi by the `mcp__s__t` tool name and on opencode by
  translating the ask's key back through the known server set (§3): exactly ONE known server's
  `sanitize(s)_` may prefix the key (`a` and `a_b` over `a_b_x` leave the server unknown → judge),
  tool names compared through opencode's sanitiser. The review block waits for the tool part when
  the ask precedes it (an MCP ask does). File tools are unchanged (an agent-control edit always sees
  the gate/judge); `edit`, `task`, `doom_loop`, `read` and `external_directory` asks never take this
  path. A task child's ask takes it with the PARENT's rules (ruling 4).
- **On allow:** reply allow; the card carries a `tool_review` block (reviewer `auto-mode`, approved,
  rationale `Allowed by your permission rule <rule>`); one info line `auto-mode allow (stage=rule)
<tool> — <rule>` with the rule text and never the command, URL or query (the command follows at
  debug); no `recordAllow()` (a static allow never resets the denial caps); no usage row (no model was
  called). The gate is synchronous, so no verdict can outlive a mode switch.

## Consequences

- A user's deny/ask rule now means the same thing on opencode, pi and Codex, for the session's own
  calls, for task subagents and for dispatch targets, in every mode — matched by effect (reordered,
  wrapped, chained, quoted) rather than by text. The price is over-refusal in the named shapes: a
  commit message quoting a denied command, `echo … | (ls); sh`, any pipe out of a data program into a
  compound, a >64 KB command.
- Auto mode is cheaper for the rules the user wrote narrowly (no judge call for `git status` under
  `Bash(git status:*)`, for a bridged MCP tool under `mcp__server`, for `bun run test` under
  `Bash(bun run test:*)`) and unchanged for broad rules that a deny/ask carves into. The judge still
  sees every launcher, every out-of-scope write and every read the user's `Read` rules deny.
- Non-auto opencode: a broader allow no longer beats a narrower deny/ask (S2 verifier F1 closed);
  reordered denies are card-less (opencode's `DeniedError` fires before any event), where the exact
  forms were already card-less — a renderer follow-up could render the tool result as a denial chip.
- Plan mode refuses more than before on opencode (non-plan-safe commands with no allow rule used to
  show a card) and pi (ask rules and session allows no longer card a mutating call); every model the
  verifiers drove refused to mutate in plan mode on its own, so the refusal is rarely the model's
  first contact with the rule.
- Subagents on opencode ask for everything gated and are answered by the parent's rules; a
  `general`/`explore` spawn in auto mode costs judge calls it did not before, and every `general` spawn
  asks in auto mode when the user has non-bridged MCP servers (the backstop). The session ruleset no
  longer grows per turn.
- Every ask on opencode costs three synchronous settings reads (user/project/local) in every mode.
- `docs/protocol-cc/14-auto-mode-classifier.md` §3.0 cross-references the ClaudeUI predicate.

### Residuals (found, named, not worth code now)

**Matcher (§1)** — each a deny/ask MISS unless noted:

- text that becomes a command only at run time: `while read l; do $l; done <<EOF` and `… | while
read l; do $l; done`, `echo <b64> | base64 -d | sh`, `rg --pre <prog>`, `make -f - <<EOF`;
  indirection in general (`$CMD`, shell/git aliases, scripts written earlier, `git config alias.*`);
- cmd.exe `^` escapes (`g^it push`); Windows cmd.exe shims (ADR-084);
- past the length cap or token budget the flat scan does not decode `$'…'`, split `git-push`, join
  `("gi" + "t …")`, remove a `\` escape, honour `--%` or expand a git alias, and past 64 KB nothing
  else is analysed;
- the SCRIPT RUNNERS, by cli.js parity: `make`, `npm test`, `bun file.ts`, `bash x.sh`, `tar
--to-command`, `rsync -e`, `tmux`, `go run`, `gh alias set --shell` are not launcher-shaped
  although each runs code its words do not show (adding them would make the Codex compiler withhold
  every allow for them whenever a Bash deny/ask exists);
- accepted over-refusals, pinned by tests: any pipe out of a data program; a data write to a
  script/rc/hook/`.git/`/agent-control path or to a file mentioned later; a pipe into a compound lifts
  everything after it; a commit message quoting a denied command.

**opencode server side (§2, §3)**

- Server-side denies are card-less (review S9); broad globs follow the rule's word order and do not
  broaden program families (`rm` ↔ `Remove-Item`) or long-form cluster synonyms — the host §1
  covers whatever asks.
- MCP server-level deny/ask `s_*` over-matches a built-in key when a server is named `external`,
  `doom`, `plan`, `workflow` or `apply`.
- Removed USER deny rules still bind task children until the server restarts (PATCH appends; a child
  copies every deny). Mode switches still append one ruleset per mode visited.
- A mid-turn default → plan switch does not reach the in-flight turn: the server keeps the ruleset its
  `runLoop` snapshotted until the next prompt; the host rung only sees what asks.
- **opencode's `DeniedError` dumps the WHOLE appended ruleset into the model's context** (vendor,
  pre-existing; measured live during the S5 verification: 707 entries, ~50 KB, the user's own rules
  included, on one server-side denial). ADR-085 §3 stopped the per-turn growth but every mode switch
  still appends one ruleset copy, and the dump leaks the user's rule text to the model. Raised with
  the owner as a follow-up (a host-side trim of the tool result, or an upstream change). "The user
  rejected permission…" duplicates the denial strip.
- A non-auto session allow on `edit *` / `webfetch *` is whole-category for that chat unless a user
  ask rule matches (old server-side UX; ADR-084's agent-control exception is auto-only).
- `webfetch`/`websearch`/`task`/MCP allow rules still beat the plan base on opencode (only
  `edit`/`bash`/`task` allows are withheld in plan mode).
- Plan-mode oracle: commands neither pi's list nor the checker knows stay refused with no card —
  `cd src && ls`, `sed -n …`, `bun run test`; programs pi's list passes keep pi's behaviour (no
  secret-path or out-of-scope refusal for `cat .env` / `cat ../outside`, no armed-git check for `git
status`), and the user's `Read` deny rules are not applied to plan-mode bash readers (the auto-mode
  skip applies them; plan does not). `isPlanSafeBashCommand` is quote-blind on chain operators
  (over-denies `grep "a && b"`) and bash-dialect only.
- "Open in panel" on a refused spawn opens a failed task entry beside a "0 total" roster (UX).

**Subagents (§3)**

- Static asks are per-agent STRING values: an agent's own pattern map (`bash: {"*": ask, "git *":
allow}`) is replaced wholesale by the ask (the parent's rules decide instead).
- The spawn-time scan reads the global config dir `config.json`/`opencode.json(c)`, `<cwd>/opencode.json(c)`,
  `<cwd>/.opencode/opencode.json(c)`, and global + project agent markdown. NOT read: parent-directory
  config files up to the worktree, `OPENCODE_CONFIG`, `OPENCODE_PERMISSION`, `~/.opencode`,
  remote/managed config, `{env:}`/`{file:}` substitutions — agents and denies only they define are
  covered by the `task:<name>` backstop (a top-level deny there IS overridden by the injected ask,
  which sits after the user tier).
- The user's own non-bridged opencode MCP servers (`GET /mcp` only) get no static child ask; in auto
  mode the backstop makes `general` spawns ask.
- `GET /agent` is cached per session (an agent added mid-session binds the next session); a failing
  `GET` fails closed for that apply.
- An agent markdown file that names no `mode` reads back as the built-in/`all` fallback (an extra ask
  on an agent no task uses — over-inclusion only).
- A child's `external_directory`/`doom_loop`/`.env` read asks keep today's card/judge path; a target
  child's non-bridged MCP ask is forwarded as a card. A child ask card does not say it came from a
  subagent (the marker carries only ids).
- opencode's own `plan_exit` tool is model-visible in ClaudeUI plan mode; its "switch to build agent"
  question does not change ClaudeUI's permission mode — the wording tells the model to ask the user.

**Codex**

- Ask rules are not compiled (ruling 6): a `prompt` reaches ClaudeUI's gate in the non-auto modes and
  the guardian in auto.
- An execpolicy-allowed command (a user Bash allow that survives the carve-out, e.g. `Bash(mkdir:*)`)
  runs in PLAN mode without reaching ClaudeUI, unsandboxed: the rules file is user-global and
  mode-less.
- `forbidden` is argv-prefix only for the commands Codex does not escalate.

**Dispatch targets**

- Claude targets under auto (`bypassPermissions`): deny/ask by cli.js's own text-prefix matcher only
  (reordered forms are its miss, not ours).

**Auto-mode skip (§4)**

- By the owner's choice (cli.js parity), allows that remain broad skip the judge: `Bash(curl:*)`
  (exfiltration), `Bash(gh:*)` (repo admin), `Bash(git:*)` when no git deny/ask exists.
- A named launcher operand is trusted as a whole: `Bash(bun run test:*)` covers `bun run test` with
  any arguments, and `Bash(docker run img:*)` would name the image but not what runs inside it (the
  docker shapes are never covered for that reason).
- Readers under an allow rule are not scope- or secret-checked (parity); only `Read` deny rules bind,
  and a reader with a glob operand goes to the judge whenever any `Read` deny rule exists (`cat *`).
- Script runners are not launcher-shaped, by cli.js parity (§1 residuals): `Bash(bun test:*)`,
  `Bash(bun scripts/x.ts:*)`, `Bash(node scripts/x.js:*)` skip for the code those files hold. A
  delete of a subdirectory is not inspected for what it contains (`rm -rf sub` with a `.git` inside;
  a symlink inside the workspace that points into an agent-control directory is followed only by
  the scope/realpath rule, not by name), and a data write to a file that runs later (`tee
package.json`) is the §1 "scripts written earlier" residual. Git shapes NOT in the destructive
  table (owner-ruled residuals): aliases (`git nuke` configured as `reset --hard`; `git -c alias.x=…`
  is already `launcher:git`), `stash pop` (conflicts), `merge|am|cherry-pick|rebase --abort`, `commit
--amend`, `notes prune`. PowerShell-style `-Force` also matches an `f` cluster (over-refusal only).
  An `mv` destination flag spelled outside `-t`, `--target-directory[=]`, `-Destination[:]` (or a
  GNU prefix of those) is read as a source — the stricter reading.
- Glob semantics are bash's: a glob-only component (`*`) is assumed not to match dotfiles, so under
  PowerShell — where `*` does — `Remove-Item -Recurse dist/*` can take `dist/.env` with it (the
  workspace root is guarded; a subdirectory is not). A quoted `'*'` is still read as a glob (fails
  closed). Glob over-refusals: `rm *.md` and `.cl*` go to the judge (a glob with a literal part may
  match an agent-control name), as does `rm -rf */` at the root.
- A Windows absolute path with backslashes (`rm -rf D:\other\x`) never skips: bash reads `D:\…` as
  drive-relative and the two-view rule refuses it (`path:drive-relative`).
- Over-refusals (the judge decides instead): a leading assignment (`FOO=1 git status`) is never
  covered by strict coverage; `Bash(npx -y x:*)` is a `ZIe` launcher shape (S1 parity — `Bash(npx
x:*)` is usable); a wrapper or runner flag that may take a value makes BOTH following words
  candidates the rule must name (`npx --package foo bar` needs a 4-word rule); two known MCP servers
  whose sanitised names prefix one key (`a`, `a_b`) leave the server unknown.
- The strict lexer unquotes: `"git" status` is covered by `Bash(git:*)` (cli.js's text prefix would
  not match) — the same program runs.
- A shell ask whose tool part never carries its input (opencode, after the ~1 s wait) goes to the
  judge as before; pi's `bash` with a `workdir`/`cwd` input never skips.
- Cosmetic: the debug refusal line names the carve-out of the FIRST covering-but-unusable rule
  (`Bash(git:*)`'s, when a narrower `Bash(git rev-list:*)` was the one carved out by an ask rule) —
  the info path is unaffected; a "narrowest covering rule first" pick is a three-line follow-up.
- PowerShell rules (`PowerShell(...)`) are cli.js's separate tool and are ignored here.

## Verification

Every slice was live-verified on the owner's real profile with synthetic rules in a scratch repo's
`.claude/settings.local.json` (profile files byte-identical before/after; opencode Windows runs
pwsh): S2 host deny/ask/session-allow incl. cross-chat; S3 reordered and `sudo` force-push denied
under `Bash(git:*)`, ask overlap asks, plan refusal with no stale child deny, MCP deny hides the tool,
auto-mode MCP call reaches the judge; S3b plan mode refuses an allowed commit/edit and runs
`git status`, pi plan refuses a write; S4 explore child `git status` parent-allowed, `hostname` carded
in default, refused in plan with the no-exit-tool wording, judged in auto, ruleset counts stable per
turn; S5 (2026-09-30, scratch-repo rules `allow Bash(hostname:*) Bash(git rev-list:*) Bash(bun run
test:*) Bash(mkdir:*) Bash(git:*)`, `deny Bash(git tag:*) Bash(git push --force:*)`, `ask Bash(git
stash:*)`): opencode auto on a free model — `hostname` skipped with `auto-mode allow (stage=rule) bash
— Bash(hostname:*)` and the card rationale, `whoami` judged, `git rev-list --count HEAD` named
`Bash(git rev-list:*)` (never the carved-out `Bash(git:*)`), an ask rule added live to the settings file
sent the same command to the judge on the next ask, `bun run test` skipped by the rule that names the
script, `mkdir s5-made-dir` skipped and `mkdir ..\s5-outside` judged, an `explore` child's `hostname`
skipped with the parent's rule and the review on the child card (3 judge calls; the `bun --version`
control was skipped because a user-scope rule covers it); pi auto on GPT-6 Luna — `hostname` skipped
from `PiSession` with the card, `whoami` judged, `git rev-list --count HEAD` named the narrow rule,
`git count-objects` judged through the carve-out (2 judge calls); regression sweep in default/plan —
reordered force-push denied server-side, `git stash list` carded despite `Bash(git:*)`, an `explore`
child's `whoami` carded with the `ApprovalCardView.*` testids and allowed by `ApprovalCardView.allow`,
a plan-mode `explore` child refused `Blocked · mode` with the no-exit-tool wording (the own-session
plan write was not exercised: the model refused to attempt it; the same host rung is the S3b live
result). Profile files byte-identical before and after; the opencode and pi processes released.
