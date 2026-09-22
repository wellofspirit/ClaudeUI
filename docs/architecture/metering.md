# Metering, the usage dashboard and the usage hub, as built

Part of [architecture/](README.md). **Status:** as-built record of the metering ledger (ADR-071), the
usage dashboard it feeds, and the opt-in sync of that ledger to a self-hosted usage hub (ADR-072).
The hub is a Cloudflare Worker in its own repository; this file describes the client and summarises
what the Worker promises.

Everything here runs in `src/core`, so the desktop host and `claudeui-server` meter, roll up and sync
the same way. The renderer sees it through the `usage:*` and `usage-hub:*` channels only.

## Why

The usage dashboard was built for one engine and one account. With four engines and several accounts
per provider it answered the wrong questions and some of its answers were wrong. Codex spend reached
no store at all. `StatusLineData.totalCostUsd` meant three different things depending on the engine,
and opencode bills a subscription-authenticated provider at zero, so a session on a ChatGPT plan
reported `$0`. Rows could not say which account ran a turn or whether anything was charged for it,
because `usage_event` carried no account key and no billing type, `daily_usage` carried no account
column at all, and dispatched work lived in a third table with neither. ADR-071 answers that with one
ledger, two costs per row, an account key derived from the provider rather than from this machine,
hourly buckets that outlive the ledger, and a window ledger that says what a subscription window
delivered in dollars.

A subscription's limit percentage is global to the account, while each machine sees only its own
spend. On several machines signed into the same accounts, no machine can show the real total, and the
window value reads low everywhere because the percent counts every machine and the dollars do not.
ADR-072 answers that with an opt-in sync: raw ledger rows are pushed to a hub the user deploys
themselves, the hub keeps hourly buckets and recomputes the window ledger across every machine, and
each machine pulls the aggregates back. The project runs no service, the hub is one user's, and with
no hub configured no sync code runs.

## The ledger

`usage_event` is the only store of what a turn cost. Every engine and every origin writes one row per
turn that moved tokens, through `recordUsageEvent` in `src/core/services/usage-recorder.ts` for live
turns and through `claudeTranscriptRow` or `backfillAttribution` in the same module for rebuilt ones.
`message_id` is unique, so the live path and the reconciler can both insert the same turn and one of
them wins. A recording failure is logged and swallowed; metering never fails a turn.

A row carries what the turn was (`engine_id`, `vendor_id`, `model_id`, the five token counts), what
it was worth (`equiv_cost_usd` and `engine_cost_usd` as the raw inputs, `api_cost_usd` and
`billed_cost_usd` as the two resolved figures), and who ran it (`account_key`, `account_label`,
`billing_type`). `origin` is `session`, `child` for a native subagent or a Codex child thread, or
`dispatch`, and `parent_routing_id` names the spawning or dispatching session for the last two.
Migration v18 added those seven columns; `SessionManager.rekey()` renames `parent_routing_id` with
the session it belongs to.

Token conventions differ per engine on purpose, and a reader cannot tell from the row. opencode folds
`reasoning` into the output count, in `OpencodeSession` and in `usage-reconciler.ts` alike, because
every provider it meters this way bills reasoning as output and `info.cost` already includes it. pi
does not: its rows carry the engine's own split, and the fold happens only inside
`src/core/pi/message-cost.ts` when our table has to price a turn pi reported as zero. Codex needs no
fold, because `reasoningOutputTokens` is already a subset of `outputTokens` on its wire;
`codexDisjointTokens` in `src/core/codex/usage-ledger.ts` is the one place its nested counts become
the disjoint ones a price and a row want.

