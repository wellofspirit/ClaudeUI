# Phase 9 — Usage Analytics: engine split + metering follow-ups

> Resolves the Phase-7 metering deferrals plus a UX restructure of the Usage view. Two stacked
> branches: **9a** (metering correctness, main-process only, no UI) and **9b** (engine-split
> dashboard + opencode-sourced pricing, main + renderer). Follows the ADR-024-era cadence:
> Opus orchestrates + reviews, a Sonnet agent writes the code, one commit per branch.

## Locked design decisions (user-confirmed this session)

1. **Layout** — Claude's windowed features (Current Block / Block Timeline / 5hr Window / Recent
   Blocks) collapse into ONE card with a 4-tab group. A flat **opencode section** sits beneath it
   (per-model tokens + cost, no windows). ONE all-engine **Daily Usage** chart at the bottom. The
   old standalone "By Engine" table is dropped (the Claude/opencode split replaces it).
   Reference mockup: `.claude/ui/mockups/baabad42/index.html`.
2. **Pricing** — sourced from opencode's `/config/providers` (it vendors models.dev) + a manual
   "refresh prices" button. Built-in Anthropic table stays as baseline. **The models.dev network
   fetch stub is removed** — no phoning home.
3. **Subagent usage** — recorded as its own `usage_event` under the **child's own model** + child
   sessionId; surfaces in the engine/model breakdown. Never attributed to the parent.
4. **WLS projection** — reads `usage_window_sample` (survives app restart). Minor numerical drift
   vs the in-memory ring is accepted.

Settled, not re-asked: opencode's displayed cost comes from its **own reported `engineCostUsd`**
(authoritative); an **opencode-idle → recompute** trigger is added so the section updates live.

## Verified facts (grounding — do NOT re-discover)

- **opencode reports real cost.** `event-mapper.ts:326-343` reads `info.cost` (cumulative
  per-message USD), emits `cost_update.engineCostUsd`; `OpencodeSession.ts:1022` records it as
  `engineCostUsd`.
- **opencode exposes a per-model price table.** `ConfigProvidersResponse.providers[].models[].cost`
  = `{ input, output, cache?: { read, write } }` (`protocol/types.ts:13-23, 35-38`), fetched via
  `OpencodeClient.getConfigProviders()` (`OpencodeClient.ts:64-66`). `model-discovery.ts` has the
  acquire-server → fetch → release pattern to reuse. **Cost unit is models.dev's USD-per-1M-tokens
  — VERIFY on a live probe before converting to `ModelPricing` (per-MTok).**
- **opencode message info carries `providerID` + `modelID`** (`OpencodeClient.ts:137` reconciler
  comment; the reconcile parse reads them). The OWN path doesn't use them (it uses the session's
  selected model via `parseModelString(this._model)`); the CHILD path currently captures neither.
- **"By Engine" already exists** (`UsageView.tsx:73-78`), gated on `perEngine.length>0`. Built by
  `block-usage.computePerEngine` (`block-usage.ts:819-841`) from `usage_event` over the last 7d.
- **perEngine only recomputes inside `block-usage.recalculate()`/`rebuildFromEntries`, triggered by
  the Claude usage poll — NOT by opencode turns.** This is why opencode usage lags / looks empty.
- **opencode cost attribution is backwards.** `computePerEngine` uses `equivCostUsd ?? engineCostUsd`
  (`block-usage.ts:831`); the daily rollup prefers `equivCostUsd` for non-claude
  (`block-usage.ts:960`). For opencode, `engineCostUsd` is authoritative (and `0` is a *valid* real
  cost for free models — only `null` should fall back).
- **`usage_window_sample` IS written every poll** — `usage-fetcher.ts:534` (`recordWindowSampleFromUsage`,
  505-544) writes `{ ts, accountUuid: activeAccount.uuid, usedPercent, canonicalEnd:
  canonicalizeWindowEnd(resetMs) }`. **No tokens in the row.** Read via `getWindowSamples(accountUuid,
  limit=100)` (`db.ts:722-729`), rows ordered `ts ASC`.
