/**
 * @vitest-environment node
 *
 * The usage hub client's loop and its failure states (ADR-072 §7).
 *
 * No network and no clock: `fetch` is injected and the timers are vitest's. What
 * is asserted is the behaviour a real hub would produce and a real one would be
 * expensive to produce on demand — a 302 from Cloudflare Access, a 426 from an
 * out-of-date hub, a raised epoch after someone pressed Resync on another
 * machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  closeDb,
  getHubConfigRow,
  getRemoteUsageBucketsSince,
  insertUsageEvent,
  insertUsageEvents,
  resetUsageEventWrittenListeners,
  upsertHubConfig,
  type UsageEventInsert
} from '../../db'
import { logger } from '../../logger'
import { recordLimitSamples, resetWindowSampleDedup } from '../../window-samples'
import { getMeta } from '../../db'
import { configureHub, setHubSecret } from '../config'
import { DEVICE_ID_META_KEY, deviceFacts, rememberAnnounced } from '../device'
import { UsageHubClient } from '../client'

const TS = 1_758_412_800_000
const SECRET = 'a-service-token-secret-value'
const HUB = 'https://hub.example.com'

/** One recorded request. */
interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []
let clients: UsageHubClient[] = []

beforeEach(() => {
  closeDb()
  resetUsageEventWrittenListeners()
  calls = []
  clients = []
  resetWindowSampleDedup()
  vi.useFakeTimers()
})

afterEach(() => {
  for (const client of clients) client.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  closeDb()
  resetUsageEventWrittenListeners()
})

function row(messageId: string, overrides: Partial<UsageEventInsert> = {}): UsageEventInsert {
  return {
    id: `id-${messageId}`,
    ts: TS,
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-5',
    inputTokens: 100,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    accountId: null,
    accountUuid: null,
    equivCostUsd: 0.01,
    engineCostUsd: null,
    sessionId: null,
    parentRoutingId: null,
    messageId,
    source: 'live',
    accountKey: 'anthropic:org-a:acct-a',
    accountLabel: 'someone@example.com',
    billingType: 'subscription',
    origin: 'session',
    apiCostUsd: 0.01,
    billedCostUsd: 0,
    ...overrides
  }
}

function enable(): void {
  configureHub({ url: HUB, deviceName: 'workshop', clientId: 'client-a', enabled: true })
  setHubSecret(SECRET)
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

/** A hub that accepts everything and returns empty pages. */
function happyHub(overrides: Partial<Record<string, () => Response>> = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    for (const [fragment, make] of Object.entries(overrides)) {
      if (url.includes(fragment)) return make!()
    }
    if (url.includes('/v1/events')) {
      // `accepted + duplicates === events.length`, the promise the cursor rests
      // on (ADR-072 §2). A fake that answered a flat 1 would have let the
      // client's own accounting check pass by accident.
      const sent = (JSON.parse(String(init?.body ?? '{}')) as { events?: unknown[] }).events ?? []
      return jsonResponse({ accepted: sent.length, duplicates: 0, epoch: 1 })
    }
    if (url.includes('/v1/limits') && init?.method === 'POST') {
      return jsonResponse({ accepted: 1, epoch: 1 })
    }
    if (url.includes('/v1/buckets')) return jsonResponse({ epoch: 1, rev: 0, buckets: [] })
    if (url.includes('/v1/windows')) return jsonResponse({ epoch: 1, rev: 0, windows: [] })
    if (url.includes('/v1/devices?')) return jsonResponse({ epoch: 1, devices: [] })
    if (url.includes('/v1/limits')) return jsonResponse({ epoch: 1, readings: [] })
    if (url.includes('/resync')) return jsonResponse({ deleted: 0, epoch: 2 })
    return jsonResponse({ error: 'unexpected route' }, 404)
  }) as unknown as typeof fetch
}

/** A hub that answers every request the same way. */
function alwaysHub(make: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return make()
  }) as unknown as typeof fetch
}

/**
 * This machine's id, which `enable()` has created (`configureHub` does it on the
 * OFF → ON edge — `status()` may not, because a query must not write).
 */
function myDeviceId(client: UsageHubClient): string {
  const id = client.status().deviceId
  expect(id).not.toBeNull()
  return id as string
}

function build(fetchImpl: typeof fetch): UsageHubClient {
  const client = new UsageHubClient({ fetchImpl, now: () => TS })
  clients.push(client)
  return client
}

