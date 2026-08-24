# ADR-018: V2 multi-engine model — engine / vendor / account split + capability model

**Status:** Accepted (V2 design; implementation complete. The detailed `docs/v2/` design docs were removed after V2 shipped — recoverable from git history.)
**Date:** 2026-06-19
**Supersedes:** [ADR-016](adr-016_provider-abstraction.md)

## Context

ClaudeUI is re-platforming from a Claude-Code desktop client into a **multi-engine** app, pivoting
the second backend from Codex to **opencode** (a meta-harness that itself spans many model vendors).
ADR-016 introduced a provider abstraction (`ISession`/`BaseSession`/`ProviderRegistry`), but it
covered only the **session layer** (~20% of the app). The rest — usage, settings, MCP/skills/
permissions, auth, persistence — hard-coded Claude. And the term "provider" conflated three
independent concepts, which opencode forces apart (one engine, many vendors, many billing models;
switching model mid-session changes all three).

This ADR records the core data + capability model; companions ADR-019/020/021 record opencode,
persistence/config, and auth. (The full `docs/v2/` foundation docs were removed post-ship; the
implemented model lives in `src/shared/types.ts` and `src/shared/model-capabilities.ts`.)

## Decision

**Separate the three layers** previously fused as "Claude":

- **Engine** — the harness running the agent loop (`EngineId = 'claude' | 'opencode'`; `'codex'`
  reserved/dormant). Owns session protocol, tool set, permission system, config plane, persistence,
  slash commands, skills, MCP wiring. **Rename `ProviderId` → `EngineId`** app-wide ("provider"
  collides with opencode's term for _vendor_).
- **Vendor** — the model maker (`VendorId`, open-ended: anthropic/openai/google/local/…). Owns the
  model list, model capabilities, token accounting. Engine→Vendor is 1:1 for Claude, 1:N for opencode.
- **Account** — credential + metering identity per (engine × vendor); a derived `AccountRef`
  `{ billingType, authState, label?, accountId? }`.

**Core entities** (implemented in `src/shared/types.ts`): `EngineDescriptor`, `VendorDescriptor`,
`ModelRef {engineId, vendorId, modelId}` (the universal selection/persistence key),
`AccountRef`, and `SessionDescriptor` binding them. **`engineId` is immutable per session;**
`model`/`account`/`capabilities`/`metering` are mutable mid-session (model switching re-resolves them).

**Capability model** (implemented in `src/shared/model-capabilities.ts`) — replace ADR-016's frozen per-provider
`SessionCapabilities` constant with a **computed** value:

- `EngineCapabilities` (vendor-independent: voice, hostedMcp, backgroundTasks, subagents, plan,
  fork, steer/queue, slashCommands, skills, sideQuestion, `autonomyModes`, `auth{canDriveLogin,
multiAccount}`).
- `ModelCapabilities` (per model: `reasoning` as **two independent axes** `{ thinking?, effort? }`
  — a model may expose both, as Claude does — plus vision, toolCalling, contextWindow…).
- `ResolvedCapabilities = resolve(engine, model)` — a field merge plus AND-of-both for
  tool-dependent features (`canUseMcp = hostedMcp && toolCalling`). **Recomputed on session start
  and every model switch.**
- `costUsd` is **removed** from capabilities — it's a billing fact (→ metering, ADR-020/foundation 5).

This **generalizes** ADR-016 rather than discarding it: `ISession`/`BaseSession`/`ProviderRegistry`
and the "ContentBlock/`session:*` IPC contract is the neutral model" decision are retained; only
`ProviderId`→`EngineId` and frozen-caps→computed-caps change.

## Consequences

- The renderer gates UI on `ResolvedCapabilities` and must **react to mid-session capability
  changes** (today it sets them once) — a renderer audit of every capability-gated component.
- Adding an engine = an `EngineDescriptor` + capability declaration + a tool→kind map (ADR for tool
  rendering, foundation 6) + an `EngineAuthProvider` (ADR-021). The `ISession` seam from ADR-016 stays.
- The `provider`→`engine` rename is a wide but mechanical diff (IPC fields, store keys, persisted
  `sessionProviders` → per-session `{engineId, model}`, remote protocol) with a read-time migration.
- Claude behavior is preserved; Codex backend code is removed (recoverable from `codex-sup` history).

## Relation to existing ADRs

- **Supersedes ADR-016** — generalizes the provider abstraction to the engine/vendor/account model
  and the computed capability model.
- **ADR-017** (Codex backend) is superseded by **ADR-019** (opencode backend).
- Companions: **ADR-019** (opencode engine), **ADR-020** (persistence + config-plane), **ADR-021**
  (auth/account). Amends the framing of **ADR-009/011/014/015** (recorded in those companions).