- **WLS internals** — in-memory ring `projectionSamples` (`block-usage.ts:407`), filled by
  `updateProjection` (1191-1243) which pushes `{ timestamp: now, tokens: totalTokens(block.tokens)
  AT POLL TIME, apiPercent }`; `computeProjectionWLS` (1257-1264) delegates to the **pure**
  `computeWLS` in `usage-aggregation.ts` (proven byte-identical by the equivalence test — **do NOT
  touch the math**). Window-change reset keys off `currentWindowEnd !== projectionWindowEnd` (the
  canonical end).
- **opencode child accumulator** (`event-mapper.ts` `MessageAccumulator`, 34-58): has `isChild`,
  but **no `model`, no `childSessionId`**. `handleChildEvent` `message.updated` (464-498) captures
  `role` + `tokens` but deliberately **not `cost`**. `sumAccumulatorCosts` (588-591) sums **all**
  accumulators. `recordTurnUsage` skips `isChild` (`OpencodeSession.ts:1001`); `sendMetering` skips
  `isChild` (1047). Both are called from the `'result'` case (`OpencodeSession.ts:558-569`).
- **Claude subagents need NO change** — Claude child turns are ordinary assistant messages in the
  JSONL with their own per-message model, already counted by block-usage. #1 is opencode-only.
- **`BlockUsageData`** (`shared/types.ts:1122-1154`): `perEngine?: EngineUsageSummary[]`;
  `EngineUsageSummary = { engineId, tokens, costUsd, requestCount }`. Pushed to the renderer over
  `usage:block-data` → `setBlockUsage` (`session-store.ts:2168`). The sidebar wheel
  (`UsagePanel.tsx:114`) reads `blockUsage.currentBlock` — **keep backward-compatible**.

---

## Branch 9a — `v2-phase-9a-metering-followups` (main only, no UI)

### #1 — Meter opencode subagent usage under the child's own model

**`event-mapper.ts`**
- `MessageAccumulator`: add `childSessionId?: string` and `model?: { providerID: string; modelID: string }`.
- `handleChildEvent` `message.updated` (≈464): set `acc.childSessionId = childSessionId`; capture
  `acc.model = { providerID: info.providerID, modelID: info.modelID }` when both present; **capture
  `acc.cost = info.cost`** (children now store cost — was deliberately skipped). Do NOT emit a
  `cost_update` for children (keep returning `{kind:'ignore'}`).
- `sumAccumulatorCosts` (588): **skip `if (acc.isChild) continue`.** Critical — now that children
  carry `cost`, this prevents child cost leaking into the parent turn's `totalCostUsd`/`cost_update`
  (own path calls it at line 334).

**`OpencodeSession.ts`**
- `recordTurnUsage` (992): **remove** the `if (acc.isChild) continue` skip. Per recordable assistant
  accumulator:
  - **own** (`!acc.isChild`): vendorId/modelId from `parseModelString(this._model)`, `sessionId =
    this.openSessionId`, account from `buildAccountRef(ownProviderID)` — unchanged.
  - **child** (`acc.isChild`): vendorId/modelId from `acc.model` — **if absent, skip + `logger.debug`
    (never record a child under the parent model)**; `sessionId = acc.childSessionId`; account from
    `buildAccountRef(acc.model.providerID)`; `engineCostUsd = acc.cost ?? null`. Tokens from `acc.tokens`.
  - dedup via `recordedUsageMessageIds` unchanged (messageIds are distinct per child message).
- `sendMetering` (1036): **keep skipping children.** The MeteringSnapshot is the parent turn's live
  per-model meter; children are separate `usage_event`s. Add a one-line code comment noting this is
  intentional (children metered via `recordUsageEvent`, not the live snapshot).

**Docs:** mark the Phase-7 subagent-metering deferral (`phase-7-metering.md:121-127`) resolved in 9a.

