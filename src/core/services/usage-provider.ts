/**
 * Limits providers — one per vendor (ADR-071 §6).
 *
 * A limits provider answers "what can this account still spend", in one shape
 * for every vendor, for every account this machine holds credentials for — not
 * only the one that happens to be active. That is the whole difference from
 * what came before: `UsageFetcher` polls the ACTIVE Claude account and
 * `ChatgptRateLimitStore` holds the vault's ChatGPT accounts in memory, and
 * neither could answer for a Claude account the user is not signed into right
 * now, which is exactly the account whose limits they want to see before
 * switching to it.
 *
 * **Inactive Claude accounts are never refreshed in the background.** Anthropic
 * may limit how many refresh grants an account gets, and a timer spending them
 * on accounts nobody is using is the wrong trade (owner's rule, ADR-071 §6). So
 * there is no timer here at all: `refresh: false` answers from what was last
 * PERSISTED and spends nothing, and `refresh: true` — a person opening the
 * dashboard or pressing refresh — is the only thing that reads a stored
 * account's credentials.
 *
 * The older `UsageProvider` below is untouched and stays where it was: it is the
 * per-session window gate (`billingType === 'subscription'` AND a provider
 * exists), a different question from "what are this account's limits", and
 * `claude-session.ts` reads it on every metering snapshot.
 */

