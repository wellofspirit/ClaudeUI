# pi engine

Governs: `src/core/pi/`, `src/core/services/pi-session-list.ts`, `src/core/services/dispatch-pi-targets.ts`, `src/core/auth/PiAuthProvider.ts`, `src/integration/pi/`

The pi backend (`pi --mode rpc` over stdio JSONL, one child per session, gated and extended through a ClaudeUI-owned
bridge extension) and pi's host-run subagents. pi is extended through its extension API, never forked (the
customization policy, ADR-037, is in `harness-installs.md`; the managed-store install of the pinned version is
ADR-082 §8, same file). Wire detail lives in `docs/protocol-pi/README.md` (from "Transport" on) and, version-exact,
in `vendor/pi-src/packages/coding-agent/docs/`. Neighbouring records:

- pi path containment, the judge-off rule and the shared rule ladder (`src/core/pi/permission-engine.ts` serves every
  engine): ADR-110 and ADR-085 (`permissions.md`); the judge: `auto-mode-judge.md`.
- pi's MCP servers, skills and agent definitions (the `Agent` registry's Claude folders, `harness.pi.model`):
  ADR-096, ADR-103, ADR-115 (`shared-catalogs.md`).
- Ending pi through stdin EOF (`PiRpcClient.dispose()` closes stdin and tree-kills only after a grace) and the model
  catalogs: ADR-092 (`providers-and-models.md`). pi as a dispatch target: ADR-033, ADR-105 (`dispatch.md`).
- The queued-message take-back rule ADR-053 and the `disconnected` contract ADR-045 (`engine-model.md`).

## pi is a Claude-shaped RPC child with a gating bridge extension (ADR-035)

pi is the third engine behind the engine-neutral seam. Unlike opencode (a shared server per cwd) it is
Claude-shaped: no server, one `pi --mode rpc` child per ClaudeUI session, lazily spawned, tree-killed on Windows.

**Transport.** `PiRpcClient` speaks LF-framed JSONL (never Node `readline`, which also splits on U+2028).
`PiSession extends BaseSession`; a pure `event-mapper` (`mapPiEvent`) translates pi events into the neutral
`session:*` contract; `agent_settled` is the turn-complete signal. Sessions are read from pi's own JSONL trees under
`~/.pi/agent/sessions` (active-branch walk) and deleted through the engine-neutral delete dispatcher (ADR-025);
`session_meta` / `usage_event` rows carry `'pi'`. pi is installed into the managed store, not vendored or packaged;
the pinned version and the `PI_INTEGRATION_TESTS` suite move together.

**Two facts drive the design.** pi has no native permission system (it runs tools ungated) and its sanctioned
interception point is a ClaudeUI-owned extension loaded per spawn with `-e`, whose `tool_call` hook returns
`{block, reason}`. Hosted tools and `dispatch_agent` reach the model through `pi.registerTool()` in that same
extension (`parameters` is a plain JSON-schema object; `execute()` returns the MCP-shaped `{content, isError?}`; the
`tool_call` gate fires for registered tools too, so a hosted tool is gate-then-execute).

**The bridge extension** (`src/core/pi/pi-bridge-source.ts`, host side `PiBridgeHost.ts`):

- It is written verbatim to `~/.claude/ui/pi-ext/claudeui-pi-bridge/<PI_BRIDGE_VERSION>/` and **content-verified
  against the compiled source on every spawn** (rewritten on any mismatch or unreadable file). Never under the
  world-writable OS temp directory (a preplant vector) and never under `~/.pi`.
- It **throws without `CLAUDEUI_PI_BRIDGE_URL` / `CLAUDEUI_PI_BRIDGE_TOKEN`**, so pi exits instead of running with
  no `tool_call` handler (an inert extension left pi ungated, ADR-110). Every error path fails closed.
- It may import Node builtins and pi's own package (`@earendil-works/pi-coding-agent`, which pi's loader aliases to
  the running binary), nothing else. It is import-free today; a removed pi export only shows at first use, so any
  import must fail closed, and a pi bump must exercise a contained path tool through the bridge.
