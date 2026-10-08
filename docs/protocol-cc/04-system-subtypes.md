# 04 — System message subtypes

Every `{type: 'system', subtype: 'X', ...}` variant cli.js emits. Verified against 2.1.114 (patched). Sections 4.20–4.27 and the §4.17 shape were added against 2.1.170 — their anchors are 2.1.170 char offsets.

Every `system` message includes minimally:

```json
{
  "type": "system",
  "subtype": "<name>",
  "session_id": "...",
  "uuid": "..."
}
```

Exception: `session_state_changed` has no `session_id`/`uuid` (raw emit, not through the flush path).

---

## 4.1 Quick catalog

| Subtype                    | Gate                                             | Emitter path                     |
| -------------------------- | ------------------------------------------------ | -------------------------------- |
| `init`                     | Always (first turn)                              | Main generator                   |
| `status`                   | Varies per variant                               | Main generator / control channel |
| `task_notification`        | Always                                           | vT queue                         |
| `task_started`             | Always                                           | vT queue                         |
| `task_updated`             | Always                                           | vT queue                         |
| `task_progress`            | Always                                           | vT queue                         |
| `compact_boundary`         | On conversation compaction                       | Main generator                   |
| `api_retry`                | On API error + auto-retry                        | Main generator                   |
| `queued_command_consumed`  | Retired with patch `queue-control` (§4.10)       | —                                |
| `hook_started`             | `--include-hook-events`                          | Hook subscriber                  |
| `hook_progress`            | `--include-hook-events`                          | Hook subscriber                  |
| `hook_response`            | `--include-hook-events`                          | Hook subscriber                  |
| `bridge_state`             | `remote_control` active                          | Control channel                  |
| `session_state_changed`    | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`        | Direct emit                      |
| `notification`             | Error conditions                                 | vT queue                         |
| `memory_recall`            | Memory feature returns results                   | Main generator                   |
| `plugin_install`           | `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`              | Main generator                   |
| `post_turn_summary`        | @internal background summarizer                  | Main generator                   |
| `model_refusal_fallback`   | On unless `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | Main generator (§4.20)           |
| `model_fallback`           | Fallback model configured + availability error   | Main generator (§4.21)           |
| `thinking_tokens`          | Thinking deltas during streaming                 | Main generator (§4.22)           |
| `commands_changed`         | Mid-session slash-command list change            | stream-json module (§4.23)       |
| `elicitation_complete`     | MCP URL-mode elicitation completes               | stream-json module (§4.24)       |
| `permission_denied`        | Tool call auto-denied without prompt             | Control channel (§4.25)          |
| `permission_allowed`       | Not emitted — retired patch `automode-verdict`   | — (§4.25)                        |
| `mirror_error`             | Transcript-mirror write failure                  | SessionStore mirror (§4.26)      |
| `dev_intent`               | Resumed transcript shows iOS-app work            | Dev-intent fold (§4.28)          |
| `session_title_changed`    | Session has / gets a user-set name (2.1.285)     | Title subscription (§4.29)       |
| `per_turn_effort_changed`  | Server refused per-turn effort (2.1.285)         | Request retry path (§4.30)       |
| `instruction_size_warning` | Instruction files exceed size limits (2.1.289)   | Main generator (§4.31)           |
| `permission_check_status`  | Auto-mode permission check past ~4 s (2.1.293)   | SDK event queue (§4.32)          |

Subtypes that exist in the SDK schema union but are **not** emitted on the SDK stdout wire are cataloged in §4.27.

---

## 4.2 `init`

Session-start snapshot. **Re-emitted at the head of every turn**, not once per session — and each
copy carries the model actually in force, so it is the live source for the resolved model id, not
just a start-of-session fact. Probed on 2.1.268: spawn with `--model haiku` → turn 1 init
`model: "claude-haiku-4-5-20251001"`; a `set_model` control request to `default` (which emits no
init of its own) → turn 2 init `model: "claude-opus-5[1m]"`. A consumer that resolves an opaque
alias (`default`) to its concrete id must therefore re-read `model` on **every** init, or a
mid-session model switch leaves it stale.

**Anchor:** builder `e86` at char `11322500`; yield at `12800961`.

**Gate:** Always.

**Ordering:** First `system` message _of a session start_, but **not** the first message with a
`session_id` — a uuid-carrying prompt's `command_lifecycle` `queued` and `started`
(03 §3.21) precede it on every turn and carry one; so did the retired `queued_command_consumed`
(§4.10). A bootstrap latch on "the first `session_id`" must not gate reading init.
Consumer uses this to resolve temp routingId → real session UUID.

### Shape

```jsonc
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/workdir",
  "session_id": "...",
  "tools": ["Bash", "Read", "Edit", ...],
  "mcp_servers": [
    {
      "name": "filesystem",
      "status": "connected"|"pending"|"failed"|"disabled"
    }
  ],
  "model": "claude-opus-4-7",
  "permissionMode": "default"|"acceptEdits"|"bypassPermissions"|"plan"|"auto"|"dontAsk",
  "slash_commands": ["help", "model", ...],
  "apiKeySource": "api_key"|"oauth"|"none",
  "betas": ["..."],
  "claude_code_version": "2.1.114",
  "output_style": "normal",
  "agents": ["general", "researcher", ...],
  "skills": ["skill-name", ...],
  "plugins": [
    { "name": "...", "path": "...", "source": "..." }
  ],
  "plugin_errors": [
    { "plugin": "...", "type": "...", "message": "..." }
  ],
  "memory_paths": {
    "auto": "~/.claude/...",
    "team": "~/.claude/team-mem/..."
  },
  "fast_mode_state": {...},
  "uuid": "..."
}
```

### Field notes

- **`plugin_errors`** — omitted when empty.
- **`memory_paths`** — only when user-memory feature enabled (`uf()` truthy). `memory_paths.team` only when team memory enabled.
- **`uuid`** — new randomUUID per init message; unrelated to `session_id`.
- **`fast_mode_state`** — only emitted when eligible account (see `09-initialize.md`).

This is the authoritative source for session_id, current model, active permissionMode, available tools / commands / skills / agents / plugins / MCP servers. The `initialize` control_response has complementary data (models/commands/agents arrays with more detail). Our harness reads both — init for runtime state, control_response for catalog data.

---

## 4.3 `status`

Three variants, same basic shape.

### Variant A — Stream request start

**Anchor:** `~12806300`.

**Gate:** `--include-partial-messages` (`includePartialMessages: true`).