The two costs come from `resolveCosts` in `src/shared/cost-rule.ts`, applied once at write time by
`rowCosts`. Under a subscription the bill is zero and the display figure is the equivalent; under an
API key the bill is the engine's figure when it is finite and not negative, and the display figure
falls back to the equivalent when the engine reported none; a free vendor displays zero; under
`unknown` an engine zero is not read as free, so only a positive figure counts as a charge. `rowCosts`
branches on `engineCostIsEquivalent`, a property of the figure rather than of the engine: cli.js and
pi report list prices whatever the plan, opencode reports what it charged. Null means unknown and is
never summed as zero (ADR-030): `sumCosts` and `totalCosts` return the known total beside a count of
what was missing from it, and every surface prints that count rather than absorbing it.

An account key names a subscription, not a person, and is derived from what the provider says so that
two machines agree on it. `src/shared/account-key.ts` states the four forms:
`anthropic:<organizationUuid>:<accountUuid>`, `chatgpt:<chatgpt_account_id>:<user>`,
`<vendor>:key:<hex16>` for an API key, where the digest is the first 16 hex characters of a SHA-256
over a domain-separated prefix (`src/core/services/account-key-hash.ts`, pinned by a test vector), and
`<engine>:<vendor>:native` for credentials an engine holds that we cannot identify. opencode and pi
need no patch: `src/core/auth/account-identity.ts` reads the identity out of the engine's own
`auth.json`, returns the key and the label and nothing else, and caches on the file's path, mtime and
size so a sign-in between turns attributes each turn to the account that ran it. Codex resolves its
key through `CodexAuthHook.accountIdentity`, which gives the same `chatgpt:` key for the same
subscription, so spend through any of the three engines lands on one account.

`unknown` is the bucket, not an account. It holds history from before attribution, rows whose account
nothing on disk can name, and Claude turns from sessions this app did not spawn while several account
directories exist. It is counted in local totals, never joined against a credential, never taken for a
label, and never pushed to the hub.

Claude rows are attributed by time, because a transcript names no account. `claudeAccountAttribution`
in `src/core/services/usage-windows.ts` resolves a row's timestamp against the account log and has
three answers: a record, the `unknown` bucket, or deferred. Deferred is the switch instant: when the
active credential directory changes and its identity cannot be read yet, `usage-fetcher.ts` appends a
marker stamped at the switch and the writers in `block-usage.ts` hold those rows back rather than
writing them under the previous account. A marker resolves within seconds in practice, and rows under
one that never resolves are written as `unknown` after 24 hours.

Dispatched turns are ledger rows. `cross-engine-dispatcher.ts` writes one per target turn with
`origin: 'dispatch'` and the dispatching session as `parent_routing_id`, so delegated work is inside
every dashboard total and can still be marked. The opencode reconciler skips the dispatcher's own
throwaway sessions by their title (`OPENCODE_DISPATCH_SESSION_TITLE`), because their messages are
already rows and a second copy under opencode's own message ids could never be deduplicated.

`usage-reconciler.ts` imports usage that happened outside this app. It runs at start-up and every ten
minutes: Claude from the JSONL transcripts through block-usage's parse, opencode by enumerating
sessions from opencode's own store and fetching each session's messages over HTTP. Both paths write
through the shared builders, so a reconciled row and a live one for the same turn agree field for
field. That cadence is also why a ledger cursor cannot be a timestamp: a row written now can carry
yesterday's `ts`.

`pruneUsageTables` in `db.ts` runs once per database open and deletes `usage_event` rows older than
90 days and `usage_window_sample` rows older than 30. The ledger is the recent detail; the buckets and
the window ledger below are the durable history.

## Hourly buckets and the window ledger

`usage_bucket` (migration v20, which also dropped `daily_usage` and `dispatched_usage`) is one row per
hour, UTC, keyed by `(hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin)`.
Hours in UTC so that a reader in any timezone can group them into its own local days and the hub can
hold the same table. Buckets are kept for good.
`BlockUsageService.rollupUsageBucketsFromDb` recomputes the last seven days of hours from the ledger
on every rebuild and retires the coarse seed buckets for the days it just rebuilt. Migration v20
seeded one bucket at 12:00 UTC per `daily_usage` day, keyed `unknown`, which lands inside the intended
local day everywhere from UTC-12 to UTC+12.

