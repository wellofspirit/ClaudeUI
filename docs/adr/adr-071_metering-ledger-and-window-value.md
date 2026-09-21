# ADR-071: One metering ledger, two costs, machine-independent account keys, and a window-value ledger

**Status:** Accepted (2026-09-21; proposed 2026-09-20). Drafted from the owner's rulings of 2026-09-20 and mockup `140549af`. Slices S0 to S4 are built on it. §6 amended 2026-09-21 to the 401 rule as built, and again on 2026-09-21 (S3c) so a window's kind and length come from the value the API states rather than from the window's position.
**Amends:** [ADR-011](adr-011_canonical-usage-windows-and-account-attribution.md) §4 (account attribution), [ADR-033](adr-033_cross-engine-dispatch.md) (what `dispatch.maxCostUsd` gates on, where dispatched usage is stored), [ADR-034](adr-034_session-time-and-cost-accounting.md) (what `totalCostUsd` means)
**Relates to:** [ADR-015](adr-015_multi-account-file-credentials.md) (per-account Claude credential files), [ADR-030](adr-030_capability-honesty.md) (unknown is never shown as zero), [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) and [ADR-069](adr-069_codex-host-per-home-and-account.md) (ChatGPT accounts and their hosts), [ADR-070](adr-070_one-auth-surface.md) (where a dead credential is reported), [ADR-072](adr-072_usage-hub-self-hosted-sync.md) (the sync that consumes this ledger)

## Context

The usage dashboard was built for one engine and one account. Four engines and several accounts per provider later, a read of the code on 2026-09-20 found these gaps. Each one is a fact about the tree at `ca985cec`, not a guess.

1. **Codex usage is recorded nowhere.** `src/core/codex/` never calls `recordUsageEvent`, and `usage-reconciler.ts` has arms for Claude and opencode only. A ChatGPT account's spend exists for the life of the status line and then it is gone.
2. **One field, three meanings.** `StatusLineData.totalCostUsd` is cli.js's API-equivalent figure on Claude, our pricing-table figure on Codex, and the engine's billed figure on opencode and pi. opencode bills a subscription-authenticated provider at zero, so an opencode session on a ChatGPT plan shows `$0.00`. `OpencodeSession` already computes the equivalent figure for `MeteringSnapshot` (`OpencodeSession.ts:2404`) and the renderer stores it (`session-store.ts:812`), but no component reads it.
3. **The dispatch cost cap inherits the same zero.** The opencode target adds `info.cost` to `cumulativeCostUsd` (`cross-engine-dispatcher.ts:2362`), so under a subscription `dispatch.maxCostUsd` never trips. The Codex target uses `equivalentCostUsd` (`:1304`). The same setting behaves differently depending on the target.
4. **A new model under a subscription has no price.** The built-in table in `src/shared/pricing.ts` is maintained by hand. The supplemental prices come from opencode's `/config/providers`, which returns zeroed costs for subscription-authenticated providers, and `isZeroCost` drops them. `selectRowCostUsd` then falls through to `0`.
5. **Rows cannot answer "which account" or "covered by what".** `usage_event` has no billing type. Claude rows carry `account_uuid` and a null `account_id`. opencode rows carry neither, because `OpencodeAuthProvider.buildAccountRef` returns no `accountId` at all. `daily_usage` has no account column, so any per-account history is gone once `usage_event` is pruned at 90 days. `dispatched_usage` is a separate table with a token total and a cost and nothing else, which is why the dashboard shows dispatched work in its own section and leaves it out of every total.
6. **Limits are per-engine one-offs.** ChatGPT limits are held per vault account in memory with no history. Claude limits exist for the active account only. `usage-provider.ts` is a 57-line placeholder for the abstraction both need.

