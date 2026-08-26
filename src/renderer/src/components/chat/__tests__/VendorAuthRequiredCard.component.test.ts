/**
 * Component tests for VendorAuthRequiredCard (Feature #2 — structured 401 re-login card).
 *
 * Two layers:
 *   1. Store-level: card visibility conditions + authorizeVendorOAuth integration.
 *   2. Real React render: drives the actual component — Re-authenticate →
 *      authorizeVendorOAuth → post-success Retry button renders (REQUIRED 2: a
 *      premature `clearVendorAuthRequired` on success unmounts the card before
 *      Retry can show, so this render test guards against that regression).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { VendorAuthRequiredCard } from '../VendorAuthRequiredCard'
import { makeUserMessage } from '@test/factories/messages'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ROUTING_ID = 'test-routing-1'

beforeEach(() => {
  // Reset relevant state
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    vendorOAuth: null
  })
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    vendorAuthProbe: vi.fn().mockResolvedValue({}),
    vendorAuthListOptions: vi.fn().mockResolvedValue({}),
    vendorAuthOauthAuthorize: vi.fn(),
    vendorAuthOauthCallback: vi.fn()
  }
  ;(globalThis as any).window.open = vi.fn()
})

describe('VendorAuthRequiredCard — visibility conditions', () => {
  it('shows card when active session has vendorAuthRequired', () => {
    // Create a session and set vendorAuthRequired
    useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTING_ID })
    useSessionStore.getState().setVendorAuthRequired(ROUTING_ID, {
      vendorId: 'openai',
      message: 'Token expired'
    })

    const { sessions } = useSessionStore.getState()
    expect(sessions[ROUTING_ID]?.vendorAuthRequired).toEqual({
      vendorId: 'openai',
      message: 'Token expired'
    })
  })

  it('no card when session has no vendorAuthRequired', () => {
    useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTING_ID })

    const { sessions } = useSessionStore.getState()
    expect(sessions[ROUTING_ID]?.vendorAuthRequired).toBeNull()
  })

  it('clearVendorAuthRequired nulls the per-session field', () => {
    useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTING_ID })
    useSessionStore.getState().setVendorAuthRequired(ROUTING_ID, {
      vendorId: 'anthropic',
      message: 'Auth expired'
    })

    // Verify it's set
    expect(useSessionStore.getState().sessions[ROUTING_ID]?.vendorAuthRequired).not.toBeNull()

    // Clear it
    useSessionStore.getState().clearVendorAuthRequired(ROUTING_ID)
    expect(useSessionStore.getState().sessions[ROUTING_ID]?.vendorAuthRequired).toBeNull()
  })
})

describe('VendorAuthRequiredCard — authorizeVendorOAuth integration', () => {
  it('authorizeVendorOAuth: auto flow → vendorOAuth set to waiting then cleared on success', async () => {
    // Mock the API to simulate auto OAuth flow
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in with OpenAI' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser to authorize'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).window.api.vendorAuthProbe = vi.fn().mockResolvedValue({
      openai: { authState: 'authenticated', billingType: 'api' }
    })

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    expect(result.ok).toBe(true)
    expect(result.needsPaste).toBeUndefined()
    // vendorOAuth should be null after success
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
    // window.open should have been called
    expect((globalThis as any).window.open).toHaveBeenCalledWith(
      'https://openai.com/auth',
      '_blank'
    )
    // callback was called without a code
    const callbackMock = (globalThis as any).window.api.vendorAuthOauthCallback as ReturnType<
      typeof vi.fn
    >
    expect(callbackMock).toHaveBeenCalledWith('opencode', 'openai', 0)
  })

  it('authorizeVendorOAuth: code flow → returns needsPaste, no callback awaited', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      github: [{ type: 'oauth', label: 'Sign in with GitHub' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://github.com/auth',
      method: 'code',
      instructions: 'Paste the code below'
    })

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'github')

    expect(result.ok).toBe(false)
    expect(result.needsPaste).toBeDefined()
    expect(result.needsPaste?.url).toBe('https://github.com/auth')
    // callback should NOT have been called
    const callbackMock = (globalThis as any).window.api.vendorAuthOauthCallback as ReturnType<
      typeof vi.fn
    >
    expect(callbackMock).not.toHaveBeenCalled()
  })

  it('authorizeVendorOAuth: auto callback failure → ok:false + stage:error', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Instructions'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi
      .fn()
      .mockRejectedValue(new Error('network error'))

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    expect(result.ok).toBe(false)
    // vendorOAuth should show error state
    const { vendorOAuth } = useSessionStore.getState()
    expect(vendorOAuth?.stage).toBe('error')
    expect(vendorOAuth?.vendorId).toBe('openai')
  })

  it('authorizeVendorOAuth: no OAuth option for vendor → ok:false immediately', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'api', label: 'API Key' }] // only api, no oauth
    })

    const result = await useSessionStore.getState().authorizeVendorOAuth('opencode', 'openai')

    expect(result.ok).toBe(false)
    expect(result.needsPaste).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real React render — drives the actual component DOM (REQUIRED 2).
// ---------------------------------------------------------------------------

describe('VendorAuthRequiredCard — rendered component', () => {
  afterEach(() => cleanup())

  function renderCard(): ReturnType<typeof render> {
    return render(React.createElement(VendorAuthRequiredCard))
  }

  function seedSession(): void {
    useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTING_ID })
    // Give the session an opencode engine + a prior user prompt (for Retry).
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [ROUTING_ID]: {
          ...s.sessions[ROUTING_ID],
          status: { ...s.sessions[ROUTING_ID].status, engineId: 'opencode' },
          messages: [makeUserMessage('do the thing')]
        }
      }
    }))
    useSessionStore.getState().setVendorAuthRequired(ROUTING_ID, {
      vendorId: 'openai',
      message: 'Token expired'
    })
  }

  it('renders nothing when the active session has no vendorAuthRequired', () => {
    useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTING_ID })
    const { container } = renderCard()
    expect(container.textContent).toBe('')
  })

  it('renders the card (vendor + message + Re-authenticate) when vendorAuthRequired is set', () => {
    seedSession()
    const { getByText } = renderCard()
    expect(getByText('openai')).toBeTruthy()
    expect(getByText('Token expired')).toBeTruthy()
    expect(getByText('Re-authenticate')).toBeTruthy()
  })

  it('Re-authenticate → on success the card STAYS mounted and shows Retry (REQUIRED 2 guard)', async () => {
    // Auto flow that succeeds.
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(true)

    seedSession()
    const { getByText, queryByText } = renderCard()

    await act(async () => {
      fireEvent.click(getByText('Re-authenticate'))
      // flush the awaited authorize → callback chain
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The card must NOT have unmounted: success copy + Retry are present.
    expect(queryByText('Re-authenticated.')).toBeTruthy()
    expect(queryByText('Retry')).toBeTruthy()
    // vendorAuthRequired is intentionally still set (cleared only on Dismiss/Retry).
    expect(useSessionStore.getState().sessions[ROUTING_ID]?.vendorAuthRequired).not.toBeNull()
  })

  it('Retry → re-sends the last user prompt and clears vendorAuthRequired', async () => {
    ;(globalThis as any).window.api.vendorAuthListOptions = vi.fn().mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Sign in' }]
    })
    ;(globalThis as any).window.api.vendorAuthOauthAuthorize = vi.fn().mockResolvedValue({
      url: 'https://openai.com/auth',
      method: 'auto',
      instructions: 'Open browser'
    })
    ;(globalThis as any).window.api.vendorAuthOauthCallback = vi.fn().mockResolvedValue(true)
    const createSession = vi.fn().mockResolvedValue(undefined)
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window.api.createSession = createSession
    ;(globalThis as any).window.api.sendPrompt = sendPrompt

    seedSession()
    const { getByText } = renderCard()

    await act(async () => {
      fireEvent.click(getByText('Re-authenticate'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.click(getByText('Retry'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // retrySend respawns (createSession) then re-sends the captured prompt.
    expect(createSession).toHaveBeenCalled()
    expect(sendPrompt).toHaveBeenCalledWith(ROUTING_ID, 'do the thing')
    // vendorAuthRequired cleared on Retry.
    expect(useSessionStore.getState().sessions[ROUTING_ID]?.vendorAuthRequired).toBeNull()
  })

  it('Dismiss → clears vendorAuthRequired and unmounts the card', () => {
    seedSession()
    const { getByText, container } = renderCard()
    fireEvent.click(getByText('✕'))
    expect(useSessionStore.getState().sessions[ROUTING_ID]?.vendorAuthRequired).toBeNull()
    expect(container.textContent).toBe('')
  })
})
