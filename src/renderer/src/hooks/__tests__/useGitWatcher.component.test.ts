/**
 * Layer 2: Component tests for useGitWatcher.
 *
 * Verifies the hook states this client's git INTEREST as a replace set
 * (`git:watch {cwds}`, phase 5 S2) whenever the active session's cwd changes.
 * window.api is stubbed with vi.fn() spies — no IPC, no main process. We drive
 * the hook by mutating the Zustand store and letting renderHook pick up
 * re-renders.
 *
 * There is no stop verb and no unmount cleanup: `[]` IS the stop, and the set is
 * released by the CONNECTION's lifetime rather than by React. That is the whole
 * point of retiring the collective owner — a browser reloading its tab never ran
 * the cleanup, so a cleanup-based release leaked a 5 s poller per abandoned cwd.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { SyncClient } from '../../../../core/shared/sync/sync-client'
import {
  resetSyncClientForTests,
  setSyncClient
} from '../../../../core/shared/sync/client-registry'
import { useGitWatcher } from '../useGitWatcher'

/**
 * The hook keys its re-send on `onSyncAnswered`, so the registry needs a REAL
 * client to fire it. Answering a snapshot is the production trigger (initial
 * sync, resync and reconnect all end there), so drive that rather than reaching
 * into the tap set.
 */
let syncClient: SyncClient
const announceSyncAnswered = (): void => {
  syncClient.applyFullState({ seq: 1 } as never, 'epoch-1', 1)
}

// ---------------------------------------------------------------------------
// window.api stub
// ---------------------------------------------------------------------------

let watchGit: ReturnType<typeof vi.fn>
let gitCheckRepo: ReturnType<typeof vi.fn>

/** The cwd sets this client has stated, in order. */
const stated = (): string[][] => watchGit.mock.calls.map((c) => c[0] as string[])

function installWindowApi(isRepo: boolean): void {
  watchGit = vi.fn().mockResolvedValue(undefined)
  gitCheckRepo = vi.fn().mockResolvedValue(isRepo)
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    watchGit,
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
    resetSyncClientForTests()
    syncClient = new SyncClient({ requestResync: () => {} })
    setSyncClient(syncClient)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetStore()
    resetSyncClientForTests()
  })

  it('states the active session cwd when it is a git repo', async () => {
    // Pre-populate store: one session, it's the active one, marked as a git repo
    useSessionStore.getState().createNewSession('session-1', '/some/project')
    useSessionStore.getState().setIsGitRepo('session-1', true)

    renderHook(() => useGitWatcher())
    await flush()

    expect(gitCheckRepo).toHaveBeenCalledWith('/some/project')
    expect(stated()).toContainEqual(['/some/project'])
  })

  it('switching sessions REPLACES the set in one call — no stop verb', async () => {
    useSessionStore.getState().createNewSession('session-1', '/repo-a')
    useSessionStore.getState().setIsGitRepo('session-1', true)
    useSessionStore.getState().createNewSession('session-2', '/repo-b', false /* switchTo */)
    useSessionStore.getState().setIsGitRepo('session-2', true)

    const { rerender } = renderHook(() => useGitWatcher())
    await flush()

    expect(stated()).toContainEqual(['/repo-a'])

    // Switch active session to session-2
    act(() => {
      useSessionStore.getState().switchSession('session-2')
    })
    rerender()
    await flush()

    // The set becomes exactly the new cwd. Dropping /repo-a from the union is
    // what stops its poller — stated as one fact, not as a stop plus a start.
    expect(stated().at(-1)).toEqual(['/repo-b'])
    expect(stated().some((set) => set.includes('/repo-a') && set.includes('/repo-b'))).toBe(
      false
    )
  })

  it('states an EMPTY set when the cwd is not a git repo', async () => {
    // gitCheckRepo resolves false this time
    installWindowApi(false)
    useSessionStore.getState().createNewSession('session-1', '/not-a-repo')
    // isGitRepo starts false by default

    renderHook(() => useGitWatcher())
    await flush()

    expect(gitCheckRepo).toHaveBeenCalledWith('/not-a-repo')
    // Empty, not silent: the client says what it wants, and "nothing" is an
    // answer the union needs in order to shrink.
    expect(stated().every((set) => set.length === 0)).toBe(true)
  })

  it('re-states the set on every answered sync (a watch dies with its socket)', async () => {
    useSessionStore.getState().createNewSession('session-1', '/repo-a')
    useSessionStore.getState().setIsGitRepo('session-1', true)

    renderHook(() => useGitWatcher())
    await flush()
    const before = stated().length

    // A reconnect: the new connection holds no interest at all until this fires.
    act(() => {
      announceSyncAnswered()
    })
    await flush()

    expect(stated().length).toBeGreaterThan(before)
    expect(stated().at(-1)).toEqual(['/repo-a'])
  })
})
