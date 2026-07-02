# Engine-hardening series — kickoff specs

> **STATUS: ALL SIX ITEMS SHIPPED 2026-07-02** on branch `multi-engine-hardening`
> (Items 1–5 one commit each; Item 6 as two commits, 6a mirror + 6b placement).
> One new 🔴 follow-up discovered during 6a — see the follow-up section at the bottom
> (tracked as ROADMAP #17).
>
> Source: multi-engine architecture review (2026-07-02). Six sequential work items, each
> implemented by an Opus orchestrator driving Sonnet implementer(s) per ADR-026, reviewed
> by the top-level session, one commit per item on branch `multi-engine-hardening`.
>
> **Standing constraints for every item (from ADR-026 / CLAUDE.md):**
> - Implementing agents never commit, `git add`, branch, or run `bun install`.
> - Gates before handing back: `bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`.
> - Renderer changes follow the ADR-027 `data-testid` convention (two-tier PascalCase).
> - Write tests alongside changes — guard tests must fail against pre-fix code.
> - Match surrounding code style; no AI attribution anywhere.
> - Never search minified cli.js by variable name; this series should not touch `patch/` at all.

---

## Item 1 — Capability honesty: stop advertising fork on opencode (+ ADR-030)

**Bug.** `OPENCODE_ENGINE_CAPABILITIES` declares `fork: true, forkFromMessage: true`
(`src/shared/model-capabilities.ts:578-579`), so MessageBubble (gates on
`status.capabilities.forkFromMessage`, `MessageBubble.tsx:84`) shows the branch-off button on
opencode sessions. The flow then calls `resolveForkAnchor()` (`session-store.ts:1116`) which only
reads Claude JSONL transcripts → always fails with "Cannot branch from this message yet…".
`OpencodeSession` discards `_resumeSessionAt`/`_forkSession` (`OpencodeSession.ts:208-209`);
`OpencodeClient.forkSession()` (`OpencodeClient.ts:166`) has no caller.

**Change.**
1. Flip `fork: false, forkFromMessage: false` in `OPENCODE_ENGINE_CAPABILITIES`; update the
   constant's doc comment to note fork is unwired (client method exists, session ignores the
   spawn params, anchor resolution is Claude-JSONL-only) and cross-ref this plan item.
2. Add a defensive early-return in the store's `forkFromMessage` action
   (`session-store.ts:1108`): if the source session's `status.capabilities.forkFromMessage` is
   false, `addError(...)` with an honest message and return null (UI gating is currently the only
   guard).
3. Leave `OpencodeClient.forkSession()` in place with a comment marking it intentionally unwired
   (future feature), so lint doesn't flag it and future implementers find it.
4. Write **ADR-030 "Capability honesty"**: a capability flag may only be `true` when the full
   end-to-end path behind it works for that engine; cite the fork case as the motivating example;
   cross-ref ADR-018 (capability model) and ADR-019. Add to `docs/adr/adr.md` index and the ADR
   table in `CLAUDE.md`.

**Tests.** Component-level: an opencode session (seeded caps) renders no fork affordance in
MessageBubble; a claude session still does. Store-level: `forkFromMessage` on a caps-false session
returns null + adds an error, and does NOT call `window.api.resolveForkAnchor`.

**Out of scope.** Actually implementing opencode fork (native `POST /session/:id/fork`); removing
the dead constructor params (item 6 handles the factory signature).

**Commit:** `fix(opencode): stop advertising unimplemented fork capability (ADR-030)`

---

## Item 2 — Remote/web session:create parity with desktop

**Bug.** The remote dispatcher's `session:create` (`src/main/ipc/remote-handlers.ts:86-113`):
- has no `engineId` param → remote clients can only spawn Claude sessions (shared contract
  `ClaudeAPI.createSession` carries `engineId?` as the 10th arg, `shared/types.ts:600-611`);
- sources sandbox from flat `settings.json` (`loadSettings().sandbox`) — a field the Phase-3b
  migration deletes — instead of `loadEngineConfig(engineId).sandbox`;
- skips proxy/endpoint/model env application and `resolveOpencodeSpawnModel`.
Additionally the web adapter (`src/web/api-adapter.ts:84-94`) stops at `forkSession` and drops
`engineId` before it even reaches the wire.

