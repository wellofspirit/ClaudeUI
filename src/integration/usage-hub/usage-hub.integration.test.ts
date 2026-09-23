/**
 * The usage hub client against the fake hub (ADR-072 §8).
 *
 * Gated: the `integration` vitest project is not in `bun run test`, so this runs
 * only under `bun run test:integration`. It spawns `scripts/fake-usage-hub.ts`
 * with bun, because that script is the contract double that goes to the hub
 * repository and it must be exercised as the standalone process it will be
 * there — not as an in-process helper that could quietly share this app's types.
 *
 * What only this level can prove:
 *
 *   - the two ends agree on the WIRE, not on a mock's idea of it: the routes,
 *     the query parameters (`schemaVersion` included), the JSON shapes, the two
 *     Access headers;
 *   - idempotency end to end — a replayed batch is answered as duplicates and
 *     changes no bucket on the hub;
 *   - `--flaky 0.3`: with a third of the `/v1/*` requests failing, every event
 *     still arrives exactly once. That is the property the whole design rests
 *     on, and a unit test with a scripted `fetch` cannot really put it under
 *     load.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { resolve } from 'node:path'
import {
  closeDb,
  getHubConfigRow,
  getRemoteUsageBucketsSince,
  insertUsageEvents,
  listRemoteAccounts,
  resetUsageEventWrittenListeners,
  upsertHubConfig,
  type UsageEventInsert
} from '../../core/services/db'
import { configureHub, setHubSecret } from '../../core/services/usage-hub/config'
import { UsageHubClient } from '../../core/services/usage-hub/client'
import { buildUsageDashboard } from '../../core/services/usage-dashboard'
import { recordLimitSamples, resetWindowSampleDedup } from '../../core/services/window-samples'

const CLIENT_ID = 'fixture-client-id'
const CLIENT_SECRET = 'fixture-client-secret'
const TS = Date.UTC(2026, 8, 21, 3, 0, 0)

const SCRIPT = resolve(__dirname, '..', '..', '..', 'scripts', 'fake-usage-hub.ts')

interface FakeHub {
  url: string
}

/** What the fake hub's `/debug/store` route answers. */
interface HubStore {
  epoch: number
  events: Array<{ messageId: string; deviceId: string; accountKey: string }>
  buckets: Array<{ deviceId: string; hourUtc: number; requestCount: number }>
  readings: Array<{ accountKey: string; windowKind: string; accountLabel: string | null }>
  devices: Array<{
    deviceId: string
    deviceName: string
    appVersion: string
    os: string
    lastPushAt: number
    retired: boolean
  }>
  accounts: Array<{ accountKey: string; vendorId: string; label: string | null }>
}

const spawned: ChildProcess[] = []

/**
 * How a hub process is started, and why not through a shell.
 *
 * `shell: true` ON WINDOWS WAS A PROCESS LEAK. It runs `cmd.exe /c bun …`, so
 * the child this suite holds is the shell and the hub is its GRANDchild;
 * `child.kill()` then stopped `cmd.exe` and left a listening `bun.exe` behind,
 * one per hub per run. They accumulated into the hundreds on the owner's
 * machine. `CreateProcess` appends `.exe` and searches `PATH` by itself, so the
 * shell bought nothing here in the first place.
 *
 * Stdin is a PIPE rather than `ignore`, because the hub exits when its stdin
 * closes — the backstop for a run that is cancelled or times out before any
 * `afterEach` gets to run.
 */
const SPAWN_OPTIONS: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] }

/**
 * Stop one hub and WAIT for it to be gone.
 *
 * `kill()` only asks. A test that returned on the signal left the port bound
 * and the process listed for as long as it took to die, which is what made the
 * leak invisible until someone counted.
 */
async function stopFakeHub(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  // Both, in order: the polite signal the script itself listens for, then the
  // blunt one for a process that is wedged mid-request.
  child.stdin?.end()
  child.kill()
  await Promise.race([
    exited,
    new Promise<void>((done) => setTimeout(done, 5_000)).then(() => {
      child.kill('SIGKILL')
      return exited
    })
  ])
}

