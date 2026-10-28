/**
 * ChatGPT subscription usage, per VAULT account (ADR-068 §2).
 *
 * One PULL feeds the map: the sidebar usage panel opening or refreshing reads
 * every stored account's `GET https://chatgpt.com/backend-api/wham/usage` with
 * that account's own vault token. There is NO polling timer — a subscription's
 * limits are interesting while somebody is looking at them.
 *
 * The request and the payload follow Codex's own backend client
 * (`codex-rs/backend-client/src/client.rs`: `get_rate_limits_with_reset_credits`,
 * `rate_limit_snapshots_from_payload`), which is the only statement of the wire
 * there is: the endpoint is the ChatGPT backend's, not a published API.
 *
 * Keyed by vault account id, never by the ChatGPT WORKSPACE id: two vault
 * accounts can share a workspace, and the picker, the session pin and the usage
 * rows all speak the vault's vocabulary.
 */
import type {
  ChatgptAccountLimits,
  ChatgptRateLimits,
  CreditLimit,
  RateWindow
} from '../../shared/types'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { windowKindsForReading } from '../../shared/window-kind'
import { chatgptRequestHeaders } from '../automode/judge-route'
import { parseJwtClaims } from '../auth/vault/codex-oauth'
import { credentialSync, type CodexInjectionToken } from '../auth/vault/CredentialSync'
import { hostAppVersion } from '../host'
import { publishCreditReading } from '../services/credit-readings'
import { emitEvent } from '../services/sync-host'
import { recordLimitSamples, type LimitSampleWindow } from '../services/window-samples'

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_TIMEOUT_MS = 15_000

/**
 * One window as the backend states it
 * (`codex-backend-openapi-models` `RateLimitWindowSnapshot`). `reset_at` is a
 * unix timestamp in SECONDS (Codex's own test vectors; `1735693200` is
 * 2025-01-01T01:00:00Z); the length is `limit_window_seconds`.
 */
export interface ChatgptUsageWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}

/** `spend_control.individual_limit` (`SpendControlLimitDetails`); the amounts are decimal STRINGS. */
export interface ChatgptUsageSpendLimit {
  source?: string | null
  limit?: string
  used?: string
  remaining?: string
  used_percent?: number
  remaining_percent?: number
  reset_after_seconds?: number
  reset_at?: number
}

/**
 * The `GET /wham/usage` payload (`RateLimitStatusPayload`), the fields ClaudeUI
 * reads. `additional_rate_limits` (per-feature buckets) and
 * `rate_limit_reached_type` are typed `unknown` on purpose: the panel shows the
 * top-level `rate_limit` only, which is what every account observed so far fills.
 */
export interface ChatgptUsagePayload {
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: ChatgptUsageWindow | null
    secondary_window?: ChatgptUsageWindow | null
  } | null
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null
  spend_control?: {
    reached?: boolean
    individual_limit?: ChatgptUsageSpendLimit | null
  } | null
  additional_rate_limits?: unknown
  rate_limit_reached_type?: unknown
}

// ---------------------------------------------------------------------------
// Snapshot (the wire, normalised)
// ---------------------------------------------------------------------------

/** One window, normalised: the percentage, its length in minutes and its reset in unix SECONDS. */
export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

/** A member's credit allowance; `limit`/`used` are decimal strings, `resetsAt` unix SECONDS. */
export interface SpendControlLimitSnapshot {
  limit: string
  used: string
  remainingPercent: number
  resetsAt: number
}