- `PiBridgeHost` is a per-session loopback HTTP server; a per-spawn bearer token is compared timing-safe (length
  checked first, `timingSafeEqual` throws on a mismatch). The token sits in the pi child's env: any process the user
  already approved a command for holds it. That is why execution of a hosted tool needs more than the token (below).
- **Long-poll.** Bun's `fetch` (pi's extension runtime) rejects an idle request after about 300 s, which would
  fail-close a pending human approval. So every exchange is a sequence of bounded requests: `POST /tool-call` and
  `POST /hosted-tool` hold at most `holdMs` (45 s) and answer `{"pending": true}`; `/tool-call/wait` and
  `/hosted-tool/wait` re-park on the same exchange (keyed `${route}:${toolCallId}`). Approvals can therefore wait
  indefinitely. When nobody is parked on an exchange for `abandonMs` (30 s) the host drops it and `onAbandoned` fires:
  `PiSession` force-denies the matching pending gate ("pi stopped waiting for this approval"), sends
  `session:approval-dismiss`, revokes the hosted grant and, on `/hosted-tool`, stops the in-flight dispatch. An
  abandoned exchange retracts its own card and stops the child it was gating. Protocol detail: `docs/protocol-pi/README.md`, "Long-poll protocol".

**Approvals and autonomy** (ADR-022 parity, as an evaluator, not a patched ruleset). The bridge host receives the
`tool_call` POSTs and runs the pure `permission-engine`: severity precedence deny > hosted-auto-allow > ask > allow over
the user's merged user/project/local **Claude** permission rules, then session allows, then the autonomy-mode base
(`ask` / `autoEdit` / `full` / `plan`). The same `~/.claude` rules govern pi, Claude and opencode: one config, all
harnesses. 'ask' raises the standard `session:approval-request`; "always allow" persists to the shared Claude store
through the same `permission-compiler` helpers opencode uses. (The ladder's later rungs, path containment and the
judge, are ADR-110 and ADR-085.)

**Hosted tools.** `render_mermaid`, `create_mockup` and `show_mockup` are registered over a second host route
(`/hosted-tool`) and delegate to the same `mermaid-tool.ts` / `mockup-tool.ts` handlers Claude and opencode use. The
engine auto-allows them (`PI_AUTO_ALLOW_HOSTED_TOOLS`, which also holds the read-only `list_models`; a deny rule
still wins), the parity of Claude's auto-allowed `mcp__claude-ui__` prefix. **Execution needs a one-shot grant**
(`toolCallId -> toolName`, `HostedGrants`) minted by the `tool_call` gate on 'allow' and consumed by `/hosted-tool`;
the bearer token alone never authorizes execution, or an approved bash command could replay it and bypass
`dispatch_agent`'s deliberate ask. Every tool that executes over `/hosted-tool` is in `PI_HOSTED_TOOL_NAMES`, and
only an allow of those mints a grant.

**Cross-engine dispatch, both directions** (ADR-033). As a **source**, `dispatch_agent` is registered like the hosted
tools but normally gated (it is deliberately not auto-allowed); `PiSession` builds the engine-neutral
`DispatchContext` and calls `crossEngineDispatcher` (streaming, approvals, usage and stop ride the generic pipeline).
As a **target** (`dispatch-pi-targets.ts`), a persistent headless pi child with its own bridge host forwards approvals
two-stage. Two divergences from the Claude target: pi has no async iterator (a settle-promise resolver is installed
before the prompt) and pi's `abort` is turn-scoped, not process-killing (targets survive for continuation, like
opencode). Recursion is structurally impossible: a target's child env explicitly sets the hosted-tools and dispatch
flags to `''` (omission would inherit the parent's env), and its bridge host has no hosted-tool handler. Spend from an
errored, timed-out or stopped target turn still counts toward the cost cap and the dispatching session's breakdown (the
cap is a spend limit, not a success limit).

