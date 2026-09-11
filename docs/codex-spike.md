# Codex executable spike

This is an isolated protocol experiment, not a product integration or an ADR.
The Python stdlib runner in `scripts/probe-codex.py` drives the official Codex
app-server over JSONL stdio. A loopback HTTP server returns synthetic Responses
API SSE fixtures. No real model, login, token refresh, or external-token auth
flow is used.

Phase 1 accepts **Codex native approvals**. Shared permission rules and classifier
parity are deferred to a later fork and patch. These results do not establish
shared Auto parity, nor do they propose silently mapping shared modes onto Codex
policies.

## Findings

The executable supports the main transport and persistence paths in this fixture.
One cancellation gap matters for any later adapter: pending dynamic tool requests
are not resolved like native approval requests.

| Probe                             | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable initialization             | Succeeds. Supplying `thread/start.dynamicTools` without experimental capability returns `-32600`, explicitly naming the required capability. A normal thread still starts.                                                                                                                                                                                                                                                                                                                           |
| Experimental initialization       | Succeeds with `capabilities.experimentalApi: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unauthenticated account           | With the built-in OpenAI provider selected and no auth file, `account/read` with `refreshToken: false` returns `account: null`, `requiresOpenaiAuth: true`. No model request occurs.                                                                                                                                                                                                                                                                                                                 |
| Locally configured provider       | The same account read returns `account: null`, `requiresOpenaiAuth: false`. Threads and turns run against the loopback provider without a credential.                                                                                                                                                                                                                                                                                                                                                |
| Streaming and reasoning           | Emits `item/agentMessage/delta`, reasoning summary part and text delta notifications, item completion, and turn completion. This tests synthetic reasoning summaries, not hidden reasoning or model quality.                                                                                                                                                                                                                                                                                         |
| Hosted dynamic tool               | Emits `item/tool/call` with thread, turn, call ID, tool name, and arguments. A client JSONL response containing `contentItems` and `success: true` reaches the next Responses request as `function_call_output`. The completed live tool item retains its result.                                                                                                                                                                                                                                    |
| Inline image result               | `inputImage` plus an inline PNG `imageUrl` reaches the model request as `input_image` with the same data URI. Mixed text and image output works. No remote image is fetched.                                                                                                                                                                                                                                                                                                                         |
| Steering                          | A correct `expectedTurnId` accepts input into the active turn while a dynamic tool is pending. The emitted user item has the exact requested `clientId` and content, matches the owning thread and turn, and survives unchanged in history. History contains exactly one turn. Wrong turn IDs and no-active-turn requests explicitly assert `-32600`; rejected text is absent from history.                                                                                                          |
| Pending dynamic call interruption | The turn completes as `interrupted`, but no matching `serverRequest/resolved` arrives within two seconds. No completed dynamic item is observed. The interrupted call is absent from immediate and cold `thread/read` item lists.                                                                                                                                                                                                                                                                    |
| Late dynamic response             | Sending the old request ID's result after interruption creates no model request during a 300 ms observation window. The result is absent from history and the next model request, both asserted. A subsequent account RPC and a new turn still succeed. This is a bounded observation, not an indefinite no-op guarantee.                                                                                                                                                                            |
| Cold read and resume              | After terminating the app-server and starting a new process with the same isolated `CODEX_HOME`, all completed-turn items match the pre-restart `thread/read` exactly, including IDs and dynamic-tool result fields. IDs also match the earlier live completion notifications.                                                                                                                                                                                                                       |
| Dynamic definition persistence    | Cold `thread/resume` without resupplying tools retains the original definition. The model receives it and can invoke it again. `ThreadResumeParams` has no dynamic-tool override; this does not test replacing an existing definition.                                                                                                                                                                                                                                                               |
| Fork                              | `thread/fork` with a completed first turn's `lastTurnId` produces a distinct thread containing exactly that turn, even though the source has a later turn. Running a new fork-only turn leaves the source's turns unchanged.                                                                                                                                                                                                                                                                         |
| Native command denial             | Native `untrusted` policy emits `item/commandExecution/requestApproval`. Replying with `{"decision":"decline"}` prevents a temporary sentinel from being created.                                                                                                                                                                                                                                                                                                                                    |
| Native command acceptance         | Replying with `{"decision":"accept"}` allows `exec_command` to write and read its temporary sentinel. The command completes with exit code 0 and output `spike-native`. Both native decision paths emit `serverRequest/resolved`.                                                                                                                                                                                                                                                                    |
| Native queue                      | Adding input while a dynamic tool is pending leaves one queued entry. Explicit queue start while active asserts rejection with `-32600`. After completion, auto-start is observed at the queue read following a 300 ms wait; the distinct turn preserves its client ID and was not injected into the first turn. This is a bounded check, not an auto-start latency guarantee. If not observed, the runner retains explicit-start fallback for investigation but reports `observed-gap`, not `pass`. |
| Native child                      | The report explicitly records `multi_agent_v1`. Its namespaced `spawn_agent` call creates a child using inherited local-provider settings. Parent collaboration items identify the child; child text and turn notifications arrive on the same stdio connection. Filtered listing and reading recover its parent relationship and completed output. This does not verify v2 ownership/control or automatic subscriptions for other child modes.                                                      |

The interrupted dynamic call's missing terminal item is separate from the
completed-turn fidelity result. An adapter cannot assume every `item/started`
has a matching `item/completed`, or that every server request receives a
`serverRequest/resolved`. It would need to cancel locally pending work when the
owning turn terminates. Persisting that interrupted call for a full transcript
would require adapter-side records or a Codex change; the tested `thread/read`
does not reconstruct it.

The report separately records `completedToolItemPresent`,
`immediateInterruptedToolPresent`, and `interruptedToolPresentInColdRead`.
The interruption probe reports a gap if either request resolution or the
completed dynamic item is missing at its bounded post-interrupt check. Completed
turn fidelity remains a separate check from interrupted-tool presence.

The denial response is named `decline` in Codex's protocol. This binary accepts
it, although the tested approval request's `availableDecisions` lists `accept`,
an execpolicy amendment, and `cancel`, not `decline`. A later UI should respect
the advertised choices rather than infer them from this one successful probe.

The native queue result must not be conflated with the application's submission
queue. Phase 1 will retain the application's held queue rather than use the
native queue; the experiment only establishes the native behavior described above.

The actual returned threads identify their `historyMode` as `paginated`, including
the successful cold read and resume. This contradicts the public guide consulted
during the initial evaluation, which described paginated creation and full-history
resume as unsupported. Use the pinned binary's behavior and generated schema for
implementation; this small-history probe does not establish large-history paging
behavior.

## Native approval surface probe (2026-09-11)

A second, repo-resident probe of the same pinned `0.154.0` binary, this time
asking only one question: which `(approvalPolicy, sandboxPolicy)` pair routes a
server-to-client approval request, and what the request carries. The probes live
in `src/integration/codex/codex-policy-probe.integration.test.ts` and run with
`CODEX_INTEGRATION=1 bun run test:integration src/integration/codex`. Thirteen
probes, all passing, each assertion pinning an observed value. Facts only; no
adapter decision is made here.

Every probe drives one scripted turn whose model output requests, in order, a
read-only shell command (`ls`), a shell write inside the workspace, a shell
write outside it, an `apply_patch` inside the workspace, an `apply_patch`
outside it, and `curl http://127.0.0.1:1/`. Approval replies are `accept` unless
a probe says otherwise. `approvalPolicy` and `sandboxPolicy` are per-turn
overrides on `turn/start`, because `thread/start` only accepts a `SandboxMode`
string and cannot express `writableRoots`.