describe('every request', () => {
  it('sets redirect: manual and sends both Access headers', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    await build(happyHub()).syncNow()

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.init.redirect).toBe('manual')
      const headers = call.init.headers as Record<string, string>
      expect(headers['CF-Access-Client-Id']).toBe('client-a')
      expect(headers['CF-Access-Client-Secret']).toBe(SECRET)
    }
  })

  it('carries the schema version, the device and the build on a push', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    await build(happyHub()).syncNow()

    const push = calls.find((call) => call.url.includes('/v1/events'))
    const body = JSON.parse(push!.init.body as string) as Record<string, unknown>
    expect(body.schemaVersion).toBe(1)
    expect(body.deviceName).toBe('workshop')
    expect(typeof body.appVersion).toBe('string')
    expect(body.os).toBe(process.platform)
    expect((body.events as unknown[]).length).toBe(1)
  })

  it('never sends a session id or a routing id, whatever the row held', async () => {
    enable()
    insertUsageEvent(row('msg-a', { sessionId: 'sess-secret', parentRoutingId: 'route-secret' }))
    await build(happyHub()).syncNow()

    const push = calls.find((call) => call.url.includes('/v1/events'))
    expect(push!.init.body as string).not.toContain('sess-secret')
    expect(push!.init.body as string).not.toContain('route-secret')
  })

  it('does nothing at all when no hub is configured', async () => {
    const client = build(happyHub())
    await client.syncNow()
    expect(calls).toHaveLength(0)
    expect(client.status().state).toBe('off')
  })
})

describe('the push advances the cursor, and only after the hub has the batch', () => {
  it('advances on success', async () => {
    enable()
    insertUsageEvents([row('msg-a'), row('msg-b')])
    await build(happyHub()).syncNow()
    expect(getHubConfigRow()?.cursorRowid).toBe(2)
  })

  it('leaves the cursor where it was when the push failed', async () => {
    enable()
    insertUsageEvents([row('msg-a'), row('msg-b')])
    await build(alwaysHub(() => jsonResponse({ error: 'down' }, 503))).syncNow()
    expect(getHubConfigRow()?.cursorRowid).toBe(0)
  })

  it('a re-sent batch is answered as duplicates and still advances', async () => {
    enable()
    insertUsageEvents([row('msg-a')])
    await build(
      happyHub({ '/v1/events': () => jsonResponse({ accepted: 0, duplicates: 1, epoch: 1 }) })
    ).syncNow()
    expect(getHubConfigRow()?.cursorRowid).toBe(1)
  })

  it('sends no events request at all when every waiting row is unattributed', async () => {
    enable()
    // Already announced, so ROWS are the only reason left to call the route —
    // a fresh device's hello has its own section below.
    upsertHubConfig({ lastPushAt: TS })
    rememberAnnounced(deviceFacts('workshop'))
    insertUsageEvents([row('msg-a', { accountKey: 'unknown' })])
    await build(happyHub()).syncNow()
    expect(calls.some((call) => call.url.includes('/v1/events'))).toBe(false)
    // The cursor still moved past it.
    expect(getHubConfigRow()?.cursorRowid).toBe(1)
  })
})

/**
 * A device the hub has never heard of (ADR-072 §7, amended by S5b).
 *
 * The hub learns a machine exists only from an events push, and a fresh
 * machine's cursor starts at `MAX(rowid)` — so without an empty "hello" a
 * machine could sync for days, pulling the combined view, while the hub's
 * machine list never mentioned it. The verifier found exactly that.
 */
