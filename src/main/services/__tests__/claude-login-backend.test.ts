/**
 * @vitest-environment node
 *
 * Which backend performs a Claude sign-in (claude-login-backend.ts), and that
 * AuthManager drives the in-app one through the same state machine. The in-app
 * flow itself is faked here — claude-oauth.test.ts covers it against a real
 * loopback listener.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  handle: { current: undefined as unknown },
  flows: [] as Array<{
    opts: { accountDir: string; loopback: boolean }
    start: ReturnType<typeof vi.fn>
    waitForCompletion: ReturnType<typeof vi.fn>
    submitCode: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../../core/services/service-session', () => ({
  serviceSession: {
    getControlHandle: vi.fn(async () => hoisted.handle.current)
  }
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/auth/claude-oauth', () => ({
  ClaudeLoginFlow: vi.fn(function (this: unknown, opts: { accountDir: string; loopback: boolean }) {
    let settle!: { resolve: (v: unknown) => void; reject: (e: Error) => void }
    const outcome = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    const done = outcome.then(
      () => undefined,
      () => undefined
    )
    const loopback = opts.loopback
    const flow = {
      opts,
      done,
      start: vi.fn(async () => ({
        manualUrl: 'https://claude.com/cai/oauth/authorize?state=in-app-state',
        ...(loopback ? { automaticUrl: 'https://claude.com/cai/oauth/authorize?auto=1' } : {})
      })),
      waitForCompletion: vi.fn(() => outcome),
      submitCode: vi.fn(() => {
        settle.resolve({
          account: {
            email: 'multi@example.com',
            organization: 'Org',
            subscriptionType: 'Claude Max',
            tokenSource: null,
            apiKeySource: null,
            apiProvider: 'firstParty'
          }
        })
        return outcome
      }),
      cancel: vi.fn((reason = 'Login cancelled') => settle.reject(new Error(reason)))
    }
    hoisted.flows.push(flow)
    return flow
  })
}))

import {
  ACCOUNT_CHANGED_DURING_SIGN_IN,
  InAppLoginBackend,
  openLoginBackend
} from '../claude-login-backend'
import { authManager } from '../auth-manager'
import { serviceSession } from '../../../core/services/service-session'
import { setSecurestorageEnv } from '../../../core/sdk/securestorage-env'
import type { AuthFlowState } from '../../../shared/types'

const DIR = '/accounts/active-id'

function cliHandle(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    claudeAuthenticate: vi.fn(async () => ({
      manualUrl: 'https://claude.ai/oauth?state=s',
      automaticUrl: 'https://claude.ai/oauth/auto'
    })),
    claudeOAuthWaitForCompletion: vi.fn(() => new Promise(() => {})),
    claudeOAuthCallback: vi.fn()
  }
}

function makeWindow(): { isDestroyed: () => boolean; webContents: { send: () => void } } {
  return { isDestroyed: () => false, webContents: { send: () => {} } }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.flows.length = 0
  hoisted.handle.current = cliHandle()
})
afterEach(async () => {
  await authManager.cancelSignIn()
  setSecurestorageEnv(null)
})

describe('openLoginBackend — the selector', () => {
  it('single-account (no account dir) → cli.js, through the service session', async () => {
    const backend = await openLoginBackend()
    expect(backend?.kind).toBe('cli')
    expect(serviceSession.getControlHandle).toHaveBeenCalledTimes(1)
  })

  it('single-account with no service session → null (the "could not start" path)', async () => {
    hoisted.handle.current = null
    expect(await openLoginBackend()).toBeNull()
  })

  it('multi-account → in-app, on the ACTIVE dir, without touching cli.js', async () => {
    setSecurestorageEnv({ dir: DIR })
    const backend = await openLoginBackend()
    expect(backend?.kind).toBe('in-app')
    expect((backend as InAppLoginBackend).accountDir).toBe(DIR)
    expect(serviceSession.getControlHandle).not.toHaveBeenCalled()
  })
})

describe('InAppLoginBackend', () => {
  it('a remote sign-in binds no loopback; a desktop one does', async () => {
    await new InAppLoginBackend(DIR).authenticate({ remote: true })
    await new InAppLoginBackend(DIR).authenticate({ remote: false })
    expect(hoisted.flows.map((f) => f.opts)).toEqual([
      { accountDir: DIR, loopback: false },
      { accountDir: DIR, loopback: true }
    ])
  })

  it('the flow ends when the active account dir moves away from it', async () => {
    setSecurestorageEnv({ dir: DIR })
    const backend = new InAppLoginBackend(DIR)
    await backend.authenticate({ remote: true })
    setSecurestorageEnv({ dir: '/accounts/other' })
    expect(hoisted.flows[0].cancel).toHaveBeenCalledWith(ACCOUNT_CHANGED_DURING_SIGN_IN)
  })
})

describe('AuthManager on the in-app backend', () => {
  it('multi-account: signIn + paste complete in-app and never reach cli.js', async () => {
    setSecurestorageEnv({ dir: DIR })
    authManager.setWindow(makeWindow() as never)
    const shim = await import('../../../test/stubs/electron-shim')
    const open = vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    const started = await authManager.signIn()
    expect(started.status).toBe('authorizing')
    expect(open).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?auto=1')
    const [flow] = hoisted.flows
    expect(flow.opts).toEqual({ accountDir: DIR, loopback: true })
    // Desktop: the loopback wait is armed on the in-app flow.
    expect(flow.waitForCompletion).toHaveBeenCalledTimes(1)

    const done = (await authManager.submitOAuthCode('CODE#in-app-state')) as AuthFlowState
    expect(flow.submitCode).toHaveBeenCalledWith('CODE', 'in-app-state')
    expect(done.status).toBe('success')
    expect(done.account?.email).toBe('multi@example.com')
    expect(serviceSession.getControlHandle).not.toHaveBeenCalled()
  })

  it('multi-account remote: manualUrl returned, no host browser, no wait armed', async () => {
    setSecurestorageEnv({ dir: DIR })
    authManager.setWindow(makeWindow() as never)
    const shim = await import('../../../test/stubs/electron-shim')
    const open = vi.spyOn(shim.shell, 'openExternal').mockResolvedValue(undefined)

    const started = await authManager.signIn({ remote: true })

    expect(started.manualUrl).toBe('https://claude.com/cai/oauth/authorize?state=in-app-state')
    expect(open).not.toHaveBeenCalled()
    expect(hoisted.flows[0].opts.loopback).toBe(false)
    expect(hoisted.flows[0].waitForCompletion).not.toHaveBeenCalled()
  })

  it('cancelSignIn cancels the in-app flow', async () => {
    setSecurestorageEnv({ dir: DIR })
    authManager.setWindow(makeWindow() as never)
    await authManager.signIn({ remote: true })
    await authManager.cancelSignIn()
    expect(hoisted.flows[0].cancel).toHaveBeenCalled()
  })

  it('a second signIn supersedes the first in-app flow', async () => {
    setSecurestorageEnv({ dir: DIR })
    authManager.setWindow(makeWindow() as never)
    await authManager.signIn({ remote: true })
    await authManager.signIn({ remote: true })
    expect(hoisted.flows[0].cancel).toHaveBeenCalled()
    expect(hoisted.flows[1].cancel).not.toHaveBeenCalled()
  })

  it('single-account: signIn still drives cli.js (claude_authenticate)', async () => {
    authManager.setWindow(makeWindow() as never)
    const handle = hoisted.handle.current as ReturnType<typeof cliHandle>
    await authManager.signIn({ remote: true })
    expect(handle.claudeAuthenticate).toHaveBeenCalledWith(true)
    expect(hoisted.flows).toHaveLength(0)
  })
})
