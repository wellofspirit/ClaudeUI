# ADR-072: Usage hub, an opt-in self-hosted sync of the metering ledger across machines

**Status:** Proposed (2026-09-20). Drafted from the owner's rulings of the same date.
**Depends on:** [ADR-071](adr-071_metering-ledger-and-window-value.md) (the ledger, the machine-independent `account_key`, hourly buckets, the window ledger)
**Relates to:** [ADR-056](adr-056_headless-admission-model.md) and the headless server (the client lives in `src/core` so it syncs too), [ADR-036](adr-036_unified-auth-vault.md) (where the service token and the read token are kept), [ADR-057](adr-057_remote-vendor-oauth-paste-back.md) (paste-back sign-in on a headless server), [ADR-030](adr-030_capability-honesty.md) (a stale machine is shown as stale)

## Context

The owner runs ClaudeUI on four machines. Each is signed into some of the same accounts. Every machine sees only its own spend, while a subscription's limit percentage is global to the account. Two things follow. No machine can show the real total. And ADR-071's window value (dollars delivered divided by percent used) reads low everywhere, because the percent includes the other three machines and the dollars do not.

The owner wants a combined view, on these terms: it is opt-in, the project runs no service for anyone, the backend is a Cloudflare Worker with a database that each user deploys for themselves, it lives in its own repository, and it is built for one user.

## Decision

### 1. A separate repository, deployed by its owner

The hub is one Worker, one D1 database and one static HTML dashboard, deployed with `wrangler deploy`. ClaudeUI contains a client for it and nothing else. With no hub URL configured, no sync code runs and the dashboard has no scope switch.

D1 over a Durable Object with SQLite: the owner chose D1. It can be inspected with `wrangler d1 execute`, it has time-travel restore, and the single-writer consistency a Durable Object would give is not needed once ingest is idempotent (§2).

### 2. Sync is a one-way push of immutable rows

A ledger row never changes after it is written and `message_id` is unique. The set of rows only grows, so merging two machines' rows is a union and needs no conflict rules.

- Each device keeps a high-water mark over its local `usage_event` and posts batches of up to 500 rows to `POST /v1/events`.
- The hub runs `INSERT … ON CONFLICT(message_id) DO NOTHING RETURNING message_id`.
- A retry, a machine that was offline for a month, and two machines that both imported the same transcript folder all produce the same result: each turn once.

This is why the hub takes raw rows and not rollups. Two machines that both saw a turn would double count it in a rollup, and nothing downstream could tell.

### 3. The hub reads from buckets it maintains at ingest

D1 bills by rows read, and a dashboard that scans raw events on every open would spend the free tier's daily allowance in a few refreshes. In the same D1 batch as the insert, the hub adds the rows that `RETURNING` reported as new into `usage_bucket`, the same hourly UTC table ADR-071 defines, plus a `device_id` column. Only new rows are added, so a replayed batch changes nothing.

Raw rows are pruned at 90 days. Buckets are kept. A scheduled Worker does the prune.

Each bucket row carries a monotonically increasing `rev`. Clients holding a read session (§6) pull with `GET /v1/buckets?since=<rev>&exclude_device=<me>` and store the result in a local `remote_usage_bucket` table. The combined view therefore works offline from the last pull, and the renderer aggregates remote and local buckets with the same code.

### 4. Windows and limits are computed across machines

Devices also post their limit readings (`account_key`, `window_kind`, `usedPercent`, `resetsAt`, `observedAt`). The hub keeps the latest reading per account and window, and it keeps the samples.

- `GET /v1/limits` returns the latest reading for every account, with the device that observed it. A machine where an account is not active shows that reading and spends no token of its own. This is the main answer to the refresh-grant concern in ADR-071 §6.
- The hub maintains `usage_window` with the numerator summed over all devices. Clients pull it and prefer it to their local copy in the combined view.

### 5. What leaves the machine

Per event: timestamp, engine, vendor, model, the five token counts, both costs, `billing_type`, `origin`, `account_key`, `account_label`, `device_id`. Per reading: the fields in §4. Per device: a name the user picks, the OS family and the app version.

Account emails are sent as `account_label`. The owner ruled this on 2026-09-20: the hub is theirs, and a dashboard of opaque ids is useless.

Never sent: prompts, responses, tool calls, file paths, working directories, session titles, session ids, routing ids, and any credential. `parent_routing_id` stays local. The API-key account key is ADR-071's 64-bit digest, and the key itself never leaves the vault.

### 6. Authentication: one gate for every path, two kinds of caller

The first draft put the dashboard behind Cloudflare Access and left the device routes outside it, which depends on scoping an Access application by path. The owner ruled that out on 2026-09-20. Every path sits behind one Access application, and the two kinds of caller differ in what the Worker lets them do.

| Caller    | How it passes Access                                                                                              | What the Worker allows                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A device  | An Access service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, under a Service Auth policy | Write only: `POST /v1/events`, `POST /v1/limits`. Every read route answers `403`. |
| The owner | Google sign-in under an Allow policy naming one email                                                             | Read everything, plus the consolidation writes below.                             |

Access validates both at the edge and hands the Worker a signed `Cf-Access-Jwt-Assertion`. The Worker verifies that JWT on every request against the team's signing keys and decides from its claims. A service-token JWT carries the token's client id as `common_name` and no email. A sign-in JWT carries the email, which the Worker compares with a deploy-time variable. A request with no valid assertion is refused, so a mistake in the Access setup fails closed. The allowed address is deploy-time configuration and appears in neither repository.

