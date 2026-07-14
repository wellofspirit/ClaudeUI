# M2 kickoff — cross-engine dispatch, reverse direction (opencode → Claude)

**Status:** not started. This is a standalone handoff spec — a fresh session with no prior
context should be able to execute it. Governing design: **ADR-033**
(`docs/adr/adr-033_cross-engine-dispatch.md`). Workflow: **ADR-026** (Opus orchestrates + reviews
every line, a Sonnet sub-agent implements, gates + real-app verify before commit).

## Where M1 left things (already shipped, on `pre-release`)

M1 delivered the **Claude → opencode** direction. Commits: ADR-033 doc, SDK `extra` threading,
dispatcher core + `dispatch_agent` tool, opencode dispatch settings section, turn-error fix.
Verified live end-to-end (Haiku dispatched to `opencode/nemotron-3-ultra-free`, got a real answer
back through the approval-gated tool). Key existing pieces M2 builds on:

- **`src/main/services/cross-engine-dispatcher.ts`** — `CrossEngineDispatcher` + `crossEngineDispatcher`
  singleton. Currently handles **opencode targets only**: `dispatchInner` has
  `if (req.engine !== 'opencode') return errorResult('… not supported yet')`. Structure to reuse:
  guards → `activeDispatches++` → `resolveAndRun` (model resolution, target create/reuse, the
  timeout/abort/heartbeat race, result extraction, `info.error` surfacing). Approval forwarding: an
  unfiltered per-cwd SSE loop maps opencode `permission.asked` → `xeng:`-prefixed `PendingApproval`
  emitted on the dispatching session; `resolveApproval(requestId, …)` consumes `xeng:`-prefixed ids
  and calls opencode `replyPermission`. `disposeFor(routingId)` tears down a dispatching session's
  targets. Target registry keyed by opencode session id, scoped to `fromRoutingId`.
- **`src/main/services/collab-tool.ts`** — `createCollabServer(ctx)` hosts `dispatch_agent` on the
  Claude-side `claude-ui-collab` MCP server. Tool arg is `engine: z.enum(['opencode'])` — **M2 must
  widen this** (see M2-D). Delegates to `crossEngineDispatcher.dispatch`, threads `extra`.
- **`src/main/services/__tests__/cross-engine-dispatcher.component.test.ts`** — 32 tests; the fake
  client + fake SSE patterns here are the template for M2 tests.
- **`DispatchContext`** = `{ fromEngine, fromRoutingId, cwd, autonomyMode, emit, extra? }`.
  `DispatchResult` = `{ text, sessionId, isError? }`.
- **`DispatchConfig`** (`src/shared/types.ts`) = `{ allowedModels?, defaultModel? }` on
  `EngineConfig.dispatch`. Read per-dispatch via `loadEngineConfig(req.engine).dispatch`. So the
  Claude direction automatically reads `engines/claude.json`'s `dispatch` block — no dispatcher
  change needed for config sourcing.
- **IPC**: `session:approval-response` in both `session.ipc.ts` and `remote-handlers.ts` already
  routes `XENG_REQUEST_PREFIX` ids to `crossEngineDispatcher.resolveApproval` before the session.
- **`session:approval-dismiss`** channel is wired end-to-end (preload, web adapter, useClaudeEvents
  → `removePendingApproval`).
- **SDK `extra`** (`src/main/sdk/create-sdk-mcp.ts`): tool handlers get `(input, extra?)` with
  `signal` + `sendProgress(extra, …)`. opencode-hosted tools get this too.

## Goal

An **opencode** session calls `claudeui_dispatch_agent` (engine `"claude"`) → dispatcher spawns a
**headless Claude target**, runs a turn, returns the final text (+ a `session_id` for continuation).
Subtask parity per the M1 decisions: **the Claude target inherits the calling opencode session's
autonomy mode, and the target's tool-approval requests forward into that opencode session's chat.**

## The load-bearing decision (RESOLVED): caller identity via an opencode plugin

The `claudeui` hosted MCP server is **per-cwd**, shared by all opencode sessions in that folder, and
an MCP tool call carries no session id. opencode's `permission.asked` for MCP tools has **empty
metadata** (verified: `vendor/opencode-src/packages/opencode/src/session/tools.ts:408`), so there is
no natural join key between the HTTP MCP call and the calling session.

