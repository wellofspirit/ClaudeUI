import { describe, it, expect } from 'vitest'
import type { GitFileStatus } from '../../../../../../shared/types'
import {
  buildTree,
  flattenSingleChildDirs,
  statusBadge,
  isStaged,
  isUntracked,
  collectFiles,
  filterAndSortFiles,
  discardLabel,
  discardDialogTitle,
  type TreeNode
} from '../utils'

// ── Helpers ─────────────────────────────────────────────────────────

function file(path: string, index = 'M', working = ' '): GitFileStatus {
  return { path, index, working }
}

// ── buildTree ───────────────────────────────────────────────────────

describe('buildTree', () => {
  it('creates a flat list for root-level files', () => {
    const tree = buildTree([file('a.ts'), file('b.ts')])
    expect(tree).toHaveLength(2)
    expect(tree[0].name).toBe('a.ts')
    expect(tree[0].file).toBeDefined()
    expect(tree[0].children).toHaveLength(0)
  })

  it('nests files under directory nodes', () => {
    const tree = buildTree([file('src/a.ts'), file('src/b.ts')])
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('src')
    expect(tree[0].file).toBeUndefined()
    expect(tree[0].children).toHaveLength(2)
  })

  it('handles deeply nested paths', () => {
    const tree = buildTree([file('a/b/c/d.ts')])
    expect(tree[0].name).toBe('a')
    expect(tree[0].children[0].name).toBe('b')
    expect(tree[0].children[0].children[0].name).toBe('c')
    expect(tree[0].children[0].children[0].children[0].name).toBe('d.ts')
    expect(tree[0].children[0].children[0].children[0].file).toBeDefined()
  })

  it('shares directory nodes for sibling files', () => {
    const tree = buildTree([file('src/a.ts'), file('src/b.ts'), file('lib/c.ts')])
    expect(tree).toHaveLength(2) // src, lib
    const src = tree.find((n) => n.name === 'src')!
    expect(src.children).toHaveLength(2)
  })

  it('returns empty for empty input', () => {
    expect(buildTree([])).toEqual([])
  })
})

// ── flattenSingleChildDirs ──────────────────────────────────────────

describe('flattenSingleChildDirs', () => {
  it('merges single-child directory chains', () => {
    const tree = buildTree([file('a/b/c.ts')])
    const flat = flattenSingleChildDirs(tree)
    expect(flat).toHaveLength(1)
    expect(flat[0].name).toBe('a/b')
    expect(flat[0].children).toHaveLength(1)
    expect(flat[0].children[0].name).toBe('c.ts')
  })

  it('does not merge when a dir has multiple children', () => {
    const tree = buildTree([file('a/x.ts'), file('a/y.ts')])
    const flat = flattenSingleChildDirs(tree)
    expect(flat[0].name).toBe('a')
    expect(flat[0].children).toHaveLength(2)
  })

  it('does not merge when child is a file', () => {
    const tree = buildTree([file('a/x.ts')])
    const flat = flattenSingleChildDirs(tree)
    // a has a single child that is a file → no merge
    expect(flat[0].name).toBe('a')
    expect(flat[0].children[0].file).toBeDefined()
  })
})

// ── statusBadge ─────────────────────────────────────────────────────

describe('statusBadge', () => {
  it('returns M/yellow for modified staged', () => {
    const badge = statusBadge(file('x.ts', 'M', ' '))
    expect(badge).toEqual({ char: 'M', color: 'text-yellow-400' })
  })

  it('returns A/green for added', () => {
    const badge = statusBadge(file('x.ts', 'A', ' '))
    expect(badge).toEqual({ char: 'A', color: 'text-green-400' })
  })

  it('returns D/red for deleted', () => {
    const badge = statusBadge(file('x.ts', 'D', ' '))
    expect(badge).toEqual({ char: 'D', color: 'text-red-400' })
  })

  it('returns R/blue for renamed', () => {
    const badge = statusBadge(file('x.ts', 'R', ' '))
    expect(badge).toEqual({ char: 'R', color: 'text-blue-400' })
  })

  it('returns U/green for untracked', () => {
    const badge = statusBadge(file('x.ts', '?', '?'))
    expect(badge).toEqual({ char: 'U', color: 'text-green-400' })
  })

  it('falls back to working status when index is space', () => {
    const badge = statusBadge(file('x.ts', ' ', 'M'))
    expect(badge).toEqual({ char: 'M', color: 'text-yellow-400' })
  })
})

