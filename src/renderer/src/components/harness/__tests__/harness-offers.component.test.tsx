/**
 * The S7b offers (ADR-082 §8; mockup `b51cb3df`) against a mocked
 * `window.api` and hand-fired sync events:
 *
 *  - the one-time upgrade sheet: rows start unchecked, Install is disabled
 *    until one is checked and then counts them, Not now answers without
 *    installing, Install installs each checked harness and answers, Escape
 *    only closes it, and a connection without `admin` never sees it;
 *  - the composer banner in each state, and its buttons;
 *  - the harness picker's marks: every harness listed (Codex too), a chip on
 *    one that is not installed, disabled where it cannot run;
 *  - the Settings "Install <version>" link on a not-installed row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  HarnessId,
  HarnessInstallProgress,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../../shared/harness-types'

const syncHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    const set = syncHandlers.get(channel) ?? new Set()
    set.add(cb)
    syncHandlers.set(channel, set)
    return () => set.delete(cb)
  }
}))

import { HarnessUpgradeSheet } from '../HarnessUpgradeSheet'
import { HarnessInstallBanner } from '../HarnessInstallBanner'
import { EnginePicker } from '../../shared/InlinePickers'
import { NotInstalledRow } from '../../SettingsDialog/HarnessInstallLink'
import { harnessStore } from '../../SettingsDialog/harness-store'
import { installEnrollBridge } from '../../SettingsDialog/enroll-flow'

function fire(channel: string, ...args: unknown[]): void {
  act(() => {
    for (const cb of syncHandlers.get(channel) ?? []) cb(...args)
  })
}

const TESTED: Record<HarnessId, string> = {
  claude: '2.1.280',
  opencode: '1.18.32',
  pi: '0.87.4',
  codex: '0.156.0'
}

function ready(id: HarnessId): HarnessStateEntry {
  return {
    id,
    manifest: { tested: TESTED[id], floor: TESTED[id], ceiling: '9.0.0' },
    selection: id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' },
    resolved: {
      source: id === 'claude' ? 'bundled' : 'managed',
      version: TESTED[id],
      path: `/store/${id}`,
      available: true
    },
    system: {
      detectedAt: '2026-09-30T00:00:00.000Z',
      installs: [],
      choice: { kind: 'fallback', reason: `No ${id} found on this computer` }
    },
    managed: [
      { version: TESTED[id], verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
    ],
    installable: id !== 'claude'
  }
}

function missing(id: HarnessId, patch: Partial<HarnessStateEntry> = {}): HarnessStateEntry {
  return {
    ...ready(id),
    resolved: {
      source: 'managed',
      version: null,
      path: null,
      reason: `${id} ${TESTED[id]} is not installed`,
      available: false
    },
    managed: [],
    ...patch
  }
}

function snapshot(
  harnesses: Partial<Record<HarnessId, HarnessStateEntry>> = {},
  patch: Partial<HarnessStateSnapshot> = {}
): HarnessStateSnapshot {
  return {
    harnesses: {
      claude: ready('claude'),
      opencode: ready('opencode'),
      pi: ready('pi'),
      codex: ready('codex'),
      ...harnesses
    },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt: { pending: false, candidates: [] },
    ...patch
  }
}

/** opencode (14 sessions) and pi (3) missing, Codex (2) missing: the sheet's three rows. */
function pendingSheet(): HarnessStateSnapshot {
  return snapshot(
    { opencode: missing('opencode'), pi: missing('pi'), codex: missing('codex') },
    {
      upgradePrompt: {
        pending: true,
        candidates: [
          { id: 'opencode', sessions: 14 },
          { id: 'pi', sessions: 3 },
          { id: 'codex', sessions: 2 }
        ]
      }
    }
  )
}

const api = {
  platform: 'win32' as string,
  harnessState: vi.fn<() => Promise<HarnessStateSnapshot>>(),
  installHarness: vi.fn(),
  cancelHarnessInstall: vi.fn(),
  setHarnessSelection: vi.fn(),
  answerHarnessUpgradePrompt: vi.fn()
}

beforeEach(() => {
  syncHandlers.clear()
  harnessStore.resetForTests()
  installEnrollBridge(null)
  for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockReset()
  api.platform = 'win32'
  api.harnessState.mockResolvedValue(snapshot())
  // Installs stay in flight unless a test settles them.
  api.installHarness.mockImplementation(() => new Promise(() => {}))
  api.answerHarnessUpgradePrompt.mockResolvedValue({ pending: false, candidates: [] })
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})

afterEach(() => {
  cleanup()
  harnessStore.resetForTests()
  installEnrollBridge(null)
})

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ── The upgrade sheet ─────────────────────────────────────────────────

