/**
 * Unit tests for the shared path-containment helper used by both the worktree
 * service (audit C2 / M-GT3) and git-service file ops (M-GT2 / gpt#5).
 *
 * The OS-agnostic cases use real resolved paths so they behave correctly on
 * whatever platform the runner is. Platform-specific semantics (Windows
 * drive-letter case, cross-drive, forward-slash git paths; POSIX `/` traversal)
 * are asserted under a `process.platform` guard so they encode the findings
 * without being flaky on the other OS.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { isPathInside } from '../path-containment'

describe('isPathInside — OS-agnostic', () => {
  const root = path.resolve('containment-root')

  it('accepts a direct child', () => {
    expect(isPathInside(root, path.join(root, 'child'))).toBe(true)
  })

  it('accepts a nested descendant', () => {
    expect(isPathInside(root, path.join(root, 'a', 'b', 'c.txt'))).toBe(true)
  })

  it('accepts a descendant reached via internal ".." that stays inside', () => {
    expect(isPathInside(root, path.join(root, 'a', '..', 'b'))).toBe(true)
  })

  it('rejects the root itself (strictly-inside only)', () => {
    expect(isPathInside(root, root)).toBe(false)
  })

  it('rejects the parent directory', () => {
    expect(isPathInside(root, path.dirname(root))).toBe(false)
  })

  it('rejects a ".." traversal that escapes the root', () => {
    expect(isPathInside(root, path.join(root, '..', 'secret'))).toBe(false)
  })

  it('rejects a deep traversal that climbs above the root', () => {
    expect(isPathInside(root, path.join(root, 'a', '..', '..', 'x'))).toBe(false)
  })

  it('rejects a sibling that merely shares the root as a string prefix', () => {
    // The classic `resolved.startsWith(root)` bug: `<root>foo` is NOT inside.
    expect(isPathInside(root, root + 'foo')).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('isPathInside — Windows semantics', () => {
  it('treats drive letters case-insensitively (NTFS)', () => {
    expect(isPathInside('D:\\repo', 'd:\\repo\\child')).toBe(true)
  })

  it('treats folder names case-insensitively (NTFS)', () => {
    expect(isPathInside('D:\\Repo\\Root', 'd:\\repo\\root\\child')).toBe(true)
  })

  it('rejects a candidate on a different drive', () => {
    expect(isPathInside('D:\\repo', 'C:\\repo\\child')).toBe(false)
  })

  it('accepts a forward-slash git-style candidate (git worktree --porcelain)', () => {
    expect(isPathInside('D:\\repo\\.claude\\worktrees', 'D:/repo/.claude/worktrees/feat')).toBe(
      true
    )
  })

  it('rejects backslash traversal that escapes the root', () => {
    expect(isPathInside('D:\\repo\\.claude\\worktrees', 'D:\\repo\\.claude\\worktrees\\..\\..\\x')).toBe(
      false
    )
  })
})

describe.runIf(process.platform !== 'win32')('isPathInside — POSIX semantics', () => {
  it('rejects a "/"-separated traversal that escapes the root', () => {
    expect(isPathInside('/a/b', '/a/b/../../etc/passwd')).toBe(false)
  })

  it('accepts a normal POSIX descendant', () => {
    expect(isPathInside('/a/b', '/a/b/c/d')).toBe(true)
  })
})
