/**
 * The usage hub protocol's encoder and decoder (ADR-072 §8).
 *
 * Moves to the hub repository with `types.ts` and the fixtures, so it imports
 * nothing but them.
 *
 * ## Why an encoder at all, rather than `JSON.stringify(row)`
 *
 * Two jobs, and only one of them is serialisation.
 *
 * 1. **The privacy boundary is enforced here.** A ledger row carries a
 *    `sessionId` and a `parentRoutingId`; an event may not. Mapping by an
 *    explicit allow-list, and refusing a payload that carries a forbidden key,
 *    means ADR-072 §5 is checked at the boundary instead of trusted at every
 *    call site upstream of it.
 * 2. **Field order is fixed**, so a request or response and its golden fixture
 *    are byte-identical. That is what makes the fixtures a contract test the hub
 *    repository can run unchanged: a field renamed on either side stops being a
 *    silent `undefined` and becomes a failing replay.
 *
 * ## Decoding is defensive, never trusting
 *
 * A pull answer is a remote input. Every decoder coerces field by field, drops
 * an element it cannot read rather than throwing the page away, and never lets a
 * missing number become `NaN` downstream.
 */

import {
  ALLOWED_EVENT_FIELDS,
  FORBIDDEN_EVENT_FIELDS,
  MAX_EVENTS_PER_PUSH,
  SCHEMA_VERSION,
  type HubEvent,
  type HubLimitReading,
  type HubDevice,
  type PullBucketsQuery,
  type PullBucketsResponse,
  type PullDevicesQuery,
  type PullDevicesResponse,
  type PullLimitsResponse,
  type PullWindowsQuery,
  type PullWindowsResponse,
  type PushEventsRequest,
  type PushEventsResponse,
  type PushLimitsRequest,
  type PushLimitsResponse,
  type RemoteBucket,
  type RemoteLimitReading,
  type RemoteWindow,
  type ResyncRequest,
  type ResyncResponse,
  type SchemaTooNewResponse
} from './types'

/** A payload this build refuses to send, or an answer it refuses to read. */
export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A finite number, or null. Keeps ADR-030's "unknown is not zero" on the wire. */
function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function bool(value: unknown): boolean {
  return value === true || value === 1
}

/**
 * The canonical serialisation: two-space JSON with a trailing newline.
 *
 * It is what the fixtures on disk hold, so `serialize(decode(read(fixture)))`
 * equals the file's bytes. The wire itself does not care about whitespace — the
 * replay test does, and it is the only mechanism keeping two repositories'
 * shapes honest.
 */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Events: POST /v1/events
// ---------------------------------------------------------------------------

/**
 * Map one row-shaped object to a wire event, in canonical field order.
 *
 * Refuses, rather than strips, a source object carrying a forbidden key: a
 * mapper that quietly dropped `sessionId` would keep working the day someone
 * renamed it to `session`, and nothing would notice.
 */
export function encodeEvent(source: unknown): HubEvent {
  if (!isRecord(source)) throw new ProtocolError('event is not an object')
  for (const forbidden of FORBIDDEN_EVENT_FIELDS) {
    if (forbidden in source) {
      throw new ProtocolError(`event carries the forbidden field "${forbidden}"`)
    }
  }
  for (const field of ALLOWED_EVENT_FIELDS) {
    if (!(field in source)) throw new ProtocolError(`event is missing "${field}"`)
  }
  const accountKey = str(source.accountKey)
  if (accountKey === '') throw new ProtocolError('event has no account key')
  if (accountKey === 'unknown') {
    // ADR-072 §2: the hub starts with clean data, so an unattributed row never
    // leaves the machine. The caller filters these out; this is the backstop.
    throw new ProtocolError('an unattributed event may not be pushed')
  }
  return {
    messageId: str(source.messageId),
    ts: num(source.ts),
    engineId: str(source.engineId),
    vendorId: str(source.vendorId),
    modelId: str(source.modelId),
    inputTokens: num(source.inputTokens),
    outputTokens: num(source.outputTokens),
    cacheWriteTokens: num(source.cacheWriteTokens),
    cacheWrite1hTokens: num(source.cacheWrite1hTokens),
    cacheReadTokens: num(source.cacheReadTokens),
    apiCostUsd: nullableNum(source.apiCostUsd),
    billedCostUsd: nullableNum(source.billedCostUsd),
    billingType: str(source.billingType, 'unknown'),
    origin: str(source.origin, 'session'),
    accountKey,
    accountLabel: nullableStr(source.accountLabel)
  }
}

export function encodePushEvents(input: {
  deviceId: string
  deviceName: string
  appVersion: string
  os: string
  events: ReadonlyArray<unknown>
}): PushEventsRequest {
  if (input.events.length > MAX_EVENTS_PER_PUSH) {
    throw new ProtocolError(`a push may carry at most ${MAX_EVENTS_PER_PUSH} events`)
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    appVersion: input.appVersion,
    os: input.os,
    events: input.events.map(encodeEvent)
  }
}

