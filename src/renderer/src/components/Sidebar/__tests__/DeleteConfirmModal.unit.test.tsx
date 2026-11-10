/**
 * Layer 1: Unit tests for DeleteConfirmModal.
 *
 * Pure rendering + user-interaction tests — no store, no IPC. The component
 * receives an `onConfirm` Promise; these tests exercise the success, error,
 * and busy states.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DeleteConfirmModal } from '../DeleteConfirmModal'

function renderModal(overrides: Partial<React.ComponentProps<typeof DeleteConfirmModal>> = {}) {
  const props: React.ComponentProps<typeof DeleteConfirmModal> = {
    kind: 'session',
    name: 'My Session',
    path: '~/.claude/projects/key/abc.jsonl',
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides
  }
  return { ...render(<DeleteConfirmModal {...props} />), props }
}

describe('DeleteConfirmModal (session)', () => {
  it('renders session title and path in the hint', () => {
    renderModal()
    expect(screen.getByText('Delete session?')).toBeInTheDocument()
    expect(screen.getByText(/"My Session"/)).toBeInTheDocument()
    expect(screen.getByText('~/.claude/projects/key/abc.jsonl')).toBeInTheDocument()
  })

  it('calls onConfirm when Delete is clicked', async () => {
    const { props } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledOnce())
  })

  it('calls onCancel when Cancel is clicked', () => {
    const { props } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('Escape cancels, but not while the delete is in flight', async () => {
    // Every ConfirmModal in the app is an `useEscapeLayer` layer as of the
    // ADR-065 follow-up: Escape is Cancel, on the same terms as the scrim
    // click. Mid-flight it is swallowed — the dialog must not vanish under the
    // user while the delete is still running.
    let resolve!: () => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    const { props } = renderModal({ onConfirm })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()
    await act(async () => {
      resolve()
    })
  })

  it('shows Deleting... state while onConfirm is pending and disables buttons', async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => {
      resolve()
    })
  })

  it('shows an inline error + Retry when onConfirm rejects', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce(undefined)
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Could not delete')).toBeInTheDocument()
    expect(screen.getByText('EBUSY: resource busy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('Retry re-invokes onConfirm', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(undefined)
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
  })
})

describe('DeleteConfirmModal (project)', () => {
  it('renders session count in body + confirm button label', () => {
    renderModal({
      kind: 'project',
      name: 'ClaudeUI',
      path: '~/.claude/projects/key/',
      sessionCount: 57
    })
    expect(screen.getByText('Delete project?')).toBeInTheDocument()
    expect(screen.getAllByText(/57 sessions/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Delete all 57 sessions' })).toBeInTheDocument()
  })

  it('pluralises "1 session" correctly', () => {
    renderModal({
      kind: 'project',
      name: 'Solo',
      path: '~/.claude/projects/solo/',
      sessionCount: 1
    })
    expect(screen.getByRole('button', { name: 'Delete all 1 session' })).toBeInTheDocument()
  })

  it('falls back to plain Delete label when sessionCount is 0', () => {
    renderModal({
      kind: 'project',
      name: 'Empty',
      path: '~/.claude/projects/empty/',
      sessionCount: 0
    })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})

/**
 * Claude sessions a project delete removes one by one (`planClaudeProjectDelete`).
 * cli.js's `EnterWorktree` moves a session's transcript into a worktree's project
 * folder while the sidebar still lists it under its home project, so deleting the
 * home folder alone would not reach it — and the dialog has to name it.
 */
