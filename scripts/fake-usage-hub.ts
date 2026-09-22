/**
 * A fake usage hub (ADR-072 §8).
 *
 *     bun test/fake-hub/fake-usage-hub.ts --client-id <id> --client-secret <secret>
 *
 * ## What this is for
 *
 * The reference implementation of the protocol, from memory and without
 * Cloudflare. The contract test runs its cases against this AND against the
 * Worker under `wrangler dev`, so a case the Worker passes and this fails (or
 * the other way round) is a disagreement about the contract, not a bug in one
 * implementation. A client repository can also run it as a stand-in: ClaudeUI's
 * gated integration test starts it on a random port, and a real-app verifier
 * points a running ClaudeUI at it.
 *
 * It is self-contained on purpose: `Bun.serve` and nothing installed, no import
 * from `protocol/` or the Worker, and the protocol restated here in the shapes
 * the fixtures hold. A fake that shared the Worker's declarations could not
 * catch the Worker and the contract disagreeing, which is the one thing it is
 * for.
 *
 * ## What it implements faithfully, and where it is deliberately thin
 *
 * Faithful, because the client's correctness depends on it:
 *
 *   - `message_id` is unique, and a replayed batch is answered as duplicates
 *     rather than inserted twice — the property ADR-072 §2 is built on;
 *   - hourly buckets are maintained AT INGEST, from the new rows only, so a
 *     replay changes nothing;
 *   - every bucket AND every window carries a monotonic `rev` from one shared
 *     counter, the answer excludes the calling device, and an `epoch` rises when
 *     a resync rebuilds — but never between two requests of the same pass;
 *   - `accepted + duplicates` always equals the batch length, which is the
 *     promise the client's cursor depends on;
 *   - `schemaVersion` is validated on every route, in the body for a POST and in
 *     the query for a GET, and any route may answer 426;
 *   - account labels are MASKED for a device caller (ADR-072 §6);
 *   - both Access headers are checked, and a mismatch is answered with a **302
 *     to a `cloudflareaccess.com` address**, not a 403. That is what the spike
 *     found a bad service token actually gets, and a client that follows
 *     redirects would parse a login page as the hub's answer;
 *   - accounts are registered and NAMED at ingest by the Worker's rule, so the
 *     two targets answer `GET /v1/accounts` with the same list for the same
 *     pushes;
 *   - the two owner routes exist and refuse a machine the way the real hub does,
 *     BEFORE the version is checked, exactly where a device route refuses the
 *     owner.
 *
 * Thin, because it is a test double and not a deployment: no D1, no Access JWT
 * verification (the headers stand in for it), no Google sign-in, no `/dash`
 * routes, no R2 archive, and the whole store dies with the process.
 *
 * ## The two callers
 *
 * A request carrying `Cf-Access-Authenticated-User-Email` — the header Access
 * itself sets on an identity login — is the OWNER; one carrying the two
 * service-token headers is a device, as before; one carrying neither is refused
 * the way a bad token is, with a 302 to a hosted login page — unless the gate is
 * off, which it is when no `--client-id`/`--client-secret` was given, and then
 * every caller that is not the owner is a machine. There is no sign-in to
 * perform: the header IS the sign-in here, exactly as the two token headers
 * stand in for a verified service-token assertion.
 *
 * What the owner is shown and a machine is not: account labels in full
 * (`accountLabel` beside the mask, on `GET /v1/limits` and `GET /v1/accounts`),
 * both service-token ids on `GET /v1/devices`, and the two routes that are the
 * owner's alone — `GET /v1/hub` and `PATCH /v1/devices/<id>`, which answer a
 * machine `403 { error: 'owner route' }`.
 *
 * Thin in one way worth naming, because it is visible on the wire: this computes
 * no window ledger. The real hub owns that rollup — a window's numerator is EVERY
 * machine's turns, which is why the hub can compute it and a machine cannot — and
 * it answers the literal `deviceId: 'hub'` for every window row, since the row
 * belongs to no one machine. Here a window exists only if `--seed` stated it, and
 * it keeps whatever `deviceId` the file gave it: a fake that rewrote the field
 * would hide which of the two a client's merge is actually reading. The CALLER
 * changes nothing about a window row on either target — a window names no account
 * label and no service token, so there is nothing in one to withhold from a
 * machine; what differs is where the rows come from, and here that is `--seed`.
 *
 * ## Flags
 *
 *   --port <n>             listen port (0, the default, picks a free one)
 *   --client-id <id>       the service-token id the caller must send
 *   --client-secret <s>    the service-token secret the caller must send
 *   --reject-schema <n>    answer every PROTOCOL request 426 with this hub version
 *   --flaky <p>            fail a fraction (0..1) of PROTOCOL requests with a 503
 *   --epoch <n>            the starting epoch (default 1)
 *   --debug-store          serve `GET /debug/store`, which a real hub never does
 *   --seed <json|path>     preload another machine's rows before serving
 *
 * ## `--seed`, and why a fake hub needs one
 *
 * "All machines" cannot be looked at on a machine that is the only machine. The
 * flag takes a JSON object — inline, or a path to a file holding one — of
 * `{ devices, buckets, windows, readings }`, each an array of exactly the shape
 * the corresponding route ANSWERS with, and stores it as if that device had
 * pushed it. Every field is optional and anything missing takes the same default
 * an ingested row would.
 *
 * Seeded buckets are stored AS GIVEN rather than folded from events, because
 * what a verifier wants to state is "this peer spent $3 in that hour", not a
 * plausible list of turns that adds up to it. They are given fresh revs, so a
 * client that has already pulled sees them on its next pass.
 *
 * It is a test-double facility and, unlike `/debug/store`, it writes nothing a
 * device caller could read that the protocol does not already return. It goes to
 * the hub repository with the rest of this file; a real hub has no such flag.
 *
 * The two fault injectors cover the `/v1/*` routes and NOTHING else. They used
 * to be applied before dispatch, so `--flaky` broke `/debug/store` too and the
 * integration test failed about one run in two on a read that is not part of
 * what it is testing. `/debug/store` is also opt-in now: it returns raw events
 * with UNMASKED account labels, which ADR-072 §6 forbids a device caller, so a
 * fake that served it unconditionally would be modelling a hub that leaks.
 *
 * With no `--client-id`/`--client-secret` the gate is OFF and any caller passes,
 * which is the convenient default for a manual poke with `curl`.
 *
 * ## Lifetime
 *
 * It exits when its STDIN closes, so it cannot outlive the harness that started
 * it. See the handler at the bottom for why that is the signal rather than a
 * parent-pid poll or a signal handler.
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// The protocol, restated (see the header on why it is not imported)
// ---------------------------------------------------------------------------

interface HubEvent {
  messageId: string
  ts: number
  engineId: string
  vendorId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  apiCostUsd: number | null
  billedCostUsd: number | null
  billingType: string
  origin: string
  accountKey: string
  accountLabel: string | null
}

interface StoredEvent extends HubEvent {
  deviceId: string
}

interface StoredBucket {
  deviceId: string
  rev: number
  hourUtc: number
  accountKey: string
  billingType: string
  engineId: string
  vendorId: string
  modelId: string
  origin: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  apiCostUsd: number
  billedCostUsd: number
  unbilledApiCostUsd: number
  unknownApiCostCount: number
  unknownBilledCostCount: number
  requestCount: number
  source: string
}

interface StoredReading {
  deviceId: string
  accountKey: string
  windowKind: string
  accountLabel: string | null
  vendorId: string
  plan: string | null
  windowMinutes: number | null
  usedPercent: number
  resetsAt: string | null
  observedAt: number
}

interface StoredDevice {
  deviceId: string
  deviceName: string
  appVersion: string
  os: string
  lastPushAt: number
  retired: boolean
  /** The service token this machine LAST announced under. Owner only on the wire. */
  clientId: string
  /** The one it FIRST announced under, which a rebind moves. Owner only too. */
  firstClientId: string
}

