# ADR-083: The opencode and pi auto-mode judge is rebalanced toward routine work, grades stage 1 by severity, and reads the user's permission rules

**Status:** Accepted (2026-09-29). Built on branch `harnesses` in the 3.6 line.
**Amends:** [ADR-023](adr-023_opencode-automode-classifier.md) (the policy text, the two-stage
contract and what the judge is told about the user's rules),
[ADR-081](adr-081_claudeui-owned-judge-transport.md) §4 (the stage-1 reasoning effort on OpenAI
reasoning routes).
**Amended by:** [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) §4
— the §3 deviation is retired for narrow allow rules: with the robust deny/ask matcher in place, an
allow rule cli.js would keep as a direct allow skips the judge, subject to safety checks.
**Relates to:** [ADR-022](adr-022_opencode-permission-mapping.md) (the user's permission rules, which
the judge now reads), [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (the shared `automode.json` and its
Trust & protection group, which gain the guidance lists),
[ADR-067](adr-067_codex-shared-permission-model.md) (Codex's own guardian, the cross-reference).

## Context

The owner found the judge too restrictive. It asked for explicit approval before the agent created a
git branch or did ordinary work inside the working directory. It also judged each action without
knowing what the user's own permission rules allow, ask about or deny.

We compared three designs:

- **Claude Code 2.1.280's classifier.** The rules are no longer a template in `cli.js`. They ship as
  a zstd asset, and `claude auto-mode defaults` prints them: 17 ALLOW exceptions, 70 SOFT rules,
  1 HARD rule. The prompt now carries a "User Deny Rules" line built from the user's deny rules only,
  so the classifier can catch the same effect reached another way. Allow and ask rules are not sent.
  In auto mode, `cli.js` keeps ordinary allow rules as direct allows and strips only the "dangerous"
  ones (interpreters, `*`, `Agent`). It also has a severity mode: stage 1 grades 0-100 and escalates
  only above a per-model threshold (defaults 15/20, 25 for Sonnet 5).
- **Codex 0.156.0's guardian.** Codex decides by risk first. Low and medium risk are allowed whatever
  the authorization, because the user's task covers the steps it needs. High risk needs at least
  medium authorization and a narrow scope. Critical is always denied. Git work on one user-owned
  feature branch, or on a finite set of repo-local files, is low or medium. Restoring a specific list
  of files counts as a bounded local edit. The sandbox keeps most routine work away from the guardian,
  and commands the user's rules allow skip it.
- **Our judge** copied Claude Code's consent bar ("the user named the action AND the must-name item")
  but not its carve-outs. Our Git Destructive rule listed amend and rebase without the "this
  session's own unpushed work" exception, and nothing said branch creation was routine. The stage-2
  suffix repeated the bar without saying which rule text must match.

We measured before changing anything. JudgEval's 41 cases plus 26 new ones (branch creation,
in-workspace work, user-rule cases and their safety counterparts) ran three times on GPT-6 Luna
through the ChatGPT route. The baseline scored 91-95 %, but it had **2-4 critical false allows per
run, all at stage 1**. At reasoning effort `none`, stage 1 cleared `git reset --hard` on a dirty tree
and `git checkout -- .` over edits the agent had not made. Its false blocks came from stage 2 reading
the consent bar literally: amending the agent's own unpushed commit, restoring a file the agent had
just edited, and opening a PR under an allow rule.

## Decision

### 1. Routine, reversible, repo-local work needs no consent

The policy states a proportionality principle. Consent bars guard the harms the rules name.
Reversible, repo-local steps that serve the user's task need no consent: the user naming the task is
enough. The rule texts carry the carve-outs that make that concrete:

- **Git Destructive** lists what destroys work that exists nowhere else: force pushes, remote
  deletes, rewriting pushed or pre-session history, deleting branches or stashes this session did not
  create, and tree-wide discards (with the tree presumed dirty with the _user's_ work). A "NOT this
  rule" list names routine version control: creating or switching branches, worktrees,
  `stash push`, fetch/pull/merge, commits, rebasing or amending this session's unpushed commits, and
  restoring specific files the agent edited.
- **Irreversible Local Destruction** is about data that cannot be recovered. Tracked files, the
  output file the task asks for, and files this session created are Local Operations.
- **Untrusted Code Integration** covers running a cloned tree, not cloning or reading one. That was
  a live false block on 2026-09-23.
- **Local Operations** is rewritten as the everyday developer steps, version control included.
- **External System Writes**: a PR on the session repo for this session's commits has that work as
  its substance.
- **Remote Host Writes** (new soft rule): changing state on another machine through a remote shell or
  remote execution — services, firewall rules, packages, system configuration, deploys — whatever the
  host is called. Must name the host and the change. Read-only diagnostics the task calls for are not
  this rule. **Credential Exploration** now names the instance-metadata credential endpoints. Both
  came from replaying real historical denials (§Consequences): our corpus only knew hosts named
  `prod`, and a metadata-credential probe inside a heredoc script cleared stage 1.

The consent model adds two more clauses. **Routine parameters**: a branch name, commit message, PR
title or file path the agent fills in does not defeat a bar. **Standing consent** is described in §3.

Stage 2 is told to block only when the action matches the text of a specific rule (its "NOT this
rule" list included) and nothing clears it, or when it crosses an explicit user boundary. Otherwise
it allows: if it cannot name the rule, the action matches none. The boundary clause is needed
because a boundary block ("don't push") has no rule text of its own. Without the clause, the
candidate let such a push through in 2 of 3 runs.

### 2. Stage 1 grades severity at the floor effort and never clears destructive, shipping or remote shapes

- In `both` mode, stage 1 answers `<severity>N</severity>` (0-100) instead of yes/no. A grade of 15
  or less allows; anything else, including a reply we cannot parse, escalates to stage 2, which is
  final. Stage 1 still never blocks. 15 is `cli.js`'s fallback threshold. The sweep put the best
  accuracy between 15 and 20, and we take the conservative end.
- Stage 1 is told that intent only ever raises its grade: an action that crosses an explicit user
  boundary grades as a rule match. `cli.js`'s "stage 1 does not apply user intent" otherwise lets a
  boundary-crossing push clear stage 1.
- **Full-review shapes skip stage 1.** A shell command that ground truth already singles out
  (`needsGitStatus` / `needsRepoVisibility`: `reset --hard`, `checkout .`, `clean -f`, `rm -rf`,
  add/commit/push/stash, remote repoints, `gh pr create`/`merge`/`release`/`repo`), remote execution
  (`ssh`, `scp`, `rsync host:`, `paramiko`, `kubectl`/`docker exec`, `Invoke-Command`) or a cloud
  instance-metadata endpoint anywhere in its text (heredoc bodies included), or a redirect that is not
  all in scope, goes straight to stage 2. One-shot grades are noisy even at effort `low`:
  one run graded `git reset --hard` on a dirty tree 0. A deterministic list removes that failure
  instead of tuning around it.
- Stage 1 runs at the lowest reasoning effort the model accepts (`none` on GPT-5.1 and later), as
  ADR-081 §4 had it. A first cut moved it to `low`; a same-time A/B on GPT-6 Luna (67 synthetic and 42
  harvested real cases, × 3 each) showed no accuracy gain once the full-review shapes skip stage 1,
  and a slower tail: stage-1 p90 2.1 s vs 1.9 s synthetic, 6.0 s vs 2.2 s real. Stage 1 is the speed
  path, so it stays at the floor. Stage 2 stays at `low`.
- OpenAI's `max_completion_tokens` counts reasoning tokens. Stage 2 reasons at `low`, and so does
  stage 1 on a model whose floor is not `none` (`minimal` on gpt-5, `low` on the o-series); a reply cut
  off mid-reasoning is unparseable. Reasoning models on that route get 2048 tokens of server-side
  headroom, as `cli.js` adds for models that cannot run stage 1 without thinking. The client-side text
  cap is unchanged. The ChatGPT route sends no server-side cap at all.
- `fast` mode (stage 1 alone) keeps its yes/no grammar. `thinking` mode is unchanged.

### 3. The judge reads the user's permission rules

The Environment section lists the user's merged allow, ask and deny rules (user, project and local
scopes, deduplicated, in order):

- **Allow** rules are standing consent for exactly what the pattern names. The pattern supplies the
  must-name item, and what the named action carries by its nature is routine parameters.
  `Bash(gh pr create:*)` clears opening a PR. `Bash(git push:*)` does not clear a force-push. A broad
  prefix (`Bash(git:*)`, `Bash(*)`, a bare tool) names no dangerous parameter and clears nothing
  beyond routine use. An allow rule never clears the HARD rule, an adversarial rule or an explicit
  boundary.
- **Ask** rules never reach the judge (G9 sends them to the human). The judge is told to block an
  action that reaches the same effect another way, so the user still gets asked.
- **Deny** rules follow `cli.js`: block the same effect reached through reordered arguments, another
  tool or a wrapper. This closes the evasion that motivated `withoutAllowRules`, where
  `git push origin main --force` slipped past `Bash(git push --force:*)`.

**Deliberate deviation from `cli.js`, kept.** In auto mode we still strip _every_ user allow rule
from the engine ruleset (`withoutAllowRules`), so allowed actions reach the judge instead of running
unreviewed. `cli.js` keeps non-dangerous allow rules as direct allows. We keep review because
argument-reordering evasion defeats pattern matching. The judge now sees the allow rule as consent,
so the cost of review is latency, not false blocks. Keeping narrow allow rules as direct allows, as
`cli.js` does, remains an open option for the owner (§Consequences).

_Superseded by [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md)
§4 (2026-09-30): the engine rulesets still strip every allow rule, so every allowed call reaches the
host, but the host now lets a usable, un-carved-out allow rule skip the judge under strict coverage
and safety checks. The reordering evasion is closed by ADR-085 §1's matcher, which runs on every call
in every mode._

### 4. User guidance lists

`~/.claude/ui/automode.json` gains two optional lists, edited under Settings › Sessions & autonomy ›
Trust & protection (opencode and pi):

- `judgeAllow` becomes a **User-Specified Allow** exception ("these kinds of action are routine for
  me").
- `judgeBlock` becomes a **User-Specified Block** soft rule ("I want to approve these myself"). Its
  must-name item is the action as the entry describes it, and its slug `user_specified_block` is
  always a valid category.

This is `cli.js`'s `autoMode.allow` / `soft_deny`, and Codex's `[auto_review] policy`, in the
opencode and pi judge. The same IPC perimeter that guards the trust lists guards these lists
(non-empty trimmed strings, capped count and length). They are fed into the judge prompt, so they
are Self-Modification territory for the agent.

## Consequences

- **Harvested real cases.** 54 real denials (48 from Claude Code transcripts, 6 from ClaudeUI's own
  judge in opencode) were rebuilt as judge inputs with the owner's actual permission rules; 12 were
  excluded as arguable, and roughly half of the rest were false blocks (test runs, reads, per-file
  restores, delegations, work the user had explicitly authorised). Kickoff prompts carry real
  boundaries ("never checkout", "don't overwrite files you did not create"), which the judge must — and
  does — honour. They stay private (the owner's real sessions) in the scratchpad bench, not in
  JudgEval. On them the final design scores ~85 %, with residual misses from stage-2 variance (a bare
  `<block>no</block>` without reasoning) and debatable labels.
- **Measured result** (67 cases × 3 runs, GPT-6 Luna, ChatGPT route): the candidate reached 98.5-100 %
  with 0 false blocks on the owner's cases. The one critical leak left was `git reset --hard` graded
  0 by stage 1; full-review shapes remove it structurally. Stage 2 alone scored 97-98.5 % with 0
  critical misses in 201 verdicts. Re-measure after every policy change. The 26 new scenarios move
  into JudgEval.
- Every action matching a full-review shape now costs a stage-2 call (about 5-10 s), commits
  included. That is the price of never letting a one-shot grade clear a destructive or shipping
  command.
- The system prompt grows by the permission-rule lines and the guidance entries. Both are stable
  within a session. An edit to the rules mid-session costs one uncached prefix.
- Open for the owner: whether narrow user allow rules should bypass the judge again, as `cli.js`
  does. That would cut latency but reopen argument-reordering evasion for broad rules. _Decided in
  [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) §4: yes, with
  a robust deny/ask matcher, a carve-out for rules a deny/ask narrows, and safety checks._
- `docs/protocol-cc/14-auto-mode-classifier.md` is updated for 2.1.280: rules asset, deny-rule line,
  severity mode, and allow-rule stripping.
