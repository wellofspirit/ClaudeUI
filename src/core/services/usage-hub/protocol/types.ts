/**
 * The usage hub's wire protocol, version 2 (ADR-072 §8).
 *
 * ## This folder is the protocol's home
 *
 * The hub owns its protocol: these types, the golden fixtures beside them and
 * the fake hub under `test/fake-hub/` are the contract, and every client vendors
 * a copy (ClaudeUI keeps one under `src/core/services/usage-hub/protocol/`).
 * The first draft was written in ClaudeUI, where the client's constraints
 * shaped it, and moved here unchanged. The folder is deliberately
 * self-contained: no import from the Worker, nothing but these declarations, so
 * a client can copy it as it is. `billingType`, `origin` and `windowKind` are
 * plain strings for the same reason — the hub must accept a value a newer client
 * knows and it does not, and a union here would be a promise neither side can
 * keep.
 *
 * ## Two rules that are not about shapes
 *
 * **Idempotency.** `messageId` is unique. The hub inserts
 * `ON CONFLICT(message_id) DO NOTHING` and answers with how many rows were new
 * and how many it had already seen. A retry, a machine that was offline for a
 * month, and two machines that both imported the same transcript folder all
 * produce the same result: each turn once (ADR-072 §2).
 *
 * **What never leaves the machine.** Per ADR-072 §5 an event carries the fields
 * in {@link HubEvent} and nothing else. Never: prompts, responses, tool calls,
 * file paths, working directories, session titles, session ids, routing ids
 * (`parentRoutingId` included) or any credential. {@link FORBIDDEN_EVENT_FIELDS}
 * is that rule as data, and `encodePushEvents` enforces it at the boundary
 * rather than trusting every caller upstream of it.
 */

/**
 * The protocol version every request carries, and the one this build speaks.
 *
 * 2 added `GET /v1/accounts`, and a new DEVICE-facing route is what a version
 * exists to state: a client that pulls it from a hub still on 1 would be
 * answered `404` and could only read that as a broken hub. The version says the
 * truth instead — such a hub answers `426` on every route, and the client pauses
 * with "update your hub" and leaves its cursor exactly where it was (ADR-072 §8).
 */
export const SCHEMA_VERSION = 2

/**
 * Routes, all under `<hubUrl>/v1/`.
 *
 * `devicePrefix` is the one entry that is not a whole path: `PATCH /v1/devices/<id>`
 * names the machine in its URL. A hub matches the exact paths first and only then
 * this prefix, so `/v1/devices/self/resync` is matched as itself and never read as
 * a device id.
 */
export const HUB_ROUTES = {
  events: '/v1/events',
  limits: '/v1/limits',
  buckets: '/v1/buckets',
  windows: '/v1/windows',
  devices: '/v1/devices',
  /** Every account the hub has seen, NAMED. Both callers; see {@link HubAccount}. */
  accounts: '/v1/accounts',
  resync: '/v1/devices/self/resync',
  /** The hub's own status line, for its dashboard. OWNER ONLY. */
  hub: '/v1/hub',
  /** `PATCH /v1/devices/<deviceId>`: rename, retire, rebind. OWNER ONLY. */
  devicePrefix: '/v1/devices/'
} as const

/**
 * Where `schemaVersion` rides on a GET.
 *
 * EVERY route carries the version and EVERY route may answer `426` — the POSTs
 * in their body, the GETs in this query parameter. A hub that validated only the
 * writes would accept a read whose response shape the client cannot parse, and
 * the client would read the mismatch as corrupt data rather than as "update your
 * hub".
 */
export const SCHEMA_VERSION_PARAM = 'schemaVersion'

/** The two Access service-token headers a device authenticates with (ADR-072 §6). */
export const HUB_CLIENT_ID_HEADER = 'CF-Access-Client-Id'
export const HUB_CLIENT_SECRET_HEADER = 'CF-Access-Client-Secret'

/** The most events one `POST /v1/events` may carry. */
export const MAX_EVENTS_PER_PUSH = 500

/** The most limit readings one `POST /v1/limits` may carry, and the depth of the client's queue. */
export const MAX_READINGS_PER_PUSH = 500

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** What every request body states about itself and its sender. */
export interface HubRequestEnvelope {
  schemaVersion: number
  /** This machine's uuid, generated once and kept in `meta` (`hub.device_id`). */
  deviceId: string
}

