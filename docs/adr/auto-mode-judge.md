# The auto-mode judge for opencode and pi

Governs: `src/core/automode/`, `scripts/judge-eval/`, `src/shared/judge-guidance.ts`, `src/core/pi/PiSession.ts`, `src/core/opencode/OpencodeSession.ts`, `src/core/services/dispatch-pi-targets.ts`, `src/core/services/dispatch-opencode-targets.ts`

ClaudeUI's own security-monitor judge: the engine-neutral two-stage classifier that decides the permission asks of
opencode and pi sessions (and their dispatch targets) in auto mode, the HTTP transport that calls the judge model,
what the judge is told, what skips it, what a block does, and what an outage does. Claude Code has its own
classifier in cli.js (its protocol is `docs/protocol-cc/14-auto-mode-classifier.md`; the verdict on the wire is
ADR-076 in `claude-engine.md`). Modes, the rule ladders and path containment (ADR-022, ADR-050, ADR-085, ADR-110) are
in `permissions.md`: deny and ask rules hold, allow rules skip the judge (ADR-085), and a switched-off judge asks like
Ask (ADR-110). Dispatch targets are judged per ADR-088 (`dispatch.md`), opencode native subagents' judge context is
ADR-111 (`opencode.md`), pi subagents ADR-089 (`pi.md`), judge usage rows ADR-071 (`metering.md`). The evaluation
harness is `scripts/judge-eval/`; the prompt text Claude Code ships is extracted by
`scripts/extract-automode-prompts.mjs`.

## The judge is an independent two-stage security monitor (ADR-023)

In auto mode (`auto`/`full` autonomy, unless the engine's `autoMode.enabled` is `false`) every would-be-`ask` tool
call of an opencode or pi session is decided by `classify()` in `src/core/automode/classifier.ts`, run through the one
shared pipeline (`judge-pipeline.ts`) that PiSession, OpencodeSession and the dispatch pi/opencode targets all use.
The judge is a separate model call with its own policy prompt, never the session model judging its own action (that
was rejected: a self-judge is weaker and injection-prone, and a separate request shares no cache with the live
conversation anyway). The policy text is ClaudeUI's own corpus (`src/core/automode/rules/`), not cli.js's.

- **Order of a call.** The caller's user-ask-rule check (G9: a user `ask` rule goes to the human with zero judge
  calls) runs first; then the pipeline: the built-in safe-category fast path (`read`, `glob`, `grep`, `list`) → the
  static read-only gate (ADR-084) → the allow-rule gate (ADR-085) → the user's one-shot grant (ADR-091 part 6) → the
  judge. Everything before the judge is zero-token.
- **Two stages, `twoStageMode`** (engine setting, default `both`):
  - `both`: stage 1 grades severity only; it can allow or escalate, never block (ADR-083 §2). Stage 2 applies user
    intent and the ALLOW exceptions and its verdict is final. An unparseable stage 2 is a block (fail closed, not
    `unavailable`).
  - `fast`: stage 1 alone decides and may block; unparseable blocks. `thinking`: stage 2 alone.
  - Budgets: stage 1 64 tokens in `both` (256 in `fast`), stage 2 8192; stage timeouts 60 s and 120 s. A timeout is
    treated exactly like a transport error.
- **Fail closed to the human, never to allow.** A transport error, timeout, missing route or a configured judge
  model the catalog no longer offers makes the result `unavailable`: the human decides, with the cause on the card
  (ADR-107). A substitute judge is never chosen by ClaudeUI; only the user's own fallback judge model is consulted
  (ADR-107). Exception: an unusable stage-1 reply in `both` mode escalates to stage 2 (ADR-109).
- **Precedence.** A user `ask` rule outranks the judge; user `deny` rules are enforced before it. The permission mode
  is re-read after the judge returns; if auto mode is no longer active the verdict is discarded and the human decides
  (cli.js `mode_changed_while_queued` parity). A verdict for an ask answered elsewhere meanwhile is dropped silently.
- **Denial caps** (`denial-tracker.ts`, one implementation for both engines; the root session, every pi child, every opencode task
  child and every dispatch target each have their own tracker and caps): 2 blocks in a row on the same corpus
  category, 3 in a row, 20 in a session. A cap hands the decision to the human with the cap's sentence as the card's
  reason, and the streaks restart after each cap (the 20-total cap stays tripped). An allow clears the streaks; a
  static allow (read-only, allow rule) does not.
- **Stage 2's `<category>`** is normalised and validated against an allowlist derived from the corpus
  (`normalizeCategory`, `deriveCategorySet`, `parseCategory`): an invented category is dropped while the block
  stands. The same-category cap and the deny text (which names the matched rule) rely on it.
