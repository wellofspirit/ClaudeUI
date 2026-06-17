/**
 * Layer 2: Component tests for GitFileTree FC.
 *
 * The FC wires store state to <GitFileTreeView>. We mock the View to capture
 * props, then exercise the prop callbacks and assert IPC calls + store effects.
 *
 * Tested callbacks:
 *   onSelect              — toggles gitSelectedFile (path → null if re-selected)
 *   onToggleStage         — calls gitStageFile / gitUnstageFile, refreshes status
 *   onToggleStageDirFiles — stages/unstages multiple files in bulk, refreshes status
 *   onConfirmDiscard      — calls gitDiscardFile, refreshes status, clears selection
 *   onContextMenuAction   — 'stage-unstage' on a file in the context menu
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitFileTreeViewProps } from '../View'
import type { GitStatusData, GitFileStatus } from '../../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock the View — capture props without rendering any DOM
// ---------------------------------------------------------------------------

let viewProps: GitFileTreeViewProps

vi.mock('../View', () => ({
  GitFileTreeView: (props: GitFileTreeViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Import the FC after mocking the View
// ---------------------------------------------------------------------------

import { GitFileTree } from '../GitFileTree'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ROUTE = 'route-gitfiletree-test'
const CWD = '/repo/gft'

const stagedFile: GitFileStatus = { path: 'src/a.ts', index: 'M', working: ' ' }
const unstagedFile: GitFileStatus = { path: 'src/b.ts', index: ' ', working: 'M' }

function makeGitStatus(files: GitFileStatus[] = []): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files,
    staged: files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path),
    unstaged: files.filter((f) => f.index === ' ' || f.index === '?').map((f) => f.path),
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0
  }
}

const fakeEvent = {
  stopPropagation: vi.fn(),
  preventDefault: vi.fn()
} as unknown as React.MouseEvent

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('GitFileTree FC — rendered', () => {
  let app: TestApp

  // Captured IPC call args
  let stageCalls: Array<[string, string]> = []
  let unstageCalls: Array<[string, string]> = []
  let discardCalls: Array<[string, string]> = []
  let statusCalls: string[] = []

  beforeEach(async () => {
    stageCalls = []
    unstageCalls = []
    discardCalls = []
    statusCalls = []

    app = await bootTestApp()
    const { bridge } = app

    // Register git IPC handlers
    bridge.ipcMain.handle('git:stage-file', (_e, cwd: string, path: string) => {
      stageCalls.push([cwd, path])
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:unstage-file', (_e, cwd: string, path: string) => {
      unstageCalls.push([cwd, path])
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:discard-file', (_e, cwd: string, path: string) => {
      discardCalls.push([cwd, path])
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      statusCalls.push(cwd)
      return { ok: true, data: makeGitStatus([stagedFile, unstagedFile]) }
    })

    // Seed the store: create session, activate it, set cwd + gitStatus
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus([stagedFile, unstagedFile]))
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {}
    })
  })

  // -------------------------------------------------------------------------
  // 1. onSelect toggles file selection
  // -------------------------------------------------------------------------

  it('onSelect sets gitSelectedFile when no file is selected', () => {
    render(React.createElement(GitFileTree))

    act(() => {
      viewProps.onSelect('src/a.ts')
    })

    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/a.ts')
  })

  it('onSelect clears gitSelectedFile when the same file is selected again', () => {
    render(React.createElement(GitFileTree))

    act(() => {
      viewProps.onSelect('src/a.ts')
    })
    act(() => {
      viewProps.onSelect('src/a.ts')
    })

    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBeNull()
  })

  it('onSelect switches selection to a different file', () => {
    render(React.createElement(GitFileTree))

    act(() => {
      viewProps.onSelect('src/a.ts')
    })
    act(() => {
      viewProps.onSelect('src/b.ts')
    })

    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/b.ts')
  })

  // -------------------------------------------------------------------------
  // 2. onToggleStage unstages a staged file
  // -------------------------------------------------------------------------

  it('onToggleStage calls gitUnstageFile for a staged file and refreshes status', async () => {
    render(React.createElement(GitFileTree))

    await act(async () => {
      await viewProps.onToggleStage(stagedFile, fakeEvent)
    })

    expect(unstageCalls).toHaveLength(1)
    expect(unstageCalls[0]).toEqual([CWD, 'src/a.ts'])
    expect(stageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]).toBe(CWD)
  })

  // -------------------------------------------------------------------------
  // 3. onToggleStage stages an unstaged file
  // -------------------------------------------------------------------------

  it('onToggleStage calls gitStageFile for an unstaged file and refreshes status', async () => {
    render(React.createElement(GitFileTree))

    await act(async () => {
      await viewProps.onToggleStage(unstagedFile, fakeEvent)
    })

    expect(stageCalls).toHaveLength(1)
    expect(stageCalls[0]).toEqual([CWD, 'src/b.ts'])
    expect(unstageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]).toBe(CWD)
  })

  // -------------------------------------------------------------------------
  // 4. onToggleStageDirFiles stages multiple files
  // -------------------------------------------------------------------------

  it('onToggleStageDirFiles calls gitStageFile for each file when stage=true', async () => {
    const files: GitFileStatus[] = [
      { path: 'src/c.ts', index: ' ', working: 'M' },
      { path: 'src/d.ts', index: ' ', working: 'A' }
    ]
    render(React.createElement(GitFileTree))

    await act(async () => {
      await viewProps.onToggleStageDirFiles(files, true, fakeEvent)
    })

    expect(stageCalls).toHaveLength(2)
    expect(stageCalls[0]).toEqual([CWD, 'src/c.ts'])
    expect(stageCalls[1]).toEqual([CWD, 'src/d.ts'])
    expect(unstageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
  })

  it('onToggleStageDirFiles calls gitUnstageFile for each file when stage=false', async () => {
    const files: GitFileStatus[] = [
      { path: 'src/e.ts', index: 'M', working: ' ' },
      { path: 'src/f.ts', index: 'A', working: ' ' }
    ]
    render(React.createElement(GitFileTree))

    await act(async () => {
      await viewProps.onToggleStageDirFiles(files, false, fakeEvent)
    })

    expect(unstageCalls).toHaveLength(2)
    expect(unstageCalls[0]).toEqual([CWD, 'src/e.ts'])
    expect(unstageCalls[1]).toEqual([CWD, 'src/f.ts'])
    expect(stageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // 5. onConfirmDiscard discards file and refreshes status
  // -------------------------------------------------------------------------

  it('onConfirmDiscard calls gitDiscardFile and refreshes status', async () => {
    render(React.createElement(GitFileTree))

    // Open context menu for the unstaged file
    act(() => {
      viewProps.onFileContextMenu(unstagedFile, fakeEvent)
    })
    // Request discard action (transitions to confirmDiscard state)
    act(() => {
      viewProps.onContextMenuAction('discard')
    })
    // Confirm the discard
    await act(async () => {
      await viewProps.onConfirmDiscard()
    })

    expect(discardCalls).toHaveLength(1)
    expect(discardCalls[0]).toEqual([CWD, 'src/b.ts'])
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]).toBe(CWD)
  })

  // -------------------------------------------------------------------------
  // 6. onConfirmDiscard clears selection when discarded file was selected
  // -------------------------------------------------------------------------

  it('onConfirmDiscard clears gitSelectedFile when the discarded file was selected', async () => {
    render(React.createElement(GitFileTree))

    // Select the file first
    act(() => {
      viewProps.onSelect('src/b.ts')
    })
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/b.ts')

    // Open context menu → request discard → confirm
    act(() => {
      viewProps.onFileContextMenu(unstagedFile, fakeEvent)
    })
    act(() => {
      viewProps.onContextMenuAction('discard')
    })
    await act(async () => {
      await viewProps.onConfirmDiscard()
    })

    expect(discardCalls).toHaveLength(1)
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBeNull()
  })

  it('onConfirmDiscard does NOT clear selection when a different file was selected', async () => {
    render(React.createElement(GitFileTree))

    // Select a different file
    act(() => {
      viewProps.onSelect('src/a.ts')
    })
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/a.ts')

    // Discard the unstaged file (src/b.ts), not the selected one (src/a.ts)
    act(() => {
      viewProps.onFileContextMenu(unstagedFile, fakeEvent)
    })
    act(() => {
      viewProps.onContextMenuAction('discard')
    })
    await act(async () => {
      await viewProps.onConfirmDiscard()
    })

    expect(discardCalls).toHaveLength(1)
    expect(discardCalls[0][1]).toBe('src/b.ts')
    // Selection for src/a.ts preserved
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/a.ts')
  })

  // -------------------------------------------------------------------------
  // 7. onContextMenuAction('stage-unstage') stages/unstages the target file
  // -------------------------------------------------------------------------

  it('onContextMenuAction stage-unstage unstages a staged file from context menu', async () => {
    render(React.createElement(GitFileTree))

    // Open context menu for a staged file
    act(() => {
      viewProps.onFileContextMenu(stagedFile, fakeEvent)
    })
    // Trigger stage-unstage action
    await act(async () => {
      viewProps.onContextMenuAction('stage-unstage')
      // Allow the async chain (then/then) to flush
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(unstageCalls).toHaveLength(1)
    expect(unstageCalls[0]).toEqual([CWD, 'src/a.ts'])
    expect(stageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
  })

  it('onContextMenuAction stage-unstage stages an unstaged file from context menu', async () => {
    render(React.createElement(GitFileTree))

    // Open context menu for an unstaged file
    act(() => {
      viewProps.onFileContextMenu(unstagedFile, fakeEvent)
    })
    // Trigger stage-unstage action
    await act(async () => {
      viewProps.onContextMenuAction('stage-unstage')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(stageCalls).toHaveLength(1)
    expect(stageCalls[0]).toEqual([CWD, 'src/b.ts'])
    expect(unstageCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
  })
})
