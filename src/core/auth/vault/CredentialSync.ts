/**
 * CredentialSync — feed-forward, sole-refresher, fs-watch resync for the M6a
 * AuthVault's Codex (ChatGPT) credential (M6b).
 *
 * SEPARATION FROM AuthVault (DECISION): this is a SIBLING service that HOLDS
 * an AuthVault (`VaultLike`, see below), not new methods bolted onto
 * AuthVault itself. AuthVault.ts's own header draws this boundary explicitly
 * ("M6a scope is deliberately narrow: storage + the login-flow entry points
 * only ... Feeding credentials to pi/opencode, background refresh-before-
 * expiry, and a filesystem watch all land in M6b"). AuthVault's job is
 * plaintext vault storage + login-flow orchestration (SRP); this class's
 * job is lifecycle orchestration ACROSS three stores (the vault + two engine
 * auth files) — timers, fs.watch, retry/backoff, and reconciliation logic.
 * Keeping them separate also keeps AuthVault.test.ts's storage fixtures
 * untouched by any of this file's timer/fs-watch machinery.
 *
 * DEPENDENCY DIRECTION (avoiding an import cycle): PiAuthProvider.ts drives
 * this service (oauthAuthorize/oauthCallback → beginLogin/completeLogin), and
 * this service must feed INTO piAuthProvider/opencodeAuthProvider — a naive
 * two-way static import would cycle. This module defines its OWN narrow
 * structural interfaces (`VaultLike`, `CodexFeedTarget`) instead of importing
 * AuthVault/PiAuthProvider/OpencodeAuthProvider's concrete classes, and the
 * concrete engine targets are wired in from OUTSIDE via `configure()` — the
 * SAME dependency-injection shape already used for
 * `OpencodeServerManager.setCallerSessionLookup` (wired from main/index.ts)
 * to break an analogous cycle. `register-auth-providers.ts` is the
 * composition root: it already imports piAuthProvider + opencodeAuthProvider
 * to populate the engine-auth registry, so wiring `credentialSync.configure()`
 * there adds zero new import edges on the provider side.
 *
 * ACCOUNTS (ADR-068 §2). The vault holds N ChatGPT accounts with one ACTIVE.
 * This service refreshes EVERY stored account on its own timer (a background
 * account's refresh token dies on its own clock), but vends only the ACTIVE one
 * to pi and opencode, whose auth stores hold a single Codex entry each. Switching
 * re-vends both and rings `onActiveAccountChanged` so the boot seam can move the
 * sessions that follow the active account off the Codex host they were on
 * (ADR-069 §4) without this module importing a session. Reconcile-on-start and the
 * fs-watch adoption still operate on the ACTIVE account alone: an engine store
 * holds the credential WE vended, so a rotation found there belongs to that
 * account and to no other. A `VaultLike` with no account methods is driven
 * exactly as before — one credential, one timer.
 *
 * HARD SAFETY NOTE (same as AuthVault.ts / codex-oauth.ts): no test may let
 * `refreshAccessToken` reach the real auth.openai.com — every scheduler test
 * injects a fake `refreshAccessToken`; every watcher test uses fake
 * CodexFeedTarget objects backed by temp files, never `~/.pi` or the real
 * opencode data dir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../services/logger'
import { authVault, CHATGPT_PROVIDER_ID, type VaultAccount } from './AuthVault'
import {
  buildVaultCredential,
  refreshAccessToken as defaultRefreshAccessToken,
  type TokenResponse,
  type VaultCredential
} from './codex-oauth'
import type { DeviceCodeStart } from './codex-device-code'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** pi's auth.json key for the Codex credential (PiAuthProvider.ts's PI_SUBSCRIPTION_VENDOR_IDS). */
export const PI_CODEX_VENDOR_ID = 'openai-codex'
/** opencode's auth.json key for the Codex credential — its ChatGPT-plugin provider id (recon-verified; NOT 'openai-codex'). */
export const OPENCODE_CODEX_VENDOR_ID = 'openai'

/**
 * How long BEFORE `expires` the vault refreshes. The engines themselves only
 * refresh at `expires < now` with NO margin (verified against the port
 * source's codex.ts:353-equivalent check) — the vault refreshing 15 minutes
 * early means it always wins the race, so pi/opencode read a still-fresh
 * access token off disk instead of hitting an expired one and refreshing
 * (and rotating the refresh token) themselves.
 */
export const REFRESH_MARGIN_MS = 15 * 60 * 1000
/** The longest delay `setTimeout` honours; anything above fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Debounce window for the fs.watch resync — matches automation-manager.ts's own 500ms precedent. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 500

/** Linear backoff step for a transient (non-401) refresh failure: attempt N waits N * this. */
export const RETRY_BASE_MS = 30 * 1000
/** After this many consecutive transient failures, give up the current retry loop and re-arm on an escalating give-up backoff (below) rather than the normal schedule — the normal schedule fires ~immediately since the original margin has already passed, which would otherwise hammer the token endpoint in a perpetual ~5-requests/3-min loop during an outage. */
export const MAX_TRANSIENT_RETRIES = 3

