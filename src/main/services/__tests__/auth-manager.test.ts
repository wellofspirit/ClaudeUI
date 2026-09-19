/**
 * @vitest-environment node
 *
 * Unit tests for AuthManager's subscriber hygiene (C-6) and the hardened,
 * never-rejecting signIn() (C-7). Heavy collaborators (electron, service
 * session, logger) are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ handle: { current: undefined as unknown } }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../../core/services/service-session', () => ({
  serviceSession: {
    getControlHandle: vi.fn(async () => hoisted.handle.current)
  }
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { authManager } from '../auth-manager'
import { serviceSession } from '../../../core/services/service-session'
import { setLiveSessionCanceller } from '../session-invalidation'
import type { AuthFlowState } from '../../../shared/types'

function makeWindow(): {
  sent: Array<[string, unknown[]]>
  win: { isDestroyed: () => boolean; webContents: { send: (ch: string, ...a: unknown[]) => void } }
} {
  const sent: Array<[string, unknown[]]> = []
  return {
    sent,
    win: {
      isDestroyed: () => false,
      webContents: { send: (ch: string, ...args: unknown[]) => sent.push([ch, args]) }
    }
  }
}

describe('AuthManager.setWindow — login-success subscriber hygiene (C-6)', () => {
  it('resets onSuccessCbs each window generation so re-creation does not stack duplicates', () => {
    const cb = vi.fn()
    authManager.setWindow(makeWindow().win as never)
    authManager.onLoginSuccess(cb)
    // Simulate a macOS window re-creation: setWindow then the per-window init()
    // calls re-register their callbacks.
    authManager.setWindow(makeWindow().win as never)
    authManager.onLoginSuccess(cb)
    const cbs = (authManager as unknown as { onSuccessCbs: unknown[] }).onSuccessCbs
    // PRE-FIX: append-only → length 2 (and unbounded across generations).
    expect(cbs).toHaveLength(1)
  })
})

describe('AuthManager.signIn — never rejects, always broadcasts on failure (C-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  it('broadcasts an error (does not reject) when the service session is unavailable', async () => {
    const { sent, win } = makeWindow()
    authManager.setWindow(win as never)
    hoisted.handle.current = null
    const state = await authManager.signIn()
    expect(state.status).toBe('error')
    expect(sent.some(([ch]) => ch === 'auth:state')).toBe(true)
  })

  it('broadcasts an error (does not reject) when getControlHandle throws', async () => {
    const { sent, win } = makeWindow()
    authManager.setWindow(win as never)
    ;(serviceSession.getControlHandle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('spawn failed')
    )
    const state = await authManager.signIn()
    expect(state.status).toBe('error')
    expect(sent.some(([ch]) => ch === 'auth:state')).toBe(true)
  })

  it('broadcasts an error (does not reject) when opening the login page fails', async () => {
    const { win } = makeWindow()
    authManager.setWindow(win as never)
    hoisted.handle.current = {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://auth.example/?state=s',
        automaticUrl: 'https://auth.example/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
      claudeOAuthCallback: vi.fn()
    }
    const shim = await import('../../../test/stubs/electron-shim')
    vi.spyOn(shim.shell, 'openExternal').mockRejectedValueOnce(new Error('no browser'))
    const state = await authManager.signIn()
    expect(state.status).toBe('error')
  })
})

/**
 * ADR-057 — a REMOTE-initiated sign-in must not open a browser on the host, and
 * must surface `manualUrl` so the remote UI can display it. The desktop path is
 * unchanged: it opens the host browser and carries no `manualUrl`. The token
 * exchange stays host-side either way (unchanged).
 */
describe('AuthManager.signIn — remote path skips openExternal + surfaces manualUrl (ADR-057)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://claude.ai/oauth?state=s',
        automaticUrl: 'https://claude.ai/oauth/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
      claudeOAuthCallback: vi.fn()
    }
  })

  it('remote: does NOT call shell.openExternal and returns manualUrl on the state', async () => {
    const { win } = makeWindow()
    authManager.setWindow(win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    const spy = vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    const state = await authManager.signIn({ remote: true })

    expect(spy).not.toHaveBeenCalled()
    expect(state.status).toBe('authorizing')
    expect(state.manualUrl).toBe('https://claude.ai/oauth?state=s')
  })

  it('desktop (no opts): opens the host browser and carries no manualUrl (byte-identical)', async () => {
    const { win } = makeWindow()
    authManager.setWindow(win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    const spy = vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    const state = await authManager.signIn()

    expect(spy).toHaveBeenCalledWith('https://claude.ai/oauth/auto')
    expect(state.status).toBe('authorizing')
    expect(state.manualUrl).toBeUndefined()
  })
})

