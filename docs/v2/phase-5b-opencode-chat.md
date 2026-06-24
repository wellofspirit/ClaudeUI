# Phase 5b — opencode chat MVP (session + event mapper + model picker + approvals)

> Second of the Phase 5 split (5a infra ✅ → **5b chat MVP** → 5c auth/MCP). Implements the
> milestone of [ADR-019](../adr/adr-019_opencode-engine-backend.md) + the implementation plan:
> **an opencode session chats, renders tools, and handles approvals**, consuming the same
> engine-neutral `session:*` IPC contract Claude uses. Builds on 5a's `OpencodeServerManager` +
> `OpencodeClient`. **Claude is untouched and must stay behavior-preserving.**

This spec is authoritative — every wire shape below was **captured from the real opencode 1.17.9
binary** during scoping (not theorized). Build on these; don't re-discover.

---

## Verified facts (ground-truth from the 1.17.9 binary — build on these)

### Transport / lifecycle (from 5a, already built)
- `OpencodeServerManager.acquire(cwd)` → `{ baseUrl, password, authHeader }` (HTTP Basic
  `opencode:<password>`), shared + ref-counted per normalized cwd. `release(cwd)` decrements;
  last-out kills. `OpencodeClient(baseUrl, authHeader)` wraps the v1 HTTP+SSE endpoints.
- **The free OpenCode-Zen provider works with ZERO credentials.** `GET /config/providers` with no
  auth returns exactly one provider `opencode` with models `mimo-v2.5-free`, `nemotron-3-ultra-free`,
  `deepseek-v4-flash-free`, `north-mini-code-free`, `big-pickle` (default). **This is the smoke
  model** — verify a full turn end-to-end without 5c auth.

### Session ops (v1 paths — NOT `/api/*`)
- `POST /session` `{title?}` → `Session {id: 'ses_…', …}`.
- `POST /session/{id}/prompt_async` `{model:{providerID,modelID}, agent?, system?, tools?, parts:[…]}`
  → fire-and-forget; results stream via `GET /event`. **Use this** (matches ClaudeUI's
  fire-and-forget `session:send`). `parts`: `{type:'text', text}` and `{type:'file', mime, url}`.
  (`POST /session/{id}/message` is the *synchronous* variant — returns the final `{info,parts[]}`;
  do NOT use it for the live turn, only as a fallback if `prompt_async` misbehaves.)
- `POST /session/{id}/abort` → interrupt the current turn.
- `POST /session/{id}/fork` `{messageID?}` → branch.
- `PATCH /session/{id}` `{permission?: PermissionRuleset, title?}` — **per-session** permission. The
  `Session` object also carries per-session `agent` + `model`. This is how autonomy mode is applied
  WITHOUT touching the shared server (no cross-session conflict). `PermissionRuleset` =
  `[{permission: string, pattern: string, action: 'allow'|'deny'|'ask'}]`.

### SSE event shapes (`GET /event`, parsed by `OpencodeClient.subscribeEvents()`)
The shared server's `/event` stream carries events for **all** sessions in that cwd — **filter every
event by `properties.sessionID === this.openSessionId`.**

- `message.part.updated` — `{properties:{sessionID, part, time}}`. **`part` is a snapshot; upsert by
  `part.id`.** Part variants observed:
  - `{type:'text', text, id:'prt_…', messageID, sessionID, time:{start,end}}`
  - `{type:'reasoning', text, id, messageID, sessionID, time}`  → maps to a `thinking` block
  - `{type:'tool', tool:'bash', callID:'call_…', state:{…}, id, messageID, sessionID}` where
    `state.status` ∈ `pending|running|completed|error`, `state.input` (tool args),
    `state.output` (string result), `state.metadata`, `state.title`, `state.time`.
  - `{type:'step-start', …}` / `{type:'step-finish', tokens:{…}, cost, …}` — turn/step markers
    (step-finish carries `tokens:{total,input,output,reasoning,cache:{read,write}}` + `cost`).
- `message.part.delta` — `{properties:{sessionID, messageID, partID, field:'text', delta:'…'}}` —
  **incremental streaming** for text/reasoning parts. Maps to `session:stream`.
- `message.updated` — `{properties:{info}}` where `info` is the full message record (role, model,
  and after completion `tokens`/`cost`/`finish`). The assistant message id is `info.id` (`msg_…`).
