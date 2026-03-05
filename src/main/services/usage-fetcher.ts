/**
 * Fetches Claude account usage (5hr session / 7-day rate windows).
 *
 * Primary path: Direct HTTP call to GET /api/oauth/usage using the exact
 * same headers as Claude Code's internal CLI (User-Agent, anthropic-beta).
 *
 * Fallback: SDK service session relay (getUsage control message) when the
 * direct call fails (e.g., no credentials, auth error).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { BrowserWindow } from 'electron'
import { ClaudeSession } from './claude-session'
import type { AccountUsage, ExtraUsage, RateWindow } from '../../shared/types'
import { blockUsageService } from './block-usage'
import { logger } from './logger'

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

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const FETCH_TIMEOUT_MS = 5_000 // same as CLI's k9q (5s)

/**
 * Construct the User-Agent header matching the CLI's jO() function.
 * The CLI uses "claude-code/<VERSION>" where VERSION comes from its
 * embedded build config. We read it from the SDK's package.json.
 */
function getCliUserAgent(): string {
  try {
    // SDK version 0.2.X corresponds to CLI version 2.1.X
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdkVersion: string = require('@anthropic-ai/claude-agent-sdk/package.json').version
    const cliVersion = sdkVersion.replace(/^0\./, '2.')
    return `claude-code/${cliVersion}`
  } catch {
    return 'claude-code/2.1.0'
  }
}

/** The anthropic-beta header value — BZ in the CLI's minified code. */
const ANTHROPIC_BETA = 'oauth-2025-04-20'

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

  /** Start background polling. Safe to call multiple times. */
  startPolling(): void {
    if (this.pollTimer) return
    this.fetch().catch((err) => { logger.warn('UsageFetcher', 'Initial fetch failed', err) })
    this.pollTimer = setInterval(() => {
      this.fetch().catch((err) => { logger.warn('UsageFetcher', 'Poll fetch failed', err) })
    }, this.pollIntervalMs)
  }

  /** Stop background polling. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Fetch usage and push to the renderer. Returns the result. */
  async fetch(): Promise<AccountUsage> {
    const usage = await this.fetchUsage()

    if (!usage.error) {
      this.lastUsage = usage
    } else if (this.lastUsage) {
      this.lastUsage = { ...this.lastUsage, error: usage.error }
    } else {
      this.lastUsage = usage
    }

    this.pushToRenderer(this.lastUsage)

    blockUsageService.recalculate().catch((err) => {
      logger.error('BlockUsage', 'Recalculation failed', err)
    })

    return this.lastUsage
  }

  /** Get the last cached result (may be null). */
  getLastUsage(): AccountUsage | null {
    return this.lastUsage
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
    } catch { /* Window may have been closed */ }
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
          'Authorization': `Bearer ${token}`,
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
            'Authorization': `Bearer ${token}`,
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
        logger.debug('UsageFetcher', 'Direct API returned 429 (rate limited), skipping until next poll')
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
              if ((err as NodeJS.ErrnoException).code === '44' || stderr?.includes('could not be found')) {
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
    } catch { /* best effort */ }

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
        usedPercent: w.utilization,
        resetsAt: w.resets_at ?? null
      }
    }

    const fiveHour = parseWindow('five_hour')

    if (!fiveHour && Object.keys(data).length > 0) {
      logger.warn(
        'UsageFetcher',
        'API response missing five_hour utilization — defaulting to 0%',
        { keys: Object.keys(data), five_hour: data['five_hour'] }
      )
    }

    // Parse extra_usage: { is_enabled, monthly_limit, used_credits, utilization }
    let extraUsage: ExtraUsage | null = null
    const eu = data['extra_usage'] as {
      is_enabled?: boolean
      monthly_limit?: number | null
      used_credits?: number
      utilization?: number
    } | undefined | null
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
