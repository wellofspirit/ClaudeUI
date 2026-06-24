# Phase 1 — Data model + `provider`→`engine` rename (implementation kickoff)

> **You are implementing Phase 1 of the V2 plan** ([implementation-plan.md](implementation-plan.md)).
> It is a **behavior-preserving refactor**: rename `provider`→`engine` app-wide, introduce the
> data-model identity types, and wrap the session model into a vendor-qualified `ModelRef`. **No
> UX change.** Read this fully, then [01-data-model.md](01-data-model.md) §3/§7/§8 and
> [../adr/adr-018_v2-engine-vendor-account-model.md](../adr/adr-018_v2-engine-vendor-account-model.md).

## Background

Phase 0 removed Codex and left `ProviderId = 'claude'` plus the provider scaffolding intact. Phase
1 makes the vocabulary match the V2 model: **engine** (the harness) is the primary axis; **vendor**
(model maker) and **account** are sub-axes. "provider" is ambiguous and collides with opencode's
term for *vendor*, so we rename eagerly (data-model §8). We also vendor-qualify the model identity
(`ModelRef`) so a model is never a bare string once an engine can run many vendors' models.

This is the **"pure refactor" PR** that de-risks the rename (plan review-gate). It must stay
behavior-preserving — lean on the type-checker and the persisted-key migration.

## Scope decisions (already made — flagged for veto)

1. **`EngineId = 'claude' | 'opencode'`** — widen the union now (type only; `'codex'` stays gone).
   The engine **registry/factory stays claude-only** (no opencode backend until Phase 5). Per the
   locked data model §3.1 and the Phase 0 hand-off note.
2. **ModelRef wrap = full**, bounded to the **session model identity**: `SessionStatus.model`
   becomes `ModelRef`. The internal `ClaudeSession.model`, store `selectedModel`, and the
   `setModel(model: string)` IPC **stay `modelId` strings** (single-vendor in Phase 1; revisit the
   UI-selection path in Phase 5 when the picker spans vendors). See the seam below.
3. **Per-session model persistence** — `sessionEngines` gains an optional `model: ModelRef`. New
   sessions write it; on reopen we **seed `selectedModel` from it when present** (small, sensible;
   the one intentional behavior addition — avoids dead persisted data). Legacy records (no model)
   behave exactly as today.
4. **Defer to later phases (do NOT introduce here):** `EngineCapabilities`/`ModelCapabilities`/
   `ResolvedCapabilities` and `ModelDescriptor` (Phase 2 — they need the capability taxonomy);
   real `AccountRef` resolution + auth probes (Phase 4); `MeteringSnapshot` (Phase 7); the SQLite
   persistence plane (Phase 3). Keep the existing frozen `SessionCapabilities`/`capabilitiesFor`
   mechanism (just renamed) and `SessionStatus.totalCostUsd` as-is.
5. **Do NOT introduce `SessionDescriptor`/`EngineDescriptor`/`VendorDescriptor` aggregates yet** —
   their members (`ResolvedCapabilities`, `MeteringSnapshot`, `EngineCapabilities`) don't exist
   until Phases 2/7. Introducing them now means placeholder types that will be rewritten — over-
   engineering. `SessionStatus` stays the runtime session type (with renamed fields + `ModelRef`).

> Net: Phase 1 introduces the **identity keys** (`EngineId`, `VendorId`, `ModelRef`, `AccountRef`)
> and does the rename + model wrap. The descriptor/aggregate types land with their members later.

## RENAME map (mechanical — the type-checker enumerates every site)

After editing `shared/types.ts`, run `bun run typecheck`; every break is a site to fix.