import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AccountLimits,
  AccountLimitWindow,
  AccountUsage,
  BillingType
} from '../../shared/types'
import { anthropicAccountKey, UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { usageFetcher, getCliUserAgent } from './usage-fetcher'
import { claudeLimitWindows, fetchClaudeUsage } from './claude-usage-api'
import { activeClaudeAttribution } from './usage-windows'
import { recordLimitSamples } from './window-samples'
import { getAllAccounts, latestWindowSamples } from './db'
import { chatgptRateLimits } from '../codex/chatgpt-rate-limits'
import { credentialSync } from '../auth/vault/CredentialSync'
import { buildClaudeAccountRef, hostAccountsDir } from '../host'
import { getSecurestorageEnv } from '../sdk/securestorage-env'
import { emitEvent } from './sync-host'
import { logger } from './logger'

/** A window observation for a subscription account. */
export interface UsageWindow {
  usedPercent: number
  resetsAt: string | null
}

/** Per-account usage-data provider. Returns null when no window is available. */
export interface UsageProvider {
  /** Resolve the current 5h window for this account, or null if none/unavailable. */
  getWindow(): UsageWindow | null
}

/** Claude provider — wraps usageFetcher's /api/oauth/usage poll (ADR-011). */
const claudeUsageProvider: UsageProvider = {
  getWindow(): UsageWindow | null {
    const usage = usageFetcher.getLastUsage()
    if (!usage || usage.error) return null
    return { usedPercent: usage.fiveHour.usedPercent, resetsAt: usage.fiveHour.resetsAt }
  }
}

/**
 * Resolve the usage provider for an (engineId, vendorId, billingType) triple.
 * Returns null when no provider exists OR the account isn't subscription-billed
 * (windows are subscription-gated). opencode/apiKey/free → null (cumulative
 * meter, no window).
 */
export function resolveUsageProvider(
  engineId: string,
  vendorId: string,
  billingType: BillingType
): UsageProvider | null {
  if (billingType !== 'subscription') return null
  // Only Claude/anthropic has a usage provider today. ChatGPT-via-opencode is
  // conceptually windowed but exposes no usage API to us yet (foundation §7).
  if (engineId === 'claude' && vendorId === 'anthropic') return claudeUsageProvider
  return null
}

// ---------------------------------------------------------------------------
// Limits providers (ADR-071 §6)
// ---------------------------------------------------------------------------

export interface LimitsProvider {
  vendorId: string
  /**
   * Every account this vendor holds credentials for. `refresh: false` must not
   * make a network call for an account that is not already being read for other
   * reasons — that is the refresh-grant rule, and the guard test for it spies on
   * the API function.
   */
  read(opts: { refresh: boolean }): Promise<AccountLimits[]>
}

/** Does this path exist? (An account directory with no credentials file is not an account.) */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The display name of a window kind read back from storage (which keeps no label). */
function windowKindLabel(kind: string): string {
  if (kind === '5h') return '5-hour'
  if (kind === '7d') return '7-day'
  if (kind.startsWith('7d:')) return `7-day ${kind.slice(3).replace(/-/g, ' ')}`
  return kind
}

/**
 * The ACTIVE Claude account, from the poller that already owns it — or NOTHING
 * when there is no Claude account at all.
 *
 * "No account signed in" and "an account whose limits we could not read" are
 * different answers, and only the second one is a card. A machine that only
 * uses Codex would otherwise show an `unknown` / unavailable Claude row forever.
 */
async function activeClaudeLimits(refresh: boolean): Promise<AccountLimits | null> {
  // Never a second fetch: `fetch()` is the poller's own path (it pushes to the
  // renderer and records the samples), and `getLastUsage()` is what it left. A
  // rejection from it is the poller's problem, not a reason to lose the stored
  // accounts, so it degrades this one card instead.
  let usage: AccountUsage | null = null
  let failure: string | null = null
  try {
    usage = refresh ? await usageFetcher.fetch() : usageFetcher.getLastUsage()
  } catch (err) {
    failure = `${err}`
  }
  const active = usageFetcher.getActiveAccount()
  if (!active && !usage) return null

  const attribution = activeClaudeAttribution(active, buildClaudeAccountRef()?.billingType)
  const base = {
    accountKey: attribution.accountKey,
    label: attribution.accountLabel ?? attribution.email ?? 'Claude',
    vendorId: 'anthropic',
    source: 'local' as const
  }
  const error = failure ?? usage?.error ?? null
  if (!usage || error) {
    return {
      ...base,
      plan: null,
      windows: [],
      observedAt: usage?.fetchedAt ?? 0,
      state: 'unavailable',
      ...(error ? { error } : {})
    }
  }
  return {
    ...base,
    plan: usage.planName,
    windows: claudeLimitWindows(usage),
    observedAt: usage.fetchedAt,
    state: 'ok'
  }
}

/** The account key a STORED account was last seen under, or `unknown`. */
function storedAccountKey(account: {
  accountUuid?: string | null
  organizationUuid?: string | null
}): string {
  // Both halves or neither, as ADR-071 §3 requires: half of
  // `anthropic:<org>:<account>` names no subscription.
  if (!account.accountUuid || !account.organizationUuid) return UNKNOWN_ACCOUNT_KEY
  return anthropicAccountKey(account.organizationUuid, account.accountUuid)
}

/**
 * Every OTHER stored Claude account (ADR-015's per-account credential dirs).
 *
 * An account that has not been active since migration v21 shipped has no
 * identity recorded, so its key is `unknown` and its email is the label — the
 * reading is still worth showing, it just cannot be pooled with the same
 * subscription seen on another machine until it has been active once.
 */
async function storedClaudeLimits(refresh: boolean): Promise<{
  limits: AccountLimits[]
  persisted: number
}> {
  const activeDir = getSecurestorageEnv()?.dir
  // Single-account mode: there is exactly one credential file and the active
  // account above already answered for it.
  if (!activeDir) return { limits: [], persisted: 0 }

  const activeId = basename(activeDir)
  const root = hostAccountsDir()
  const limits: AccountLimits[] = []
  let persisted = 0

  for (const account of getAllAccounts()) {
    if (account.id === activeId) continue
    const credentialsPath = join(root, account.id, '.credentials.json')
    if (!(await exists(credentialsPath))) continue

    const accountKey = storedAccountKey(account)
    const base = {
      accountKey,
      label: account.organizationName
        ? `${account.email ?? account.id} (${account.organizationName})`
        : (account.email ?? account.id),
      vendorId: 'anthropic',
      plan: account.subscriptionType,
      source: 'local' as const
    }

    if (!refresh) {
      limits.push({ ...base, ...lastPersistedReading(accountKey) })
      continue
    }

    const result = await fetchClaudeUsage({
      credentialsPath,
      allowRefresh: true,
      userAgent: getCliUserAgent()
    })
    if ('usage' in result) {
      const windows = claudeLimitWindows(result.usage)
      persisted += recordLimitSamples({
        accountKey,
        accountUuid: account.accountUuid,
        windows
      })
      limits.push({
        ...base,
        plan: result.usage.planName ?? account.subscriptionType,
        windows,
        observedAt: result.usage.fetchedAt,
        state: 'ok'
      })
      continue
    }
    // No retry and no timer: ADR-071 §6 says mark it and stop.
    limits.push({
      ...base,
      windows: [],
      observedAt: 0,
      state: result.error === 'needs-sign-in' ? 'needs-sign-in' : 'unavailable',
      error: result.detail
    })
  }

  return { limits, persisted }
}

/** What an account's limits are when no token may be spent on it. */
function lastPersistedReading(
  accountKey: string
): Pick<AccountLimits, 'windows' | 'observedAt' | 'state'> {
  // `unknown` is the bucket EVERY unattributable row shares, so reading it back
  // as one account's limits would show another account's numbers.
  const samples = accountKey === UNKNOWN_ACCOUNT_KEY ? [] : latestWindowSamples(accountKey)
  if (samples.length === 0) return { windows: [], observedAt: 0, state: 'unavailable' }
  const windows: AccountLimitWindow[] = samples.map((sample) => ({
    kind: sample.windowKind,
    label: windowKindLabel(sample.windowKind),
    usedPercent: sample.usedPercent,
    // The canonical end IS the window's reset instant (ADR-011's snap rule).
    resetsAt: new Date(sample.canonicalEnd).toISOString()
  }))
  return {
    windows,
    observedAt: Math.max(...samples.map((sample) => sample.ts)),
    state: 'stale'
  }
}

const claudeLimitsProvider: LimitsProvider = {
  vendorId: 'anthropic',
  async read({ refresh }) {
    const active = await activeClaudeLimits(refresh)
    // The active account's reading is in memory; the stored ones need the
    // database and the disk. One of those failing must not take the account the
    // user is actually signed into off the screen with it.
    const stored = await storedClaudeLimits(refresh).catch((err) => {
      logger.warn('UsageProvider', `stored Claude accounts unavailable: ${err}`)
      return { limits: [] as AccountLimits[], persisted: 0 }
    })
    // The active account's samples are written by the poll itself; only the
    // stored accounts' readings are new information from this call.
    if (stored.persisted > 0) emitEvent('usage:limits-changed', [])
    return active ? [active, ...stored.limits] : stored.limits
  }
}

const chatgptLimitsProvider: LimitsProvider = {
  vendorId: 'openai',
  async read({ refresh }) {
    // The store owns the reading (one host per account, ADR-069 §1) and
    // persists its own samples on `record()`. This maps, and nothing else.
    if (refresh) await chatgptRateLimits.refresh()
    const snapshot = chatgptRateLimits.snapshot()
    const limits: AccountLimits[] = []
    for (const [vaultAccountId, account] of Object.entries(snapshot)) {
      const identity = await credentialSync.accountIdentity(vaultAccountId)
      const windows: AccountLimitWindow[] = []
      if (account.primary) windows.push({ kind: '5h', label: '5-hour', ...account.primary })
      if (account.secondary) windows.push({ kind: '7d', label: '7-day', ...account.secondary })
      limits.push({
        accountKey: identity.accountKey,
        label: identity.accountLabel ?? account.email ?? vaultAccountId,
        vendorId: 'openai',
        plan: account.planType ?? null,
        windows,
        ...(account.credits ? { credits: account.credits } : {}),
        observedAt: account.fetchedAt,
        source: 'local',
        state: 'ok'
      })
    }
    return limits
  }
}

/** Every limits provider, in display order. */
export function limitsProviders(): LimitsProvider[] {
  return [claudeLimitsProvider, chatgptLimitsProvider]
}

/** The refreshing read in flight, if any — see {@link readAccountLimits}. */
let refreshInFlight: Promise<AccountLimits[]> | null = null

/**
 * Every account's limits, across vendors.
 *
 * A provider that throws yields nothing rather than failing the whole read: one
 * vendor being unreachable must not blank the other's bars. Failures WITHIN a
 * provider — a stored account that needs a sign-in — travel as `state` on that
 * account, which is the case the dashboard has to render.
 *
 * A REFRESHING read is single-flighted, exactly as `ChatgptRateLimitStore.refresh()`
 * is and for a stronger reason: this channel is registered on both transports,
 * so a desktop dashboard and a phone can ask at the same moment, and every
 * concurrent sweep is a second set of refresh grants spent on the same accounts
 * (a double-click on one Refresh button does it too). `claude-usage-api` guards
 * the individual credential file; this guards the sweep, so the ChatGPT hosts
 * are not spawned twice either. A non-refreshing read is local and cheap, and
 * must not queue behind a refresh, so it runs on its own.
 */
export function readAccountLimits(opts: { refresh?: boolean } = {}): Promise<AccountLimits[]> {
  if (!opts.refresh) return readEveryProvider(false)
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = readEveryProvider(true).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function readEveryProvider(refresh: boolean): Promise<AccountLimits[]> {
  const readings = await Promise.all(
    limitsProviders().map(async (provider) => {
      try {
        return await provider.read({ refresh })
      } catch (err) {
        logger.warn('UsageProvider', `${provider.vendorId} limits unavailable: ${err}`)
        return [] as AccountLimits[]
      }
    })
  )
  return readings.flat()
}
