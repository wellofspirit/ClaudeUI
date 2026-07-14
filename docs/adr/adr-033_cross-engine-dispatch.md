# ADR-033: Cross-engine agent dispatch — hosted `dispatch_agent` tool, headless subtask-style targets

**Status:** Accepted
**Date:** 2026-07-14
**Relates to:** ADR-018/019 (engine model), ADR-020 (config plane), ADR-022/023 (opencode permissions), ADR-026 (workflow), ADR-030 (capability honesty), ADR-032 (non-fatal denials)

## Context

ClaudeUI now runs two engines (Claude, opencode) fronting different model vendors. We want a session
on either engine to delegate a task to an agent on the *other* engine — e.g. a Claude session asks a
GPT-5-backed opencode agent to review a diff — with the same UX as a native subtask: a task card in
the dispatching chat, approvals surfacing in the dispatching session, no separate session to manage.

Both engines already consume ClaudeUI-hosted MCP tools: Claude via in-process SDK MCP servers
(`mcpServers` option in `claude-session.ts`), opencode via the `claudeui` HTTP-MCP host injected
through `OPENCODE_CONFIG_CONTENT` (ADR-019). The subagent/TaskCard rendering pipeline
(`session:subagent-*`, `session:task-*`) is engine-neutral.

De-risked against opencode v1.17.14 source (pinned clone in git-ignored `vendor/opencode-src/`):

- **Abort propagates end-to-end**: session abort → Effect interrupt → turn `AbortController` →
  AI SDK `abortSignal` → `client.callTool({signal})`. In-flight MCP calls are cancelled.
- **opencode natively permission-gates MCP tools**: every MCP tool execution runs
  `ctx.ask({permission: '<server>_<tool>'})` against the merged ruleset (last-match-wins wildcards,
  default `ask`). Our `{*: allow}` baseline is why hosted tools run silently — gating the dispatch
  tool is one appended rule in the ruleset we already `PATCH`.
- **Deny is survivable**: opencode's default kills the turn on a bare reject, but ClaudeUI already
  ships `experimental.continue_loop_on_deny: true` and always rejects with a message
  (→ `CorrectedError`, inherently non-fatal) — ADR-032. Caveat: one reject cascades bare
  auto-rejects to all other pending asks in that session; the forwarding layer must reconcile on
  `permission.replied` events.
- **Timeout**: opencode's `callTool` timeout (per-server config ?? 60s SDK default) resets on
  progress notifications (`resetTimeoutOnProgress: true`).

## Decision

1. **One symmetric tool, `dispatch_agent({ engine, prompt, model?, session_id? })`**, hosted by
   ClaudeUI and injected into both engines. Returns the target's final text plus a `session_id`;
   passing `session_id` back continues the same target (multi-turn collaboration without new
   transport). Registration:
   - Claude: a **separate** in-process server (`claude-ui-collab`) so it does **not** ride the
     auto-allowed `mcp__claude-ui__` prefix — it goes through `canUseTool` like an ordinary tool.
   - opencode: registered on the existing `claudeui` hosted server (appears as
     `claudeui_dispatch_agent`), gated by an appended `ask` rule in the session ruleset.
2. **A single main-process `CrossEngineDispatcher` service** owns all dispatch logic: target
   creation, guards (concurrency cap, per-dispatch timeout, model allowlist), approval forwarding,
   result await, cancellation. Both engines' tool registrations delegate to it.
3. **Targets are headless dispatcher-owned mini-sessions built on engine client primitives, not
   `SessionManager`/`ISession`**: opencode targets use `OpencodeClient` directly (create session →
   patch ruleset → synchronous `POST /session/{id}/message` — the `askSideQuestion`/judge
   precedent); Claude targets use `sdkQuery()` directly (the `service-session.ts` precedent) with a
   `canUseTool` callback. No sidebar entry, no renderer session, no rekey/lifecycle coupling.
4. **Recursion is structurally impossible**: dispatcher-created targets never get the collab server
   registered (and opencode targets additionally get a deny rule for `claudeui_dispatch_agent*`).
   No depth counters. The tool is main-agent-only by policy; Claude-native subagents share the
   parent's MCP channel, so enforcement there is best-effort v1 (documented limitation).
5. **Subtask-identical UX**: the target inherits the dispatcher's autonomy mode (mapped through the
   ADR-022 `buildRuleset` for opencode; permission mode for Claude — auto-mode judge is *not*
   spun up for targets in v1, `full` maps to allow-all). Target approval requests are re-emitted as
   `session:approval-request` under the **dispatching** session's routing with a reserved requestId
   prefix (`xeng:`); the approve IPC handler routes that prefix to the dispatcher instead of the
   session. Output streams into the dispatching chat through the existing
   `session:subagent-*`/`session:task-*` events keyed by the dispatching `toolUseId` (TaskCard
   renders it; engine badge added).
6. **Config (plane ③, ADR-020)**: `engines/<engineId>.json` gains
   `dispatch?: { allowedModels?: string[]; defaultModel?: string }` governing dispatches **into**
   that engine, edited in a per-engine SettingsDialog section (Engines › Claude / Engines ›
   opencode).
7. **Long-call survival**: `create-sdk-mcp.ts` threads the MCP SDK `extra` parameter
   (cancellation `signal`, `sendNotification`) through to tool handlers — backward-compatible; the
   dispatch tool sends progress heartbeats (resets opencode's timeout, feeds TaskCard progress) and
   observes `extra.signal` to interrupt the target. The injected `mcp.claudeui` block also sets an
   explicit generous `timeout`.

## Consequences

- New `src/main/services/cross-engine-dispatcher.ts` (+ tool registrations in `claude-session.ts`
  and `opencode-hosted-tools.ts`); `SessionManager` stays untouched.
- `create-sdk-mcp.ts` handler signature gains an optional second `extra` argument; existing tools
  (mermaid/mockup/auto-classifier) unaffected.
- Approval IPC gains prefix routing; renderer approval UI unchanged in v1 (approvals appear as
  ordinary tool approvals on the dispatching session).
- Dispatched turns consume tokens on the target engine's active account — usage attribution
  (ADR-011) follows in a hardening phase, before which dispatched usage is attributed like
  side-questions (i.e. not itemized).
- Per ADR-030, a `crossEngineDispatch` capability flag is only set true for an engine once the full
  path (tool visible → gated → dispatch → stream → result) works end-to-end for that engine.

## M2–M4 — decisions + full plan

Full standalone implementation plan (M2 reverse direction, M3 streaming UX, M4 usage/capability/
hardening): **`docs/v2/cross-engine-dispatch-implementation-plan.md`**.

- **Caller-session identity on the shared opencode MCP host** — RESOLVED: a ClaudeUI-provided
  opencode **plugin** stamps the caller `sessionID` into the dispatch tool's args via
  `tool.execute.before` (deterministic; opencode passes `args` by reference before `execute`, so
  the mutation reaches our MCP handler — `vendor/opencode-src/.../session/tools.ts:402-409`).
  Chosen over FIFO temporal correlation off `permission.asked` (racy across concurrent same-cwd
  sessions) and over fixed-mode/no-forwarding (breaks subtask parity). #1 de-risk for M2 is
  confirming local-file plugin loading via `OPENCODE_CONFIG_CONTENT`.

## Still-open questions

- Whether cli.js imposes a timeout on in-process (`mcp_message`) tool calls — verify and, if so,
  mitigate via env or heartbeats. (Not observed in M1's short dispatches; matters for long
  Claude-target turns in M2.)