describe('a device announces itself', () => {
  function eventPushes(): Array<Record<string, unknown>> {
    return calls
      .filter((call) => call.url.includes('/v1/events'))
      .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>)
  }

  it('pushes an empty batch when it has never pushed and has nothing to send', async () => {
    enable()
    const client = build(happyHub())
    await client.syncNow()

    const pushes = eventPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0].events).toEqual([])
    // The hello carries the same three facts a real batch would.
    expect(pushes[0]).toMatchObject({
      deviceId: myDeviceId(client),
      deviceName: 'workshop',
      os: process.platform
    })
    expect(typeof pushes[0].appVersion).toBe('string')
    expect(client.status().state).toBe('idle')
    expect(getHubConfigRow()?.lastPushAt).toBe(TS)
  })

  it('does it once — a second sync with nothing pending pushes nothing', async () => {
    enable()
    const client = build(happyHub())
    await client.syncNow()
    expect(eventPushes()).toHaveLength(1)

    calls = []
    await client.syncNow()
    expect(eventPushes()).toHaveLength(0)
  })

  it('announces again when the device name changed, and only then', async () => {
    enable()
    const client = build(happyHub())
    await client.syncNow()
    calls = []

    // A rename is a `configure`, which is also what the settings group sends.
    configureHub({ url: HUB, deviceName: 'renamed', clientId: 'client-a', enabled: true })
    await client.syncNow()
    const pushes = eventPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ deviceName: 'renamed', events: [] })

    // And it settles again: the facts the hub holds are now the current ones.
    calls = []
    await client.syncNow()
    expect(eventPushes()).toHaveLength(0)
  })

  it('a real batch is the announce — no separate hello beside it', async () => {
    enable()
    insertUsageEvents([row('msg-a')])
    const client = build(happyHub())
    await client.syncNow()

    const pushes = eventPushes()
    expect(pushes).toHaveLength(1)
    expect((pushes[0].events as unknown[]).length).toBe(1)

    calls = []
    await client.syncNow()
    expect(eventPushes()).toHaveLength(0)
  })

  it('does not record the announce when the hub refused it', async () => {
    enable()
    const client = build(alwaysHub(() => jsonResponse({ error: 'down' }, 503)))
    await client.syncNow()
    expect(client.status().state).toBe('backoff')

    calls = []
    await build(happyHub()).syncNow()
    expect(eventPushes()).toHaveLength(1)
  })
})

describe('a rejected credential', () => {
  it('reads a 302 to the Access login as rejected, and stops the timers', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(
      alwaysHub(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login' }
          })
      )
    )
    client.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(client.status().state).toBe('needs-credentials')
    const before = calls.length
    // An hour of timers must produce nothing: only a person can fix this.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(calls.length).toBe(before)
  })

  it('reads a 401 the same way', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ error: 'no' }, 401)))
    await client.syncNow()
    expect(client.status().state).toBe('needs-credentials')
  })

  it('reads a 403 the same way', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ error: 'no' }, 403)))
    await client.syncNow()
    expect(client.status().state).toBe('needs-credentials')
  })

  it('says so without a hub call when no secret is stored', async () => {
    configureHub({ url: HUB, deviceName: 'workshop', clientId: 'client-a', enabled: true })
    const client = build(happyHub())
    await client.syncNow()
    expect(calls).toHaveLength(0)
    expect(client.status().state).toBe('needs-credentials')
  })
})

describe('a hub that is behind', () => {
  it('ends in update-hub with the cursor untouched', async () => {
    enable()
    insertUsageEvents([row('msg-a'), row('msg-b')])
    const client = build(alwaysHub(() => jsonResponse({ hubSchemaVersion: 1 }, 426)))
    await client.syncNow()

    expect(client.status().state).toBe('update-hub')
    expect(getHubConfigRow()?.cursorRowid).toBe(0)
    expect(client.status().lastError).toContain('update the hub')
  })

  it('stays paused on a timer, and a pressed sync tries again', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ hubSchemaVersion: 1 }, 426)))
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterStart = calls.length

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(calls.length).toBe(afterStart)

    await client.syncNow()
    expect(calls.length).toBeGreaterThan(afterStart)
  })
})