export function decodePushEventsResponse(payload: unknown): PushEventsResponse {
  if (!isRecord(payload)) throw new ProtocolError('events response is not an object')
  return {
    accepted: num(payload.accepted),
    duplicates: num(payload.duplicates),
    epoch: num(payload.epoch)
  }
}

// ---------------------------------------------------------------------------
// Limit readings: POST /v1/limits
// ---------------------------------------------------------------------------

export function encodeLimitReading(source: unknown): HubLimitReading {
  if (!isRecord(source)) throw new ProtocolError('reading is not an object')
  const accountKey = str(source.accountKey)
  if (accountKey === '' || accountKey === 'unknown') {
    throw new ProtocolError('a reading with no account key may not be pushed')
  }
  return {
    accountKey,
    accountLabel: nullableStr(source.accountLabel),
    vendorId: str(source.vendorId),
    plan: nullableStr(source.plan),
    windowKind: str(source.windowKind),
    windowMinutes: nullableNum(source.windowMinutes),
    label: str(source.label),
    usedPercent: num(source.usedPercent),
    resetsAt: nullableStr(source.resetsAt),
    observedAt: num(source.observedAt)
  }
}

export function encodePushLimits(input: {
  deviceId: string
  readings: ReadonlyArray<unknown>
}): PushLimitsRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: input.deviceId,
    readings: input.readings.map(encodeLimitReading)
  }
}

export function decodePushLimitsResponse(payload: unknown): PushLimitsResponse {
  if (!isRecord(payload)) throw new ProtocolError('limits response is not an object')
  return { accepted: num(payload.accepted), epoch: num(payload.epoch) }
}

// ---------------------------------------------------------------------------
// Buckets: GET /v1/buckets
// ---------------------------------------------------------------------------

function decodeBucket(source: unknown): RemoteBucket | null {
  if (!isRecord(source)) return null
  const deviceId = str(source.deviceId)
  const accountKey = str(source.accountKey)
  // A bucket with no owner or no account is unusable: both are primary-key
  // columns locally, and a blank one would collide with the next blank one.
  if (deviceId === '' || accountKey === '') return null
  return {
    deviceId,
    rev: num(source.rev),
    hourUtc: num(source.hourUtc),
    accountKey,
    billingType: str(source.billingType, 'unknown'),
    engineId: str(source.engineId),
    vendorId: str(source.vendorId),
    modelId: str(source.modelId),
    origin: str(source.origin, 'session'),
    inputTokens: num(source.inputTokens),
    outputTokens: num(source.outputTokens),
    cacheWriteTokens: num(source.cacheWriteTokens),
    cacheWrite1hTokens: num(source.cacheWrite1hTokens),
    cacheReadTokens: num(source.cacheReadTokens),
    apiCostUsd: num(source.apiCostUsd),
    billedCostUsd: num(source.billedCostUsd),
    unbilledApiCostUsd: num(source.unbilledApiCostUsd),
    unknownApiCostCount: num(source.unknownApiCostCount),
    unknownBilledCostCount: num(source.unknownBilledCostCount),
    requestCount: num(source.requestCount),
    source: str(source.source, 'rollup')
  }
}

/**
 * The buckets query, in canonical order.
 *
 * `excludeDevice` is the caller's own id and is not optional: the hub leaves the
 * calling device's rows out of the answer, because they are already in the local
 * `usage_bucket` and holding the hub's copy too would double every total.
 */
export function encodePullBucketsQuery(input: {
  since: number
  excludeDevice: string
}): PullBucketsQuery {
  return {
    schemaVersion: SCHEMA_VERSION,
    since: num(input.since),
    excludeDevice: input.excludeDevice
  }
}

export function decodePullBucketsResponse(payload: unknown): PullBucketsResponse {
  if (!isRecord(payload)) throw new ProtocolError('buckets response is not an object')
  const raw = Array.isArray(payload.buckets) ? payload.buckets : []
  const buckets = raw.map(decodeBucket).filter((bucket): bucket is RemoteBucket => bucket !== null)
  return { epoch: num(payload.epoch), rev: num(payload.rev), buckets }
}

// ---------------------------------------------------------------------------
// Windows: GET /v1/windows
// ---------------------------------------------------------------------------

