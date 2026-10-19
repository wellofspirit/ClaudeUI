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
  reasoning or stray output, while a tool argument is a defined value. Every target engine gets the tool, and only a
  dispatch target does; one shared description (`src/shared/dispatch-agent-description.ts`) serves all four:
  - Claude targets: a one-tool in-process MCP server built for each spawn (`claude-ui-handback`), listed in the
    process's `allowedTools`. cli.js gives a subagent of the target the same in-process tools, so the call is
    attributed from the stream (the owner map of ADR-104's session tools) and only the X-Agent's own is its report; a
    subagent's call, or one that cannot be attributed, is refused and ends nothing. Probed on cli.js 2.1.293 in `auto`
    mode (2026-10-20): a call with an ordinary report ran with no permission ask and no classifier block.
  - pi targets: the bridge extension registers `hand_back` under its own gate (`CLAUDEUI_PI_HAND_BACK`, bridge v18),
    which only a target's environment sets; the target's own bridge host answers it, and the extension's gate lets it
    through without judging (it is the report, not an action).
  - opencode targets: `claudeui_hand_back` on the hosted server. The caller is the session opencode's `_meta` names,
    and only the session of a live dispatch target is accepted. Every interactive ruleset denies the tool (hidden from
    the model); a target's ruleset allows it in every mode.
  - Codex targets: a dynamic tool declared at `thread/start`, answered by the target's own server-request handler. A
    thread keeps the tools it was started with.
    A call from anything that is not a running dispatch target is refused.
- One report per run — a run being the launch, or a resume by a parent message. The call ends the run: the tool
  result tells the agent it is done and output after it is not delivered. A second call in the same run is refused
  (the run has ended; a target has no `session_message` before §4). The turn is ended where the engine has no native
  way to: pi's result carries its own `terminate` hint (an abort follows a model that goes on anyway); a Claude target
  is interrupted when the call's tool result goes by on its stream; an opencode or Codex turn is interrupted when the
  call's own tool item has completed on the engine's feed (a short ceiling covers a feed that never says), and not at
  all when the turn ended by itself first — an interrupt inside the call would cancel the call. The run's result is
  the stored report, never later turn text. A run that ends without a report is nudged into the same session up to
  three times to call `hand_back` (naming the tool as that engine spells it), and not past its cost cap — except while
  a Claude target waits on an agent or workflow of its own, running or just ended (cli.js then starts a turn of its
  own, whose result is waited for), a wait with a ceiling. Every frame pushed into a Claude target carries a uuid,
  and a result counts as the end of the target's turn only after cli.js reported one of those frames started
  (`command_lifecycle`): the zero-turn pointer of a notification and the stray turn an earlier run's work started
  are not counted, while a turn a notification led still is when the prompt was folded into it; after that the parent is told
  the X-Agent ended without a report, and its unsent text is not delivered (it stays readable in the X-Agent's own
  transcript). A target that has no `hand_back` tool (a Codex thread started before it existed) is not nudged: its
  last message is the report, flagged as such.
- How each run ended is stored in operational.db (`dispatch_report`, migration v36): one row per run, whatever the
  end (delivered, withheld, fallback, stopped, failed, timeout), keyed by the X-Agent's ledger row, the run's number
  and the call that launched or continued it. A report is kept as received (cut at a size cap, in memory and in the
  row); the sanitiser runs where it is shown or delivered. A report longer than a set size is delivered as an excerpt
  with a pointer; the whole text stays readable on demand (`session_read` on the X-Agent). The X-Agent's card shows
  its run's stored end, live and after a reload: a continuation's own card shows its own run. A blocking call's tool result is the framed
  report (below), never the raw text of the target.
- Judge review of the report is not part of this version: the dispatch judge (ADR-088) exists for pi and opencode
  targets only, and a Claude or Codex target has no ClaudeUI judge to ask. The report is delivered unreviewed, behind
  the untrusted framing below. (Intended: under a judged auto mode the judge reviews it and never blocks it, a report
  it objects to or could not review being delivered with a warning above it, as Claude Code does.)
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
  named in a marker. One ClaudeUI sanitiser (`src/shared/handback-frame.ts`) does this, because pi, opencode and Codex
  parents have no such defence of their own: exotic line breaks become LF; a `<` opening a system-reminder, harness
  envelope or signal tag, or `antml`, gets a backslash after it; a line starting `[harness`, `[subagent`, `[X-Agent`
  or `[hand_back]`, and the "NOTE: this agent stopped" line, are broken the same way; settings files,
  `bypassPermissions`, `--dangerously-skip-permissions` and `permissions.allow/deny` are only named; `Human:` and
  `Assistant:` at the start of a line are rewritten silently; a `[harness: report matched …]` marker names what
  matched. Invisible characters (zero-width, soft hyphen) hide none of this, and every pattern is bounded, so
  adversarial input costs linear time. The turn it starts is not a user turn: it cannot satisfy ADR-104's clean-user-turn gate, and the
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
- When a parent session disconnects, the sync reducer clears the session's task records and pending approvals. The
  dispatcher observes that status event and, after the clear, re-emits `task-started` for the parent's running
  X-Agents and every approval card they still wait on, so the card, the roster and the attention gate stay right
  while the parent is down. The trigger is the status, not the creation of a new session object: a cancel on the same
  object clears the cards without any re-creation, while a replacement clears nothing, and re-emitting then would
  show every approval twice. Approving a re-raised card resolves the target's gate as before. A re-raised approval
  card is marked, and a client that sees the mark lists the card but raises no attention and no notification for it:
  the user was told about that ask when it first came.
- History reload builds dispatch cards from the ledger, for every engine's read and for the sidebar's cold load as
  well as a resume: a finished row becomes a terminal task notification (idle is completed, failed is failed, stopped
  is stopped; interrupted is the neutral `unfinished`, since `stopped` means never resumed, with a summary that says
  it can be resumed), a running row an active task record that starts at the run's own start. A reopened parent is a
  historical session, in which no task is running, with one exception: a dispatch record is kept, so the card and the
  roster show the X-Agent running and the card's Stop reaches the dispatcher, which needs no live parent. The ledger
  holds no result text, so a reloaded card says that the X-Agent ended; the delivered text joins it with the report
  store. Replaying the child's full stream from its own transcript is later work.
- App quit ends the processes. On the next start, running rows become `interrupted` and the parent's inbox gets a
  notice naming the X-Agent; nothing resumes automatically.
- An X-Agent ends when the user stops it, when its parent session is deleted, or by a retention sweep of idle rows
  whose parent is gone; harness-side state is removed where the engine allows it. Ending means the run is stopped, the
  process released, its pending approvals dismissed and the row set to `stopped`, which is never resumed (Claude Code
  does not resume a stopped agent either). opencode's session is deleted and pi's session directory removed; Claude
  Code's transcript and Codex's thread stay on disk.
  - Stop on the X-Agent's card ends it, for a background run and for a blocking one alike. The parent's own interrupt
    of a blocking call (Esc) does not: the target stays resumable (`interrupted` or `idle`).
  - Deleting the parent session ends every X-Agent it owns, running or not, once the parent's engine has accepted
    the delete (Codex: thread by thread as the binary deletes them). A delete the engine refuses leaves them alone.
  - At start-up, rows whose parent session is provably gone are ended the same way. Only a Claude Code parent can be
    proven gone (no transcript in any project directory and no mention in the session registry); a parent of another
    engine, or any parent whose record store cannot be read completely, is left alone.
- A background run that ends while its parent is not live (no session object, or its engine is down) releases the
  X-Agent's process at once, leaving the row as the turn wrote it, instead of parking it for a continuation that may
  never come. A running X-Agent also holds its parent's idle timer (§3); when a run ends, the dispatcher asks the
  parent session to arm the timer again.

_Amended 2026-10-20 (slice B-2b): the re-raise trigger, the end paths, release after a run and the boot sweep._

_Amended 2026-10-20 (slice B-3a): §3's report tool, its per-engine wiring, the end of a run, the report store, the
sanitiser, the card and the blocking result. Delivery into the parent (the `dispatch-result` origin, the inbox, the
wake cap, the background default) is slice B-3b._

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
- Codex threads started before this change keep their tool set, so they cannot message their parent, and they cannot
  call `hand_back`: their last message stands in as the report, flagged.
- A report is not reviewed by a judge in this version, for any engine.

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