/** Stop every hub started so far, whatever happened to the test that started it. */
async function stopAllFakeHubs(): Promise<void> {
  await Promise.all(spawned.splice(0).map((child) => stopFakeHub(child)))
}

async function startFakeHub(extra: string[] = []): Promise<FakeHub> {
  const child = spawn(
    'bun',
    [
      SCRIPT,
      '--port',
      '0',
      '--client-id',
      CLIENT_ID,
      '--client-secret',
      CLIENT_SECRET,
      // Opt-in, because the route answers with UNMASKED account labels and a
      // real hub never serves that to a device. It is also served ABOVE the two
      // fault injectors now, so `--flaky` can no longer break the read this
      // suite asserts on — round 2's R1, which cost about one run in two.
      '--debug-store',
      ...extra
    ],
    SPAWN_OPTIONS
  )
  // BEFORE the URL is awaited: a hub that starts and then never prints one must
  // still be stopped by the teardown, not left for the process table.
  spawned.push(child)

  return { url: await hubUrl(child) }
}

/** The address the hub prints on stdout once it is listening. */
function hubUrl(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake hub never printed a URL')), 20_000)
    const stdout = child.stdout
    if (stdout === null) {
      clearTimeout(timer)
      reject(new Error('the fake hub was started without a stdout pipe'))
      return
    }
    let buffered = ''
    stdout.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => {
      buffered += chunk
      const match = /listening on (http:\/\/\S+)/.exec(buffered)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[1])
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the fake hub exited with ${code}`))
    })
  })
}

const AUTH_HEADERS = {
  'CF-Access-Client-Id': CLIENT_ID,
  'CF-Access-Client-Secret': CLIENT_SECRET
}

async function readStore(hub: FakeHub): Promise<HubStore> {
  const response = await fetch(`${hub.url}/debug/store`, { headers: AUTH_HEADERS })
  if (!response.ok) throw new Error(`/debug/store answered HTTP ${response.status}`)
  return (await response.json()) as HubStore
}

/**
 * Run a body with a client, and stop it whatever happens.
 *
 * The client holds a ten-minute interval and a retry timer; a test that threw
 * before stopping one left both armed against a hub whose process had already
 * been killed, and the next test's failures came with a stranger's stack.
 */
async function withClient(body: (client: UsageHubClient) => Promise<void>): Promise<void> {
  const client = new UsageHubClient()
  try {
    await body(client)
  } finally {
    client.stop()
  }
}

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

function enable(hub: FakeHub): void {
  configureHub({ url: hub.url, deviceName: 'fixture', clientId: CLIENT_ID, enabled: true })
  setHubSecret(CLIENT_SECRET)
}

/**
 * One turn pushed under ANOTHER machine's id, over the real route.
 *
 * `--seed` can preload a peer's buckets, but a bucket carries no label, so a
 * seeded peer's account is registered unnamed — and a name is the whole point
 * of the account list. Ingest is where the hub learns one, so this suite gets
 * its peer the way the hub actually gets one.
 */
async function pushAsPeer(
  hub: FakeHub,
  deviceId: string,
  event: { messageId: string; ts: number; accountKey: string; accountLabel: string | null }
): Promise<void> {
  const response = await fetch(`${hub.url}/v1/events`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 2,
      deviceId,
      deviceName: 'studio',
      appVersion: '3.3.0',
      os: 'darwin',
      events: [
        {
          ...event,
          engineId: 'claude',
          vendorId: 'anthropic',
          modelId: 'claude-opus-5',
          inputTokens: 100,
          outputTokens: 20,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          apiCostUsd: 1,
          billedCostUsd: 0,
          billingType: 'apiKey',
          origin: 'session'
        }
      ]
    })
  })
  if (!response.ok) throw new Error(`the peer push answered HTTP ${response.status}`)
}

beforeEach(() => {
  closeDb()
  resetUsageEventWrittenListeners()
  resetWindowSampleDedup()
})

afterEach(async () => {
  await stopAllFakeHubs()
  closeDb()
  resetUsageEventWrittenListeners()
})

afterAll(async () => {
  await stopAllFakeHubs()
})

describe('the client and the fake hub agree on the wire', () => {
  it('pushes events, then answers a replay as duplicates without changing a bucket', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c', { accountKey: 'unknown' })])
      await client.syncNow()
      expect(client.status().state).toBe('idle')

      let store = await readStore(hub)
      // The unattributed row never leaves the machine (ADR-072 §2).
      expect(store.events.map((event) => event.messageId).sort()).toEqual(['msg-a', 'msg-b'])
      expect(store.buckets).toHaveLength(1)
      expect(store.buckets[0].requestCount).toBe(2)
      expect(store.devices[0]).toMatchObject({ deviceName: 'fixture', os: process.platform })
      expect(store.devices[0].lastPushAt).toBeGreaterThan(0)
      // All three rows are behind the cursor now, the skipped one included.
      expect(getHubConfigRow()?.cursorRowid).toBe(3)

      // Force a replay: the cursor goes back and the same rows are sent again.
      upsertHubConfig({ cursorRowid: 0 })
      await client.syncNow()

      store = await readStore(hub)
      expect(store.events).toHaveLength(2)
      expect(store.buckets[0].requestCount).toBe(2)
      // `accepted + duplicates` still covered the batch, so the cursor moved.
      expect(client.status().state).toBe('idle')
      expect(getHubConfigRow()?.cursorRowid).toBe(3)
    })
  })

  it('pushes limit readings and pulls them back masked', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      // `start()` FIRST, and its own opening pass settled before the reading is
      // written: the queue is filled by the subscription `start()` makes, so a
      // reading written before that is one no push would ever have carried.
      client.start()
      await client.syncNow()
      recordLimitSamples({
        accountKey: 'anthropic:org-a:acct-a',
        accountUuid: 'uuid-a',
        accountLabel: 'someone@example.com',
        vendorId: 'anthropic',
        plan: 'max_20x',
        now: Date.now(),
        windows: [
          {
            kind: '7d',
            usedPercent: 51,
            resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            windowMinutes: 10_080
          }
        ]
      })
      await client.syncNow()

      const store = await readStore(hub)
      expect(store.readings).toHaveLength(1)
      expect(store.readings[0]).toMatchObject({
        accountKey: 'anthropic:org-a:acct-a',
        windowKind: '7d'
      })

      // Read it back as a DEVICE caller: the hub masks the label (ADR-072 §6).
      const relay = await fetch(`${hub.url}/v1/limits?schemaVersion=1`, { headers: AUTH_HEADERS })
      const body = (await relay.json()) as { readings: Array<{ labelMasked: string | null }> }
      expect(body.readings[0].labelMasked).not.toContain('someone@example.com')
      expect(body.readings[0].labelMasked).toContain('•')
    })
  })

  it('reads the machine list a device is allowed to see', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      insertUsageEvents([row('msg-a')])
      await client.syncNow()

      // This machine is the only device the hub knows, and a client keeps its
      // own out of the cache — so the list is empty and the ROUTE still worked.
      expect(client.status().remote.devices).toEqual([])
      const answer = await fetch(`${hub.url}/v1/devices?schemaVersion=1`, { headers: AUTH_HEADERS })
      const body = (await answer.json()) as {
        devices: Array<Record<string, unknown>>
      }
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0]).toMatchObject({
        deviceName: 'fixture',
        os: process.platform,
        retired: false
      })
      // Device-safe: no account label anywhere in the answer.
      expect(JSON.stringify(body)).not.toContain('someone@example.com')
    })
  })

  it('registers a device that has nothing to push, with one empty batch', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      // No ledger rows at all, and a machine whose rows are all `unknown` is in
      // the same position: there is nothing the hub may be told, possibly for
      // days (ADR-072 §2). Without the announce it would never learn the
      // machine exists.
      await client.syncNow()
      expect(client.status().state).toBe('idle')

      const store = await readStore(hub)
      expect(store.events).toHaveLength(0)
      expect(store.devices).toHaveLength(1)
      expect(store.devices[0]).toMatchObject({ deviceName: 'fixture', os: process.platform })
      expect(store.devices[0].lastPushAt).toBeGreaterThan(0)
      expect(getHubConfigRow()?.lastPushAt).not.toBeNull()
    })
  })

  it('refuses a GET that states no schema version', async () => {
    const hub = await startFakeHub()
    const answer = await fetch(`${hub.url}/v1/buckets?since=0`, { headers: AUTH_HEADERS })
    expect(answer.status).toBe(400)
  })

  it('answers 426 on a GET from a newer client', async () => {
    const hub = await startFakeHub()
    const answer = await fetch(`${hub.url}/v1/buckets?schemaVersion=99&since=0`, {
      headers: AUTH_HEADERS
    })
    expect(answer.status).toBe(426)
    expect(await answer.json()).toEqual({ hubSchemaVersion: 2 })
  })

  it('resync makes the hub drop this device rows and the client push them again', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      insertUsageEvents([row('msg-a'), row('msg-b')])
      await client.syncNow()
      const before = await readStore(hub)
      expect(before.events).toHaveLength(2)

      await client.resync()

      const after = await readStore(hub)
      // Deleted and re-pushed: the same two turns, and an epoch that has risen so
      // every other machine drops its cache of this one's buckets.
      expect(after.events).toHaveLength(2)
      expect(after.epoch).toBeGreaterThan(before.epoch)
      expect(getHubConfigRow()?.remoteEpoch).toBe(after.epoch)
      expect(client.status().state).toBe('idle')
    })
  })

  it('reads a wrong secret as a rejected credential, not as a hub answer', async () => {
    const hub = await startFakeHub()
    enable(hub)
    setHubSecret('the-wrong-secret')
    insertUsageEvents([row('msg-a')])

    await withClient(async (client) => {
      await client.syncNow()
      // The fake hub answers a 302 to a `cloudflareaccess.com` address, which is
      // what the spike found a bad service token actually gets.
      expect(client.status().state).toBe('needs-credentials')
      expect(getHubConfigRow()?.cursorRowid).toBe(0)
    })
  })

  it('reads a hub that is behind as update-hub, cursor untouched', async () => {
    const hub = await startFakeHub(['--reject-schema', '0'])
    enable(hub)
    insertUsageEvents([row('msg-a')])

    await withClient(async (client) => {
      await client.syncNow()
      expect(client.status().state).toBe('update-hub')
      expect(getHubConfigRow()?.cursorRowid).toBe(0)
      // The fault injectors cover `/v1/*` and NOTHING else (round-2 R1): they
      // used to run before dispatch, so the route this suite asserts on failed
      // with them and `--flaky` broke about one run in two.
      expect((await readStore(hub)).events).toEqual([])
    })
  })

  it('serves no debug route without --debug-store', async () => {
    // It answers raw events with UNMASKED labels, which ADR-072 §6 forbids a
    // device caller, so a hub that served it by default would model a leak.
    const child = spawn('bun', [SCRIPT, '--port', '0'], SPAWN_OPTIONS)
    spawned.push(child)
    const url = await hubUrl(child)
    expect((await fetch(`${url}/debug/store`)).status).toBe(404)
  })

  it('stores nothing for the window ledger the fake hub does not compute', async () => {
    const hub = await startFakeHub()
    enable(hub)
    await withClient(async (client) => {
      await client.syncNow()
      // The hub's window rollup is H2's work; an empty page must leave the
      // watermark where it was rather than walk for ever.
      expect(getHubConfigRow()?.remoteWindowRev).toBe(0)
      expect(getRemoteUsageBucketsSince(0)).toEqual([])
    })
  })
})

describe('the account list names what nothing else can (S6)', () => {
  it('names a key only another machine has spent on, on the combined dashboard', async () => {
    const hub = await startFakeHub()
    enable(hub)
    const now = Date.now()
    // An API-key account this machine has never held a credential for and never
    // written a ledger row about. Nothing relays a reading for one — an API key
    // has no rate-limit meter — so `GET /v1/accounts` is the only route that
    // can say what it is called.
    const peerKey = 'anthropic:key:zzzz1111zzzz1111'
    await pushAsPeer(hub, 'device-studio', {
      messageId: 'msg-peer',
      ts: now - 60 * 60 * 1000,
      accountKey: peerKey,
      accountLabel: 'partner@example.com'
    })

    await withClient(async (client) => {
      await client.syncNow()

      // Masked on the wire, because this client is a device caller.
      expect(listRemoteAccounts()).toEqual([
        {
          accountKey: peerKey,
          vendorId: 'anthropic',
          labelMasked: 'p•••@e•••.com',
          lastSeenAt: now - 60 * 60 * 1000
        }
      ])

      const data = await buildUsageDashboard({ range: '7d', scope: 'all', now })
      const account = data.providers.flatMap((provider) => provider.accounts)[0]
      expect(account.accountKey).toBe(peerKey)
      // Without the account list this would read `anthropic key`, which every
      // other Anthropic key on the machine would read as too.
      expect(account.label).toBe('p•••@e•••.com')
      expect(account.labelMasked).toBe(true)
    })
  })
})

describe('every attributed row is pushed, however old (ruling 1, S6)', () => {
  it('sends the rows written BEFORE sync was enabled, and no unattributed one', async () => {
    const hub = await startFakeHub()
    // The order is the whole test: three turns are on disk before anything is
    // configured, which is the case the old rule got wrong — it seeded the
    // cursor at MAX(rowid) on the OFF → ON edge, and the owner's first day on
    // the hub lost a morning of one subscription's turns that way (ADR-072 §2,
    // amended 2026-09-22).
    insertUsageEvents([
      // One hour between them, so the two that arrive fold into one bucket.
      row('msg-old-a', { ts: TS - 6 * 60 * 60 * 1000 }),
      row('msg-old-b', { ts: TS - 6 * 60 * 60 * 1000 + 60_000 }),
      row('msg-old-unknown', { ts: TS - 6 * 60 * 60 * 1000 + 120_000, accountKey: 'unknown' })
    ])
    enable(hub)

    await withClient(async (client) => {
      await client.syncNow()

      const store = await readStore(hub)
      // Attribution is the trust boundary, not the enable instant: the two
      // attributed turns arrive and the unattributed one never leaves. Under
      // the old rule this list was empty — the cursor had been seeded past all
      // three before the first pass ran.
      expect(store.events.map((event) => event.messageId).sort()).toEqual([
        'msg-old-a',
        'msg-old-b'
      ])
      expect(store.buckets).toHaveLength(1)
      expect(store.buckets[0].requestCount).toBe(2)
      expect(getHubConfigRow()?.cursorRowid).toBe(3)
    })
  })
})

describe('under injected failures every event still arrives exactly once', () => {
  it('survives --flaky 0.3', async () => {
    const hub = await startFakeHub(['--flaky', '0.3'])
    enable(hub)
    await withClient(async (client) => {
      const rows = Array.from({ length: 40 }, (_, index) => row(`msg-${index}`))
      insertUsageEvents(rows)

      // Pressed syncs rather than the retry timer: real timers in a 60 s test
      // budget cannot walk a 5 s / 15 s / 60 s ladder, and what is under test is
      // the idempotency, not the delays (the unit suite pins those).
      for (let attempt = 0; attempt < 40; attempt++) {
        await client.syncNow()
        if (getHubConfigRow()?.cursorRowid === rows.length) break
      }

      expect(getHubConfigRow()?.cursorRowid).toBe(rows.length)
      const store = await readStore(hub)
      expect(store.events).toHaveLength(rows.length)
      expect(new Set(store.events.map((event) => event.messageId)).size).toBe(rows.length)
      // One hour, one account, one model: 40 turns in exactly one bucket, counted
      // once each however many times a batch was re-sent.
      expect(store.buckets).toHaveLength(1)
      expect(store.buckets[0].requestCount).toBe(rows.length)
    })
  })
})