```json
{
  "type": "system",
  "subtype": "status",
  "status": "requesting",
  "session_id": "...",
  "uuid": "..."
}
```

Fires when a new API request begins streaming.

### Variant B — Permission mode change

**Anchor:** `~12824600`.

**Gate:** Always. Fires on `set_permission_mode` control request or internal mode change.

```jsonc
{
  "type": "system",
  "subtype": "status",
  "status": null,
  "permissionMode": "default"|"acceptEdits"|...,
  "session_id": "...",
  "uuid": "..."
}
```

### Variant C — SDK status callback (compaction)

**Anchor:** `~12837335`.

**Gate:** Always. Fires on arbitrary SDK-status updates, notably compaction results.

```jsonc
{
  "type": "system",
  "subtype": "status",
  "status": "...",
  "compact_result": {...},           // after successful compaction
  "compact_error": "...",            // after failed compaction
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.4 `task_notification`

A task (background agent, Bash shell, subagent, in-process teammate) reached a terminal state.

A terminal `task_notification` for an auto-continuing task type (`local_agent`, `remote_agent`,
`in_process_teammate`, `local_workflow`) means cli.js will re-invoke the main agent on its own:
mid-turn it is absorbed into the current turn; between turns it starts a fresh auto-continued turn
(new `system/init`, own `result`). See §3.7 "`result` vs background tasks" for the probed sequences
(2026-08-26, 2.1.241).

**Anchors:** `FY` emitter at `3995289`; subagent at `7820041`; team-streaming-C at `8650876`; XML re-emission at `12834859`. (2.1.241: the emitter is `Qg` at `cli.js@char2620439`.)

**Gate:** Always.

### Shape

```jsonc
{
  "type": "system",
  "subtype": "task_notification",
  "task_id": "t123abc"|"a123abc"|"r123abc"|"agentname@team",
  "tool_use_id": "toolu_...",
  "status": "completed"|"failed"|"stopped",
  "output_file": "/path/to/output",        // empty string when no file
  "summary": "text summary",
  "usage": {
    "total_tokens": 1234,
    "tool_uses": 5,
    "duration_ms": 6789
  },                                        // may be omitted when no usage data
  "skip_transcript": false,                 // optional; true = don't record in transcript
  "session_id": "...",
  "uuid": "..."
}
```

### `task_id` format by task type

- Background bash: `t` + 6 hex chars (e.g., `tabc123`)
- Background agent (local_agent): `a` + 6 hex chars
- In-process teammate: `name@team` (e.g., `ts-advocate@lang-debate`)
- Remote agent: `r` + 6 hex chars

### `status` values

- `completed` — normal completion
- `failed` — error exit
- `stopped` — user-initiated stop (upstream maps `killed` to `stopped` since 2.1.114; observed on the official 2.1.280 binary, which is why the `taskstop-notification` patch was deleted)

---

## 4.5 `task_started`

A task transitions from non-existent to existing (first `setAppState` update).

**Anchor:** `4891300` inside `KD4(H, $)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_started",
  "task_id": "...",
  "tool_use_id": "...",
  "description": "...",
  "task_type": "local_bash"|"local_agent"|"in_process_teammate"|"local_workflow",
  "is_backgrounded": false,                 // see below; absent for types without the notion
  "subagent_type": "general-purpose",       // local_agent only
  "spawn_depth": 1,                          // local_agent only
  "owned_by_subagent": true,                 // local_bash started inside a subagent only
  "workflow_name": "...",                  // optional
  "prompt": "...",                          // optional
  "skip_transcript": false,
  "session_id": "...",
  "uuid": "..."
}
```

### `run_id`, `parent_task_id` (2.1.293)

`run_id` (optional) identifies one run of a task and is equal across that run's
`task_started` / `task_updated` / `task_progress` / `task_notification` frames and its
`background_tasks_changed` entries. A resumed task keeps its `task_id` and gets a new
`run_id`; run ids sort, as plain strings, in the order runs opened. Absent for tasks
this process did not register. `parent_task_id` (optional, on `task_started` and
`background_tasks_changed` entries) is the `task_id` of the subagent task that
launched this one, absent when the main thread did. `background_tasks_changed`
entries also carry `subagent_type`. `@internal`: `awaited`, and
`task_notification.handback` / `handback_report`. ClaudeUI reads none of these yet.

### `is_backgrounded` — foreground or background (2.1.280)

The registry record's `isBackgrounded` at registration, read as
`is_backgrounded:"isBackgrounded"in g?g.isBackgrounded:void 0` (`.cache/pristine-cli.js`
@10112444), so it is absent for task types whose record has no such field.

- `false`: the task runs in the FOREGROUND and blocks its tool call — a Bash command without
  `run_in_background`, or an agent the model launched synchronously. Only such a task can be
  moved with `background_tasks` (07 §7.3).
- `true`: it started in the background (`run_in_background: true`, or an async agent launch).
  _Corrected 2026-09-30 (2.1.280, `scripts/probe-nested-agents.mjs`):_ an earlier revision listed
  "a Bash started inside a subagent" here. It is wrong: a subagent's **foreground** Bash registers
  `false` at depth 1 and depth 2 alike (with `owned_by_subagent: true`), exactly like the main
  agent's, and only `run_in_background` or a later move makes it `true`.

**Registration timing.** An agent registers within milliseconds of its tool_use. A foreground
Bash registers only once it has run for 2 s: the Bash progress loop calls the registrar (`Ovn`,
which builds the record with `isBackgrounded:!1`) on the first progress tick at or past
`j6t=2000` ms (@10959996; call site @10987988). Observed 4.5–4.6 s after the assistant's
tool_use frame on the official 2.1.280 binary (two probes). A command that finishes sooner never registers, so it emits no
`task_started` and no `task_notification`. Until the `task_started` arrives, `background_tasks`
answers `{backgrounded:false}` for that tool_use id. A foreground Bash that does register gets
a `task_notification` (`status:"completed"`, `output_file:""`) when it finishes, like a
background one.

When a foreground task is backgrounded, `is_backgrounded` changes through `task_updated`
(§4.6); `task_started` is not re-emitted. ClaudeUI relays the start as `session:task-started`
with `isBackgrounded`, and re-sends that event for the same run with `isBackgrounded: true`
when the `task_updated` flip arrives. `TaskCard` and `ToolCard` offer "Send to background" only
for a record with `isBackgrounded === false`.

### `task_type` values (2.1.241)

The full enum grew past the four documented at 2.1.114 (`Wlv` map, `cli.js@char3683754`):
`local_bash` (`t`/`b` ids), `local_agent` (`a`), `remote_agent` (`r`), `in_process_teammate` (`t`),
`local_workflow` (`w`), `monitor_mcp` (`m`), `monitor_ws` (`s`), `mcp_task` (`k`), `dream` (`d`),
`auto_mode_scan` (`e`). Of these, `local_agent`/`remote_agent`/`in_process_teammate`/`local_workflow`
are the auto-continuing "agent-like" set (upstream busy predicate `S3e`, §3.7).

**Scoping gotcha (probed 2026-08-26):** a background Bash started INSIDE a subagent emits its own
top-level `task_started`/`task_notification` (`task_type: "local_bash"`) with **no
`parent_tool_use_id`** — task events are not scoped to the agent that spawned the task.

**Nested agents (probed 2026-09-30, 2.1.280, Haiku 4.5, `scripts/probe-nested-agents.mjs`).** The
main agent spawned background agent A; A spawned background agent B, ran a foreground Bash past 2 s
and a `run_in_background` Bash; B ran a foreground Bash past 2 s. The same scoping holds one level
down, and every id stays the call's own:

- B's `task_started` is **top-level**: `task_type: "local_agent"`, `spawn_depth: 2`,
  `is_backgrounded: true`, and `tool_use_id` = **A's Agent call for B** (not A's id).
- B's `assistant`/`user` snapshots carry `parent_tool_use_id` = B's own call id. B's `stream_event`s
  carry the same plus `agent_id` = B's task id (Patch E). A consumer keyed by call id places B's
  output under B, not A.
- A's Agent `tool_use` for B, and its "Async agent launched" `tool_result`, arrive as A's
  sub-agent frames (`parent_tool_use_id` = A's origin): the spawn call lives in **A's** transcript.
- B's terminal `task_updated` + `task_notification` are top-level with `tool_use_id` = B's call id.
  The `<task-notification>` user text for B landed in the MAIN transcript in this run (A had already
  finished; which transcript receives it is timing-dependent). A's own background Bash's
  notification went to A and resumed it: a second `task_started` for A under its origin id, whose
  stream events carry only `agent_id` (ADR-078's idle self-resume).
- On disk `subagents/` is flat: `agent-<id>.jsonl` + `agent-<id>.meta.json` for A and B alike. B's
  sidecar names its parent, `{"toolUseId":"<B's call>","parentAgentId":"<A's id>","spawnDepth":2,…}`;
  A's has no `parentAgentId` and `spawnDepth: 1`.
- Shells: A's and B's foreground Bashes register `is_backgrounded: false`, `owned_by_subagent: true`
  (see the correction above). A's `run_in_background` Bash registers `is_backgrounded: true`,
  `owned_by_subagent: true`, and its `tool_use` arrives in A's bucket with `run_in_background: true`
  intact.

ClaudeUI's use of this is ADR-073 §7.

### A RESUMED agent emits a second `task_started` (probed 2026-09-21, 2.1.268)

"Non-existent → existing" above describes the first run only. `SendMessage` to an agent that has
already reached a terminal `task_notification` **restarts it, and the full lifecycle repeats**:
`task_started` → `task_updated` → `task_notification`, once per run. Probe:
`scripts/probe-agent-resume.mjs`.

- `task_id` is **stable across runs** — it is the agent's identity.
- `tool_use_id` is **the id of whichever tool call started that run**: the `Agent` call for run 1,
  the `SendMessage` call for run 2. It is NOT stable, and it is not the agent's identity.
- `description` keeps the value from the original spawn.

The resumed child's own output is **split across both ids**, which is the trap:

| run 2 signal                                          | carries the tool_use_id of  |
| ----------------------------------------------------- | --------------------------- |
| `task_started` / `task_updated` / `task_notification` | the SendMessage call        |
| `stream_event` partials                               | the SendMessage call        |
| the completed `assistant` message                     | **the original Agent call** |

A consumer that keys subagent state by `tool_use_id` (as ClaudeUI does) must therefore map each
run's id back to the agent's ORIGIN tool_use id via `task_id`, and must not evict that mapping on a
terminal notification — see ADR-073. Observed sequence, `proberalpha`, 2.1.268:

```
run 1   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…  task_type=local_agent
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01Csp3…  status=completed
run 2   task_started      task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…  task_type=local_agent
        task_notification task_id=aec60e185d4e7eb6d  tool_use_id=toolu_01MYC4…  status=completed
