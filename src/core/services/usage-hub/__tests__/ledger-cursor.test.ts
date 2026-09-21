/**
 * @vitest-environment node
 *
 * The outbox: a rowid cursor over `usage_event`, the notifier that says a row
 * landed, and the config row the cursor lives in (ADR-072 §2, §7).
 *
 * The cases that matter are the ones a `ts` cursor would get wrong. The
 * reconciler backfills turns from transcripts every ten minutes, so a row
 * written NOW can carry yesterday's timestamp — and `ORDER BY ts` would have
 * walked straight past it. The rowid is the only monotonic column, and the
 * backfill test below is the reason the cursor is one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  closeDb,
  countUsageEventsAfterRowid,
  getHubConfigRow,
  insertUsageEvent,
  insertUsageEvents,
  maxUsageEventRowid,
  oldestUsageEventTs,
  onUsageEventWritten,
  readUsageEventsAfterRowid,
  resetUsageEventWrittenListeners,
  upsertHubConfig,
  type UsageEventInsert
} from '../../db'
import {
  HubUrlError,
  configureHub,
  forgetHub,
  getHubConfig,
  sanitizeHubConfigureInput,
  sanitizeHubSecret,
  sanitizeHubUrl,
  setHubSecret
} from '../config'
import { nextEventBatch, pendingEventCount } from '../ledger-cursor'
import { usageHubCommands } from '../../../ipc/usage-hub-commands'

beforeEach(() => {
  closeDb()
  resetUsageEventWrittenListeners()
})
afterEach(() => {
  closeDb()
  resetUsageEventWrittenListeners()
})

const TS = 1_758_412_800_000

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

describe('the cursor starts where sync was enabled', () => {
  it('enabling sets the cursor to MAX(rowid), so nothing older is ever pushed', () => {
    insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c')])
    expect(maxUsageEventRowid()).toBe(3)

    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })

    expect(getHubConfig().cursorRowid).toBe(3)
    expect(pendingEventCount(getHubConfig().cursorRowid)).toBe(0)
  })

  it('a re-save on an already-enabled hub does not skip what is unpushed', () => {
    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })
    insertUsageEvents([row('msg-a'), row('msg-b')])

    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'renamed',
      clientId: 'client-a',
      enabled: true
    })

    // Still 0: the two rows written since are still waiting.
    expect(getHubConfig().cursorRowid).toBe(0)
    expect(pendingEventCount(0)).toBe(2)
  })

  it('an empty ledger enables at cursor 0', () => {
    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })
    expect(getHubConfig().cursorRowid).toBe(0)
  })
})

describe('the batch', () => {
  it('reads the rows past the cursor and reports where it lands', () => {
    insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c')])
    const batch = nextEventBatch(1, 10)
    expect(batch.events.map((event) => event.messageId)).toEqual(['msg-b', 'msg-c'])
    expect(batch.nextCursor).toBe(3)
    expect(batch.rowsRead).toBe(2)
    expect(batch.full).toBe(false)
  })

  it('pushes a row once — a second read past the cursor sees nothing', () => {
    insertUsageEvent(row('msg-a'))
    const first = nextEventBatch(0, 10)
    expect(first.events).toHaveLength(1)
    expect(nextEventBatch(first.nextCursor, 10).events).toHaveLength(0)
  })

  it('a duplicate message id inserts no second row, so nothing is pushed twice', () => {
    insertUsageEvent(row('msg-a'))
    insertUsageEvent(row('msg-a', { id: 'id-other' }))
    expect(maxUsageEventRowid()).toBe(1)
    expect(nextEventBatch(0, 10).events).toHaveLength(1)
  })

  it('skips `unknown` rows and still advances the cursor past them', () => {
    insertUsageEvents([
      row('msg-a', { accountKey: 'unknown' }),
      row('msg-b', { accountKey: 'unknown' }),
      row('msg-c')
    ])
    const batch = nextEventBatch(0, 10)
    expect(batch.events.map((event) => event.messageId)).toEqual(['msg-c'])
    expect(batch.rowsRead).toBe(3)
    expect(batch.nextCursor).toBe(3)
  })

  it('a batch of nothing but `unknown` rows still moves the cursor', () => {
    insertUsageEvents([row('msg-a', { accountKey: 'unknown' })])
    const batch = nextEventBatch(0, 10)
    expect(batch.events).toHaveLength(0)
    expect(batch.nextCursor).toBe(1)
  })

  it('pushes a BACKFILLED row whose ts is old but whose rowid is new', () => {
    // This is the whole reason the cursor is a rowid. The reconciler writes
    // yesterday's turn today; a `ts` cursor sitting at "now" would never see it.
    insertUsageEvent(row('msg-live', { ts: TS }))
    const cursor = nextEventBatch(0, 10).nextCursor
    insertUsageEvent(row('msg-backfilled', { ts: TS - 48 * 60 * 60 * 1000, source: 'backfill' }))

    const batch = nextEventBatch(cursor, 10)
    expect(batch.events.map((event) => event.messageId)).toEqual(['msg-backfilled'])
    expect(batch.events[0].ts).toBeLessThan(TS)
  })

  it('reports a full batch so the push loop knows to come back', () => {
    insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c')])
    const batch = nextEventBatch(0, 2)
    expect(batch.rowsRead).toBe(2)
    expect(batch.full).toBe(true)
  })

  it('the pending count excludes `unknown`, which is never pushable', () => {
    insertUsageEvents([row('msg-a'), row('msg-b', { accountKey: 'unknown' }), row('msg-c')])
    expect(countUsageEventsAfterRowid(0)).toBe(2)
  })

  it('readUsageEventsAfterRowid RETURNS unknown rows — the cursor must pass them', () => {
    insertUsageEvents([row('msg-a', { accountKey: 'unknown' })])
    expect(readUsageEventsAfterRowid(0, 10)).toHaveLength(1)
  })

  it('names the oldest row for a resync, and null for an empty ledger', () => {
    expect(oldestUsageEventTs()).toBeNull()
    insertUsageEvents([row('msg-a', { ts: TS }), row('msg-b', { ts: TS - 1_000 })])
    expect(oldestUsageEventTs()).toBe(TS - 1_000)
  })
})

describe('the row-written notifier', () => {
  it('fires once for a batch that inserted one row', () => {
    const listener = vi.fn()
    onUsageEventWritten(listener)
    insertUsageEvents([row('msg-a')])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fires ONCE for a batch of many, not once per row', () => {
    const listener = vi.fn()
    onUsageEventWritten(listener)
    insertUsageEvents([row('msg-a'), row('msg-b'), row('msg-c')])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire when every row was a duplicate', () => {
    insertUsageEvents([row('msg-a'), row('msg-b')])
    const listener = vi.fn()
    onUsageEventWritten(listener)
    insertUsageEvents([row('msg-a'), row('msg-b')])
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires for a batch that was PART duplicate', () => {
    insertUsageEvent(row('msg-a'))
    const listener = vi.fn()
    onUsageEventWritten(listener)
    insertUsageEvents([row('msg-a'), row('msg-b')])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a single insert fires, and a duplicate single insert does not', () => {
    const listener = vi.fn()
    onUsageEventWritten(listener)
    insertUsageEvent(row('msg-a'))
    insertUsageEvent(row('msg-a', { id: 'id-other' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a listener that throws does not fail the write', () => {
    onUsageEventWritten(() => {
      throw new Error('subscriber is broken')
    })
    expect(() => insertUsageEvent(row('msg-a'))).not.toThrow()
    expect(maxUsageEventRowid()).toBe(1)
  })

  it('unsubscribes', () => {
    const listener = vi.fn()
    const off = onUsageEventWritten(listener)
    off()
    insertUsageEvent(row('msg-a'))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the device credential never comes back out', () => {
  it('getHubConfig() has no clientSecret property at all', () => {
    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })
    setHubSecret('a-service-token-secret')

    const view = getHubConfig()
    expect(Object.keys(view)).not.toContain('clientSecret')
    expect(JSON.stringify(view)).not.toContain('a-service-token-secret')
    expect(view.hasSecret).toBe(true)
  })

  it('an empty secret clears the stored one', () => {
    setHubSecret('a-service-token-secret')
    expect(getHubConfig().hasSecret).toBe(true)
    setHubSecret('')
    expect(getHubConfig().hasSecret).toBe(false)
  })

  it('forgetHub() leaves no row and no remote data', () => {
    configureHub({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })
    setHubSecret('a-service-token-secret')
    upsertHubConfig({ remoteEpoch: 7, remoteRev: 12 })

    forgetHub()

    expect(getHubConfigRow()).toBeNull()
    const view = getHubConfig()
    expect(view.enabled).toBe(false)
    expect(view.hasSecret).toBe(false)
    expect(view.remoteEpoch).toBeNull()
    expect(view.url).toBe('')
  })
})

describe('the perimeter sanitises what arrives from the wire', () => {
  it('accepts an https origin and strips a trailing slash', () => {
    expect(sanitizeHubUrl('https://hub.example.com/')).toBe('https://hub.example.com')
    expect(sanitizeHubUrl('  https://hub.example.com  ')).toBe('https://hub.example.com')
  })

  it('accepts http only on loopback — the fake hub and a wrangler dev run', () => {
    expect(sanitizeHubUrl('http://localhost:8787')).toBe('http://localhost:8787')
    expect(sanitizeHubUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(() => sanitizeHubUrl('http://hub.example.com')).toThrow(HubUrlError)
  })

  it('refuses credentials in the URL — they would reach every log line', () => {
    expect(() => sanitizeHubUrl('https://id:secret@hub.example.com')).toThrow(HubUrlError)
  })

  it('refuses a path, a query or a fragment', () => {
    expect(() => sanitizeHubUrl('https://hub.example.com/v1')).toThrow(HubUrlError)
    expect(() => sanitizeHubUrl('https://hub.example.com?a=1')).toThrow(HubUrlError)
    expect(() => sanitizeHubUrl('https://hub.example.com#x')).toThrow(HubUrlError)
  })

  it('refuses anything that is not a URL, and anything that is not a string', () => {
    expect(() => sanitizeHubUrl('not a url')).toThrow(HubUrlError)
    expect(() => sanitizeHubUrl('')).toThrow(HubUrlError)
    expect(() => sanitizeHubUrl(42)).toThrow(HubUrlError)
    expect(() => sanitizeHubUrl(null)).toThrow(HubUrlError)
  })

  it('bounds the device name and the client id, and reads enabled strictly', () => {
    const input = sanitizeHubConfigureInput({
      url: 'https://hub.example.com',
      deviceName: ` ${'n'.repeat(500)} `,
      clientId: ' client-a ',
      enabled: 'yes'
    })
    expect(input.deviceName).toHaveLength(200)
    expect(input.clientId).toBe('client-a')
    // Only a real `true` enables sync.
    expect(input.enabled).toBe(false)
  })

  it('refuses a payload that is not an object', () => {
    expect(() => sanitizeHubConfigureInput(null)).toThrow(HubUrlError)
    expect(() => sanitizeHubConfigureInput([])).toThrow(HubUrlError)
  })

  /**
   * The rule `configureHub` already applied to the stored row, applied HERE as
   * well. It was only half wired: the sanitiser validated the URL before the
   * switch was consulted, so the settings group could not clear the address and
   * save with sync off — the one payload the rule exists to allow.
   */
  it('accepts a blank URL while sync is off, and refuses one while it is on', () => {
    expect(sanitizeHubConfigureInput({ url: '', deviceName: 'n', clientId: 'c' }).url).toBe('')
    expect(sanitizeHubConfigureInput({ url: '   ', enabled: false }).url).toBe('')
    // A missing key is the same case as an empty one.
    expect(sanitizeHubConfigureInput({ enabled: false }).url).toBe('')
    expect(() => sanitizeHubConfigureInput({ url: '', enabled: true })).toThrow(HubUrlError)
    // Blank means absent or whitespace, nothing else: junk is still refused, so
    // a malformed payload can never read as "clear the address".
    expect(() => sanitizeHubConfigureInput({ url: 42, enabled: false })).toThrow(HubUrlError)
    expect(() => sanitizeHubConfigureInput({ url: {}, enabled: false })).toThrow(HubUrlError)
    // And a URL that IS offered is validated whatever the switch says.
    expect(() =>
      sanitizeHubConfigureInput({ url: 'http://hub.example.com', enabled: false })
    ).toThrow(HubUrlError)
  })

  it('bounds the secret and refuses a non-string', () => {
    expect(sanitizeHubSecret('  abc  ')).toBe('abc')
    expect(sanitizeHubSecret('')).toBe('')
    expect(() => sanitizeHubSecret('x'.repeat(513))).toThrow(HubUrlError)
    expect(() => sanitizeHubSecret(undefined)).toThrow(HubUrlError)
  })
})

