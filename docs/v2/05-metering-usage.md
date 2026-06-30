# Foundation 5 — Metering & Usage

> **Status: DRAFT for discussion.** The neutral metering model: what we track, the primary
> metric, per-billing-type reporting, the window-prediction feature, and the DB schema. Builds on
> [01-data-model.md](01-data-model.md) (`MeteringSnapshot`), [02](02-capability-model.md) §6
> (`costUsd` left capabilities), [04](04-auth-accounts.md) (`billingType` from the probe), and
> [persistence.md](persistence.md) (first heavy DB consumer; DB lib = better-sqlite3). Grounded in
> a full read of the current usage stack.

## 1. Purpose

Captured direction (locked): **equivalent API cost (USD) is the primary metric**, reported at the
**session level** — not subscription spend (unless the account is API-billed, where it *is* real
spend). Subscription utilization is **reference**. The 5h-window prediction is a valued existing
feature to preserve and improve.

## 2. Current state

Two cost paths today:

- **Session-level** — `claude-session.ts:1147` accumulates `result.total_cost_usd` →
  `StatusLineData {totalCostUsd, tokens, contextWindowSize, used/remainingPercentage}`
  (`types.ts:928`), emitted on `session:status-line`.
- **Analytics** — `block-usage.ts` parses Claude JSONL, applies a **hardcoded `MODEL_PRICING`
  table** via `calculateCostFromTokens()` (`:59-215`), aggregates into 5h `UsageBlock`s with
  `burnRate` + `projectedUsage`.

**Windows (ADR-011)** — `usage-fetcher.ts` polls `/api/oauth/usage` → `AccountUsage`
(`fiveHour`/`sevenDay` `RateWindow {usedPercent, resetsAt}`); `usage-windows.ts` canonicalizes
window ends (±2min snap) and attributes by account via `account-log.jsonl`.

**Prediction (the valued feature)** — `block-usage.ts:870-978`: **WLS regression** over a
ring buffer of `{timestamp, tokens, apiPercent}` (30 samples, 5-min half-life decay), model
`tokens = k·apiPercent`, `maxTokens = k·100`. Shown as "Window Capacity ~X · $Y" + "Burn Rate
X/min · $Y/hr" (`UsageView.tsx:226-241`).

**Persistence** — JSONL transcripts (analytics source) + daily files + `account-log.jsonl` +
`usage-cache.json`.

## 3. The neutral model

Three notions, selected by `Account.billingType` (recap of 02 §6):
**tokens** (universal) · **equivalent USD cost** (tokens × price) · **subscription utilization %**.

**Primary metric = equivalent API cost = tokens × per-token price.** Billing-independent and
consistent across engines/vendors, so it's the headline everywhere. (Both engines *also* report a
cost directly — cli.js `total_cost_usd`, opencode `AssistantMessage.cost` — used as a cross-check
and as **real spend** for `apiKey` accounts.)

Live per-session metric, on the session (replaces bare `totalCostUsd`):

```ts
interface MeteringSnapshot {
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number; total: number }
  equivalentCostUsd: number | null        // tokens × pricing — primary metric; null if model unpriced
  engineReportedCostUsd?: number          // cli.js/opencode cost; real spend when billingType==='apiKey'
  contextWindow: { used: number; size: number }
  window?: {                              // subscription only; absent otherwise
    usedPercent: number; resetsAt: string
    projection?: { maxTokens: number; costUsd: number }   // the WLS feature
  }
}
```

The dashboard is the historical aggregation of the same data (blocks, daily, per-model,
**per-engine**) read from the DB.

## 4. Pricing source — internal first, external opt-in

**Default: a bundled, version-controlled pricing table** (the V2 successor to `MODEL_PRICING`,
extended to the flagship vendors/models we support). ClaudeUI does **not** fetch external pricing
by default — no phoning home. Resolution order for a model's price:

1. **Internal table** (bundled, curated) — the default; exact equivalent cost for supported models.
2. **Engine-reported cost** — both engines emit actual per-turn cost; use it as the real-spend
   figure for `apiKey` accounts and a best-effort fallback for unpriced models. (No table needed
   for the *actual* number.)
3. **External (models.dev)** — **opt-in only** ("use external pricing sources"); fills/refreshes
   the table for long-tail models.

> Distinction: opencode's `GET /config/providers` `cost.*` is *engine-provided* (a local call to
> our own opencode server) — acceptable as an internal-ish source. "External" means ClaudeUI
> reaching out to models.dev directly, which stays opt-in.

Equivalent cost is exact for supported models, best-effort otherwise, and degrades to tokens-only
when no price is known (`equivalentCostUsd: null`).

## 5. Recording model — live events + ongoing backfill

Two sources feed the DB:

- **Live, in-app** — record each turn's usage as it streams, engine-agnostically: one
  `usage_event` row per turn `{ts, engineId, vendorId, accountId, model, tokens…, equivalentCostUsd,
  engineReportedCostUsd?, sessionId}`. Claude (`result`/status-line) and opencode
  (`AssistantMessage`) both feed it. No per-engine transcript parsing on the hot path.