```

**Harness gotcha:** `SendMessage` is a DEFERRED tool at this version — the model must call
`ToolSearch` (`select:SendMessage`) to load its schema before it can invoke it. A probe that stops
at the first `result` after asking for a resume will cut the run off mid-`ToolSearch`.

**Re-probed 2026-09-23 at 2.1.280** (Haiku 4.5). The clean resume above is unchanged. Three
additions:

- **cli.js resumes agents on its own, reusing the id of the run already in progress.** A
  `SendMessage` to a _running_ agent answers `"Message queued for delivery …"` and starts no
  run. If the agent finishes first, cli.js closes the run (`task_updated` + `task_notification`)
  and immediately starts another one to deliver the message, with a `task_started` under the same
  `tool_use_id`. An agent whose own background Bash finishes after the
  agent went idle is restarted the same way. Only a `SendMessage` to a _finished_ agent (answer:
  `"resumedAgentId"`) gets a new `tool_use_id`.
- **The resume `task_started` is gated on a terminal claim.** `register` emits it for an existing
  task only if the task id is in `terminalEmitClaims`. The claim is set when a terminal
  `task_notification` is emitted, consumed by the next `register`, and cleared wholesale by
  `reset()`.
- **Agents outlive the parent process** (`scripts/probe-agent-respawn.mjs`). When the parent is
  killed mid-run and the session is `--resume`d, cli.js reaps each orphaned agent with a
  `task_notification` carrying the `task_id`, `status: "stopped"` and **no `tool_use_id`**, ahead of
  `system/init`. A later `SendMessage{to: <agent id>}` resumes the agent from its disk transcript:
  `task_started` under the SendMessage id, while the child's completed messages carry the
  **original Agent call's id from the dead process**. `SendMessage{to: <name>}` fails after a
  respawn ("No agent named … is reachable"); only the id works. A consumer's task-id → origin map
  therefore has to survive the process (ADR-073 §5).

---

## 4.6 `task_updated`

Patch diff of a task's state changes.

**Anchor:** `4890453` inside `$D4(H, $, q)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_updated",
  "task_id": "...",
  "patch": {/* fields that changed — subset of task shape */},
  "session_id": "...",
  "uuid": "..."
}
```

At 2.1.280 the patch builder (`MMr`, `.cache/pristine-cli.js` @10110830) compares the old and
new registry record and emits only these keys: `status`, `description`, `end_time`,
`total_paused_ms`, `error`, and `is_backgrounded`. `is_backgrounded: true` is how a
foreground task reports that it moved to the background; it is sent before cli.js answers the
`background_tasks` request that caused it. Observed for Bash and for an agent:

```
system/background_tasks_changed  tasks=[{task_id:"bvup3m1hz", task_type:"local_bash", …}]
system/task_updated              task_id="bvup3m1hz"  patch={is_backgrounded:true}
control_response                 {backgrounded:true}
user (tool_result, ~1 s later)   "Command was manually backgrounded by user with ID: bvup3m1hz. Output is being written to: …"
…
system/task_notification         task_id="bvup3m1hz"  status="completed"   (when the command ends)
```

---

## 4.7 `task_progress`

Periodic progress snapshot.

**Anchor:** `7649634` inside `xc8(H)`.

**Gate:** Always.

```jsonc
{
  "type": "system",
  "subtype": "task_progress",
  "task_id": "...",
  "tool_use_id": "...",
  "description": "...",
  "usage": {
    "total_tokens": 123,
    "tool_uses": 4,
    "duration_ms": 5678
  },
  "last_tool_name": "Read",                // optional
  "summary": "...",                         // optional
  "workflow_progress": {...},               // optional — for local_workflow tasks
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.8 `compact_boundary`

Conversation compaction boundary. Emitted when cli.js compacts the transcript and inserts a boundary marker.

**Anchors:** `12801876` (compact-only turn early exit), `12806585` (main stream loop).

**Gate:** Always (when compaction triggers).

```jsonc
{
  "type": "system",
  "subtype": "compact_boundary",
  "session_id": "...",
  "uuid": "...",
  "compact_metadata": {
    "preservedSegment": { "tailUuid": "..." },
    ...
  }
}
```

**Field notes:** `compact_metadata` goes through `te8()` normalizer — preserve the entire object for replays.

---

## 4.9 `api_retry`

API error triggered automatic retry inside the streaming layer.

**Anchor:** `12806731`.

**Gate:** Always (when API error triggers retry).

```jsonc
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 2,
  "max_retries": 5,
  "retry_delay_ms": 1500,
  "error_status": 529, // HTTP status, null if non-HTTP
  "error": {/* normalized via U9K() */},
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.10 `queued_command_consumed` (RETIRED 2026-09-25)

Emitted only by the `queue-control` patch, deleted at 2.1.280. It announced, by the queued text,
that cli.js had taken a queued command: the patch hooked both the mid-turn fold (a `queued_command`
attachment) and the between-turns drain, and yielded `{subtype:"queued_command_consumed", prompt,
source_uuid}` from both. Its native replacement is `command_lifecycle` `started` (03 §3.21), keyed
by the client `uuid` the user frame carried instead of by text, and emitted by the official binary.

Two lessons from it still apply to the replacement:

- **Normalize a queued prompt before reading its text.** `prompt` was the pushed message's
  `message.content` verbatim — a string, or a block array whenever the prompt carried an image or a
  PDF. Comparing the array with the queued text never matched, so an image-carrying steer was
  only noticed at the turn-end flush and its bubble landed below its own answer. The same `prompt`
  field is what a persisted `queued_command` attachment carries (03 §3.21, "Transcript"); cli.js's
  rule (`rD` @2680178 on 2.1.280) is mirrored in `src/core/sdk/queued-command-text.ts`.
- **The frame that carries the first `session_id` is not `system/init`.** The notification landed
  before init on every turn, and a `captureSessionBootstrap` that nested its init capture inside
  `if (msg.session_id && !this.sessionId)` silently dropped `resolvedModelId`, `slash_commands`,
  `skills`, `mcp_servers` and the init permission-mode reconciliation — a `default` session sized
  its context window at 200K instead of 1M and rendered a 614K-token transcript as 307%.
  `command_lifecycle` `queued`/`started` land in the same place today. Latch the session id and
  read `system/init` **independently**.

---

## 4.11 Hook lifecycle — `hook_started`, `hook_progress`, `hook_response`

Internal hook events transformed by the `KGK` subscriber at char `4914613`. A dispatcher at char `12819444` subscribes when `--include-hook-events` + stream-json verbose.

**Anchors:**

- Dispatcher: `12819444`
- `hook_started` transformer: `12819588`
- `hook_progress` transformer: `12819602`
- `hook_response` transformer: `12819795`

**Gate:** `--include-hook-events` flag. Without it, `KGK` is never subscribed and these don't fire.

### `hook_started`

```jsonc
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "...",
  "hook_name": "PreToolUse",
  "hook_event": "...",
  "uuid": "...",
  "session_id": "..."
}
```

### `hook_progress`

```jsonc
{
  "type": "system",
  "subtype": "hook_progress",
  "hook_id": "...",
  "hook_name": "...",
  "hook_event": "...",
  "stdout": "partial stdout...",
  "stderr": "...",
  "output": "combined...",
  "uuid": "...",
  "session_id": "..."
}
```

### `hook_response`

```jsonc
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "hook_name": "...",
  "hook_event": "...",
  "output": "full output",
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "outcome": "allow"|"deny"|...,
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.12 `bridge_state`