function decodeWindow(source: unknown): RemoteWindow | null {
  if (!isRecord(source)) return null
  const deviceId = str(source.deviceId)
  const accountKey = str(source.accountKey)
  const windowKind = str(source.windowKind)
  if (deviceId === '' || accountKey === '' || windowKind === '') return null
  return {
    deviceId,
    accountKey,
    windowKind,
    canonicalEnd: num(source.canonicalEnd),
    windowStart: num(source.windowStart),
    windowMinutes: nullableNum(source.windowMinutes),
    peakPercent: num(source.peakPercent),
    apiCostUsd: num(source.apiCostUsd),
    billedCostUsd: num(source.billedCostUsd),
    unknownCostCount: num(source.unknownCostCount),
    inputTokens: num(source.inputTokens),
    outputTokens: num(source.outputTokens),
    cacheWriteTokens: num(source.cacheWriteTokens),
    cacheReadTokens: num(source.cacheReadTokens),
    sampleCount: num(source.sampleCount),
    closed: bool(source.closed),
    updatedAt: num(source.updatedAt),
    rev: num(source.rev)
  }
}

/** The windows query: everything past the hub revision `since`. */
export function encodePullWindowsQuery(input: { since: number }): PullWindowsQuery {
  return { schemaVersion: SCHEMA_VERSION, since: num(input.since) }
}

export function decodePullWindowsResponse(payload: unknown): PullWindowsResponse {
  if (!isRecord(payload)) throw new ProtocolError('windows response is not an object')
  const raw = Array.isArray(payload.windows) ? payload.windows : []
  const windows = raw.map(decodeWindow).filter((window): window is RemoteWindow => window !== null)
  return { epoch: num(payload.epoch), rev: num(payload.rev), windows }
}

// ---------------------------------------------------------------------------
// Limit relay: GET /v1/limits
// ---------------------------------------------------------------------------

function decodeLimitReading(source: unknown): RemoteLimitReading | null {
  if (!isRecord(source)) return null
  const accountKey = str(source.accountKey)
  const windowKind = str(source.windowKind)
  if (accountKey === '' || windowKind === '') return null
  return {
    deviceId: str(source.deviceId),
    accountKey,
    windowKind,
    labelMasked: nullableStr(source.labelMasked),
    vendorId: str(source.vendorId),
    plan: nullableStr(source.plan),
    windowMinutes: nullableNum(source.windowMinutes),
    usedPercent: num(source.usedPercent),
    resetsAt: nullableStr(source.resetsAt),
    observedAt: num(source.observedAt)
  }
}

export function decodePullLimitsResponse(payload: unknown): PullLimitsResponse {
  if (!isRecord(payload)) throw new ProtocolError('limit relay response is not an object')
  const raw = Array.isArray(payload.readings) ? payload.readings : []
  const readings = raw
    .map(decodeLimitReading)
    .filter((reading): reading is RemoteLimitReading => reading !== null)
  return { epoch: num(payload.epoch), readings }
}

// ---------------------------------------------------------------------------
// Devices: GET /v1/devices
// ---------------------------------------------------------------------------

export function encodePullDevicesQuery(): PullDevicesQuery {
  return { schemaVersion: SCHEMA_VERSION }
}

function decodeDevice(source: unknown): HubDevice | null {
  if (!isRecord(source)) return null
  const deviceId = str(source.deviceId)
  if (deviceId === '') return null
  return {
    deviceId,
    // A device the hub has never been told a name for is named by its id, not by
    // an empty string a surface would render as a blank row.
    deviceName: str(source.deviceName) === '' ? deviceId : str(source.deviceName),
    os: str(source.os, 'unknown'),
    appVersion: str(source.appVersion, 'unknown'),
    lastPushAt: num(source.lastPushAt),
    retired: bool(source.retired)
  }
}

export function decodePullDevicesResponse(payload: unknown): PullDevicesResponse {
  if (!isRecord(payload)) throw new ProtocolError('devices response is not an object')
  const raw = Array.isArray(payload.devices) ? payload.devices : []
  const devices = raw.map(decodeDevice).filter((device): device is HubDevice => device !== null)
  return { epoch: num(payload.epoch), devices }
}

// ---------------------------------------------------------------------------
// Resync: POST /v1/devices/self/resync
// ---------------------------------------------------------------------------

export function encodeResync(input: { deviceId: string; since: number }): ResyncRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: input.deviceId,
    since: num(input.since)
  }
}

export function decodeResyncResponse(payload: unknown): ResyncResponse {
  if (!isRecord(payload)) throw new ProtocolError('resync response is not an object')
  return { deleted: num(payload.deleted), epoch: num(payload.epoch) }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The hub's version out of a `426` body, or null when it did not say.
 *
 * Null still means "update your hub" — the status code is the decision, and the
 * number is only what the message can quote.
 */
export function decodeSchemaTooNew(payload: unknown): SchemaTooNewResponse | null {
  if (!isRecord(payload)) return null
  const version = nullableNum(payload.hubSchemaVersion)
  return version === null ? null : { hubSchemaVersion: version }
}