**Tests:**
- `event-mapper.test.ts`: a child `message.updated` with `info.{providerID,modelID,cost,tokens}` →
  accumulator gets `model`, `childSessionId`, `cost`, `tokens`; `sumAccumulatorCosts` over a
  parent+child set EXCLUDES the child (guard: set a non-zero child cost, assert parent total
  unchanged). A child `message.updated` without model fields → `acc.model` undefined.
- `OpencodeSession.test.ts` (extend the child fixture ≈2304): after `result`, a child
  `usage_event` is recorded under the **child** model + child sessionId, distinct from the parent's
  row. Guard: child with no model → NOT recorded (no row under parent model).

### #2 — DB-source the WLS projection (survive restart)

Build `ProjectionSample[]` from the DB instead of (only) the in-memory ring:
- Obtain the **active account UUID** (expose `usageFetcher.getActiveAccountUuid()` returning
  `this.activeAccount?.uuid`, or reuse block-usage's `emailToUuid` map via
  `accountForTimestamp(accountLog, now)`).
- `getWindowSamples(activeAccountUuid)` → filter to `canonicalEnd === currentWindowEnd` (the block's
  window). For each sample build `{ timestamp: sample.ts, tokens: cumTokensAt(sample.ts),
  apiPercent: sample.usedPercent }`, where `cumTokensAt(ts)` = `Σ totalTokens` of the **current
  block's** entries with `entry.timestamp <= ts`.
- Thread the current block's entries (the `AggEntry`/`ParsedEntry` slice already in scope in
  `rebuildFromEntries`, line ~757) into `updateProjection`/`computeProjectionWLS` so `cumTokensAt`
  can be computed. Feed the rebuilt samples into the **unchanged** pure `computeWLS`.
- **Replace** the in-memory ring as the source (drift accepted). Retire `projectionSamples` /
  `MAX_PROJECTION_SAMPLES` / the per-poll push, OR keep the ring only as a fallback when the DB has
  zero samples for the window — agent's call; prefer the simplest correct version. Preserve the
  "pause projection when no window / window expired" guards (`updateProjection` 1196-1201).
- **Ordering note:** `recordWindowSampleFromUsage` runs inside `usage-fetcher.pushToRenderer` (≈492)
  before `usage:data` is sent; block-usage's recalc reads samples on its own cadence — so the
  freshest sample may lag one cycle. Acceptable per the drift decision; note it.

**Tests:** DB-sourced projection equals the in-memory result on a fixture where token-at-ts
reconstruction matches (construct `usage_event` + `usage_window_sample` fixtures, reuse the WLS
equivalence fixtures); projection still produced after a simulated restart (samples in DB,
in-memory ring empty).

### 9a verify + commit
`bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`. No UI →
gate via a verification subagent; optional live opencode subagent drive.
Commit: `feat(v2/metering): meter opencode subagent usage + DB-sourced WLS projection (Phase 9a)`.

---

## Branch 9b — `v2-phase-9b-usage-engine-split` (main + renderer; delegate UI rewrite)

