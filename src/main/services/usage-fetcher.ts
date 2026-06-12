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

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { BrowserWindow } from 'electron'
import { ClaudeSession, getSdkVersion } from './claude-session'
import type { AccountUsage, ExtraUsage, RateWindow } from '../../shared/types'
import { logger } from './logger'

/** The currently authenticated Claude account (from ~/.claude.json). */
export interface ActiveAccount {
  uuid: string
  email: string
}

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth?: OAuthCredentials
}

// ---------------------------------------------------------------------------
// Constants — match Claude Code's internal cli.js exactly
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const IS_MACOS = platform() === 'darwin'
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token'

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes (supplementary data only)
const FETCH_TIMEOUT_MS = 5_000 // same as CLI's k9q (5s)
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
 * embedded build config. We read it from the SDK's package.json.
 */
function getCliUserAgent(): string {
  try {
    // SDK version 0.2.X corresponds to CLI version 2.1.X
    const sdkVersion = getSdkVersion()
    const cliVersion = sdkVersion.replace(/^0\./, '2.')
    return `claude-code/${cliVersion}`
  } catch {
    return 'claude-code/2.1.0'
  }
}

/** The anthropic-beta header value — BZ in the CLI's minified code. */
const ANTHROPIC_BETA = 'oauth-2025-04-20'

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
  private window: BrowserWindow | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastUsage: AccountUsage | null = null
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  private sessionGetter: SessionUsageGetter | null = null
  private userAgent = getCliUserAgent()
  private cacheWriteTimer: ReturnType<typeof setTimeout> | null = null
  private activeAccount: ActiveAccount | null = null
  /** Last account written to the account log (avoid duplicate records). */
  private lastLoggedAccountUuid: string | null = null
  private accountLogSeeded = false
  /** One-shot timer firing shortly after the 5h window expires. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private lastFetchStartedAt = 0

  /** Attach the main BrowserWindow so we can push events to the renderer. */
  setWindow(win: BrowserWindow): void {
    this.window = win
  }

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
        }
      })
      .catch(() => {
        // Cache read failed — fetch immediately
        this.fetch().catch((err) => {
          logger.warn('UsageFetcher', 'Initial fetch failed', err)
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

  // -------------------------------------------------------------------------
  // Account tracking
  // -------------------------------------------------------------------------

  /**
   * Read the authenticated account from ~/.claude.json and append a record to
   * the account log when it changes. The log lets block-usage attribute JSONL
   * entries to the account active at their timestamp.
   */
  private async trackActiveAccount(): Promise<void> {
    try {
      const raw = await readFile(CLAUDE_JSON_PATH, 'utf-8')
      const parsed = JSON.parse(raw) as {
        oauthAccount?: { accountUuid?: string; emailAddress?: string }
      }
      const uuid = parsed.oauthAccount?.accountUuid
      const email = parsed.oauthAccount?.emailAddress
      if (!uuid || !email) return
      this.activeAccount = { uuid, email }

      // Initialize dedup state from the log's last record (once per launch)
      if (!this.accountLogSeeded) {
        this.accountLogSeeded = true
        try {
          const log = await readFile(ACCOUNT_LOG_PATH, 'utf-8')
          const lines = log.trim().split('\n')
          const last = JSON.parse(lines[lines.length - 1]) as { accountUuid?: string }
          this.lastLoggedAccountUuid = last.accountUuid ?? null
        } catch {
          this.lastLoggedAccountUuid = null
        }
      }

      if (uuid !== this.lastLoggedAccountUuid) {
        this.lastLoggedAccountUuid = uuid
        const record = JSON.stringify({ ts: Date.now(), accountUuid: uuid, email })
        await mkdir(ACCOUNT_LOG_DIR, { recursive: true })
        await appendFile(ACCOUNT_LOG_PATH, record + '\n', 'utf-8')
        logger.info('UsageFetcher', `Active account changed → ${email}`)
      }
    } catch (err) {
      logger.debug('UsageFetcher', `Account tracking failed: ${err}`)
    }
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
      return data
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
    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('usage:data', usage)
      }
      for (const w of ClaudeSession.getExtraWindows()) {
        if (!w.isDestroyed()) w.webContents.send('usage:data', usage)
      }
    } catch {
      /* Window may have been closed */
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
          return this.parseResponse(data)
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

  private async fetchDirect(): Promise<AccountUsage | null> {
    const creds = await this.readCredentials()
    if (!creds) return null // no creds → skip to fallback silently

    // Refresh token if expired (with 60s buffer)
    let token = creds.accessToken
    if (creds.expiresAt < Date.now() + 60_000) {
      try {
        token = await this.refreshToken(creds)
      } catch {
        return null // refresh failed → skip to fallback
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      // Exact same headers as CLI's k9q():
      //   { "Content-Type": "application/json", "User-Agent": jO(), ...u_().headers }
      // where u_().headers = { Authorization: "Bearer <token>", "anthropic-beta": BZ }
      const resp = await fetch(USAGE_API_URL, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
          Authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_BETA
        },
        signal: controller.signal
      })

      if (resp.status === 401) {
        // Try refreshing and retrying once
        try {
          token = await this.refreshToken(creds)
        } catch {
          return null
        }
        const retry = await fetch(USAGE_API_URL, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            Authorization: `Bearer ${token}`,
            'anthropic-beta': ANTHROPIC_BETA
          },
          signal: controller.signal
        })
        if (!retry.ok) return null
        const data = (await retry.json()) as Record<string, unknown>
        return this.parseResponse(data)
      }

      if (resp.status === 429) {
        // Rate-limited — don't retry or fall back, just wait for the next poll cycle
        logger.debug(
          'UsageFetcher',
          'Direct API returned 429 (rate limited), skipping until next poll'
        )
        return this.errorResult('Rate limited')
      }

      if (!resp.ok) {
        logger.debug('UsageFetcher', `Direct API returned ${resp.status}`)
        return null // non-200 → skip to fallback
      }

      const data = (await resp.json()) as Record<string, unknown>
      return this.parseResponse(data)
    } catch (err) {
      // Network error / timeout → skip to fallback
      logger.debug('UsageFetcher', `Direct API error: ${err}`)
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  // -------------------------------------------------------------------------
  // Credential management
  // -------------------------------------------------------------------------

  private async readCredentials(): Promise<OAuthCredentials | null> {
    const fileCreds = await this.readCredentialsFromFile()
    if (fileCreds) return fileCreds

    if (IS_MACOS) {
      return this.readCredentialsFromKeychain()
    }

    return null
  }

  private async readCredentialsFromFile(): Promise<OAuthCredentials | null> {
    try {
      const raw = await readFile(CREDENTIALS_PATH, 'utf-8')
      const parsed = JSON.parse(raw) as CredentialsFile
      if (!parsed.claudeAiOauth?.accessToken) return null
      return parsed.claudeAiOauth
    } catch {
      return null
    }
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

  private async refreshToken(creds: OAuthCredentials): Promise<string> {
    const resp = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: 'cli'
      })
    })

    if (!resp.ok) throw new Error(`Refresh failed: ${resp.status}`)

    const data = (await resp.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    // Persist refreshed credentials
    const newCreds: OAuthCredentials = {
      ...creds,
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
    }
    try {
      const raw = await readFile(CREDENTIALS_PATH, 'utf-8')
      const file = JSON.parse(raw) as CredentialsFile
      file.claudeAiOauth = newCreds
      await writeFile(CREDENTIALS_PATH, JSON.stringify(file, null, 2), 'utf-8')
    } catch {
      /* best effort */
    }

    return data.access_token
  }

  // -------------------------------------------------------------------------
  // Response parsing
  // -------------------------------------------------------------------------

  private parseResponse(data: Record<string, unknown>): AccountUsage {
    const parseWindow = (key: string): RateWindow | null => {
      const w = data[key] as { utilization?: number; resets_at?: string } | undefined
      if (!w || typeof w.utilization !== 'number') return null
      return {
        // API returns utilization as 0–100 (percentage), not 0–1 (fraction).
        // This differs from rate_limit_event headers which use 0–1 — see
        // toUsedPercent() in updateFromRateLimitEvent for the conversion.
        usedPercent: w.utilization,
        resetsAt: w.resets_at ?? null
      }
    }

    const fiveHour = parseWindow('five_hour')

    if (!fiveHour && Object.keys(data).length > 0) {
      logger.warn('UsageFetcher', 'API response missing five_hour utilization — defaulting to 0%', {
        keys: Object.keys(data),
        five_hour: data['five_hour']
      })
    }

    // Parse extra_usage: { is_enabled, monthly_limit, used_credits, utilization }
    let extraUsage: ExtraUsage | null = null
    const eu = data['extra_usage'] as
      | {
          is_enabled?: boolean
          monthly_limit?: number | null
          used_credits?: number
          utilization?: number
        }
      | undefined
      | null
    if (eu && typeof eu === 'object') {
      extraUsage = {
        isEnabled: eu.is_enabled ?? false,
        monthlyLimit: eu.monthly_limit ?? null,
        usedCredits: eu.used_credits ?? 0,
        utilization: eu.utilization ?? 0
      }
    }

    return {
      fiveHour: fiveHour ?? { usedPercent: 0, resetsAt: null },
      sevenDay: parseWindow('seven_day'),
      sevenDaySonnet: parseWindow('seven_day_sonnet'),
      sevenDayOpus: parseWindow('seven_day_opus'),
      extraUsage,
      planName: null,
      fetchedAt: Date.now(),
      error: null
    }
  }

  private errorResult(message: string): AccountUsage {
    return {
      fiveHour: { usedPercent: 0, resetsAt: null },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
      planName: null,
      fetchedAt: Date.now(),
      error: message
    }
  }
}

/** Singleton instance */
export const usageFetcher = new UsageFetcher()