- **Ongoing backfill (out-of-tool sessions)** — usage that happened **outside ClaudeUI** (you ran
  `claude`/`opencode` in a terminal, or another client) must still appear. A periodic reconciler
  scans each engine's own store and imports `usage_event`s not already present (dedup by
  message/session id):
  - **Claude** → scan `~/.claude/projects/**/*.jsonl` (today's `block-usage` parse, repurposed as
    the reconciler — *not* retired).
  - **opencode** → via the **API** (`GET /session` + `…/message`) against the running per-cwd
    server, *not* by parsing opencode's internal store (its on-disk format is unstable — research).

The dashboard queries the DB. Live + ongoing backfill keeps it complete regardless of where work
happened.

## 6. Per-`billingType` reporting

| billingType | Headline | Window | Notes |
| --- | --- | --- | --- |
| **subscription** | utilization % + window + prediction | ✓ if a usage provider exists (§7) | equivalent $ shown as *notional* reference |
| **apiKey** | **real spend** (= equivalent/engine cost) | ✗ | the $ is what you pay |
| **free / local** | tokens only | ✗ | no cost |
| **unknown** | tokens + equivalent $ | ✗ | best-effort |

The "show $ / show window" choice is driven entirely by `billingType` (from the auth probe, 04 §6)
— no capability boolean (02 §6).

## 7. Window + prediction — subscription-gated, preserved

Windows are a **subscription** concept (Claude Max/Pro **and** OpenAI/ChatGPT Plus alike), so the
gate is `billingType === 'subscription'`. But populating a window needs a **per-account usage-data
provider**, and not every subscription exposes one:

- **Claude subscription** → has `/api/oauth/usage` (ADR-011): keep the full feature — windows,
  utilization %, burn rate, and the WLS capacity projection (algorithm unchanged, it's neutral).
  The feature you value; preserve and refine it.
- **Other subscriptions (e.g. ChatGPT via opencode)** → conceptually windowed, but no usage API is
  exposed to us today → **best-effort/unpopulated** until a provider exists.
- **apiKey / free** → no window; a simpler **cumulative** meter (tokens + cost, burn rate), no cap.

The usage-data provider is **per-account and pluggable** (Claude has one; others slot in later).

## 8. DB schema + library

**DB library — decided: `better-sqlite3`** (de-facto Electron standard; sync, fast, mature). Cost
is the native-module build: wire `electron-rebuild` + per-platform prebuilds (we already carry a
native toolchain for `node-pty`, so it's incremental). `node:sqlite` was set aside (newer,
Electron-Node-version-dependent).

Schema sketch (one per-user SQLite DB):
```
usage_event(id, ts, engineId, vendorId, accountId, model,
            input, output, cacheWrite, cacheRead, equivCostUsd, engineCostUsd, sessionId)
   indexes: (ts, engineId), (sessionId), (accountId, ts)
account_window(accountId, resetsAt, usedPercent, fetchedAt)     -- subscription usage providers
```
Blocks/daily/per-model aggregates become **SQL queries**, not in-memory JSONL passes.

## 9. Neutral vs Claude-specific

- **Neutral:** token counts; equivalent cost (tokens × the internal pricing table); burn rate;
  block grouping; the WLS algorithm; the per-`usage_event` recording model; dashboard aggregations.
- **Claude-specific (gated, behind the per-account usage provider):** the `/api/oauth/usage` poll,
  `resets_at` 5h windows, subscription utilization %, account attribution from `~/.claude.json`.

## 10. Migration

- Stand up the DB (`better-sqlite3`) + the live `usage_event` recorder; both engines feed it.
- **Backfill is ongoing, not one-time** — the reconciler (§5) runs on startup + periodically to
  import out-of-tool sessions (Claude JSONL scan; opencode via API). Initial run imports history;
  keep files as a fallback for a release.
- `usage-fetcher`/ADR-011 windows stay as the Claude-subscription usage provider (one provider
  behind the per-account interface in §7).
- `StatusLineData.totalCostUsd` → `MeteringSnapshot` (USD becomes `equivalentCostUsd`; window
  fields gated).

## 11. Decisions

1. **Primary metric = equivalent API cost** ✓ (tokens × pricing, session-level).
2. **Recording = live events + ongoing backfill** ✓ — out-of-tool sessions reconciled into the DB
   (Claude JSONL scan; opencode via API), not just a one-time import (§5).
3. **Pricing = internal-first** ✓ — bundled curated table + engine-reported cost fallback;
   **external (models.dev) is opt-in only**. Engine-provided `cost.*` (local) is fine; ClaudeUI
   fetching models.dev directly is the opt-in case (§4).
4. **Window + prediction = subscription-gated** ✓ — Claude *and* OpenAI/ChatGPT subs conceptually;
   each needs a per-account usage provider (Claude has one; others best-effort until available) (§7).
5. **DB library = better-sqlite3** ✓ (§8).
