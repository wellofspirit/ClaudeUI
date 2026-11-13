# Cross-engine dispatch and session tools

Governs: `src/core/services/cross-engine-dispatcher.ts`, `src/core/services/collab-tool.ts`, `src/core/services/dispatch-claude-targets.ts`, `src/core/services/dispatch-opencode-targets.ts`, `src/core/services/dispatch-pi-targets.ts`, `src/core/services/dispatch-target-judge.ts`, `src/core/services/dispatch-target-ledger.ts`, `src/core/services/dispatch-workdir.ts`, `src/core/services/session-tools.ts`, `src/core/services/session-delivery.ts`, `src/core/services/session-links.ts`, `src/shared/handback-frame.ts`, `src/shared/dispatch-agent-description.ts`, `src/shared/dispatch-concurrency.ts`, `src/shared/session-tools-description.ts`, `src/core/providers/turn-origin-ledger.ts`, `src/core/opencode/opencode-hosted-tools.ts`

How one session delegates to an agent on another engine (`dispatch_agent`, X-Agents) and how sessions start, hand off
to and message each other (`session_*` tools). Dispatch targets are Claude, opencode and pi
(`cross-engine-dispatcher.ts` is the engine-neutral core; `dispatch-claude-targets.ts`,
`dispatch-opencode-targets.ts` and `dispatch-pi-targets.ts` are the per-engine target classes). The judge that reviews
targets is `auto-mode-judge.md` (ADR-023, ADR-081 to ADR-084, ADR-091, ADR-106); deny/ask/allow rule ladders and pi path
containment are `permissions.md` (ADR-085, ADR-110); agent rosters and task-run identity (ADR-040, ADR-073) are
`agents-and-tasks.md`; pi's own subagents and `PiChildRunner` (ADR-089) are `pi.md`; dispatched spend in the usage
ledger and the API-equivalent cost gate (ADR-034, ADR-071) are `metering.md`; Claude agent definitions (ADR-103) are
`shared-catalogs.md`; the opencode 2.x wire for targets is `docs/protocol-opencode/README.md` ("Dispatch targets");
the peer-message envelope Claude Code sees is `docs/protocol-cc/15-peer-sessions.md`.

## A hosted `dispatch_agent` tool starts headless targets owned by the dispatcher (ADR-033)

A session on any engine delegates a task to an agent on a different engine or model with one hosted tool,
`dispatch_agent`. A single main-process service, `CrossEngineDispatcher`, owns all dispatch logic: target creation,
guards, approval forwarding, result await, cancellation. Every engine's tool registration delegates to it.

- **The tool.** Arguments: `engine`, `prompt`, `description` (3 to 5 words, required on a new launch), and optionally
  `model`, `name`, `run_in_background`, `workdir`. Each side's `engine` enum lists only the other engines;
  same-engine dispatch is refused ("use your own tools or a native subagent"). One shared description
  (`src/shared/dispatch-agent-description.ts`) steers each engine to its own subagent tool for ordinary delegation.
  `session_id` is not an argument any more: a call that passes one is told to message the agent with `session_message`
  (ADR-105 §4).
- **Registration.** Claude: a separate in-process MCP server, `claude-ui-collab`, so the tool does NOT ride the
  auto-allowed `mcp__claude-ui__` prefix and goes through `canUseTool` like any ordinary tool. opencode: the hosted
  `claudeui` server (`claudeui_dispatch_agent`), gated by an `ask` rule appended AFTER the user's compiled rules, so a
  blanket user allow cannot silently un-gate it. pi: the bridge's `registerTool` over the same host. The card kind is
  `task` (`mcp__claude-ui-collab__dispatch_agent` maps to it), with "engine . model" in the badge slot.
- **The capability flag** `crossEngineDispatch` is true for an engine only while some target engine is installed
  (`crossEngineDispatchAvailable`); the tool registration and the settings sections gate on it.
- **Caller identity on opencode.** opencode names the caller session in `_meta["ai.opencode/sessionID"]`, which wins;
  the ClaudeUI plugin (`resources/opencode/claudeui-xeng`) stamps `__xeng_caller_session` and `__xeng_call_id` into the
  tool args as the fallback. They are DECLARED optional fields of the tool schema because the host's `z.object()`
  strips unknown keys; the handler reads and strips them. A subagent child's call is resolved through `parentID` to the
  chat it descends from. The tool-call id keys the streams and task events onto the model's own card.
- **Targets are headless, dispatcher-owned mini-sessions, not `ISession`.** No sidebar entry, no renderer session,
  no `SessionManager` coupling, no rekey coupling. Each engine's target class sits behind `DispatchTargetHost`. Output
  streams into the dispatching chat through the engine-neutral `session:subagent-*` / `session:task-*` events keyed by
  the dispatching tool-use id, so the card renders like a native subtask; the "send to background" affordance is
  suppressed on dispatch cards.

### §4 Recursion is structurally impossible

Dispatcher-created targets never get the collab server or the dispatch tool: Claude targets are not given
`claude-ui-collab`, pi targets' bridge never registers `dispatch_agent`, opencode targets' rulesets deny
`claudeui_dispatch_agent*`. There are no depth counters. Only dispatch TARGETS are cut off; that is the whole
recursion guard. Native subagents of Claude and opencode may dispatch (an opencode child's call resolves to its chat
through `parentID`): the call's owner (`callOwner`, from the stream) only picks the background default (ADR-105 §2),
so a subagent's call is blocking by default and an explicit background one is marked `fromSubagent`.

### Approval forwarding goes to the dispatching session's user

A target's approval request is re-emitted as `session:approval-request` under the DISPATCHING session's routing with
the reserved requestId prefix `xeng:` (`XENG_REQUEST_PREFIX`). The approve IPC handler (`ipc/approval-response.ts`)
routes that prefix to the dispatcher, not to the session, and the answer resolves the target's own gate. Rules:

- A target never has its own approval UI and never decides a forwarded ask by itself; with no judge the card is the
  human's. Child sessions of a target (opencode task children) are registered so their asks are forwarded too.
