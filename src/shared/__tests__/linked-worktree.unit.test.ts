import { describe, it, expect, vi } from 'vitest'
import {
  isCreatedWorktree,
  linkedWorktreeFor,
  linkedWorktreeIndex,
  worktreeCwdKey
} from '../linked-worktree'
import type { DirectoryGroup, LinkedWorktree } from '../types'

const lw: LinkedWorktree = {
  worktreePath: 'D:/wt/foo',
  repoRoot: 'D:/repo',
  name: 'foo',
  branch: 'b'
}
const group = (cwd: string, linked?: LinkedWorktree): DirectoryGroup => ({
  cwd,
  projectKey: cwd,
  folderName: 'x',
  sessions: [],
  ...(linked ? { linkedWorktree: linked } : {})
})

describe('worktreeCwdKey', () => {
  it('one spelling for a Windows directory whatever the separator, case or trailing slash', () => {
    const keys = ['D:\\Wt\\Foo', 'd:/wt/foo/', '\\\\?\\D:\\wt\\foo\\', 'D:/WT/FOO'].map(
      worktreeCwdKey
    )
    expect(new Set(keys)).toEqual(new Set(['d:/wt/foo']))
  })

  it('computes a spelling once per distinct input (memoised), and stays correct past the memo bound', () => {
    const input = 'D:\\Memo\\Probe\\'
    const first = worktreeCwdKey(input)
    const replace = vi.spyOn(String.prototype, 'replace')
    try {
      expect(worktreeCwdKey(input)).toBe(first)
      expect(replace).not.toHaveBeenCalled()
    } finally {
      replace.mockRestore()
    }
    for (let i = 0; i < 5000; i++) worktreeCwdKey(`/bulk/${i}/`)
    expect(worktreeCwdKey(input)).toBe('d:/memo/probe')
    expect(worktreeCwdKey('/bulk/7/')).toBe('/bulk/7')
  })

  it('keeps POSIX case, which is significant, and the root itself', () => {
    expect(worktreeCwdKey('/Home/Me/Repo//')).toBe('/Home/Me/Repo')
    expect(worktreeCwdKey('/home/me/repo')).not.toBe(worktreeCwdKey('/home/me/Repo'))
    expect(worktreeCwdKey('/')).toBe('/')
    expect(worktreeCwdKey('')).toBe('')
  })
})

describe('linkedWorktreeFor', () => {
  it('finds a marked group by cwd and ignores unmarked ones', () => {
    const dirs = [group('D:\\wt\\foo', lw), group('D:/repo')]
    expect(linkedWorktreeFor(dirs, 'd:/wt/foo/')).toBe(lw)
    expect(linkedWorktreeFor(dirs, 'D:/repo')).toBeNull()
    expect(linkedWorktreeFor(dirs, '')).toBeNull()
    expect(linkedWorktreeFor(dirs, undefined)).toBeNull()
  })

  it('indexes a listing once per array', () => {
    const dirs = [group('/a', lw)]
    expect(linkedWorktreeIndex(dirs)).toBe(linkedWorktreeIndex(dirs))
    expect(linkedWorktreeIndex([...dirs])).not.toBe(linkedWorktreeIndex(dirs))
  })
})

describe('isCreatedWorktree (C-S11)', () => {
  it('uses origin when present', () => {
    expect(isCreatedWorktree({ origin: 'created', originalHeadCommit: '' })).toBe(true)
    expect(isCreatedWorktree({ origin: 'detected', originalHeadCommit: 'abc' })).toBe(false)
  })

  it('legacy entries: an empty originalHeadCommit means detected', () => {
    expect(isCreatedWorktree({ originalHeadCommit: '' })).toBe(false)
    expect(isCreatedWorktree({ originalHeadCommit: 'abc123' })).toBe(true)
  })
})
