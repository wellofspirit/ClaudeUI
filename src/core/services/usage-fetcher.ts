/**
 * Fetches Claude account usage (5hr session / 7-day rate windows).
 *
 * Primary path (real-time): cli.js emits a `rate_limit_event` whenever a
 * subscription window's rounded percentage or reset time moves, carrying every
 * window's utilization and reset parsed from the `anthropic-ratelimit-unified-*`
 * response headers (`rate_limit_info.unifiedWindows`). ClaudeSession forwards
 * them via `updateFromRateLimitWindows()` — zero extra API calls.
 *
 * Secondary path (background poll every 30 min): Direct HTTP call to
 * GET /api/oauth/usage for supplementary data not in the headers
 * (per-model 7-day breakdowns, extra_usage/overage info).
 *
 * Fallback: SDK service session relay (getUsage control message) when the
 * direct call fails (e.g., no credentials, auth error).
 *
 * Disk cache (`~/.claude/ui/usage-cache.json`): Persists lastUsage so cold
 * starts can display data immediately without an API call.
 */

import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { getCliVersion } from './claude-session'
import { emitEvent } from './sync-host'
import type { AccountUsage, BillingType, RateWindow } from '../../shared/types'
import type { RateLimitWindowInfo } from '../sdk/types'
import { logger } from './logger'
import { getAccount, updateAccountIdentity } from './db'
import {
  activeClaudeAttribution,
  claudeAccountLabel,
  claudeBillingTypeFromProfile,
  isUnresolvedMarker,
  type AccountLogEntry,
  type AccountLogMarker,
  type AccountLogRecord
} from './usage-windows'
import {
  claudeLimitWindows,
  fetchClaudeUsage,
  parseUsageResponse,
  type ClaudeUsageError,
  type CredentialsFile,
  type OAuthCredentials
} from './claude-usage-api'
import { recordLimitSamples } from './window-samples'
import { accountState, buildClaudeAccountRef } from '../host'
import { getSecurestorageEnv, onSecurestorageEnvChange } from '../sdk/securestorage-env'
import { apiKeyAccountKey } from './account-key-hash'
import { apiKeyAccountLabel } from '../../shared/account-key'
import {
  claudeDirAccountKey,
  repairClaudeIdentityOnce,
  resolveClaudeDirIdentity,
  skipClaudeIdentityRepair,
  type ClaudeDirIdentity
} from './claude-account-identity'

/**
 * The currently authenticated Claude account.
 *
 * Under multi-account it is what the ACTIVE dir's own credential resolves to
 * (`/api/oauth/profile`, S2e); in single-account mode it is `~/.claude.json`'s
 * `oauthAccount`. Same three facts either way.
 */
export interface ActiveAccount {
  uuid: string
  email: string
  /**
   * The subscription this account is on (ADR-071 §3's `anthropic:<org>:…`).
   * Optional because the single-account source is not guaranteed to carry it —
   * an account with no organization id is attributable by email but not by key.
   */
  organizationUuid?: string
  /**
   * Display only — what tells two subscriptions under one email apart. On the
   * dir path it comes from the account row's login-captured `organization`
   * column, not from the profile body (which carries no name), so an account
   * that has never completed a login in this app has none.
   */
  organizationName?: string
  /**
   * The account key OUTRIGHT, for an account that has no uuid pair to build one
   * from: a Claude API key, identified by a digest of the key (S2f). `uuid`
   * holds the same string, because `usage_window_sample.account_uuid` is NOT
   * NULL and the ChatGPT accounts already file their key there.
   */
  accountKey?: string
  /**
   * How this account is billed — the SAME value the account-log record carries,
   * so a row written live and a row attributed to this account by time cannot
   * disagree.
   *
   * It is here because the profile's `billing_type` is the only signal that
   * separates a `usage_based` OAuth account from a plan, and nothing outside
   * this class resolves it: a caller that has to name the account NOW (the
   * dispatcher's Claude target) cannot wait on a file read or a request.
   */
  billingType: BillingType
}

// ---------------------------------------------------------------------------
// Constants — match Claude Code's internal cli.js exactly
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const IS_MACOS = platform() === 'darwin'

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes (supplementary data only)
const CACHE_STALE_MS = 10 * 60 * 1000 // 10 minutes — skip API call on startup if cache is fresher
const CACHE_WRITE_DEBOUNCE_MS = 30_000 // 30s — match block-usage recalc cadence
const CACHE_DIR = join(homedir(), '.claude', 'ui')
const CACHE_PATH = join(CACHE_DIR, 'usage-cache.json')
const CLAUDE_JSON_PATH = join(homedir(), '.claude.json')
const ACCOUNT_LOG_DIR = join(CACHE_DIR, 'usage')
const ACCOUNT_LOG_PATH = join(ACCOUNT_LOG_DIR, 'account-log.jsonl')

/**
 * Backoff for a read of the ACTIVE account that could not be completed (S2g
 * part 3, generalised in round 3): 5 s, 15 s, 60 s, then this cadence.
 *
 * Two causes arm it, and neither is an answer from the endpoint: an identity
 * that could not be read, and a usage read that failed for a transient reason.
 * A refusal never does — retrying it would spend grants on an account that has
 * said no — and neither does a 429, which has its own handling.
 *
 * Every attempt re-reads the credentials file first, because cli.js rewrites it
 * the moment the user sends a turn — so the usual recovery is that a later
 * attempt finds a fresh access token and spends nothing at all. The 30-minute
 * poll is far too slow for this: on 2026-09-21 it left thirteen minutes of
 * turns keyed to the account the user had just switched AWAY from.
 *
 * The steady cadence is the standing cost of a fault that never clears: one
 * `/api/oauth/profile` GET every five minutes for a folder whose identity stays
 * unread, and one `/api/oauth/usage` GET every five minutes while a reading
 * keeps failing. Both stop the moment they succeed, and `stopPolling` clears
 * the timer.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000]
const RETRY_STEADY_MS = 5 * 60 * 1000

/** Delay after the 5h window expires before proactively re-fetching usage. */
const WINDOW_EXPIRY_FETCH_DELAY_MS = 10_000
/** Throttle for fetchIfWindowUnknown() — avoid hammering on bursty JSONL updates. */
const UNKNOWN_WINDOW_FETCH_THROTTLE_MS = 30_000

/**
 * Construct the User-Agent header matching the CLI's jO() function.
 * The CLI uses "claude-code/<VERSION>" where VERSION comes from its
 * embedded build config. We read it from the vendored CLI's version.json.
 */
export function getCliUserAgent(): string {
  try {
    return `claude-code/${getCliVersion()}`
  } catch {
    return 'claude-code/2.1.0'
  }
}

/** The account-log dedup subject: which subscription the last record named. */
interface LoggedAccountPair {
  accountUuid: string
  organizationUuid: string | undefined
  /** Set for an API-key account, whose key is not derived from the pair (S2f). */
  accountKey: string | undefined
}

/**
 * Whether the account log already names this subscription. Compared as a PAIR
 * rather than as one encoded string, so no separator has to be assumed absent
 * from either uuid.
 */
function samePair(a: LoggedAccountPair | null, b: LoggedAccountPair): boolean {
  return (
    a !== null &&
    a.accountUuid === b.accountUuid &&
    a.organizationUuid === b.organizationUuid &&
    a.accountKey === b.accountKey
  )
}

// ---------------------------------------------------------------------------
// Utilization normalization
// ---------------------------------------------------------------------------

/**
 * Convert a utilization value to a 0–100 percentage.
 *
 * Two sources provide utilization in different scales:
 *   - API (`/api/oauth/usage`): already 0–100 (percentage)
 *   - Rate limit headers / events: 0–1 (fraction)
 *
 * This helper makes the conversion explicit so callers can't accidentally
 * store a fraction where a percentage is expected (or vice versa).
 */
