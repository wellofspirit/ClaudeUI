/**
 * Layer 2: Component tests for MobileGitView — the mobile full-screen git
 * takeover (viewport ≤768px), a two-screen drill-down over the same store
 * state the desktop GitPanel uses.
 *
 * What actually matters here and can't be read off the source:
 *   1. Mount lands on the LIST screen — MobileGitView must NOT inherit
 *      GitPanel's auto-select-first-file behaviour, and must clear a stale
 *      desktop selection (otherwise mobile opens on a diff nobody asked for).
 *   2. Selection drives navigation: tapping a row shows the diff, back clears.
 *   3. prev/next walk `filterAndSortFiles` order (NOT raw status order) and
 *      disable at the ends.
 *   4. Stage/unstage and the two-tap discard call through to git IPC and
 *      refresh status.
 *
 * GitFileTree is left REAL (its row taps are the navigation trigger under
 * test); GitFileDiffView / GitCommitBox are stubbed — their own suites cover
 * them and mounting them here would drag in patch fetching and commit state
 * for no added signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitFileStatus, GitStatusData } from '../../../../../../shared/types'

vi.mock('../../GitFileDiffView', () => ({
  GitFileDiffView: () => <div data-testid="GitFileDiffView" />
}))
vi.mock('../../GitCommitBox', () => ({
  GitCommitBox: () => <div data-testid="GitCommitBox" />
}))

import { MobileGitView } from '../MobileGitView'

const ROUTE = 'route-mobile-git'
const CWD = '/d/repo-mobile-git'

// Deliberately NOT in sorted order: filterAndSortFiles sorts by path, so
// prev/next must walk a.ts → m.ts → z.ts even though status lists z first.
const fileZ: GitFileStatus = { path: 'src/z.ts', index: 'M', working: ' ' } // staged
const fileA: GitFileStatus = { path: 'src/a.ts', index: ' ', working: 'M' } // unstaged
const fileM: GitFileStatus = { path: 'src/m.ts', index: ' ', working: 'M' } // unstaged

function makeGitStatus(files: GitFileStatus[]): GitStatusData {
  return {
    branch: 'feature/mobile',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/feature/mobile',
    files,
    staged: files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path),
    unstaged: files.filter((f) => f.index === ' ').map((f) => f.path),
    untracked: [],
    linesAdded: 4,
    linesRemoved: 2
  }
}

describe('MobileGitView', () => {
  let app: TestApp
  let statusCalls: string[]
  let stageCalls: string[]
  let unstageCalls: string[]
  let discardCalls: string[]
  let status: GitStatusData

  beforeEach(async () => {
    statusCalls = []
    stageCalls = []
    unstageCalls = []
    discardCalls = []
    status = makeGitStatus([fileZ, fileA, fileM])

    app = await bootTestApp()
    const { bridge } = app
    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      statusCalls.push(cwd)
      return { ok: true, data: status }
    })
    bridge.ipcMain.handle('git:stage-file', (_e, _cwd: string, filePath: string) => {
      stageCalls.push(filePath)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:unstage-file', (_e, _cwd: string, filePath: string) => {
      unstageCalls.push(filePath)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:discard-file', (_e, _cwd: string, filePath: string) => {
      discardCalls.push(filePath)
      return { ok: true, data: undefined }
    })

    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setIsGitRepo(ROUTE, true)
    useSessionStore.getState().setGitStatus(ROUTE, status)
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function mount(): Promise<void> {
    await act(async () => {
      render(React.createElement(MobileGitView))
    })
  }

  const selected = (): string | null => useSessionStore.getState().sessions[ROUTE].gitSelectedFile

  it('lands on the list screen and fetches status, without auto-selecting a file', async () => {
    await mount()

    expect(statusCalls).toEqual([CWD])
    expect(screen.getByTestId('MobileGitView.listScreen')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileGitView.diffScreen')).toBeNull()
    // The guard for the suppressed GitPanel auto-select.
    expect(selected()).toBeNull()
    // Branch surfaced next to the title.
    expect(screen.getByTestId('MobileGitView.listScreen')).toHaveTextContent('feature/mobile')
  })

  it('clears a stale desktop selection on mount', async () => {
    useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/z.ts')
    expect(selected()).toBe('src/z.ts')

    await mount()

    expect(selected()).toBeNull()
    expect(screen.getByTestId('MobileGitView.listScreen')).toBeInTheDocument()
  })

  it('tapping a file row drills into the diff screen; diffBack returns to the list', async () => {
    await mount()

    await act(async () => {
      screen
        .getAllByTestId('GitFileRow')
        .find((r) => r.dataset.id === 'src/m.ts')!
        .click()
    })

    expect(screen.getByTestId('MobileGitView.diffScreen')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileGitView.listScreen')).toBeNull()
    expect(screen.getByTestId('GitFileDiffView')).toBeInTheDocument()
    expect(selected()).toBe('src/m.ts')

    await act(async () => {
      screen.getByTestId('MobileGitView.diffBack').click()
    })

    expect(selected()).toBeNull()
    expect(screen.getByTestId('MobileGitView.listScreen')).toBeInTheDocument()
  })

  it('prev/next walk the filtered+sorted order and disable at the ends', async () => {
    await mount()
    // Start at the middle of a.ts → m.ts → z.ts.
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/m.ts')
    })

    expect(screen.getByTestId('MobileGitView.position')).toHaveTextContent('2/3')
    expect(screen.getByTestId('MobileGitView.prevFile')).not.toBeDisabled()
    expect(screen.getByTestId('MobileGitView.nextFile')).not.toBeDisabled()

    await act(async () => {
      screen.getByTestId('MobileGitView.prevFile').click()
    })
    expect(selected()).toBe('src/a.ts')
    expect(screen.getByTestId('MobileGitView.position')).toHaveTextContent('1/3')
    expect(screen.getByTestId('MobileGitView.prevFile')).toBeDisabled()

    await act(async () => {
      screen.getByTestId('MobileGitView.nextFile').click()
    })
    await act(async () => {
      screen.getByTestId('MobileGitView.nextFile').click()
    })
    expect(selected()).toBe('src/z.ts')
    expect(screen.getByTestId('MobileGitView.position')).toHaveTextContent('3/3')
    expect(screen.getByTestId('MobileGitView.nextFile')).toBeDisabled()
  })

  it('shows "–" and disables both arrows when the selected file vanished from status', async () => {
    await mount()
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/gone.ts')
    })

    expect(screen.getByTestId('MobileGitView.position')).toHaveTextContent('–')
    expect(screen.getByTestId('MobileGitView.prevFile')).toBeDisabled()
    expect(screen.getByTestId('MobileGitView.nextFile')).toBeDisabled()
    // No GitFileStatus to act on → the file actions are inert too.
    expect(screen.getByTestId('MobileGitView.toggleStage')).toBeDisabled()
    expect(screen.getByTestId('MobileGitView.discard')).toBeDisabled()
  })

  it('toggleStage stages an unstaged file then refreshes status', async () => {
    await mount()
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/a.ts')
    })

    expect(screen.getByTestId('MobileGitView.toggleStage')).toHaveTextContent('Stage')
    statusCalls.length = 0

    // Next refresh reports a.ts as staged.
    status = makeGitStatus([fileZ, { path: 'src/a.ts', index: 'M', working: ' ' }, fileM])

    await act(async () => {
      screen.getByTestId('MobileGitView.toggleStage').click()
    })

    expect(stageCalls).toEqual(['src/a.ts'])
    expect(statusCalls).toEqual([CWD])
    expect(screen.getByTestId('MobileGitView.toggleStage')).toHaveTextContent('Unstage')
  })

  it('toggleStage unstages an already-staged file', async () => {
    await mount()
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/z.ts')
    })

    expect(screen.getByTestId('MobileGitView.toggleStage')).toHaveTextContent('Unstage')

    await act(async () => {
      screen.getByTestId('MobileGitView.toggleStage').click()
    })

    expect(unstageCalls).toEqual(['src/z.ts'])
    expect(stageCalls).toEqual([])
  })

  it('discard takes two taps, then returns to the list', async () => {
    await mount()
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/a.ts')
    })

    const discard = (): HTMLElement => screen.getByTestId('MobileGitView.discard')
    expect(discard()).toHaveTextContent('Discard')

    // First tap only arms the confirm — nothing is destroyed yet.
    await act(async () => {
      discard().click()
    })
    expect(discardCalls).toEqual([])
    expect(discard()).toHaveTextContent('Confirm discard?')

    status = makeGitStatus([fileZ, fileM])
    await act(async () => {
      discard().click()
    })

    expect(discardCalls).toEqual(['src/a.ts'])
    expect(selected()).toBeNull()
    expect(screen.getByTestId('MobileGitView.listScreen')).toBeInTheDocument()
  })

  it('discard confirm disarms on blur', async () => {
    await mount()
    await act(async () => {
      useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/a.ts')
    })

    await act(async () => {
      screen.getByTestId('MobileGitView.discard').click()
    })
    expect(screen.getByTestId('MobileGitView.discard')).toHaveTextContent('Confirm discard?')

    await act(async () => {
      fireEvent.blur(screen.getByTestId('MobileGitView.discard'))
    })
    expect(screen.getByTestId('MobileGitView.discard')).toHaveTextContent('Discard')
    expect(discardCalls).toEqual([])
  })

  it('back closes the git panel (same action as the desktop panel close)', async () => {
    useSessionStore.getState().openGitPanel(ROUTE)
    await mount()

    await act(async () => {
      screen.getByTestId('MobileGitView.back').click()
    })

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
  })

  it('renders the tree empty state when there are no changes', async () => {
    status = makeGitStatus([])
    useSessionStore.getState().setGitStatus(ROUTE, status)

    await mount()

    expect(screen.getByTestId('MobileGitView.listScreen')).toBeInTheDocument()
    expect(screen.getByTestId('GitFileTree')).toHaveTextContent('No changes')
  })
})
