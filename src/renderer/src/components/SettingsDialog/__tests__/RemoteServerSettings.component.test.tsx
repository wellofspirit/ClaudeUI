import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteServerSettings } from '../RemoteServerSettings'
import { selectMenuValue, selectMenuOptionLabels } from '../../../../../test/helpers/select-menu'
import type { RemoteConfig, NetworkInterfaceInfo } from '../../../../../shared/types'

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 0,
  tlsHttpsPort: 443,
  allowTerminal: false,
  // ADR-064: the remote-IDE toggle at its closed default.
  allowIde: false,
  ideCliPath: null,
  shellGrantIdleMinutes: 10,
  // ADR-052 policy fields: AUTO with nothing enrolled, i.e. the legacy stack.
  authPolicy: null,
  effectiveAuthPolicy: 'password',
  credentialCount: 0,
  passwordBreakGlass: true,
  // ADR-054 second axis, at its defaults (series 2 owns the tier UI).
  stepUpTier: 'medium',
  effectiveStepUpTier: 'medium',
  stepUpMutationIdleMinutes: 60,
  sessionMaxAgeHours: 4,
  auditRetentionDays: 365,
  passwordSet: false,
  passwordUpdatedAt: null
}

const interfaces: NetworkInterfaceInfo[] = [
  { name: 'Wi-Fi', address: '192.168.1.50', priority: 1 },
  { name: 'Ethernet', address: '10.0.0.5', priority: 2 }
]

const api = {
  getRemoteConfig: vi.fn(),
  setRemoteConfig: vi.fn(),
  setRemotePassword: vi.fn(),
  clearRemotePassword: vi.fn(),
  getNetworkInterfaces: vi.fn(),
  detectTailscale: vi.fn(),
  // Needed by the nested RemotePasskeySettings (ADR-052), which subscribes to
  // `remote:status` and reads the credential list. Its own behavior is covered
  // in RemotePasskeySettings.component.test.tsx; here they only have to exist.
  onRemoteStatus: vi.fn(() => () => {}),
  webauthnCredentials: vi.fn(async () => [])
}

