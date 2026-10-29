/**
 * The worktree pill popover for a session that is only MARKED as a linked worktree (no recorded
 * entry): the projection synthesises the info, and a detached worktree (opencode) has no
 * branch row to show.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import type { WorktreeInfo } from '../../../../../shared/types'
import { worktreeInfoFromLinked } from '../../../../../shared/linked-worktree'
import { WorktreePopover } from '../WorktreePill'

const anchor = { current: document.createElement('div') }

function seed(worktreeInfo: WorktreeInfo): void {
  useSessionStore.setState({
    activeSessionId: 's-1',
    sessions: { 's-1': { ...EMPTY_SESSION_STATE, worktreeInfo } }
  })
}

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

describe('WorktreePopover', () => {
  it('hides the branch row for a detached worktree', () => {
    seed(
      worktreeInfoFromLinked({
        worktreePath: '/home/me/.local/share/opencode/worktree/ab12/repo',
        repoRoot: '/home/me/repo',
        name: 'ab12/repo',
        branch: ''
      })
    )
    render(<WorktreePopover anchorRef={anchor} onClose={() => {}} />)
    expect(screen.getByTestId('WorktreePill.popover')).toHaveTextContent('ab12/repo')
    expect(screen.queryByTestId('WorktreePill.branch')).toBeNull()
  })

  it('shows the branch of a branch worktree', () => {
    seed(
      worktreeInfoFromLinked({
        worktreePath: '/repo/.claude/worktrees/foo',
        repoRoot: '/repo',
        name: 'foo',
        branch: 'worktree-foo'
      })
    )
    render(<WorktreePopover anchorRef={anchor} onClose={() => {}} />)
    expect(screen.getByTestId('WorktreePill.branch')).toHaveTextContent('worktree-foo')
  })
})
