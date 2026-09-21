# ADR-072: Usage hub, an opt-in self-hosted sync of the metering ledger across machines

**Status:** Accepted (2026-09-21; proposed 2026-09-20). Drafted from the owner's rulings of 2026-09-20. Amended 2026-09-21 from the S5 design discussion: clean data only, resync in place of device removal, a retired device keeps its name and data, raw rows archived to R2 after 360 days, aliases deferred, protocol ownership, and §6 restated as a requirement plus a mechanism, which a spike confirmed the same day on both a custom subdomain and `workers.dev`.
**Depends on:** [ADR-071](adr-071_metering-ledger-and-window-value.md) (the ledger, the machine-independent `account_key`, hourly buckets, the window ledger)
**Relates to:** [ADR-056](adr-056_headless-admission-model.md) and the headless server (the client lives in `src/core` so it syncs too), [ADR-036](adr-036_unified-auth-vault.md) (where the service token is kept), [ADR-030](adr-030_capability-honesty.md) (a stale machine is shown as stale)

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

**Only attributed rows are pushed (owner, 2026-09-21).** A row whose `account_key` is `unknown` never leaves the machine. The hub starts with clean data, and its combined view begins where attribution began on each machine (2026-09-20 at the earliest). History before that stays in the "this machine" view. Days that exist locally only as seeded buckets have no raw rows and are never pushed either.

**Rows do change, rarely, and resync is the repair.** "Never changes" holds for normal writes. It did not hold during ADR-071's build: an identity bug was repaired by re-keying `account_key` on rows already written, four times. A row pushed before such a repair would keep its old key on the hub, because ingest ignores a `message_id` it has seen. The hub therefore has one repair route, `POST /v1/devices/self/resync`, called from a button in ClaudeUI's hub settings:

- The device sends the timestamp of its oldest local ledger row. The hub deletes that device's raw rows from that instant forward, rebuilds the affected buckets and windows from what remains, and raises its `epoch` (§3). Rows older than the device can re-send are left alone, so a resync never destroys history.
- The device resets its high-water mark and pushes again.
- It is a manual action for a known data fault, not part of normal sync. An ordinary user should never need it.

### 3. The hub reads from buckets it maintains at ingest

D1 bills by rows read, and a dashboard that scans raw events on every open would spend the free tier's daily allowance in a few refreshes. In the same D1 batch as the insert, the hub adds the rows that `RETURNING` reported as new into `usage_bucket`, the same hourly UTC table ADR-071 defines, plus a `device_id` column. Only new rows are added, so a replayed batch changes nothing.

Buckets are kept for good. Raw rows stay in D1 for 360 days. A scheduled Worker then writes each month that has aged out to R2 as one compressed NDJSON object per device and deletes those rows from D1 (owner, 2026-09-21: long history is cheap and worth having, and object storage is the cheaper home for volume). Both limits are deploy-time settings. On the free plans as of 2026-09-21, D1 allows 500 MB per database and R2 10 GB; four machines at the owner's rate write roughly 350 MB of raw rows a year, so 360 days fits. R2 is optional: with no bucket bound, the hub keeps raw rows until the database nears its cap, and the README says what to do then. Nothing reads the archive in the first version. It exists so that a later reprice or audit is possible.

The hub keeps one integer `epoch`, returned with every pull. It rises whenever buckets are rebuilt (a resync). A client that sees an epoch it does not hold drops `remote_usage_bucket` and pulls from zero, because a rebuild can remove an hour outright and "changed since rev" cannot say that something is gone.

Each bucket row carries a monotonically increasing `rev`. Clients pull with `GET /v1/buckets?since=<rev>&exclude_device=<me>` and store the result in a local `remote_usage_bucket` table. The combined view therefore works offline from the last pull, and the renderer aggregates remote and local buckets with the same code.

### 4. Windows and limits are computed across machines

Devices also post their limit readings (`account_key`, `window_kind`, `usedPercent`, `resetsAt`, `observedAt`). The hub keeps the latest reading per account and window, and it keeps the samples.

- `GET /v1/limits` returns the latest reading for every account, with the device that observed it. A machine where an account is not active shows that reading and spends no token of its own. This is the main answer to the refresh-grant concern in ADR-071 §6.
- The hub maintains `usage_window` with the numerator summed over all devices. Clients pull it and prefer it to their local copy in the combined view.

### 5. What leaves the machine

Per event: timestamp, engine, vendor, model, the five token counts, both costs, `billing_type`, `origin`, `account_key`, `account_label`, `device_id`. Per reading: the fields in §4. Per device: a name the user picks, the OS family and the app version.

Account emails are sent as `account_label`. The owner ruled this on 2026-09-20: the hub is theirs, and a dashboard of opaque ids is useless. The hub returns them in full only to a Google sign-in (§6).

Never sent: prompts, responses, tool calls, file paths, working directories, session titles, session ids, routing ids, and any credential. `parent_routing_id` stays local. The API-key account key is ADR-071's 64-bit digest, and the key itself never leaves the vault.