- Every target carries the user's deny and ask rules, never the allow rules (ADR-085 §2), and the host's robust matcher
  runs on every forwarded ask: a denied command is refused and an ask-rule command reaches the human in every mode.
- A target parked on an unanswered forwarded approval counts as alive for the inactivity limit, and the answer starts a
  fresh window. The absolute limit keeps running while parked, deliberately.
- A give-up path (timeout, stop, caller abort) dismisses the target's pending approval cards.
- Stop rides `session:stop-task` with `isDispatch`; a Stop that reaches the dispatcher before the call registered arms a
  pending stop-intent, consumed at registration. The intent has no clock: Claude Code runs a first-party MCP call only
  when nothing else in its assistant message is executing, so a second dispatch can start minutes later. It lives until
  consumed, the dispatching turn ends, the session is disposed or it is deleted. A stopped blocking dispatch surfaces
  to the caller as an error result ("Dispatch stopped by user."), which on opencode is a model-visible corrected error,
  so the card ends neutral.

### Guards and the user's limits

All limits are read at the gate on every call (no restart needed) and none has a built-in default except the
concurrency count.

- **Concurrency.** `AppSettings.dispatchMaxConcurrent` (ClaudeUI's own settings, not an engine file; it counts every
  in-flight dispatch in the process). `resolveDispatchMaxConcurrent` (`src/shared/dispatch-concurrency.ts`) is the one
  rule, shared by the gate and the Settings row: unset, non-numeric or negative means 3; `0` means no limit; otherwise
  the value floored, at least 1. Over the limit a launch is refused (never queued), naming the effective cap and that
  `0` means no limit. Reset in Settings clears the key.
- **Per-engine config** `engines/<engineId>.json#dispatch` (`DispatchConfig`, edited in Settings > engine >
  Cross-engine dispatch, governing dispatches INTO that engine): `allowedModels` (a non-empty list refuses any other
  model), `defaultModel`, `maxCostUsd` (a cumulative per-target cap: a continuation or message run is refused once the
  target's spend has met it; the target survives; the cost source and the API-equivalent gate are ADR-071,
  `metering.md`), `turnTimeoutMs` and `idleTimeoutMs`.
- **No built-in time limit.** A dispatched agent may run indefinitely. Only the user stopping it, the caller aborting
  it, the user's configured limits or the cost cap end a turn early. Empty, `0` and a hand-edited negative all mean no
  limit (`resolveTurnLiveness`). One watchdog (`startTurnWatchdog`, 10 s poll on the injectable clock) serves every
  direction: an absolute cap and an inactivity cap, each timeout text naming which cap fired and the configured
  minutes. With both unlimited no interval is armed. Each direction bumps `lastActivityAt` from its own event feed as
  far upstream as it goes, so an event the mapper drops still proves life.
- **Long calls from the caller's end.** cli.js's MCP call timeout is off unless `MCP_TOOL_TIMEOUT` or a per-server
  `timeout` is set (idle-reset by progress); ClaudeUI never sets it, so a user's own environment variable applies to a
  dispatch like any MCP tool. An interrupted dispatching turn aborts an in-flight blocking call; there is no orphan
  reaper.

### Targets, per engine, in short

- **Claude targets** are a `bun-claude` process per run via the engine's query layer, driven by a manual
  `iterator.next()` loop (the handle's `asyncIterator.return()` kills the child, so `for await` with `break` is
  forbidden). One iterator per target: a concurrent run on the same target is busy-rejected. Persisted, never
  `persistSession: false`.
- **opencode targets** (2.x) are sessions on the shared per-server feed under an exact lease, driven by an inbox prompt
  and settled by the event mapper (`docs/protocol-opencode/README.md`, "Dispatch targets"). `OpencodeClient.prompt()`
  (synchronous POST) is not for dispatch: a long turn dies on the 300 s fetch ceiling.
- **pi targets** are a headless `PiRpcClient` plus a per-target `PiBridgeHost` (ADR-035).
- Usage is captured per turn into the usage ledger (origin `dispatch`), attributed to the DISPATCHING session; a DB
  error drops the row with a warning and never fails the dispatch (`metering.md`).

## An X-Agent is a durable, background run beside its parent (ADR-105)

`dispatch_agent` starts an X-Agent: a real session of the target's harness that runs as if it were a subagent. It
supersedes the older blocking-only dispatch over in-memory targets and `session_id` continuation.

### §1 The ledger row owns the target, the parent is resolved live

- Each target has a row in the dispatch ledger (`dispatch_target`, operational.db): its ClaudeUI id (a session ref
  `s-xxxxxx`), engine, the harness's own session id, the parent's durable session id, the launching tool call, `cwd`,
  `parent_cwd`, model, account, the caller restriction it was created with, `name`, `description`, `launch_mode` and
  state (running, idle, stopped, failed, interrupted). Cost is never stored there: it is derived from `usage_event`
  rows with origin `dispatch`, so one source of truth.
- The target is owned by the parent's DURABLE id, never by the launching call's context. Every read of the parent (the
  judge's live autonomy mode, its transcript, its blocked calls) and every event the target emits resolves the live
  parent at that moment (`dispatch-parent.ts`). With no live parent the mode falls back to the ledger's `launch_mode`,
  and while the parent's engine is down the judge uses the stricter of the current and launch mode, never a looser one.
- Each harness keeps the target's session, hidden from the sidebar: Claude with a transcript on disk (the history list,
  block usage and the usage backfill skip ledger ids through one shared predicate, so spend is never counted twice);
  pi with its own session directory under `~/.claude/ui/dispatch/pi/`; opencode's session is no longer deleted (its
  `xeng-dispatch` title hides it). Claude target transcripts live in the project's own transcript directory, so Claude
  Code's `--resume` picker run there can see them.