/** One account the hub has seen, and the newest name it was told for it. */
interface StoredAccount {
  accountKey: string
  vendorId: string
  label: string | null
  /** The instant of the row `label` came from; 0 when there is none. */
  labelTs: number
  firstSeenAt: number
  lastSeenAt: number
}

const SCHEMA_VERSION = 2

/** What the real hub's `RETENTION_DAYS` says, quoted back by `GET /v1/hub`. */
const RETENTION_DAYS = 360

/** 1-120 characters after trimming, the Worker's rule for a name the owner sets. */
const MAX_DEVICE_NAME = 120

/** `PATCH /v1/devices/<id>` names the machine in its URL; every other path is exact. */
const DEVICE_PREFIX = '/v1/devices/'
const HOUR_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const options = {
  port: Number(flag('port') ?? 0),
  clientId: flag('client-id'),
  clientSecret: flag('client-secret'),
  rejectSchema: flag('reject-schema') === undefined ? null : Number(flag('reject-schema')),
  flaky: Number(flag('flaky') ?? 0),
  epoch: Number(flag('epoch') ?? 1),
  debugStore: process.argv.includes('--debug-store'),
  seed: flag('seed')
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const events = new Map<string, StoredEvent>()
const buckets = new Map<string, StoredBucket>()
const readings = new Map<string, StoredReading>()
const devices = new Map<string, StoredDevice>()
const accounts = new Map<string, StoredAccount>()
let nextRev = 1
let epoch = options.epoch

function bucketKey(b: {
  deviceId: string
  hourUtc: number
  accountKey: string
  billingType: string
  engineId: string
  vendorId: string
  modelId: string
  origin: string
}): string {
  // JSON, not a joined string: a model id or an account key could contain any
  // separator character, and two different buckets sharing a key would silently
  // merge. This is a test double, so being obviously correct beats being fast.
  return JSON.stringify([
    b.deviceId,
    b.hourUtc,
    b.accountKey,
    b.billingType,
    b.engineId,
    b.vendorId,
    b.modelId,
    b.origin
  ])
}

/**
 * Fold one new event into its hour's bucket, exactly as the Worker will do in
 * the same D1 batch as the insert. Only NEW rows reach this, so a replayed batch
 * changes no bucket.
 */
function foldIntoBucket(event: StoredEvent): void {
  const hourUtc = Math.floor(event.ts / HOUR_MS) * HOUR_MS
  const identity = {
    deviceId: event.deviceId,
    hourUtc,
    accountKey: event.accountKey,
    billingType: event.billingType,
    engineId: event.engineId,
    vendorId: event.vendorId,
    modelId: event.modelId,
    origin: event.origin
  }
  const key = bucketKey(identity)
  const bucket: StoredBucket =
    buckets.get(key) ??
    ({
      ...identity,
      rev: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      apiCostUsd: 0,
      billedCostUsd: 0,
      unbilledApiCostUsd: 0,
      unknownApiCostCount: 0,
      unknownBilledCostCount: 0,
      requestCount: 0,
      source: 'rollup'
    } satisfies StoredBucket)

  bucket.inputTokens += event.inputTokens
  bucket.outputTokens += event.outputTokens
  bucket.cacheWriteTokens += event.cacheWriteTokens
  bucket.cacheWrite1hTokens += event.cacheWrite1hTokens
  bucket.cacheReadTokens += event.cacheReadTokens
  bucket.requestCount += 1
  // ADR-030: an unpriced turn is counted, never added as a zero.
  if (event.apiCostUsd === null) bucket.unknownApiCostCount += 1
  else bucket.apiCostUsd += event.apiCostUsd
  if (event.billedCostUsd === null) {
    bucket.unknownBilledCostCount += 1
    if (event.apiCostUsd !== null) bucket.unbilledApiCostUsd += event.apiCostUsd
  } else {
    bucket.billedCostUsd += event.billedCostUsd
  }
  // A touched bucket gets a fresh rev so a puller sees it as changed.
  bucket.rev = nextRev++
  buckets.set(key, bucket)
}

/**
 * Register an account, and take the name if it is the newest one seen.
 *
 * The Worker's `UPSERT_ACCOUNTS` rule, restated (see the header on why it is not
 * imported): a key is registered whatever it is called, so an account with no
 * rate-limit meter is still named; the label moves only when the incoming row
 * has one AND its instant is at or past the stored one, so a backlog push cannot
 * undo a rename that happened since; `firstSeenAt` never moves.
 */
function registerAccount(
  accountKey: string,
  vendorId: string,
  label: string | null,
  instant: number
): void {
  // The Worker's validator refuses both of these before a statement runs, so a
  // fake that registered them would answer a list the real hub never would.
  if (accountKey === '' || accountKey === 'unknown') return
  const named = label !== null && label !== ''
  const held = accounts.get(accountKey)
  if (held === undefined) {
    accounts.set(accountKey, {
      accountKey,
      vendorId,
      label: named ? label : null,
      labelTs: named ? instant : 0,
      firstSeenAt: instant,
      lastSeenAt: instant
    })
    return
  }
  if (named && instant >= held.labelTs) {
    held.label = label
    // The vendor moves WITH the name, so the two always come from one row.
    held.vendorId = vendorId
    held.labelTs = instant
  }
  held.lastSeenAt = Math.max(held.lastSeenAt, instant)
}

/**
 * Rebuild every bucket of one device from the raw rows it still holds.
 *
 * `accounts` is deliberately untouched, as on the real hub: a name is not a
 * per-device fact, and the epoch bump tells every client to re-pull the list.
 */
function rebuildDevice(deviceId: string): void {
  for (const [key, bucket] of buckets) if (bucket.deviceId === deviceId) buckets.delete(key)
  for (const event of events.values()) if (event.deviceId === deviceId) foldIntoBucket(event)
  epoch += 1
}

/**
 * `d•••@e•••.com`, or the last four characters for anything that is not an
 * email. ADR-072 §6: full labels go to a Google sign-in, never to a device.
 */
function maskLabel(label: string | null): string | null {
  if (label === null || label === '') return label
  const at = label.indexOf('@')
  if (at <= 0) return `…${label.slice(-4)}`
  const [user, domain] = [label.slice(0, at), label.slice(at + 1)]
  const dot = domain.lastIndexOf('.')
  const host = dot > 0 ? domain.slice(0, dot) : domain
  const tld = dot > 0 ? domain.slice(dot) : ''
  // `slice`, not `[0]`: a label ending in `@` has no host at all, and a masked
  // label must never read `undefined`. The Worker's `src/mask.ts` does the same.
  return `${user.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`
}

// ---------------------------------------------------------------------------
// Seeding (see the `--seed` section of the header)
// ---------------------------------------------------------------------------

interface SeedFile {
  devices?: Array<Partial<StoredDevice> & { deviceId: string }>
  buckets?: Array<Partial<StoredBucket> & { deviceId: string; hourUtc: number }>
  windows?: Array<Record<string, unknown> & { deviceId: string }>
  readings?: Array<Partial<StoredReading> & { accountKey: string; windowKind: string }>
}

/** Another machine's window-value rows, kept exactly as `GET /v1/windows` answers them. */
const seededWindows: Array<Record<string, unknown>> = []

function readSeed(raw: string): SeedFile {
  // A leading brace means the JSON is inline; anything else is a path. Inline
  // is awkward to quote on Windows, so both spellings are accepted.
  const text = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf-8')
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--seed takes a JSON object')
  }
  return parsed as SeedFile
}