| From | To | Notes |
| --- | --- | --- |
| `ProviderId` | `EngineId` | widen to `'claude' \| 'opencode'` |
| `SessionStatus.provider` | `.engineId` | |
| `SessionInfo.provider` | `.engineId` | legacy default still `'claude'` |
| `ISession.provider` (+ `BaseSession`) | `.engineId` | abstract member + `baseStatusFields()` |
| `ProviderSessionFactory` | `EngineSessionFactory` | |
| `ProviderRegistry` / `providerRegistry` | `EngineRegistry` / `engineRegistry` | class + singleton + `ProviderRegistry.ts`→`EngineRegistry.ts` |
| `register-providers.ts` | `register-engines.ts` | file rename; update the import in `session-manager.ts` |
| `capabilitiesFor(provider)` | `capabilitiesFor(engineId)` | body unchanged (returns `CLAUDE_CAPABILITIES`) |
| `createSession(..., providerId?)` | `..., engineId?` | IPC + preload + web-adapter + session-manager + registry |
| renderer `selectedProvider` | `selectedEngineId` | store field + all consumers |
| renderer `lastSelectedProvider` (+ setter, localStorage key) | `lastSelectedEngineId` / `lastSelectedEngine` | localStorage read-fallback to the old key |
| persisted `sessionProviders` | `sessionEngines` | shape change + migration (below) |
| `ProviderToggle.tsx` / `ProviderLogo.tsx` | `EngineToggle.tsx` / `EngineLogo.tsx` | file renames + all imports/usages |

Keep names that are genuinely about *vendor/account* unchanged. There are none today (everything
"provider" means engine), but do not rename usage-analytics model strings or cli.js env config.

## ModelRef wrap — the seam (precise)

Add to `shared/types.ts`:

```ts
export type EngineId = 'claude' | 'opencode'
export type VendorId = 'anthropic' | 'openai' | 'google' | 'local' | (string & {})

export interface ModelRef {
  engineId: EngineId
  vendorId: VendorId
  modelId: string            // 'claude-opus-4-8', 'default', etc.
}

/** Construct a Claude ModelRef (engine 'claude' is 1:1 with vendor 'anthropic'). */
export function claudeModel(modelId: string): ModelRef {
  return { engineId: 'claude', vendorId: 'anthropic', modelId }
}
```

Apply:
- `SessionStatus.model: string | null` → **`model: ModelRef | null`**.
- `ClaudeSession` keeps `private model: string`; when it builds a `SessionStatus`, wrap:
  `model: this.model ? claudeModel(this.model) : null`. (`this.model` defaults to `'default'` →
  `claudeModel('default')`.) Do **not** wrap the unrelated `model:` at the result/usage event
  (`(msg.model as string) || this.model || 'unknown'`) — that is not `SessionStatus.model`.
- Every **consumer of `status.model`** (status line, sidebar model display, comparisons) reads
  `status.model?.modelId`. Comparisons like `status.model === selectedModel` become
  `status.model?.modelId === selectedModel`.
- **Leave as plain `string`:** `ClaudeSession.model`, store `selectedModel`, `setModel(model)`
  IPC/preload, `ModelInfo.value`, `ModelOverrideSettings.model`, `Automation.model`, and all
  usage-analytics model names. Only `SessionStatus.model` (and the persisted `ModelRef`) are wrapped.

Also introduce (declarations only — vocabulary for Phase 4, unused now, with a `// wired in Phase 4`
note): `AccountRef`, `BillingType`, `AuthState` exactly as in data-model §3.4.

## Persisted migration — `sessionProviders` → `sessionEngines`

```ts
// shared/types.ts (UISessionConfig) + main/services/ui-config.ts
sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
```

`ui-config.loadSessionConfig()` read-migration (replaces the current `sessionProviders`→`'claude'`
coercion):
1. If `config.sessionEngines` exists, leave it (clamp any `engineId !== 'claude' && !== 'opencode'`
   to `'claude'`).
2. Else if legacy `config.sessionProviders` exists, convert each `Record<sid, string>` entry to
   `{ engineId: 'claude' }` (every legacy value — incl. `'codex'` — maps to `'claude'`; model was
   never persisted, so omit it). Delete the old `sessionProviders` key.
