/**
 * The sidebar's delete entry points, through the REAL context menus.
 *
 * `Sidebar.component.test.ts` mocks the View and calls `onDeleteSession`
 * directly, so it cannot see whether a row actually offers the action. That is
 * how Codex delete shipped unreachable: the subtree walk and its confirmation
 * existed, but the session menu and the project menu both still carried the
 * guard that predated them. These tests right-click the rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DirectoryGroup, EngineId, SessionInfo } from '../../../../../shared/types'

vi.mock('../SettingsPanel', () => ({ SettingsPanel: () => null }))

import { SidebarView, type SidebarViewProps } from '../View'

const PROJECT_KEY = '-d-workplace-demo'

function session(id: string, engineId: EngineId): SessionInfo {
  return {
    sessionId: id,
    cwd: '/d/WorkPlace/demo',
    projectKey: PROJECT_KEY,
    title: `Session ${id}`,
    timestamp: 0,
    lastActivityAt: 0,
    engineId
  }
}

function renderView(
  group: DirectoryGroup,
  overrides: Partial<SidebarViewProps> = {}
): SidebarViewProps {
  const noop = (): void => {}
  const props: SidebarViewProps = {
    platform: 'win32',
    uiFontScale: 1,
    activeSessionId: null,
    activeView: { type: 'chat' },
    pluginViews: [],
    automationBadge: 0,
    pinnedSessionIds: [],
    pinnedSessions: [],
    watchingSessions: [],
    recentSessions: [],
    augmentedDirs: [group],
    hiddenSessionSet: new Set(),
    hiddenProjectSet: new Set(),
    hasAnyHidden: false,
    showHidden: false,
    expandedDir: group.projectKey,
    renamingKey: null,
    worktreesModalCwd: null,
    deleteTarget: null,
    deletePlan: null,
    cleanupWorktree: null,
    onNewSession: noop,
    onNewSessionDblClick: noop,
    onSetActiveView: noop,
    onShowHiddenToggle: noop,
    onSetRenamingKey: noop,
    onClickSession: noop,
    onToggleWatch: noop,
    onPin: noop,
    onUnpin: noop,
    onReorderPinned: noop,
    onFinishRename: noop,
    onAutoRename: noop,
    onRemoveRecent: noop,
    onDirClick: noop,
    onDirDoubleClick: noop,
    onSessionDoubleClick: noop,
    onViewWorktrees: noop,
    onCloseWorktreesModal: noop,
    onHideSession: noop,
    onUnhideSession: noop,
    onDeleteSession: vi.fn(),
    onHideProject: noop,
    onUnhideProject: noop,
    onDeleteProject: vi.fn(),
    onConfirmDelete: async () => {},
    onCancelDelete: noop,
    onWorktreeCleanupKeep: noop,
    onWorktreeCleanupRemove: noop,
    onWorktreeCleanupCancel: noop,
    ...overrides
  }
  render(<SidebarView {...props} />)
  return props
}

function groupOf(...sessions: SessionInfo[]): DirectoryGroup {
  return { cwd: '/d/WorkPlace/demo', projectKey: PROJECT_KEY, folderName: 'demo', sessions }
}

afterEach(cleanup)

describe('SidebarView delete menus', () => {
  it.each<EngineId>(['claude', 'opencode', 'pi', 'codex'])(
    'offers "Delete session..." on a %s row and hands the row upstream',
    (engineId) => {
      const row = session('s-1', engineId)
      const props = renderView(groupOf(row))

      const item = screen
        .getAllByTestId('SessionItem')
        .find((el) => el.getAttribute('data-id') === 's-1')!
      fireEvent.contextMenu(item)
      fireEvent.click(screen.getByTestId('SessionItem.delete'))

      expect(props.onDeleteSession).toHaveBeenCalledWith(row)
    }
  )

  it('offers "Delete project..." on a project that holds a Codex session', () => {
    const group = groupOf(session('cl-1', 'claude'), session('cx-1', 'codex'))
    const props = renderView(group)

    const dir = screen.getByTestId('DirectoryItem')
    fireEvent.contextMenu(within(dir).getByText('demo'))
    fireEvent.click(screen.getByTestId('DirectoryItem.delete'))

    expect(props.onDeleteProject).toHaveBeenCalledWith(group)
  })

  it.each<[EngineId | undefined, string]>([
    ['claude', `~/.claude/projects/${PROJECT_KEY}/s-1.jsonl`],
    [undefined, `~/.claude/projects/${PROJECT_KEY}/s-1.jsonl`],
    ['codex', 's-1'],
    ['opencode', 's-1'],
    ['pi', 's-1']
  ])(
    'the session confirmation names a %s session by a path only Claude has',
    (engineId, detail) => {
      renderView(groupOf(session('s-1', engineId ?? 'claude')), {
        deleteTarget: {
          kind: 'session',
          sessionId: 's-1',
          projectKey: PROJECT_KEY,
          title: 'Session s-1',
          engineId
        }
      })
      const modal = screen.getByTestId('DeleteConfirmModal')
      expect(within(modal).getByText(detail)).toBeInTheDocument()
      expect(modal.textContent).toContain('and its subagents. This cannot be undone.')
      expect(modal.textContent).not.toContain('from disk')
    }
  )
})