### What fires

`cmd` is `item/commandExecution/requestApproval`, `patch` is
`item/fileChange/requestApproval`. "up front" means the request arrived with
`reason: null`, before anything ran. "after failure" means it arrived with
`reason: "command failed; retry without sandbox?"`, after a sandboxed attempt
had already been made.

| approvalPolicy                 | readOnly                                              | workspaceWrite (writableRoots = cwd)                                                       | dangerFullAccess     |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| `untrusted`                    | all 6 asked up front (4 `cmd`, 2 `patch`)             | all 6 asked up front                                                                       | all 6 asked up front |
| `on-request`                   | 4 commands silent; both `patch` asked up front        | 4 commands silent; in-cwd `patch` asked after failure, outside-cwd `patch` up front        | nothing asked        |
| `never`                        | nothing asked                                         | nothing asked                                                                              | nothing asked        |
| `granular` (all five flags on) | 4 commands asked after failure; both `patch` up front | 4 commands asked after failure; in-cwd `patch` after failure, outside-cwd `patch` up front | nothing asked        |

On every command request observed, under any policy, `availableDecisions` is
exactly `["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]`.
`decline` and `acceptForSession` are in the wire type and are never advertised.
File-change requests carry no `availableDecisions`, no `kind` and no `grantRoot`
at all, so a client has nothing to render but accept or reject.

### Answers