**Devices.** One service token per machine, created in the Zero Trust dashboard and pasted into ClaudeUI once. Deleting it there revokes that machine alone. The hub needs no enrollment route and no admin secret, and it stores no device credential at all. On a token's first write the hub records its client id in a `device` table with the name the client sent. ClaudeUI keeps the id and secret in the OS credential store through the existing vault, never in a settings file.

A leaked service token can add junk rows. It cannot read spend, emails or anything else. That is the reason for making it write-only.

**Reads from inside ClaudeUI.** The combined view has to read buckets, windows and limits, and the device token may not. The app gets a read session by sign-in. It opens the browser at `/auth/device`, the owner signs in with Google, and the Worker mints a read token (256 bits, stored hashed, 30-day expiry, listed and revocable on the hub dashboard). The token returns to the app over a loopback redirect, or by paste-back on a headless server as in ADR-057. A read request carries the device's service token, which gets it through Access, and the read token, which the Worker requires for read routes. A read token alone does not pass Access, and a device token alone does not read. When the session expires the combined view says so and offers the sign-in again, while pushes continue.

**Consolidation writes, sign-in only.** Ledger rows stay immutable. The owner may add or remove an entry in `account_alias`, which makes two account keys display and sum as one (the `unknown` rows of a machine with one account, or a key that changed shape), rename a device, and remove a device together with its rows. The buckets are rebuilt from the remaining raw rows when a device is removed, so a device older than the 90-day raw retention can be hidden but not subtracted.

**To confirm in H1.** That a `workers.dev` hostname accepts a Service Auth policy next to the Allow policy on its Access application. If it does not, the hub needs a custom domain, and the README says so.

### 7. The client

The client lives in `src/core/services/usage-hub/`, so the desktop app and `claudeui-server` both sync.

- The outbox is the ledger itself plus a high-water mark. There is no second queue to keep consistent.
- Push runs after a turn ends, debounced to at most once a minute, and on a 10-minute timer. Pull runs when the dashboard opens and on the same timer.
- Failures back off exponentially to a one-hour ceiling. Sync never blocks or fails a turn, the same rule `recordUsageEvent` already follows.
- Settings gets a Usage hub group: URL, device name, the service token fields, sign in for the combined view, last sync, forget this device.
- The dashboard header gets the scope switch (this machine, all machines) and a sync chip. The chip opens the machine list: last sync, events, share of spend. A machine more than 24 hours behind is flagged, because its usage is missing from the combined window value (ADR-030).

### 8. Versioning across two repositories

Routes are under `/v1/`. Every batch carries `schemaVersion`. A hub that receives a newer version than it knows answers `426` with its own version, and the client shows "update your hub" and keeps its high-water mark where it was, so nothing is lost. A hub newer than the client accepts older batches.

The wire types and a set of golden request and response fixtures live in the hub repository. ClaudeUI vendors a copy under `src/core/services/usage-hub/protocol/`, and a unit test replays the fixtures through the client's encoder and decoder. A Miniflare-hosted hub inside ClaudeUI's test run was considered and judged too heavy for what it would catch.

### 9. The hub dashboard

One HTML page, no build step, served by the Worker. It shows the combined view only: the summary, accounts and limits, window value, spend over time, the breakdown and the machine list, following ADR-071 §8's layout. It exists for when no ClaudeUI instance is running. It reads `/dash/*` routes backed by the buckets, never the raw events.

It will repeat some of ClaudeUI's chart code. Sharing React components across two repositories means publishing a package, and a page this size does not justify one.

## Slices

| Slice | Repository | Content                                                                                                                                                                    |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1    | hub        | Worker, D1 schema and migrations, Access JWT verification with the two caller kinds, `/v1/events` ingest with bucket upkeep, the `workers.dev` question from §6, fixtures. |
| H2    | hub        | `/auth/device` read sessions, `/v1/buckets`, `/v1/limits`, `/v1/windows`, the prune job.                                                                                   |
| S5    | ClaudeUI   | The client, settings group, scope switch, sync chip and machine list. Needs ADR-071 S2 and H2.                                                                             |
| H3    | hub        | The HTML dashboard, the consolidation writes, read-session management.                                                                                                     |

## Consequences

- The combined total and a correct window-value numerator become possible. The claude.ai share of a limit is still invisible.
- The user owns a Cloudflare account, a deploy and its upkeep. The project owns no infrastructure and sees no data.
- Two repositories must agree on a wire format. The `426` rule and the vendored fixtures are the whole mechanism, and they have to be kept honest by hand.
- Cost figures are computed on each device at write time. Two machines on different app versions can price the same model differently until both update. The hub stores token counts, so repricing on the hub is possible later and is not built now.
- The free tier is enough for this use: D1 allows 100,000 row writes a day against an expected few thousand events per machine, and reads go to buckets.

## Alternatives considered

- **Sync files through R2 or a cloud drive, merge on the client.** No server code at all, and the closest rival. Rejected because the window value needs a cross-machine sum by account and time, the limit relay needs a latest-reading lookup, and the owner wants a dashboard that works with every machine off.
- **Push rollups instead of raw events.** Rejected for the double counting described in §2.
- **Our own device tokens with a bypass for the device routes.** The first draft. Rejected by the owner: it leaves part of the hub outside the edge gate and depends on path-scoped Access applications.
- **A device token that can also read.** Simpler for the app, which would need no sign-in. Rejected: the token sits on four machines, and a leak would expose spend and account emails.
- **One service token shared by all devices.** Rejected because revoking one machine would mean replacing the token on all of them.
- **Google sign-in implemented inside the Worker.** Rejected. It adds a client secret, a callback route and session cookies to maintain, and Cloudflare Access does the same job with a policy.
- **A hosted service.** Rejected by the owner's terms.
