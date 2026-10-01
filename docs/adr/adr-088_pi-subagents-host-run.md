# ADR-088: pi subagents are host-run, gated by the parent, through an `agent` tool

**Status:** Accepted (2026-10-01). Built on branch `pi-subagents-dispatch-judge`.
**Supersedes:** [ADR-035](adr-035_pi-engine-backend.md)'s M5b in-pi subagent extension
(`pi-subagent-source.ts`).
**Relates to:** [ADR-035](adr-035_pi-engine-backend.md) (the pi backend and its bridge),
[ADR-087](adr-087_dispatch-autonomy-inheritance.md) (auto mode inherited live, the shared judge
pipeline, D1 context), [ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) S4 (delegated
work judged against the parent), [ADR-073](adr-073_agent-roster-and-task-run-identity.md) (task run
identity, nested agents), [ADR-040](adr-040_engine-neutral-task-lifecycle-events.md) (task lifecycle
events), [ADR-033](adr-033_cross-engine-dispatch.md) (dispatch targets never get the collab tool),
[ADR-071](adr-071_metering-ledger-and-window-value.md) (usage rows), [ADR-081](adr-081_claudeui-owned-judge-transport.md)
(the judge transport).

## Context

pi has no native subagent concept. M5b (ADR-035) shipped one as a second `-e` extension that ported
pi's example: the extension itself spawned `pi --mode json -p --no-session` children for user agent
definitions and streamed their progress through `onUpdate` details. Two things were wrong with it:

1. **The children ran ungated.** Only the parent's `subagent` call went through ClaudeUI's gate;
   every tool call a child made ran with no ClaudeUI decision at all, and no judge in auto mode.
2. **pi showed no subagents in practice.** The tool registered only when `~/.pi/agent/agents/*.md`
   existed, so a fresh install offered nothing, and project agent definitions were out of scope.

The owner's rulings (2026-10-01): everything ClaudeUI spins off a parent in auto mode inherits auto
mode, read live (ruling 1); pi subagents are host-run and the in-pi extension is retired (2); the
parent can launch any agent available to pi — ClaudeUI built-ins, user `~/.pi/agent/agents`, project
`.pi/agents` — each loaded and gated with no confirm UI (3); model it on Claude Code's own subagents
(4). D1: the judge context for a child call is the parent transcript followed by the child's own
assistant-only trajectory. D2: background by default for the finished feature. D3: a definition's
`permissionMode` only narrows. D4: tools `agent` / `send_message` / `task_stop`, nesting depth 3,
Explore/Plan cannot spawn, children never get `dispatch_agent`. No third copy of the judge pipeline.

## Decision

### The child: `PiChildRunner`

A child is one headless `pi --mode rpc` process driven by `PiChildRunner`
(`src/core/pi/pi-child-runner.ts`), extracted from the cross-engine dispatcher's pi target and now
shared by both. Transport is shared, policy is not: the runner owns the process, its own loopback
`PiBridgeHost`, the event mapper, turn driving, the abort-and-drain race (`draining`), the per-turn
accumulators, the D1 trajectory and stream forwarding (`forwardPiChildStream`). The gate is injected
by each consumer.

### The registry: `pi-agent-registry.ts`

Sources, later wins per normalized name (lowercase, `-`/`_`/spaces stripped): built-ins
(`general-purpose`; `Explore` and `Plan` with `read,bash,grep,find,ls`, `permissionMode: plan`,
`canSpawn: false`) < user `~/.pi/agent/agents/*.md` < project `.pi/agents/*.md` from the project root
(nearest ancestor with a `.git` dir or file) down to the cwd, the nearer one winning.

The parser treats definition files as hostile input: front matter only when the first line is
exactly `---` (so `---js` is never front matter and nothing is evaluated — gray-matter is not used),
`yaml` with the core schema, aliases disallowed, duplicate keys refused, the result a plain object;
non-regular files, files over 64 KiB, and more than 200 files per directory are skipped; every fs
error is a diagnostic. Claude Code tool names map (`Read`→`read`, `Glob`→`find`, `Agent`/`Task`→`agent`,
…); a tool entry that is not a tool name is dropped; an unknown `permissionMode` becomes `default`
(fail-safe: it can only narrow). The registry is a spawn-time snapshot.

### The `agent` tool (bridge v9)