- The product label is "X-Agent". `name` is a short handle, unique among the parent's live children; `main`, `origin`,
  `parent`, `self` and ref-shaped strings are reserved and refused as names. The dispatcher refuses a launch without
  `description` because not every engine enforces a tool's schema. Ledger and report rows are never deleted.

### §2 Background by default, one run engine

- A root agent's dispatch runs in the background; a subagent's waits for the result; `run_in_background` overrides
  either. The default is decided by each engine's REGISTRATION of the tool, never by the dispatcher (whose own default
  stays waiting): background for the top-level agent provided the call carries a tool-call id (the card shows, stops
  and reports the run), waiting for a subagent or an unattributable caller. Claude attributes each call from the frames
  cli.js streams; opencode's chat agent is the caller and a subagent child is not; pi registers the tool for the root
  agent only, so every pi call is background.
- A background launch validates synchronously, spawns asynchronously and returns at once with the X-Agent's id and
  name, so several dispatches in one message do not wait on each other. The waiting form launches the same background
  run and awaits it: there is one run engine, and a resume uses it too. The run is registered by its ledger id for its
  whole life (stop, progress, liveness) and is never tied to the launching MCP request.
- The parent's session receives the same task lifecycle as its own background agents (`task-started`, `task-progress`,
  `task-notification`). Task records carry `wakesParent`, set by whoever emits them; the attention gate and the
  sidebar's subagent count read that field, not a list of task types.
- Over the concurrency limit a background launch is refused with the limit in the message. A parent's idle timer is held
  while it owns running X-Agents and re-armed when the last run ends.

### §3 Results come back through `hand_back`, reviewed and framed

- **The report is a tool call.** An X-Agent reports with `hand_back { report }`, as Claude Code's subagents do. The
  final turn text is never the report (it can carry leaked reasoning or stray output; a tool argument cannot). Every
  target engine gets the tool and only a dispatch target does; any other caller is refused. Claude: a one-tool
  in-process server `claude-ui-handback` built per spawn, attributing the call from the stream (a subagent's call or
  an unattributable one is refused). pi: the bridge extension's `hand_back` under its own gate. opencode:
  `claudeui_hand_back` on the hosted server, accepted only from the session of a live target; interactive rulesets
  deny it, a target's ruleset allows it in every mode.
- **One report per run**, a run being the launch or a resume by a message. The call ends the run (the result tells the
  agent to stop for this run and that a later message starts a new one); a second call is refused. The turn is ended
  where the engine has no native way to: pi's `terminate` hint, an interrupt on the call's tool result for Claude, an
  interrupt after the call's tool item completes for opencode (never when the turn ended by itself first). The run's
  result is the stored report, never later turn text. A run that ends without a report is nudged into the same session
  up to 3 times (`MAX_HAND_BACK_NUDGES`), not past its cost cap, except while a Claude target waits on an agent or
  workflow of its own; after that the parent is told it ended without a report. A Claude target's turn counts as ended
  only after cli.js reported one of ClaudeUI's own uuid-carrying frames started.
- **Stored per run** in `dispatch_report` (one row per run whatever the end: delivered, flagged, withheld, fallback,
  stopped, failed, timeout), kept as received up to a size cap; the sanitiser runs where it is shown or delivered. The
  card shows the stored end live and after a reload; a message-started run is run n+1 of the card the X-Agent was
  launched from.
- **The report is reviewed by the X-Agent's OWN judge, and the review FLAGS, never blocks.** It runs only while the
  X-Agent runs in a judged auto mode; otherwise the report goes as written. pi and opencode: ClaudeUI's judge on a
  synthetic `hand_back` call (a hand-back `ClassifierAction`, the first 16 000 characters, stage 2 only in `both`
  mode, stage 1 alone deciding in `fast` mode, evaluation rule 15 of the policy, a throwaway denial tracker, no card),
  awaited by the turn body for at most `HAND_BACK_REVIEW_MS` (twice the stage-2 budget plus 10 s, 250 s, because a block
  is confirmed by a second stage-2 sample, ADR-106 §2), then aborted. Claude: Claude Code's own classifier reviews the MCP call as an
  ordinary action (a weaker review, no rule 15): the report tool is pre-allowed only where cli.js would otherwise deny
  it (`dontAsk`, `bypassPermissions`); in the asking modes `canUseTool` allows it so the classifier sees it in auto.
  A blocked call never reaches the handler, so ClaudeUI takes the report from the announced call, accepts it flagged
  with the classifier's reason and ends the turn when the denial goes by. An ask raised under auto (denial cap, long
  transcript, mode change) is allowed through but never as a clean one.
- **What the verdict does to the delivery.** Allow: as written (`delivered`). Block: `flagged` under "SECURITY WARNING:
  auto mode blocked this X-Agent's report. Reason: ...". A review the provider refused: Claude Code's UNREVIEWED
  warning. A review that did not happen (no route, timeout, error, mode left, run stopped): NOT flagged, with "Note: the
  report could not be reviewed (...). Please verify it carefully." above it. The reviewer's reason is untrusted: cut at
  500 characters and sanitised. The warning is stored (`dispatch_report.warning`) and shown on the card and as the
  line above the frame.
- **One item is delivered into the parent when a background run ends**, by the parent's durable id, through each
  engine's host-delivery path (folded into a running turn at its next tool boundary, or starting a turn). A blocking run
  delivers nothing: its framed report is its tool result. The item says: the report (status line with tool uses,
  tokens, time and cost so far, then the framed report; cut at 16 000 characters, and so the whole stays under 19 000
  because the host cuts a delivery at 20 000, the pointer to the card never being the part lost), or "ended without
  delivering a report", or "failed: <first line>", or "was stopped by the user", or, for an X-Agent that was running when
  ClaudeUI quit, an "interrupted" notice in the parent's inbox at the next start (no attention raised). `delivered_at`
  is stamped when the item is handed to the parent's engine, not when it is held. An X-Agent result is held past the
  inbox cap and never refused for capacity, because it is the only trace of the run the parent model gets. A launch that
  failed before the X-Agent existed, and a run whose parent was deleted, deliver nothing.
