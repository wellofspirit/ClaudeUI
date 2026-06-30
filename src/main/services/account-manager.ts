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
import { setSecurestorageEnv } from '../sdk/securestorage-env'
import { serviceSession } from './service-session'
import { authManager } from './auth-manager'
import { logger } from './logger'
import {
  getAllAccounts,
  upsertAccount,
  deleteAccountRow,
  importAccountsOnce
} from './db'

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

  /** Wire up at app start: load state, apply active env, capture login emails. */
  init(win: BrowserWindow): void {
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

  /** Create a new account, make it active, and kick off its login flow. */
  async addAccount(): Promise<AccountsState> {
    if (!this.state.enabled) this.state.enabled = true
    const acc = this.createAccount(`Account ${this.state.accounts.length + 1}`)
    this.state.accounts.push(acc)
    this.state.activeId = acc.id
    this.persistAndApply()
    // serviceSession now points at the new (empty) dir — start the login there.
    void authManager.signIn()
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

  /** Persist pointer file + re-point env + restart sessions so the change takes effect. */
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
    this.applyActive()
    // The service session caches its credential for its process lifetime; stop
    // it so the next use respawns against the new account dir.
    serviceSession.stop()
    this.broadcast()
    // Tell the renderer to respawn chat sessions against the new account.
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