3. New writes set `{ engineId, model: claudeModel(selectedModel) }`. On session reopen, when a
   persisted `model` is present, seed the store `selectedModel = model.modelId` (decision §3).

Mirror the store-side rename: `session-store` `sessionProviders` → `sessionEngines`, and the
`applyExternalSessionConfig` / `createNewSession` / `rekeySession` paths that read/write it.

## Step-by-step

1. **Branch** `v2-phase-1-engine-rename` (already created off `v2-phase-0-rip-codex`). Do **not**
   commit; leave the tree modified for review.
2. `shared/types.ts`: rename `ProviderId`→`EngineId` (widen), add `VendorId`/`ModelRef`/`claudeModel`/
   `AccountRef`/`BillingType`/`AuthState`, change `SessionStatus.model`→`ModelRef|null` and
   `.provider`→`.engineId`, `SessionInfo.provider`→`.engineId`, `UISessionConfig.sessionProviders`→
   `sessionEngines`, `createSession` param `providerId`→`engineId`.
3. `bun run typecheck` → fix every break (the rename map + the `status.model?.modelId` reads).
4. Rename the provider files/symbols (`EngineRegistry`, `register-engines.ts`, `Engine{Toggle,Logo}`).
5. `ui-config.ts` + store: the `sessionEngines` migration + reads/writes; the `selectedModel` seed.
6. Renderer: `selectedEngineId`/`lastSelectedEngineId`, `Engine{Toggle,Logo}` usages, model-picker
   and status-line `status.model?.modelId`.
7. Tests: rename throughout; update any `provider`/`sessionProviders`/`status.model` assertions to
   the new names/shape. Add a test for the `sessionProviders`→`sessionEngines` read-migration and
   for `claudeModel()` / `SessionStatus.model` being a `ModelRef`.
8. **Update `CLAUDE.md`**: the "Provider Abstraction" section → "Engine Abstraction"; `ProviderId`→
   `EngineId`; note `ModelRef`. Update the `src/main/providers/` file list (`register-engines.ts`,
   `EngineRegistry.ts`).
9. **Sweep:** `rg -iw "provider|providerId|ProviderId|sessionProviders|selectedProvider" src` returns
   nothing except genuine vendor/opencode-API meanings (none yet). Resolve every hit.

## Verify

```
bun run typecheck      # clean
bun run test           # green
bun run test:ci        # + git project, green
bun run lint           # 0 errors (3 pre-existing exhaustive-deps warnings are fine)
bun run build          # succeeds
```
Then a **runtime smoke** via the `verifier-electron` skill (`node scripts/app-shot.mjs`): the app
launches, the model picker shows a model, switching/opening a session works, and no `provider`-era
breakage. Read the screenshot.

## Gotchas

- **Behavior-preserving.** The only intentional behavior delta is the persisted model seed (§3). If
  it complicates anything, persist the model but skip the read-seed (capture-only) and flag it.
- **`status.model` is now an object** — any place doing `=== string`, string templating, or `.model`
  display must read `.modelId`. The type-checker catches most; the status line / sidebar are the
  visible ones (smoke-test them).
- **localStorage `lastSelectedProvider`** — read the old key as a fallback so existing users don't
  lose their last engine on first launch after the rename.
- **Don't over-introduce types.** Only `EngineId`/`VendorId`/`ModelRef`/`AccountRef`(+`BillingType`/
  `AuthState`). Descriptors/aggregates/capability types come with their members in Phases 2/7.
- **`EngineId` now has `'opencode'`** but no factory — a `switch (engineId)` that assumed only
  `'claude'` should keep a `'claude'`/default path; don't add opencode logic.

## Commit

Branch off `v2-phase-0-rip-codex`; no AI attribution. Suggested:
`refactor(v2): rename provider→engine + introduce data-model identity types (Phase 1)`.
