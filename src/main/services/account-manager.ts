/**
 * Multiple-account support (ADR-015 / Phase 4 ADR-021).
 *
 * Each account is a directory `~/.claude/ui/accounts/<id>/` holding only its
 * own `.credentials.json`. cli.js is pointed at the active account's dir via
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` + `SKIP_SECURESTORAGE=1` (the
 * skip-securestorage patch forces file-based storage), so credentials are
 * per-account while settings / history stay shared in `~/.claude`.
 *
 * Phase 4 change: AccountInfo metadata (email, subscriptionType, organization,
 * createdAt) moves into the operational DB (v2 migration). Credentials NEVER
 * enter the DB (ADR-015 unchanged). enabled/activeId stay in accounts.json as
 * a lightweight pointer file — avoids a DB read on the hot spawn-env path.
 * accounts.json is kept as a one-release fallback (data imported to DB on init).
 *
 * Switch mechanism (env re-point + respawn) is unchanged.
 */

import type { BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AccountsState, AccountInfo, OAuthAccount } from '../../shared/types'
import { setSecurestorageEnv, getSecurestorageEnv } from '../../core/sdk/securestorage-env'
import { serviceSession } from '../../core/services/service-session'
import { authManager } from './auth-manager'
import { invalidateLiveSessions } from './session-invalidation'
import { logger } from '../../core/services/logger'
import {
  getAllAccounts,
  upsertAccount,
  deleteAccountRow,
  importAccountsOnce
} from '../../core/services/db'

const ACCOUNTS_DIR = join(homedir(), '.claude', 'ui', 'accounts')
const ACCOUNTS_FILE = join(ACCOUNTS_DIR, 'accounts.json')

/**
 * Pointer file shape — only enabled/activeId. accounts array is kept for
 * one-release fallback compatibility and legacy file reads. After migration
 * the DB is the source of truth for AccountInfo; this file is secondary.
 */
interface AccountsPointer {
  enabled: boolean
  activeId: string | null
  /** Legacy field — kept for one-release fallback; DB is primary after import. */
  accounts?: AccountInfo[]
}

const EMPTY_POINTER: AccountsPointer = { enabled: false, activeId: null }

class AccountManager {
  private window: BrowserWindow | null = null
  /** In-memory cache of the current state. Always consistent with DB + pointer file. */
  private state: AccountsState = { enabled: false, activeId: null, accounts: [] }

  /**
   * Wire up at app start: load state, apply active env, capture login emails.
   *
   * Called from `bootCore()` (process lifetime) — `win` is `null` in a windowless
   * boot, which costs only the two host-local broadcasts below; applying the
   * active account's spawn env is what a headless session actually needs, and it
   * happens either way.
   */
  init(win: BrowserWindow | null): void {
    this.window = win
    this.state = this.load()
    this.applyActive()
    // After a successful login, stamp the active account with its email/tier.
    authManager.onLoginSuccess((account) => this.noteLogin(account))
  }

