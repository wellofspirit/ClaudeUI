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
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const loadSessionConfig = vi.fn()
const saveSessionConfig = vi.fn()

vi.mock('../../../core/services/ui-config', () => ({
  loadSessionConfig: () => loadSessionConfig(),
  saveSessionConfig: (config: unknown) => saveSessionConfig(config)
}))

const {
  detectEnteredWorktree,
  deriveWorktreeName,
  recordWorktreeEntry,
  forgetWorktreeEntries,
  isCreatedWorktreePath,
  forgetSessionWorktree,
  WORKTREE_ENTER_TOOL_NAMES
} = await import('../../../core/services/worktree-detect')

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

describe('detectEnteredWorktree (pre-2.1.306 and structured shapes)', () => {
  it("parses cli.js's old unquoted natural-language result", () => {
    expect(
      detectEnteredWorktree(
        'Created worktree at /project/worktrees/my-branch on branch my-branch. Now working in that directory.'
      )
    ).toEqual({
      worktreePath: '/project/worktrees/my-branch',
      worktreeBranch: 'my-branch',
      pathExact: true
    })
  })

  it('parses a Windows backslash path', () => {
    expect(
      detectEnteredWorktree(
        'Created worktree at D:\\project\\worktrees\\my-branch on branch my-branch.'
      )
    ).toEqual({
      worktreePath: 'D:\\project\\worktrees\\my-branch',
      worktreeBranch: 'my-branch',
      pathExact: true
    })
  })

  it('parses the labelled and JSON shapes', () => {
    expect(detectEnteredWorktree('worktreePath: /a/b\nworktreeBranch: feat\n')).toEqual({
      worktreePath: '/a/b',
      worktreeBranch: 'feat',
      pathExact: true
    })
    expect(detectEnteredWorktree('{"worktreePath": "/a/b", "worktreeBranch": "feat"}')).toEqual({
      worktreePath: '/a/b',
      worktreeBranch: 'feat',
      pathExact: true
    })
  })

  it('returns null when no path is declared', () => {
    expect(detectEnteredWorktree('Failed to create worktree')).toBeNull()
    expect(detectEnteredWorktree('')).toBeNull()
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

  it('is idempotent for the SAME worktree (a replayed tool result is harmless)', () => {
    const existing = { ...INFO, originalCwd: '/first' }
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r1: existing } })
    const emit = vi.fn()
    recordWorktreeEntry('r1', { ...INFO, worktreePath: '/project/worktrees/feat/' }, emit)

    expect(saveSessionConfig).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('overwrites an entry for a DIFFERENT worktree, keeping the first originalCwd', () => {
    const existing = { ...INFO, worktreePath: '/project/worktrees/existing', originalCwd: '/first' }
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r1: existing } })
    const emit = vi.fn()
    recordWorktreeEntry('r1', { ...INFO, originalCwd: '/second' }, emit)

    expect(saveSessionConfig).toHaveBeenCalledWith({
      worktreeInfoMap: { r1: { ...INFO, originalCwd: '/first' } }
    })
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

describe('forgetSessionWorktree', () => {
  it('drops one session entry, saves and emits once', () => {
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r1: INFO, r2: INFO } })
    const emit = vi.fn()
    expect(forgetSessionWorktree('r1', emit)).toBe(true)
    expect(saveSessionConfig).toHaveBeenCalledWith({ worktreeInfoMap: { r2: INFO } })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the session has no entry', () => {
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r2: INFO } })
    const emit = vi.fn()
    expect(forgetSessionWorktree('r1', emit)).toBe(false)
    expect(saveSessionConfig).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('isCreatedWorktreePath (C-S11, server side)', () => {
  const entry = (worktreePath: string, extra: object) => ({ ...INFO, worktreePath, ...extra })

  it('is true only for a directory with a created entry, compared as paths', () => {
    loadSessionConfig.mockReturnValue({
      worktreeInfoMap: {
        made: entry('/project/worktrees/ours', { origin: 'created', originalHeadCommit: 'abc' }),
        seen: entry('/project/worktrees/theirs', { origin: 'detected' }),
        legacyCreated: entry('/project/worktrees/old', { originalHeadCommit: 'def' }),
        legacyDetected: entry('/project/worktrees/older', { originalHeadCommit: '' })
      }
    })

    expect(isCreatedWorktreePath('/project/worktrees/ours')).toBe(true)
    expect(isCreatedWorktreePath('/project/worktrees/ours/')).toBe(true)
    expect(isCreatedWorktreePath('/project/worktrees/old')).toBe(true)
    expect(isCreatedWorktreePath('/project/worktrees/theirs')).toBe(false)
    expect(isCreatedWorktreePath('/project/worktrees/older')).toBe(false)
    expect(isCreatedWorktreePath('/project/worktrees/unknown')).toBe(false)
  })

  it('a detected entry beside a created one for the same directory does not hide it, and no map is false', () => {
    loadSessionConfig.mockReturnValue({
      worktreeInfoMap: {
        a: entry('/project/worktrees/x', { origin: 'detected' }),
        b: entry('/project/worktrees/x', { origin: 'created', originalHeadCommit: 'abc' })
      }
    })
    expect(isCreatedWorktreePath('/project/worktrees/x')).toBe(true)

    loadSessionConfig.mockReturnValue({})
    expect(isCreatedWorktreePath('/project/worktrees/x')).toBe(false)
  })
})

