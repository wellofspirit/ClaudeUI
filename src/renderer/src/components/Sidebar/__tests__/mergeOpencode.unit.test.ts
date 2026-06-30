/**
 * Unit tests for mergeOpencodeIntoDirectories.
 *
 * Core merge regression guard: an opencode SessionInfo with
 * projectKey: 'D--WorkPlace-ClaudeUI' must merge INTO the Claude group
 * with the same projectKey (one group out, both sessions in).
 *
 * Also verifies that sessions with different projectKeys create separate groups.
 */
import { describe, it, expect } from 'vitest'
import { mergeOpencodeIntoDirectories } from '../Sidebar'
import type { DirectoryGroup, SessionInfo } from '../../../../../shared/types'

function makeClaudeSession(id: string, cwd: string, projectKey: string): SessionInfo {
  return {
    sessionId: id,
    cwd,
    projectKey,
    title: `Claude ${id}`,
    timestamp: 1000,
    lastActivityAt: 1000,
    engineId: 'claude'
  }
}

function makeOpencodeSession(id: string, cwd: string, projectKey: string): SessionInfo {
  return {
    sessionId: id,
    cwd,
    projectKey,
    title: `Opencode ${id}`,
    timestamp: 2000,
    lastActivityAt: 2000,
    engineId: 'opencode'
  }
}

function makeGroup(cwd: string, projectKey: string, sessions: SessionInfo[]): DirectoryGroup {
  return {
    cwd,
    projectKey,
    folderName: cwd.split(/[\\/]/).pop() || cwd,
    sessions
  }
}

describe('mergeOpencodeIntoDirectories', () => {
  it('merges an opencode session into the Claude group with the same projectKey', () => {
    const claudeSession = makeClaudeSession('c1', 'D:/WorkPlace/ClaudeUI', 'D--WorkPlace-ClaudeUI')
    const claudeGroup = makeGroup('D:/WorkPlace/ClaudeUI', 'D--WorkPlace-ClaudeUI', [claudeSession])

    const opencodeSession = makeOpencodeSession('o1', 'D:/WorkPlace/ClaudeUI', 'D--WorkPlace-ClaudeUI')

    const result = mergeOpencodeIntoDirectories([claudeGroup], [opencodeSession])

    // ONE group, not two
    expect(result).toHaveLength(1)
    // Both sessions in the single group
    const sessionIds = result[0].sessions.map((s) => s.sessionId)
    expect(sessionIds).toContain('c1')
    expect(sessionIds).toContain('o1')
    // opencode session has correct engineId
    expect(result[0].sessions.find((s) => s.sessionId === 'o1')?.engineId).toBe('opencode')
  })

  it('creates a separate group when projectKeys differ', () => {
    const claudeSession = makeClaudeSession('c1', 'D:/WorkPlace/ClaudeUI', 'D--WorkPlace-ClaudeUI')
    const claudeGroup = makeGroup('D:/WorkPlace/ClaudeUI', 'D--WorkPlace-ClaudeUI', [claudeSession])

    const opencodeSession = makeOpencodeSession('o2', 'D:/WorkPlace/other', 'D--WorkPlace-other')

    const result = mergeOpencodeIntoDirectories([claudeGroup], [opencodeSession])

    expect(result).toHaveLength(2)
    const groupKeys = result.map((g) => g.projectKey)
    expect(groupKeys).toContain('D--WorkPlace-ClaudeUI')
    expect(groupKeys).toContain('D--WorkPlace-other')
  })

  it('removes stale opencode sessions on each merge (no accumulation)', () => {
    const claudeSession = makeClaudeSession('c1', '/proj', '-proj')
    const claudeGroup = makeGroup('/proj', '-proj', [claudeSession])

    // First merge: o1 + o2
    const first = mergeOpencodeIntoDirectories(
      [claudeGroup],
      [
        makeOpencodeSession('o1', '/proj', '-proj'),
        makeOpencodeSession('o2', '/proj', '-proj')
      ]
    )
    expect(first[0].sessions.map((s) => s.sessionId).sort()).toEqual(['c1', 'o1', 'o2'].sort())

    // Second merge: only o3 — o1 and o2 must be gone
    const second = mergeOpencodeIntoDirectories(first, [makeOpencodeSession('o3', '/proj', '-proj')])
    expect(second[0].sessions.map((s) => s.sessionId).sort()).toEqual(['c1', 'o3'].sort())
  })

  it('creates a new group for an opencode-only cwd (no Claude sessions)', () => {
    const result = mergeOpencodeIntoDirectories(
      [],
      [makeOpencodeSession('o1', '/new/project', '-new-project')]
    )
    expect(result).toHaveLength(1)
    expect(result[0].projectKey).toBe('-new-project')
    expect(result[0].sessions[0].sessionId).toBe('o1')
  })

  it('sorts groups by most recent session activity (newest group first)', () => {
    const oldClaudeSession: SessionInfo = {
      ...makeClaudeSession('c1', '/old', '-old'),
      lastActivityAt: 100
    }
    const oldGroup = makeGroup('/old', '-old', [oldClaudeSession])

    const newOpencodeSession: SessionInfo = {
      ...makeOpencodeSession('o1', '/new', '-new'),
      lastActivityAt: 9999
    }

    const result = mergeOpencodeIntoDirectories([oldGroup], [newOpencodeSession])
    expect(result[0].projectKey).toBe('-new') // newest group first
  })
})
