/**
 * Layer 1: the Updates button and panel views, props in and DOM out, for every
 * state of the mockup (`updates-panel-mockup.html`): A release, B restart
 * confirm, C local build, D working, E the button; plus read-only, a failed
 * download and an ineligible install.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { HarnessInstallProgress } from '../../../../../shared/harness-types'
import type { AppUpdateView } from '../../../../../shared/types/app-update'
import { UpdatesButtonView, UpdatesPanelView, type UpdatesPanelViewProps } from '../View'
import { appSection, harnessUpdateRows, type UpdatesButtonModel } from '../utils'
import {
  CHECKED,
  TREES,
  appView,
  buildingView,
  harnessView,
  localView,
  stagedView
} from './fixtures'

const NOW = Date.parse(CHECKED) + 2 * 60_000 + 102_000

function rowsOf(installs: HarnessInstallProgress[] = []) {
  return harnessUpdateRows({
    updates: harnessView(),
    installs,
    dismissed: new Set(),
    completed: [],
    started: {},
    later: {}
  })
}

function renderPanel(
  view: AppUpdateView | null,
  overrides: Partial<UpdatesPanelViewProps> = {},
  rebuildIntent = false
) {
  const props: UpdatesPanelViewProps = {
    narrow: false,
    writable: true,
    now: NOW,
    checking: false,
    working: false,
    checkedAt: CHECKED,
    app: appSection(view, { later: {}, rebuildIntent }),
    trees: TREES,
    rebuildIntent,
    busy: null,
    confirm: null,
    harnessRows: rowsOf(),
    installRows: [],
    harnessMode: 'ask',
    version: view?.current.version ?? null,
    canRelaunch: true,
    errors: [],
    onCheck: vi.fn(),
    onSettings: vi.fn(),
    onRelaunch: vi.fn(),
    onConfirm: vi.fn(),
    onCancelConfirm: vi.fn(),
    appActions: {
      onDownload: vi.fn(),
      onRestartUpdate: vi.fn(),
      onUpdateAndRestart: vi.fn(),
      onRebuild: vi.fn(),
      onCancelRebuild: vi.fn(),
      onRelaunchBuilt: vi.fn(),
      onLater: vi.fn(),
      onSkip: vi.fn()
    },
    harnessActions: {
      onUpdate: vi.fn(),
      onLater: vi.fn(),
      onSkip: vi.fn(),
      onCancel: vi.fn(),
      onDismiss: vi.fn(),
      onInstallCancel: vi.fn(),
      onInstallDismiss: vi.fn()
    },
    ...overrides
  }
  return { ...render(<UpdatesPanelView {...props} />), props }
}

const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!
const appRow = (): HTMLElement => screen.getByTestId('UpdatesPanel.appRow')

describe('A · release build', () => {
  it('a staged release: name, chip, What’s new, from → to, the status, and its three choices', () => {
    const { props } = renderPanel(stagedView())
    expect(appRow()).toHaveAttribute('data-state', 'staged')
    expect(within(appRow()).getByTestId('UpdatesPanel.chip')).toHaveTextContent('Pre-release')
    expect(within(appRow()).getByTestId('UpdatesPanel.notes')).toHaveAttribute(
      'href',
      'https://github.com/wellofspirit/ClaudeUI/releases/tag/v3.9.1-pre.14'
    )
    expect(byId('UpdatesPanel.versions', 'claudeui')).toHaveTextContent(
      '3.9.1-pre.13 → 3.9.1-pre.14'
    )
    expect(within(appRow()).getByTestId('UpdatesPanel.status')).toHaveTextContent(
      'Downloaded. Ships Claude Code 2.1.341.'
    )
    fireEvent.click(byId('UpdatesPanel.primary', 'restart'))
    expect(props.appActions.onRestartUpdate).toHaveBeenCalled()
    fireEvent.click(byId('UpdatesPanel.later', 'claudeui'))
    expect(props.appActions.onLater).toHaveBeenCalledWith('claudeui@3.9.1-pre.14')
    const skip = byId('UpdatesPanel.skip', 'claudeui')
    expect(skip).toHaveTextContent('Skip pre.14')
    fireEvent.click(skip)
    expect(props.appActions.onSkip).toHaveBeenCalledWith('3.9.1-pre.14')
  })

  it('the header, the harness rows with their own choices, the footnote and the footer', () => {
    const { props } = renderPanel(stagedView())
    expect(screen.getByTestId('UpdatesPanel.checked')).toHaveTextContent('Checked 3 min ago')
    fireEvent.click(screen.getByTestId('UpdatesPanel.check'))
    expect(props.onCheck).toHaveBeenCalled()
    const rows = screen.getAllByTestId('UpdatesPanel.harnessRow')
    expect(rows.map((r) => [r.dataset.id, r.dataset.state])).toEqual([
      ['opencode', 'available'],
      ['pi', 'available']
    ])
    expect(byId('UpdatesPanel.versions', 'opencode')).toHaveTextContent('2.4.1 → 2.5.0')
    // No harness manifest names a notes page: no What's new on the harness rows.
    expect(within(rows[0]).queryByTestId('UpdatesPanel.notes')).toBeNull()
    fireEvent.click(byId('UpdatesPanel.harnessUpdate', 'opencode'))
    expect(props.harnessActions.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'opencode', from: '2.4.1', to: '2.5.0' })
    )
    fireEvent.click(byId('UpdatesPanel.harnessLater', 'pi'))
    expect(props.harnessActions.onLater).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi' }))
    expect(byId('UpdatesPanel.harnessSkip', 'pi')).toHaveTextContent('Skip 0.72.1')
    fireEvent.click(byId('UpdatesPanel.harnessSkip', 'pi'))
    expect(props.harnessActions.onSkip).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi' }))
    expect(screen.getByTestId('UpdatesPanel.footnote')).toHaveTextContent(
      'Running sessions keep their version.'
    )
    expect(screen.getByTestId('UpdatesPanel.version')).toHaveTextContent('3.9.1-pre.13')
    fireEvent.click(screen.getByTestId('UpdatesPanel.relaunch'))
    expect(props.onRelaunch).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('UpdatesPanel.settings'))
    expect(props.onSettings).toHaveBeenCalled()
  })

  it('Ask me, not downloaded: Download; downloading: a bar with bytes and no main action', () => {
    const { props, unmount } = renderPanel(appView())
    expect(appRow()).toHaveAttribute('data-state', 'ready')
    fireEvent.click(byId('UpdatesPanel.primary', 'download'))
    expect(props.appActions.onDownload).toHaveBeenCalled()
    unmount()
    renderPanel(
      appView({
        download: {
          phase: 'downloading',
          version: '3.9.1-pre.14',
          received: 14_890_000,
          total: 24_010_000
        }
      })
    )
    expect(byId('UpdatesPanel.progress', 'claudeui')).toHaveAttribute('aria-valuenow', '62')
    expect(within(appRow()).getByTestId('UpdatesPanel.status')).toHaveTextContent(
      'Downloading · 14.2 MB / 22.9 MB'
    )
    expect(screen.queryByTestId('UpdatesPanel.primary')).toBeNull()
  })

  it('a failed download shows the reason and offers Retry', () => {
    const { props } = renderPanel(
      appView({
        download: { phase: 'failed', version: '3.9.1-pre.14', error: 'Not enough disk space' }
      })
    )
    expect(within(appRow()).getByTestId('UpdatesPanel.status')).toHaveTextContent(
      'Not enough disk space'
    )
    fireEvent.click(byId('UpdatesPanel.primary', 'retry'))
    expect(props.appActions.onDownload).toHaveBeenCalled()
  })

  it('an install that cannot update itself says why, links the manual download, offers no download', () => {
    renderPanel(
      appView({ eligibility: { ok: false, reason: "Can't update here: download manually" } })
    )
    const status = within(appRow()).getByTestId('UpdatesPanel.status')
    expect(status).toHaveTextContent("Can't update here: download manually.")
    expect(within(status).getByTestId('UpdatesPanel.notes')).toHaveTextContent('Download manually')
    expect(screen.queryByTestId('UpdatesPanel.primary')).toBeNull()
    expect(byId('UpdatesPanel.skip', 'claudeui')).toBeInTheDocument()
  })
})

describe('B · restart confirm', () => {
  it('lists what a restart interrupts, inline in the row; Restart now and Cancel', () => {
    const { props } = renderPanel(stagedView(), {
      confirm: { action: 'update', impact: { workingSessions: 2, terminals: 1, remoteClients: 1 } }
    })
    const box = within(appRow()).getByTestId('UpdatesPanel.restartConfirm')
    expect(box).toHaveTextContent('Restart ClaudeUI now?')
    expect(
      within(box)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([
      '2 sessions are working. Their turns stop; they reopen after.',
      '1 terminal will close.',
      '1 remote device will reconnect.'
    ])
    // The row's own actions give way to the confirm.
    expect(screen.queryByTestId('UpdatesPanel.primary')).toBeNull()
    fireEvent.click(screen.getByTestId('UpdatesPanel.restartNow'))
    expect(props.onConfirm).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('UpdatesPanel.cancelRestart'))
    expect(props.onCancelConfirm).toHaveBeenCalled()
  })

  it('a plain Relaunch confirms above the footer; an unreadable impact still asks', () => {
    renderPanel(stagedView(), { confirm: { action: 'relaunch', impact: null } })
    const box = screen.getByTestId('UpdatesPanel.restartConfirm')
    expect(appRow()).not.toContainElement(box)
    expect(box).toHaveTextContent('Relaunch ClaudeUI now?')
    expect(box).toHaveTextContent('What is running could not be read.')
    expect(screen.getByTestId('UpdatesPanel.restartNow')).toHaveTextContent('Relaunch now')
  })

  it('while restarting, the button says so and waits', () => {
    renderPanel(stagedView(), {
      busy: 'restart',
      confirm: { action: 'update', impact: { workingSessions: 1, terminals: 0, remoteClients: 0 } }
    })
    expect(screen.getByTestId('UpdatesPanel.restartNow')).toHaveTextContent('Restarting…')
    expect(screen.getByTestId('UpdatesPanel.restartNow')).toBeDisabled()
  })
})

describe('C · local build', () => {
  it('the chip, base +ahead → release, the build line, and the two choices with Rebuild picked', () => {
    const { props } = renderPanel(localView())
    expect(appRow()).toHaveAttribute('data-id', 'local')
    expect(within(appRow()).getByTestId('UpdatesPanel.chip')).toHaveTextContent('Local build')
    expect(byId('UpdatesPanel.versions', 'claudeui')).toHaveTextContent('pre.13 +5 → 3.9.1-pre.14')
    expect(screen.getByTestId('UpdatesPanel.built')).toHaveTextContent(
      'Built from e4f1a2c, with uncommitted changes.'
    )
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveAttribute('aria-checked', 'true')
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveTextContent(
      'Builds the tree as it is. Pull first to get pre.14.'
    )
    expect(byId('UpdatesPanel.choice', 'release')).toHaveTextContent(
      'Replaces this build with pre.14 (228 MB). Your source is untouched.'
    )
    // The tree this build came from is picked first.
    // A themed menu, not a native select (no-native-select guard).
    const picker = screen.getByTestId('UpdatesPanel.tree')
    expect(picker).toHaveAttribute('data-value', TREES[0].id)
    expect(screen.getByTestId('UpdatesPanel.tree.trigger')).toHaveTextContent(
      'Worktree: auto-update · 3 uncommitted'
    )
    fireEvent.click(screen.getByTestId('UpdatesPanel.tree.trigger'))
    // Opening the menu leaves the radio as it was.
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveAttribute('aria-checked', 'true')
    const options = screen.getAllByTestId('UpdatesPanel.tree.option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Worktree: auto-update · 3 uncommitted',
      'Main checkout: pre-release'
    ])
    fireEvent.click(options[1])
    expect(picker).toHaveAttribute('data-value', TREES[1].id)
    expect(screen.queryByTestId('UpdatesPanel.tree.menu')).toBeNull()
    fireEvent.click(byId('UpdatesPanel.primary', 'rebuild'))
    expect(props.appActions.onRebuild).toHaveBeenCalledWith(TREES[1].id)
  })

  it('the primary button follows the radio', () => {
    const { props } = renderPanel(localView())
    fireEvent.click(byId('UpdatesPanel.choice', 'release'))
    expect(byId('UpdatesPanel.choice', 'release')).toHaveAttribute('aria-checked', 'true')
    const primary = byId('UpdatesPanel.primary', 'update')
    expect(primary).toHaveTextContent('Update & restart')
    fireEvent.click(primary)
    expect(props.appActions.onUpdateAndRestart).toHaveBeenCalled()
  })

  it('without a known source the Rebuild choice is off, and the release is picked', () => {
    renderPanel(localView({ rebuildAvailable: false }))
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveAttribute('aria-disabled', 'true')
    expect(byId('UpdatesPanel.choice', 'release')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('UpdatesPanel.tree')).toBeNull()
  })

  it('opened from the Rebuild entry with nothing on offer: Rebuild only, no skip', () => {
    renderPanel(localView({ available: undefined }), {}, true)
    expect(screen.queryAllByTestId('UpdatesPanel.choice').map((c) => c.dataset.id)).toEqual([
      'rebuild'
    ])
    expect(byId('UpdatesPanel.choice', 'rebuild')).toHaveTextContent('Builds the tree as it is.')
    expect(screen.queryByTestId('UpdatesPanel.skip')).toBeNull()
  })

  it('a failed build says why', () => {
    renderPanel(
      localView({ rebuild: { phase: 'failed', startedAt: 'b', error: 'typecheck failed' } })
    )
    expect(screen.getByTestId('UpdatesPanel.buildError')).toHaveTextContent(
      'The build failed: typecheck failed'
    )
  })
})

describe('D · working', () => {
  it('a rebuild streams its stages, the elapsed time and the last line, with Cancel build', () => {
    const installs: HarnessInstallProgress[] = [
      {
        id: 'opencode',
        version: '2.5.0',
        phase: 'downloading',
        receivedBytes: 14_890_000,
        totalBytes: 24_010_000
      },
      {
        id: 'pi',
        version: '0.72.1',
        phase: 'failed',
        reason: 'Download stalled: no data for 30 s.'
      }
    ]
    const { props } = renderPanel(buildingView(), { harnessRows: rowsOf(installs), working: true })
    expect(screen.getByTestId('UpdatesPanel.checked')).toHaveTextContent('Working…')
    expect(appRow()).toHaveAttribute('data-state', 'building')
    expect(screen.getByTestId('UpdatesPanel.elapsed')).toHaveTextContent('3:42')
    expect(appRow()).toHaveTextContent('Building from worktree auto-update')
    expect(screen.getAllByTestId('UpdatesPanel.stage').map((s) => s.dataset.state)).toEqual([
      'done',
      'done',
      'running'
    ])
    expect(screen.getByTestId('UpdatesPanel.lastLine')).toHaveTextContent(
      'packaging platform=win32'
    )
    fireEvent.click(screen.getByTestId('UpdatesPanel.cancelBuild'))
    expect(props.appActions.onCancelRebuild).toHaveBeenCalled()
    expect(appRow()).toHaveTextContent('Nothing changes until you relaunch.')

    // opencode installs: progress with Cancel; pi failed: the reason, Retry, Dismiss.
    expect(byId('UpdatesPanel.harnessRow', 'opencode')).toHaveAttribute('data-state', 'installing')
    expect(byId('UpdatesPanel.harnessProgress', 'opencode')).toHaveAttribute('aria-valuenow', '62')
    fireEvent.click(byId('UpdatesPanel.harnessCancel', 'opencode'))
    expect(props.harnessActions.onCancel).toHaveBeenCalled()
    const pi = byId('UpdatesPanel.harnessRow', 'pi')
    expect(within(pi).getByTestId('UpdatesPanel.harnessReason')).toHaveTextContent(
      'Download stalled: no data for 30 s.'
    )
    fireEvent.click(byId('UpdatesPanel.harnessRetry', 'pi'))
    expect(props.harnessActions.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi' })
    )
    fireEvent.click(byId('UpdatesPanel.harnessDismiss', 'pi'))
    expect(props.harnessActions.onDismiss).toHaveBeenCalled()
  })

  it('built: Build ready with its commit, Relaunch now and Later', () => {
    const { props } = renderPanel(
      localView({
        rebuild: {
          phase: 'built',
          startedAt: 'b',
          built: { version: '3.9.1-pre.13+6', commit: 'f00ba12' }
        }
      })
    )
    expect(appRow()).toHaveAttribute('data-state', 'built')
    expect(within(appRow()).getByTestId('UpdatesPanel.status')).toHaveTextContent(
      'Build ready · f00ba12'
    )
    fireEvent.click(byId('UpdatesPanel.primary', 'relaunch-built'))
    expect(props.appActions.onRelaunchBuilt).toHaveBeenCalled()
    fireEvent.click(byId('UpdatesPanel.later', 'claudeui'))
    expect(props.appActions.onLater).toHaveBeenCalledWith('rebuild@b')
  })

  it('an installed harness row says new sessions use it', () => {
    const rows = harnessUpdateRows({
      updates: harnessView({ available: [] }),
      installs: [],
      dismissed: new Set(),
      completed: [{ id: 'opencode', version: '2.5.0' }],
      started: { 'opencode@2.5.0': '2.4.1' },
      later: {}
    })
    renderPanel(null, { harnessRows: rows })
    const row = byId('UpdatesPanel.harnessRow', 'opencode')
    expect(row).toHaveAttribute('data-state', 'installed')
    expect(row).toHaveTextContent('Installed')
    expect(row).toHaveTextContent('New sessions use 2.5.0.')
  })
})

describe('read only and the rest', () => {
  it('a connection without admin: the same rows, no action buttons, the read-only line', () => {
    renderPanel(stagedView(), { writable: false })
    expect(appRow()).toHaveAttribute('data-state', 'staged')
    expect(screen.getAllByTestId('UpdatesPanel.harnessRow')).toHaveLength(2)
    for (const id of [
      'UpdatesPanel.primary',
      'UpdatesPanel.later',
      'UpdatesPanel.skip',
      'UpdatesPanel.harnessUpdate',
      'UpdatesPanel.check',
      'UpdatesPanel.relaunch'
    ]) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.getByTestId('UpdatesPanel.readOnly')).toHaveTextContent(
      'Read only: updating needs an admin connection.'
    )
    // Settings stay one click away.
    expect(screen.getByTestId('UpdatesPanel.settings')).toBeInTheDocument()
  })

  it('nothing pending says so; errors show', () => {
    renderPanel(appView({ available: undefined }), {
      harnessRows: [],
      errors: ['GitHub rate limit']
    })
    expect(screen.getByTestId('UpdatesPanel.empty')).toHaveTextContent(
      'ClaudeUI and its harnesses are up to date.'
    )
    expect(screen.getByTestId('UpdatesPanel.error')).toHaveTextContent('GitHub rate limit')
  })

  it('is 344 px wide on the desktop, and spans its container in the phone drawer', () => {
    const { unmount } = renderPanel(stagedView())
    expect(screen.getByTestId('UpdatesPanel').className).toContain('w-[344px]')
    unmount()
    renderPanel(stagedView(), { narrow: true })
    expect(screen.getByTestId('UpdatesPanel').className).toContain('right-3')
    expect(screen.getByTestId('UpdatesPanel').className).not.toContain('w-[344px]')
  })
})

describe('E · the button', () => {
  const model = (patch: Partial<UpdatesButtonModel>): UpdatesButtonModel => ({
    state: 'available',
    count: 2,
    title: 'opencode 2.5.0, pi 0.72.1: click to review',
    ...patch
  })

  it.each([
    ['available', 2, true],
    ['restart', 3, true],
    ['running', 0, false],
    ['failed', 0, false],
    ['done', 0, false]
  ] as const)('%s: the icon state, and a badge only with a count', (state, count, badge) => {
    render(
      <UpdatesButtonView
        model={model({ state, count })}
        open={false}
        fading={false}
        onClick={vi.fn()}
      />
    )
    const button = screen.getByTestId('UpdatesButton')
    expect(button).toHaveAttribute('data-state', state)
    if (badge) expect(screen.getByTestId('UpdatesButton.badge')).toHaveTextContent(String(count))
    else expect(screen.queryByTestId('UpdatesButton.badge')).toBeNull()
  })

  it('names the items in its title, and a click only reports itself', () => {
    const onClick = vi.fn()
    render(<UpdatesButtonView model={model({})} open={false} fading={false} onClick={onClick} />)
    const button = screen.getByTestId('UpdatesButton')
    expect(button).toHaveAttribute('title', 'opencode 2.5.0, pi 0.72.1: click to review')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('open with nothing pending shows the check; fading hides it', () => {
    const { rerender } = render(
      <UpdatesButtonView
        model={model({ state: 'hidden', count: 0, title: '' })}
        open
        fading={false}
        onClick={vi.fn()}
      />
    )
    expect(screen.getByTestId('UpdatesButton')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('UpdatesButton')).toHaveAttribute('aria-expanded', 'true')
    rerender(
      <UpdatesButtonView
        model={model({ state: 'done', count: 0 })}
        open={false}
        fading
        onClick={vi.fn()}
      />
    )
    expect(screen.getByTestId('UpdatesButton').className).toContain('opacity-0')
  })
})
