# ADR-040 — Task lifecycle is event-driven: `session:task-started` / `session:task-notification`

**Status:** Accepted
**Relates to:** ADR-038 (the same principle for approvals — lifecycle state mirrors explicit wire
events, never inferred from turn/tool state), ADR-033 (cross-engine dispatch renders through the
same TaskCard), `docs/protocol-cc/04-system-subtypes.md` §4.4/§4.5 (the cli.js wire shapes)

## Context

TaskCard used to decide running-vs-complete for a subagent from two proxies: the tool input's
`run_in_background` flag and the presence of a `tool_result`. Claude Code 2.1.219 broke both at
once: Agent/Task subagents are **background-by-default**, the model normally **omits**
`run_in_background`, and an immediate "Async agent launched successfully" `tool_result` arrives at
spawn. Every async-launched task therefore rendered as completed instantly — hiding the Stop button
while the subagent was still running. Worse, the patch notes for `subagent-streaming` record that
even explicit-foreground tasks are non-deterministically routed through the async path, so **no
amount of input-sniffing can ever be correct**.

The authoritative signals were already on the wire and partially plumbed:

- `system/task_started` `{task_id, tool_use_id, task_type}` at spawn — consumed by
  `handleTaskStarted` only to populate the internal `taskIdMap`, never forwarded to the renderer.
- `system/task_notification` `{status: completed|failed|stopped, tool_use_id, usage}` at terminal
  state — already forwarded as `session:task-notification`.
- The stop path (`stop_task` control request) was never broken — only hidden by the wrong status.

## Decision

Task running-state is derived from the **start/terminal event pair**, mirroring ADR-038's rule for
approvals: renderer state is a projection of explicit lifecycle events, never an inference from
tool input, tool results, or turn state.

- `handleTaskStarted` additionally emits the engine-neutral `session:task-started`
  `{toolUseId, taskId, taskType}` (same channel conventions as `session:task-notification`).
- The store keeps `PerSessionState.activeTasks: Record<toolUseId, {taskId, taskType}>` — set by
  task-started, deleted by task-notification, reset with the session (it rides
  `EMPTY_SESSION_STATE`).
- **Predicate:** an `activeTasks` record means RUNNING — regardless of `tool_result` presence or
  the `run_in_background` input — until the matching notification arrives. TaskCard and TaskEntry
  share this predicate.
- **Legacy fallback, on purpose:** engines that never emit `task_started` (opencode and pi child
  sessions, historical transcripts, cross-engine dispatch cards driven by synthesized
  notifications) have no record and keep the pre-existing heuristic
  (`isBackground ? !bgNotification : !hasResult`) byte-for-byte. The new signal only ever *adds*
  running-ness; it cannot regress engines that don't speak it.
- `handleTaskNotification` falls back to the wire's own `tool_use_id` when the `taskIdMap`
  reverse-lookup misses (map evicted, or `task_started` never arrived).
- "Send to background" is suppressed for tasks with an `activeTasks` record — they are already
  async; the button remains only for the residual synchronous-foreground path.
- `activeTasks` rides the remote `PerSessionSnapshot` (optional field), so a remote client that
  connects or re-syncs mid-task sees the running state instead of re-deriving it from the broken
  heuristic. Live updates need no relay change — the RemoteBridge forwards all session channels.

## Consequences

- Stop works again for background-by-default subagents; the button renders whenever the card is
  running, and the protocol path underneath was untouched.
- Any future engine that can report task spawn should emit `session:task-started` rather than
  invent its own status inference; the store and both views are already engine-neutral.
- If cli.js ever changes the `task_started` shape, the failure mode is graceful: no record → the
  legacy heuristic — visible as this bug again, caught by the four lifecycle guard tests in
  `TaskCard.component.test.tsx` (verified failing pre-fix).
- `taskType` is carried but not yet rendered; it is there so the card can label task kinds without
  another wire change.
