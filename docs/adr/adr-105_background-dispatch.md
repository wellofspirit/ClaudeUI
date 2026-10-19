# ADR-105: Background dispatch — X-Agents run beside their parent, survive restarts and talk back

**Status:** Accepted (2026-10-19). Implemented on branch `async-dispatch`.
**Amends:** [ADR-033](adr-033_cross-engine-dispatch.md) (dispatch was a blocking tool call whose targets lived only
in memory: §3 "no lifecycle coupling" is kept for the sidebar, M2's `persistSession: false` and the
continuation-by-`session_id` contract are replaced), [ADR-104](adr-104_agent-session-tools.md) (§6 "only a
session's root agent can act" gains one exception: `session_message` for dispatch children, within their own
family).
**Relates to:** [ADR-038](adr-038_event-driven-approval-lifecycle.md), [ADR-073](adr-073_agent-roster-and-task-run-identity.md),
[ADR-087](adr-087_transcript-blobs-off-the-ring-and-host-eviction.md), [ADR-088](adr-088_dispatch-autonomy-inheritance.md),
[ADR-089](adr-089_pi-subagents-host-run.md) (the model this generalises), [ADR-095](adr-095_sidebar-status-dot-ripple.md),
[ADR-097](adr-097_opencode-v2-only.md) (S9 caller restriction).

## Context

`dispatch_agent` hands a task to an agent on another engine or model. It was built as a blocking tool call: the
parent waits for the child's whole run and cannot serve the user meanwhile. Claude Code runs MCP tool calls that are
not marked read-only one after another (`isConcurrencySafe` is `annotations.readOnlyHint ?? false` in 2.1.293), so
several dispatches in one assistant message ran in sequence. Targets lived only in the dispatcher's memory and every
parent `cancel()` — the idle timer, Disconnect, an effort or thinking respawn, a Claude account switch, app quit —
tore them down; Claude targets ran without a transcript, pi targets with `--no-session`, opencode target sessions
were deleted, so "continue that agent" after any of these failed. A dispatched agent had no name, no way to message
its parent, and its card showed the engine and model only.

Claude Code's own subagents and ClaudeUI's host-run pi subagents (ADR-089) already have the wanted shape: the launch
returns at once, the parent keeps working, the result arrives in the parent's conversation when the child finishes
(folded into a running turn or starting one), the two message each other by name, and a stopped or finished child
can be resumed. A dispatched agent is a real session of its harness running as if it were a subagent, so the same
shape applies.

## Decision

### 1. A dispatched agent is an "X-Agent" with a durable record

- Each target has a row in a dispatch ledger (operational.db): its ClaudeUI id (a session ref, `s-xxxxxx`), engine,
  the harness's own session id, the parent's durable session id, the launching tool call, working directory, model,
  account, the caller restriction it was created with (ADR-097 S9, which sticks to it), `name`, `description`, and
  state (running, idle, stopped, failed, interrupted). Cost is not stored there; it is derived from the
  `usage_event` rows with origin `dispatch` (one source of truth).
- The target is owned by the parent's durable id, never by the tool call's context. Every decision that reads the
  parent — the judge's live autonomy mode (ADR-088), its transcript, its blocked calls — and every event the target
  emits resolves the live parent at that moment. With no live parent, the judge uses the mode recorded at launch or
  a stricter one, never a looser one.
- Each harness keeps the target's session, hidden from the sidebar: Claude without `persistSession: false` (the
  history list, block usage and the usage backfill skip ledger ids through one shared predicate, so cost is never
  counted twice); pi with its own session directory under `~/.claude/ui/dispatch/pi/`; opencode's session is no
  longer deleted (its `xeng-dispatch` title already hides it); Codex threads are filtered from the history list.
- The product label is "X-Agent". `dispatch_agent` takes optional `name` (a short handle, unique among the parent's
  live children) and `description` (a short summary), as Claude Code's Agent tool does.

### 2. Background by default

- A root agent's dispatch runs in the background; a subagent's waits for the result; `run_in_background` overrides
  either. The waiting form launches the same background run and awaits it: there is one run engine.
- A background launch validates synchronously, spawns asynchronously and returns at once with the X-Agent's id and
  name. Several dispatches in one message therefore return in turn without waiting on each other.
- The run is registered by its ledger id for its whole life — stop, progress, liveness — and is never tied to the
  launching MCP request (its abort signal, progress token) or to the dispatcher's call frame.
- The parent's session receives the same task lifecycle as for its own background agents: `task-started`,
  `task-progress`, `task-notification`. Task records carry `wakesParent`, set by whoever emits them, and the
  attention gate and the sidebar's subagent count read that field instead of a list of task types.
- Over the configured concurrency limit a background launch is refused with the limit in the message.

### 3. Results come back into the parent

- An X-Agent reports back through a tool, `hand_back { report }`, as Claude Code's subagents do through
  `SubagentHandback`. The final turn text is never the report: on other engines and models it can carry leaked
  reasoning or stray output, while a tool argument is a defined value. Every target engine gets the tool (Claude
  targets through their ClaudeUI MCP server, pi through the bridge, opencode through the hosted server, Codex through
  `dynamicTools`).
