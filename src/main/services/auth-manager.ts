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
 * The pasted "Authentication code" is ONE `<code>#<state>` string and this
 * control request takes the two halves separately — see `submitOAuthCode`.
 *
 * The IPC `signIn()` resolves as soon as the browser is opened (status
 * "authorizing") without blocking the renderer. On the DESKTOP the terminal
 * result arrives via the `auth:state` broadcast, and the loopback wait races an
 * optional manual paste for the same flow. A REMOTE sign-in (ADR-057) arms no
 * loopback wait — see `signIn` — and `auth:state` is host-local by design, so
 * its terminal result is carried by the `submitOAuthCode` invoke RETURN and
 * nothing else. That is why settling a flow twice must not erase its outcome
 * (`replaySettled`).
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
import { serviceSession } from '../../core/services/service-session'
import { invalidateLiveSessions } from './session-invalidation'
import { logger } from '../../core/services/logger'
import { emitEvent } from '../../core/services/sync-host'
import { ANTHROPIC_AUTH_PROVIDER_ID } from '../../core/auth/auth-providers'

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

/**
 * cli.js's own wording for the same condition — a paste with one half missing.
 * Both of its manual entries (the REPL's paste handler and `claude auth
 * login`'s stdin line handler) refuse on `if (!code || !state)` with this
 * sentence, so a user who has seen the CLI reads the same thing here. (The
 * REPL's copy omits the full stop; the stdin one has it.)
 */
const HALF_COPIED = 'Invalid code. Please make sure the full code was copied.'

class AuthManager {
  private window: BrowserWindow | null = null
  /** `state` param parsed from the active flow's login URL (for manual paste). */
  private pendingState: string | null = null
  /**
   * The active REMOTE flow's `manualUrl`, so an error raised while that flow is
   * live can carry it forward — the remote paste panel reads the URL off
   * `authState`, and an error state without it is what turned one bad paste
   * into "The host did not return a sign-in link. Start again." Set only on the
   * remote path, exactly like the `manualUrl` on `signIn`'s own return: the
   * desktop has no paste panel to serve, and its payloads stay untouched.
   */
  private pendingManualUrl: string | null = null
  /** Monotonic flow id — stale completions (after cancel/restart) are ignored. */
  private flowId = 0
  /** Guards against finalizing the same flow twice (loopback + manual race). */
  private settled = false
  /**
   * Terminal state of the last flow that settled, keyed by its id. Replayed
   * when the SAME flow settles again so the second caller is told the real
   * outcome instead of `IDLE` — see `replaySettled`.
   */
  private settledFlow: { flow: number; state: AuthFlowState } | null = null

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
    this.pendingManualUrl = null

    let urls: AuthorizeUrls
    try {
      urls = (await handle.claudeAuthenticate(true)) as AuthorizeUrls
    } catch (err) {
      return this.broadcastError(`Failed to start login: ${errText(err)}`)
    }

    this.pendingState = parseState(urls.manualUrl)
    if (remote) this.pendingManualUrl = urls.manualUrl ?? null
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
    //
    // DESKTOP ONLY, and not as an optimisation: arming this on the remote path
    // is what made a SUCCESSFUL remote sign-in report nothing at all. A remote
    // browser's redirect goes to `localhost` on the REMOTE USER'S OWN device,
    // so the host loopback listener can never be hit from there — the wait can
    // only ever settle off the paste. And cli.js serves
    // `claude_oauth_wait_for_completion` and `claude_oauth_callback` from ONE
    // branch attached to the SAME `Ls.flow` promise (vendor/claude-cli/cli.js
    // 2.1.268 — find it by the literal `No active claude_authenticate flow`;
    // docs/protocol-cc/07-control-outbound.md §7.5), so both continuations run
    // when the exchange succeeds, in registration order. This one was
    // registered first, so it settled the very flow the paste was trying to
    // complete, and `submitOAuthCode`'s own finalize() then hit the
    // already-settled guard and returned IDLE. `auth:state` is host-local by
    // design (a flow's `state` param is its CSRF token — see the `why` in
    // core/shared/sync/channels.ts) and there is no auth-state QUERY to poll,
    // so that invoke return is a remote caller's only outcome channel: the
    // login had actually succeeded host-side and the web UI was told `idle`.
    if (!remote) {
      handle
        .claudeOAuthWaitForCompletion()
        .then((res) => this.finalize(myFlow, res as OAuthResult))
        .catch((err) => this.fail(myFlow, err))
    }

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