**Plan mode.** pi has no native plan mode; ClaudeUI enforces it twice. The bridge toggles pi's active-tool set with
`pi.setActiveTools()` on `/cui-plan-enter` / `/cui-plan-exit` (sent over the normal RPC `prompt` channel; extension
commands run immediately, even mid-turn), drops `edit` / `write`, and exposes a locally executed `exit_plan` tool only
while planning. The ladder's `'plan'` base is the second layer: mutating kinds deny, bash passes only a per-segment
read-only allowlist (every chained segment must match, substitution constructs deny, network commands are excluded:
a plan-mode bash allow is an auto-allow with no human), and `exit_plan` asks, surfacing the same ExitPlanModeCard and
Shift+Tab cycle Claude uses.

**Interaction parity.** Mid-turn `steer`; thinking levels as the effort picker (`set_thinking_level`, gated on the
catalog's `reasoning` flag); slash-command and skill discovery (`get_commands`); live bash output through opencode's
`BashStreamGate`. Skills and MCP come from the shared catalogs (ADR-115, ADR-096).

**Auth** (ADR-021). `PiAuthProvider` reads and writes pi-owned `~/.pi/agent/auth.json` with a byte-preserving
api_key merge. Driven OAuth login is supported only for the `openai-codex` vendor (ADR-036); pi's other subscription
vendors still need `/login` in a terminal (the Settings hint shows the binary path). ClaudeUI's other writes under
`~/.pi/agent/` are the native settings editor (`settings.json` leaf patches) and the shared-provider adapter
(`models.json`).

**`/btw` (sideQuestion)** answers a question ABOUT the running session from its context. pi has no non-persisting
in-session ask RPC, so `PiSession.askSideQuestion` builds a bounded context from the session's own `messageHistory`
(last ~20 messages, 8k-character cap) and spawns an isolated
`pi --mode rpc --no-session --no-tools --no-extensions --no-skills --no-context-files --no-prompt-templates`
observer. `--no-tools` is the enforcement (the observer cannot mutate the live cwd even if it ignores the framing);
the discovery surfaces are off so repository-writable content never reaches the ephemeral. The answer renders in the
BtwCard, never the transcript. Fidelity limit: it sees the visible transcript, not pi's in-flight state.

**Fork / forkFromMessage.** pi has a native branch tree, but no id ClaudeUI can match a renderer message to (a live
assistant message id is a synthesized uuid), so `resolveForkAnchor` resolves pi forks by POSITION (the forked
message's index -> the pi entry id of the next user message to drop, or a clone-latest sentinel). `PiSession` runs
`fork {entryId}` alone, or `clone` alone for the latest-turn sentinel, right after the initial `get_state` and BEFORE
any `set_model`; both leave the resumed source byte-unchanged (an integration test asserts it), and a failed fork
disposes and rethrows before configuring. Position anchoring is exact for reopen-then-fork; a heavily live session may
fork at a slightly imprecise point, never corrupt.

**Capability honesty** (ADR-030). A capability flag flips only when its path ships end to end
(`PI_ENGINE_CAPABILITIES` in `src/shared/model-capabilities.ts`): `crossEngineDispatch` is ANDed per session with
`crossEngineDispatchAvailable('pi')`. `sandbox`, `proxy` and `auth.multiAccount` are false (not applicable to pi).

**Registration surfaces.** Adding an engine id has three compile-enforced tables (engine-meta, engine-tool-maps,
EngineLogo) and two that fail silently: the per-engine capability consts in `model-capabilities` and the `db.ts`
engine-id string allowlists (unknown ids clamp to `'claude'`; tests, not types, guard them).

The M5b in-pi `subagent` extension (`pi-subagent-source.ts`) is retired by ADR-089; the `subagent` tool kind stays
mapped to `'task'` for legacy transcripts.

## pi subagents are host-run, gated by the parent, through an `agent` tool (ADR-089)

pi has no native subagent concept. ClaudeUI host-runs them: the bridge's own `agent` tool calls back over
`/hosted-tool`, and `PiSubagentManager` (`pi-subagents.ts`) spawns one headless `pi --mode rpc` child per call
(`PiChildRunner`, `pi-child-runner.ts`, shared with the dispatcher's pi target: transport is shared, the gate is
injected by each consumer). Every tool call a child makes is a ClaudeUI decision under the PARENT's live mode and
judge; a child never runs ungated (the retired extension's flaw). Anything ClaudeUI spins off a parent in auto mode
inherits auto mode, read live. The model is Claude Code's own subagents. Children stream through the same
`session:subagent-*` / TaskCard pipeline the dispatch target uses, only through `session.send` (never
`dispatchOutput`), so child messages never enter the transcript the judge and `/btw` read.

### The registry

`pi-agent-registry.ts`; later wins per normalized name (lowercase, `-` `_` spaces stripped): built-ins
(`general-purpose`; `Explore` and `Plan` with `read,bash,grep,find,ls`, `permissionMode: plan`, `canSpawn: false`) <
`~/.claude/agents` < `~/.pi/agent/agents` < project `.claude/agents` then `.pi/agents` per directory from the project
root (nearest `.git` dir or file) down to the cwd, nearer winning. A project file may redefine a built-in
(`general-purpose` too): allowed, logged, listed as `(project)`; a repo can change what the model gets under a built-in
name. A project definition overrides a same-named user one whole, model included (see `shared-catalogs.md`, ADR-103).
The registry is a spawn-time snapshot: a definition added mid-session applies at the next spawn.

Definition files are hostile input (the shared reader `src/core/agents/agent-defs.ts`): front matter only when the
first line is exactly `---` (so `---js` is never front matter, nothing is evaluated, gray-matter is not used), `yaml`
core schema, aliases refused, duplicate keys refused; non-regular files, files over 64 KiB and more than 200 files per
directory are skipped; every fs error is a diagnostic. Claude tool names map (`Read`->`read`, `Glob`->`find`,
`Agent`/`Task`->`agent`, ...); a non-tool entry is dropped. Directories are scanned flat (Claude Code recurses).
Supported fields: `name`, `description`, `tools`, `disallowedTools`, `model`, `harness.pi.model`, `thinking` /
`effort`, `permissionMode`, `background`. `mcpServers`, `skills`, `color`, `memory`, `isolation`, `maxTurns` and
`omitClaudeMd` are ignored.

### The tools (`agent`, `send_message`, `task_stop`, `list_models`)

The bridge registers `agent` when `CLAUDEUI_PI_AGENT_TOOL === '1'` (plus bridge url/token, independent of the hosted
flag): a fixed preamble plus the registry listing (`CLAUDEUI_PI_AGENT_LISTING`, one line per agent, capped; agents
with `tools: []` are omitted). Parameters: `description`, `prompt`, `subagent_type`, `model`, `name`,
`run_in_background`. `task_stop` and `list_models` ride in the same block (only an agent that may launch agents may
stop or list models); `send_message` (`to`, `message`, `summary`) is gated on `CLAUDEUI_PI_SEND_MESSAGE === '1'` so
every child has it. Each executes over `/hosted-tool` behind a one-shot grant. The bridge also registers the
`cui-deliver` command whenever url/token are set.

### D1 The judge's context for a child call

`classifyAutoMode` runs with the child scope: the subagent header (type, description, prompt), the transcript = the
ROOT session's messages followed by the acting child's own assistant-only trajectory (an intermediate agent's
trajectory is excluded: its prompts to the child are agent-authored), the child's own outcomes and denial caps, its
narrowed mode re-read live, and `stillPending` false once the child is stopped or draining (-> deny "Agent stopped").
Judge model, transport, environment and review sender are the parent's. There is no third copy of the judge pipeline
(ADR-088, ADR-091 in `auto-mode-judge.md` and `dispatch.md`). An agent's trajectory lives on its record, so a resumed
run's judge sees its earlier actions.

### D2 A child's call is gated by the parent's gate

`PiSession.gateChild(scope, payload)` runs the SAME ladder as the session's own calls (`decideToolCall`):

- A source comment's "D2.4" means the child judge, stated under D1 above (in the old ADR it was the fourth bullet of
  this list).
- **Rules and allows:** the parent's rules (the allow tier stripped in auto, as for the parent) and the parent's
  session allows. "Allow for this session" on a child's card is consent for the whole session, children included
  (Claude Code parity); the user's own allow rules (a bare `Write`) apply to children as to the parent. Children share
  the parent's path containment (ADR-110).
- **Spawn-call rung** (Claude Code parity, after the deny-rule check, before the mode base): an `agent` call is
  allowed with no card in every non-auto mode, plan included (every child action is gated by the same live mode). In
  auto the `task` kind asks under the `acceptEdits` base and the judge decides. A user `Agent` / `Task` deny rule
  refuses the launch and an ask rule puts the human card in front of it, in every mode (ADR-110: those rules match pi's
  `agent` tool only, never `dispatch_agent`; the specifier is a glob on `subagent_type`). `send_message` takes the same
  rung (a message that resumes or redirects an agent is delegation, judged like a spawn in auto). `task_stop` is allowed
  in every mode, auto included, with no judge call (it only stops work). Who may message or stop whom is the manager's
  check, not the gate's.
- **Human:** `askHuman` on the parent's routing with the child's own call id, rendered as a floating card that names
  the agent (`PendingApproval.agent`). A reject records into the child's outcomes.
- **Host-side spawn limits.** "Cannot spawn" and the depth cap are enforced on the host, not only by withholding the
  tool: the bridge token is in the child's env, so an approved shell command could POST `/tool-call` and
  `/hosted-tool` directly. The child gate denies `agent` for a scope that cannot spawn ("This agent cannot launch
  agents", no grant) and `run()` refuses a parent that cannot spawn.
- Background by default (the integration test cites this as D2): `background = definition.background === true ||
run_in_background !== false`. A background call returns once the child started, with Claude Code's async-launched
  text; the run continues and notifies its owner when it ends. The renderer reads a card as background from the
  RESULT (the host's launch text, `PI_ASYNC_LAUNCHED_PREFIX`); a foreground report opening with that prefix gets a fixed
  `Agent report:` header so it cannot pose as one.

### D3 A definition's `permissionMode` only narrows

The mode a child's call is gated under is `narrowMode(parent's live mode, definition mode)` on every call (rank
plan < default < acceptEdits < auto = full < bypassPermissions; an unknown parent mode ranks as default; an unknown
definition `permissionMode` becomes `default`, failing safe). An Explore or Plan child is plan-gated even under an auto
parent: reads and the read-only bash allowlist pass, edits are refused with the plan reason, no judge, no human. A
definition can never widen what the parent's mode allows.

### D4 Child flags, env, tools and depth

Nesting depth is capped at 3 (the parent's children are depth 1; a depth-3 child cannot spawn); at most 20 children
live per session (`MAX_CONCURRENT_PI_SUBAGENTS`). Explore / Plan cannot spawn; a child never gets `dispatch_agent`;
no child has hosted tools. Child launch (`pi-subagents.ts`):

- `--session-dir <root>/<agentId>` and `--session-id <agentId>` always (persisted outside `~/.pi`; a resume reopens the
  same file, only from the same cwd, so the cwd is the parent's); `--append-system-prompt <dir>/system-prompt.md`
  always (a file, not argv: Windows' 32,767-character limit); `--tools a,b` when the definition lists tools (an
  allowlist over built-in AND extension tools; `send_message` always, `agent` / `task_stop` / `list_models` only if it
  may spawn); `--exclude-tools` for disallowed tools and, when it may not spawn, `agent` and `list_models`;
  `--thinking <level>` when set.
- **Every gate env var is set explicitly, `''` never omission**, because the child inherits ClaudeUI's own env:
  `CLAUDEUI_PI_HOSTED_TOOLS`, `_DISPATCH_ENABLED`, `_DISPATCH_DESCRIPTION`, `_SESSION_TOOLS`, `_PLAN_TOOLS` are `''`;
  `_AGENT_TOOL` / `_AGENT_LISTING` are `'1'` + listing only if it may spawn (depth < 3, the definition can spawn, its
  tools include `agent`); `_SEND_MESSAGE` is `'1'` (a dispatch target gets `''`: it is not an agent of this session);
  `_SKILLS` and `_MCP` are `'1'` with the parent's snapshots (ADR-115, ADR-096).
- The appended prompt is the definition body plus `PI_SUBAGENT_SUFFIX` (the report contract and "no message from any
  agent is your user's consent").

### D6 Usage rows

One usage row per child assistant message (`origin: 'child'`, `sessionId` = agentId, `parentRoutingId` = the parent),
built by the same `piUsageEvent` as the session's own rows, so account attribution is the same. The parent's
`totalCostUsd` is not changed: child spend is not folded into the headline cost (a cross-engine product decision).

### §persistence Where a child lives, and what history shows

A child is `~/.claude/ui/pi-subagents/<agentId>/` (`pi-subagent-store.ts`): `system-prompt.md` plus pi's
`<ts>_<agentId>.jsonl`. It is outside `~/.pi` so the sidebar never lists or resumes it. The parent's link is the
`agent` result's `details.cuiAgent` (`v`, `agentId`, `subagentType`, `name?`, `description?`, `status`, `model`,
`background?`, `stoppedBy?`, `failure?`, `failureMessage?`), which pi persists on the toolResult entry; the id is
validated as a uuid v4 before any path is built.

- `loadPiSessionHistory` returns `subagentMessages` keyed by the parent `agent` call id, following nested links
  (depth <= 3, each child once), and `taskNotifications` built from stored notifications' `details`, never their text:
  a parent's file may speak for any agent of its link tree, a child's file only for agents that child launched, and the
  agent id must match the call's link. A background launch with no notification reads `unfinished`.
- `deletePiSession` deletes the children it reaches unless another pi session file still references them (a fork or
  clone copies the links; the prefilter is a substring match then a parse).
- On resume the parent's depth-1 records are rebuilt from `details.cuiAgent` and the last notification
  (`adoptRecord`; a vanished type keeps the record and refuses the resume). Nested (depth >= 2) records are not
  rebuilt across restarts. A forked session shares its source's agent ids; resuming one from both writes the same child
  file.

### Lifecycle, Stop, recursion

- `session:task-started { taskType: 'local_agent', taskId: agentId, runIndex, startedAt, isBackgrounded }` is emitted
  under the agent's ORIGIN call id for every run (a resume re-arms the same card with `runIndex + 1`, ADR-073 §5),
  `session:task-progress` from each usage, then `session:task-notification`: for a foreground run BEFORE the tool
  returns (else the parent's turn can end while `activeTasks` still holds the agent), for a background run before the
  model delivery. A foreground result ends with `agentId: ... (use send_message ...)` and a `<usage>` line.
- **Stop.** `PiSession.stopTask(toolUseId)` (the card's Stop; `capabilities.backgroundTasks` is true) and `task_stop`
  stop that agent and ALL its descendants, abort the child and retract its open approval cards. `interrupt()` stops
  only FOREGROUND children and their foreground descendants and denies only the session's own pending cards (Claude
  Code's Esc spares background agents). `cancel()` and the parent's process exit dispose everything with no delivery
  (the parent exiting kills background children without telling the model). An abandoned `agent` exchange stops its
  child. A run past its continuation cannot be stopped; `stoppedBy` is recorded only for a run that ended stopped. A
  stopped child streams no `[error: ...]` row (ADR-090, `engine-model.md`).
- **Send to background.** A foreground run sends `isBackgrounded: false`, so the card offers it; `backgroundTask`
  flips the run, re-emits task-started (`true`) and releases the waiting call with the async-launched text.
- **Recursion.** A child's `hostedToolHandler` handles `agent` (the manager with the child as parent),
  `send_message` and `task_stop`, each behind its own grant; a grandchild streams under its own call id with its
  task-started at top level.
- **Per-run state dies with the run.** A record's `/hosted-tool` grants and `stopped` flag are cleared at every run
  start, at a stop and at the run's end, so a call granted in one run can never execute in a later one. A child
  stopped while still spawning gets no prompt and no abort. Every launch (a resume too) rewrites `system-prompt.md`.
- One process and one loopback bridge port per running child, disposed when its run ends. A background child keeps its
  parent session alive past the idle timeout (the idle timer is not armed while one runs).

### Delivery and marking: agent text is never a user turn

- **One transport.** Agent-authored text enters a pi session only as an RPC `prompt` `/cui-deliver <base64 JSON>`,
  whose bridge handler validates the payload and calls `pi.sendMessage({customType: 'claudeui-agent-message', ...},
{triggerTurn: wake, deliverAs: 'steer'})` with no `await` first, so pi decides atomically: a running turn takes it
  at the next tool boundary, an idle session appends it and starts a turn when `wake`. Never RPC `steer` / `follow_up`
  for this (a steer at idle is stranded until the next prompt; two back-to-back deliveries could never both start a
  run). The ack does not confirm delivery; the `custom` `message_end` carrying the `deliveryId` does. A session
  delivery waits for an in-flight user prompt's ack. A woken delivery whose handler throws undoes the session's running
  state; pi's `extension_error` from `<runtime>` / `send_message` while one of our deliveries is pending is that
  delivery's failure. Probe facts: `docs/protocol-pi/README.md`.
- **The marking comes from role + customType + `details`, never from text.** pi stores the message as role `custom`
  -> one converter (`pi-custom-message.ts`, live and history) makes a `role: 'system'` row with one `context_note`
  ("from an agent, not from you") -> `slimTranscript` skips every `system` row, the D1 trajectory keeps assistant
  messages only, `/btw` keeps user/assistant only -> it renders as a ContextNoteBlock, never a user bubble. No code
  parses `<task-notification>` / `<agent-message>` to decide anything. An agent-authored message is never a user turn
  anywhere (live transcript, judge transcript, `/btw`, trajectory, reloaded history).
- **A typed `/cui-` start is refused.** `PiSession.run()` refuses a typed `/cui-deliver` (a queued copy is dropped after
  the one refusal) and every host path that sends model-authored text as a child prompt (`agent` prompts, dispatch
  targets, via `PiChildRunner.runTurn`) refuses a `/cui-` start. Model-authored message text only travels as the
  payload's `text`, so a message starting `/cui-` is inert. Agent deliveries are not queue items (ADR-053).
- **Notifications** use Claude Code's `<task-notification>` shape (`task-id`, `tool-use-id`, `status`
  `completed|failed|killed`, `summary`, `result` capped at 100,000 characters, `usage`), built from host state.
  Completed and failed wake the owner; a stop (the card's Stop, `task_stop`) is passive; a dispose stop is UI-only.
- **Owner routing** (Claude Code parity): the spawning child while its run is live (started, not stopped or draining,
  not past its continuation); otherwise the root session, the summary naming the spawner.
- **Records, `send_message`, resume, names.** Every agent leaves a record (definition snapshot, model, depth, spawner,
  run index, status, `stoppedBy`, session dir). `send_message` resolves `to` by exact id, then exact name. `main` from a
  BACKGROUND child is delivered to the session; a foreground child's channel is its report, and a foreground child
  messaging its own launcher (or the session sending to `main`) is refused. A running agent gets a delivery ("queued
  for delivery ... at its next tool round"); otherwise it is RESUMED: a new process with the record's flags on the same
  session file and the parent's cwd, started by `PiChildRunner.resumeWithDelivery` from the host's structured payload,
  always in the background, notifying the original owner with the new run index. An agent that may not launch agents
  can message running agents but not resume a finished one (a resume launches a process). Names: at most 64
  characters, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, not uuid-shaped, not `main` / `user` / `system` / `team-lead`, unique in
  the session (case-insensitive; re-checked after the catalog await). An agent's label (name, else description) is
  one line without quotes or markup, at most 64 characters. `task_stop` takes an id or name; the session may stop any
  agent, a child only its descendants.

### Messaging v2 (amendment: messaging v2)

- **User-stop hold.** A `'user'` stop (the card's Stop, cascaded to live descendants) raises `userStopHold` on the
  record the moment the stop is recorded. `PiSession.run()` (the one path every user-authored prompt takes) calls
  `userTurn()`, which clears every hold. While held, `send_message` refuses ("was stopped by the user. Resume it only
  if the user asks you to; the user has not spoken since the stop"). Agent deliveries, plan toggles and judge traffic
  are not user turns. An accidental Stop is thus recoverable without an approval card. `task_stop` and interrupt
  stops never hold.
- **Failure classes** (`pi-agent-failure.ts`, first match wins): context overflow -> permanent; 401/403 (the anchored
  status parse in `pi-error-status.ts`) -> transient; quota or usage limits -> transient; pi's retryable
  provider/transport errors -> transient; a crashed child or dead transport (`PiTurnOutcome.cause: 'exit'`) ->
  transient; a launch failure -> transient for a resume, permanent for a first run; a refused `/cui-` prompt and
  anything unmatched -> permanent. A permanently failed agent refuses `send_message` with its message; a transiently
  failed one is resumable. The overflow, quota and retryable patterns are ported from
  `vendor/pi-src/packages/ai/src/utils/{overflow,retry}.ts`: re-diff them at every pi bump. `failure` and
  `failureMessage` (one line, <= 200 characters) persist in `details.cuiAgent` and the notification `details`.
- **Child auth failures fail.** `PiChildRunner` settles a mapper `auth-required` like any turn error (a 401/403 child
  once reported "completed"), under the same draining rule.
- **Identity.** Every launch appends to `system-prompt.md` the agent's id and name, who launched it, the handle that
  reaches its launcher (usable only while it runs in the background) and how `<agent-message>` replies work.
- **Models.** The `agent` call's `model`, else the definition's (`inherit` excepted), resolves against the
  authenticated, allowlisted catalog (`getPiAllowedModelCatalog`, `pi-agent-model.ts`): exact `provider/id` (then
  case-insensitive) -> bare id (the parent's provider first; still ambiguous -> an error naming <= 10 candidates) ->
  alias `opus` / `sonnet` / `haiku` / `fable` (the newest version, the parent's provider first; only numeric id tokens
  count as version, 8-digit dates excluded) -> "Unknown model ... Call list_models". A miss refuses the launch: never
  substitute. An empty catalog passes the value through unchecked. `list_models` (read-only; session model, then one
  line per model, `query` filter, 100-line cap) is how pi learns which models exist instead of guessing ids.
- **Dispatch description.** `src/shared/dispatch-agent-description.ts` builds every engine's `dispatch_agent`
  description: use it only for a different engine or model vendor or an independent second opinion; for ordinary
  delegation use your own subagent tool (Claude `Agent`, pi `agent`, opencode `task`). pi gets it in
  `CLAUDEUI_PI_DISPATCH_DESCRIPTION` (`''` for every child and dispatch target; the bridge keeps a short fallback).
- Model-driven message ping-pong between agents is deliberately not rate-limited (Claude Code parity).

### Accepted limits

- A rebuilt record whose link says `stoppedBy: 'user'` is held until the next prompt even if the user spoke after the
  stop in an earlier app run; a user stop of a background agent is durable only once its passive notice is in the
  parent's file (quitting before the end of the turn loses it).
- A resume whose launch fails is transient even when the model no longer exists (each retry costs one spawn); the alias
  version rule reads id tokens and can be fooled by an id whose numbers are not versions.
- A delivery whose deferred run never starts is logged (ids only) and lost; a refused `cui-deliver` payload cannot be
  tied to its id, so a child's refused delivery stays pending until the drive's idle grace ends the run. A passive
  delivery (a stop notice) to a live spawner is appended at the end of its turn and wakes nothing. A steered message
  undelivered at an interrupt stays in pi's queue until the next run (pi's `abort` keeps its queues).
- Stale `~/.claude/ui/pi-ext/claudeui-pi-subagent/` copies from the retired extension stay on disk, inert.
- Rejected: an in-pi extension v2 (ClaudeUI could not stop, meter or judge a child as a unit); one shared parent
  process running children as sessions (pi's RPC has one session per process); gray-matter for front matter (its
  `javascript` engine evaluates `---js`).