describe('RemoteServerSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getRemoteConfig.mockResolvedValue(baseConfig)
    api.getNetworkInterfaces.mockResolvedValue(interfaces)
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  it('loads and renders the persisted config', async () => {
    api.getRemoteConfig.mockResolvedValue({
      ...baseConfig,
      port: 4568,
      bindHost: '10.0.0.5',
      autostart: true,
      passwordSet: true,
      passwordUpdatedAt: Date.now()
    })
    render(<RemoteServerSettings />)
    const root = await screen.findByTestId('RemoteServerSettings')
    expect(root).toBeInTheDocument()
    expect(screen.getByTestId('RemoteServerSettings.port')).toHaveValue('4568')
    expect(selectMenuValue(screen.getByTestId('RemoteServerSettings.bindHost'))).toBe('10.0.0.5')
  })

  it('shows a validation message for an out-of-range port and never calls setRemoteConfig', async () => {
    render(<RemoteServerSettings />)
    const portInput = await screen.findByTestId('RemoteServerSettings.port')
    fireEvent.change(portInput, { target: { value: '80' } })
    fireEvent.blur(portInput)
    await screen.findByTestId('RemoteServerSettings.portError')
    expect(screen.getByTestId('RemoteServerSettings.portError')).toHaveTextContent(
      'Port must be 0 (random) or between 1024 and 65535'
    )
    expect(api.setRemoteConfig).not.toHaveBeenCalled()
  })

  it('commits a valid port on blur', async () => {
    api.setRemoteConfig.mockResolvedValue({ ...baseConfig, port: 5000 })
    render(<RemoteServerSettings />)
    const portInput = await screen.findByTestId('RemoteServerSettings.port')
    fireEvent.change(portInput, { target: { value: '5000' } })
    fireEvent.blur(portInput)
    await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ port: 5000 }))
  })

  // ADR-042 — the pinned Tailscale HTTPS port.
  describe('HTTPS port (Tailscale)', () => {
    it('renders the persisted pinned port and is disabled while TLS mode is off', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, tlsHttpsPort: 8443 })
      render(<RemoteServerSettings />)
      const input = await screen.findByTestId('RemoteServerSettings.tlsHttpsPort')
      expect(input).toHaveValue('8443')
      expect(input).toBeDisabled()
      // The hint has to state the two facts that surprise people: no fallback,
      // and which ports Funnel would accept.
      expect(screen.getByTestId('RemoteServerSettings.tlsHttpsPortHint')).toHaveTextContent(
        /no fallback/i
      )
      expect(screen.getByTestId('RemoteServerSettings.tlsHttpsPortHint')).toHaveTextContent('10000')
    })

    it('commits a valid port on blur when TLS mode is on', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1 })
      api.setRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1, tlsHttpsPort: 9443 })
      render(<RemoteServerSettings />)
      const input = await screen.findByTestId('RemoteServerSettings.tlsHttpsPort')
      expect(input).not.toBeDisabled()
      fireEvent.change(input, { target: { value: '9443' } })
      fireEvent.blur(input)
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ tlsHttpsPort: 9443 }))
      await waitFor(() => expect(input).toHaveValue('9443'))
    })

    // 0 is legal for the LISTEN port ("pick a random one") but meaningless here:
    // serve binds one concrete port, and pinning it is the whole point.
    it.each(['0', '70000', 'abc', '-1'])(
      'rejects %s without calling setRemoteConfig',
      async (value) => {
        api.getRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1 })
        render(<RemoteServerSettings />)
        const input = await screen.findByTestId('RemoteServerSettings.tlsHttpsPort')
        fireEvent.change(input, { target: { value } })
        fireEvent.blur(input)
        await screen.findByTestId('RemoteServerSettings.tlsHttpsPortError')
        expect(screen.getByTestId('RemoteServerSettings.tlsHttpsPortError')).toHaveTextContent(
          'Tailscale HTTPS port must be between 1 and 65535'
        )
        expect(api.setRemoteConfig).not.toHaveBeenCalled()
      }
    )

    it('an empty field commits the 443 default rather than erroring', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1, tlsHttpsPort: 9443 })
      api.setRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1, tlsHttpsPort: 443 })
      render(<RemoteServerSettings />)
      const input = await screen.findByTestId('RemoteServerSettings.tlsHttpsPort')
      fireEvent.change(input, { target: { value: '  ' } })
      fireEvent.blur(input)
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ tlsHttpsPort: 443 }))
      await waitFor(() => expect(input).toHaveValue('443'))
    })
  })

  it('renders network interfaces in the bind-host select and keeps a stale persisted value visible', async () => {
    api.getRemoteConfig.mockResolvedValue({ ...baseConfig, bindHost: '172.16.9.9' })
    render(<RemoteServerSettings />)
    const field = await screen.findByTestId('RemoteServerSettings.bindHost')
    // Themed SelectMenu, never a native <select>.
    expect(field.querySelector('select')).toBeNull()
    // Stale bindHost not in the current interface list still renders as selected.
    expect(selectMenuValue(field)).toBe('172.16.9.9')
    expect(field).toHaveTextContent('172.16.9.9 (unavailable)')
    expect(selectMenuOptionLabels(field)).toEqual([
      'All interfaces (0.0.0.0)',
      '192.168.1.50 (Wi-Fi)',
      '10.0.0.5 (Ethernet)',
      // The stale value is appended last so it stays reachable.
      '172.16.9.9 (unavailable)'
    ])
  })

  it('toggles autostart via setRemoteConfig', async () => {
    api.setRemoteConfig.mockResolvedValue({ ...baseConfig, autostart: true })
    render(<RemoteServerSettings />)
    const toggle = await screen.findByTestId('RemoteServerSettings.autostart')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ autostart: true }))
  })

  // The password FIELDS moved into the settings editor (`SessionSecuritySettings`,
  // ADR-054 §6 amendment): they are one of the six facts an operator reviews and
  // changes together, inside the bounded editing mode. Their validation and
  // rotation flows are covered by that component's suite. What stayed here is
  // CLEARING the credential, which is host-anchor only — removing the last way
  // back in over the network belongs beside the transport controls.
  it('offers Clear only on the host, and only when a password exists', async () => {
    api.getRemoteConfig.mockResolvedValue({ ...baseConfig, passwordSet: true })
    render(<RemoteServerSettings />)
    await screen.findByTestId('RemoteServerSettings')
    expect(screen.getByTestId('RemoteServerSettings.clearPassword')).toBeInTheDocument()
    // …and no rotation surface: that is the editor's now.
    expect(screen.queryByTestId('RemoteServerSettings.passwordInput')).toBeNull()
    expect(screen.queryByTestId('RemoteServerSettings.setPassword')).toBeNull()
  })

  it('hides Clear when no password is set', async () => {
    api.getRemoteConfig.mockResolvedValue({ ...baseConfig, passwordSet: false })
    render(<RemoteServerSettings />)
    await screen.findByTestId('RemoteServerSettings')
    expect(screen.queryByTestId('RemoteServerSettings.clearPassword')).toBeNull()
  })

  // Phase 3 — the TLS toggle is gated on a LIVE probe. `tailscale serve` on a
  // certs-disabled tailnet silently no-ops (or blocks), so flipping tls_mode
  // optimistically would produce a loopback-bound server reachable from nowhere.
  describe('Tailscale HTTPS toggle', () => {
    it('keeps the toggle OFF and shows the actionable message when detection is not ok', async () => {
      api.detectTailscale.mockResolvedValue({
        state: 'https-disabled',
        message: 'HTTPS certificates are not enabled for this tailnet.'
      })
      render(<RemoteServerSettings />)
      const toggle = await screen.findByTestId('RemoteServerSettings.tls')
      fireEvent.click(toggle)

      await screen.findByTestId('RemoteServerSettings.tlsDetection')
      expect(screen.getByTestId('RemoteServerSettings.tlsDetection')).toHaveTextContent(
        'HTTPS certificates are not enabled for this tailnet.'
      )
      // GUARD: nothing persisted, so the next start does not bind loopback-only.
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
      expect(screen.queryByTestId('RemoteServerSettings.tlsConfirm')).not.toBeInTheDocument()
    })

    it('asks for one confirm click after a passing probe, then persists tlsMode:1', async () => {
      api.detectTailscale.mockResolvedValue({
        state: 'ok',
        binaryPath: 'tailscale',
        version: '1.98.5',
        dnsName: 'cg-mac.tail3140f8.ts.net',
        certDomains: ['cg-mac.tail3140f8.ts.net'],
        ownerLogin: 'owner@example.com'
      })
      api.setRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1 })
      render(<RemoteServerSettings />)
      const toggle = await screen.findByTestId('RemoteServerSettings.tls')

      fireEvent.click(toggle)
      await screen.findByTestId('RemoteServerSettings.tlsConfirm')
      expect(screen.getByTestId('RemoteServerSettings.tlsConfirm')).toHaveTextContent(
        'persists until turned off'
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()

      fireEvent.click(toggle)
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ tlsMode: 1 }))
      // The bind-interface picker is meaningless in TLS mode.
      await waitFor(() =>
        expect(screen.getByTestId('RemoteServerSettings.bindHost.trigger')).toBeDisabled()
      )
      expect(screen.getByTestId('RemoteServerSettings.bindHostTlsHint')).toBeInTheDocument()
    })

    it('turning it OFF needs no probe and no confirm', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 1 })
      api.setRemoteConfig.mockResolvedValue({ ...baseConfig, tlsMode: 0 })
      render(<RemoteServerSettings />)
      const toggle = await screen.findByTestId('RemoteServerSettings.tls')
      fireEvent.click(toggle)
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ tlsMode: 0 }))
      expect(api.detectTailscale).not.toHaveBeenCalled()
    })

    it('surfaces a throwing probe inline instead of enabling the mode', async () => {
      api.detectTailscale.mockRejectedValue(new Error('tailscale detect blew up'))
      render(<RemoteServerSettings />)
      fireEvent.click(await screen.findByTestId('RemoteServerSettings.tls'))
      await screen.findByTestId('RemoteServerSettings.tlsDetection')
      expect(screen.getByTestId('RemoteServerSettings.tlsDetection')).toHaveTextContent(
        'tailscale detect blew up'
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
    })
  })

  // The transport-honesty note (ADR-030 spirit — a password proof is a bearer
  // secret, only as private as the network it crosses) moved with the password
  // fields into the settings editor, and is asserted there.

  it('clear password requires a confirm click before calling the IPC', async () => {
    api.getRemoteConfig.mockResolvedValue({
      ...baseConfig,
      passwordSet: true,
      passwordUpdatedAt: Date.now()
    })
    render(<RemoteServerSettings />)
    const clearBtn = await screen.findByTestId('RemoteServerSettings.clearPassword')
    fireEvent.click(clearBtn)
    expect(api.clearRemotePassword).not.toHaveBeenCalled()
    expect(clearBtn).toHaveTextContent('Confirm clear?')
    fireEvent.click(clearBtn)
    await waitFor(() => expect(api.clearRemotePassword).toHaveBeenCalledTimes(1))
  })
})