/**
 * F5 — security-adjacent. A successful login replaces the credential every
 * running engine process cached, so those processes have to stop MAIN-side.
 *
 * PRE-FIX the only reaction was the desktop renderer's `auth:state` handler
 * marking its ACTIVE session inactive: the processes stayed up on the stale
 * token, every other session (and every other client) was told nothing, and
 * canonical — which never hears a `host-local` channel — went on serving
 * `sdkActive: true` in every snapshot. Cancelling needs no new channel: the
 * `disconnected` status each cancel broadcasts is already folded to
 * `sdkActive: false` by the shared reducer.
 */
describe('AuthManager.finalize — a successful login stops the stale-credential processes (F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  async function driveSuccessfulLogin(): Promise<Array<[string, unknown[]]>> {
    const { sent, win } = makeWindow()
    authManager.setWindow(win as never)
    hoisted.handle.current = {
      claudeAuthenticate: vi.fn(async () => ({ manualUrl: 'https://auth.example/?state=s' })),
      claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
      claudeOAuthCallback: vi.fn(async () => ({ account: { email: 'user@example.com' } }))
    }
    await authManager.signIn()
    await authManager.submitOAuthCode('the-code')
    return sent
  }

  it('cancels every live session', async () => {
    const cancelled: string[] = []
    setLiveSessionCanceller(() => cancelled.push('cancelAll'))
    try {
      const sent = await driveSuccessfulLogin()
      expect(sent.some(([ch]) => ch === 'auth:state')).toBe(true)
      expect(cancelled).toEqual(['cancelAll'])
    } finally {
      setLiveSessionCanceller(null)
    }
  })

  it('a throwing canceller never breaks the login flow', async () => {
    setLiveSessionCanceller(() => {
      throw new Error('manager exploded')
    })
    try {
      const sent = await driveSuccessfulLogin()
      // The success broadcast still went out.
      const states = sent.filter(([ch]) => ch === 'auth:state').map(([, a]) => a[0])
      expect(states.some((st) => (st as { status: string }).status === 'success')).toBe(true)
    } finally {
      setLiveSessionCanceller(null)
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-070 slice D — the remote paste-back sign-in swallowed its own success.
// ---------------------------------------------------------------------------

/** Structural shape of the states these tests assert on. */
interface AuthFlowStateish {
  status: string
  account: { email?: string | null } | null
  error: string | null
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-queued microtask and timer-0 continuation run. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

const ACCOUNT = { account: { email: 'user@example.com' } }

function internals(): {
  finalize: (flow: number, res: unknown) => AuthFlowStateish
  fail: (flow: number, err: unknown) => AuthFlowStateish
  flowId: number
} {
  return authManager as unknown as {
    finalize: (flow: number, res: unknown) => AuthFlowStateish
    fail: (flow: number, err: unknown) => AuthFlowStateish
    flowId: number
  }
}

/**
 * Reproduces the cli.js shape that causes the bug. In vendor/claude-cli/cli.js
 * (2.1.268) `claude_oauth_callback` and `claude_oauth_wait_for_completion` are
 * served by ONE branch — locate it by the literal `No active claude_authenticate
 * flow` — and BOTH attach a continuation to the SAME `Ls.flow` promise. The two
 * control requests therefore settle together, in continuation-registration
 * order, which is what this handle models: one shared promise behind both.
 */
function makeSharedFlowHandle(): {
  handle: {
    claudeAuthenticate: ReturnType<typeof vi.fn>
    claudeOAuthWaitForCompletion: ReturnType<typeof vi.fn>
    claudeOAuthCallback: ReturnType<typeof vi.fn>
  }
  flow: ReturnType<typeof deferred<void>>
} {
  const flow = deferred<void>()
  return {
    flow,
    handle: {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://claude.ai/oauth?state=s',
        automaticUrl: 'https://claude.ai/oauth/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => flow.promise.then(() => ACCOUNT)),
      claudeOAuthCallback: vi.fn(() => flow.promise.then(() => ACCOUNT))
    }
  }
}

describe('AuthManager.signIn — the host loopback wait is a DESKTOP-only arm (slice D)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  it('remote: does NOT arm claudeOAuthWaitForCompletion', async () => {
    const { handle } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)

    await authManager.signIn({ remote: true })

    // A remote browser's redirect goes to `localhost` on the REMOTE USER'S OWN
    // device, so the host loopback can never be hit from there. Arming it buys
    // nothing and races the paste path for the one shared cli.js flow promise.
    expect(handle.claudeOAuthWaitForCompletion).not.toHaveBeenCalled()
  })

  it('desktop: still arms claudeOAuthWaitForCompletion (unchanged)', async () => {
    const { handle } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    await authManager.signIn()

    expect(handle.claudeOAuthWaitForCompletion).toHaveBeenCalledTimes(1)
  })
})

