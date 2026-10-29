/**
 * Layer 2: Component tests for GitBranchDropdown FC.
 *
 * Renders the FC with a mocked View to capture props without touching DOM.
 * Each test exercises a single View prop callback and asserts:
 *   1. The correct IPC channel was called with the expected args.
 *   2. The Zustand store was updated appropriately.
 *   3. Side-effects (onClose, popups, errors, etc.) occurred as expected.
 *
 * Auto-fetch on mount: the FC calls gitFetch() on mount when the branch has an
 * upstream and lastFetchTime is beyond the 30-second cooldown. We seed gitStatus
 * with a trackingBranch and keep gitLastFetchTime=null so the cooldown does not
 * suppress the auto-fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { resetFactoryCounter } from '@test/factories/messages'
import type { GitBranchDropdownViewProps } from '../View'
import type {
  GitStatusData,
  GitBranchData,
  GitBranchDetail,
  GitPullConfig
} from '../../../../../../shared/types'
import { GitBranchDropdown } from '../GitBranchDropdown'

// ---------------------------------------------------------------------------
// View mock — capture whatever props the FC passes to GitBranchDropdownView
// ---------------------------------------------------------------------------

let viewProps: GitBranchDropdownViewProps

vi.mock('../View', () => ({
  GitBranchDropdownView: (props: GitBranchDropdownViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTE = 'route-branch-dropdown'
const CWD = '/repo/branch-test'
const SHA = 'a'.repeat(40)

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
    ...overrides
  }
}

function detail(name: string, overrides: Partial<GitBranchDetail> = {}): GitBranchDetail {
  return {
    name,
    kind: 'local',
    commitTime: 1_700_000_000,
    ahead: 0,
    behind: 0,
    gone: false,
    current: false,
    ...overrides
  }
}

function makeGitBranches(overrides: Partial<GitBranchData> = {}): GitBranchData {
  return {
    current: 'feature/my-branch',
    local: ['main', 'dev', 'feature/my-branch'],
    remote: ['origin/main', 'origin/dev'],
    tracking: { 'feature/my-branch': 'origin/feature/my-branch' },
    details: [
      detail('feature/my-branch', {
        current: true,
        upstream: 'origin/feature/my-branch',
        ahead: 2,
        behind: 1
      }),
      detail('main', { upstream: 'origin/main' }),
      detail('dev', { upstream: 'origin/dev' }),
      detail('origin/main', { kind: 'remote' }),
      detail('origin/dev', { kind: 'remote' })
    ],
    autostashes: [],
    pullConfig: { rebase: null, ff: null },
    unpublished: 0,
    ...overrides
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
  let onClose: ReturnType<typeof vi.fn<() => void>>
  let anchorRef: React.RefObject<HTMLButtonElement | null>
  let branchesData: GitBranchData
  let statusData: GitStatusData

  // Track IPC calls per-channel, in call order across channels
  const ipcCalls: Record<string, unknown[][]> = {}
  const callOrder: string[] = []

  function record(channel: string, ...args: unknown[]): void {
    if (!ipcCalls[channel]) ipcCalls[channel] = []
    ipcCalls[channel].push(args)
    callOrder.push(channel)
  }

  beforeEach(async () => {
    resetFactoryCounter()
    onClose = vi.fn()
    anchorRef = { current: null }
    branchesData = makeGitBranches()
    statusData = makeGitStatus()

    // Clear IPC call tracking
    for (const key of Object.keys(ipcCalls)) delete ipcCalls[key]
    callOrder.length = 0

    app = await bootTestApp()
    const { bridge } = app

    // Register all git IPC handlers the FC uses
    bridge.ipcMain.handle('git:fetch', (_e, cwd: string) => {
      record('git:fetch', cwd)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:pull', (_e, cwd: string, mode?: string) => {
      record('git:pull', cwd, mode)
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
    bridge.ipcMain.handle('git:create-branch', (_e, cwd: string, name: string, base?: string) => {
      record('git:create-branch', cwd, name, base)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:stash-push', (_e, cwd: string) => {
      record('git:stash-push', cwd)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:stash-restore', (_e, cwd: string, sha: string) => {
      record('git:stash-restore', cwd, sha)
      return { ok: true, data: undefined }
    })
    bridge.ipcMain.handle('git:status', (_e, cwd: string) => {
      record('git:status', cwd)
      return { ok: true, data: statusData }
    })
    bridge.ipcMain.handle('git:branches', (_e, cwd: string) => {
      record('git:branches', cwd)
      return { ok: true, data: branchesData }
    })

    // Seed the store: create session, activate it, set git status
    // Keep gitLastFetchTime null so the mount auto-fetch is not suppressed
    // (null means no prior fetch -> cooldown does not apply)
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus())
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
      customTitles: {}
    })
  })

  /** Render the FC and flush all mount-time async effects. */
  async function renderFC(): Promise<void> {
    await act(async () => {
      render(React.createElement(GitBranchDropdown, { onClose, anchorRef }))
      // Flush mount effects (gitGetBranches + auto-fetch useEffects)
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  /** Seed a different git status (the store is what the FC reads). */
  function seedStatus(overrides: Partial<GitStatusData>): void {
    statusData = makeGitStatus(overrides)
    useSessionStore.getState().setGitStatus(ROUTE, statusData)
  }

  /** Type into the search box the way the View would. */
  function type(text: string): void {
    act(() => viewProps.onSearchChange(text))
  }

  const key = (k: string, extra: Partial<React.KeyboardEvent<HTMLInputElement>> = {}): void => {
    act(() =>
      viewProps.onSearchKeyDown({
        key: k,
        shiftKey: false,
        preventDefault: () => {},
        ...extra
      } as React.KeyboardEvent<HTMLInputElement>)
    )
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
    expect(typeof viewProps.onCreate).toBe('function')
    expect(viewProps.current).toBe('feature/my-branch')
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

    // Start fetch without awaiting it
    let fetchDone = false
    act(() => {
      // onFetch is typed as () => void but the FC binds an async handler
      const p = (viewProps.onFetch as () => Promise<void>)()
      p.then(() => {
        fetchDone = true
      })
    })

    // The FC should have synchronously set syncOp = 'fetching'
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('fetching')

    // Resolve the pending IPC and flush the promise chain
    await act(async () => {
      resolveFetch()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(fetchDone).toBe(true)
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncOperation).toBe('idle')
  })

  // -------------------------------------------------------------------------
  // onPull — a fast-forward just runs; a diverged branch asks first
  // -------------------------------------------------------------------------

  it('a fast-forward pull runs without asking', async () => {
    seedStatus({ ahead: 0, behind: 3 })
    await renderFC()

    await act(async () => {
      await viewProps.onPull()
    })

    expect(viewProps.pullPrompt).toBeNull()
    expect(ipcCalls['git:pull']).toHaveLength(1)
    expect(ipcCalls['git:pull'][0]).toEqual([CWD, undefined])
    expect(ipcCalls['git:status']).toBeDefined()
  })

  it('onPull transitions syncOp to pulling then idle', async () => {
    seedStatus({ ahead: 0, behind: 1 })
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

  describe.each<[string, GitPullConfig, string]>([
    ['unset (git needs a choice)', { rebase: null, ff: null }, 'ask'],
    ['pull.rebase=true', { rebase: 'rebase', ff: null }, 'rebase'],
    ['pull.rebase=false', { rebase: 'merge', ff: null }, 'merge'],
    ['pull.ff=only', { rebase: null, ff: 'only' }, 'ff-only']
  ])('diverged pull with %s', (_label, pullConfig, choice) => {
    it(`opens the popup with choice "${choice}" and pulls only once a mode is confirmed`, async () => {
      branchesData = makeGitBranches({ pullConfig })
      await renderFC() // status is ahead 2 / behind 1

      await act(async () => {
        await viewProps.onPull()
      })
      expect(viewProps.pullPrompt).toEqual({ ahead: 2, behind: 1, choice })
      expect(ipcCalls['git:pull']).toBeUndefined()

      await act(async () => {
        await viewProps.onPullConfirm('rebase')
      })
      expect(ipcCalls['git:pull'][0]).toEqual([CWD, 'rebase'])
      expect(viewProps.pullPrompt).toBeNull()
    })
  })

  it('cancelling the pull popup pulls nothing', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onPull()
    })
    act(() => viewProps.onPullCancel())
    expect(viewProps.pullPrompt).toBeNull()
    expect(ipcCalls['git:pull']).toBeUndefined()
  })

  it('a confirmed merge passes the merge mode', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onPull()
    })
    await act(async () => {
      await viewProps.onPullConfirm('merge')
    })
    expect(ipcCalls['git:pull'][0]).toEqual([CWD, 'merge'])
  })

  it("a failed pull shows git's whole message under a title, and dismisses", async () => {
    seedStatus({ ahead: 0, behind: 1 })
    app.bridge.ipcMain.handle('git:pull', () => ({
      ok: false,
      error: 'error: could not apply abc123\nhint: Resolve all conflicts manually'
    }))
    await renderFC()
    await act(async () => {
      await viewProps.onPull()
    })
    expect(viewProps.error?.title).toBe("Couldn't pull")
    expect(viewProps.error?.message).toContain('hint: Resolve all conflicts manually')
    expect(useSessionStore.getState().sessions[ROUTE].gitSyncError).toContain('could not apply')

    act(() => viewProps.onDismissError())
    expect(viewProps.error).toBeNull()
  })

  // -------------------------------------------------------------------------
  // onPush / onPublish
  // -------------------------------------------------------------------------

  it('onPush calls gitPush and refreshes status', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    expect(ipcCalls['git:push']).toBeDefined()
    expect(ipcCalls['git:push'][0][0]).toBe(CWD)

    // status/branches refreshed after successful push
    expect(ipcCalls['git:status']).toBeDefined()
  })

  it('onPush sets the error for a push failure', async () => {
    app.bridge.ipcMain.handle('git:push', () => ({
      ok: false,
      error: 'error: remote rejected - permission denied'
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onPush()
    })

    expect(viewProps.error?.title).toBe("Couldn't push")
    expect(viewProps.error?.message).toContain('remote rejected')
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.gitSyncError).toContain('remote rejected')
    expect(session.gitSyncOperation).toBe('idle')
  })

  it('onPublish pushes the current branch with -u', async () => {
    seedStatus({ trackingBranch: '', ahead: 0, behind: 0 })
    await renderFC()

    await act(async () => {
      await viewProps.onPublish()
    })

    expect(ipcCalls['git:push-with-upstream'][0]).toEqual([CWD, 'feature/my-branch'])
    expect(ipcCalls['git:push']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // onCheckout — clean tree switches; dirty tree asks
  // -------------------------------------------------------------------------

  it('onCheckout on a clean tree calls gitCheckout, refreshes status, and calls onClose', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onCheckout('dev')
    })

    expect(viewProps.stashPrompt).toBeNull()
    expect(ipcCalls['git:checkout']).toBeDefined()
    expect(ipcCalls['git:checkout'][0][0]).toBe(CWD)
    expect(ipcCalls['git:checkout'][0][1]).toBe('dev')
    expect(ipcCalls['git:stash-push']).toBeUndefined()

    // refreshAll triggered
    expect(ipcCalls['git:status']).toBeDefined()

    // Dropdown closed
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onCheckout of the current branch just closes', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onCheckout('feature/my-branch')
    })
    expect(ipcCalls['git:checkout']).toBeUndefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onCheckout sets the error and does NOT call onClose on failure', async () => {
    app.bridge.ipcMain.handle('git:checkout', () => ({
      ok: false,
      error: 'error: Your local changes would be overwritten by checkout.\nPlease commit them.'
    }))

    await renderFC()

    await act(async () => {
      await viewProps.onCheckout('other-branch')
    })

    expect(viewProps.error?.title).toBe("Couldn't switch to other-branch")
    expect(viewProps.error?.message).toContain('overwritten by checkout')
    expect(viewProps.error?.message).toContain('Please commit them.')
    expect(onClose).not.toHaveBeenCalled()
  })

  describe('with uncommitted changes', () => {
    beforeEach(() => {
      seedStatus({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] as GitStatusData['files'] })
    })

    it('asks first and switches nothing yet', async () => {
      await renderFC()
      await act(async () => {
        await viewProps.onCheckout('dev')
      })
      expect(viewProps.stashPrompt).toEqual({ branch: 'dev', files: 2 })
      expect(ipcCalls['git:checkout']).toBeUndefined()
      expect(ipcCalls['git:stash-push']).toBeUndefined()
    })

    it('"Stash and switch" stashes, then checks out', async () => {
      await renderFC()
      await act(async () => {
        await viewProps.onCheckout('dev')
      })
      await act(async () => {
        await viewProps.onStashAndSwitch()
      })
      const verbs = callOrder.filter((c) => c === 'git:stash-push' || c === 'git:checkout')
      expect(verbs).toEqual(['git:stash-push', 'git:checkout'])
      expect(ipcCalls['git:checkout'][0]).toEqual([CWD, 'dev'])
      expect(viewProps.stashPrompt).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('"Switch and bring them along" checks out without stashing', async () => {
      await renderFC()
      await act(async () => {
        await viewProps.onCheckout('dev')
      })
      await act(async () => {
        await viewProps.onSwitchAnyway()
      })
      expect(ipcCalls['git:stash-push']).toBeUndefined()
      expect(ipcCalls['git:checkout'][0]).toEqual([CWD, 'dev'])
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Cancel leaves everything alone', async () => {
      await renderFC()
      await act(async () => {
        await viewProps.onCheckout('dev')
      })
      act(() => viewProps.onStashCancel())
      expect(viewProps.stashPrompt).toBeNull()
      expect(ipcCalls['git:checkout']).toBeUndefined()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('a checkout that fails after stashing says so and stays open', async () => {
      app.bridge.ipcMain.handle('git:checkout', () => ({ ok: false, error: 'fatal: nope' }))
      await renderFC()
      await act(async () => {
        await viewProps.onCheckout('dev')
      })
      await act(async () => {
        await viewProps.onStashAndSwitch()
      })
      expect(viewProps.error?.title).toBe("Stashed, but couldn't switch to dev")
      expect(viewProps.error?.message).toContain('fatal: nope')
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  it('offers Restore for a ClaudeUI autostash from the current branch only, and applies it by sha', async () => {
    branchesData = makeGitBranches({
      autostashes: [
        { sha: 'b'.repeat(40), branch: 'dev', time: '2026-10-28T10:00:00.000Z' },
        { sha: SHA, branch: 'feature/my-branch', time: '2026-10-28T09:00:00.000Z' }
      ]
    })
    await renderFC()
    expect(viewProps.autostashCount).toBe(1)

    await act(async () => {
      await viewProps.onRestore()
    })
    expect(ipcCalls['git:stash-restore'][0]).toEqual([CWD, SHA])
    expect(viewProps.successMsg).toMatch(/Restored/)
  })

  it('shows no Restore row without a matching autostash', async () => {
    branchesData = makeGitBranches({
      autostashes: [{ sha: SHA, branch: 'dev', time: '2026-10-28T09:00:00.000Z' }]
    })
    await renderFC()
    expect(viewProps.autostashCount).toBe(0)
  })

  it('a conflicted restore reports git and keeps the stash on offer', async () => {
    branchesData = makeGitBranches({
      autostashes: [{ sha: SHA, branch: 'feature/my-branch', time: '2026-10-28T09:00:00.000Z' }]
    })
    app.bridge.ipcMain.handle('git:stash-restore', () => ({
      ok: false,
      error: 'CONFLICT (content): Merge conflict in a.ts'
    }))
    await renderFC()
    await act(async () => {
      await viewProps.onRestore()
    })
    expect(viewProps.error?.title).toBe("Couldn't restore the stash")
    expect(viewProps.error?.message).toContain('Merge conflict in a.ts')
    expect(viewProps.autostashCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Search doubles as create
  // -------------------------------------------------------------------------

  it('typing a new name offers Create; Enter creates it from the current branch', async () => {
    await renderFC()

    type('  feature/new-thing  ')
    expect(viewProps.list.createName).toBe('feature/new-thing')
    expect(viewProps.highlightKey).toBe('create')
    expect(viewProps.createBase).toBe('feature/my-branch')

    await act(async () => {
      key('Enter')
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(ipcCalls['git:create-branch'][0]).toEqual([CWD, 'feature/new-thing', null])
    expect(ipcCalls['git:status']).toBeDefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a picked base is passed to create', async () => {
    await renderFC()
    type('topic')
    act(() => viewProps.onToggleBaseMenu())
    expect(viewProps.baseMenuOpen).toBe(true)
    expect(viewProps.baseOptions).toEqual(['main', 'dev', 'feature/my-branch'])
    act(() => viewProps.onPickBase('main'))
    expect(viewProps.createBase).toBe('main')
    expect(viewProps.baseMenuOpen).toBe(false)

    await act(async () => {
      await viewProps.onCreate()
    })
    expect(ipcCalls['git:create-branch'][0]).toEqual([CWD, 'topic', 'main'])
  })

  it('an existing name offers no Create row', async () => {
    await renderFC()
    type('dev')
    expect(viewProps.list.createName).toBeNull()
  })

  it('Shift+Enter creates the typed name even with a match highlighted', async () => {
    await renderFC()
    type('mai') // matches main; "mai" is not a branch, so Create is offered too
    key('ArrowDown') // off Create, onto the first match
    expect(viewProps.highlightKey).toBe('local:main')
    await act(async () => {
      key('Enter', { shiftKey: true })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(ipcCalls['git:create-branch'][0][1]).toBe('mai')
    expect(ipcCalls['git:checkout']).toBeUndefined()
  })

  it('Enter on a highlighted match switches to it; arrows move the highlight', async () => {
    await renderFC()
    type('dev')
    expect(viewProps.highlightKey).toBe('local:dev')
    // origin/dev has a local twin, so the only row is the local one
    key('ArrowDown')
    expect(viewProps.highlightKey).toBe('local:dev')

    await act(async () => {
      key('Enter')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(ipcCalls['git:checkout'][0]).toEqual([CWD, 'dev'])
  })

  it('ArrowUp from the first row wraps to the last', async () => {
    await renderFC()
    type('mai') // Create "mai" + main
    expect(viewProps.list.navKeys).toEqual(['create', 'local:main'])
    key('ArrowUp')
    expect(viewProps.highlightKey).toBe('local:main')
  })

  it("create failure keeps the dropdown open with git's message", async () => {
    app.bridge.ipcMain.handle('git:create-branch', () => ({
      ok: false,
      error: "fatal: 'bad..name' is not a valid branch name"
    }))
    await renderFC()
    type('bad..name')
    await act(async () => {
      await viewProps.onCreate()
    })
    expect(viewProps.error?.title).toBe("Couldn't create bad..name")
    expect(viewProps.error?.message).toContain('not a valid branch name')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('onCreate does nothing when the text is blank', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onCreate()
    })
    expect(ipcCalls['git:create-branch']).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Mount effects
  // -------------------------------------------------------------------------

  it('loads branches from gitGetBranches on mount', async () => {
    await renderFC()

    // gitGetBranches is called on mount to populate the branch list
    expect(ipcCalls['git:branches']).toBeDefined()
    expect(viewProps.loaded).toBe(true)
  })

  it('auto-fetches on mount when the branch has an upstream and no prior fetch', async () => {
    await renderFC()

    expect(ipcCalls['git:fetch']).toBeDefined()
  })

  it('does NOT auto-fetch when cooldown has not expired', async () => {
    // Set lastFetchTime to now - within the 30s cooldown
    useSessionStore.getState().setGitLastFetchTime(ROUTE, Date.now())

    await renderFC()

    // Auto-fetch should be suppressed
    expect(ipcCalls['git:fetch']).toBeUndefined()
    expect(viewProps.fetchedLabel).toBe('Fetched just now')
  })

  // ── Escape ────────────────────────────────────────────────────────────────
  // Below tier 1 the top bar's menu row is the ONLY way to this panel, so it has
  // to answer the key like every other overlay — through the app's one stack.
  const pressEscape = (): void => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }

  it('Escape closes the dropdown', async () => {
    await renderFC()
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape peels the base list, then the typed text, then the dropdown', async () => {
    await renderFC()
    type('topic')
    act(() => viewProps.onToggleBaseMenu())

    pressEscape()
    expect(viewProps.baseMenuOpen).toBe(false)
    expect(viewProps.search).toBe('topic')

    pressEscape()
    expect(viewProps.search).toBe('')
    expect(onClose).not.toHaveBeenCalled()

    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
