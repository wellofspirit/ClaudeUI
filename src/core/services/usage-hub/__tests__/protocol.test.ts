/**
 * @vitest-environment node
 *
 * The usage hub protocol's contract (ADR-072 §8).
 *
 * Two guarantees, and the hub repository will run the same two against its own
 * implementation once it exists:
 *
 * 1. **Replay.** Every golden fixture parses into its type and re-encodes to the
 *    same bytes. A field renamed on either side of the wire stops being a silent
 *    `undefined` and becomes a failing assertion here.
 * 2. **The privacy boundary.** ADR-072 §5's "never sent" list is enforced by the
 *    ENCODER, not by the discipline of every caller upstream of it. A ledger row
 *    carries a `sessionId` and a `parentRoutingId`, so the day someone spreads a
 *    row into a payload this is the thing that notices.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ProtocolError,
  decodePullBucketsResponse,
  decodePullDevicesResponse,
  decodePullLimitsResponse,
  decodePullWindowsResponse,
  decodePushEventsResponse,
  decodePushLimitsResponse,
  decodeResyncResponse,
  decodeSchemaTooNew,
  encodeEvent,
  encodePullBucketsQuery,
  encodePullDevicesQuery,
  encodePullWindowsQuery,
  encodePushEvents,
  encodePushLimits,
  encodeResync,
  serialize
} from '../protocol/codec'
import {
  ALLOWED_EVENT_FIELDS,
  FORBIDDEN_EVENT_FIELDS,
  MAX_EVENTS_PER_PUSH,
  SCHEMA_VERSION
} from '../protocol/types'

const FIXTURES = path.join(__dirname, '..', 'protocol', 'fixtures')

function readFixture(name: string): { text: string; parsed: Record<string, unknown> } {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf-8')
  return { text, parsed: JSON.parse(text) as Record<string, unknown> }
}

/** Fixture → the round trip that must reproduce it byte for byte. */
const REPLAYS: Array<[string, (parsed: Record<string, unknown>) => unknown]> = [
  [
    'events-request.json',
    (p) =>
      encodePushEvents({
        deviceId: p.deviceId as string,
        deviceName: p.deviceName as string,
        appVersion: p.appVersion as string,
        os: p.os as string,
        events: p.events as unknown[]
      })
  ],
  [
    // The announce: an events push with an empty batch, which is how a device
    // that has nothing to send tells the hub it exists (ADR-072 §7).
    'events-announce-request.json',
    (p) =>
      encodePushEvents({
        deviceId: p.deviceId as string,
        deviceName: p.deviceName as string,
        appVersion: p.appVersion as string,
        os: p.os as string,
        events: p.events as unknown[]
      })
  ],
  ['events-response.json', decodePushEventsResponse],
  [
    'limits-push-request.json',
    (p) => encodePushLimits({ deviceId: p.deviceId as string, readings: p.readings as unknown[] })
  ],
  ['limits-push-response.json', decodePushLimitsResponse],
  [
    'buckets-query.json',
    (p) =>
      encodePullBucketsQuery({ since: p.since as number, excludeDevice: p.excludeDevice as string })
  ],
  ['buckets-response.json', decodePullBucketsResponse],
  ['windows-query.json', (p) => encodePullWindowsQuery({ since: p.since as number })],
  ['windows-response.json', decodePullWindowsResponse],
  ['devices-query.json', encodePullDevicesQuery],
  ['devices-response.json', decodePullDevicesResponse],
  ['limits-response.json', decodePullLimitsResponse],
  [
    'resync-request.json',
    (p) => encodeResync({ deviceId: p.deviceId as string, since: p.since as number })
  ],
  ['resync-response.json', decodeResyncResponse],
  ['error-schema-too-new.json', decodeSchemaTooNew]
]

describe('the fixtures are the contract', () => {
  it('every fixture file is covered by a replay', () => {
    const onDisk = fs
      .readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.json'))
      .sort()
    expect(onDisk).toEqual(REPLAYS.map(([name]) => name).sort())
  })

  for (const [name, roundTrip] of REPLAYS) {
    it(`${name} re-encodes byte-identically`, () => {
      const { text, parsed } = readFixture(name)
      expect(serialize(roundTrip(parsed))).toBe(text)
    })
  }

  it('EVERY request fixture states the schema version, the GETs included', () => {
    // A GET carries it as a query parameter and a POST in its body, and every
    // route may answer 426 (ADR-072 §8): a hub that validated only the writes
    // would hand back a response shape the client cannot parse.
    for (const name of REPLAYS.map(([fixture]) => fixture)) {
      if (!name.includes('request') && !name.includes('query')) continue
      expect(readFixture(name).parsed.schemaVersion).toBe(SCHEMA_VERSION)
    }
  })
})