/** Base wait after a full transient-retry cycle exhausts. The give-up delay escalates linearly per consecutive give-up cycle (base * N) up to the ceiling, so an extended endpoint outage backs off instead of re-firing immediately. Reset on any successful refresh / adoption / fresh login (via scheduleRefresh). */
export const GIVE_UP_BACKOFF_BASE_MS = 5 * 60 * 1000
/** Ceiling for the escalating give-up backoff. The refresh token typically outlives this, so backing off this long is safe — a recovered endpoint refreshes on the next wake (or the engine adopts, resetting the loop). */
export const GIVE_UP_BACKOFF_MAX_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Structural interfaces (deliberately NOT importing the concrete classes —
// see the module header's "DEPENDENCY DIRECTION" note).
// ---------------------------------------------------------------------------

/**
 * The slice of AuthVault this service needs. The real `authVault` singleton
 * satisfies this structurally.
 *
 * The ACCOUNT half (ADR-068 §2) is optional so a fake can stay a single
 * credential: a vault without it is driven exactly as before — one credential,
 * one timer — and every plural path below degrades to that one account.
 * `load()`/`save()` keep meaning "the ACTIVE account", which is what the
 * single-slot pi and opencode stores are fed.
 */
export interface VaultLike {
  load(): Promise<VaultCredential | null>
  save(cred: VaultCredential): Promise<void>
  listAccounts?(providerId: string): Promise<VaultAccount[]>
  getActiveAccountId?(providerId: string): Promise<string | null>
  setActiveAccount?(providerId: string, id: string): Promise<void>
  removeAccount?(providerId: string, id: string): Promise<void>
  saveAccountCredential?(providerId: string, id: string, cred: VaultCredential): Promise<void>
  removeCredential?(providerId: string): Promise<void>
  hasUnreadableLegacyVault?(): boolean
  beginLogin(): Promise<{ authorizeUrl: string }>
  completeLogin(): Promise<VaultCredential>
  /** ADR-057 remote paste-back completion. Optional so fakes stay minimal. */
  completeLoginFromPastedInput?(input: string): Promise<VaultCredential>
  /**
   * ADR-068 §3 / Slice 7 device-code start. Optional so fakes stay minimal.
   * `completeLogin()` then awaits whichever flow the vault has live, which is
   * why there is no `completeDeviceCodeLogin` twin.
   */
  beginDeviceCodeLogin?(): Promise<DeviceCodeStart>
  cancelLogin(): void
}

/** What feedAll() writes into one engine's store. */
export interface CodexCredentialInput {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

/** What readOauthEntry() reads back from one engine's store. */
export interface CodexEntrySnapshot {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

/**
 * One engine's half of the feed-forward / resync loop. PiAuthProvider and
 * OpencodeAuthProvider each implement this (structurally — no import here).
 */
export interface CodexFeedTarget {
  /** Absolute path to this engine's OWN auth-store file — used to derive the fs.watch dir + filename filter. */
  authFilePath(): string
  /** RMW-merge a Codex OAuth credential into this engine's auth store under `vendorId`. */
  feedOauthCredential(vendorId: string, cred: CodexCredentialInput): Promise<void>
  /** Read this engine's current Codex entry, or null if absent/non-oauth/malformed. */
  readOauthEntry(vendorId: string): Promise<CodexEntrySnapshot | null>
  /** Remove this vendor's native credential and invalidate the target's auth cache. */
  removeVendorAuth(vendorId: string): Promise<void>
}

export interface CodexEnabledRoutes {
  pi: boolean
  opencode: boolean
}

export interface CredentialSyncDeps {
  vault?: VaultLike
  now?: () => number
  refreshAccessToken?: (refreshToken: string) => Promise<TokenResponse>
  watchDebounceMs?: number
  getEnabledRoutes?: () => CodexEnabledRoutes
  /**
   * Rung AFTER the active account changed and both engine stores were re-fed.
   * The boot seam wires it (`core/boot/core-services.ts`) without this module
   * importing a session or an engine; the default is a no-op. Codex's hosts are
   * the one consumer today (ADR-069 §4) — opencode recycles from its own auth
   * provider's mutation points instead (ADR-047).
   */
  onActiveAccountChanged?: () => void | Promise<void>
  /**
   * Rung once AFTER a ChatGPT login has been applied — the one post-completion
   * tail every login path runs ({@link CredentialSync.applyCompletedLogin}), so
   * the desktop loopback, the ADR-057 paste-back and the Slice-7 device code all
   * ring it exactly once and none of them owns a copy.
   *
   * INJECTED rather than an `emitEvent` import (ADR-070 §2): this class is
   * unit-tested with almost nothing mocked, and importing `sync-host` would drag
   * the service graph into those tests. Same posture, same boot seam and same
   * no-op default as {@link CredentialSyncDeps.onActiveAccountChanged} above.
   *
   * A throw is caught and logged, never propagated: by the time this rings, the
   * credential is stored and vended, so failing the login would be a lie.
   *
   * `accountId` is the VAULT account key the credential landed on — the same
   * id-space {@link CodexInjectionToken.vaultAccountId} reports, so the two
   * halves of ADR-070 §2 compare on one id. It matters because a provider holds
   * several accounts: adding account B must not announce that the sessions
   * broken on account A are fixed. `undefined` for a vault with no named
   * account: {@link LEGACY_ACCOUNT_KEY} is this class's own slot key, not an
   * account, and the listener's event is replicated — with nothing to tell
   * apart there is nothing to name.
   */
  onCredentialStored?: (accountId: string | undefined) => void
}

/**
 * The scheduler key for a vault with no account support — one credential, one
 * timer, the pre-ADR-068 shape. Never collides with a vault account id (those
 * are hex).
 */
const LEGACY_ACCOUNT_KEY = '__active__'

/** Everything the refresher tracks for ONE account. */
interface AccountRuntime {
  refreshTimer?: ReturnType<typeof setTimeout>
  retryTimer?: ReturnType<typeof setTimeout>
  retryCount: number
  /** Consecutive give-up cycles — drives the escalating give-up backoff. */
  giveUpCount: number
  refreshInFlight: Promise<void> | null
  needsReauth: boolean
}

/** One account as `getStatus()` reports it — never any token material. */
export interface CredentialAccountStatus {
  id: string
  email?: string
  accountId?: string
  planType?: string
  expiresAt: number
  needsReauth: boolean
}

/**
 * What ONE Codex process is injected with (ADR-068 §1). The ONLY shape in this
 * module that carries token material across its boundary — see
 * {@link CredentialSync.injectionTokenFor}.
 */
export interface CodexInjectionToken {
  /** The ChatGPT access token (a JWT). Never logged, never persisted by Codex. */
  accessToken: string
  /** The workspace id Codex keys the account on (`chatgpt_account_id`). */
  chatgptAccountId: string
  chatgptPlanType: string | null
  /** The VAULT account id this token came from — not the workspace id. */
  vaultAccountId: string
}

type EngineKey = 'pi' | 'opencode'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Classify a refresh failure as REVOKED (the refresh token is dead — no retry
 * will help; surface needsReauth) vs TRANSIENT (retry with backoff).
 *
 * REVOKED = an `invalid_grant` body (RFC 6749 §5.2 — the canonical
 * revoked/expired-refresh-token signal) OR a 400/401/403 client error.
 * Critically the RFC returns invalid_grant with HTTP **400**, not 401, so a
 * 401-only check (the original M6b logic) would misclassify every real
 * revocation as transient and retry a dead token forever while never setting
 * needsReauth — the bug Finding B fixes. codex-oauth.ts's refreshAccessToken
 * now appends the response body to the thrown error so the `invalid_grant`
 * match can fire.
 *
 * TRANSIENT = everything else: 5xx server errors, 429 rate-limits (a 4xx that
 * is explicitly retryable, hence NOT in the revoked set), and network/
 * transport failures (a thrown TypeError with no HTTP status at all).
 *
 * Exported for direct unit testing of the classification matrix.
 */
export function isRefreshRevoked(err: unknown): boolean {
  const message = errMessage(err)
  if (/invalid_grant/i.test(message)) return true
  const match = /failed:\s*(\d{3})/.exec(message)
  if (!match) return false
  const status = Number(match[1])
  return status === 400 || status === 401 || status === 403
}

export class CredentialSync {
  private readonly vault: VaultLike
  private readonly now: () => number
  private readonly refreshAccessTokenFn: (refreshToken: string) => Promise<TokenResponse>
  private readonly watchDebounceMs: number
  private getEnabledRoutes: () => CodexEnabledRoutes
  private hasConfiguredRoutePolicy: boolean
  private lifecycleGeneration = 0

  private piTarget: CodexFeedTarget | undefined
  private opencodeTarget: CodexFeedTarget | undefined

  // -- scheduler state, PER ACCOUNT (ADR-068 §2) --
  private readonly runtimes = new Map<string, AccountRuntime>()
  /**
   * The key whose runtime the public `needsReauth` getter reports. Cached
   * because that getter is synchronous while the active id is a vault read;
   * every path that learns the active id refreshes it.
   */
  private activeKey: string = LEGACY_ACCOUNT_KEY
  private onActiveAccountChanged: () => void | Promise<void>
  private onCredentialStored: (accountId: string | undefined) => void

  // -- watcher state --
  private watchers = new Map<EngineKey, fs.FSWatcher>()
  private watchDebounceTimers = new Map<EngineKey, ReturnType<typeof setTimeout>>()
  /**
   * Engines currently inside a feed-triggered adoption (M-AT1). The adopt path
   * calls feedAll() again, which re-enters feedOne() for the same engine; this
   * makes the recursion bound explicit (one level) instead of relying on the
   * freshly-adopted refresh token happening to match on the second pass.
   */
  private adoptingFromFeed = new Set<EngineKey>()

  constructor(deps: CredentialSyncDeps = {}) {
    this.vault = deps.vault ?? authVault
    this.now = deps.now ?? (() => Date.now())
    this.refreshAccessTokenFn =
      deps.refreshAccessToken ?? ((refresh) => defaultRefreshAccessToken(refresh))
    this.watchDebounceMs = deps.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.getEnabledRoutes = deps.getEnabledRoutes ?? (() => ({ pi: true, opencode: true }))
    this.hasConfiguredRoutePolicy = deps.getEnabledRoutes !== undefined
    this.onActiveAccountChanged = deps.onActiveAccountChanged ?? ((): void => {})
    this.onCredentialStored = deps.onCredentialStored ?? ((): void => {})
  }

  /**
   * Wire the engine feed targets and the account-switch hook in from the
   * composition roots. Safe to call more than once (e.g. hot-reload), and
   * ADDITIVE: every field is optional and an absent one leaves what is already
   * wired alone, because the wiring comes from two places — the desktop's
   * provider registrar supplies the two feed targets (`register-auth-providers
   * .ts`, which is the only module that may import both those providers and
   * this one), while the Electron-free boot seam supplies the switch hook,
   * which needs the session graph.
   */
  configure(targets: {
    pi?: CodexFeedTarget
    opencode?: CodexFeedTarget
    getEnabledRoutes?: () => CodexEnabledRoutes
    onActiveAccountChanged?: () => void | Promise<void>
    onCredentialStored?: (accountId: string | undefined) => void
  }): void {
    if (targets.pi) this.piTarget = targets.pi
    if (targets.opencode) this.opencodeTarget = targets.opencode
    if (targets.getEnabledRoutes) {
      this.getEnabledRoutes = targets.getEnabledRoutes
      this.hasConfiguredRoutePolicy = true
    }
    if (targets.onActiveAccountChanged) this.onActiveAccountChanged = targets.onActiveAccountChanged
    if (targets.onCredentialStored) this.onCredentialStored = targets.onCredentialStored
  }

  /**
   * True after the ACTIVE account's refresh hit a revoked/invalid token —
   * surfaced to the UI. Cleared by any subsequent successful refresh, adopt or
   * completeLogin() ON THAT ACCOUNT: a dead BACKGROUND account must not make the
   * account in use look broken (its own flag is in `getStatus().accounts`).
   */
  get needsReauth(): boolean {
    return this.runtime(this.activeKey).needsReauth
  }

  /** This account's scheduler state, created on first use. */
  private runtime(key: string): AccountRuntime {
    const existing = this.runtimes.get(key)
    if (existing) return existing
    const created: AccountRuntime = {
      retryCount: 0,
      giveUpCount: 0,
      refreshInFlight: null,
      needsReauth: false
    }
    this.runtimes.set(key, created)
    return created
  }

  /** True when the vault stores N accounts rather than one credential. */
  private supportsAccounts(): boolean {
    return typeof this.vault.listAccounts === 'function'
  }

  private async accounts(): Promise<VaultAccount[]> {
    if (!this.vault.listAccounts) return []
    try {
      return await this.vault.listAccounts(CHATGPT_PROVIDER_ID)
    } catch (err) {
      logger.warn('CredentialSync', `listAccounts failed: ${errMessage(err)}`)
      return []
    }
  }

  /** The active account's id, refreshing {@link activeKey} on the way through. */
  private async readActiveKey(): Promise<string> {
    if (!this.vault.getActiveAccountId) return LEGACY_ACCOUNT_KEY
    try {
      const id = await this.vault.getActiveAccountId(CHATGPT_PROVIDER_ID)
      this.activeKey = id ?? LEGACY_ACCOUNT_KEY
    } catch (err) {
      logger.warn('CredentialSync', `getActiveAccountId failed: ${errMessage(err)}`)
    }
    return this.activeKey
  }

  // -------------------------------------------------------------------------
  // App lifecycle
  // -------------------------------------------------------------------------

  /**
   * Call at app start. Reconciles the NEWEST credential across {vault, pi
   * store, opencode store}, then arms the refresh scheduler + fs-watch resync
   * off it. Never throws — best-effort, like every other auth-provider init.
   *
   * Why reconcile (Finding A): while ClaudeUI is CLOSED an engine can run
   * standalone, hit `expires < now`, refresh, and ROTATE the refresh token in
   * its own store — leaving the vault holding a now-dead token that no watch
   * event will ever correct (the rotation happened while we were down).
   * Blindly scheduling off the stale vault copy would fire immediately, fail,
   * and (mis)classify as needsReauth or retry forever, all while a perfectly
   * valid token sits on disk. Reconciling on start adopts it instead. It also
   * makes an existing engine credential (a transplant, or a prior
   * `pi /login`) get picked up into the vault WITHOUT a fresh login — the
   * whole point of a centralized refresher.
   */
  async start(): Promise<void> {
    const generation = this.lifecycleGeneration
    const cred = await this.reconcileOnStart(generation)
    try {
      await this.removeDisabledCopies(cred)
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `start: failed to remove one or more disabled credential copies: ${errMessage(err)}`
      )
    }
    if (!cred || !this.isCurrent(generation)) return // empty vault + no engine credential — clean no-op
    await this.scheduleAll(cred)
    if (!this.isCurrent(generation)) return
    this.startWatchers()
  }

  /**
   * Arm one refresh timer PER stored account (ADR-068 §2). A background account
   * expires on its own clock, and a single timer aimed at the active credential
   * would leave every other account to rot until it was switched to — by which
   * time its refresh token may be long dead.
   *
   * `activeCred` is what reconcile-on-start settled on; with no account support
   * it is the only thing there is to schedule.
   */
  private async scheduleAll(activeCred: VaultCredential): Promise<void> {
    if (!this.supportsAccounts()) {
      this.scheduleRefresh(LEGACY_ACCOUNT_KEY, activeCred)
      return
    }
    const [accounts, activeKey] = await Promise.all([this.accounts(), this.readActiveKey()])
    if (accounts.length === 0) {
      this.scheduleRefresh(LEGACY_ACCOUNT_KEY, activeCred)
      return
    }
    for (const account of accounts) {
      this.scheduleRefresh(account.id, account.id === activeKey ? activeCred : account.credential)
    }
  }

  /**
   * Pick the newest credential across the vault and both engine stores,
   * adopting an engine credential into the vault when it strictly beats the
   * vault's (different refresh token AND newer expiry), or bootstrapping the
   * vault from an engine store when the vault is empty. Returns the credential
   * to schedule off, or null when there is nothing anywhere (no-op).
   */
  private async reconcileOnStart(generation: number): Promise<VaultCredential | null> {
    const vaultCred = await this.vault.load()
    if (!this.isCurrent(generation)) return null
    const recoveringLegacyVault = !vaultCred && this.vault.hasUnreadableLegacyVault?.() === true
    const newestEngine = await this.readNewestEngineEntry(recoveringLegacyVault)
    if (!this.isCurrent(generation)) return null

    if (vaultCred) {
      const engineBeatsVault =
        newestEngine !== null &&
        newestEngine.refresh !== vaultCred.refresh &&
        newestEngine.expires > vaultCred.expires
      if (engineBeatsVault) {
        logger.info(
          'CredentialSync',
          'reconcileOnStart: engine store holds a newer credential than the vault — adopting'
        )
        return this.persistAdopted(newestEngine, vaultCred, generation)
      }
      return vaultCred // vault is the newest (or tied) — keep it
    }

    // Vault empty: bootstrap from an engine store if one has a credential.
    if (newestEngine) {
      logger.info(
        'CredentialSync',
        `reconcileOnStart: ${recoveringLegacyVault ? 'recovering unreadable legacy vault from' : 'vault empty, adopting'} existing engine credential`
      )
      return this.persistAdopted(newestEngine, null, generation)
    }
    if (recoveringLegacyVault) await this.removeChatgptCredential()
    return null
  }

  /** Read both engines' Codex entries (best-effort) and return the one with the strictly-largest expiry, or null if neither has one. */
  private async readNewestEngineEntry(includeDisabled = false): Promise<CodexEntrySnapshot | null> {
    const routes = this.routes()
    const snapshots = await Promise.all([
      includeDisabled || routes.pi
        ? this.safeReadEntry('pi', this.piTarget, PI_CODEX_VENDOR_ID)
        : null,
      includeDisabled || routes.opencode
        ? this.safeReadEntry('opencode', this.opencodeTarget, OPENCODE_CODEX_VENDOR_ID)
        : null
    ])
    let newest: CodexEntrySnapshot | null = null
    for (const snap of snapshots) {
      if (snap && (!newest || snap.expires > newest.expires)) newest = snap
    }
    return newest
  }

  private async safeReadEntry(
    label: EngineKey,
    target: CodexFeedTarget | undefined,
    vendorId: string
  ): Promise<CodexEntrySnapshot | null> {
    if (!target) return null
    try {
      return await target.readOauthEntry(vendorId)
    } catch (err) {
      logger.warn('CredentialSync', `readOauthEntry(${label}) failed: ${errMessage(err)}`)
      return null
    }
  }

  /** Call at app teardown (before-quit). Clears every account's timers and closes every watcher. Idempotent. */
  stop(): void {
    for (const key of [...this.runtimes.keys()]) {
      this.clearRefreshTimer(key)
      this.clearRetryTimer(key)
    }
    this.stopWatchers()
  }

  // -------------------------------------------------------------------------
  // Login-flow delegation (PiAuthProvider.oauthAuthorize/oauthCallback/cancelVendorOauth)
  // -------------------------------------------------------------------------

  async beginLogin(): Promise<{ authorizeUrl: string }> {
    return this.vault.beginLogin()
  }

  /**
   * Start the DEVICE-CODE flow (ADR-068 §3, Slice 7) instead of the loopback
   * one. There is no `completeDeviceCodeLogin` twin on purpose: the vault holds
   * ONE login slot, so `completeLogin()` below already awaits whichever flow was
   * started last, and `cancelLogin()` already cancels either.
   */
  async beginDeviceCodeLogin(): Promise<DeviceCodeStart> {
    if (!this.vault.beginDeviceCodeLogin) {
      throw new Error('CredentialSync: vault does not support device-code login')
    }
    return this.vault.beginDeviceCodeLogin()
  }

  /**
   * On success: feed both engine stores, arm the refresh scheduler, and start
   * the fs-watch resync.
   *
   * `pastedInput` (ADR-057) drives the remote paste-back completion instead of
   * the desktop loopback wait — the host still performs the exchange. Absent,
   * the vault completes whichever flow is LIVE: the desktop loopback, or the
   * Slice 7 device-code poll. Everything AFTER the vault completion is identical
   * for all three, so it lives in {@link applyCompletedLogin} and no path owns a
   * copy of it.
   */
  async completeLogin(pastedInput?: string): Promise<VaultCredential> {
    const generation = this.lifecycleGeneration
    const cred =
      pastedInput !== undefined
        ? await this.completeVaultLoginFromPaste(pastedInput)
        : await this.vault.completeLogin()
    return this.applyCompletedLogin(cred, generation)
  }

  /**
   * The one post-completion tail every login path runs: honour a cancellation
   * that raced the exchange, clear the account's `needsReauth`, vend it when it
   * is the active one, arm its refresh timer and start the watchers.
   */
  private async applyCompletedLogin(
    cred: VaultCredential,
    generation: number
  ): Promise<VaultCredential> {
    if (!this.isCurrent(generation)) {
      await this.removeChatgptCredential()
      throw new Error('ChatGPT login was cancelled')
    }
    // The vault UPSERTED this credential onto an account (a re-login updates the
    // one it belongs to, a new workspace appends one). Only the ACTIVE account is
    // vended: adding a second subscription must not silently re-point pi and
    // opencode at it.
    const key = await this.keyForCredential(cred)
    const runtime = this.runtime(key)
    runtime.needsReauth = false
    runtime.retryCount = 0
    if (key === (await this.readActiveKey()) || key === LEGACY_ACCOUNT_KEY) {
      await this.feedAll(cred)
    }
    this.scheduleRefresh(key, cred)
    this.startWatchers()
    // ADR-070 §2: a stored credential is the one thing that means "this provider
    // works now". Rung AFTER the cancellation check above, so a login the user
    // cancelled mid-exchange (which throws and removes the credential) never
    // reports a resolution.
    //
    // The try/catch is what MAKES the listener non-fatal, rather than a contract
    // asserted of callers: `cred` is already stored and vended by the time we get
    // here, so a listener that threw would turn a login that genuinely succeeded
    // into a rejected promise the caller reports as a failed sign-in — telling the
    // user their working credential is broken, which is the exact failure mode
    // this whole ADR exists to remove.
    try {
      this.onCredentialStored(key === LEGACY_ACCOUNT_KEY ? undefined : key)
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `onCredentialStored listener threw (login already succeeded): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return cred
  }

  /** Which account key a just-stored credential landed on (its refresh token is unique). */
  private async keyForCredential(cred: VaultCredential): Promise<string> {
    if (!this.supportsAccounts()) return LEGACY_ACCOUNT_KEY
    const accounts = await this.accounts()
    const match =
      accounts.find((account) => account.credential.refresh === cred.refresh) ??
      (cred.accountId
        ? accounts.find((account) => account.accountId === cred.accountId)
        : undefined)
    return match?.id ?? (await this.readActiveKey())
  }

  /**
   * Make `id` the active account: vend it to both engines, then ring the hook so
   * the boot seam can act on the switch (ADR-069 §4 — every Codex session that
   * FOLLOWS the active account leaves the host it was on and continues on the
   * new account's at its next prompt; a pinned session is untouched).
   */
  async switchActiveAccount(id: string): Promise<void> {
    if (!this.vault.setActiveAccount || !this.vault.listAccounts) {
      throw new Error('CredentialSync: this vault does not support accounts')
    }
    await this.vault.setActiveAccount(CHATGPT_PROVIDER_ID, id)
    this.activeKey = id
    const account = (await this.accounts()).find((candidate) => candidate.id === id)
    if (account) {
      await this.feedAll(account.credential)
      this.scheduleRefresh(id, account.credential)
    }
    await this.onActiveAccountChanged()
  }

  /**
   * Drop one account. Its timer goes with it; removing the ACTIVE one vends the
   * promoted account instead, and removing the LAST one cleans both engine
   * copies out the way `disconnectChatgpt` does — an engine left holding a
   * credential the vault no longer owns is the one state nothing would ever fix.
   */
  async removeAccount(id: string): Promise<void> {
    if (!this.vault.removeAccount || !this.vault.listAccounts) {
      throw new Error('CredentialSync: this vault does not support accounts')
    }
    const wasActive = (await this.readActiveKey()) === id
    this.clearRefreshTimer(id)
    this.clearRetryTimer(id)
    this.runtimes.delete(id)
    await this.vault.removeAccount(CHATGPT_PROVIDER_ID, id)
    const promotedKey = await this.readActiveKey()
    if (!wasActive) return
    const promoted = (await this.accounts()).find((account) => account.id === promotedKey)
    if (promoted) {
      await this.feedAll(promoted.credential)
      this.scheduleRefresh(promoted.id, promoted.credential)
      // What the engines are vended just changed, exactly as it does on a
      // switch, so opencode has to drop the credential it is still holding in
      // process for the account that is gone (ADR-047).
      await this.onActiveAccountChanged()
      return
    }
    await Promise.all([
      this.removeOne('pi', this.piTarget, PI_CODEX_VENDOR_ID).catch((err: unknown) =>
        logger.warn('CredentialSync', `removeAccount: pi cleanup failed: ${errMessage(err)}`)
      ),
      this.removeOne('opencode', this.opencodeTarget, OPENCODE_CODEX_VENDOR_ID).catch(
        (err: unknown) =>
          logger.warn(
            'CredentialSync',
            `removeAccount: opencode cleanup failed: ${errMessage(err)}`
          )
      )
    ])
    // Same reason on the empty path, and more sharply: the engine files are gone
    // but a running opencode server would keep serving the deleted credential.
    await this.onActiveAccountChanged()
  }

  cancelLogin(): void {
    this.vault.cancelLogin()
  }

  /** Drive the vault's remote paste-back completion, or fail clearly when the vault has no such support. */
  private async completeVaultLoginFromPaste(input: string): Promise<VaultCredential> {
    if (!this.vault.completeLoginFromPastedInput) {
      throw new Error('CredentialSync: vault does not support pasted login completion')
    }
    return this.vault.completeLoginFromPastedInput(input)
  }

  /** Remove only ChatGPT credentials, preserving all other central-vault records. */
  async disconnectChatgpt(): Promise<void> {
    this.lifecycleGeneration += 1
    this.cancelLogin()
    this.stop()
    this.runtimes.clear()
    this.activeKey = LEGACY_ACCOUNT_KEY
    const failures: unknown[] = []
    await Promise.all([
      this.removeChatgptCredential().catch((err) => failures.push(err)),
      this.removeOne('pi', this.piTarget, PI_CODEX_VENDOR_ID).catch((err) => failures.push(err)),
      this.removeOne('opencode', this.opencodeTarget, OPENCODE_CODEX_VENDOR_ID).catch((err) =>
        failures.push(err)
      )
    ])
    if (failures.length)
      throw new AggregateError(failures, 'Failed to disconnect ChatGPT credentials')
  }

  /** Force an out-of-band refresh check right now, for EVERY stored account. Goes through the same per-account single-flight dedupe as the scheduled path. */
  async refreshNow(): Promise<void> {
    if (!this.supportsAccounts()) return this.runRefresh(LEGACY_ACCOUNT_KEY)
    const accounts = await this.accounts()
    if (accounts.length === 0) return this.runRefresh(LEGACY_ACCOUNT_KEY)
    await Promise.all(accounts.map((account) => this.runRefresh(account.id)))
  }

  /**
   * Read-only connection snapshot for M6c's Settings UI (PiVendors.tsx's
   * "Connect ChatGPT" flow). Reads `vault.load()` fresh every call — same
   * cheap-local-read posture as PiAuthProvider.probe() — plus the in-memory
   * `needsReauth` flag. NEVER returns `access`/`refresh` token material.
   */
  async getStatus(): Promise<{
    connected: boolean
    email?: string
    accountId?: string
    expiresAt?: number
    needsReauth: boolean
    accounts: CredentialAccountStatus[]
    activeId: string | null
  }> {
    const [cred, accounts] = await Promise.all([this.vault.load(), this.accounts()])
    const activeKey = await this.readActiveKey()
    const activeId = activeKey === LEGACY_ACCOUNT_KEY ? null : activeKey
    const list: CredentialAccountStatus[] = accounts.map((account) => ({
      id: account.id,
      ...(account.email ? { email: account.email } : {}),
      ...(account.accountId ? { accountId: account.accountId } : {}),
      ...(account.planType ? { planType: account.planType } : {}),
      expiresAt: account.credential.expires,
      needsReauth: this.runtime(account.id).needsReauth
    }))
    if (!cred) {
      return { connected: false, needsReauth: this.needsReauth, accounts: list, activeId }
    }
    const status: {
      connected: boolean
      email?: string
      accountId?: string
      expiresAt?: number
      needsReauth: boolean
      accounts: CredentialAccountStatus[]
      activeId: string | null
    } = {
      connected: true,
      needsReauth: this.needsReauth,
      expiresAt: cred.expires,
      accounts: list,
      activeId
    }
    if (cred.email) status.email = cred.email
    if (cred.accountId) status.accountId = cred.accountId
    return status
  }

  /**
   * **The one method on this class that returns TOKEN MATERIAL.** Everything
   * else here is deliberately token-free (`getStatus`, and the
   * `provider-account:*` commands built on it); this exists because Codex is fed
   * by INJECTION rather than by file (ADR-068 §1) and the host has to hand the
   * app-server an access token over the wire.
   *
   * Nothing in it logs, and its result must never reach a log line, an IPC
   * result or a snapshot. The two callers are the inject and refresh halves of
   * `codex-auth-hook.ts`.
   *
   * `accountId` null means the ACTIVE account. Returns null when the vault holds
   * no credential for that account, or when the credential carries no workspace
   * id: `account/login/start {type:'chatgptAuthTokens'}` REQUIRES
   * `chatgptAccountId`, so a workspace-less credential cannot be injected at all
   * and the process is left on whatever Codex's own store holds.
   *
   * `refreshMarginMs` decides how eagerly it refreshes first:
   *
   *  - at INJECT time the default {@link REFRESH_MARGIN_MS} applies, so a
   *    process never starts on a token that is about to die mid-turn;
   *  - the REFRESH server request passes 0, because Codex gives the host 10
   *    seconds to answer and a cached-but-still-valid token is the answer it
   *    wants (ADR-068 §1). Only a genuinely expired credential is worth a
   *    network round trip there.
   *
   * The refresh goes through the same per-account single-flight as every
   * scheduled one, so two processes starting at once cause ONE token request.
   */
  async injectionTokenFor(
    accountId: string | null,
    refreshMarginMs: number = REFRESH_MARGIN_MS
  ): Promise<CodexInjectionToken | null> {
    const key = accountId ?? (await this.readActiveKey())
    let cred = await this.loadForKey(key)
    if (!cred) return null
    if (cred.expires - refreshMarginMs <= this.now()) {
      await this.runRefresh(key)
      cred = await this.loadForKey(key)
      if (!cred) return null
    }
    if (!cred.accountId) return null
    return {
      accessToken: cred.access,
      chatgptAccountId: cred.accountId,
      chatgptPlanType: cred.planType ?? null,
      vaultAccountId: key
    }
  }

  // -------------------------------------------------------------------------
  // 1. Feed-forward
  // -------------------------------------------------------------------------

  /** Write `cred` into BOTH engine stores. Each write is independent/best-effort — a failure in one never aborts the other. */
  async feedAll(cred: VaultCredential): Promise<{ pi: boolean; opencode: boolean }> {
    const input: CodexCredentialInput = {
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      accountId: cred.accountId
    }
    const [pi, opencode] = await Promise.all([
      this.feedOne('pi', this.piTarget, PI_CODEX_VENDOR_ID, input),
      this.feedOne('opencode', this.opencodeTarget, OPENCODE_CODEX_VENDOR_ID, input)
    ])
    logger.info('CredentialSync', `feedAll: pi=${pi} opencode=${opencode}`)
    return { pi, opencode }
  }

  private async feedOne(
    label: EngineKey,
    target: CodexFeedTarget | undefined,
    vendorId: string,
    cred: CodexCredentialInput
  ): Promise<boolean> {
    if (!this.routes()[label]) {
      logger.info('CredentialSync', `feedAll: ${label} route disabled — skipping`)
      return false
    }
    if (!target) {
      logger.warn('CredentialSync', `feedAll: no ${label} target configured — skipping`)
      return false
    }
    if (await this.engineOutranksFeed(label, target, vendorId, cred)) {
      logger.info(
        'CredentialSync',
        `feedAll: ${label} holds a strictly-newer credential — skipping the write and adopting instead`
      )
      // Arm the watcher regardless of which branch we took: the watch is what
      // catches the NEXT external rotation, and skipping the write must not
      // leave this engine unwatched.
      this.startWatcher(label, target)
      this.adoptingFromFeed.add(label)
      try {
        // Reuse the watch-adoption path verbatim rather than duplicating it —
        // it re-reads the entry, re-compares against the vault, and carries its
        // own lifecycleGeneration guards through every await.
        await this.handleExternalChange(label)
      } finally {
        this.adoptingFromFeed.delete(label)
      }
      return false
    }
    try {
      await target.feedOauthCredential(vendorId, cred)
      this.startWatcher(label, target)
      return true
    } catch (err) {
      logger.warn('CredentialSync', `feedAll: ${label} write failed: ${errMessage(err)}`)
      return false
    }
  }

  /**
   * Pre-write freshness compare (M-AT1). `feedOauthCredential` overwrites the
   * engine's entry unconditionally, so an engine that rotated its own token
   * after our last read gets its NEWER refresh token destroyed by the feed —
   * and the watch event that follows sees `entry.refresh === vaultCred.refresh`
   * and files it as "our own write", masking the loss. With rotating refresh
   * tokens the clobbered token can be the only live one, so the damage only
   * surfaces later as an `invalid_grant` and a forced re-login.
   *
   * True means the engine's on-disk entry strictly beats what we are about to
   * write — the same rule reconcileOnStart() uses for "engine beats vault":
   * a DIFFERENT refresh token (not our own prior write) AND a NEWER expiry
   * (never regress to a stale copy).
   *
   * A read failure returns false (write proceeds, as before the fix) — the
   * feed must not become dependent on a readable engine store.
   *
   * REMAINING TOCTOU: the engine can still write between this read and our
   * write. Closing that window entirely needs cross-process file locking over
   * both engines' auth stores (out of scope); this removes the common
   * lost-rotation case, not the instantaneous race.
   */
  private async engineOutranksFeed(
    label: EngineKey,
    target: CodexFeedTarget,
    vendorId: string,
    cred: CodexCredentialInput
  ): Promise<boolean> {
    if (this.adoptingFromFeed.has(label)) return false
    let entry: CodexEntrySnapshot | null
    try {
      entry = await target.readOauthEntry(vendorId)
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `feedAll: ${label} pre-write read failed — writing anyway: ${errMessage(err)}`
      )
      return false
    }
    if (!entry) return false
    return entry.refresh !== cred.refresh && entry.expires > cred.expires
  }

  // -------------------------------------------------------------------------
  // 2. Sole-refresher scheduler
  // -------------------------------------------------------------------------

  private scheduleRefresh(key: string, cred: VaultCredential): void {
    // A normal (non-give-up) schedule means we are healthy again — reset the
    // escalating give-up backoff. Every recovery path (doRefresh success,
    // adoption, completeLogin, start) routes through here, so this is the single
    // reset point; the give-up path deliberately re-arms via armRefreshTimer()
    // to keep escalating.
    this.runtime(key).giveUpCount = 0
    const delay = Math.max(0, cred.expires - REFRESH_MARGIN_MS - this.now())
    // Node clamps a setTimeout delay above 2^31-1 ms (~24.8 days) to 1 ms, so a
    // credential that far from expiry would be refreshed IMMEDIATELY — rotating
    // a perfectly good token for nothing, or marking a long-lived one revoked
    // when the authority refuses. Beyond the cap the timer only re-arms.
    if (delay > MAX_TIMER_DELAY_MS) {
      this.clearRefreshTimer(key)
      this.clearRetryTimer(key)
      this.runtime(key).refreshTimer = setTimeout(
        () => this.scheduleRefresh(key, cred),
        MAX_TIMER_DELAY_MS
      )
      return
    }
    this.armRefreshTimer(key, delay)
  }

  /** Arm one account's refresh timer at an explicit delay, clearing its prior refresh/retry timer. */
  private armRefreshTimer(key: string, delayMs: number): void {
    this.clearRefreshTimer(key)
    this.clearRetryTimer(key)
    this.runtime(key).refreshTimer = setTimeout(() => {
      void this.runRefresh(key)
    }, delayMs)
  }

  private clearRefreshTimer(key: string): void {
    const runtime = this.runtimes.get(key)
    if (runtime?.refreshTimer) {
      clearTimeout(runtime.refreshTimer)
      runtime.refreshTimer = undefined
    }
  }

  private clearRetryTimer(key: string): void {
    const runtime = this.runtimes.get(key)
    if (runtime?.retryTimer) {
      clearTimeout(runtime.retryTimer)
      runtime.retryTimer = undefined
    }
  }

  /** Single-flight wrapper, PER ACCOUNT: a refresh already in progress for this account is awaited, not duplicated. */
  private async runRefresh(key: string): Promise<void> {
    const runtime = this.runtime(key)
    if (runtime.refreshInFlight) {
      await runtime.refreshInFlight
      return
    }
    const promise = this.doRefresh(key)
    runtime.refreshInFlight = promise
    try {
      await promise
    } finally {
      runtime.refreshInFlight = null
    }
  }

  /**
   * The credential this account key currently holds — the ACTIVE one for the
   * legacy key.
   *
   * Deliberately NOT `async`: the legacy branch hands back `vault.load()`'s own
   * promise, so the refresh path keeps the exact microtask depth it had before
   * accounts existed (two disconnect/identity-guard tests observe the in-flight
   * call after a single tick).
   */
  private loadForKey(key: string): Promise<VaultCredential | null> {
    if (key === LEGACY_ACCOUNT_KEY) return this.vault.load()
    return this.accounts().then(
      (list) => list.find((candidate) => candidate.id === key)?.credential ?? null
    )
  }

  /** Persist a rotated credential back onto the account it belongs to. */
  private async persistForKey(key: string, cred: VaultCredential): Promise<void> {
    if (key === LEGACY_ACCOUNT_KEY || !this.vault.saveAccountCredential) {
      await this.vault.save(cred)
      return
    }
    await this.vault.saveAccountCredential(CHATGPT_PROVIDER_ID, key, cred)
  }

  private async doRefresh(key: string): Promise<void> {
    const generation = this.lifecycleGeneration
    const cred = await this.loadForKey(key)
    if (!this.isCurrent(generation)) return
    if (!cred) {
      logger.debug('CredentialSync', 'doRefresh: no vault credential — nothing to refresh')
      return
    }
    // Identity of the credential we are about to refresh. The generation guard
    // below only covers a disconnect (which bumps lifecycleGeneration); it does
    // NOT cover a watch-adoption or another refresh landing a DIFFERENT vault
    // credential during the network await. Compare against this after the await
    // and bail if we were superseded — otherwise a late invalid_grant on the
    // OLD token would falsely set needsReauth AND clear the freshly-armed timer
    // of a now-valid credential (M-AT2).
    const refreshedIdentity = cred.refresh

    let tokens: TokenResponse
    try {
      tokens = await this.refreshAccessTokenFn(cred.refresh)
    } catch (err) {
      if (
        this.isCurrent(generation) &&
        (await this.isStillCurrentCredential(generation, key, refreshedIdentity))
      )
        this.handleRefreshError(key, err)
      return
    }
    if (!this.isCurrent(generation)) return
    // A concurrent adoption/refresh replaced the vault credential while our
    // network call was in flight — our (now-stale) result must not overwrite it.
    if (!(await this.isStillCurrentCredential(generation, key, refreshedIdentity))) return

    const runtime = this.runtime(key)
    runtime.retryCount = 0
    runtime.needsReauth = false
    // Shared with the login path via buildVaultCredential — identical expires
    // math + carry-forward of the prior accountId/email/planType when a refresh
    // response's JWTs omit the profile claims.
    const next = buildVaultCredential(tokens, this.now, {
      accountId: cred.accountId,
      email: cred.email,
      planType: cred.planType
    })
    if (!this.isCurrent(generation)) return
    await this.persistForKey(key, next)
    if (!this.isCurrent(generation)) return
    // Only the ACTIVE account reaches pi and opencode: their stores hold one
    // Codex entry each, so feeding a background rotation would silently switch
    // the engines to another subscription.
    if (key === LEGACY_ACCOUNT_KEY || key === (await this.readActiveKey())) {
      await this.feedAll(next)
    }
    if (this.isCurrent(generation)) this.scheduleRefresh(key, next)
  }

  /**
   * True iff the vault still holds the credential we set out to refresh (matched
   * by refresh token) AND this lifecycle generation is still current. Re-reads
   * the vault; used as the post-await identity guard in doRefresh (M-AT2).
   */
  private async isStillCurrentCredential(
    generation: number,
    key: string,
    refresh: string
  ): Promise<boolean> {
    const current = await this.loadForKey(key)
    if (!this.isCurrent(generation)) return false
    return current?.refresh === refresh
  }

  private handleRefreshError(key: string, err: unknown): void {
    const runtime = this.runtime(key)
    if (isRefreshRevoked(err)) {
      runtime.needsReauth = true
      this.clearRefreshTimer(key)
      this.clearRetryTimer(key)
      runtime.retryCount = 0
      logger.error(
        'CredentialSync',
        `refresh rejected (refresh token revoked) — needsReauth: ${errMessage(err)}`
      )
      return
    }

    runtime.retryCount += 1
    if (runtime.retryCount > MAX_TRANSIENT_RETRIES) {
      runtime.retryCount = 0
      runtime.giveUpCount += 1
      // Escalating backoff instead of scheduleRefresh() (which would fire
      // ~immediately, since the refresh margin has already passed, and hammer
      // the endpoint). Reset back to the normal schedule on the next success/
      // adoption via scheduleRefresh().
      const backoff = Math.min(
        GIVE_UP_BACKOFF_BASE_MS * runtime.giveUpCount,
        GIVE_UP_BACKOFF_MAX_MS
      )
      logger.error(
        'CredentialSync',
        `refresh failed ${MAX_TRANSIENT_RETRIES} time(s) transiently — backing off ${backoff}ms before retry (give-up cycle ${runtime.giveUpCount}): ${errMessage(err)}`
      )
      this.armRefreshTimer(key, backoff)
      return
    }

    const backoff = RETRY_BASE_MS * runtime.retryCount
    logger.warn(
      'CredentialSync',
      `refresh failed transiently (attempt ${runtime.retryCount}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoff}ms: ${errMessage(err)}`
    )
    this.clearRetryTimer(key)
    runtime.retryTimer = setTimeout(() => {
      void this.runRefresh(key)
    }, backoff)
  }

  // -------------------------------------------------------------------------
  // 3. fs-watch resync
  // -------------------------------------------------------------------------

  private startWatchers(): void {
    const routes = this.routes()
    if (routes.pi) this.startWatcher('pi', this.piTarget)
    if (routes.opencode) this.startWatcher('opencode', this.opencodeTarget)
  }

  /**
   * Watches the auth file's PARENT DIRECTORY with a filename filter, not the
   * file itself. Rationale (matches automation-manager.ts's own precedent):
   * an `fs.watch` on a single file is unreliable cross-platform — on Windows
   * in particular, an atomic replace (temp-file + rename, which is how a
   * careful writer avoids a half-written file) can either fire as `rename`
   * (invalidating the old file handle the watcher held) or fail to fire at
   * all, depending on the filesystem driver. Watching the directory and
   * filtering by filename sidesteps both failure modes and survives the
   * watched file not existing yet at watch-start time.
   */
  private startWatcher(engine: EngineKey, target: CodexFeedTarget | undefined): void {
    if (!target || this.watchers.has(engine)) return

    let filePath: string
    try {
      filePath = target.authFilePath()
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `startWatcher(${engine}): authFilePath() failed: ${errMessage(err)}`
      )
      return
    }
    const dir = path.dirname(filePath)
    const filename = path.basename(filePath)

    if (!fs.existsSync(dir)) {
      logger.debug(
        'CredentialSync',
        `startWatcher(${engine}): ${dir} does not exist yet — skipping watch`
      )
      return
    }

    try {
      const watcher = fs.watch(dir, (_event, changedFilename) => {
        if (!changedFilename || changedFilename !== filename) return
        this.debounceWatch(engine)
      })
      // An FSWatcher error (e.g. on Windows, deleting the watched dir raises an
      // async 'error') with no listener would throw at the process level. Handle
      // it: close the dead watcher and drop it from the map so the next feed /
      // schedule can re-create it (the `watchers.has(engine)` guard at the top of
      // startWatcher would otherwise leave external-rotation adoption dead until
      // app restart). Only evict THIS watcher, not a replacement that superseded
      // it.
      watcher.on('error', (err) => {
        logger.warn(
          'CredentialSync',
          `watcher(${engine}) error — closing so it can be re-created: ${errMessage(err)}`
        )
        try {
          watcher.close()
        } catch {
          /* already closed */
        }
        if (this.watchers.get(engine) === watcher) this.watchers.delete(engine)
      })
      this.watchers.set(engine, watcher)
    } catch (err) {
      logger.warn('CredentialSync', `startWatcher(${engine}) failed: ${errMessage(err)}`)
    }
  }

  private debounceWatch(engine: EngineKey): void {
    const existing = this.watchDebounceTimers.get(engine)
    if (existing) clearTimeout(existing)
    this.watchDebounceTimers.set(
      engine,
      setTimeout(() => {
        this.watchDebounceTimers.delete(engine)
        void this.handleExternalChange(engine)
      }, this.watchDebounceMs)
    )
  }

  private stopWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const timer of this.watchDebounceTimers.values()) clearTimeout(timer)
    this.watchDebounceTimers.clear()
  }

  /**
   * Reconcile after a debounced change to one engine's auth file. Adopts the
   * on-disk credential into the vault ONLY if it's both DIFFERENT (guards
   * against the vault's own feedAll write re-triggering this watcher — an
   * identical refresh token means "this is our own write, or nothing
   * changed") and NEWER (never regress to an older credential, e.g. a stale
   * write racing behind the current one).
   */
  private async handleExternalChange(engine: EngineKey): Promise<void> {
    const generation = this.lifecycleGeneration
    if (!this.routes()[engine]) return
    const target = engine === 'pi' ? this.piTarget : this.opencodeTarget
    if (!target) return
    const vendorId = engine === 'pi' ? PI_CODEX_VENDOR_ID : OPENCODE_CODEX_VENDOR_ID

    let entry: CodexEntrySnapshot | null
    try {
      entry = await target.readOauthEntry(vendorId)
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `handleExternalChange(${engine}): read failed: ${errMessage(err)}`
      )
      return
    }
    if (!entry || !this.isCurrent(generation)) return

    const vaultCred = await this.vault.load()
    if (!this.isCurrent(generation) || !vaultCred) return // nothing to reconcile against yet — first credential must arrive via completeLogin()

    if (entry.refresh === vaultCred.refresh) return // our own write (loop guard) or genuinely unchanged
    if (entry.expires <= vaultCred.expires) {
      logger.debug(
        'CredentialSync',
        `handleExternalChange(${engine}): ignoring older/stale credential`
      )
      return
    }

    logger.info(
      'CredentialSync',
      `handleExternalChange(${engine}): adopting externally-rotated credential`
    )
    const adopted = await this.persistAdopted(entry, vaultCred, generation)
    if (adopted && this.isCurrent(generation)) {
      this.scheduleRefresh(await this.readActiveKey(), adopted)
    }
  }

  /**
   * Adopt an engine-store credential snapshot into the vault: save it, clear
   * any transient/needsReauth failure state, and re-feed BOTH stores so the
   * one we did NOT read from is re-synced (and the source store's own
   * subsequent watch event self-cancels via the loop guard, since its refresh
   * token now equals the vault's). Carries forward the prior accountId/email
   * when the snapshot omits them. Does NOT schedule — the caller
   * (handleExternalChange / start) owns scheduling so start() schedules
   * exactly once. Shared by Finding A's reconcile-on-start and the fs-watch
   * resync path.
   */
  private async persistAdopted(
    snapshot: CodexEntrySnapshot,
    prior: VaultCredential | null,
    generation: number
  ): Promise<VaultCredential | null> {
    const adopted: VaultCredential = {
      type: 'oauth',
      access: snapshot.access,
      refresh: snapshot.refresh,
      expires: snapshot.expires
    }
    const accountId = snapshot.accountId ?? prior?.accountId
    if (accountId) adopted.accountId = accountId
    if (prior?.email) adopted.email = prior.email
    if (prior?.planType) adopted.planType = prior.planType

    if (!this.isCurrent(generation)) return null
    // The ACTIVE account, explicitly: an engine store holds the credential WE
    // vended, so a rotation found there belongs to the account in use and to no
    // other (ADR-068 §2). An empty vault has no active account yet, and save()
    // is then the bootstrap that creates the first one.
    const activeKey = await this.readActiveKey()
    if (!this.isCurrent(generation)) return null
    await this.persistForKey(activeKey, adopted)
    if (!this.isCurrent(generation)) return null
    const runtime = this.runtime(activeKey)
    runtime.needsReauth = false
    runtime.retryCount = 0
    await this.feedAll(adopted)
    return this.isCurrent(generation) ? adopted : null
  }

  private routes(): CodexEnabledRoutes {
    try {
      return this.getEnabledRoutes()
    } catch (err) {
      logger.warn('CredentialSync', `getEnabledRoutes failed, failing closed: ${errMessage(err)}`)
      return this.hasConfiguredRoutePolicy
        ? { pi: false, opencode: false }
        : { pi: true, opencode: true }
    }
  }

  private async removeChatgptCredential(): Promise<void> {
    if (!this.vault.removeCredential) throw new Error('Vault does not support credential removal')
    await this.vault.removeCredential('chatgpt')
  }

  /**
   * On start, remove the Codex copy from any DISABLED route — but only the one
   * ClaudeUI actually MANAGED (ADR-037: "removes only its ClaudeUI-managed
   * credential"). Provenance is the vault credential: with no vault credential
   * ClaudeUI has vended nothing, and a disabled route's Codex entry is the
   * user's own (e.g. a manual `pi /login`); a matching refresh token proves the
   * entry is the one we vended. Removing an unmanaged / mismatched entry would
   * destroy a credential we never owned (M-AT3).
   */
  private async removeDisabledCopies(vaultCred: VaultCredential | null): Promise<void> {
    if (!vaultCred) return
    const routes = this.routes()
    await Promise.allSettled([
      routes.pi
        ? undefined
        : this.removeManagedCopy('pi', this.piTarget, PI_CODEX_VENDOR_ID, vaultCred.refresh),
      routes.opencode
        ? undefined
        : this.removeManagedCopy(
            'opencode',
            this.opencodeTarget,
            OPENCODE_CODEX_VENDOR_ID,
            vaultCred.refresh
          )
    ])
  }

  /** Remove a disabled route's Codex entry ONLY when it is the credential ClaudeUI vended (refresh token matches the vault's). A read failure or a mismatched/absent entry is left untouched (fail-safe: never delete when unsure). */
  private async removeManagedCopy(
    label: EngineKey,
    target: CodexFeedTarget | undefined,
    vendorId: string,
    vaultRefresh: string
  ): Promise<void> {
    if (!target) return
    let entry: CodexEntrySnapshot | null
    try {
      entry = await target.readOauthEntry(vendorId)
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `removeDisabledCopies: readOauthEntry(${label}) failed — preserving: ${errMessage(err)}`
      )
      return
    }
    if (!entry) return // nothing to remove
    if (entry.refresh !== vaultRefresh) {
      logger.info(
        'CredentialSync',
        `removeDisabledCopies: ${label} holds an unmanaged Codex credential — preserving`
      )
      return
    }
    await this.removeOne(label, target, vendorId)
  }

  private isCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration
  }

  private async removeOne(
    label: EngineKey,
    target: CodexFeedTarget | undefined,
    vendorId: string
  ): Promise<void> {
    if (!target) return
    try {
      await target.removeVendorAuth(vendorId)
    } catch (err) {
      logger.warn('CredentialSync', `removeVendorAuth(${label}) failed: ${errMessage(err)}`)
      throw err
    }
  }
}

/** Singleton — wired to the real engine providers via configure() from register-auth-providers.ts. */
export const credentialSync = new CredentialSync()
