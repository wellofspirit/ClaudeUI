# Phase 7 — Metering & usage (DB-backed, full SQL) — LAST V2 plan phase

> Implements [foundation 5](05-metering-usage.md) + ADR-020 (metering). Moves usage onto the
> operational SQLite DB: a live `usage_event` recorder (both engines) + an ongoing backfill reconciler
> + an internal multi-vendor pricing table + equivalent-API-cost as the primary metric + a
> `MeteringSnapshot` per session; and **rewires the dashboard aggregations to SQL** (foundation §8/§10,
> user-chosen "Full SQL"). **The valued Claude usage feature — 5h windows, burn rate, WLS capacity
> projection — must be preserved exactly (now SQL-sourced).** After this, V2 is feature-complete.

Two review passes under one `v2-phase-7-metering` branch + one commit:
- **Pass 1** — recording substrate (additive, low-risk): DB tables + repos + internal pricing +
  equivalent-cost + the live `usage_event` recorder fed by BOTH engines. No dashboard/status-line UI
  change yet.
- **Pass 2** — the reconciler (Claude JSONL repurposed + opencode via API) + dashboard→SQL aggregations
  (blocks/daily/per-model/**per-engine**) + WLS sourced from the DB + `MeteringSnapshot` + per-account
  usage-provider abstraction + per-`billingType` reporting. The risky, behavior-preserving pass.

## Verified current stack (from a full read — PRESERVE the Claude feature)

- **`block-usage.ts`** — `MODEL_PRICING` (`Array<{match, pricing:{inputPerMTok, outputPerMTok,
  cacheWritePerMTok, cacheWrite1hPerMTok, cacheReadPerMTok}}>`, ~:69-198), `calculateCostFromTokens(model,
  in, out, cacheCreate, cacheCreate1h, cacheRead)` (~:225-244), JSONL scan of `~/.claude/projects/**/*.jsonl`
  → `ParsedEntry {timestamp, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
  costUsd, messageId}` (dedup by messageId, last 7d), `UsageBlock` (5h-aligned, burnRate, projectedUsage,
  models[], finalApiPercent, windowAligned), and the **WLS projection** (~:870-978): ring buffer of
  `{timestamp, tokens, apiPercent}` (30 samples, 5-min half-life decay), `tokens = k·apiPercent`,
  `k = Σ(wᵢtᵢpᵢ)/Σ(wᵢpᵢ²)`, output `{tokens: k·100, costUsd}`; single-point fallback < 3 samples.
  **Preserve the algorithm verbatim** — only change where samples come from (DB, Pass 2).
- **`usage-fetcher.ts` / `usage-windows.ts` / `service-session.ts`** (ADR-011) — `/api/oauth/usage`
  poll + `rate_limit_event` → `AccountUsage {fiveHour, sevenDay…: RateWindow{usedPercent, resetsAt}}`;
  `canonicalizeWindowEnd` (round-to-min, ±2min snap); `accountForTimestamp(log, ts)` from
  `account-log.jsonl {ts, accountUuid, email}`; `usage-cache.json`. IPC `usage:data`→store `accountUsage`.
- **Session cost** — `claude-session.ts` accumulates per-msg `total_cost_usd` + tokens →
  `StatusLineData` (types.ts) → `session:status-line` → store. OpencodeSession accumulates
  `totalCostUsd` (cost_update from `message.updated` info.tokens/cost in the 5b mapper) but does NOT
  surface tokens to the dashboard at all (opencode has NO usage analytics today — the headline gap).
- **Dashboard** (`renderer/.../usage/`) — `UsageView` reads `blockUsage: BlockUsageData` (IPC
  `usage:block-data`, `fetchBlockUsage`) + `accountUsage`. `CurrentBlockCard`/`BlockTimeline` are
  coupled to `UsageBlock` (tokens/costUsd/burnRate/projectedUsage/models); `DailyUsageChart` uses flat
  daily aggregates (loosely coupled); `usage-utils.ts` = pure formatters. WLS shown at `UsageView.tsx`
  ~:226-241 ("Window Capacity ~X · $Y").
- **DB** (`db.ts`) — v1 `session_meta`, v2 `account`; `user_version` migration list (`MIGRATIONS`,
  add `{version, up}` + bump); typed repos (no raw db); test stub `better-sqlite3-stub.ts` (node:sqlite,
  `:memory:`, user_version round-trips). **Extend this pattern — do NOT expose raw db.**
- **Tests** — `block-usage.test.ts` (pricing/cost/projection/blocks), `usage-fetcher*.test.ts`,
  `usage-windows.test.ts`, `usage-utils.test.ts`, `useClaudeEvents` usage IPC. Keep green / migrate intent.

## Pass 1 — recording substrate

1. **DB migrations** (`db.ts`, new versions):
   - `usage_event(id TEXT PK, ts INTEGER, engine_id TEXT, vendor_id TEXT, account_id TEXT, account_uuid
     TEXT, model_id TEXT, input_tokens INT, output_tokens INT, cache_write_tokens INT,
     cache_write_1h_tokens INT, cache_read_tokens INT, equiv_cost_usd REAL, engine_cost_usd REAL,
     session_id TEXT, message_id TEXT, source TEXT)` — indexes `(ts, engine_id)`, `(session_id)`,
     `(account_uuid, ts)`, and **`UNIQUE(message_id)`** (dedup: live + reconciler converge; use
     `INSERT … ON CONFLICT(message_id) DO NOTHING`/upsert). `source` ∈ `'live'|'backfill'`.
   - `usage_window_sample(id TEXT PK, ts INTEGER, account_uuid TEXT, used_percent REAL, canonical_end
     INTEGER)` — the ADR-011 window observations over time (feeds the WLS apiPercent series + 5h block
     alignment in Pass 2). Index `(account_uuid, ts)`.
   - Typed repos: `insertUsageEvent`/`insertUsageEvents` (idempotent on message_id), `recordWindowSample`,
     plus the aggregation queries Pass 2 needs (can stub/add in Pass 2). Mirror the session_meta repo
     style. Update the test stub if it lacks any SQL feature used (it's node:sqlite — most works).
2. **Internal pricing** (`src/shared/pricing.ts` — shared so renderer + main agree): port + generalize
   `MODEL_PRICING` to a multi-vendor table (anthropic models as-is; add the opencode-surfaced flagship
   vendors/models we support — openai/google/etc. best-effort), keyed by `{vendorId, modelId}` (match
   patterns like today). `equivalentCostUsd(vendorId, modelId, tokens): number | null` (null when
   unpriced) preserving the 5m/1h cache-write split + cacheRead. Resolution order (foundation §4):
   internal table → engine-reported cost (fallback/real-spend) → external models.dev (**opt-in only,
   wire the toggle + fetch as a stub/guarded path; default OFF — no phoning home**). Keep
   `calculateCostFromTokens` working (block-usage still uses it in Pass 1).
3. **Live recorder** (`src/main/services/usage-recorder.ts`): `recordUsageEvent(event)` → DB
   (idempotent). Hook into BOTH engines per turn, engine-agnostically:
   - **Claude** — at the existing per-assistant-message usage accumulation in `claude-session.ts` (where
     `total_cost_usd` + token usage are read), build a `usage_event` (engineId 'claude', vendorId from
     the model's ModelRef = 'anthropic', accountId/accountUuid from the session's AccountRef /
     account-log, model_id, tokens incl. cache split, equiv_cost via the pricing table, engine_cost =
     total_cost_usd delta, message_id = the cli.js message id, session_id). source 'live'.
   - **opencode** — in `OpencodeSession` where `message.updated` info.tokens/cost is handled (5b mapper
     `cost_update`), build a `usage_event` (engineId 'opencode', vendorId from the model's providerID,
     tokens from info.tokens {input,output,reasoning,cache:{read,write}}, engine_cost = info.cost,
     equiv_cost via pricing, message_id = the opencode msg id, session_id = the ses_ id). source 'live'.
   - **message_id is the dedup key** so the Pass-2 reconciler never double-counts live turns.
   - Failures must be swallowed (never break a turn) — log + continue.
4. **No UI/status-line change in Pass 1.** StatusLineData + the JSONL dashboard keep working unchanged;
   Pass 1 only ADDS the DB recording. MeteringSnapshot lands in Pass 2 with the dashboard.

## Pass 2 — reconciler + dashboard→SQL + MeteringSnapshot

1. **Backfill reconciler** (`src/main/services/usage-reconciler.ts`): runs on startup + periodically.
   - **Claude** → repurpose `block-usage`'s JSONL parse (`ParsedEntry`) to `insertUsageEvents`
     (source 'backfill', dedup on message_id — live turns already present are skipped). The parse is
     NOT retired; it becomes the reconciler's Claude source.
   - **opencode** → via the **API** (`GET /session` + `…/message` against the running per-cwd server;
     do NOT parse opencode's on-disk store — unstable). Import messages' tokens/cost as usage_event
     (dedup on message_id). Best-effort (opencode server may be down → skip).
   - Keep JSONL/files as a fallback for a release.
2. **Dashboard → SQL** (the foundation §8/§10 move; the risky, behavior-preserving part):
   - Replace `block-usage`'s in-memory aggregation with **SQL queries over `usage_event`**: 5h-aligned
     blocks (group by the canonical 5h window from `usage_window_sample`/resets_at), daily, per-model,
     **per-engine** (new). Produce the SAME `BlockUsageData`/`UsageBlock` shapes the renderer consumes
     (so `CurrentBlockCard`/`BlockTimeline`/`DailyUsageChart` are unchanged or minimally touched).
   - **WLS projection**: preserve the algorithm verbatim; source `{timestamp, tokens, apiPercent}` from
     the DB (cumulative `usage_event` tokens in the active block × `usage_window_sample.used_percent`
     time-series). Same outputs, same `UsageView` "Window Capacity ~X · $Y" rendering.
   - Add the **per-engine** breakdown to the dashboard (opencode now appears — the headline win).
3. **`MeteringSnapshot`** (foundation §3) on the session — replaces bare `totalCostUsd` in StatusLineData
   (or augments it): `{tokens{input,output,cacheWrite,cacheRead,total}, equivalentCostUsd|null,
   engineReportedCostUsd?, contextWindow{used,size}, window?{usedPercent, resetsAt, projection?}}`.
   Both engines emit it; the status-line renderer shows equivalentCostUsd as the headline. **Behavior-
   preserving for the Claude status line** (it still shows cost + tokens + context + window %).
4. **Per-account usage provider** (foundation §7) — abstract the Claude `/api/oauth/usage` poll behind a
   per-account provider interface; window+projection gated on `billingType==='subscription'`. Claude
   keeps the full feature; opencode/apiKey/free get cumulative meter (no window) per §6.
5. **Per-`billingType` reporting** (§6) — subscription→utilization%+window+projection; apiKey→real
   spend; free→tokens only; unknown→tokens+equiv$. Driven by the session's AccountRef.billingType.

## Out of scope (deferred)
External models.dev pricing fetch beyond the opt-in toggle/stub; richer per-engine dashboard polish
beyond the per-engine breakdown; retiring the JSONL files (kept a release as fallback).

**opencode subagent (task child-session) usage metering** (added Phase 8d, ADR-024): **RESOLVED in
Phase 9a.** Child/subagent token usage is now recorded as its own `usage_event` under the **child's
own model** (`info.providerID` / `info.modelID` from the child `message.updated`) + child sessionId.
`MessageAccumulator` was extended with `childSessionId` and `model` fields; `handleChildEvent`
`message.updated` now captures both; `sumAccumulatorCosts` skips `isChild` accumulators (critical guard
against child cost leaking into the parent turn's `totalCostUsd`); `recordTurnUsage` now meters child
accumulators under their own model (skipping those with no `model` info rather than attributing to the
parent). `sendMetering` continues to skip children intentionally — the live MeteringSnapshot is the
parent turn's per-model meter; children are metered via `recordUsageEvent`, not the snapshot.

## Testing
- Pass 1: DB migration + usage_event/window_sample repos (idempotent message_id dedup); pricing table
  `equivalentCostUsd` (per vendor/model + cache split + null for unpriced); the recorder building a
  correct usage_event from a Claude msg + an opencode message.updated (both engines).
- Pass 2: the reconciler (JSONL→usage_event dedup vs live; opencode API import); the SQL aggregation
  (blocks/daily/per-model/per-engine matches the old JSONL aggregation on the same fixtures — port
  block-usage.test fixtures); the WLS projection over DB-sourced samples (same result as the in-memory
  version on the same samples — this is the key preservation test); MeteringSnapshot per billingType.
- Keep all existing usage tests green / migrate intent. DB code stays main-only (tests hit the stub).

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- **DB ABI:** do NOT `bun install` (reverts better-sqlite3 to Node-ABI). If deps must change, run
  `bun run rebuild:native`. Tests hit the node:sqlite stub.
- **Runtime smoke (verifier-electron):** open the Usage view on a Claude account with history →
  screenshot → assert the 5h block, burn rate, **Window Capacity (WLS) projection**, daily chart, and
  per-model breakdown render **identically** to before (read the PNG; compare against pre-Phase-7).
  Drive an opencode turn (free model) then open Usage → assert opencode usage now appears (per-engine).
  The Claude usage feature is the daily driver — any regression in the window/projection is a real bug.

## Gotchas
- **Preserve the WLS algorithm + 5h window canonicalization byte-for-byte** — only re-source the
  samples from the DB. The "same projection on the same samples" test is the guard.
- **message_id dedup** is load-bearing — live recorder + reconciler converge on `usage_event`; without
  the UNIQUE/ON-CONFLICT, history double-counts.
- **opencode usage** is the headline new value — make sure the recorder fires for opencode turns
  (info.tokens/cost) and the per-engine dashboard surfaces it.
- **Account attribution stays time-based** (ADR-011 `accountForTimestamp`) — carry accountUuid onto
  each usage_event.
- **Behavior-preserving for the Claude dashboard** — the renderer usage components should see the same
  BlockUsageData/UsageBlock shapes (now SQL-sourced); minimize renderer churn.
- **Pre-existing:** 3 `exhaustive-deps` lint warnings — leave them.

## Commit
Branch `v2-phase-7-metering` off `v2-phase-6-tool-registry`; **no AI attribution**; one commit after
both passes review clean. Suggested subject:
`feat(v2): DB-backed metering — usage_event recorder + reconciler + SQL dashboard + cross-engine cost (Phase 7)`.