Remote-control bridge state changes.

**Anchor:** `12856963`.

**Gate:** `remote_control` is actively enabled on the session. No-op otherwise.

```jsonc
{
  "type": "system",
  "subtype": "bridge_state",
  "state": "connecting"|"connected"|"failed"|...,
  "detail": "human-readable reason",       // optional
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.13 `session_state_changed`

Session state machine transition.

**Anchor:** `11924745`.

**Gate:** `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. Off by default.

```jsonc
{
  "type": "system",
  "subtype": "session_state_changed",
  "state": "idle"|"running"|"waiting"|...
}
```

**Field notes:** No `session_id` / `uuid` — raw emit, not flushed via `ZtH`.

---

## 4.14 `notification`

Error-condition notifications.

**Anchors:**

- `auto-mode-gate-plan-exit-fallback` at `~8376881`
- `stop-hook-error` at `~8610623`
- `error-compacting-conversation` at `~8914817`

**Gate:** Always (conditional on the respective error).

```jsonc
{
  "type": "system",
  "subtype": "notification",
  "key": "auto-mode-gate-plan-exit-fallback"|"stop-hook-error"|"error-compacting-conversation",
  "text": "human-readable message",
  "priority": "immediate"|...,
  "color": "warning"|"error"|...,
  "timeout_ms": 10000,
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.15 `memory_recall`

Emitted when cli.js loads relevant memories as an attachment (via `relevant_memories` attachment type).

**Anchors:** builder `Y17` at `12792370`; yield at `12805290`.

**Gate:** Always (when memory feature returns results).

```jsonc
{
  "type": "system",
  "subtype": "memory_recall",
  "mode": "synthesize"|"select",
  "memories": [
    {
      "path": "~/.claude/memory/ctx.md",
      "scope": "personal"|"project"|"team",
      "content": "..."                     // only present on synthesize mode entries
    }
  ],
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.16 `plugin_install`

Progress updates from plugin-install flow.

**Anchor:** `12831306`.

**Gate:** `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` env var.

```jsonc
{
  "type": "system",
  "subtype": "plugin_install",
  "status": "started"|"installed"|"failed"|...,
  "name": "plugin-name",
  "error": "error message",               // only on failed
  "uuid": "...",
  "session_id": "..."
}
```

---

## 4.17 `post_turn_summary`

Background post-turn summary emitted after each assistant turn (marked `@internal` in the SDK schema).

**Anchor (2.1.170):** schema `RF8` at `~7077561`.

```jsonc
{
  "type": "system",
  "subtype": "post_turn_summary",
  "summarizes_uuid": "...", // assistant message this summarizes
  "status_category": "...",
  "status_detail": "...",
  "needs_action": "...",
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.18 Filter behavior

The outer filter at char `12822512` lists subtypes excluded from `--output-format json` aggregation:

- `session_state_changed`
- `task_notification`
- `task_started`, `task_updated`, `task_progress`
- `notification`
- `post_turn_summary`

**In stream-json + verbose (our mode), the filter is a no-op** — every system message reaches stdout.

---

## 4.19 Consumer guidance

- **`init`** — always handle. First-message parsing for session metadata.
- **`status`** — handle all three variants. Differentiate by presence of `permissionMode` vs `compact_result` vs bare `status: "requesting"`.
- **`task_*`** — correlate by `task_id` in the client. `task_started` → `task_progress` (many) → `task_notification`. An active (non-terminal) task of an auto-continuing type means the conversation is NOT waiting for the user even after a `result` — see §3.7 "`result` vs background tasks".
- **`compact_boundary`** — preserve `compact_metadata` for session replay.
- **`api_retry`** — show in UI if visible. `retry_delay_ms` tells the user how long they're waiting.
- **`queued_command_consumed`** — retired with its patch (§4.10); a queued card is dismissed on the native top-level `command_lifecycle` `started` (03 §3.21).
- **`hook_*`** — expose in a debug panel; not typically user-facing.
- **`bridge_state`** — update remote-control status UI.
- **`session_state_changed`** — only handle when your workflow enables the env var; otherwise ignore.
- **`notification`** — surface as a toast / banner per `priority`/`color`/`timeout_ms`.
- **`memory_recall`** — log or show which memories were loaded.
- **`plugin_install`** — show install progress UI when the env var is set.
- **`model_refusal_fallback`** — render a persistent warning banner (the model switch is sticky for the session); evict `retracted_message_uuids` from transcript state; update any model indicator. See §4.20.
- **`model_fallback`** — render a warning for the current turn only (turn-scoped swap). See §4.21.
- **`thinking_tokens`** — optional spinner/pill progress; not authoritative token counts.
- **`commands_changed`** — REPLACE the cached slash-command list with the payload (a re-fetch returns the stale init list).
- **`elicitation_complete`** — dismiss any pending MCP elicitation UI.
- **`permission_denied`** — render the decision on the tool call instead of only showing an `is_error` tool_result. ClaudeUI does: a `classifier` decision becomes a `tool_review` block (the same one pi and opencode produce), except a recognisable no-verdict fallback (below), which becomes a `permission_denial` block like anything else. See `core/services/claude-permission-decision.ts`.
- **`mirror_error`** — log; surfaces transcript-mirror data loss.
- **`dev_intent`** — advisory only; safe to ignore. ClaudeUI does not handle it (unknown subtypes fall through `handleSystemMessage`'s if-chain). See §4.28.

Unknown subtypes: log and pass through. Don't silently drop.

---

## 4.20 `model_refusal_fallback`

Emitted when the primary model ends the stream with `stop_reason: "refusal"` and the CLI retries the turn once on a fallback model. **The swap is persistent for the rest of the session** (`direction: "retry"`). The enum values `"revert"` and `"sticky"` are retained for SDK-consumer compat and are no longer emitted.

This fires without any user-configured fallback model — it's a built-in safety-refusal recovery path (e.g. Fable 5 refusal → Opus 4.8).

**Anchors (2.1.170):**

- Gate fn `ed()` at `2535147`: `return !$_.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`
- Schema `WkO` at `~7083170`
- Internal builder `dxK` at `10478678`
- SDK emitter yields at `16271622` / `16271675` (inside the main generator's `case "system"`)
- Push-channel variant at `16088919`

**Gate:** On by default; disabled only by `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` env var.

### Shape (wire, snake_case)

```jsonc
{
  "type": "system",
  "subtype": "model_refusal_fallback",
  "trigger": "refusal",
  "direction": "retry", // "revert"|"sticky" legacy, no longer emitted
  "original_model": "claude-fable-5[1m]",
  "fallback_model": "claude-opus-4-8",
  "request_id": "req_...", // nullable
  "api_refusal_category": "cyber", // nullable/absent; open string ("cyber", "bio", …)
  "api_refusal_explanation": "...", // nullable/absent; unstable prose — display only
  "retracted_message_uuids": ["..."], // optional; see below
  "content": "…safety measures flagged this message… Switched to Opus 4.8…",
  "session_id": "...",
  "uuid": "..."
}
```

### Ordering (with `--include-partial-messages`)

If a partial assistant message was mid-stream when the refusal hit, the CLI first **retracts** it by synthesizing closing stream events:

1. `stream_event` `content_block_stop` (only if a block was open)
2. `stream_event` `message_delta` with `delta.stop_reason: "refusal"` + usage
3. `stream_event` `message_stop`
4. the `model_refusal_fallback` system message
5. the turn replays on the fallback model — subsequent `assistant` messages carry `model: <fallback_model>`

### Field notes

- **`retracted_message_uuids`** — wire uuids of the messages this fallback retracted (the refused partial as the consumer received it, one uuid per normalized SDK message, plus any tombstoned tool_results). Emitted AFTER the retraction: remove these from transcript state on receipt. Eviction is idempotent — unknown/already-removed uuids are a no-op. Absent on older CLIs.
- **Transcript JSONL form is camelCase** (`originalModel`, `fallbackModel`, `requestId`, `apiRefusalCategory`, `retractedMessageUuids`) and adds `level: "warning"` — don't reuse wire parsing for transcript parsing.
- The retried assistant message in the transcript may carry a `{"type": "fallback", "from": {"model": ...}, "to": {"model": ...}}` content block recording the swap.
- **Usage attribution:** all post-fallback API calls record `message.model = fallback_model`. A session that started on Fable and fell back bills as the fallback model from that point — usage analytics will (correctly) show the fallback model.

---

## 4.21 `model_fallback`

Availability fallback — the current turn is switched to the **configured** fallback model because the primary failed with an availability error. Unlike §4.20 this is **turn-scoped**: the primary is re-tried on the next user turn. Marked `@internal` / "not yet in the public SDKMessage union" in the schema, but it IS yielded by the SDK emitter, ungated.

**Anchors (2.1.170):** schema `VIA` at `~7084860`; emitter yield at `16272124`.

**Gate:** Requires a configured fallback model (`--fallback-model` / settings); fires on availability errors.

```jsonc
{
  "type": "system",
  "subtype": "model_fallback",
  "trigger": "model_not_found"|"permission_denied"|"overloaded",
  "original_model": "...",
  "fallback_model": "...",
  "content": "human-readable render text",
  "session_id": "...",
  "uuid": "..."
}
```

`model_not_found`: model retired/unknown. `permission_denied`: org lacks access. `overloaded`: repeated 529s.

---

## 4.22 `thinking_tokens`

Live thinking-token estimate, digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase (where the API otherwise streams only pings). Also recomputed from signature length on `signature_delta`.

**Anchors (2.1.170):** schema `xkO` at `~7092092`; yields at `16266973` / `16267340` (stream-event digestion in the main generator).

**Gate:** Emitted while thinking deltas stream (practically: sessions with extended thinking).

```jsonc
{
  "type": "system",
  "subtype": "thinking_tokens",
  "estimated_tokens": 1234, // running total for the current thinking block
  "estimated_tokens_delta": 56, // increment carried by this frame
  "session_id": "...",
  "uuid": "..."
}
```

Approximate progress for spinners/pills — not the authoritative billed `output_tokens`.

---

## 4.23 `commands_changed`

Fire-and-forget push of the **full** slash-command list after a mid-session change (e.g. skills discovered dynamically as the agent works in a subdirectory).

**Anchors (2.1.170):** schema `CkO` at `~7090713`; emit at `16316834` (stream-json module).

**Gate:** Always (when the command list changes mid-session).

```jsonc
{
  "type": "system",
  "subtype": "commands_changed",
  "commands": [{/* same command shape as initialize's supportedCommands */}],
  "session_id": "...",
  "uuid": "..."
}
```

**Consumer:** REPLACE the cached command list. `supportedCommands()` is captured once at initialize and never reflects mid-session changes, so a client re-fetch would return the stale init list.

---

## 4.24 `elicitation_complete`

Emitted when an MCP server confirms that a URL-mode elicitation is complete.

**Anchors (2.1.170):** schema `pkO` at `~7094043`; emit at `16307841` (stream-json module).

```jsonc
{
  "type": "system",
  "subtype": "elicitation_complete",
  "mcp_server_name": "...",
  "elicitation_id": "...",
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.25 `permission_denied`

`permission_denied` is emitted when a tool call is **auto-denied without an interactive permission prompt** (auto-mode classifier, `dontAsk` mode, headless-agent auto-deny, or a deny rule). The "ask" path surfaces via a `can_use_tool` control_request; this event covers the "deny" short-circuit so SDK hosts can render the denial instead of only seeing an `is_error` tool_result. PreToolUse hook denies bypass `canUseTool` and are NOT covered.

No frame reports an **auto-mode classifier allow**: the emit site is gated on `behavior === "deny"`, so Claude shows a judge's verdict on a block and nothing on an allow. Internally cli.js stamps `decisionReason.classifierAllowed === true` on a `classifier` allow where the classifier ran and reached a verdict (`noVerdict !== true`, `classifierRan !== false`), but that flag never reaches the wire. ClaudeUI's `automode-verdict` patch emitted the allow half as `system/permission_allowed` until 2026-09-28, when the owner ruled allow verdicts not worth a patch; nothing on the stock wire carries that subtype.

**Anchors (2.1.170):** schema `BkO` at `~7094308`; emit at `7156177` (control-channel area). On 2.1.280 the emitter is the `emitPermissionDenied(n,e,s,r){…this.outbound.enqueue({…})}` method on the control-channel class (see "Two emitters" below).

```jsonc
{
  "type": "system",
  "subtype": "permission_denied",
  "tool_name": "Bash",
  "tool_use_id": "toolu_...",
  "agent_id": "...", // optional; subagent ID when decided inside a subagent
  "decision_reason_type": "rule", // optional; 'classifier'|'asyncAgent'|'mode'|'rule'|…
  "decision_reason_code": "...", // optional, 2.1.280+; machine code, see below
  "decision_reason": "...", // optional human-readable reason
  "message": "...", // the rejection message returned to the model
  "session_id": "...",
  "uuid": "..."
}
```

### Which permission wrapper an SDK host gets

cli.js builds the permission function from `--permission-prompt-tool`. With `stdio` (and not `none`) it returns `createCanUseTool(…)` → the **stdio wrapper**, which emits `permission_denied` on its deny branch and raises `can_use_tool` control requests on its ask branch. With no prompt tool, or `none`, it builds a different inline wrapper that emits after resolving the ask itself. **An SDK host with a `canUseTool` callback passes `--permission-prompt-tool stdio`** (`src/core/sdk/args.ts`), so it gets the stdio wrapper; ClaudeUI always does. Earlier revisions of this section and of the patch README said the opposite. The distinction matters to anyone patching either wrapper: a test harness that never passes a prompt tool exercises only the other one.

### `decision_reason_code` (2.1.280+)

Upstream added a machine-readable code beside `decision_reason`. It is set for a few specific reasons and absent otherwise, including for every ordinary classifier verdict:

| Code                             | When                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `classifier_transcript_too_long` | the classifier transcript exceeded its context window (`classifier` with `noVerdict`, or `other` / `safetyCheck` with the same reason) |
| `outside_reads_blocked`          | `permissions.blockReadsOutsideWorkingDirectories` refused a read                                                                       |
| `memory_paused`                  | memory access blocked by `/pause-memory`                                                                                               |

For `subcommandResults` it is taken from the subcommands, with `outside_reads_blocked` taking precedence.

### The non-verdict classifier outcomes

`decision_reason_type: "classifier"` does **not** always mean the classifier judged the action. cli.js (2.1.268 and 2.1.280) builds all of the following with `type: "classifier"`:

| Behavior | `noVerdict` | `decision_reason`                                                                                                                                        |
| -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deny     | `true`      | an empty classifier action (the tool gave the classifier nothing to judge)                                                                               |
| deny     | `true`      | `"Auto mode classifier transcript exceeded context window — …"`                                                                                          |
| deny     | `true`      | a safeguard refusal of the classifier request                                                                                                            |
| deny     | `true`      | (2.1.280) `"Auto mode unavailable — stopped after repeated responses with no safety verdict"`                                                            |
| deny     | not set     | `"Classifier unavailable"` — cli.js itself tells this one apart by the exact string                                                                      |
| allow    | `true`      | `"Delivered with a warning: the classifier request was refused by the safety safeguard"` / `"Delivered with a note: the classifier could not review it"` |
| allow    | not set     | `"Tool declares no classifier-relevant input"` (the classifier never ran; its `classifierRan: false` is stripped before the decision leaves)             |

The frame carries none of `noVerdict` / `classifierRan`, and `decision_reason` for a `classifier` decision is `decisionReason.reason` verbatim, so a host cannot tell "the judge blocked this" from "the judge was never reached" from the flags alone. The allow rows are never on the wire (no allow frame exists). Three deny rows are recognisable natively: `"Classifier unavailable"` and the no-verdict streak `"Auto mode unavailable — stopped after repeated responses with no safety verdict"` by exact reason, and the transcript overflow by `decision_reason_code: "classifier_transcript_too_long"` (2.1.280+, which cli.js sends on a `classifier` deny only for that fallback). ClaudeUI routes those three to a `permission_denial` with source `autoModeNoVerdict`; the rest (a safeguard refusal, an empty classifier-only action) have free-form reasons and render as a verdict carrying that reason.

### Two emitters — only one is on the wire (probed 2.1.268, 2026-09-21)

cli.js builds `permission_denied` in **two** places, and this trips up anyone hooking the obvious one:

1. **The engine turn loop** wraps `canUseTool` and pushes advisory frames onto a `pendingDenialFrames` buffer, drained by a generator into the engine's message stream. It sits right next to the tool executor and is a **dead end**: that stream passes through the stdout adapter's `case "system"` switch, whose `default: return` drops every subtype not explicitly listed — and `permission_denied` is not listed. Frames emitted here are enqueued, yielded, and silently discarded.
2. **The control-channel class** (`emitPermissionDenied`) enqueues onto `this.outbound`, written to stdout unconditionally under `--output-format stream-json --verbose`. **This is the wire.**

Verify by instrumenting both with `process.stderr.write(...)` before assuming.

### `decision_reason` is not symmetric between allow and deny

- **Allow** reasons are **fixed cli.js strings**: `"Allowed by fast classifier"` (stage 1 cleared it), `"Allowed by classifier"` (stage 2 did), or `"Not flagged by the server-side auto mode classifier"`. They say which stage decided but are not model prose, and no frame carries them.
- **Deny** reasons ARE model text, following the stage-2 grammar (§14 §2): `[Exact Rule Name]` optionally followed by one sentence. Observed live: `"[Create Unsafe Agents]"` with no sentence at all. A consumer must handle bracket-only, bracket-plus-sentence, and no-bracket (`fast` mode never asks for one). The content-free fallbacks are `"Blocked by classifier"` (category mode with no rule) and `"No reason provided"` (the model gave no `<reason>`).

`cli.js`'s own rejection `message` restates the reason inline: _"Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Create Unsafe Agents]. …"_ — so it is also the `tool_result` body, and a consumer that renders both will say the same thing twice.

### The frame is not persisted

`permission_denied` is excluded from the "worth keeping" predicate that gates the accumulated message list, the `--output-format json` last-message pick, and the transcript mirror. It is live-only: a reopened session shows no verdicts, on any engine (ClaudeUI's own `tool_review` blocks are live-only too, so this is parity rather than a gap).

---

## 4.26 `mirror_error`

Emitted when `SessionStore.append()` rejects or times out for a transcript-mirror batch after bounded retry (3 attempts with short backoff; timeouts are not retried). The batch is then dropped — this surfaces the failure so consumers are not silent on data loss.

**Anchors (2.1.170):** schema `XkO` at `~7082241`; emit at `12946429`.

```jsonc
{
  "type": "system",
  "subtype": "mirror_error",
  "error": "...",
  "key": { "projectKey": "...", "sessionId": "...", "subpath": "..." }, // subpath optional
  "session_id": "...",
  "uuid": "..."
}
```

---

## 4.27 Schema-only / internal subtypes (not on the SDK stdout wire)

The SDK schema union (region `~7060000–7100000` in 2.1.170) declares more subtypes than the wire emits. The main generator's `case "system"` forwards exactly four internal system messages — `compact_boundary`, `api_error`→`api_retry`, `model_refusal_fallback`, `model_fallback` — and the emitter switch explicitly `break`s (drops) others, e.g. `api_metrics`. The subtypes below are mapped from internal `SystemMessage`s for the **transcript-mirror channel** (desktop LocalSessionManager / SessionStore), so they can appear in session JSONL transcripts but should not be expected on stdout in SDK mode:

| Subtype                | Internal meaning                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `task_summary`         | Mid-turn progress line from the debounced classifier; `detail` null on idle clear          |
| `informational`        | Generic loop text banner (`level`: info/notice/suggestion/warning; `prevent_continuation`) |
| `permission_retry`     | Tool execution retried after permission-mode change allowed denied commands                |
| `stop_hook_summary`    | Stop/SubagentStop hook execution summary at turn end                                       |
| `memory_saved`         | Memory subsystem wrote `written_paths`                                                     |
| `agents_killed`        | Background agents terminated (e.g. on interrupt)                                           |
| `away_summary`         | Summary of what happened while the user was away                                           |
| `thinking`             | Rendered thinking text (not the token estimate — that's §4.22)                             |
| `file_snapshot`        | Snapshot of session files (plan, todo) captured for rewind                                 |
| `scheduled_task_fire`  | Scheduled (cron) task fired                                                                |
| `api_metrics`          | Per-turn TTFT + output-tokens/sec line (distinct from top-level `api_metrics` message)     |
| `local_command_output` | Output from a local slash command (e.g. `/usage`)                                          |
| `files_persisted`      | Attachment-file persistence results                                                        |
| `session_metadata`     | 2.1.285: `metadata.artifacts` from the same `notifyMetadataChanged` path as `task_summary` |

If one of these is observed on stdout in a future CLI version, promote it to a numbered section.

---

## 4.28 `dev_intent`

**Added in 2.1.268.** A one-shot advisory that cli.js has inferred what kind of
project the session is working on. Only one kind exists today.

```json
{ "type": "system", "subtype": "dev_intent", "kind": "ios_app" }
```

| Field  | Type   | Notes                                                      |
| ------ | ------ | ---------------------------------------------------------- |
| `kind` | string | From the kind list `["ios_app"]` — the only one in 2.1.268 |

**Detection.** A per-session fold (chunk `chunk-gm00f911.js`) walks messages
looking for two independent signals and emits only when BOTH have been seen:

1. `swiftFileEdited` — a Write/Edit-family tool call whose `file_path` ends in
   `.swift`.
2. `iosEvidence` — any of: `import UIKit` / `.iOS(` in written content;
   `SDKROOT = iphoneos|iphonesimulator`, `IPHONEOS_DEPLOYMENT_TARGET` or
   `TARGETED_DEVICE_FAMILY` in written content or in a tool_result;
   `simctl`, `-sdk iphonesimulator|iphoneos` or `platform=iOS Simulator` in a
   Bash command.

It fires **at most once per kind per session**, and a detector that throws is
swallowed (telemetry `dev_intent_detect/fold_threw`) — never fatal.

**Gate.** Ungated: no env var, no feature flag. But in the headless stream-json
path the fold only absorbs `initialMessages` at session construction — the TUI
is the only caller that feeds it live turn messages (it uses the result to pick
spinner tips). So on our wire `dev_intent` can only appear **at session start,
on a resume whose transcript already carries both signals**, never mid-turn.

**Consumer note.** Advisory only; nothing downstream depends on it. ClaudeUI
ignores it — `handleSystemMessage` is an if-chain over known subtypes and
`SystemMessage['subtype']` admits `string`, so an unhandled subtype is a no-op
rather than an error.

---

## 4.29 `session_title_changed`

**Added in 2.1.285.** The session's user-set name, for a host that displays it.

```json
{
  "type": "system",
  "subtype": "session_title_changed",
  "title": "…",
  "uuid": "…",
  "session_id": "…"
}
```

The schema (`@internal`) says a headless session sends it **at startup when the
session already has a name**, then after every change to the name. That includes a
`rename_session` the host itself sent, but not an AI-generated title. A cleared
name is not sent. A name another process writes into the transcript arrives only
when this process next reads its transcript tail, after about 32 KB of its own
writes or at a compaction. `title` is sanitised (control, bidi and zero-width
characters become spaces, trimmed, at most 200 code points) and can carry a
uniqueness suffix.

**Gate.** Ungated. The emitter subscribes during stream-json session setup and
fires once immediately, so on a resume of a named session it can arrive **before**
`system/init`. Probed on 2.1.285: a stream-json spawn with `--name probe-title` and no
prompt writes `session_title_changed` as its first stdout line. That is harmless to ClaudeUI, which reads init independently of
the session-id latch (§4.2), but a consumer that treats "first system message" as
init would break.

**Consumer note.** Not consumed. ClaudeUI names sessions itself, and unknown
subtypes are no-ops (§4.28).

## 4.30 `per_turn_effort_changed`

**Added in 2.1.285.** `@internal`. Sent once, when the conversation stops sending
effort per turn because the server refused its per-turn effort message or a
`role:"system"` message. From the retried request on, an effort change rewrites the
cached prefix for every model, until a later `system/init` says otherwise.

```json
{
  "type": "system",
  "subtype": "per_turn_effort_changed",
  "per_turn_effort_active": false,
  "uuid": "…",
  "session_id": "…"
}
```

`per_turn_effort_active` is always `false`; a change back to `true` is reported
only by `system/init`. Relevant to models whose catalog entry carries the
`per_turn_effort` capability (Sonnet 5.5 among them, 13 §13.5).

**Consumer note.** Not consumed; unknown subtypes are no-ops.

## 4.31 `instruction_size_warning`

**Added in 2.1.289.** Emitted when loaded instruction files exceed the active
per-file or aggregate character limits, behind cli.js's instruction-warning gate.

```json
{
  "type": "system",
  "subtype": "instruction_size_warning",
  "total_chars": 123456,
  "total_limit_chars": 100000,
  "file_count": 4,
  "largest_chars": 80000,
  "uuid": "…",
  "session_id": "…"
}
```

`largest_chars` is optional and appears when more than one file is loaded and
the largest alone exceeds the aggregate limit. The static builder is `gS` in
the 2.1.289 darwin-arm64 concat at char `~27236553`; it returns `null` when
there is no aggregate-limit warning or the gate is off. ClaudeUI does not
consume this subtype; its permissive system-message handling makes it a no-op
rather than a break.

## 4.32 `permission_check_status`

**Added in 2.1.293, `@internal`.** Sent for a tool call whose automatic permission
check (the auto-mode classifier) has been waiting for about 4 s.

```json
{
  "type": "system",
  "subtype": "permission_check_status",
  "tool_use_id": "toolu_…",
  "agent_id": "…",
  "status": "checking",
  "uuid": "…",
  "session_id": "…"
}
```

`checking` goes out once the check has waited ~4 s, and `done` when it ends; a check
that answers sooner sends nothing. `agent_id` is present only when the call came from
inside a subagent, as on `permission_denied` (§4.25). It travels the shared SDK event
queue (the `task_notification` path), so it is on the stream-json wire in print mode.
Read from the 2.1.293 bundle, not probed live. ClaudeUI does not consume it; unknown
subtypes are no-ops.