describe('AuthManager.submitOAuthCode — reports the real outcome, never `idle` (slice D)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  /**
   * THE BUG THE OWNER HIT. A remote sign-in, code pasted, exchange succeeded
   * host-side — and the invoke return (the remote caller's ONLY outcome channel,
   * since `auth:state` is host-local by design) said `idle`, so the web UI
   * reported neither success nor failure and they had to RDP in to sign in.
   */
  it('remote: a pasted code whose flow also settles an armed wait still returns success', async () => {
    const { handle, flow } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)

    await authManager.signIn({ remote: true })

    const submit = authManager.submitOAuthCode('the-code')
    await flush() // let submitOAuthCode reach claudeOAuthCallback
    expect(handle.claudeOAuthCallback).toHaveBeenCalled()

    // Both continuations are registered on the one shared flow promise now;
    // resolving it runs them in registration order.
    flow.resolve()
    const state = (await submit) as AuthFlowStateish

    expect(state.status).toBe('success')
    expect(state.account?.email).toBe('user@example.com')
  })

  /**
   * The same swallow, reached the other way: on the DESKTOP the wait is
   * legitimately armed, so a paste that races the loopback still double-settles
   * one flow. Unarming cannot help here — only caching the terminal state per
   * flow id can.
   */
  it('desktop: a paste that races the loopback settle returns the success, not idle', async () => {
    const { handle, flow } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    await authManager.signIn()

    const submit = authManager.submitOAuthCode('the-code')
    await flush()
    expect(handle.claudeOAuthCallback).toHaveBeenCalled()

    flow.resolve()
    const state = (await submit) as AuthFlowStateish

    expect(state.status).toBe('success')
    expect(state.account?.email).toBe('user@example.com')
  })
})

