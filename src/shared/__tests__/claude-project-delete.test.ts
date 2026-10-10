/**
 * `planClaudeProjectDelete` — which Claude files a project delete removes.
 *
 * Shared by `handlers-core.deleteProject` (which runs it) and the Sidebar's
 * delete dialog (which describes it), so these cases pin the one rule both use.
 * The worktree layout is cli.js's `EnterWorktree` relocation: a home-project
 * session's file moves into `-repo--claude-worktrees-wt` while the listing
 * keeps it under `-repo`.
 */
import { describe, it, expect } from 'vitest'
import { planClaudeProjectDelete } from '../claude-project-delete'
import type { DirectoryGroup, SessionInfo } from '../types'

const HOME = '-repo'
const WT = '-repo--claude-worktrees-wt'

function session(
  sessionId: string,
  projectKey: string,
  engineId?: SessionInfo['engineId']
): SessionInfo {
  return {
    sessionId,
    cwd: '/repo',
    projectKey,
    title: sessionId,
    timestamp: 1,
    lastActivityAt: 1,
    ...(engineId ? { engineId } : {})
  }
}

function group(projectKey: string, sessions: SessionInfo[]): DirectoryGroup {
  return { cwd: '/repo', projectKey, folderName: 'repo', sessions }
}

describe('planClaudeProjectDelete', () => {
  it('the normal case: the folder goes wholesale, nothing one by one', () => {
    const dirs = [group(HOME, [session('a', HOME, 'claude'), session('b', HOME)])]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({ removeDir: true, sessionFiles: [] })
  })

  it('a member relocated into a worktree folder is deleted by its own key', () => {
    const dirs = [
      group(HOME, [session('a', HOME, 'claude'), session('moved', WT, 'claude')]),
      // A session BORN in the worktree — not a member, and never in the plan.
      group(WT, [session('wt-own', WT, 'claude')])
    ]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({
      removeDir: true,
      sessionFiles: [{ sessionId: 'moved', projectKey: WT }]
    })
  })

  it('a folder that holds ANOTHER project’s relocated session is kept; every member goes one by one', () => {
    const dirs = [
      group(HOME, [session('moved', WT, 'claude')]),
      group(WT, [session('wt-own', WT, 'claude'), session('wt-2', WT)])
    ]
    expect(planClaudeProjectDelete(dirs, WT)).toEqual({
      removeDir: false,
      sessionFiles: [
        { sessionId: 'wt-own', projectKey: WT },
        { sessionId: 'wt-2', projectKey: WT }
      ]
    })
  })

  it('ignores other engines’ sessions, both as members and as residents', () => {
    const dirs = [
      group(HOME, [
        session('a', HOME, 'claude'),
        // Not Claude files: deleted through their own engines, never unlinked here.
        session('oc', WT, 'opencode'),
        session('pi', WT, 'pi'),
        session('cx', WT, 'codex')
      ]),
      // An opencode row keyed to HOME from another group does not make HOME "shared".
      group(WT, [session('oc-wt', HOME, 'opencode')])
    ]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({ removeDir: true, sessionFiles: [] })
  })

  it('an unknown project key plans the folder delete alone', () => {
    expect(planClaudeProjectDelete([], HOME)).toEqual({ removeDir: true, sessionFiles: [] })
  })
})