- `session.status` — `{properties:{sessionID, status:{type:'busy'}}}` — busy/idle indicator.
- `session.idle` — `{properties:{sessionID}}` — **turn complete** → emit `session:result`, set idle.
- `permission.asked` — `{properties:{id:'per_…', sessionID, permission:string, patterns:string[],
  metadata:{}, always:string[], tool:{messageID, callID}}}`. `id` is the requestID; `tool.callID`
  binds it to the tool part. **Only fires when the session's permission action is `ask`.**
- Ignore for 5b: `catalog.updated`, `plugin.added`, `file.watcher.updated`, `session.diff`,
  `integration.updated`, `reference.updated`, `session.next.*` (use `session.idle` for completion).

### Approval reply
- `POST /permission/{requestID}/reply` `{reply: 'once'|'always'|'reject', message?}`. Map
  `ApprovalDecision`: `allow → 'once'`, `allowForSession → 'always'`, `deny → 'reject'`.

### Discovery
- `GET /config/providers` returns ONLY **configured/usable** providers (free `opencode` always; more
  appear as 5c adds auth) — `{providers:[{id, name, models:{<id>:Model}}], default}`. Each `Model`
  has `capabilities:{reasoning, attachment, toolcall, input:{text,image,…}}`, `limit:{context,output}`,
  `cost:{…}`. `GET /provider/auth` is the *auth-option catalog* (what you CAN configure) — that's a
  5c concern; **5b uses `/config/providers` for the picker.**

---

## Scope decisions (locked with the user)

1. **Full model-picker integration** (chosen). opencode vendors/models are discovered at runtime via
   a transient `opencode serve` (mirroring how Claude's `fetchModels` spawns a transient cli.js in
   `PERSISTED_SESSIONS_DIR`), merged into the existing model picker **grouped by engine/vendor**.
   Selecting an opencode model sets `engineId='opencode'` + the `ModelRef` and persists per-session.
