/**
 * The Claude usage API, for ONE credential file (ADR-011, ADR-071 §6).
 *
 * This is `UsageFetcher.fetchDirect()`'s body, lifted out of the class the day a
 * second caller appeared: the limits provider reads accounts that are NOT
 * active, each out of its own `~/.claude/ui/accounts/<id>/.credentials.json`
 * (ADR-015), while the fetcher keeps polling the active one. Everything that
 * made the call correct — cli.js's exact headers, the 60-second expiry buffer,
 * the single 401 retry, 429 as its own answer — is here rather than duplicated
 * per caller, and the path is a PARAMETER so neither caller can read or write
 * the other's file.
 *
 * `/api/oauth/usage` says nothing about WHO the token belongs to: the body
 * carries windows and a subscription type, never an account id. Identity is the
 * caller's problem, and it is why `AccountInfo` learned to remember it — and
 * why {@link authorizedOAuthGet} is exported: `claude-account-identity.ts` asks
 * `/api/oauth/profile` the same question about the same credential file, under
 * the same refresh rules.
 */

import { readFile } from 'node:fs/promises'
import type { AccountLimitWindow, AccountUsage, ExtraUsage, RateWindow } from '../../shared/types'
import { logger } from './logger'
import { writeJsonAtomicAsync } from './write-json-atomic'

/** The OAuth credential cli.js stores. Token material — never log a value of it. */
export interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

export interface CredentialsFile {
  claudeAiOauth?: OAuthCredentials
}

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token'
/** The anthropic-beta header value — BZ in the CLI's minified code. */
const ANTHROPIC_BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 5_000 // same as CLI's k9q (5s)
/** Refresh this long before the token actually expires. */
const EXPIRY_BUFFER_MS = 60_000

/**
 * Why a reading could not be taken.
 *
 *  - `needs-sign-in` — the stored credential cannot authenticate any more
 *    (no credential, refresh refused). ADR-071 §6: mark it and STOP. Retrying
 *    spends refresh grants on an account nobody is using.
 *  - `rate-limited` — a 429. The account is fine; the answer is to wait.
 *  - `unavailable` — everything else (network, timeout, a 5xx).
 */
export type ClaudeUsageError = 'needs-sign-in' | 'rate-limited' | 'unavailable'

export type ClaudeUsageResult =
  { usage: AccountUsage } | { error: ClaudeUsageError; detail: string }

export interface ClaudeUsageOptions {
  /** The `.credentials.json` to read — and, on a rotation, to write back to. */
  credentialsPath: string
  /**
   * May this call spend a refresh grant? `false` uses the stored access token
   * while it is valid and gives up rather than refreshing (ADR-071 §6).
   */
  allowRefresh: boolean
  userAgent: string
  /**
   * A second credential source, consulted only when the file yields nothing —
   * the macOS Keychain, which applies in single-account mode alone.
   */
  fallbackCredentials?: () => Promise<OAuthCredentials | null>
}

/** Read `claudeAiOauth` out of a credentials file. Null when absent or unreadable. */
export async function readCredentialsFile(path: string): Promise<OAuthCredentials | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as CredentialsFile
    if (!parsed.claudeAiOauth?.accessToken) return null
    return parsed.claudeAiOauth
  } catch {
    return null
  }
}

/** Refresh exchanges in flight, keyed by the file whose grant they are spending. */
const refreshInFlight = new Map<string, Promise<OAuthCredentials>>()

/**
 * Exchange the refresh token for a fresh access token and PERSIST the result to
 * `path`.
 *
 * The write-back is not a cache: Anthropic rotates the refresh token on use, so
 * the response's `refresh_token` is the only one that will ever work again. A
 * refresh whose result is not written leaves the file holding a spent grant —
 * the stored account is then bricked until the user signs in again, and on an
 * INACTIVE account nobody would notice until they switched to it. The write is
 * atomic (temp + rename) because this file is cli.js's live OAuth store.
 */
export function refreshClaudeToken(
  creds: OAuthCredentials,
  path: string
): Promise<OAuthCredentials> {
  // Single-flighted per file for the reason the doc comment gives: the grant is
  // single-use, and this module now has two callers per credential (the usage
  // read and S2e's identity resolve), each with its own in-flight map. Two
  // DIFFERENT operations overlapping on one expired file would otherwise POST
  // the same spent token twice.
  const existing = refreshInFlight.get(path)
  if (existing) return existing
  const exchange = exchangeRefreshToken(creds, path).finally(() => {
    refreshInFlight.delete(path)
  })
  refreshInFlight.set(path, exchange)
  return exchange
}

