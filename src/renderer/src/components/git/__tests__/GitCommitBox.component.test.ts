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
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from '../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { GitStatusData } from '../../../../../shared/types'

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
    ...overrides,
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
    getPluginViews: () => Promise.resolve([]),
  }

  // Reset store to a clean slate
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
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
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      files: [
        { path: 'src/a.ts', index: 'M', working: ' ' },
        { path: 'src/b.ts', index: 'A', working: ' ' },
      ],
    }))

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
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      files: [{ path: 'src/a.ts', index: 'M', working: ' ' }],
    }))
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
      files: [{ path: 'src/a.ts', index: 'M', working: ' ' }],
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
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      staged: ['src/a.ts'],
      files: [{ path: 'src/a.ts', index: 'M', working: ' ' }],
    }))
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
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      staged: [],
      files: [{ path: 'src/a.ts', index: ' ', working: 'M' }],
    }))
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'fix: something')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitStatus?.staged.length).toBe(0)
  })

  it('commit is blocked when message is empty', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      staged: ['src/a.ts'],
    }))
    useSessionStore.getState().setGitCommitMessage(ROUTE, '')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitCommitMessage.trim()).toBe('')
  })

  it('allStaged is true when every changed file is staged', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus({
      staged: ['src/a.ts', 'src/b.ts'],
      files: [
        { path: 'src/a.ts', index: 'M', working: ' ' },
        { path: 'src/b.ts', index: 'A', working: ' ' },
      ],
    }))

    const session = useSessionStore.getState().sessions[ROUTE]
    const stagedCount = session.gitStatus?.staged.length ?? 0
    const totalChanges = session.gitStatus?.files.length ?? 0

    // Component derives: allStaged = totalChanges > 0 && stagedCount === totalChanges
    expect(totalChanges).toBeGreaterThan(0)
    expect(stagedCount).toBe(totalChanges)
  })
})
