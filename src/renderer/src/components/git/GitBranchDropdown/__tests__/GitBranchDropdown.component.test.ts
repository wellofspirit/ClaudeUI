/**
 * Layer 2: Component tests for GitBranchDropdown FC.
 *
 * Renders the FC with a mocked View to capture props without touching DOM.
 * Each test exercises a single View prop callback and asserts:
 *   1. The correct IPC channel was called with the expected args.
 *   2. The Zustand store was updated appropriately.
 *   3. Side-effects (onClose, upstreamPrompt, etc.) occurred as expected.
 *
 * Auto-fetch on mount: the FC calls gitFetch() on mount when hasTracking=true
 * and lastFetchTime is beyond the 30-second cooldown. We seed gitStatus with
 * a trackingBranch and keep gitLastFetchTime=null so the cooldown does not
 * suppress the auto-fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { resetFactoryCounter } from '@test/factories/messages'
import type { GitBranchDropdownViewProps } from '../View'
import type { GitStatusData, GitBranchData } from '../../../../../../shared/types'
import { GitBranchDropdown } from '../GitBranchDropdown'

// ---------------------------------------------------------------------------
// View mock — capture whatever props the FC passes to GitBranchDropdownView
// ---------------------------------------------------------------------------

let viewProps: GitBranchDropdownViewProps

vi.mock('../View', () => ({
  GitBranchDropdownView: (props: GitBranchDropdownViewProps) => {
    viewProps = props
    return null
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTE = 'route-branch-dropdown'
const CWD = '/repo/branch-test'

function makeGitStatus(overrides: Partial<GitStatusData> = {}): GitStatusData {
  return {
    branch: 'feature/my-branch',
    ahead: 2,
    behind: 1,
    trackingBranch: 'origin/feature/my-branch',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides,
  }
}

function makeGitBranches(overrides: Partial<GitBranchData> = {}): GitBranchData {
  return {
    current: 'feature/my-branch',
    local: ['main', 'dev', 'feature/my-branch'],
    remote: ['origin/main', 'origin/dev'],
    tracking: { 'feature/my-branch': 'origin/feature/my-branch' },
    ...overrides,
  }
}

function makePullResult(): { summary: string } {
  return { summary: 'Already up to date' }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('GitBranchDropdown FC — rendered', () => {
  let app: TestApp
  const onClose = vi.fn() as unknown as () => void
  let anchorRef: React.RefObject<HTMLButtonElement | null>

  // Track IPC calls per-channel
  const ipcCalls: Record<string, unknown[][]> = {}

  function record(channel: string, ...args: unknown[]): void {
    if (!ipcCalls[channel]) ipcCalls[channel] = []
    ipcCalls[channel].push(args)
  }

  beforeEach(async () => {
    resetFactoryCounter()
    anchorRef = { current: null }

    // Clear IPC call tracking
    for (const key of Object.keys(ipcCalls)) delete ipcCalls[key]

    app = await bootTestApp()
    const { bridge } = app

    // Register all git IPC handlers the FC uses
    bridge.ipcMain.handle('git:fetch', (_e, cwd: string) => {
      record('git:fetch', cwd)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:pull', (_e, cwd: string) => {
      record('git:pull', cwd)
      return { ok: true, data: makePullResult() }
    })
    bridge.ipcMain.handle('git:push', (_e, cwd: string) => {
      record('git:push', cwd)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:push-with-upstream', (_e, cwd: string, branch: string) => {
      record('git:push-with-upstream', cwd, branch)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:checkout', (_e, cwd: string, branch: string) => {
      record('git:checkout', cwd, branch)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:create-branch', (_e, cwd: string, name: string) => {
      record('git:create-branch', cwd, name)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      record('git:status', cwd)
      return { ok: true, data: makeGitStatus() }
    })
    bridge.ipcMain.handle('git:branches', (_e, cwd: string) => {
      record('git:branches', cwd)
      return { ok: true, data: makeGitBranches() }
    })

    // Seed the store: create session, activate it, set git status + last fetch time
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus())
    // Keep gitLastFetchTime null so the mount auto-fetch is not suppressed
    // (null means no prior fetch → cooldown does not apply)
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
    })
  })

  async function renderFC(): Promise<void> {
    await act(async () => {
      render(React.createElement(GitBranchDropdown, { onClose, anchorRef }))
      // Flush mount effects (gitGetBranches + auto-fetch useEffects)
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  // -------------------------------------------------------------------------
  // Smoke test
  // -------------------------------------------------------------------------

  it('renders without crashing and passes initial props to View', async () => {
    await renderFC()
    expect(viewProps).toBeDefined()
    expect(typeof viewProps.onFetch).toBe('function')
    expect(typeof viewProps.onPull).toBe('function')
    expect(typeof viewProps.onPush).toBe('function')
    expect(typeof viewProps.onCheckout).toBe('function')
    expect(typeof viewProps.onCreateBranch).toBe('function')
  })

  // -------------------------------------------------------------------------
  // onFetch
  // -------------------------------------------------------------------------

  it('onFetch calls gitFetch and refreshes status/branches in store', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onFetch()
    })

    // IPC called with correct cwd
    expect(ipcCalls['git:fetch']).toBeDefined()
    expect(ipcCalls['git:fetch'][0][0]).toBe(CWD)

    // refreshAll triggers both gitGetStatus + gitGetBranches
    expect(ipcCalls['git:status']).toBeDefined()
    expect(ipcCalls['git:branches']).toBeDefined()

    // Store updated with refreshed status
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitStatus?.branch).toBe('feature/my-branch')
  })

  it('onFetch transitions syncOp to fetching then back to idle', async () => {
    // Delay the fetch handler so we can observe the intermediate state
    let resolveFetch!: () => void
    app.bridge.ipcMain.handle('git:fetch', () => {
      return new Promise<{ ok: boolean; data: undefined }>((res) => {
        resolveFetch = () => res({ ok: true, data: undefined })
      })
    })

    await renderFC()

    // Start fetch — do not await
    let fetchDone = false
    act(() => {
      ;(viewProps.onFetch() as unknown as Promise<void>).then(() => { fetchDone = true })
    })

    // At this point the FC should have set syncOp = 'fetching'
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('fetching')

    // Resolve the pending fetch
    await act(async () => {
      resolveFetch()
      // Give the promise chain a tick to run
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(fetchDone).toBe(true)
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('idle')
  })

  // -------------------------------------------------------------------------
  // onPull
  // -------------------------------------------------------------------------

  it('onPull calls gitPull and refreshes status', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onPull()
    })

    expect(ipcCalls['git:pull']).toBeDefined()
    expect(ipcCalls['git:pull'][0][0]).toBe(CWD)

    // status refresh happened
    expect(ipcCalls['git:status']).toBeDefined()
  })

  it('onPull transitions syncOp to pulling then idle', async () => {
    let resolvePull!: () => void
    app.bridge.ipcMain.handle('git:pull', () => {
      return new Promise<{ ok: boolean; data: { summary: string } }>((res) => {
        resolvePull = () => res({ ok: true, data: { summary: 'Already up to date' } })
      })
    })

    await renderFC()

    act(() => {
      viewProps.onPull()
    })

    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('pulling')

    await act(async () => {
      resolvePull()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('idle')
  })

  // -------------------------------------------------------------------------
  // onPush
  // -------------------------------------------------------------------------

  it('onPush calls gitPush and refreshes status', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    expect(ipcCalls['git:push']).toBeDefined()
    expect(ipcCalls['git:push'][0][0]).toBe(CWD)

    // status/branches refreshed
    expect(ipcCalls['git:status']).toBeDefined()
  })

  it('onPush shows upstreamPrompt when push fails with "no upstream branch" error', async () => {
    // Override push to return a no-upstream error
    app.bridge.ipcMain.handle('git:push', () => ({
      ok: false,
      error: 'error: The current branch feature/my-branch has no upstream branch.',
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    // upstreamPrompt should be set with the current branch name
    expect(viewProps.upstreamPrompt).not.toBeNull()
    expect(viewProps.upstreamPrompt?.branch).toBe('feature/my-branch')

    // syncOp returns to idle even on error
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('idle')
  })

  it('onPush sets syncError for generic push failures (not upstream errors)', async () => {
    app.bridge.ipcMain.handle('git:push', () => ({
      ok: false,
      error: 'error: remote rejected — permission denied',
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    expect(viewProps.upstreamPrompt).toBeNull()

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitSyncError).toContain('remote rejected')
  })

  // -------------------------------------------------------------------------
  // onPushWithUpstream
  // -------------------------------------------------------------------------

  it('onPushWithUpstream calls gitPushWithUpstream with the branch from upstreamPrompt', async () => {
    // First trigger a push failure to set upstreamPrompt
    app.bridge.ipcMain.handle('git:push', () => ({
      ok: false,
      error: 'error: The current branch has no upstream branch.',
    }))

    await renderFC()

    // Trigger the failing push to set upstreamPrompt
    await act(async () => {
      await viewProps.onPush()
    })

    expect(viewProps.upstreamPrompt).not.toBeNull()

    // Now call onPushWithUpstream
    await act(async () => {
      await viewProps.onPushWithUpstream()
    })

    expect(ipcCalls['git:push-with-upstream']).toBeDefined()
    expect(ipcCalls['git:push-with-upstream'][0][0]).toBe(CWD)
    expect(ipcCalls['git:push-with-upstream'][0][1]).toBe('feature/my-branch')

    // Prompt dismissed after successful upstream push
    expect(viewProps.upstreamPrompt).toBeNull()
  })

  // -------------------------------------------------------------------------
  // onCheckout
  // -------------------------------------------------------------------------

  it('onCheckout calls gitCheckout, refreshes status, and calls onClose', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onCheckout('dev')
    })

    expect(ipcCalls['git:checkout']).toBeDefined()
    expect(ipcCalls['git:checkout'][0][0]).toBe(CWD)
    expect(ipcCalls['git:checkout'][0][1]).toBe('dev')

    // refreshAll triggered
    expect(ipcCalls['git:status']).toBeDefined()

    // Dropdown closed
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onCheckout sets localError and does NOT call onClose on failure', async () => {
    app.bridge.ipcMain.handle('git:checkout', () => ({
      ok: false,
      error: 'error: Your local changes would be overwritten by checkout.',
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onCheckout('other-branch')
    })

    expect(viewProps.localError).toContain('overwritten by checkout')
    expect(onClose).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // onCreateBranch
  // -------------------------------------------------------------------------

  it('onCreateBranch calls gitCreateBranch with trimmed name, refreshes, and closes', async () => {
    await renderFC()

    // Set the branch name via onNewBranchNameChange first
    act(() => {
      viewProps.onNewBranchNameChange('  feature/new-thing  ')
    })

    await act(async () => {
      await viewProps.onCreateBranch()
    })

    expect(ipcCalls['git:create-branch']).toBeDefined()
    expect(ipcCalls['git:create-branch'][0][0]).toBe(CWD)
    expect(ipcCalls['git:create-branch'][0][1]).toBe('feature/new-thing')

    // refreshAll triggered
    expect(ipcCalls['git:status']).toBeDefined()

    // Dropdown closed
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onCreateBranch does nothing when newBranchName is blank', async () => {
    await renderFC()

    // Leave newBranchName empty (default)
    await act(async () => {
      await viewProps.onCreateBranch()
    })

    expect(ipcCalls['git:create-branch']).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('onCreateBranch sets localError and does NOT call onClose on failure', async () => {
    app.bridge.ipcMain.handle('git:create-branch', () => ({
      ok: false,
      error: 'error: A branch named that already exists.',
    }))

    await renderFC()

    act(() => {
      viewProps.onNewBranchNameChange('existing-branch')
    })

    await act(async () => {
      await viewProps.onCreateBranch()
    })

    expect(viewProps.localError).toContain('already exists')
    expect(onClose).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Mount effects
  // -------------------------------------------------------------------------

  it('loads branches from gitGetBranches on mount', async () => {
    await act(async () => {
      renderFC()
      // Allow the useEffect promise to resolve
      await new Promise((r) => setTimeout(r, 0))
    })

    // gitGetBranches is called on mount to populate the branch list
    expect(ipcCalls['git:branches']).toBeDefined()
  })

  it('auto-fetches on mount when hasTracking=true and no prior fetch', async () => {
    // gitStatus already has trackingBranch set; gitLastFetchTime is null
    await act(async () => {
      renderFC()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(ipcCalls['git:fetch']).toBeDefined()
  })

  it('does NOT auto-fetch when cooldown has not expired', async () => {
    // Set lastFetchTime to now — within the 30s cooldown
    useSessionStore.getState().setGitLastFetchTime(ROUTE, Date.now())

    await act(async () => {
      renderFC()
      await new Promise((r) => setTimeout(r, 0))
    })

    // Auto-fetch should be suppressed
    expect(ipcCalls['git:fetch']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // onDismissUpstream
  // -------------------------------------------------------------------------

  it('onDismissUpstream clears upstreamPrompt without calling IPC', async () => {
    // Trigger push failure to set prompt
    app.bridge.ipcMain.handle('git:push', () => ({
      ok: false,
      error: 'error: The current branch has no upstream branch.',
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    expect(viewProps.upstreamPrompt).not.toBeNull()

    act(() => {
      viewProps.onDismissUpstream()
    })

    expect(viewProps.upstreamPrompt).toBeNull()
    // No upstream push IPC was called
    expect(ipcCalls['git:push-with-upstream']).toBeUndefined()
  })
})
