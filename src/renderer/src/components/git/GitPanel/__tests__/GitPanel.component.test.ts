/**
 * Layer 2: Component tests for GitPanel FC.
 *
 * The FC wires store state to <GitPanelView>. We mock the View to capture
 * props, then exercise the prop callbacks and assert IPC calls + store effects.
 *
 * Tested behaviours:
 *   mount         — fetches git:status on mount, updates store
 *   auto-select   — selects first file when no file is currently selected
 *   no auto-select — leaves selection intact when a file is already selected
 *   onClose       — calls closeGitPanel, sets rightPanel → 'none'
 *   onToggleLayout — flips settings.gitPanelLayout between 'single' and 'double'
 *   isDouble prop  — passes true when gitPanelLayout is 'double'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitPanelViewProps } from '../View'
import type { GitStatusData, GitFileStatus } from '../../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock the View — capture props without rendering any DOM
// ---------------------------------------------------------------------------

let viewProps: GitPanelViewProps

vi.mock('../View', () => ({
  GitPanelView: (props: GitPanelViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Import the FC after mocking the View
// ---------------------------------------------------------------------------

import { GitPanel } from '../GitPanel'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ROUTE = 'route-gitpanel-test'
const CWD = '/repo/gp'

const fileA: GitFileStatus = { path: 'src/a.ts', index: 'M', working: ' ' }
const fileB: GitFileStatus = { path: 'src/b.ts', index: ' ', working: 'M' }

function makeGitStatus(files: GitFileStatus[] = []): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files,
    staged: files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path),
    unstaged: files.filter((f) => f.index === ' ').map((f) => f.path),
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('GitPanel FC — rendered', () => {
  let app: TestApp
  let statusCalls: string[]

  beforeEach(async () => {
    statusCalls = []

    app = await bootTestApp()
    const { bridge } = app

    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      statusCalls.push(cwd)
      return { ok: true, data: makeGitStatus([fileA, fileB]) }
    })

    // Seed the store: create session, activate it, set cwd
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
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
  // 1. Fetches git status on mount and updates the store
  // -------------------------------------------------------------------------

  it('fetches git status on mount and updates store', async () => {
    await act(async () => {
      render(React.createElement(GitPanel))
    })

    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]).toBe(CWD)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitStatus).not.toBeNull()
    expect(session.gitStatus?.files).toHaveLength(2)
    expect(session.gitStatus?.files[0].path).toBe('src/a.ts')
  })

  // -------------------------------------------------------------------------
  // 2. Auto-selects first file when no file is currently selected
  // -------------------------------------------------------------------------

  it('auto-selects first file when none selected', async () => {
    // Ensure no file is pre-selected
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBeNull()

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitSelectedFile).toBe('src/a.ts')
  })

  // -------------------------------------------------------------------------
  // 3. Does not auto-select when a file is already selected
  // -------------------------------------------------------------------------

  it('does not auto-select when a file is already selected', async () => {
    // Pre-select fileB in the store before mounting
    useSessionStore.getState().setGitSelectedFile(ROUTE, 'src/b.ts')
    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/b.ts')

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    // Selection should remain on the pre-selected file
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitSelectedFile).toBe('src/b.ts')
  })

  // -------------------------------------------------------------------------
  // 4. onClose calls closeGitPanel — sets rightPanel to 'none'
  // -------------------------------------------------------------------------

  it('onClose calls closeGitPanel in store', async () => {
    // Open the git panel first so we can verify it closes
    useSessionStore.getState().openGitPanel(ROUTE)
    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('git')

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    act(() => {
      viewProps.onClose()
    })

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
  })

  // -------------------------------------------------------------------------
  // 5. onToggleLayout flips gitPanelLayout between 'single' and 'double'
  // -------------------------------------------------------------------------

  it('onToggleLayout toggles from single to double', async () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitPanelLayout: 'single' }
    }))

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    act(() => {
      viewProps.onToggleLayout()
    })

    expect(useSessionStore.getState().settings.gitPanelLayout).toBe('double')
  })

  it('onToggleLayout toggles from double to single', async () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitPanelLayout: 'double' }
    }))

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    act(() => {
      viewProps.onToggleLayout()
    })

    expect(useSessionStore.getState().settings.gitPanelLayout).toBe('single')
  })

  // -------------------------------------------------------------------------
  // 6. isDouble prop reflects current gitPanelLayout setting
  // -------------------------------------------------------------------------

  it('passes isDouble=true when layout is double', async () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitPanelLayout: 'double' }
    }))

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    expect(viewProps.isDouble).toBe(true)
  })

  it('passes isDouble=false when layout is single', async () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitPanelLayout: 'single' }
    }))

    await act(async () => {
      render(React.createElement(GitPanel))
    })

    expect(viewProps.isDouble).toBe(false)
  })
})
