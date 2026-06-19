# ClaudeUI V2 — Implementation Plan

> Design is complete (`docs/v2/` foundations 1–6 + persistence; ADR-018..021). This is the **build**
> sequencing. Principle: **design fully, build incrementally** — Claude works at every step; each
> phase is independently reviewable; no big-bang rewrite.

## Sequencing

| Phase | Outcome | Foundation / ADR | Shippable? |
| --- | --- | --- | --- |
| 0 | Rip Codex | ADR-019 | ✅ Claude-only, clean tree |
| 1 | Data model + `provider`→`engine` rename | 1 / ADR-018 | ✅ no UX change |
| 2 | Capability model | 2 / ADR-018 | ✅ |
| 3 | Persistence + settings | 3 + persistence / ADR-020 | ✅ |
| 4 | Auth providers | 4 / ADR-021 | ✅ |
| 5 | opencode engine | ADR-019 | ✅ **MVP — opencode chat** |
| 6 | Tool registry | 6 | ✅ |
| 7 | Metering | 5 / ADR-020 | ✅ |

### Phase 0 — Rip Codex
Remove `src/main/codex/`, `ensure-codex`/`generate-codex-protocol`, `package.json#codexCliVersion`/
`codexProtocolRef`, `getCodexStatus`, `CODEX_CAPABILITIES`, the electron-builder codex extraResources,
and `docs/codex/`. **Keep** the provider scaffolding (`ISession`/`BaseSession`/`ProviderRegistry`,
`ApprovalDecision`, `session:plan`, the provider-tagging mechanism). Unregister `'codex'`. ADR-017
superseded; code recoverable from `codex-sup` history. Leaves a clean Claude-only app.

> **Detailed kickoff for a fresh session: [phase-0-rip-codex.md](phase-0-rip-codex.md)** — verified
> delete/edit/keep lists + step-by-step + verification. Point the new session at that file.

### Phase 1 — Data model + rename
Introduce `EngineId`/`VendorId`/`ModelRef`/`AccountRef`/`SessionDescriptor`; eager rename
`ProviderId`→`EngineId`, `provider`→`engine(Id)` across main/renderer/shared/remote; read-time
migration for persisted `sessionProviders` → `{engineId, model}`. Behavior-preserving.

### Phase 2 — Capability model
`EngineCapabilities` registry + `ModelCapabilities` (incl. the `ReasoningCapability` union) +
`resolveCapabilities()`; add `autonomyModes` + `auth` traits; remove `costUsd` from caps. **Audit
every capability-gated renderer component to react to mid-session capability changes** (the gating risk).

### Phase 3 — Persistence + settings
Stand up the `better-sqlite3` operational DB (wire `electron-rebuild` + per-platform prebuilds).
Refactor config to the config-plane model (edit engines' own files; launch-params at spawn). Re-IA the
SettingsDialog into App / Engines / Vendors / Accounts, capability-gated; apply the tier reclassifications.

### Phase 4 — Auth providers
Extract `EngineAuthProvider`; repackage `AuthManager`+`AccountManager`+service session as
`ClaudeAuthProvider` (no behavior change); per-vendor probe → `VendorAuthMap`; `AuthState`→`AuthFlowState`
rename; account metadata file→DB.

### Phase 5 — opencode engine (MVP milestone)
`ensure-opencode` + vendored binary; `OpencodeServerManager` (shared per-cwd, ref-counted); legacy/v1
protocol client (HTTP+SSE) + pinned `/doc` snapshot + smoke test; `OpencodeSession` + event→ContentBlock
mapper; opencode tool→kind map; `OpencodeAuthProvider` (API-key + paste-code OAuth); hosted-MCP injection.
**Milestone: an opencode session chats, renders tools, handles approvals.**

### Phase 6 — Tool registry
`ToolKind` taxonomy + `TOOL_RENDERERS` registry; unify the three dispatch sites; shared `ToolCard` shell
+ extracted `<ApprovalButtons>`; port existing cards to kinds (behavior-preserving for Claude); lift
`question`/`plan`/`todo` to the interaction layer. Coverage polish deferred.

### Phase 7 — Metering
`usage_event` recorder (live events) + ongoing backfill reconciler (Claude JSONL scan; opencode via API);
internal pricing table (external models.dev opt-in); equivalent API cost as the primary metric;
subscription windows behind the per-account usage provider (Claude provider = ADR-011 logic); dashboard
→ SQL queries.

## Review gates
Open PRs after **Phase 1** (pure refactor — de-risks the rename) and **Phase 5** (opencode MVP). Phases
3/4 are independently reviewable infra. Keep phases as stacked PRs on the V2 branch.

## Risks
- **opencode v1↔v2 API churn** — pin the binary + snapshot `/doc` + smoke-test wire shapes (ADR-019).
- **Rename blast radius** (Phase 1) — wide but mechanical; lean on the type-checker + the persisted-key migration.
- **Mid-session capability re-resolution** (Phase 2) — the renderer audit is the gating risk; an all-caps-false stub test helps.
- **Native DB module** (Phase 3) — `electron-rebuild` per Electron bump + per-platform prebuilds in CI.