function toUsedPercent(value: number, scale: 'fraction' | 'percent'): number {
  return scale === 'fraction' ? value * 100 : value
}

// ---------------------------------------------------------------------------
// Session getter type (for SDK fallback)
// ---------------------------------------------------------------------------

/** Returns usage data via SDK control message, or null if unavailable. */
export type SessionUsageGetter = () => Promise<Record<string, unknown> | null>

// ---------------------------------------------------------------------------
// UsageFetcher class
// ---------------------------------------------------------------------------

export class UsageFetcher {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastUsage: AccountUsage | null = null
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  private sessionGetter: SessionUsageGetter | null = null
  private userAgent = getCliUserAgent()
  private cacheWriteTimer: ReturnType<typeof setTimeout> | null = null
  private activeAccount: ActiveAccount | null = null
  /**
   * Last (accountUuid, organizationUuid) PAIR written to the account log
   * (avoid duplicate records). The pair, not the uuid alone: one person moving
   * between two organizations keeps one account uuid, and ADR-071 §3 keys each
   * organization as its own subscription, so a uuid-only comparison would
   * never log the move and every later row would name the wrong subscription.
   */
  private lastLoggedAccountPair: LoggedAccountPair | null = null
  /** The whole last record, which the one-shot identity repair reads back. */
  private lastLoggedRecord: AccountLogRecord | null = null
  private accountLogSeeded = false
  /**
   * The resolved identity of one credential file, remembered until that file
   * changes (S2e).
   *
   * Keyed by mtime AND size so a re-login — the one event that puts a different
   * account behind the same path — misses, while the half-hourly poll costs no
   * request at all. An identity is not a reading: it moves only when the
   * credential does.
   */
  private identityCache: {
    dir: string
    mtimeMs: number
    size: number
    identity: ClaudeDirIdentity
  } | null = null
  /**
   * Which dir `activeAccount` was RESOLVED for, or null in Keychain mode and
   * before the first resolve of the process.
   *
   * Only a successful resolve writes it (S2g): it is what tells "this folder's
   * endpoint is briefly down, keep the account we already read" apart from "the
   * folder moved and we have never read it", and the second case is the one
   * whose rows must not be lent to the previous account.
   */
  private activeAccountDir: string | null = null
  /**
   * False until the first `trackActiveAccount` pass of the process has finished.
   *
   * "At boot" is a real distinction — it is the one moment where an unreadable
   * identity may mean nothing moved — and it cannot be read off
   * `activeAccountDir`, which the single-account and API-key paths reset to null
   * mid-session (round 2, M9).
   */
  private firstTrackedPassDone = false
  /** Unsubscribe from the account-switch hook, while polling. */
  private unsubscribeSwitch: (() => void) | null = null
  /**
   * What this process decided about a folder whose identity it could not read
   * (S2g), and which folder that was.
   *
   * `markerTs` is the instant of the marker in the account log, or null for
   * "nothing moved, nothing deferred" (the boot case below). While a marker is
   * open, a Claude transcript row after it is DEFERRED rather than written;
   * closing it appends the real record at that same instant, so the rows land
   * with their own timestamps under the account that ran them.
   *
   * `dir: null` means the marker was read back off the log at startup — a
   * deferral that outlived the process that opened it. The folder cannot have
   * moved while the app was down (`AccountManager` writes the pointer), so the
   * first folder this process sees is taken to be the marker's.
   *
   * ONE decision per folder, and it is this field rather than the retry episode
   * below that answers "have I already marked this folder": the episode can
   * outlive the decision when another folder resolves in between, and taking it
   * as the memo left a re-switch to a still-unread folder unmarked (round 2, R1).
   */
  private unreadFolder: { dir: string | null; markerTs: number | null } | null = null
  /**
   * What the ONE retry loop is working on: the folder that was applied when it
   * was armed (null in single-account mode), how many tries in it is, and
   * whether the folder's IDENTITY is the thing that could not be read.
   *
   * `identityUnread` decides what an attempt does. While it is set, only the
   * identity is re-read: a full pass would offer the same credential file its
   * own refresh grant on every attempt, which is the spending ADR-071 §6 exists
   * to prevent. Once the identity is in hand, an attempt is a whole pass, so a
   * reading that had failed lands too.
   */
  private retryState: { dir: string | null; attempt: number; identityUnread: boolean } | null = null
  /** The retry loop's ONE timer. Cleared by a resolve, a new cause, and stop. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The credentials-file version a refresh grant has already been spent on and
   * REFUSED by the endpoint (ADR-071 §6 applied to the retry loop).
   *
   * Keyed by mtime and size like {@link identityCache}, because that pair is
   * what changes when cli.js rotates the file. While it has not changed, a
   * second refresh would offer the endpoint the very token it just rejected.
   *
   * ONE slot, deliberately: the fetcher reads the ACTIVE credential and nothing
   * else, so two paths hold a refusal at once only across a switch, where the
   * new folder's first read is the one that matters. A dashboard sweep of
   * STORED accounts does not come through here (it has its own reads, with
   * `allowRefresh` decided per account), so the slot cannot be evicted by
   * another account's failure mid-retry.
   */
  private refreshRefusedOn: { path: string; mtimeMs: number; size: number } | null = null
  /**
   * Why the direct read of THIS pass failed, or null when it succeeded.
   *
   * `fetch` reads it to decide whether to retry: only `unavailable` is a
   * transient fault. It is on the instance rather than returned because
   * `fetchDirect` answers the older `AccountUsage | null` contract that the SDK
   * relay's fallback is built on, and widening that would touch every caller.
   */
  private lastDirectFailure: ClaudeUsageError | null = null
  /** One-shot timer firing shortly after the 5h window expires. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private lastFetchStartedAt = 0

  /** Set the SDK session fallback getter. */
  setSessionGetter(getter: SessionUsageGetter): void {
    this.sessionGetter = getter
  }

  /** Update the polling interval (in seconds). Restarts the timer if running. */
  setIntervalSecs(secs: number): void {
    const ms = Math.max(30, secs) * 1000
    if (ms === this.pollIntervalMs) return
    this.pollIntervalMs = ms
    if (this.pollTimer) {
      this.stopPolling()
      this.startPolling()
    }
  }

