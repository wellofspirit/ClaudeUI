import { describe, expect, it } from 'vitest'
import {
  effectiveStartInWorktree,
  isManagedWorktreePath,
  withProjectChoice,
  type WorktreeProjectChoice
} from '../worktree-start'

describe('effectiveStartInWorktree', () => {
  const KEY = '-d-work-app'
  const cases: Array<[boolean | undefined, WorktreeProjectChoice | undefined, boolean]> = [
    [undefined, undefined, false],
    [false, undefined, false],
    [true, undefined, true],
    [undefined, 'always', true],
    [false, 'always', true],
    [true, 'always', true],
    [undefined, 'never', false],
    [false, 'never', false],
    [true, 'never', false]
  ]
  it.each(cases)('global %s, project %s -> %s', (global, choice, expected) => {
    const settings = {
      startInWorktree: global,
      worktreeByProject: choice ? { [KEY]: choice } : undefined
    }
    expect(effectiveStartInWorktree(settings, KEY)).toBe(expected)
  })

  it('reads only the project asked about', () => {
    const settings = { startInWorktree: true, worktreeByProject: { other: 'never' as const } }
    expect(effectiveStartInWorktree(settings, 'mine')).toBe(true)
  })
})

describe('withProjectChoice', () => {
  it('sets, replaces and removes one project, leaving the rest', () => {
    const a = withProjectChoice({ x: 'never' }, 'p', 'always')
    expect(a).toEqual({ x: 'never', p: 'always' })
    expect(withProjectChoice(a, 'p', 'never')).toEqual({ x: 'never', p: 'never' })
    expect(withProjectChoice(a, 'p', null)).toEqual({ x: 'never' })
  })

  it('is undefined once the last override goes', () => {
    expect(withProjectChoice({ p: 'always' }, 'p', null)).toBeUndefined()
    expect(withProjectChoice(undefined, 'p', null)).toBeUndefined()
  })
})

describe('isManagedWorktreePath', () => {
  it('matches a path inside .claude/worktrees on either separator', () => {
    expect(isManagedWorktreePath('/repo/.claude/worktrees/calm-river')).toBe(true)
    expect(isManagedWorktreePath('D:\\repo\\.claude\\worktrees\\calm-river')).toBe(true)
    expect(isManagedWorktreePath('/repo/app')).toBe(false)
  })
})
