/**
 * The sidebar footer's harness update button (ADR-082 §6, mockup `04c3853c`):
 * hidden / count badge / spinner / a check that fades after five seconds /
 * amber on a failure, the panel it opens, Update all, the read-only mode of a
 * connection without `admin`, and its place in the footer (left of Remote
 * Access, holding the footer's `ml-auto`). Against a mocked `window.api` and
 * hand-fired sync events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessStateSnapshot, HarnessUpdatesView } from '../../../../../shared/harness-types'

const syncHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    const set = syncHandlers.get(channel) ?? new Set()
    set.add(cb)
    syncHandlers.set(channel, set)
    return () => set.delete(cb)
  }
}))
// The footer test mounts SettingsPanel; keep its heavy neighbours out.
vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: () => <div data-testid="SettingsDialog" />,
  SettingsToggle: () => null
}))
vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))

import {
  HarnessUpdateButton,
  useHarnessUpdateIndicator,
  DONE_FADE_MS,
  DONE_VISIBLE_MS
} from '../HarnessUpdateButton'
import { SettingsPanel } from '../SettingsPanel'
import { harnessStore } from '../../SettingsDialog/harness-store'
import { installEnrollBridge } from '../../SettingsDialog/enroll-flow'

const RUN = '2026-09-30T01:00:00.000Z'

function updates(patch: Partial<HarnessUpdatesView> = {}): HarnessUpdatesView {
  return {
    mode: 'ask',
    available: [
      { id: 'opencode', from: '1.18.40', to: '1.18.41', choice: 'latest' },
      { id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }
    ],
    status: { running: false, lastCheckedAt: RUN, results: [] },
    ...patch
  }
}

/** Only `updates` and `installs` matter to the button. */
function snapshot(view: HarnessUpdatesView, patch: Partial<HarnessStateSnapshot> = {}) {
  return {
    harnesses: {},
    detection: { running: false },
    installs: [],
    updates: view,
    ...patch
  } as unknown as HarnessStateSnapshot
}

const api = {
  platform: 'win32' as string,
  harnessState: vi.fn<() => Promise<HarnessStateSnapshot>>(),
  updateHarnesses: vi.fn(),
  checkHarnessUpdates: vi.fn(),
  setHarnessUpdateMode: vi.fn(),
  getRemoteStatus: vi.fn(async () => null),
  onRemoteStatus: vi.fn(() => () => {})
}

beforeEach(() => {
  syncHandlers.clear()
  harnessStore.resetForTests()
  installEnrollBridge(null)
  for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockReset()
  api.platform = 'win32'
  api.getRemoteStatus.mockResolvedValue(null)
  api.onRemoteStatus.mockReturnValue(() => {})
  api.harnessState.mockResolvedValue(snapshot(updates({ available: [] })))
  api.updateHarnesses.mockResolvedValue(snapshot(updates({ available: [] })))
  api.checkHarnessUpdates.mockResolvedValue(snapshot(updates()))
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  harnessStore.resetForTests()
  installEnrollBridge(null)
})

function Footer(): React.JSX.Element {
  const indicator = useHarnessUpdateIndicator()
  return (
    <div className="relative">
      <HarnessUpdateButton indicator={indicator} />
    </div>
  )
}

async function mounted(view: HarnessUpdatesView, patch: Partial<HarnessStateSnapshot> = {}) {
  api.harnessState.mockResolvedValue(snapshot(view, patch))
  const result = render(<Footer />)
  await act(async () => {})
  return result
}

/** The next read answers `view`; the store re-reads now. */
async function nextRead(view: HarnessUpdatesView, patch: Partial<HarnessStateSnapshot> = {}) {
  api.harnessState.mockResolvedValue(snapshot(view, patch))
  await act(async () => {
    await harnessStore.refresh()
  })
}

const button = (): HTMLElement => screen.getByTestId('HarnessUpdateButton')
const rows = (): HTMLElement[] => screen.getAllByTestId('HarnessUpdatePanel.row')