Two sums a bucket keeps are not obvious. `unknown_api_cost_count` and `unknown_billed_cost_count` are
how an hour says what is missing from it rather than absorbing an unpriced turn as zero.
`unbilled_api_cost_usd` is the `api` half of the row rule's `billed ?? api`, summed separately, so
`bucketDisplayCostUsd` in `src/core/services/usage-aggregation.ts` can hand the hour to the row rule
and get exactly the sum of its rows' display costs, even for an hour where only some turns reported a
charge. Every bucket write stamps a fresh `rev` from a one-row counter, which is what the hub pages
by.

`usage_window` (migration v22, `window_minutes` added in v25) is one row per
`(account_key, window_kind, canonical_end)`: the highest utilization ever reported for that window
beside what the ledger saw the account spend inside it. `recomputeUsageWindows` in
`src/core/services/usage-window-ledger.ts` runs right after the bucket rollup, from the same `now`.
It materialises every window a sample in the 30-day lookback names, sums `usage_event` over the
window's half-open interval for that account key across all origins, and takes the numerator as the
literal sum of `api_cost_usd` with the unpriced turns counted rather than added. A window's span comes
from `window_minutes` when the vendor stated one and from the kind's own name otherwise; a window whose
length nothing states is sampled and never materialised, because with no interval there is no
numerator. Windows seeded by v22 are open, and `unknown` is excluded from the seed and from every
recompute.

A window closes 24 hours after its end, not at its end (`WINDOW_CLOSE_GRACE_MS`). A turn reaches the
ledger later than it happened, so a window shut on the first pass past its end would drop every late
arrival; until the grace is up the window is recomputed like any other open one, and the pass that
closes it has just summed it. A closed window is never touched again, which matters because the
samples behind its peak are pruned at 30 days.

The derived figures live on the read side. `usageWindowSummary` returns dollars per percent and the
implied value of a full window, null for any window whose peak is under 5 percent, so a small peak
cannot turn noise into a headline. Every row is flagged `biased`: the percent is the account's global
utilization while the dollars are only what this ledger saw. Under the combined scope the same
function prefers the hub's row for a window it knows, which closes the other-machines half of that
bias; nothing closes the claude.ai half.

## Limits providers and identity

`src/core/services/usage-provider.ts` holds one limits provider per vendor behind
`readAccountLimits({ refresh, relayed })`. A provider answers for every account this machine holds
credentials for, not only the active one. The Claude provider reads the active account through
`usage-fetcher.ts` and each stored account directory (ADR-015) through `fetchClaudeUsage`; the ChatGPT
provider maps `ChatgptRateLimitStore`'s snapshot, resolving each vault account's identity through
`CredentialSync.accountIdentity`. A provider that throws yields nothing rather than blanking the
others, and a per-account failure travels as `state` on that account.

Inactive accounts are never refreshed on a timer. `refresh: false` answers from the last persisted
sample through `latestWindowSamples` and spends nothing; `refresh: true` is a person opening the
dashboard or pressing the button, and it is the only thing that reads a stored account's credentials.
The refreshing sweep is single-flighted, because the channel is registered on both transports and two
dashboards asking at once would be two sets of refresh grants.

`authorizedOAuthGet` in `src/core/services/claude-usage-api.ts` owns the credential rules for both
`/api/oauth/usage` and `/api/oauth/profile`: a 60-second expiry buffer, a refresh only when the caller
allows one, and on a 401 exactly one refresh and one retry before the account is marked as needing
sign-in. A 429 is its own answer rather than a failure, and a refresh that fails on the network is
`unavailable` and retried with backoff rather than reported as a dead credential.

