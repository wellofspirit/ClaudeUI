# Codex Provider Support — Implementation Plan (Strategy B)

> Branch: `codex-sup` (off `pre-release`).
> Goal: add **OpenAI Codex** as a first-class agent backend alongside Claude, behind a
> formal provider abstraction, so the renderer is backend-agnostic and a third
> backend can later be added without another refactor.

---

## 0. Decisions locked for this plan

| Decision | Choice | Consequence |
| --- | --- | --- |
| Abstraction | **Strategy B** — formal provider abstraction | Extract `ISession` + `BaseSession`; refactor `ClaudeSession` behind it; add `CodexSession` as a peer. The existing `ContentBlock`/`session:*` IPC contract **is** our neutral event model — we do **not** introduce a separate `ProviderRuntimeEvent` schema (avoid t3code-style over-modeling). |
| MCP | **Out of scope for v1** | Codex sessions start with no ClaudeUI-hosted MCP tools (mermaid/mockup). No `-c mcp_servers…` injection. Revisit after parity. |
| Codex binary | **Bundle our own, version-pinned** | Vendor a prebuilt `codex` per platform under `vendor/codex-cli/`, pinned via `package.json#codexCliVersion`. Spawn the bundled binary, never PATH. Gives a slot to drop in a custom build later. |
| "Patching" Codex | **Protocol-layer interception now; source-fork later** | Codex app-server is compiled **Rust** — we cannot regex-patch it like cli.js. Our patch surface is (a) in-process JSON-RPC frame interceptors in our client/adapter for anything observable on the wire, and (b) a deferred, scaffolded `codex-rs` source-fork + build pipeline for non-observable internal changes. |
| Neutral model | Reuse `ChatMessage` + `ContentBlock` | Codex `item`s map onto existing block types. Synthesize `toolUseId` from Codex `item.id`. |