| Question                                                                                    | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Which commands does `untrusted` run without asking?                                      | None. `ls`, `cat inside.txt`, `pwd`, `git status`, `echo hi` and `rg x .` each produced an approval request. The pinned binary ships no built-in trusted list that bypasses `untrusted`. `commandActions` classifies them coarsely: `listFiles`, `read`, `unknown`, `unknown`, `unknown`, `search` respectively, so `pwd`, `git status` and `echo hi` are indistinguishable on that field.                                                                                                                                                                 |
| B. Is there a setting that asks before every command and every file change, reads included? | Yes, `untrusted`, under all three sandbox policies. It is the only policy that asks before execution rather than after a sandbox failure. `granular` with `sandbox_approval`, `rules`, `skill_approval`, `request_permissions` and `mcp_elicitations` all `true` asks for commands only after the sandboxed attempt failed, so it cannot vet a command up front.                                                                                                                                                                                           |
| C. Under `workspaceWrite`, do in-cwd file changes ask?                                      | Not on policy grounds. The in-cwd `apply_patch` request arrived with `reason: "command failed; retry without sandbox?"` under both `on-request` and `granular`, meaning Codex attempted it sandboxed first and only escalated because that attempt failed. The failure is the fixture's (see limits below), so natively this is a silent apply. The outside-cwd `apply_patch` asked up front (`reason: null`) in the same turn, which is the contrast that makes the reading safe.                                                                         |
| D. How far does `acceptForSession` reach?                                                   | One command string. Replying `acceptForSession` to `echo one` suppressed the ask for a second, identical `echo one` (which then ran, exit 0) and did not suppress the ask for `echo two`.                                                                                                                                                                                                                                                                                                                                                                  |
| E. Must `approvalsReviewer: 'user'` be set explicitly?                                      | No. With no `approvals_reviewer` line in `config.toml`, `thread/start` reports `approvalsReviewer: "user"` and an `untrusted` command still reached the client. The same response echoes `approvalPolicy` and the legacy `sandbox` field; `activePermissionProfile` is `null`, so that field carries no provenance here.                                                                                                                                                                                                                                   |
| F. What does `thread/settings/update` return, and is it honoured?                           | It returns `{}`. The applied settings come back only on a `thread/settings/updated` notification carrying the full `ThreadSettings`, and that notification is not ordered against the RPC reply: reading the notification list immediately after the reply finds nothing, so a client has to wait for it. The update is honoured. After switching a thread from `on-request`/`readOnly` to `untrusted`/`dangerFullAccess` mid-thread, the next turn (with no per-turn override) asked for its command and the accepted write landed outside the workspace. |

### Other observations

An accepted command runs unsandboxed. Under `untrusted` plus `readOnly`, `ls`
exits 0 and both the in-cwd and outside-cwd writes land. Approving is a
full-access grant on this wire; there is no "approve but keep it sandboxed"
decision.

`on-request` gates exactly one thing, the model setting
`sandbox_permissions: "require_escalated"`. That request arrives with the
model's `justification` as its `reason`. Under `never` the same escalation never
reaches the client, nothing runs, and the model is told:

```text
approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never
```

`decline` is honoured on both the command and the file-change paths despite
never appearing in `availableDecisions`, and leaves no file behind. A declined
command reports no exit code back to the model.

`proposedExecpolicyAmendment` is argv, and any redirection drags the wrapper in:
`echo x > <cwd>/inside.txt` proposes
`["/bin/zsh", "-lc", "echo x > <cwd>/inside.txt"]`, a rule that cannot match a
second time. Plain commands propose the whole argv including arguments, so
`git status` proposes `["git", "status"]`, not `["git"]`.

`item/permissions/requestApproval` is unreachable by default. It requires the
`request_permissions` tool, which appears only with the under-development
`request_permissions_tool` feature enabled (the binary warns about it on
startup). Its request carries `permissions`, `cwd` and `reason` and no
`availableDecisions`; the reply is a granted profile plus a `turn` or `session`
scope rather than an accept/decline. The requested profile arrives in two
representations at once, a legacy `{read, write}` pair and an `entries` array.

The tool surface is `exec_command`, `write_stdin`, `request_user_input`,
`view_image`, `multi_agent_v1`, `get_goal`, `create_goal`, `update_goal`. There
is no `shell` tool (a `shell` call is answered `unsupported call: shell`) and no
`apply_patch` tool. File changes reach `item/fileChange/requestApproval` only
because Codex intercepts an `apply_patch` heredoc inside an `exec_command`
payload. The set did not change with `apply_patch_freeform = true` or with a
catalog model slug in place of `mock-model`.

### What the fixture cannot express

macOS lets a process re-apply the same seatbelt profile but refuses a different
one, however permissive either is: `sandbox-exec -f a.sb sandbox-exec -f b.sb
/bin/echo` fails with `sandbox_apply: Operation not permitted` and exit 71. The
fixture wraps every spawn in `sandbox-exec` for containment, so any command
Codex decides to run sandboxed dies at exit 71 before touching the filesystem.
The last probe in the file pins this directly.

The consequence is that the approval dimension is measurable and the
sandbox-enforcement dimension is not. Whether Codex's own `readOnly` or
`workspaceWrite` profile would have blocked a given write cannot be observed
here, and any approval request whose `reason` is the retry prompt exists only
because the nested profile failed. Requests with `reason: null` are unaffected,
since Codex decided to ask before running anything.

Also not expressed: `item/tool/requestUserInput`, MCP elicitations, skill
approvals, the `rules` half of `granular` (no execpolicy rules were configured),
`approvalsReviewer: "auto_review"` and `"guardian_subagent"`, named permission
profiles via `permissions`, network approvals through a managed proxy (the
`curl` step reached a closed local port and exited 7 rather than being gated),
and `apply_patch` as a first-class tool.

## Native reviewer and judge-thread probe (2026-09-11)

