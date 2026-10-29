/**
 * Layer 2: GitBranchPill - one pill for the branch and, in a linked worktree, the
 * worktree: the worktree mark replaces the branch mark and the pill turns purple.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitStatusData, WorktreeInfo } from '../../../../../shared/types'
import { worktreeInfoFromLinked } from '../../../../../shared/linked-worktree'
import { GitBranchPill } from '../GitBranchPill'

const ROUTE = 'route-gbp'

function status(overrides: Partial<GitStatusData> = {}): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides
  }
}

function worktree(branch: string): WorktreeInfo {
  return worktreeInfoFromLinked({
    worktreePath: '/repo/.claude/worktrees/foo',
    repoRoot: '/repo',
    name: 'foo',
    branch
  })
}

describe('GitBranchPill', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setIsGitRepo(ROUTE, true)
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('wears the branch mark in a plain checkout', () => {
    useSessionStore.getState().setGitStatus(ROUTE, status())
    render(<GitBranchPill />)
    expect(screen.getByTestId('GitBranchPill.mark')).toHaveAttribute('data-mark', 'branch')
    expect(screen.getByTestId('GitBranchPill.toggle').className).not.toContain('text-mode-edit')
    expect(screen.getByTestId('GitBranchPill.toggle')).toHaveTextContent('main')
  })

  it('wears the worktree mark, tinted purple, in a worktree session', () => {
    useSessionStore.getState().setGitStatus(ROUTE, status({ branch: 'worktree-foo' }))
    useSessionStore.getState().setWorktreeInfo(ROUTE, worktree('worktree-foo'))
    render(<GitBranchPill />)
    expect(screen.getByTestId('GitBranchPill.mark')).toHaveAttribute('data-mark', 'worktree')
    expect(screen.getByTestId('GitBranchPill.toggle').className).toContain('text-mode-edit')
    expect(screen.getByTestId('GitBranchPill.toggle')).toHaveTextContent('worktree-foo')
  })

  it('names the worktree when it is detached (no branch to show)', () => {
    useSessionStore.getState().setGitStatus(ROUTE, status({ branch: 'HEAD', trackingBranch: '' }))
    useSessionStore.getState().setWorktreeInfo(ROUTE, worktree(''))
    render(<GitBranchPill />)
    expect(screen.getByTestId('GitBranchPill.toggle')).toHaveTextContent('foo')
    expect(screen.getByTestId('GitBranchPill.toggle')).not.toHaveTextContent('HEAD')
  })

  it('renders nothing outside a repo', () => {
    useSessionStore.getState().setIsGitRepo(ROUTE, false)
    const { container } = render(<GitBranchPill />)
    expect(container.firstChild).toBeNull()
  })
})