describe('backoff', () => {
  it('walks 5 s, 15 s, 60 s, 5 min and then doubles to a one-hour ceiling', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ error: 'down' }, 503)))
    // `syncNow()` rather than `start()`: the ten-minute backstop interval keeps
    // running through a backoff (deliberately — it is the thing that recovers a
    // machine whose retry timer died with a sleep), and an extra attempt from it
    // would be indistinguishable here from a wrong ladder step.
    await client.syncNow()
    expect(client.status().state).toBe('backoff')

    const attempts = (): number => calls.filter((call) => call.url.includes('/v1/events')).length
    let seen = attempts()

    for (const delay of [5_000, 15_000, 60_000, 300_000, 600_000, 1_200_000, 2_400_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(attempts()).toBe(seen)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts()).toBe(seen + 1)
      seen += 1
    }

    // Capped: the next step would be 4,800 s and the ceiling is 3,600 s.
    await vi.advanceTimersByTimeAsync(3_600_000 - 1)
    expect(attempts()).toBe(seen)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(seen + 1)
  })

  it('honours Retry-After on a 429', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(
      alwaysHub(() => jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '120' }))
    )
    await client.syncNow()
    expect(client.status().state).toBe('backoff')

    const attempts = (): number => calls.filter((call) => call.url.includes('/v1/events')).length
    const seen = attempts()
    // The ladder's first step is 5 s; the header says two minutes and wins.
    await vi.advanceTimersByTimeAsync(119_999)
    expect(attempts()).toBe(seen)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(seen + 1)
  })

  it('a network failure backs off rather than throwing', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build((async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    await expect(client.syncNow()).resolves.toBeDefined()
    expect(client.status().state).toBe('backoff')
    expect(client.status().lastError).toContain('hub unreachable')
  })

  it('a 400 is an error and is NOT retried on a timer', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ error: 'malformed' }, 400)))
    await client.syncNow()
    expect(client.status().state).toBe('error')
    const seen = calls.length
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(calls.length).toBe(seen)
  })

  it('recovers: a success after a failure clears the error and the ladder', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    let failing = true
    const client = build((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      if (failing) return jsonResponse({ error: 'down' }, 503)
      return happyHub()(input, init)
    }) as unknown as typeof fetch)
    await client.syncNow()
    expect(client.status().state).toBe('backoff')

    failing = false
    await client.syncNow()
    expect(client.status().state).toBe('idle')
    expect(client.status().lastError).toBeNull()
  })
})

describe('the secret never reaches a log line', () => {
  it('not on a rejection, not on a failure, not on a success', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const lines: string[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '))
      })
    }

    await build(alwaysHub(() => jsonResponse({ error: 'no' }, 401))).syncNow()
    await build(alwaysHub(() => jsonResponse({ error: 'down' }, 503))).syncNow()
    await build(happyHub()).syncNow()

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(SECRET)
  })
})

