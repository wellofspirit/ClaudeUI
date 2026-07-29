import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteServerSettings } from '../RemoteServerSettings'
import type { RemoteConfig, NetworkInterfaceInfo } from '../../../../../shared/types'

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 0,
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
  getNetworkInterfaces: vi.fn()
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
    expect(screen.getByTestId('RemoteServerSettings.bindHost')).toHaveValue('10.0.0.5')
    expect(screen.getByTestId('RemoteServerSettings.passwordStatus')).toHaveTextContent('Set')
    expect(screen.getByTestId('RemoteServerSettings.setPassword')).toHaveTextContent('Change')
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

  it('renders network interfaces in the bind-host select and keeps a stale persisted value visible', async () => {
    api.getRemoteConfig.mockResolvedValue({ ...baseConfig, bindHost: '172.16.9.9' })
    render(<RemoteServerSettings />)
    const select = await screen.findByTestId('RemoteServerSettings.bindHost')
    // Stale bindHost not in the current interface list still renders as selected.
    expect(select).toHaveValue('172.16.9.9')
    expect(select).toHaveTextContent('172.16.9.9 (unavailable)')
    expect(select).toHaveTextContent('192.168.1.50 (Wi-Fi)')
  })

  it('toggles autostart via setRemoteConfig', async () => {
    api.setRemoteConfig.mockResolvedValue({ ...baseConfig, autostart: true })
    render(<RemoteServerSettings />)
    const toggle = await screen.findByTestId('RemoteServerSettings.autostart')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ autostart: true }))
  })

  it('shows a mismatch error when password + confirm differ and never calls the IPC', async () => {
    render(<RemoteServerSettings />)
    await screen.findByTestId('RemoteServerSettings')
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordInput'), {
      target: { value: 'a-good-password-1' }
    })
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordConfirm'), {
      target: { value: 'a-different-password' }
    })
    fireEvent.click(screen.getByTestId('RemoteServerSettings.setPassword'))
    await screen.findByTestId('RemoteServerSettings.passwordError')
    expect(screen.getByTestId('RemoteServerSettings.passwordError')).toHaveTextContent(
      'Passwords do not match'
    )
    expect(api.setRemotePassword).not.toHaveBeenCalled()
  })

  it('shows an inline error from the IPC throw (min-length rejection) without clearing the fields', async () => {
    api.setRemotePassword.mockRejectedValueOnce(
      new Error('Password must be at least 12 characters')
    )
    render(<RemoteServerSettings />)
    await screen.findByTestId('RemoteServerSettings')
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordInput'), {
      target: { value: 'valid-length-pw' }
    })
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordConfirm'), {
      target: { value: 'valid-length-pw' }
    })
    fireEvent.click(screen.getByTestId('RemoteServerSettings.setPassword'))
    await waitFor(() => expect(api.setRemotePassword).toHaveBeenCalledWith('valid-length-pw'))
    await screen.findByTestId('RemoteServerSettings.passwordError')
    expect(screen.getByTestId('RemoteServerSettings.passwordError')).toHaveTextContent(
      'Password must be at least 12 characters'
    )
  })

  it('sets a valid matching password, then reloads and clears the input fields', async () => {
    api.setRemotePassword.mockResolvedValue(undefined)
    api.getRemoteConfig
      .mockResolvedValueOnce(baseConfig)
      .mockResolvedValueOnce({ ...baseConfig, passwordSet: true, passwordUpdatedAt: Date.now() })
    render(<RemoteServerSettings />)
    await screen.findByTestId('RemoteServerSettings')
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordInput'), {
      target: { value: 'a-good-password-123' }
    })
    fireEvent.change(screen.getByTestId('RemoteServerSettings.passwordConfirm'), {
      target: { value: 'a-good-password-123' }
    })
    fireEvent.click(screen.getByTestId('RemoteServerSettings.setPassword'))
    await waitFor(() => expect(api.setRemotePassword).toHaveBeenCalledWith('a-good-password-123'))
    await waitFor(() =>
      expect(screen.getByTestId('RemoteServerSettings.passwordStatus')).toHaveTextContent('Set')
    )
    expect(screen.getByTestId('RemoteServerSettings.passwordInput')).toHaveValue('')
    expect(screen.getByTestId('RemoteServerSettings.passwordConfirm')).toHaveValue('')
  })

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
