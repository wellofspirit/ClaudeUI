/**
 * The session-delete cleanup modal through its REAL View: the R2 copy (the branch is kept, only
 * commits found nowhere else count) and the refused / partial notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorktreeCleanupModalView, type WorktreeCleanupModalViewProps } from '../View'
import type { WorktreeInfo, WorktreeStatus } from '../../../../../shared/types'

const info = {
  worktreeName: 'feat-x',
  worktreePath: '/d/repo/.claude/worktrees/feat-x',
  worktreeBranch: 'feat/x',
  gitRoot: '/d/repo',
  originalCwd: '/d/repo',
  originalHeadCommit: 'abc123',
  createdAt: 1
} as WorktreeInfo

function status(over: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    uncommittedFiles: 0,
    commitsAhead: 0,
    files: [],
    uniqueCommits: 0,
    branch: 'feat/x',
    ...over
  }
}

function view(over: Partial<WorktreeCleanupModalViewProps> = {}): WorktreeCleanupModalViewProps {
  const p: WorktreeCleanupModalViewProps = {
    worktreeInfo: info,
    status: status(),
    removing: false,
    outcome: null,
    onKeep: vi.fn(),
    onRemove: vi.fn(),
    onCancel: vi.fn(),
    ...over
  }
  render(<WorktreeCleanupModalView {...p} />)
  return p
}

const t = (id: string): HTMLElement => screen.getByTestId(`WorktreeCleanupModal.${id}`)
const q = (id: string): HTMLElement | null => screen.queryByTestId(`WorktreeCleanupModal.${id}`)

afterEach(cleanup)

describe('WorktreeCleanupModalView copy (R2)', () => {
  it('commits only on the branch are counted and the branch is kept', () => {
    view({ status: status({ uniqueCommits: 3 }) })
    expect(t('commits').textContent).toBe('commits only on this branch: 3 — the branch is kept')
  })

  it('no unique commits: just the count, no "kept" claim', () => {
    view({ status: status({ uniqueCommits: 0 }) })
    expect(t('commits').textContent).toBe('commits only on this branch: 0')
  })

  it('never says "unmerged commits are permanently deleted"', () => {
    view({ status: status({ uncommittedFiles: 2, uniqueCommits: 3 }) })
    expect(t('warning').textContent).toContain('uncommitted changes')
    expect(document.body.textContent).not.toMatch(/unmerged commits/i)
  })

  it('a detached HEAD loses its commits and says so', () => {
    view({ status: status({ branch: null, uniqueCommits: 2 }) })
    expect(t('commits').textContent).toBe('commits only on this detached HEAD: 2')
    expect(t('detachedWarning').textContent).toContain('will be lost')
  })

  it('a clean worktree has no warning', () => {
    view()
    expect(q('warning')).toBeNull()
    expect(q('detachedWarning')).toBeNull()
  })
})

describe('WorktreeCleanupModalView outcome', () => {
  it('shows the refusal or partial notice and relabels Remove as Retry', () => {
    const p = view({
      outcome: { tone: 'warn', text: 'Refused: in use by Fix bug.', paths: ['C:/x (EBUSY)'] }
    })
    expect(t('outcome').textContent).toContain('Refused: in use by Fix bug.')
    expect(t('outcome').textContent).toContain('C:/x (EBUSY)')
    expect(t('remove').textContent).toBe('Retry')
    fireEvent.click(t('remove'))
    expect(p.onRemove).toHaveBeenCalled()
  })

  it('no notice before an attempt', () => {
    view()
    expect(q('outcome')).toBeNull()
    expect(t('remove').textContent).toBe('Remove worktree')
  })

  it('the button row wraps on a narrow screen (N8)', () => {
    view()
    expect(t('cancel').parentElement?.className).toContain('flex-wrap')
  })
})