- One report per run — a run being the launch, or a resume by a parent message. The call ends the run: the tool
  result tells the agent it is done and output after it is not delivered. A second call in the same run is refused
  and points at `session_message`. A run that ends without a report is nudged up to three times to call `hand_back`;
  after that the parent is told the X-Agent ended without a report, and its unsent text is not delivered (it stays
  readable in the X-Agent's own transcript).
- Under a judged auto mode the dispatch judge (ADR-088) reviews the report before delivery. It never blocks it: a
  report the judge objects to, or could not review, is delivered with a warning above it, as Claude Code does.
- The report is stored in operational.db, keyed by the X-Agent's ledger row and run, and the delivery goes through the
  parent's inbox (ADR-104). A report longer than a set size is delivered as an excerpt with a pointer; the whole text
  stays readable on demand (`session_read` on the X-Agent).
- The report, status and cost line are delivered into the parent through each engine's host-delivery path (Claude
  Code's peer envelope on stdin, opencode steer or prompt, pi `/cui-deliver`, Codex `turn/steer` or `turn/start`):
  folded into a running turn at its next tool boundary, or starting a turn when the parent is idle.
- This delivery has its own origin, `dispatch-result`: it wakes the parent and is not counted in ADR-104's budget of
  ten agent-started turns since the user's last prompt. A separate cap on dispatch-result wakes since the user's
  last prompt guards against a parent that re-dispatches on every result.
- The report is agent-authored, untrusted output with no user authority, and is delivered as such on every parent
  engine, the way Claude Code delivers a subagent's `SubagentHandback` report (cli.js 2.1.293): a header sentence
  saying so, every line of the report indented so a frame-like line inside it cannot pass for a real one, and
  instruction-shaped content (harness and system tags, turn markers, permission-escalation strings) neutralised or
  named in a marker. One ClaudeUI sanitiser does this, because pi, opencode and Codex parents have no such defence of
  their own. The turn it starts is not a user turn: it cannot satisfy ADR-104's clean-user-turn gate, and the
  auto-mode judge reads the report as agent output.
- When the parent is not live, the delivery waits in its inbox (ADR-104) and is delivered when the parent is live
  again — a respawn after an account switch or effort change, a reconnect, or the user reopening it — and the card
  and the sidebar show that a result is waiting.
- A parent's idle timer is held while it owns running X-Agents.

### 4. Messages both ways go through `session_message`

- X-Agents are addressable sessions: by id, and by name within their parent's family. ClaudeUI's `session_message`
  is the one messaging tool (never Claude Code's `SendMessage`).
- Parent to X-Agent: a running X-Agent receives the message as a steer; an idle or released one is resumed through
  its harness (`--resume`, pi's session directory, opencode's session, Codex `thread/resume`) and the message starts
  a turn as that X-Agent's user input — the parent is its user.
- X-Agent to parent: dispatch targets get `session_message` and no other session tool. ADR-104 §6's root-agent rule
  stands for every other tool, because a subagent never has a clean user turn and starting sessions from one could
  run away. The message reaches the parent as a peer message (counted in ADR-104's budget, marking the turn
  non-user) and waits in the inbox when the parent is not live.
- Ownership is a refusal enforced by the tool service in every permission mode, `bypassPermissions` included:
  parent to its own X-Agents and their descendants, X-Agent to its parent; anything else is refused. Names resolve
  only within the parent's family; `main`, `origin` and ref-shaped names are reserved. An X-Agent's caller class is
  its own effective mode. Every message an X-Agent sends is audited with the X-Agent as the actor.
- `dispatch_agent` no longer takes `session_id`; a call that still passes one is told to use `session_message`.

### 5. Lifetime is the X-Agent's own

- A parent's restart or cancel no longer ends its X-Agents. A running X-Agent finishes its turn and delivers as
  above; an idle one's process is released and resumed on its next message; pending approvals stay pending.
- When a parent session object is created again, the dispatcher re-emits `task-started` for its running X-Agents and
  re-raises their pending approvals, so the card, the roster and the attention gate are right after a respawn.
- History reload builds dispatch cards from the ledger (state and delivered text). Replaying the child's full stream
  from its own transcript is later work.
- App quit ends the processes. On the next start, running rows become `interrupted` and the parent's inbox gets a
  notice naming the X-Agent; nothing resumes automatically.
- An X-Agent ends when the user stops it, when its parent session is deleted, or by a retention sweep of idle rows
  whose parent is gone; harness-side state is removed where the engine allows it.

## Consequences

- The parent keeps serving the user while its X-Agents work, and several dispatches run side by side.
- An X-Agent survives everything short of app quit, and after app quit it can be resumed by a message.
- The dispatcher's target model changes from "call context" to "ledger row + live lookup"; most of the existing
  per-engine target code (spawn, gate, judge, streaming, cost) stays, re-keyed.
- One more injected-message origin (`dispatch-result`) across four engines and the reducer.
- Claude target transcripts now exist on disk; three readers must skip them. They live in the
  project's own transcript directory, so Claude Code's `--continue` / `--resume` picker run in
  that directory can see them.
- A ledger insert that fails after Codex's `thread/start` leaves that thread listed in history
  (the Codex list can only skip ids the ledger knows).
- Codex threads started before this change keep their tool set, so they cannot message their parent.

## Alternatives considered

- **Mark `dispatch_agent` read-only (`readOnlyHint`) so Claude Code runs several at once.** Rejected: it parallelises
  the blocking calls but leaves the parent blocked, and the same hint lets the tool through plan mode without asking.
- **Continue an X-Agent through `dispatch_agent`'s `session_id`.** Rejected: a separate messaging tool keeps launching
  and talking apart, and one tool already reaches every session.
- **Keep targets tied to the parent's process.** Rejected: every restart of the parent lost its children.
- **Queue launches over the concurrency limit.** Rejected: a refusal is simpler and tells the model to wait.
- **Use the X-Agent's final turn text as its report.** Rejected: on other engines and models the final text can
  carry leaked reasoning or stray output into the parent; a tool argument cannot.
- **Make each target a hidden interactive session object.** Simpler in the long run; not taken now. The ledger is
  keyed so that this stays a rename later.