describe('the pull', () => {
  const bucket = (deviceId: string, rev: number, hourUtc: number): Record<string, unknown> => ({
    deviceId,
    rev,
    hourUtc,
    accountKey: 'anthropic:org-a:acct-a',
    billingType: 'subscription',
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-5',
    origin: 'session',
    inputTokens: 10,
    outputTokens: 2,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    apiCostUsd: 0.01,
    billedCostUsd: 0,
    unbilledApiCostUsd: 0.01,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 1,
    requestCount: 1,
    source: 'rollup'
  })

  it('stores the buckets of another machine and never its own', async () => {
    enable()
    const client = build(happyHub())
    const me = myDeviceId(client)
    let page = 0
    const hub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.includes('/v1/buckets')) {
        page += 1
        if (page === 1) {
          return jsonResponse({
            epoch: 1,
            rev: 2,
            // The hub excludes the caller, but a client that trusted that would
            // double every total the day a hub got it wrong.
            buckets: [bucket('device-b', 1, TS), bucket(me, 2, TS)]
          })
        }
        return jsonResponse({ epoch: 1, rev: 2, buckets: [] })
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch

    await build(hub).syncNow()

    expect(getRemoteUsageBucketsSince(0).map((b) => b.deviceId)).toEqual(['device-b'])
  })

  it('fills the machine list from GET /v1/devices, minus itself', async () => {
    enable()
    const client = build(happyHub())
    const me = myDeviceId(client)
    const hub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1/devices?')) {
        calls.push({ url, init: init ?? {} })
        return jsonResponse({
          epoch: 1,
          devices: [
            {
              deviceId: 'device-b',
              deviceName: 'studio',
              os: 'darwin',
              appVersion: '3.2.0',
              lastPushAt: TS - 60_000,
              retired: false
            },
            // The hub lists every machine, this one included; the client keeps
            // its own out of the cache, because its own state is not remote.
            {
              deviceId: me,
              deviceName: 'workshop',
              os: 'win32',
              appVersion: '3.3.0',
              lastPushAt: TS,
              retired: false
            }
          ]
        })
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch

    const driver = build(hub)
    await driver.syncNow()

    expect(driver.status().remote.devices).toEqual([
      {
        deviceId: 'device-b',
        deviceName: 'studio',
        os: 'darwin',
        appVersion: '3.2.0',
        lastPushAt: TS - 60_000,
        retired: false
      }
    ])
  })

  it('excludes itself in the query it sends', async () => {
    enable()
    const client = build(happyHub())
    await client.syncNow()
    const bucketsCall = calls.find((call) => call.url.includes('/v1/buckets'))
    expect(bucketsCall!.url).toContain(`exclude_device=${encodeURIComponent(myDeviceId(client))}`)
    expect(bucketsCall!.url).toContain('since=0')
  })

  it('a changed epoch drops the cached rows and pulls again from rev 0', async () => {
    enable()
    // First pass: epoch 1, one page of buckets, so the rev advances.
    let epoch = 1
    const sinceSeen: string[] = []
    const hub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.includes('/v1/buckets')) {
        const since = new URL(url).searchParams.get('since') ?? ''
        sinceSeen.push(since)
        if (since === '0') {
          return jsonResponse({ epoch, rev: 5, buckets: [bucket('device-b', 5, TS)] })
        }
        return jsonResponse({ epoch, rev: 5, buckets: [] })
      }
      // Every route of a REAL hub reports the same epoch in one pass, and a fake
      // that did not would have the client dropping the cache it had just filled.
      if (url.includes('/v1/windows')) return jsonResponse({ epoch, windows: [] })
      if (url.includes('/v1/limits')) return jsonResponse({ epoch, readings: [] })
      return happyHub()(input, init)
    }) as unknown as typeof fetch

    const client = build(hub)
    await client.syncNow()
    expect(getHubConfigRow()?.remoteRev).toBe(5)
    expect(getHubConfigRow()?.remoteEpoch).toBe(1)

    // Someone pressed Resync on another machine: the hub rebuilt and its epoch
    // rose. An hour can have been REMOVED by a rebuild, and "since rev" cannot
    // say that, so the only correct answer is to forget and start again.
    epoch = 2
    sinceSeen.length = 0
    await client.syncNow()

    expect(sinceSeen[0]).not.toBe('0')
    expect(sinceSeen).toContain('0')
    expect(getHubConfigRow()?.remoteEpoch).toBe(2)
  })

  it('records the first epoch it ever sees without dropping anything', async () => {
    enable()
    const client = build(happyHub())
    await client.syncNow()
    expect(getHubConfigRow()?.remoteEpoch).toBe(1)
    expect(client.status().remote.epoch).toBe(1)
  })

  it('stamps lastPullAt and lastPushAt, and ends idle', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(happyHub())
    await client.syncNow()
    const status = client.status()
    expect(status.state).toBe('idle')
    expect(status.lastPushAt).toBe(TS)
    expect(status.lastPullAt).toBe(TS)
    expect(status.pendingEvents).toBe(0)
  })
})