  /**
   * Manual fallback: complete the flow with a pasted authorization code.
   *
   * claude.ai's "Authentication code" page hands back ONE string of the form
   * `<code>#<state>`, and splitting it is the CALLER's job here. cli.js splits
   * it in both of its own manual entries — the REPL's paste handler and `claude
   * auth login`'s stdin line handler, each `split("#")` then `if (!code ||
   * !state)` — but the `claude_oauth_callback` control request we drive passes
   * `authorizationCode` and `state` straight into `handleManualAuthCodeInput`
   * with no split of its own. We were the one entry not splitting, so the whole
   * `code#state` blob went into the token exchange's POST body as `code` and
   * claude.ai answered 400.
   *
   * cli.js's `handleManualAuthCodeInput` currently reads only
   * `authorizationCode` and drops `state` (the exchange re-uses the state it
   * generated itself), so today only the split changes the outcome. We still
   * send the pasted half rather than `pendingState`, because that is what
   * cli.js's own entries send and a version that starts validating it must find
   * what it expects.
   *
   * A paste with no `#` keeps the previous behaviour exactly — whole string as
   * the code, `pendingState` as the state. Strictly additive on purpose: this
   * repairs the broken path without touching one that may work.
   */
  async submitOAuthCode(code: string): Promise<AuthFlowState> {
    const handle = await serviceSession.getControlHandle()
    if (!handle || !this.pendingState) {
      return this.broadcastError('No active login flow. Start login again.')
    }
    const myFlow = this.flowId
    const pasted = code.trim()
    // FIRST `#` only: the state is opaque, so anything after the separator
    // belongs to it. (cli.js's destructuring `split("#")` would silently drop a
    // third segment; keeping it whole can only ever be more correct.)
    const sep = pasted.indexOf('#')
    const authorizationCode = sep === -1 ? pasted : pasted.slice(0, sep)
    const state = sep === -1 ? this.pendingState : pasted.slice(sep + 1)
    if (!authorizationCode || !state) {
      // Half a paste is a copy that stopped short, not a dead flow: report it
      // WITHOUT settling, so the same flow accepts the next attempt. Posting an
      // empty half would burn the flow for real (a failed exchange rejects
      // cli.js's shared flow promise, which clears its `Ls` and leaves every
      // later paste answering "No active claude_authenticate flow").
      return this.broadcastError(HALF_COPIED, this.pendingManualUrl ?? undefined)
    }
    try {
      const res = (await handle.claudeOAuthCallback(authorizationCode, state)) as OAuthResult
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
    this.pendingManualUrl = null
    this.broadcast(IDLE)
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * A flow can settle twice — cli.js hangs the loopback wait and the manual
   * paste off one shared promise, so on the desktop both continuations fire on
   * a successful exchange. The second one used to read `IDLE`, which is how a
   * login that succeeded reported neither success nor failure to the caller
   * whose invoke return was the only channel it had. Replay that flow's real
   * terminal state instead.
   *
   * Scope is deliberately per flow ID: a settle for a DIFFERENT flow is not a
   * duplicate — it belongs to a login the user cancelled or restarted — and
   * still reads `IDLE`, which is the correct answer for it.
   *
   * Side-effect free on purpose. It returns BEFORE `invalidateLiveSessions`,
   * the `auth:state` broadcast, the `onSuccessCbs` loop and the
   * `provider:auth-resolved` emit, so a replay cannot re-run any of them and
   * cannot stomp the state of a newer flow. Answering a duplicate is all it
   * does.
   */
  private replaySettled(flow: number): AuthFlowState | null {
    return this.settledFlow?.flow === flow ? this.settledFlow.state : null
  }

  private finalize(flow: number, res: OAuthResult): AuthFlowState {
    const replay = this.replaySettled(flow)
    if (replay) return replay
    if (flow !== this.flowId || this.settled) return IDLE
    this.settled = true
    this.pendingState = null
    this.pendingManualUrl = null

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
    // Remembered BEFORE the side effects below, so even a re-entrant settle
    // (from one of the `onSuccessCbs`) replays this instead of erasing it.
    this.settledFlow = { flow, state }
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
    // ADR-070 §2: the ONE resolution signal. Replicated, so every client — not
    // just the desktop that signed in — clears the sign-in this login fixed;
    // before it, `authRequired` was cleared only by a turn that RAN again, which
    // meant a successful sign-in left every owed-sign-in surface lit.
    //
    // An import-based emit rather than one more `onSuccessCbs` subscriber:
    // `setWindow` resets that list on every window generation (see its note), so
    // a callback registered from another module is not reliably present — and
    // this function already reaches core the same way, via
    // `invalidateLiveSessions` above.
    //
    // **LAST in this function, deliberately — do not move it up.** A client's
    // reaction to this event is `vendorAuthProbe('claude')`, which reads
    // `ClaudeAuthProvider.cachedAuthSource`, and that field is refreshed by one of
    // the `onSuccessCbs` above. Emitting before the loop would publish the fact
    // before the state it makes clients read, and the only thing hiding it would
    // be that the renderer is two async IPC hops away while the loop is
    // synchronous. Ordering by luck on the Claude login path is not ordering.
    emitEvent('provider:auth-resolved', [{ providerId: ANTHROPIC_AUTH_PROVIDER_ID }])
    return state
  }

  private fail(flow: number, err: unknown): AuthFlowState {
    // Same replay, and it matters most here: the loopback wait rejecting after
    // the paste already succeeded must NOT turn that success into an error.
    const replay = this.replaySettled(flow)
    if (replay) return replay
    if (flow !== this.flowId || this.settled) return IDLE
    this.settled = true
    // Read BEFORE clearing: this failure happened ON that flow, so its error
    // state is exactly the one that has to carry the flow's sign-in link.
    const manualUrl = this.pendingManualUrl ?? undefined
    this.pendingState = null
    this.pendingManualUrl = null
    const state = this.broadcastError(errText(err), manualUrl)
    this.settledFlow = { flow, state }
    return state
  }

  /**
   * `manualUrl` is passed EXPLICITLY, never read from the field here, because
   * this is also the reporting path for failures that happen before any flow
   * exists — `signIn`'s early returns and a paste with no flow to complete.
   * Those have no link to offer and must stay link-free; only a caller that
   * knows it is failing a live flow passes one.
   */
  private broadcastError(message: string, manualUrl?: string): AuthFlowState {
    const state: AuthFlowState = {
      status: 'error',
      account: null,
      error: message,
      ...(manualUrl ? { manualUrl } : {})
    }
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