The owner's requirements, stated 2026-09-20: show what subscription usage would have cost on the API, next to what was billed. Track usage and limits per account. Count dispatched work. Show how much API-equivalent usage each subscription delivers per window, which is the measure of what a plan is worth. (The first draft said "per 5-hour and per 7-day window" and "OpenAI plans have only the 7-day window". **Amended 2026-09-21 (S3c):** a plan has whatever windows it has and each one states its own length — the owner's ChatGPT plan reports ONE window and it is weekly, while Codex's fixtures carry 30-minute, 1-hour and 1-day windows. See §6.)

## Decision

### 1. `usage_event` is the only ledger

Every turn that moves tokens writes one row, from every engine and every origin. `dispatched_usage` stops being written. Its reads move to the ledger, and a migration copies its existing rows in with `origin = 'dispatch'`, null token splits and `account_key = 'unknown'`.

New columns on `usage_event`:

| Column              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account_key`       | Machine-independent account identity, see §3. `'unknown'` for rows that predate this ADR.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `account_label`     | What a person calls the account (the email with the plan, or `openrouter key …a41f`: the vendor id and the last four characters of a key longer than eight). Display only.                                                                                                                                                                                                                                                                                                                                         |
| `billing_type`      | `subscription`, `apiKey`, `free` or `unknown`, captured when the row is written.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `origin`            | `session`, `child` (a native subagent or a Codex child thread) or `dispatch`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `parent_routing_id` | The dispatching or spawning session, for `child` and `dispatch` rows. `SessionManager.rekey()` renames it exactly as it renames `dispatched_usage.from_routing_id` today.                                                                                                                                                                                                                                                                                                                                          |
| `api_cost_usd`      | Tokens priced at list price. Null when the model has no known price.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `billed_cost_usd`   | Money that left a wallet. The engine's figure for `apiKey`, `0` for `subscription` and `free`. Under `unknown` it is the engine's figure only when that figure is positive AND the engine reports charges (opencode, pi); otherwise null. cli.js's figure is an API-equivalent whatever the plan (ADR-034), so a Claude row's bill is its figure under `apiKey`, `0` under `subscription` and null under `unknown`, and its `api_cost_usd` is that same figure, which prices the 1h cache tier our table does not. |

`equiv_cost_usd` and `engine_cost_usd` stay as the raw inputs. The two new cost columns are derived from them once, at write time, by one function. `selectRowCostUsd` and its `> 0` heuristics are deleted.

`daily_usage` is replaced by `usage_bucket`, keyed by `(hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin)`. Buckets are hourly and in UTC so that a reader in any timezone can group them into local days, and so that ADR-072's hub can hold the same table. Buckets are kept forever. `usage_event` keeps its 90-day retention. Existing `daily_usage` rows migrate to midday-UTC buckets under `account_key = 'unknown'`.

### 2. Two costs, shown by billing type

- A subscription row shows `api_cost_usd` and says it is covered.
- An API-key row shows `billed_cost_usd` as the figure and `api_cost_usd` beside it. The two differ when a gateway adds a margin.
- A null cost renders as `unknown` (ADR-030). It is never summed as zero. A total that includes unknown rows says how many.

`StatusLineData.totalCostUsd` follows the same rule on every engine, so the opencode and pi sessions stop reporting zero under a subscription. The status line gains `billedCostUsd` for the tooltip. ADR-034's ruling that dispatched spend stays out of the session headline is unchanged. The dashboard includes it in every total and marks the rows.

`dispatch.maxCostUsd` gates on the same figure a headline shows, for every target: the API-equivalent cost under a subscription, the billed cost under an API key. A target whose model has no price cannot be capped, and the dispatch card says so instead of pretending the cap is armed.

### 3. `account_key` is derived from the provider, never from this machine

A vault id is a UUID minted on one machine, so it cannot identify an account on another. ADR-072 needs the same key on every machine, and changing keys later means rewriting the ledger, so the key is machine-independent from the first row.

| Account                                            | `account_key`                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription                                | `anthropic:<organizationUuid>:<accountUuid>`, both from the account's own credential (see below)                                             |
| ChatGPT subscription                               | `chatgpt:<chatgpt_account_id>:<user>`, where `<user>` is the id token's stable user claim, or the lowercased email if the token carries none |
| Any API key                                        | `<vendor>:key:<hex16>`, where `hex16` is the first 16 hex characters of `SHA-256("claudeui-account-key-v1:" + vendor + ":" + apiKey)`        |
| Credentials an engine holds and we cannot identify | `<engine>:<vendor>:native`                                                                                                                   |

**A key names a subscription, not a person.** The owner's correction of 2026-09-20: one email can hold a personal and a business ChatGPT subscription, and the same happens on Anthropic, more rarely. Each has its own limits and its own bill, so each is its own account here. That is why the subscription's id comes first in both subscription keys. On ChatGPT it is `chatgpt_account_id`. On Anthropic it is `organizationUuid`, which `oauthAccount` carries next to `organizationName` and `organizationRateLimitTier` and which nothing reads today. **Amended 2026-09-21 (S2e):** under multi-account (ADR-015) the identity is NOT read from `~/.claude.json`. That file is one shared file for every account dir and for the terminal `claude`, and cli.js rewrites its `oauthAccount` only when it refetches the profile (daily at most), so the block names whichever process refetched last, not the account whose credentials a spawn holds. Found on the owner's machine: the company dir stamped with the personal identity and a day of rows keyed to the wrong subscription. The identity of an account dir is resolved from the dir's own credential through `GET /api/oauth/profile` (the call cli.js itself makes), cached on the `account` row and in memory per credential file, re-resolved when the file changes; app-side switches append to the account log so time-based attribution follows the app. Single-account (Keychain) mode still reads `~/.claude.json`, where one login is the only login. A one-shot repair re-keys the rows written under the stale attribution since the log's last record. The user part stays in the key because ADR-068 records the reverse case too: two people's accounts inside one workspace. `account_label` shows the email with the plan or organization name, so two subscriptions under one email can be told apart on screen.

The API-key rule is a plain hash, not an HMAC, because it has to give the same answer on a machine that has never heard of a hub. A provider API key carries at least 128 bits of entropy, so a 64-bit digest of it cannot be inverted or guessed. All it allows is confirming a key somebody already holds. The label shows the last four characters of the key, as provider consoles do.

#### opencode and pi accounts need no patch

`OpencodeAuthProvider.buildAccountRef` returns no account id today, so every opencode row is unattributed. The identity is already on disk. opencode's `auth.json` holds, per vendor, either `{ type: 'oauth', access, refresh, expires, accountId }` or `{ type: 'api', key }` (field names confirmed on a live file, 2026-09-20). `OpencodeAuthProvider` already parses the oauth shape for ADR-036's vault feed. It gains one method that returns `{ accountKey, accountLabel }` for a vendor and nothing else:

- an `openai` oauth entry gives `accountId`, which is the `chatgpt_account_id`, and its `access` JWT gives the user claim and the email. This is the same key the Codex engine derives for the same subscription, so usage through either engine lands on one account.
- an `api` entry gives the digest of `key` by the rule above.
- a key that comes from an environment variable or from `provider.<id>.options.apiKey` in opencode's config is resolved the same way when we can read it.
- anything else, including an Anthropic oauth entry, which carries no account id, is `opencode:<vendor>:native`. Resolving it would cost a profile call with a token that belongs to opencode, and that is not worth doing until somebody needs it.

The method reads the file in-process and returns the key and the label only. No token or key material reaches a log, an IPC payload or a usage row. The result is cached on the file's mtime and read when the turn's row is written, so a sign-in change between turns attributes each turn to the account that ran it. `PiAuthProvider` gets the same method over `~/.pi/agent/auth.json`. If a future opencode stops persisting `accountId`, the fallback is a patch to the fork that reports it on `/config/providers`. It is not needed at 1.18.29.

Claude terminal sessions and any other transcript we import keep ADR-011's time-based attribution. That is the only way to attribute a transcript that records no account. Sessions this app spawns record the key directly, which also closes ADR-011's known gap around the moment of a switch.

### 4. Codex writes to the ledger

`thread/tokenUsage/updated` carries cumulative totals per thread, so `CodexSession` records a delta at each turn end, for the root and for each child thread. The row's `message_id` is `codex:<threadId>:<turnId>`. It is built from native ids only, never from a routing id, so a rekey or a resume cannot produce a second row for the same turn.

**What the probe found (S0, 2026-09-20, `docs/codex-spike.md` § Token usage across a resume).** The cumulative total belongs to the native thread and continues on every path: a second turn, a resume after an unload, a resume by a process that did not create the thread, and a fork. A fork starts at the SOURCE's total, not at zero. Four more facts shape the recorder:

- A resume replays one frame before any new turn, carrying the last completed turn's id and that turn's `last`. Reading `last` as "what this turn cost" counts the previous turn twice.
- `CodexSession` forks with `excludeTurns: true`, which suppresses the replay, so the first frame the product sees on a fork already holds the whole source history.
- One turn can emit several frames under one turn id, one per model request.
- A child thread meters itself under its own thread id and never appears in its parent's total.

So the baseline is held per native thread id and seeded from the first cumulative the app is shown for that thread, never from zero. The first frame for a thread id records the baseline and writes nothing. At each turn end the row is the newest frame minus the baseline as it stood when the turn began, and the baseline moves up. A replay is then a no-op, a fork's first turn costs its own tokens, a multi-request turn is one row, and each child has its own baseline. If any component of the cumulative goes DOWN, the baseline is re-seeded and nothing is written: `TokenUsageInfo::fill_to_context_window` in the pinned source replaces the total with the context window size and zeroes its components, and the probe's fixture could not exercise that path. A turn whose end the app never sees (a host killed mid-turn) has its tokens charged to the next observed turn. That misattributes one turn and neither drops nor double counts.

A failed or interrupted turn that moved tokens writes a row. The ledger records spend, not success.

### 5. Prices come from models.dev directly

`opencode-pricing.ts` fetches `https://models.dev/api.json` itself instead of reading opencode's view of it. That view is zeroed by whatever the user is signed in with, which is the wrong input for a list price. The fetch runs on boot and from the existing refresh button, is skipped when non-essential traffic is disabled, and persists to the same file. The built-in table stays as the offline fallback and keeps precedence for Anthropic, where cache-write tiers matter and models.dev does not carry them.