/** What every response states about the hub's bucket-rebuild generation (ADR-072 §3). */
export interface HubEpochEnvelope {
  /**
   * Rises whenever the hub rebuilds buckets (a resync). A client holding a
   * different epoch drops its cached remote rows and pulls from `rev` 0, because
   * a rebuild can REMOVE an hour and "changed since rev" cannot say that
   * something is gone.
   *
   * **THE HUB'S PROMISE: one epoch per pass.** The epoch reported to one device
   * must not change between two requests that arrive within the same minute,
   * unless a resync from THAT device caused it. A client reads the epoch from the
   * first response of a sync pass and holds it for the rest; a later response in
   * the same pass carrying a different one means the hub rebuilt underneath the
   * pass, so the client ABANDONS the pass without writing anything — no
   * truncate, no watermark advance — and runs it again on the next tick. Without
   * the promise a client could store a page of buckets against a generation that
   * had already been replaced, and nothing downstream could tell.
   */
  epoch: number
}

// ---------------------------------------------------------------------------
// POST /v1/events
// ---------------------------------------------------------------------------

/**
 * One ledger row, as ADR-072 §5 permits it to leave the machine.
 *
 * The field list IS the privacy boundary — see the module header. Costs are
 * nullable because ADR-030 forbids counting an unknown as zero: a turn whose
 * model had no published price has no API-equivalent, and a subscription turn
 * that was never billed has no bill.
 */
export interface HubEvent {
  /** The turn's stable identity, and the hub's idempotency key. */
  messageId: string
  ts: number
  engineId: string
  vendorId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  /** Includes the 1h-TTL tier; {@link cacheWrite1hTokens} is a SUBSET, not an addend. */
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  /** Tokens at list price, or null when the model had no known price. */
  apiCostUsd: number | null
  /** Money that left a wallet, or null when that cannot be known. */
  billedCostUsd: number | null
  /** `subscription` | `free` | `apiKey` | `unknown` — a string, see the header. */
  billingType: string
  /** `session` | `dispatch` | … — a string, see the header. */
  origin: string
  /** ADR-071 §3's machine-independent key. Never `unknown` on the wire (ADR-072 §2). */
  accountKey: string
  /** The account's email or `<vendor> key …abcd`. Sent in full; the hub masks it on the way out. */
  accountLabel: string | null
}

/** The per-push device facts ADR-072 §5 allows: a name the user picked, the OS family, the build. */
export interface PushEventsRequest extends HubRequestEnvelope {
  deviceName: string
  appVersion: string
  /** `process.platform` — `win32`, `darwin`, `linux`. The OS FAMILY, not a build. */
  os: string
  /**
   * The batch, at most {@link MAX_EVENTS_PER_PUSH} rows — and **an empty array
   * is valid**: it is how a device announces itself.
   *
   * The hub learns a device exists only from this route, and the three facts
   * above only travel on it. A machine that enables sync starts its cursor at
   * the newest row it holds (ADR-072 §2), so it may have nothing to send for
   * days; without an empty push it would pull the combined view while the hub's
   * machine list never mentioned it. The hub must therefore record the device
   * and answer `{ accepted: 0, duplicates: 0, epoch }` — which satisfies the
   * promise below as 0 of 0. Clients send one when they have never pushed and
   * whenever `deviceName`, `appVersion` or `os` has changed since their last.
   */
  events: HubEvent[]
}

/**
 * **THE HUB'S PROMISE: `accepted + duplicates === events.length`.**
 *
 * Every row of the batch is accounted for, as new or as already held. A short
 * answer means the hub silently dropped rows — a validation it did not report, a
 * partial D1 batch — and the client treats it as a failure and leaves its cursor
 * where it was, because the alternative is advancing past turns that never
 * landed and never noticing.
 */
export interface PushEventsResponse extends HubEpochEnvelope {
  /** Rows the hub had never seen. */
  accepted: number
  /** Rows whose `messageId` it already held. Not an error; the point of the design. */
  duplicates: number
}

// ---------------------------------------------------------------------------
// POST /v1/limits
// ---------------------------------------------------------------------------

/**
 * One limit-window reading, as a device observed it.
 *
 * `windowMinutes` is here because of S3c: the kind is a grouping key and a plan
 * can state a length the kind does not name, so two machines can only key one
 * window the same way if the length travels with it.
 */