**Change.**
1. Extract the desktop `session:create` body (`session.ipc.ts:795-848`) into a shared helper,
   e.g. `prepareAndCreateSession(manager, win, args…)` in a new `src/main/ipc/create-session.ts`
   (or similar) so both surfaces call ONE implementation: engine config load, the
   claude-vs-opencode env/model-resolution branch (unchanged logic — item 4 restructures it),
   `manager.create(...)`, and the `session:created` broadcast.
2. Remote handler: accept `engineId?: EngineId` (last param, matching IPC positional order) and
   delegate to the shared helper.
3. Web adapter: pass `engineId` through `connection.invoke('session:create', …)`.
4. Check `RemoteAccessModal`/web client callers compile against the updated adapter.

**Tests.** Dispatcher-level (see `src/main/services/remote-dispatcher.ts` test patterns): remote
`session:create` with `engineId:'opencode'` reaches `engineRegistry` with `'opencode'`; sandbox
config comes from `loadEngineConfig`, not `loadSettings`. A guard test that the old path spawned
claude for an opencode request should fail pre-fix.

**Out of scope.** Deriving the whole remote-handler mirror from IPC registrations (item 6); the
spawn-hook restructure (item 4).

**Commit:** `fix(remote): thread engineId + engine-config sandbox through remote session:create`

---

## Item 3 — Hoist Claude-only methods onto ISession (kill isClaudeSession casts)

**Problem.** The pattern `capabilities.X && isClaudeSession(s)` appears 19× in `session.ipc.ts`
(guard at `:119-122`) and ~12× in `remote-handlers.ts` (`:44-47`), plus
`SessionManager.forEachClaude` (`session-manager.ts:136-142`) used at `session.ipc.ts:1407,1420,1817`
and `remote-handlers.ts:375`, and the duplicated `instanceof OpencodeSession` skills dispatch
(`session.ipc.ts:1271-1285`, `remote-handlers.ts:353-364`). A third engine setting
`backgroundTasks: true` would still be silently skipped at every cast site. The codebase already
has the right pattern: `ISession.setReasoningVariant?()`.

**Change.**
1. Inventory every method reached through `isClaudeSession` / `forEachClaude` /
   `instanceof OpencodeSession` in the two files (background watch/read/stop/task, dequeue,
   voice start/stop, setEffort, setThinkingMode, getPlanContent, getSessionLogPath, MCP
   status/toggle/reconnect/setServers, notifySettingsChanged, getUsage, skills discovery — verify
   the exact list from the code, not this spec).
2. Add each to `ISession` as an **optional** method with a doc comment naming the capability flag
   that gates it (mirror the `setReasoningVariant?` precedent). Group with section comments.
3. Rewrite call sites to `s?.capabilities.X && s.method?.(…)` (or `s.method?.() ?? fallback` where
   a return value is consumed) — delete both `isClaudeSession` guards and `forEachClaude`
   (replace with `forEach` + optional call). For skills discovery, prefer an optional
   `discoverSkills?(cwd)` on ISession implemented by both engines (Claude → `scanSkills`,
   opencode → `discoverOpencodeSkills`), removing the `instanceof` and the cross-file duplication.
