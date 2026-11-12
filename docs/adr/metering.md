# Metering and usage

Governs: `src/core/services/usage-hub/`, `src/core/services/usage-aggregation.ts`, `src/core/services/usage-windows.ts`, `src/core/services/usage-window-ledger.ts`, `src/core/services/usage-fetcher.ts`, `src/core/services/usage-provider.ts`, `src/core/services/usage-recorder.ts`, `src/core/services/usage-reconciler.ts`, `src/core/services/block-usage.ts`, `src/core/services/opencode-pricing.ts`, `src/shared/account-key.ts`, `src/shared/cost-rule.ts`, `src/shared/pricing.ts`, `src/core/auth/account-identity.ts`, `src/renderer/src/components/usage/`, `scripts/fake-usage-hub.ts`

What a turn costs, who paid for it, which account's limit window it fell in, and what may leave the machine
for the optional usage hub. As-built mechanics (schemas, formulas, routes) are in
`docs/architecture/metering.md`. The hub itself is deployed from its own repository (`claudeui-usage-hub`);
this record keeps the contract this repository depends on. Judge usage rows (`origin: 'judge'`) are ADR-081
(`auto-mode-judge.md`); accounts, identities and credential files are ADR-015, ADR-068, ADR-080
(`auth-and-accounts.md`); dispatch and its cost cap are ADR-033 and ADR-105 (`dispatch.md`); "unknown is never
shown as zero" is ADR-030 (`engine-model.md`).

## Window identity comes from `resets_at`; Claude rows are attributed by time (ADR-011)

The Claude 5 h block analytics and its projection are anchored to the rate-limit window the usage API reports.
The rules that still bind:

1. **Window identity is the canonical `resets_at`, never an hour grid.** `canonicalizeWindowEnd`
   (`usage-windows.ts`) rounds an observed reset to the minute and snaps to an already-known end within 2
   minutes (first observation wins), because polls return sub-second jitter and genuinely non-hour ends occur.
   Known windows are re-derived at start-up from the `apiResetAt` values persisted in the daily files; there is
   no separate registry file. `floorToHour` survives only as the fallback for entries outside every known
   window: such blocks are provisional (`windowAligned: false`), never force a split and are not persisted as
   completed while recent. An entry before a window's derived start attaches to it within a 30 minute grace.
   Hour-rounding was rejected: it split one real window into two alternating alignments.
2. **The expired-window gap is a state.** With no unexpired window known: no snapshots are persisted (a
   0%/null-reset snapshot is no signal), the projection is null and no recent block is finalised. Proactive
   fetches shorten the gap: one at `resets_at + 10 s` (rescheduled on every usage update), one at launch when
   the cached usage has no unexpired window, and a 30 s throttled one when the transcript watcher sees new
   entries while no window is known (`usage-fetcher.ts`).
3. **Projection state is keyed on window identity.** The WLS sample buffer resets when the canonical end
   changes (a window roll and an account switch both arrive as a new `resets_at`). Restored block metadata is
   matched by exact block id only; there is no time-overlap matcher. The projection stays Claude-only and
   answers "where will this window end up", a different question from the window-value ledger (ADR-071 §7).
   Two safeguards keep a stale or contaminated fit from showing (`block-usage.ts`): the sample buffer is
   dropped when the API percent falls more than 5 points below the buffered maximum (the window semantics
   changed under us, and old samples would inflate the fit through the origin); and a restored projection is
   discarded when it exceeds 1.5x the capacity implied by the block's own `finalApiPercent`, or is below the
   block's own tokens. A block that shows no projection after a restart is this rule, not a bug.

### §4 Account attribution is time-based, for every Claude row

Credentials are global, so an account switch is a point-in-time event and a timestamp resolves the account
exactly. `usage-fetcher.ts` appends a record to the append-only account log
(`~/.claude/ui/usage/account-log.jsonl`) when the account changes; `claudeAccountAttribution`
(`usage-windows.ts`) resolves a row's timestamp against it with three answers: a record, the `unknown` bucket,
or **deferred**. Deferred is the switch instant: while the new directory's identity cannot be read yet a marker
holds those rows back rather than writing them under the previous account, because the hub reads the ledger as
append-only and a row written `unknown` and re-keyed later is the thing to avoid. A marker that never resolves
releases its rows as `unknown` after 24 hours. Transcripts carry no account (verified: cli.js writes no account
field), so time-based attribution is the only way to attribute them, and it covers terminal sessions and
imported transcripts as well as sessions this app spawned. Windows are tagged with the account active when
observed, which disambiguates overlapping windows from two accounts. The Usage view's account filter is shown
only when more than one account is known. What the log records as the account identity is ADR-071 §3's
credential-derived identity, not `~/.claude.json`.