### 6. One limits provider per vendor, and the readings are kept

`usage-provider.ts` becomes the real abstraction:

```ts
interface AccountLimits {
  accountKey: string
  label: string
  plan?: string
  windows: Array<{
    kind: '5h' | '7d' | string
    label: string
    usedPercent: number
    resetsAt: string | null
    windowMinutes?: number | null // the length the vendor stated (S3c)
  }>
  credits?: { unlimited: boolean; balance: string | null }
  observedAt: number
  source: 'local' | { deviceId: string } // ADR-072 relays readings from other machines
}
```

The ChatGPT provider wraps `ChatgptRateLimitStore` unchanged. The Claude provider takes a credential directory (ADR-015), so it can read any stored account. The account's identity (key and billing type) comes from the same credential through the profile endpoint (§3 as amended 2026-09-21), never from `~/.claude.json`, and a stored account's identity is resolved only on a user-driven refresh, like its reading.

**Inactive Claude accounts are never refreshed in the background.** The owner's concern is that Anthropic may limit how many refresh grants an account gets, and a timer spending them on accounts nobody is using is the wrong trade. The rule is: use the stored access token while it is valid. Refresh only when the user opens the dashboard or presses refresh. On a 401 during a read the user asked for, spend one refresh grant and retry once. If the refresh fails or the retry is a 401 too, mark the account as needing sign-in through ADR-070's pill and stop. A read that may not refresh marks it on the first 401. (Amended 2026-09-21. The first draft said to stop on the first 401 in every case. The owner ruled that the one retry stays, because no timer reaches this path, refreshes are single-flighted per credentials file, and stopping cold would turn a server-side token revocation into a full sign-in. Syncing tokens between machines is a later discussion.) With ADR-072 enabled, a reading relayed from the machine where the account is active beats any local fetch, and this machine spends no token at all.

