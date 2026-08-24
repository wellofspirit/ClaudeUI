/**
 * The store half of ADR-057's remote vendor sign-in (S4-UI).
 *
 * `authorizeVendorOAuth` has ONE new fork, and it is the platform: a remote
 * client can neither be sent to a page by the host nor reach the host's
 * loopback, so BOTH vendor methods become the two-step paste-back and the flow
 * parks at `stage: 'paste'`. The desktop path — `window.open` + the long-lived
 * `auto` callback await — must be byte-identical, which is what
 * `authorizeVendorOAuth.component.test.ts` next door still pins.
 *
 * The other half is `submitVendorOAuthCode`: post the pasted string verbatim,
 * once, and drop to a TERMINAL `error` stage on failure — the host's login flow
 * tears itself down on any failed completion, so leaving the paste field up
 * would invite the user to retype into a flow that can no longer accept it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'

vi.mock('electron', async () => await import('../../../../test/stubs/electron-shim'))

const OAUTH_OPTIONS = { openai: [{ type: 'oauth', label: 'Sign in' }] }

function stubApi(platform: string, overrides: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    vendorAuthListOptions: vi.fn(async () => OAUTH_OPTIONS),
    vendorAuthOauthAuthorize: vi.fn(async () => ({
      url: 'https://auth.example/authorize?state=s',
      method: 'auto',
      instructions: 'Complete sign-in in the browser window that just opened.'
    })),
    vendorAuthOauthCallback: vi.fn(async () => true),
    vendorAuthOauthCancel: vi.fn(async () => {}),
    ...overrides
  }
}

beforeEach(() => {
  useSessionStore.setState({ vendorOAuth: null, vendorAuth: null })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
})

describe('authorizeVendorOAuth on web — the paste-back fork', () => {
  it('parks the flow at stage "paste" with the url + method, and does NOT open a window', async () => {
    stubApi('web')
    const result = await useSessionStore.getState().authorizeVendorOAuth('pi', 'openai')

    // The open is the flow component's job, from a real user gesture — a
    // post-await window.open is blocked by every mobile browser.
    expect(window.open).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.needsPaste).toEqual({
      url: 'https://auth.example/authorize?state=s',
      method: 0,
      instructions: 'Complete sign-in in the browser window that just opened.'
    })
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      engineId: 'pi',
      vendorId: 'openai',
      stage: 'paste',
      url: 'https://auth.example/authorize?state=s',
      method: 0
    })
  })

  it('never enters the host-loopback wait, even for the `auto` method', async () => {
    stubApi('web')
    await useSessionStore.getState().authorizeVendorOAuth('pi', 'openai')
    expect(window.api.vendorAuthOauthCallback).not.toHaveBeenCalled()
  })

  it('records an authorize refusal verbatim as a terminal error (the desktop-only outcome)', async () => {
    const refusal =
      "opencode's automatic browser sign-in only completes on the host machine. " +
      "Choose the 'paste a code' method, or sign in from the desktop app."
    stubApi('web', {
      vendorAuthOauthAuthorize: vi.fn(async () => {
        throw new Error(refusal)
      })
    })
    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')
    expect(result).toEqual({ ok: false, error: refusal })
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      stage: 'error',
      error: refusal
    })
  })
})

describe('authorizeVendorOAuth on desktop — unchanged (platform pin)', () => {
  it('still opens the host browser and awaits the loopback for `auto`', async () => {
    stubApi('darwin')
    const result = await useSessionStore.getState().authorizeVendorOAuth('pi', 'openai')
    expect(window.open).toHaveBeenCalledWith('https://auth.example/authorize?state=s', '_blank')
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith('pi', 'openai', 0)
    expect(result.ok).toBe(true)
    // No paste stage is ever reachable from a desktop caller.
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })

  it('leaves an authorize refusal off the store (desktop surfaces have no outcome row)', async () => {
    stubApi('darwin', {
      vendorAuthOauthAuthorize: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')
    expect(result).toEqual({ ok: false, error: 'boom' })
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })
})

describe('submitVendorOAuthCode', () => {
  beforeEach(async () => {
    stubApi('web')
    await useSessionStore.getState().authorizeVendorOAuth('pi', 'openai')
    ;(window.api.vendorAuthOauthCallback as ReturnType<typeof vi.fn>).mockClear()
  })

  it('posts the pasted string VERBATIM against the parked method, exactly once', async () => {
    const pasted = 'http://localhost:1455/auth/callback?code=abc&state=xyz'
    const result = await useSessionStore.getState().submitVendorOAuthCode(pasted)
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledTimes(1)
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith('pi', 'openai', 0, pasted)
    expect(result).toEqual({ ok: true })
    // Success clears the flow — the surfaces unmount it and re-probe.
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })

  it('a rejected paste is TERMINAL: stage error with the backend text, no paste field left', async () => {
    ;(window.api.vendorAuthOauthCallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Invalid state - potential CSRF attack')
    )
    const result = await useSessionStore.getState().submitVendorOAuthCode('bad')
    expect(result).toEqual({ ok: false, error: 'Invalid state - potential CSRF attack' })
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      stage: 'error',
      error: 'Invalid state - potential CSRF attack'
    })
  })

  it('a `false` return is a rejection too, with a start-again message', async () => {
    ;(window.api.vendorAuthOauthCallback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    const result = await useSessionStore.getState().submitVendorOAuthCode('nope')
    expect(result.ok).toBe(false)
    expect(useSessionStore.getState().vendorOAuth?.stage).toBe('error')
  })

  it('refuses when no flow is parked, rather than inventing one', async () => {
    useSessionStore.setState({ vendorOAuth: null })
    const result = await useSessionStore.getState().submitVendorOAuthCode('anything')
    expect(result.ok).toBe(false)
    expect(window.api.vendorAuthOauthCallback).not.toHaveBeenCalled()
  })
})
