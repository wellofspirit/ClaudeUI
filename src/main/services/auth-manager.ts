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
import { invalidateLiveSessions } from './session-invalidation'
import { logger } from '../../core/services/logger'
import { emitEvent } from '../../core/services/sync-host'

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
    // Reset the login-success subscribers on each window generation. setWindow()
    // is called once per createWindow (index.ts), immediately BEFORE the
    // per-window init() calls that (re-)register their callbacks
    // (AccountManager.init + ClaudeAuthProvider.init). Without this reset,
    // onSuccessCbs is append-only, so a macOS window re-creation (activate after
    // all windows closed) stacks a duplicate callback each time — unbounded
    // growth and duplicate side effects (N DB upserts + N broadcasts per login).
    this.onSuccessCbs = []
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
    // login is global so the id is a synthetic 'system'. Reaches every subscriber
    // since SyncCore phase 4c — the channel rings, so a reconnecting client
    // already replayed this from the catchup; being main-window-only live was the
    // asymmetry, not a privacy boundary.
    emitEvent('session:auth-source', ['system', loggedIn ? 'authenticated' : 'none'])
  }

  // ---------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------

  /**
   * Begin the login flow. Opens the browser and starts awaiting the loopback
   * redirect in the background. Resolves with the "authorizing" snapshot; the
   * success/error transition is broadcast via `auth:state`.
   *
   * `opts.remote` (ADR-057) is the ONLY behavioural fork: a remote-initiated
   * sign-in must NOT open a browser on the HOST — the remote user opens the URL
   * on their own device — so `shell.openExternal` is skipped and the returned
   * snapshot carries `manualUrl` for the remote UI to display. cli.js still
   * performs the token EXCHANGE host-side either way (that is correct and
   * unchanged). The desktop path (`opts` absent) is byte-identical to before.
   */
  async signIn(opts?: { remote?: boolean }): Promise<AuthFlowState> {
    const remote = opts?.remote === true
    // Never let a spawn-path throw escape as a rejected promise: callers
    // fire-and-forget this (AccountManager.addAccount → `void signIn()`), so a
    // rejection would be an unhandled rejection AND the renderer would get no
    // auth:state error. getControlHandle() and openExternal() below can throw,
    // so both are guarded and funnel into broadcastError() instead.
    let handle: Awaited<ReturnType<typeof serviceSession.getControlHandle>>
    try {
      handle = await serviceSession.getControlHandle()
    } catch (err) {
      return this.broadcastError(`Could not start the login service session: ${errText(err)}`)
    }
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
    // Remote sign-in: do NOT open a browser on the host — the remote user opens
    // `manualUrl` on their own device (ADR-057). Desktop: open the host browser
    // exactly as before.
    if (!remote && urls.automaticUrl) {
      try {
        await shell.openExternal(urls.automaticUrl)
      } catch (err) {
        return this.broadcastError(`Failed to open the login page: ${errText(err)}`)
      }
    }

    // Await the loopback redirect in the background — do not block the caller.
    // On the remote path the host loopback still arms (harmless); completion
    // will normally arrive via `auth:submit-code` instead.
    handle
      .claudeOAuthWaitForCompletion()
      .then((res) => this.finalize(myFlow, res as OAuthResult))
      .catch((err) => this.fail(myFlow, err))

    const authorizing: AuthFlowState = {
      status: 'authorizing',
      account: null,
      error: null,
      // Surfaced ONLY for a remote sign-in, so the desktop snapshot is unchanged.
      ...(remote ? { manualUrl: urls.manualUrl } : {})
    }
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
    // Every live engine process cached the credential this login just replaced,
    // so stop them main-side. Before this the ONLY reaction was the desktop
    // renderer's `auth:state` handler marking its ACTIVE session inactive: the
    // processes stayed up on the stale token, every other session (and every
    // other client) was told nothing, and canonical never heard about it at all.
    // "The active session" is not expressible here on purpose — selection is
    // per-client view state (ADR-041) — and it is also the wrong scope: every
    // session holds the same stale credential.
    invalidateLiveSessions('Claude login succeeded')
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