A Claude account's identity is read from its own credential, never from the shared `~/.claude.json`.
That file is one file for every account directory and for the terminal `claude`, and cli.js rewrites
its `oauthAccount` when it refetches the profile, so the block names whichever process refetched last.
`resolveClaudeDirIdentity` in `src/core/services/claude-account-identity.ts` asks
`GET /api/oauth/profile` with the directory's own token, the answer is cached on the `account` row and
in memory per credential file, and it is re-read when the file changes. Migration v23 cleared the four
identity columns that had been guessed from the shared file and added the one-shot repair marker that
re-keys the rows written under the stale attribution. Single-account mode still reads the shared file,
where one login is the only login.

A window's kind and its length come from the value the API states, never from the window's position
in the payload. Claude names its own windows, so `5h`, `7d` and `7d:<slug>` are the payload's own
vocabulary. ChatGPT names nothing: it fills a `primary` and a `secondary` slot and states each
window's length, and reading the slot as the kind filed a weekly-only plan's one window as a five-hour
one. `src/shared/window-kind.ts` derives the kind from the duration for core and renderer alike, gives
a window whose length the vendor withheld the slot's own name and the honest label `limit`, and
suffixes the secondary `<kind>:secondary` when both slots state the same length, because the kind is
an identity in four different places downstream.

`recordLimitSamples` in `src/core/services/window-samples.ts` is the one writer of
`usage_window_sample`. All three callers agree there on the canonical window end and on the
`(account_key, window_kind)` a row is filed under, an unchanged reading writes nothing, and a window
with no reset instant is skipped. The same function reports what it actually wrote through
`onLimitSamplesWritten`, which is what the hub client pushes.

## The dashboard

`buildUsageDashboard` in `src/core/services/usage-dashboard.ts` answers `usage:dashboard` from one
bounded read of `usage_bucket`, plus a second read of `remote_usage_bucket` under the combined scope.
There is no aggregate SQL: the grouping key is an account-key rule and a bucket's display cost is the
cost rule, so both are computed in TypeScript over one fold. The range runs from the local midnight
`range` days before now, floored to the UTC hour, and yields `range + 1` day columns; `today` is that
rule with zero days plus an hourly series at the ledger's own grain. Buckets above the last column are
excluded from the fold outright, so the series always sums to the hero even when a peer's clock runs
fast.

The renderer shell is `src/renderer/src/components/usage/UsageView.tsx`. It owns the range (`today`,
`7d`, `30d`, `90d`), the group-by (provider, account, engine, model, machine), the scope, the tab and
both reads; the widgets are pure functions of what lands there. Two tabs: `Spend` mounts `Summary`,
`AccountsPanel`, `SpendChart`, `BreakdownTable` and `MachinesPanel`, and `Plan value` mounts
`WindowValue` alone, which makes its own `usage:windows` read because windows are a differently shaped
query nothing else consumes. The shell is also the only place in the app that passes `refresh: true`
to the limits read, on a button click, because that is the one call that can spend a refresh grant.

`Summary` draws the hero, which is the display cost of everything in range, with a bar splitting it
into what a plan absorbed and what was charged and then by provider, and the count of unpriced turns
beside it. `AccountsPanel` is the union of the ledger's accounts and the credentials the limits
providers found, joined on the account key and never on `unknown`, with each account's windows inline
as meters; the Claude block analytics live behind those rows in `ClaudeBlocksDrillIn`. `SpendChart`
stacks display cost by provider per day or per hour, because `byProvider` is the only per-day split
the query carries, and says so when the group-by disagrees. `BreakdownTable` is a tree whose levels
the group-by reorders, with dispatched work as an inline marker on the row it ran under rather than a
section of its own. `WindowValue` compares subscriptions, charts one account's windows in time order
and scatters peak against dollars. `MachinesPanel` lists the machines, flags one more than 24 hours
behind against the reader's own clock, and is the only widget that says which machines the combined
figures came from.

