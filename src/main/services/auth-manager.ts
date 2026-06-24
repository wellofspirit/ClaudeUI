/**
 * Native Anthropic OAuth ("Log in with Claude") orchestration — see ADR-014.
 *
 * cli.js owns the entire subscription OAuth flow (PKCE, browser, loopback
 * listener, token exchange, Keychain storage). We merely drive its native
 * control requests through the long-lived `serviceSession` handle:
 *
 *   claude_authenticate              → { manualUrl, automaticUrl }
 *   claude_oauth_wait_for_completion → { account }   (loopback auto-complete)
 *   claude_oauth_callback(code,state) → { account }  (manual paste fallback)
 *
 * The IPC `signIn()` resolves as soon as the browser is opened (status
 * "authorizing"); the terminal result arrives via the `auth:state` broadcast,
 * so the loopback wait and an optional manual paste race the same flow without
 * blocking the renderer.
 *
 * We deliberately never read cli.js's credential store ourselves — doing so via
 * the `security` CLI triggers macOS Keychain trust prompts (the item's ACL does
 * not trust our spawned `security` process). Login state for the proactive
 * banner comes from the `account` in cli.js's initialize response instead
 * (claude-session broadcasts `session:auth-source`).
 */

import { shell } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AuthFlowState, OAuthAccount } from '../../shared/types'
import { serviceSession } from './service-session'
import { logger } from './logger'

interface AuthorizeUrls {
  manualUrl?: string
  automaticUrl?: string
}

interface OAuthResult {
  account?: {
    email?: string | null
    organization?: string | null
    subscriptionType?: string | null
    tokenSource?: string | null
    apiKeySource?: string | null
    apiProvider?: string | null
  }
}

const IDLE: AuthFlowState = { status: 'idle', account: null, error: null }

class AuthManager {
  private window: BrowserWindow | null = null
  /** `state` param parsed from the active flow's login URL (for manual paste). */
  private pendingState: string | null = null
  /** Monotonic flow id — stale completions (after cancel/restart) are ignored. */
  private flowId = 0
  /** Guards against finalizing the same flow twice (loopback + manual race). */
  private settled = false

  /** Listeners notified with the account on a successful login (ADR-015). */
  private onSuccessCbs: ((account: OAuthAccount | null) => void)[] = []

  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  /** Subscribe to successful logins (used by the account manager to capture the
   *  signed-in account's email for the active account dir). */
  onLoginSuccess(cb: (account: OAuthAccount | null) => void): void {
    this.onSuccessCbs.push(cb)
  }

  /**
   * Broadcast login status derived from an initialize-response `account`.
   * Called both at app load (the model-detection query) and per chat-session
   * init, so the banner is accurate before any session is opened. A present
   * `account.email` = logged in; absent = logged out. See ADR-014.
   */
  reportLoginStatus(account: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    const acc = account as Record<string, unknown> | undefined
    const loggedIn = !!(acc && acc.email)
    // Matches the (routingId, source) shape of the session:auth-source event;
    // login is global so the id is a synthetic 'system'.
    this.window.webContents.send(
      'session:auth-source',
      'system',
      loggedIn ? 'authenticated' : 'none'
    )
  }

  // ---------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------

  /**
   * Begin the login flow. Opens the browser and starts awaiting the loopback
   * redirect in the background. Resolves with the "authorizing" snapshot; the
   * success/error transition is broadcast via `auth:state`.
   */
  async signIn(): Promise<AuthFlowState> {
    const handle = await serviceSession.getControlHandle()
    if (!handle) {
      return this.broadcastError('Could not start the login service session.')
    }

    const myFlow = ++this.flowId
    this.settled = false
    this.pendingState = null

    let urls: AuthorizeUrls
    try {
      urls = (await handle.claudeAuthenticate(true)) as AuthorizeUrls
    } catch (err) {
      return this.broadcastError(`Failed to start login: ${errText(err)}`)
    }

    this.pendingState = parseState(urls.manualUrl)
    if (urls.automaticUrl) {
      await shell.openExternal(urls.automaticUrl)
    }

    // Await the loopback redirect in the background — do not block the caller.
    handle
      .claudeOAuthWaitForCompletion()
      .then((res) => this.finalize(myFlow, res as OAuthResult))
      .catch((err) => this.fail(myFlow, err))

    const authorizing: AuthFlowState = { status: 'authorizing', account: null, error: null }
    this.broadcast(authorizing)
    return authorizing
  }

  /** Manual fallback: complete the flow with a pasted authorization code. */
  async submitOAuthCode(code: string): Promise<AuthFlowState> {
    const handle = await serviceSession.getControlHandle()
    if (!handle || !this.pendingState) {
      return this.broadcastError('No active login flow. Start login again.')
    }
    const myFlow = this.flowId
    try {
      const res = (await handle.claudeOAuthCallback(code.trim(), this.pendingState)) as OAuthResult
      return this.finalize(myFlow, res)
    } catch (err) {
      return this.fail(myFlow, err)
    }
  }

  /** Abort an in-flight flow. Stale loopback/manual completions are ignored. */
  async cancelSignIn(): Promise<void> {
    this.flowId++ // invalidate any pending completion
    this.settled = true
    this.pendingState = null
    this.broadcast(IDLE)
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private finalize(flow: number, res: OAuthResult): AuthFlowState {
    if (flow !== this.flowId || this.settled) return IDLE
    this.settled = true
    this.pendingState = null

    const account: OAuthAccount | null = res.account
      ? {
          email: res.account.email ?? null,
          organization: res.account.organization ?? null,
          subscriptionType: res.account.subscriptionType ?? null,
          tokenSource: res.account.tokenSource ?? null,
          apiKeySource: res.account.apiKeySource ?? null,
          apiProvider: res.account.apiProvider ?? null
        }
      : null

    const state: AuthFlowState = { status: 'success', account, error: null }
    logger.info('AuthManager', `Login succeeded${account?.email ? ` (${account.email})` : ''}`)
    this.broadcast(state)
    for (const cb of this.onSuccessCbs) {
      try {
        cb(account)
      } catch {
        /* listener errors must not break the flow */
      }
    }
    return state
  }

  private fail(flow: number, err: unknown): AuthFlowState {
    if (flow !== this.flowId || this.settled) return IDLE
    this.settled = true
    this.pendingState = null
    return this.broadcastError(errText(err))
  }

  private broadcastError(message: string): AuthFlowState {
    const state: AuthFlowState = { status: 'error', account: null, error: message }
    logger.error('AuthManager', `Login failed: ${message}`)
    this.broadcast(state)
    return state
  }

  private broadcast(state: AuthFlowState): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('auth:state', state)
    }
  }
}

function parseState(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).searchParams.get('state')
  } catch {
    return null
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

/** Singleton auth manager. */
export const authManager = new AuthManager()
