/**
 * @vitest-environment node
 *
 * `currentWorkdir`: the directory a Claude session works in now, main-side (the dispatch context's
 * cwd) — its worktree entry while that exists, else its spawn cwd.
 */
import { describe, it, expect } from 'vitest'
import { currentWorkdir } from '../session-workdir'
import type { WorktreeInfo } from '../../../shared/types'

const info = (worktreePath: string): WorktreeInfo => ({
  worktreePath,
  worktreeBranch: 'b',
  worktreeName: 'wt',
  originalCwd: '/repo',
  gitRoot: '/repo',
  originalHeadCommit: '',
  createdAt: 1,
  origin: 'detected'
})

describe('currentWorkdir', () => {
  it('is the cwd without a worktree entry', () => {
    expect(currentWorkdir('/repo', undefined, () => true)).toBe('/repo')
  })

  it('is the worktree when an entry exists and the directory does', () => {
    expect(currentWorkdir('/repo', info('/repo/.claude/worktrees/wt'), () => true)).toBe(
      '/repo/.claude/worktrees/wt'
    )
  })

  it('falls back to the cwd when the worktree directory is gone', () => {
    expect(currentWorkdir('/repo', info('/repo/.claude/worktrees/wt'), () => false)).toBe('/repo')
  })

  it('keeps a cwd that is already inside the worktree', () => {
    expect(
      currentWorkdir(
        '/repo/.claude/worktrees/wt/pkg',
        info('/repo/.claude/worktrees/wt'),
        () => true
      )
    ).toBe('/repo/.claude/worktrees/wt/pkg')
  })
})