async function exchangeRefreshToken(
  creds: OAuthCredentials,
  path: string
): Promise<OAuthCredentials> {
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

  const newCreds: OAuthCredentials = {
    ...creds,
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const file = JSON.parse(raw) as CredentialsFile
    file.claudeAiOauth = newCreds
    await writeJsonAtomicAsync(path, file, { indent: 2 })
  } catch {
    /* best effort */
  }

  return newCreds
}

/**
 * The headers cli.js's k9q() sends, given a bearer token.
 *
 * Shared with the `/api/oauth/profile` read (S2e): cli.js builds both requests
 * from the same helper, and an endpoint that saw a different `anthropic-beta`
 * or User-Agent than the CLI's would be answering a different client.
 */
export function oauthApiHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    Authorization: `Bearer ${token}`,
    'anthropic-beta': ANTHROPIC_BETA
  }
}

/**
 * Reads in flight, keyed by the credential file they are reading.
 *
 * THE REFRESH TOKEN IS SINGLE-USE. Anthropic rotates it on every exchange, so
 * two reads of one file that overlap inside the 60-second expiry buffer both
 * load the same stored token, both POST it, and the second exchange is a reuse
 * of a spent grant — `needs-sign-in` on a healthy account at best, and a
 * provider that treats reuse as compromise revokes the whole family. Two
 * dashboards (the desktop and a phone on the remote transport) asking for a
 * refresh at once is enough, and so is a double-click.
 *
 * Keyed by PATH rather than globally because each account's file is its own
 * grant: two different accounts refreshing at the same time is fine, and
 * serialising them would make the dashboard as slow as the slowest account.
 */
const inFlight = new Map<string, Promise<ClaudeUsageResult>>()

/**
 * Read one account's usage. Never throws: every failure is an {@link ClaudeUsageError}.
 *
 * Single-flighted per credentials path: a second caller for the same file
 * awaits the first caller's answer rather than starting a second exchange.
 */
export function fetchClaudeUsage(options: ClaudeUsageOptions): Promise<ClaudeUsageResult> {
  const existing = inFlight.get(options.credentialsPath)
  if (existing) return existing
  const read = readUsage(options).finally(() => {
    inFlight.delete(options.credentialsPath)
  })
  inFlight.set(options.credentialsPath, read)
  return read
}

async function readUsage(options: ClaudeUsageOptions): Promise<ClaudeUsageResult> {
  const result = await authorizedOAuthGet({
    ...options,
    url: USAGE_API_URL,
    label: 'usage API',
    timeoutMs: FETCH_TIMEOUT_MS
  })
  if ('error' in result) return result
  return { usage: parseUsageResponse(result.body) }
}

export interface AuthorizedGetOptions extends ClaudeUsageOptions {
  url: string
  /** What the detail string calls this endpoint ("usage API returned 503"). */
  label: string
  timeoutMs: number
  /** Anything beyond {@link oauthApiHeaders} — the profile read's Cache-Control. */
  extraHeaders?: Record<string, string>
}

export type AuthorizedGetResult =
  { body: Record<string, unknown> } | { error: ClaudeUsageError; detail: string }

/**
 * One authenticated GET against an `/api/oauth/*` endpoint, with the whole
 * credential dance around it: the 60-second expiry buffer, ADR-071 §6's rule
 * that a refresh grant is spent only when the caller allows it, one 401 retry
 * and no more, and a 429 as its own answer rather than a failure.
 *
 * Shared rather than copied because the rules are the RISKY part, not the URL:
 * the second endpoint to need them (S2e's `/api/oauth/profile`) reads and
 * rotates the same single-use grant, and a divergent copy of the retry policy
 * is how an account gets its token family revoked. Callers never throw out of
 * it — every failure is a typed {@link ClaudeUsageError}.
 *
 * NOT single-flighted here: each caller keys its own in-flight map by
 * credentials path, because "the same usage read" and "the same identity read"
 * are different answers to share.
 */
