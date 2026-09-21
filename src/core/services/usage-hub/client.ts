/**
 * The usage hub client (ADR-072 §7).
 *
 * In `src/core` so the desktop app and `claudeui-server` both sync, and so that
 * neither host has a version of this loop the other does not.
 *
 * ## What it does, in one paragraph
 *
 * Push: the ledger's rows past a rowid cursor, in batches of 500, skipping the
 * unattributed ones; plus the limit readings the sample writer has just written.
 * Pull: the other machines' hourly buckets (paged by the hub's `rev`), their
 * window-value rows (paged by `updatedAt`) and the latest limit reading per
 * account and window. Nothing here blocks or fails a turn — the same rule
 * `recordUsageEvent` already follows.
 *
 * ## Triggers, and why there are four
 *
 *   - the row-written notifier, DEBOUNCED to one push a minute. A turn ending is
 *     the moment there is something new to say, and a minute is enough that a
 *     burst of backfilled rows is one request;
 *   - a ten-minute timer, as the backstop for anything the notifier missed (a
 *     write from another process, a push that failed while the app was asleep);
 *   - the same timer pulls;
 *   - `syncNow()`, from the settings button and from the dashboard opening.
 *
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppresses the first three and not
 * the fourth: a person pressing Sync has asked, which is the same rule the
 * models.dev refresh button follows.
 *
 * ## Failure is a state, not an exception
 *
 * Every public method resolves. A failure lands in `state` and `lastError`,
 * which `usage-hub:status` reports and S5b renders, and the retry timer decides
 * what happens next:
 *
 *   - `needs-credentials` — 401, 403, or ANY redirect. Cloudflare Access answers
 *     a bad service token with a 302 to its login page rather than a 403 (the
 *     ADR-072 §6 spike), so `redirect: 'manual'` is not an optimisation: without
 *     it the client would follow the redirect and read an HTML login page as the
 *     hub's answer. Timers stop; there is nothing to retry until someone pastes
 *     a working token;
 *   - `update-hub` — 426. The cursor is left exactly where it was, so nothing is
 *     lost, and sync pauses until the app restarts or the user presses Sync;
 *   - `backoff` — 5xx, a network error, or a 429 (whose `Retry-After` wins).
 *     5 s, 15 s, 60 s, 5 min, then doubling to a one-hour ceiling;
 *   - `error` — a 4xx that is none of the above. Not retried on a timer: a
 *     malformed request will be malformed again in five seconds.
 */

import { emitEvent } from '../sync-host'
import { envFlag } from '../context-window'
import { logger } from '../logger'
import {
  getHubConfigRow,
  listRemoteDevices,
  oldestUsageEventTs,
  replaceRemoteDevices,
  upsertHubConfig,
  upsertRemoteLimits,
  upsertRemoteUsageBuckets,
  upsertRemoteUsageWindows,
  type RemoteLimitRow,
  type RemoteUsageBucketRow,
  type RemoteUsageWindowRow
} from '../db'
import { onUsageEventWritten } from '../db'
import { onLimitSamplesWritten, type LimitReadingWritten } from '../window-samples'
import type { UsageHubState, UsageHubStatus } from '../../../shared/types'
import { getHubConfig, hubCredential, resetRemoteCache } from './config'
import { deviceAppVersion, deviceId, deviceOs, hubDeviceName, storedDeviceId } from './device'
import { nextEventBatch, pendingEventCount } from './ledger-cursor'
import {
  decodePullBucketsResponse,
  decodePullDevicesResponse,
  decodePullLimitsResponse,
  decodePullWindowsResponse,
  decodePushEventsResponse,
  decodePushLimitsResponse,
  decodeResyncResponse,
  decodeSchemaTooNew,
  encodePushEvents,
  encodePushLimits,
  encodeResync
} from './protocol/codec'
import {
  HUB_CLIENT_ID_HEADER,
  HUB_CLIENT_SECRET_HEADER,
  HUB_ROUTES,
  MAX_EVENTS_PER_PUSH,
  SCHEMA_VERSION,
  SCHEMA_VERSION_PARAM,
  type RemoteBucket,
  type RemoteWindow
} from './protocol/types'

const LOG_SOURCE = 'UsageHub'

/** One request's ceiling. The hub answers from buckets, so nothing here is slow. */
const REQUEST_TIMEOUT_MS = 30_000

/** The notifier's debounce: at most one push a minute (ADR-072 §7). */
const PUSH_DEBOUNCE_MS = 60_000

