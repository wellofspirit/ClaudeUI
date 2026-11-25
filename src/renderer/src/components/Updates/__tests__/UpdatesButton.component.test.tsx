/**
 * Layer 2: the footer's Updates button and panel against the test app
 * (`bootTestApp`: the real stores, the real sync client, handlers on the IPC
 * bridge). A click only opens the panel and never installs; Update installs
 * that one harness; Skip asks the host; Restart to update confirms only when
 * something would be interrupted; the cog menu's entries reach the same
 * panel; a connection without `admin` sees it read only; and the button sits
 * left of Remote Access, holding the footer's `ml-auto`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { HarnessStateSnapshot, HarnessUpdatesView } from '../../../../../shared/harness-types'
import type { AppUpdateView } from '../../../../../shared/types/app-update'
import type { RestartImpact } from '../../../../../shared/relaunch'

// The footer test mounts SettingsPanel; keep its heavy neighbours out.
vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: () => <div data-testid="SettingsDialog" />,
  SettingsToggle: () => null
}))
vi.mock('../../Sidebar/UsagePanel', () => ({ UsageRing: () => null }))

import { UpdatesButton, useUpdatesIndicator } from '../UpdatesButton'
import { updatesStore } from '../app-update-store'
import { harnessStore } from '../../SettingsDialog/harness-store'
import { installEnrollBridge } from '../../SettingsDialog/enroll-flow'
import { SettingsPanel } from '../../Sidebar/SettingsPanel'
import { TREES, appView, harnessView, localView, stagedView } from './fixtures'

const NO_IMPACT: RestartImpact = { workingSessions: 0, terminals: 0, remoteClients: 0 }

function snapshot(updates: HarnessUpdatesView): HarnessStateSnapshot {
  return {
    harnesses: {},
    detection: { running: false },
    installs: [],
    updates,
    upgradePrompt: { pending: false, candidates: [] }
  } as unknown as HarnessStateSnapshot
}

let app: TestApp
const host = {
  view: appView({ available: undefined }) as AppUpdateView,
  harness: harnessView(),
  impact: NO_IMPACT
}
const calls: Record<string, unknown[][]> = {}
let finishInstall: ((value: unknown) => void) | null = null

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  app.bridge.ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
    ;(calls[channel] ??= []).push(args)
    return fn(...args)
  })
}

beforeEach(async () => {
  app = await bootTestApp()
  updatesStore.resetForTests()
  harnessStore.resetForTests()
  installEnrollBridge(null)
  for (const k of Object.keys(calls)) delete calls[k]
  host.view = appView({ available: undefined })
  host.harness = harnessView()
  host.impact = NO_IMPACT
  finishInstall = null
  handle('app-update:state', () => host.view)
  handle('app:relaunch-availability', () => ({ available: true }))
  handle('harness:state', () => snapshot(host.harness))
  handle('app:restart-impact', () => host.impact)
  handle('app-update:apply', () => ({ accepted: true }))
  handle('app:relaunch', () => ({ accepted: true }))
  handle('app-update:trees', () => TREES)
  handle('app-update:rebuild', () => host.view)
  handle('harness:update-all', () => snapshot(host.harness))
  handle('harness:install', ({ id, version }: { id: string; version: string }) => {
    return new Promise((resolve) => {
      finishInstall = () => resolve({ status: 'installed', id, version, verified: 'publisher' })
    })
  })
  handle('harness:skip-update', ({ id }: { id: string }) => {
    host.harness = harnessView({
      available: host.harness.available.filter((u) => u.id !== id),
      skipped: { [id]: '0.72.1' }
    })
    return host.harness
  })
  handle('remote:status', () => null)
})

afterEach(() => {
  cleanup()
  updatesStore.resetForTests()
  harnessStore.resetForTests()
  installEnrollBridge(null)
  app.teardown()
})

function Footer(): React.JSX.Element {
  const indicator = useUpdatesIndicator()
  return (
    <div className="relative">
      <UpdatesButton indicator={indicator} />
    </div>
  )
}

async function mounted(): Promise<void> {
  render(<Footer />)
  await waitFor(() => expect(calls['harness:state']).toBeDefined())
  await waitFor(() => expect(calls['app-update:state']).toBeDefined())
  await act(async () => {})
}

const button = (): HTMLElement => screen.getByTestId('UpdatesButton')
const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!

describe('the button', () => {
  it('is hidden with nothing pending', async () => {
    host.harness = harnessView({ available: [] })
    await mounted()
    expect(screen.queryByTestId('UpdatesButton')).toBeNull()
  })

  it('a click opens the panel and never installs anything', async () => {
    await mounted()
    expect(button()).toHaveAttribute('data-state', 'available')
    expect(screen.getByTestId('UpdatesButton.badge')).toHaveTextContent('2')
    fireEvent.click(button())
    expect(screen.getByTestId('UpdatesPanel')).toBeInTheDocument()
    await act(async () => {})
    expect(calls['harness:install']).toBeUndefined()
    expect(calls['harness:update-all']).toBeUndefined()
    fireEvent.click(button())
    expect(screen.queryByTestId('UpdatesPanel')).toBeNull()
  })

  it('counts a staged ClaudeUI update and shows the restart arrow', async () => {
    host.view = stagedView()
    await mounted()
    expect(button()).toHaveAttribute('data-state', 'restart')
    expect(screen.getByTestId('UpdatesButton.badge')).toHaveTextContent('3')
  })

  it('re-reads on the app-update:changed nudge', async () => {
    host.harness = harnessView({ available: [] })
    await mounted()
    expect(screen.queryByTestId('UpdatesButton')).toBeNull()
    host.view = stagedView()
    act(() => app.emit('app-update:changed'))
    await waitFor(() => expect(button()).toHaveAttribute('data-state', 'restart'))
  })
})

describe('harness rows', () => {
  it('Update installs that one harness, shows its progress, then Installed', async () => {
    await mounted()
    fireEvent.click(button())
    fireEvent.click(byId('UpdatesPanel.harnessUpdate', 'opencode'))
    await waitFor(() =>
      expect(calls['harness:install']).toEqual([[{ id: 'opencode', version: '2.5.0' }]])
    )
    expect(calls['harness:update-all']).toBeUndefined()
    act(() =>
      app.emit('harness:install-progress', {
        id: 'opencode',
        version: '2.5.0',
        phase: 'downloading',
        receivedBytes: 62,
        totalBytes: 100
      })
    )
    expect(byId('UpdatesPanel.harnessRow', 'opencode')).toHaveAttribute('data-state', 'installing')
    expect(button()).toHaveAttribute('data-state', 'running')
    // The host's store now holds 2.5.0: no longer an update.
    host.harness = harnessView({ available: [harnessView().available[1]] })
    await act(async () => finishInstall?.(undefined))
    await waitFor(() =>
      expect(byId('UpdatesPanel.harnessRow', 'opencode')).toHaveAttribute('data-state', 'installed')
    )
    expect(byId('UpdatesPanel.harnessRow', 'opencode')).toHaveTextContent('New sessions use 2.5.0.')
    expect(screen.queryAllByTestId('UpdatesPanel.install')).toHaveLength(0)
  })

  it('Skip asks the host to skip that version; the row goes', async () => {
    await mounted()
    fireEvent.click(button())
    fireEvent.click(byId('UpdatesPanel.harnessSkip', 'pi'))
    await waitFor(() =>
      expect(calls['harness:skip-update']).toEqual([[{ id: 'pi', version: '0.72.1' }]])
    )
    await waitFor(() =>
      expect(screen.getAllByTestId('UpdatesPanel.harnessRow').map((r) => r.dataset.id)).toEqual([
        'opencode'
      ])
    )
  })

  it('Later hides a row for this client, with no call to the host', async () => {
    await mounted()
    fireEvent.click(button())
    fireEvent.click(byId('UpdatesPanel.harnessLater', 'opencode'))
    expect(screen.getAllByTestId('UpdatesPanel.harnessRow').map((r) => r.dataset.id)).toEqual([
      'pi'
    ])
    expect(screen.getByTestId('UpdatesButton.badge')).toHaveTextContent('1')
    expect(calls['harness:skip-update']).toBeUndefined()
  })
})

describe('restarting into the update', () => {
  it('with something running: the inline confirm first, then the restart', async () => {
    host.view = stagedView()
    host.impact = { workingSessions: 2, terminals: 1, remoteClients: 1 }
    await mounted()
    fireEvent.click(button())
    fireEvent.click(byId('UpdatesPanel.primary', 'restart'))
    const confirm = await screen.findByTestId('UpdatesPanel.restartConfirm')
    expect(
      within(screen.getByTestId('UpdatesPanel.appRow')).getByTestId('UpdatesPanel.restartConfirm')
    ).toBe(confirm)
    expect(confirm).toHaveTextContent('2 sessions are working.')
    expect(calls['app-update:apply']).toBeUndefined()
    fireEvent.click(screen.getByTestId('UpdatesPanel.restartNow'))
    await waitFor(() => expect(calls['app-update:apply']).toEqual([[{ source: 'release' }]]))
  })

  it('with nothing running: the first click restarts', async () => {
    host.view = stagedView()
    await mounted()
    fireEvent.click(button())
    fireEvent.click(byId('UpdatesPanel.primary', 'restart'))
    await waitFor(() => expect(calls['app-update:apply']).toEqual([[{ source: 'release' }]]))
    expect(screen.queryByTestId('UpdatesPanel.restartConfirm')).toBeNull()
  })
})

describe('a local build', () => {
  it('lists the trees once the row shows, and rebuilds the one picked', async () => {
    host.view = localView()
    await mounted()
    fireEvent.click(button())
    await waitFor(() => expect(calls['app-update:trees']).toHaveLength(1))
    const picker = await screen.findByTestId('UpdatesPanel.tree')
    // The worktree at the build's commit, though the main checkout is listed first.
    await waitFor(() => expect(picker).toHaveAttribute('data-value', TREES[1].id))
    expect(screen.getByTestId('UpdatesPanel.version')).toHaveTextContent('3.9.1-pre.13 +5')
    fireEvent.click(screen.getByTestId('UpdatesPanel.tree.trigger'))
    const main = screen
      .getAllByTestId('UpdatesPanel.tree.option')
      .find((o) => o.dataset.id === TREES[0].id)!
    fireEvent.click(main)
    // Picking a tree inside the panel does not close it (the menu lives inside it).
    expect(screen.getByTestId('UpdatesPanel')).toBeInTheDocument()
    fireEvent.click(byId('UpdatesPanel.primary', 'rebuild'))
    await waitFor(() => expect(calls['app-update:rebuild']).toEqual([[{ treeId: TREES[0].id }]]))
  })
})

describe('remote read-only', () => {
  it('a connection without admin sees the rows and no action buttons', async () => {
    host.view = stagedView()
    app.api.platform = 'web'
    installEnrollBridge({
      authMethod: () => 'none' as never,
      capableOrigin: () => false,
      browserCapable: () => false,
      enroll: async () => {},
      subscribe: () => () => {}
    })
    await mounted()
    fireEvent.click(button())
    expect(screen.getByTestId('UpdatesPanel.appRow')).toHaveAttribute('data-state', 'staged')
    expect(screen.getByTestId('UpdatesPanel.readOnly')).toBeInTheDocument()
    expect(screen.queryByTestId('UpdatesPanel.primary')).toBeNull()
    expect(screen.queryByTestId('UpdatesPanel.harnessUpdate')).toBeNull()
    expect(screen.queryByTestId('UpdatesPanel.check')).toBeNull()
  })
})

describe('in the footer', () => {
  it('sits left of Remote Access and takes the ml-auto while it shows', async () => {
    render(<SettingsPanel />)
    await waitFor(() => expect(screen.getByTestId('Updates')).toBeInTheDocument())
    const remote = screen.getByTestId('SettingsPanel.remoteAccess')
    const wrapper = screen.getByTestId('Updates')
    expect(wrapper.className).toContain('ml-auto')
    expect(remote.className).not.toContain('ml-auto')
    expect(wrapper.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    host.harness = harnessView({ available: [] })
    await act(async () => {
      await harnessStore.refresh()
    })
    expect(screen.queryByTestId('Updates')).toBeNull()
    expect(screen.getByTestId('SettingsPanel.remoteAccess').className).toContain('ml-auto')
  })

  it('the cog menu’s Rebuild & relaunch… opens the panel on the rebuild choice', async () => {
    host.harness = harnessView({ available: [] })
    host.view = appView({ available: undefined, rebuildAvailable: true })
    render(<SettingsPanel />)
    await waitFor(() => expect(calls['app-update:state']).toBeDefined())
    fireEvent.click(screen.getByTestId('SettingsPanel.toggle'))
    fireEvent.click(await screen.findByTestId('SettingsPanel.rebuild'))
    const row = await screen.findByTestId('UpdatesPanel.appRow')
    expect(row).toHaveAttribute('data-id', 'local')
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveAttribute('aria-checked', 'true')
  })

  it('the cog menu’s Relaunch confirms in the panel when something runs', async () => {
    host.harness = harnessView({ available: [] })
    host.impact = { workingSessions: 0, terminals: 2, remoteClients: 0 }
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTestId('SettingsPanel.toggle'))
    fireEvent.click(await screen.findByTestId('SettingsPanel.relaunch'))
    const confirm = await screen.findByTestId('UpdatesPanel.restartConfirm')
    expect(confirm).toHaveTextContent('2 terminals will close.')
    expect(calls['app:relaunch']).toBeUndefined()
    fireEvent.click(screen.getByTestId('UpdatesPanel.restartNow'))
    await waitFor(() => expect(calls['app:relaunch']).toHaveLength(1))
  })
})
