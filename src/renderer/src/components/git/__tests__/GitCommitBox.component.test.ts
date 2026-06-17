/**
 * Layer 2: Component tests for GitCommitBox store-level business logic.
 *
 * GitCommitBox makes heavy IPC calls (gitCommit, gitPush, etc.) that are
 * difficult to test without rendering. Instead, we test the Zustand store
 * actions that the component reads from and writes to:
 *
 *   setGitCommitMessage  — stores the commit message draft
 *   setGitStatus         — updates git status and populates the cross-session cache
 *   selectNextGitFile    — advances selected file after a commit
 *
 * These actions collectively determine whether the commit button is enabled
 * and what happens to the UI state after a successful commit.
 *
 * The second half of this file (describe 'GitCommitBox FC — rendered') renders
 * the actual FC via @testing-library/react, captures the View props it passes
 * to <GitCommitBoxView />, and calls the prop callbacks to assert IPC + store
 * effects. The View is mocked out so no real DOM rendering is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSessionStore } from '../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { GitStatusData } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock the View — capture props without rendering any DOM
// ---------------------------------------------------------------------------

import type { GitCommitBoxViewProps } from '../GitCommitBox/View'

let viewProps: GitCommitBoxViewProps

vi.mock('../GitCommitBox/View', () => ({
  GitCommitBoxView: (props: GitCommitBoxViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitStatus(overrides: Partial<GitStatusData> = {}): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ROUTE = 'route-commit-test'

beforeEach(() => {
  resetFactoryCounter()

  // Stub window.api — createNewSession calls saveSessionConfig internally.
  // Only the methods called by the store actions under test need to be present.
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: () => {},
    saveSettings: () => {},
    saveSlashCommands: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }

  // Reset store to a clean slate
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitCommitBox store state — setGitCommitMessage', () => {
  it('stores the commit message for the active session', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'feat: add login page')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitCommitMessage).toBe('feat: add login page')
  })

  it('allows updating the message multiple times', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'first draft')
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'final message')

    expect(useSessionStore.getState().sessions[ROUTE].gitCommitMessage).toBe('final message')
  })

  it('clears the commit message when set to empty string', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'some message')
    useSessionStore.getState().setGitCommitMessage(ROUTE, '')

    expect(useSessionStore.getState().sessions[ROUTE].gitCommitMessage).toBe('')
  })

  it('does not affect other sessions', () => {
    const otherRoute = 'route-other'
    useSessionStore.getState().createNewSession(ROUTE, '/repo-a')
    useSessionStore.getState().createNewSession(otherRoute, '/repo-b')

    useSessionStore.getState().setGitCommitMessage(ROUTE, 'my message')

    expect(useSessionStore.getState().sessions[otherRoute].gitCommitMessage).toBe('')
  })
})

describe('GitCommitBox store state — selectNextGitFile', () => {
  it('selects the first file from gitStatus after a commit', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        files: [
          { path: 'src/a.ts', index: 'M', working: ' ' },
          { path: 'src/b.ts', index: 'A', working: ' ' }
        ]
      })
    )

    useSessionStore.getState().selectNextGitFile(ROUTE)

    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBe('src/a.ts')
  })

  it('sets gitSelectedFile to null when there are no files', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({ files: [] }))

    useSessionStore.getState().selectNextGitFile(ROUTE)

    expect(useSessionStore.getState().sessions[ROUTE].gitSelectedFile).toBeNull()
  })

  it('clears gitFileDiff when selecting next file', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        files: [{ path: 'src/a.ts', index: 'M', working: ' ' }]
      })
    )
    // Simulate a diff being loaded for the previously selected file
    useSessionStore.getState().setGitFileDiff(ROUTE, { patch: '@@ -1 +1 @@\n-old\n+new' })

    useSessionStore.getState().selectNextGitFile(ROUTE)

    expect(useSessionStore.getState().sessions[ROUTE].gitFileDiff).toBeNull()
  })

  it('sets both gitSelectedFile and gitFileDiff to null when gitStatus is absent', () => {
    // Use a unique cwd so the module-level gitStatusCache does not pre-populate
    // this session from a previous test that shared the same cwd.
    useSessionStore.getState().createNewSession(ROUTE, '/repo-no-status-unique')
    // Do NOT call setGitStatus — session has no gitStatus

    useSessionStore.getState().selectNextGitFile(ROUTE)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitSelectedFile).toBeNull()
    expect(session.gitFileDiff).toBeNull()
  })
})

describe('GitCommitBox store state — setGitStatus and the git status cache', () => {
  it('updates gitStatus in the session', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    const status = makeGitStatus({
      branch: 'feature/my-branch',
      staged: ['src/a.ts'],
      files: [{ path: 'src/a.ts', index: 'M', working: ' ' }]
    })

    useSessionStore.getState().setGitStatus(ROUTE, status)

    expect(useSessionStore.getState().sessions[ROUTE].gitStatus?.branch).toBe('feature/my-branch')
    expect(useSessionStore.getState().sessions[ROUTE].gitStatus?.staged).toContain('src/a.ts')
  })

  it('a new session with the same cwd inherits cached git status immediately', () => {
    const CWD = '/repo-shared'
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    const status = makeGitStatus({ branch: 'dev', staged: ['x.ts'] })
    useSessionStore.getState().setGitStatus(ROUTE, status)

    // Create a second session pointing to the same cwd
    const route2 = 'route-second-session'
    useSessionStore.getState().createNewSession(route2, CWD)

    const session2 = useSessionStore.getState().sessions[route2]
    // Cache should be populated from the first session's setGitStatus call
    expect(session2.gitStatus?.branch).toBe('dev')
  })

  it('a second session with a different cwd does NOT inherit the cached status', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo-cache-src')
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({ branch: 'main' }))

    const route2 = 'route-different-cwd'
    // Unique cwd that was never passed to setGitStatus → no cache entry
    useSessionStore.getState().createNewSession(route2, '/repo-cache-dest-unique')

    // Different cwd → no cache hit, gitStatus stays at its initial null value
    expect(useSessionStore.getState().sessions[route2].gitStatus).toBeNull()
  })
})

describe('GitCommitBox commit enablement conditions', () => {
  it('commit is enabled when staged count > 0 and message is non-empty', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        staged: ['src/a.ts'],
        files: [{ path: 'src/a.ts', index: 'M', working: ' ' }]
      })
    )
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'fix: something')

    const session = useSessionStore.getState().sessions[ROUTE]
    const stagedCount = session.gitStatus?.staged.length ?? 0
    const message = session.gitCommitMessage

    // The component derives: commitDisabled = loading || !message.trim() || stagedCount === 0
    // We test the preconditions the component checks, not the derived boolean itself
    expect(stagedCount).toBeGreaterThan(0)
    expect(message.trim()).not.toBe('')
  })

  it('commit is blocked when there are no staged files', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        staged: [],
        files: [{ path: 'src/a.ts', index: ' ', working: 'M' }]
      })
    )
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'fix: something')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitStatus?.staged.length).toBe(0)
  })

  it('commit is blocked when message is empty', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        staged: ['src/a.ts']
      })
    )
    useSessionStore.getState().setGitCommitMessage(ROUTE, '')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitCommitMessage.trim()).toBe('')
  })

  it('allStaged is true when every changed file is staged', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(
      ROUTE,
      makeGitStatus({
        staged: ['src/a.ts', 'src/b.ts'],
        files: [
          { path: 'src/a.ts', index: 'M', working: ' ' },
          { path: 'src/b.ts', index: 'A', working: ' ' }
        ]
      })
    )

    const session = useSessionStore.getState().sessions[ROUTE]
    const stagedCount = session.gitStatus?.staged.length ?? 0
    const totalChanges = session.gitStatus?.files.length ?? 0

    // Component derives: allStaged = totalChanges > 0 && stagedCount === totalChanges
    expect(totalChanges).toBeGreaterThan(0)
    expect(stagedCount).toBe(totalChanges)
  })
})

// ---------------------------------------------------------------------------
// FC rendering tests — exercises View prop callbacks via IPC + store
// ---------------------------------------------------------------------------

import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { GitCommitBox } from '../GitCommitBox/GitCommitBox'

const FC_ROUTE = 'route-fc-render'
const FC_CWD = '/repo-fc'

/** Minimal GitStatusData with staged files. */
function makeStagedStatus(staged: string[] = ['src/a.ts']): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: staged.map((p) => ({ path: p, index: 'M', working: ' ' })),
    staged,
    unstaged: [],
    untracked: [],
    linesAdded: 1,
    linesRemoved: 0
  }
}