An account's name resolves in one order, in `toProviders`: a label this machine read from a
credential, then the newest label the ledger recorded, then the hub's masked form, then the key's own
second segment. The masked form itself has two sources under the combined scope, gathered in
`limitsLabels`: a relayed limit reading first, then the hub's account list for every key no reading
named, which is the only way an API-key account gets a name, since a key has no rate-limit meter.
`unknown` is checked before all of them and renders as unattributed history, because any label found
under it belongs to something else. A row that took a masked form carries `labelMasked`, so nothing
renames an account silently.

## The hub client

`src/core/services/usage-hub/` is the whole client. `device.ts` keeps this machine's identity: a uuid
generated once into `meta` under `hub.device_id`, never derived from a hostname or a network card,
because the hub keys a machine's whole history on it. The name defaults to the hostname and is
editable, and each push also carries the OS family and the app version, the latter through the
`hostAppVersion()` seam in `core/host.ts` since `app.getVersion()` is main-only.

`config.ts` owns the stored row and the perimeter. The hub URL is accepted as an origin only, https
except on loopback, with no path, query, fragment or userinfo. The device credential is an Access
service token, and it lives in the operational database beside the remote server's password hash, for
the reason `remote_config` gives: `config:save-settings` is reachable from a remote client, so
anything a settings file carries is remotely writable, and the auth vault is plaintext JSON at mode 0600. `setHubSecret` is the only writer, `hubCredential` the only reader, and no query channel returns
it; `usage-hub:status` answers `hasSecret` instead.

The outbox is the ledger itself plus a high-water mark over `usage_event`'s hidden rowid, in
`ledger-cursor.ts`. Neither of the obvious candidates works: `id` is a random uuid and `ts` is not
monotonic, while rowid rises with every insert and the prune deletes the oldest rows, so its maximum
is never reused. **The push rule, as ruled on 2026-09-22: every attributed row is pushed however old,
and only `unknown` rows are ignored.** An `unknown` row is read and skipped rather than filtered out
in SQL, so the cursor can move past it, and a batch can legitimately be forty rows read, twelve
pushed. Enabling sync no longer seeds the cursor at the newest local row; the hub's combined view
therefore reaches back over the whole local ledger rather than beginning where a machine joined. That
supersedes the earlier "start fresh from enable time" ruling, and `config.ts` and `client.ts` are
where it is stated; the migration that carried it also reset this machine's cursor once, so the
history already on disk is re-read under the new rule and the hub deduplicates what it already holds.

`client.ts` runs the pass. A push sends batches of at most 500 events, advancing the cursor only after
the hub has taken a batch, then the queued limit readings. An empty events array is a valid request
and is how a machine announces itself: the hub learns a device exists only from that route, and the
three device facts travel only on it, so the client sends one when it has never pushed or when the
facts have changed since the marker in `meta` under `hub.announced`. A pull walks buckets paged by the
hub's `rev`, then windows by their own `rev`, then the latest limit reading per account and kind, then
the machine list, then the accounts list that names a key a bucket only keys. Every response carries
the hub's `epoch`; the client takes it from the first response of a pass and holds it, drops every
`remote_*` cache and re-pulls from zero when it differs from the stored one, and abandons the pass
without writing anything when a later response in the same pass disagrees. Rows the hub attributes to
the calling device are dropped on the way in, so no hour is counted twice.

What a pull stores is five cache tables, added by migrations v26 and v27 beside `usage_hub_config`
itself. `remote_usage_bucket` and `remote_usage_window` mirror their local twins with a `device_id`
that joins the primary key, because two machines legitimately hold the same hour or the same window
and merging them there would be the double counting the whole design avoids. `remote_limits` keeps
the latest reading per account key and window kind, so its `device_id` records who saw it rather than
being part of the key. `remote_device` is the machine list, which is the only place a peer's name can
come from, and `remote_account` is the account list. None of them has a foreign key into the local
tables: a remote row is about an account this machine may never have held a credential for.

Resync is the one repair, and it is a button rather than anything automatic. The client sends the
timestamp of its oldest local ledger row, the hub deletes that device's rows from there forward,
rebuilds and raises its epoch, and the cursor goes back to zero so the local ledger is re-pushed.