describe('DeleteConfirmModal (project, relocated sessions)', () => {
  const RELOCATED = '~/.claude/projects/-repo--claude-worktrees-wt/moved.jsonl'

  it('names the relocated session files alongside the folder', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 3,
      sessionPaths: [RELOCATED]
    })
    const block = screen.getByTestId('DeleteConfirmModal.relocated')
    expect(block).toHaveTextContent(
      'Also deletes 1 session file stored in other Claude project folders (moved or worktree sessions):'
    )
    expect(
      screen.getAllByTestId('DeleteConfirmModal.relocatedPath').map((el) => el.textContent)
    ).toEqual([RELOCATED])
    // The folder itself is still deleted, and said so, exactly as before.
    expect(screen.getByText('~/.claude/projects/-repo/')).toBeInTheDocument()
  })

  it('does not claim the folder when it is kept — its sessions go one by one', () => {
    const own = [
      '~/.claude/projects/-repo--claude-worktrees-wt/a.jsonl',
      '~/.claude/projects/-repo--claude-worktrees-wt/b.jsonl'
    ]
    renderModal({
      kind: 'project',
      name: 'wt',
      path: '~/.claude/projects/-repo--claude-worktrees-wt/',
      sessionCount: 2,
      sessionPaths: own,
      folderKept: true
    })
    expect(screen.getByTestId('DeleteConfirmModal.relocated')).toHaveTextContent(
      /sessions are deleted one by one — the folder also holds another project's session, so it is kept/
    )
    expect(screen.getAllByTestId('DeleteConfirmModal.relocatedPath')).toHaveLength(2)
    expect(
      screen.getByText('~/.claude/projects/-repo--claude-worktrees-wt/ — folder kept')
    ).toBeInTheDocument()
  })

  it('renders exactly as before when no session is deleted one by one', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 2,
      sessionPaths: []
    })
    expect(screen.queryByTestId('DeleteConfirmModal.relocated')).not.toBeInTheDocument()
    expect(screen.getByText('~/.claude/projects/-repo/')).toBeInTheDocument()
  })
})

/** The sidebar folds linked-worktree sessions into their parent project; the delete covers them. */
describe('DeleteConfirmModal (project, folded worktrees and Claude memory)', () => {
  it('says which worktree sessions are included and that the worktree folders stay', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 5,
      worktrees: { sessionCount: 3, names: ['feat-a', 'feat-b'] }
    })
    expect(screen.getByTestId('DeleteConfirmModal.worktrees')).toHaveTextContent(
      'Includes 3 sessions in 2 worktrees: feat-a, feat-b. The worktree folders are not deleted.'
    )
  })

  it('singular forms', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 2,
      worktrees: { sessionCount: 1, names: ['feat'] }
    })
    expect(screen.getByTestId('DeleteConfirmModal.worktrees')).toHaveTextContent(
      'Includes 1 session in 1 worktree: feat.'
    )
  })

  it('warns that removing the project folder also removes Claude’s saved project memory', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 2
    })
    expect(screen.getByTestId('DeleteConfirmModal.memory')).toHaveTextContent(
      "also removes Claude's saved project memory"
    )
    expect(screen.queryByTestId('DeleteConfirmModal.worktrees')).not.toBeInTheDocument()
  })

  it('a synthesised parent: the repository folder is kept, memory included, and says so', () => {
    renderModal({
      kind: 'project',
      name: 'repo',
      path: '~/.claude/projects/-repo/',
      sessionCount: 1,
      sessionPaths: ['~/.claude/projects/-repo--claude-worktrees-a/w1.jsonl'],
      folderKept: true,
      folderUnlisted: true,
      worktrees: { sessionCount: 1, names: ['a'] }
    })
    expect(screen.getByTestId('DeleteConfirmModal.memoryKept')).toHaveTextContent(
      'with its saved project memory, is not touched'
    )
    expect(screen.queryByTestId('DeleteConfirmModal.memory')).not.toBeInTheDocument()
    // Not the "another project's session" explanation, which would be untrue here.
    expect(screen.getByTestId('DeleteConfirmModal.relocated')).toHaveTextContent(
      'Deletes 1 Claude session file one by one:'
    )
    expect(screen.getByText('~/.claude/projects/-repo/ — folder kept')).toBeInTheDocument()
  })

  it('a kept folder that holds another project’s session does not promise memory removal', () => {
    renderModal({
      kind: 'project',
      name: 'wt',
      path: '~/.claude/projects/-repo--claude-worktrees-wt/',
      sessionCount: 1,
      sessionPaths: ['~/.claude/projects/-repo--claude-worktrees-wt/a.jsonl'],
      folderKept: true
    })
    expect(screen.queryByTestId('DeleteConfirmModal.memory')).not.toBeInTheDocument()
  })
})
