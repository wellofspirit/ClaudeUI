/**
 * Settings › Harnesses › Installed (ADR-082 arc 2, S5): the rows, the source
 * segment, the version dropdown, the install progress pill, Detect again, the
 * live re-read and the remote read-only mode — against a mocked `window.api`
 * and hand-fired sync events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  HarnessId,
  HarnessInstallProgress,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../../shared/harness-types'

// The store's two push subscriptions, captured so a test can fire them. The
// real registry DEFERS a listener while no transport client exists.
const syncHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    const set = syncHandlers.get(channel) ?? new Set()
    set.add(cb)
    syncHandlers.set(channel, set)
    return () => set.delete(cb)
  }
}))

import { HarnessesInstalled, HarnessesPageActions } from '../HarnessesInstalled'
import { CHANGED_DEBOUNCE_MS, harnessStore } from '../harness-store'
import { installEnrollBridge } from '../enroll-flow'

function fire(channel: string, ...args: unknown[]): void {
  act(() => {
    for (const cb of syncHandlers.get(channel) ?? []) cb(...args)
  })
}

const CLAUDE_TOO_OLD =
  'No usable System Claude Code found: Claude Code 2.1.198 is older than 2.1.275, the oldest ClaudeUI supports'

function entries(): Record<HarnessId, HarnessStateEntry> {
  return {
    claude: {
      id: 'claude',
      manifest: { tested: '2.1.280', floor: '2.1.275', ceiling: '3.0.0' },
      selection: { source: 'bundled' },
      resolved: {
        source: 'bundled',
        version: '2.1.280',
        path: '/opt/claudeui/vendor/claude-cli/bun-claude',
        available: true
      },
      system: {
        detectedAt: '2026-09-30T00:00:00.000Z',
        installs: [
          {
            displayPath: '/opt/tools/bin/claude',
            version: '2.1.198',
            verdict: 'too-old',
            reason: 'Claude Code 2.1.198 is older than 2.1.275, the oldest ClaudeUI supports',
            installKind: 'native-installer'
          }
        ],
        choice: { kind: 'fallback', reason: CLAUDE_TOO_OLD }
      },
      managed: [],
      bundledVersion: '2.1.280'
    },
    opencode: {
      id: 'opencode',
      manifest: { tested: '1.18.32', floor: '1.18.32', ceiling: '2.0.0' },
      selection: { source: 'managed', version: 'tested' },
      resolved: {
        source: 'managed',
        version: '1.18.32',
        path: '/opt/store/opencode/1.18.32/opencode',
        available: true
      },
      system: {
        detectedAt: '2026-09-30T00:00:00.000Z',
        installs: [
          {
            displayPath: '/opt/tools/bin/opencode',
            version: '1.18.40',
            verdict: 'untested',
            installKind: 'npm'
          }
        ],
        choice: { kind: 'ok', displayPath: '/opt/tools/bin/opencode', version: '1.18.40' }
      },
      managed: [
        { version: '1.18.32', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
      ]
    },
    pi: {
      id: 'pi',
      manifest: { tested: '0.87.4', floor: '0.87.4', ceiling: '1.0.0' },
      selection: { source: 'managed', version: 'tested' },
      resolved: {
        source: 'bundled',
        version: '0.87.4',
        path: '/opt/claudeui/vendor/pi-cli/pi',
        reason: 'pi 0.87.4 is not installed in ClaudeUI',
        available: true
      },
      system: {
        detectedAt: '2026-09-30T00:00:00.000Z',
        installs: [],
        choice: { kind: 'fallback', reason: 'No pi found on this computer' }
      },
      managed: []
    },
    codex: {
      id: 'codex',
      manifest: { tested: '0.156.0', floor: '0.156.0', ceiling: '1.0.0' },
      selection: { source: 'managed', version: 'tested' },
      resolved: {
        source: 'managed',
        version: '0.156.0',
        path: '/opt/store/codex/0.156.0/codex',
        available: true
      },
      system: {
        detectedAt: '2026-09-30T00:00:00.000Z',
        installs: [],
        choice: { kind: 'fallback', reason: 'No Codex found on this computer' }
      },
      managed: [
        { version: '0.156.0', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
      ]
    }
  }
}

function snapshot(patch: Partial<HarnessStateSnapshot> = {}): HarnessStateSnapshot {
  return {
    harnesses: entries(),
    detection: { running: false, lastRunAt: '2026-09-30T00:00:00.000Z' },
    installs: [],
    ...patch
  }
}

const api = {
  platform: 'win32' as string,
  harnessState: vi.fn<() => Promise<HarnessStateSnapshot>>(),
  harnessVersions: vi.fn(),
  setHarnessSelection: vi.fn(),
  installHarness: vi.fn(),
  cancelHarnessInstall: vi.fn(),
  detectHarnesses: vi.fn()
}

beforeEach(() => {
  syncHandlers.clear()
  harnessStore.resetForTests()
  installEnrollBridge(null)
  for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockReset()
  api.platform = 'win32'
  api.harnessState.mockResolvedValue(snapshot())
  api.harnessVersions.mockImplementation(async (id: HarnessId) => ({
    status: 'ok',
    id,
    latest: id === 'opencode' ? '1.18.40' : '0.88.0',
    available: id === 'opencode' ? ['1.18.40', '1.18.32'] : ['0.88.0', '0.87.4']
  }))
  api.setHarnessSelection.mockImplementation(async (id: HarnessId, selection) => ({
    ...entries()[id],
    selection
  }))
  api.cancelHarnessInstall.mockImplementation(async (id: HarnessId, version: string) => ({
    status: 'cancelled',
    id,
    version
  }))
  api.detectHarnesses.mockResolvedValue(snapshot())
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})

afterEach(() => {
  cleanup()
  harnessStore.resetForTests()
  installEnrollBridge(null)
})

function renderPage(): void {
  render(
    <>
      <HarnessesPageActions />
      <HarnessesInstalled />
    </>
  )
}

const row = (id: HarnessId): HTMLElement =>
  screen.getAllByTestId('HarnessRow').find((el) => el.dataset.id === id)!

const sourceOption = (id: HarnessId, value: string): HTMLElement =>
  within(row(id))
    .getAllByTestId('HarnessRow.sourceOption')
    .find((el) => el.dataset.id === value)!

const line = (id: HarnessId): HTMLElement => within(row(id)).getByTestId('HarnessRow.line')

/** pi selected on an exact version that is neither installed nor the bundled copy's. */
function piWants(version: string): HarnessStateSnapshot {
  const s = snapshot()
  s.harnesses.pi = {
    ...s.harnesses.pi,
    selection: { source: 'managed', version },
    resolved: { ...s.harnesses.pi.resolved, reason: `pi ${version} is not installed in ClaudeUI` }
  }
  return s
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('HarnessRow')).toHaveLength(4))
}