Failure is a state, never an exception. Any redirect, a 401 or a 403 is `needs-credentials`, which is
why every request uses `redirect: 'manual'`: Access answers a bad service token with a 302 to its
hosted login page, and a client that followed it would parse an HTML form as the hub's answer. A 426
is `update-hub`, which leaves the cursor exactly where it was. A 5xx, a network error or a 429 is
`backoff`, walking 5 s, 15 s, 60 s and 5 min and then doubling to a one-hour ceiling, honouring
`Retry-After`. Any other 4xx is `error`. Four of those states arm nothing at all, not the ten-minute
interval and not a push behind a turn ending, and all four are lifted only by a user action. Pushes
are otherwise triggered by the row-written notifier debounced to one a minute, by the ten-minute
timer, and by a pressed Sync. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppresses the timers and the
notifier subscriptions but never a sync the user pressed, which is the rule the models.dev refresh
already follows.

Six channels carry all of it, declared once in `src/core/ipc/usage-hub-commands.ts` and served by both
transports: `usage-hub:status`, `configure`, `set-secret`, `sync-now`, `resync` and `forget`. They sit
at the `config` capability, like the `usage:*` family, and every argument is sanitised at the
perimeter in `config.ts`. `usage-hub:changed` is emitted on every state change so the settings card
and the dashboard chip refresh.

## The protocol

The hub owns its protocol. `src/core/services/usage-hub/protocol/` is a vendored copy of the hub
repository's `protocol/` folder, as its own README says: change it there, get the contract test green
against both the Worker and the fake hub, then copy it back. `types.ts` holds the declarations and the
two rules that are not shapes, `codec.ts` the encoders, decoders and the privacy check, and
`fixtures/` one golden JSON file per request and response, which a replay test asserts round-trips
byte for byte. The folder is deliberately self-contained, and `billingType`, `origin` and `windowKind`
are plain strings so that a hub can accept a value a newer client knows.

This build speaks `SCHEMA_VERSION = 2`. Every request states its version, in the body on a write and
in the `schemaVersion` query parameter on a read, and every route may answer `426 { hubSchemaVersion }`.

| Route                          | Caller        | What it does                                                                             |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------- |
| `POST /v1/events`              | device        | Up to 500 rows, idempotent on `messageId`; an empty array announces the device           |
| `POST /v1/limits`              | device        | Up to 500 limit readings, each with its window kind and stated length                    |
| `POST /v1/devices/self/resync` | device        | Delete this device's rows from `since` forward, rebuild, raise `epoch`                   |
| `GET /v1/buckets`              | device, owner | Hourly buckets paged by `rev`, excluding the caller's own, with an optional `from` bound |
| `GET /v1/windows`              | device, owner | The hub's window ledger paged by `rev`, every row carrying the literal `deviceId: "hub"` |
| `GET /v1/limits`               | device, owner | The latest reading per account key and window kind, with the device that observed it     |
| `GET /v1/devices`              | device, owner | The machine list: id, name, OS family, app version, last push, retired                   |
| `GET /v1/accounts`             | device, owner | One row per account the hub has heard of, with the newest label it was told              |
| `GET /v1/hub`                  | owner         | The hub's status line: schema version, last recompute, retention, whether R2 is bound    |
| `PATCH /v1/devices/<deviceId>` | owner         | Rename, retire or unretire, rebind the resync token; any combination, none is a 400      |

Two promises the client's correctness rests on. `accepted + duplicates === events.length` on every
push, counting a row the hub refuses on validation as a duplicate: a short answer means rows were
dropped silently, so the client treats it as a failure and holds its cursor. And one `epoch` per
device per minute, unless that device's own resync changed it, which is what lets a pass hold the
epoch it first saw.