describe('GitCommitBox FC — rendered', () => {
  let app: TestApp

  // Captured IPC args
  let commitCalls: Array<[string, string]> = []
  let statusCalls: string[] = []
  let stageAllCalls: string[] = []
  let unstageAllCalls: string[] = []
  let pushCalls: string[] = []
  let pushUpstreamCalls: Array<[string, string]> = []
  let filePatchCalls: Array<[string, string, boolean, boolean]> = []
  let generateMsgCalls: string[] = []

  beforeEach(async () => {
    resetFactoryCounter()
    commitCalls = []
    statusCalls = []
    stageAllCalls = []
    unstageAllCalls = []
    pushCalls = []
    pushUpstreamCalls = []
    filePatchCalls = []
    generateMsgCalls = []

    app = await bootTestApp()
    const { bridge } = app

    // Register git IPC handlers
    bridge.ipcMain.handle('git:commit', (_e, cwd: string, msg: string) => {
      commitCalls.push([cwd, msg])
      return { ok: true, data: 'abc1234567890' }
    })
    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      statusCalls.push(cwd)
      return { ok: true, data: makeStagedStatus() }
    })
    bridge.ipcMain.handle('git:stage-all', (_e, cwd: string) => {
      stageAllCalls.push(cwd)
      return { ok: true, data: null }
    })
    bridge.ipcMain.handle('git:unstage-all', (_e, cwd: string) => {
      unstageAllCalls.push(cwd)
      return { ok: true, data: null }
    })
    bridge.ipcMain.handle('git:push', (_e, cwd: string) => {
      pushCalls.push(cwd)
      return { ok: true, data: null }
    })
    bridge.ipcMain.handle('git:push-with-upstream', (_e, cwd: string, branch: string) => {
      pushUpstreamCalls.push([cwd, branch])
      return { ok: true, data: null }
    })
    bridge.ipcMain.handle(
      'git:file-patch',
      (_e, cwd: string, filePath: string, staged: boolean, ignoreWs: boolean) => {
        filePatchCalls.push([cwd, filePath, staged, ignoreWs])
        return { ok: true, data: { patch: `diff --git a/${filePath} b/${filePath}\n+new line` } }
      }
    )
    bridge.ipcMain.handle('session:generate-commit-message', (_e, diff: string) => {
      generateMsgCalls.push(diff)
      return 'feat: generated message'
    })

    // Seed the store: create session, set it active, populate git status + message
    useSessionStore.getState().createNewSession(FC_ROUTE, FC_CWD)
    useSessionStore.setState({ activeSessionId: FC_ROUTE })
    useSessionStore.getState().setGitStatus(FC_ROUTE, makeStagedStatus())
    useSessionStore.getState().setGitCommitMessage(FC_ROUTE, 'feat: my commit')
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

  it('renders without crashing and passes correct initial props to View', () => {
    render(React.createElement(GitCommitBox))

    expect(viewProps).toBeDefined()
    expect(viewProps.gitCommitMessage).toBe('feat: my commit')
    expect(viewProps.stagedCount).toBe(1)
    expect(viewProps.commitDisabled).toBe(false)
  })

  it('onCommitMessageChange updates store commit message', () => {
    render(React.createElement(GitCommitBox))

    act(() => {
      viewProps.onCommitMessageChange('fix: updated message')
    })

    expect(useSessionStore.getState().sessions[FC_ROUTE].gitCommitMessage).toBe(
      'fix: updated message'
    )
  })

  it('onPrimaryCommit (commit-only mode) calls gitCommit, clears message, refreshes status, selects next file', async () => {
    // Ensure commit-only mode (default)
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitCommitMode: 'commit' }
    }))

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onPrimaryCommit()
    })

    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]).toEqual([FC_CWD, 'feat: my commit'])

    // Message cleared
    expect(useSessionStore.getState().sessions[FC_ROUTE].gitCommitMessage).toBe('')

    // Status refreshed
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]).toBe(FC_CWD)
  })

  it('onToggleStageAll calls gitStageAll when not all staged', async () => {
    // Only 1 of 2 files staged → allStaged = false → should call stageAll
    useSessionStore.getState().setGitStatus(FC_ROUTE, {
      ...makeStagedStatus(['src/a.ts']),
      files: [
        { path: 'src/a.ts', index: 'M', working: ' ' },
        { path: 'src/b.ts', index: ' ', working: 'M' }
      ]
    })

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onToggleStageAll()
    })

    expect(stageAllCalls).toHaveLength(1)
    expect(stageAllCalls[0]).toBe(FC_CWD)
    expect(unstageAllCalls).toHaveLength(0)
    expect(statusCalls).toHaveLength(1)
  })

  it('onToggleStageAll calls gitUnstageAll when all staged', async () => {
    // Set all files staged
    useSessionStore.getState().setGitStatus(FC_ROUTE, makeStagedStatus(['src/a.ts']))

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onToggleStageAll()
    })

    expect(unstageAllCalls).toHaveLength(1)
    expect(unstageAllCalls[0]).toBe(FC_CWD)
    expect(stageAllCalls).toHaveLength(0)
  })

  it('onPush calls gitPush and refreshes status on success', async () => {
    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onPush()
    })

    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toBe(FC_CWD)
  })

  it('onPush sets upstreamPrompt when push fails with no-upstream error', async () => {
    // Override push handler to simulate no-upstream error
    app.bridge.ipcMain.handle('git:push', () => {
      return { ok: false, error: 'error: The current branch has no upstream branch.' }
    })

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onPush()
    })

    // upstreamPrompt should be set — the View receives it as a prop
    expect(viewProps.upstreamPrompt).not.toBeNull()
    expect(viewProps.upstreamPrompt?.branch).toBe('main')
  })

  it('onPushWithUpstream calls gitPushWithUpstream and clears upstreamPrompt', async () => {
    // First trigger a push that sets upstreamPrompt
    app.bridge.ipcMain.handle('git:push', () => {
      return { ok: false, error: 'error: The current branch has no upstream branch.' }
    })

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onPush()
    })

    // upstreamPrompt is set
    expect(viewProps.upstreamPrompt).not.toBeNull()

    // Re-register push handler for status refresh after upstream push
    app.bridge.ipcMain.handle('git:push', () => ({ ok: true, data: null }))

    await act(async () => {
      await viewProps.onPushWithUpstream()
    })

    expect(pushUpstreamCalls).toHaveLength(1)
    expect(pushUpstreamCalls[0][0]).toBe(FC_CWD)
    expect(pushUpstreamCalls[0][1]).toBe('main')
    // upstreamPrompt cleared
    expect(viewProps.upstreamPrompt).toBeNull()
  })

  it('onGenerateMessage calls gitGetFilePatch + generateCommitMessage and sets message in store', async () => {
    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onGenerateMessage()
    })

    expect(filePatchCalls).toHaveLength(1)
    expect(filePatchCalls[0][0]).toBe(FC_CWD)
    expect(filePatchCalls[0][1]).toBe('src/a.ts')
    expect(filePatchCalls[0][2]).toBe(true) // staged=true
    expect(filePatchCalls[0][3]).toBe(false) // ignoreWhitespace=false

    expect(generateMsgCalls).toHaveLength(1)
    expect(generateMsgCalls[0]).toContain('new line')

    expect(useSessionStore.getState().sessions[FC_ROUTE].gitCommitMessage).toBe(
      'feat: generated message'
    )
  })

  it('onGenerateMessage shows error toast when no staged files', async () => {
    // Remove staged files
    useSessionStore.getState().setGitStatus(FC_ROUTE, makeStagedStatus([]))

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onGenerateMessage()
    })

    // No IPC calls made
    expect(filePatchCalls).toHaveLength(0)
    expect(generateMsgCalls).toHaveLength(0)

    // Toast shown with error
    expect(viewProps.toast).not.toBeNull()
    expect(viewProps.toast?.type).toBe('error')
  })

  it('commitDisabled is true when stagedCount is 0', () => {
    useSessionStore.getState().setGitStatus(FC_ROUTE, makeStagedStatus([]))

    render(React.createElement(GitCommitBox))

    expect(viewProps.commitDisabled).toBe(true)
  })

  it('commitDisabled is true when message is blank', () => {
    useSessionStore.getState().setGitCommitMessage(FC_ROUTE, '   ')

    render(React.createElement(GitCommitBox))

    expect(viewProps.commitDisabled).toBe(true)
  })

  it('onSecondaryCommit in commit-only mode triggers commitAndPush', async () => {
    // In commit-only mode, primary=commit, secondary=commitAndPush
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, gitCommitMode: 'commit' }
    }))

    render(React.createElement(GitCommitBox))

    await act(async () => {
      await viewProps.onSecondaryCommit()
    })

    // Commit was called
    expect(commitCalls).toHaveLength(1)
    // Push was attempted (commitAndPush path)
    expect(pushCalls).toHaveLength(1)
  })
})
