# ADR-067: Codex under ClaudeUI's shared permission model

**Status:** Accepted (2026-09-11), implemented on `codex-integration`
**Supersedes:** [ADR-066](adr-066_codex-fourth-engine.md) §"Phase-1 permissions are native, not shared Auto". The rest of ADR-066 stands.
**Re-includes Codex in:** [ADR-022](adr-022_opencode-permission-mapping.md) (one rule set for every harness) and [ADR-050](adr-050_auto-mode-as-the-default-autonomy.md) (Auto as the default autonomy).
**Relates to:** [ADR-023](adr-023_opencode-automode-classifier.md) (ClaudeUI's own judge, which Codex does not use), [ADR-030](adr-030_capability-honesty.md), [ADR-035](adr-035_pi-engine-backend.md) (the pi evaluator this reuses)

## Context

ADR-066 shipped Codex with its native approval policy, sandbox and reviewer exposed as a per-session pill, and deferred parity with ClaudeUI's permission modes and Claude-style rules. The owner then asked for the opposite: drop the native controls and make Codex behave like the other three engines under one policy, keeping Codex's own judge for Auto mode where ours cannot be mapped.

Two evidence sources fixed the design. A repo-resident probe against the pinned 0.154.0 binary (`src/integration/codex/codex-policy-probe.integration.test.ts`, findings in [codex-spike.md](../codex-spike.md) §"Native approval surface probe") established what each `(approvalPolicy, sandboxPolicy)` pair routes to the client. The Codex source at tag `rust-v0.154.0` (checked out under `.cache/codex-src/`, not vendored) explained why.

What the binary does:

- `untrusted` is the only policy that asks **before** executing, and it asks for every command and every file change. There is no built-in trusted list: `core/src/exec_policy.rs` renders `Decision::Prompt` for any command not explicitly allowed by an execpolicy rule, and `core/src/safety.rs` returns `AskUser` for every patch. `on-request` runs commands silently inside the sandbox and surfaces only model-requested escalations and outside-workspace patches; `never` asks nothing; `granular` asks only after a sandboxed attempt failed.
- Approving a command runs it **unsandboxed**. There is no "approve but keep it contained" reply. An execpolicy `allow` rule likewise runs with `bypass_sandbox` once every command segment is explicitly allowed (`exec_policy.rs`, `ExecApprovalRequirement::Skip`). Approval and sandbox are alternatives, not layers.
- Policy is accepted per turn on `turn/start` (`approvalPolicy`, `sandboxPolicy`, `approvalsReviewer`), so nothing about policy needs `thread/settings/update` or its unordered acknowledgement.
- The tool surface is `exec_command` plus non-filesystem tools; file edits are `apply_patch` heredocs the binary intercepts into `item/fileChange/requestApproval`. Two gate points cover every filesystem effect.
- `decline` is honoured on both request types though never advertised in `availableDecisions`. `acceptForSession` covers one exact command string.
- Codex has a native reviewer. `approvalsReviewer: auto_review` routes approval requests to a guardian subagent instead of the user, but only under `on-request` or `granular` (`core/src/guardian/review.rs`, `routes_approval_policy_to_guardian`); under `untrusted` the reviewer field is ignored and requests go to the user. Guardian approval is a stable, default-enabled feature in 0.154.0 (`features/src/lib.rs`). Approval precedence is hooks, then guardian, then user (`core/src/tools/approvals.rs`).
- Codex has its own rules engine, execpolicy: Starlark `prefix_rule(pattern=[argv tokens], decision=allow|prompt|forbidden)` files under `rules/` in each config layer (`~/.codex/rules/*.rules`, project `.codex/rules/`). Prefix semantics over argv, not glob semantics over the command string; redirections drag the shell wrapper into the proposed prefix.

## Decision

**Codex executes; ClaudeUI decides.** The session's shared `PermissionMode` (`plan | default | acceptEdits | auto`) is the only policy the user sets. On every `turn/start` the adapter derives the native parameters from it and answers every server request it receives with the same evaluator pi uses (`src/core/pi/permission-engine.ts`, engine-neutral by design: deny rules, ask rules, session allows, allow rules, mode base).

| Mode        | `approvalPolicy` | `sandboxPolicy`        | `approvalsReviewer` | Evaluator                                                                                                                               |
| ----------- | ---------------- | ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| plan        | `untrusted`      | `readOnly`, no network | `user`              | mode base: read-class commands allowed, every patch and mutating command declined with the plan reason                                  |
| default     | `untrusted`      | `workspaceWrite`       | `user`              | rules, else the standard approval card                                                                                                  |
| acceptEdits | `untrusted`      | `workspaceWrite`       | `user`              | in-workspace patches allowed by mode base; a mode-base allow for a path outside the workspace is downgraded to ask; commands as default |
| auto        | `on-request`     | `workspaceWrite`       | `auto_review`       | Codex's guardian reviews escalations; anything it still sends to the client is gated like default                                       |

Mapping details:

- `item/commandExecution/requestApproval` gates as `bash` with the command string. `commandActions` is display-only. `item/fileChange/requestApproval` carries no paths; they are read from the `fileChange` item already mapped into the transcript, one evaluation per file (`add` → write, otherwise edit), collapsed as any-deny denies, else any-ask asks, else allow. A request with nothing resolvable asks.
- Allow → `{decision: 'accept'}`. Deny → `{decision: 'decline'}` plus a `session:error` naming the rule or the plan reason, because neither native reply carries a reason and a silent decline is invisible to model and user alike. Ask → the standard `PendingApproval` with no engine payload, `commandExecution` / `fileChange` as tool names (already mapped by the renderer's Codex tool map), and always-allow suggestions in the Claude rule vocabulary. `allowForSession` records the shared session-allow key; persisted suggestions write Claude permission rules the way pi and opencode do.
- `acceptForSession` and `acceptWithExecpolicyAmendment` are never sent. ClaudeUI owns rules and session allows; Codex's execpolicy is not written.
- The thread baseline (`thread/start` / `thread/resume`) carries the same policy as the current mode so a turn that starts without a per-turn override still runs under it.
- `setPermissionMode` applies from the next turn. A running turn is not re-policied mid-flight.
- Auto is available for Codex and follows the global default (ADR-050). ClaudeUI's own classifier and judge transports are not used for Codex; the guardian is Codex's, prompted and constrained by Codex.

Removed: the native policy pill, `CodexPolicyOptions`, the policy keys in `codex_session_overrides` (rows written with them load leniently and replay only model and effort), the native policy fields of `SessionStatus.codex`, and every renderer carve-out that hid the mode tab, mode picker and Shift+Tab cycle for Codex. Native reasoning effort moves into the standard effort picker, which renders engine-published tiers and applies them live over the existing `session:set-effort` command. The Codex approval card survives only for `item/tool/requestUserInput` questions.

Deliberately not done: a bypass mode (the shared union has none), compiling Claude rules into execpolicy files, and `item/permissions/requestApproval` grants (still denied with a visible explanation; the tool behind it is an under-development feature in 0.154.0).

## Consequences

- One policy surface across four engines. A deny rule on `Bash(rm -rf:*)` declines before anything runs; an ask rule reaches the human even in acceptEdits; plan mode is read-only on Codex the same way it is on pi.
- Approved actions run unsandboxed under plan, default and acceptEdits, exactly as Claude Code behaves without its sandbox feature and as pi behaves today. The sandbox column is what the model is told about its environment and what contains `auto`'s silent in-workspace work; it is not a second decision layer. This trades OS containment for a single source of truth, and the trade is explicit.
- Under `auto`, nothing reaches the client. The reviewer probe (codex-spike.md §"Native reviewer and judge-thread probe") showed zero `requestApproval` calls under `on-request` plus `auto_review`; Codex emits `item/autoApprovalReview/started` and `completed` plus a `guardianWarning` per decision instead, none of which has a generated type yet, and three consecutive guardian denials interrupt the turn. The reviewer runs on Codex's preferred review model (`codex-auto-review` when the catalog lists it, else the active model's resolved slug) on the same account. A user-authored ClaudeUI deny rule therefore never fires under `auto`. This is the accepted meaning of "leave Auto to their native judge"; the fallback gate in the adapter exists for completeness, not because anything is known to reach it. `guardian_subagent` is a serde alias of `auto_review`, not a third reviewer.
- Every `untrusted` command costs one round trip to the client. Codex loads Starlark rule files from `$CODEX_HOME/rules/*.rules` (user layer) and, only for trusted projects, `<cwd>/.codex/rules/*.rules`. A later follow-up may compile Claude rules into a ClaudeUI-owned file there: `allow` rules would skip the ask (without adding containment, since explicit execpolicy allows also bypass the sandbox), and `forbidden` rules would block before the reviewer is consulted, which is the only way a ClaudeUI deny rule could bind under `auto`. Claude's `Bash(cmd args:*)` rules are prefix rules already, so the mapping is close for commands and absent for file-path rules. Writing into the user's Codex config folder is a decision in its own right and is not part of this ADR.
- The `session:codex-settings` channel and its `reset` action are removed; model and effort travel over the shared `session:set-model` and `session:set-effort` commands, and `codex_session_overrides` is written only through them.
- Sandbox enforcement cannot be measured in the integration fixture: macOS refuses to nest a second seatbelt profile, so the fixture's containment wrapper kills every sandboxed command. Approval routing is measured; containment claims rest on the source and on real-app runs.

## Verification

Guard tests in `src/core/codex/__tests__/codex-session.test.ts` (per-mode `turn/start` parameters, plan declines, rule-sourced verdicts, acceptEdits workspace narrowing, standard card shape, `allowForSession`, legacy overrides rows), renderer tests for the returned mode surfaces and native effort picker, and two real-binary integration cases: plan declines a write and leaves no file; default asks, the human allows, the file exists. Real-app drive: the Codex session view shows the shared mode tab and the native effort picker without a turn.