export interface HubLimitReading {
  accountKey: string
  accountLabel: string | null
  vendorId: string
  plan: string | null
  windowKind: string
  windowMinutes: number | null
  /** The window's display label as the observing machine rendered it. */
  label: string
  usedPercent: number
  /** ISO 8601, or null for a window whose reset the vendor did not state. */
  resetsAt: string | null
  observedAt: number
}

export interface PushLimitsRequest extends HubRequestEnvelope {
  readings: HubLimitReading[]
}

export interface PushLimitsResponse extends HubEpochEnvelope {
  accepted: number
}

// ---------------------------------------------------------------------------
// GET /v1/buckets
// ---------------------------------------------------------------------------

/**
 * One hour of another machine's spend — ADR-071's `usage_bucket` in camelCase.
 *
 * A bucket carries an `accountKey` and no label, deliberately: the key is the
 * grouping fact and a label repeated on every hour would be the same string a
 * hundred thousand times. `GET /v1/accounts` is where the name for a key comes
 * from, for a caller that holds no credential of its own for that account.
 */
export interface RemoteBucket {
  deviceId: string
  /** Monotonic on the hub. The client pages with it and never displays it. */
  rev: number
  /** Start of the hour, ms since the epoch, floored in UTC. */
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
  /** The `api` half of the per-row `billed ?? api` rule, for the hour's unbilled turns. */
  unbilledApiCostUsd: number
  unknownApiCostCount: number
  unknownBilledCostCount: number
  requestCount: number
  /** `rollup` | `seed`. */
  source: string
}

/**
 * The buckets query. `excludeDevice` is the caller's own id: its rows are already
 * local, and storing the hub's copy of them would double the combined total.
 */
export interface PullBucketsQuery {
  schemaVersion: number
  since: number
  excludeDevice: string
  /**
   * The oldest hour worth answering, ms since the epoch — `hour_utc >= from`.
   *
   * Absent means no bound, which is what a machine sends: it is catching up on
   * everything it has not seen. The hub's own dashboard sends one, because a
   * 30-day view has no use for the hub's whole history and pages it would only
   * throw away cost the same as pages it keeps.
   */
  from?: number
}

export interface PullBucketsResponse extends HubEpochEnvelope {
  /** The highest `rev` in `buckets`, or the requested `since` for an empty page. */
  rev: number
  buckets: RemoteBucket[]
}

// ---------------------------------------------------------------------------
// GET /v1/windows
// ---------------------------------------------------------------------------

/** One window-value row of another machine — ADR-071 §7's `usage_window` plus whose it is. */
export interface RemoteWindow {
  /**
   * The hub's own aggregate rows carry the literal `hub`, because their numerator
   * is EVERY machine's turns: a window's value cannot be computed on one machine.
   * A client's merge keys on `(accountKey, windowKind, canonicalEnd)` and
   * discards this, but it must be non-empty — a window without it is dropped.
   */
  deviceId: string
  accountKey: string
  windowKind: string
  canonicalEnd: number
  windowStart: number
  windowMinutes: number | null
  peakPercent: number
  apiCostUsd: number
  billedCostUsd: number
  unknownCostCount: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  sampleCount: number
  closed: boolean
  updatedAt: number
  /**
   * Monotonic on the hub, from the same source the buckets' `rev` comes from.
   *
   * A window row is UPDATED as its numerator grows, so the first draft paged by
   * `updatedAt` — which is a CLOCK, not a revision. Two hubs, a clock that steps
   * back, or two rows touched in the same millisecond as the client's watermark
   * are all ways for a change to be missed for ever, and none of them is
   * detectable afterwards. A revision counter has one job and cannot do that.
   */
  rev: number
}

export interface PullWindowsQuery {
  schemaVersion: number
  since: number
}

export interface PullWindowsResponse extends HubEpochEnvelope {
  /** The highest `rev` in `windows`, or the requested `since` for an empty page. */
  rev: number
  windows: RemoteWindow[]
}

// ---------------------------------------------------------------------------
// GET /v1/limits
// ---------------------------------------------------------------------------

/**
 * The latest reading per account key and window kind, across every machine.
 *
 * This is ADR-072 §4's relay, and the answer to ADR-071 §6's refresh-grant
 * problem: a machine where an account is not active shows the reading another
 * machine already paid for and spends no grant of its own.
 *
 * `labelMasked` is masked BY THE HUB for a device caller (`d•••@g•••.com`, or an
 * API key's last four). Full labels go to a Google sign-in only. A client shows
 * its own full label for a key it holds a credential for and this one otherwise.
 */