Attribution only works forward from deployment: history from before it stays `unknown` and ages out of the
7-day transcript scan.

## Session time is active turn time; cumulative cost is replaced, never added (ADR-034)

- **Session time** (`StatusLineData.totalDurationMs`) is the summed wall-clock of turn processing, prompt sent
  to turn complete, on every engine. Idle time never counts. `turnStartedAtMs` lets the renderer tick the
  in-flight turn. Reload durability is reconstruction from each engine's own transcript (Claude turn spans from
  line timestamps, opencode from stored-message times), never from a private copy in the DB; a `Math.max`
  ratchet keeps the displayed duration from moving backward. Forks are excluded from seeding.
- **`result.total_cost_usd` and `result.modelUsage` are cumulative within one cli.js process and reset to zero
  on `--resume`** (`docs/protocol-cc/03-inbound-messages.md`); only `usage` and `duration_ms` are per turn.
  Cost is therefore tracked as a **base** (everything before this engine process, seeded once from a transcript
  recompute or stored-message costs) plus a **live overlay** (the latest cumulative, **replaced, never
  added**, folded into the base at a process boundary). The post-result reconciliation never touches cost, or it
  would overwrite authoritative live values with a pricing estimate. A claude dispatch target converts the
  cumulative figure to a per-turn delta against a per-entry baseline for the same reason.
- `StatusLineData.modelCosts` carries the per-model breakdown; the TopBar shows it with two or more rows or any
  dispatched row. **Dispatched spend is breakdown-visible but never in the headline:** it appears as
  `dispatched: true` rows plus a "Total incl. dispatched" line (`BaseSession.addDispatchedCost`, a plain `+=`
  because dispatch costs arrive per turn), while `totalCostUsd` stays own-engine-only so the status line and
  usage attribution keep their meaning. Dispatched spend itself is durable in the ledger as `origin: 'dispatch'`
  rows (ADR-071 §1); the `dispatched_usage` table is gone.
- The dispatch cost cap counts failed-subtype turns too: the cap is a spend limit, not a success limit. What it
  gates on is ADR-071 §2.
- Accepted imprecision: historical cost is pricing-table math, live cost is the authoritative figure, so
  breakdown rows can differ from a dashboard recomputation by table drift; the headline is authoritative.

## One ledger, two costs, machine-independent account keys, a window-value ledger (ADR-071)

The usage dashboard was built for one engine and one account. This decision makes `usage_event` the only
ledger, resolves cost once per row, derives accounts from the provider rather than the machine, and keeps a
per-window record of what a subscription delivered. The Codex engine, which this ADR also first recorded, was
removed on 2026-10-29: the code drops no historical Codex rows (they show as recorded, under their keys), and
migrations that name `codex:openai:native` stay.

### §1 `usage_event` is the only ledger

Every turn that moves tokens writes one row, from every engine and every origin (`session`, `child` for a
native subagent, `dispatch`, and `judge`, ADR-081). A failed or interrupted turn that moved tokens writes a row:
the ledger records spend, not success. Writing a row never blocks or fails a turn.

- **Columns that carry the decision:** `account_key`, `account_label` (display only), `billing_type`
  (`subscription`, `apiKey`, `free`, `unknown`, captured at write time), `origin`, `parent_routing_id` (renamed
  by `SessionManager.rekey()` with its session), and the two derived costs `api_cost_usd` (tokens at list
  price, null when the model has no price) and `billed_cost_usd` (money that left a wallet). `equiv_cost_usd`
  and `engine_cost_usd` remain as the raw inputs; `resolveCosts` (`src/shared/cost-rule.ts`) derives the two
  costs once, at write time.
- **Bill rule:** the engine's figure under `apiKey`, `0` under `subscription` and `free`; under `unknown` the
  engine's figure only when positive AND the engine reports charges (opencode, pi), otherwise null. cli.js's
  figure is an API-equivalent whatever the plan, so a Claude row's bill is that figure under `apiKey`, `0` under
  `subscription`, null under `unknown`.
- **`selectRowCostUsd` survives as the pre-v18 fallback** only, for a row whose backfill could fill neither
  cost; its first line is `displayCostFromRow`, so every row written since never reaches the old `> 0`
  heuristics.
- **Token counts follow each engine's convention and a row does not say which.** opencode folds `reasoning`
  into output (its provider bills it so); pi keeps the split it reported and folds only to price a turn it
  reported as zero (`src/core/pi/message-cost.ts`). So `output_tokens` is comparable across engines as a billing
  quantity, not as tokens emitted; a sum that cares keys on `engine_id`.
