/**
 * The project menu's "New sessions in worktree" choice: Use default / Always / Never write or
 * delete `worktreeByProject[projectKey]`, and the ⑂ mark on the row follows the effective value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DirectoryGroup } from '../../../../../shared/types'
import { DirectoryItem } from '../DirectoryItem'
import { useSessionStore } from '../../../stores/session-store'

const group: DirectoryGroup = {
  cwd: '/d/WorkPlace/demo',
  projectKey: '-d-workplace-demo',
  folderName: 'demo',
  sessions: []
}

function renderItem(g: DirectoryGroup = group): void {
  render(
    <DirectoryItem
      group={g}
      expanded={false}
      activeSessionId={null}
      onClick={vi.fn()}
      onDoubleClick={vi.fn()}
      onSessionClick={vi.fn()}
      onSessionDoubleClick={vi.fn()}
      onToggleWatch={vi.fn()}
      renamingKey={null}
      renamePrefix="dir"
      onStartRename={vi.fn()}
      onFinishRename={vi.fn()}
      onAutoRename={vi.fn()}
      onCancelRename={vi.fn()}
    />
  )
}

const settings = (): ReturnType<typeof useSessionStore.getState>['settings'] =>
  useSessionStore.getState().settings

function setSettings(patch: Record<string, unknown>): void {
  act(() => {
    useSessionStore.setState({ settings: { ...settings(), ...patch } })
  })
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByTestId('DirectoryItem').firstElementChild!)
}

const updateSettings = vi.fn()

beforeEach(() => {
  updateSettings.mockReset()
  useSessionStore.setState({
    settings: { ...settings(), startInWorktree: undefined, worktreeByProject: undefined },
    // The real action also saves through IPC; the menu only needs to hand it the new map.
    updateSettings: (partial) => {
      updateSettings(partial)
      useSessionStore.setState({ settings: { ...settings(), ...partial } })
    }
  })
})
afterEach(cleanup)

describe('project menu: New sessions in worktree', () => {
  it('shows Use default with the global value, Always and Never, and a check on the current one', () => {
    setSettings({ startInWorktree: true })
    renderItem()
    openMenu()

    expect(screen.getByTestId('DirectoryItem.worktree.default')).toHaveTextContent(
      'Use default (On)'
    )
    expect(screen.getByTestId('DirectoryItem.worktree.default').getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByTestId('DirectoryItem.worktree.always').getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(screen.getByTestId('DirectoryItem.worktreeMenu')).toHaveTextContent(
      'Default: Settings › Sessions & autonomy › Worktrees'
    )
  })

  it('Always and Never write this project only; Use default deletes the entry', () => {
    setSettings({ worktreeByProject: { other: 'never' } })
    renderItem()

    openMenu()
    fireEvent.click(screen.getByTestId('DirectoryItem.worktree.always'))
    expect(updateSettings).toHaveBeenLastCalledWith({
      worktreeByProject: { other: 'never', [group.projectKey]: 'always' }
    })

    openMenu()
    expect(screen.getByTestId('DirectoryItem.worktree.always').getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByTestId('DirectoryItem.worktree.never'))
    expect(updateSettings).toHaveBeenLastCalledWith({
      worktreeByProject: { other: 'never', [group.projectKey]: 'never' }
    })

    openMenu()
    fireEvent.click(screen.getByTestId('DirectoryItem.worktree.default'))
    expect(updateSettings).toHaveBeenLastCalledWith({ worktreeByProject: { other: 'never' } })
  })

  it('drops worktreeByProject when the last override goes', () => {
    setSettings({ worktreeByProject: { [group.projectKey]: 'always' } })
    renderItem()
    openMenu()
    fireEvent.click(screen.getByTestId('DirectoryItem.worktree.default'))
    expect(updateSettings).toHaveBeenLastCalledWith({ worktreeByProject: undefined })
  })

  it('offers neither the menu block nor the mark for a project under .claude/worktrees', () => {
    setSettings({ startInWorktree: true })
    renderItem({ ...group, cwd: '/d/WorkPlace/demo/.claude/worktrees/calm-river' })
    expect(screen.queryByTestId('DirectoryItem.worktreeMark')).toBeNull()
    openMenu()
    expect(screen.getByText('New session here')).toBeTruthy()
    expect(screen.queryByTestId('DirectoryItem.worktreeMenu')).toBeNull()
  })

  it('marks the row with the fork sign exactly when the effective value is on', () => {
    renderItem()
    expect(screen.queryByTestId('DirectoryItem.worktreeMark')).toBeNull()

    setSettings({ startInWorktree: true })
    expect(screen.getByTestId('DirectoryItem.worktreeMark')).toBeTruthy()

    setSettings({ worktreeByProject: { [group.projectKey]: 'never' } })
    expect(screen.queryByTestId('DirectoryItem.worktreeMark')).toBeNull()

    setSettings({ startInWorktree: false, worktreeByProject: { [group.projectKey]: 'always' } })
    expect(screen.getByTestId('DirectoryItem.worktreeMark')).toBeTruthy()
  })
})
