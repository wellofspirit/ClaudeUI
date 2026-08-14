/**
 * Worktree-entry detection — SyncCore phase 4c.
 *
 * These assertions used to live in `useClaudeEvents-extended.component.test.ts`,
 * because the RENDERER parsed the `EnterWorktree` tool result and stored the
 * result. That was the last violation of sync-core.md's client-computation rule,
 * and 4c moved the parse to the main process; the tests move with it.
 *
 * The audit C2 gate is the sharp one: harvesting a `worktreePath` from ANY tool
 * whose name matched `/worktree/i` let a third-party MCP tool plant a deletion
 * target that later flowed into `worktree:remove`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadSessionConfig = vi.fn()
const saveSessionConfig = vi.fn()

vi.mock('../ui-config', () => ({
  loadSessionConfig: () => loadSessionConfig(),
  saveSessionConfig: (config: unknown) => saveSessionConfig(config)
}))

const {
  detectEnteredWorktree,
  deriveWorktreeName,
  recordWorktreeEntry,
  WORKTREE_ENTER_TOOL_NAMES
} = await import('../worktree-detect')

const INFO = {
  worktreePath: '/project/worktrees/feat',
  worktreeBranch: 'feat',
  worktreeName: 'feat',
  originalCwd: '/project/app',
  gitRoot: '/project/app',
  originalHeadCommit: '',
  createdAt: 0
}

beforeEach(() => {
  loadSessionConfig.mockReset()
  saveSessionConfig.mockReset()
  loadSessionConfig.mockReturnValue({})
})

describe('detectEnteredWorktree', () => {
  it("parses cli.js's natural-language result", () => {
    expect(
      detectEnteredWorktree(
        'Created worktree at /project/worktrees/my-branch on branch my-branch. Now working in that directory.'
      )
    ).toEqual({ worktreePath: '/project/worktrees/my-branch', worktreeBranch: 'my-branch' })
  })

  it('parses a Windows backslash path', () => {
    expect(
      detectEnteredWorktree('Created worktree at D:\\project\\worktrees\\my-branch on branch my-branch.')
    ).toEqual({ worktreePath: 'D:\\project\\worktrees\\my-branch', worktreeBranch: 'my-branch' })
  })

  it('parses the labelled and JSON shapes', () => {
    expect(detectEnteredWorktree('worktreePath: /a/b\nworktreeBranch: feat\n')).toEqual({
      worktreePath: '/a/b',
      worktreeBranch: 'feat'
    })
    expect(
      detectEnteredWorktree('{"worktreePath": "/a/b", "worktreeBranch": "feat"}')
    ).toEqual({ worktreePath: '/a/b', worktreeBranch: 'feat' })
  })

  it('returns null when either half is missing', () => {
    expect(detectEnteredWorktree('Created worktree at /a/b')).toBeNull()
    expect(detectEnteredWorktree('Failed to create worktree')).toBeNull()
  })
})

describe('deriveWorktreeName', () => {
  // RN11 — a Windows worktree path has no '/', so the old `split('/')` put the
  // ENTIRE path in the sidebar/header where the branch folder belongs.
  it('handles posix, windows, trailing separators, and the branch fallback', () => {
    expect(deriveWorktreeName('/project/worktrees/feat', 'feat')).toBe('feat')
    expect(deriveWorktreeName('D:\\project\\worktrees\\feat', 'feat')).toBe('feat')
    expect(deriveWorktreeName('D:\\project/worktrees\\feat', 'feat')).toBe('feat')
    expect(deriveWorktreeName('/project/worktrees/', 'worktree-feat')).toBe('feat')
    expect(deriveWorktreeName('', 'worktree-feat')).toBe('feat')
  })
})

describe('the audit-C2 harvest gate', () => {
  it('excludes MCP tool names that the old /worktree/i substring accepted', () => {
    // Documents the pre-fix hole: the old substring gate accepted this name.
    expect(/worktree/i.test('mcp__evil__worktree_helper')).toBe(true)
    // The exact-name allowlist rejects it.
    expect(WORKTREE_ENTER_TOOL_NAMES.has('mcp__evil__worktree_helper')).toBe(false)
    // ...while still admitting the real cli.js built-in.
    expect(WORKTREE_ENTER_TOOL_NAMES.has('EnterWorktree')).toBe(true)
    // And the pre-4c renderer's other accepted name is NOT admitted either.
    expect(WORKTREE_ENTER_TOOL_NAMES.has('CreateWorktree')).toBe(false)
  })
})

describe('recordWorktreeEntry', () => {
  it('merges into sessions.json and broadcasts the whole config', () => {
    loadSessionConfig.mockReturnValue({ recentSessions: ['r1'] })
    const emit = vi.fn()
    recordWorktreeEntry('r1', INFO, emit)

    expect(saveSessionConfig).toHaveBeenCalledWith({
      recentSessions: ['r1'],
      worktreeInfoMap: { r1: INFO }
    })
    // The ordinary config echo — so every replica applies it through the reducer
    // and a reconnecting client gets it in its snapshot.
    expect(emit).toHaveBeenCalledWith('config:sessions-changed', [
      { recentSessions: ['r1'], worktreeInfoMap: { r1: INFO } }
    ])
  })

  it('does not overwrite an existing entry (a replayed tool result is harmless)', () => {
    const existing = { ...INFO, worktreePath: '/project/worktrees/existing' }
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r1: existing } })
    const emit = vi.fn()
    recordWorktreeEntry('r1', INFO, emit)

    expect(saveSessionConfig).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