describe('the triggers', () => {
  it('debounces three ledger writes inside a minute into one push', async () => {
    enable()
    const client = build(happyHub())
    client.start()
    // The start pass first, so what follows is the notifier's doing alone.
    await vi.advanceTimersByTimeAsync(0)
    const afterStart = calls.filter((call) => call.url.includes('/v1/events')).length

    insertUsageEvent(row('msg-a'))
    await vi.advanceTimersByTimeAsync(10_000)
    insertUsageEvent(row('msg-b'))
    await vi.advanceTimersByTimeAsync(10_000)
    insertUsageEvent(row('msg-c'))

    // Still inside the minute: nothing has gone out.
    expect(calls.filter((call) => call.url.includes('/v1/events')).length).toBe(afterStart)

    await vi.advanceTimersByTimeAsync(41_000)
    const pushes = calls.filter((call) => call.url.includes('/v1/events'))
    expect(pushes.length).toBe(afterStart + 1)
    // One request, all three rows.
    const body = JSON.parse(pushes[pushes.length - 1].init.body as string) as {
      events: unknown[]
    }
    expect(body.events).toHaveLength(3)
  })

  it('pulls on the ten-minute timer with nothing to push', async () => {
    enable()
    const client = build(happyHub())
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterStart = calls.filter((call) => call.url.includes('/v1/windows')).length

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(calls.filter((call) => call.url.includes('/v1/windows')).length).toBe(afterStart + 1)
  })

  it('starts no timers under CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, but a pressed sync runs', async () => {
    enable()
    const previous = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    try {
      const client = build(happyHub())
      client.start()
      insertUsageEvent(row('msg-a'))
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(calls).toHaveLength(0)

      await client.syncNow()
      expect(calls.length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
      else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previous
    }
  })

  it('stop() ends every timer', async () => {
    enable()
    const client = build(happyHub())
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    client.stop()
    const seen = calls.length
    insertUsageEvent(row('msg-a'))
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(calls.length).toBe(seen)
    expect(client.status().state).toBe('off')
  })
})

describe('resync', () => {
  it('sends the oldest local ts, resets the cursor and pushes everything again', async () => {
    enable()
    insertUsageEvents([row('msg-a', { ts: TS - 1_000 }), row('msg-b', { ts: TS })])
    const client = build(happyHub())
    await client.syncNow()
    expect(getHubConfigRow()?.cursorRowid).toBe(2)

    calls = []
    await client.resync()

    const resyncCall = calls.find((call) => call.url.includes('/resync'))
    const body = JSON.parse(resyncCall!.init.body as string) as Record<string, unknown>
    expect(body.since).toBe(TS - 1_000)
    // The hub dropped this device's rows from that instant, so they all go again.
    const push = calls.find((call) => call.url.includes('/v1/events'))
    const pushed = JSON.parse(push!.init.body as string) as { events: unknown[] }
    expect(pushed.events).toHaveLength(2)
  })

  it('does nothing when the ledger is empty', async () => {
    enable()
    const client = build(happyHub())
    await client.resync()
    expect(calls.some((call) => call.url.includes('/resync'))).toBe(false)
  })
})

describe('limit readings ride the same push', () => {
  const reading = (): void => {
    recordLimitSamples({
      accountKey: 'anthropic:org-a:acct-a',
      accountUuid: 'uuid-a',
      accountLabel: 'someone@example.com',
      vendorId: 'anthropic',
      plan: 'max_20x',
      now: TS,
      windows: [
        {
          kind: '7d',
          usedPercent: 51,
          resetsAt: new Date(TS + 60_000).toISOString(),
          windowMinutes: 10_080
        }
      ]
    })
  }

  it('pushes what recordLimitSamples wrote, with the window length (S3c)', async () => {
    enable()
    const client = build(happyHub())
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    calls = []

    reading()
    await vi.advanceTimersByTimeAsync(60_000)

    const push = calls.find(
      (call) => call.url.includes('/v1/limits') && call.init.method === 'POST'
    )
    expect(push).toBeDefined()
    const body = JSON.parse(push!.init.body as string) as {
      schemaVersion: number
      readings: Array<Record<string, unknown>>
    }
    expect(body.schemaVersion).toBe(1)
    expect(body.readings).toHaveLength(1)
    expect(body.readings[0]).toMatchObject({
      accountKey: 'anthropic:org-a:acct-a',
      accountLabel: 'someone@example.com',
      vendorId: 'anthropic',
      plan: 'max_20x',
      windowKind: '7d',
      windowMinutes: 10_080,
      usedPercent: 51
    })
  })

  it('keeps a reading that failed to send, and sends it on the next pass', async () => {
    enable()
    let failing = true
    const client = build((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (failing && url.includes('/v1/limits') && init?.method === 'POST') {
        calls.push({ url, init: init ?? {} })
        return jsonResponse({ error: 'down' }, 503)
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)

    reading()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.status().state).toBe('backoff')

    failing = false
    calls = []
    await client.syncNow()
    const push = calls.find(
      (call) => call.url.includes('/v1/limits') && call.init.method === 'POST'
    )
    const body = JSON.parse(push!.init.body as string) as { readings: unknown[] }
    expect(body.readings).toHaveLength(1)
  })
})

/**
 * Round 2 — the pauses, the epoch discipline and the hub's two promises.
 *
 * Every case here is a defect an independent reviewer found in round 1: a state
 * that claimed not to retry and did, a revoked token that kept pushing for ever,
 * a window watermark that was a clock, and an events answer nobody checked.
 */
describe('a paused client stays paused', () => {
  it('error pauses the ten-minute interval, and a pressed sync lifts it', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ error: 'malformed' }, 400)))
    // `start()`, so the INTERVAL is running — clearing the retry timer alone
    // left it firing every ten minutes for ever, which is what round 1 did.
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.status().state).toBe('error')

    const attempts = (): number => calls.filter((call) => call.url.includes('/v1/events')).length
    const seen = attempts()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(attempts()).toBe(seen)

    await client.syncNow()
    expect(attempts()).toBe(seen + 1)
  })

  it('update-hub pauses the interval too', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const client = build(alwaysHub(() => jsonResponse({ hubSchemaVersion: 1 }, 426)))
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.status().state).toBe('update-hub')

    const seen = calls.length
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(calls.length).toBe(seen)
  })

  it('a rejected credential arms nothing on a ledger write — not one request a minute', async () => {
    enable()
    const client = build(alwaysHub(() => jsonResponse({ error: 'no' }, 401)))
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.status().state).toBe('needs-credentials')

    const seen = calls.length
    // An hour of spend on a machine whose token was revoked. Round 1 sent one
    // request train for every minute of it, because `stopTimers()` left the
    // notifier subscriptions live and `onLedgerWrite` never looked at the state.
    for (let minute = 0; minute < 60; minute++) {
      insertUsageEvent(row(`msg-${minute}`))
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(calls.length).toBe(seen)
  })

  it('a rejected credential queues no limit readings either', async () => {
    enable()
    const client = build(alwaysHub(() => jsonResponse({ error: 'no' }, 401)))
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    const seen = calls.length

    recordLimitSamples({
      accountKey: 'anthropic:org-a:acct-a',
      accountUuid: 'uuid-a',
      vendorId: 'anthropic',
      now: TS,
      windows: [{ kind: '7d', usedPercent: 51, resetsAt: new Date(TS + 60_000).toISOString() }]
    })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(calls.length).toBe(seen)
  })

  it('a new secret re-arms the client through restart()', async () => {
    enable()
    let failing = true
    const client = build((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failing) {
        calls.push({ url: String(input), init: init ?? {} })
        return jsonResponse({ error: 'no' }, 401)
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.status().state).toBe('needs-credentials')

    failing = false
    setHubSecret('a-fresh-service-token-secret')
    client.restart()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.status().state).toBe('idle')

    // And the notifier is live again.
    const seen = calls.length
    insertUsageEvent(row('msg-after'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBeGreaterThan(seen)
  })

  it('under the env gate a failed pressed sync schedules no retry', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    const previous = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    try {
      const client = build(alwaysHub(() => jsonResponse({ error: 'down' }, 503)))
      await client.syncNow()
      expect(client.status().state).toBe('backoff')
      const seen = calls.length
      // The user asked for ONE request, not for a ladder of them.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(calls.length).toBe(seen)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
      else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previous
    }
  })
})