### 6. Authentication: Google sign-in for the owner, a credential per device

**The requirement (owner, restated 2026-09-21).** The owner signs in from a browser with their Google account. Each device authenticates with its own API-key-style credential. Cloudflare Access is the mechanism if it does both at no cost; it is not a requirement in itself. The owner has a domain and will give the hub its own subdomain. An earlier version of this section recorded "every path behind Access" as an owner ruling. The owner did not rule that, and this paragraph replaces it.

**The mechanism, confirmed by the spike below.** One Access application on the hub's subdomain with two policies. It is the preferred design because the Worker then holds no login code, no session cookies and no stored device secrets. The two kinds of caller differ in what the Worker lets them do.

| Caller    | How it passes Access                                                                                              | What the Worker allows                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A device  | An Access service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, under a Service Auth policy | Write `POST /v1/events` and `POST /v1/limits`, and resync itself. Read the aggregates (`/v1/buckets`, `/v1/windows`, `/v1/limits`) with account labels masked. No owner writes, no device list, no raw events. |
| The owner | Google sign-in under an Allow policy naming one email                                                             | Read everything with full labels, plus the owner writes below.                                                                                                                                                 |

Access validates both at the edge and hands the Worker a signed `Cf-Access-Jwt-Assertion`. The Worker verifies that JWT on every request against the team's signing keys and decides from its claims. A service-token JWT carries the token's client id as `common_name` and no email. A sign-in JWT carries the email, which the Worker compares with a deploy-time variable. A request with no valid assertion is refused, so a mistake in the Access setup fails closed. The allowed address is deploy-time configuration and appears in neither repository.

**Devices.** One service token per machine, created in the Zero Trust dashboard and pasted into ClaudeUI once. Deleting it there revokes that machine alone. **Revoking a device removes its access and nothing else (owner, 2026-09-21).** The hub tracks usage, not devices: a lost or retired machine's rows, buckets and name all stay. The owner may mark the device `retired` from the hub dashboard so the machine list stops flagging it as behind. No route deletes a device's data. The hub needs no enrollment route and no admin secret, and it stores no device credential at all. On a token's first write the hub records its client id in a `device` table with the name the client sent. ClaudeUI keeps the id and secret in the OS credential store through the existing vault, never in a settings file.

**What a device can read, and why it can.** The first amendment of 2026-09-20 made the device token write-only and had the app read through a second token minted by a Google sign-in. The owner reversed that the same day: without read access the in-app dashboard has no combined view, the data is usage figures and nothing more, and a second token is friction on every machine for little gain. So a device reads the aggregates, and only the aggregates: hourly buckets, the window ledger and the latest limit readings. It cannot list raw events or devices and cannot call an owner route.

Every device read masks `account_label`. The hub returns the `account_key`, the vendor, the plan and a masked label (`d•••@g•••.com`, or the last four characters for an API key). ClaudeUI shows its own full label for any key it holds a credential for on that machine, and the masked label for an account that only another machine uses. Full emails are returned to a Google sign-in only, which means the hub's own dashboard.

A leaked service token can add junk rows and read spend figures, account keys and masked labels. It cannot read an email address, a raw event or anything that reaches a provider. Deleting the token in the Zero Trust dashboard ends it. That is the accepted risk.

**Owner writes, sign-in only.** Rename a device and mark it retired. `account_alias` (two account keys shown and summed as one) was in the first draft mainly to fold `unknown` rows into a real account. Since `unknown` rows are never pushed (§2), it is deferred until a real case appears, such as an account key that changes shape.