A third probe of the same pinned `0.154.0` binary, asking three questions the
approval-surface probe left open: what `approvalsReviewer: "auto_review"` does on
the wire, whether that reviewer honours a rule set, and how toolless a judge
thread can be made. The probes live in
`src/integration/codex/codex-auto-review-probe.integration.test.ts` and run with
`CODEX_INTEGRATION=1 bun run test:integration src/integration/codex`. Twelve
probes, all passing, each assertion pinning an observed value. Mechanism claims
are cited to the pinned source at `.cache/codex-src` (tag `rust-v0.154.0`); every
one is confirmed at runtime by a probe. Facts only; no adapter decision is made
here.

The turn each auto-review probe drives is four steps chosen to be gated
deterministically under `on-request`: one `exec_command` carrying
`sandbox_permissions: "require_escalated"`, then three `apply_patch` heredocs (in
cwd, outside cwd, in cwd again). A plain command is deliberately absent, for the
reason in "What the fixture cannot express" below.

### Q1. `approvalsReviewer: "auto_review"`

| Question                                                        | Observed                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does any `requestApproval` still reach the client?              | No. Under `on-request` and under `granular`, `clientCalls` is empty for all four steps. The reviewer replaces the client entirely, and there is no copy, no notification of the request, and no way to intervene.                                                                                                                                                               |
| What arrives instead?                                           | `item/autoApprovalReview/started` and `item/autoApprovalReview/completed`, one pair per gated action, plus one `guardianWarning` per decision. None of the three has a generated type in `src/core/codex/protocol/v2/`.                                                                                                                                                         |
| What do those notifications carry?                              | `threadId`, `turnId`, `reviewId`, `targetItemId` (the tool call id), `startedAtMs`/`completedAtMs`, `decisionSource` (`"agent"`), `review: {status, riskLevel, userAuthorization, rationale}`, and `action`. `action.type` is `"command"` (with `source`, `command`, `cwd`) or `"applyPatch"` (with `cwd`, `files`).                                                            |
| Any reviewer/subagent item, `collabAgent*`, `multi_agent` item? | No. `item/started` / `item/completed` carried only `userMessage`, `commandExecution`, `fileChange` and `agentMessage`. The reviewer thread produces no thread item and no child in the parent's item stream.                                                                                                                                                                    |
| Does the reviewer call the model?                               | Yes, once per review, on the SAME provider as the agent. `client_metadata` marks it: `x-openai-subagent: "guardian"`, `subagent_kind: "guardian"`, `thread_source: "guardian_review"`, its own `thread_id` with `parent_thread_id`/`parent_turn_id` pointing at the agent, and `auto_review_enabled: false` on its own turn (no recursion).                                     |
| On which model?                                                 | Not necessarily the one selected. `model-provider/src/provider.rs` sets `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL = "codex-auto-review"`; `core/src/guardian/review.rs` uses that slug when the offline catalog lists it, else the ACTIVE model's resolved slug. In the fixture the reviewer ran on `gpt-5.6-luna` for BOTH an active `gpt-5.6-luna` and an active `mock-model`. |
| Does the reviewer's verdict control execution?                  | Yes. `{"outcome":"allow"}` ran all four actions and every artifact landed, the escalated write outside the workspace included. A `deny` verdict ran nothing and left nothing behind. The reviewer is an authority, not an advisory layer.                                                                                                                                       |
| Does `guardian_subagent` differ?                                | No. `protocol/src/config_types.rs` declares `ApprovalsReviewer` with two variants and `#[serde(rename = "auto_review", alias = "guardian_subagent")]`; the three-value string in the generated TS type comes from a hand-written `JsonSchema` impl. The probe confirms it: same four reviews, same notifications, same artifacts.                                               |
| Does it work on a model with no catalog entry?                  | Yes. `core/src/guardian/reviewer_config.rs` falls back to `BUNDLED_GUARDIAN_POLICY_TEMPLATE` (`core/assets/guardian/policy_template.md`) when the review model's catalog metadata has no `auto_review.policy_template`. With `mock-model` active, four reviews still ran; the only difference on the wire is the `Model metadata for \`mock-model\` not found` warning.         |
| Which approval policies route to it?                            | `on-request` and `granular` only. `core/src/guardian/review.rs` `routes_approval_policy_to_guardian` matches `OnRequest \| Granular(_)` and `ApprovalsReviewer::AutoReview`. Under `untrusted` the probe saw zero reviewer calls and all four requests on the client, so "ask before everything" and "decide automatically" cannot be combined.                                 |
| What is the reviewer's own sandbox and tool set?                | Read-only, code-mode. Its request advertises `functions.exec` and `functions.wait`, `reasoning: {effort: "low", context: "all_turns"}`, `tool_choice: "auto"`, and a developer message stating `sandbox_mode` is `read-only`, approval policy `never`, and "Do not provide the `sandbox_permissions` for any reason".                                                           |
| What does it see?                                               | The full agent transcript between `>>> TRANSCRIPT START` / `END`, labelled untrusted evidence, then the planned action as JSON between `>>> APPROVAL REQUEST START` / `END` (argv, cwd, tool, tty, `sandbox_permissions`, `justification`). Its system prompt is an 18,446-char developer message, not `instructions`, which is absent on a code-mode model.                    |