describe('the hub keeps its promises, or the pass fails', () => {
  it('a short events answer is a failure and the cursor is held back', async () => {
    enable()
    insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c')])
    const client = build(
      happyHub({
        // Three sent, two accounted for. The row the hub dropped would have been
        // lost for ever behind an advanced cursor.
        '/v1/events': () => jsonResponse({ accepted: 1, duplicates: 1, epoch: 1 })
      })
    )
    await client.syncNow()

    expect(client.status().state).toBe('error')
    expect(client.status().lastError).toContain('accounted for 2 of 3')
    expect(getHubConfigRow()?.cursorRowid).toBe(0)
  })

  it('accepted + duplicates equal to the batch is accepted', async () => {
    enable()
    insertUsageEvents([row('msg-a'), row('msg-b')])
    const client = build(
      happyHub({ '/v1/events': () => jsonResponse({ accepted: 1, duplicates: 1, epoch: 1 }) })
    )
    await client.syncNow()
    expect(client.status().state).toBe('idle')
    expect(getHubConfigRow()?.cursorRowid).toBe(2)
  })

  it('an epoch that changes mid-pass abandons the pass and writes nothing', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    // The buckets page lands under epoch 1; the windows request then reports 2,
    // which the hub promises not to do inside a minute. Round 1 would have
    // truncated the rows it had just stored and reset the watermark.
    const hub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1/buckets')) {
        calls.push({ url, init: init ?? {} })
        return jsonResponse({
          epoch: 1,
          rev: 7,
          buckets: [
            {
              deviceId: 'device-b',
              rev: 7,
              hourUtc: TS,
              accountKey: 'anthropic:org-a:acct-a',
              billingType: 'subscription',
              engineId: 'claude',
              vendorId: 'anthropic',
              modelId: 'claude-opus-5',
              origin: 'session',
              requestCount: 1
            }
          ]
        })
      }
      if (url.includes('/v1/windows')) {
        calls.push({ url, init: init ?? {} })
        return jsonResponse({ epoch: 2, rev: 0, windows: [] })
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch

    const client = build(hub)
    await client.syncNow()

    expect(client.status().state).toBe('backoff')
    expect(client.status().lastError).toContain('changed its epoch mid-pass')
    // Epoch 1 was adopted as the pass epoch (nothing was held before), and the
    // conflicting one was NOT: no truncate, no second generation recorded.
    expect(getHubConfigRow()?.remoteEpoch).toBe(1)
    // The buckets stored under epoch 1 stay; the next pass sees epoch 2 as its
    // FIRST response and drops the cache properly.
    expect(getRemoteUsageBucketsSince(0)).toHaveLength(1)
  })

  it('states the schema version on every request, GETs included', async () => {
    enable()
    insertUsageEvent(row('msg-a'))
    await build(happyHub()).syncNow()

    for (const call of calls) {
      if (call.init.method === 'POST') {
        const body = JSON.parse(call.init.body as string) as { schemaVersion?: number }
        expect(body.schemaVersion).toBe(1)
      } else {
        expect(new URL(call.url).searchParams.get('schemaVersion')).toBe('1')
      }
    }
    // And a GET is one of them, so the loop above is not vacuous.
    expect(calls.some((call) => call.init.method !== 'POST')).toBe(true)
  })

  it('pages the windows by the hub rev, not by a clock', async () => {
    enable()
    const windowRow = (rev: number): Record<string, unknown> => ({
      deviceId: 'device-b',
      accountKey: 'anthropic:org-a:acct-a',
      windowKind: '7d',
      canonicalEnd: TS + 60_000,
      windowStart: TS - 604_800_000,
      windowMinutes: 10_080,
      peakPercent: 51,
      apiCostUsd: 1.5,
      billedCostUsd: 0,
      unknownCostCount: 0,
      inputTokens: 10,
      outputTokens: 2,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      sampleCount: 3,
      closed: false,
      // The clock the first draft paged by: FROZEN across both pages, so a
      // watermark taken from it would ask for the same page for ever.
      updatedAt: TS,
      rev
    })
    const seen: string[] = []
    let page = 0
    const hub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1/windows')) {
        calls.push({ url, init: init ?? {} })
        seen.push(new URL(url).searchParams.get('since') ?? '')
        page += 1
        if (page === 1) return jsonResponse({ epoch: 1, rev: 11, windows: [windowRow(11)] })
        return jsonResponse({ epoch: 1, rev: 11, windows: [] })
      }
      return happyHub()(input, init)
    }) as unknown as typeof fetch

    await build(hub).syncNow()

    expect(seen).toEqual(['0', '11'])
    expect(getHubConfigRow()?.remoteWindowRev).toBe(11)
  })
})