**Confirmed by a spike (2026-09-21, a throwaway Worker on the owner's account, free Zero Trust plan).** One Access application holds an Allow policy (Google sign-in, one email) and a Service Auth policy (a service token) together, and each caller gets through. The device policy's action MUST be Service Auth: with Allow, Access accepts the token and still redirects to the login page (a 302 with no error), which is the first mistake a deployer will make, so the README has to say it. A service token's JWT carries `aud`, `common_name` (the client id, 39 characters), `exp`, `iat`, `iss`, an EMPTY `sub` and `type: app`, and no `email`. A sign-in JWT carries `email`. So the Worker's rule is: `common_name` and no email is a device, an email equal to the configured owner is the owner, anything else is refused. A wrong secret is answered with a 302 to the Access login, not a 403. The hub client therefore never follows redirects and reads a redirect to `*.cloudflareaccess.com` as "credentials rejected"; the README tells the deployer to turn on the application's 401 response for failed service auth. With `workers_dev = false` and `preview_urls = false` the `workers.dev` address serves nothing, so no hostname skips the gate. A deployer with no domain is covered too: on `workers.dev`, the Worker's Access tab ("Manage Worker access", scope All traffic) takes the same two reusable policies and every test passed the same way. That gate has its own audience tag, and a hostname application, where one exists, takes precedence over it. The Worker verifies the assertion itself on every request (signature against the team's keys, `aud`, `iss`, `exp`), so a hostname that did bypass Access would fail closed. **Fallback, not needed:** Worker-verified device API keys (a salted hash per device in D1, created from the signed-in dashboard) with Access on the browser paths only. It would cost an enrollment route and stored device secrets.

### 7. The client

The client lives in `src/core/services/usage-hub/`, so the desktop app and `claudeui-server` both sync.

- The outbox is the ledger itself plus a high-water mark. There is no second queue to keep consistent.
- Push runs after a turn ends, debounced to at most once a minute, and on a 10-minute timer. Pull runs when the dashboard opens and on the same timer.
- Failures back off exponentially to a one-hour ceiling. Sync never blocks or fails a turn, the same rule `recordUsageEvent` already follows.
- Settings gets a Usage hub group: URL, device name, the service token fields, last sync, forget this device.
- The dashboard header gets the scope switch (this machine, all machines) and a sync chip. The chip opens the machine list: last sync, events, share of spend. A machine more than 24 hours behind is flagged, because its usage is missing from the combined window value (ADR-030).

### 8. Versioning across two repositories

Routes are under `/v1/`. Every batch carries `schemaVersion`. A hub that receives a newer version than it knows answers `426` with its own version, and the client shows "update your hub" and keeps its high-water mark where it was, so nothing is lost. A hub newer than the client accepts older batches.

The hub is a standalone project and owns its protocol: the wire types, the golden request and response fixtures, and the version numbers live in the hub repository. ClaudeUI is a client of it, not necessarily the only one, and it has the say on which features the protocol must carry. Until the hub repository exists, the first draft of the types and fixtures is written in ClaudeUI under `src/core/services/usage-hub/protocol/`, because the client's constraints shape them. They move to the hub repository when it is created, and from then on ClaudeUI vendors a copy. A unit test replays the fixtures through the client's encoder and decoder. A Miniflare-hosted hub inside ClaudeUI's test run was considered and judged too heavy for what it would catch.

### 9. The hub dashboard

One HTML page, no build step, served by the Worker. It shows the combined view only: the summary, accounts and limits, window value, spend over time, the breakdown and the machine list, following ADR-071 §8's layout. It exists for when no ClaudeUI instance is running. It reads `/dash/*` routes backed by the buckets, never the raw events.

It will repeat some of ClaudeUI's chart code. Sharing React components across two repositories means publishing a package, and a page this size does not justify one.

## Slices

| Slice | Repository | Content                                                                                                                                                              |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1    | hub        | Worker, D1 schema and migrations, Access JWT verification with the two caller kinds, `/v1/events` ingest with bucket upkeep, the resync route and `epoch`, fixtures. |
| H2    | hub        | `/v1/buckets`, `/v1/limits`, `/v1/windows` with label masking for device callers.                                                                                    |
| S5    | ClaudeUI   | The draft protocol, the client, settings group with resync, scope switch, sync chip and machine list. Built against fixtures until H2 exists.                        |
| H3    | hub        | The HTML dashboard, device rename and retire, the R2 archive job.                                                                                                    |

## Consequences

- The combined total and a correct window-value numerator become possible. The claude.ai share of a limit is still invisible.
- The user owns a Cloudflare account, a deploy and its upkeep. The project owns no infrastructure and sees no data.
- Two repositories must agree on a wire format. The `426` rule and the vendored fixtures are the whole mechanism, and they have to be kept honest by hand.
- Cost figures are computed on each device at write time. Two machines on different app versions can price the same model differently until both update. The hub stores token counts, so repricing on the hub is possible later and is not built now.
- The free tier is enough for this use: D1 allows 100,000 row writes a day against an expected few thousand events per machine, and reads go to buckets.

## Alternatives considered

- **Sync files through R2 or a cloud drive, merge on the client.** No server code at all, and the closest rival. Rejected because the window value needs a cross-machine sum by account and time, the limit relay needs a latest-reading lookup, and the owner wants a dashboard that works with every machine off.
- **Push rollups instead of raw events.** Rejected for the double counting described in §2.
- **Our own device keys, verified by the Worker, with Access on the browser paths only.** The first draft. Set aside because it needs an enrollment route, stored device secrets and path-scoped Access applications. It is the fallback in §6 if the spike shows Access cannot serve both callers.
- **A write-only device token, with the app reading through a token minted by a Google sign-in.** The first amendment. Reversed by the owner: it costs a sign-in per machine every 30 days to protect figures that are not sensitive once the email is masked.
- **One service token shared by all devices.** Rejected because revoking one machine would mean replacing the token on all of them.
- **Google sign-in implemented inside the Worker.** Rejected. It adds a client secret, a callback route and session cookies to maintain, and Cloudflare Access does the same job with a policy.
- **A hosted service.** Rejected by the owner's terms.
