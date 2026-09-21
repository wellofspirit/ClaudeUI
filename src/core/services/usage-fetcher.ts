/**
 * Fetches Claude account usage (5hr session / 7-day rate windows).
 *
 * Primary path (real-time): The SDK emits `rate_limit_event` messages after
 * every inference call, containing utilization and reset data parsed from
 * `anthropic-ratelimit-unified-*` response headers.  ClaudeSession forwards
 * these via `updateFromRateLimitEvent()` — zero extra API calls.
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
import { logger } from './logger'
import { getAccount, updateAccountIdentity } from './db'
import {
  activeClaudeAttribution,
  claudeBillingTypeFromProfile,
  type AccountLogRecord
} from './usage-windows'
import {
  claudeLimitWindows,
  fetchClaudeUsage,
  parseUsageResponse,
  type CredentialsFile,
  type OAuthCredentials
} from './claude-usage-api'
import { recordLimitSamples } from './window-samples'
import { buildClaudeAccountRef } from '../host'
import { getSecurestorageEnv, onSecurestorageEnvChange } from '../sdk/securestorage-env'
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
}

/**
 * Whether the account log already names this subscription. Compared as a PAIR
 * rather than as one encoded string, so no separator has to be assumed absent
 * from either uuid.
 */
function samePair(a: LoggedAccountPair | null, b: LoggedAccountPair): boolean {
  return a !== null && a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid
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
  /** Which dir `activeAccount` was resolved for, or null in Keychain mode. */
  private activeAccountDir: string | null = null
  /** Unsubscribe from the account-switch hook, while polling. */
  private unsubscribeSwitch: (() => void) | null = null
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
          cached?.fiveHour.resetsAt != null &&
          new Date(cached.fiveHour.resetsAt).getTime() > Date.now()
        if (cached) {
          this.lastUsage = cached
          this.pushToRenderer(cached)
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
          void this.trackActiveAccount()
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
      // `fetch()` tracks the account first, so the limits and the sample land
      // under the new one in the same pass.
      this.fetch().catch((err) => {
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
    this.unsubscribeSwitch?.()
    this.unsubscribeSwitch = null
  }

  /** Fetch usage and push to the renderer. Returns the result. */
  async fetch(): Promise<AccountUsage> {
    this.lastFetchStartedAt = Date.now()
    // Track the authenticated account alongside usage (cheap local read)
    await this.trackActiveAccount()

    const usage = await this.fetchUsage()

    if (!usage.error) {
      this.lastUsage = usage
    } else if (this.lastUsage) {
      this.lastUsage = { ...this.lastUsage, error: usage.error }
    } else {
      this.lastUsage = usage
    }

    this.pushToRenderer(this.lastUsage)
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
    const resetsAt = this.lastUsage?.fiveHour.resetsAt
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
  private async trackActiveAccount(): Promise<void> {
    const dir = getSecurestorageEnv()?.dir
    try {
      if (dir) await this.trackAccountFromDir(dir)
      else await this.trackAccountFromClaudeJson()
    } catch (err) {
      logger.debug('UsageFetcher', `Account tracking failed: ${err}`)
    }
  }

  /** The multi-account path: the dir's own credential names the account. */
  private async trackAccountFromDir(dir: string): Promise<void> {
    const identity = await this.resolveDirIdentity(dir)
    if (!identity) {
      // A dir we already resolved keeps what it had — the endpoint being down
      // says nothing about who the account is. A dir we have NOT resolved gets
      // nothing: a row keyed to the previous dir's subscription is the exact
      // bug this replaced, and `unknown` is the honest answer instead.
      if (this.activeAccountDir !== dir) {
        this.activeAccountDir = dir
        this.activeAccount = null
      }
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

    await this.seedAccountLog()
    const staleRecord = this.lastLoggedRecord
    await this.appendAccountLogIfMoved(this.activeAccount)
    // After the append, the log's last record IS the dir — so the repair reads
    // the one captured before it, which is the stale attribution it has to move.
    repairClaudeIdentityOnce({
      identity,
      ...(organizationName ? { organizationName } : {}),
      lastRecord: staleRecord
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

  /** The single-account (Keychain) path: `~/.claude.json` is the only source. */
  private async trackAccountFromClaudeJson(): Promise<void> {
    const raw = await readFile(CLAUDE_JSON_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as {
      oauthAccount?: {
        accountUuid?: string
        emailAddress?: string
        organizationUuid?: string
        organizationName?: string
        billingType?: string
      }
    }
    const oauthAccount = parsed.oauthAccount
    const uuid = oauthAccount?.accountUuid
    const email = oauthAccount?.emailAddress
    if (!uuid || !email) return
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
    await this.appendAccountLogIfMoved(this.activeAccount)
    // One credential file, so the shared `~/.claude.json` described it
    // correctly and there is nothing for S2e's re-key to move.
    skipClaudeIdentityRepair('single-account mode')
  }

  /**
   * Who the credential in `dir` belongs to, cached until that file changes.
   *
   * The 30-minute poll must not ask the profile endpoint again for an answer
   * that cannot have moved: the only thing that puts a different account behind
   * this path is a re-login, and that rewrites the file. `allowRefresh` is true
   * because this is the ACTIVE account — cli.js keeps its token fresh, so a
   * refresh here is the exception, not the rule (ADR-071 §6).
   */
  private async resolveDirIdentity(dir: string): Promise<ClaudeDirIdentity | null> {
    const credentialsPath = join(dir, '.credentials.json')
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(credentialsPath)
      mtimeMs = info.mtimeMs
      size = info.size
      const cached = this.identityCache
      if (cached && cached.dir === dir && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.identity
      }
    } catch {
      // No credential file: the resolve below answers `needs-sign-in`, and
      // nothing is cached against a file that is not there.
    }

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: this.userAgent
    })
    if ('error' in result) {
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

  /** Load the log's last record once per launch — the dedup and repair subject. */
  private async seedAccountLog(): Promise<void> {
    if (this.accountLogSeeded) return
    this.accountLogSeeded = true
    try {
      const log = await readFile(ACCOUNT_LOG_PATH, 'utf-8')
      // Backwards to the last line that PARSES: a crash mid-append leaves a
      // partial one, and the repair reads this record to decide what to move.
      const lines = log.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue
        try {
          const record = JSON.parse(lines[i]) as AccountLogRecord
          if (typeof record.ts !== 'number' || typeof record.email !== 'string') continue
          this.lastLoggedRecord = record
          this.lastLoggedAccountPair = record.accountUuid
            ? { accountUuid: record.accountUuid, organizationUuid: record.organizationUuid }
            : null
          return
        } catch {
          // Try the line before it.
        }
      }
      this.lastLoggedAccountPair = null
    } catch {
      this.lastLoggedAccountPair = null
    }
  }

  /** Append a record when the subscription moved. No-op otherwise. */
  private async appendAccountLogIfMoved(account: ActiveAccount): Promise<void> {
    // A pre-ADR-071 last record names no organization, so the first run after
    // the upgrade sees a changed pair and appends one that does. That is how
    // an existing log starts naming subscriptions at all.
    const pair: LoggedAccountPair = {
      accountUuid: account.uuid,
      organizationUuid: account.organizationUuid
    }
    if (samePair(this.lastLoggedAccountPair, pair)) return
    this.lastLoggedAccountPair = pair
    const record: AccountLogRecord = {
      ts: Date.now(),
      accountUuid: account.uuid,
      email: account.email,
      ...(account.organizationUuid ? { organizationUuid: account.organizationUuid } : {}),
      ...(account.organizationName ? { organizationName: account.organizationName } : {}),
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
    const resetsAt = this.lastUsage?.fiveHour.resetsAt
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
   * Merge rate limit data from an SDK `rate_limit_event` into lastUsage.
   * Called by ClaudeSession when it receives a rate_limit_event message.
   *
   * `resetsAt` is epoch seconds — convert to ISO string for consistency
   * with the `/api/oauth/usage` API response format.
   */
  updateFromRateLimitEvent(info: Record<string, unknown>): void {
    const utilization = info.utilization as number | undefined
    const rateLimitType = info.rateLimitType as string | undefined
    const resetsAt = info.resetsAt as number | undefined

    // Skip events without utilization data (e.g. status-only events)
    if (typeof utilization !== 'number') return

    const window: RateWindow = {
      usedPercent: toUsedPercent(utilization, 'fraction'),
      resetsAt: typeof resetsAt === 'number' ? new Date(resetsAt * 1000).toISOString() : null
    }

    // Map rateLimitType to the AccountUsage field
    const fieldMap: Record<string, keyof AccountUsage> = {
      five_hour: 'fiveHour',
      seven_day: 'sevenDay',
      seven_day_sonnet: 'sevenDaySonnet',
      seven_day_opus: 'sevenDayOpus'
    }

    const field = rateLimitType ? fieldMap[rateLimitType] : undefined
    if (!field) return

    // Build updated usage, preserving other windows from the last full API response
    const base = this.lastUsage ?? this.defaultUsage()
    this.lastUsage = {
      ...base,
      [field]: window,
      fetchedAt: Date.now(),
      error: null
    }

    this.pushToRenderer(this.lastUsage)
    this.scheduleCacheWrite()
    this.scheduleExpiryFetch()
  }

  /**
   * Update from the enriched header_utilization field (from our rate-limit-relay
   * patch). This carries per-window utilization from the parsed response headers
   * (hD4/pf8) — always present, unlike rate_limit_info.utilization which is
   * only set when status is "allowed_warning".
   *
   * Shape: { five_hour?: { utilization: number, resets_at: number }, seven_day?: { ... } }
   */
  updateFromHeaderUtilization(
    headerUtil: Record<string, { utilization: number; resets_at: number }>
  ): void {
    const base = this.lastUsage ?? this.defaultUsage()
    let updated = false

    const windowMap: Record<string, keyof AccountUsage> = {
      five_hour: 'fiveHour',
      seven_day: 'sevenDay'
    }

    for (const [key, field] of Object.entries(windowMap)) {
      const data = headerUtil[key]
      if (!data || typeof data.utilization !== 'number') continue

      const window: RateWindow = {
        usedPercent: toUsedPercent(data.utilization, 'fraction'),
        resetsAt:
          typeof data.resets_at === 'number' ? new Date(data.resets_at * 1000).toISOString() : null
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

    this.pushToRenderer(this.lastUsage)
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
      // A cache written before sevenDayModels existed has no such key.
      return { ...data, sevenDayModels: data.sevenDayModels ?? null }
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

  private defaultUsage(): AccountUsage {
    return {
      fiveHour: { usedPercent: 0, resetsAt: null },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayModels: null,
      extraUsage: null,
      planName: null,
      fetchedAt: Date.now(),
      error: null
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

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
    const result = await fetchClaudeUsage({
      credentialsPath: this.credentialsPath(),
      allowRefresh: true,
      userAgent: this.userAgent,
      fallbackCredentials: () => this.readKeychainCredentials()
    })
    if ('usage' in result) return result.usage
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
      fiveHour: { usedPercent: 0, resetsAt: null },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayModels: null,
      extraUsage: null,
      planName: null,
      fetchedAt: Date.now(),
      error: message
    }
  }
}

/** Singleton instance */
export const usageFetcher = new UsageFetcher()