- **Hourly buckets, UTC:** `usage_bucket` replaces `daily_usage`, keyed by hour, account, billing type, engine,
  vendor, model and origin. Hours in UTC so any reader groups them into local days and the hub holds the same
  table; a daily row would bake in one timezone (rejected). **Retention:** `usage_event` rows are pruned at 90
  days (`pruneUsageTables`, once per database open), `usage_window_sample` at 30 days, buckets and the window
  ledger are kept forever. History from before attribution shows under the `unknown` account and counts in
  totals.
- Reconciled rows (`usage-reconciler.ts` imports transcripts every ten minutes) and live rows for one turn agree
  field for field. Because a row written now can carry yesterday's `ts`, no cursor over the ledger may be a
  timestamp.

### §2 Two costs, shown by billing type

- A subscription row shows `api_cost_usd` and says it is covered.
- An API-key row shows `billed_cost_usd` as the figure and `api_cost_usd` beside it; they differ when a gateway
  adds a margin. Showing only the API-equivalent was rejected for that reason.
- A null cost renders as `unknown` (ADR-030) and is never summed as zero; a total that includes unknown rows
  says how many (`sumCosts` returns the known total beside the missing count, and every surface prints it).
- `StatusLineData.totalCostUsd` follows the same rule on every engine, so an opencode or pi session under a
  subscription shows the API-equivalent figure labelled covered, not `$0`. `billedCostUsd` rides along for the
  tooltip. The dashboard includes dispatched rows in every total and marks them.
- **`dispatch.maxCostUsd` gates on the figure a headline shows,** for every target: API-equivalent under a
  subscription, billed under an API key. A target whose model has no price cannot be capped, and the dispatch
  card says so instead of showing an armed cap. (Keeping `dispatched_usage` and joining it at read time was
  rejected: no token split, account or vendor, so every question would need a second code path.)

### §3 `account_key` is derived from the provider, never from this machine

A vault id is minted on one machine, so it cannot identify an account elsewhere; the key must be identical on
every machine from the first row because changing keys later means rewriting the ledger (`src/shared/account-key.ts`):

- Claude subscription: `anthropic:<organizationUuid>:<accountUuid>`.
- ChatGPT subscription: `chatgpt:<chatgpt_account_id>:<user>`, `<user>` the id token's stable user claim, else
  the lowercased email, else the literal `unknown`. A missing user half degrades rather than discarding the key:
  the workspace half still names the subscription the limits and bill belong to.
- Any API key: `<vendor>:key:<hex16>`, the first 16 hex characters of SHA-256 over
  `claudeui-account-key-v1:<vendor>:<key>` (`account-key-hash.ts`, pinned by a test vector). A plain hash, not an
  HMAC, because it must be derivable on a machine that has no hub; a provider key carries at least 128 bits, so
  a 64-bit digest cannot be inverted, only used to confirm a key someone holds. The label shows the key's last
  four characters.
- Credentials an engine holds that nothing can identify: `<engine>:<vendor>:native`.

**A key names a subscription, not a person.** One email can hold a personal and a business subscription with
separate limits and bills, so the subscription's id comes first. The user part stays in the key because two
people's accounts can sit inside one ChatGPT workspace.

**Claude identity comes from the account directory's own credential, never `~/.claude.json`.** That file is
shared by every account directory and the terminal `claude`, and cli.js rewrites its `oauthAccount` only on a
daily profile refetch, so it names whichever process refetched last (this once keyed a day of rows to the wrong
subscription). The identity is resolved through `GET /api/oauth/profile` with the directory's credential, cached
on the `account` row and in memory per credential file, re-resolved when the file changes. Single-account
(Keychain) mode still reads `~/.claude.json`, where one login is the only login.

**opencode and pi need no patch.** `src/core/auth/account-identity.ts` reads the identity out of the engine's own
`auth.json` (oauth `accountId` plus the access JWT's user claim and email; an `api` key digest; an environment
or config key resolved the same way when readable) and returns the key and label and nothing else; no token or
key material reaches a log, an IPC payload or a row. Cached on path, mtime and size, read when the row is
written, so a sign-in change between turns attributes each turn to the account that ran it. A ChatGPT
subscription gets the same `chatgpt:` key through every engine. An Anthropic oauth entry in opencode's file
carries no account id and is `opencode:anthropic:native`; resolving it would cost a profile call with a token
that belongs to opencode.

`unknown` is a bucket, not an account: counted in local totals, never joined to a credential, never taken for a
label, never pushed to the hub (ADR-072 §2). **Claude rows are attributed by the account log (ADR-011 §4), not
by a key recorded at spawn**: the ADR's earlier claim that sessions this app spawns record the key directly is
not what is built.

### §5 Prices come from models.dev directly

