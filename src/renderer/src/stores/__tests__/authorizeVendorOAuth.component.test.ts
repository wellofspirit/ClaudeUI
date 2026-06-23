/**
 * Store action tests for authorizeVendorOAuth (Feature #7 — native auto OAuth drive).
 *
 * Tests:
 *   - method:'auto' → window.open called, vendorAuthOauthCallback invoked without code,
 *     success → vendorOAuth cleared + {ok:true}; the global vendorAuth map is NOT
 *     clobbered (it's Claude/anthropic-specific — REQUIRED 1)
 *   - method:'code' → returns {ok:false, needsPaste:{...}}, no callback awaited
 *   - callback rejects → {ok:false} + stage:'error' in vendorOAuth
 *   - cancel-then-late-resolve → no state change (SHOULD-FIX 4 flow guard)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'

vi.mock('electron', async () => await import('../../../../test/stubs/electron-shim'))

beforeEach(() => {
  // Reset relevant store slices
  useSessionStore.setState({ vendorOAuth: null, vendorAuth: null })
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.open = vi.fn()
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    vendorAuthListOptions: vi.fn(),
    vendorAuthOauthAuthorize: vi.fn(),
    vendorAuthOauthCallback: vi.fn(),
    vendorAuthProbe: vi.fn().mockResolvedValue({}),
  }
})

describe('authorizeVendorOAuth — auto flow (method: "auto")', () => {
  it('calls window.open, awaits callback without code, clears vendorOAuth on success', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in with OpenAI' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/authorize',
      method: 'auto',
      instructions: 'Follow the browser flow'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(true)

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    // Result should be ok
    expect(result.ok).toBe(true)
    expect(result.needsPaste).toBeUndefined()

    // window.open was called with the OAuth URL
    expect((globalThis as any).window.open).toHaveBeenCalledWith(
      'https://openai.com/authorize',
      '_blank'
    )

    // vendorAuthOauthCallback was called WITHOUT a code arg (auto flow)
    const callbackMock = (globalThis as any).window.api.vendorAuthOauthCallback as ReturnType<typeof vi.fn>
    expect(callbackMock).toHaveBeenCalledTimes(1)
    // Should be called with (engineId, vendorId, methodIdx) — no code
    expect(callbackMock).toHaveBeenCalledWith('opencode', 'openai', 0)

    // vendorOAuth was cleared after success
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })

  it('does NOT write opencode probe into the global vendorAuth map (Claude-specific) — REQUIRED 1', async () => {
    // Pre-seed vendorAuth with Claude's anthropic entry; the opencode flow must
    // leave it untouched (AuthBanner reads vendorAuth.anthropic).
    const claudeVendorAuth = {
      anthropic: { authState: 'authenticated' as const, billingType: 'subscription' as const }
    }
    useSessionStore.setState({ vendorAuth: claudeVendorAuth })

    const probeMock = vi.fn().mockResolvedValue({
      openai: { authState: 'authenticated' as const, billingType: 'apiKey' as const }
    })
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in with OpenAI' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/authorize',
      method: 'auto',
      instructions: 'Follow the browser flow'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).window.api.vendorAuthProbe = probeMock

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')
    expect(result.ok).toBe(true)

    // The global vendorAuth must be IDENTICAL — no opencode probe clobber.
    expect(useSessionStore.getState().vendorAuth).toEqual(claudeVendorAuth)
    // And we must not even call the global probe for the side effect.
    expect(probeMock).not.toHaveBeenCalled()
  })
})

describe('authorizeVendorOAuth — code flow (method: "code")', () => {
  it('returns needsPaste, does NOT call vendorAuthOauthCallback', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      github: [{ type: 'oauth', label: 'Sign in with GitHub' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://github.com/oauth',
      method: 'code',
      instructions: 'Paste the code below'
    })

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'github')

    expect(result.ok).toBe(false)
    expect(result.needsPaste).toEqual({
      url: 'https://github.com/oauth',
      method: 0,
      instructions: 'Paste the code below'
    })

    // Callback must NOT be called for code flow
    const callbackMock = (globalThis as any).window.api.vendorAuthOauthCallback as ReturnType<typeof vi.fn>
    expect(callbackMock).not.toHaveBeenCalled()

    // vendorOAuth stays null (code flow doesn't set waiting state)
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })
})

describe('authorizeVendorOAuth — callback failure', () => {
  it('callback rejects → {ok:false} + stage:"error" in vendorOAuth', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockRejectedValue(
      new Error('Connection refused')
    )

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    expect(result.ok).toBe(false)

    const { vendorOAuth } = useSessionStore.getState()
    expect(vendorOAuth).not.toBeNull()
    expect(vendorOAuth?.stage).toBe('error')
    expect(vendorOAuth?.vendorId).toBe('openai')
    expect(vendorOAuth?.engineId).toBe('opencode')
  })

  it('callback returns false → {ok:false} + stage:"error" in vendorOAuth', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(false)

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    expect(result.ok).toBe(false)

    const { vendorOAuth } = useSessionStore.getState()
    expect(vendorOAuth?.stage).toBe('error')
  })
})

describe('authorizeVendorOAuth — cancel-then-late-resolve (SHOULD-FIX 4)', () => {
  it('a callback that resolves AFTER cancelVendorOAuth() does not resurrect the card', async () => {
    // Defer the callback so we can cancel while it's still pending.
    let resolveCallback: (v: boolean) => void = () => {}
    const callbackPromise = new Promise<boolean>((res) => {
      resolveCallback = res
    })
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockReturnValue(callbackPromise)

    // Start the flow (don't await yet — the callback is pending).
    const flowPromise = useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    // Let authorize + the synchronous setVendorOAuth('waiting') run.
    await Promise.resolve()
    await Promise.resolve()
    expect(useSessionStore.getState().vendorOAuth?.stage).toBe('waiting')

    // User cancels — clears vendorOAuth and bumps the flow token.
    useSessionStore.getState().cancelVendorOAuth()
    expect(useSessionStore.getState().vendorOAuth).toBeNull()

    // The in-flight callback resolves LATE (success). The flow guard must bail.
    resolveCallback(true)
    const result = await flowPromise

    // No state resurrection: still null, and the late success is reported as not-ok.
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
    expect(result.ok).toBe(false)
  })

  it('a late-resolving callback that FAILS after cancel does not set stage:error', async () => {
    let rejectCallback: (e: unknown) => void = () => {}
    const callbackPromise = new Promise<boolean>((_res, rej) => {
      rejectCallback = rej
    })
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockReturnValue(callbackPromise)

    const flowPromise = useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')
    await Promise.resolve()
    await Promise.resolve()
    expect(useSessionStore.getState().vendorOAuth?.stage).toBe('waiting')

    useSessionStore.getState().cancelVendorOAuth()

    rejectCallback(new Error('timed out'))
    const result = await flowPromise

    // The error branch must also be guarded — no stale 'error' card.
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
    expect(result.ok).toBe(false)
  })
})