- **Judge model.** `autoMode.judgeModel` (a `<provider>/<model>` string in the engine's own ids) or, when unset, the
  session's own current model, read per call. There is no cap on allowed judge calls (parity with cli.js): cost is
  bounded by the zero-token paths above, the slimmed transcript, prompt caching and the model choice. There is no
  `(tool, input)` verdict memoization, deliberately: a memoized verdict would override the user's later decision to
  approve or deny the same call; every evaluation is fresh.
- **What the judge is given.** A policy prompt; an Environment section (cwd, platform, session-start git remotes
  captured once and frozen, resolved repo visibility, additional directories, the user's trusted domains and registries
  and protected patterns, the user's merged allow/ask/deny rules, the user's guidance lists, ADR-083 §3-§4); a slimmed
  transcript; the proposed action. The transcript carries user text, assistant tool calls with their recorded
  `{"outcome":…}` (ok / error / rejected-by-user / automode-blocked / pi's `unanswered`), and the tail (2000
  characters) of the last assistant message before each user turn, so an affirmed proposal is visible. Continuation
  lines of a quoted turn are indented so prose cannot forge a `User:` line; `system` rows are never a user turn.
- **What the judge is never given.** Project instruction files (AGENTS.md / CLAUDE.md), tool results (accepted parity gap: it cannot reason about command output),
  thinking blocks, images, assistant prose that no user message answered, credentials or key values. Ground-truth
  captures (git status, repo visibility via `gh`, redirect measurements) are spawned without a shell, time-budgeted,
  and emit nothing on failure.
- **Where the settings live.** `~/.claude/ui/automode.json` holds the shared trust and guidance lists,
  `readOnlyBypass` and `blockHoldSeconds`; the per-engine settings (`autoMode`) hold `enabled`, `judgeModel`, the
  fallback judge and `twoStageMode`. The engine `autoMode` block and the shared trust and guidance lists are
  memoized per session (`JudgeSetup`), so an edit to them (including `judgeAllow`/`judgeBlock`) binds the next
  session. Live per call: the user's permission rules, `readOnlyBypass` and `blockHoldSeconds`.

Rejected: a hidden opencode judge session (stateful, shares the engine prompt), and verdict memoization (above).

## ClaudeUI makes the judge's model call itself (ADR-081)

For opencode and pi sessions the main process makes the judge's one model call with plain `fetch` (no SDK, no
tools). The opencode fork and pi's second judge process are gone; the judge prompt is exactly the policy and the stage
budgets apply where the provider allows. Out of scope: Claude Code (cli.js classifier), `/btw` and agent-generate
(not security judges; they keep deny-all throwaway sessions). Judge-http code lives in
`src/core/automode/judge-http/` and must not import vault, shared-provider or engine code; `judge-route.ts` is the
resolver.

### §2 Routes come from vault-backed shared providers