/** What one account's usage read says, in the shape the store folds in. */
export interface RateLimitSnapshot {
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  individualLimit: SpendControlLimitSnapshot | null
  planType: string | null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Seconds → whole minutes, rounding UP (`client.rs` `window_minutes_from_seconds`); non-positive is no statement. */
function windowMinutes(seconds: unknown): number | null {
  const value = finiteNumber(seconds)
  return value !== null && value > 0 ? Math.ceil(value / 60) : null
}

function windowFromWire(window: ChatgptUsageWindow | null | undefined): RateLimitWindow | null {
  const used = finiteNumber(window?.used_percent)
  if (!window || used === null) return null
  return {
    usedPercent: used,
    windowDurationMins: windowMinutes(window.limit_window_seconds),
    resetsAt: finiteNumber(window.reset_at)
  }
}

function individualLimitFromWire(
  limit: ChatgptUsageSpendLimit | null | undefined
): SpendControlLimitSnapshot | null {
  if (!limit) return null
  const remaining = finiteNumber(limit.remaining_percent)
  if (typeof limit.limit !== 'string' || typeof limit.used !== 'string' || remaining === null) {
    return null
  }
  return {
    limit: limit.limit,
    used: limit.used,
    remainingPercent: remaining,
    resetsAt: finiteNumber(limit.reset_at) ?? 0
  }
}

/**
 * The snapshot a usage payload amounts to: its top-level `rate_limit`, credits
 * and `spend_control.individual_limit`. `additional_rate_limits` is ignored.
 */
export function pickRateLimitSnapshot(payload: ChatgptUsagePayload): RateLimitSnapshot {
  const credits = payload.credits
  return {
    primary: windowFromWire(payload.rate_limit?.primary_window),
    secondary: windowFromWire(payload.rate_limit?.secondary_window),
    credits: credits
      ? {
          hasCredits: credits.has_credits === true,
          unlimited: credits.unlimited === true,
          balance: typeof credits.balance === 'string' ? credits.balance : null
        }
      : null,
    individualLimit: individualLimitFromWire(payload.spend_control?.individual_limit),
    planType: typeof payload.plan_type === 'string' && payload.plan_type ? payload.plan_type : null
  }
}

/**
 * `resetsAt` is a unix timestamp in SECONDS; multiplying by 1000 is the whole
 * conversion. ClaudeUI's `RateWindow` carries ISO 8601 because
 * `formatResetTime` and every Claude usage row already do.
 *
 * `windowDurationMins` is KEPT (S3c). It is the only trusted statement of how
 * long the window lasts — the backend's `limit_window_seconds` — and dropping
 * it is what left a weekly-only plan filed under the five-hour kind.
 * Non-positive or non-finite is no statement at all and travels as null.
 */
export function rateWindow(window: RateLimitWindow | null | undefined): RateWindow | null {
  if (!window || typeof window.usedPercent !== 'number') return null
  const seconds = window.resetsAt
  const minutes = window.windowDurationMins
  return {
    usedPercent: window.usedPercent,
    resetsAt:
      typeof seconds === 'number' && Number.isFinite(seconds)
        ? new Date(seconds * 1000).toISOString()
        : null,
    windowMinutes:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : null
  }
}

/** A non-negative decimal amount, or null — `Number('')` is 0, which is not an amount. */
function creditAmount(raw: string | null | undefined): number | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * A member's credit allowance from the wire's `spend_control.individual_limit`,
 * or null.
 *
 * The amounts are decimal STRINGS on the wire. One that does not parse, or is
 * negative, drops the whole allowance — a bar with half its numbers is a claim
 * nobody made — which is also what Codex's `/status` does.
 *
 * `resetsAt` is unix SECONDS like every other reset on this wire; a
 * non-positive one is no statement and travels as null.
 */
export function creditLimit(
  limit: SpendControlLimitSnapshot | null | undefined
): CreditLimit | null {
  if (!limit) return null
  const used = creditAmount(limit.used)
  const total = creditAmount(limit.limit)
  const remaining = limit.remainingPercent
  if (used === null || total === null) return null
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null
  const seconds = limit.resetsAt
  return {
    used,
    limit: total,
    remainingPercent: Math.max(0, Math.min(100, remaining)),
    resetsAt:
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? new Date(seconds * 1000).toISOString()
        : null
  }
}

/**
 * One observed window as the sample writer takes it, under the kind the whole
 * reading resolved it to (S3c) — the DURATION's kind, never the slot's, and
 * `windowKindsForReading` keeps the two slots distinct when they share a length.
 */
function sampleWindow(kind: string, window: RateWindow): LimitSampleWindow {
  return {
    kind,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes ?? null
  }
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface ChatgptUsageReadDeps {
  /**
   * An account's token: `force` refreshes it first whatever its expiry. Null
   * when the account is signed out, gone or workspace-less.
   */
  token: (force: boolean, accountId: string) => Promise<CodexInjectionToken | null>
  fetch: typeof fetch
  appVersion: string
}

/** Codex marks a FedRAMP workspace with `chatgpt_account_is_fedramp` in the token's auth claims. */
function isFedrampToken(accessToken: string): boolean {
  const claims = parseJwtClaims(accessToken) as
    | (Record<string, unknown> & { 'https://api.openai.com/auth'?: Record<string, unknown> })
    | undefined
  return (
    claims?.['https://api.openai.com/auth']?.chatgpt_account_is_fedramp === true ||
    claims?.chatgpt_account_is_fedramp === true
  )
}

/** The request headers for `token`: the judge's set, plus Codex's FedRAMP routing header when it applies. */
function usageHeaders(token: CodexInjectionToken, appVersion: string): Record<string, string> {
  return {
    ...chatgptRequestHeaders(token, appVersion),
    Accept: 'application/json',
    ...(isFedrampToken(token.accessToken) ? { 'X-OpenAI-Fedramp': 'true' } : {})
  }
}

/**
 * One account's usage payload, or null when it cannot be had. A 401 gets ONE
 * retry on a force-refreshed token (the judge transport's rule); a refresh that
 * changed nothing is not retried, since the same token would only 401 again.
 * Never throws and never logs: the request carries the token.
 */
async function readOne(
  deps: ChatgptUsageReadDeps,
  accountId: string
): Promise<ChatgptUsagePayload | null> {
  try {
    let token = await deps.token(false, accountId)
    if (!token) return null
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await deps.fetch(CHATGPT_USAGE_URL, {
        method: 'GET',
        headers: usageHeaders(token, deps.appVersion),
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
      })
      if (response.status === 401 && attempt === 0) {
        const fresh = await deps.token(true, accountId)
        if (!fresh || fresh.accessToken === token.accessToken) return null
        token = fresh
        continue
      }
      if (!response.ok) return null
      const body: unknown = await response.json()
      return body && typeof body === 'object' && !Array.isArray(body)
        ? (body as ChatgptUsagePayload)
        : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read every listed account's usage, concurrently. An account that fails is
 * ABSENT from the map — never another account's numbers, and never a reason for
 * the others to go missing.
 */
export function readChatgptUsage(
  deps: ChatgptUsageReadDeps
): (accountIds: ReadonlyArray<string>) => Promise<Map<string, ChatgptUsagePayload>> {
  return async (accountIds) => {
    const results = await Promise.all(accountIds.map((id) => readOne(deps, id)))
    const map = new Map<string, ChatgptUsagePayload>()
    accountIds.forEach((id, index) => {
      const payload = results[index]
      if (payload) map.set(id, payload)
    })
    return map
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One stored account, as the store needs to label it. */
export interface ChatgptLimitAccount {
  id: string
  email?: string
  planType?: string
}

export interface ChatgptRateLimitDeps {
  /** The vault's stored accounts, token-free (`credentialSync.getStatus()`). */
  accounts: () => Promise<ChatgptLimitAccount[]>
  /**
   * One read per account (see {@link readChatgptUsage}). Answers the WHOLE
   * payload: choosing what to believe of it is this module's job
   * ({@link pickRateLimitSnapshot}), not the transport's.
   */
  read: (accountIds: ReadonlyArray<string>) => Promise<Map<string, ChatgptUsagePayload>>
  /** Tells clients the map moved. No payload: they re-query. */
  changed: () => void
  /**
   * Keep the reading (ADR-071 §6). Takes the VAULT account id and the windows
   * THIS snapshot carried.
   *
   * Injected because resolving the vault id to ADR-071 §3's account key is async
   * and touches the vault, neither of which belongs inside a synchronous fold;
   * it also keeps this class's unit tests free of a database.
   */
  persist: (vaultAccountId: string, windows: LimitSampleWindow[]) => void
  /**
   * Relay the account's credits (ADR-072 §4, amended 2026-10-01). Takes the
   * MERGED entry, not the snapshot: the hub replaces its row whole, so what it is
   * sent has to be the account's current state. `observedAt` is when the credits
   * were last READ in full. Injected for the same reason `persist` is.
   */
  publishCredits: (vaultAccountId: string, entry: ChatgptAccountLimits, observedAt: number) => void
  now: () => number
}

export class ChatgptRateLimitStore {
  private limits: ChatgptRateLimits = {}
  private inFlight: Promise<void> | null = null
  /** When each account's credits were last READ IN FULL — the date the hub relay carries. */
  private creditsReadAt = new Map<string, number>()

  constructor(private readonly deps: ChatgptRateLimitDeps) {}

  snapshot(): ChatgptRateLimits {
    return structuredClone(this.limits)
  }

  /**
   * Fold one snapshot in under `vaultAccountId`.
   *
   * A snapshot that lacks a window keeps whatever the previous reading
   * established instead of overwriting it with nothing. `readAt` is the instant
   * of the full read; it is the authority for credits and allowance (including
   * their absence), and is omitted only by a caller that has no full read.
   */
  record(
    vaultAccountId: string,
    snapshot: RateLimitSnapshot,
    identity: { email?: string; planType?: string } = {},
    /** FULL read authority for credits and allowance (including their absence). */
    readAt?: number
  ): void {
    const previous = this.limits[vaultAccountId]
    const observedPrimary = rateWindow(snapshot.primary)
    const observedSecondary = rateWindow(snapshot.secondary)
    const primary = observedPrimary ?? previous?.primary ?? null
    const secondary = observedSecondary ?? previous?.secondary ?? null
    const credits =
      readAt === undefined
        ? previous?.credits
        : snapshot.credits?.hasCredits
          ? { unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance }
          : undefined
    const allowance =
      readAt === undefined
        ? previous?.creditLimit
        : (creditLimit(snapshot.individualLimit) ?? undefined)
    const entry: ChatgptAccountLimits = {
      ...((identity.email ?? previous?.email) ? { email: identity.email ?? previous?.email } : {}),
      ...((identity.planType ?? snapshot.planType ?? previous?.planType)
        ? { planType: identity.planType ?? snapshot.planType ?? previous?.planType }
        : {}),
      primary,
      secondary,
      ...(credits ? { credits } : {}),
      ...(allowance ? { creditLimit: allowance } : {}),
      fetchedAt: this.deps.now()
    }
    this.limits[vaultAccountId] = entry

    // The OBSERVED windows, not the merged ones: a sample says "this is what the
    // account read at this instant". The KINDS, though, come from the MERGED
    // pair: the collision rule (two slots of one length) needs both.
    const kinds = windowKindsForReading({ primary, secondary })
    const observed: LimitSampleWindow[] = []
    if (observedPrimary) observed.push(sampleWindow(kinds.primary, observedPrimary))
    if (observedSecondary) observed.push(sampleWindow(kinds.secondary, observedSecondary))
    if (observed.length) this.deps.persist(vaultAccountId, observed)
    // A credits plan has no window to sample; its credits travel on their own,
    // dated by the full read that established them.
    if (readAt !== undefined) {
      if (credits || allowance) this.creditsReadAt.set(vaultAccountId, readAt)
      else this.creditsReadAt.delete(vaultAccountId)
    }
    const readCreditsAt = this.creditsReadAt.get(vaultAccountId)
    if ((entry.credits || entry.creditLimit) && readCreditsAt !== undefined) {
      this.deps.publishCredits(vaultAccountId, entry, readCreditsAt)
    }

    this.deps.changed()
  }

  /** Drop everything the vault no longer holds, so a removed account's bars go. */
  private prune(ids: ReadonlySet<string>): void {
    for (const id of Object.keys(this.limits)) if (!ids.has(id)) delete this.limits[id]
    for (const id of [...this.creditsReadAt.keys()]) {
      if (!ids.has(id)) this.creditsReadAt.delete(id)
    }
  }

  /**
   * Read every stored account's limits. Single-flight: the panel's Refresh and
   * its open-on-mount read must not issue two sweeps.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async run(): Promise<void> {
    const accounts = await this.deps.accounts().catch(() => [])
    this.prune(new Set(accounts.map((account) => account.id)))
    if (accounts.length === 0) {
      this.deps.changed()
      return
    }
    const responses = await this.deps
      .read(accounts.map((account) => account.id))
      .catch(() => new Map<string, ChatgptUsagePayload>())
    for (const account of accounts) {
      const response = responses.get(account.id)
      if (!response) continue
      this.record(
        account.id,
        pickRateLimitSnapshot(response),
        {
          ...(account.email ? { email: account.email } : {}),
          ...(account.planType ? { planType: account.planType } : {})
        },
        this.deps.now()
      )
    }
    this.deps.changed()
  }
}

export const chatgptRateLimits = new ChatgptRateLimitStore({
  accounts: async () => {
    const status = await credentialSync.getStatus()
    return status.accounts.map((account) => ({
      id: account.id,
      ...(account.email ? { email: account.email } : {}),
      ...(account.planType ? { planType: account.planType } : {})
    }))
  },
  read: (accountIds) =>
    readChatgptUsage({
      token: (force, accountId) =>
        credentialSync.injectionTokenFor(accountId, force ? Infinity : undefined),
      fetch: (input, init) => fetch(input, init),
      get appVersion() {
        return hostAppVersion()
      }
    })(accountIds),
  changed: () => {
    emitEvent('usage:chatgpt-limits-changed', [])
    // ADR-071 §6's channel, beside ADR-068's: `usage:limits` answers for every
    // vendor, so a client watching limits across vendors must not have to know
    // which vendor's nudge to listen for.
    emitEvent('usage:limits-changed', [])
  },
  persist: (vaultAccountId, windows) => {
    void persistChatgptSamples(vaultAccountId, windows)
  },
  publishCredits: (vaultAccountId, entry, observedAt) => {
    void publishChatgptCredits(vaultAccountId, entry, observedAt)
  },
  now: () => Date.now()
})

/**
 * Keep one ChatGPT reading under ADR-071 §3's account key.
 *
 * The key is resolved from the VAULT (async, and it reads credentials), which is
 * why this is not inside `record()`. Best-effort: a sample nobody could key is
 * dropped rather than filed under `unknown`, where it would be indistinguishable
 * from every other account's.
 */
async function persistChatgptSamples(
  vaultAccountId: string,
  windows: LimitSampleWindow[]
): Promise<void> {
  try {
    const { accountKey, accountLabel } = await credentialSync.accountIdentity(vaultAccountId)
    if (accountKey === UNKNOWN_ACCOUNT_KEY) return
    // Label and plan are display-only here: the SAMPLE stores neither, and they
    // exist for the hub relay (ADR-072 §4), where a machine that does not hold
    // this credential still has to say whose meter it is looking at.
    recordLimitSamples({
      accountKey,
      accountLabel,
      vendorId: 'openai',
      plan: chatgptRateLimits.snapshot()[vaultAccountId]?.planType ?? null,
      windows
    })
  } catch {
    /* advisory */
  }
}

/**
 * Relay one account's credits under ADR-071 §3's account key (ADR-072 §4,
 * amended 2026-10-01).
 *
 * Keyed from the vault like a sample, and for the same reason it is not inside
 * `record()`. Best-effort, and an account nobody could key is not relayed:
 * `publishCreditReading` refuses `unknown`, where it would be indistinguishable
 * from every other account's.
 */
async function publishChatgptCredits(
  vaultAccountId: string,
  entry: ChatgptAccountLimits,
  observedAt: number
): Promise<void> {
  try {
    const { accountKey, accountLabel } = await credentialSync.accountIdentity(vaultAccountId)
    publishCreditReading({
      accountKey,
      accountLabel: accountLabel ?? entry.email ?? null,
      vendorId: 'openai',
      plan: entry.planType ?? null,
      credits: entry.credits ?? null,
      allowance: entry.creditLimit ?? null,
      observedAt
    })
  } catch {
    /* advisory */
  }
}