describe('AuthManager terminal-state replay — scope and side effects (slice D)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  it('a completion for a STALE flow id still reads idle', async () => {
    const { handle } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)

    await authManager.signIn({ remote: true })
    const stale = internals().flowId
    // The user restarted the login: a newer flow supersedes the old one.
    await authManager.signIn({ remote: true })

    const state = internals().finalize(stale, ACCOUNT)

    expect(state.status).toBe('idle')
    expect(state.account).toBeNull()
  })

  it('a second settle of an already-succeeded flow does not downgrade it to an error', async () => {
    const waitFlow = deferred<unknown>()
    hoisted.handle.current = {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://claude.ai/oauth?state=s',
        automaticUrl: 'https://claude.ai/oauth/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => waitFlow.promise),
      claudeOAuthCallback: vi.fn(async () => ACCOUNT)
    }
    const { sent, win } = makeWindow()
    authManager.setWindow(win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    await authManager.signIn()
    const thisLogin = internals().flowId
    const ok = (await authManager.submitOAuthCode('the-code')) as AuthFlowStateish
    expect(ok.status).toBe('success')

    // The shared cli.js flow's OTHER continuation now rejects.
    waitFlow.reject(new Error('flow aborted'))
    await flush()

    // Neither the broadcast nor a direct re-settle may turn the success sour.
    const states = sent
      .filter(([ch]) => ch === 'auth:state')
      .map(([, a]) => a[0] as AuthFlowStateish)
    expect(states.filter((st) => st.status === 'error')).toHaveLength(0)
    expect(states[states.length - 1].status).toBe('success')
    expect(internals().fail(thisLogin, new Error('late failure')).status).toBe('success')
  })

  it('replaying a settled flow re-runs no side effects (one invalidateLiveSessions per login)', async () => {
    const { handle, flow } = makeSharedFlowHandle()
    hoisted.handle.current = handle
    const { sent, win } = makeWindow()
    authManager.setWindow(win as never)
    const shim = await import('../../../test/stubs/electron-shim')
    vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    const cancelled: string[] = []
    setLiveSessionCanceller(() => cancelled.push('cancelAll'))
    try {
      await authManager.signIn() // desktop: the wait is armed, so the flow settles twice
      const submit = authManager.submitOAuthCode('the-code')
      await flush()
      flow.resolve()
      expect(((await submit) as AuthFlowStateish).status).toBe('success')
      await flush()

      expect(cancelled).toEqual(['cancelAll'])
      const successes = sent
        .filter(([ch]) => ch === 'auth:state')
        .map(([, a]) => a[0] as AuthFlowStateish)
        .filter((st) => st.status === 'success')
      expect(successes).toHaveLength(1)
    } finally {
      setLiveSessionCanceller(null)
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-070 slice G — claude.ai hands back `code#state` as ONE string, and we
// posted the whole blob as the authorization code (the owner's 400).
// ---------------------------------------------------------------------------

/**
 * cli.js splits the pasted string in BOTH of its own manual entries and does
 * NOT split it on the control path we drive (vendor/claude-cli/cli.js 2.1.268):
 *
 *   REPL   @21948712: `let[I,ae]=Q.split("#");if(!I||!ae){…"Invalid code.
 *                      Please make sure the full code was copied"…}` then
 *                     `handleManualAuthCodeInput({authorizationCode:I,state:ae})`
 *   stdin  @23375467: the same split and the same guard, per input line.
 *   control@23904052: `claude_oauth_callback` →
 *                     `Ls.service.handleManualAuthCodeInput({
 *                        authorizationCode:d.request.authorizationCode,
 *                        state:d.request.state})` — straight through, no split.
 *
 * Splitting is therefore the CALLER's job over the control channel, and we are
 * the caller. The whole blob reached the token exchange's POST body as `code`,
 * which is the 400 the owner saw.
 */
describe('AuthManager.submitOAuthCode — the paste is `code#state` (slice G)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  function makePasteHandle(): {
    claudeAuthenticate: ReturnType<typeof vi.fn>
    claudeOAuthWaitForCompletion: ReturnType<typeof vi.fn>
    claudeOAuthCallback: ReturnType<typeof vi.fn>
  } {
    return {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://claude.ai/oauth?state=s',
        automaticUrl: 'https://claude.ai/oauth/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
      claudeOAuthCallback: vi.fn(async () => ACCOUNT)
    }
  }

  async function startRemoteFlow(): Promise<ReturnType<typeof makePasteHandle>> {
    const handle = makePasteHandle()
    hoisted.handle.current = handle
    authManager.setWindow(makeWindow().win as never)
    await authManager.signIn({ remote: true })
    return handle
  }

  /** GUARD — fails pre-fix: the blob went out whole and the server answered 400. */
  it('splits `CODE#STATE` into the two control-request fields', async () => {
    const handle = await startRemoteFlow()

    const state = (await authManager.submitOAuthCode('CODE#STATE')) as AuthFlowStateish

    expect(handle.claudeOAuthCallback).toHaveBeenCalledWith('CODE', 'STATE')
    expect(state.status).toBe('success')
  })

  /**
   * The fallback, pinned so it cannot rot: a paste with no `#` is the code, and
   * the state is the one parsed off this flow's own authorize URL. This is
   * today's behaviour exactly — the fix is strictly additive.
   */
  it('a paste with no `#` still sends the whole string plus the flow state', async () => {
    const handle = await startRemoteFlow()

    await authManager.submitOAuthCode('  just-the-code  ')

    expect(handle.claudeOAuthCallback).toHaveBeenCalledWith('just-the-code', 's')
  })

  /**
   * The state is opaque. cli.js's own `split("#")` destructure silently drops
   * anything past a second `#`; splitting on the FIRST one keeps the state
   * whole, which can only ever be more correct.
   */
  it('splits on the FIRST `#` only — the state is opaque', async () => {
    const handle = await startRemoteFlow()

    await authManager.submitOAuthCode('CODE#ST#ATE')

    expect(handle.claudeOAuthCallback).toHaveBeenCalledWith('CODE', 'ST#ATE')
  })

  it.each([['#STATE'], ['CODE#'], ['#']])(
    'refuses %j without posting an empty half',
    async (pasted) => {
      const handle = await startRemoteFlow()

      const state = (await authManager.submitOAuthCode(pasted)) as AuthFlowStateish

      expect(handle.claudeOAuthCallback).not.toHaveBeenCalled()
      expect(state.status).toBe('error')
      expect(state.error).toBe('Invalid code. Please make sure the full code was copied.')
    }
  )

  /** A half-copied paste is a typo, not a dead flow: the next one must work. */
  it('a refused half-copy leaves the flow live, so a good paste still completes it', async () => {
    const handle = await startRemoteFlow()

    expect(((await authManager.submitOAuthCode('CODE#')) as AuthFlowStateish).status).toBe('error')
    const state = (await authManager.submitOAuthCode('CODE#STATE')) as AuthFlowStateish

    expect(handle.claudeOAuthCallback).toHaveBeenCalledWith('CODE', 'STATE')
    expect(state.status).toBe('success')
  })
})

/**
 * G2 — a failed paste must not destroy the sign-in link. `broadcastError`
 * returned no `manualUrl`, the store assigns the invoke return straight onto
 * `authState`, and the panel reads `authState.manualUrl` — so one bad paste
 * left it saying "The host did not return a sign-in link. Start again." with
 * the link gone and `Sign-in page ↗` disabled.
 */
describe('AuthManager — an error on a LIVE flow carries its sign-in link (slice G)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.handle.current = undefined
  })

  function remoteFlowHandle(callback: ReturnType<typeof vi.fn>): {
    claudeAuthenticate: ReturnType<typeof vi.fn>
    claudeOAuthWaitForCompletion: ReturnType<typeof vi.fn>
    claudeOAuthCallback: ReturnType<typeof vi.fn>
  } {
    return {
      claudeAuthenticate: vi.fn(async () => ({
        manualUrl: 'https://claude.ai/oauth?state=s',
        automaticUrl: 'https://claude.ai/oauth/auto'
      })),
      claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
      claudeOAuthCallback: callback
    }
  }

  /** GUARD — fails pre-fix: the error state dropped the URL the panel needs. */
  it('a failed submit on a live remote flow still returns manualUrl', async () => {
    hoisted.handle.current = remoteFlowHandle(
      vi.fn(async () => {
        throw new Error('Request failed with status code 400')
      })
    )
    authManager.setWindow(makeWindow().win as never)
    await authManager.signIn({ remote: true })

    const state = (await authManager.submitOAuthCode('CODE#STATE')) as AuthFlowState

    expect(state.status).toBe('error')
    expect(state.error).toBe('Request failed with status code 400')
    expect(state.manualUrl).toBe('https://claude.ai/oauth?state=s')
  })

  it('a refused half-copy carries the link too', async () => {
    hoisted.handle.current = remoteFlowHandle(vi.fn())
    authManager.setWindow(makeWindow().win as never)
    await authManager.signIn({ remote: true })

    const state = (await authManager.submitOAuthCode('#STATE')) as AuthFlowState

    expect(state.manualUrl).toBe('https://claude.ai/oauth?state=s')
  })

  /** Failures from BEFORE a flow exists have no link to carry — unchanged. */
  it('signIn early failures still carry no manualUrl', async () => {
    authManager.setWindow(makeWindow().win as never)
    hoisted.handle.current = null

    const state = (await authManager.signIn({ remote: true })) as AuthFlowState

    expect(state.status).toBe('error')
    expect(state.manualUrl).toBeUndefined()
  })

  it('a submit with no live flow still carries no manualUrl', async () => {
    authManager.setWindow(makeWindow().win as never)
    await authManager.cancelSignIn()
    hoisted.handle.current = remoteFlowHandle(vi.fn())

    const state = (await authManager.submitOAuthCode('CODE#STATE')) as AuthFlowState

    expect(state.status).toBe('error')
    expect(state.error).toBe('No active login flow. Start login again.')
    expect(state.manualUrl).toBeUndefined()
  })

  /** Slice D's invariant: a replayed terminal state still wins, unaltered. */
  it('a late failure on a flow that already succeeded replays the success, link-free', async () => {
    hoisted.handle.current = remoteFlowHandle(vi.fn(async () => ACCOUNT))
    authManager.setWindow(makeWindow().win as never)
    await authManager.signIn({ remote: true })
    const thisLogin = internals().flowId

    expect(((await authManager.submitOAuthCode('CODE#STATE')) as AuthFlowStateish).status).toBe(
      'success'
    )

    const late = internals().fail(thisLogin, new Error('late failure')) as AuthFlowState
    expect(late.status).toBe('success')
    expect(late.manualUrl).toBeUndefined()
  })
})