**Chosen mechanism: a tiny ClaudeUI-provided opencode plugin that stamps the caller `sessionID`
into the dispatch tool's args in-band.** opencode fires `plugin.trigger("tool.execute.before",
{tool, sessionID, callID}, {args})` immediately before running an MCP tool's `execute`, passing the
**same `args` object by reference** (`tools.ts:402-409`); a plugin that mutates `args` has its
change flow through `execute` → `client.callTool({arguments: args})` → our MCP handler.
Deterministic, race-free. (Rejected alternatives: FIFO temporal correlation off `permission.asked`
— racy across concurrent same-cwd sessions; fixed-mode-no-forwarding — breaks subtask parity.)

## Slices (each = one ADR-026 loop: written kickoff → Sonnet implements → Opus reviews every line
→ gates → real-app verify → precise commit)

### M2-A — Claude headless target in the dispatcher

Add an `engine === 'claude'` path to `dispatchInner`/`resolveAndRun`. Unlike opencode (clean
synchronous `client.prompt()` + throwaway session), a Claude turn is **streaming** via
`sdkQuery()` — this is the bulk of M2's work.

- **Spawn**: raw `sdkQuery({ prompt, options })` (the `src/main/services/service-session.ts`
  precedent — do NOT use `SessionManager`/`ISession`; the dispatcher owns this process directly, no
  `BrowserWindow`). Needed options: `cwd` (dispatcher cwd), `canUseTool` (M2-B forwarding),
  `abortController`, `getSdkExecutableOpts()`, a permission mode mapped from the inherited autonomy,
  model env. Drive `for await (const msg of q)` and resolve on the `result` message
  (`msg.type === 'result'`, final text in `msg.result` — `src/main/sdk/types.ts` `ResultMessage`).
- **Model resolution**: Claude models are **alias strings** (`haiku`, `sonnet`, …), NOT opencode's
  `providerID/modelID`. `loadEngineConfig('claude').dispatch` supplies allowlist/default (same code
  path). **Verify/handle**: model/endpoint/proxy env must be applied for the spawn — Claude's normal
  path runs `spawnPrepRegistry.require('claude').prep(model, engineCfg)` in
  `src/main/ipc/create-session.ts`. The dispatcher needs the equivalent (getModelEnv / model-env)
  applied to the `sdkQuery` `env` overlay. Flag: factor a reusable helper rather than duplicating
  create-session logic.
- **Continuation**: `session_id` = Claude session UUID from the `system/init` event. Keep the
  process alive across turns (persistent `MessageChannel` prompt, like `ClaudeSession`), OR use
  `--resume-session-id` for a fresh process per continuation turn — pick the simpler that works;
  document the choice.
- **Guards reuse**: same `activeDispatches` cap, per-dispatch timeout, `extra.signal` abort race,
  `sendProgress` heartbeats. Abort → `abortController.abort()`.
- **Recursion guard**: the Claude target must NOT get the `claude-ui-collab` server (structural — a
  dispatched Claude agent can't dispatch again). Since the dispatcher spawns it via raw `sdkQuery`
  and controls the options, simply don't register the collab server for it.

### M2-B — caller-identity plugin + approval forwarding for Claude targets

1. **Ship the opencode plugin.** Small JS module hooking `tool.execute.before`; for
   `tool === 'claudeui_dispatch_agent'` set `args.__xeng_caller_session = input.sessionID`.
   **Verify from source first** (`vendor/opencode-src/packages/opencode/src/plugin/` +
   the config schema `src/shared/opencode-config-schema.1.17.14.json`): the exact plugin module
   shape/exported hook names, and **how a plugin is registered** — the `plugin` config key, and
   whether a **local file path** loads (vs an npm package). Wire it through the existing
   `OPENCODE_CONFIG_CONTENT` builder (`src/main/opencode/OpencodeServerManager.ts`
   `buildOpencodeConfigContent`). If local-path plugins don't load cleanly, fall back is documented
   in ADR-033 (temporal correlation) — but confirm before switching.
2. **MCP handler reads identity.** In the opencode hosted `dispatch_agent` handler (M2-D), read and
   strip `args.__xeng_caller_session`; look up the live `OpencodeSession` via `SessionManager` (by
   routingId == that session id, after rekey) to get its **permission mode** (for `autonomyMode`)
   and its **`send`** (for `emit`). Build the `DispatchContext` from those. If the session isn't
   found (or the id is absent — plugin didn't fire), return an `isError` explaining dispatch needs
   the plugin (fail loud, don't silently misroute).
3. **Gate the dispatch tool on the opencode side.** Today MCP tools run under the `{*: allow}`
   baseline (permission-compiler skips `mcp__`), so `claudeui_dispatch_agent` would run **without**
   a prompt. To gate it (the dispatch itself should be user-approved, per ADR-033), append an `ask`
   rule for the tool to the calling session's ruleset. `buildRuleset` is exported from
   `OpencodeSession.ts` (M1). Decide where the rule lives (likely: OpencodeSession appends
   `{ permission: 'claudeui_dispatch_agent', pattern: '*', action: 'ask' }` when building its
   ruleset) — this makes opencode raise a **normal** `permission.asked` that OpencodeSession's
   existing path shows in that session's own chat. No forwarding needed for the dispatch approval
   itself (the opencode session IS the visible dispatching session).
4. **Forward the Claude target's approvals.** The target's `canUseTool` (M2-A) → build a
   `PendingApproval` with an `xeng:` requestId → `emit('session:approval-request', approval)` on the
   calling OpencodeSession's `send` (shows in its chat). Resolution comes back through the existing
   `xeng:` IPC routing → `crossEngineDispatcher.resolveApproval`. **M1's `resolveApproval` maps
   only to opencode `replyPermission`** — M2 must make it distinguish target type: a Claude-target
   forwarded approval resolves the target's `canUseTool` promise (`{behavior:'allow'|'deny', …}`)
   instead. Track pending approvals with their target kind. Reuse `session:approval-dismiss` for
   timeout/abort/dispose.

### M2-C — Claude-side dispatch settings section (the deferred twin)

Mirror `OpencodeDispatchSection` (`settings-sections.tsx`) for engine `'claude'`: default model +
allowlist, models from `getEngineModels()` filtered `engineId === 'claude'`, saving the `dispatch`
block of `engines/claude.json` via `saveEngineConfig('claude', …)`. Register under **Engines ›
Claude** (`ENGINE_CLAUDE_SECTION_IDS` + the `claude-engine` subgroup). testids per ADR-027
(`ClaudeDispatchSection`, `.defaultModel`, `.allowedModel` + `data-id`). Update
`settings-scopes.unit.test.tsx` expectations. Component test asserting the merged save doesn't
clobber sibling Claude engine config (`sandbox`/`proxy`).

### M2-D — widen the tool + register on opencode

- `collab-tool.ts`: widen `engine` enum to `z.enum(['opencode', 'claude'])` and update the tool
  description to explain both targets. (This server runs inside *Claude* sessions; a Claude session
  targeting `'claude'` is same-engine and already rejected by the dispatcher's guard — fine.)
- `src/main/opencode/opencode-hosted-tools.ts` `createOpencodeHostedToolsServer(cwd)`: register a
  `dispatch_agent` tool (opencode will expose it as `claudeui_dispatch_agent`). It needs a
  dispatcher reference and the caller-identity handling (M2-B.2). **This factory currently closes
  over `cwd` only** — thread whatever it needs (the dispatcher singleton is import-accessible;
  identity comes from args). Tool `engine` enum here is `['claude']`.

## Risks to verify EARLY (before deep implementation)

1. **opencode local-file plugin loading** via `OPENCODE_CONFIG_CONTENT` — the whole M2-B mechanism
   depends on it. Probe against the vendored binary if source is ambiguous (per the "probe cli/wire
   first" project convention). This is the #1 de-risk.
2. **Claude headless target env** — model/endpoint/proxy env application outside the
   SessionManager/create-session path. Confirm `getSdkExecutableOpts()` + model-env give a working
   spawn; the free/aliased model must actually load (recall the model-discovery bootstrap gate:
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is force-set on spawns).
3. **`canUseTool` on a raw `sdkQuery`** — confirm the callback fires and its
   `{behavior, updatedInput}` contract works headless (it does for ClaudeSession; verify for the
   bare-query path). `context.signal` is a real AbortSignal.

## Testing + verification

- Component tests mirroring the M1 dispatcher tests: Claude-target happy path (fake sdkQuery
  yielding assistant + result), timeout/abort, model allowlist, mode inheritance, approval
  forwarding both directions of resolution (allow/deny → canUseTool result), unknown-caller isError.
- Plugin unit test: `tool.execute.before` for the dispatch tool injects the id; other tools
  untouched.
- Gates: `bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`.
- **Real-app E2E** (verifier-electron): drive an **opencode** session, have it call
  `dispatch_agent` (engine claude, a cheap model e.g. `haiku`), approve the dispatch in the opencode
  chat, confirm the Claude target's answer returns. Reuse the M1 drive-script pattern
  (Playwright `_electron`, read the transcript JSONL for the tool result). Note opencode sessions
  can't be created via the OS folder picker under Playwright — reach an existing opencode session
  via the sidebar (they exist in the operational DB; filter `engine_id='opencode'`).

## After M2

M3 = TaskCard streaming/badge UX for dispatched turns (both directions); M4 = usage/cost
attribution (ADR-011) for dispatched turns + the `crossEngineDispatch` capability flag (ADR-030,
set true per engine only once its full path works). Both tracked in ADR-033.