describe('HarnessUpgradeSheet', () => {
  async function renderSheet(state = pendingSheet()): Promise<void> {
    api.harnessState.mockResolvedValue(state)
    render(<HarnessUpgradeSheet />)
    await flush()
  }

  const checkbox = (id: HarnessId): HTMLInputElement =>
    screen
      .getAllByTestId('HarnessUpgradeSheet.checkbox')
      .find((el) => el.getAttribute('data-id') === id) as HTMLInputElement

  it('lists each candidate with its version and session count, every row unchecked', async () => {
    await renderSheet()
    const rows = screen.getAllByTestId('HarnessUpgradeSheet.row')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['opencode', 'pi', 'codex'])
    expect(within(rows[0]).getByTestId('HarnessUpgradeSheet.version')).toHaveTextContent('1.18.32')
    expect(within(rows[0]).getByTestId('HarnessUpgradeSheet.sessions')).toHaveTextContent(
      '14 sessions'
    )
    for (const id of ['opencode', 'pi', 'codex'] as const) expect(checkbox(id).checked).toBe(false)
    // No download sizes anywhere.
    expect(screen.getByTestId('HarnessUpgradeSheet').textContent).not.toMatch(/MB/)
  })

  it('keeps Install disabled until a row is checked, then counts the checked rows', async () => {
    await renderSheet()
    const install = screen.getByTestId('HarnessUpgradeSheet.install')
    expect(install).toBeDisabled()
    expect(install).toHaveTextContent(/^Install$/)
    fireEvent.click(checkbox('opencode'))
    fireEvent.click(checkbox('codex'))
    expect(install).toBeEnabled()
    expect(install).toHaveTextContent('Install 2')
    fireEvent.click(checkbox('codex'))
    expect(install).toHaveTextContent('Install 1')
  })

  it('Not now answers without installing, and the sheet goes', async () => {
    await renderSheet()
    fireEvent.click(checkbox('pi'))
    fireEvent.click(screen.getByTestId('HarnessUpgradeSheet.notNow'))
    await flush()
    expect(api.answerHarnessUpgradePrompt).toHaveBeenCalledTimes(1)
    expect(api.installHarness).not.toHaveBeenCalled()
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
  })

  it('Install installs each checked harness at its version, answers, and closes', async () => {
    await renderSheet()
    fireEvent.click(checkbox('opencode'))
    fireEvent.click(checkbox('codex'))
    fireEvent.click(screen.getByTestId('HarnessUpgradeSheet.install'))
    await flush()
    expect(api.installHarness.mock.calls).toEqual([
      ['opencode', '1.18.32'],
      ['codex', '0.156.0']
    ])
    expect(api.answerHarnessUpgradePrompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
    // Progress continues in the shared install list (the pill, the banner).
    expect(harnessStore.getState().installs.map((p) => p.id)).toEqual(['opencode', 'codex'])
  })

  it('Escape closes it for this run without answering', async () => {
    await renderSheet()
    fireEvent.keyDown(document, { key: 'Escape' })
    await flush()
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
    expect(api.answerHarnessUpgradePrompt).not.toHaveBeenCalled()
  })

  it('is not shown before the host says it is pending', async () => {
    await renderSheet(snapshot({ opencode: missing('opencode') }))
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
  })

  it('is never shown to a web connection without admin', async () => {
    webConnection('none')
    await renderSheet()
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
  })

  it('shows on a web admin connection, and a refusal hides it without an error', async () => {
    webConnection('webauthn')
    api.answerHarnessUpgradePrompt.mockRejectedValue(
      new Error(
        'Permission denied: "harness:answer-upgrade-prompt" requires the "admin" capability'
      )
    )
    await renderSheet()
    fireEvent.click(screen.getByTestId('HarnessUpgradeSheet.notNow'))
    await flush()
    expect(screen.queryByTestId('HarnessUpgradeSheet')).toBeNull()
    expect(harnessStore.getState().loadError).toBeNull()
  })
})

// ── The composer banner ───────────────────────────────────────────────

