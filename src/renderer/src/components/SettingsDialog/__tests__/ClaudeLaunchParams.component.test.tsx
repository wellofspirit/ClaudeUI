/**
 * Layer 2: the Claude page's launch parameters (ADR-065, phase 2 slice C).
 *
 * The Sandbox and Proxy groups are the only two on the Claude page, and both
 * are dependency trees: a master toggle, then rows that must nest, dim and go
 * inert underneath it. What is worth guarding is exactly that — which rows the
 * master disables, and that a presentation pass left every WRITE untouched
 * (each row still hands `updateEngineConfig` the whole `sandbox`/`proxy`
 * object with one field changed).
 *
 * Driven through `SettingsDialogView` with `activePage: 'claude'` so the rows
 * render inside the real shell, the same way `SettingsDialogView.component`
 * drives the other pages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SettingsDialogView, type SettingsDialogViewProps } from '../View'
import { DEFAULT_SETTINGS } from '../../../stores/session-store'
import type { EngineConfig, ProxySettings, SandboxSettings } from '../../../../../shared/types'

/** Mirrors `DEFAULT_SANDBOX` in settings-sections.tsx — the shape a row that
 *  changes ONE field has to hand back untouched. Duplicated on purpose: the
 *  constant is module-private, and a copy here is what makes "the rest of the
 *  object unchanged" an assertion rather than a tautology. */
const SANDBOX_OFF: SandboxSettings = {
  enabled: false,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: false,
  network: {
    restrictNetwork: false,
    allowLocalBinding: false,
    allowedDomains: [],
    allowManagedDomainsOnly: false,
    allowAllUnixSockets: false,
    allowUnixSockets: []
  },
  filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
  excludedCommands: []
}

/** Mirrors `DEFAULT_PROXY`, for the same reason. */
const PROXY_OFF: ProxySettings = {
  enabled: false,
  type: 'http',
  hostname: '',
  port: 8080,
  username: '',
  password: '',
  proxySubprocesses: false
}

function renderClaudePage(engineConfig: EngineConfig = {}): {
  updateEngineConfig: SettingsDialogViewProps['updateEngineConfig']
} {
  const props: SettingsDialogViewProps = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: vi.fn(),
    engineConfig,
    updateEngineConfig: vi.fn(),
    vendorConfig: {},
    updateVendorConfig: vi.fn(),
    versionInfo: { appVersion: '9.9.9', cliVersion: '2.5.0' },
    activePage: 'claude',
    onSelectPage: vi.fn(),
    activeGroup: null,
    onActiveGroupChange: vi.fn(),
    scrollNonce: 0,
    engineByGroup: {},
    onSelectEngine: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    navigate: vi.fn(),
    onClose: vi.fn()
  }
  render(<SettingsDialogView {...props} />)
  return { updateEngineConfig: props.updateEngineConfig }
}

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
  app.bridge.ipcMain.handle('config:load-vendor-config', async () => ({}))
  app.bridge.ipcMain.handle('engine:is-installed', async () => true)
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('the sandbox group', () => {
  it('disables every dependent row while the master toggle is off', () => {
    renderClaudePage()

    for (const id of [
      'ClaudeSandbox.autoAllow',
      'ClaudeSandbox.allowUnsandboxed',
      'ClaudeSandbox.localBinding',
      'ClaudeSandbox.restrictNetwork',
      'ClaudeSandbox.allowAllUnixSockets'
    ]) {
      expect(screen.getByTestId(id), id).toBeDisabled()
    }
    // The lists go inert through their editor, which is not a <button> row.
    expect(screen.getByTestId('ClaudeSandbox.allowWrite.input')).toBeDisabled()
    expect(screen.getByTestId('ClaudeSandbox.allowedDomains.input')).toBeDisabled()
  })

  it('enables the dependents once the master toggle is on', () => {
    renderClaudePage({ sandbox: { ...SANDBOX_OFF, enabled: true } })

    expect(screen.getByTestId('ClaudeSandbox.autoAllow')).not.toBeDisabled()
    expect(screen.getByTestId('ClaudeSandbox.allowWrite.input')).not.toBeDisabled()
    // Still gated on its own parent (restrictNetwork), not just the master.
    expect(screen.getByTestId('ClaudeSandbox.allowedDomains.input')).toBeDisabled()
    expect(screen.getByTestId('ClaudeSandbox.managedDomainsOnly')).toBeDisabled()
  })

  it('turning the master on writes enabled: true and nothing else', () => {
    const { updateEngineConfig } = renderClaudePage()
    fireEvent.click(screen.getByTestId('ClaudeSandbox.enabled'))
    expect(updateEngineConfig).toHaveBeenCalledWith({
      sandbox: { ...SANDBOX_OFF, enabled: true }
    })
  })

  it('adding an allowed domain appends it to the existing list', () => {
    const sandbox: SandboxSettings = {
      ...SANDBOX_OFF,
      enabled: true,
      network: {
        ...SANDBOX_OFF.network,
        restrictNetwork: true,
        allowedDomains: ['files.example.com']
      }
    }
    const { updateEngineConfig } = renderClaudePage({ sandbox })

    fireEvent.change(screen.getByTestId('ClaudeSandbox.allowedDomains.input'), {
      target: { value: 'registry.npmjs.org' }
    })
    fireEvent.click(screen.getByTestId('ClaudeSandbox.allowedDomains.add'))

    expect(updateEngineConfig).toHaveBeenCalledWith({
      sandbox: {
        ...sandbox,
        network: {
          ...sandbox.network,
          allowedDomains: ['files.example.com', 'registry.npmjs.org']
        }
      }
    })
  })

  it('carries a description on the note row instead of a prose footer', () => {
    renderClaudePage()
    expect(screen.getByTestId('ClaudeSandbox.note')).toHaveTextContent(
      'Filesystem defaults: the project directory and $TMPDIR are writable.'
    )
    // The "applies on next session" half of the old footer is the group note.
    expect(screen.getByTestId('ClaudeSandbox.note')).not.toHaveTextContent('next session')
  })
})

