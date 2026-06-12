/**
 * Layer 2: Component tests for useTerminalColdCleanup.
 *
 * Verifies ADR-003: when a terminal cwd group has tabs but no session with
 * that cwd, after 10 minutes the PTYs are killed and the group is removed.
 *
 * Uses vi.useFakeTimers() to simulate time passage without real sleeps.
 *
 * IMPORTANT: the hook stores its timer Map at module scope. Each test must
 * unmount the hook in afterEach so the module's internal timers are cleared
 * and state doesn't leak between tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { useTerminalColdCleanup } from '../useTerminalColdCleanup'
import type { TerminalTab } from '../../../../shared/types'

const COLD_TIMEOUT_MS = 10 * 60 * 1000
const TEN_MIN_PLUS = 11 * 60 * 1000

// ---------------------------------------------------------------------------
// window.api stub
// ---------------------------------------------------------------------------

let killTerminalsByCwd: ReturnType<typeof vi.fn>

function installWindowApi(): void {
  killTerminalsByCwd = vi.fn().mockResolvedValue(undefined)
   
  ;(globalThis as any).window = globalThis.window || {}
   
  ;(globalThis as any).window.api = {
    killTerminalsByCwd,
    saveSessionConfig: () => {},
    saveSlashCommands: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([]),
  }
}

function resetStore(): void {
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    terminalGroups: {},
  })
}

/** Directly set a terminal group for a given cwd. */
function setTerminalGroup(cwd: string, tabs: TerminalTab[]): void {
  useSessionStore.setState((state) => ({
    terminalGroups: {
      ...state.terminalGroups,
      [cwd]: { tabs, activeTabId: tabs[0]?.id ?? null },
    },
  }))
}

const makeTab = (id: string, cwd: string): TerminalTab => ({ id, title: id, cwd })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTerminalColdCleanup', () => {
  beforeEach(() => {
    installWindowApi()
    resetStore()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetStore()
  })

  it('kills terminals and removes the group after 10 min when cwd has no active session (ADR-003)', async () => {
    const { unmount } = renderHook(() => useTerminalColdCleanup())

    // No session with /orphan/path → its terminal group is orphaned
    act(() => {
      setTerminalGroup('/orphan/path', [makeTab('tab-1', '/orphan/path')])
    })

    // Just before the 10-minute deadline, nothing should have fired
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_TIMEOUT_MS - 1000)
    })
    expect(killTerminalsByCwd).not.toHaveBeenCalled()
    expect(useSessionStore.getState().terminalGroups['/orphan/path']).toBeDefined()

    // Cross the deadline → cleanup fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MIN_PLUS - (COLD_TIMEOUT_MS - 1000))
    })

    expect(killTerminalsByCwd).toHaveBeenCalledTimes(1)
    expect(killTerminalsByCwd).toHaveBeenCalledWith('/orphan/path')
    expect(useSessionStore.getState().terminalGroups['/orphan/path']).toBeUndefined()

    unmount()
  })

  it('does NOT fire when a session with that cwd exists (terminal is in use)', async () => {
    const { unmount } = renderHook(() => useTerminalColdCleanup())

    // Active session with /active/path + a terminal group for that cwd
    act(() => {
      useSessionStore.getState().createNewSession('session-1', '/active/path')
      setTerminalGroup('/active/path', [makeTab('tab-1', '/active/path')])
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MIN_PLUS)
    })

    expect(killTerminalsByCwd).not.toHaveBeenCalled()
    expect(useSessionStore.getState().terminalGroups['/active/path']).toBeDefined()

    unmount()
  })

  it('cancels the cleanup timer when a session with that cwd reappears mid-wait', async () => {
    const { unmount } = renderHook(() => useTerminalColdCleanup())

    // Orphan at t=0
    act(() => {
      setTerminalGroup('/revived/path', [makeTab('tab-1', '/revived/path')])
    })

    // After 5 min, revive by creating a session with that cwd
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    })
    expect(killTerminalsByCwd).not.toHaveBeenCalled()

    act(() => {
      useSessionStore.getState().createNewSession('session-1', '/revived/path')
    })

    // Advance past the original 10-min deadline. Timer should have been cancelled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MIN_PLUS)
    })

    expect(killTerminalsByCwd).not.toHaveBeenCalled()
    expect(useSessionStore.getState().terminalGroups['/revived/path']).toBeDefined()

    unmount()
  })

  it('clears all pending timers on unmount so no cleanup fires after', async () => {
    const { unmount } = renderHook(() => useTerminalColdCleanup())

    act(() => {
      setTerminalGroup('/orphan/path', [makeTab('tab-1', '/orphan/path')])
    })

    // Unmount before the timeout fires
    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MIN_PLUS)
    })

    expect(killTerminalsByCwd).not.toHaveBeenCalled()
  })
})
