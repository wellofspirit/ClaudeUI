/**
 * Who performs a Claude sign-in: cli.js, or the app itself.
 *
 * `AuthManager` owns the flow's state machine (flow ids, settle/replay, remote
 * vs desktop, the half-copied paste, cancel, `finalize`'s side effects). The
 * three calls it makes to actually sign in sit behind {@link ClaudeLoginBackend}:
 *
 *   - **cli.js** (single-account): the service session's native control
 *     requests (`claude_authenticate` / `claude_oauth_wait_for_completion` /
 *     `claude_oauth_callback`, docs/protocol-cc/07-control-outbound.md §7.5).
 *     cli.js stores the login in the user's own Claude Code credential store.
 *   - **in-app** (multi-account, ADR-015): `core/auth/claude-oauth.ts` runs the
 *     same OAuth flow and writes the ACTIVE account dir's `.credentials.json`,
 *     so the login no longer depends on cli.js's store being redirected there.
 *
 * The backend is chosen per flow, when the sign-in STARTS, and the account dir
 * is captured then: a later switch ends a login already under way rather than
 * moving it (see {@link InAppLoginBackend}).
 */

import { serviceSession, type ServiceControlHandle } from '../../core/services/service-session'
import { getSecurestorageEnv, onSecurestorageEnvChange } from '../../core/sdk/securestorage-env'
import { ClaudeLoginFlow } from '../../core/auth/claude-oauth'

export interface AuthorizeUrls {
  manualUrl?: string
  automaticUrl?: string
}

export interface OAuthResult {
  account?: {
    email?: string | null
    organization?: string | null
    subscriptionType?: string | null
    tokenSource?: string | null
    apiKeySource?: string | null
    apiProvider?: string | null
  }
}

export interface ClaudeLoginBackend {
  readonly kind: 'cli' | 'in-app'
  /** Start a flow and return its authorize URLs. `remote` = ADR-057 sign-in. */
  authenticate(opts: { remote: boolean }): Promise<AuthorizeUrls>
  /** The flow's outcome via the loopback redirect (desktop only). */
  waitForCompletion(): Promise<OAuthResult>
  /** Complete the flow with a pasted code (already split from `code#state`). */
  submitCode(code: string, state: string): Promise<OAuthResult>
  /** Abandon the flow. */
  cancel(): void
}

/** cli.js, over the service session. Unchanged from before the seam. */
export class CliLoginBackend implements ClaudeLoginBackend {
  readonly kind = 'cli' as const

  constructor(private readonly handle: ServiceControlHandle) {}

  async authenticate(): Promise<AuthorizeUrls> {
    return (await this.handle.claudeAuthenticate(true)) as AuthorizeUrls
  }

  async waitForCompletion(): Promise<OAuthResult> {
    return (await this.handle.claudeOAuthWaitForCompletion()) as OAuthResult
  }

  async submitCode(code: string, state: string): Promise<OAuthResult> {
    return (await this.handle.claudeOAuthCallback(code, state)) as OAuthResult
  }

  /**
   * Nothing to do, as before: cli.js replaces its own flow on the next
   * `claude_authenticate`, and AuthManager's flow id discards a stale answer.
   */
  cancel(): void {
    /* no-op — see above */
  }
}

/** Why an in-app flow ended when the account it was signing in moved away. */
export const ACCOUNT_CHANGED_DURING_SIGN_IN =
  'The active account changed during sign-in. Start again.'

/**
 * The app's own flow, writing one account dir's `.credentials.json`.
 *
 * The flow dies when the active account dir moves off `accountDir`, the way a
 * cli.js flow dies with the service session `AccountManager` stops on every
 * switch. Surviving it would be worse than it looks: the credential would land
 * in the right dir, but `AccountManager.noteLogin` stamps the login's email on
 * whichever account is active WHEN it succeeds.
 */
export class InAppLoginBackend implements ClaudeLoginBackend {
  readonly kind = 'in-app' as const
  private flow: ClaudeLoginFlow | null = null
  private unwatch: (() => void) | null = null

  constructor(
    readonly accountDir: string,
    private readonly makeFlow: (opts: {
      accountDir: string
      loopback: boolean
    }) => ClaudeLoginFlow = (opts) => new ClaudeLoginFlow(opts)
  ) {}

  async authenticate(opts: { remote: boolean }): Promise<AuthorizeUrls> {
    this.cancel()
    // No loopback for a remote sign-in: its redirect lands on the remote
    // device's own localhost, never on this host's listener.
    const flow = this.makeFlow({ accountDir: this.accountDir, loopback: !opts.remote })
    const urls = await flow.start()
    this.flow = flow
    const unwatch = onSecurestorageEnvChange((env) => {
      if (env?.dir !== this.accountDir) flow.cancel(ACCOUNT_CHANGED_DURING_SIGN_IN)
    })
    this.unwatch = unwatch
    // Settled either way, the flow no longer cares where the pointer goes.
    void flow.done.then(unwatch)
    return urls
  }

  waitForCompletion(): Promise<OAuthResult> {
    if (!this.flow) return Promise.reject(new Error('No active login flow'))
    return this.flow.waitForCompletion()
  }

  submitCode(code: string, state: string): Promise<OAuthResult> {
    if (!this.flow) return Promise.reject(new Error('No active login flow'))
    return this.flow.submitCode(code, state)
  }

  cancel(): void {
    this.unwatch?.()
    this.unwatch = null
    this.flow?.cancel()
    this.flow = null
  }
}

/**
 * The backend for a NEW flow: in-app when multi-account mode has an active
 * account dir, cli.js otherwise. `null` (or a throw) means cli.js's service
 * session could not be reached — AuthManager's "Could not start the login
 * service session" — which the in-app backend never answers.
 */
export async function openLoginBackend(): Promise<ClaudeLoginBackend | null> {
  const dir = getSecurestorageEnv()?.dir
  if (dir) return new InAppLoginBackend(dir)
  const handle = await serviceSession.getControlHandle()
  return handle ? new CliLoginBackend(handle) : null
}

/**
 * The backend a PASTE goes to. An in-app flow lives in this process and only
 * its own object holds the verifier, so the paste returns to it. cli.js is
 * re-reached through the service session at paste time, exactly as before the
 * seam — a service session restarted since the flow began then answers for
 * itself rather than through a handle to a stopped process.
 */
export function backendForPaste(
  current: ClaudeLoginBackend | null
): Promise<ClaudeLoginBackend | null> {
  if (current?.kind === 'in-app') return Promise.resolve(current)
  return openLoginBackend()
}
