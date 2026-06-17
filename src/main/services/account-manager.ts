/**
 * Multiple-account support (ADR-015).
 *
 * Each account is a directory `~/.claude/ui/accounts/<id>/` holding only its
 * own `.credentials.json`. cli.js is pointed at the active account's dir via
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` + `SKIP_SECURESTORAGE=1` (the
 * skip-securestorage patch forces file-based storage), so credentials are
 * per-account while settings / history stay shared in `~/.claude`.
 *
 * We own the account list + active pointer (`accounts.json`) and orchestrate
 * add/switch/delete; cli.js still owns all token read/write/refresh inside the
 * active dir (we never parse tokens). On any change we re-point the spawn env,
 * restart the service session, and tell the renderer to respawn chat sessions.
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

const ACCOUNTS_DIR = join(homedir(), '.claude', 'ui', 'accounts')
const ACCOUNTS_FILE = join(ACCOUNTS_DIR, 'accounts.json')

const EMPTY: AccountsState = { enabled: false, activeId: null, accounts: [] }

class AccountManager {
  private window: BrowserWindow | null = null
  private state: AccountsState = EMPTY

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
      this.state.accounts.push(this.createAccount('Account 1'))
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
    this.save()
    this.broadcast()
  }

  private createAccount(label: string): AccountInfo {
    const id = randomUUID()
    mkdirSync(this.accountDir(id), { recursive: true, mode: 0o700 })
    return {
      id,
      email: label, // placeholder until the first successful login fills it in
      subscriptionType: null,
      organization: null,
      createdAt: Date.now()
    }
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

  /** Persist + re-point env + restart sessions so the change takes effect. */
  private persistAndApply(): void {
    this.save()
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

  private load(): AccountsState {
    try {
      const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as Partial<AccountsState>
      return {
        enabled: !!raw.enabled,
        activeId: raw.activeId ?? null,
        accounts: Array.isArray(raw.accounts) ? raw.accounts : []
      }
    } catch {
      return { ...EMPTY }
    }
  }

  private save(): void {
    try {
      mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    } catch (err) {
      logger.error('AccountManager', `Failed to persist accounts.json: ${err}`)
    }
  }
}

/** Singleton account manager. */
export const accountManager = new AccountManager()
