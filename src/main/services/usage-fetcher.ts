/**
 * Fetches Claude account usage (5hr session / 7-day rate windows)
 * via the Anthropic OAuth API.
 *
 * Reads credentials from ~/.claude/.credentials.json, calls
 * GET https://api.anthropic.com/api/oauth/usage, and pushes
 * updates to the renderer via BrowserWindow.webContents.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import type { AccountUsage, RateWindow } from '../../shared/types'
import { blockUsageService } from './block-usage'

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
// Constants
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token'
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const FETCH_TIMEOUT_MS = 15_000
const MAX_RETRIES = 5

// ---------------------------------------------------------------------------
// UsageFetcher class
// ---------------------------------------------------------------------------

export class UsageFetcher {
  private window: BrowserWindow | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastUsage: AccountUsage | null = null
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS

  /** Attach the main BrowserWindow so we can push events to the renderer. */
  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  /** Update the polling interval (in seconds). Restarts the timer if running. */
  setIntervalSecs(secs: number): void {
    const ms = Math.max(30, secs) * 1000
    if (ms === this.pollIntervalMs) return
    this.pollIntervalMs = ms
    // Restart timer with new interval if currently polling
    if (this.pollTimer) {
      this.stopPolling()
      this.startPolling()
    }
  }

  /** Start background polling. Safe to call multiple times. */
  startPolling(): void {
    if (this.pollTimer) return
    // Fetch immediately, then every pollIntervalMs
    this.fetch().catch(() => {})
    this.pollTimer = setInterval(() => {
      this.fetch().catch(() => {})
    }, this.pollIntervalMs)
  }

  /** Stop background polling. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Fetch usage from the API and push to the renderer. Returns the result. */
  async fetch(): Promise<AccountUsage> {
    const usage = await this.fetchUsage()

    // Only overwrite lastUsage with successful results — don't let transient
    // errors (timeout, network blip) replace good cached data with zeros.
    if (!usage.error) {
      this.lastUsage = usage
    } else if (this.lastUsage) {
      // Keep the last good data values and their original fetchedAt timestamp
      // so consumers can detect staleness. Only propagate the error message.
      this.lastUsage = { ...this.lastUsage, error: usage.error }
    } else {
      this.lastUsage = usage
    }

    this.pushToRenderer(this.lastUsage)

    // Trigger block usage recalculation (fire-and-forget)
    blockUsageService.recalculate().catch((err) => {
      console.error('[BlockUsage] recalculation failed:', err)
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
    } catch {
      // Window may have been closed
    }
  }

  private async fetchUsage(): Promise<AccountUsage> {
    const creds = await this.readCredentials()
    if (!creds) {
      return this.errorResult('No OAuth credentials found. Run "claude login" first.')
    }

    // Refresh token if expired (with 60s buffer)
    let token = creds.accessToken
    if (creds.expiresAt < Date.now() + 60_000) {
      try {
        token = await this.refreshToken(creds)
      } catch (err) {
        return this.errorResult(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let lastError = ''
    let retriedAuth = false

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, attempt * 1000))
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const resp = await fetch(USAGE_API_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'ClaudeUI'
          },
          signal: controller.signal
        })

        if (resp.status === 401 && !retriedAuth) {
          // Token may have expired despite expiresAt — force a refresh and retry
          retriedAuth = true
          try {
            token = await this.refreshToken(creds)
          } catch {
            return this.errorResult('Unauthorized — token refresh failed. Try "claude login" again.')
          }
          lastError = 'Unauthorized (retrying with refreshed token)'
          continue
        }

        if (resp.status === 401) {
          return this.errorResult('Unauthorized — token may be invalid. Try "claude login" again.')
        }
        if (resp.status === 403) {
          return this.errorResult('Forbidden — token missing user:profile scope.')
        }

        // Retry on server errors (5xx)
        if (resp.status >= 500) {
          lastError = `API error: ${resp.status} ${resp.statusText}`
          continue
        }

        if (!resp.ok) {
          return this.errorResult(`API error: ${resp.status} ${resp.statusText}`)
        }

        const data = (await resp.json()) as Record<string, unknown>
        return this.parseResponse(data, creds.rateLimitTier ?? null)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          lastError = 'Request timed out'
        } else {
          lastError = `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
        }
        // Retry on network errors and timeouts
        continue
      } finally {
        clearTimeout(timeout)
      }
    }

    return this.errorResult(`${lastError} (after ${MAX_RETRIES + 1} attempts)`)
  }

  private async readCredentials(): Promise<OAuthCredentials | null> {
    try {
      const raw = await readFile(CREDENTIALS_PATH, 'utf-8')
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
        client_id: 'cli' // Claude CLI client id
      })
    })

    if (!resp.ok) {
      throw new Error(`Refresh failed: ${resp.status}`)
    }

    const data = (await resp.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    // Update credentials file
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
      // Non-fatal — we still have the new token in memory
    }

    return data.access_token
  }

  private parseResponse(
    data: Record<string, unknown>,
    rateLimitTier: string | null
  ): AccountUsage {
    const parseWindow = (key: string): RateWindow | null => {
      const w = data[key] as { utilization?: number; resets_at?: string } | undefined
      if (!w || typeof w.utilization !== 'number') return null
      return {
        usedPercent: w.utilization,
        resetsAt: w.resets_at ?? null
      }
    }

    const fiveHour = parseWindow('five_hour')

    return {
      fiveHour: fiveHour ?? { usedPercent: 0, resetsAt: null },
      sevenDay: parseWindow('seven_day'),
      sevenDaySonnet: parseWindow('seven_day_sonnet'),
      sevenDayOpus: parseWindow('seven_day_opus'),
      planName: rateLimitTier,
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
      planName: null,
      fetchedAt: Date.now(),
      error: message
    }
  }
}

/** Singleton instance */
export const usageFetcher = new UsageFetcher()