`opencode-pricing.ts` fetches `https://models.dev/api.json` itself rather than reading opencode's view of it,
because that view is zeroed for whatever the user is signed in with, which is the wrong input for a list price.
It runs on boot and from the refresh button and is skipped when non-essential traffic is disabled. The built-in
table in `src/shared/pricing.ts` stays as the offline fallback and keeps precedence for Anthropic, where
cache-write tiers matter and models.dev has none. A models.dev outage leaves new models unpriced, shown as
`unknown`, which is the honest reading.

### §6 One limits provider per vendor; readings are kept

`usage-provider.ts` holds one provider per vendor behind `readAccountLimits`. Rules:

- A per-account failure is a value, not an exception: `AccountLimits.state` is `ok`, `stale` (answered from the
  last persisted sample because no token may be spent), `needs-sign-in` or `unavailable`, with `error`. One
  account needing a sign-in never blanks the others; a provider that throws yields nothing, not a crash.
- `source` is `local` or the observing device (id and name: a bare id answers nobody); `labelMasked` says the
  label is the hub's masked form rather than a name this machine read, so no surface renames an account silently.
- **Inactive Claude accounts are never refreshed in the background**: Anthropic may limit refresh grants and a
  timer spending them on unused accounts is the wrong trade. Use the stored access token while valid; refresh
  only when the user opens the dashboard or presses refresh; on a 401 during such a read spend one refresh grant
  and retry once; if that fails mark the account as needing sign-in (ADR-070's pill) and stop. A read that may not
  refresh marks it on the first 401. The one retry stays because refreshes are single-flighted per credentials
  file and stopping cold would turn a server-side revocation into a full sign-in. A stored account's identity is
  resolved only on a user-driven refresh, like its reading. With the hub enabled a reading relayed from the
  machine where the account is active beats any local fetch.
- **A relayed reading shows under both dashboard scopes.** A limit is a fact about the account; the scope switch
  decides whose spend is summed. The reading names the machine that took it, and a key this machine holds a local
  reading for keeps that local one whatever its state, `needs-sign-in` included, so a dead local credential is
  never hidden by a healthy reading from elsewhere.
- Readings are persisted (`usage_window_sample` with `account_key`, `window_kind`, `window_minutes`) for Claude
  and ChatGPT.
- **A window's kind and length come from the value the API states, never from its position.** Claude names its
  own windows (`5h`, `7d`, `7d:<slug>`). ChatGPT fills `primary`/`secondary` slots and states each length
  (`limit_window_seconds` / `window_minutes` / `windowDurationMins`); one shared function derives the kind from
  the duration (300 min is `5h`, 10,080 is `7d`, whole days or hours `<n>d`/`<n>h`, else `<n>m`). A window whose
  length the vendor withheld keeps the slot name and is labelled `limit`, never a guessed `5h`. When both slots
  state the same length the secondary's kind becomes `<kind>:secondary`, because a kind is an identity (sample
  dedup, `usage_window` key, meter key) and two windows may not share one. A window with no stated length is
  sampled but never materialised into `usage_window`: no length, no numerator. (This is why a weekly-only
  ChatGPT plan no longer files its one window under `5h`.)
- An absent window is absent (ADR-030): `AccountUsage.fiveHour` is nullable, so an API-key, Bedrock or Vertex
  account gets no fabricated 0% five-hour meter.
- ChatGPT business workspaces report credits and a member allowance (`creditLimit`) instead of windows; these
  are drawn as meters, never sampled, never a window kind (see ADR-072 §4 for their relay).

### §7 The window-value ledger

`usage_window` has one row per `(account_key, window_kind, canonical_end)`: the peak percent seen, and the
ledger's `api_cost_usd` and tokens for that account between the window's start and end, across all origins.
Window identity reuses ADR-011's `canonicalizeWindowEnd` for every kind.

- **A window closes 24 hours after its end, not at it** (`WINDOW_CLOSE_GRACE_MS`). Turns reach the ledger late
  (ten-minute reconciliation, sessions imported at the next start), so closing at the end would drop late
  arrivals. Until the grace is up the window is recomputed on every pass; a closed window is never touched
  again, which matters because the samples behind its peak are pruned at 30 days. A row landing more than a day
  late is not counted: the price of the bound. The hub applies the same grace (ADR-072 §4).
- **A reading at 0% names no window.** A meter at 0% has not started its window, so its reset is provisional
  (ChatGPT answers "a week from now" for an idle weekly limit, a different instant per reading, which had
  materialised nineteen windows for one idle account). A window is materialised only from a sample group whose
  peak is above 0%, locally and on the hub; earlier 0% readings with the same end still count towards its
  samples. The 0% samples themselves are kept.