export interface RemoteLimitReading {
  deviceId: string
  accountKey: string
  windowKind: string
  labelMasked: string | null
  vendorId: string
  plan: string | null
  windowMinutes: number | null
  usedPercent: number
  resetsAt: string | null
  observedAt: number
  /**
   * The label in full — OWNER ONLY, and absent for a device caller rather than
   * null, so a device cannot tell "the hub withheld it" from "there is none".
   * The hub's dashboard reads it; nothing on the wire to a machine carries it.
   */
  accountLabel?: string | null
}

export interface PullLimitsResponse extends HubEpochEnvelope {
  readings: RemoteLimitReading[]
}

// ---------------------------------------------------------------------------
// GET /v1/devices
// ---------------------------------------------------------------------------

/**
 * One machine on the hub, as a DEVICE caller may see it.
 *
 * Readable by a device (orchestrator ruling, 2026-09-21, for the owner to
 * confirm before S5c): a name the user chose, an OS family, a build number and
 * an instant. None of it is sensitive, and without it the machine list can only
 * show opaque uuids and guess "last seen" from the newest hour in a bucket — so
 * a machine that synced but spent nothing reads as a machine that is behind,
 * which is exactly the flag ADR-030 wants to be trustworthy.
 *
 * What stays owner-only is unchanged: raw events, and account labels in full.
 */
export interface HubDevice {
  deviceId: string
  deviceName: string
  /** The OS FAMILY the device reported — `win32`, `darwin`, `linux`. */
  os: string
  appVersion: string
  /** When the hub last accepted a write from this device. */
  lastPushAt: number
  /** The owner marked it retired from the hub dashboard; the machine list stops flagging it. */
  retired: boolean
  /**
   * The Access service token this machine last pushed under — OWNER ONLY, and
   * absent for a device caller. It is how the hub's dashboard says which token is
   * which machine; a machine is never told another machine's credential.
   */
  clientId?: string
  /**
   * The Access service token this machine FIRST pushed under — OWNER ONLY, and
   * absent for a device caller, like {@link clientId}.
   *
   * It is the one the resync guard is checked against, so a dashboard that can
   * see both can say "rotated" for a machine whose two differ, and offer the
   * rebind that makes Resync work again.
   */
  firstClientId?: string
}

export interface PullDevicesQuery {
  schemaVersion: number
}

export interface PullDevicesResponse extends HubEpochEnvelope {
  devices: HubDevice[]
}

// ---------------------------------------------------------------------------
// GET /v1/accounts
// ---------------------------------------------------------------------------

/**
 * One account the hub has seen, named — the label buckets do not carry.
 *
 * The hub learns a name from the `accountLabel` on an event and on a limit
 * reading, and keeps the NEWEST one it was ever told. That matters for the
 * accounts a reading can never name: an API-key account has no rate-limit meter,
 * so `GET /v1/limits` says nothing about it, and a machine holding no credential
 * for it could only show the raw key.
 */
export interface HubAccount {
  accountKey: string
  vendorId: string
  /** Masked BY THE HUB for a device caller, `maskLabel`'s rule; null when the hub was never told a label. */
  labelMasked: string | null
  /**
   * The newest instant the hub saw this account on any row: an event's `ts` or a
   * reading's `observedAt`, whether or not that row carried a label. Milliseconds.
   */
  lastSeenAt: number
  /** The label in full — OWNER ONLY, absent for a device caller (the {@link RemoteLimitReading} rule). */
  accountLabel?: string | null
}

export interface PullAccountsQuery {
  schemaVersion: number
}

/**
 * Every account, whole. It is not paged by `rev`: the list is one row per
 * account rather than one per hour, and a client re-reads it on every pass the
 * way it re-reads the machine list.
 */
export interface PullAccountsResponse extends HubEpochEnvelope {
  accounts: HubAccount[]
}

// ---------------------------------------------------------------------------
// PATCH /v1/devices/<deviceId>
// ---------------------------------------------------------------------------

/**
 * The owner's three edits to one machine, any combination of them (ADR-072 §6).
 *
 * At least one has to be present: a body that changes nothing is refused rather
 * than answered, because a client that meant to send a name and sent none would
 * otherwise read the unchanged device back as a successful rename.
 *
 * None of the three touches a row of usage. Retiring keeps a machine's events,
 * buckets and name and only stops it being counted as active; revoking its
 * credential is done in Zero Trust and not here.
 */