Readings are persisted. `usage_window_sample` gains `account_key` and `window_kind`, and takes ChatGPT readings as well as Claude's.

**A window's kind and length come from the value the API states, never from the window's position (amended 2026-09-21, S3c; owner: "don't just assume, use trusted value").** Claude names its own windows (`five_hour`, `seven_day`, and `limits[]` entries of `kind: "weekly_scoped"`), so `5h`, `7d` and `7d:<slug>` are the payload's own vocabulary and their lengths come with their names. ChatGPT names nothing: it fills two SLOTS, `primary` and `secondary`, and states each window's length — the backend's `limit_window_seconds`, which Codex carries as `window_minutes` and the app-server wire as `windowDurationMins`. Reading the slot as the kind filed a weekly-only plan's one window (the owner's, delivered as `primary`) under `5h`, labelled it `5-hour`, and summed a week of spend over five hours in §7's ledger.

So one shared function derives the kind and the label from the duration: 300 minutes is `5h`, 10,080 is `7d`, any other whole number of days or hours is `<n>d` / `<n>h`, anything else `<n>m`. A window whose duration the vendor withheld keeps the slot's own name (`primary` / `secondary`) and is labelled `limit` — never a guessed `5h`. When BOTH slots of one reading state the same length, the secondary's kind becomes `<kind>:secondary`: the kind is an identity downstream (the sample dedup key, `usage_window`'s primary key, one row per kind in a stale read, the accounts panel's meter key), so two windows may never share one. `usage_window_sample` and `usage_window` carry a nullable `window_minutes` (migration v25, which also drops the mis-kinded ChatGPT rows so they re-seed), and §7's ledger takes a window's span from it when present, falling back to the kind's own name for Claude's rows. A window whose length nothing states is sampled but never materialised into `usage_window`: no length, no numerator.

The same amendment removes ONE assumption on the Claude side: `AccountUsage.fiveHour` was defaulted to `{ usedPercent: 0, resetsAt: null }` when the payload carried no `five_hour`, so an account with no five-hour window (an API key, Bedrock, Vertex) got a fabricated 0 % meter and samples under a window it does not have. It is nullable now, and an absent window is absent (ADR-030).

### 7. The window-value ledger

New table `usage_window`, one row per `(account_key, window_kind, canonical_end)`:

| Column                 | Meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `peak_percent`         | The highest `usedPercent` seen for the window.                        |
| `api_cost_usd`, tokens | The ledger's sum for that account between the window's start and end. |
| `closed`               | Set once `canonical_end` has passed and a final recompute has run.    |

The dashboard derives dollars per 1% and the implied value of a full window (`api_cost_usd / peak_percent × 100`) on read. Window identity reuses ADR-011's `canonicalizeWindowEnd` for every kind, not only the 5-hour one.

The implied value has a known bias, and the dashboard says so. `peak_percent` is the account's global utilization, but the dollars are only what this ledger saw. Usage on another machine, or in claude.ai, pushes the percent up without adding dollars, so the implied value reads low. ADR-072 fixes the other-machines part by summing the numerator across machines. Nothing fixes the claude.ai part. A window whose peak is under 5% is excluded from the averages, because dividing by a small percent turns noise into a headline.

ADR-011's WLS projection stays as it is and stays Claude-only. It answers a different question (where will this window end up) from the same samples.

### 8. The dashboard

Layout ruled by the owner from mockup `140549af`, top to bottom:

1. Header: two tabs (Spend, Plan value), range (Today, 7d, 30d, 90d; Today is the viewer's local calendar day and the default for a fresh viewer, added 2026-09-21 by owner ruling), group-by (provider, account, engine, model, machine; Spend tab only), the scope switch and sync chip from ADR-072.
2. Summary: one hero figure for API-equivalent spend, with a bar splitting it into covered and billed and then by provider (variant B). Below roughly 600px it collapses to the one-line strip (variant D).
3. Accounts: grouped by provider, subtotal on the provider header, one row per account with its window meters inline (variant C). The reset timeline (variant D) was built beside it and removed on 2026-09-21: on real data it repeated every meter of the accounts panel row for row, and the reset time is already on each meter.
4. Window value, on the Plan value tab (moved out of the Spend page on 2026-09-21: it is plan analysis, not a glance at spend): the subscription comparison as range bars (B), then per-window columns for the selected account (A), then the scatter of peak percent against dollars delivered (C). It follows the shared range.
5. Spend over time: stacked columns, 130px tall, bars capped at 14px (A), with a toggle to one row per provider on independent scales (B). Providers here differ by about 30×, which flattens the small ones in a shared scale. On the Today range the columns are the local day's hours (the buckets are hourly already); every other range draws days.
6. Breakdown: a tree table of provider, account and model with tokens, both costs and share. Dispatched rows are marked inline and counted in every subtotal (A).

The Claude 5-hour block analytics (current block, timeline, recent blocks, projection) move behind the Claude account rows as a drill-in. They describe one kind of account, not the dashboard.

Categorical colour follows the provider, in a fixed order, and a filter never repaints the survivors. The five-slot palette was validated against the `#111318` card surface with the dataviz validator (worst adjacent CVD ΔE 8.4). Meter fills carry severity and always ship with an icon and the number, so state never rests on colour alone.

## Slices

| Slice | Content                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | The Codex cumulative-total probe (§4).                                                                                                      |
| S1    | The two-cost rule, the status-line fix for opencode and pi, the dispatch cap fix, models.dev prices. Ships alone and fixes the `$0` report. |
| S2    | Schema migration, `account_key` derivation, Codex recording, dispatch rows folded in, `usage_bucket`.                                       |
| S3    | Limits providers, on-demand reads of inactive Claude accounts, persisted samples, `usage_window`.                                           |
| S4    | The dashboard.                                                                                                                              |

Each slice follows ADR-026. S2's guard tests have to fail before the fix: a rekeyed Codex session producing one row per turn, an opencode subscription turn carrying a non-null `api_cost_usd`, and a dispatched turn appearing in the provider subtotal.

## Consequences

- One query answers per-provider, per-account, per-machine and coverage questions. The separate dispatched section and its table go away.
- History before the migration is unattributed. It shows under an `unknown` account and is included in totals. The owner accepted this on 2026-09-20.
- The session headline changes meaning for opencode and pi under a subscription. It was zero. It becomes the API-equivalent figure, labelled as covered.
- A models.dev outage leaves new models unpriced until the next successful fetch. They show as `unknown`, which is the honest reading.
- Opening the dashboard can spend a refresh grant for an inactive Claude account. Nothing else does.
- The implied full-window value is an estimate with a stated downward bias. It is good for comparing plans against each other and should not be read as a quota.

## Alternatives considered

- **Keep `dispatched_usage` and join it at read time.** Rejected. It has no token split, no account and no vendor, so every new question would need a second code path, which is the state we are leaving.
- **Daily rollups instead of hourly.** Rejected. A daily row bakes in one timezone, and the hub in ADR-072 serves machines that may not share one.
- **HMAC the API key with a per-user secret.** Rejected. The key must be derivable on a machine with no hub configured, and the plain digest already cannot be inverted.
- **Poll every Claude account on a timer.** Rejected on the owner's refresh-grant concern.
- **Show API-equivalent cost as the only figure.** Rejected. For an API-key account behind a gateway, the billed figure is the true one and the two differ.