describe('the encoder is the privacy boundary (ADR-072 §5)', () => {
  const event = () => ({
    messageId: 'msg_test',
    ts: 1_758_412_800_000,
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 2,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    apiCostUsd: 0.01,
    billedCostUsd: 0,
    billingType: 'subscription',
    origin: 'session',
    accountKey: 'anthropic:org-a:acct-a',
    accountLabel: 'someone@example.com'
  })

  it('accepts exactly the allowed fields, in canonical order', () => {
    expect(Object.keys(encodeEvent(event()))).toEqual([...ALLOWED_EVENT_FIELDS])
  })

  for (const forbidden of FORBIDDEN_EVENT_FIELDS) {
    it(`refuses a payload carrying "${forbidden}"`, () => {
      expect(() => encodeEvent({ ...event(), [forbidden]: 'anything' })).toThrow(ProtocolError)
    })
  }

  it('refuses a whole ledger row, because a row carries a session id', () => {
    // The shape `rowToUsageEvent` produces. Spreading it into a payload is the
    // mistake this check exists for.
    const row = { ...event(), sessionId: 'sess-1', parentRoutingId: null, source: 'live' }
    expect(() => encodeEvent(row)).toThrow(/sessionId/)
  })

  it('refuses an unattributed row — the hub starts with clean data', () => {
    expect(() => encodeEvent({ ...event(), accountKey: 'unknown' })).toThrow(ProtocolError)
  })

  it('refuses a row that is missing a required field', () => {
    const partial: Record<string, unknown> = event()
    delete partial.billingType
    expect(() => encodeEvent(partial)).toThrow(/billingType/)
  })

  it('refuses a batch over the 500-event cap', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_PUSH + 1 }, (_, i) => ({
      ...event(),
      messageId: `msg_${i}`
    }))
    expect(() =>
      encodePushEvents({
        deviceId: 'device-a',
        deviceName: 'workshop',
        appVersion: '3.3.0',
        os: 'linux',
        events
      })
    ).toThrow(ProtocolError)
  })

  it('keeps an unknown cost null rather than making it zero (ADR-030)', () => {
    const encoded = encodeEvent({ ...event(), apiCostUsd: null, billedCostUsd: Number.NaN })
    expect(encoded.apiCostUsd).toBeNull()
    expect(encoded.billedCostUsd).toBeNull()
  })
})

describe('decoding is defensive', () => {
  it('drops a bucket with no device or no account rather than the whole page', () => {
    const answer = decodePullBucketsResponse({
      epoch: 2,
      rev: 9,
      buckets: [
        { deviceId: '', accountKey: 'a' },
        { deviceId: 'd', accountKey: '' },
        'not an object',
        { deviceId: 'd', accountKey: 'a', hourUtc: 1, rev: 9 }
      ]
    })
    expect(answer.buckets).toHaveLength(1)
    expect(answer.buckets[0]).toMatchObject({ deviceId: 'd', accountKey: 'a', rev: 9 })
  })

  it('answers zeros, never NaN, for a field the hub omitted', () => {
    const answer = decodePullBucketsResponse({ buckets: [{ deviceId: 'd', accountKey: 'a' }] })
    expect(answer.epoch).toBe(0)
    expect(answer.buckets[0].requestCount).toBe(0)
    expect(answer.buckets[0].apiCostUsd).toBe(0)
  })

  it('throws on an answer that is not an object at all', () => {
    expect(() => decodePullWindowsResponse('<html>login</html>')).toThrow(ProtocolError)
    expect(() => decodePullLimitsResponse(null)).toThrow(ProtocolError)
  })

  it('reads a 426 body, and tolerates one that says nothing', () => {
    expect(decodeSchemaTooNew({ hubSchemaVersion: 1 })).toEqual({ hubSchemaVersion: 1 })
    expect(decodeSchemaTooNew({})).toBeNull()
    expect(decodeSchemaTooNew('nope')).toBeNull()
  })
})