function applySeed(seed: SeedFile): void {
  for (const device of seed.devices ?? []) {
    devices.set(device.deviceId, {
      deviceId: device.deviceId,
      deviceName: device.deviceName ?? device.deviceId,
      appVersion: device.appVersion ?? 'unknown',
      os: device.os ?? 'unknown',
      lastPushAt: device.lastPushAt ?? Date.now(),
      retired: device.retired ?? false,
      clientId: device.clientId ?? '',
      firstClientId: device.firstClientId ?? device.clientId ?? ''
    })
  }

  for (const given of seed.buckets ?? []) {
    const bucket: StoredBucket = {
      deviceId: given.deviceId,
      hourUtc: given.hourUtc,
      accountKey: given.accountKey ?? 'unknown',
      billingType: given.billingType ?? 'subscription',
      engineId: given.engineId ?? 'claude',
      vendorId: given.vendorId ?? 'anthropic',
      modelId: given.modelId ?? 'unknown',
      origin: given.origin ?? 'session',
      inputTokens: given.inputTokens ?? 0,
      outputTokens: given.outputTokens ?? 0,
      cacheWriteTokens: given.cacheWriteTokens ?? 0,
      cacheWrite1hTokens: given.cacheWrite1hTokens ?? 0,
      cacheReadTokens: given.cacheReadTokens ?? 0,
      apiCostUsd: given.apiCostUsd ?? 0,
      billedCostUsd: given.billedCostUsd ?? 0,
      unbilledApiCostUsd: given.unbilledApiCostUsd ?? 0,
      unknownApiCostCount: given.unknownApiCostCount ?? 0,
      unknownBilledCostCount: given.unknownBilledCostCount ?? 0,
      requestCount: given.requestCount ?? 1,
      source: given.source ?? 'rollup',
      // A fresh rev, so a client that has already pulled sees it next pass.
      rev: nextRev++
    }
    buckets.set(bucketKey(bucket), bucket)
    // A seeded bucket implies the device exists, even when the file named none.
    if (!devices.has(bucket.deviceId)) {
      devices.set(bucket.deviceId, {
        deviceId: bucket.deviceId,
        deviceName: bucket.deviceId,
        appVersion: 'unknown',
        os: 'unknown',
        lastPushAt: Date.now(),
        retired: false,
        clientId: '',
        firstClientId: ''
      })
    }
    // And the account: on the real hub the events behind this hour registered
    // it, so a seeded peer whose buckets name a key nothing knows would be a
    // shape the real hub cannot produce. A bucket carries no label, so it
    // registers the key unnamed and a seeded reading may name it below.
    registerAccount(bucket.accountKey, bucket.vendorId, null, bucket.hourUtc)
  }

  for (const window of seed.windows ?? []) {
    seededWindows.push({ ...window, rev: nextRev++ })
  }

  for (const given of seed.readings ?? []) {
    const reading: StoredReading = {
      deviceId: given.deviceId ?? '',
      accountKey: given.accountKey,
      windowKind: given.windowKind,
      accountLabel: given.accountLabel ?? null,
      vendorId: given.vendorId ?? 'anthropic',
      plan: given.plan ?? null,
      windowMinutes: given.windowMinutes ?? null,
      usedPercent: given.usedPercent ?? 0,
      resetsAt: given.resetsAt ?? null,
      observedAt: given.observedAt ?? Date.now()
    }
    readings.set(JSON.stringify([reading.accountKey, reading.windowKind]), reading)
    registerAccount(reading.accountKey, reading.vendorId, reading.accountLabel, reading.observedAt)
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/**
 * The version a request states, or null when it states none.
 *
 * An ABSENT value is refused rather than defaulted, in a body and in a query
 * alike: `Number('')` and `Number(null)` are both 0, which is finite, so a
 * lenient read would let an unversioned request through and there is no such
 * request. The Worker's `schemaVersionOf` does exactly this.
 */
function statedVersion(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** The refusal a stated version earns, or null to carry on. The Worker's order. */
function versionRefusal(raw: unknown): Response | null {
  const stated = statedVersion(raw)
  if (stated === null) return json({ error: 'no schemaVersion' }, 400)
  if (stated > SCHEMA_VERSION) return json({ hubSchemaVersion: SCHEMA_VERSION }, 426)
  if (stated < 1) return json({ error: 'bad schemaVersion' }, 400)
  return null
}

/** Who is calling, once the stand-in for Access has looked at the headers. */
type Caller = 'owner' | 'device'

/**
 * The Access gate, as the spike found it: a bad service token is answered with a
 * 302 to the hosted login page. The deployer can turn on a 401 instead, so both
 * shapes are legal and a client has to read either as "credentials rejected".
 *
 * `Cf-Access-Authenticated-User-Email` is the header Access sets on an identity
 * login, and it is the owner here — checked FIRST, and without the token gate,
 * because a browser sign-in carries no service token and never will. Null is
 * "neither caller", which is refused.
 */
function callerOf(request: Request): Caller | null {
  if ((request.headers.get('Cf-Access-Authenticated-User-Email') ?? '').trim() !== '') {
    return 'owner'
  }
  // With no `--client-id`/`--client-secret` the gate is off and any caller is a
  // machine, which is the convenient default for a poke with `curl`.
  if (options.clientId === undefined || options.clientSecret === undefined) return 'device'
  const matched =
    request.headers.get('CF-Access-Client-Id') === options.clientId &&
    request.headers.get('CF-Access-Client-Secret') === options.clientSecret
  return matched ? 'device' : null
}

function rejected(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login' }
  })
}

async function handle(request: Request): Promise<Response> {
  const caller = callerOf(request)
  if (caller === null) return rejected()

  const url = new URL(request.url)
  const path = url.pathname

  // NOT part of the protocol, and served only on request: it returns raw events
  // with UNMASKED account labels, which ADR-072 §6 forbids a device caller. It
  // is also deliberately ABOVE the two fault injectors — they model a hub under
  // load, and a test that cannot read the store it is asserting on is not
  // testing the client.
  if (request.method === 'GET' && path === '/debug/store') {
    if (!options.debugStore) return json({ error: 'pass --debug-store to enable this route' }, 404)
    return json({
      epoch,
      nextRev,
      events: [...events.values()],
      buckets: [...buckets.values()],
      readings: [...readings.values()],
      devices: [...devices.values()],
      accounts: [...accounts.values()]
    })
  }

  // The two injectors, from here down: every `/v1/*` route and nothing else.
  if (options.rejectSchema !== null) {
    return json({ hubSchemaVersion: options.rejectSchema }, 426)
  }
  if (options.flaky > 0 && Math.random() < options.flaky) {
    return json({ error: 'injected failure' }, 503)
  }

  // WHO may call a route does not depend on WHAT they sent, so this runs before
  // the version gate and before any body is read — the Worker's own order
  // (`router.ts`), where an owner route refuses a machine exactly where a device
  // route refuses the owner. A machine calling `/v1/hub` with no version at all
  // has to get the 403 and not a 400 about the version.
  const ownerOnly =
    (request.method === 'GET' && path === '/v1/hub') ||
    (request.method === 'PATCH' && path.startsWith(DEVICE_PREFIX))
  if (ownerOnly && caller !== 'owner') return json({ error: 'owner route' }, 403)

  // `schemaVersion` on EVERY route (ADR-072 §8): the body for a POST, the query
  // for a GET, and any route may answer 426. A hub that checked only the writes
  // would hand a client a response shape it cannot parse, and the client would
  // read the mismatch as corrupt data rather than as "update your hub".
  if (request.method === 'GET' && path.startsWith('/v1/')) {
    const refused = versionRefusal(url.searchParams.get('schemaVersion'))
    if (refused !== null) return refused
  }

  if (request.method === 'POST' && path === '/v1/events') {
    const body = (await request.json()) as {
      schemaVersion?: number
      deviceId?: string
      deviceName?: string
      appVersion?: string
      os?: string
      events?: HubEvent[]
    }
    const refused = versionRefusal(body.schemaVersion)
    if (refused) return refused
    const deviceId = body.deviceId ?? ''
    if (deviceId === '') return json({ error: 'no deviceId' }, 400)
    // BEFORE the batch is looked at, and with no check that there is one: an
    // empty `events` array is a valid request and is how a device that has
    // nothing to send announces itself (ADR-072 §7). Recording it here is what
    // makes `{ accepted: 0, duplicates: 0 }` a complete answer, and it is part
    // of the contract the hub repository inherits with this file.
    const known = devices.get(deviceId)
    const clientId = request.headers.get('CF-Access-Client-Id') ?? ''
    devices.set(deviceId, {
      deviceId,
      deviceName: body.deviceName ?? deviceId,
      appVersion: body.appVersion ?? 'unknown',
      os: body.os ?? 'unknown',
      lastPushAt: Date.now(),
      retired: known?.retired ?? false,
      clientId,
      // Written once and never by a later push: it is what the real hub's resync
      // guard is checked against, and only a rebind may move it.
      firstClientId: known?.firstClientId ?? clientId
    })
    const batch = body.events ?? []
    let accepted = 0
    let duplicates = 0
    for (const event of batch) {
      if (!event?.messageId) {
        // Counted rather than dropped, because
        // `accepted + duplicates === events.length` is a promise (ADR-072 §2):
        // a hub that silently ignores a row breaks the client's cursor.
        duplicates++
        continue
      }
      // The account is registered from EVERY row of the batch, the new ones and
      // the ones already held alike: the real hub's upsert runs over the whole
      // bound JSON, and a name it was told again is a name it was told.
      registerAccount(event.accountKey, event.vendorId, event.accountLabel, event.ts)
      if (events.has(event.messageId)) {
        duplicates++
        continue
      }
      const stored: StoredEvent = { ...event, deviceId }
      events.set(event.messageId, stored)
      foldIntoBucket(stored)
      accepted++
    }
    return json({ accepted, duplicates, epoch })
  }

  if (request.method === 'POST' && path === '/v1/limits') {
    const body = (await request.json()) as {
      schemaVersion?: number
      deviceId?: string
      readings?: StoredReading[]
    }
    const refused = versionRefusal(body.schemaVersion)
    if (refused) return refused
    const deviceId = body.deviceId ?? ''
    let accepted = 0
    for (const reading of body.readings ?? []) {
      if (!reading?.accountKey || !reading.windowKind) continue
      registerAccount(
        reading.accountKey,
        reading.vendorId,
        reading.accountLabel,
        reading.observedAt
      )
      const key = JSON.stringify([reading.accountKey, reading.windowKind])
      const existing = readings.get(key)
      // Taken, whether or not it is the newest: a real hub keeps every reading as a
      // sample, so "accepted" means the hub has it. Latest wins for the RELAY only —
      // two devices watching one account must not move its meter backwards.
      accepted++
      if (existing && existing.observedAt > reading.observedAt) continue
      readings.set(key, { ...reading, deviceId })
    }
    return json({ accepted, epoch })
  }

  if (request.method === 'POST' && path === '/v1/devices/self/resync') {
    const body = (await request.json()) as {
      schemaVersion?: number
      deviceId?: string
      since?: number
    }
    const refused = versionRefusal(body.schemaVersion)
    if (refused) return refused
    const deviceId = body.deviceId ?? ''
    const since = body.since ?? 0
    let deleted = 0
    for (const [messageId, event] of events) {
      if (event.deviceId !== deviceId || event.ts < since) continue
      events.delete(messageId)
      deleted++
    }
    rebuildDevice(deviceId)
    return json({ deleted, epoch })
  }

  if (request.method === 'GET' && path === '/v1/buckets') {
    const since = Number(url.searchParams.get('since') ?? 0)
    const exclude = url.searchParams.get('exclude_device') ?? ''
    // The optional lower bound on the HOUR. Absent is no bound, which is what a
    // machine sends: it is catching up on everything. The hub's own dashboard
    // sends one, because a 30-day view has no use for a year of hours.
    const fromRaw = url.searchParams.get('from')
    const from = fromRaw === null || fromRaw.trim() === '' ? 0 : Number(fromRaw)
    const page = [...buckets.values()]
      .filter(
        (bucket) => bucket.rev > since && bucket.deviceId !== exclude && bucket.hourUtc >= from
      )
      .sort((a, b) => a.rev - b.rev)
      .slice(0, 500)
    const rev = page.reduce((max, bucket) => Math.max(max, bucket.rev), since)
    return json({ epoch, rev, buckets: page })
  }

  if (request.method === 'GET' && path === '/v1/windows') {
    // The window ledger is the hub's own rollup in the real thing (ADR-072 §4),
    // and a fake that invented numbers would let a wrong merge look right
    // against figures nothing produced. So nothing is DERIVED here: the page is
    // empty unless `--seed` stated the rows outright, and a seeded row keeps the
    // `deviceId` it was given, where the real hub answers the literal `hub`. It
    // carries the `rev` envelope either way, because the client's paging loop is
    // real and has to terminate against it.
    const since = Number(url.searchParams.get('since') ?? 0)
    const exclude = url.searchParams.get('exclude_device') ?? ''
    const page = seededWindows
      .filter((w) => Number(w.rev) > since && w.deviceId !== exclude)
      .sort((a, b) => Number(a.rev) - Number(b.rev))
      .slice(0, 500)
    const rev = page.reduce((max, w) => Math.max(max, Number(w.rev)), since)
    return json({ epoch, rev, windows: page })
  }

  if (request.method === 'GET' && path === '/v1/limits') {
    const page = [...readings.values()].map((reading) => ({
      deviceId: reading.deviceId,
      accountKey: reading.accountKey,
      windowKind: reading.windowKind,
      labelMasked: maskLabel(reading.accountLabel),
      vendorId: reading.vendorId,
      plan: reading.plan,
      windowMinutes: reading.windowMinutes,
      usedPercent: reading.usedPercent,
      resetsAt: reading.resetsAt,
      observedAt: reading.observedAt,
      // Owner only, and ABSENT rather than null for a machine: a key that is not
      // there cannot be read as "the hub knows no label for this account".
      ...(caller === 'owner' ? { accountLabel: reading.accountLabel } : {})
    }))
    return json({ epoch, readings: page })
  }

  // The names behind the account keys every other read carries, for both
  // callers. It is the only route that can name an account no reading ever will:
  // an API-key account has no rate-limit meter, so the relay is silent about it.
  if (request.method === 'GET' && path === '/v1/accounts') {
    const page = [...accounts.values()]
      .sort((one, other) => (one.accountKey < other.accountKey ? -1 : 1))
      .map((account) => ({
        accountKey: account.accountKey,
        vendorId: account.vendorId,
        labelMasked: maskLabel(account.label),
        lastSeenAt: account.lastSeenAt,
        ...(caller === 'owner' ? { accountLabel: account.label } : {})
      }))
    return json({ epoch, accounts: page })
  }

  // The machine list, readable by a device (ADR-072 §6): names, OS families,
  // builds and last-push instants. No account label and no raw event, which is
  // what keeps it a device-safe route.
  if (request.method === 'GET' && path === '/v1/devices') {
    return json({
      epoch,
      devices: [...devices.values()].map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        os: device.os,
        appVersion: device.appVersion,
        lastPushAt: device.lastPushAt,
        retired: device.retired,
        // Which token is which machine, and which one Resync is bound to. A
        // machine is never told another machine's credential, its own included.
        ...(caller === 'owner'
          ? { clientId: device.clientId, firstClientId: device.firstClientId }
          : {})
      }))
    })
  }

  // The hub's own status line, for its dashboard. Owner only, like the patch
  // below: a machine is refused here exactly where the owner is refused a push.
  if (request.method === 'GET' && path === '/v1/hub') {
    // The caller was settled above, with the other owner route.
    return json({
      epoch,
      schemaVersion: SCHEMA_VERSION,
      // Nothing here recomputes a window ledger and nothing here archives, so
      // both are stated as what they are rather than invented.
      recomputedAt: 0,
      retentionDays: RETENTION_DAYS,
      archiveBound: false,
      deviceCount: devices.size
    })
  }

  // The owner's three edits to one machine: rename, retire or unretire, rebind.
  // The exact paths are matched above, so `/v1/devices/self/resync` stays the
  // resync route and is never read as a machine called `self/resync`.
  if (request.method === 'PATCH' && path.startsWith(DEVICE_PREFIX)) {
    // A machine was already refused above, before this body was read at all.
    const body = (await request.json()) as {
      schemaVersion?: unknown
      deviceName?: unknown
      retired?: unknown
      rebindToken?: unknown
    }
    const refused = versionRefusal(body.schemaVersion)
    if (refused !== null) return refused

    let deviceName: string | undefined
    if (body.deviceName !== undefined) {
      const trimmed = typeof body.deviceName === 'string' ? body.deviceName.trim() : ''
      // Refused, never cut: a truncated name is a wrong name in somebody's list.
      if (trimmed === '' || trimmed.length > MAX_DEVICE_NAME) {
        return json({ error: 'bad deviceName' }, 400)
      }
      deviceName = trimmed
    }
    if (body.retired !== undefined && typeof body.retired !== 'boolean') {
      return json({ error: 'bad retired' }, 400)
    }
    // Only `true`: no history of tokens is kept, so `false` could only ask the
    // hub to put back a value it does not have.
    if (body.rebindToken !== undefined && body.rebindToken !== true) {
      return json({ error: 'bad rebindToken' }, 400)
    }
    if (deviceName === undefined && body.retired === undefined && body.rebindToken === undefined) {
      // Refused rather than answered: a caller that meant to send a name and sent
      // none would otherwise read the unchanged machine back as a rename.
      return json({ error: 'nothing to change' }, 400)
    }

    const device = devices.get(path.slice(DEVICE_PREFIX.length))
    if (device === undefined) return json({ error: 'no such device' }, 404)
    if (deviceName !== undefined) device.deviceName = deviceName
    if (typeof body.retired === 'boolean') device.retired = body.retired
    if (body.rebindToken === true) device.firstClientId = device.clientId
    return json({
      epoch,
      device: {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        os: device.os,
        appVersion: device.appVersion,
        lastPushAt: device.lastPushAt,
        retired: device.retired,
        clientId: device.clientId,
        firstClientId: device.firstClientId
      }
    })
  }

  return json({ error: 'no such route' }, 404)
}

