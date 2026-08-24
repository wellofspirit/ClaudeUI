# ADR-038: Approval lifecycle is event-driven — never inferred from turn state

**Status:** Accepted
**Date:** 2026-07-27
**Relates to:** [ADR-033](adr-033_cross-engine-dispatch.md) (cross-engine dispatch — origin of the `session:approval-dismiss` forwarding pattern), [ADR-022](adr-022_opencode-permission-mapping.md) (opencode permission mapping)

## Context

Each engine session in the main process parks unresolved permission requests in a
`pendingApprovals` map (`requestId → resolver`) and emits `session:approval-request` so the
renderer can show a card; the user's click travels back over `session:approval-response` and
resolves the parked promise, which unblocks the engine's tool call.

The renderer historically wiped its card list whenever the session went `idle`
(`clearPendingApprovals` in `useClaudeEvents`' `onStatus`). That was a stale-card safety net built
on an invariant that used to hold: _a turn cannot end while an approval is legitimately pending_.

claude-code broke that invariant. cli.js ends the parent turn — emits `result`, ClaudeUI
broadcasts `session:status` `idle` — while background subagents (`Agent` tool,
`run_in_background`) are still running. A subagent's `can_use_tool` control request can arrive, or
remain unanswered, **after** the parent turn is over; when the subagent finishes, cli.js resumes
the parent turn on its own (one prompt, multiple `result`s). Wire probes confirmed the overlap on
2.1.198, 2.1.207 and 2.1.219 alike — this is the harness's steady-state semantics, not a
transient regression.

The collision froze real work: the renderer wiped the card at idle while the main process still
held the unresolved promise. No UI remained that could produce the `requestId`, so the approval
was unanswerable, and the subagent hung inside cli.js indefinitely (`TaskStop` the only exit).
Nothing was logged — the deadlock was invisible to diagnostics (fixed in `4003c19`; findings in
the session of 2026-07-27).

## Decision

**The renderer's pending-approval state is an exact, event-driven mirror of the owning session's
`pendingApprovals` map.**

- Cards are **added** only by `session:approval-request`.
- Cards are **removed** only by explicit resolution signals:
  - `session:approval-dismiss { requestId }` — the session resolved the approval internally;
  - a matching `tool_result` (`removePendingApprovalByToolUse`) — the call already ran or failed;
  - the user's own resolution via `session:approval-response`;
  - `disconnected` status — the session object is gone and its `cancel()` has already denied
    everything, so a blanket clear is a faithful mirror, not an inference.
- Approval lifetime is **never derived from turn or session state** (`idle`, `result`, `running`).
  Turn boundaries do not bound approval lifetimes.

**Corollary — the emission duty.** Removing the idle wipe is only sound if every session
implementation emits `session:approval-dismiss` at _every_ point it resolves a pending approval
without a renderer click. For `ClaudeSession` that is: the per-request abort listener
(`control_cancel_request` → signal), `cancel()`'s deny-all loop, `interrupt()`'s deny-all loop,
and an echo after normal resolution (so remote/multi-window views that never saw the local click
drop the card too — the pattern `OpencodeSession` and the cross-engine dispatcher already
followed). A resolution path that skips the emit leaks a permanently-stale card; this is the
invariant to check first when adding any new resolution path.

Dismiss emissions are keyed by uuid `requestId` and are idempotent on the renderer (filter), so
double emission (e.g. abort listener + post-await echo) is harmless, and emissions from a disposed
session that shares a `routingId` with its replacement cannot clobber the replacement's approvals.

## Consequences

- A background subagent's approval card survives the parent turn ending and can be answered
  minutes later; approving it resumes the subagent and, transitively, the parent turn.
- Sessions may display `idle` while approvals (and background subagents) are outstanding — status
  and approval state are now independent axes. A "background agents running" status hint is an
  open UX follow-up, not a correctness requirement.
- Any new engine backend must implement both halves: emit `approval-request` on park and
  `approval-dismiss` on every internal resolution. Blanket renderer-side cleanup tied to engine
  status transitions (other than `disconnected`) is prohibited.
- Guard tests encode the new invariant (approval survives idle; dismiss removes exactly one card;
  cancel/interrupt/abort each emit per-request dismisses). Caveat recorded honestly: the current
  suites exercise harness replicas of the hook/session logic rather than the production modules,
  so the live-app drive remains the decisive verification for this pipeline.
