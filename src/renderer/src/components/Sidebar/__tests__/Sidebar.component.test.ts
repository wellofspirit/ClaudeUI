/**
 * Layer 2: Component tests for Sidebar FC.
 *
 * The FC wires the Zustand store + IPC to <SidebarView>. We mock the View to
 * capture props, then call prop callbacks and assert IPC + store effects.
 *
 * Tested flows:
 *   1. listDirectories called on mount → directories populated
 *   2. onNewSessionDblClick → pickFolder → createNewSession
 *   3. onClickSession (already loaded) → switchSession
 *   4. onClickSession (not loaded) → loadSessionHistory + loadHistoricalSession
 *   5. onPin / onUnpin → store mutations
 *   6. onFinishRename with non-empty → setCustomTitle + writeCustomTitle
 *   7. onFinishRename with empty → generateTitle → applyTitle
 *   8. onToggleWatch → watchSession / unwatchSession + setWatching
 *   9. onDeleteSession → deleteTarget set; onConfirmDelete → api.deleteSession
 *  10. onReorderPinned → reorderPinnedSessions store action
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { SidebarViewProps } from '../View'
import type { SessionInfo, DirectoryGroup } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock the View to capture props (no DOM render)
// ---------------------------------------------------------------------------

let viewProps: SidebarViewProps
vi.mock('../View', () => ({
  SidebarView: (props: SidebarViewProps) => {
    viewProps = props
    return null
  },
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_KEY = '-d-workplace-demo'
const CWD = '/d/WorkPlace/demo'

function makeSessionInfo(id: string, title = 'Session title'): SessionInfo {
  return {
    sessionId: id,
    cwd: CWD,
    projectKey: PROJECT_KEY,
    title,
    timestamp: Date.now(),
    lastActivityAt: Date.now(),
  }
}

function makeDirectoryGroup(sessions: SessionInfo[]): DirectoryGroup {
  return {
    cwd: CWD,
    projectKey: PROJECT_KEY,
    folderName: 'demo',
    sessions,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Sidebar FC', () => {
  let app: TestApp

  beforeEach(async () => {
    // useIsMobile calls window.matchMedia — jsdom needs a stub
    ;(window as any).matchMedia = (window as any).matchMedia || ((): MediaQueryList => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList))

    app = await bootTestApp()

    // Register the IPC handlers the Sidebar relies on; tests override as needed.
    app.bridge.ipcMain.handle('session:list-directories', async () => [])
    app.bridge.ipcMain.handle('session:load-history', async () => ({
      messages: [],
      taskNotifications: [],
      customTitle: null,
      agentIdToToolUseId: {},
      statusLine: null,
      teamName: null,
      pendingTeammates: {},
      taskPrompts: {},
    }))
    app.bridge.ipcMain.handle('session:load-subagent-history', async () => [])
    app.bridge.ipcMain.handle('session:build-subagent-file-map', async () => ({}))
    app.bridge.ipcMain.handle('session:pick-folder', async () => null)
    app.bridge.ipcMain.handle('session:watch-session', async () => undefined)
    app.bridge.ipcMain.handle('session:unwatch-session', async () => undefined)
    app.bridge.ipcMain.handle('session:write-custom-title', async () => undefined)
    app.bridge.ipcMain.handle('session:generate-title', async () => 'auto-title')
    app.bridge.ipcMain.handle('session:delete-session' as any, async () => undefined)
    app.bridge.ipcMain.handle('session:delete-project' as any, async () => undefined)

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      hiddenSessionIds: [],
      hiddenProjectKeys: [],
      customTitles: {},
      worktreeInfoMap: {},
      pluginViews: [],
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { Sidebar } = await import('../Sidebar')
    return render(React.createElement(Sidebar))
  }

  // -------------------------------------------------------------------------
  // 1. Mount — listDirectories populates store
  // -------------------------------------------------------------------------

  it('fetches directories on mount and populates store', async () => {
    const group = makeDirectoryGroup([makeSessionInfo('sess-1')])
    app.bridge.ipcMain.handle('session:list-directories', async () => [group])

    await act(async () => { await renderFC() })

    expect(useSessionStore.getState().directories).toHaveLength(1)
    expect(useSessionStore.getState().directories[0].sessions).toHaveLength(1)
    expect(viewProps.augmentedDirs[0].folderName).toBe('demo')
  })

  // -------------------------------------------------------------------------
  // 2. onNewSessionDblClick — pickFolder → createNewSession
  // -------------------------------------------------------------------------

  it('picks a folder and creates a new session on double-click', async () => {
    app.bridge.ipcMain.handle('session:pick-folder', async () => '/new/folder')

    await act(async () => { await renderFC() })

    await act(async () => { await viewProps.onNewSessionDblClick() })

    const sessions = Object.values(useSessionStore.getState().sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].cwd).toBe('/new/folder')
  })

  // -------------------------------------------------------------------------
  // 3. onClickSession (loaded in store) — just switchSession
  // -------------------------------------------------------------------------

  it('switches to an already-loaded session without IPC', async () => {
    useSessionStore.getState().createNewSession('already-loaded', CWD)

    let loadHistoryCalls = 0
    app.bridge.ipcMain.handle('session:load-history', async () => {
      loadHistoryCalls++
      return {
        messages: [], taskNotifications: [], customTitle: null,
        agentIdToToolUseId: {}, statusLine: null, teamName: null,
        pendingTeammates: {}, taskPrompts: {},
      }
    })

    await act(async () => { await renderFC() })

    await act(async () => {
      await viewProps.onClickSession(makeSessionInfo('already-loaded'))
    })

    expect(loadHistoryCalls).toBe(0)
    expect(useSessionStore.getState().activeSessionId).toBe('already-loaded')
  })

  // -------------------------------------------------------------------------
  // 4. onClickSession (not loaded) — loads from disk
  // -------------------------------------------------------------------------

  it('loads session history from disk when clicking an unloaded session', async () => {
    const historyCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:load-history', async (...args) => {
      historyCalls.push(args)
      return {
        messages: [], taskNotifications: [], customTitle: 'From disk',
        agentIdToToolUseId: {}, statusLine: null, teamName: null,
        pendingTeammates: {}, taskPrompts: {},
      }
    })

    await act(async () => { await renderFC() })

    await act(async () => {
      await viewProps.onClickSession(makeSessionInfo('disk-sess'))
    })

    expect(historyCalls).toHaveLength(1)
    // historyCalls[0] = [event, sessionId, projectKey]
    expect(historyCalls[0][1]).toBe('disk-sess')
    expect(historyCalls[0][2]).toBe(PROJECT_KEY)
    expect(useSessionStore.getState().customTitles['disk-sess']).toBe('From disk')
    expect(useSessionStore.getState().activeSessionId).toBe('disk-sess')
  })

  // -------------------------------------------------------------------------
  // 5. onPin / onUnpin — store mutations
  // -------------------------------------------------------------------------

  it('pins and unpins sessions via store actions', async () => {
    useSessionStore.getState().createNewSession('sess-p', CWD)

    await act(async () => { await renderFC() })

    act(() => { viewProps.onPin('sess-p') })
    expect(useSessionStore.getState().pinnedSessionIds).toContain('sess-p')

    act(() => { viewProps.onUnpin('sess-p') })
    expect(useSessionStore.getState().pinnedSessionIds).not.toContain('sess-p')
  })

  // -------------------------------------------------------------------------
  // 6. onFinishRename (non-empty) — setCustomTitle + writeCustomTitle IPC
  // -------------------------------------------------------------------------

  it('applies a custom title and persists to disk', async () => {
    const group = makeDirectoryGroup([makeSessionInfo('rename-sess')])
    // listDirectories is called on mount and overwrites preseeded directories —
    // stub it to return our group so findProjectKey can resolve.
    app.bridge.ipcMain.handle('session:list-directories', async () => [group])

    const writeCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:write-custom-title', async (...args) => {
      writeCalls.push(args)
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => {
      viewProps.onFinishRename('rename-sess', 'My New Title')
    })

    expect(useSessionStore.getState().customTitles['rename-sess']).toBe('My New Title')
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0][1]).toBe('rename-sess')
    expect(writeCalls[0][2]).toBe(PROJECT_KEY)
    expect(writeCalls[0][3]).toBe('My New Title')
  })

  // -------------------------------------------------------------------------
  // 7. onAutoRename — generateTitle IPC + applyTitle
  // -------------------------------------------------------------------------

  it('auto-generates a title by calling generateTitle IPC', async () => {
    const group = makeDirectoryGroup([makeSessionInfo('auto-sess')])
    app.bridge.ipcMain.handle('session:list-directories', async () => [group])

    // Session must exist with some text content for the FC to build conversationText
    useSessionStore.getState().createNewSession('auto-sess', CWD)
    useSessionStore.getState().addMessage('auto-sess', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'Hello world'.repeat(40) }],
      timestamp: Date.now(),
    })

    const generateCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:generate-title', async (...args) => {
      generateCalls.push(args)
      return 'generated-title'
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    await act(async () => {
      viewProps.onAutoRename('auto-sess')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(generateCalls).toHaveLength(1)
    expect(useSessionStore.getState().customTitles['auto-sess']).toBe('generated-title')
  })

  // -------------------------------------------------------------------------
  // 8. onToggleWatch — watchSession IPC + setWatching
  // -------------------------------------------------------------------------

  it('watches and unwatches sessions via IPC', async () => {
    // Start with a loaded session (not watching)
    useSessionStore.getState().createNewSession('watch-sess', CWD)

    const watchCalls: unknown[][] = []
    const unwatchCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:watch-session', async (...args) => { watchCalls.push(args) })
    app.bridge.ipcMain.handle('session:unwatch-session', async (...args) => { unwatchCalls.push(args) })

    await act(async () => { await renderFC() })

    // Toggle on
    act(() => {
      viewProps.onToggleWatch(makeSessionInfo('watch-sess'))
    })
    expect(watchCalls).toHaveLength(1)
    expect(useSessionStore.getState().sessions['watch-sess'].isWatching).toBe(true)

    // Toggle off
    act(() => {
      viewProps.onToggleWatch(makeSessionInfo('watch-sess'))
    })
    expect(unwatchCalls).toHaveLength(1)
    expect(useSessionStore.getState().sessions['watch-sess'].isWatching).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 9. onDeleteSession → deleteTarget; onConfirmDelete → deleteSession IPC
  // -------------------------------------------------------------------------

  it('shows a delete confirmation, then calls deleteSession IPC on confirm', async () => {
    const deleteCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:delete-session' as any, async (...args) => {
      deleteCalls.push(args)
    })

    await act(async () => { await renderFC() })

    act(() => {
      viewProps.onDeleteSession(makeSessionInfo('del-sess'))
    })
    expect(viewProps.deleteTarget?.kind).toBe('session')

    await act(async () => { await viewProps.onConfirmDelete() })

    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0][1]).toBe('del-sess')
    expect(deleteCalls[0][2]).toBe(PROJECT_KEY)
  })

  // -------------------------------------------------------------------------
  // 10. onReorderPinned — reorderPinnedSessions store action
  // -------------------------------------------------------------------------

  it('reorders pinned sessions', async () => {
    useSessionStore.setState({ pinnedSessionIds: ['a', 'b', 'c'] })

    await act(async () => { await renderFC() })

    act(() => { viewProps.onReorderPinned(['c', 'a', 'b']) })

    expect(useSessionStore.getState().pinnedSessionIds).toEqual(['c', 'a', 'b'])
  })

  // -------------------------------------------------------------------------
  // 11. Team session branch — loadSessionHistory returns teamName + teammates
  // -------------------------------------------------------------------------

  it('reconstructs team state when loading a team session from disk', async () => {
    app.bridge.ipcMain.handle('session:load-history', async () => ({
      messages: [],
      taskNotifications: [],
      customTitle: null,
      agentIdToToolUseId: { 'coder@team-v1': 'tu-coder' },
      statusLine: null,
      teamName: 'team-v1',
      pendingTeammates: {
        'tu-coder': { name: 'Coder', teamName: 'team-v1' },
      },
      taskPrompts: { 'tu-coder': 'coder prompt' },
    }))
    app.bridge.ipcMain.handle('session:build-subagent-file-map', async () => ({ 'tu-coder': 'hexfile-1' }))
    app.bridge.ipcMain.handle('session:load-subagent-history', async () => [])

    await act(async () => { await renderFC() })
    await act(async () => {
      await viewProps.onClickSession(makeSessionInfo('team-sess'))
    })

    const session = useSessionStore.getState().sessions['team-sess']
    expect(session.teamName).toBe('team-v1')
    expect(Object.values(session.teammates)).toHaveLength(1)
    const teammate = Object.values(session.teammates)[0]
    expect(teammate.name).toBe('Coder')
    expect(teammate.agentId).toBe('coder@team-v1')
  })

  // -------------------------------------------------------------------------
  // 12. onToggleWatch async load-then-watch — session not in memory
  // -------------------------------------------------------------------------

  it('loads history from disk before watching a session not in memory', async () => {
    app.bridge.ipcMain.handle('session:load-history', async () => ({
      messages: [],
      taskNotifications: [],
      customTitle: 'Disk Title',
      agentIdToToolUseId: {},
      statusLine: null,
      teamName: null,
      pendingTeammates: {},
      taskPrompts: {},
    }))

    const watchCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:watch-session', async (...args) => { watchCalls.push(args) })

    await act(async () => { await renderFC() })

    await act(async () => {
      viewProps.onToggleWatch(makeSessionInfo('cold-sess'))
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // Session should now be loaded AND watching
    expect(useSessionStore.getState().sessions['cold-sess']).toBeDefined()
    expect(useSessionStore.getState().sessions['cold-sess'].isWatching).toBe(true)
    expect(watchCalls).toHaveLength(1)
    expect(useSessionStore.getState().customTitles['cold-sess']).toBe('Disk Title')
  })

  // -------------------------------------------------------------------------
  // 13. Worktree cleanup callbacks
  // -------------------------------------------------------------------------

  it('onRemoveRecent opens the worktree cleanup modal when the session has worktree info', async () => {
    useSessionStore.setState({
      worktreeInfoMap: {
        'wt-sess': {
          worktreeName: 'feat-x',
          worktreePath: '/d/repo/.claude/worktrees/feat-x',
          worktreeBranch: 'feat/x',
          gitRoot: '/d/repo',
        } as any,
      },
    })

    await act(async () => { await renderFC() })

    act(() => { viewProps.onRemoveRecent(makeSessionInfo('wt-sess')) })

    expect(viewProps.cleanupWorktree?.sessionId).toBe('wt-sess')
  })

  it('onWorktreeCleanupRemove clears worktree info and removes from recents', async () => {
    useSessionStore.setState({
      recentSessionIds: ['wt-sess'],
      worktreeInfoMap: {
        'wt-sess': {
          worktreeName: 'feat-x',
          worktreePath: '/p',
          worktreeBranch: 'b',
          gitRoot: '/r',
        } as any,
      },
    })

    await act(async () => { await renderFC() })
    act(() => { viewProps.onRemoveRecent(makeSessionInfo('wt-sess')) })

    act(() => { viewProps.onWorktreeCleanupRemove() })

    expect(useSessionStore.getState().recentSessionIds).not.toContain('wt-sess')
    expect(useSessionStore.getState().worktreeInfoMap['wt-sess']).toBeUndefined()
    expect(viewProps.cleanupWorktree).toBeNull()
  })

  it('onWorktreeCleanupCancel dismisses the modal without touching recents or worktree info', async () => {
    useSessionStore.setState({
      recentSessionIds: ['wt-sess'],
      worktreeInfoMap: {
        'wt-sess': {
          worktreeName: 'feat-x',
          worktreePath: '/p',
          worktreeBranch: 'b',
          gitRoot: '/r',
        } as any,
      },
    })

    await act(async () => { await renderFC() })
    act(() => { viewProps.onRemoveRecent(makeSessionInfo('wt-sess')) })
    expect(viewProps.cleanupWorktree?.sessionId).toBe('wt-sess')

    act(() => { viewProps.onWorktreeCleanupCancel() })

    // Modal closed, but recents and worktree info untouched
    expect(viewProps.cleanupWorktree).toBeNull()
    expect(useSessionStore.getState().recentSessionIds).toContain('wt-sess')
    expect(useSessionStore.getState().worktreeInfoMap['wt-sess']).toBeDefined()
  })

  it('onWorktreeCleanupKeep removes from recents but preserves worktree info', async () => {
    useSessionStore.setState({
      recentSessionIds: ['wt-sess'],
      worktreeInfoMap: {
        'wt-sess': {
          worktreeName: 'feat-x',
          worktreePath: '/p',
          worktreeBranch: 'b',
          gitRoot: '/r',
        } as any,
      },
    })

    await act(async () => { await renderFC() })
    act(() => { viewProps.onRemoveRecent(makeSessionInfo('wt-sess')) })

    act(() => { viewProps.onWorktreeCleanupKeep() })

    expect(useSessionStore.getState().recentSessionIds).not.toContain('wt-sess')
    expect(useSessionStore.getState().worktreeInfoMap['wt-sess']).toBeDefined()
    expect(viewProps.cleanupWorktree).toBeNull()
  })

  // -------------------------------------------------------------------------
  // 14. Auto-rename failure paths
  // -------------------------------------------------------------------------

  it('falls back to kebab slug when generateTitle returns null', async () => {
    const group = makeDirectoryGroup([makeSessionInfo('auto-sess')])
    app.bridge.ipcMain.handle('session:list-directories', async () => [group])

    useSessionStore.getState().createNewSession('auto-sess', CWD)
    useSessionStore.getState().addMessage('auto-sess', {
      id: 'u1', role: 'user',
      content: [{ type: 'text', text: 'Refactor the login screen flow' }],
      timestamp: Date.now(),
    })

    app.bridge.ipcMain.handle('session:generate-title', async () => null)

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    await act(async () => {
      viewProps.onAutoRename('auto-sess')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // FC builds a kebab slug from the first user message (lowercase, dashes,
    // truncated to 40 chars — the first 60 chars of the prompt get slugified).
    expect(useSessionStore.getState().customTitles['auto-sess']).toBe('refactor-the-login-screen-flow')
  })

  it('clears the "generating..." title when generateTitle rejects', async () => {
    const group = makeDirectoryGroup([makeSessionInfo('auto-err')])
    app.bridge.ipcMain.handle('session:list-directories', async () => [group])

    useSessionStore.getState().createNewSession('auto-err', CWD)
    useSessionStore.getState().addMessage('auto-err', {
      id: 'u1', role: 'user',
      content: [{ type: 'text', text: 'Hello'.repeat(40) }],
      timestamp: Date.now(),
    })

    app.bridge.ipcMain.handle('session:generate-title', async () => { throw new Error('boom') })
    app.bridge.ipcMain.handle('log:error' as any, async () => {})

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    await act(async () => {
      viewProps.onAutoRename('auto-err')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // setCustomTitle('') removes the key from customTitles
    expect(useSessionStore.getState().customTitles['auto-err']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // 15. onConfirmDelete — project branch
  // -------------------------------------------------------------------------

  it('onConfirmDelete calls deleteProject IPC when kind is project', async () => {
    const deleteProjectCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:delete-project' as any, async (...args) => {
      deleteProjectCalls.push(args)
    })

    await act(async () => { await renderFC() })

    const group = makeDirectoryGroup([makeSessionInfo('s1'), makeSessionInfo('s2')])
    act(() => { viewProps.onDeleteProject(group) })
    expect(viewProps.deleteTarget?.kind).toBe('project')

    await act(async () => { await viewProps.onConfirmDelete() })

    expect(deleteProjectCalls).toHaveLength(1)
    expect(deleteProjectCalls[0][1]).toBe(PROJECT_KEY)
  })

  // -------------------------------------------------------------------------
  // 16. onDirectoriesChanged push event refreshes the sidebar
  // -------------------------------------------------------------------------

  it('re-fetches directories when the onDirectoriesChanged event fires', async () => {
    let listCalls = 0
    const firstGroup = makeDirectoryGroup([makeSessionInfo('s-orig')])
    const secondGroup = makeDirectoryGroup([makeSessionInfo('s-new')])
    app.bridge.ipcMain.handle('session:list-directories', async () => {
      listCalls++
      return listCalls === 1 ? [firstGroup] : [secondGroup]
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(useSessionStore.getState().directories[0].sessions[0].sessionId).toBe('s-orig')

    await act(async () => {
      app.emit('session:directories-changed')
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(listCalls).toBe(2)
    expect(useSessionStore.getState().directories[0].sessions[0].sessionId).toBe('s-new')
  })
})