Failure modes, observed:

| Input                                   | Observed                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three consecutive `deny` verdicts       | A circuit breaker fires and interrupts the turn: three of the four steps were reviewed, then `guardianWarning` reported `rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.` It arrives on the same channel as every other decision. |
| A final message that is not strict JSON | Fail closed, after THREE provider attempts per review (12 calls for 4 reviews). Each review completed `denied`, `riskLevel: "high"`, rationale `Automatic approval review failed: guardian assessment was not valid JSON`. The breaker did NOT fire, so it counts deny VERDICTS, not review failures. |
| Either denial, as the model sees it     | `exec_command failed: CreateProcess { message: "Rejected(\"This action was rejected due to unacceptable risk.\nReason: <rationale>\nThe agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. …\")" }`, with no exit code.                  |

### Q2. Does the native reviewer honour a rule set?

`core/src/exec_policy.rs` `load_exec_policy` walks the config layers
low-to-high and parses every `*.rules` file in `<layer config folder>/rules/`
(`RULES_DIR_NAME = "rules"`, `RULE_EXTENSION = "rules"`). Files are Starlark;
`prefix_rule` / `network_rule` / `host_executable` are defined in
`execpolicy/src/parser.rs`. `Decision::{Forbidden, Prompt, Allow}` map to
`ExecApprovalRequirement::{Forbidden, NeedsApproval, Skip}`.

| Rule set at                                                | `prefix_rule(pattern=["echo"], decision=…)` | Observed for `echo hi` (with `ls` as the unruled control in the same turn)                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$CODEX_HOME/rules/fixture.rules` (user layer)             | `forbidden`                                 | Not asked, never ran, no exit code. Model told `` `/bin/zsh -lc 'echo hi'` rejected: policy forbids commands starting with `echo` ``. `ls` still asked.                              |
| `<cwd>/.codex/rules/fixture.rules`, untrusted              | `forbidden`                                 | NO EFFECT. Asked, accepted, ran, exit 0. An untrusted project layer is disabled and `layers_low_to_high` skips disabled layers (`config/src/state.rs`), so it contributes no rules.  |
| `<cwd>/.codex/rules/fixture.rules`, trusted                | `forbidden`                                 | Blocked, identically to the user layer. Trust comes from `[projects."<path>"] trust_level = "trusted"` in `config.toml`.                                                             |
| `$CODEX_HOME/fixture.rules` (control, no `rules/`)         | `forbidden`                                 | Ignored. Asked, ran, exit 0. The file must sit in a `rules/` directory under the layer's config folder.                                                                              |
| `$CODEX_HOME/rules/fixture.rules`                          | `allow`                                     | Not asked, ran. A rule file widens permissions as readily as it narrows them (`Decision::Allow` sets `bypass_sandbox`).                                                              |
| `$CODEX_HOME/rules/fixture.rules`, `auto_review`           | `forbidden`                                 | Blocked with ZERO reviews and zero reviewer provider calls. The rule decides before the reviewer, which cannot override it because it is never asked.                                |
| `$CODEX_HOME/rules/fixture.rules`, `auto_review`           | `prompt`                                    | Routed TO the reviewer: one review, `approved`, one provider call. The approved command then ran SANDBOXED (exit 71), unlike a user `accept`, which runs unsandboxed.                |
| `$CODEX_HOME/rules/fixture.rules`, `granular.rules: false` | `prompt`                                    | Local deny, not a skip: not asked, never ran, model told `approval required by policy rule, but AskForApproval::Granular.rules is false`. The flag suppresses the ASK, not the RULE. |

Not a rule source, confirmed at runtime: a `[rules] prefix_rules = […]` table in
`config.toml`, a `requirements.toml` in `CODEX_HOME`, and a `requirements.toml`
in `<cwd>/.codex`. `config/read` shows `rules` present in the user layer's RAW
config and absent from the effective `Config`; `configRequirements/read` has no
`rules` field at all, so a client cannot even read back an enterprise rule set.
`config/read` with `includeLayers` reported exactly three layers for the fixture
cwd: `project` (`<cwd>/.codex`), `user` (`$CODEX_HOME/config.toml`), `system`
(`/etc/codex/config.toml`). The TOML rule table belongs to the enterprise
requirements layer, loaded only from `<mdm>/requirements.toml` and
`<enterprise-managed>/requirements.toml`
(`config/src/requirements_exec_policy.rs` holds its shape:
`prefix_rules = [{ pattern = [{ token = "echo" }], decision = "forbidden" }]`).

`codex execpolicy check --rules <path> <argv>` evaluates the same parser out of
process and is pinned separately: `echo hi` against the forbid rule returns
`{"matchedRules":[{"prefixRuleMatch":{"matchedPrefix":["echo"],"decision":"forbidden"}}],"decision":"forbidden"}`,
and `ls` returns `{"matchedRules":[]}` with no decision of its own.

One detail worth keeping: Codex parses INSIDE its own shell wrapper. A bare-argv
rule (`["echo"]`) matched a command whose argv is
`["/bin/zsh", "-lc", "echo hi"]`, which is not what
`proposedExecpolicyAmendment` suggests on the approval path.

### Q3. Can a judge thread be made toolless?

Every variant is an `ephemeral: true` thread with `baseInstructions` set to a
54-char fixed prompt, `approvalPolicy: "never"`, sandbox `readOnly`, on
`mock-model` (a catalog model reports no top-level `tools` at all, see below).
The turn's single scripted step is `exec_command` with `cmd: "ls"`.

`core/src/tools/spec_plan.rs` gates the exec tool on
`Feature::ShellTool && Feature::UnifiedExec` (plus `Feature::UnifiedExecTty` for
the tty variant) and `view_image` on `Feature::ViewImage`, so the `[features]`
table is the tool switch.

| Variant                                                                                                                              | `tools` in the provider request                                                     | Did `ls` run?                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------ |
| baseline                                                                                                                             | `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `multi_agent_v1` | Yes, exit 71 (containment sandbox)   |
| `dynamicTools: []`                                                                                                                   | unchanged                                                                           | Yes, exit 71                         |
| `thread/start` `config: {features: {unified_exec, unified_exec_tty, shell_tool, view_image, multi_agent, goals, sleep_tool: false}}` | `request_user_input` only                                                           | No: `unsupported call: exec_command` |
| the same seven flags in `config.toml`'s `[features]`                                                                                 | `request_user_input` only                                                           | No: `unsupported call: exec_command` |
| those flags plus `[tools] experimental_request_user_input = false`, `update_plan = false`                                            | n/a                                                                                 | `thread/start` rejected, `-32600`    |
| those flags plus `[tools.experimental_request_user_input] enabled = false` and `[tools.update_plan] enabled = false`                 | `[]` (empty)                                                                        | No: `unsupported call: exec_command` |
| `experimental_use_unified_exec_tool = false`                                                                                         | unchanged                                                                           | Yes, exit 71                         |