const progress = (patch: Partial<HarnessInstallProgress>): HarnessInstallProgress => ({
  id: 'pi',
  version: '0.87.4',
  phase: 'downloading',
  receivedBytes: 5 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  ...patch
})

describe('rows', () => {
  it('shows Loading… until the first read lands', async () => {
    let resolve!: (s: HarnessStateSnapshot) => void
    api.harnessState.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    renderPage()
    expect(screen.getByTestId('HarnessesInstalled.status')).toHaveAttribute('data-id', 'loading')
    await act(async () => resolve(snapshot()))
    await loaded()
  })

  it('renders one row per harness, in order, with its source and version controls', async () => {
    renderPage()
    await loaded()
    expect(screen.getAllByTestId('HarnessRow').map((el) => el.dataset.id)).toEqual([
      'claude',
      'opencode',
      'pi',
      'codex'
    ])
    // Claude Code: Bundled | System, the bundled version locked.
    expect(within(row('claude')).getByTestId('HarnessRow.source')).toHaveAttribute(
      'role',
      'radiogroup'
    )
    expect(sourceOption('claude', 'bundled')).toHaveTextContent('Bundled')
    expect(sourceOption('claude', 'bundled')).toHaveAttribute('aria-checked', 'true')
    expect(within(row('claude')).getByTestId('HarnessRow.lockedVersion')).toHaveTextContent(
      'Bundled · 2.1.280'
    )
    // opencode, pi: ClaudeUI | System, a version dropdown on the ClaudeUI side.
    expect(sourceOption('opencode', 'managed')).toHaveTextContent('ClaudeUI')
    expect(within(row('opencode')).getByTestId('HarnessRow.version.trigger')).toHaveTextContent(
      'Tested · 1.18.32'
    )
    expect(within(row('pi')).getByTestId('HarnessRow.version')).toBeInTheDocument()
    // Codex: ClaudeUI locked to the pin.
    expect(within(row('codex')).getByTestId('HarnessRow.lockedVersion')).toHaveTextContent(
      '0.156.0'
    )
    expect(within(row('codex')).queryByTestId('HarnessRow.version')).toBeNull()
  })

  it('describes each row in ONE line for the active side, the path only in its title', async () => {
    renderPage()
    await loaded()
    const claude = line('claude')
    expect(claude).toHaveAttribute('data-state', 'running')
    expect(claude).toHaveTextContent(
      'Bundled with ClaudeUI · 2.1.280 · patched: voice and live streaming'
    )
    expect(claude).not.toHaveTextContent('/opt')
    expect(claude.getAttribute('title')).toContain('/opt/claudeui/vendor/claude-cli/bun-claude')
    expect(line('opencode')).toHaveTextContent("ClaudeUI's copy · 1.18.32")
    expect(line('codex')).toHaveTextContent('Exact version this ClaudeUI release speaks · 0.156.0')
    // The System reason is not a row line.
    expect(claude).not.toHaveTextContent('older than')
  })

  it('a bundled copy of the selected version satisfies it: no "not installed", no Install', async () => {
    renderPage()
    await loaded()
    expect(line('pi')).toHaveAttribute('data-state', 'running')
    expect(line('pi')).toHaveTextContent('Bundled with ClaudeUI · 0.87.4')
    expect(line('pi')).not.toHaveTextContent('not installed')
    expect(within(row('pi')).queryByTestId('HarnessRow.install')).toBeNull()
  })

  it('disables System when nothing usable was found; its tooltip says why', async () => {
    renderPage()
    await loaded()
    expect(sourceOption('claude', 'system')).toHaveAttribute('aria-disabled', 'true')
    expect(sourceOption('claude', 'system')).toHaveAttribute('title', CLAUDE_TOO_OLD)
    expect(sourceOption('claude', 'system')).toHaveAccessibleDescription(CLAUDE_TOO_OLD)
    // Nothing detected at all: the tooltip says so, and there is no disclosure.
    expect(sourceOption('pi', 'system')).toHaveAttribute('aria-disabled', 'true')
    expect(sourceOption('pi', 'system')).toHaveAttribute('title', 'No pi found on this computer')
    expect(within(row('pi')).queryByTestId('HarnessRow.detectedToggle')).toBeNull()
    expect(sourceOption('codex', 'system')).toHaveAttribute('aria-disabled', 'true')
    // A disabled radio does nothing when clicked.
    fireEvent.click(sourceOption('claude', 'system'))
    expect(api.setHarnessSelection).not.toHaveBeenCalled()
    // opencode has a usable System install.
    expect(sourceOption('opencode', 'system')).not.toHaveAttribute('aria-disabled')
    expect(sourceOption('opencode', 'system')).not.toHaveAttribute('title')
  })

  it('lists what detection found, with each verdict', async () => {
    renderPage()
    await loaded()
    fireEvent.click(within(row('claude')).getByTestId('HarnessRow.detectedToggle'))
    const found = within(row('claude')).getAllByTestId('HarnessRow.detected')
    expect(found).toHaveLength(1)
    expect(found[0]).toHaveTextContent('too old')
    expect(found[0]).toHaveTextContent('2.1.198')
    expect(found[0]).toHaveTextContent('/opt/tools/bin/claude')
  })

  it('marks a running System install tested or untested', async () => {
    const s = snapshot()
    s.harnesses.opencode = {
      ...s.harnesses.opencode,
      selection: { source: 'system', version: '1.18.30' },
      resolved: {
        source: 'system',
        version: '1.18.40',
        path: '/opt/tools/lib/opencode',
        displayPath: '/opt/tools/bin/opencode',
        available: true
      }
    }
    api.harnessState.mockResolvedValue(s)
    renderPage()
    await loaded()
    expect(within(row('opencode')).getByTestId('HarnessRow.verdict')).toHaveTextContent('untested')
    expect(line('opencode')).toHaveTextContent(
      '/opt/tools/bin/opencode · 1.18.40, newer than the 1.18.32 ClaudeUI tested'
    )
  })

  it('an unusable System selection becomes the line: the reason, and what runs instead', async () => {
    const s = snapshot()
    s.harnesses.opencode = {
      ...s.harnesses.opencode,
      selection: { source: 'system' },
      resolved: {
        source: 'bundled',
        version: '1.18.32',
        path: '/opt/claudeui/vendor/opencode-cli/opencode',
        reason: 'No usable System opencode found',
        available: true
      }
    }
    api.harnessState.mockResolvedValue(s)
    renderPage()
    await loaded()
    expect(line('opencode')).toHaveAttribute('data-state', 'fallback')
    expect(line('opencode')).toHaveTextContent(
      'No usable System opencode found; running the bundled copy'
    )
    expect(within(row('opencode')).queryByTestId('HarnessRow.install')).toBeNull()
  })

  it('keeps the last ClaudeUI choice, greyed, while System is selected', async () => {
    const s = snapshot()
    s.harnesses.opencode = {
      ...s.harnesses.opencode,
      selection: { source: 'system', version: '1.18.30' }
    }
    api.harnessState.mockResolvedValue(s)
    renderPage()
    await loaded()
    expect(sourceOption('opencode', 'system')).toHaveAttribute('aria-checked', 'true')
    expect(within(row('opencode')).getByTestId('HarnessRow.versionSlot')).toHaveAttribute(
      'data-kept',
      'true'
    )
    const trigger = within(row('opencode')).getByTestId('HarnessRow.version.trigger')
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('1.18.30')
  })

  it('a selected version that is neither installed nor bundled says so, and installs', async () => {
    api.harnessState.mockResolvedValue(piWants('0.88.0'))
    api.installHarness.mockReturnValue(new Promise(() => {}))
    renderPage()
    await loaded()
    expect(line('pi')).toHaveAttribute('data-state', 'not-installed')
    expect(line('pi')).toHaveTextContent('0.88.0 is not installed')
    fireEvent.click(within(row('pi')).getByTestId('HarnessRow.install'))
    expect(api.installHarness).toHaveBeenCalledWith('pi', '0.88.0')
    // The line now shows the install, over a bar, instead of the link.
    await waitFor(() => expect(line('pi')).toHaveAttribute('data-state', 'installing'))
    expect(within(row('pi')).queryByTestId('HarnessRow.install')).toBeNull()
    expect(within(row('pi')).getByTestId('HarnessRow.progress')).toHaveAttribute(
      'data-id',
      'pi@0.88.0'
    )
  })
})