export async function authorizedOAuthGet(
  options: AuthorizedGetOptions
): Promise<AuthorizedGetResult> {
  const { credentialsPath, allowRefresh, userAgent, url, label, timeoutMs } = options
  let creds = await readCredentialsFile(credentialsPath)
  if (!creds && options.fallbackCredentials) creds = await options.fallbackCredentials()
  if (!creds) return { error: 'needs-sign-in', detail: 'no stored credentials' }

  let token = creds.accessToken
  if (creds.expiresAt < Date.now() + EXPIRY_BUFFER_MS) {
    if (!allowRefresh) {
      return { error: 'unavailable', detail: 'access token expired and refresh not allowed' }
    }
    try {
      creds = await refreshClaudeToken(creds, credentialsPath)
      token = creds.accessToken
    } catch (err) {
      return { error: 'needs-sign-in', detail: `token refresh failed: ${err}` }
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const get = (bearer: string): Promise<Response> =>
    fetch(url, {
      method: 'GET',
      headers: { ...oauthApiHeaders(bearer, userAgent), ...options.extraHeaders },
      signal: controller.signal
    })

  try {
    const resp = await get(token)

    if (resp.status === 401) {
      // The token was valid by the clock and rejected anyway. One refresh, one
      // retry, then stop — ADR-071 §6's rule for a stored account.
      if (!allowRefresh) return { error: 'needs-sign-in', detail: 'unauthorized' }
      try {
        creds = await refreshClaudeToken(creds, credentialsPath)
      } catch (err) {
        return { error: 'needs-sign-in', detail: `token refresh failed: ${err}` }
      }
      const retry = await get(creds.accessToken)
      if (retry.status === 401)
        return { error: 'needs-sign-in', detail: 'unauthorized after refresh' }
      if (!retry.ok) return { error: 'unavailable', detail: `${label} returned ${retry.status}` }
      return { body: (await retry.json()) as Record<string, unknown> }
    }

    if (resp.status === 429) {
      return { error: 'rate-limited', detail: `${label} returned 429` }
    }

    if (!resp.ok) {
      return { error: 'unavailable', detail: `${label} returned ${resp.status}` }
    }

    return { body: (await resp.json()) as Record<string, unknown> }
  } catch (err) {
    return { error: 'unavailable', detail: `${err}` }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Parse a usage response into AccountUsage. Two shapes are accepted:
 *
 *   1. `/api/oauth/usage` HTTP body — windows at the top level
 *      (`five_hour`, `seven_day`, …) with `extra_usage` alongside.
 *   2. SDK-relay fallback — cli.js's structured `get_usage` control response,
 *      which nests the same windows (and `extra_usage`) under `rate_limits`
 *      (null when `rate_limits_available` is false), and adds `session` /
 *      `subscription_type` / `behaviors`. cli.js restructured this shape in a
 *      recent release; before, the relay mirrored the flat HTTP body.
 *
 * Window utilization is 0–100 (percentage) in both shapes — unlike the
 * rate_limit_event headers (0–1 fraction); see UsageFetcher's toUsedPercent().
 */
export function parseUsageResponse(data: Record<string, unknown>): AccountUsage {
  // The structured relay shape is distinguished by its top-level keys.
  const isStructured = 'rate_limits' in data || 'rate_limits_available' in data
  const rateLimits =
    isStructured && data.rate_limits && typeof data.rate_limits === 'object'
      ? (data.rate_limits as Record<string, unknown>)
      : null
  // Where the per-window objects live: nested under rate_limits for the
  // structured shape, top-level for the HTTP shape.
  const windowSource: Record<string, unknown> = isStructured ? (rateLimits ?? {}) : data

  const parseWindow = (key: string): RateWindow | null => {
    const w = windowSource[key] as
      { utilization?: number | null; resets_at?: string | null } | undefined | null
    if (!w || typeof w.utilization !== 'number') return null
    return {
      usedPercent: w.utilization,
      resetsAt: w.resets_at ?? null
    }
  }

  const fiveHour = parseWindow('five_hour')

  // Warn only on a genuinely unrecognized HTTP shape. The structured fallback
  // legitimately reports no five_hour when rate_limits is unavailable (API key
  // / Bedrock / Vertex sessions) — that's not an error.
  if (!fiveHour && !isStructured && Object.keys(data).length > 0) {
    logger.warn('UsageFetcher', 'API response missing five_hour utilization — defaulting to 0%', {
      keys: Object.keys(data),
      five_hour: data['five_hour']
    })
  }

  // extra_usage: { is_enabled, monthly_limit, used_credits, utilization }.
  // Top-level in the HTTP shape, nested under rate_limits in the structured one
  // (windowSource resolves to the right object for both).
  let extraUsage: ExtraUsage | null = null
  const eu = windowSource['extra_usage'] as
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

  // The generalized `limits[]` array sits alongside the legacy per-window
  // keys. Weekly per-model buckets live ONLY here (seven_day_opus /
  // seven_day_sonnet are null on such accounts), so mirror cli.js: keep
  // `kind === "weekly_scoped"` entries carrying a scope model and take the
  // label from the server's display_name — never hardcode a model name.
  // `percent` is already 0-100. Malformed entries are skipped silently, as
  // parseWindow does.
  const sevenDayModels: Array<{ label: string; window: RateWindow }> = []
  const limits = windowSource['limits']
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      const entry = raw as {
        kind?: unknown
        percent?: unknown
        resets_at?: string | null
        scope?: { model?: { display_name?: unknown } | null } | null
      } | null
      if (!entry || typeof entry !== 'object' || entry.kind !== 'weekly_scoped') continue
      const label = entry.scope?.model?.display_name
      if (typeof label !== 'string' || typeof entry.percent !== 'number') continue
      sevenDayModels.push({
        label,
        window: { usedPercent: entry.percent, resetsAt: entry.resets_at ?? null }
      })
    }
  }

  // subscription_type ('pro' | 'max' | 'team' | 'enterprise') is only present
  // in the structured shape; the HTTP body has no plan name.
  const planName = typeof data.subscription_type === 'string' ? data.subscription_type : null

  return {
    fiveHour: fiveHour ?? { usedPercent: 0, resetsAt: null },
    sevenDay: parseWindow('seven_day'),
    sevenDaySonnet: parseWindow('seven_day_sonnet'),
    sevenDayOpus: parseWindow('seven_day_opus'),
    sevenDayModels: sevenDayModels.length ? sevenDayModels : null,
    extraUsage,
    planName,
    fetchedAt: Date.now(),
    error: null,
    // The response says nothing about WHICH account it describes; the fetcher
    // stamps that on, from the account it resolved in the same pass.
    accountLabel: null
  }
}

/**
 * A weekly per-model bucket's canonical kind, from the label the SERVER chose.
 *
 * `/api/oauth/usage` names a scoped weekly limit by `scope.model.display_name`
 * ("Opus", "Fable") and by nothing else — there is no model id in the payload
 * to key on. So the kind is that name, slugged: lower case, every run of
 * anything else a single `-`. It is a grouping key, not an identity, and a
 * display name Anthropic renames simply starts a new series rather than
 * corrupting the old one.
 */
export function weeklyScopedKind(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `7d:${slug || 'model'}`
}

/**
 * One reading's windows, in ADR-071 §6's vocabulary.
 *
 * `sevenDaySonnet` / `sevenDayOpus` are the legacy per-model weeklies — the
 * shape an account gets when the payload carries no `limits[]` — so they are
 * `7d:<model>` too rather than a third concept. An account reporting both (none
 * observed) files them as separate series, which is the honest reading: two
 * numbers the server chose to send separately.
 */
export function claudeLimitWindows(usage: AccountUsage): AccountLimitWindow[] {
  const windows: AccountLimitWindow[] = [{ kind: '5h', label: '5-hour', ...usage.fiveHour }]
  if (usage.sevenDay) windows.push({ kind: '7d', label: '7-day', ...usage.sevenDay })
  if (usage.sevenDaySonnet) {
    windows.push({ kind: '7d:sonnet', label: '7-day Sonnet', ...usage.sevenDaySonnet })
  }
  if (usage.sevenDayOpus) {
    windows.push({ kind: '7d:opus', label: '7-day Opus', ...usage.sevenDayOpus })
  }
  for (const model of usage.sevenDayModels ?? []) {
    windows.push({
      kind: weeklyScopedKind(model.label),
      label: `7-day ${model.label}`,
      ...model.window
    })
  }
  return windows
}
