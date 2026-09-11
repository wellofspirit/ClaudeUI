import { describe, expect, it, vi } from 'vitest'
import { CodexAuthProvider } from '../../auth/CodexAuthProvider'
import type { CodexService } from '../CodexService'

vi.mock('../codex-locate', () => ({ codexBinaryAvailable: () => true }))

describe('native auth provider', () => {
  it('only exposes safe account metadata; status does not start login', async () => {
    const service = {
      accountStatus: vi.fn(async () => ({
        available: true,
        authenticated: true,
        authKind: 'chatgpt',
        token: 'synthetic-do-not-forward'
      })),
      modelOptions: vi.fn(async () => ({ catalog: [] })),
      startLogin: vi.fn()
    }
    const provider = new CodexAuthProvider(service as unknown as CodexService)
    expect(await provider.status()).toEqual({
      available: true,
      authenticated: true,
      authKind: 'chatgpt',
      modelCount: 0
    })
    expect(await provider.probe()).toMatchObject({
      openai: { authState: 'authenticated', billingType: 'subscription' }
    })
    expect(service.startLogin).not.toHaveBeenCalled()
  })
  it('uses an explicit retained device flow and drops URL/code after completion', async () => {
    let complete!: (value: { status: 'completed' }) => void
    const service = {
      startLogin: vi.fn(() => ({
        started: Promise.resolve({
          type: 'chatgptDeviceCode',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'FIXTURE',
          loginId: 'native'
        }),
        completed: new Promise((resolve) => {
          complete = resolve
        }),
        cancel: vi.fn()
      }))
    }
    const provider = new CodexAuthProvider(service as unknown as CodexService)
    expect(provider.loginStatus()).toEqual({ status: 'idle' })
    expect(await provider.loginStart()).toEqual({
      status: 'waiting',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'FIXTURE'
    })
    expect(service.startLogin).toHaveBeenCalledExactlyOnceWith({ type: 'chatgptDeviceCode' })
    await expect(provider.loginStart()).rejects.toThrow('already pending')
    complete({ status: 'completed' })
    await Promise.resolve()
    expect(provider.loginStatus()).toEqual({ status: 'completed' })
  })
})