  /** Start background polling. Uses disk cache to avoid API calls on every launch. */
  startPolling(): void {
    if (this.pollTimer) return

    // Try disk cache first — if fresh AND it carries an unexpired 5h window,
    // push to renderer and skip the initial API fetch. A cache without an
    // indicative window (no resetsAt, or already expired) can't anchor block
    // grouping, so fetch immediately in that case.
    this.loadCache()
      .then((cached) => {
        const windowIndicative =
          cached?.fiveHour?.resetsAt != null &&
          new Date(cached.fiveHour.resetsAt).getTime() > Date.now()
        if (cached) {
          this.publish(cached)
          this.scheduleExpiryFetch()
          logger.debug(
            'UsageFetcher',
            `Loaded cache (age ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s)`
          )
        }
        if (!cached || !windowIndicative) {
          this.fetch().catch((err) => {
            logger.warn('UsageFetcher', 'Initial fetch failed', err)
          })
        } else {
          // `fetch()` is the only thing that resolves the active account, so a
          // fresh cache used to leave the app with NO account until the first
          // poll half an hour in — and with it, no window samples and no chance
          // to run S2e's one-shot repair. Resolve it now, without making the
          // cached reading wait on a network call.
          void this.trackActiveAccount().then(() => {
            // The cached payload went out before the account was known, so the
            // popup's heading (and this reading's window samples) would wait
            // half an hour for the first poll. Re-publish what is already on
            // screen, now that it can be named.
            if (this.lastUsage) this.publish(this.lastUsage)
          })
        }
      })
      .catch(() => {
        // Cache read failed — fetch immediately
        this.fetch().catch((err) => {
          logger.warn('UsageFetcher', 'Initial fetch failed', err)
        })
      })

    // The account can move while the app runs (ADR-015's switch), and the
    // identity is the dir's, not the machine's. `AccountManager` lives in main
    // and core cannot import it, so the credential-dir pointer is the seam.
    this.unsubscribeSwitch ??= onSecurestorageEnvChange(() => {
      // THE SWITCH INSTANT, taken before any await (S2g part 1). Every turn
      // after it runs on the new folder — `AccountManager.persistAndApply`
      // cancels the live sessions — so this, and not the moment the identity
      // read happens to come back, is where the new account's spend begins.
      // Reading the identity costs a network round trip on every switch (the
      // cache holds one folder), and on 2026-09-21 it took thirteen minutes.
      const switchAt = Date.now()
      // `fetch()` tracks the account first, so the limits and the sample land
      // under the new one in the same pass.
      this.fetch(switchAt).catch((err) => {
        logger.warn('UsageFetcher', 'Account-switch fetch failed', err)
      })
    })

    this.pollTimer = setInterval(() => {
      this.fetch().catch((err) => {
        logger.warn('UsageFetcher', 'Poll fetch failed', err)
      })
    }, this.pollIntervalMs)
  }

  /** Stop background polling. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.retryState = null
    this.clearRetry()
    this.unsubscribeSwitch?.()
    this.unsubscribeSwitch = null
  }

  /**
   * Fetch usage and push to the renderer. Returns the result.
   *
   * `switchAt` is the instant the ACTIVE credential folder moved, and only the
   * switch listener passes it: an account-log record written because of a switch
   * is stamped with the switch, not with the moment the identity read returned
   * (S2g). Every other caller means "now".
   */
  async fetch(switchAt?: number): Promise<AccountUsage> {
    this.lastFetchStartedAt = Date.now()
    // Track the authenticated account alongside usage (cheap local read)
    await this.trackActiveAccount(switchAt)

    const usage = await this.fetchUsage()

    if (!usage.error) {
      this.lastUsage = usage
    } else if (this.lastUsage) {
      this.lastUsage = { ...this.lastUsage, error: usage.error }
    } else {
      this.lastUsage = usage
    }

    // A reading that could not be taken for a TRANSIENT reason retries on the
    // backoff rather than waiting out the half-hourly poll (round 3, item 1).
    // A refusal and a 429 are answers, and neither arms anything. One that
    // succeeded retires a retry armed by an earlier failure.
    if (usage.error && this.lastDirectFailure === 'unavailable') this.armRetry(false)
    else if (!usage.error) this.retireReadRetry()

    this.publish(this.lastUsage)
    this.scheduleCacheWrite()
    this.scheduleExpiryFetch()

    return this.lastUsage
  }

  /**
   * Fetch promptly when local activity is observed while no (or an expired)
   * 5h window is known — a new window has likely just started and we want
   * its resets_at without waiting for the regular poll. Throttled.
   */
  fetchIfWindowUnknown(): void {
    const resetsAt = this.lastUsage?.fiveHour?.resetsAt
    const windowKnown = resetsAt != null && new Date(resetsAt).getTime() > Date.now()
    if (windowKnown) return
    if (Date.now() - this.lastFetchStartedAt < UNKNOWN_WINDOW_FETCH_THROTTLE_MS) return
    logger.debug('UsageFetcher', 'Activity with no known 5h window — fetching usage')
    this.fetch().catch((err) => {
      logger.warn('UsageFetcher', 'Unknown-window fetch failed', err)
    })
  }

  /** Get the last cached result (may be null). */
  getLastUsage(): AccountUsage | null {
    return this.lastUsage
  }

  /** The currently authenticated account, if known. */
  getActiveAccount(): ActiveAccount | null {
    return this.activeAccount
  }

  /** The active account's UUID, or undefined if not yet known. */
  getActiveAccountUuid(): string | undefined {
    return this.activeAccount?.uuid
  }

  // -------------------------------------------------------------------------
  // Account tracking
  // -------------------------------------------------------------------------

  /**
   * Resolve which Claude account is active, and append a record to the account
   * log when it changes. The log lets block-usage attribute JSONL entries to
   * the account active at their timestamp.
   *
   * TWO SOURCES, AND ONLY ONE OF THEM IS TRUSTWORTHY PER MODE (S2e).
   *
   *  - Multi-account (a credential dir is set): the dir's OWN credential,
   *    through `/api/oauth/profile`. `~/.claude.json` is shared by every dir
   *    and by the terminal `claude`, and cli.js rewrites its `oauthAccount`
   *    only when it refetches the profile — so it names whichever cli.js
   *    process refetched last, which is routinely the wrong account. It is not
   *    read at all on this path.
   *  - Single account (no dir): `~/.claude.json`, unchanged. There is one
   *    credential, one account, and nothing for the file to be wrong about.
   *
   * The record carries the organization and the billing type (ADR-071 §3),
   * because a row attributed by time to a PAST account has nothing else left to
   * read — whatever the log did not write down about that account is gone by
   * the time the row is built.
   */
  private async trackActiveAccount(switchAt?: number): Promise<void> {
    const dir = getSecurestorageEnv()?.dir
    // Multi-account is ON but no dir has been applied to this process: the
    // shared file names whichever account some cli.js refetched last, and the
    // pointer says that is not necessarily the active one. A record written
    // here re-attributes every turn after it (incident, 2026-09-21), so the
    // path refuses outright — no read, no record, no repair marker.
    //
    // A NULL account state is not this case: headless and the test harness
    // wire no host, and there the single credential is what the file describes.
    if (!dir && accountState()?.enabled === true) {
      logger.debug('UsageFetcher', 'multi-account enabled with no dir applied — account not read')
      return
    }
    try {
      if (dir) await this.trackAccountFromDir(dir, switchAt)
      else await this.trackAccountFromClaudeJson(switchAt)
    } catch (err) {
      logger.debug('UsageFetcher', `Account tracking failed: ${err}`)
    } finally {
      this.firstTrackedPassDone = true
    }
  }

  /**
   * Is `dir` still the applied credential folder?
   *
   * Asked after every await on the folder path (round 2, R3). Two switches can
   * straddle one in-flight profile read, and a read that comes back for a folder
   * the app has already left must touch nothing: a late FAILURE would mark a
   * switch instant while another folder is applied, deferring that folder's real
   * spend, and a late SUCCESS would back-stamp a record over turns that ran
   * somewhere else. The pass is simply dropped; the folder that IS applied has
   * its own pass, from its own switch.
   */
  private stillApplied(dir: string): boolean {
    if (getSecurestorageEnv()?.dir === dir) return true
    logger.debug(
      'UsageFetcher',
      `account ${basename(dir)} was switched away from mid-read — dropping the pass`
    )
    return false
  }