- Dollars per 1% and the implied value of a full window (`api_cost_usd / peak_percent * 100`) are derived on read
  (`usageWindowSummary`), and the dashboard says they are biased low: the percent is the account's global
  utilization while the dollars are only what this ledger saw. The hub fixes the other-machines part by summing
  across machines; nothing fixes usage in claude.ai. A window whose peak is under 5%
  (`MIN_PEAK_PERCENT_FOR_VALUE`) keeps its real sums and peak and reports no derived figure; the floor lives on
  the read side so it can move without a migration. The figure is for comparing plans, not a quota.
- The ledger is derived from `usage_event` by `recomputeUsageWindows` right after the bucket rollup, and
  `unknown` is excluded from it.

### §8 The dashboard

A decided shape, not a pixel spec (the components are in `src/renderer/src/components/usage/`):

- Two tabs: Spend and Plan value. Range Today / 7d / 30d / 90d; Today is the viewer's local calendar day and the
  default for a fresh viewer (the hourly buckets make it a day of hours). Group-by provider, account, engine,
  model or machine on the Spend tab. The scope switch and sync chip are ADR-072's.
- One hero figure for API-equivalent spend, split into covered and billed and then by provider; it collapses to
  a one-line strip below about 600 px.
- Accounts are grouped by provider with a subtotal and window meters inline. A separate reset timeline was built
  and removed: it repeated every meter row for row.
- Window value is plan analysis, so it lives on the Plan value tab: the subscription comparison, per-window
  columns for the selected account, and peak percent against dollars delivered.
- Spend over time is stacked columns with a toggle to one row per provider on independent scales (providers
  differ about 30x, which flattens small ones on a shared scale).
- Breakdown is a provider, account, model tree with tokens, both costs and share. Dispatched rows are marked
  inline and counted in every subtotal.
- Claude's 5 h block analytics (current block, timeline, recent blocks, projection) live behind the Claude
  account rows as a drill-in: they describe one kind of account.
- Categorical colour follows the provider in a fixed order and a filter never repaints survivors. Meter fills
  always ship with an icon and the number, so state never rests on colour alone.

## The usage hub is an opt-in, self-hosted sync of the ledger (ADR-072)

