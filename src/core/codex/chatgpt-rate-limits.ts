/**
 * ChatGPT subscription usage, per VAULT account (ADR-068 §2).
 *
 * Two sources feed ONE map, which is why this module exists rather than a field
 * on either of them:
 *
 *  - a PULL, `CodexService.rateLimits`, driven by the sidebar usage panel
 *    opening or refreshing. Each stored account's own HOST answers for it
 *    (ADR-069 §1), so nothing re-injects across accounts and nothing spawns;
 *  - a PUSH, `account/rateLimits/updated`, which every live Codex session
 *    forwards under the account it was injected with.
 *
 * There is NO polling timer. A subscription's rate limits are interesting while
 * somebody is looking at them, and every turn a live session runs already pushes
 * a fresh snapshot for free.
 *
 * Keyed by vault account id, never by the ChatGPT WORKSPACE id: two vault
 * accounts can share a workspace, and the picker, the session pin and the usage
 * rows all speak the vault's vocabulary.
 */
import { homedir } from 'node:os'
import type { ChatgptAccountLimits, ChatgptRateLimits, RateWindow } from '../../shared/types'
import { CodexService } from './CodexService'
import { codexBinaryAvailable } from './codex-locate'
import { credentialSync } from '../auth/vault/CredentialSync'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { RateLimitWindow } from './protocol/v2/RateLimitWindow'
import { emitEvent } from '../services/sync-host'

/**
 * `resetsAt` is a unix timestamp in SECONDS.
 *
 * The GENERATED type says only `number | null` — ts-rs copies no doc comment
 * onto the v2 struct — so the unit comes from the core type the v2 one converts
 * from verbatim (`protocol/src/protocol.rs`: "Unix timestamp (seconds since
 * epoch) when the window resets"; `app-server-protocol/src/protocol/v2/account.rs`
 * `impl From<CoreRateLimitWindow>` assigns `resets_at` unchanged). Codex's own
 * test vectors agree — `1735693200` is 2025-01-01T01:00:00Z, not 1970.
 *
 * Multiplying by 1000 is therefore the whole conversion; ClaudeUI's `RateWindow`
 * carries ISO 8601 because `formatResetTime` and every Claude usage row already do.
 */
export function rateWindow(window: RateLimitWindow | null | undefined): RateWindow | null {
  if (!window || typeof window.usedPercent !== 'number') return null
  const seconds = window.resetsAt
  return {
    usedPercent: window.usedPercent,
    resetsAt:
      typeof seconds === 'number' && Number.isFinite(seconds)
        ? new Date(seconds * 1000).toISOString()
        : null
  }
}

/** Does this snapshot say anything at all about what the account can spend? */
function saysSomething(snapshot: RateLimitSnapshot | undefined): boolean {
  return (
    !!snapshot && (!!snapshot.primary || !!snapshot.secondary || !!snapshot.credits?.hasCredits)
  )
}

/**
 * Which snapshot of an `account/rateLimits/read` answer to believe.
 *
 * `rateLimits` is the backward-compatible single-bucket view and is what every
 * account observed so far fills, so it wins whenever it says anything. The
 * `rateLimitsByLimitId` fallback is DEFENSIVE: an account whose top-level view
 * carried neither windows nor credits, while the metered `codex` bucket held
 * them, would otherwise render as "no data" with the numbers one field away.
 * `codex` is preferred by name because that is the limit ClaudeUI spends; any
 * other single bucket is better than nothing.
 */
export function pickRateLimitSnapshot(response: GetAccountRateLimitsResponse): RateLimitSnapshot {
  if (saysSomething(response.rateLimits)) return response.rateLimits
  const buckets = response.rateLimitsByLimitId ?? {}
  const codex = buckets.codex
  if (saysSomething(codex)) return codex as RateLimitSnapshot
  for (const bucket of Object.values(buckets)) if (saysSomething(bucket)) return bucket!
  return response.rateLimits
}

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
   * One read per account, each on that account's own host. Answers the WHOLE
   * `account/rateLimits/read` response: choosing which bucket of it to believe
   * is this module's job ({@link pickRateLimitSnapshot}), not the transport's.
   */
  read: (accountIds: ReadonlyArray<string>) => Promise<Map<string, GetAccountRateLimitsResponse>>
  /** Tells clients the map moved. No payload: they re-query. */
  changed: () => void
  now: () => number
}

export class ChatgptRateLimitStore {
  private limits: ChatgptRateLimits = {}
  private inFlight: Promise<void> | null = null

  constructor(private readonly deps: ChatgptRateLimitDeps) {}

  snapshot(): ChatgptRateLimits {
    return structuredClone(this.limits)
  }

  /**
   * Fold one native snapshot in under `vaultAccountId`.
   *
   * A SPARSE update (the notification's own doc comment says nullable metadata
   * "does not clear a previously observed value") must not erase a window the
   * last full read established, so a null window keeps whatever is already
   * there instead of overwriting it with nothing.
   */
  record(
    vaultAccountId: string,
    snapshot: RateLimitSnapshot,
    identity: { email?: string; planType?: string } = {}
  ): void {
    const previous = this.limits[vaultAccountId]
    const primary = rateWindow(snapshot.primary) ?? previous?.primary ?? null
    const secondary = rateWindow(snapshot.secondary) ?? previous?.secondary ?? null
    // Same sparse rule as the windows: only a snapshot that actually says the
    // account HAS credits replaces what the last full read established.
    const credits = snapshot.credits?.hasCredits
      ? { unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance }
      : previous?.credits
    const entry: ChatgptAccountLimits = {
      ...((identity.email ?? previous?.email) ? { email: identity.email ?? previous?.email } : {}),
      ...((identity.planType ?? snapshot.planType ?? previous?.planType)
        ? { planType: identity.planType ?? snapshot.planType ?? previous?.planType }
        : {}),
      primary,
      secondary,
      ...(credits ? { credits } : {}),
      fetchedAt: this.deps.now()
    }
    this.limits[vaultAccountId] = entry
    this.deps.changed()
  }

  /** Drop everything the vault no longer holds, so a removed account's bars go. */
  private prune(ids: ReadonlySet<string>): void {
    for (const id of Object.keys(this.limits)) if (!ids.has(id)) delete this.limits[id]
  }

  /**
   * Read every stored account's limits. Single-flight: the panel's Refresh and
   * its open-on-mount read must not spawn two app-servers.
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
      .catch(() => new Map<string, GetAccountRateLimitsResponse>())
    for (const account of accounts) {
      const response = responses.get(account.id)
      if (!response) continue
      this.record(account.id, pickRateLimitSnapshot(response), {
        ...(account.email ? { email: account.email } : {}),
        ...(account.planType ? { planType: account.planType } : {})
      })
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
  read: async (accountIds) => {
    if (!codexBinaryAvailable()) return new Map()
    // A facade, not a process: the service is built per sweep and disposed with
    // it, and all it holds are LEASES on the per-account hosts (ADR-069 §1).
    // `{ accountId: null }` is only the default identity — `rateLimits` acquires
    // one host per id in the list.
    const service = new CodexService({
      cwd: homedir(),
      identity: { accountId: null },
      label: 'rate-limits'
    })
    try {
      return await service.rateLimits(accountIds)
    } finally {
      service.dispose()
    }
  },
  changed: () => emitEvent('usage:chatgpt-limits-changed', []),
  now: () => Date.now()
})
