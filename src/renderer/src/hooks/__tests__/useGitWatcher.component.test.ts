/**
 * Layer 2: Component tests for useGitWatcher.
 *
 * Verifies the hook subscribes/unsubscribes to git polling when the active
 * session's cwd changes. window.api is stubbed with vi.fn() spies — no IPC,
 * no main process. We drive the hook by mutating the Zustand store and
 * letting renderHook pick up re-renders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { useGitWatcher } from '../useGitWatcher'

// ---------------------------------------------------------------------------
// window.api stub
// ---------------------------------------------------------------------------

let gitStartWatching: ReturnType<typeof vi.fn>
let gitStopWatching: ReturnType<typeof vi.fn>
let gitCheckRepo: ReturnType<typeof vi.fn>

function installWindowApi(isRepo: boolean): void {
  gitStartWatching = vi.fn().mockResolvedValue(undefined)
  gitStopWatching = vi.fn().mockResolvedValue(undefined)
  gitCheckRepo = vi.fn().mockResolvedValue(isRepo)
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    gitStartWatching,
    gitStopWatching,
    gitCheckRepo,
    // session-store calls these when createNewSession/etc. fires
    saveSessionConfig: () => {},
    saveSlashCommands: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }
}

function resetStore(): void {
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
}

// flush queued microtasks — gitCheckRepo is a Promise, setIsGitRepo runs on
// the next tick. We need both to resolve before asserting.
const flush = async (): Promise<void> => {
  // Two microtask flushes: one for gitCheckRepo.then, one for any chained .then
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGitWatcher', () => {
  beforeEach(() => {
    installWindowApi(true)
    resetStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetStore()
  })

  it('starts git polling when the active session has a cwd in a git repo', async () => {
    // Pre-populate store: one session, it's the active one, marked as a git repo
    useSessionStore.getState().createNewSession('session-1', '/some/project')
    useSessionStore.getState().setIsGitRepo('session-1', true)

    renderHook(() => useGitWatcher())
    await flush()

    expect(gitCheckRepo).toHaveBeenCalledWith('/some/project')
    expect(gitStartWatching).toHaveBeenCalledWith('/some/project')
    expect(gitStopWatching).not.toHaveBeenCalled()
  })

  it('stops polling the old cwd and starts the new one when active session switches', async () => {
    useSessionStore.getState().createNewSession('session-1', '/repo-a')
    useSessionStore.getState().setIsGitRepo('session-1', true)
    useSessionStore.getState().createNewSession('session-2', '/repo-b', false /* switchTo */)
    useSessionStore.getState().setIsGitRepo('session-2', true)

    const { rerender } = renderHook(() => useGitWatcher())
    await flush()

    expect(gitStartWatching).toHaveBeenCalledWith('/repo-a')

    // Switch active session to session-2
    act(() => {
      useSessionStore.getState().switchSession('session-2')
    })
    rerender()
    await flush()

    // Old session's watcher got stopped
    expect(gitStopWatching).toHaveBeenCalledWith('/repo-a')
    // New session's watcher got started
    expect(gitStartWatching).toHaveBeenCalledWith('/repo-b')
  })

  it('does NOT start polling when cwd is not a git repo', async () => {
    // gitCheckRepo resolves false this time
    installWindowApi(false)
    useSessionStore.getState().createNewSession('session-1', '/not-a-repo')
    // isGitRepo starts false by default

    renderHook(() => useGitWatcher())
    await flush()

    expect(gitCheckRepo).toHaveBeenCalledWith('/not-a-repo')
    expect(gitStartWatching).not.toHaveBeenCalled()
  })

  it('stops watching on unmount', async () => {
    useSessionStore.getState().createNewSession('session-1', '/repo-a')
    useSessionStore.getState().setIsGitRepo('session-1', true)

    const { unmount } = renderHook(() => useGitWatcher())
    await flush()
    expect(gitStartWatching).toHaveBeenCalledWith('/repo-a')

    unmount()
    expect(gitStopWatching).toHaveBeenCalledWith('/repo-a')
  })
})