- **Origin `dispatch-result`.** It wakes the parent, is NOT counted in ADR-104's ten-turn budget, and has its own cap
  of 25 wakes since the user's last prompt (`DISPATCH_WAKE_CAP`; past it the result is held). It still taints the
  session like any agent text and cannot satisfy the clean-user-turn gate. The sender is named behind an `x-agent:`
  prefix on the ledger id (it survives every engine's echo and cli.js's envelope round trip), so the transcript row
  reads "Report from X-Agent <name>", "from an X-Agent, not from you", never "Message from"; a native peer cannot take
  that label by naming itself so. A Claude parent reads cli.js's fixed peer wrapper (only `from` and `from-name`
  differ; the `[X-Agent report]` header inside marks it untrusted); the other engines get ClaudeUI's own wrapper.
- **The report is agent-authored, untrusted output with no user authority**, on every parent engine. One sanitiser,
  `src/shared/handback-frame.ts`, indents every line, neutralises harness and system tags, turn markers, frame-prefix
  lines and permission-escalation strings (named in a `[harness: report matched ...]` marker), and survives invisible
  characters; every pattern is bounded.
- **A parent that is not live** (no session object, its engine down, wake cap reached, engine refusal) holds the item
  in its inbox (ADR-104). It is flushed, with wake, at one edge: the first `session:status` `idle` of a session object
  whose engine is up (`isEngineLive()`), after the session was armed by `disconnected`, `session:created` or a hold.
  A replacement of the object sends no status and flushes nothing; a turn end flushes nothing. The flush delivers
  held results, oldest first, one chain with the prompt path's flush, stopping at the wake cap; a held message of an
  X-Agent whose result is held rides along ahead of that X-Agent's later result (`messagesBeforeResults`), while the
  parent has agent-turn budget; the rest of the inbox waits for the user's prompt. A bare reopen of a
  disconnected session starts no engine; its held results arrive with the user's next prompt, whose spawn flushes first.
- **A result that had to wait raises attention**: the replicated signal `session:dispatch-result-held` makes every
  client set `needsAttention` and post an OS notification "X-Agent <name> finished - result waiting", unless the user
  is looking at that session.

### §4 Messages both ways go through `session_message`

- X-Agents are addressable for `session_message` and nothing else: `session_get`, `session_read`, `session_usage` and
  `session_stop` refuse them. An X-Agent is addressed by ref or by `name`, resolved only among its parent's own
  non-stopped X-Agents. `session_list` shows a session's own X-Agents and nobody else's.
