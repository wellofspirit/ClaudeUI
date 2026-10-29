import { describe, it, expect } from 'vitest'
import type { WorktreeInfo } from '../../../../shared/types'
import { sessionWorkdir } from '../session-workdir'

const worktree = (worktreePath: string): WorktreeInfo => ({
  worktreePath,
  worktreeBranch: 'b',
  worktreeName: 'wt',
  originalCwd: '/repo',
  gitRoot: '/repo',
  originalHeadCommit: '',
  createdAt: 0
})

describe('sessionWorkdir', () => {
  it('prefers the worktree path over the spawn cwd', () => {
    expect(
      sessionWorkdir({ cwd: '/repo', worktreeInfo: worktree('/repo/.claude/worktrees/wt') })
    ).toBe('/repo/.claude/worktrees/wt')
  })

  it('falls back to cwd without a worktree', () => {
    expect(sessionWorkdir({ cwd: '/repo', worktreeInfo: null })).toBe('/repo')
    expect(sessionWorkdir({ cwd: '/repo' })).toBe('/repo')
  })

  it('falls back to cwd when the worktree has no path', () => {
    expect(sessionWorkdir({ cwd: '/repo', worktreeInfo: worktree('') })).toBe('/repo')
  })

  it('keeps a cwd that is the worktree or a folder inside it', () => {
    const wt = worktree('D:\\repo\\.claude\\worktrees\\wt')
    expect(sessionWorkdir({ cwd: 'd:/repo/.claude/worktrees/wt/', worktreeInfo: wt })).toBe(
      'd:/repo/.claude/worktrees/wt/'
    )
    expect(
      sessionWorkdir({ cwd: 'D:\\repo\\.claude\\worktrees\\wt\\packages\\api', worktreeInfo: wt })
    ).toBe('D:\\repo\\.claude\\worktrees\\wt\\packages\\api')
    // A sibling that only shares the prefix is not inside it.
    expect(sessionWorkdir({ cwd: 'D:\\repo\\.claude\\worktrees\\wt2', worktreeInfo: wt })).toBe(
      'D:\\repo\\.claude\\worktrees\\wt'
    )
  })

  it('is empty when there is neither', () => {
    expect(sessionWorkdir({})).toBe('')
    expect(sessionWorkdir({ cwd: '', worktreeInfo: null })).toBe('')
  })
})