describe('the proxy group', () => {
  it('disables the type segment and the fields while the proxy is off', () => {
    renderClaudePage()
    for (const el of screen.getAllByTestId('ClaudeProxy.type.option')) {
      expect(el).toBeDisabled()
    }
    expect(screen.getByTestId('ClaudeProxy.hostname.input')).toBeDisabled()
    expect(screen.getByTestId('ClaudeProxy.port.input')).toBeDisabled()
    expect(screen.getByTestId('ClaudeProxy.subprocesses')).toBeDisabled()
  })

  it('picking SOCKS5 writes type and nothing else', () => {
    const proxy: ProxySettings = { ...PROXY_OFF, enabled: true, hostname: 'proxy.example.com' }
    const { updateEngineConfig } = renderClaudePage({ proxy })

    const socks = screen
      .getAllByTestId('ClaudeProxy.type.option')
      .find((el) => el.dataset.id === 'socks5')!
    fireEvent.click(socks)

    expect(updateEngineConfig).toHaveBeenCalledWith({ proxy: { ...proxy, type: 'socks5' } })
  })

  it('an emptied port field falls back to the default rather than to NaN', () => {
    const proxy: ProxySettings = { ...PROXY_OFF, enabled: true, port: 3128 }
    const { updateEngineConfig } = renderClaudePage({ proxy })

    const port = screen.getByTestId('ClaudeProxy.port.input')
    fireEvent.change(port, { target: { value: '' } })
    fireEvent.blur(port)

    expect(updateEngineConfig).toHaveBeenCalledWith({ proxy: { ...proxy, port: 8080 } })
  })

  it('cannot test a connection with no hostname', () => {
    renderClaudePage({ proxy: { ...PROXY_OFF, enabled: true } })
    expect(screen.getByTestId('ClaudeProxy.test.action')).toBeDisabled()
    expect(screen.getByTestId('ClaudeProxy.test')).toHaveTextContent('Not tested yet.')
  })

  it('reports the round trip in the row description once the proxy answers', async () => {
    // `safeHandler` envelope: the probe's own {ok, latencyMs} is the `data`.
    app.bridge.ipcMain.handle('proxy:test-connection', async () => ({
      ok: true,
      data: { ok: true, latencyMs: 42 }
    }))
    renderClaudePage({ proxy: { ...PROXY_OFF, enabled: true, hostname: 'proxy.example.com' } })

    const button = screen.getByTestId('ClaudeProxy.test.action')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    expect(await screen.findByText('Reachable · 42 ms')).toBeInTheDocument()
  })

  it('puts a failure in the row error slot, not beside the button', async () => {
    // The PROBE failed, not the IPC: a reachability verdict is a successful
    // envelope carrying {ok: false, error}.
    app.bridge.ipcMain.handle('proxy:test-connection', async () => ({
      ok: true,
      data: { ok: false, latencyMs: 0, error: 'ECONNREFUSED 10.0.0.1:8080' }
    }))
    renderClaudePage({ proxy: { ...PROXY_OFF, enabled: true, hostname: 'proxy.example.com' } })

    fireEvent.click(screen.getByTestId('ClaudeProxy.test.action'))

    expect(await screen.findByTestId('ClaudeProxy.test.error')).toHaveTextContent(
      'ECONNREFUSED 10.0.0.1:8080'
    )
  })
})