describe('writes', () => {
  it('switching source saves the selection with the right payload', async () => {
    renderPage()
    await loaded()
    fireEvent.click(sourceOption('opencode', 'system'))
    expect(api.setHarnessSelection).toHaveBeenCalledWith('opencode', { source: 'system' })
    await waitFor(() =>
      expect(sourceOption('opencode', 'system')).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('the segment is a keyboard radiogroup: an arrow key moves and selects', async () => {
    renderPage()
    await loaded()
    const current = sourceOption('opencode', 'managed')
    expect(current).toHaveAttribute('tabindex', '0')
    expect(sourceOption('opencode', 'system')).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(current, { key: 'ArrowRight' })
    expect(api.setHarnessSelection).toHaveBeenCalledWith('opencode', { source: 'system' })
  })

  it('switching Claude Code back to Bundled sends no version', async () => {
    const s = snapshot()
    s.harnesses.claude = { ...s.harnesses.claude, selection: { source: 'system' } }
    api.harnessState.mockResolvedValue(s)
    renderPage()
    await loaded()
    fireEvent.click(sourceOption('claude', 'bundled'))
    expect(api.setHarnessSelection).toHaveBeenCalledWith('claude', { source: 'bundled' })
  })

  it('the version menu offers Latest, Tested and exact versions, marking installed ones', async () => {
    renderPage()
    await loaded()
    await waitFor(() => expect(api.harnessVersions).toHaveBeenCalledWith('opencode'))
    fireEvent.click(within(row('opencode')).getByTestId('HarnessRow.version.trigger'))
    const menu = screen.getByTestId('HarnessRow.version.menu')
    expect(
      within(menu)
        .getAllByTestId('HarnessRow.version.option')
        .map((el) => el.dataset.id)
    ).toEqual(['latest', 'tested', '1.18.40', '1.18.32'])
    expect(
      within(menu)
        .getAllByTestId('HarnessRow.version.section')
        .map((el) => el.textContent)
    ).toEqual(['Keep up to date', 'Stay on a version'])
    const option = (v: string): HTMLElement =>
      within(menu)
        .getAllByTestId('HarnessRow.version.option')
        .find((el) => el.dataset.id === v)!
    expect(option('latest')).toHaveTextContent("upstream's newest · 1.18.40")
    expect(option('latest')).toHaveTextContent('untested')
    expect(option('1.18.32')).toHaveTextContent('installed')
    expect(option('1.18.40')).not.toHaveTextContent('installed')
  })

  it('choosing a version that is not installed saves it and installs it', async () => {
    api.installHarness.mockReturnValue(new Promise(() => {}))
    renderPage()
    await loaded()
    await waitFor(() => expect(api.harnessVersions).toHaveBeenCalledWith('opencode'))
    fireEvent.click(within(row('opencode')).getByTestId('HarnessRow.version.trigger'))
    fireEvent.click(
      screen.getAllByTestId('HarnessRow.version.option').find((el) => el.dataset.id === '1.18.40')!
    )
    await waitFor(() => expect(api.installHarness).toHaveBeenCalledWith('opencode', '1.18.40'))
    expect(api.setHarnessSelection).toHaveBeenCalledWith('opencode', {
      source: 'managed',
      version: '1.18.40'
    })
  })

  it('choosing an installed version only saves it', async () => {
    const s = snapshot()
    s.harnesses.opencode = {
      ...s.harnesses.opencode,
      selection: { source: 'managed', version: '1.18.40' }
    }
    api.harnessState.mockResolvedValue(s)
    renderPage()
    await loaded()
    fireEvent.click(within(row('opencode')).getByTestId('HarnessRow.version.trigger'))
    fireEvent.click(
      screen.getAllByTestId('HarnessRow.version.option').find((el) => el.dataset.id === 'tested')!
    )
    await waitFor(() =>
      expect(api.setHarnessSelection).toHaveBeenCalledWith('opencode', {
        source: 'managed',
        version: 'tested'
      })
    )
    expect(api.installHarness).not.toHaveBeenCalled()
  })

  it('a refused selection reverts the row and says why', async () => {
    api.setHarnessSelection.mockRejectedValue(
      new Error(
        "Error invoking remote method 'harness:set-selection': Error: opencode 9.0.0 is not supported"
      )
    )
    renderPage()
    await loaded()
    fireEvent.click(sourceOption('opencode', 'system'))
    await waitFor(() =>
      expect(within(row('opencode')).getByTestId('HarnessRow.error')).toHaveTextContent(
        'opencode 9.0.0 is not supported'
      )
    )
    expect(sourceOption('opencode', 'managed')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('the progress pill', () => {
  it('one install shows its phase and bytes, and cancels', async () => {
    renderPage()
    await loaded()
    expect(screen.queryByTestId('HarnessInstallPill')).toBeNull()
    fire('harness:install-progress', progress({}))
    const pill = screen.getByTestId('HarnessInstallPill')
    expect(pill).toHaveAttribute('data-state', 'active')
    expect(pill).toHaveTextContent('pi 0.87.4')
    expect(within(pill).getByTestId('HarnessInstallPill.progress')).toHaveTextContent(
      'Downloading 5.0 MB of 10.0 MB'
    )
    expect(line('pi')).toHaveAttribute('data-state', 'installing')
    expect(line('pi')).toHaveTextContent('Installing 0.87.4 · Downloading 5.0 MB of 10.0 MB')
    expect(within(row('pi')).getByTestId('HarnessRow.progress')).toBeInTheDocument()

    fireEvent.click(within(pill).getByTestId('HarnessInstallPill.cancel'))
    expect(api.cancelHarnessInstall).toHaveBeenCalledWith('pi', '0.87.4')
    expect(screen.queryByTestId('HarnessInstallPill')).toBeNull()
    // The abort's own `failed`, and reports still in the pipe, stay gone.
    fire('harness:install-progress', progress({ phase: 'downloading' }))
    fire(
      'harness:install-progress',
      progress({ phase: 'failed', reason: 'The install was cancelled' })
    )
    expect(screen.queryByTestId('HarnessInstallPill')).toBeNull()
  })

  it('several installs show a count that opens the list', async () => {
    renderPage()
    await loaded()
    fire('harness:install-progress', progress({}))
    fire('harness:install-progress', progress({ id: 'opencode', version: '1.18.40' }))
    const pill = screen.getByTestId('HarnessInstallPill')
    expect(pill).toHaveAttribute('data-state', 'several')
    expect(within(pill).getByTestId('HarnessInstallPill.count')).toHaveTextContent('2 installs')
    expect(screen.queryByTestId('HarnessInstallPill.list')).toBeNull()
    fireEvent.click(within(pill).getByTestId('HarnessInstallPill.count'))
    const items = within(screen.getByTestId('HarnessInstallPill.list')).getAllByTestId(
      'HarnessInstallPill.item'
    )
    expect(items.map((el) => el.dataset.id)).toEqual(['pi@0.87.4', 'opencode@1.18.40'])
    fireEvent.click(within(items[1]).getByTestId('HarnessInstallPill.cancel'))
    expect(api.cancelHarnessInstall).toHaveBeenCalledWith('opencode', '1.18.40')
  })

  it('a failed install shows its reason until dismissed', async () => {
    renderPage()
    await loaded()
    fire('harness:install-progress', progress({ phase: 'failed', reason: 'checksum mismatch' }))
    const pill = screen.getByTestId('HarnessInstallPill')
    expect(pill).toHaveAttribute('data-state', 'failed')
    expect(within(pill).getByTestId('HarnessInstallPill.reason')).toHaveTextContent(
      'checksum mismatch'
    )
    // A re-read does not drop a failure: the snapshot lists only installs in flight.
    fire('harness:changed', { id: 'pi' })
    await waitFor(() => expect(api.harnessState).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('HarnessInstallPill')).toHaveAttribute('data-state', 'failed')
    fireEvent.click(within(pill).getByTestId('HarnessInstallPill.dismiss'))
    expect(screen.queryByTestId('HarnessInstallPill')).toBeNull()
  })

  it('a finished install leaves the pill and re-reads', async () => {
    renderPage()
    await loaded()
    fire('harness:install-progress', progress({}))
    fire('harness:install-progress', progress({ phase: 'done' }))
    expect(screen.queryByTestId('HarnessInstallPill')).toBeNull()
    await waitFor(() => expect(api.harnessState).toHaveBeenCalledTimes(2))
  })

  it('a replayed progress event the snapshot does not list is dropped on the re-read', async () => {
    renderPage()
    await loaded()
    fire('harness:install-progress', progress({}))
    expect(screen.getByTestId('HarnessInstallPill')).toBeInTheDocument()
    await waitFor(() => expect(api.harnessState).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('HarnessInstallPill')).toBeNull())
  })

  it('the snapshot’s installs show on the first read', async () => {
    api.harnessState.mockResolvedValue(
      snapshot({ installs: [progress({ id: 'codex', version: '0.156.0', phase: 'verifying' })] })
    )
    renderPage()
    await loaded()
    expect(screen.getByTestId('HarnessInstallPill')).toHaveAttribute('data-phase', 'verifying')
  })

  it('an install the web transport stopped waiting for is still running, not failed', async () => {
    api.installHarness.mockRejectedValue(new Error('Timeout: harness:install'))
    api.harnessState.mockResolvedValue(piWants('0.88.0'))
    renderPage()
    await loaded()
    fireEvent.click(within(row('pi')).getByTestId('HarnessRow.install'))
    await waitFor(() => expect(api.installHarness).toHaveBeenCalled())
    // The host still lists it: the re-read after the timeout keeps it.
    api.harnessState.mockResolvedValue({
      ...piWants('0.88.0'),
      installs: [progress({ version: '0.88.0', phase: 'downloading' })]
    })
    await waitFor(() => expect(api.harnessState).toHaveBeenCalledTimes(2))
    const pill = screen.getByTestId('HarnessInstallPill')
    expect(pill).toHaveAttribute('data-state', 'active')
    expect(within(row('pi')).queryByTestId('HarnessRow.error')).toBeNull()
  })
})

describe('Detect again', () => {
  it('shows the running state while the detection runs, then re-reads', async () => {
    let finish!: (s: HarnessStateSnapshot) => void
    api.detectHarnesses.mockReturnValue(new Promise((r) => (finish = r)))
    renderPage()
    await loaded()
    const button = screen.getByTestId('HarnessesPageActions.detect')
    expect(button).toHaveTextContent('Detect again')
    fireEvent.click(button)
    expect(api.detectHarnesses).toHaveBeenCalled()
    expect(button).toHaveTextContent('Detecting…')
    expect(button).toBeDisabled()
    await act(async () => finish(snapshot()))
    await waitFor(() => expect(button).toHaveTextContent('Detect again'))
    expect(api.harnessState).toHaveBeenCalledTimes(2)
  })

  it("reads the host's own detection from the snapshot", async () => {
    api.harnessState.mockResolvedValue(snapshot({ detection: { running: true } }))
    renderPage()
    await loaded()
    expect(screen.getByTestId('HarnessesPageActions.detect')).toHaveTextContent('Detecting…')
  })

  it('a detection the web transport stopped waiting for keeps the snapshot’s running state', async () => {
    api.detectHarnesses.mockRejectedValue(new Error('Timeout: harness:detect'))
    renderPage()
    await loaded()
    api.harnessState.mockResolvedValue(snapshot({ detection: { running: true } }))
    fireEvent.click(screen.getByTestId('HarnessesPageActions.detect'))
    await waitFor(() => expect(api.harnessState).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('HarnessesPageActions.detect')).toHaveTextContent('Detecting…')
    expect(screen.queryByTestId('HarnessesPageActions.error')).toBeNull()
  })
})

describe('live updates', () => {
  it('re-reads on harness:changed, once per burst', async () => {
    renderPage()
    await loaded()
    expect(api.harnessState).toHaveBeenCalledTimes(1)
    const s = snapshot()
    s.harnesses.claude = {
      ...s.harnesses.claude,
      system: {
        ...s.harnesses.claude.system,
        choice: { kind: 'ok', displayPath: '/opt/tools/bin/claude', version: '2.1.290' }
      }
    }
    api.harnessState.mockResolvedValue(s)
    // One detection fires one event per harness.
    fire('harness:changed', { id: 'claude' })
    fire('harness:changed', { id: 'opencode' })
    fire('harness:changed', { id: 'pi' })
    await waitFor(() =>
      expect(sourceOption('claude', 'system')).not.toHaveAttribute('aria-disabled')
    )
    expect(api.harnessState).toHaveBeenCalledTimes(2)
    await new Promise((r) => setTimeout(r, CHANGED_DEBOUNCE_MS * 2))
    expect(api.harnessState).toHaveBeenCalledTimes(2)
  })

  it('stops listening when the page goes away', async () => {
    const view = render(<HarnessesInstalled />)
    await loaded()
    view.unmount()
    expect(syncHandlers.get('harness:changed')?.size ?? 0).toBe(0)
    expect(syncHandlers.get('harness:install-progress')?.size ?? 0).toBe(0)
  })
})

describe('remote read-only', () => {
  function webConnection(method: string | undefined): void {
    api.platform = 'web'
    installEnrollBridge({
      authMethod: () => method as never,
      capableOrigin: () => false,
      browserCapable: () => false,
      enroll: async () => {},
      subscribe: () => () => {}
    })
  }

  it('a connection without admin sees the page with every write disabled', async () => {
    webConnection('none')
    api.harnessState.mockResolvedValue(piWants('0.88.0'))
    renderPage()
    await loaded()
    expect(screen.getByTestId('HarnessesInstalled.readOnly')).toHaveTextContent(
      'needs an admin connection'
    )
    expect(sourceOption('opencode', 'system')).toHaveAttribute('aria-disabled', 'true')
    expect(sourceOption('opencode', 'managed')).toHaveAttribute('aria-disabled', 'true')
    expect(within(row('opencode')).getByTestId('HarnessRow.version.trigger')).toBeDisabled()
    expect(within(row('pi')).getByTestId('HarnessRow.install')).toBeDisabled()
    expect(screen.getByTestId('HarnessesPageActions.detect')).toBeDisabled()
    fire('harness:install-progress', progress({}))
    expect(screen.getByTestId('HarnessInstallPill.cancel')).toBeDisabled()
  })

  it('a passkey connection holds admin and can write', async () => {
    webConnection('webauthn')
    renderPage()
    await loaded()
    expect(screen.queryByTestId('HarnessesInstalled.readOnly')).toBeNull()
    expect(sourceOption('opencode', 'system')).not.toHaveAttribute('aria-disabled')
  })

  it('a "Permission denied" latches read-only instead of an error per click', async () => {
    api.setHarnessSelection.mockRejectedValue(
      new Error('Permission denied: "harness:set-selection" requires the "admin" capability')
    )
    renderPage()
    await loaded()
    fireEvent.click(sourceOption('opencode', 'system'))
    await waitFor(() =>
      expect(screen.getByTestId('HarnessesInstalled.readOnly')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('HarnessRow.error')).toBeNull()
    expect(sourceOption('pi', 'managed')).toHaveAttribute('aria-disabled', 'true')
  })
})