The judge model string maps to a shared-provider definition by the ownership rule `decorateSharedProviderClaims`
uses (the definition whose delivered route for that engine is enabled and whose native provider id equals the
string's). The route is resolved per call, so a rotated key or refreshed token applies to the next call. Keys and
tokens never leave the main process and are never logged (only the account label).

- ChatGPT subscription (shared definition `chatgpt`: opencode `openai` with the ChatGPT route on, pi `openai-codex`):
  Responses wire, streamed, `https://chatgpt.com/backend-api/codex/responses`, with the active account's token
  (`credentialSync.injectionTokenFor`). A named fallback account uses that vault account's token (ADR-107).
- OpenAI API key (vault-backed catalog `openai`) and OpenRouter key (catalog `openrouter` or a custom definition
  derived from it): chat completions; the endpoint is a constant for these two catalog providers, and the engine
  catalog only supplies optional facts (reasoning bit, output ceiling).
- Other vault-keyed catalog providers use the engine catalog's endpoint, only if it is OpenAI-compatible.
- Custom definitions: protocol `openai-completions` (`baseUrl` + `/chat/completions`, key optional, keyless
  endpoints work) or `openai-responses` (`baseUrl` + `/responses`). An Anthropic-protocol definition is refused.
- Anthropic OAuth is never used. OpenAI's OAuth (the ChatGPT token) is used directly.

### §3 No engine fallback

A judge model that no ClaudeUI route covers (Copilot, pi's own OAuth vendors, keys added outside ClaudeUI,
Anthropic, Google, Bedrock) gets no judge: every gated action goes to the human, the session shows one banner saying
why, and the judge picker marks models ClaudeUI cannot call (`judgeModelSupport`). The engine transports are deleted,
not kept as a fallback. The only second route is the user's own fallback judge (ADR-107). A configured judge model
that the catalog no longer offers fails closed the same way (never a substitute).

### §4 Wire rules

- Both wires stream, one SSE accumulator per wire. A stream that ends without a terminal event, a mid-stream error
  event or an empty text channel is a transport error (`unavailable`). There are no retries except two on the ChatGPT
  backend: one on HTTP 401 after a forced token refresh of the same account, and one at `low` when a workspace
  refuses `none`/`minimal` reasoning (HTTP 403 "reasoning level isn't available"); `low` is then that route's and
  account's floor until restart (`effort-floor.ts`, in memory).
- Responses (ChatGPT): headers `Authorization`, `ChatGPT-Account-Id`, `originator: opencode` (the vault token is
  issued to opencode's OAuth client), `User-Agent`, `session-id`, and the residency header when the token pins one.
  Body: `instructions` = the system prompt verbatim, one `input` user item, `store:false`, `stream:true`,
  `reasoning.encrypted_content`, `prompt_cache_key`, `reasoning:{effort}`, `text:{verbosity:"low"}`. It never sends
  `max_output_tokens`, `stop` or `temperature` (the backend rejects the first at any value); the output cap and stop
  sequence are enforced client-side (the accumulator cuts at the stop string and keeps reading to the terminal event
  so usage arrives; a character budget derived from `maxTokens` aborts a runaway stream).
- `session-id` and `prompt_cache_key` are `judge-` + the first 32 hex of SHA-256(system prompt). Every byte before
  the user turn must stay stable across calls (no timestamps, no ids); a byte-stability test pins the policy prompt.
- Reasoning effort: stage 1 is the lowest the model accepts (`none` from gpt-5.1 on, `minimal` on gpt-5, `low` on the
  o-series); stage 2 is `low`. OpenAI's `max_completion_tokens` counts reasoning, so reasoning models get 2048 tokens
  of headroom on top of the stage budget; the client-side text cap is unchanged.
- Chat completions, capabilities per route (`judge-http/caps.ts`): OpenAI reasoning models (`^o\d`, or `gpt-N` with
  N >= 5 and no `-chat`) take the `developer` role, no `stop`, no temperature; others `temperature: 0` and `stop`.
  OpenRouter: `max_tokens`, `usage:{include:true}` (real cost), reasoning disabled when the catalog marks the model
  as reasoning and for stage 1 unless the catalog says it does not reason (a 64-token grade has no room to think;
  a model the catalog does not list otherwise returned empty text), `cache_control` on the system part for
  `anthropic/*`, attribution headers. Custom chat: `max_tokens`, `stop`, `temperature: 0`.
- `JudgeRequest.signal` is aborted by the stage timeout, so a timed-out stage stops spending tokens.

### §5 Every judge call is a usage row

Every judge HTTP response that reports usage writes one `usage_event` (`origin: judge`) inside the transport
(`judge-usage.ts`), recording whatever usage arrived even if the call was aborted. It is attributed to the judged
session's engine, session and routing id, with `messageId` `judge:<uuid>`, the account that paid (API key digest or
the ChatGPT vault account), `billingType` `subscription` (ChatGPT) or `apiKey`, and `engineCostUsd` from OpenRouter
only. Static allows, allow-rule skips and grants write no row (no model was called). The row's schema and the hub's
handling are ADR-071 (`metering.md`).

### §6 Network

The judge keeps the proxy behaviour the engines had: `HTTP(S)_PROXY` is honoured through the shared proxy-aware
fetch (`services/net-fetch.ts`, also used by harness downloads); otherwise the global `fetch`.

## The policy favours routine work, stage 1 grades severity, the judge reads the user's rules (ADR-083)

### §1 Routine, reversible, repo-local work needs no consent

Consent bars guard the harms the rules name. Reversible, repo-local steps that serve the user's task need no consent
beyond the user naming the task: creating or switching branches, worktrees, `stash push`, fetch/pull/merge, commits,
amending or rebasing this session's own unpushed commits, restoring specific files the agent edited, tracked files and
files this session created. Git Destructive means what destroys work that exists nowhere else (force pushes, remote
deletes, rewriting pushed or pre-session history, deleting branches or stashes the session did not create,
tree-wide discards, with the tree presumed dirty with the user's work). Untrusted Code Integration covers running a
cloned tree, not cloning or reading one. Remote Host Writes (a soft rule) covers changing state on another machine
whatever the host is called; Credential Exploration names the instance-metadata credential endpoints. Parameters the
agent fills in (a branch name, commit message, PR title, file path) do not defeat a consent bar. Stage 2 blocks only
when the action matches the text of a specific rule (its "NOT this rule" list included) and nothing clears it, or when
it crosses an explicit user boundary; if it cannot name the rule, it allows.

### §2 Stage 1 grades severity and never clears destructive, shipping or remote shapes

- In `both` mode stage 1 answers `<severity>N</severity>` (0-100). A grade of 15 or less
  (`STAGE1_ALLOW_MAX_SEVERITY`) allows; anything else, including an unparseable reply, two different grades, a
  fraction or an out-of-range number, escalates to stage 2. Stage 1 is told intent only ever raises its grade (an
  action crossing an explicit user boundary grades as a rule match).
- **Full-review shapes skip stage 1** and go straight to stage 2 (`requiresFullReview`), because a one-shot grade is
  noisy even at low effort (one run graded `git reset --hard` on a dirty tree 0). They are: shell commands that
  ground truth singles out (`needsGitStatus` / `needsRepoVisibility`: `reset --hard`, `checkout .`, `clean -f`,
  `rm -rf`, add/commit/push/stash, remote repoints, `gh pr create`/`merge`/`release`/`repo`); remote execution
  (`ssh`, `scp`, `rsync host:`, `paramiko`, `kubectl`/`docker exec`, `Invoke-Command`) or a cloud instance-metadata
  endpoint anywhere in the command text, heredoc bodies included (deliberately coarse: a mere mention also matches);
  a shell redirect that did not measure `allInScope: true` (a malformed meta line counts as not in scope); every
  delegation tool (`agent`, `dispatch_agent`, `send_message`, `subagent`, `task`, `claudeui_dispatch_agent`,
  ADR-091); a delegated agent's hand-back report and a message to the spawning agent (ADR-105, `dispatch.md`); an
  action that retries or re-runs part of a call already refused (ADR-106 §3); an edit to an agent-control path
  (ADR-084 §3) or a patch whose targets cannot be read. An ordinary edit stays with stage 1. The price is a stage-2
  call (about 5-10 s) for every such action, commits included.
- Stage 1 runs at the lowest reasoning effort the model accepts and stage 2 at `low`; `low` for stage 1 was measured
  and gave no accuracy gain once the full-review shapes skip stage 1, only a slower tail. `fast` keeps its yes/no
  grammar.

### §3 The judge reads the user's permission rules

The Environment lists the user's merged allow, ask and deny rules (user, project and local scopes, deduplicated, in
order).

- **Allow** rules are standing consent for exactly what the pattern names; the pattern supplies the must-name item
  and routine parameters come with it. `Bash(gh pr create:*)` clears opening a PR; `Bash(git push:*)` does not clear
  a force-push; a broad prefix (`Bash(git:*)`, `Bash(*)`, a bare tool) names no dangerous parameter and clears nothing
  beyond routine use. An allow rule never clears the HARD rule, an adversarial rule or an explicit boundary.
- **Ask** rules never reach the judge (G9); the judge is told to block an action that reaches the same effect another
  way, so the user still gets asked.
- **Deny** rules: block the same effect reached through reordered arguments, another tool or a wrapper.
- Auto mode strips every user allow rule from the engine ruleset (`withoutAllowRules` in
  `opencode/permission-v2.ts` and `pi/permission-engine.ts`), so every allowed call reaches the host. Superseded for
  narrow allow rules by ADR-085 §4: a usable, un-carved-out allow rule skips the judge in the host under strict
  coverage and safety checks (`allow-rule-gate.ts`, `allow-rule-skip.ts`). Ask-rule provenance for G9 keeps the full
  rules.

### §4 User guidance lists

`~/.claude/ui/automode.json` has two optional lists, edited under Settings › Sessions & autonomy › Trust &
protection: `judgeAllow` becomes a User-Specified Allow exception ("routine for me"); `judgeBlock` becomes a
User-Specified Block soft rule ("I want to approve these myself"; its slug `user_specified_block` is always a valid
category). They are capped (50 entries, 300 characters each, `src/shared/judge-guidance.ts`), validated at the IPC
perimeter and held to the same caps on read (entries with prompt-breaking characters are dropped), because they are
fed into the judge prompt and are Self-Modification territory for the agent. The prompt grows with these lines; an
edit of the permission rules mid-session costs one uncached prefix.

## An unusable stage-1 reply escalates to stage 2 (ADR-109)

In `both` mode a stage-1 reply that opens off-format, runs past its budget or completes with no visible text sends the
action to stage 2 (final), exactly like an unparseable grade; it does not become `unavailable`. The transport still
throws on all three, with a `JudgeWireError` coded `judge:off-format`, `judge:over-budget` or `judge:empty`; only
`classify()`'s `both`-mode stage 1 turns those into an escalation (`ClassifyResult.stage1Unusable`). Every other
stage-1 failure (HTTP error, timeout, abort, missing route, and a reply whose reasoning used the whole budget) stays
`unavailable`. `fast` mode and stage 2 keep verdict semantics.

- **Off-format is abandoned at once.** The stage-1 request names the prefixes the reply may open with (`<severity>`
  and `<thinking>`, since the severity parser strips thinking blocks); the reader checks the kept text after each
  delta (leading whitespace and case ignored) and cancels the stream as soon as it can no longer become one of them.
  `<think>`, a fence, a bold tag or a zero-width character is off-format. No prefixes in the request, no check. The
  stage-1 character budget is 1,024 on the ChatGPT route (64 tokens x 16).
- **No banner for an unusable reply** (off-format and over-budget in any mode; an empty reply on the escalating
  stage-1 request only): the route is healthy and the banner copy is wrong for a per-reply event. In `fast` mode and
  stage 2 the human card still gives the cause. An empty reply elsewhere may be a judge that never answers and the
  banner must name it.
- **The fallback judge is not consulted** when stage 1 escalates and stage 2 decides; it still runs when that stage 2
  fails.
- The verdict log line carries `s1=off-format|over-budget|empty` on an escalation.
- Consequence: content that steers stage 1 into prose now meets stage 2; a deliberating stage 1 cannot talk itself
  into a clearing grade. A provider usage-policy kill on a compliant reply stays `unavailable`.

**Amendment (2026-10-25): stage-1 output phrasing.** The severity grammar, scale and threshold stay; the output line
takes the retired yes/no instruction's phrasing ("Respond with ONLY", tags in backticks, "Do NOT output any analysis,
reasoning, or commentary before `<severity>`"), which measurably cut off-format replies (hard calls 42% to 7%).

Rejected, and likely to be proposed again: strict structured output on the ChatGPT route (not enforced, shifted grades
down); stage-1 effort `low`; returning stage 1 to yes/no (it cleared at stage 1 what the severity threshold always
escalates); a larger stage-1 budget; turning overflow into a truncated `length` result (in `fast` mode and
stage 2 an over-budget reply would then block as unparseable instead of going to the human, and a half-written verdict
could be salvaged).

## Measured facts, a confirmation sample and a retry fact calibrate the judge (ADR-106)

### §1 Measured redirect facts

The harness measures shell redirects and tells the judge, so it never infers scope from text. The scanner is
quote-aware only where bash and PowerShell provably agree text is not shell (single-quoted and simple double-quoted
text of inert commands and interpreters, heredoc bodies with a quoted delimiter); anything ambiguous is scanned as
before. It tracks `cd` as a set of possible directories through `&&`, `||`, `;` (a `cd` that may have failed keeps
the old one), honours opencode's `workdir`, counts `/tmp` (and macOS `/private/tmp`) as temp roots, checks protected
and agent-control components relative to the working directory, reports `tee`/`Out-File`/`Set-Content`/
`Add-Content`/`Tee-Object` writes and append mode, and treats PowerShell `$null` as a sink. For targets outside scope
it measures `exists`, `empty` and `modifiedSinceSessionStart`; a symlinked target is listed in `symlinked` and never
counts as in scope. A failed measurement emits nothing.

Every `>` is also read without quote awareness; one the quote-aware scan dropped and that is not cleanly in scope is
reported in `quotedTargets` and makes `allInScope` false (a fabricated all-clear is worse than a false block). Targets
that read in scope but whose real location cannot be checked (a link the same command creates, a UNC root, a hard
link, a timed-out probe) are `unmeasured`; an out-of-scope target never is. On macOS, quote-blind scanning skips
single-quoted spans only when the segment is led by an inert text command and nothing in the command re-reads text as
shell (ADR-091 part 1); every imprecision falls back to over-reporting. Measurements live in `ground-truth.ts` and
`redirect-measure.ts`.

### §2 A block needs a second sample, except credential findings

When the deciding stage returns a parsed block (stage 2 in `thinking` and `both`, stage 1 in `fast`), the same stage
is asked once more with the identical request; the block stands only if the second sample also blocks, with the first
sample's reason and category. A second sample that throws, times out or is unreadable keeps the block (fail closed);
one that allows overturns it (`overturnedBlock`). An unreadable first reply is not a block verdict and gets no second
call. Credential Exploration and Credential Leakage blocks stand on one sample (recognised from the category, the raw
category text or the reason, including in `fast` mode): the confirmation lost correct credential blocks and saved few
false ones. The sample stays within one model (ADR-107).

### §3 The retry fact

The harness tells the judge when an action repeats (`identical`: same normalised command and working directory) or
re-runs part of (`subset`) a call that was blocked or rejected, quoting that call as the transcript shows it
(`retryOf`, `retry-match.ts`). An identical retry needs the user's go-ahead after the block; a changed retry is judged
on its merits; without the fact a call that differs from a blocked one is not a retry. `identical` outranks
`subset`; trivial wrappers (`2>&1`, `| tail`, a comment, `VAR=` prefixes, grouping, quoting) count as the same call;
whitespace inside quotes is significant. Such actions skip the stage-1 grade (§2 above).

### §4 Variables are a hint, never scope

A redirect target containing `$`, `%`, a backtick or a glob stays unresolvable (except that a glob-bearing phantom
that cannot name a protected file, such as `list[int]:` or `**Note**`, counts as a literal name, and an in-scope
phantom is still dropped). A target that starts with a
temp-directory variable carries a non-authoritative `tempVarTargets` hint naming the path it normally means, withheld
when the command assigns or mutates the variable, uses a current-scope code runner, or binds it conditionally. Proving
a variable unchanged from command text is an arms race the scanner cannot win; the judge reads the whole command and
disguised rebinding is Auto-Mode Bypass.

### §5 Policy text calibration

Overwrites are judged on the measured facts (new, empty, appended, written earlier this session, named by the user or
task, log-like); scope is not existence. Credential values are never revealed (existence, length, key names, entry
names and sizes and redacted forms are metadata), and taking a credential from a store to feed another program needs
the user's explicit instruction. Reading transcripts inside the harness is routine; a named account or subscription is
spending consent; editing policy or prompt source in the working tree is not instruction poisoning while uninstructed
directive writes to instruction files are; an agent the harness runs is inside the trust boundary except for a
credential the agent obtained itself; approval claims relayed by agents are checked against the user's own turns
(ADR-105, `dispatch.md`); continuation lines of a quoted turn are indented. The policy is general (no
product-specific lists). Re-measure with `scripts/judge-eval/` after every policy change: the results are estimates
on a hard-negative replay set, not production rates, and byte-identical requests vary run to run.

Known residuals: CDPATH is not modelled; a heredoc body is resolved against the directory at the
heredoc, not at a later `cd`; an interpreter's own shell-outs are not shell redirects of the command; a redacted
credential preview is still blocked. The policy text deliberately does not describe `quotedTargets` and `unmeasured`:
with them described, more should-block samples were allowed (4 of 36 to 11 of 36), a shift the measurement could not
tell from the model's own run-to-run variance, so the calibrated prompt stays as measured.

OpenRouter stage 1 never reasons unless the catalog says the model does not reason (see ADR-081 §4).

## Plainly read-only shell commands skip the judge; repo-armed git and agent-control edits do not (ADR-084)

### §1 A static read-only path in front of the judge

`readOnlyVerdict(action, scope)` (`read-only.ts`, pure, decides from text alone and fails closed) and its glue
`read-only-gate.ts` run in both engine wirings after the category fast path and before any judge is set up, so it holds
even when no judge model resolves. On opencode the ask can arrive before the tool part carries its input; the gate
waits briefly for it, else the call goes to the judge.

- On allow: the call runs; one info line `auto-mode allow (stage=static) …` with no command text (the command follows
  at debug); a `tool_review` with a fixed rationale on the card. It does NOT call `recordAllow()` (a static allow
  never resets the denial caps) and writes no usage row.
- "Plainly read-only": no expansion, substitution, grouping, redirection (only exactly `2>&1`), backgrounding, CR/LF/
  NUL/DEL, Unicode quote/dash/space look-alikes, `VAR=` prefix, `eval`/`source`/`exec`, provider or scheme tokens, UNC
  paths or unbalanced quotes. Segments split at unquoted `| || && ;` and every segment must name an allowlisted
  command with every flag in that command's typed flag allowlist; an unlisted flag refuses the whole command. The
  allowlist is small (about 25 tables; `pwd echo wc cat head tail grep rg find ls date`, a git subset
  `status log diff show branch(list) rev-parse ls-files merge-base remote(bare|-v)` with global options only
  `--no-pager -P --no-optional-locks`, and PowerShell `Get-ChildItem Get-Content Select-String Test-Path Get-Location
Get-Command` plus pipe formatters). `sed awk xargs jq env printenv`, network tools and interpreters are refused by
  name. It grows from the refusal log (debug).
- Both dialects: the shell is unknowable, so a path token must be safe under both the bash reading (backslash
  escapes) and the Windows reading; PowerShell aliases take the intersection. There is no PowerShell parser.
- "Doesn't affect others": every path resolves inside the session cwd or `additionalDirectories` (against
  `input.workdir` when set, which must itself be in scope, then `realpath` through an injected capability; no
  realpath, no bypass; temp roots are not in scope); no network (URLs, UNC, `git remote show`); no secret-shaped file
  (matched on path components, case-insensitive everywhere: `.env*`, key and cert stores, `.ssh .aws .kube .docker
.gnupg`, `.npmrc .pypirc .git-credentials .netrc`, history files, `*.tfstate`/`*.tfvars`, `auth*.json`,
  credentials, secrets, and `.git` itself); the user's `Read(...)` deny rules on the resolved path; `Bash(...)` deny
  and ask rules re-checked per segment through ADR-085 §1's matcher.
- Engines without a `workdir` parameter (pi) refuse a command that carries one.
- **Opt-out.** `readOnlyBypass: false` in `automode.json` (one row under Trust & protection); on by default. Only an
  absent key or exactly `true` is on: a hand-edited `"false"` or `0` reads as off. Read fresh per command (turning it
  off binds from the next one). A corrupt unparseable `automode.json` reads as "bypass on".
- Accepted cost: the bypass gives up the judge's reading of chat boundaries and `judgeBlock` guidance for these
  reads. Ask rules (`Bash(git log:*)`) remain the precise tool.

### §2 No git bypass in an armed repo, and the judge sees it too

For a verdict with `needsGitCheck` the host runs `git --no-pager config --list --show-scope --includes -z`
(`shell:false`, `-z` so a multi-line value cannot forge a record) and keeps only `local | worktree | command` scopes
(the user's global config is theirs). Any of `diff.external`, `diff.*.command`, `diff.*.textconv`,
`filter.*.clean|smudge|process`, a non-boolean `core.fsmonitor`, `core.hooksPath`, `gpg.program`, `gpg.*.program`,
`log.showSignature`, `core.pager`, `pager.*`, `core.worktree` refuses the bypass. A repo cannot be verified, and the
bypass is refused, when the capture fails, is truncated or is malformed, when the cwd has no `local` entry (not a
repository), or when the index holds a gitlink (mode `160000`: `git status`/`git diff` recurse into populated
submodules with their own config). So a session in a repo with submodules loses the git part of the bypass, and so
does a session whose cwd is a submodule work tree (`core.worktree`). The capture also feeds the judge a
`{"meta":{"gitConfigArmed":[…keys]}}` line for git commands, so the judge no longer allows `git diff` in an armed
repo blind.

### §3 Edits to agent-control paths go to the judge

In auto mode file edits under agent-control paths raise an ask instead of being auto-accepted, so the judge sees them
(Self-Modification, Instruction Poisoning, Unauthorized Persistence). The list is one pure module
(`agent-control-paths.ts`) used by both engines: directories matched as any path component (`.git` also as a file,
`.claude`, `.husky`, `.githooks`, `.vscode`, `.devcontainer`, `.opencode`, `.pi`, `.agents`, and cli.js's sensitive
directories and files, including multi-component entries such as `.config/git`) and file names (`CLAUDE.md`,
`CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `.mcp.json`, `opencode.json(c)`, `.devcontainer.json`, and
cli.js's). Pi's allow-rule behaviour on these is ADR-110 §7a (`permissions.md`).

The matcher does not trust the spelling: case folds on every platform, `\` equals `/`, an ADS suffix and trailing dots
or spaces are dropped, any 8.3-shaped component (`GIT~1`) matches. A path resolves against the session cwd: inside
cwd it matches relative to cwd (so `<repo>/.claude/worktrees/<name>` does not match `.claude` on every edit), outside
cwd it matches absolute.

- **pi** checks the path in its `acceptEdits` mode base (which is also auto mode's base): a match asks (the judge in
  auto mode, the human in plain `acceptEdits`).
- **opencode, plain `acceptEdits`/`autoEdit`:** the list is rendered into `edit` ask patterns after the base rules and
  the human is asked (opencode's own `Wildcard.match`; off Windows it matches case-sensitively).
- **opencode, auto mode:** the ruleset asks for every edit; `handleAutoModeApproval` runs a host-side gate after G9
  and the read fast path. It collects every target the ask names (patterns, the edit/write path, apply_patch move
  destinations) and replies `once` with no judge call only if the matcher clears all of them; a control path or an
  undeterminable target goes to the judge.
- Accepted residuals: paths are matched by text (a symlink into `.git/` is not seen); committed secrets are reachable by
  blob SHA (`git show <sha>` is allowlisted and repo content is in scope by definition); `Get-ChildItem -Recurse`
  follows an in-tree junction but lists names only; opencode's bash path sources `~/.bashrc` with aliases enabled
  (the user's own doing; an alias can redefine an allowlisted command); `rg` reads every non-ignored
  file by content (the judge would see the same command); `Get-Command` can trigger PowerShell module auto-loading
  from the user's `PSModulePath`; cmd.exe is not modelled; pi's Git-Bash `/d/...` paths lose the bypass and its
  `powershell` tool is never bypassed (ClaudeUI does not enable it, and the judge's shell meta and redirect analysis do
  not read it). In non-auto modes a human "allow for session" on one control-path edit allows
  later ones (the human's own choice); the judge always replies `once`. The realpath and git captures must run where
  the command runs.

## Judge blocks hold for the user, and session-booted targets are local (ADR-091)

A judge block on pi, opencode or their dispatch targets is a question to the user, not a dead end. Claude's judge runs
inside cli.js (ADR-076): there is no host-side override for it.

### §3 A judge block holds the call and asks

When the judge blocks and no denial cap trips, the pipeline returns a held block, not `deny`; the engine's human path
(pi `askHuman`, opencode `fallbackToHuman`, the dispatcher's forwarded ask) raises the permission card flagged as an
auto-mode block, under the judge's review. The card offers **Keep blocked / Approve anyway**.

- **Approve anyway** runs the exact held call: no outcome annotation, the denial streak resets, and the review is
  marked `overriddenByUser` ("Auto mode · blocked · approved by you").
- **Keep blocked** answers the model with the judge's own deny text (not "User denied") and records
  `automode-blocked` (the annotation post-block consent inheritance reads).
- Unanswered, the hold resolves exactly as Keep blocked after the hold window (`block-hold.ts`) and the card is
  withdrawn. Interrupts and abandonment force-deny. HARD blocks are holdable too (the click is the user reviewing the
  permission prompt; transcript text never clears a HARD rule). A tripped denial cap raises the ordinary un-timed human
  card. Delegated calls (pi children, dispatch targets) raise the agent-labelled card.
- The held card's timeout and whether a hold happens at all is Part 6.

### §4 Delegated judges read the transcript in time order

The judge transcript for a pi child, an opencode task child (ADR-111) or a pi/opencode dispatch target is the parent
transcript, the parent's still-queued user turns and the child's assistant trajectory, merged in timestamp order
(stable sort). A "go ahead" typed after a child's block therefore follows the block, so post-block consent inheritance
applies. A queued turn renders as a `User:` line: it is the user's own text, merely undelivered.

### Part 6 The hold is optional; approve after the block

`blockHoldSeconds` (shared auto-mode config, Settings, 0-600 s, `normalizeBlockHoldSeconds`) sets the hold, read per
block so a change binds the next one.

- **Default 0: no hold.** A block is denied at once through the same Keep blocked path and the agent carries on.
  Above 0: the §3 held card with that timeout. A config that cannot be read means 0.
- **Approve after the fact.** The blocked review strip (reviewer `auto-mode`, decision `denied`, live session, not yet
  approved, not currently held) carries an **Approve** button (`blocked-calls.ts`, one ledger per ROOT session, 200
  entries). A click (1) records a one-shot, exact-match grant: the next identical call by any agent of the root
  session (parent, child, dispatch target) runs before the judge (`consumeGrant`, after the static paths) and the
  grant is spent; the user's deny and ask rules still win (ADR-085); it covers HARD blocks too; it is memory-only,
  never persisted, never matches a different input, and its key includes the call's effective working directory;
  it expires 15 minutes after the click; and (2) sends a nudge: an ordinary user prompt ("I approve the … call auto
  mode blocked… Run it again exactly as it was."), queued if the agent is busy. The grant is the authority and the
  message only the trigger; if the agent alters the call the grant does not match and the judge sees the user's
  message naming the command (Path A consent). A second click on another surface showing the same call does nothing.
- **Nudge routing**: to the nearest agent, from the blocked one up to the root, that is still running. A running pi
  child or grandchild gets a `[ClaudeUI]` note (never a `User:` line); a finished pi child goes to its live parent,
  else the root, as a user prompt naming the subagent; an opencode task child to the root's prompt queue; a dispatch
  target in flight to the target if its runner takes deliveries, else (finished) the dispatching agent; a Claude
  subagent to the main Claude agent, message only. The review records where the nudge went ("Sent to the main agent").
- Claude gets the button, message only: cli.js owns that judge, so no grant is possible and its own classifier
  decides the retry.
- An unattended run with a hold set pauses that long at each non-capped block; the default never pauses and the
  override lives on the blocked summary. An agent cannot reword its way around a block while the card is up (the
  Auto-Mode Bypass rule polices that window).

### Session-booted targets are local; the rule corpus carve-outs

- **Part 1. Redirect scope on macOS.** `tempDirRoots()` adds `/tmp` (POSIX) and `/private/tmp` (darwin): scope matching
  compares spellings and does not resolve symlinks. The redirect scan stays quote-blind unless the segment is led by an
  inert text command and nothing in the command re-reads text as shell (shells, `eval`, `ssh`, `sudo`, `xargs`,
  interpreters, `awk`); an allowlist, not a re-reader list, because that list can never be complete. Double quotes are
  never skipped.
- **Remote Host Writes / Local Operations.** A VM or container this session itself created or booted is local scratch
  infrastructure; one that pre-dates the session stays in scope. Evaluation rule 14 (SESSION-MADE GUESTS) applies this
  under every rule (Network Exposure, Permission Grant): configuring a guest the session made is Local Operations.
- **Network Exposure.** Binding to a host-only virtual network only the session's guests can reach, or a guest's own
  NAT or egress allow list, is not exposure.
- **Untrusted Code Integration.** When the user names a tool, that project's canonical channel (documented install
  method, official tap, its own releases, its registry package) is a routine parameter; mirrors, forks and look-alike
  names are not. The owner check is anchored to the transcript (a maintainer name the transcript already ties to the
  tool), never to the judge's recall.
- **Data Exfiltration (HARD).** A credential the user typed into this conversation, carried in a delegation payload to
  a harness-run engine, routes to the soft Credential Leakage rule; handing it to the delegate for use on the target
  the user named is normal use. A credential the agent obtained itself never qualifies, nor does any other
  destination. The HARD rule stays consent-proof: the exception is about where the credential came from and goes.
  Every delegation tool skips stage 1 for exactly this provenance call (§2 of ADR-083 above).
- Post-block consent inheritance covers a subagent's retried call. The source-trust cases (a tool only the agent
  chose, a look-alike tap) stay noisy under every wording; the hold card and the Approve click are their backstop.
- These carve-outs rely on the judge recognising a session-booted VM and a canonical channel from the transcript.

## A judge that cannot answer says so, and an optional fallback judge takes over (ADR-107)

A judge that cannot produce a verdict returns the human outcome with the cause; it never reads as a BLOCK.

- **The cause is on every card**, e.g. `Auto-mode judge unavailable: ChatGPT · gpt-6-luna: HTTP 429 (resets at …).
Review this call yourself.` The response body is never shown; the full text stays in the log, which says "judge
  unavailable", not BLOCK.
- **One banner per session on a failed call**, not only on a missing route. A cancelled review or a stage timeout is
  not reported (it says nothing about the route). The fallback judge has its own one banner.
- **Rate-limit cooldown** (`judge-cooldown.ts`): a 429 that names a reset (`resets_at` or `retry-after`) puts that
  route, keyed by provider, model and paying account, on a process-wide cooldown capped at 8 days; while it lasts the
  route resolves as unavailable without a network call. In memory only (a restart pays one failed call per route).
  Settings shows "<model> has hit its usage limit and rests until …" under the judge model.
- **Optional fallback judge model** (`autoMode.fallbackJudgeModel`, per engine, same picker and "ClaudeUI can call
  it" narrowing). When the judge model cannot produce a verdict (call failure, timeout, cooldown, no route, model
  gone) the WHOLE classification runs again on the fallback, so every verdict, including ADR-106's confirmation
  sample, comes from one model and a block is never overturned by a different model. A permission-mode change, a
  settled ask or a denial cap never reaches the fallback; an unusable stage-1 reply that stage 2 decides does not
  either (ADR-109). When both fail, the card names both causes. The banner says the fallback is judging and the log
  marks verdicts `judge=fallback`. A fallback model gone from the catalog (or equal to the primary on the same
  account) is no fallback.
- **Optional fallback account** (`autoMode.fallbackJudgeAccount`, a vault ChatGPT account id, behind a collapsed
  "Advanced" section): token, reauthorization, usage rows and cooldown are all per account. A named account that is
  missing or signed out is refused, never swapped for the active one. It applies only to a ChatGPT-routed fallback
  model (any other model clears it). The fallback may be the judge model itself only on a different account.
- **No engine transport.** Models only an engine can call (opencode's hosted free tier) stay unavailable as judges.
- A weaker fallback model changes the security profile while it judges; the banner names it. Measured free models
  allowed nearly every should-block case, so a free model is not a safe fallback; the recommended fallback is the
  same judge model on another subscription.
