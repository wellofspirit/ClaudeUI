# ADR-016: Provider abstraction — ISession / BaseSession / ProviderRegistry

**Status:** Superseded by [ADR-018](adr-018_v2-engine-vendor-account-model.md) (V2 engine/vendor/account model)
**Date:** 2026-06-17

> Superseded: the `ISession`/`BaseSession`/`ProviderRegistry` seam and the "ContentBlock is the
> neutral model" decision are retained, but `ProviderId`→`EngineId` and the frozen per-provider
> `SessionCapabilities` constant is replaced by the computed engine+model capability model. See
> ADR-018.

## Context

ClaudeUI was tightly coupled to a single backend: the Claude cli.js process managed by
`ClaudeSession`. The renderer communicated over a fixed `session:*` IPC contract carrying
`ChatMessage`, `ContentBlock`, and `PendingApproval` shapes — an implicitly provider-neutral
contract, but with no seam to add a second backend without a disruptive rewrite.

Adding OpenAI Codex required that seam. Two strategies were considered:

- **Strategy A** — introduce a unified `ProviderRuntimeEvent` schema; each backend emits
  these events and a single adapter maps them to `session:*`. Cleanly separates concerns but
  adds a translation layer for problems that don't yet exist; risks over-modeling the neutral
  model before the second backend's requirements are known.
- **Strategy B** — keep the existing `ContentBlock`/`session:*` IPC contract as the neutral
  model; extract a formal provider interface and shared base; each backend maps its wire
  protocol directly into that shape.

Strategy B was chosen (locked decision — see `docs/codex/implementation-plan.md §0`).

## Decision

Introduce three provider-abstraction modules under `src/main/providers/`:

**`ISession` (`ISession.ts`)** — provider-neutral session interface. Every backend
implements all methods. Provider-specific capabilities (voice, MCP, background tasks, etc.)
are declared via a `SessionCapabilities` constant and gated at the IPC layer — they are NOT
expressed as separate interface methods, so the IPC handlers can call a uniform interface and
check `capabilities.X` rather than `instanceof`.

```ts
interface ISession {
  readonly provider: ProviderId        // 'claude' | 'codex'
  readonly routingId: string
  readonly cwd: string
  readonly capabilities: SessionCapabilities
  readonly willQueue: boolean
  getSessionId(): string | null
  getMessages(): ChatMessage[]
  run(prompt: string | null, attachments?): Promise<void>
  interrupt(): Promise<void>
  cancel(): void
  resolveApproval(requestId, decision, answers?, updatedPermissions?): void
  setModel(model: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setInactivityTimeout(ms: number): void
  dispose(): void
}
```

**`BaseSession` (`BaseSession.ts`)** — abstract class implementing `ISession`. Owns the
provider-neutral plumbing shared across all backends:
- Static `extraWindows` set + `addExtraWindow`/`removeExtraWindow`/`getExtraWindows` (remote
  client broadcast — lifted verbatim from the former private `ClaudeSession` statics).
- Instance fields: `routingId` (mutable for rekey), `win`, `cwd`, `messageHistory`,
  inactivity timer.
- `protected send(channel, data)` — broadcasts to `win.webContents` and all extra windows
  with the routingId envelope.
- Concrete `getMessages()`, `setInactivityTimeout()`, inactivity timer logic.
- `protected baseStatusFields()` — returns `{ provider, capabilities }` for merge into any
  `SessionStatus` object, keeping status construction DRY.

**`ProviderRegistry` (`ProviderRegistry.ts` + `register-providers.ts`)** — singleton factory;
the single place where `new ClaudeSession(...)` or `new CodexSession(...)` is constructed.
`SessionManager` calls `providerRegistry.createSession(providerId, ...args)` rather than
`new ClaudeSession(...)` directly. `register-providers.ts` is a side-effect module imported
once at app bootstrap; adding a third backend = add one `providerRegistry.register()` call
there.

**`SessionCapabilities`** (`src/shared/types.ts`) — frozen per-provider constant:
`CLAUDE_CAPABILITIES` (all flags true) and `CODEX_CAPABILITIES` (subset). The IPC handlers
in `session.ipc.ts` check `session.capabilities.X` before calling any Claude-only method
(`setEffort`, `setThinkingMode`, voice, MCP, background tasks, etc.), making capability
gating the single chokepoint for provider-specific behavior.

**`SessionStatus`** is extended with `provider: ProviderId` and
`capabilities: SessionCapabilities`, emitted on the first status push so the renderer can
feature-gate UI from the moment a session is created.

**`createSession` in `SessionManager`** gains a **trailing** `providerId` parameter (defaulting
to `'claude'`), so all existing Claude call sites are unaffected without change. The same
trailing param is threaded through `ClaudeAPI.createSession` → preload → the `session:create`
IPC handler.

### The neutral model — the deliberate non-decision

The existing `ContentBlock`/`session:*` IPC contract is the neutral model. No separate
`ProviderRuntimeEvent` schema is introduced. Each backend maps its wire protocol directly into
Claude-shaped blocks (e.g. Codex synthesizes `toolUseId` from `item.id`). This avoids
over-modeling at the cost of requiring each new backend to understand the block semantics
rather than defining its own event vocabulary.

## Consequences

- Renderer is largely unchanged: same `session:*` events, same store shapes. It learns the
  active session's `provider` and `capabilities` via `SessionStatus` and gates UI accordingly.
- A third backend requires: a new `ISession` implementation, one `providerRegistry.register()`
  call, one frozen `SessionCapabilities` constant. No IPC layer changes needed.
- Claude behavior is preserved byte-for-byte: `ClaudeSession extends BaseSession` with the
  same logic; `CLAUDE_CAPABILITIES` has every flag true so no handler exits early.
- Capability gating is the single chokepoint for provider-specific IPC/UI. Missing a guard =
  a runtime error for any backend where the capability is false. Mitigation: a unit test that
  feeds a stub `ISession` (all caps false) through every IPC handler.

## Relation to existing ADRs

This ADR sits above the cli.js/SDK-layer ADRs and does not supersede any of them:

- **ADR-006** (rebundle Bun binary) — governs how ClaudeUI packages cli.js; unaffected.
  `ClaudeSession` still calls `sdkQuery()` from `src/main/sdk/` unchanged.
- **ADR-009** (Claude settings.json) — governs where cli.js-consumed settings live;
  unaffected (Codex settings go into UISettings per provider config, not `settings.json`).
- **ADR-014** (native Anthropic OAuth) — governs Claude auth; unaffected. Codex auth is
  fully delegated to the codex binary (see ADR-017 — the opposite of ADR-014).
- **ADR-015** (multi-account file credentials) — governs Claude account switching; unaffected.
  Codex multi-account is a tracked follow-up, deferred from v1.
- **ADR-017** — the companion decision recording the Codex-specific backend implementation.
