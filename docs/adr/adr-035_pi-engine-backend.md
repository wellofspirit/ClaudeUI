# ADR-035: pi engine backend — RPC stdio subprocess, bridge-extension gating & hosted tools

**Status:** Accepted (implemented on branch `pi`, M0–M4c)
**Date:** 2026-07-20
**Relates to:** ADR-018 (engine/vendor/account model), ADR-019 (opencode backend — the template this
mirrors), ADR-020 (persistence/config plane), ADR-021 (neutral auth), ADR-022 (permission mapping),
ADR-024 (interaction parity), ADR-025 (engine-neutral delete), ADR-030 (capability honesty),
ADR-033/034 (cross-engine dispatch + cost accounting), ADR-026 (workflow)

## Context

pi ([earendil-works/pi](https://github.com/earendil-works/pi), Mario Zechner's minimal coding agent)
is added as ClaudeUI's third engine behind the existing engine-neutral seam (ADR-018). Unlike
opencode (a shared HTTP/SSE server per cwd), pi is **Claude-shaped**: no server, one
`pi --mode rpc` child process per session speaking LF-framed JSONL over stdio, with a purpose-built
embedding protocol (`docs/protocol-pi/README.md` — the verified wire reference; version-exact docs
ship inside the vendored payload at `vendor/pi-cli/docs/`).

Two facts drove the design, both **probed against the real binary before any product code** (the
"probe the wire first" discipline, ADR-026 / [[feedback-probe-cli-wire]]):

1. **pi has no native permission system** — it executes tools ungated. The sanctioned interception
   point is a ClaudeUI-owned TypeScript extension loaded per-spawn via `-e`, whose `tool_call` hook
   returns `{block, reason}`. Verified: the hook fires, blocking provably prevents execution, and
   the extension can `fetch()` a loopback endpoint to make the decision.
2. **pi has no MCP client** — hosted tools (mermaid/mockup) and `dispatch_agent` reach the model via
   `pi.registerTool()` in that same extension. Verified: `parameters` accepts a plain JSON-schema
   object (no typebox import needed in the import-free extension), `execute()` returns the MCP-shaped
   `{content,isError?}`, and the `tool_call` gate fires for registered tools too (so hosted tools are
   a two-stage flow: gate, then execute).

## Decision

- **Transport:** one vendored `pi --mode rpc` child per ClaudeUI session (`PiRpcClient`, LF-only
  JSONL framing — never Node `readline`), lazily spawned, tree-killed on Windows. This is the
  claude-shaped lifecycle, not opencode's ref-counted server. `PiSession extends BaseSession`;
  a **pure `event-mapper`** (`mapPiEvent`) translates pi events → the neutral `session:*` contract,
  mirroring opencode's `event-mapper.ts` shape. `agent_settled` is the turn-complete signal.
- **Packaging:** pinned prebuilt binary under `vendor/pi-cli/` via `scripts/ensure-pi.mjs`
  (GitHub-release asset + SHA256 verify, Node-native zip/tar extractors), version pinned as
  `package.json#piCliVersion`, shipped via electron-builder `extraResources`. Mirrors
  `ensure-opencode`. **No vendored source snapshot per bump** (deliberate — the version-exact docs
  ship in the payload; for source-level questions, shallow-clone the pinned tag — see
  `docs/protocol-pi/README.md` and the ADR-026 standing constraint added for pi).
- **Approvals & autonomy (ADR-022 parity, as an evaluator not a ruleset):** a per-session
  `PiBridgeHost` (loopback HTTP, per-spawn bearer token compared timing-safe) receives the
  extension's `tool_call` POSTs and runs a **pure `permission-engine`** — severity precedence
  deny > hosted-auto-allow > ask > allow over the user's merged user/project/local **Claude**
  permission rules (bare-tool + Bash prefix/exact matchers; path-glob deferred), then
  session-allows, then the autonomy-mode base (`ask`/`autoEdit`/`full`). The **same `~/.claude`
  settings rules govern pi, Claude, and opencode** — the "one config, all harnesses" requirement.
  'ask' surfaces the standard `session:approval-request`; "always allow" persists to the shared
  Claude store via the same `permission-compiler` helpers opencode uses. The injected extension
  file under `os.tmpdir()` is **content-verified against the compiled source on every spawn**
  (rewrite on any mismatch) — write-if-absent alone left a preplant window on world-writable
  POSIX `/tmp`.
- **Interaction parity (ADR-024):** mid-turn `steer`, thinking levels → the effort picker
  (`set_thinking_level`, gated on the model's catalog `reasoning` flag), slash-command + skill
  discovery (`get_commands`), and live bash-output streaming (reusing opencode's `BashStreamGate`).
- **Auth (ADR-021):** `PiAuthProvider` reads/writes pi-owned `~/.pi/agent/auth.json` (the one
  sanctioned `~/.pi` write — a byte-preserving api_key merge). OAuth `/login` is TUI-interactive and
  **not** driven from ClaudeUI (`canDriveLogin:false`); the Settings › pi › Providers section shows
  a "run /login in a terminal" hint with the copyable vendored binary path plus in-app API-key CRUD.
- **Shared skills:** the bridge extension's `resources_discover` hook returns the existing
  `~/.claude/skills` + `<cwd>/.claude/skills` dirs (computed main-side, passed via env), so pi
  surfaces Claude skills through the same `session:skills` wiring.
- **Hosted tools (ADR-007/019 parity):** `render_mermaid`/`create_mockup`/`show_mockup` registered
  via `pi.registerTool()` over a second `PiBridgeHost` route (`/hosted-tool`), delegating to the
  SAME `mermaid-tool.ts`/`mockup-tool.ts` handlers Claude and opencode reuse. Auto-allowed by the
  permission-engine (parity with Claude's `mcp__claude-ui__` prefix). Execution requires a
  **one-shot grant** (`toolCallId → toolName`) minted by the `tool_call` gate on 'allow' and
  consumed by `/hosted-tool` — the bearer token alone must not authorize execution, since it sits
  in the pi child's env where any already-approved bash command could replay it to bypass
  `dispatch_agent`'s deliberate 'ask' gating.
- **Cross-engine dispatch (ADR-033/034), both directions:**
  - **Source:** a pi session's `dispatch_agent` (registered like the hosted tools, but normally
    gated) builds the engine-neutral `DispatchContext` and calls the existing `crossEngineDispatcher`
    — no dispatcher change; streaming/approvals/usage/stop ride the engine-generic pipeline.
  - **Target:** a `PiTargetEntry` mirroring the Claude target (persistent headless `PiRpcClient` +
    own `PiBridgeHost` for two-stage approval forwarding). Two documented divergences from the
    Claude target: pi has no async-iterator (a settle-promise resolver is installed before the
    prompt), and pi's `abort` is turn-scoped not process-killing (targets survive for continuation,
    like opencode). Recursion is structurally impossible — a target's child env **explicitly
    overrides** the hosted-tools/dispatch enable flags to `''` (omission alone would inherit the
    parent process env through the spawn merge), and the target's bridge host has no hosted-tool
    handler, so even a stray-registered tool fails closed. Spend from errored/timed-out/stopped
    target turns still counts toward the cost cap and the dispatching session's breakdown (the cap
    is a spend limit, not a success limit — same rule as the Claude target).
- **Plan mode (M5a):** pi has no native plan mode — ClaudeUI builds it as extension-enforced
  read-only autonomy, patterned on pi's shipped `examples/extensions/plan-mode/`. The bridge
  extension toggles pi's own active-tool set via `pi.setActiveTools()` on
  `/cui-plan-enter`/`/cui-plan-exit` commands (sent over the normal RPC `prompt` channel — extension
  commands execute immediately, even mid-turn), drops `edit`/`write`, and exposes a locally-executed
  `exit_plan` tool only while planning (registered tools auto-activate, so a `session_start` handler
  hides it otherwise). The permission-engine's `'plan'` mode base is the second enforcement layer:
  mutating kinds deny, bash passes only a per-segment read-only allowlist (every chained segment
  must match; substitution constructs deny; network commands excluded — a plan-mode bash allow is
  an auto-allow with no human gate), and `exit_plan` asks — surfacing the same engine-neutral
  ExitPlanModeCard/Shift+Tab cycle Claude uses (kind `'plan'` in the tool registry).
- **In-pi subagents (M5b):** a SECOND ClaudeUI-owned `-e` extension (`pi-subagent-source.ts`,
  content-verified tmp file like the bridge; this one imports node builtins — allowed, probed)
  ports pi's shipped subagent example to v1 scope: user-level agent `.md` discovery
  (`~/.pi/agent/agents`), single + parallel tasks, children spawned as
  `pi --mode json -p --no-session` with NO extensions of their own (recursion structurally
  absent). Child progress streams through the registered tool's `onUpdate` `details`
  (`cuiSubagent` v1 contract: per-agent status + DELTA messages + usage), which surfaces verbatim
  on RPC `tool_execution_update.partialResult` (probed); PiSession maps it onto the same
  `session:subagent-*` payloads the dispatch target emits, so TaskCard renders both identically.
  One usage row per agent with account attribution; parent totals untouched. The `subagent` tool
  itself is gated as kind `'task'` (ask/allow/deny by mode) — children then run their agent-def
  toolset ungated, the same two-stage trust posture as the M4c dispatch target, safe because
  agent defs are user-authored files the model cannot write through this tool.
- **Capability honesty (ADR-030):** flags flipped only as each end-to-end path shipped and was
  live-verified: M1 `queue`; M2 `steer`/`interactiveApprovals`/`autonomyModes`/`slashCommands`/
  `skills`; M4 `hostedMcp`/`crossEngineDispatch` (the latter ANDed per-session with
  `crossEngineDispatchAvailable('pi')`); M5a `plan` (+ `'plan'` in `autonomyModes`); M5b
  `subagents`. `fork`, `backgroundTasks`, `voice`, `sandbox`, `proxy`, `sideQuestion`,
  `multiAccount`, `canDriveLogin` remain false (unwired or N/A).

## Consequences

- New `src/main/pi/` (PiRpcClient, PiSession, event-mapper, model-discovery, pi-spawn-prep,
  pi-locate, pi-protocol, PiBridgeHost, pi-bridge-source, permission-engine) + `PiAuthProvider` +
  `pi-session-list` + `PiEngineToolMap` + the engine registration surfaces keyed off the `EngineId`
  union: three genuinely compile-enforced tables (engine-meta, engine-tool-maps, EngineLogo — each
  `satisfies Record<EngineId, …>`), plus two that are convention-only and fail silently for a future
  engine #4: the per-engine capability consts in model-capabilities (no exhaustive table) and the
  db.ts engine-id string allowlists (unknown ids clamp to `'claude'` — guarded by tests, not types).
  The `ISession` seam,
  `crossEngineDispatcher`, and the renderer's `session:*`/subagent/task pipeline were untouched
  except for additive pi branches; Claude and opencode behavior is byte-identical.
- Persistence: `session_meta`/`usage_event` rows carry `'pi'` (db allowlists extended); sessions are
  read from pi's own JSONL trees under `~/.pi/agent/sessions` (active-branch walk), deleted via the
  ADR-025 dispatcher.
- Maintenance: `piCliVersion` + the wire smoke/integration tests move together; a bump re-runs the
  gated `PI_INTEGRATION_TESTS` suite (real binary). Wire questions consult `docs/protocol-pi/` then a
  shallow checkout of the pinned tag — never a vendored source clone.

## Relation to existing ADRs

- Implements the engine model of **ADR-018**; is the third concrete backend after **ADR-019**
  (opencode), which it uses as the structural template while diverging on transport (RPC stdio vs
  HTTP/SSE) and gating (evaluator vs patched ruleset).
- Auth per **ADR-021**; permission semantics per **ADR-022**; interaction parity per **ADR-024**;
  delete per **ADR-025**; capability honesty per **ADR-030**; cross-engine dispatch + cost per
  **ADR-033/034**; hosted-tool rendering via the neutral ToolKind registry.
- Built via the **ADR-026** workflow (Opus orchestrates + reviews every line; Sonnet implements;
  gates + real-app verification before each commit).