if (options.seed !== undefined) {
  // Before the first request, and fatal on a bad file: a verifier that asked for
  // a peer and silently got none would read an empty machine list as a bug in
  // the app.
  applySeed(readSeed(options.seed))
  process.stdout.write(
    `seeded ${devices.size} device(s), ${buckets.size} bucket(s), ` +
      `${seededWindows.length} window(s), ${readings.size} reading(s)\n`
  )
}

const server = Bun.serve({
  port: options.port,
  fetch: (request) =>
    handle(request).catch((err) => json({ error: 'fake hub failed', detail: String(err) }, 500))
})

/**
 * Die with whoever started this.
 *
 * A harness that starts a hub and is then killed — a cancelled run, a timeout, a
 * shell wrapper that swallowed the kill signal before it reached this process —
 * leaves a listening server behind with nothing left to stop it. One integration
 * run leaked a dozen, and they accumulated into the hundreds on a developer
 * machine. A CLOSED STDIN is the one signal that arrives in every one of those
 * cases, so it is the one this listens for. A person running it by hand keeps
 * their terminal's stdin open and is unaffected; pass `< /dev/null` and it
 * exits, which is the correct reading of "nobody is holding this open".
 */
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume()

process.stdout.write(`fake usage hub listening on http://127.0.0.1:${server.port}\n`)