describe('states', () => {
  it('is hidden when there is nothing to show', async () => {
    await mounted(updates({ available: [] }))
    expect(api.harnessState).toHaveBeenCalled()
    expect(screen.queryByTestId('HarnessUpdateButton')).toBeNull()
  })

  it('Automatically only reports: available updates alone do not show it', async () => {
    await mounted(updates({ mode: 'auto' }))
    expect(screen.queryByTestId('HarnessUpdateButton')).toBeNull()
  })

  it('Ask me with updates: a count badge and a tooltip naming them', async () => {
    await mounted(updates())
    expect(button()).toHaveAttribute('data-state', 'available')
    expect(screen.getByTestId('HarnessUpdateButton.badge')).toHaveTextContent('2')
    expect(button()).toHaveAttribute(
      'title',
      '2 harness updates — opencode 1.18.40 → 1.18.41, pi 0.87.1 → 0.87.4 · click to install'
    )
  })

  it('spins while the host runs an update', async () => {
    await mounted(updates({ status: { running: true, lastRunAt: RUN, results: [] } }))
    expect(button()).toHaveAttribute('data-state', 'running')
  })

  it('shows a check after a run that installed everything, fading after five seconds', async () => {
    await mounted(updates({ status: { running: true, lastRunAt: RUN, results: [] } }))
    vi.useFakeTimers()
    await nextRead(
      updates({
        available: [],
        status: {
          running: false,
          lastRunAt: RUN,
          results: [
            { id: 'opencode', from: '1.18.40', to: '1.18.41', status: 'installed' },
            { id: 'pi', from: '0.87.1', to: '0.87.4', status: 'installed' }
          ]
        }
      })
    )
    expect(button()).toHaveAttribute('data-state', 'done')
    expect(button().className).not.toContain('opacity-0')
    act(() => vi.advanceTimersByTime(DONE_VISIBLE_MS - 1))
    expect(button().className).not.toContain('opacity-0')
    act(() => vi.advanceTimersByTime(1))
    expect(button().className).toContain('opacity-0')
    act(() => vi.advanceTimersByTime(DONE_FADE_MS))
    expect(screen.queryByTestId('HarnessUpdateButton')).toBeNull()
  })

  it('a run that had already finished before this client looked shows no check', async () => {
    await mounted(
      updates({
        available: [],
        status: {
          running: false,
          lastRunAt: RUN,
          results: [{ id: 'pi', from: '0.87.1', to: '0.87.4', status: 'installed' }]
        }
      })
    )
    expect(screen.queryByTestId('HarnessUpdateButton')).toBeNull()
  })

  it('is amber after a failure, until dismissed', async () => {
    await mounted(
      updates({
        available: [{ id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }],
        status: {
          running: false,
          lastRunAt: RUN,
          results: [
            { id: 'opencode', from: '1.18.40', to: '1.18.41', status: 'installed' },
            {
              id: 'pi',
              from: '0.87.1',
              to: '0.87.4',
              status: 'failed',
              reason: "The download didn't match the published SHA-256"
            }
          ]
        }
      })
    )
    expect(button()).toHaveAttribute('data-state', 'failed')
    expect(button()).toHaveAttribute('title', '1 harness update failed')
    fireEvent.click(button())
    const pi = rows().find((r) => r.dataset.id === 'pi')!
    expect(pi).toHaveAttribute('data-state', 'failed')
    expect(within(pi).getByTestId('HarnessUpdatePanel.reason')).toHaveTextContent(
      "The download didn't match the published SHA-256"
    )
    expect(rows().find((r) => r.dataset.id === 'opencode')).toHaveAttribute(
      'data-state',
      'installed'
    )
    // Retry is offered while the failed version is still an update.
    expect(screen.getByTestId('HarnessUpdatePanel.updateAll')).toHaveAttribute('data-id', 'retry')
    fireEvent.click(within(pi).getByTestId('HarnessUpdatePanel.dismiss'))
    // Dismissed: pi is still an update, so the count shows again (Ask me).
    expect(button()).toHaveAttribute('data-state', 'available')
  })
})