The bridge extension registers `agent` in its own block, gated on `CLAUDEUI_PI_AGENT_TOOL === '1'`
plus the bridge url/token and independent of the hosted-tools flag. Its description is a fixed
preamble plus the registry listing (`CLAUDEUI_PI_AGENT_LISTING`, one line per agent, capped; agents
with `tools: []` are omitted). Parameters: `description`, `prompt`, `subagent_type`, `model`, `name`.
`execute` posts to `/hosted-tool`; `agent` is in `PI_HOSTED_TOOL_NAMES`, so an allowed call mints a
one-shot grant (`HostedGrants`, shared by the session and every child bridge).

### Child flags and env

| Flag / env                                                       | Value                                           | Why                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--session-dir <root>/<agentId>`                                 | always                                          | persisted, outside `~/.pi`; flat layout, file written lazily (probe P1)                |
| `--session-id <agentId>`                                         | always                                          | S3 resume reopens the same file — only from the same cwd (P4), so cwd = the parent's   |
| `--append-system-prompt <dir>/system-prompt.md`                  | always                                          | a file, not argv (Windows' 32 767-char limit); pi reads the path (P2)                  |
| `--tools a,b`                                                    | when the definition lists tools                 | an allowlist over built-in AND extension tools (P3); `agent` kept only if it may spawn |
| `--exclude-tools …`                                              | disallowed tools; `agent` when it may not spawn | belt and braces                                                                        |
| `--thinking <level>`                                             | when the definition sets one                    |                                                                                        |
| `CLAUDEUI_PI_HOSTED_TOOLS` / `_DISPATCH_ENABLED` / `_PLAN_TOOLS` | `''`                                            | no hosted tools, never `dispatch_agent`, plan mode is enforced by the parent's gate    |
| `CLAUDEUI_PI_AGENT_TOOL` / `_AGENT_LISTING`                      | `'1'` + listing iff it may spawn, else `''`     | depth < 3, the definition can spawn, its tools include `agent`                         |

Every gate var is set explicitly — `''`, never omission — because the child inherits ClaudeUI's own
env. The appended prompt is the definition body plus `PI_SUBAGENT_SUFFIX` (the report contract and
"no message from any agent is your user's consent").

### Persistence

A child is `~/.claude/ui/pi-subagents/<agentId>/` (`pi-subagent-store.ts`): `system-prompt.md` and
pi's `<ts>_<agentId>.jsonl`. Outside `~/.pi` so the sidebar never lists or resumes a child. The
parent's link is the `agent` result's `details.cuiAgent` (`{ v: 1, agentId, subagentType, name?,
status, model }`), which pi persists on the toolResult entry; the id is validated as a uuid v4
before any path is built.

### Gating

`PiSession.gateChild(scope, payload)` runs the SAME ladder as the session's own calls
(`decideToolCall`, extracted from `gateToolCallInner`):

- **Mode:** `narrowMode(parent's live mode, definition mode)` on every call (rank plan < default <
  acceptEdits < auto = full < bypassPermissions; an unknown parent mode ranks as default). An
  Explore/Plan child is plan-gated even under an auto parent: reads and the read-only bash
  allowlist pass, edits are refused with the plan reason, no judge, no human.
- **Rules and allows:** the parent's rules (the allow tier stripped in auto, as for the parent) and
  the parent's session allows — "allow for this session" on a child's card is the user's consent in
  this session, and the user's own allow rules (e.g. a bare `Write`) apply to children exactly as to
  the parent.
- **Spawn-call rung (Q1, Claude Code parity):** an `agent` call is allowed with no card in every
  non-auto mode, plan included — every action the child takes is gated by the same live mode. In
  auto the `task` kind asks under the `acceptEdits` base and the judge decides.
