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
  `PiBridgeHost` (loopback HTTP, per-spawn bearer token) receives the extension's `tool_call` POSTs
  and runs a **pure `permission-engine`** — severity precedence deny > hosted-auto-allow > ask >
  allow over the user's merged user/project/local **Claude** permission rules (bare-tool + Bash
  prefix/exact matchers; path-glob deferred), then session-allows, then the autonomy-mode base
  (`ask`/`autoEdit`/`full`). The **same `~/.claude` settings rules govern pi, Claude, and opencode**
  — the "one config, all harnesses" requirement. 'ask' surfaces the standard
  `session:approval-request`; "always allow" persists to the shared Claude store via the same
  `permission-compiler` helpers opencode uses.
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
  permission-engine (parity with Claude's `mcp__claude-ui__` prefix).
- **Cross-engine dispatch (ADR-033/034), both directions:**
  - **Source:** a pi session's `dispatch_agent` (registered like the hosted tools, but normally
    gated) builds the engine-neutral `DispatchContext` and calls the existing `crossEngineDispatcher`
    — no dispatcher change; streaming/approvals/usage/stop ride the engine-generic pipeline.
  - **Target:** a `PiTargetEntry` mirroring the Claude target (persistent headless `PiRpcClient` +
    own `PiBridgeHost` for two-stage approval forwarding). Two documented divergences from the
    Claude target: pi has no async-iterator (a settle-promise resolver is installed before the
    prompt), and pi's `abort` is turn-scoped not process-killing (targets survive for continuation,
    like opencode). Recursion is structurally impossible — a target's child env omits the
    hosted-tools/dispatch enable flags, so it has no `dispatch_agent` tool.
- **Capability honesty (ADR-030):** flags flipped only as each end-to-end path shipped and was
  live-verified: M1 `queue`; M2 `steer`/`interactiveApprovals`/`autonomyModes`/`slashCommands`/
  `skills`; M4 `hostedMcp`/`crossEngineDispatch` (the latter ANDed per-session with
  `crossEngineDispatchAvailable('pi')`). `plan`, `fork`, `subagents`, `backgroundTasks`, `voice`,
  `sandbox`, `proxy`, `sideQuestion`, `multiAccount`, `canDriveLogin` remain false (unwired or N/A).

## Consequences

- New `src/main/pi/` (PiRpcClient, PiSession, event-mapper, model-discovery, pi-spawn-prep,
  pi-locate, pi-protocol, PiBridgeHost, pi-bridge-source, permission-engine) + `PiAuthProvider` +
  `pi-session-list` + `PiEngineToolMap` + the five compile-enforced engine tables (EngineId union,
  engine-meta, model-capabilities, engine-tool-maps, EngineLogo). The `ISession` seam,
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