describe('HarnessInstallBanner', () => {
  async function renderBanner(
    state: HarnessStateSnapshot,
    id: HarnessId = 'opencode'
  ): Promise<void> {
    api.harnessState.mockResolvedValue(state)
    render(<HarnessInstallBanner engineId={id} />)
    await flush()
  }

  const banner = (): HTMLElement => screen.getByTestId('HarnessInstallBanner')

  it('renders nothing for a harness that runs', async () => {
    await renderBanner(snapshot())
    expect(screen.queryByTestId('HarnessInstallBanner')).toBeNull()
  })

  it('offers the tested copy with Install and Settings…', async () => {
    const opened = vi.fn()
    window.addEventListener('open-settings', opened)
    try {
      await renderBanner(snapshot({ opencode: missing('opencode') }))
      expect(banner()).toHaveAttribute('data-state', 'offer')
      expect(banner()).toHaveTextContent("opencode isn't installed.")
      expect(banner()).toHaveTextContent("ClaudeUI's tested copy is 1.18.32.")
      fireEvent.click(screen.getByTestId('HarnessInstallBanner.settings'))
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'harnesses' })
      fireEvent.click(screen.getByTestId('HarnessInstallBanner.install'))
      await flush()
      expect(api.installHarness).toHaveBeenCalledWith('opencode', '1.18.32')
      // The click is followed through: the banner now shows the install.
      expect(banner()).toHaveAttribute('data-state', 'installing')
    } finally {
      window.removeEventListener('open-settings', opened)
    }
  })

  it('shows an install in flight with its progress and a Cancel', async () => {
    const active: HarnessInstallProgress = {
      id: 'opencode',
      version: '1.18.32',
      phase: 'downloading',
      receivedBytes: 18 * 1024 * 1024,
      totalBytes: 45 * 1024 * 1024
    }
    api.cancelHarnessInstall.mockResolvedValue({
      status: 'cancelled',
      id: 'opencode',
      version: '1.18.32'
    })
    await renderBanner(snapshot({ opencode: missing('opencode') }, { installs: [active] }))
    expect(banner()).toHaveAttribute('data-state', 'installing')
    expect(screen.getByTestId('HarnessInstallBanner.progress')).toHaveTextContent(
      'Downloading 18.0 MB of 45.0 MB'
    )
    fireEvent.click(screen.getByTestId('HarnessInstallBanner.cancel'))
    await flush()
    expect(api.cancelHarnessInstall).toHaveBeenCalledWith('opencode', '1.18.32')
  })

  it('shows a failure with its reason and a Retry', async () => {
    await renderBanner(snapshot({ opencode: missing('opencode') }))
    fire('harness:install-progress', {
      id: 'opencode',
      version: '1.18.32',
      phase: 'failed',
      reason: "the download's SHA-256 does not match the reviewed digest"
    })
    expect(banner()).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('HarnessInstallBanner.reason')).toHaveTextContent(
      "the download's SHA-256 does not match the reviewed digest"
    )
    fireEvent.click(screen.getByTestId('HarnessInstallBanner.retry'))
    await flush()
    expect(api.installHarness).toHaveBeenCalledWith('opencode', '1.18.32')
  })

  it('offers "Use ClaudeUI’s copy" for a System selection that cannot run: switch, then install', async () => {
    const pi = missing('pi', {
      selection: { source: 'system', version: 'tested' },
      resolved: {
        source: 'system',
        version: null,
        path: null,
        reason: 'No usable System pi found: pi 0.80.0 is older than 0.87.4',
        available: false
      }
    })
    api.setHarnessSelection.mockImplementation(async (_id: HarnessId, selection: unknown) => ({
      ...missing('pi'),
      selection
    }))
    await renderBanner(snapshot({ pi }), 'pi')
    expect(banner()).toHaveAttribute('data-state', 'system-unusable')
    expect(screen.getByTestId('HarnessInstallBanner.reason')).toHaveTextContent(
      'No usable System pi found: pi 0.80.0 is older than 0.87.4'
    )
    fireEvent.click(screen.getByTestId('HarnessInstallBanner.useManaged'))
    await flush()
    await flush()
    expect(api.setHarnessSelection).toHaveBeenCalledWith('pi', {
      source: 'managed',
      version: 'tested'
    })
    expect(api.installHarness).toHaveBeenCalledWith('pi', '0.87.4')
  })

  it('tells a web connection without admin to ask an admin, with no button', async () => {
    webConnection('none')
    await renderBanner(snapshot({ pi: missing('pi') }), 'pi')
    expect(banner()).toHaveAttribute('data-state', 'ask-admin')
    expect(banner()).toHaveTextContent(
      "pi isn't installed on this server. Ask an admin to install it from Settings › Harnesses › Installed."
    )
    expect(within(banner()).queryAllByRole('button')).toHaveLength(0)
  })

  it('says why a harness cannot run on this computer, with no button', async () => {
    const codex = missing('codex', {
      installable: false,
      resolved: {
        source: 'managed',
        version: null,
        path: null,
        reason: 'Codex is not available for win32-arm64',
        available: false
      }
    })
    await renderBanner(snapshot({ codex }), 'codex')
    expect(banner()).toHaveAttribute('data-state', 'unavailable-here')
    expect(banner()).toHaveTextContent('Codex is not available for win32-arm64')
    expect(within(banner()).queryAllByRole('button')).toHaveLength(0)
  })

  it('goes when the install lands', async () => {
    await renderBanner(snapshot({ opencode: missing('opencode') }))
    expect(screen.getByTestId('HarnessInstallBanner')).toBeInTheDocument()
    api.harnessState.mockResolvedValue(snapshot())
    await act(async () => {
      await harnessStore.refresh()
    })
    expect(screen.queryByTestId('HarnessInstallBanner')).toBeNull()
  })
})