A device and the owner see different answers from the same routes. A device gets the aggregates with
`accountLabel` masked by the hub (`d•••@g•••.com`, or an API key's last four) and never sees a raw
event or another machine's `clientId`; the owner, meaning a browser signed in through Google, gets
full labels and the owner-only fields, and the two owner routes refuse a device with a 403. What may
leave a machine at all is enforced by the encoder rather than by its callers: `FORBIDDEN_EVENT_FIELDS`
is ADR-072 §5's never-sent list as data, and `encodeEvent` refuses a payload carrying any of those
keys instead of stripping them, because a ledger row does have a `sessionId` and a `parentRoutingId`.

`scripts/fake-usage-hub.ts` is the reference implementation of the same contract, also vendored from
the hub repository. It is self-contained, imports nothing from `protocol/`, and restates the shapes
from the fixtures, which is what lets it catch the Worker and the contract disagreeing. It is faithful
where the client's correctness depends on it (idempotency, buckets maintained at ingest, one monotonic
`rev`, the accounting promise, masking, a 302 rather than a 403 on a bad token) and thin everywhere
else (no D1, no JWT verification, no sign-in, and a `/debug/store` the Worker does not have and never
will).

## The hub

The hub is a separate repository: one Cloudflare Worker, one D1 database, one React dashboard served
as the Worker's static assets, deployed by whoever owns it. Its README is the reference for the wire
promises, the Access recipe and the deploy order; what follows is only the shape.

D1 rather than a Durable Object, because it can be inspected with `wrangler d1 execute`, it has
time-travel restore, and once ingest is idempotent the single-writer consistency is not needed. Reads
are served from the buckets the hub maintains in the same batch as the insert, never from raw events,
because D1 bills by rows read.

Every path sits behind one Cloudflare Access application with two policies, and the Worker verifies
the `Cf-Access-Jwt-Assertion` itself on every request. A service-token assertion carries `common_name`
and no email and is a machine; an assertion carrying the configured address is the owner; anything
else is refused, so a hostname that somehow bypassed Access still fails closed. The device policy's
action must be Service Auth, and the application's 401 response for failed service auth should be on,
or a bad token gets a login redirect instead of a refusal. A resync is bound to the token a device
first pushed under and answers 409 to any other, because any valid token may push under any device id;
after a rotation the owner rebinds the machine from the dashboard.

The window ledger is the hub's own arithmetic and the one thing no machine can compute: its numerator
is summed over every device's turns. A cron recomputes it every 15 minutes, with the same 24-hour
grace before a window closes, and every open window gets a fresh `rev` on each pass. Raw events are
kept for 360 days; a nightly job archives the oldest whole machine-month to R2 as gzip NDJSON and then
deletes exactly that range, and with no bucket bound it deletes nothing at all. Buckets and windows
are never pruned.

The dashboard at the hub's root reads the same `/v1/*` routes a machine does, as the owner, so it
needs no auth code of its own. It exists for when no ClaudeUI instance is running.

## Testing

Unit tests cover the rules and the client. `src/core/services/usage-hub/__tests__/` drives the client
against a scripted `fetch` (the pattern `claude-usage-api.test.ts` established), the cursor against a
seeded ledger, and the protocol through the fixture replay. The cost rule, the account keys, the
window kinds, the bucket rollup, the window ledger and the dashboard query each have their own suites,
and `bun run verify:sqlite` replays every migration under `bun:sqlite`, which the arm vitest cannot
host.

`src/integration/usage-hub/usage-hub.integration.test.ts` is gated behind `bun run test:integration`.
It spawns `scripts/fake-usage-hub.ts` as the standalone process it will be in the hub repository and
proves what a mock cannot: that the two ends agree on the routes, the query parameters and the JSON
shapes; that a replayed batch is answered as duplicates and changes no bucket; and that under
`--flaky 0.3` every event still arrives exactly once.

