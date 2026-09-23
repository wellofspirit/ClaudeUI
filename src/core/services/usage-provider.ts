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

import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AccountInfo,
  AccountLimits,
  AccountLimitWindow,
  AccountUsage,
  BillingType,
  RateWindow
} from '../../shared/types'
import { anthropicAccountKey, UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { windowKindLabel, windowKindsForReading } from '../../shared/window-kind'
import { usageFetcher, getCliUserAgent } from './usage-fetcher'
import { claudeLimitWindows, fetchClaudeUsage } from './claude-usage-api'
import { claudeDirAccountKey, resolveClaudeDirIdentity } from './claude-account-identity'
import { activeClaudeAttribution, claudeAccountLabel } from './usage-windows'
import { recordLimitSamples } from './window-samples'
import {
  getAllAccounts,
  latestAccountLabels,
  latestWindowSamples,
  listRemoteDevices,
  listRemoteLimits,
  updateAccountIdentity,
  type RemoteLimitRow
} from './db'
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
    // No five-hour window is now literally none (S3c) rather than a fabricated
    // 0 % one, and this gate already means "no window is available".
    if (!usage || usage.error || !usage.fiveHour) return null
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

/**
 * When was this credential file last written? Null when there is none — an
 * account directory with no credentials file is not an account.
 *
 * The mtime is not decoration: it is how a stored account's recorded identity
 * is invalidated. A file written after the identity was last read means the
 * user signed in again, and the account behind that path may now be a
 * different one (S2e).
 */
async function credentialsMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
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
 * Does this stored account's recorded identity still have to be read?
 *
 * Yes when it was never read (migration v23 cleared every row, because the
 * values it held came from the shared `~/.claude.json` and named whichever
 * account cli.js refetched last), and yes when the credential file is newer
 * than the last successful read — a re-login is the one thing that can put a
 * different account behind the same path.
 */
function needsIdentityRead(account: AccountInfo, credentialsMtimeMs: number): boolean {
  if (!account.accountUuid || !account.organizationUuid) return true
  return credentialsMtimeMs > (account.identityCheckedAt ?? 0)
}

/**
 * Read a stored account's identity off its OWN credential and persist it.
 *
 * Only on a refreshing read: it is a network call against that account's token,
 * which is exactly what ADR-071 §6 says happens when a person asks and never
 * on a timer. Returns null when it could not be read, and the caller falls back
 * to whatever the row already said — a reading under a stale key is still more
 * useful than no reading, and the usage read below will report its own failure
 * if the credential is the problem.
 */
async function readStoredIdentity(
  account: AccountInfo,
  credentialsPath: string
): Promise<{ accountKey: string; accountUuid: string } | null> {
  const result = await resolveClaudeDirIdentity({
    credentialsPath,
    allowRefresh: true,
    userAgent: getCliUserAgent()
  })
  if ('error' in result) {
    logger.info(
      'UsageProvider',
      `stored Claude account ${account.id} identity not read: ${result.error} (${result.detail})`
    )
    return null
  }
  try {
    // The organization NAME is not in the profile body, so the label keeps
    // reading the login-captured columns.
    updateAccountIdentity(account.id, {
      accountUuid: result.identity.accountUuid,
      organizationUuid: result.identity.organizationUuid,
      billingType: result.identity.billingType
    })
  } catch (err) {
    logger.debug('UsageProvider', `stored identity write failed: ${err}`)
  }
  const accountKey = claudeDirAccountKey(result.identity)
  logger.info('UsageProvider', `stored Claude account ${account.id} is ${accountKey}`)
  return { accountKey, accountUuid: result.identity.accountUuid }
}

/**
 * Every OTHER stored Claude account (ADR-015's per-account credential dirs).
 *
 * An account with no identity recorded reads under `unknown` with its email as
 * the label — the reading is still worth showing, it just cannot be pooled with
 * the same subscription seen on another machine. A REFRESHING read fixes that
 * first: it asks the account's own credential who it belongs to (S2e) and files
 * the reading under the answer, which is the only way an account that is never
 * made active gets a real key, since migration v23 cleared the identities that
 * were guessed from the shared `~/.claude.json`.
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
    const credentialsMtimeMs = await credentialsMtime(credentialsPath)
    if (credentialsMtimeMs === null) continue

    // BEFORE the usage read, because the key is what the reading is filed
    // under: reading first and re-keying after would leave a sample under the
    // stale key on every path that fails halfway.
    const identity =
      refresh && needsIdentityRead(account, credentialsMtimeMs)
        ? await readStoredIdentity(account, credentialsPath)
        : null
    const accountKey = identity?.accountKey ?? storedAccountKey(account)
    const accountUuid = identity?.accountUuid ?? account.accountUuid
    const base = {
      accountKey,
      // `organization_name` is NULL on every row until the account has been
      // refreshed at least once (migration v23 cleared it), so the
      // login-captured `organization` is the fallback rather than nothing: two
      // subscriptions under one email differ by that word alone.
      label: claudeAccountLabel({
        email: account.email ?? account.id,
        organizationName: account.organizationName ?? account.organization ?? undefined
      }),
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
      const written = recordLimitSamples({
        accountKey,
        accountUuid,
        // Display-only, for the hub relay (ADR-072 §4) — the same three fields
        // the active poll passes, from the base this loop already built.
        accountLabel: base.label,
        vendorId: base.vendorId,
        plan: result.usage.planName ?? account.subscriptionType,
        windows
      })
      persisted += written
      // The key and the counts, never the label: this line is the only trace
      // a refresh leaves, and a refresh spends a grant (ADR-071 §6).
      logger.info(
        'UsageProvider',
        `stored Claude account ${accountKey} read: ${windows.length} window(s), ${written} sample(s) new`
      )
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
    logger.info(
      'UsageProvider',
      `stored Claude account ${accountKey} not read: ${result.error} (${result.detail})`
    )
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
    // Storage keeps no label, so it is rebuilt from the kind — the one rule
    // every surface labels a window by (S3c).
    label: windowKindLabel(sample.windowKind),
    usedPercent: sample.usedPercent,
    // The canonical end IS the window's reset instant (ADR-011's snap rule).
    resetsAt: new Date(sample.canonicalEnd).toISOString(),
    windowMinutes: sample.windowMinutes
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

/** One ChatGPT window in ADR-071 §6's vocabulary, under the kind the reading gave it. */
function chatgptWindow(kind: string, window: RateWindow): AccountLimitWindow {
  return {
    kind,
    label: windowKindLabel(kind),
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes ?? null
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
      // The KIND comes from the length the backend stated, never from the slot
      // the window arrived in (S3c): a plan whose only limit is weekly delivers
      // it as `primary`, and position said it was a five-hour window. The SAME
      // helper the store's sample writer uses, so a meter and the sample behind
      // it can never be filed under two different kinds.
      const kinds = windowKindsForReading(account)
      const windows: AccountLimitWindow[] = []
      if (account.primary) windows.push(chatgptWindow(kinds.primary, account.primary))
      if (account.secondary) windows.push(chatgptWindow(kinds.secondary, account.secondary))
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
export function readAccountLimits(
  opts: { refresh?: boolean; relayed?: boolean } = {}
): Promise<AccountLimits[]> {
  // `relayed` defaults ON: every surface that asks "what are this account's
  // limits" wants the hub's answer for a key it cannot read itself. The one
  // caller that passes `false` is the dashboard's LABEL map, which must not
  // read a `remote_*` table under the `local` scope at all (S5c round 2, R3).
  const relayed = opts.relayed ?? true
  if (!opts.refresh) return readEveryProvider(false, relayed)
  // The single-flight covers the refreshing read only, and every refreshing
  // caller wants the relay, so the flight needs no second key.
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = readEveryProvider(true, relayed).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function readEveryProvider(refresh: boolean, relayed: boolean): Promise<AccountLimits[]> {
  // A refreshing read is the one thing in the app that may spend refresh
  // grants, so it always leaves a line; a cheap read is debug-only.
  logger[refresh ? 'info' : 'debug']('UsageProvider', `limits read (refresh: ${refresh})`)
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
  const local = readings.flat()
  return relayed ? [...local, ...relayedLimits(local)] : local
}

// ---------------------------------------------------------------------------
// Relayed readings (ADR-072 §4, slice S5c)
// ---------------------------------------------------------------------------

/**
 * The accounts only ANOTHER machine holds a credential for, as that machine
 * last read them.
 *
 * This is the direct answer to ADR-071 §6's refresh-grant problem: a reading
 * costs the account one grant wherever it is taken, and the hub already has the
 * one another machine paid for. So a key this machine cannot read shows that
 * reading and spends nothing — the stored-account path above is untouched, and
 * in particular nothing here can make it try a 401'd credential again.
 *
 * NOT SCOPED to the combined dashboard view. Limits are the account's state
 * right now, which is one fact however many machines watch it (ADR-072 §4); the
 * `local` / `all` switch is about whose SPEND is being added up, a different
 * question. What the scope does decide is the machines column beside the row.
 *
 * A KEY WITH A LOCAL READING KEEPS IT, whatever its state. Even
 * `needs-sign-in` — that says this machine's own credential is dead, which is
 * something the person has to fix here, and replacing it with a healthy reading
 * from elsewhere would hide the only place the problem shows.
 */
function relayedLimits(local: ReadonlyArray<AccountLimits>): AccountLimits[] {
  let rows: RemoteLimitRow[]
  try {
    rows = listRemoteLimits()
  } catch (err) {
    // The remote cache being unreadable must not take the local readings down
    // with it: they are the ones with meters on screen.
    logger.debug('UsageProvider', `relayed limits unavailable: ${err}`)
    return []
  }
  if (rows.length === 0) return []

  const held = new Set(local.map((entry) => entry.accountKey))
  // The hub's machine list, so a reading can say WHO took it rather than only
  // which uuid did (R2). It is the same cache the machine card reads; a device
  // the hub has since dropped leaves the id as the only honest answer.
  let deviceNames = new Map<string, string>()
  try {
    deviceNames = new Map(listRemoteDevices().map((device) => [device.deviceId, device.deviceName]))
  } catch (err) {
    logger.debug('UsageProvider', `relayed device names unavailable: ${err}`)
  }
  // The ledger's own label wins over the hub's masked one: if this machine has
  // ever recorded a turn for the key it knows what the account is called, and
  // showing `d•••@e•••.com` beside spend attributed to a name would read as two
  // different accounts.
  const ledgerLabels = latestAccountLabels()

  const byAccount = new Map<
    string,
    { vendorId: string; plan: string | null; rows: RemoteLimitRow[] }
  >()
  for (const row of rows) {
    // `unknown` is the bucket every unattributable row shares, never an account
    // (ADR-071 §3) — the same rule the local readings follow.
    if (row.accountKey === UNKNOWN_ACCOUNT_KEY || held.has(row.accountKey)) continue
    const entry = byAccount.get(row.accountKey)
    if (entry) entry.rows.push(row)
    else byAccount.set(row.accountKey, { vendorId: row.vendorId, plan: row.plan, rows: [row] })
  }

  const out: AccountLimits[] = []
  for (const [accountKey, entry] of byAccount) {
    // One reading per kind, so the window order is the vendor's rather than the
    // order the pull happened to write the rows in.
    const windows: AccountLimitWindow[] = entry.rows
      .slice()
      .sort((a, b) => a.windowKind.localeCompare(b.windowKind))
      .map((row) => ({
        kind: row.windowKind,
        label: windowKindLabel(row.windowKind),
        usedPercent: row.usedPercent,
        resetsAt: row.resetsAt,
        windowMinutes: row.windowMinutes
      }))
    // The newest observation across the kinds: the age a surface shows is the
    // age of the freshest thing on the row.
    const observedAt = Math.max(...entry.rows.map((row) => row.observedAt))
    const newest = entry.rows.find((row) => row.observedAt === observedAt) ?? entry.rows[0]
    const ledgerLabel = ledgerLabels.get(accountKey)
    out.push({
      accountKey,
      label: ledgerLabel ?? newest.labelMasked ?? accountKey,
      vendorId: entry.vendorId,
      plan: entry.plan,
      windows,
      observedAt,
      source: {
        deviceId: newest.deviceId,
        deviceName: deviceNames.get(newest.deviceId)?.trim() || newest.deviceId
      },
      ...(ledgerLabel === undefined && newest.labelMasked !== null ? { labelMasked: true } : {}),
      // `ok` rather than `stale`: the reading is as current as the account's
      // state gets, and `stale` means "this machine did not spend a grant",
      // which is a claim about a credential it does not hold. How old it is
      // travels as `observedAt`, which is what the `via <machine>` tag reads.
      state: 'ok'
    })
  }
  return out
}