/** The backstop cadence for both directions. */
const SYNC_INTERVAL_MS = 10 * 60 * 1000

/**
 * The backoff ladder, then doubling to the ceiling.
 *
 * The first four steps are `usage-fetcher`'s, deliberately: a person watching
 * two background services recover should not see two different rhythms. The
 * ceiling is ADR-072 §7's hour.
 */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]
const BACKOFF_CEILING_MS = 60 * 60 * 1000

/** How many unsent limit readings to hold. A window's meter is worth seconds, not megabytes. */
const MAX_QUEUED_READINGS = 500

/** How many bucket pages one pull will walk before giving the loop back. */
const MAX_PULL_PAGES = 50

/** How many 500-row batches one push will send before giving the loop back. */
const MAX_PUSH_BATCHES = 50

/** What one request came back as. `kind` and not `ok` — see the module header on failure. */
type SendResult =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'credentials'; detail: string }
  | { kind: 'schema'; detail: string }
  | { kind: 'backoff'; detail: string; retryAfterMs?: number }
  | { kind: 'error'; detail: string }

/** Injected in tests so the suite needs neither a network nor a real clock. */
export interface UsageHubClientDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

export class UsageHubClient {
  private state: UsageHubState = 'off'
  private started = false
  /**
   * Set by `stop()` and cleared by `start()`.
   *
   * NOT the inverse of `started`: a client that has never been started is not
   * stopped, and a `syncNow()` on one — which is how the settings screen tests a
   * hub before enabling it — must still be allowed to write.
   */
  private stopped = false
  private inFlight: Promise<void> | null = null
  /**
   * The three pauses. Each says "nothing unprompted will help", and each is
   * lifted only by a user action: `syncNow` clears the first two, and a new
   * credential or a re-save clears the third through `restart()`.
   */
  private schemaPaused = false
  private errorPaused = false
  /**
   * The epoch the CURRENT pass established from its first response (ADR-072 §3,
   * the hub's one-epoch-per-pass promise). Null between passes.
   */
  private passEpoch: number | null = null

  private syncTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private backoffAttempt = 0

  private unsubscribeRows: (() => void) | null = null
  private unsubscribeLimits: (() => void) | null = null

  /** Readings written since the last successful limits push. */
  private queuedReadings: LimitReadingWritten[] = []

  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(deps: UsageHubClientDeps = {}) {
    // Bound to `globalThis` rather than taken bare: an unbound `fetch` throws
    // "Illegal invocation" on some hosts.
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.now = deps.now ?? (() => Date.now())
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Arm the client. Idempotent, and a no-op for a hub that is not configured.
   *
   * Subscribing to the notifiers is what makes a push follow a turn, so it is
   * gated on the env flag too: a machine that has asked for no non-essential
   * traffic must not reach the network because a turn ended.
   */
  start(): void {
    if (this.started) return
    const config = getHubConfigRow()
    if (!config?.enabled) {
      this.setState('off')
      return
    }
    this.started = true
    this.stopped = false
    this.schemaPaused = false
    this.errorPaused = false
    // HERE and in `configureHub`, never in `status()`: a query must not write
    // (M6). These are the two moments the id is actually needed, and both are
    // already writing to the same database.
    deviceId()
    this.setState('idle')

    if (this.trafficSuppressed()) {
      logger.info(
        LOG_SOURCE,
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set — no hub timers; a pressed sync still runs'
      )
      return
    }

    this.unsubscribeRows = onUsageEventWritten(() => this.onLedgerWrite())
    this.unsubscribeLimits = onLimitSamplesWritten((readings) => this.onLimitsWritten(readings))
    this.syncTimer = setInterval(() => {
      // The env gate is re-read, not captured at `start()`: a process whose
      // environment gained the flag must stop reaching the network, and this is
      // the only timer that outlives a single failure.
      if (this.trafficSuppressed()) return
      this.fireAndForget('timer')
    }, SYNC_INTERVAL_MS)
    // The first pass is not deferred ten minutes: a machine that was off while
    // three others were spending has an empty combined view until it pulls.
    this.fireAndForget('start')
  }

  /**
   * Run a pass nobody is awaiting, and swallow the failure at debug.
   *
   * `runSync` already turns every failure into a state, so a rejection here can
   * only be a bug in that translation — but a floating rejection from a timer is
   * an unhandled rejection, which on some hosts is fatal to the process. This is
   * background housekeeping; it may not take the app down.
   */
  private fireAndForget(reason: 'start' | 'timer' | 'rows' | 'manual'): void {
    void this.runSync(reason).catch((err) => {
      logger.debug(LOG_SOURCE, `background sync failed: ${err}`)
    })
  }

  /**
   * Disarm everything. Safe to call on a client that never started.
   *
   * A pass already in flight cannot be cancelled mid-request, so `started` is
   * also what it checks before every write: the desktop closes the database on
   * the way out, and a push that came back after that would throw inside a
   * teardown nobody is watching.
   */
  stop(): void {
    this.started = false
    this.stopped = true
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.clearTimer('debounce')
    this.clearTimer('retry')
    this.unsubscribeRows?.()
    this.unsubscribeRows = null
    this.unsubscribeLimits?.()
    this.unsubscribeLimits = null
    this.setState('off')
  }

  /** Re-read the config and re-arm — what a settings change calls. */
  restart(): void {
    this.stop()
    this.start()
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /**
   * Whether a ledger write or a new reading should arm a push at all.
   *
   * FOUR states arm nothing. `needs-credentials` is the one that matters: a
   * revoked service token used to get one request train per minute of spend, for
   * ever, because the notifier subscriptions outlived `stopTimers()` and nothing
   * on this path looked at the state. `update-hub` and `error` are the same
   * argument — the next request will fail the same way — and `off` is a client
   * that has been stopped. All four are lifted by a user action (`syncNow`, or a
   * `configure` / `set-secret` that calls `restart()`), never by a turn ending.
   */
  private armedByActivity(): boolean {
    if (!this.started) return false
    return (
      this.state !== 'needs-credentials' &&
      this.state !== 'update-hub' &&
      this.state !== 'error' &&
      this.state !== 'off'
    )
  }

  private onLedgerWrite(): void {
    if (!this.armedByActivity()) return
    if (this.debounceTimer) return // already inside the minute
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.fireAndForget('rows')
    }, PUSH_DEBOUNCE_MS)
  }