// ── The harness picker ────────────────────────────────────────────────

describe('EnginePicker marks (ADR-082 §8)', () => {
  function option(id: HarnessId): HTMLElement {
    return screen
      .getAllByTestId('EnginePicker.option')
      .find((el) => el.dataset.engine === id) as HTMLElement
  }

  it('lists every harness; one not installed carries a chip and can still be picked', async () => {
    const onSelectEngine = vi.fn()
    api.harnessState.mockResolvedValue(
      snapshot({ opencode: missing('opencode'), codex: missing('codex') })
    )
    render(
      <EnginePicker selectedEngineId="claude" locked={false} onSelectEngine={onSelectEngine} />
    )
    await flush()
    fireEvent.click(screen.getByTestId('EnginePicker.trigger'))
    expect(screen.getAllByTestId('EnginePicker.option').map((el) => el.dataset.engine)).toEqual([
      'claude',
      'opencode',
      'pi',
      'codex'
    ])
    const chips = screen.getAllByTestId('EnginePicker.notInstalled').map((el) => el.dataset.engine)
    expect(chips).toEqual(['opencode', 'codex'])
    expect(option('codex')).toBeEnabled()
    fireEvent.click(option('codex'))
    expect(onSelectEngine).toHaveBeenCalledWith('codex')
  })

  it('disables a harness this computer cannot run, with the reason as its title', async () => {
    const onSelectEngine = vi.fn()
    api.harnessState.mockResolvedValue(
      snapshot({ codex: missing('codex', { installable: false }) })
    )
    render(
      <EnginePicker selectedEngineId="claude" locked={false} onSelectEngine={onSelectEngine} />
    )
    await flush()
    fireEvent.click(screen.getByTestId('EnginePicker.trigger'))
    expect(option('codex')).toBeDisabled()
    expect(option('codex')).toHaveAttribute('title', 'Not available on this computer')
    expect(screen.queryByTestId('EnginePicker.notInstalled')).toBeNull()
    fireEvent.click(option('codex'))
    expect(onSelectEngine).not.toHaveBeenCalled()
  })

  it('marks nothing before the harness snapshot loads', () => {
    api.harnessState.mockImplementation(() => new Promise(() => {}))
    render(<EnginePicker selectedEngineId="claude" locked={false} onSelectEngine={() => {}} />)
    fireEvent.click(screen.getByTestId('EnginePicker.trigger'))
    expect(screen.getAllByTestId('EnginePicker.option')).toHaveLength(4)
    expect(screen.queryByTestId('EnginePicker.notInstalled')).toBeNull()
  })
})

// ── The Settings install link ─────────────────────────────────────────

describe('NotInstalledRow (Settings, mockup D)', () => {
  it('offers "Install <version>" for a missing harness and installs through the shared path', async () => {
    api.harnessState.mockResolvedValue(snapshot({ codex: missing('codex') }))
    render(
      <NotInstalledRow
        testid="Row"
        harness="codex"
        lead="Codex is not installed."
        rest="Cross-engine dispatch lets a Claude, opencode or pi session delegate a task to a Codex agent."
      />
    )
    await flush()
    const link = await screen.findByTestId('HarnessInstallLink')
    expect(link).toHaveTextContent('Install 0.156.0')
    expect(screen.getByTestId('Row').textContent).toBe(
      'Codex is not installed. Install 0.156.0 · Cross-engine dispatch lets a Claude, opencode or pi session delegate a task to a Codex agent.'
    )
    fireEvent.click(link)
    await flush()
    expect(api.installHarness).toHaveBeenCalledWith('codex', '0.156.0')
    await waitFor(() =>
      expect(screen.getByTestId('HarnessInstallLink')).toHaveAttribute('data-state', 'installing')
    )
  })

  it('offers nothing to a connection without admin, or for a harness that cannot be installed here', async () => {
    webConnection('none')
    api.harnessState.mockResolvedValue(snapshot({ pi: missing('pi') }))
    render(<NotInstalledRow testid="Row" harness="pi" lead="pi is not installed." rest="Why." />)
    await flush()
    expect(screen.queryByTestId('HarnessInstallLink')).toBeNull()
    expect(screen.getByTestId('Row').textContent).toBe('pi is not installed. Why.')
  })
})
