/**
 * ClaudeAuthProvider — EngineAuthProvider implementation for the 'claude' engine.
 *
 * Wraps the existing AuthManager + AccountManager with zero behavior change.
 * All existing IPC channels (auth:sign-in, auth:cancel, account:*) route through
 * this class; it delegates unchanged to the underlying singletons.
 *
 * probe() — builds a VendorAuthMap with a single 'anthropic' entry derived from
 * the cached auth-source signal (set by ClaudeSession.run → initializationResult →
 * session:auth-source). NO credential-file reads (preserves ADR-014 Keychain-
 * prompt avoidance). billingType is inferred from the active account's
 * OAuthAccount subscriptionType / apiKeySource.
 */

import type { BrowserWindow } from 'electron'
import type {
  VendorAuthMap,
  AuthFlowState,
  AccountsState,
  AccountRef,
  AuthState
} from '../../shared/types'
import type { OAuthAccount } from '../../shared/types'
import type { EngineAuthProvider } from '../../core/auth/EngineAuthProvider'
import { authManager } from '../services/auth-manager'
import { accountManager } from '../services/account-manager'

class ClaudeAuthProvider implements EngineAuthProvider {
  /**
   * Cached from the most-recent session:auth-source event ('authenticated' |
   * 'none' | null). Null = not yet probed (before any session init).
   */
  private cachedAuthSource: string | null = null

  /**
   * Cached account info from the most-recent successful OAuth login or from
   * the most-recent session init response. Used to enrich the probe label +
   * billingType without reading credential files.
   */
  private cachedAccount: OAuthAccount | null = null

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Wire up at app start. Subscribes to login-success callbacks so probe()
   * can reflect fresh account info after re-auth without doing a file read.
   */
  init(win: BrowserWindow | null): void {
    // Intercept successful logins to keep cachedAccount fresh.
    authManager.onLoginSuccess((account) => {
      if (account) this.cachedAccount = account
    })
    // AccountManager needs the window for broadcasts — already called by main/index.ts.
    // We call it here only if it hasn't been wired yet (idempotent on win reference).
    void win // retained for future use (e.g. probe-result events)
  }

  /**
   * Called by ClaudeSession whenever it receives a session:auth-source event so
   * the probe result stays current without IPC round-trips.
   */
  updateAuthSource(source: string, account?: OAuthAccount | null): void {
    this.cachedAuthSource = source
    if (account !== undefined) this.cachedAccount = account
  }

  // -------------------------------------------------------------------------
  // EngineAuthProvider interface
  // -------------------------------------------------------------------------

  async probe(): Promise<VendorAuthMap> {
    const authState: AuthState =
      this.cachedAuthSource === 'authenticated'
        ? 'authenticated'
        : this.cachedAuthSource === 'none'
          ? 'unauthenticated'
          : 'unknown'

    const acc = this.cachedAccount
    const billingType = inferBillingType(acc)
    const label = acc?.email ?? acc?.organization ?? undefined

    return {
      anthropic: {
        authState,
        billingType,
        label
      }
    }
  }

  async signIn(opts?: { remote?: boolean }): Promise<AuthFlowState> {
    return authManager.signIn(opts)
  }

  async submitCode(code: string): Promise<AuthFlowState> {
    return authManager.submitOAuthCode(code)
  }

  async cancelSignIn(): Promise<void> {
    return authManager.cancelSignIn()
  }

  async addAccount(opts?: { remote?: boolean }): Promise<AccountsState> {
    return accountManager.addAccount(opts)
  }

  async switchAccount(id: string): Promise<AccountsState> {
    return accountManager.switchAccount(id)
  }

  async deleteAccount(id: string): Promise<AccountsState> {
    return accountManager.deleteAccount(id)
  }

  // -------------------------------------------------------------------------
  // Helpers for session.account construction
  // -------------------------------------------------------------------------

  /**
   * Build an AccountRef for the current session from probe state + active accountId.
   * Used by ClaudeSession to populate SessionStatus.account.
   */
  buildAccountRef(activeAccountId?: string | null): AccountRef {
    const acc = this.cachedAccount
    return {
      engineId: 'claude',
      vendorId: 'anthropic',
      billingType: inferBillingType(acc),
      authState:
        this.cachedAuthSource === 'authenticated'
          ? 'authenticated'
          : this.cachedAuthSource === 'none'
            ? 'unauthenticated'
            : 'unknown',
      label: acc?.email ?? acc?.organization ?? undefined,
      accountId: activeAccountId ?? undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Billing-type inference — no credential-file reads
// ---------------------------------------------------------------------------

function inferBillingType(
  acc: OAuthAccount | null
): 'subscription' | 'apiKey' | 'free' | 'unknown' {
  if (!acc) return 'unknown'
  // OAuth subscription (pro / max)
  if (acc.subscriptionType) return 'subscription'
  // API key via Anthropic Console or proxy
  if (acc.apiKeySource || acc.apiProvider) return 'apiKey'
  return 'unknown'
}

/** Singleton Claude auth provider. */
export const claudeAuthProvider = new ClaudeAuthProvider()