Anything user-visible is then driven in the real Electron app against a real profile, with the live
DOM asserted by `data-testid` before a screenshot is read (ADR-027, the `verifier-electron` skill).
That is not optional for this surface: fixture-driven component tests passed while real data broke the
join on `unknown`, the coverage bar's sizing and the limits-without-spend case. A hub can be driven
the same way by pointing a running app at the fake hub, which takes a `--seed` file and a
`--debug-store` route for the assertions.

## Gotchas worth keeping

An older build that opens a database a newer build has migrated warns and proceeds read-forward, and
an older build that already has the database open keeps running; its reads of a table a migration
dropped fail on every tick. That is how v20
produced a stream of `no such table: daily_usage` in a packaged instance while a dev build migrated
underneath it. Restart or rebuild the other instance after pulling a schema change.

`pruneUsageTables()` runs at every database open, so a claim that the ledger is unchanged has to allow
for rows past 90 days disappearing.

A Playwright-launched instance is not packaged, so `session.ipc.ts` skips block usage and it can never
materialise a `usage_window` itself. Only a packaged instance, or one launched with
`CLAUDE_UI_DEV_USAGE=1`, exercises that path.

Any test that can reach an auth provider's credential reader must mock the provider or isolate its
home. Three suites were found reading a real opencode `auth.json` the moment product code started
asking for an identity, and one suite booting the real service graph started the real usage poll,
which appended a record to the real account log and mis-attributed live turns to another subscription.
Both vitest setup files now pin `USERPROFILE` and `HOME` to a per-process temp home, which is the
containment that actually holds; check for this whenever a new caller of `accountIdentity()` or of
`startCoreServices` appears in a test.

Nothing local says which subscription a past Claude turn was billed to. Transcripts carry no account
id, and the `context.userEmail` attachment cli.js writes disagrees with the directory's own credential
on most rows under multi-account, because it comes from the same shared file the identity read no longer uses.
History before attribution stays `unknown` by ruling, and the hub receives only attributed rows.

A lost `hub.device_id`, for instance from a database restored from an older backup, makes the machine
a second device on the hub and double counts the overlap until the old one is retired. A hub restored
from backup rewinds its `rev` counter, and unless it bumps its `epoch` the clients will read empty
pages for ever; the hub README says to bump it.

`INSERT OR IGNORE` in a migration swallows every constraint failure, not only the unique one. It is
fine while every NOT NULL column is supplied, and a later NOT NULL addition would silently drop
history instead of failing the migration.

The seed buckets a rollup retires are deleted with no tombstone and no `rev`, and so are the buckets a
one-shot identity repair drops. That was a hazard while the hub was expected to mirror bucket
deletions; it is moot as built, because the hub folds its own buckets from the events it is pushed.

## Related

- [ADR-071](../adr/adr-071_metering-ledger-and-window-value.md): one ledger, two costs,
  machine-independent account keys, the window-value ledger, the dashboard layout.
- [ADR-072](../adr/adr-072_usage-hub-self-hosted-sync.md): the opt-in self-hosted usage hub.
- [ADR-030](../adr/adr-030_capability-honesty.md): an unknown is counted, never shown as zero.
- [ADR-011](../adr/adr-011_canonical-usage-windows-and-account-attribution.md): canonical window ends
  and time-based attribution.
- [ADR-015](../adr/adr-015_multi-account-file-credentials.md): per-account Claude credential
  directories.
- [ADR-033](../adr/adr-033_cross-engine-dispatch.md) and
  [ADR-034](../adr/adr-034_session-time-and-cost-accounting.md): dispatched spend, and what a session
  headline means.
- [ADR-068](../adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md) and
  [ADR-069](../adr/adr-069_codex-host-per-home-and-account.md): ChatGPT accounts and their hosts.
- [persistence.md](persistence.md) for the operational database, [sync-core.md](sync-core.md) for the
  event channels the dashboard listens on, [remote.md](remote.md) and [security.md](security.md) for
  the transport and the capability the `usage:*` and `usage-hub:*` channels sit at.
