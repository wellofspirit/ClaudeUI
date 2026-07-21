/**
 * Unit tests for PiVendors (Settings › pi › Vendor, M3 + M6c Connect-ChatGPT UI).
 *
 * Mocks window.api directly (mirrors opencode-providers.unit.test.tsx's
 * convention) — no real IPC, no real ~/.pi/agent/auth.json touched.
 *
 * M6c's CodexConnect block uses the REAL `useSessionStore` (its
 * `authorizeVendorOAuth`/`cancelVendorOAuth` actions are engine-neutral —
 * see authorizeVendorOAuth.component.test.ts) — reset `vendorOAuth` to null
 * in beforeEach so tests don't leak flow state across each other, and stub
 * `window.open` (jsdom throws "not implemented" otherwise).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { PiVendors } from '../PiVendors'
import { useSessionStore } from '../../../stores/session-store'
import type { PiAuthStatus, VendorAuthMap, VendorAuthOption } from '../../../../../shared/types'

let probeMap: VendorAuthMap = {}
let optionsMap: Record<string, VendorAuthOption[]> = {}
let codexStatus: PiAuthStatus = { connected: false, needsReauth: false }

const vendorAuthProbe = vi.fn(async () => structuredClone(probeMap))
const vendorAuthListOptions = vi.fn(async () => structuredClone(optionsMap))
const vendorAuthSetKey = vi.fn(async (_engineId: string, vendorId: string, _key: string) => {
  probeMap = { ...probeMap, [vendorId]: { authState: 'authenticated', billingType: 'apiKey', label: 'API key' } }
})
const vendorAuthRemove = vi.fn(async (_engineId: string, vendorId: string) => {
  const next = { ...probeMap }
  delete next[vendorId]
  probeMap = next
  if (vendorId === 'openai-codex') codexStatus = { connected: false, needsReauth: false }
})
const engineIsInstalled = vi.fn(async () => true)
const getPiBinaryPath = vi.fn(async () => '/fake/vendor/pi-cli/pi')
const getPiAuthStatus = vi.fn(async () => structuredClone(codexStatus))
const vendorAuthOauthAuthorize = vi.fn(async () => ({
  url: 'https://auth.openai.com/oauth/authorize?x=1',
  method: 'auto' as const,
  instructions: 'Complete sign-in to ChatGPT in the browser window that just opened.'
}))
const vendorAuthOauthCallback = vi.fn(async () => {
  codexStatus = { connected: true, email: 'user@example.com', needsReauth: false }
  return true
})
const vendorAuthOauthCancel = vi.fn(async () => undefined)

function installApiStub(): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    vendorAuthProbe,
    vendorAuthListOptions,
    vendorAuthSetKey,
    vendorAuthRemove,
    engineIsInstalled,
    getPiBinaryPath,
    getPiAuthStatus,
    vendorAuthOauthAuthorize,
    vendorAuthOauthCallback,
    vendorAuthOauthCancel
  }
}

describe('PiVendors', () => {
  beforeEach(() => {
    probeMap = {}
    optionsMap = {
      anthropic: [{ type: 'api', label: 'API key' }, { type: 'oauth', label: 'Subscription (run pi /login in a terminal)' }],
      openai: [{ type: 'api', label: 'API key' }],
      'openai-codex': [{ type: 'oauth', label: 'Subscription (run pi /login in a terminal)' }]
    }
    codexStatus = { connected: false, needsReauth: false }
    vendorAuthProbe.mockClear()
    vendorAuthListOptions.mockClear()
    vendorAuthSetKey.mockClear()
    vendorAuthRemove.mockClear()
    engineIsInstalled.mockClear()
    getPiBinaryPath.mockClear()
    getPiAuthStatus.mockClear()
    vendorAuthOauthAuthorize.mockClear()
    vendorAuthOauthCallback.mockClear()
    vendorAuthOauthCancel.mockClear()
    installApiStub()
    useSessionStore.setState({ vendorOAuth: null })
    ;(globalThis as any).window.open = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a not-installed message when pi is not installed', async () => {
    engineIsInstalled.mockResolvedValueOnce(false)
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors')).toHaveTextContent('pi is not installed')
    })
  })

  it('lists configured vendors from probe() with their auth label', async () => {
    probeMap = { anthropic: { authState: 'authenticated', billingType: 'subscription', label: 'OAuth' } }
    render(<PiVendors />)
    await waitFor(() => {
      const row = screen.getByTestId('PiVendors.row')
      expect(row).toHaveAttribute('data-id', 'anthropic')
      expect(row).toHaveTextContent('OAuth')
    })
  })

  it('shows the expired-oauth label distinctly (still authenticated)', async () => {
    // Uses a non-codex vendor (anthropic) deliberately: openai-codex is now
    // EXCLUDED from this generic probe()-driven row (M6c) — it gets its own
    // dedicated CodexConnect block instead, covered by the M6c tests below.
    probeMap = {
      anthropic: {
        authState: 'authenticated',
        billingType: 'subscription',
        label: 'OAuth (expired — refreshes on use)'
      }
    }
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.row')).toHaveTextContent('OAuth (expired')
    })
  })

  it('renders no configured-provider rows when probe() is empty', async () => {
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('PiVendors.row')).not.toBeInTheDocument()
  })

  it('offers only providers with an api option, not yet configured, in the add-key select', async () => {
    probeMap = { anthropic: { authState: 'authenticated', billingType: 'apiKey', label: 'API key' } }
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.addVendorSelect'))
    const select = screen.getByTestId('PiVendors.addVendorSelect') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    // anthropic is already configured -> excluded; openai-codex has no 'api'
    // option (oauth-only) -> excluded; openai has an api option and is
    // unconfigured -> included.
    expect(optionValues).toContain('openai')
    expect(optionValues).not.toContain('anthropic')
    expect(optionValues).not.toContain('openai-codex')
  })

  it('add-key flow calls vendorAuthSetKey with the selected vendor + typed key and reloads', async () => {
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.addVendorSelect'))

    fireEvent.change(screen.getByTestId('PiVendors.addVendorSelect'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByTestId('PiVendors.addKeyInput'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByTestId('PiVendors.addKey'))

    await waitFor(() => {
      expect(vendorAuthSetKey).toHaveBeenCalledWith('pi', 'openai', 'sk-test-123')
    })
    // Reload after a successful add — probe() called again beyond the initial mount fetch.
    await waitFor(() => {
      expect(vendorAuthProbe.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('remove action calls vendorAuthRemove for that vendor', async () => {
    probeMap = { anthropic: { authState: 'authenticated', billingType: 'subscription', label: 'OAuth' } }
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.remove'))
    fireEvent.click(screen.getByTestId('PiVendors.remove'))
    await waitFor(() => {
      expect(vendorAuthRemove).toHaveBeenCalledWith('pi', 'anthropic')
    })
  })

  it('renders the subscription hint with the resolved pi binary path', async () => {
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.subscriptionCommand')).toHaveTextContent('/fake/vendor/pi-cli/pi')
    })
    expect(screen.getByTestId('PiVendors.subscriptionHint')).toHaveTextContent('run /login in a terminal')
  })

  it('setKey rejection surfaces the error message and does not clear the form', async () => {
    vendorAuthSetKey.mockRejectedValueOnce(new Error('failed to write auth.json'))
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.addVendorSelect'))

    fireEvent.change(screen.getByTestId('PiVendors.addVendorSelect'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByTestId('PiVendors.addKeyInput'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByTestId('PiVendors.addKey'))

    await waitFor(() => {
      expect(screen.getByTestId('PiVendors')).toHaveTextContent('failed to write auth.json')
    })
    // Reload does NOT run on failure — probe() was only called once (initial mount).
    expect(vendorAuthProbe.mock.calls.length).toBe(1)
  })

  it('setKey rejection with a non-Error throw falls back to a generic message', async () => {
    vendorAuthSetKey.mockRejectedValueOnce('not an Error instance')
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.addVendorSelect'))

    fireEvent.change(screen.getByTestId('PiVendors.addVendorSelect'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByTestId('PiVendors.addKeyInput'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByTestId('PiVendors.addKey'))

    await waitFor(() => {
      expect(screen.getByTestId('PiVendors')).toHaveTextContent('Failed to save key for openai')
    })
  })

  it('binaryPath null: subscription hint renders without the copyable command block', async () => {
    getPiBinaryPath.mockResolvedValueOnce(null as unknown as string)
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.subscriptionHint')).toHaveTextContent('run /login in a terminal')
    })
    expect(screen.queryByTestId('PiVendors.subscriptionCommand')).not.toBeInTheDocument()
    expect(screen.queryByTestId('PiVendors.copyCommand')).not.toBeInTheDocument()
  })

  it('getPiBinaryPath rejection: subscription hint renders without the copyable command block', async () => {
    getPiBinaryPath.mockRejectedValueOnce(new Error('not found'))
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.subscriptionHint')).toHaveTextContent('run /login in a terminal')
    })
    expect(screen.queryByTestId('PiVendors.subscriptionCommand')).not.toBeInTheDocument()
  })

  // ── M6c: Connect ChatGPT (openai-codex) ──────────────────────────────

  it('fetches Codex auth status via getPiAuthStatus on mount', async () => {
    render(<PiVendors />)
    await waitFor(() => {
      expect(getPiAuthStatus).toHaveBeenCalled()
    })
  })

  it('not connected: renders the Connect button; clicking it drives authorizeVendorOAuth(pi, openai-codex)', async () => {
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.connectCodex'))
    expect(screen.queryByTestId('PiVendors.codexConnected')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('PiVendors.connectCodex'))

    await waitFor(() => {
      expect(vendorAuthListOptions).toHaveBeenCalledWith('pi')
    })
    await waitFor(() => {
      expect(vendorAuthOauthAuthorize).toHaveBeenCalledWith('pi', 'openai-codex', 0)
    })
    expect((globalThis as any).window.open).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/authorize?x=1',
      '_blank'
    )
    await waitFor(() => {
      expect(vendorAuthOauthCallback).toHaveBeenCalledWith('pi', 'openai-codex', 0)
    })
    // On success the flow re-fetches status — the connected block should appear.
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.codexConnected')).toHaveTextContent('user@example.com')
    })
  })

  it('connected: shows "Connected as <email>" and a disconnect action instead of the Connect button', async () => {
    codexStatus = { connected: true, email: 'user@example.com', needsReauth: false }
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.codexConnected')).toHaveTextContent('user@example.com')
    })
    expect(screen.queryByTestId('PiVendors.connectCodex')).not.toBeInTheDocument()
    expect(screen.getByTestId('PiVendors.disconnectCodex')).toBeInTheDocument()
  })

  it('connected without email: falls back to accountId in the connected label', async () => {
    codexStatus = { connected: true, accountId: 'acct-123', needsReauth: false }
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.codexConnected')).toHaveTextContent('acct-123')
    })
  })

  it('needsReauth: renders a warning banner with a reconnect action', async () => {
    codexStatus = { connected: true, accountId: 'acct-123', needsReauth: true }
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.codexNeedsReauth')).toHaveTextContent('reconnect')
    })
    // The connected block still shows (credential exists, just stale) alongside the banner.
    expect(screen.getByTestId('PiVendors.codexConnected')).toBeInTheDocument()
    // The reconnect action reuses the connect testid/action (only one renders at a time).
    expect(screen.getByTestId('PiVendors.connectCodex')).toBeInTheDocument()
  })

  it('disconnect calls vendorAuthRemove(pi, openai-codex) and returns to the not-connected state', async () => {
    codexStatus = { connected: true, email: 'user@example.com', needsReauth: false }
    render(<PiVendors />)
    await waitFor(() => screen.getByTestId('PiVendors.disconnectCodex'))

    fireEvent.click(screen.getByTestId('PiVendors.disconnectCodex'))

    await waitFor(() => {
      expect(vendorAuthRemove).toHaveBeenCalledWith('pi', 'openai-codex')
    })
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.connectCodex')).toBeInTheDocument()
    })
  })

  it('does not double-list openai-codex as a generic configured-provider row', async () => {
    probeMap = { 'openai-codex': { authState: 'authenticated', billingType: 'subscription', label: 'OAuth' } }
    codexStatus = { connected: true, email: 'user@example.com', needsReauth: false }
    render(<PiVendors />)
    await waitFor(() => {
      expect(screen.getByTestId('PiVendors.codexConnected')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('PiVendors.row')).not.toBeInTheDocument()
  })
})
