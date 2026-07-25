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
 * HARD SAFETY NOTE (same as AuthVault.ts / codex-oauth.ts): no test may let
 * `refreshAccessToken` reach the real auth.openai.com — every scheduler test
 * injects a fake `refreshAccessToken`; every watcher test uses fake
 * CodexFeedTarget objects backed by temp files, never `~/.pi` or the real
 * opencode data dir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../services/logger'
import { authVault } from './AuthVault'
import {
  buildVaultCredential,
  refreshAccessToken as defaultRefreshAccessToken,
  type TokenResponse,
  type VaultCredential
} from './codex-oauth'

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

/** Debounce window for the fs.watch resync — matches automation-manager.ts's own 500ms precedent. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 500

/** Linear backoff step for a transient (non-401) refresh failure: attempt N waits N * this. */
export const RETRY_BASE_MS = 30 * 1000
/** After this many consecutive transient failures, give up the retry loop and fall back to the normal schedule (which fires ~immediately, since the original margin has already passed). */
export const MAX_TRANSIENT_RETRIES = 3

// ---------------------------------------------------------------------------
// Structural interfaces (deliberately NOT importing the concrete classes —
// see the module header's "DEPENDENCY DIRECTION" note).
// ---------------------------------------------------------------------------

/** The slice of AuthVault this service needs. The real `authVault` singleton satisfies this structurally. */
export interface VaultLike {
  load(): Promise<VaultCredential | null>
  save(cred: VaultCredential): Promise<void>
  removeCredential?(providerId: string): Promise<void>
  hasUnreadableLegacyVault?(): boolean
  beginLogin(): Promise<{ authorizeUrl: string }>
  completeLogin(): Promise<VaultCredential>
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

  // -- scheduler state --
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryCount = 0
  private refreshInFlight: Promise<void> | null = null
  private _needsReauth = false

  // -- watcher state --
  private watchers = new Map<EngineKey, fs.FSWatcher>()
  private watchDebounceTimers = new Map<EngineKey, ReturnType<typeof setTimeout>>()

  constructor(deps: CredentialSyncDeps = {}) {
    this.vault = deps.vault ?? authVault
    this.now = deps.now ?? (() => Date.now())
    this.refreshAccessTokenFn =
      deps.refreshAccessToken ?? ((refresh) => defaultRefreshAccessToken(refresh))
    this.watchDebounceMs = deps.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.getEnabledRoutes = deps.getEnabledRoutes ?? (() => ({ pi: true, opencode: true }))
    this.hasConfiguredRoutePolicy = deps.getEnabledRoutes !== undefined
  }

  /** Wire the two engine feed targets in from the composition root (register-auth-providers.ts). Safe to call more than once (e.g. hot-reload). */
  configure(targets: {
    pi: CodexFeedTarget
    opencode: CodexFeedTarget
    getEnabledRoutes?: () => CodexEnabledRoutes
  }): void {
    this.piTarget = targets.pi
    this.opencodeTarget = targets.opencode
    if (targets.getEnabledRoutes) {
      this.getEnabledRoutes = targets.getEnabledRoutes
      this.hasConfiguredRoutePolicy = true
    }
  }

