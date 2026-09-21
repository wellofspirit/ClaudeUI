/**
 * A fake usage hub (ADR-072 §8).
 *
 *     bun scripts/fake-usage-hub.ts --client-id <id> --client-secret <secret>
 *
 * ## What this is for
 *
 * The real hub is a Cloudflare Worker in its own repository and it does not
 * exist yet. This serves the same protocol from memory so that the client can be
 * driven end to end: the gated integration test starts it on a random port, and
 * a real-app verifier points a running ClaudeUI at it.
 *
 * **It goes to the hub repository as that project's first contract test**, which
 * is why it is self-contained: `Bun.serve` and nothing installed, no import from
 * `src/`, and the protocol restated here in the shapes the fixtures hold rather
 * than imported from the client's types. A fake that shared the client's
 * declarations could not catch the client and the hub disagreeing, which is the
 * one thing two repositories need catching.
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
 *     redirects would parse a login page as the hub's answer.
 *
 * Thin, because it is a test double and not a deployment: no D1, no Access JWT
 * verification (the headers stand in for it), no owner sign-in, no `/dash`
 * routes, no R2 archive, and the whole store dies with the process.
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
 */

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
}

const SCHEMA_VERSION = 1
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
  debugStore: process.argv.includes('--debug-store')
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const events = new Map<string, StoredEvent>()
const buckets = new Map<string, StoredBucket>()
const readings = new Map<string, StoredReading>()
const devices = new Map<string, StoredDevice>()
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

/** Rebuild every bucket of one device from the raw rows it still holds. */
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
  return `${user[0]}•••@${host[0]}•••${tld}`
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
 * The Access gate, as the spike found it: a bad service token is answered with a
 * 302 to the hosted login page. The deployer can turn on a 401 instead, so both
 * shapes are legal and a client has to read either as "credentials rejected".
 */
function authorized(request: Request): boolean {
  if (options.clientId === undefined || options.clientSecret === undefined) return true
  return (
    request.headers.get('CF-Access-Client-Id') === options.clientId &&
    request.headers.get('CF-Access-Client-Secret') === options.clientSecret
  )
}

function rejected(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login' }
  })
}

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) return rejected()

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
      devices: [...devices.values()]
    })
  }

  // The two injectors, from here down: every `/v1/*` route and nothing else.
  if (options.rejectSchema !== null) {
    return json({ hubSchemaVersion: options.rejectSchema }, 426)
  }
  if (options.flaky > 0 && Math.random() < options.flaky) {
    return json({ error: 'injected failure' }, 503)
  }

  // `schemaVersion` on EVERY route (ADR-072 §8): the body for a POST, the query
  // for a GET, and any route may answer 426. A hub that checked only the writes
  // would hand a client a response shape it cannot parse, and the client would
  // read the mismatch as corrupt data rather than as "update your hub".
  if (request.method === 'GET' && path.startsWith('/v1/')) {
    const raw = url.searchParams.get('schemaVersion')
    // An ABSENT parameter is refused, not defaulted: `Number('')` is 0, which is
    // finite, so a lenient read would have let an unversioned request through
    // and the whole point of P4 is that there is no such request.
    if (raw === null || raw.trim() === '' || !Number.isFinite(Number(raw))) {
      return json({ error: 'no schemaVersion' }, 400)
    }
    if (Number(raw) > SCHEMA_VERSION) return json({ hubSchemaVersion: SCHEMA_VERSION }, 426)
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
    if ((body.schemaVersion ?? 0) > SCHEMA_VERSION) {
      return json({ hubSchemaVersion: SCHEMA_VERSION }, 426)
    }
    const deviceId = body.deviceId ?? ''
    if (deviceId === '') return json({ error: 'no deviceId' }, 400)
    // BEFORE the batch is looked at, and with no check that there is one: an
    // empty `events` array is a valid request and is how a device that has
    // nothing to send announces itself (ADR-072 §7). Recording it here is what
    // makes `{ accepted: 0, duplicates: 0 }` a complete answer, and it is part
    // of the contract the hub repository inherits with this file.
    const known = devices.get(deviceId)
    devices.set(deviceId, {
      deviceId,
      deviceName: body.deviceName ?? deviceId,
      appVersion: body.appVersion ?? 'unknown',
      os: body.os ?? 'unknown',
      lastPushAt: Date.now(),
      retired: known?.retired ?? false
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
    if ((body.schemaVersion ?? 0) > SCHEMA_VERSION) {
      return json({ hubSchemaVersion: SCHEMA_VERSION }, 426)
    }
    const deviceId = body.deviceId ?? ''
    let accepted = 0
    for (const reading of body.readings ?? []) {
      if (!reading?.accountKey || !reading.windowKind) continue
      const key = JSON.stringify([reading.accountKey, reading.windowKind])
      const existing = readings.get(key)
      // Latest wins, and only the latest: two devices watching one account must
      // not be able to move its meter backwards.
      if (existing && existing.observedAt > reading.observedAt) continue
      readings.set(key, { ...reading, deviceId })
      accepted++
    }
    return json({ accepted, epoch })
  }

  if (request.method === 'POST' && path === '/v1/devices/self/resync') {
    const body = (await request.json()) as {
      schemaVersion?: number
      deviceId?: string
      since?: number
    }
    if ((body.schemaVersion ?? 0) > SCHEMA_VERSION) {
      return json({ hubSchemaVersion: SCHEMA_VERSION }, 426)
    }
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
    const page = [...buckets.values()]
      .filter((bucket) => bucket.rev > since && bucket.deviceId !== exclude)
      .sort((a, b) => a.rev - b.rev)
      .slice(0, 500)
    const rev = page.reduce((max, bucket) => Math.max(max, bucket.rev), since)
    return json({ epoch, rev, buckets: page })
  }

  if (request.method === 'GET' && path === '/v1/windows') {
    // The window ledger is the hub's own rollup in the real thing (ADR-072 §4),
    // and a fake that invented numbers would let a wrong merge look right
    // against figures nothing produced. So the page is always empty — but it
    // carries the `rev` envelope, because the client's paging loop is real and
    // has to terminate against it.
    const since = Number(url.searchParams.get('since') ?? 0)
    return json({ epoch, rev: since, windows: [] })
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
      observedAt: reading.observedAt
    }))
    return json({ epoch, readings: page })
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
        retired: device.retired
      }))
    })
  }

  return json({ error: 'no such route' }, 404)
}

const server = Bun.serve({
  port: options.port,
  fetch: (request) =>
    handle(request).catch((err) => json({ error: 'fake hub failed', detail: String(err) }, 500))
})

process.stdout.write(`fake usage hub listening on http://127.0.0.1:${server.port}\n`)