describe('forgetWorktreeEntries', () => {
  it('drops every entry whose worktreePath matches (normalised), saves and emits ONCE', () => {
    loadSessionConfig.mockReturnValue({
      recentSessions: ['r1'],
      worktreeInfoMap: {
        r1: { ...INFO, worktreePath: '/project/worktrees/a' },
        r2: { ...INFO, worktreePath: '/project/worktrees/a/' },
        r3: { ...INFO, worktreePath: '/project/worktrees/b' },
        r4: { ...INFO, worktreePath: '/project/worktrees/ab' }
      }
    })
    const emit = vi.fn()

    const dropped = forgetWorktreeEntries(['/project/worktrees/a', '/project/worktrees/b'], emit)

    expect(dropped.sort()).toEqual(['r1', 'r2', 'r3'])
    expect(saveSessionConfig).toHaveBeenCalledTimes(1)
    const saved = saveSessionConfig.mock.calls[0][0]
    expect(Object.keys(saved.worktreeInfoMap)).toEqual(['r4'])
    expect(saved.recentSessions).toEqual(['r1'])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('config:sessions-changed', [saved])
  })

  it('matches the directory, not the spelling: a record made through a link goes when git reports the real path of a removed worktree', () => {
    // git lists a worktree by its real path; the record keeps the spelling the repo was reached by
    // (a symlinked project, macOS /tmp, a Windows 8.3 name). The worktree is gone by now.
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forget-link-')))
    try {
      const real = path.join(base, 'repo')
      const alias = path.join(base, 'repo-alias')
      fs.mkdirSync(real)
      fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
      loadSessionConfig.mockReturnValue({
        worktreeInfoMap: {
          r1: { ...INFO, worktreePath: path.join(alias, '.claude', 'worktrees', 'a') },
          r2: { ...INFO, worktreePath: path.join(alias, '.claude', 'worktrees', 'b') }
        }
      })

      const dropped = forgetWorktreeEntries([path.join(real, '.claude', 'worktrees', 'a')], vi.fn())

      expect(dropped).toEqual(['r1'])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('saves and emits nothing when no entry matches', () => {
    loadSessionConfig.mockReturnValue({ worktreeInfoMap: { r1: INFO } })
    const emit = vi.fn()

    expect(forgetWorktreeEntries(['/somewhere/else'], emit)).toEqual([])
    expect(forgetWorktreeEntries([], emit)).toEqual([])

    expect(saveSessionConfig).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
