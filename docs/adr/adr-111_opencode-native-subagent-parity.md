# ADR-111: opencode native subagents reach pi's level: judge context, task lifecycle, Stop and the model allowlist

**Status:** Accepted (2026-10-25). Implemented on branch `worktree-opencode-subagent-parity`.
**Amends:** [ADR-073](adr-073_agent-roster-and-task-run-identity.md) §3, §8 and Consequences (opencode now sends
lifecycle events, background subagents run, reopened chats load child transcripts),
[ADR-040](adr-040_engine-neutral-task-lifecycle-events.md) (opencode child sessions send `task_started`),
[ADR-091](adr-091_judge-blocks-hold-and-session-local-targets.md) §4 (opencode task children included),
[ADR-097](adr-097_opencode-v2-only.md) §3 (auto mode asks for a spawn again, for the judge),
[ADR-103](adr-103_claude-agent-definitions-in-pi-and-opencode.md) (`effort` mapped on opencode; `permissionMode` and
`background` not).
**Relates to:** [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) (allow rules that skip the judge),
[ADR-088](adr-088_dispatch-autonomy-inheritance.md) D1 (a delegated judge reads the acting agent's own trajectory),
[ADR-089](adr-089_pi-subagents-host-run.md) (pi host-run subagents, the reference),
[ADR-030](adr-030_capability-honesty.md) (capability flags).

## Context

pi subagents are host-run: ClaudeUI starts one `pi --mode rpc` child per call and owns everything about it
(ADR-089). opencode 2.x subagents are native: the `subagent` tool creates a child session on the shared server and
ClaudeUI follows it through the SSE feed. As of opencode 2.1.2 the native path lagged pi in five ways:

1. **Judge context.** A child's tool call was judged against the parent transcript alone, with one set of tool
   outcomes and denial caps shared by the parent and every child. A pi child is judged on the parent transcript,
   the still-queued user turns and its own trajectory, with its own outcomes and caps (ADR-091 §4).
2. **Spawn, web search and skill unjudged.** Auto mode's opencode ruleset had no `subagent`, `websearch` or `skill`
   ask, and opencode's baseline allows all three, so the judge never read a spawn's delegation payload. pi judges
   `agent` and `send_message`, and Claude Code's classifier reads WebSearch and Skill (neither is on its safe list).
3. **No lifecycle.** opencode sent only a terminal `task-notification`, so the roster and TaskCard fell back to the
   legacy heuristic: no live usage, no run index, no background state. The idle timer ignored background children,
   and its teardown interrupted them.
4. **Model allowlist bypassed.** The `subagent` tool's per-call `model` and the target agent's configured model
   are checked only against opencode's own catalog, never ClaudeUI's per-provider allowlist.
5. **No per-subagent Stop.** `backgroundTasks` was false, so Stop on a subagent card was refused.

What opencode 2.1.2 offers without a fork:

- The `claudeui-xeng` plugin's `execute.before` hook sees a tool call's input before it runs and may reject the
  call; the model reads the thrown message as the tool failure. Plugin options (`{package, options}` entries) reach
  `setup`, also for a directory plugin.
- `POST /api/session/:id/interrupt` accepts a child session: its job is cancelled; a foreground parent call fails
  with "Subagent cancelled"; a background child's cancellation reaches the parent as a synthetic completion, which
  wakes it. A parent interrupt cancels foreground children only.
- `POST /api/session/:id/background` moves EVERY foreground job the session is blocked on (sibling subagents and
  shells too) and adds a synthetic note. There is no per-job route.
- `models` (the tool the `subagent` description points at) is a Code Mode tool (`opencode_models`). ClaudeUI
  hides `execute` in every mode, so the model cannot call it.

## Decision

### 1. A child is judged in its own context

`OpencodeSession` keeps judge state per child session (trajectory, outcomes, denial tracker), keyed by the child's
opencode session id. A resumed child runs under several calls, and a grandchild's owner is a call made inside the
child, so the call id would be the wrong key. A child's ask is judged on this session's transcript, its
still-queued user turns and that child's assistant trajectory in time order, with that child's outcomes and caps:
pi's `childHooks`. A grandchild's judge does not see the intermediate agent's trajectory (ADR-088 D1). The state
lives as long as the session (each trajectory bounded at 200 messages). A reopened chat seeds it from the child
transcripts its history load already reads. A child's approval card names its agent (`agent`, the label shared
with the blocked-call row).