  getState(): AccountsState {
    return this.state
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async setEnabled(enabled: boolean): Promise<AccountsState> {
    this.state.enabled = enabled
    if (enabled) this.ensureActiveAccount()
    this.persistAndApply()
    return this.state
  }

  /** Guarantee a valid active account exists (seeding one if needed) so the
   *  spawn env always resolves to a real dir while multi-account is on. */
  private ensureActiveAccount(): void {
    if (this.state.accounts.length === 0) {
      const acc = this.createAccount('Account 1')
      this.state.accounts.push(acc)
    }
    if (!this.state.accounts.some((a) => a.id === this.state.activeId)) {
      this.state.activeId = this.state.accounts[0].id
    }
  }

  /** Create a new account, make it active, and kick off its login flow.
   *  `opts.remote` (ADR-057) forwards to signIn so a remote add surfaces the
   *  manual URL instead of opening a browser on the host. */
  async addAccount(opts?: { remote?: boolean }): Promise<AccountsState> {
    if (!this.state.enabled) this.state.enabled = true
    const acc = this.createAccount(`Account ${this.state.accounts.length + 1}`)
    this.state.accounts.push(acc)
    this.state.activeId = acc.id
    this.persistAndApply()

    // serviceSession now points at the new (empty) dir — start the login there.
    //
    // REMOTE (S4-UI): the caller is the only client that may see this flow's
    // `manualUrl` (it carries the flow's CSRF `state`), and the `auth:state`
    // event that used to carry it is host-local, so echo the "authorizing"
    // snapshot back on the RESPONSE. signIn() resolves as soon as the authorize
    // URL exists — it does NOT block on the login completing — so awaiting it
    // costs one cli.js control round-trip, not a user's attention span. It is
    // also hardened to never reject; the catch is belt-and-braces and degrades
    // to "no pendingSignIn", which the UI renders as "no sign-in link".
    if (opts?.remote) {
      try {
        return { ...this.state, pendingSignIn: await authManager.signIn(opts) }
      } catch (err) {
        logger.error('AccountManager', `Failed to start login for new account: ${err}`)
        return this.state
      }
    }

    // DESKTOP: unchanged. signIn() resolves at the "authorizing" stage and
    // broadcasts terminal success/error via auth:state, so we deliberately don't
    // await it. Guard the fire-and-forget with a catch so a spawn-path throw can
    // never surface as an unhandled rejection (signIn() itself is also hardened
    // to broadcast errors rather than reject).
    void authManager.signIn(opts).catch((err) => {
      logger.error('AccountManager', `Failed to start login for new account: ${err}`)
    })
    return this.state
  }

  async switchAccount(id: string): Promise<AccountsState> {
    if (!this.state.accounts.some((a) => a.id === id) || this.state.activeId === id) {
      return this.state
    }
    this.state.activeId = id
    this.persistAndApply()
    return this.state
  }

  async deleteAccount(id: string): Promise<AccountsState> {
    const idx = this.state.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return this.state
    this.state.accounts.splice(idx, 1)
    // Remove DB row + credentials directory.
    try {
      deleteAccountRow(id)
    } catch (err) {
      logger.warn('AccountManager', `Failed to delete account row ${id}: ${err}`)
    }
    try {
      rmSync(this.accountDir(id), { recursive: true, force: true })
    } catch (err) {
      logger.warn('AccountManager', `Failed to remove account dir ${id}: ${err}`)
    }
    if (this.state.activeId === id) {
      this.state.activeId = this.state.accounts[0]?.id ?? null
    }
    this.persistAndApply()
    return this.state
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Stamp the active account with the freshly-signed-in identity. */
  private noteLogin(account: OAuthAccount | null): void {
    if (!this.state.enabled || !this.state.activeId || !account) return
    const acc = this.state.accounts.find((a) => a.id === this.state.activeId)
    if (!acc) return
    acc.email = account.email ?? acc.email
    acc.subscriptionType = account.subscriptionType ?? acc.subscriptionType
    acc.organization = account.organization ?? acc.organization
    // Persist new info to DB (source of truth) + pointer file.
    try {
      upsertAccount(acc)
    } catch (err) {
      logger.warn('AccountManager', `Failed to upsert account ${acc.id} to DB: ${err}`)
    }
    this.savePointer()
    this.broadcast()
  }

  private createAccount(label: string): AccountInfo {
    const id = randomUUID()
    mkdirSync(this.accountDir(id), { recursive: true, mode: 0o700 })
    const acc: AccountInfo = {
      id,
      email: label, // placeholder until the first successful login fills it in
      subscriptionType: null,
      organization: null,
      createdAt: Date.now()
    }
    // Write to DB immediately.
    try {
      upsertAccount(acc)
    } catch (err) {
      logger.warn('AccountManager', `Failed to insert account ${id} to DB: ${err}`)
    }
    return acc
  }

  private accountDir(id: string): string {
    return join(ACCOUNTS_DIR, id)
  }

  /** Point cli.js spawns at the active account dir (or clear for Keychain mode). */
  private applyActive(): void {
    if (this.state.enabled && this.state.activeId) {
      const dir = this.accountDir(this.state.activeId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      setSecurestorageEnv({ dir })
    } else {
      setSecurestorageEnv(null)
    }
  }

  /**
   * Persist pointer file + re-point env, and — only when the EFFECTIVE credential
   * directory actually moved — stop everything holding the old one.
   *
   * The gate matters because this method is the common tail of four very
   * different mutations: `setEnabled`, `addAccount`, `switchAccount` and
   * `deleteAccount`. Only some of them change which credential a spawn would
   * read; `deleteAccount` of a NON-active account changes nothing at all.
   */
  private persistAndApply(): void {
    // Upsert all accounts to DB (handles any new ones from createAccount → already done,
    // but re-syncing here ensures consistency after setEnabled/switch mutations).
    for (const acc of this.state.accounts) {
      try {
        upsertAccount(acc)
      } catch (err) {
        logger.warn('AccountManager', `Failed to sync account ${acc.id} to DB: ${err}`)
      }
    }
    this.savePointer()
    // Snapshot the EFFECTIVE credential dir across `applyActive()`. Not every
    // mutation that lands here changes it: deleting a non-active account, or
    // re-saving the same active id, leaves every running process pointed at the
    // exact credential it already holds — and cancelling then would destroy live
    // turns for a settings-list edit the user does not connect to their session.
    const dirBefore = getSecurestorageEnv()?.dir ?? null
    this.applyActive()
    const dirAfter = getSecurestorageEnv()?.dir ?? null
    if (dirBefore === dirAfter) {
      this.broadcast()
      return
    }
    // The service session caches its credential for its process lifetime; stop
    // it so the next use respawns against the new account dir.
    serviceSession.stop()
    // Every CHAT session caches it too, and asking the desktop renderer to flip
    // its own `sdkActive` flags never stopped the processes — nor told any other
    // client. Cancelling here does both: the `disconnected` status each cancel
    // broadcasts folds to `sdkActive: false` in canonical and in every replica.
    invalidateLiveSessions(`active account changed to ${this.state.activeId ?? 'none'}`)
    this.broadcast()
    // Tell the renderer to respawn chat sessions against the new account. Kept
    // verbatim: the desktop's respawn UX is unchanged, and its local
    // `sdkActive: false` write is now idempotent with the fold above rather
    // than the only thing that happens.
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('account:respawn-sessions')
    }
  }

  private broadcast(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('account:changed', this.state)
    }
  }

  /**
   * Load state: DB is the primary source for AccountInfo; pointer file provides
   * enabled/activeId. One-time import from accounts.json runs if DB is empty.
   */
  private load(): AccountsState {
    mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 })