2. **Approvals routed through ClaudeUI's UI** (chosen). The neutral autonomy mode maps to opencode:
   - `full` → per-session `permission` ruleset = **allow** (opencode's default) — no prompts.
   - `ask` → per-session `permission` ruleset = **ask** → opencode emits `permission.asked` →
     existing `FloatingApproval` UI → `POST /permission/{id}/reply`.
   - `plan` → switch session `agent` → opencode's read-only `plan` agent.
   - `autoEdit` is **not** offered (opencode `autonomyModes = [plan, ask, full]`; gated out).
   Applied per-session via `PATCH /session/{id}` (+ agent on prompt) — never global server config.
3. **prompt_async + SSE** for the live turn; completion on `session.idle`. (Not the sync `/message`.)
4. **Conservative engine capabilities for 5b** — only declare what's actually wired this phase
   (see step 3 caps). MCP/subagents/steer/queue/slash stay `false` until their phase, so the
   renderer doesn't surface non-functional affordances.
5. **Basic tool→ToolKind map** — the full registry is Phase 6. For 5b, map opencode `tool` parts to
   `tool_use` + `tool_result` ContentBlocks; the existing generic `ToolCallBlock` renders them.

---

## File / seam map

**New (all under `src/main/opencode/` unless noted):**
- `OpencodeSession.ts` — extends `BaseSession`, implements `ISession`. The core deliverable.
- `event-mapper.ts` — pure functions: SSE `OpencodeEvent` → `{ChatMessage upserts, stream deltas,
  tool results, PendingApproval, completion}`. Unit-tested in isolation (no network).
- `tool-kinds.ts` — `opencodeToolKind(toolName): string` basic map (bash/read/edit/glob/grep/task…).
- `model-discovery.ts` — `discoverOpencodeModels(): Promise<EngineModelGroup[]>` — transient
  `serve` in `PERSISTED_SESSIONS_DIR`, `getConfigProviders()`, flatten, cache. Mirrors `fetchModels`.
- `__tests__/event-mapper.test.ts`, `__tests__/OpencodeSession.test.ts` — default-suite unit tests.

**Edited:**
- `src/shared/model-capabilities.ts` — add `OPENCODE_ENGINE_CAPABILITIES`, `opencodeModelCapabilities`,
  `resolveOpencodeCapabilities(model?)`. (VendorId is already open via `(string & {})` — no change.)
- `src/shared/types.ts` — extend `ModelInfo` with optional `engineId?: EngineId; vendorId?: VendorId;
  vision?: boolean; toolCalling?: boolean` (Claude entries default claude/anthropic). Add
  `EngineModelGroup { engineId; vendorId; vendorName; models: ModelInfo[] }`. Add `opencodeModel(
  vendorId, modelId): ModelRef`.
- `src/main/providers/register-engines.ts` — register the `'opencode'` factory.
- `src/main/ipc/session.ipc.ts` — (a) new `session:get-engine-models` handler returning
  `EngineModelGroup[]` (Claude group from `fetchModels` + opencode groups from `discoverOpencodeModels`);
  (b) in `session:create`, when `engineId==='opencode'` derive vendor/model from the model string and
  skip the Claude-only proxy/endpoint/model env (those are anthropic-specific). Keep Claude path
  identical.
- `src/main/opencode/OpencodeServerManager.ts` — **Windows tree-kill** in `release()`/`dispose()`
  (`taskkill /T /F /PID` on win32; `SIGTERM` elsewhere) to reap the opencode child tree.
- `src/preload/index.ts` + `src/shared/types.ts` ClaudeAPI — expose `getEngineModels()`.
- Renderer:
  - `src/components/shared/InlinePickers.tsx` (`ModelPicker`) — render grouped by engine/vendor.
  - `src/renderer/src/components/chat/InputBox/InputBox.tsx` — fetch via `getEngineModels()`, build
    grouped list; `handleSelectModel` carries engineId/vendorId; on opencode selection set
    `lastSelectedEngineId`/`selectedEngineId` + persist `ModelRef`.
  - `src/renderer/src/stores/session-store.ts` — `setSelectedModel` persists the right `ModelRef`
    (claude vs opencode); **fix the gap**: `loadHistoricalSession` must restore
    `selectedEngineId` from `sessionEngines[routingId]?.engineId` (currently hardcoded `'claude'`).
  - `src/components/shared/EngineToggle.tsx` — keep; selecting an opencode model implies the engine,
    but the toggle remains valid for new-session default.

---

## Step-by-step

### Step 1 — Capabilities (shared)
In `src/shared/model-capabilities.ts`:
- `OPENCODE_ENGINE_CAPABILITIES: EngineCapabilities` — **5b-conservative**:
  `voice:false, hostedMcp:false, backgroundTasks:false, subagents:false, plan:true, fork:true,
  forkFromMessage:true, steer:false, queue:false, slashCommands:false, skills:false,
  sideQuestion:false, interactiveApprovals:true, autonomyModes:['plan','ask','full'],
  auth:{canDriveLogin:true, multiAccount:false}`. Add a comment listing which flip true in 5c/6.
- `opencodeModelCapabilities(m?: {capabilities?, limit?, cost?}): ModelCapabilities`:
  `reasoning: {}` (no thinking/effort picker for opencode in 5b — opencode's reasoning is a per-model
  boolean, not a modes/levels control; note as a follow-up); `vision: !!(caps.attachment ||
  caps.input?.image)`; `toolCalling: !!caps.toolcall`; `contextWindow: limit?.context ?? 200000`;
  `maxOutput: limit?.output ?? 8192`; `promptCaching: !!cost?.cache`.
- `resolveOpencodeCapabilities(model?)` → `resolveCapabilities(OPENCODE_ENGINE_CAPABILITIES,
  opencodeModelCapabilities(model))`.

### Step 2 — Model discovery (main)
`src/main/opencode/model-discovery.ts`:
- `discoverOpencodeModels(): Promise<EngineModelGroup[]>` — `acquire(PERSISTED_SESSIONS_DIR)` (or a
  one-shot spawn), `client.getConfigProviders()`, for each provider build an `EngineModelGroup`
  `{engineId:'opencode', vendorId: provider.id, vendorName: provider.name, models: [...]}` where each
  model → `ModelInfo {value: \`${provider.id}/${modelId}\`, displayName: model.name, description,
  engineId:'opencode', vendorId: provider.id, vision, toolCalling, supportsEffort:false,
  supportsAdaptiveThinking:false}`. `release()` after. **Cache** the result (invalidate on auth
  change later). On any failure (binary missing, spawn fail) return `[]` — opencode is optional;
  Claude must not break.
- **value convention**: opencode picker value = `"<providerID>/<modelID>"`. This keeps the
  string-based `ISession.setModel(model)`/`session:create(model)` signatures intact; `OpencodeSession`
  parses `providerID/modelID`. `ModelRef` for opencode = `{engineId:'opencode', vendorId:providerID,
  modelId:modelID}` via `opencodeModel(providerID, modelID)`.

### Step 3 — `OpencodeSession` (main) — the core
`src/main/opencode/OpencodeSession.ts extends BaseSession`:
- Constructor mirrors `EngineSessionFactory` args (routingId, win, cwd, effort, resumeSessionId,
  permissionMode, model, sandboxConfig, thinkingMode, resumeSessionAt, forkSession). Store
  `model` (the `providerID/modelID` string; default to the free `opencode/big-pickle` or first
  discovered if absent), parse into `{providerID, modelID}`. `engineId = 'opencode'`.
  `capabilities = resolveOpencodeCapabilities(<discovered model caps if available>)` — for MVP it's
  acceptable to resolve from the model string alone (caps default sane); if the discovered caps are
  cached, use them.
- Fields: `conn: ServerConnection | null`, `client: OpencodeClient | null`, `openSessionId: string |
  null` (the `ses_…`), `sseAbort: AbortController | null`, `isProcessing`, `totalCostUsd`,
  `pendingApprovals: Map<requestId, …>`, a per-message accumulator for upsert-by-part-id.
- `run(prompt, attachments?)`:
  1. If no `conn`: `conn = await opencodeServerManager.acquire(this.cwd)`; `client = new
     OpencodeClient(conn.baseUrl, conn.authHeader)`.
  2. If no `openSessionId`: `const s = await client.createSession({title})`; `openSessionId = s.id`;
     **emit `session:status` with `sessionId = s.id`** → renderer rekeys routingId→ses_id; call this
     via the `status` getter + `sendStatus()` exactly like Claude.
  3. Start the SSE consumer if not running (see below) — **before** prompting so no events are missed.
  4. Apply autonomy mode: `await applyPermissionMode(this.permissionMode)` (PATCH session permission
     ruleset / agent — see step 4).
  5. Emit the user message + `session:status` running. `await client.promptAsync(openSessionId,
     {model:{providerID, modelID}, parts: [textPart, ...filePartsFromAttachments]})`. Map attachments
     → `{type:'file', mime: mediaType, url: 'data:<mediaType>;base64,<base64Data>'}` (verify opencode
     accepts data URLs during smoke; if not, fall back to text-only and log a warning).
- **SSE consumer** (`private async consumeEvents()`): `for await (const ev of
  client.subscribeEvents(this.sseAbort.signal))` — **skip if `ev.properties.sessionID !==
  this.openSessionId`** — then dispatch through `event-mapper`:
  - `message.part.delta` (field text) → `this.send('session:stream', {type: part.type==='reasoning'
    ? 'thinking' : 'text', text: delta})`.
  - `message.part.updated` → upsert the part into the current assistant `ChatMessage` (keyed by
    `info.id`/`messageID`; build `content[]` by upserting blocks keyed by part.id) and
    `this.send('session:message', msg)`. For `tool` parts: emit a `tool_use` block on first sight,
    and when `state.status` is `completed`/`error` emit `session:tool-result` `{toolUseId: callID,
    result: state.output ?? metadata.output, isError: status==='error'}`.
  - `message.updated` → capture `info.tokens`/`info.cost` → accumulate `totalCostUsd`; emit
    `session:status-line` (optional for MVP — at minimum keep `totalCostUsd` current for status).
  - `permission.asked` → build `PendingApproval {requestId: id, toolUseId: tool.callID, toolName:
    permission, input: metadata}`; store in `pendingApprovals`; `this.send('session:approval-request',
    approval)`.
  - `session.idle` → set `isProcessing=false`; `this.send('session:result', {totalCostUsd, durationMs,
    result:'', sessionId: openSessionId})`; `sendStatus()`.
  - `session.status {busy}` → optional; can drive `isProcessing` true.
- `interrupt()` → `client.abortSession(openSessionId)`.
- `resolveApproval(requestId, decision)` → map decision → `'once'|'always'|'reject'`, `POST
  /permission/{requestId}/reply`. Add a thin client method `replyPermission(requestId, reply)`
  (`POST /permission/{id}/reply {reply}`). Remove from `pendingApprovals`.
- `setModel(model)` → parse `providerID/modelID`; store; recompute `capabilities` (from cached
  discovery caps if available); `sendStatus()`. (opencode model is per-prompt, so no server call.)
- `setPermissionMode(mode)` → store; if `openSessionId` exists, `applyPermissionMode(mode)` now;
  `this.send('session:permission-mode', mode)`.
- `applyPermissionMode(mode)` (private): `full` → `PATCH /session/{id} {permission: [{permission:'*',
  pattern:'*', action:'allow'}]}`; `ask` → `action:'ask'`; `plan` → no permission change, set agent
  to `'plan'` on subsequent prompts (store `this.agent='plan'`, pass in prompt `agent` field; `build`
  otherwise). **Verify the `'*'` wildcard ruleset behaves during smoke**; if opencode wants per-tool
  keys, enumerate the common tools (bash, edit, read, write, glob, grep, list, task) with the chosen
  action. Add `client.patchSession(id, {permission})`.
- `cancel()` → `clearInactivityTimer()`, abort SSE, `release()`, idempotent. `sendStatus()`
  disconnected.
- `dispose()` → `cancel()` + drop refs.
- `getSessionId()` → `openSessionId`. `willQueue` → `false` for MVP (no queue cap).
- `status` getter → `{state, sessionId: openSessionId, model: this.model ? opencodeModel(providerID,
  modelID) : null, cwd, totalCostUsd, account: null /* 5c */, ...baseStatusFields()}`. `sendStatus()`
  → `send('session:status', this.status)`.

### Step 4 — register engine
`register-engines.ts`: `engineRegistry.register('opencode', (routingId, win, cwd, effort,
resumeSessionId, permissionMode, model, sandboxConfig, thinkingMode, resumeSessionAt, forkSession) =>
new OpencodeSession(...))`.

### Step 5 — IPC: model discovery + create wiring
- `session:get-engine-models` → `[claudeGroup, ...opencodeGroups]`. `claudeGroup = {engineId:'claude',
  vendorId:'anthropic', vendorName:'Anthropic', models: (await fetchModels()).map(tag claude/anthropic)}`.
  Wrap opencode discovery in try/catch → `[]` on failure. Expose `getEngineModels()` in preload +
  `ClaudeAPI`. (Keep the old `session:get-models` for back-compat / Claude-only callers.)
- `session:create`: when `engineId==='opencode'`, **skip** `applyProxyEnv`/`applyEndpointEnv`/
  `applyModelEnv` (anthropic-specific) — or guard them to claude. Pass `model` (the
  `providerID/modelID` string) through unchanged. Claude path must remain byte-identical.

### Step 6 — Windows tree-kill (ServerManager)
In `release()` (refCount→0) and `dispose()`: on `process.platform==='win32'`, spawn `taskkill /pid
<pid> /T /F` instead of `process.kill('SIGTERM')` (which orphans opencode's child tree on Windows).
Keep `SIGTERM` on posix. Guard against missing `process.pid`.

### Step 7 — renderer: grouped picker + engine threading
- `InputBox`: replace `getModels()` with `getEngineModels()`; flatten into a grouped structure for
  the picker (preserve `shortName` derivation). `selectedModel` reconciliation must match the new
  `value` (claude values unchanged; opencode = `providerID/modelID`).
- `ModelPicker` (InlinePickers): render section headers per group (`Claude · Anthropic`,
  `opencode · <vendor>`), options under each. On select, pass back the full entry (engineId/vendorId/
  value), not just the value string.
- `handleSelectModel(entry)`: `setSelectedModel(entry.value)`; set engine via existing
  `setLastSelectedEngineId(entry.engineId)` and the session's `selectedEngineId`; persist the right
  `ModelRef` (`entry.engineId==='opencode' ? opencodeModel(entry.vendorId, modelIdPart) :
  claudeModel(entry.value)`). For a running session, `window.api.setModel(activeSessionId,
  entry.value)` (the existing channel works — string passes through to `OpencodeSession.setModel`).
- `session-store.ts`: `setSelectedModel` persists the engine-correct `ModelRef`; **`loadHistoricalSession`
  restores `selectedEngineId` from `sessionEngines[routingId]?.engineId ?? 'claude'`** (the gap).

### Step 8 — tool kinds (basic)
`tool-kinds.ts`: `opencodeToolKind(name)` mapping bash→'bash', read→'read', edit/write→'edit',
glob/grep/list→'search', task→'task', default→'other'. Used when building `tool_use` blocks (store
on the block if useful; renderer already renders generic tool blocks, so this is light for MVP).

---

## Out of scope (later sub-phases / phases)
- `OpencodeAuthProvider`, API-key entry, paste-code OAuth, `/provider/auth` UI, hosted-MCP via
  `OPENCODE_CONFIG_CONTENT` → **5c**. (5b uses the free no-auth provider + no MCP injection;
  `hostedMcp:false`.)
- Tool registry / `ToolKind` taxonomy + per-tool cards → **Phase 6** (5b uses generic rendering).
- Metering / usage recorder → **Phase 7** (5b keeps `totalCostUsd` live in status only).
- opencode steer/queue/slash-commands/subagents/skills/voice → deferred (caps `false` in 5b).
- Reasoning picker for opencode models (opencode reasoning is a per-model boolean) → follow-up.
- Shared single SSE stream per server (5b opens one `/event` subscription per session, filtered by
  sessionID — fine for MVP; optimize later if needed).

---

## Testing
**Default suite (unit, no binary/network — must pass in `test`/`test:ci`):**
- `event-mapper.test.ts` — feed captured event fixtures (text/reasoning/tool part.updated, delta,
  permission.asked, session.idle) → assert the emitted ChatMessage/ContentBlock/PendingApproval/
  result shapes. **Cross-session filter**: an event with a foreign `sessionID` is ignored.
- `OpencodeSession.test.ts` — inject a fake `OpencodeClient` (stub HTTP + a scripted async event
  generator) + a fake `OpencodeServerManager`; drive `run()` → assert `session:*` emissions in order
  (status w/ sessionId rekey, message, stream, tool-result, result). `resolveApproval` → asserts the
  reply call + decision mapping. `setPermissionMode('ask'|'full'|'plan')` → asserts the PATCH/agent.
- `model-capabilities` — opencode caps resolution (toolCalling/vision/contextWindow; autonomyModes
  excludes autoEdit; `canUseMcp=false` in 5b).
- Keep all opencode imports main-process-only (never pulled into renderer/shared test graph in a way
  that loads a binary).

**Gated smoke (real binary, free model — `integration` project, NOT in default test):**
- Spawn via the manager, create a session, `prompt_async` with `opencode/mimo-v2.5-free` "say hi",
  consume SSE, assert a text part + `session.idle` arrive. Optionally a `bash` tool turn with
  `permission:ask` → assert `permission.asked` fires and a reply unblocks it.

## Verify (all must pass)
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- `lint`: 0 errors (3 pre-existing `exhaustive-deps` warnings OK).
- **Runtime smoke via `verifier-electron`** (this is a UI/behavior change): `bun run build`, then
  `node scripts/app-shot.mjs` — launch the app, open the model picker, confirm the opencode group +
  free models render; select `mimo-v2.5-free`, send "say hello", screenshot, assert the assistant
  reply renders. Then a tool turn in `ask` mode → assert the approval UI appears. **Read the PNG.**
- Confirm **Claude is unchanged**: open a Claude session, send a prompt, screenshot — identical UX.

## Gotchas
- **Filter SSE by `sessionID`** — the shared server streams all sessions in the cwd. Missing this
  cross-talks events between sessions in the same folder.
- **Subscribe to SSE before `prompt_async`** — else you miss the opening events of the turn.
- **`opencode/big-pickle` is the default but a paid alias** — for the no-auth smoke use a `*-free`
  model (`mimo-v2.5-free`). Don't hardcode a paid model as the 5b default.
- **Per-session permission via PATCH, never global** — the server is shared; global config would
  leak modes across sessions/folders.
- **Windows orphans** — `SIGTERM` on the parent leaves `opencode.exe` children; use `taskkill /T`.
- **better-sqlite3 ABI** — do NOT `bun install`/`bun add`. No new runtime deps needed (global
  `fetch`, `node:child_process`). If a dep truly must change, run `bun run rebuild:native`.
- **Don't break Claude** — guard the anthropic-specific env (proxy/endpoint/model) to the claude
  path; keep `session:get-models` working; the renderer picker must still show Claude models
  identically when opencode discovery returns `[]`.
- **opencode optional** — every opencode failure path (binary missing, server won't start, discovery
  error) must degrade gracefully (Claude-only), never throw into the create/getModels path.
- **Probe binary** lives at `.cache/opencode-probe/package/bin/opencode.exe` and is also vendored at
  `vendor/opencode-cli/opencode.exe` — the manager's locator finds either.

## Commit
Branch `v2-phase-5b-opencode-chat` off `v2-phase-5a-opencode-server`; **no AI attribution**; one
commit, multi-paragraph body. Suggested subject:
`feat(v2): opencode chat MVP — session + event mapper + grouped model picker + approvals (Phase 5b)`.