  /** The multi-account path: the dir's own credential names the account. */
  private async trackAccountFromDir(dir: string, switchAt?: number): Promise<void> {
    // Before the read, not after it: the boot check below compares the folder's
    // own row against the log's last record, and closing a marker needs to know
    // there is one. Seeding is one-shot, so this costs nothing per poll.
    await this.seedAccountLog()
    if (!this.stillApplied(dir)) return
    const identity = await this.resolveDirIdentity(dir)
    if (!this.stillApplied(dir)) return
    if (!identity) {
      await this.deferUnreadIdentity(dir, switchAt ?? Date.now())
      return
    }

    // The profile body carries no organization NAME, and the label is the only
    // thing on screen that tells two subscriptions under one email apart — so
    // it comes from the row cli.js's own login response filled in for this dir.
    const organizationName = this.dirOrganizationName(dir)

    this.activeAccountDir = dir
    this.activeAccount = {
      uuid: identity.accountUuid,
      email: identity.email,
      organizationUuid: identity.organizationUuid,
      ...(organizationName ? { organizationName } : {}),
      // The profile's own answer, with `ClaudeAuthProvider`'s probe as the
      // fallback for a billing type outside cli.js's vocabulary — the same
      // two signals, in the same order, as the single-account path.
      billingType:
        identity.billingType !== 'unknown'
          ? identity.billingType
          : (buildClaudeAccountRef()?.billingType ?? 'unknown')
    }
    this.rememberAccountIdentity(this.activeAccount)

    const settled = this.settleUnreadIdentity(dir, switchAt)
    const staleRecord = this.lastLoggedRecord
    await this.appendAccountLogIfMoved(this.activeAccount, {
      ts: settled.from,
      force: settled.releasesDeferred
    })
    // After the append, the log's last record IS the dir — so the repair reads
    // the one captured before it, which is the stale attribution it has to move.
    repairClaudeIdentityOnce({
      identity,
      ...(organizationName ? { organizationName } : {}),
      lastRecord: staleRecord
    })
    if (settled.releasesDeferred) this.flushDeferredClaudeRows(settled.from)
  }

  /**
   * The identity of a folder could not be read. Decide whether this is a SWITCH
   * whose rows have to be deferred, and keep retrying either way (S2g part 2).
   *
   * @param at the switch instant, or now for a boot or a poll.
   */
  private async deferUnreadIdentity(dir: string, at: number): Promise<void> {
    // A dir whose account we are STILL HOLDING keeps what it had — the endpoint
    // being down says nothing about who the account is, and no switch happened,
    // so the rows after it still belong to the account we read.
    //
    // Both halves matter (round 3, item 2). `activeAccountDir` alone is stale
    // after another folder's unread pass nulled the account: a switch away and
    // back, with the credential rewritten in between so the cache misses, would
    // return here with no account, the other folder's marker still open and
    // nothing retrying.
    if (this.activeAccountDir === dir && this.activeAccount !== null) return

    // A dir we cannot name gets nothing in memory: a row keyed to the previous
    // dir's subscription is the exact bug this replaced.
    this.activeAccount = null
    // ONE decision per folder, taken from `unreadFolder` and not from the retry
    // episode (round 2, R1): a folder can come back unread AFTER another folder
    // resolved, and the episode from its first switch may still be running.
    if (this.unreadFolder?.dir === null) {
      // A restart INSIDE the gap: the log already carries the marker, stamped
      // with the switch this process never saw. One boundary, not two.
      this.unreadFolder = { dir, markerTs: this.unreadFolder.markerTs }
    } else if (this.unreadFolder?.dir !== dir) {
      // A marker belonging to ANOTHER folder is deliberately NOT reused. Its gap
      // holds turns that ran on a credential we still cannot read, and the new
      // marker is what stops the rows after THIS switch from resolving to the
      // record in between. The abandoned gap is bounded by DEFERRAL_MAX_MS.
      this.unreadFolder = { dir, markerTs: await this.decideUnreadMarker(dir, at) }
    }
    this.armRetry(true)
  }

  /**
   * Write the marker that defers this folder's rows, unless nothing moved, and
   * answer the instant it defers from (null when nothing is deferred).
   *
   * THE BOOT CASE. On the first pass of the process there is no previous folder
   * to have moved away from, so an unreadable identity is only a problem if the
   * log's last record names a DIFFERENT account than this folder's own
   * `account` row does. When they agree, time-based attribution is still right
   * and deferring would hold rows back for nothing.
   */
  private async decideUnreadMarker(dir: string, at: number): Promise<number | null> {
    if (!this.firstTrackedPassDone && this.folderMatchesLastRecord(dir)) {
      logger.info(
        'UsageFetcher',
        `active account ${basename(dir)} identity unread at startup, but the log already names it — nothing deferred`
      )
      return null
    }
    await this.appendUnresolvedMarker(at)
    return at
  }

  /**
   * Does this folder's own `account` row name the account the log's last record
   * names? Then nothing moved while we were not looking.
   *
   * The row is written by `rememberAccountIdentity` on every resolved poll, so
   * it survives a restart; an account that has never resolved has none, and
   * that is not a match.
   */
  private folderMatchesLastRecord(dir: string): boolean {
    const last = this.lastLoggedRecord
    if (!last?.accountUuid) return false
    try {
      const uuid = getAccount(basename(dir))?.accountUuid
      return !!uuid && uuid === last.accountUuid
    } catch (err) {
      logger.debug('UsageFetcher', `Account row read failed: ${err}`)
      return false
    }
  }

  /**
   * An identity resolved. Stop retrying, and say from which instant the record
   * takes effect — plus whether that record releases deferred rows.
   *
   * `dir` is null for the single-account and API-key paths, which have no
   * credential folder: an open marker of theirs belongs to a folder whose
   * credential they are not reading, so it is closed from HERE (round 2, R2).
   */
  private settleUnreadIdentity(
    dir: string | null,
    switchAt?: number
  ): { from: number; releasesDeferred: boolean } {
    // Whatever the retry loop was waiting on, it is not waiting any more: this
    // process just resolved an account. Dropping the episode only when it names
    // the resolving folder left a timer running against a folder the app had
    // left, and made the episode look like a marker the next time that folder
    // came back unread (round 2, R1). The pass's own usage read re-arms it if
    // the reading still cannot be taken.
    if (this.retryState) {
      this.retryState = null
      this.clearRetry()
    }
    const unread = this.unreadFolder
    // No deferral: a plain switch takes effect from the SWITCH (S2g part 1),
    // and a boot or a poll from now.
    if (!unread) return { from: switchAt ?? Date.now(), releasesDeferred: false }
    // Either way this record is what stops a marker deferring anything further,
    // so the decision is spent.
    this.unreadFolder = null
    if (unread.markerTs === null) {
      // The boot case: nothing was ever deferred, so there is nothing to force
      // or to re-offer.
      return { from: switchAt ?? Date.now(), releasesDeferred: false }
    }
    // This folder's own marker — or one recovered from the log, whose folder
    // this process never saw. The record takes the MARKER's instant, so every
    // row deferred since the switch lands under the account that ran it.
    if (dir !== null && (unread.dir === null || unread.dir === dir)) {
      return { from: unread.markerTs, releasesDeferred: true }
    }
    // Another folder's gap. Those turns ran on a credential we still cannot
    // read, so they are not lent to whichever account resolved next; this
    // record releases the rows from here on, and DEFERRAL_MAX_MS bounds the
    // gap itself.
    return { from: switchAt ?? Date.now(), releasesDeferred: true }
  }

  // -------------------------------------------------------------------------
  // The retry loop for a read of the ACTIVE account (S2g part 3)
  // -------------------------------------------------------------------------

  /**
   * Arm the ONE retry timer for the folder that is applied now.
   *
   * An unread IDENTITY outranks a failed reading: while it is set an attempt
   * re-reads only the identity, and the attempt count carries over so a second
   * cause does not restart the backoff. A different folder does restart it.
   */
  private armRetry(identityUnread: boolean): void {
    const dir = getSecurestorageEnv()?.dir ?? null
    const existing = this.retryState
    if (existing && existing.dir === dir) {
      existing.identityUnread ||= identityUnread
    } else {
      this.retryState = { dir, attempt: 0, identityUnread }
      this.clearRetry()
    }
    this.scheduleRetry()
  }