Opt-in: with no hub URL configured no sync code runs and the dashboard has no scope switch. The project runs no
service; each user deploys the hub (one Cloudflare Worker, a D1 database, a React dashboard served as the
Worker's static assets, optionally R2) in their own account, from its own repository. ClaudeUI contains the
client and nothing else. D1 was chosen over a Durable Object because it is inspectable and restorable and
single-writer consistency is unnecessary once ingest is idempotent.

### §2 Sync is a one-way push of immutable rows

Merging two machines' rows is a union, so there are no conflict rules. A device keeps a high-water mark over its
local ledger and posts batches of at most 500 rows to `POST /v1/events`; the hub inserts
`ON CONFLICT(message_id) DO NOTHING RETURNING message_id`.

- **The hub answers `accepted + duplicates === events.length`.** A short answer is a client failure: the cursor
  stays and the error says how many rows went unaccounted for, otherwise the cursor would pass rows the hub
  silently dropped.
- Raw rows, not rollups: two machines that saw a turn would double-count it in a rollup. A retry, a month
  offline, and two machines importing the same transcripts all give each turn once.
- **The high-water mark is `usage_event`'s hidden `rowid`** (`usage_hub_config.cursor_rowid`, `ledger-cursor.ts`).
  `id` is a random uuid and `ts` is not monotonic (backfill); rowid rises with every insert and the 90-day
  prune deletes the oldest rows, so its maximum is never reused.
- **Every attributed row is pushed however old; a row keyed `unknown` never leaves the machine.** Attribution is
  the trust boundary, not the instant sync was enabled, so enabling moves no cursor (a fresh configuration starts
  at 0, a re-enable keeps its mark). An `unknown` row is read and skipped, not filtered in SQL, so the cursor can
  move past it. The combined view therefore begins where attribution began on each machine; earlier history
  stays in the "this machine" scope, and days that exist locally only as seeded buckets are never pushed.
  Re-pushing rows the hub holds is free (duplicates).
- **Resync is the repair for rows that changed.** Rows are immutable in normal operation but identity repairs
  re-key `account_key` on rows already written, and the hub ignores a `message_id` it has seen. So
  `POST /v1/devices/self/resync` (a button in the hub settings, a manual action for a known data fault) sends
  the timestamp of the device's oldest local row; the hub deletes that device's raw rows from that instant,
  rebuilds the affected buckets and windows and raises its `epoch`; the device resets its mark and pushes again.
  Rows older than the device can re-send are left alone, so resync never destroys history.

### §3 The hub reads from buckets it maintains at ingest

D1 bills by rows read, so a dashboard scanning raw events would burn the free tier. In the same batch as the
insert the hub folds the rows `RETURNING` reported as new into hourly UTC buckets plus a `device_id`, so a
replayed batch changes nothing. Buckets are kept for good; raw rows stay 360 days, then a scheduled job writes
whole machine-months to R2 as gzip NDJSON and deletes them from D1 (R2 optional; without a bound bucket nothing
is deleted). The archive is not read by anything yet; it exists for a later reprice or audit.

- Each bucket carries a monotonic `rev`; clients pull `GET /v1/buckets?since=<rev>&exclude_device=<me>` into a
  local `remote_usage_bucket` table, so the combined view works offline from the last pull and the renderer
  aggregates remote and local buckets with the same code.
- **The hub's `epoch`** rises whenever buckets are rebuilt (a resync). A client that sees an epoch it does not
  hold truncates its `remote_*` tables, resets both watermarks (`remote_rev`, `remote_window_rev`) and re-pulls
  in the same pass, because "changed since rev" cannot say something is gone. A client that has never pulled
  records the epoch it first sees and drops nothing.
- **One epoch per pass.** The epoch the hub reports to a device must not change between requests in the same
  minute unless that device's own resync caused it. The client reads the epoch from the pass's first response; a
  later different one means the hub rebuilt underneath, so the pass is abandoned with nothing written and runs
  again on the next tick.
- **A device never stores rows the hub attributes to itself**, even if returned: they are already local and the
  total would double. `device_id` is part of the primary key of `remote_usage_bucket` and `remote_usage_window`
  (two machines legitimately hold the same hour or window; merging them is the double counting this design
  prevents). `remote_limits` keeps the latest reading per account and kind across devices, `remote_device` and
  `remote_account` cache `GET /v1/devices` and `GET /v1/accounts`, and `remote_credits` caches relayed credits.
- **No bucket deletion ever travels, in either direction.** Local buckets disappear (the rollup retires a seed
  bucket per rebuilt day; the Claude identity repair drops a stale key's buckets) with no tombstone and no `rev`,
  and nothing has to travel: the hub folds its buckets from the events it was pushed, so a local recomputation
  is invisible to it and re-pushing events is a no-op. The hub removes an hour only in a resync, which the epoch
  announces.

### §4 Windows and limits are computed across machines

Devices post limit readings (`account_key`, `window_kind`, `usedPercent`, `resetsAt`, `observedAt`, with the
stated length). The hub keeps the latest per account and window and the samples.

- `GET /v1/limits` returns the latest reading per account with the observing device. A machine where an account
  is not active shows that reading and spends no token of its own: the answer to ADR-071 §6's refresh-grant
  concern.
- The hub maintains `usage_window` with the numerator summed over all devices, with the same 24-hour close grace
  and the same no-window-at-0% rule as the local ledger (ADR-071 §7). Clients prefer it in the combined view.
  **Windows page by `rev`, not by `updatedAt`:** a clock can step back or tie, and a change lost that way
  leaves nothing to notice it by; a counter cannot.
- **Credits travel as one reading per account, beside the windows.** `POST /v1/limits` takes an optional
  `credits` array (`accountKey`, label, vendor, plan, `credits` `{unlimited, balance}` or null, `allowance`
  `{used, limit, remainingPercent, resetsAt}` or null, `observedAt`; an entry with neither half is not one) and
  `GET /v1/limits` answers the latest per account, label masked for a device caller. The hub keeps only the
  latest (`credit_latest`, newest `observedAt` wins): an allowance is a monthly state, never a `window_kind`, a
  sample or a ledger window (it would materialise a window with no length). A published credits reading is dated
  by the last full read, never by a live turn's push (a push copies the previous allowance forward, and dating the
  copy by the push would overwrite another machine's newer reading). Sending the allowance as a made-up window
  kind was rejected: it loses the amounts and pollutes the window ledger.
- A machine more than 24 hours behind is flagged in the machine list, because its usage is missing from the
  combined window value (ADR-030).

### §5 What leaves the machine

- **Per event, exactly sixteen fields:** `messageId, ts, engineId, vendorId, modelId, inputTokens,
outputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, apiCostUsd, billedCostUsd, billingType,
origin, accountKey, accountLabel`. Both costs are nullable (an unknown is not a zero).
- **Per push:** the `deviceId` (a uuid generated once into the `meta` table, never derived from a hostname or MAC
  address), the user-chosen `deviceName`, the `appVersion` and the OS family (`process.platform`).
- **Per reading:** the fields in §4.
- **Account emails are sent** as `account_label`: the hub is the user's own, and a dashboard of opaque ids is
  useless. The hub returns them in full only to the owner's Google sign-in (§6).
- **Never sent:** prompts, responses, tool calls, file paths, working directories, session titles, session ids,
  routing ids (`parent_routing_id` stays local) and any credential. An API-key account's key is the 64-bit digest
  of ADR-071 §3; the key itself never leaves the vault.
- The never-sent list is enforced by the **encoder**, not by callers' discipline: `FORBIDDEN_EVENT_FIELDS` in the
  protocol codec is that list as data, and a payload carrying any of them is refused, not stripped. A ledger row
  does have a `sessionId` and a `parentRoutingId`, so "the mapper does not copy them" is one edit from false.

### §6 Authentication: Google sign-in for the owner, a credential per device

The requirement: the owner signs in from a browser with a Google account; each device authenticates with its
own API-key-style credential. Cloudflare Access is the mechanism because the Worker then holds no login code,
session cookies or stored device secrets; it is not itself a requirement.

- **Two callers.** A device presents an Access service token (`CF-Access-Client-Id`/`-Secret`) under a Service
  Auth policy; the owner passes a Google sign-in under an Allow policy naming one email. The Worker verifies the
  signed `Cf-Access-Jwt-Assertion` itself on every request (signature, `aud`, `iss`, `exp`): `common_name` and
  no email is a device, an email equal to the deploy-time owner variable is the owner, anything else is refused,
  so an Access misconfiguration fails closed. The device policy's action MUST be Service Auth: with Allow,
  Access accepts the token and still redirects to the login page. `workers_dev` and `preview_urls` are off so
  no hostname skips the gate. The allowed address appears in neither repository.
- **A device may:** write `POST /v1/events` and `POST /v1/limits`, resync itself, and read the aggregates
  (`/v1/buckets`, `/v1/windows`, `/v1/limits`), the device list (`/v1/devices`: id, name, OS, app version,
  last push, retired) and the account list (`/v1/accounts`), with account labels masked. It cannot read an
  email, a raw event or an owner route (those answer `403`), and the owner-only fields (`accountLabel`,
  `clientId`, `firstClientId`) are absent for a device rather than null, so it cannot tell a withheld value from
  a missing one. The device list is readable because without it "last seen" would be guessed from the newest
  bucket and a machine that synced but spent nothing would read as behind (ADR-030).
- **Masking:** device reads return the account key, vendor, plan and a masked label (`d•••@g•••.com`, or the last
  four characters for an API key). ClaudeUI shows its own full label for any key it holds a credential for and
  the masked label for an account only another machine uses.
- **A leaked service token** can add junk rows and read spend figures, account keys and masked labels; it cannot
  read an email, a raw event or anything that reaches a provider. Deleting it in Zero Trust ends it: accepted
  risk. One token per machine, so revoking one machine does not touch the rest (a shared token was rejected).
  **Revoking a device removes its access and nothing else:** its rows, buckets and name stay; the owner may mark
  it `retired` so the list stops flagging it. No route deletes a device's data. The hub has no enrollment route,
  no admin secret and stores no device credential; it records a client id and name on a token's first write.
- **The device credential is kept in the operational database, not the vault or a settings file.** It lives in
  the single-row `usage_hub_config` table beside `remote_config`'s password hash, because
  `config:save-settings` is reachable from a remote client and anything a settings file carries is remotely
  writable. The app has no OS credential store. The secret is written by one write-only channel
  (`usage-hub:set-secret`) and read by one function that hands it to a request header; `usage-hub:status`
  answers `hasSecret: boolean`, and no query returns the secret.
- **A rejected credential is a 302, a 401 or a 403.** Access answers a bad service token with a redirect to its
  login page, so the client sends every request with `redirect: 'manual'` and treats ANY 3xx, 401 or 403 as
  "credentials rejected"; following the redirect would parse an HTML login form as the hub's answer.
- **The six `usage-hub:*` channels keep the `config` capability** (`admin` was ruled against): a remote client
  with `config` can re-point the hub URL, but `config:save-vendor-config` already lets it redirect the whole
  conversation stream and the Anthropic token, so moving these channels would only block configuring the hub
  from a phone while narrowing nothing already open. The secret is protected structurally: write-only, no wire
  shape carries it back.
- **A resync is bound to the token a device first pushed under.** Any valid token may push under any `deviceId`
  (a machine keeps its id across a token rotation), so the hub keeps `client_id` (last seen) and
  `first_client_id` (set at insert, never rewritten by a device route). Resync acts only when the caller's
  `common_name` equals `first_client_id`, else `409`, not `403`: the client reads 403 as a bad credential and
  would tell a machine with a legitimately rotated token that its working credential is bad. The owner rebinds
  after a rotation through the hub dashboard. `MAX_READINGS_PER_PUSH = 500` matches the client's queue depth so a
  machine offline for a day is not a permanent `400`.
- `account_alias` (showing two keys as one) is deferred until a real case appears; rows keyed `unknown` are
  never pushed. A hub-side Worker-verified device-key design is the unbuilt fallback if Access ever cannot serve
  both callers.

### §7 The client

It lives in `src/core/services/usage-hub/`, so the desktop app and `claudeui-server` both sync. The outbox is
the ledger plus the high-water mark; there is no second queue.

- **A pass pushes and then pulls.** Triggers: a row-written notifier (`onUsageEventWritten`, fired only when an
  insert actually added a row, debounced to one pass a minute), a ten-minute timer, and a pressed Sync. Opening
  the dashboard does not start a pass; the settings card and machines card carry a Sync now button. Limit
  readings use the same notifier shape (`onLimitSamplesWritten`, reporting only readings that produced a write,
  so an unchanged reading is not re-dated on the hub).
- **Sync never blocks or fails a turn.** Failures back off 5 s, 15 s, 60 s, 5 min, then doubling to a one-hour
  ceiling, honouring `Retry-After` on a `429`.
- **State vocabulary** (`usage-hub:status`): `off`, `idle`, `syncing`, `backoff`, `needs-credentials`,
  `update-hub`, `error`. `needs-credentials` and `error` schedule no retry (only a person can fix them);
  `update-hub` (a `426`) keeps the cursor and pauses until restart or a pressed Sync.
- **A paused client is paused for everything:** `needs-credentials`, `update-hub`, `error` and `off` arm no
  timer and no notifier push, so a dead credential does not send a request train on every turn. A user action
  (pressed Sync, `configure`, `set-secret`) lifts it, never activity.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppresses the timers and the notifier but never a sync the user
  pressed (the rule the models.dev refresh follows).
- **A device announces itself with an empty push:** an empty `events` array is valid and answers
  `{ accepted: 0, duplicates: 0, epoch }`; the client sends one when it has never pushed and whenever name,
  build or OS family changed (last announced triple in `meta` under `hub.announced`). Otherwise a machine that
  enabled sync would pull the combined view while the hub's list never mentioned it.
- Settings has a Usage hub group (URL, device name, token fields, last sync, forget this device); the dashboard
  header has the scope switch and a sync chip opening the machine list.

### §8 Versioning across two repositories

Routes are under `/v1/`. Every request carries `schemaVersion` (body for a POST, query parameter for a GET) and
every route may answer `426`: versioning only writes would let a read hand a client a shape it cannot parse,
which it would take for corrupt data rather than "update your hub". A hub that gets a newer version answers
`426` with its own; the client shows "update your hub" and keeps its mark. A newer hub accepts older batches.
Every route checks `schemaVersion` before it can answer `404`.

- **Current: `SCHEMA_VERSION = 2` and ten routes**, stated in `src/core/services/usage-hub/protocol/types.ts`,
  the authority: `POST /v1/events`, `POST /v1/limits`, `POST /v1/devices/self/resync` (device); `GET
/v1/buckets`, `/v1/windows`, `/v1/limits`, `/v1/devices`, `/v1/accounts` (device or owner); `GET /v1/hub` and
  `PATCH /v1/devices/<deviceId>` (owner only; a device gets `403`).
- **A version states a new route or a changed meaning, never an added optional field.** Credits (§4) are
  additive under version 2: decoders ignore keys they do not know and read a missing array as empty, so either
  side older than the other just shows no credits, where a bump would have paused all sync with `426` for a
  display-only field.
- **The hub repository owns the protocol** (wire types, golden fixtures, version numbers). The copies in
  `src/core/services/usage-hub/protocol/` and `scripts/fake-usage-hub.ts` are vendored: `protocol/README.md`
  says so, and they change only by copying back from the hub repository. A unit test replays every fixture
  through the codec and asserts identical bytes; the gated integration test
  (`src/integration/usage-hub/`) runs against the fake hub. A Miniflare-hosted hub in this repository's tests was
  judged too heavy for what it would catch.

### The hub dashboard

A React page built with Vite and served by the Worker as static assets behind the same Access application,
shown for when no ClaudeUI instance is running. It shows the combined view only (Spend, Plan value, Machines
tabs, following ADR-071 §8) and reads the same `/v1/*` routes as the owner, so it gets full labels and
owner-only fields with no auth code of its own; there are no `/dash/*` routes. It repeats some of this repo's
chart code as hand-drawn SVG and shares only `protocol/` (sharing components would mean publishing a package).
Retention (§3) runs from a nightly cron.

Consequences that still bind: cost figures are computed on each device at write time, so two app versions can
price one model differently until both update (the hub stores token counts, so a hub-side reprice is possible
later and not built). The user owns the Cloudflare account, the deploy and its upkeep; the project sees no data.
The free tier suffices (D1 100,000 writes a day against a few thousand events per machine; reads hit buckets).
Syncing files through R2 or a cloud drive was the closest rival, rejected because the window value needs a
cross-machine sum and a latest-reading lookup and the dashboard must work with every machine off.