- **Ownership is enforced by the tool service in every permission mode, `bypassPermissions` included**: a session
  messages its own X-Agents, an X-Agent messages its parent (`session: "origin"`, `"parent"` or the parent's ref),
  nothing else. No descendants, no sibling messages. An X-Agent runs `session_message` and no other session tool,
  and not once its run is over; each message is audited with the X-Agent's ref as actor.
- **Parent to X-Agent.** Framed as a message from the session that dispatched it, acting for the user. A running
  X-Agent takes it as a steer into its running turn on its engine's path; one still starting is waited for (bounded).
  Any other non-stopped X-Agent is RESUMED through the one run engine as a background run with the message as input
  (the harness's own resume, the cost cap, the model allowlist, the slot, the nudges, the review, the delivery). Every
  run's process is released when it ends, so a message to a finished X-Agent resumes its harness session from the
  row. Messages to one X-Agent are taken one after another. A message-started run's input says it is a new run to which
  the earlier `hand_back` does not apply and asks for a new report.
- **A steer is not an answer.** Each steer is tracked until the report is accepted. It is ANSWERED if the engine took it
  into the turn before the report call (Claude `command_lifecycle` started for its uuid; pi's `deliveryId` seen
  arriving; opencode's inbox item delivered; the engine's own message item). Otherwise it is UNANSWERED: when the report
  is accepted the engine's held copy is taken back before the tool result goes out (Claude `cancel_async_message`,
  opencode `DELETE .../inbox/:inboxID`; pi's deferred copy is context only), and when the run has settled the
  unanswered messages start the next run, once, in order, also after a run that ended without a report, but not after
  a Stop, a deleted parent or a failed run. A turn that starts on such a message with no run in flight is interrupted
  at once. A lagging opencode feed can make a read message look unanswered, costing a duplicate run, never a lost message.
- **X-Agent to parent.** Untrusted model output: defused like a report (`sanitizeReport`, idempotent, with a marker
  line when something matched), then delivered as a peer message through ADR-104's path: counted in its ten-turn
  budget, marking the turn non-user, held in the inbox when the parent is not live, carrying the X-Agent's mode class.
  Its sender key is `x-agent-message:<ref>`, so the row reads "Message from X-Agent <name>".
- **An outgoing message is judged as the X-Agent's own action.** In a judged auto mode its own judge reviews it and a
  block REFUSES the send (the X-Agent gets the reason; nothing reaches the parent, no inbox row, no budget spent):
  unlike a report, a message is not terminal and can be rephrased. Outside a judged auto mode it is sent without
  asking, as `hand_back` is. Claude: the tool is pre-allowed only in `dontAsk` and `bypassPermissions`, `canUseTool`
  allows it in the asking modes and Claude Code's classifier reviews it in auto; an ask for it raised under auto (denial cap, no verdict) goes to the
  human through the parent's approval surface and is NOT waved through as `hand_back` is. pi and opencode: ClaudeUI's judge
  through the target's normal gate and denial tracker, classified as a message to the spawning agent under rule 15.
- **Offered per engine to dispatch targets only**, and only while the session tools are on: Claude gets a
  `claude-ui-sessions` server holding that one tool; pi a one-element `CLAUDEUI_PI_SESSION_TOOLS`; opencode denies the
  other eight by name.

### §5 Lifetime is the X-Agent's own

- A parent's restart, cancel, effort or account respawn no longer ends its X-Agents. A running one finishes and
  delivers; an idle one's process is released and resumed on its next message; pending approvals stay pending.
- When a parent session disconnects, the sync reducer clears its task records and pending approvals. The dispatcher
  observes the status event and, AFTER the clear, re-emits `task-started` for the parent's running X-Agents and every
  approval card they wait on. The trigger is the status, not creation of a session object (a replacement clears
  nothing; re-emitting then would show each approval twice). A re-raised card is marked so a client lists it but raises
  no attention or notification.
- History reload builds dispatch cards from the ledger on every engine and on cold load: idle is completed, failed is
  failed, stopped is stopped, interrupted is the neutral `unfinished` (resumable), running an active record. A
  reopened parent is a historical session in which no task runs, except that a dispatch record is kept: the card shows
  the X-Agent running and its Stop reaches the dispatcher. The ledger holds no result text; the delivered text joins
  it with the report store.
- **App quit ends the processes; nothing resumes automatically.** At the next start a `running` row whose owner is gone
  becomes `interrupted` and the parent's inbox gets a notice ("continue it by messaging it with session_message"). A
  `running` row records its owner (process id plus a random per-boot id); the owner is gone when its boot id differs
  and its pid is not running, or its pid is this process's own under another boot id. A row owned by a live second
  instance sharing the database is left alone; a row with no owner (older build) is interrupted.
- **What deletes or hides X-Agent state.** An X-Agent ends only when the user stops it, when its parent session is
  deleted, or at start-up when its Claude parent is provably gone. Ending means: run stopped, process released,
  pending approvals dismissed, row `stopped` (final, never resumed, and later state or owner writes are ignored);
  harness-side state is removed where the engine allows it (opencode's session deleted, pi's session directory
  removed; Claude Code's transcript stays on disk). Detail:
  - Stop on the X-Agent's card ends it, background or blocking. The parent's own interrupt (Esc) of a blocking call does
    NOT: the target stays resumable.
  - Stop on a `running` row nothing in this process runs (a crash-left row whose pid was reused, or one a second instance
    runs) sets it `stopped` and notifies the parent, with no stop intent armed. Only a row the calling session owns is
    ended this way, and harness state is removed only when no other live instance owns the row.
  - Deleting the parent ends every X-Agent it owns, running or not, once the parent's engine accepted the delete; a
    refused delete leaves them alone.
  - The start-up sweep ends rows whose parent is provably gone. Only a Claude Code parent can be proven gone (no
    transcript in any project directory AND no mention in the session registry); a parent of another engine, or any
    parent whose record store cannot be read completely, is left alone.
- When a run ends, background or blocking, its target's process is released (Claude process, pi, the opencode lease)
  whether or not the parent is live, as the last step after its result is delivered and its unanswered messages are
  sent again. The row stays `idle` (or `failed`); only a message continues a target. The release is skipped while
  another run holds the target.
- The approval card and the OS notification name a first-party tool by its product name ("X-Agent", "Hand back",
  "Session . message"), not by its wire name. The parent's sidebar dot stays violet while its X-Agents run (ADR-095).

Accepted limits, not bugs: a Claude target moved into auto mid-turn reads the mode at its NEXT ask (an ask raised under
the old mode is allowed clean); the Claude review of a report is an action review; the live card of a report over
16 000 characters shows it cut until the session is reopened; a `running` row whose pid was reused by an unrelated
process stays `running` until a turn or Stop; a Stop on a row another live instance runs does not reach it; a stopped
turn writes no usage row, so its spend no longer counts toward the cost cap after release; a stray execution after
release is neither carded nor judged; no cap limits how many messages a session sends one X-Agent in a turn; a message
to an idle X-Agent is a paid run that counts against `maxCostUsd` and the concurrency limit; a message run that fails
before binding a ledger id leaves the previous run's live entry parked until the parent is disposed; between a run
leaving the registry and its result's delivery a message can start the next run, whose result could overtake the
earlier one only if the earlier delivery stays blocked behind the serialised inbox chain for longer than a model turn.

Rejected, and likely to be proposed again: marking `dispatch_agent` `readOnlyHint` so Claude Code runs several at once
(it leaves the parent blocked and lets the tool through plan mode without asking); continuing through `session_id`
(launching and talking stay separate tools); queuing launches over the limit (a refusal tells the model to wait); using
the final turn text as the report.

## A target inherits the parent's auto mode live and is judged (ADR-088)

Everything a parent in auto mode spins off inherits auto mode, READ LIVE from the parent at every decision point, and
is judged. A target's auto mode is never allow-all, and its mode is never frozen at creation. There is no push
notification: a switch is pulled at the next decision point.

- **Who judges.** A Claude target keeps cli.js's own judge (`permissionMode: 'auto'`, never `bypassPermissions` for an
  auto parent; no skip flag). pi and opencode targets use ClaudeUI's own judge (ADR-081 transport) through
  `DispatchTargetJudge` (`dispatch-target-judge.ts`, one per target). `bypassPermissions` on the parent still spawns a
  Claude target bypass plus `allowDangerouslySkipPermissions` (a parent in bypass is not in auto), still subject to the
  user's deny/ask rules passed as `--settings`; `plan` maps to `default`; `full` is read as `auto`.
- **Live mode per engine.** Claude: `set_permission_mode` at the next continuation turn or the target's next ask; a
  rejected `auto` falls back to `default` with one `session:warning` and is not retried on that process;
  `bypassPermissions` is never applied to a process spawned without the skip flag. opencode: every ask reads the
  parent's mode (the ruleset is a creation-time snapshot; a PATCH only appends). pi: every gate call reads it; a judged
  auto target decides from the `acceptEdits` base and an `ask` goes to the judge. With the TARGET engine's
  `autoMode.enabled === false` an auto parent's pi or opencode target has NO judge and gates like `default` (asks go to
  the human; pi never decides from the allow-everything auto base, ADR-110).
- **Residuals, accepted.** An opencode target created under `default` and switched into auto is judged on every ask (more
  asks than needed, never fewer); one created under `acceptEdits` keeps the server-side edit allow except agent-control
  patterns. Asks already parked on the human when the parent switches into auto stay with the human. A mid-turn switch
  OUT of auto for a Claude target binds at its next turn in practice (cli.js's own judge decides first).
- **Claude target preamble.** cli.js's judge sees only the target transcript, where the dispatch prompt is a `user`
  message, so every prompt pushed to a Claude target is prefixed with `DISPATCH_PROMPT_PREAMBLE` ("Task delegated to
  you by another agent acting for the user:"). pi and opencode targets need none.

### §shared One judge pipeline, no third copy

The engine-neutral judge steps are one module, `src/core/automode/judge-pipeline.ts` (`runJudgePipeline(action,
hooks)`): category fast path, read-only gate, allow-rule gate (skipped when no `allowRuleAction` hook), the
fail-closed stale-judge-model check, ground truth, classify, settle check, denial caps, outcomes, review. `PiSession`,
`OpencodeSession` and `DispatchTargetJudge` all run on it; engine specifics are hooks (`inputFor(stage)` for opencode's
ask-before-input ordering, `stillPending(stage)`). G9 (a user ask rule goes to the human) stays in each caller, before
the pipeline; opencode's agent-control edit fast path stays in the session. A fix to a gate lands once.

### D1 The target judge reads the parent transcript plus the target's own trajectory

The judge reads the PARENT transcript followed by the TARGET's own assistant trajectory: its forwarded messages with
every `user`-role message removed, upserted by id, bounded to the most recent 200 (`TARGET_TRAJECTORY_MAX`), kept across
continuation turns and merged in time order (ADR-091). The parent's human turns stay the only `User:` lines, the only
real authorisation; the child's own earlier calls tell the judge what it already did. Rejected: the parent transcript
alone (the judge cannot see what the target did) and the target's alone (its only `user` message is another agent's
prompt, so the user's intent never appears).

- Host and engine notes are never human turns: `slimTranscript` skips every `role: 'system'` message on every engine
  (compaction, API errors, agent messages, task notifications, `send_message` deliveries).
- **Amendment (ADR-088 amendment: agent notes are system rows).** cli.js delivers a background agent's `<task-notification>` as a `user`
  frame; ClaudeUI records it as the shared agent note (`services/agent-note.ts`: `role: 'system'`, labelled "from an
  agent, not from you"), live and on reload. Recognition is structural (`origin.kind`), with the XML only as a
  fallback for a frame without `origin`; a typed prompt never becomes a system row. Live, the note is built from
  `system/task_notification`, not from a user frame (cli.js does not put it on stdout).
- A Claude session records the user's own prompts locally (a queued one when cli.js takes it); a RESUMED Claude session
  starts with an empty history, so its targets' judge sees only the current process's turns. opencode's own synthetic
  user text (`synthetic: true`) is dropped on replay.
- **The action** is headed as the `dispatch:<engine>` subagent's, with the target's model as description and the LATEST
  dispatch prompt as its task. **Model:** the TARGET engine's `autoMode.judgeModel`, else the target's model; a
  configured model the catalog no longer lists fails closed to the human with one banner per target. **Usage:** every
  judge call is a `judge` ledger row with `parentRoutingId` = the dispatching session's routing id.
- **Environment:** the user's deny/ask rules (allow empty, exactly what binds a target), the shared trust lists,
  session-start git remotes per target, and the target's scope (ADR-108). Per target: denial caps and the outcome map
  keyed by the target's own tool ids. Verdicts go out as `session:tool-review` under the dispatching routing with the
  TARGET's tool id, so they land on the TaskCard.
- An opencode target's own task children contribute nothing to the trajectory (their parts are not on the target's
  accumulators); they are judged on the target's trajectory. Known gap, not a context bug.
- Hand-back and outgoing-message reviews of X-Agents are ADR-105 §3 and §4.

Rejected: a push-based mode notification (a new seam through every session class for what a pull gives).

## A dispatched agent may run in its own directory, and its scope is the user's workspace (ADR-108)

- **`dispatch_agent` takes an optional `workdir`** (all hosts): absolute, `~`-led or relative to the dispatcher's
  working directory. `resolveDispatchWorkdir` (`dispatch-workdir.ts`) realpaths both sides and accepts it only inside
  the dispatcher's working directory or one of the user's additional directories (the settings merge for the
  dispatcher's directory). **Containment is decided BEFORE existence**, so a refusal never reveals whether an outside
  path exists; then it must be an existing directory. The target starts in the canonical real path (so a link swapped
  in after the check cannot redirect it) and the ledger stores that real path. A continuation cannot change an
  X-Agent's directory: `workdir` together with a resume field is refused.
- **Ledger.** `cwd` is the target's own directory; nullable `parent_cwd` holds the dispatcher's (NULL on older rows
  means the same as `cwd`). A resume or message whose stored directory no longer exists (a removed worktree) is
  refused with a clear message before anything spawns; restoring the directory makes it resumable again.
- **Rules union.** A target's deny and ask rules are the union of the rules for the dispatcher's directory and for the
  target's, parent first. They only tighten: a worktree target never loses the parent's `.claude/settings.local.json`
  rules. Allow rules are empty in every target ruleset (ADR-033, ADR-085).

### Amendment of 2026-10-24: a target's additional directories are its workspace

This is the amendment of 2026-10-24 to ADR-108 (it replaced a context-only reading of those directories).

A target's scope is its working directory, the dispatcher's working directory when the target runs elsewhere, and the
user's additional directories from the settings merge for both directories (each entry resolved: `~` expanded, a
relative entry against the directory whose settings it came from; the union de-duplicated). This is the target
ruleset's `additionalDirectories` on EVERY engine, so every gate sees it: the read-only bypass (ADR-084), opencode's
compiled `external_directory` allows and host pre-check, and `--add-dir` for a Claude target. The judge's environment
and redirect scope read the same list; there is no separate context-only channel. Directories sent to an engine
(`--add-dir`) are only those that exist at send time. pi and opencode targets re-read the scope per gate call; a
Claude target gets it at process start like its `--settings` rules, so a settings edit reaches a running Claude target
at its next spawn or resume.

Consequence, accepted: a broad additional directory widens every target as much as it widens the user's own sessions
(a workspace root makes every project under it local to every target and reads there skip the judge).

## A Claude target runs under the Claude engine's sandbox and at a new session's effort (ADR-116)

A Claude dispatch target is a Claude Code process of ClaudeUI's, so the two Claude engine settings that decide how
its commands run apply to it as they do to a session: the command sandbox (`engines/claude.json#sandbox`) and the
starting effort for its model. A target loads no settings source, so without this its Bash ran unsandboxed while
the sandbox was enabled, and it ran at Claude Code's own default effort.

- **Sandbox.** The engine's sandbox settings reach a target through the mapping a session uses
  (`claudeSandboxOption`, `src/core/sdk/args.ts`; one function, so the two are never confined by different rules)
  and in the same `--settings` JSON as its behaviour switches and its deny and ask rules. As for a session, the
  sandbox is required to start: where it cannot run (Windows as Claude Code ships, Linux without bubblewrap)
  Claude Code refuses to start and the dispatch fails; a target never falls back to running unsandboxed. The
  filesystem and network lists, the excluded commands and `allowUnsandboxedCommands` are the engine's.
- **Never auto-approved.** `autoAllowBashIfSandboxed` is the one setting a target does not take: it is always sent
  as `false`. A sandboxed command of a target is gated by everything that gates its Bash without a sandbox: the
  forwarded approval card, Claude Code's classifier in auto mode, the user's deny and ask rules, and the host's
  matcher on every forwarded ask (ADR-085). Two reasons. Claude Code suspends the auto-approve in plan mode, and a
  target never runs in plan (`plan` maps to `default`, ADR-088), so a plan-mode session's target would run commands
  a plan-mode session asks about. And an auto-approved command never reaches the host, so a target's deny and ask
  rules would be matched by Claude Code's text prefix alone. The key is sent explicitly because Claude Code reads
  an absent one as true. The sandbox therefore only ever tightens a target.
- **Outside the sandbox.** An excluded command, and a command the agent asks to run unsandboxed where the engine
  allows it (`dangerouslyDisableSandbox`), go through the target's normal gate. A connection the sandbox refuses is
  asked about as `SandboxNetworkAccess` and forwarded to the dispatching session's user like any other ask.
- **Effort.** A target starts at the effort a new Claude session gets for its model with no pick of its own: the
  user's saved starting effort for the model, else the model's default, clamped to the levels the model accepts
  (the ladder an automation run uses, `resolveAutomationEffort`). No `--effort` is sent for a model that takes
  none, nor for `default` while the model catalog has no row for it: which model it names is then unknown, and a
  guess would replace Claude Code's own default. `dispatch_agent` has no effort argument.
- **Read at spawn, stored nowhere.** Both are read when a target's process is spawned, for a new target and for a
  resume; the ledger records neither. A target resumed after a setting changed runs under the setting of that
  moment, on or off. A process already running keeps what it was spawned with, including a run that continues a
  target whose earlier result is still being delivered. This is the binding a target's `--settings` rules and
  `--add-dir` scope have (ADR-108).
- **Nothing else changes.** A target still loads no settings source, gets no hosted tools, and keeps its own
  permission mode and rule handling (ADR-033, ADR-085, ADR-088).
- **A dead process says why.** Claude Code explains a refusal to start on stderr only, so the failure a target's
  run reports quotes the last lines its process wrote there.
- **An automation run is bound the same way** (added 2026-11-13). It is the other Claude Code process of ClaudeUI's
  that runs commands without being a session. It carries the engine's sandbox through the same mapping, required
  to start, read at each run and at each follow-up message, and never auto-approved (`claudeGatedSandboxOption`,
  one function for a run and a target). Nobody is present at a run: its gate is Claude Code's classifier in auto
  mode and otherwise a callback that denies every ask, and auto-approval would take every sandboxed command past
  both. A run that Claude Code refuses to start records the reason; its notification shows the first line. Unlike a
  target, a run loads the user's settings sources as a session does: their sandbox lists merge with the engine's,
  and while the engine's sandbox is off a sandbox set in the user's own settings file applies to a run as it does to
  a session.

Rejected: taking `autoAllowBashIfSandboxed` as a session does (wider than a session in plan mode, and it removes
the host-side deny and ask matching from a target's Bash); recording on the ledger row that a target was created
sandboxed, so it stays so (the setting is the user's, and a session resumed after the change follows it too); an
effort argument on `dispatch_agent`.

## Sessions start, hand off to and message other sessions with one tool family (ADR-104)

A hosted family on every engine, with one description source (`src/shared/session-tools-description.ts`):
`session_list`, `session_get`, `session_read`, `session_message`, `session_start`, `session_dismiss_proposal`,
`session_hand_off`, `session_usage`, `session_stop`. On Claude it is its own in-process server `claude-ui-sessions`,
outside the auto-allowed `claude-ui` prefix; on opencode it joins the hosted `claudeui` server; on pi the bridge
registers it. Only the root agent of an interactive session gets them: subagents, host-run pi subagents, automations
and side questions are refused (opencode's children are not even offered them), and a call that cannot be attributed
is refused. Requests that would ask go to the user, never to the auto-mode judge. The names never resemble Claude
Code's `SendMessage` or pi's `send_message`, and ClaudeUI does not host or override `SendMessage` routing or
`ccd_session_mgmt` (rejected: an undocumented internal contract, and `SendMessage` serves subagents and teammates).
`dispatch_agent` keeps its meaning (non-interactive background agent owned by the calling session); `session_start`
creates a session exactly as the user would, interactive in every client's sidebar. The one exception to root-only is
an X-Agent and its dispatching session messaging each other (ADR-105 §4).

- **Fresh briefs only.** A new session never receives a copy of the starting conversation: it starts from a brief
  (task plus at least 80 characters of background) or, for a hand-off, from a handoff the old session wrote. The point
  is to leave an overgrown context behind. Rejected: forking the conversation.
- **Hand-off as content.** `session_hand_off` takes the text as an argument; ClaudeUI saves it under
  `~/.claude/ui/handoffs/` (`handoffsDir()`) and inlines it into the new session's first prompt. Agents never get a
  path the host will read: no agent-chosen read path, no engine grant or sandbox exception, no file in the user's
  repository. Rejected: an agent-written file in the repository (an injection surface that pollutes every tree).
- **Groups of sequential work, not parent and child.** The starting session stays alive and carries on; the new one
  works on its own and asks the user for anything it needs. Nothing flows back: no turn reports, no waking. The origin
  is a link (`started` | `handoff`, lifecycle `starting`, `live`, `ended`, `failed`) driving a flat logical group (the
  topmost grouped session is the head). A hand-off is grouped by default, a started session is standalone unless marked
  the same work; the user can "Detach from group" or "Add to group" from the row menu, and a proposal card offers
  "Start as standalone work". Sessions are addressed by short refs that survive the routing-id rekey; routing ids are
  never shown to models.

### §5 Every injected turn carries an origin

Every prompt the host delivers carries an origin: `user`, `host-instruction` (the user's own setting or click), or the
non-user origins `session-message`, `agent-note` and `dispatch-result`. Session messages and agent notes become
`role:'system'` note rows in the replicated state, never user rows, so the judge never reads them as consent. On Claude
they use Claude Code's own cross-session form (the `<cross-session-message>` envelope plus a `peer` origin), which
Claude Code frames as another session's message and its classifier treats as non-user; ClaudeUI's gate is the approval
surface, so the frame asserts the receiving session's mode class. A per-session taint (`userOriginClean`) records
whether anything not from the user reached the current turn. A started session's first prompt IS origin `user` (its
judge treats the starter's brief as user intent): accepted, because a start only follows a clean user turn and the
started session's mode is capped.

### §6 Safety

- A session starts or hands off only on a clean user turn; otherwise the call becomes a proposal card. An
  agent-started session cannot start sessions until its user types into it (a hand-off requested by the user's
  context-pressure setting is exempt); so is a session started from a proposal by the user's click, since an agent
  wrote its brief. At most 10 starts per user turn (`STARTS_PER_USER_TURN`); proposals are capped per turn and per
  session; a proposal whose folder is outside the proposer's says so on its card (the click is the only consent).
- A started session's permission mode is capped at the starter's (it inherits it as is and may only request a mode at or
  below); a working directory outside the starter's tree turns the start into a proposal.
- Reads are automatic within the group (or between a session and the one that directly started it) and the project;
  other projects need approval. Messages and stops are automatic within the group (or that direct pair) when the
  target's mode class is not above the sender's, otherwise they need approval. Mode classes: `plan` < `default`/`dontAsk`
  < `acceptEdits` < `auto` < `bypassPermissions`. The scope is the whole flat group: the last session of a hand-off
  chain reaches the first without asking, and the user's "Add to group" is also a grant. A group spans projects only
  through the user.
- Turns started by other sessions are bounded (`AGENT_TURN_BUDGET` = 10 since the last user prompt); past that, and for
  idle, closed or out-of-budget targets, items wait in a persistent per-session inbox and are delivered at the target's
  next turn. Messages never resume a closed session (an idle X-Agent is the one exception, ADR-105 §4).
- Every acting call is audited with the calling session as actor.
- **Where enforced.** Deny rules (root agent only, plan mode, the start gate, the caps) are re-checked by the tool
  service itself, so they hold in every permission mode. The rules that only ask first (reads outside group and project,
  messages and stops outside the group or into a higher class) go through the engine's approval step, so a session in
  `bypassPermissions` skips them as it skips every prompt; these tools offer no "always allow" rule that would remove
  them silently.
- The caller is identified from the engine's own record of the tool call (on Claude, the frame carrying the tool use;
  subagent frames carry a parent tool-use id or agent id); a call that cannot be attributed within a short wait is
  refused. In-process teammates write no frames and are refused in bypass mode for that reason.
- Paths are stored in forward-slash form; comparisons normalise separators.

### §7 Context pressure is a user setting

The user picks threshold percentages and a mode: off, ask (a banner above the composer on every client) or auto. At the
first turn end past a threshold, ask shows the banner; auto, or the user's click, sends the session a host
instruction to finish the current step and call `session_hand_off`. A threshold fires once, re-arms only after usage
falls below it and crosses it again (compaction, a clear), does not fire again after a hand-off until the user's next
prompt, and falls back to the banner when an automatic hand-off does not happen. Whether the hand-off happened is
judged at the end of the turn that read the instruction; a turn the user stopped is not a refusal. In plan mode the
session can only be asked, never instructed. The instruction's "don't start new work here" is guidance, not a gate:
that turn is the user's standing instruction, so the start rules treat it as the user speaking. Engines that report no
window size do not arm. Banner and watch state live in memory: after a restart an unanswered banner is gone and the next
completed turn above a threshold fires again. Rejected: a host threshold that starts sessions with no user setting.
The model-facing guidance says the user's instruction wins over Claude Code's "no need to hand off" line.

### Remote parity and native Claude cross-session messages

All of it is renderer UI plus replicated state, so cards, nesting, banner and settings work on the desktop app and the
browser clients, with client commands on both transports. ClaudeUI's Claude sessions are registered for Claude Code's
native cross-session messaging: such a message is read from the transcript and shown as a note. Claude Code holds a peer
message whose sender's mode class differs from the receiver's with no expiry and no host-side approval request;
ClaudeUI shows the hold and its one action, "Allow messages from other Claude sessions here", which sets Claude Code's
own cross-session setting to accept for that process. Messages ClaudeUI itself delivers assert the receiving
session's class because its own gate already decided them.