describe('reading the status changes nothing', () => {
  it('answers a null device id before sync was ever enabled, and creates none', () => {
    const client = build(happyHub())
    expect(client.status().deviceId).toBeNull()
    expect(getMeta(DEVICE_ID_META_KEY)).toBeNull()
    // Twice, because a lazy generator would have written on the first call.
    expect(client.status().deviceId).toBeNull()
    expect(getMeta(DEVICE_ID_META_KEY)).toBeNull()
  })

  it('enabling creates the id, and the status reads it back', () => {
    enable()
    const client = build(happyHub())
    const stored = getMeta(DEVICE_ID_META_KEY)
    expect(stored).not.toBeNull()
    expect(client.status().deviceId).toBe(stored)
  })

  it('carries the client id but never the secret', () => {
    enable()
    const status = build(happyHub()).status()
    expect(status.clientId).toBe('client-a')
    expect(JSON.stringify(status)).not.toContain(SECRET)
  })
})

describe('configure', () => {
  it('accepts an empty URL when sync is being turned off', () => {
    enable()
    expect(() =>
      configureHub({ url: '', deviceName: 'workshop', clientId: 'client-a', enabled: false })
    ).not.toThrow()
    expect(build(happyHub()).status()).toMatchObject({ enabled: false, url: '' })
  })

  it('still refuses an empty URL when sync is being turned on', () => {
    expect(() =>
      configureHub({ url: '', deviceName: 'workshop', clientId: 'client-a', enabled: true })
    ).toThrow()
  })
})