export interface PatchDeviceRequest {
  schemaVersion: number
  /** 1–120 characters after trimming. */
  deviceName?: string
  retired?: boolean
  /**
   * Bind Resync to the token this machine is pushing under NOW.
   *
   * Only `true`: there is no un-rebind, because the old token is not recorded
   * anywhere after this and a machine's current token is the only value the hub
   * could put back.
   */
  rebindToken?: true
}

export interface PatchDeviceResponse extends HubEpochEnvelope {
  /** The machine as it now stands, in the owner's shape (both token fields). */
  device: HubDevice
}

// ---------------------------------------------------------------------------
// GET /v1/hub
// ---------------------------------------------------------------------------

/**
 * What the hub says about itself, for the one line at the top of its dashboard.
 *
 * OWNER ONLY, and deliberately not a health route: every path on this hub is
 * behind Access, so this answers a signed-in browser and nobody else.
 */
export interface HubStatusResponse extends HubEpochEnvelope {
  /** The version this build speaks, which is what a dashboard renders itself against. */
  schemaVersion: number
  /** When the window ledger was last recomputed, ms, or 0 when it never has been. */
  recomputedAt: number
  /** How long raw events are kept before the nightly job archives and deletes them. */
  retentionDays: number
  /** Whether an R2 bucket is bound. With none, nothing is archived and nothing is deleted. */
  archiveBound: boolean
  deviceCount: number
}

// ---------------------------------------------------------------------------
// POST /v1/devices/self/resync
// ---------------------------------------------------------------------------

/**
 * The repair route (ADR-072 §2), called from a button and never on a timer.
 *
 * `since` is the timestamp of the device's OLDEST local ledger row. The hub
 * deletes this device's raw rows from that instant forward, rebuilds the
 * affected buckets and windows from what remains, and raises its `epoch`. Rows
 * older than the device can re-send are left alone, so a resync never destroys
 * history.
 */
export interface ResyncRequest extends HubRequestEnvelope {
  since: number
}

export interface ResyncResponse extends HubEpochEnvelope {
  deleted: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The body of a `426 Upgrade Required`: the hub knows an older schema than the
 * client speaks. The client shows "update your hub" and leaves its cursor
 * exactly where it was, so nothing is lost (ADR-072 §8).
 */
export interface SchemaTooNewResponse {
  hubSchemaVersion: number
}

/** Any other error body the hub may send. Advisory — the status code decides. */
export interface HubErrorResponse {
  error: string
  detail?: string
}

// ---------------------------------------------------------------------------
// The privacy boundary, as data
// ---------------------------------------------------------------------------

/**
 * Keys that may not appear among the TOP-LEVEL keys of an object offered to
 * {@link HubEvent}'s encoder.
 *
 * ADR-072 §5 as an assertion rather than a paragraph. `encodeEvent` refuses an
 * input object carrying any of them: the ledger row these are built from HAS a
 * `sessionId` and a `parentRoutingId`, so "the mapper does not copy them" is one
 * edit away from being false, and this is the check that would notice.
 *
 * Top-level only, deliberately. It guards the one real hazard — someone
 * spreading a row (or a row-shaped object) into a payload — and a wire event is
 * flat by construction, since every field the encoder emits is a number, a
 * string or null. A deep walk would be a check with no input that could reach it.
 */
export const FORBIDDEN_EVENT_FIELDS: ReadonlyArray<string> = [
  'cwd',
  'workingDirectory',
  'sessionId',
  'session_id',
  'parentRoutingId',
  'parent_routing_id',
  'routingId',
  'prompt',
  'promptText',
  'content',
  'text',
  'title',
  'path',
  'filePath',
  'accessToken',
  'apiKey',
  'clientSecret',
  'credentials'
]

/** The fields an event on the wire is allowed to have. Anything else is a leak. */
export const ALLOWED_EVENT_FIELDS: ReadonlyArray<keyof HubEvent> = [
  'messageId',
  'ts',
  'engineId',
  'vendorId',
  'modelId',
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'cacheReadTokens',
  'apiCostUsd',
  'billedCostUsd',
  'billingType',
  'origin',
  'accountKey',
  'accountLabel'
]