    // Read the pointer file (enabled + activeId + legacy accounts array).
    let pointer: AccountsPointer = { ...EMPTY_POINTER }
    try {
      const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as Partial<AccountsPointer>
      pointer = {
        enabled: !!raw.enabled,
        activeId: raw.activeId ?? null,
        accounts: Array.isArray(raw.accounts) ? raw.accounts : []
      }
    } catch {
      // File absent = first run; pointer stays empty.
    }

    // One-time import: if DB table is empty and the legacy JSON has accounts, import them.
    if (pointer.accounts && pointer.accounts.length > 0) {
      try {
        importAccountsOnce(pointer.accounts)
      } catch (err) {
        logger.warn('AccountManager', `Failed to import accounts.json to DB: ${err}`)
      }
    }

    // Read authoritative list from DB.
    let accounts: AccountInfo[] = []
    try {
      accounts = getAllAccounts()
    } catch (err) {
      // DB unavailable (e.g. during tests with a stub that errors) — fall back to JSON.
      logger.warn('AccountManager', `Failed to read accounts from DB, using JSON fallback: ${err}`)
      accounts = pointer.accounts ?? []
    }

    return {
      enabled: pointer.enabled,
      activeId: pointer.activeId,
      accounts
    }
  }

  /**
   * Persist the pointer file (enabled + activeId only). AccountInfo is in the DB.
   * Keep a legacy accounts array for one-release fallback compatibility.
   */
  private savePointer(): void {
    try {
      mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 })
      const pointer: AccountsPointer = {
        enabled: this.state.enabled,
        activeId: this.state.activeId,
        accounts: this.state.accounts // legacy fallback — remove in next release
      }
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(pointer, null, 2), { mode: 0o600 })
    } catch (err) {
      logger.error('AccountManager', `Failed to persist accounts.json pointer: ${err}`)
    }
  }
}

/** Singleton account manager. */
export const accountManager = new AccountManager()