### 2. Auto mode judges spawns, web searches and skill loads

`autoModeGates()` adds `subagent`, `websearch` and `skill` asks. Other modes are unchanged, and plan mode's
`subagent general` deny still wins. A spawn's input is a delegation payload, so it gets the full review. Allow
rules follow Claude Code: a `Task`/`Agent` allow never skips the judge on a spawn; a bare `WebSearch` and a
`Skill(name)` allow do (ADR-085). "Allow for session" does not exempt a spawn in auto mode. opencode dispatch
targets inherit the asks; their generic target judge reads them.

### 3. Task lifecycle for native subagents

The mapper sends `task-started` for every run, `task-progress` per child step, and a terminal `task-notification`
carrying the run's usage, run index, summary and background flag.

- **A run is one call.** On opencode `toolUseId` is the per-run call: a resume is a new `subagent {sessionID}`
  call with its own card and roster row. `taskId`, the child session, ties the runs together, and `runIndex` is the
  call's position among the child's calls.
- **Usage** is Σ(input + output + reasoning) over the child's own steps in that run, as pi's `turnTotalTokens`.
  Grandchildren count in their own runs.
- **`wakesParent: true`** on every run.
- **Steering.** A call that steers a still-running child first settles the earlier call ("continued by a later
  call"), or its record would hold the session as waiting forever.
- **Reopen.** Cold history carries the same figures per run, and seeding remembers the calls that ran each child,
  so a resume continues the count.
- **Idle hold.** A live background child holds the idle timer, which re-arms when the child ends.

### 4. Stop per subagent; no Send to background

`OpencodeSession.stopTask` interrupts the card's child and its live descendants, never siblings or the parent.

- The run ends `stopped`, unless it completed on its own first.
- A stopped child that a background grandchild's completion wakes again is interrupted again, until a new call
  links it.
- The model is told the user stopped that agent, so it does not re-spawn the same work: one host instruction
  per Stop to the root session ("Sent by ClaudeUI for you"), sent before the interrupt. It steers a running turn;
  a background child's cancelled completion wakes the parent anyway, so the note adds no turn. opencode's own
  result says only "Subagent cancelled". A non-user agent message would mark the session's origin as tainted and
  count against its agent-turn budget, which a Stop click should not do. Teardown and parent interrupts send no
  note. The note is user-role text (the auto-mode judge reads it as a `User:` line), so it carries nothing the
  model authored: it names the agent by its type (a safe identifier, else `subagent`) and the call id, never
  the call's description or prompt. The call id is provider-stream data, so it is quoted only when it matches
  `[A-Za-z0-9_.:-]{1,128}` (else the note says "started by one of your calls"), and the wording is "started by call <id>": a
  nested call was made by the child, not by the caller.
- A Stop whose child interrupt cannot be sent is rolled back for the sessions not reached; a descendant that was
  interrupted keeps its `stopped` end.
- `backgroundTasks` is true; `backgroundTask` is not implemented.
- A foreground run omits `isBackgrounded`. The cards offer "Send to background" only for an explicit `false`, and
  opencode's background route would move every blocked job of the turn, not the one card.

### 5. ClaudeUI's model allowlist holds for subagents

The plugin gates `subagent` in `execute.before`. It resolves the model the tool would run on: the call's `model`,
then a resumed same-agent child's own model, then the target agent's model, then (a resume that switches to an
agent with no model) the child's own stored model, which `switchAgent` never changes; a call with none inherits
the already gated parent. An off-list model throws a message that names the allowed models and points at
`claudeui_list_models`.

- **Stateless delivery.** The allowlist arrives as the plugin entry's options and joins the server's config
  identity. opencode evicts an idle location after an hour and re-runs `setup`, so a pushed copy would be lost.
- **Freshness.** A change gives new leases a new server; an open session keeps its list until it reconnects. This
  is the same freshness as the injected agents and the parent's spawn gate.
- **Fail closed.** Missing options refuse a model-bearing call.
- **Guard.** The guard RPC requires `modelGate` and also reports `allowlistLoaded` (the options parsed). ClaudeUI
  logs a warning when it is false and does not refuse: the gate already fails closed per call.
- **One validation, failing closed.** `loadOpencodeModelAllowlist` validates the shape once and every consumer
  trusts its result. A present key always restricts: a lone string is a one-model list, an array keeps its string
  ids, and any other value allows none of that provider. Each malformed entry logs a warning.

ClaudeUI hosts `claudeui_list_models`: the allowlisted models with their `#variant` options, built from ClaudeUI's
own discovery (pi's `list_models`). Its description keeps opencode's rule: pass a model only when the user asks.

### 6. Claude agent files: `effort` maps, `permissionMode` and `background` do not

The shim turns a file's top-level `effort` into `#<effort>` on `harness.opencode.model` when that model has no
variant of its own. It is not validated at injection: the shim's output keys the server, so it must be a pure
function of the files and the allowlist. The agent type catalog checks it against discovery and warns in Settings
(an unknown variant fails every run of that agent). The check uses the cached discovery, else waits at most 2 s
for discovery (which may start the pooled server); no answer within that is no warning. opencode agents have no `permissionMode` or default
`background` field, so neither is mapped.

## Consequences

- A child's judge sees what the child did and what the user typed meanwhile, and one child's denial streak no
  longer escalates the parent or a sibling.
- Every spawn, web search and skill load in opencode auto mode costs a judge call, as on Claude.
- The roster and TaskCard show live tokens, run counts and background state for opencode, and Stop works per card.
- An allowlist change restarts the pooled opencode server for new sessions.
- Known gaps (issues): a background child still running from before a reopen is not linked, so it does not hold
  the idle timer; a background child whose end is never observed holds it until the connection drops; a child card
  offers no "allow for session"; an opencode dispatch target's own task children are judged on the target's
  trajectory; per-job Send to background needs an upstream route.
- Known gap (REC2): opencode commands with `subtask: true` (the command's `model`, or its agent's), and a
  non-subtask command's model switch, do not go through the `subagent` tool, so the model gate does not see them.
  They are started by the user, not the model.
- Live treats any earlier run that a later `sessionID` call took over before its notification as superseded; a
  reopened chat treats only background runs that way. Parallel foreground `sessionID` calls to one child can read
  differently after a reopen.
- `experimental.subagent_depth` keeps opencode's default of 1 (Settings exposes it).

## Alternatives considered

- **Run opencode subagents from the host, as pi does** (deny the native tool and create child sessions through the
  API). Full control (per-job background, any model rule, `permissionMode`), but it loses opencode's job recovery
  across a restart, its tuned tool prompts and TUI consistency, and it is a rewrite. Rejected while the plugin hook,
  the API and the feed cover the gaps.
- **Push the allowlist to the plugin over RPC.** Lost when opencode evicts an idle location; a session holds one
  lease across turns, so the push would not recur and the fail-closed gate would refuse model-bearing spawns
  indefinitely. Rejected for plugin options.
- **Check the model on a `subagent` permission ask.** The ask carries no model, and it would gate only auto mode
  with a generic "Subagent denied". Rejected for the plugin hook.
- **Validate `effort` at injection.** Makes the server key depend on the model cache (a second server at boot).
  Rejected for the catalog warning.
- **Offer Send to background through the session route.** It moves sibling subagents and shells too and posts a
  "user requested" note into the transcript. Rejected; the card offers Stop only.
- **Filter opencode's `models` tool output.** The model cannot reach it (Code Mode). Replaced by
  `claudeui_list_models`.