### Non-goals for v1
- ClaudeUI-hosted MCP tools inside Codex sessions.
- Codex multi-account / shadow-home (t3code's overlay). Single `CODEX_HOME`.
- Codex realtime/voice (`thread/realtime/*`), web-search rendering polish, image generation.
- A custom `codex-rs` binary build (scaffold only).
- Usage-analytics dashboard integration for Codex (token feed differs; gate it off).

---

## 1. Target architecture

```
Renderer (unchanged contract) ── session:* events + ChatMessage/ContentBlock/PendingApproval
        │
   IPC (session.ipc.ts) ── calls ISession methods; guards capability-gated ones
        │
   SessionManager: Map<routingId, ISession>  +  ProviderRegistry (factory by providerId)
        ├── ClaudeSession  extends BaseSession  (existing, refactored)
        └── CodexSession   extends BaseSession  (new)
                              │
                    CodexAppServerClient (NDJSON JSON-RPC, reuses src/main/sdk/protocol.ts)
                              │
                    vendor/codex-cli/codex app-server   (bundled, pinned)
```

**Key invariant:** every backend emits the same `session:*` events carrying the same shapes.
The renderer learns a session's `provider` + `capabilities` once (on init) and feature-gates
provider-specific UI (effort/thinking pickers, voice, etc.).

### 1.1 The `ISession` interface (provider-neutral core)

Derived from `ClaudeSession`'s current public surface (`claude-session.ts`). Core methods
every provider must implement:

```ts
interface ISession {
  readonly provider: ProviderId            // 'claude' | 'codex'
  readonly routingId: string
  readonly cwd: string
  readonly capabilities: SessionCapabilities

  run(prompt: string, attachments?: FileAttachment[]): Promise<void>
  interrupt(): Promise<void>
  cancel(): void
  resolveApproval(requestId: string, decision: 'allow'|'deny', answers?, updatedPermissions?): void
  setModel(model: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setInactivityTimeout(ms: number): void
  getSessionId(): string | null
  getMessages(): ChatMessage[]
  dispose(): void                          // unify cancel/teardown
}
```

Capability-gated (optional) methods — present only when `capabilities.X` is true:
`setEffort`, `setThinkingMode`, `voice*`, `mcp*`, `stopTask`, `backgroundTask`,
`watchBackground`/`unwatchBackground`/`readBackgroundRange`, `dequeueMessage`,
`askSideQuestion`, `getUsage`, `getSessionLogPath`, `getPlanContent`.

```ts
interface SessionCapabilities {
  thinkingModes: boolean        // claude: true (adaptive/enabled/disabled). codex: false
  effortLevels: boolean         // claude: 5-tier. codex: reasoningEffort (low/med/high) → map
  voice: boolean                // claude: true. codex: false (v1)
  hostedMcp: boolean            // claude: true. codex: false (v1)
  backgroundTasks: boolean      // claude: true. codex: false
  subagents: boolean            // claude: true. codex: collab (later)
  plan: boolean                 // both true (codex collaborationMode='plan')
  costUsd: boolean              // claude: true. codex: false (tokens only)
  fork: boolean                 // both true
  sideQuestion: boolean         // claude: true. codex: false
}
```

### 1.2 `BaseSession` (abstract)
Holds what is identical across providers and is **not** protocol-specific:
- fields: `routingId`, `win`, `cwd`, `messageHistory`, `pendingApprovals` map
- statics: `extraWindows` set + `addExtraWindow/removeExtraWindow/getExtraWindows`
- `protected send(channel, data)` → `webContents.send(channel, this.routingId, data)` + extra-window mirror (lifted verbatim from `claude-session.ts:2256`)
- `protected sendStatus()` skeleton, `getMessages()`, `setInactivityTimeout()` default impl

`ClaudeSession extends BaseSession` and `CodexSession extends BaseSession`.

---

## 2. Phase 0 — Branch & scaffolding ✅ (you are here)

**Goal:** branch exists; plan committed; directory skeleton in place.

Steps:
1. `git checkout -b codex-sup` (done).
2. Add this plan at `docs/codex/implementation-plan.md` (done) and commit.
3. Create empty dirs with `.gitkeep`:
   - `src/main/providers/` (new home for the abstraction + registry)
   - `src/main/codex/` (CodexSession + protocol client + mappers)
   - `src/main/codex/protocol/` (generated types)
   - `patch/codex/` (future frame-interceptor patches; README only for now)
   - `docs/codex/`

**Acceptance:** branch builds unchanged (`bun run typecheck`); plan doc on branch.

---

## 3. Phase 1 — Provider abstraction refactor (no Codex yet)

**Goal:** introduce `ISession`/`BaseSession`/`ProviderRegistry`, refactor `ClaudeSession`
to fit, make `SessionManager` and `session.ipc.ts` provider-agnostic. **Claude behaves
exactly as before.** This phase is independently shippable and reviewable.

Steps:
1. **Define types** in `src/main/providers/ISession.ts`: `ProviderId`, `SessionCapabilities`,
   `ISession`, and a `ProviderSessionFactory` signature. Add `ProviderId` + `SessionCapabilities`
   to `src/shared/types.ts` (renderer needs them).
2. **`src/main/providers/BaseSession.ts`**: lift `send`/`sendStatus`/`extraWindows`/`getMessages`
   /`setInactivityTimeout` out of `ClaudeSession`. Keep the exact `webContents.send(channel,
   routingId, data)` semantics.
3. **Refactor `ClaudeSession extends BaseSession`**: remove the lifted members; add
   `readonly provider = 'claude'`, `readonly capabilities = CLAUDE_CAPS`. Implement `dispose()`
   delegating to `cancel()` + timers cleanup. No behavior change.
4. **`src/main/providers/ProviderRegistry.ts`**: `createSession(providerId, args): ISession`.
   For now only registers `'claude'`. Centralizes the `new ClaudeSession(...)` call that lives
   in `session-manager.ts:35`.
5. **`SessionManager`**: change `Map<string, ClaudeSession>` → `Map<string, ISession>`. Route
   `createSession` through `ProviderRegistry`. `createSession` signature gains a leading
   `providerId: ProviderId` (default `'claude'` to keep callers working during migration).
6. **`session.ipc.ts` guarding**: every handler that calls a Claude-only method
   (`setEffort`, `setThinkingMode`, `voice*`, `mcp*`, `stopTask`, `backgroundTask`,
   `dequeueMessage`, `askSideQuestion`, `getUsage`) must check `session.capabilities.X`
   (or `typeof session.method === 'function'`) and no-op/return a typed error otherwise.
   Enumerate these by grepping `session\.` usages in `session.ipc.ts` and `remote-handlers.ts`.
7. **Emit provider + capabilities to renderer**: extend `SessionStatus` (`types.ts:41`) with
   `provider: ProviderId` and `capabilities: SessionCapabilities`; populate on the first
   status emit. (Renderer wiring lands in Phase 5; emit it now so the contract is stable.)

**Acceptance:**
- `bun run typecheck` + `bun run test` green (unit/component/e2e).
- Manual smoke: Claude session works end-to-end (chat, approvals, thinking, voice, MCP toggle).
- `git grep "new ClaudeSession"` returns only `ProviderRegistry`.

**Risks:** `session.ipc.ts` is large; missing a Claude-only call site → runtime error for Codex
later. Mitigation: the capability guard is the single chokepoint; add a unit test that asserts
every IPC handler tolerates a stub `ISession` with all caps `false`.

---

## 4. Phase 2 — Codex CLI vendoring + protocol generation + patch strategy

**Goal:** a pinned `codex` binary on disk + generated TS protocol types + a documented,
honest patch mechanism.

### 4a. Vendoring
1. Add `package.json#codexCliVersion` (pin to a known-good `@openai/codex` release).
2. `scripts/ensure-codex.mjs`: download/extract the pinned `@openai/codex` platform binary
   into `vendor/codex-cli/codex[.exe]`. Cache-hit skip on matching version (mirror
   `ensure-cli.mjs`'s version-stamp approach). No rebundle/codesign needed beyond ad-hoc
   signing on macOS if the downloaded binary isn't already signed.
3. Wire `ensure-codex` into `postinstall`, `dev`, and `build:*` next to `ensure-cli`.
4. `.gitignore` `vendor/codex-cli/` (binaries not checked in, like `vendor/claude-cli/`).
5. `src/main/codex/locate.ts`: resolve `vendor/codex-cli/codex[.exe]` (dev) vs
   `<Resources>/codex-cli/codex[.exe]` (prod). Mirror `sdk/locate.ts`.
6. **electron-builder**: add `vendor/codex-cli/` to `extraResources` so it ships in the app.

### 4b. Protocol generation
7. `scripts/generate-codex-protocol.mjs`: fetch `codex-rs/app-server-protocol` JSON Schema
   from `github.com/openai/codex` at a **pinned ref** (record the ref as
   `package.json#codexProtocolRef`). Emit plain-TS types + a runtime validator into
   `src/main/codex/protocol/` — split into `methods.ts` (request/notification catalog),
   `schema.ts` (param/response/item types), `index.ts`. Validate with `zod` if already a dep,
   else hand-rolled guards; **no Effect**.
8. Commit the generated output (unlike binaries, generated TS is checked in so the build
   is hermetic and diffs are reviewable on version bumps).
9. Add `docs/codex/protocol-reference.md` summarizing the surface we actually use
   (regenerate/verify against source — do not trust this plan's method list blindly).

### 4c. Patch strategy (honest)
- **Primary (now):** protocol-observable behavior is "patched" via in-process frame
  interceptors in `CodexAppServerClient` (Phase 3) — a list of `(frame) => frame|null`
  transforms on inbound/outbound JSON-RPC. Document the pattern in `patch/codex/README.md`.
  This covers ~everything we needed cli.js patches for (forcing streaming, reshaping events),
  because app-server already emits rich deltas/requests natively.
- **Escape hatch (deferred, scaffold only):** for behavior **not** observable on stdio
  (e.g. how codex talks to the OpenAI API), the only lever is a `codex-rs` source fork +
  cross-platform Rust build. Add `patch/codex/SOURCE-FORK.md` describing the approach
  (fork ref, `cargo build --release` targets, drop-in path) but **do not build it in v1**.

**Acceptance:** `bun run ensure-codex` yields a runnable binary; `vendor/codex-cli/codex app-server`
starts and responds to a manual `initialize` (verify with a throwaway script). Generated types
compile.

**Risks:** binary distribution shape of `@openai/codex` may differ by platform; confirm the
extraction per-OS. Protocol ref must match the binary version closely or decode fails — keep
`codexCliVersion` and `codexProtocolRef` bumped together (note this in `docs/codex/maintenance.md`).

---

## 5. Phase 3 — Codex protocol client (NDJSON JSON-RPC)

**Goal:** a typed, plain-TS client that speaks Codex app-server over stdio, reusing our NDJSON
transport.

Steps:
1. `src/main/codex/CodexAppServerClient.ts`:
   - Reuse `NdjsonReader`/`NdjsonWriter` from `src/main/sdk/protocol.ts` over the spawned
     child's stdio (newline-delimited JSON; CR-stripped; `JSON.stringify(msg)+"\n"`).
   - Frame discrimination: has `id`+`method` → server→client **request**; `method` no `id` →
     **notification**; matches response envelope → response to our request.
   - Monotonic integer request ids from 1; `Map<id, Deferred>` correlation (reuse the pattern
     in `sdk/control.ts`).
   - API: `request(method, params)`, `notify(method, params)`,
     `handleServerRequest(method, handler)`, `handleServerNotification(method, handler)`,
     `handleUnknownServerRequest(handler)` (default reply `methodNotFound`).
   - Per-method param/response validation via generated `schema.ts`.
   - **Interceptor hooks**: `addInboundInterceptor(fn)` / `addOutboundInterceptor(fn)` —
     the Codex "patch" surface.
   - Drain stderr on a separate path (never feed the JSON parser); classify ERROR-level lines
     for surfacing.
2. `src/main/codex/CodexAppServerClient.test.ts` — drive it against a mock peer that emits
   canned frames (port t3code's `codex-app-server-mock-peer.ts` fixtures conceptually).

**Acceptance:** unit tests cover request/response correlation, notification dispatch, unknown
server-request fallback, and interceptor application. No real binary needed (mock peer).

---

## 6. Phase 4 — `CodexSession` (the core)

**Goal:** `CodexSession extends BaseSession implements ISession`, spawns the bundled binary,
runs the thread/turn loop, and emits our `session:*` contract.

### 6a. Lifecycle & handshake
1. Spawn `vendor/codex-cli/codex app-server` with `cwd`, `env` (`CODEX_HOME` expanded — `~`
   is not shell-expanded by `spawn`), `forceKillAfter` ~2s.
2. Handshake: `request initialize {clientInfo:{name:'ClaudeUI',version}, capabilities:{experimentalApi:true}}`
   → `notify initialized` → `thread/start {cwd, approvalPolicy, sandbox, model?}` (or
   `thread/resume {threadId, …}` with fallback to `thread/start` on "not found"-class errors).
3. Capture `thread.id` as the resume cursor; emit `session:status` (state `running`/`idle`,
   provider `codex`, capabilities `CODEX_CAPS`). Rekey routingId→thread.id analog (see Phase 6).

### 6b. RuntimeMode → policy map (from permissionMode)
| ClaudeUI permission mode | Codex `approvalPolicy` | Codex `sandbox` / turn `sandboxPolicy` |
| --- | --- | --- |
| approval-required / default | `untrusted` | `read-only` / `readOnly` |
| acceptEdits / auto | `on-request` | `workspace-write` / `workspaceWrite` |
| bypassPermissions / full | `never` | `danger-full-access` / `dangerFullAccess` |

### 6c. Turn loop (`run(prompt, attachments)`)
4. `turn/start {threadId, input:[{type:'text',text}, …{type:'image',url:dataURL}], approvalPolicy,
   sandboxPolicy, model?, effort?(reasoningEffort), collaborationMode?(plan)}`.
   Attachments → base64 data URLs.
5. Emit a user `ChatMessage` immediately (or rely on existing optimistic user-add — match
   Claude's flow).
6. Capture `turn.id` as active turn for `interrupt()` → `turn/interrupt {threadId, turnId}`.

### 6d. Notification → ContentBlock/`session:*` mapping (the heart)
Implement `src/main/codex/mapCodexEvent.ts` (pure function, heavily unit-tested). Reference:
t3code's `CodexAdapter.mapToRuntimeEvents`, but **retarget to our `ContentBlock`/IPC**:

| Codex notification | Emit |
| --- | --- |
| `item/agentMessage/delta` (`delta`) | `session:stream {type:'text', text:delta}` |
| `item/reasoning/textDelta` / `summaryTextDelta` | `session:stream {type:'thinking', text:delta}` |
| `item/commandExecution/outputDelta` | append to the matching `tool_use`/result stream |
| `item/started` type `commandExecution`/`fileChange`/`mcpToolCall` | assistant `ChatMessage` with `tool_use` block; `toolUseId = item.id` |
| `item/completed` (non-plan) | `session:tool-result {toolUseId:item.id, result, isError}` |
| `item/completed` type `plan` | plan content → `ChatMessage.planContent` / plan UI |
| `turn/plan/updated` | todo/plan widget feed (Phase 6 polish) |
| `turn/diff/updated` (`diff`) | feed git/diff panel (later) |
| `thread/tokenUsage/updated` | `session:status-line` (tokens; no USD) |
| `turn/completed` | `session:result` + status `idle`/`error` |
| `error {willRetry}` | `session:warning` (retry) or `session:error` |

**ID synthesis:** Codex assigns `item.id` to everything, so the store's `toolUseId`-keyed
approval/result matching (`types.ts:60-67`) works without the legacy fallback. Good.

### 6e. Approvals (server→client requests)
7. `handleServerRequest('item/commandExecution/requestApproval', …)` and
   `item/fileChange/requestApproval`, `item/tool/requestUserInput`:
   - Park the JSON-RPC response in a Deferred; emit `session:approval-request` with a
     `PendingApproval {requestId, toolUseId:item.id, toolName, input, …}`.
   - `resolveApproval(requestId, 'allow'|'deny', …)` → resolve the Deferred with the Codex
     decision union: `allow → 'accept'`, `deny → 'decline'`. (Optionally expose
     `acceptForSession` later via a UI affordance; v1 maps to the 2-value subset.)
   - `requestUserInput` → emit our AskUserQuestion-equivalent; map answers back to
     `{questionId:{answers:[…]}}`.
8. Unknown server requests (incl. `account/chatgptAuthTokens/refresh`) → `methodNotFound`;
   token refresh is handled inside the binary's managed-auth.

### 6f. Capabilities & teardown
9. `CODEX_CAPS`: `{thinkingModes:false, effortLevels:true, voice:false, hostedMcp:false,
   backgroundTasks:false, subagents:false, plan:true, costUsd:false, fork:true,
   sideQuestion:false}`.
10. `dispose()`: close client, kill child, settle pending approvals as `cancel`, shut queues.
11. Register `'codex'` in `ProviderRegistry`.

**Acceptance:**
- Unit: `mapCodexEvent` covers every notification we handle (table-driven).
- Integration (gated, real binary): start a Codex session in a temp repo, send a prompt that
  triggers a command-exec approval, allow it, assert a `tool_result` arrives and `turn/completed`
  fires. Mirror the existing gated integration-test harness.
- Manual: a Codex chat renders text, reasoning, a command tool-call card, and an approval prompt.

**Risks:** item/turn/thread id correlation bugs (Codex separates threadId/turnId/itemId);
the mapper must thread these through. Lean on t3code's `readRouteFields`/`readNotificationThreadId`
as the reference.

---

## 7. Phase 5 — Renderer: provider selection + capability gating

**Goal:** user can start a Codex session; provider-specific UI gates correctly.

Steps:
1. **Store** (`session-store.ts`): add per-session `provider: ProviderId` and
   `capabilities: SessionCapabilities`, set from `SessionStatus`. Default to claude caps for
   back-compat on history load.
2. **Provider picker**: in the new-session flow (`WelcomeScreen`/`Sidebar` folder pick, and/or
   a provider dropdown next to the model picker). Selecting a provider passes `providerId` to
   `window.api.createSession`. Add `providerId` to the `createSession` IPC + preload.
3. **Capability-gate pickers** (`InlinePickers.tsx`):
   - Thinking-mode picker: render only if `capabilities.thinkingModes`.
   - Effort picker: render for both, but Codex uses reasoningEffort tiers (low/medium/high) —
     source the level list from capabilities/model, not hardcoded Claude tiers.
   - Voice button / MCP dialog / background-task affordances: gate on caps.
4. **Model picker**: source Codex models from `model/list` (fetched at session init, surfaced
   via a `session:models` event or the init status). Tag each model with its provider.
5. **Cost display**: when `!capabilities.costUsd`, hide `totalCostUsd`, show token-based status
   only.
6. **useClaudeEvents**: no new channels needed (same `session:*`). Add handling for
   `provider`/`capabilities` on status. (Consider renaming the hook later; not required.)

**Acceptance:** start both a Claude and a Codex session in different tabs; Claude shows
thinking/effort/voice, Codex shows effort only, no voice/MCP/cost. Switching tabs preserves
each session's capability gating.

**Risks:** several components read Claude-only state unconditionally (e.g. `streamingThinking`).
Audit `session-store` selectors used by chat components; ensure they're inert when empty for Codex.

---

## 8. Phase 6 — History, resume, fork

**Goal:** Codex sessions persist and resume like Claude's.

Steps:
1. **Resume**: `CodexSession` accepts a resume cursor (`threadId`); `thread/resume` on first run.
   Plumb through `SessionManager.rekey` analog (Codex's stable id is `thread.id`).
2. **History load**: `session-history.ts` is Claude-JSONL-specific. Add a provider-routed path:
   for Codex, load history via `thread/read {threadId, includeTurns:true}` → map turns/items →
   `ChatMessage[]`. Introduce `ISessionHistoryLoader` per provider, or branch inside the IPC
   handler on the persisted session's provider.
3. **Persisted-session metadata**: record `provider` in the persisted-sessions store so resume
   picks the right backend.
4. **Fork**: Codex has native `thread/fork`; wire ClaudeUI's "branch off" to it for Codex
   sessions (ADR-010 is Claude `--fork-session`; document the Codex analog).

**Acceptance:** quit/reopen → a Codex thread resumes with prior turns rendered; fork creates a
new thread carrying history.

**Risks:** ClaudeUI assumes one persistence model (`~/.claude/projects/*.jsonl`). Codex owns its
store in `CODEX_HOME`. Keep them separate; don't try to unify the on-disk format.

---

## 9. Phase 7 — Auth (delegated)

**Goal:** detect Codex login state; guide the user; no in-app OAuth.

Steps:
1. On session start (or a settings "refresh provider status"), `request account/read {}`.
   - `account` present → authenticated; surface email when `account.type==='chatgpt'`.
   - absent + `requiresOpenaiAuth` → emit a typed "not authenticated" state.
2. **UI**: if unauthenticated, show an inline card: *"Codex CLI is not authenticated. Run
   `codex login` and retry."* (Do **not** build an OAuth flow — opposite of ADR-014/015.)
3. **Settings**: a Codex provider row (binary = bundled by default, optional `CODEX_HOME`
   override, enable/disable). Reuse the settings infra; store under UISettings/provider config
   (not Claude `settings.json`).

**Acceptance:** with no `codex login`, the Codex tab shows the auth prompt; after `codex login`,
status flips to authenticated with email shown.

**Risks:** auth probe must be timeout-bounded and must distinguish "binary missing" from "not
logged in" (spawn error vs runtime error), as t3code does.

---

## 10. Phase 8 — Testing & hardening

Per the four-layer strategy (`docs/testing-strategy.md`):
1. **Unit**: `mapCodexEvent` (table-driven, the highest-value tests); `CodexAppServerClient`
   (mock peer); policy-mode mapping; capability gating helper.
2. **Component**: feed Codex-shaped `session:*` events through the store → assert messages,
   approvals, tool results, status render correctly (proves the contract holds without a binary).
3. **e2e**: full bridge → store pipeline for a Codex turn.
4. **Integration (gated)**: real bundled `codex app-server` — handshake, a turn with an approval,
   resume. Gate behind the same env flag as Claude integration tests; skip in default `bun run test`.
5. **Regression**: confirm Claude paths untouched (run full `bun run test:ci`).
6. Add `bun run ensure-codex` to CI before integration runs.

**Acceptance:** `bun run test:ci` green; gated Codex integration green locally with a logged-in
`codex`.

---

## 11. Phase 9 — Docs & ADRs

1. **ADR-016 — Provider abstraction (`ISession`/`BaseSession`/`ProviderRegistry`)**: records
   Strategy B, the "ContentBlock is the neutral model" decision, and capability gating. Scan
   existing ADRs; this relates to (but doesn't supersede) the cli.js-centric ones — note it.
2. **ADR-017 — Codex backend via app-server**: bundling, protocol generation, delegated auth,
   no-MCP-v1, protocol-layer "patching" vs source-fork.
3. **`docs/codex/protocol-reference.md`** + **`docs/codex/maintenance.md`** (bump
   `codexCliVersion` + `codexProtocolRef` together; regenerate).
4. **CLAUDE.md**: add a Providers section; update the structure tree (`src/main/providers/`,
   `src/main/codex/`); add `ensure-codex`/`update-codex` commands; note the Rust-binary
   patch reality.
5. **README/known gotchas** as needed.

---

## 12. Sequencing & checkpoints

| Phase | Outcome | Shippable alone? |
| --- | --- | --- |
| 0 | branch + plan + skeleton | n/a |
| **1** | provider abstraction; **Claude unchanged** | ✅ yes — merge-able even without Codex |
| 2 | bundled binary + generated protocol | infra only |
| 3 | protocol client (mock-tested) | infra only |
| **4** | Codex chat works (text/tools/approvals) | ✅ MVP milestone |
| 5 | provider picker + capability gating | ✅ user-facing Codex |
| 6 | history/resume/fork | parity |
| 7 | auth prompt | parity |
| 8–9 | tests, docs, ADRs | hardening |

**Recommended review gates:** open a PR after Phase 1 (pure refactor — easy to review, de-risks
the abstraction) and again after Phase 4 (the protocol MVP). Keep Phases 5–7 as stacked PRs on
`codex-sup`.

---

## 13. Risk register (top items)

1. **Rust binary ≠ patchable JS.** Set expectations: protocol-layer interception covers most
   needs; true binary changes require a `codex-rs` fork + build (deferred). Don't promise
   cli.js-style patches for Codex.
2. **Protocol/binary version skew.** `codexCliVersion` and `codexProtocolRef` must move
   together; decode failures otherwise. Enforce in `ensure-codex` (warn on mismatch).
3. **`session.ipc.ts` Claude-only call sites.** Missing a guard → Codex runtime errors. The
   capability chokepoint + the "all-caps-false stub" test is the mitigation.
4. **Renderer hidden Claude assumptions.** `streamingThinking`, todo-building from
   `TodoWrite`, subagent routing via `parent_tool_use_id`. Audit selectors; gate or no-op for
   Codex. Codex todos come from `turn/plan/updated`, not a tool.
5. **Usage analytics divergence.** Codex reports tokens, not USD; keep the Usage dashboard
   Claude-only in v1 (gate on `capabilities.costUsd`).
6. **History model divergence.** Two persistence backends; do not unify on-disk formats.

---

## 14. Open questions to resolve before/while building

- Which `@openai/codex` version to pin first, and does its app-server protocol ref line up with
  the latest schema we generate? (Resolve in Phase 2 against the real binary.)
- Provider picker placement: per-tab dropdown vs. chosen at folder-open? (UX call in Phase 5.)
- Do we expose `acceptForSession` (Codex's richer approval) now, or stay allow/deny-only in v1?
- Effort-level UX for Codex (its reasoningEffort tiers differ from Claude's 5-tier) — reuse the
  picker with a provider-sourced level list.