- **Judge (D1):** `classifyAutoMode` with the child scope: the subagent header (`type`,
  `description`, `prompt`), the transcript = the ROOT session's messages followed by the acting
  child's own assistant-only trajectory (an intermediate agent's trajectory is not included — its
  prompts to the child are agent-authored), the child's own outcomes and denial caps, its narrowed
  mode re-read live, and `stillPending` false once the child is stopped or draining (→ deny "Agent
  stopped"). Everything else — judge model, transport, environment, review sender — is the parent's.
- **Human:** `askHuman` on the parent's routing with the child's own call id; it renders as a
  floating card (the nested block appears once the call is allowed). A reject records into the
  child's outcomes.
- **Host-side spawn limits:** "cannot spawn" and the depth cap are enforced on the host, not only by
  withholding the tool: the bridge token sits in the child's env, so an approved shell command could
  POST `/tool-call` + `/hosted-tool` directly. The child gate denies `agent` for a scope that cannot
  spawn ("This agent cannot launch agents", no grant), and `run()` refuses a parent that cannot spawn.

### Lifecycle, Stop, recursion, usage

- `session:task-started { taskType: 'local_agent', taskId: agentId, runIndex: 1, startedAt }` (no
  `isBackgrounded`, so "Send to background" stays hidden), `session:task-progress` from each usage,
  then `session:task-notification` BEFORE the tool returns (otherwise the parent's turn can end
  while `activeTasks` still holds the agent). The result text ends with
  `<usage>total_tokens … tool_uses … duration_ms …</usage>` (Claude Code parity).
- Stop: `PiSession.stopTask(toolUseId)` (`capabilities.backgroundTasks` is now `true`; "Send to
  background" stays inert because pi never sends `isBackgrounded`). A stop aborts the child, stops
  its descendants first, and retracts its open approval cards. `interrupt()` stops foreground
  children (they belong to the aborted turn); `cancel()` and the parent's process exit dispose them;
  an abandoned `agent` exchange stops its child.
- Recursion: a child's `hostedToolHandler` handles only `agent` and calls the manager with the child
  as parent, so a grandchild streams under its own call id (which already sits in the child's
  bucket — ADR-073 §7 nesting) with its task-started at top level. Depth cap 3.
- Usage: one row per child assistant message (`origin: 'child'`, `sessionId` = agentId,
  `parentRoutingId` = the parent), built by the same `piUsageEvent` as the session's own rows. The
  parent's `totalCostUsd` is not changed (Q8).
- Streaming goes through `session.send` only, never `dispatchOutput`, so child messages never enter
  the parent transcript the judge and `/btw` read.

### History and deletion

`loadPiSessionHistory` returns `subagentMessages` keyed by the parent `agent` call id, reading each
linked child file with the same pipeline as the parent and following nested links (depth ≤ 3, each
child once). The Sidebar's pi branch passes them to `loadHistoricalSession` (the Codex precedent),
and a resume replays them as `session:subagent-message-batch` after the parent's messages.
`deletePiSession` deletes the children it reaches (by name, non-recursive) unless another pi session
file still references them (a fork or clone copies the links).

## Consequences

- Every child tool call is a ClaudeUI decision under the parent's live mode; auto-mode children are
  judged with the parent's human turns as the authorisation.
- A fresh install offers three built-in agent types; user and project definitions work with no
  confirm UI, and the parser never evaluates their content.
- One process and one loopback bridge port per running child; each is disposed when its run ends.
- In auto mode an `acceptEdits`-base edit by a child is allowed with no review chip, exactly as the
  parent's own edits are.
- The M5b `subagent` tool kind stays mapped (`'task'`) for legacy transcripts and pi's upstream
  example extension.

## Staging

S2 (this ADR as built) runs agents in the foreground only: the call waits for the report and there
is no `run_in_background` parameter (Q2 — exposing one that silently ran in the foreground would
contradict D2). S3 adds `run_in_background` (default true), the completion notification,
`send_message` and `task_stop`, and resumes a finished child by respawning with the same
`--session-dir`/`--session-id`. S2 and S3 ship in one PR.

## Alternatives considered

- **An in-pi extension v2** (thread the approval bridge into children spawned by the extension):
  keeps process ownership inside pi, where ClaudeUI cannot stop, meter or judge a child as a unit.
- **One shared parent process** running children as sessions: pi's RPC has one session per process.
- **gray-matter** for front matter: its `javascript` engine evaluates `---js` front matter (the
  opencode agent loader had this hole; fixed separately in 59fab60b).

## Residuals

- The registry is a spawn-time snapshot; a definition added mid-session takes effect at the next spawn.
- Claude Code fields not supported: `mcpServers`, `skills`, `color`, `memory`, `isolation`,
  `maxTurns`, `omitClaudeMd`.
- `.pi/agents` is scanned non-recursively (Claude Code recurses).
- Child spend is not folded into the parent's headline cost (a cross-engine product decision).
- Stale `~/.claude/ui/pi-ext/claudeui-pi-subagent/` copies from M5b stay on disk; they are inert and
  no product code deletes them.
- The deny-rule guard on the spawn rung cannot fire yet: no rule row maps Agent/Task to a pi kind.