  /**
   * A reading was taken, so a retry armed by a FAILED READING has done its job.
   *
   * An unread identity is not retired here: it is settled by the resolve, and
   * until then a reading can succeed on a folder whose owner is still unknown.
   */
  private retireReadRetry(): void {
    if (!this.retryState || this.retryState.identityUnread) return
    this.retryState = null
    this.clearRetry()
  }

  /** Schedule the next attempt, at the delay this attempt count has earned. */
  private scheduleRetry(): void {
    if (this.retryTimer) return
    const attempt = this.retryState?.attempt ?? 0
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_STEADY_MS
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.runRetry().catch((err) => {
        logger.debug('UsageFetcher', `retry failed: ${err}`)
      })
    }, delay)
  }

  private clearRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /**
   * One attempt.
   *
   * While the IDENTITY is what could not be read, only that is re-read: a whole
   * pass would offer the same credential file its own refresh grant every time,
   * which is the spending ADR-071 §6 exists to prevent. Once it resolves — or
   * when the identity was never the problem — the attempt is a full pass, so a
   * reading that had failed lands with its window samples in the same go.
   */
  private async runRetry(): Promise<void> {
    const pending = this.retryState
    if (!pending) return
    if ((getSecurestorageEnv()?.dir ?? null) !== pending.dir) {
      // The folder moved on; whatever is applied now has its own pass.
      this.retryState = null
      return
    }
    pending.attempt++
    if (pending.identityUnread) {
      // `trackActiveAccount` re-arms the timer through `deferUnreadIdentity` if
      // the read fails again, so there is nothing to schedule here.
      await this.trackActiveAccount()
      if (this.retryState?.identityUnread) return
    }
    await this.fetch().catch((err) => {
      logger.warn('UsageFetcher', 'Retry fetch failed', err)
    })
  }

  /**
   * Re-offer the Claude rows that were deferred while the identity was unread.
   *
   * The account log now names the account from the switch instant onward, so the
   * transcript entries that were skipped have to be offered again — and the
   * reconciler's Claude pass IS that offer: it re-parses every transcript in the
   * scan window through `block-usage` (which reloads the log, because it just
   * changed) and re-inserts. `ON CONFLICT(message_id) DO NOTHING` makes every
   * row that already landed a no-op, so there is no queue to keep and nothing
   * here has to know which files changed.
   *
   * The hourly buckets the dashboard reads are rebuilt by the next
   * recalculation — the JSONL watcher's, or the reconciler's own ten-minute
   * tick — which is also what keeps this out of the dev build's snapshot
   * writes. So the dashboard lags by up to that tick and is never wrong.
   *
   * Dynamic import because `usage-reconciler` statically imports `block-usage`,
   * which imports this module: the same cycle `claude-session` and `session.ipc`
   * avoid the same way.
   */
  private flushDeferredClaudeRows(since: number): void {
    void import('./usage-reconciler')
      .then(({ usageReconciler }) => usageReconciler.reconcileClaude())
      .then(() => {
        logger.info(
          'UsageFetcher',
          `re-offered the Claude rows deferred since ${new Date(since).toISOString()}`
        )
      })
      .catch((err) => {
        logger.debug('UsageFetcher', `deferred-row flush failed: ${err}`)
      })
  }

  /**
   * The display name recorded for this dir at its last login, or undefined.
   *
   * Best-effort in the same sense as {@link rememberAccountIdentity}: an
   * unreadable row costs a label, never the poll that wanted one.
   */
  private dirOrganizationName(dir: string): string | undefined {
    try {
      return getAccount(basename(dir))?.organization ?? undefined
    } catch (err) {
      logger.debug('UsageFetcher', `Account row read failed: ${err}`)
      return undefined
    }
  }

  /**
   * The single-account (Keychain) path: `~/.claude.json` is the only source.
   *
   * It takes `switchAt` and closes an open marker like the folder path does
   * (round 2, R2): turning multi-account OFF, or deleting the active account,
   * fires the switch listener and lands here — and if a marker were left open
   * the dedup would swallow this record (the pair is usually unchanged) and
   * every Claude row from then on would be deferred until it aged out.
   */
  private async trackAccountFromClaudeJson(switchAt?: number): Promise<void> {
    const raw = await readFile(CLAUDE_JSON_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as {
      oauthAccount?: {
        accountUuid?: string
        emailAddress?: string
        organizationUuid?: string
        organizationName?: string
        billingType?: string
      }
      /** cli.js's `/login` with a managed key: "the key, source /login managed key". */
      primaryApiKey?: string
    }
    const oauthAccount = parsed.oauthAccount
    const uuid = oauthAccount?.accountUuid
    const email = oauthAccount?.emailAddress
    if (!uuid || !email) {
      await this.trackApiKeyAccount(parsed.primaryApiKey, switchAt)
      return
    }
    const organizationUuid = oauthAccount?.organizationUuid
    const organizationName = oauthAccount?.organizationName
    // Resolved on EVERY read, not only when a record is appended below: the
    // active account has to carry the billing type for a caller attributing
    // a turn right now, and the log only writes on a CHANGE of subscription.
    const billingType = this.claudeBillingType(oauthAccount?.billingType)
    this.activeAccountDir = null
    this.activeAccount = {
      uuid,
      email,
      ...(organizationUuid ? { organizationUuid } : {}),
      ...(organizationName ? { organizationName } : {}),
      billingType
    }
    this.rememberAccountIdentity(this.activeAccount)

    await this.seedAccountLog()
    const settled = this.settleUnreadIdentity(null, switchAt)
    await this.appendAccountLogIfMoved(this.activeAccount, {
      ts: settled.from,
      force: settled.releasesDeferred
    })
    // One credential file, so the shared `~/.claude.json` described it
    // correctly and there is nothing for S2e's re-key to move.
    skipClaudeIdentityRepair('single-account mode')
    if (settled.releasesDeferred) this.flushDeferredClaudeRows(settled.from)
  }

  /**
   * The API-key path: a Claude user with no `oauthAccount` at all (S2f).
   *
   * Every row such a machine writes used to be `unknown`, because the only
   * identity the fetcher looked for was an OAuth one. The account is the KEY —
   * `anthropic:key:<digest>` (ADR-071 §3) — so two keys are two accounts and
   * the same key on two machines is one, which is what ADR-072's hub needs.
   *
   * The environment comes first because it is the same environment cli.js is
   * spawned into, so `ANTHROPIC_API_KEY` is the key the turns will actually be
   * billed against, whatever the file says. `apiKeyHelper` is out of scope: it
   * is a user command, and running one on every poll is a different decision
   * from reading a file.
   *
   * CREDENTIAL BOUNDARY: `key` lives in this function and reaches nothing but
   * {@link apiKeyAccountKey} and {@link apiKeyAccountLabel}. What leaves is a
   * digest and the last four characters — never the key, in the log record, on
   * disk, or in a logger call.
   */
  private async trackApiKeyAccount(fileKey: string | undefined, switchAt?: number): Promise<void> {
    // `||`, not `??`: an env var set to the empty string is not a key, and the
    // file's is the better answer than none (ADR-070 Slice J's rule).
    const key = process.env.ANTHROPIC_API_KEY?.trim() || fileKey?.trim()
    if (!key) return

    const { accountKey } = apiKeyAccountKey('anthropic', key)
    const label = apiKeyAccountLabel('anthropic', key)

    this.activeAccountDir = null
    this.activeAccount = {
      // `usage_window_sample.account_uuid` is NOT NULL and an API key has no
      // uuid, so the key goes there — the same thing the ChatGPT accounts do.
      uuid: accountKey,
      email: label,
      accountKey,
      billingType: 'apiKey'
    }
    // No `rememberAccountIdentity`: that writes the identity onto an ACCOUNT
    // ROW, and this path only runs with no credential dir set — an API key is
    // not per dir. Under a dir the profile read above owns the identity.

    await this.seedAccountLog()
    // Closes an open marker like the two paths above (round 2, R2).
    const settled = this.settleUnreadIdentity(null, switchAt)
    await this.appendAccountLogIfMoved(this.activeAccount, {
      ts: settled.from,
      force: settled.releasesDeferred
    })
    // No per-dir credential, so there is no mis-attributed dir for S2e's
    // one-shot re-key to move.
    skipClaudeIdentityRepair('api-key account')
    if (settled.releasesDeferred) this.flushDeferredClaudeRows(settled.from)
  }

  /**
   * Who the credential in `dir` belongs to, cached until that file changes.
   *
   * The 30-minute poll must not ask the profile endpoint again for an answer
   * that cannot have moved: the only thing that puts a different account behind
   * this path is a re-login, and that rewrites the file. Whether a refresh grant
   * may be spent is {@link refreshAllowedFor}'s answer — this is the ACTIVE
   * account, so cli.js normally keeps its token fresh and a refresh here is the
   * exception (ADR-071 §6).
   */
  private async resolveDirIdentity(dir: string): Promise<ClaudeDirIdentity | null> {
    const credentialsPath = join(dir, '.credentials.json')
    const { mtimeMs, size } = await this.credentialVersion(credentialsPath)
    const cached = this.identityCache
    if (
      mtimeMs > 0 &&
      cached &&
      cached.dir === dir &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size
    ) {
      return cached.identity
    }

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: this.refreshAllowedFor(credentialsPath, mtimeMs, size),
      userAgent: this.userAgent
    })
    if ('error' in result) {
      this.noteRefreshResult(result, credentialsPath, mtimeMs, size)
      logger.info(
        'UsageFetcher',
        `active account ${basename(dir)} identity not read: ${result.error} (${result.detail})`
      )
      return null
    }
    if (mtimeMs > 0) {
      this.identityCache = { dir, mtimeMs, size, identity: result.identity }
    }
    logger.info(
      'UsageFetcher',
      `active account ${basename(dir)} is ${claudeDirAccountKey(result.identity)}`
    )
    return result.identity
  }

  /** A credentials file's version — `{ mtimeMs: 0, size: 0 }` when it is absent. */
  private async credentialVersion(path: string): Promise<{ mtimeMs: number; size: number }> {
    try {
      const info = await stat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      // Not there: a read of it answers `needs-sign-in` without a request, and
      // there is no version to cache or to charge a refresh against.
      return { mtimeMs: 0, size: 0 }
    }
  }

  /**
   * May a read of this credentials file spend a refresh grant? (ADR-071 §6.)
   *
   * No, while a refresh for THIS version of the file has already been POSTed and
   * refused: the endpoint has seen that token and said no, and cli.js has not
   * rewritten the file since, so offering it again only spends grants. It turns
   * back on by itself the moment the file changes — which is what cli.js does
   * as soon as the user sends a turn on the account.
   *
   * Both reads of a credential go through here, the identity and the usage one:
   * they share one file and one grant, and the switch that reaches this path
   * used to POST a refused token twice in a single pass.
   *
   * A MISSING file has no version to latch (round 2, R4). `{0, 0}` is what
   * `credentialVersion` answers for one, and latching it would mean that in
   * single-account Keychain mode — where the credential lives in the Keychain
   * and the file legitimately does not exist — one refused refresh disabled
   * every later refresh for the life of the process.
   */
  private refreshAllowedFor(path: string, mtimeMs: number, size: number): boolean {
    if (mtimeMs <= 0) return true
    const refused = this.refreshRefusedOn
    return !(refused?.path === path && refused.mtimeMs === mtimeMs && refused.size === size)
  }

  /** Remember a refused refresh, so {@link refreshAllowedFor} stops offering it. */
  private noteRefreshResult(
    result: { refreshFailed?: boolean },
    path: string,
    mtimeMs: number,
    size: number
  ): void {
    if (mtimeMs <= 0) return
    if (result.refreshFailed) this.refreshRefusedOn = { path, mtimeMs, size }
  }

  /**
   * Load the log's newest entries once per launch: the last RECORD, which is
   * the dedup and repair subject, and whether the log ends on one of S2g's
   * markers, which means a deferral outlived the process that opened it.
   *
   * Newest by `ts`, with the later line winning a tie — the rule
   * `accountRecordForTimestamp` applies, so this and the log's readers cannot
   * disagree about which entry is in force. (A record written for a switch
   * carries the switch's instant, so a slow identity read racing a second
   * switch can leave the FILE out of order.) A line that does not parse is
   * skipped: a crash mid-append leaves a partial one.
   */
  private async seedAccountLog(): Promise<void> {
    if (this.accountLogSeeded) return
    this.accountLogSeeded = true
    this.lastLoggedAccountPair = null
    try {
      const log = await readFile(ACCOUNT_LOG_PATH, 'utf-8')
      let newestEntry: AccountLogEntry | null = null
      let newestRecord: AccountLogRecord | null = null
      for (const line of log.split('\n')) {
        if (!line.trim()) continue
        let entry: AccountLogEntry
        try {
          entry = JSON.parse(line) as AccountLogEntry
        } catch {
          continue
        }
        if (typeof entry.ts !== 'number' || typeof entry.email !== 'string') continue
        if (!newestEntry || entry.ts >= newestEntry.ts) newestEntry = entry
        if (!isUnresolvedMarker(entry) && (!newestRecord || entry.ts >= newestRecord.ts)) {
          newestRecord = entry
        }
      }
      if (newestRecord) {
        this.lastLoggedRecord = newestRecord
        this.lastLoggedAccountPair = newestRecord.accountUuid
          ? {
              accountUuid: newestRecord.accountUuid,
              organizationUuid: newestRecord.organizationUuid,
              accountKey: newestRecord.accountKey
            }
          : null
      }
      // The folder cannot have moved while the app was down, so this marker
      // belongs to whichever folder this process sees first (`dir: null` until
      // then). Rows after it stay deferred across the restart, which is the
      // whole point of the marker being on disk.
      if (newestEntry && isUnresolvedMarker(newestEntry)) {
        this.unreadFolder = { dir: null, markerTs: newestEntry.ts }
      }
    } catch {
      /* No log yet: nothing is logged, and nothing is deferred. */
    }
  }

  /**
   * Record that the active folder moved at `ts` and we cannot say whose it is.
   *
   * Deliberately NOT the dedup subject: a marker names no account, so
   * `lastLoggedAccountPair` and `lastLoggedRecord` keep pointing at the last
   * real record — which is what S2e's one-shot repair reads, and what the
   * append below compares against when the identity finally resolves.
   */
  private async appendUnresolvedMarker(ts: number): Promise<void> {
    const marker: AccountLogMarker = { ts, email: '', unresolved: true }
    await mkdir(ACCOUNT_LOG_DIR, { recursive: true })
    await appendFile(ACCOUNT_LOG_PATH, JSON.stringify(marker) + '\n', 'utf-8')
    logger.info(
      'UsageFetcher',
      `Active account changed at ${new Date(ts).toISOString()} but its identity could not be read — rows deferred until it can`
    )
  }

  /**
   * Append a record when the subscription moved. No-op otherwise.
   *
   * `ts` is the instant the record takes effect from — the switch's, not the
   * append's (S2g). `force` writes the record even when it names the account
   * the last one already did, which is how a marker gets superseded.
   */
  private async appendAccountLogIfMoved(
    account: ActiveAccount,
    opts: { ts?: number; force?: boolean } = {}
  ): Promise<void> {
    // A pre-ADR-071 last record names no organization, so the first run after
    // the upgrade sees a changed pair and appends one that does. That is how
    // an existing log starts naming subscriptions at all. S2f adds the KEY to
    // the comparison: an API-key account and an OAuth one are different
    // subscriptions, and the key is the only field that says which is which.
    const pair: LoggedAccountPair = {
      accountUuid: account.uuid,
      organizationUuid: account.organizationUuid,
      accountKey: account.accountKey
    }
    if (!opts.force && samePair(this.lastLoggedAccountPair, pair)) return
    this.lastLoggedAccountPair = pair
    const record: AccountLogRecord = {
      ts: opts.ts ?? Date.now(),
      accountUuid: account.uuid,
      email: account.email,
      ...(account.organizationUuid ? { organizationUuid: account.organizationUuid } : {}),
      ...(account.organizationName ? { organizationName: account.organizationName } : {}),
      ...(account.accountKey ? { accountKey: account.accountKey } : {}),
      billingType: account.billingType
    }
    await mkdir(ACCOUNT_LOG_DIR, { recursive: true })
    await appendFile(ACCOUNT_LOG_PATH, JSON.stringify(record) + '\n', 'utf-8')
    this.lastLoggedRecord = record
    logger.info('UsageFetcher', `Active account changed → ${account.email}`)
  }

  /**
   * Write the active account's identity onto its own `account` row (ADR-071 §6).
   *
   * What the limits provider reads back when the account is NOT active, so that
   * a stored account's reading has a key without a second network call. A no-op
   * in single-account mode (no per-account directory, so no row to name) and
   * best-effort: the identity is an optimization for a future read, never a
   * reason to fail the poll that noticed it.
   */
  private rememberAccountIdentity(account: ActiveAccount): void {
    const dir = getSecurestorageEnv()?.dir
    if (!dir) return
    try {
      updateAccountIdentity(basename(dir), {
        accountUuid: account.uuid,
        organizationUuid: account.organizationUuid,
        organizationName: account.organizationName,
        billingType: account.billingType
      })
    } catch (err) {
      logger.debug('UsageFetcher', `Account identity write failed: ${err}`)
    }
  }

  /**
   * How this account is billed, for the log record. Single-account path only —
   * the dir path applies the same two signals to the profile's own answer.
   *
   * `oauthAccount.billingType` is the profile Anthropic itself returned (plan
   * metadata, not a credential), and it is the only signal that separates a
   * `usage_based` OAuth account — billed per token — from a plan. The app's
   * other decision, `ClaudeAuthProvider`'s `inferBillingType`, reads cli.js's
   * `initialize` response, which for an OAuth account can only ever answer
   * `subscription` or `unknown`, and is empty until the first session inits.
   * So it is the FALLBACK here, for a profile field that is absent or holds a
   * value outside cli.js's own vocabulary.
   */
  private claudeBillingType(profileValue: unknown): BillingType {
    return (
      claudeBillingTypeFromProfile(profileValue) ??
      buildClaudeAccountRef()?.billingType ??
      'unknown'
    )
  }

  // -------------------------------------------------------------------------
  // Proactive window-expiry fetch
  // -------------------------------------------------------------------------

  /**
   * Schedule a one-shot fetch shortly after the current 5h window expires,
   * so the UI learns about the roll promptly instead of waiting up to a full
   * poll interval. Rescheduled on every usage update.
   */
  private scheduleExpiryFetch(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    const resetsAt = this.lastUsage?.fiveHour?.resetsAt
    if (!resetsAt) return
    const resetMs = new Date(resetsAt).getTime()
    if (isNaN(resetMs)) return
    const delay = resetMs - Date.now() + WINDOW_EXPIRY_FETCH_DELAY_MS
    if (delay <= 0) return // already expired — fetchIfWindowUnknown covers it
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      logger.debug('UsageFetcher', '5h window expired — proactive usage fetch')
      this.fetch().catch((err) => {
        logger.warn('UsageFetcher', 'Expiry fetch failed', err)
      })
    }, delay)
  }

  // -------------------------------------------------------------------------
  // Real-time rate limit updates from inference headers
  // -------------------------------------------------------------------------

  /**
   * Merge a `rate_limit_event`'s `rate_limit_info.unifiedWindows` into
   * lastUsage. cli.js tracks every window on every response, unlike the
   * top-level `utilization`, which describes only the currently limiting one.
   *
   * Only `five_hour` and `seven_day` have an AccountUsage field;
   * `seven_day_overage_included` (a per-model weekly bucket) does not and is
   * ignored. Every other window keeps its value from the last full read.
   * `utilization` is a fraction and `resetsAt` epoch seconds, converted to the
   * `/api/oauth/usage` scale (percent) and format (ISO string).
   */
  updateFromRateLimitWindows(windows: Record<string, RateLimitWindowInfo>): void {
    const base = this.lastUsage ?? this.defaultUsage()
    let updated = false

    const windowMap: Record<string, keyof AccountUsage> = {
      five_hour: 'fiveHour',
      seven_day: 'sevenDay'
    }

    for (const [key, field] of Object.entries(windowMap)) {
      const data = windows[key]
      if (!data || typeof data.utilization !== 'number') continue

      const window: RateWindow = {
        usedPercent: toUsedPercent(data.utilization, 'fraction'),
        resetsAt:
          typeof data.resetsAt === 'number' ? new Date(data.resetsAt * 1000).toISOString() : null
      }

      ;(base as unknown as Record<string, unknown>)[field] = window
      updated = true
    }

    if (!updated) return

    this.lastUsage = {
      ...base,
      fetchedAt: Date.now(),
      error: null
    }

    this.publish(this.lastUsage)
    this.scheduleCacheWrite()
    this.scheduleExpiryFetch()
  }

  // -------------------------------------------------------------------------
  // Disk cache
  // -------------------------------------------------------------------------

  /** Load cached usage from disk. Returns null if missing or stale. */
  async loadCache(): Promise<AccountUsage | null> {
    try {
      const raw = await readFile(CACHE_PATH, 'utf-8')
      const data = JSON.parse(raw) as AccountUsage
      if (!data.fetchedAt || Date.now() - data.fetchedAt > CACHE_STALE_MS) return null
      // A cache written before sevenDayModels or accountLabel existed has no
      // such key. The label is re-stamped on publish anyway; this keeps the
      // object honest for anything that reads it in between. A pre-S3c file's
      // fabricated 0 % `fiveHour` is deliberately NOT sanitised: it carries no
      // `resetsAt`, so it is not window-indicative, writes no sample and is
      // replaced by the immediate fetch that a non-indicative cache triggers.
      return {
        ...data,
        sevenDayModels: data.sevenDayModels ?? null,
        accountLabel: data.accountLabel ?? null
      }
    } catch {
      return null
    }
  }

  /** Debounced write of lastUsage to disk. */
  private scheduleCacheWrite(): void {
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer)
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = null
      if (!this.lastUsage) return
      mkdir(CACHE_DIR, { recursive: true })
        .then(() => writeFile(CACHE_PATH, JSON.stringify(this.lastUsage), 'utf-8'))
        .catch((err) => {
          logger.debug('UsageFetcher', `Cache write failed: ${err}`)
        })
    }, CACHE_WRITE_DEBOUNCE_MS)
  }

  /**
   * The merge base for a header or `rate_limit_event` update that arrives before
   * any full read. Every window is null: nothing has been observed yet, and a
   * placeholder 0 % five-hour window is exactly what S3c removed.
   */
  private defaultUsage(): AccountUsage {
    return {
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayModels: null,
      extraUsage: null,
      planName: null,
      fetchedAt: Date.now(),
      error: null,
      accountLabel: null
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Record `usage` as the last reading, stamped with the account it describes,
   * and push it.
   *
   * The stamp lands on `lastUsage` rather than only on the pushed copy because
   * `usage:fetch` hands that object straight back to the renderer — a label
   * carried by the push alone would vanish the moment the popup refreshed
   * itself. Every path that produces a reading goes through here, so there is
   * one place that answers "whose meters are these".
   */
  private publish(usage: AccountUsage): void {
    this.lastUsage = {
      ...usage,
      accountLabel: this.activeAccount ? claudeAccountLabel(this.activeAccount) : null
    }
    this.pushToRenderer(this.lastUsage)
  }

  private pushToRenderer(usage: AccountUsage): void {
    // Phase 7: record a window-utilization sample so the WLS apiPercent
    // time-series + 5h block alignment can be sourced from the DB. Best-effort.
    this.recordWindowSampleFromUsage(usage)
    try {
      emitEvent('usage:data', [usage])
    } catch {
      /* Window may have been closed */
    }
  }

  /**
   * Record a usage_window_sample for every window this observation carried —
   * the 5-hour one, the weekly one, and each weekly per-model bucket (ADR-071
   * §6). It used to be the 5-hour window alone, which is all the WLS projection
   * reads; the others are what the limits dashboard and the window-value ledger
   * are built on, and an observation nobody recorded is gone.
   *
   * Skips when there is no account uuid — every sample is filed under an
   * account, and the fetcher cannot name one before `trackActiveAccount` has
   * resolved it. The per-window skips (no reset, expired, unchanged)
   * and the canonical-end snapping live in `recordLimitSamples`, which the
   * provider's inactive-account reads share. Failures are swallowed — advisory.
   */
  private recordWindowSampleFromUsage(usage: AccountUsage): void {
    try {
      if (usage.error) return
      const active = this.activeAccount
      if (!active) return
      const written = recordLimitSamples({
        accountKey: activeClaudeAttribution(active, buildClaudeAccountRef()?.billingType)
          .accountKey,
        accountUuid: active.uuid,
        // Display-only, and for the hub relay alone (ADR-072 §4): a machine
        // where this account is not active shows the reading this one paid for,
        // and it has to be able to name whose it is.
        accountLabel: claudeAccountLabel(active),
        vendorId: 'anthropic',
        plan: usage.planName ?? null,
        windows: claudeLimitWindows(usage)
      })
      // ADR-071 §6's nudge, beside `usage:data`: a client watching LIMITS across
      // vendors reads `usage:limits`, and the active account's readings move
      // here rather than in the provider.
      if (written > 0) emitEvent('usage:limits-changed', [])
    } catch (err) {
      logger.debug('UsageFetcher', `recordWindowSample failed: ${err}`)
    }
  }

  /**
   * Try direct API first (same headers as Claude Code), fall back to SDK relay.
   */
  private async fetchUsage(): Promise<AccountUsage> {
    // 1. Direct API call — identical to CLI's k9q()
    const directResult = await this.fetchDirect()
    if (directResult) return directResult

    // 2. Fallback: SDK service session relay
    if (this.sessionGetter) {
      try {
        const data = await this.sessionGetter()
        if (data !== null && typeof data === 'object') {
          return parseUsageResponse(data)
        }
      } catch (err) {
        logger.debug('UsageFetcher', `SDK fallback failed: ${err}`)
      }
    }

    return this.errorResult('No usage data available')
  }

  // -------------------------------------------------------------------------
  // Direct API — mirrors CLI's k9q() exactly
  // -------------------------------------------------------------------------

  /**
   * The direct `/api/oauth/usage` call for the ACTIVE account, in the shape the
   * relay fallback expects: the usage, or null to mean "try the SDK relay".
   *
   * The call itself lives in `claude-usage-api.ts` now — the limits provider
   * makes the same one against a stored account's own credentials path (ADR-071
   * §6) — so this is the mapping from its typed failures back onto that older
   * contract. Only a 429 is an ANSWER here: it says the account is fine and the
   * relay would be told the same thing, so it becomes an error result rather
   * than a fallback (the regression pin in usage-fetcher-expanded holds this).
   */
  private async fetchDirect(): Promise<AccountUsage | null> {
    const credentialsPath = this.credentialsPath()
    const { mtimeMs, size } = await this.credentialVersion(credentialsPath)
    const result = await fetchClaudeUsage({
      credentialsPath,
      // Still the ACTIVE account, which may refresh — but not with a grant this
      // version of the file has already had refused (see refreshAllowedFor).
      allowRefresh: this.refreshAllowedFor(credentialsPath, mtimeMs, size),
      userAgent: this.userAgent,
      fallbackCredentials: () => this.readKeychainCredentials()
    })
    this.lastDirectFailure = 'usage' in result ? null : result.error
    if ('usage' in result) return result.usage
    this.noteRefreshResult(result, credentialsPath, mtimeMs, size)
    if (result.error === 'rate-limited') {
      logger.debug(
        'UsageFetcher',
        'Direct API returned 429 (rate limited), skipping until next poll'
      )
      return this.errorResult('Rate limited')
    }
    logger.debug('UsageFetcher', `Direct API unavailable: ${result.detail}`)
    return null
  }

  // -------------------------------------------------------------------------
  // Credential management
  // -------------------------------------------------------------------------

  /**
   * Resolve the `.credentials.json` cli.js is actually reading from.
   *
   * Multi-account (ADR-015) points cli.js at a per-account directory via
   * `CLAUDE_SECURESTORAGE_CONFIG_DIR` (set by AccountManager.applyActive()),
   * and the running session refreshes/rotates the token in THAT file — the
   * root `~/.claude/.credentials.json` goes stale and its refresh token gets
   * invalidated. Reading the same dir cli.js uses keeps the direct usage call
   * on the live access token instead of silently failing into the SDK relay.
   * Returns the root path in single-account / Keychain mode (env unset).
   */
  private credentialsPath(): string {
    const dir = getSecurestorageEnv()?.dir
    return dir ? join(dir, '.credentials.json') : CREDENTIALS_PATH
  }

  /**
   * The macOS Keychain credential, when it applies at all.
   *
   * Keychain storage only exists in single-account mode. When multi-account is
   * active, credentials are file-based per ADR-015 (SKIP_SECURESTORAGE) — never
   * the Keychain — so this answers null and the file is the only source.
   */
  private async readKeychainCredentials(): Promise<OAuthCredentials | null> {
    if (!IS_MACOS || getSecurestorageEnv()) return null
    return this.readCredentialsFromKeychain()
  }

  private async readCredentialsFromKeychain(): Promise<OAuthCredentials | null> {
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        execFile(
          '/usr/bin/security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
          { timeout: 5000 },
          (err, stdout, stderr) => {
            if (err) {
              if (
                (err as NodeJS.ErrnoException).code === '44' ||
                stderr?.includes('could not be found')
              ) {
                return resolve('')
              }
              return reject(err)
            }
            resolve(stdout.trim())
          }
        )
      })

      if (!raw) return null
      const parsed = JSON.parse(raw) as CredentialsFile
      if (!parsed.claudeAiOauth?.accessToken) return null
      return parsed.claudeAiOauth
    } catch {
      return null
    }
  }

  private errorResult(message: string): AccountUsage {
    return {
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayModels: null,
      extraUsage: null,
      planName: null,
      fetchedAt: Date.now(),
      error: message,
      accountLabel: null
    }
  }
}

/** Singleton instance */
export const usageFetcher = new UsageFetcher()
