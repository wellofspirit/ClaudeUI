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
vi.mock('../service-session', () => ({
  serviceSession: {
    getControlHandle: vi.fn(async () => hoisted.handle.current)
  }
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { authManager } from '../auth-manager'
import { serviceSession } from '../service-session'
import { setLiveSessionCanceller } from '../session-invalidation'

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