A fully empty `tools` array IS reachable. Both delivery routes work identically
and a per-thread `config` override is enough, so a judge thread needs no global
change. `[tools]` entries are structs, not booleans: the boolean form fails
config load (`invalid type: boolean false, expected struct UpdatePlanToolConfig`)
and the app-server answers `thread/start` with a bare `-32600` that names no key.

`baseInstructions` REPLACES Codex's defaults rather than prefixing them. In every
variant that started, the provider request's `instructions` was the 54-char fixed
prompt byte for byte. Without it, the same `ephemeral` thread sent a 16,979-char
Codex prompt beginning `You are a coding agent running in the Codex CLI…`, plus a
separate `<skills_instructions>` developer message.

### What the fixture cannot express

The containment caveat from the approval-surface probe applies unchanged: every
spawn is wrapped in `sandbox-exec`, macOS refuses to nest a different seatbelt
profile, so anything Codex runs sandboxed dies at exit 71 and only what it runs
unsandboxed executes for real.

That caveat has a sharper consequence here. Under `granular`, Codex reviews a
plain command only AFTER a sandboxed attempt fails, and the containment
profile's exit-71 failure is not reliably classified as a sandbox denial: repeat
runs reviewed different subsets of the same commands. The auto-review probes
therefore use only actions that are gated deterministically (a model-initiated
`require_escalated` command, and `apply_patch`), and the extra commands
`granular` would also review are not probed.

Also not expressed:

- The reviewer's own tool calls. The fixture answers the reviewer with a verdict
  immediately, so nothing exercises the read-only `functions.exec` it is offered,
  and `thread/approveGuardianDeniedAction` (the method that retries a denied
  action after a human approves it) is never reached.
- `autoApprovalReview/strictReviewRequired`, which exists on the wire and did not
  fire in any probe.