describe('the channel surface', () => {
  it('declares six channels, all `config`, with set-secret a command', () => {
    const commands = usageHubCommands()
    expect(commands.map((command) => command.channel)).toEqual([
      'usage-hub:status',
      'usage-hub:configure',
      'usage-hub:set-secret',
      'usage-hub:sync-now',
      'usage-hub:resync',
      'usage-hub:forget'
    ])
    expect(commands.every((command) => command.capability === 'config')).toBe(true)
    expect(commands.find((c) => c.channel === 'usage-hub:status')?.kind).toBe('query')
    expect(commands.find((c) => c.channel === 'usage-hub:set-secret')?.kind).toBe('command')
  })

  it('no answer over the channel layer carries the device secret', async () => {
    const commands = usageHubCommands()
    const call = async (channel: string, arg?: unknown): Promise<unknown> => {
      const command = commands.find((c) => c.channel === channel)
      if (!command) throw new Error(`no such channel: ${channel}`)
      return command.handler(arg)
    }

    await call('usage-hub:configure', {
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: false
    })
    const secret = 'a-service-token-secret'
    const afterSecret = await call('usage-hub:set-secret', secret)
    const status = await call('usage-hub:status')

    for (const answer of [afterSecret, status]) {
      expect(JSON.stringify(answer)).not.toContain(secret)
    }
    expect(status).toMatchObject({ hasSecret: true, url: 'https://hub.example.com' })

    // And `forget` really does leave nothing.
    const forgotten = (await call('usage-hub:forget')) as { hasSecret: boolean; url: string }
    expect(forgotten.hasSecret).toBe(false)
    expect(forgotten.url).toBe('')
    expect(getHubConfigRow()).toBeNull()
  })

  it('lets a caller clear the URL and turn sync off in one write', async () => {
    const configure = usageHubCommands().find((c) => c.channel === 'usage-hub:configure')!
    await configure.handler({
      url: 'https://hub.example.com',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: true
    })
    // What the settings group sends when the URL field has been cleared and the
    // switch turned off. It used to be refused at the perimeter.
    const status = (await configure.handler({
      url: '',
      deviceName: 'workshop',
      clientId: 'client-a',
      enabled: false
    })) as { url: string; enabled: boolean }
    expect(status).toMatchObject({ url: '', enabled: false })
    expect(getHubConfigRow()).toMatchObject({ url: '', enabled: false })
  })

  it('refuses a hub URL the perimeter does not accept, and stores nothing', async () => {
    const configure = usageHubCommands().find((c) => c.channel === 'usage-hub:configure')!
    await expect(
      configure.handler({
        url: 'http://hub.example.com',
        deviceName: 'x',
        clientId: 'y',
        enabled: true
      })
    ).rejects.toThrow(HubUrlError)
    expect(getHubConfigRow()).toBeNull()
  })
})