  private onLimitsWritten(readings: LimitReadingWritten[]): void {
    // Not queued either, for the same reason: a paused client holding readings
    // it will never send is a memory leak with a nice name.
    if (!this.armedByActivity()) return
    this.queuedReadings.push(...readings)
    if (this.queuedReadings.length > MAX_QUEUED_READINGS) {
      // Oldest first: a superseded reading of the same window is the least
      // valuable row in the queue.
      this.queuedReadings = this.queuedReadings.slice(-MAX_QUEUED_READINGS)
    }
    this.onLedgerWrite()
  }

  /**
   * Push, then pull, now. The user-pressed path: it ignores the env gate, the
   * backoff timer and a `426` pause, because all three are this build's guesses
   * about what is worth doing unprompted.
   */
  async syncNow(): Promise<UsageHubStatus> {
    this.schemaPaused = false
    this.errorPaused = false
    this.clearTimer('retry')
    this.backoffAttempt = 0
    await this.runSync('manual')
    return this.status()
  }

  /**
   * The repair route (ADR-072 §2) — a manual action for a known data fault.
   *
   * The hub deletes this device's rows from the oldest local row's timestamp
   * forward and raises its epoch; the cursor then goes back to zero so the whole
   * local ledger is re-pushed. Zero and "the rowid of the first row at or after
   * `since`" are the same cursor, because `since` IS the oldest row's timestamp.
   */
  async resync(): Promise<UsageHubStatus> {
    const config = getHubConfigRow()
    if (!config?.enabled) return this.status()
    const since = oldestUsageEventTs()
    if (since === null) {
      logger.info(LOG_SOURCE, 'resync skipped — the local ledger is empty')
      return this.status()
    }
    this.schemaPaused = false
    this.errorPaused = false
    const result = await this.send(
      config.url,
      HUB_ROUTES.resync,
      encodeResync({ deviceId: deviceId(), since })
    )
    if (result.kind !== 'ok') {
      this.applyFailure(result)
      return this.status()
    }
    const answer = decodeResyncResponse(result.payload)
    logger.info(LOG_SOURCE, `resync: the hub deleted ${answer.deleted} row(s) of this device`)
    upsertHubConfig({ cursorRowid: 0, lastError: null })
    // A resync is the ONE thing that legitimately raises the epoch from this
    // device's own action, so it is applied outside a pass and starts no
    // conflict — see the one-epoch-per-pass promise in `protocol/types.ts`.
    this.passEpoch = null
    this.adoptEpoch(answer.epoch)
    this.backoffAttempt = 0
    await this.runSync('manual')
    return this.status()
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * The whole client state, and it WRITES NOTHING.
   *
   * It used to call `deviceId()`, which generates and stores a uuid on first
   * use — so a `usage-hub:status` query, declared a query and audited as one,
   * mutated the database. The id is created at the two moments that need it
   * (enabling sync, and `start()`); here it is read, and `null` when a machine
   * has never had one. Nor does the machine list scan buckets any more: it is
   * the cache of `GET /v1/devices`, which is where a peer's NAME comes from.
   */
  status(): UsageHubStatus {
    const config = getHubConfig()
    const devices = config.enabled ? listRemoteDevices() : []
    return {
      enabled: config.enabled,
      url: config.url,
      deviceId: storedDeviceId(),
      deviceName: config.deviceName,
      clientId: config.clientId,
      hasSecret: config.hasSecret,
      state: this.state,
      lastPushAt: config.lastPushAt,
      lastPullAt: config.lastPullAt,
      lastError: config.lastError,
      pendingEvents: config.enabled ? pendingEventCount(config.cursorRowid) : 0,
      remote: {
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          os: device.os,
          appVersion: device.appVersion,
          lastPushAt: device.lastPushAt,
          retired: device.retired
        })),
        epoch: config.remoteEpoch
      }
    }
  }

  // -------------------------------------------------------------------------
  // The sync pass
  // -------------------------------------------------------------------------

  /**
   * One pass, and only one at a time.
   *
   * SINGLE-FLIGHT and JOINING, not "drop the second caller": a pressed Sync that
   * landed while the ten-minute timer was mid-pass must resolve when that pass
   * does, or the settings button would return a status from before the work it
   * appeared to do. Same shape as `ChatgptRateLimitStore.refresh`.
   */
  private runSync(reason: 'start' | 'timer' | 'rows' | 'manual'): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.pass(reason).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async pass(reason: 'start' | 'timer' | 'rows' | 'manual'): Promise<void> {
    // EVERYTHING inside the try, the config read included: `getHubConfigRow()`
    // opens the database, and on the shutdown path (or a disk fault) it can
    // throw — outside the try that rejection would escape a pass nobody awaits.
    try {
      if (reason !== 'manual' && (this.schemaPaused || this.errorPaused)) return
      const config = getHubConfigRow()
      if (!config?.enabled) {
        this.setState('off')
        return
      }
      if (config.url === '' || hubCredential() === null) {
        this.setState('needs-credentials')
        return
      }
      // One epoch per pass (ADR-072 §3): established by the first response and
      // held to by every later one.
      this.passEpoch = null
      this.setState('syncing')
      const pushed = await this.push(config.url)
      if (!pushed) return
      const pulled = await this.pull(config.url)
      if (!pulled) return
      if (!this.writable()) return
      upsertHubConfig({ lastError: null })
      this.backoffAttempt = 0
      this.clearTimer('retry')
      this.setState('idle')
    } catch (err) {
      // A bug here must not take a turn or the boot path with it.
      this.applyFailure({
        kind: 'error',
        detail: err instanceof Error ? err.message : String(err)
      })
    } finally {
      this.passEpoch = null
    }
  }

  /**
   * Whether this pass may still write.
   *
   * `stop()` cannot cancel a request that is already out, and on the desktop it
   * runs inside the before-quit teardown that then closes the database. A write
   * from a late response would throw in a path nobody is watching, so every
   * write point asks first.
   */
  private writable(): boolean {
    return !this.stopped
  }

  /** Returns false when the pass ended in a failure state. */
  private async push(url: string): Promise<boolean> {
    // Events first, in batches, until the ledger is caught up. `full` rather
    // than "the batch was non-empty": a run of `unknown` rows is read, advances
    // the cursor and sends nothing, and the loop has to keep going through it.
    for (let batchIndex = 0; batchIndex < MAX_PUSH_BATCHES; batchIndex++) {
      const config = getHubConfigRow()
      if (!config) return false
      const batch = nextEventBatch(config.cursorRowid, MAX_EVENTS_PER_PUSH)
      if (batch.rowsRead === 0) break
      if (batch.events.length > 0) {
        const result = await this.send(
          url,
          HUB_ROUTES.events,
          encodePushEvents({
            deviceId: deviceId(),
            deviceName: hubDeviceName(config.deviceName),
            appVersion: deviceAppVersion(),
            os: deviceOs(),
            events: batch.events
          })
        )
        if (result.kind !== 'ok') {
          this.applyFailure(result)
          return false
        }
        const answer = decodePushEventsResponse(result.payload)
        // EVERY row accounted for, as new or as already held (ADR-072 §2's
        // promise). A short answer means the hub dropped rows without saying so,
        // and advancing the cursor past turns that never landed would lose them
        // silently — which is the one failure mode a ledger sync must not have.
        const accounted = answer.accepted + answer.duplicates
        if (accounted !== batch.events.length) {
          this.applyFailure({
            kind: 'error',
            detail:
              `the hub accounted for ${accounted} of ${batch.events.length} event(s) ` +
              `(${answer.accepted} new, ${answer.duplicates} already held) — cursor held back`
          })
          return false
        }
        logger.info(
          LOG_SOURCE,
          `pushed ${batch.events.length} event(s): ${answer.accepted} new, ${answer.duplicates} already held`
        )
        if (!this.noteEpoch(answer.epoch)) return false
      }
      // ONLY after the hub has the batch. A cursor advanced first would lose the
      // rows on any failure, and the hub's idempotency makes the other order
      // (re-send, counted as duplicates) free.
      if (!this.writable()) return false
      upsertHubConfig({ cursorRowid: batch.nextCursor, lastPushAt: this.now() })
      if (!batch.full) break
    }

    if (this.queuedReadings.length > 0) {
      const readings = this.queuedReadings
      // Cleared before the request, and restored on failure: a reading that
      // arrives mid-flight must not be dropped by a successful push of the
      // batch it was not in.
      this.queuedReadings = []
      const result = await this.send(
        url,
        HUB_ROUTES.limits,
        encodePushLimits({ deviceId: deviceId(), readings })
      )
      if (result.kind !== 'ok') {
        this.queuedReadings = [...readings, ...this.queuedReadings].slice(-MAX_QUEUED_READINGS)
        this.applyFailure(result)
        return false
      }
      const answer = decodePushLimitsResponse(result.payload)
      logger.info(LOG_SOURCE, `pushed ${answer.accepted} limit reading(s)`)
      if (!this.noteEpoch(answer.epoch)) return false
      if (!this.writable()) return false
      upsertHubConfig({ lastPushAt: this.now() })
    }
    return true
  }

  /** Returns false when the pass ended in a failure state. */
  private async pull(url: string): Promise<boolean> {
    const me = deviceId()

    // Buckets, paged by rev. One re-pull is permitted inside a pass: a changed
    // epoch drops the cache and starts again from zero (ADR-072 §3).
    let restarted = false
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const config = getHubConfigRow()
      if (!config) return false
      const query =
        `?${SCHEMA_VERSION_PARAM}=${SCHEMA_VERSION}` +
        `&since=${encodeURIComponent(String(config.remoteRev))}` +
        `&exclude_device=${encodeURIComponent(me)}`
      const result = await this.send(url, `${HUB_ROUTES.buckets}${query}`, null)
      if (result.kind !== 'ok') {
        this.applyFailure(result)
        return false
      }
      const answer = decodePullBucketsResponse(result.payload)
      const epoch = this.classifyEpoch(answer.epoch)
      if (epoch === 'conflict') return this.abandonPass()
      if (epoch === 'changed' && !restarted) {
        // `adoptEpoch` has just zeroed both watermarks, so the next iteration
        // asks from rev 0 against the generation that is actually live.
        restarted = true
        continue
      }
      if (answer.buckets.length === 0) break
      if (!this.writable()) return false
      upsertRemoteUsageBuckets(answer.buckets.filter((b) => b.deviceId !== me).map(toBucketRow))
      const highest = answer.buckets.reduce((max, b) => Math.max(max, b.rev), answer.rev)
      // Strictly forward: a hub answering with a rev at or below the cursor
      // would page for ever.
      if (highest <= config.remoteRev) break
      upsertHubConfig({ remoteRev: highest })
    }

    // Windows, paged by the hub's own `rev` — the same mechanism as the buckets
    // and for the same reason: a window row is UPDATED as its numerator grows,
    // and a clock cannot order updates the way a counter can (ADR-072 §4).
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const config = getHubConfigRow()
      if (!config) return false
      const query =
        `?${SCHEMA_VERSION_PARAM}=${SCHEMA_VERSION}` +
        `&since=${encodeURIComponent(String(config.remoteWindowRev))}`
      const result = await this.send(url, `${HUB_ROUTES.windows}${query}`, null)
      if (result.kind !== 'ok') {
        this.applyFailure(result)
        return false
      }
      const answer = decodePullWindowsResponse(result.payload)
      if (this.classifyEpoch(answer.epoch) !== 'ok') return this.abandonPass()
      if (answer.windows.length === 0) break
      if (!this.writable()) return false
      upsertRemoteUsageWindows(answer.windows.filter((w) => w.deviceId !== me).map(toWindowRow))
      const highest = answer.windows.reduce((max, w) => Math.max(max, w.rev), answer.rev)
      if (highest <= config.remoteWindowRev) break
      upsertHubConfig({ remoteWindowRev: highest })
    }

    // The limit relay: the latest reading per account and window, whichever
    // machine saw it. This is the answer to ADR-071 §6's refresh-grant problem.
    const limitsResult = await this.send(
      url,
      `${HUB_ROUTES.limits}?${SCHEMA_VERSION_PARAM}=${SCHEMA_VERSION}`,
      null
    )
    if (limitsResult.kind !== 'ok') {
      this.applyFailure(limitsResult)
      return false
    }
    const limits = decodePullLimitsResponse(limitsResult.payload)
    if (this.classifyEpoch(limits.epoch) !== 'ok') return this.abandonPass()
    const rows: RemoteLimitRow[] = limits.readings
      .filter((reading) => reading.deviceId !== me)
      .map((reading) => ({
        accountKey: reading.accountKey,
        windowKind: reading.windowKind,
        deviceId: reading.deviceId,
        labelMasked: reading.labelMasked,
        vendorId: reading.vendorId,
        plan: reading.plan,
        windowMinutes: reading.windowMinutes,
        usedPercent: reading.usedPercent,
        resetsAt: reading.resetsAt,
        observedAt: reading.observedAt
      }))
    if (!this.writable()) return false
    upsertRemoteLimits(rows)

    // The machine list (ADR-072 §6). A device may read it, and it is the only
    // source of a peer's NAME, its build and the instant it last pushed — the
    // three things the "more than 24 h behind" flag needs to be honest about.
    const devicesResult = await this.send(
      url,
      `${HUB_ROUTES.devices}?${SCHEMA_VERSION_PARAM}=${SCHEMA_VERSION}`,
      null
    )
    if (devicesResult.kind !== 'ok') {
      this.applyFailure(devicesResult)
      return false
    }
    const devices = decodePullDevicesResponse(devicesResult.payload)
    if (this.classifyEpoch(devices.epoch) !== 'ok') return this.abandonPass()
    if (!this.writable()) return false
    replaceRemoteDevices(
      devices.devices
        .filter((device) => device.deviceId !== me)
        .map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          os: device.os,
          appVersion: device.appVersion,
          lastPushAt: device.lastPushAt,
          retired: device.retired
        }))
    )
    upsertHubConfig({ lastPullAt: this.now() })
    return true
  }

  /**
   * The hub rebuilt underneath this pass. Write nothing and come back.
   *
   * No truncate and no watermark advance: the pages already stored in this pass
   * belong to a generation that has been replaced, and the next pass will see
   * the new epoch as its FIRST response and drop the cache properly. Scheduled
   * as a backoff rather than left to the ten-minute timer, because a resync on
   * another machine is exactly when a fresh view is wanted.
   */
  private abandonPass(): boolean {
    this.applyFailure({
      kind: 'backoff',
      detail: 'the hub changed its epoch mid-pass — the pass was abandoned and will run again'
    })
    return false
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * One request. Never throws, and never puts a credential in its answer.
   *
   * `redirect: 'manual'` on every request, and a 3xx is read as a rejected
   * credential: Cloudflare Access answers a bad service token with a 302 to its
   * hosted login page (ADR-072 §6's spike), so a client that followed redirects
   * would parse an HTML login form as the hub's reply. A fetch implementation
   * that reports an opaque redirect as `status 0` is covered by the same branch.
   */
  private async send(baseUrl: string, path: string, body: unknown): Promise<SendResult> {
    const credential = hubCredential()
    if (!credential) return { kind: 'credentials', detail: 'no device credential is stored' }
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HUB_CLIENT_ID_HEADER]: credential.clientId,
      [HUB_CLIENT_SECRET_HEADER]: credential.clientSecret
    }
    if (body !== null) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: body === null ? 'GET' : 'POST',
        redirect: 'manual',
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      // The message is ours to shape and the headers are not in it. The URL has
      // no credentials by construction (`sanitizeHubUrl` refuses a userinfo).
      return {
        kind: 'backoff',
        detail: `hub unreachable: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const status = response.status
    if (status === 0 || (status >= 300 && status < 400)) {
      return { kind: 'credentials', detail: `the hub redirected the request (HTTP ${status})` }
    }
    if (status === 401 || status === 403) {
      return { kind: 'credentials', detail: `the hub refused the credential (HTTP ${status})` }
    }
    if (status === 426) {
      const hubVersion = decodeSchemaTooNew(await readJson(response))
      return {
        kind: 'schema',
        detail:
          `the hub speaks schema ${hubVersion?.hubSchemaVersion ?? 'an older version'}, ` +
          `this app speaks ${SCHEMA_VERSION} — update the hub`
      }
    }
    if (status === 429) {
      const after = retryAfterMs(response.headers.get('retry-after'))
      return {
        kind: 'backoff',
        detail: 'the hub is rate limiting',
        ...(after === null ? {} : { retryAfterMs: after })
      }
    }
    if (status >= 500) return { kind: 'backoff', detail: `the hub failed (HTTP ${status})` }
    if (status < 200 || status >= 300) {
      return { kind: 'error', detail: `the hub refused the request (HTTP ${status})` }
    }
    return { kind: 'ok', payload: await readJson(response) }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private applyFailure(result: Exclude<SendResult, { kind: 'ok' }>): void {
    upsertHubConfig({ lastError: result.detail })
    logger.warn(LOG_SOURCE, result.detail)
    switch (result.kind) {
      case 'credentials':
        // Nothing to retry: only a person can fix a rejected token.
        this.clearTimer('retry')
        this.stopTimers()
        this.setState('needs-credentials')
        return
      case 'schema':
        // The cursor is untouched — see the module header.
        this.schemaPaused = true
        this.clearTimer('retry')
        this.setState('update-hub')
        return
      case 'backoff':
        this.scheduleRetry(result.retryAfterMs)
        this.setState('backoff')
        return
      default:
        // PAUSED, not merely un-retried. Clearing the retry timer alone left the
        // ten-minute interval firing, so a malformed request was re-sent every
        // ten minutes for ever — which is what the comment above claimed it was
        // not doing. Lifted by a pressed sync, like `update-hub`.
        this.errorPaused = true
        this.clearTimer('retry')
        this.setState('error')
    }
  }

  /**
   * Fit one response's epoch into the pass, and say what that means.
   *
   *  - `ok` — it agrees with the pass (or is the first response, and agrees with
   *    what is stored);
   *  - `changed` — it is the FIRST response of the pass and differs from the
   *    stored epoch, so the cached remote rows have been dropped and both
   *    watermarks zeroed. The caller re-asks from zero;
   *  - `conflict` — a LATER response in the same pass disagrees with the first.
   *    The hub rebuilt mid-pass, which it promises not to do inside a minute
   *    (`protocol/types.ts`), so the pass is abandoned without writing.
   */
  private classifyEpoch(epoch: number): 'ok' | 'changed' | 'conflict' {
    if (this.passEpoch !== null) {
      return epoch === this.passEpoch ? 'ok' : 'conflict'
    }
    this.passEpoch = epoch
    return this.adoptEpoch(epoch) ? 'changed' : 'ok'
  }

  /** `classifyEpoch` for a caller that only needs "may I go on" (the push path). */
  private noteEpoch(epoch: number): boolean {
    const verdict = this.classifyEpoch(epoch)
    if (verdict === 'conflict') {
      this.abandonPass()
      return false
    }
    return true
  }

  /**
   * Record an epoch, dropping the cache when it replaced one we held.
   *
   * Returns whether the cache was dropped. A first-ever epoch is recorded and
   * drops nothing; a changed one drops all four remote tables and both
   * watermarks, because a rebuild can REMOVE an hour outright and "changed since
   * rev" has no way to say that something is gone (ADR-072 §3).
   */
  private adoptEpoch(epoch: number): boolean {
    if (!this.writable()) return false
    const config = getHubConfigRow()
    if (!config) return false
    if (config.remoteEpoch === epoch) return false
    const had = config.remoteEpoch !== null
    if (had) {
      logger.info(
        LOG_SOURCE,
        `hub epoch ${config.remoteEpoch} → ${epoch}: dropping the cached remote rows and pulling from zero`
      )
      resetRemoteCache()
    }
    upsertHubConfig({ remoteEpoch: epoch })
    return had
  }

  private scheduleRetry(retryAfterMs?: number): void {
    if (this.retryTimer) return
    // A pressed sync under the env gate must not leave a timer behind: the user
    // asked for ONE request, not for a ladder of them.
    if (this.trafficSuppressed()) return
    const laddered =
      BACKOFF_MS[this.backoffAttempt] ??
      Math.min(
        BACKOFF_CEILING_MS,
        (BACKOFF_MS[BACKOFF_MS.length - 1] ?? 300_000) *
          2 ** (this.backoffAttempt - BACKOFF_MS.length + 1)
      )
    const delay = Math.min(retryAfterMs ?? laddered, BACKOFF_CEILING_MS)
    this.backoffAttempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.runSync('timer')
    }, delay)
  }

  private stopTimers(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.clearTimer('debounce')
  }

  private clearTimer(which: 'debounce' | 'retry'): void {
    if (which === 'debounce' && this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (which === 'retry' && this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private trafficSuppressed(): boolean {
    return envFlag(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  }

  private setState(next: UsageHubState): void {
    if (this.state === next) return
    this.state = next
    try {
      emitEvent('usage-hub:changed', [])
    } catch {
      /* the window may be gone — the same guard every other emitter uses */
    }
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * The unions on the wire are STRINGS, and a remote row may carry a value this
 * build has no name for — a newer machine's billing type, a future origin.
 * Every one is normalised to the union's `unknown` member here rather than cast,
 * so a value from the future is stored as honestly unknown instead of flowing
 * into the cost rule as a type the code believes it understands.
 */
function asBillingType(value: string): RemoteUsageBucketRow['billingType'] {
  return value === 'subscription' || value === 'free' || value === 'apiKey' ? value : 'unknown'
}

/**
 * `origin` has no `unknown` member, so a value this build cannot name becomes
 * `session` — the neutral default `usageEventParams` already applies to a local
 * row that states none, and the one the dashboard's Delegated section excludes
 * rather than mis-attributes.
 */
function asOrigin(value: string): RemoteUsageBucketRow['origin'] {
  return value === 'session' || value === 'child' || value === 'dispatch' ? value : 'session'
}

function toBucketRow(bucket: RemoteBucket): RemoteUsageBucketRow {
  return {
    deviceId: bucket.deviceId,
    rev: bucket.rev,
    hourUtc: bucket.hourUtc,
    accountKey: bucket.accountKey,
    billingType: asBillingType(bucket.billingType),
    engineId: bucket.engineId,
    vendorId: bucket.vendorId,
    modelId: bucket.modelId,
    origin: asOrigin(bucket.origin),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    cacheWrite1hTokens: bucket.cacheWrite1hTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    apiCostUsd: bucket.apiCostUsd,
    billedCostUsd: bucket.billedCostUsd,
    unbilledApiCostUsd: bucket.unbilledApiCostUsd,
    unknownApiCostCount: bucket.unknownApiCostCount,
    unknownBilledCostCount: bucket.unknownBilledCostCount,
    requestCount: bucket.requestCount,
    source: bucket.source === 'seed' ? 'seed' : 'rollup'
  }
}

function toWindowRow(window: RemoteWindow): RemoteUsageWindowRow {
  return {
    deviceId: window.deviceId,
    accountKey: window.accountKey,
    windowKind: window.windowKind,
    canonicalEnd: window.canonicalEnd,
    windowStart: window.windowStart,
    windowMinutes: window.windowMinutes,
    peakPercent: window.peakPercent,
    apiCostUsd: window.apiCostUsd,
    billedCostUsd: window.billedCostUsd,
    unknownCostCount: window.unknownCostCount,
    inputTokens: window.inputTokens,
    outputTokens: window.outputTokens,
    cacheWriteTokens: window.cacheWriteTokens,
    cacheReadTokens: window.cacheReadTokens,
    sampleCount: window.sampleCount,
    closed: window.closed,
    updatedAt: window.updatedAt
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A JSON body, or null. A hub that answers HTML is a hub whose answer we ignore. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * `Retry-After`, in milliseconds — seconds or an HTTP date, clamped to
 * [1 s, 1 h]. Null when the header said nothing usable, which leaves the ladder
 * to decide.
 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1_000), BACKOFF_CEILING_MS)
  }
  const at = Date.parse(header)
  if (Number.isNaN(at)) return null
  return Math.min(Math.max(at - Date.now(), 1_000), BACKOFF_CEILING_MS)
}

/** The process-wide client. One hub per machine, one client for it. */
export const usageHubClient = new UsageHubClient()