describe('the panel', () => {
  it('Ask me: one click installs every update and opens the panel with progress', async () => {
    let finish!: (s: HarnessStateSnapshot) => void
    api.updateHarnesses.mockReturnValue(new Promise((r) => (finish = r)))
    await mounted(updates())
    fireEvent.click(button())
    expect(api.updateHarnesses).toHaveBeenCalledTimes(1)
    expect(button()).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('HarnessUpdatePanel')).toBeInTheDocument()
    // The host's progress arrives as events.
    act(() => {
      for (const cb of syncHandlers.get('harness:install-progress') ?? []) {
        cb({ id: 'opencode', version: '1.18.41', phase: 'verifying' })
      }
    })
    const opencode = rows().find((r) => r.dataset.id === 'opencode')!
    expect(opencode).toHaveAttribute('data-state', 'installing')
    expect(opencode).toHaveTextContent('1.18.40 → 1.18.41')
    expect(opencode).toHaveTextContent('Verifying')
    await act(async () => finish(snapshot(updates({ available: [] }))))
  })

  it('offers Update all in the panel when Ask me has updates and nothing runs', async () => {
    // Opened during a run; the run ends and new updates are found meanwhile.
    await mounted(updates({ status: { running: true, lastRunAt: RUN, results: [] } }))
    fireEvent.click(button())
    expect(screen.queryByTestId('HarnessUpdatePanel.updateAll')).toBeNull()
    await nextRead(updates())
    expect(rows().map((r) => [r.dataset.id, r.dataset.state, r.textContent])).toEqual([
      ['opencode', 'available', expect.stringContaining('1.18.40 → 1.18.41')],
      ['pi', 'available', expect.stringContaining('0.87.1 → 0.87.4')]
    ])
    const updateAll = screen.getByTestId('HarnessUpdatePanel.updateAll')
    expect(updateAll).toHaveAttribute('data-id', 'update')
    expect(updateAll).toHaveTextContent('Update all')
    fireEvent.click(updateAll)
    await act(async () => {})
    expect(api.updateHarnesses).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('HarnessUpdatePanel.note')).toHaveTextContent(
      'Running sessions keep their version'
    )
  })

  it('Automatically: the panel says updates install automatically, and offers no Update all', async () => {
    await mounted(updates({ mode: 'auto', status: { running: true, lastRunAt: RUN, results: [] } }))
    fireEvent.click(button())
    expect(screen.getByTestId('HarnessUpdatePanel.note')).toHaveTextContent(
      'Updates install automatically'
    )
    expect(screen.queryByTestId('HarnessUpdatePanel.updateAll')).toBeNull()
    expect(rows().map((r) => r.dataset.state)).toEqual(['waiting', 'waiting'])
  })

  it('"Harness settings" opens Settings › Harnesses › Installed and closes the panel', async () => {
    await mounted(updates({ status: { running: true, lastRunAt: RUN, results: [] } }))
    const seen: unknown[] = []
    const onOpen = (e: Event): void => {
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener('open-settings', onOpen)
    try {
      fireEvent.click(button())
      fireEvent.click(screen.getByTestId('HarnessUpdatePanel.settings'))
    } finally {
      window.removeEventListener('open-settings', onOpen)
    }
    expect(seen).toEqual([{ page: 'harnesses' }])
    expect(screen.queryByTestId('HarnessUpdatePanel')).toBeNull()
  })

  it('Check now asks the host for new versions', async () => {
    await mounted(updates({ status: { running: true, lastRunAt: RUN, results: [] } }))
    fireEvent.click(button())
    // Not while a run is in flight.
    expect(screen.getByTestId('HarnessUpdatePanel.check')).toBeDisabled()
    await nextRead(updates())
    fireEvent.click(screen.getByTestId('HarnessUpdatePanel.check'))
    await act(async () => {})
    expect(api.checkHarnessUpdates).toHaveBeenCalledTimes(1)
  })

  it('a remote invoke that times out is a run still going, not an error', async () => {
    api.updateHarnesses.mockRejectedValue(new Error('Timeout: harness:update-all'))
    await mounted(updates())
    fireEvent.click(button())
    await act(async () => {})
    expect(screen.queryByTestId('HarnessUpdatePanel.error')).toBeNull()
  })
})

describe('remote read-only', () => {
  function webConnection(method: string): void {
    api.platform = 'web'
    installEnrollBridge({
      authMethod: () => method as never,
      capableOrigin: () => false,
      browserCapable: () => false,
      enroll: async () => {},
      subscribe: () => () => {}
    })
  }

  it('a connection without admin sees the state, and a click only opens the panel', async () => {
    webConnection('none')
    await mounted(updates())
    expect(button()).toHaveAttribute('data-state', 'available')
    expect(button()).not.toHaveAttribute('title', expect.stringContaining('click to install'))
    fireEvent.click(button())
    expect(api.updateHarnesses).not.toHaveBeenCalled()
    expect(screen.getByTestId('HarnessUpdatePanel.readOnly')).toBeInTheDocument()
    expect(screen.getByTestId('HarnessUpdatePanel.updateAll')).toBeDisabled()
    expect(screen.getByTestId('HarnessUpdatePanel.check')).toBeDisabled()
  })

  it('a "Permission denied" latches read-only', async () => {
    api.updateHarnesses.mockRejectedValue(
      new Error('Permission denied: "harness:update-all" requires the "admin" capability')
    )
    await mounted(updates())
    fireEvent.click(button())
    await waitFor(() =>
      expect(screen.getByTestId('HarnessUpdatePanel.readOnly')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('HarnessUpdatePanel.error')).toBeNull()
  })
})

describe('in the footer', () => {
  it('sits left of Remote Access and takes the ml-auto while it shows', async () => {
    api.harnessState.mockResolvedValue(snapshot(updates()))
    render(<SettingsPanel />)
    await act(async () => {})
    const remote = screen.getByTestId('SettingsPanel.remoteAccess')
    const wrapper = screen.getByTestId('HarnessUpdate')
    expect(wrapper.className).toContain('ml-auto')
    expect(remote.className).not.toContain('ml-auto')
    // Document order: the update button, then Remote Access, then the cog.
    expect(wrapper.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await nextRead(updates({ available: [] }))
    expect(screen.queryByTestId('HarnessUpdate')).toBeNull()
    expect(screen.getByTestId('SettingsPanel.remoteAccess').className).toContain('ml-auto')
  })
})