- The enterprise requirements layer, and therefore `guardian_policy_config` (the
  `{{ tenant_policy_config }}` slot in the reviewer's prompt, empty here) and
  `allowedApprovalsReviewers`. `/etc/codex` is root-owned and read-denied to the
  fixture.
- `codex-auto-review` as the actual reviewer model. It is hidden from the offline
  catalog in this fixture, so the fallback to the active model's slug is the only
  branch observed.
- Whether a catalog model's non-code-mode tool surface can be emptied the same
  way. Catalog models here are `tool_mode: "code_mode_only"` and send their tools
  as an `additional_tools` developer item instead of a top-level `tools` array,
  so Q3 was measured on `mock-model`.

## Phase-1 adapter decisions

These are scoped decisions for later implementation, not product changes made
by this spike. No ADR is added here.

- Pin the Codex binary and use app-server stdio transport.
- Expose Codex-native permission modes in the UI. Do not imply shared Auto or classifier parity.
- Use the application's held queue and `turn/steer` for active-turn input rather than Codex's native queue. Keep explicit thread/turn preconditions and client message IDs.
- Clean up pending dynamic work locally when its owning turn ends. Parent completion must not be treated as child completion; track each owning thread and turn separately.
- Keep adapter-owned interrupted-tool records if full transcript history is required.
- Route by `thread.id`, not the session tree's `sessionId`.
- Hosted dynamic tools require experimental capability. Cold definition persistence is tested; updating definitions is not.
- Authentication strategy remains open. The isolated account reads do not select a production login or token-management design.

## Binary provenance

- Release: [`rust-v0.154.0`](https://github.com/openai/codex/releases/tag/rust-v0.154.0).
- Source commit: `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`.
- Annotated tag object: `36eab01061df3cde5f95ec20a526777b430091ba`. GitHub reports the tag as unsigned.
- Host and asset: macOS arm64, `codex-aarch64-apple-darwin.tar.gz`, 88,080,735 bytes.
- Download: `https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-aarch64-apple-darwin.tar.gz`.
- GitHub asset API: `https://api.github.com/repos/openai/codex/releases/assets/553706549`.
- Archive SHA256, matched to the GitHub asset digest before extraction: `344310a0a591c1b192e04feff304321a69907c9498baaac331ca7e16ebcef9d7`.
- Extracted binary SHA256: `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`. The runner checks this before executing it.
- Version output: `codex-cli 0.154.0`.
- License: [Apache-2.0, Copyright 2025 OpenAI](https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/LICENSE).

The digest check establishes equality with GitHub's release metadata, not a
separate signed supply-chain attestation. No binary is added to the repository.

## Isolation

All artifacts are under this approved temporary root:

```text
/var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike
```

macOS resolves that path to `/private/var/...`; reports use the resolved form.
Each run must use a new output directory and creates its own `home/.codex`,
`cwd`, `tmp`, schema directory, fixtures, and traces. State is deliberately
retained there for the main reviewer's inspection. The runner does not inspect
the user's actual home, credentials, project files, or Codex configuration.

The child environment is explicitly constructed with only `HOME`, `CODEX_HOME`,
`TMPDIR`, `PATH`, `SHELL`, `LANG`, `USER`, `LOGNAME`, and `RUST_LOG`. No inherited
credential or proxy environment is passed. Credential storage is explicitly
file-based, so the isolated account probe does not select a keychain backend.

An outer macOS `sandbox-exec` profile blocks reads of file contents in `/Users`,
mounted user-data locations, the root home, global `/etc/codex`, and unrelated
temporary directories. OS runtime files and file metadata remain available.
Writes are restricted to the run directory and `/dev` for stdio and PTYs.
Networking is denied except outbound connections to the loopback mock port.
This outer sandbox remains in force when native approval allows a command.
It is a spike containment measure, not a replacement product permission model.

Telemetry, feedback, update checks, web search, plugins, remote plugins, browser
use, computer use, and shell snapshots are disabled in the isolated configuration.
Initial fixture-development runs exposed default plugin-discovery attempts;
the outer network sandbox blocked them. Explicitly disabling plugins removed
those attempts from later stderr traces. There are no real model, login, or
refresh requests in the fixture.

The Responses provider disables retries and WebSockets, uses a 15-second stream
idle timeout, and requires no auth. RPCs and HTTP bodies have bounded waits.
The suite has a 180-second alarm. Cleanup in `finally` terminates app-server
process groups and enumerated descendants, including PTY children in separate
groups. Native commands are fixed, short `printf` and `cat` operations confined
to the isolated working directory. This is not an adversarial daemon-escape
or operating-system sandbox audit.

## Reproduction

No workspace dependency installation is required. `uv` must already have a
Python interpreter available for the offline command below. The script is
stdlib-only and rejects optimized Python because its probe assertions must run.
It intentionally supports only this verified macOS arm64 binary and temporary
root. It refuses existing output directories and never overwrites prior runs.

The acquisition commands used were the following, with download and extraction
commands run from the temporary root after checking its parent with `ls`:

```sh
ls /var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode
mkdir /var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike
curl -q --noproxy '*' -fL --max-time 180 https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-aarch64-apple-darwin.tar.gz -o codex-aarch64-apple-darwin.tar.gz
shasum -a 256 codex-aarch64-apple-darwin.tar.gz
tar -xzf codex-aarch64-apple-darwin.tar.gz
shasum -a 256 codex-aarch64-apple-darwin
```

The existing verified binary can be reused. From the repository root, run the
following with a fresh output directory suffix:

```sh
uv --no-config run --no-project --offline scripts/probe-codex.py \
  --codex /var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike/codex-aarch64-apple-darwin \
  --output-dir /var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike/reviewer-03
```

The runner executes `codex --version` and
`codex app-server generate-json-schema --experimental --out <run>/schema`
inside the same isolation before starting the protocol probes. It does not
download anything at runtime. `report.json` distinguishes `pass`, `observed-gap`,
and `fail`. Exit 0 means the checks completed without assertion or fixture
failures; it does **not** erase an `observed-gap` or certify product readiness.
An assertion failure, mock error, unused response fixture, or fatal error exits
nonzero. An early fatal error leaves evidence already captured.

## Evidence

The main reviewer inspected the script and document, independently verified the
GitHub asset digest and local archive/binary checksums, and ran `reviewer-01`.
Review tightened steering identity assertions and separately recorded each part
of the interrupted-tool gap. The revised code was reviewed and independently
rerun as `reviewer-02`, with the same 12 passing probes and one gap. The reviewer
also checked the raw interrupted-tool trace, cold history, final report, cleanup,
and invalid-binary/output-path guards. This verifies the bounded spike, not the
unimplemented product adapter.

- Revised implementation run directory: `codex-spike/run-12` under the temporary root above.
- Final independent run directory: `codex-spike/reviewer-02` under the same root.
- Recorded outcome: exit 0; 13 probes, 12 `pass`, one `observed-gap`, 21 loopback model requests, no mock errors, no unused fixtures.
- `report.json`: per-probe outcomes, request index ranges, process IDs and exit statuses, binary provenance, and environment key names.
- `version-check.json`, `binary-check.json`, `schema/`: direct binary identity and generated protocol schema.
- `unauthenticated.jsonl`, `stable.jsonl`, `experimental.jsonl`, `cold.jsonl`: client/server JSONL in order, with monotonic timestamps. Server stderr is in the matching `.stderr` files.
- `http/request-NNN.json`: actual Responses request bodies, including tools and returned tool outputs. `http/fixture-*.json` contains the SSE events supplied by the fixture.
- `history-live.json`, `history-cold-read.json`, `history-cold-resume.json`: completed-turn fidelity evidence.
- `history-interrupted.json`, `history-interrupted-cold.json`: the interrupted dynamic call is missing from returned items, before and after process restart.
- `history-fork.json`, `history-steer.json`, `history-queue.json`: fork boundary, steering client ID, and distinct queued turn evidence.
- `child-spawn-item.json`, `child-list.json`, `history-child.json`: native child identity, parent relationship, and completed history.
- `cwd/accept.sentinel` contains `spike-native`; `cwd/decline.sentinel` does not exist.
- At the temporary root, `release-asset.json`, `release-tag.json`, and `LICENSE` preserve upstream provenance metadata.

All four app-server processes have recorded cleanup exit status `-15`. A
post-run process lookup found no matching spike binary still running. Separate
guard invocations rejected a workspace output path and the public `LICENSE`
file supplied as a binary, both before creating an output directory. Whitespace
checks passed for both new repository files. No app-wide gates were run.

Development runs `run-01` through `run-04` stopped before protocol probes while
the outer sandbox profile was being corrected. `run-05` used an obsolete command
fixture and exposed the cancellation gap. `run-06` fixed native command fixtures
and disabled plugin discovery. `run-07` showed that explicitly requesting the
unknown `mock-model` in `spawn_agent` is rejected against the model catalogue.
Omitting that override inherits the parent's local model and succeeds in later
runs. `run-08` through `run-10` exercised successive assertion and isolation
improvements. These directories remain available; they are not the final result.

## Limits

Unrun or intentionally excluded: real-provider model behavior, authenticated
accounts, login and token refresh, external-token auth, hosted dynamic namespaces,
model catalogue discovery, native file-change approvals/diffs, user-question and
MCP elicitation flows, permission-mode switching, shared-queue recall races,
remote media, child approval routing, v2 child ownership/control, automatic
subscriptions across arbitrary child modes, deeper agent trees, child cancellation,
dynamic-tool redefinition on resume, persistence after an OS crash, pagination
under large histories, queue recovery across process restart, Windows/Linux,
and shared permission classifier parity. Hooks were out of scope; no hooks
documentation or implementation source was fetched for this spike.

The local fixture uses `mock-model` and Codex's fallback model metadata. Synthetic
SSE events reuse simple response/message IDs across different turns. The results
establish the tested transport paths, not robustness against every provider's
stream ordering, reconnect behavior, or ID semantics. The resume check is a
process restart after completed turns, not a durability guarantee under abrupt
power loss. No app-wide tests, production edits, dependency installs into the
workspace, branches, staging, commits, or ADRs are part of this spike.

## Pinned references

The fixture setup and RPC shapes were checked against the following sources at
`rust-v0.154.0`, alongside the binary-generated schemas:

- [Mock provider configuration](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/common/config.rs).
- [Native command and final-message SSE fixtures](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/common/responses.rs).
- [Dynamic tool round-trip tests](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/suite/v2/dynamic_tools.rs).
- [Core SSE helpers, including reasoning](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/tests/common/responses.rs).
- [Turn steering tests](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/suite/v2/turn_steer.rs).
- [Queue tests](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs).
- [Native approval interruption and resolution test](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs).
- [Thread protocol definitions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- [Turn protocol definitions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- [Plugin startup gating](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/manager.rs).