### Data + cost fixes (main)
- `EngineUsageSummary` (`shared/types.ts:1149`): add `models: ModelTokenBreakdown[]`.
- `perEngineBreakdown` (`usage-aggregation.ts:441`): add an inner per-`(engineId, modelId)` grouping
  → populate `models[]` (reuse `mergeModelFamilies`? — for opencode keep raw model ids; only Claude
  needs family-merge, and the Claude section doesn't use this. Keep opencode models raw).
- `computePerEngine` (`block-usage.ts:819`) **and** the daily rollup (`block-usage.ts:960`): cost per
  row = `engineId==='claude' ? (engineCostUsd ?? equivCostUsd ?? 0) : (engineCostUsd ?? equivCostUsd ?? 0)`
  — i.e. **prefer `engineCostUsd` for opencode** (treat `0` as valid; only `null` falls back).
- **opencode-idle recompute trigger:** in `OpencodeSession.ts` `'result'` case (after
  `recordTurnUsage`, ≈563) call `blockUsageService.recalculate()` fire-and-forget (`.catch(()=>{})`),
  debounced if trivial. Import the singleton from `../services/block-usage`. Keeps the opencode
  section live without waiting for a Claude poll.

### Pricing (main)
- New `src/main/services/opencode-pricing.ts`: `refreshPrices()` acquires a server (reuse
  `model-discovery`'s acquire/release), calls `getConfigProviders()`, extracts `{ providerID,
  modelID, cost }` for every model with a `cost`, converts to `ModelPricing` (**confirm unit on the
  live probe** — expected USD/MTok), persists to `~/.claude/ui/opencode-prices.json`, and calls a
  pricing registrar. On boot, load the persisted file and register it.
- `pricing.ts`: add `registerSupplementalPricing(entries: PricingEntry[])` (in-memory) + consult it
  in `findPricing` **after** the built-in table (built-in Anthropic stays authoritative). Keep
  `pricing.ts` **pure** (no fs/electron) — main owns the file I/O and calls the registrar.
- **Remove `externalPricingStub`** + the models.dev TODO/resolution-order note.
- IPC `usage:refresh-prices` → `opencodePricing.refreshPrices()` → `{ count, refreshedAt }`. Wire
  preload + `ClaudeAPI.refreshPrices()` + store action. Add to the remote dispatcher blocklist
  (spawns a local server — desktop-only).

### UI rewrite (`UsageView.tsx`) — delegate, mockup `baabad42` is the reference
- Claude card with a **4-tab group** (local `useState`): Current Block / Block Timeline / 5hr Window
  / Recent Blocks. **Move the existing sub-components verbatim into panels** — `CurrentBlockCard`,
  `BlockTimeline` (`Section`-wrapped), `ApiUsageBar`, and the Recent-Blocks `BlockRow` list. No
  behavior change inside them.
- **opencode section** from `perEngine.find(e => e.engineId==='opencode')`: summary row
  (tokens / cost / requests) + per-model table (`models[]`); a `↻ refresh prices` button →
  `window.api.refreshPrices()`; render only when an opencode entry exists (else absent).
- **Daily Usage** (all engines) at the bottom — `DailyUsageChart`, unchanged.
- **Drop** the standalone `PerEngineTable` / "By Engine" section.
- Claude-only users see exactly today's content, just tabbed; the sidebar `UsagePanel` wheel is
  untouched.

**Tests:** `UsageView` renders the Claude tab group + switches panels; opencode section renders
per-model rows from `perEngine`; refresh-prices button invokes the IPC. Per-engine-per-model
aggregation unit test. Keep existing usage tests green (adjust only for By-Engine removal).

### 9b verify + commit
All gates + **verifier-electron runtime smoke**: open Usage → assert Claude tab group, switch tabs,
opencode section (run an opencode free-model turn first to populate, else assert empty-state) —
read the PNG. Commit: `feat(v2/usage): engine-split dashboard + opencode-sourced pricing (Phase 9b)`.

---

## Out of scope
- Claude subagent re-metering (already correct via JSONL).
- ChatGPT-via-opencode windows (no usage API exposed to us).
- models.dev network fetch (removed, not re-added).
- Daily-chart Claude-only filter (#11) — folded away; daily stays all-engines per the locked layout.
- Retiring the legacy JSONL usage files (kept a release as fallback).

## Gotchas
- **Child-cost double-count**: `sumAccumulatorCosts` MUST skip `isChild` the moment children start
  capturing `cost` (9a #1) — else parent turn totals inflate.
- **WLS drift** is inherent to token-at-ts reconstruction from percent-only samples — accepted.
- **`pricing.ts` stays pure** (it lives in `shared/`) — no fs/electron; main owns I/O + the registrar.
- **models.dev cost unit** (per-MTok vs per-token) — verify on a live `getConfigProviders` probe.
- **No `bun install`/`add`** (better-sqlite3 ABI). 9a is main-process only.
- **Don't break the sidebar wheel** (`UsagePanel`) — `BlockUsageData` additions are additive.
- **No AI attribution** in commits.