4. Where a handler returns data (e.g. `getUsage`, `getPlanContent`), preserve the existing
   envelope semantics when the method is absent (same value the old path returned when the
   session wasn't Claude).
5. Keep behavior identical for both existing engines — this is a mechanical de-casting refactor,
   not a behavior change.

**Tests.** Existing suites are the main guard. Add: a stub ISession without the optional methods
flows through the affected handlers without throwing; ClaudeSession still receives
`notifySettingsChanged` via the neutral iteration.

**Out of scope.** Implementing any of these capabilities for opencode; changing capability flags.

**Commit:** `refactor(providers): hoist capability-gated methods onto ISession, remove engine casts`

---

## Item 4 — Engine-owned spawn preparation hook

**Problem.** `session.ipc.ts` spawn path branches `if (engineId !== 'opencode') { applyProxyEnv…;
applyEndpointEnv…; applyModelEnv…; claudeModel(model).vendorId } else { resolveOpencodeSpawnModel }`
— the *else-is-claude* inversion means a third engine would get Anthropic endpoint env applied.
(After item 2 this branch lives in the shared create-session helper — refactor it there.)

**Change.**
1. New per-engine seam: `EngineSpawnPrep = (model: string | undefined, engineConfig: EngineConfig)
   => Promise<{ resolvedModel: string | undefined }>` registered alongside the session factory
   (either a second map in `EngineRegistry` or a parallel registry in `src/main/providers/`;
   registration lives in `register-engines.ts` so adding an engine keeps a single bootstrap file).
2. Claude impl (new `src/main/providers/claude-spawn-prep.ts` or under `services/`): current
   vendor derivation (`claudeModel(model).vendorId` → `loadVendorConfig`) + the three env
   applications, moved verbatim. opencode impl: `resolveOpencodeSpawnModel`.
3. The create-session helper calls `spawnPrep(engineId)` — **unknown engine throws** (mirror
   `EngineRegistry.createSession`'s error), no silent Claude default beyond the existing
   `engineId ?? 'claude'` legacy default at the IPC boundary.
4. Document (comment) that the endpoint/proxy/model env setters remain module-global singletons
   applied at create time — converting them to per-spawn overlays is future work; note the
   multi-vendor last-writer-wins hazard where the setters are defined.

**Tests.** Unit: claude prep applies env + derives vendor; opencode prep resolves the spawn model;
unregistered engine id throws. The item-2 dispatcher test still passes.

**Out of scope.** Per-spawn env overlay threading through `sdk/query.ts`; multi-vendor Claude.

**Commit:** `refactor(providers): engine-owned spawn preparation, remove else-is-claude env branch`

---

## Item 5 — Minimal EngineDescriptor (turn the add-an-engine checklist into compile errors)

**Problem.** ADR-018 promised an `EngineDescriptor`; it was never built. Per-engine policy is
scattered as `engineId === 'opencode' ? … : <claude>` ternaries: session-store (10 sites —
`defaultModelForEngine :64`, `modelRefForEngine :93`, capability seeding `:1011/:1036/:2223`,
picker-value reconstruction `:1083`, resume semantics `:2354`, rekey `:2406`),
`engine-tool-maps.ts:11`, `EngineLogo.tsx:28`, `InlinePickers.tsx:63` (group label),
`settings-sections.tsx:3314-3317` (`scopeCapabilities` ladder), `db.ts:353/359` (row hydration
vendor default). A third engine silently falls into the Claude branch everywhere.

**Change (two slices, shared→main then renderer).**
1. **Shared meta** (`src/shared/engine-meta.ts`): `interface EngineMeta { id: EngineId;
   label: string; capabilities: EngineCapabilities; defaultVendorId: VendorId;
   defaultModelValue: (opencodeDefault?: string) => string;  // naming: keep neutral, param is per-engine default
   encodeModelValue(ref: ModelRef): string; decodeModelValue(value: string): ModelRef;
   seedCapabilities(modelInfo?: ModelInfo): ResolvedCapabilities }` with a
   `ENGINE_META: Record<EngineId, EngineMeta>` table and a `engineMeta(id)` accessor that
   **throws on unknown id**. Fold the existing `claudeModel`/`opencodeModel` string conventions
   (bare alias vs `vendorId/modelId` slash-encoding) into encode/decode.
2. **Consume in main:** `db.ts` rowToMeta vendor default → `engineMeta(engineId).defaultVendorId`;
   anywhere else main hardcodes the two-engine vendor pairing.
3. **Consume in renderer:** replace the session-store ternaries (`defaultModelForEngine`,
   `modelRefForEngine`, both capability-seeding sites, picker-value reconstruction) with
   `engineMeta()` calls; `engine-tool-maps.ts`, `EngineLogo`, `InlinePickers` group label, and
   `scopeCapabilities` switch to a renderer-side extension table
   (`RENDERER_ENGINE_EXTRAS: Record<EngineId, { Logo, toolMap, settingsScopeId }>`) keyed off the
   same ids — renderer-only concerns must not import React into shared/.
4. Preserve exact current behavior for both engines (this is a table-ification, not a redesign).
   Where the old code had `?? 'claude'` fallbacks for **legacy persisted data**, keep them at the
   data boundary (loading old rows) but not in the policy functions.

**Tests.** Table completeness (every `EngineId` union member has meta + renderer extras — a
type-level `satisfies Record<EngineId, …>` makes it a compile error); encode/decode round-trip
for both conventions; unknown id throws; store behavior parity tests for default model + seeding.

**Out of scope.** Auth-state unification in the store; settings section componentization.

**Commit:** `refactor(shared): introduce EngineMeta descriptor table, collapse per-engine ternaries`

---

## Item 6 — Mirror + placement cleanups (may land as 2 commits)

**a. Shared handler table for the IPC/remote mirror.** `remote-handlers.ts` hand-mirrors ~49 of
125 IPC handlers and has already diverged (item 2's bug). Extract the overlapping session-domain
handler bodies into a shared module (e.g. `src/main/ipc/handlers-core.ts`) exporting named
functions both surfaces register; remote-only concerns (blocklist, auth token) stay in
remote-handlers. Don't force handlers that legitimately diverge (e.g. desktop-only dialogs) into
the shared table — document which remain surface-specific and why. After items 2-4 much of
session lifecycle is already shared; sweep the rest of the overlap.

**b. Placement/naming cleanups (mechanical):**
- Move `deleteSessionByEngine` from `opencode-session-list.ts:197-207` to a neutral module
  (`delete-session-files.ts` or new `services/session-delete.ts`); the opencode branch stays a
  dispatch into the opencode module.
- Replace `ClaudeSession.getExtraWindows()/addExtraWindow()/removeExtraWindow()` references in
  neutral modules (session.ipc, remote-handlers, automation-manager, remote-server,
  plugin-manager, block-usage, session-watcher) with `BaseSession.*` — the statics live there.
- `EngineSessionFactory`: replace the 11-positional-param tuple with
  `(routingId, win, cwd, opts: EngineSpawnOptions)` where `EngineSpawnOptions` is a named object
  (effort, resumeSessionId, permissionMode, model, sandboxConfig, thinkingMode, resumeSessionAt,
  forkSession). Update `register-engines.ts`, `SessionManager.create`, both session constructors,
  and call sites. Claude-specific members get doc comments noting which engines consume them.
- Deduplicate `parseModelString` (`OpencodeSession.ts:124`, `agent-generate.ts:15`) → export from
  one place (or use item 5's `decodeModelValue`), and the `FREE_VENDOR_IDS`/`FREE_OPENCODE_VENDORS`
  sets (`model-discovery.ts:25`, `OpencodeAuthProvider.ts:26`, `session-store.ts:68`).

**Deferred (do NOT do in this series):** folding `usage-fetcher.ts` behind `resolveUsageProvider`
(couples to roadmap #14 legacy-JSONL retirement); opencode voice; per-spawn env overlays.

---

## Follow-up discovered during Item 6a — remote `config:save-settings` divergence ✅ FIXED

> **Status: fixed 2026-07-02** (branch `remote-save-settings-parity`, ROADMAP #17). Desktop body
> extracted verbatim into `saveUiSettings()` in `handlers-core.ts`; both surfaces delegate, with
> broadcast targeting per surface via `notifyMainWindow` (the `saveSessions` pattern). All desktop
> side effects replicated remotely by design — settings.json is a single shared store. Guard tests
> (field-stripping, env application, interval/log/timeout propagation, stripped broadcast) verified
> to fail against the pre-fix code.

Found while building the 6a extraction inventory (documented in `handlers-core.ts`'s module
header): the remote `config:save-settings` handler is a **stale simplified copy** of the desktop
one. It does NOT strip the four engine/vendor-owned fields (`sandbox`/`proxy`/
`anthropicEndpoint`/`modelOverride`) from the incoming payload, does NOT re-apply
proxy/endpoint/model env from the engine/vendor stores, and does NOT propagate
usage/analytics/log/timeout settings the desktop handler applies. Same class of bug as Item 2's
`session:create` drift — a remote client saving settings can reintroduce migrated-away fields
into `settings.json` and leave spawn env stale.

Not fixed in 6a because converging is a behavior change deserving its own guard tests, not a
rider on a refactor commit. Fix Item-2-style: extract the desktop body into `handlers-core.ts`
(or a dedicated module), have remote delegate, with a guard test proving the remote path strips
engine/vendor fields (fails pre-fix).

**Tests.** Existing suites; for (a) a test that a shared handler registered on both surfaces
produces identical results for the same args.

**Commits:** `refactor(ipc): shared handler core for desktop + remote surfaces` and
`refactor: placement cleanups — neutral delete dispatcher, BaseSession statics, spawn options object`
