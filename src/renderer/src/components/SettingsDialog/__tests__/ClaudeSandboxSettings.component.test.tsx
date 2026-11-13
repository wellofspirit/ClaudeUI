/**
 * Settings › Engines › Claude Code › Sandbox: every row shows the replicated `claudeSandbox` value,
 * saves a patch holding only its own field through `setClaudeSandbox`, never flips ahead of the
 * host's echo and shows a refused write in the row. An unsupported host disables the switch while
 * the setting is off and warns while it is on; the active directory's own sandbox settings show as a
 * read-only note; the remembered domain list survives "restrict network" being off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { pageOf } from '../settings-pages'
import {
  SandboxAllowedDomainsRow,
  SandboxMainRow,
  SandboxRestrictNetworkRow,
  SandboxToggleRow
} from '../claude-sandbox'
import { seedLocalApp } from '../../../stores/replica'
import { useSessionStore } from '../../../stores/session-store'
import { resetReplicaSeam, seedSession } from '@test/helpers/replica-seed'
import {
  DEFAULT_SANDBOX,
  type ClaudeSandboxScope,
  type EngineConfig,
  type SandboxSettings
} from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const setClaudeSandbox = vi.fn<(patch: unknown) => Promise<void>>()
const claudeSandboxScopes = vi.fn<(cwd: string) => Promise<ClaudeSandboxScope[]>>()

function seedSandbox(settings: Partial<SandboxSettings>, supported = true): void {
  act(() =>
    seedLocalApp({ claudeSandbox: { settings: { ...DEFAULT_SANDBOX, ...settings }, supported } })
  )
}

beforeEach(() => {
  resetReplicaSeam()
  setClaudeSandbox.mockReset().mockResolvedValue(undefined)
  claudeSandboxScopes.mockReset().mockResolvedValue([])
  ;(window as unknown as { api: unknown }).api = { setClaudeSandbox, claudeSandboxScopes }
  useSessionStore.setState({
    activeSessionId: null,
    claudeSandbox: { settings: DEFAULT_SANDBOX, supported: true }
  })
})
afterEach(cleanup)

const main = (): HTMLElement => screen.getByTestId('ClaudeSandbox.enabled')

describe('Claude page › Sandbox', () => {
  it('names the shared settings file and says it is shared with the claude CLI', () => {
    const group = pageOf('claude').groups.find((g) => g.id === 'sandbox')!
    expect(group.storage).toBe('~/.claude/settings.json')
    expect(group.note).toContain('claude CLI')
  })

  it('shows the store value and never flips ahead of the echo', async () => {
    render(<SandboxMainRow />)
    expect(main().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(main())
    expect(setClaudeSandbox).toHaveBeenCalledWith({ enabled: true })
    await waitFor(() => expect(setClaudeSandbox).toHaveBeenCalledTimes(1))
    expect(main().getAttribute('aria-pressed')).toBe('false')
    seedSandbox({ enabled: true })
    expect(main().getAttribute('aria-pressed')).toBe('true')
  })

  it('shows a refused write in the row and clears it after a later success', async () => {
    setClaudeSandbox.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'claude:set-sandbox': Error: settings.json is not valid JSON; fix or remove it, then try again"
      )
    )
    render(<SandboxMainRow />)
    fireEvent.click(main())
    expect((await screen.findByTestId('ClaudeSandbox.enabled.error')).textContent).toBe(
      'settings.json is not valid JSON; fix or remove it, then try again'
    )
    fireEvent.click(main())
    await waitFor(() => expect(screen.queryByTestId('ClaudeSandbox.enabled.error')).toBeNull())
  })

  it('a dependent row is inert while the sandbox is off and sends only its field when on', () => {
    const row = (
      <SandboxToggleRow
        testid="ClaudeSandbox.autoAllow"
        label="Auto"
        description="d"
        read={(s) => s.autoAllowBashIfSandboxed}
        patch={(v) => ({ autoAllowBashIfSandboxed: v })}
      />
    )
    render(row)
    expect(screen.getByTestId('ClaudeSandbox.autoAllow')).toBeDisabled()
    seedSandbox({ enabled: true })
    fireEvent.click(screen.getByTestId('ClaudeSandbox.autoAllow'))
    expect(setClaudeSandbox).toHaveBeenCalledWith({ autoAllowBashIfSandboxed: true })
  })
})

describe('Claude page › Sandbox › unsupported host', () => {
  it('disables the switch and says so while the setting is off', () => {
    seedSandbox({ enabled: false }, false)
    render(<SandboxMainRow />)
    expect(main()).toBeDisabled()
    expect(screen.getByTestId('ClaudeSandbox.enabled.unsupported').textContent).toContain(
      'cannot run on this host'
    )
    expect(screen.queryByTestId('ClaudeSandbox.enabled.warning')).toBeNull()
  })

  it('warns while it is on and still lets it be turned off', () => {
    seedSandbox({ enabled: true }, false)
    render(<SandboxMainRow />)
    expect(screen.getByTestId('ClaudeSandbox.enabled.warning').textContent).toContain(
      'will not start'
    )
    expect(main()).not.toBeDisabled()
    fireEvent.click(main())
    expect(setClaudeSandbox).toHaveBeenCalledWith({ enabled: false })
  })
})

describe('Claude page › Sandbox › the project note', () => {
  const withActiveDir = (cwd: string): void => {
    seedSession('r1', { cwd })
    act(() => useSessionStore.setState({ activeSessionId: 'r1' }))
  }

  it('names the files when the query answers, and shows nothing for an empty answer', async () => {
    claudeSandboxScopes.mockResolvedValue(['project', 'managed'])
    withActiveDir('/work/proj')
    render(<SandboxMainRow />)
    const note = await screen.findByTestId('ClaudeSandbox.projectNote')
    expect(claudeSandboxScopes).toHaveBeenCalledWith('/work/proj')
    expect(note.textContent).toContain('.claude/settings.json')
    expect(note.textContent).toContain('the managed settings')
    expect(note.textContent).not.toContain('settings.local.json')
  })

  it('shows nothing for an empty answer or without an active directory', async () => {
    withActiveDir('/work/proj')
    const { unmount } = render(<SandboxMainRow />)
    await waitFor(() => expect(claudeSandboxScopes).toHaveBeenCalled())
    expect(screen.queryByTestId('ClaudeSandbox.projectNote')).toBeNull()
    unmount()
    claudeSandboxScopes.mockClear()
    act(() => useSessionStore.setState({ activeSessionId: null }))
    render(<SandboxMainRow />)
    expect(claudeSandboxScopes).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ClaudeSandbox.projectNote')).toBeNull()
  })
})

describe('Claude page › Sandbox › the remembered domain list', () => {
  const claudeConfig = { sandboxRememberedDomains: ['a.example.com'] }

  it('shows the remembered list dimmed while the restriction is off', () => {
    seedSandbox({ enabled: true })
    render(<SandboxAllowedDomainsRow engineConfig={{ claudeConfig }} />)
    expect(screen.getByTestId('ClaudeSandbox.allowedDomains.input')).toBeDisabled()
    expect(screen.getByTestId('ClaudeSandbox.allowedDomains').textContent).toContain(
      'a.example.com'
    )
  })

  it('turning the restriction off stores the list in the engine config and sends the patch', () => {
    seedSandbox({
      enabled: true,
      network: {
        ...DEFAULT_SANDBOX.network,
        restrictNetwork: true,
        allowedDomains: ['b.example.com']
      }
    })
    const updateEngineConfig = vi.fn<(p: Partial<EngineConfig>) => void>()
    render(<SandboxRestrictNetworkRow engineConfig={{}} updateEngineConfig={updateEngineConfig} />)
    fireEvent.click(screen.getByTestId('ClaudeSandbox.restrictNetwork'))
    expect(updateEngineConfig).toHaveBeenCalledWith({
      claudeConfig: { sandboxRememberedDomains: ['b.example.com'] }
    })
    expect(setClaudeSandbox).toHaveBeenCalledWith({ network: { restrictNetwork: false } })
  })

  it('turning the restriction on sends it with the remembered list', () => {
    seedSandbox({ enabled: true })
    render(
      <SandboxRestrictNetworkRow engineConfig={{ claudeConfig }} updateEngineConfig={vi.fn()} />
    )
    fireEvent.click(screen.getByTestId('ClaudeSandbox.restrictNetwork'))
    expect(setClaudeSandbox).toHaveBeenCalledWith({
      network: { restrictNetwork: true, allowedDomains: ['a.example.com'] }
    })
  })
})