// ── isStaged / isUntracked ──────────────────────────────────────────

describe('isStaged', () => {
  it('returns true for staged files', () => {
    expect(isStaged(file('x', 'M', ' '))).toBe(true)
    expect(isStaged(file('x', 'A', ' '))).toBe(true)
  })

  it('returns false for unstaged/untracked', () => {
    expect(isStaged(file('x', ' ', 'M'))).toBe(false)
    expect(isStaged(file('x', '?', '?'))).toBe(false)
  })
})

describe('isUntracked', () => {
  it('returns true for ?? files', () => {
    expect(isUntracked(file('x', '?', '?'))).toBe(true)
  })

  it('returns false for other statuses', () => {
    expect(isUntracked(file('x', 'M', ' '))).toBe(false)
    expect(isUntracked(file('x', ' ', 'M'))).toBe(false)
  })
})

// ── collectFiles ────────────────────────────────────────────────────

describe('collectFiles', () => {
  it('returns the file from a leaf node', () => {
    const f = file('a.ts')
    const node: TreeNode = { name: 'a.ts', path: 'a.ts', children: [], file: f }
    expect(collectFiles(node)).toEqual([f])
  })

  it('collects files recursively from directory nodes', () => {
    const f1 = file('src/a.ts')
    const f2 = file('src/b.ts')
    const tree = buildTree([f1, f2])
    expect(collectFiles(tree[0])).toEqual([f1, f2])
  })
})

// ── filterAndSortFiles ──────────────────────────────────────────────

describe('filterAndSortFiles', () => {
  const files = [
    file('z.ts', 'M', ' '), // staged
    file('a.ts', ' ', 'M'), // unstaged
    file('m.ts', '?', '?') // untracked (unstaged)
  ]

  it('returns all files sorted by path for "all"', () => {
    const result = filterAndSortFiles(files, 'all')
    expect(result.map((f) => f.path)).toEqual(['a.ts', 'm.ts', 'z.ts'])
  })

  it('returns only staged files for "staged"', () => {
    const result = filterAndSortFiles(files, 'staged')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('z.ts')
  })

  it('returns unstaged+untracked for "unstaged"', () => {
    const result = filterAndSortFiles(files, 'unstaged')
    expect(result.map((f) => f.path)).toEqual(['a.ts', 'm.ts'])
  })

  it('returns empty for empty input', () => {
    expect(filterAndSortFiles([], 'all')).toEqual([])
  })
})

// ── discardLabel / discardDialogTitle ───────────────────────────────

describe('discardLabel', () => {
  it('returns "Delete file" for untracked file', () => {
    expect(discardLabel({ kind: 'file', file: file('x', '?', '?') })).toBe('Delete file')
  })

  it('returns "Discard changes" for tracked file', () => {
    expect(discardLabel({ kind: 'file', file: file('x', 'M', ' ') })).toBe('Discard changes')
  })

  it('returns delete count for all-untracked dir', () => {
    const f = [file('a', '?', '?'), file('b', '?', '?')]
    expect(discardLabel({ kind: 'dir', files: f, dirName: 'src' })).toBe('Delete 2 files')
  })

  it('returns discard count for mixed dir', () => {
    const f = [file('a', 'M', ' '), file('b', '?', '?')]
    expect(discardLabel({ kind: 'dir', files: f, dirName: 'src' })).toBe(
      'Discard changes (2 files)'
    )
  })
})

describe('discardDialogTitle', () => {
  it('returns correct title for untracked file', () => {
    expect(discardDialogTitle({ kind: 'file', file: file('x', '?', '?') })).toBe(
      'Delete untracked file?'
    )
  })

  it('returns correct title for tracked file', () => {
    expect(discardDialogTitle({ kind: 'file', file: file('x', 'M', ' ') })).toBe('Discard changes?')
  })

  it('returns correct title for all-untracked dir', () => {
    const f = [file('a', '?', '?')]
    expect(discardDialogTitle({ kind: 'dir', files: f, dirName: 'src' })).toBe(
      'Delete untracked files?'
    )
  })
})