  /** True after a refresh attempt hits a revoked/invalid refresh token — surfaced to M6c's UI. Cleared by any subsequent successful refresh, adopt, or completeLogin(). */
  get needsReauth(): boolean {
    return this._needsReauth
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
      await this.removeDisabledCopies()
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `start: failed to remove one or more disabled credential copies: ${errMessage(err)}`
      )
    }
    if (!cred || !this.isCurrent(generation)) return // empty vault + no engine credential — clean no-op
    this.scheduleRefresh(cred)
    this.startWatchers()
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

  /** Call at app teardown (before-quit). Clears every timer and closes every watcher. Idempotent. */
  stop(): void {
    this.clearRefreshTimer()
    this.clearRetryTimer()
    this.stopWatchers()
  }

  // -------------------------------------------------------------------------
  // Login-flow delegation (PiAuthProvider.oauthAuthorize/oauthCallback/cancelVendorOauth)
  // -------------------------------------------------------------------------

  async beginLogin(): Promise<{ authorizeUrl: string }> {
    return this.vault.beginLogin()
  }

  /** On success: feed both engine stores, arm the refresh scheduler, and start the fs-watch resync. */
  async completeLogin(): Promise<VaultCredential> {
    const generation = this.lifecycleGeneration
    const cred = await this.vault.completeLogin()
    if (!this.isCurrent(generation)) {
      await this.removeChatgptCredential()
      throw new Error('ChatGPT login was cancelled')
    }
    this._needsReauth = false
    this.retryCount = 0
    await this.feedAll(cred)
    this.scheduleRefresh(cred)
    this.startWatchers()
    return cred
  }

  cancelLogin(): void {
    this.vault.cancelLogin()
  }

  /** Remove only ChatGPT credentials, preserving all other central-vault records. */
  async disconnectChatgpt(): Promise<void> {
    this.lifecycleGeneration += 1
    this.cancelLogin()
    this.stop()
    this._needsReauth = false
    this.retryCount = 0
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

  /** Force an out-of-band refresh check right now (e.g. a future "sync now" UI action). Goes through the same single-flight dedupe as the scheduled path. */
  async refreshNow(): Promise<void> {
    return this.runRefresh()
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
  }> {
    const cred = await this.vault.load()
    if (!cred) {
      return { connected: false, needsReauth: this._needsReauth }
    }
    const status: {
      connected: boolean
      email?: string
      accountId?: string
      expiresAt?: number
      needsReauth: boolean
    } = {
      connected: true,
      needsReauth: this._needsReauth,
      expiresAt: cred.expires
    }
    if (cred.email) status.email = cred.email
    if (cred.accountId) status.accountId = cred.accountId
    return status
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
    try {
      await target.feedOauthCredential(vendorId, cred)
      this.startWatcher(label, target)
      return true
    } catch (err) {
      logger.warn('CredentialSync', `feedAll: ${label} write failed: ${errMessage(err)}`)
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 2. Sole-refresher scheduler
  // -------------------------------------------------------------------------

  private scheduleRefresh(cred: VaultCredential): void {
    this.clearRefreshTimer()
    this.clearRetryTimer()
    const delay = Math.max(0, cred.expires - REFRESH_MARGIN_MS - this.now())
    this.refreshTimer = setTimeout(() => {
      void this.runRefresh()
    }, delay)
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  /** Single-flight wrapper: a refresh already in progress is awaited, not duplicated. */
  private async runRefresh(): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight
      return
    }
    const promise = this.doRefresh()
    this.refreshInFlight = promise
    try {
      await promise
    } finally {
      this.refreshInFlight = null
    }
  }

  private async doRefresh(): Promise<void> {
    const generation = this.lifecycleGeneration
    const cred = await this.vault.load()
    if (!this.isCurrent(generation)) return
    if (!cred) {
      logger.debug('CredentialSync', 'doRefresh: no vault credential — nothing to refresh')
      return
    }

    let tokens: TokenResponse
    try {
      tokens = await this.refreshAccessTokenFn(cred.refresh)
    } catch (err) {
      if (this.isCurrent(generation)) this.handleRefreshError(err, cred)
      return
    }
    if (!this.isCurrent(generation)) return

    this.retryCount = 0
    this._needsReauth = false
    // Shared with the login path via buildVaultCredential — identical expires
    // math + carry-forward of the prior accountId/email when a refresh
    // response's JWTs omit the profile claims.
    const next = buildVaultCredential(tokens, this.now, {
      accountId: cred.accountId,
      email: cred.email
    })
    if (!this.isCurrent(generation)) return
    await this.vault.save(next)
    if (!this.isCurrent(generation)) return
    await this.feedAll(next)
    if (this.isCurrent(generation)) this.scheduleRefresh(next)
  }

  private handleRefreshError(err: unknown, cred: VaultCredential): void {
    if (isRefreshRevoked(err)) {
      this._needsReauth = true
      this.clearRefreshTimer()
      this.clearRetryTimer()
      this.retryCount = 0
      logger.error(
        'CredentialSync',
        `refresh rejected (refresh token revoked) — needsReauth: ${errMessage(err)}`
      )
      return
    }

    this.retryCount += 1
    if (this.retryCount > MAX_TRANSIENT_RETRIES) {
      logger.error(
        'CredentialSync',
        `refresh failed ${this.retryCount - 1} time(s) transiently — giving up this cycle: ${errMessage(err)}`
      )
      this.retryCount = 0
      this.scheduleRefresh(cred)
      return
    }

    const backoff = RETRY_BASE_MS * this.retryCount
    logger.warn(
      'CredentialSync',
      `refresh failed transiently (attempt ${this.retryCount}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoff}ms: ${errMessage(err)}`
    )
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      void this.runRefresh()
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
    if (adopted && this.isCurrent(generation)) this.scheduleRefresh(adopted)
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

    if (!this.isCurrent(generation)) return null
    await this.vault.save(adopted)
    if (!this.isCurrent(generation)) return null
    this._needsReauth = false
    this.retryCount = 0
    await this.feedAll(adopted)
    return this.isCurrent(generation) ? adopted : null
  }

  private routes(): CodexEnabledRoutes {
    try {
      return this.getEnabledRoutes()
    } catch (err) {
      logger.warn(
        'CredentialSync',
        `getEnabledRoutes failed, failing closed: ${errMessage(err)}`
      )
      return this.hasConfiguredRoutePolicy ? { pi: false, opencode: false } : { pi: true, opencode: true }
    }
  }

  private async removeChatgptCredential(): Promise<void> {
    if (!this.vault.removeCredential) throw new Error('Vault does not support credential removal')
    await this.vault.removeCredential('chatgpt')
  }

  private async removeDisabledCopies(): Promise<void> {
    const routes = this.routes()
    await Promise.allSettled([
      routes.pi ? undefined : this.removeOne('pi', this.piTarget, PI_CODEX_VENDOR_ID),
      routes.opencode
        ? undefined
        : this.removeOne('opencode', this.opencodeTarget, OPENCODE_CODEX_VENDOR_ID)
    ])
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
