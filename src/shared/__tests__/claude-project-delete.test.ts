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
import type { DirectoryGroup, EngineId, SessionInfo } from '../types'

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
        // Not Claude files: deleted through their own engines, never unlinked here (the
        // last is a row an older build left for an engine this build no longer ships).
        session('oc', WT, 'opencode'),
        session('pi', WT, 'pi'),
        session('cx', WT, 'codex' as EngineId)
      ]),
      // An opencode row keyed to HOME from another group does not make HOME "shared".
      group(WT, [session('oc-wt', HOME, 'opencode')])
    ]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({ removeDir: true, sessionFiles: [] })
  })

  it('an unknown project key plans nothing: a key the sidebar never showed removes no folder', () => {
    expect(planClaudeProjectDelete([], HOME)).toEqual({ removeDir: false, sessionFiles: [] })
    const dirs = [group(HOME, [session('a', HOME, 'claude')])]
    expect(planClaudeProjectDelete(dirs, '-nope')).toEqual({ removeDir: false, sessionFiles: [] })
  })
})

/**
 * The sidebar folds linked-worktree groups into their parent, so a project delete covers them
 * (`worktreeChildrenOf`). A parent the listing has no group for must never lose its folder.
 */
describe('planClaudeProjectDelete (folded worktrees)', () => {
  const WT_KEY = '-repo--claude-worktrees-a'
  const worktreeGroup = (sessions: SessionInfo[]): DirectoryGroup => ({
    cwd: '/repo/.claude/worktrees/a',
    projectKey: WT_KEY,
    folderName: 'a',
    sessions,
    linkedWorktree: {
      worktreePath: '/repo/.claude/worktrees/a',
      repoRoot: '/repo',
      name: 'a',
      branch: 'b'
    }
  })

  it('an existing parent: its folder goes wholesale, each worktree session by its own key', () => {
    const dirs = [
      group(HOME, [session('p', HOME, 'claude')]),
      worktreeGroup([session('w1', WT_KEY, 'claude'), session('oc', WT_KEY, 'opencode')])
    ]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({
      removeDir: true,
      sessionFiles: [{ sessionId: 'w1', projectKey: WT_KEY }]
    })
  })

  it('a synthesised parent never removes its folder, only the listed files', () => {
    const dirs = [worktreeGroup([session('w1', WT_KEY, 'claude'), session('w2', WT_KEY)])]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({
      removeDir: false,
      sessionFiles: [
        { sessionId: 'w1', projectKey: WT_KEY },
        { sessionId: 'w2', projectKey: WT_KEY }
      ]
    })
  })

  it('a worktree that holds the parent’s relocated session is a member, not a reason to keep the folder', () => {
    const dirs = [
      group(HOME, [session('moved', WT_KEY, 'claude')]),
      worktreeGroup([session('w1', WT_KEY, 'claude')])
    ]
    expect(planClaudeProjectDelete(dirs, HOME)).toEqual({
      removeDir: true,
      sessionFiles: [
        { sessionId: 'moved', projectKey: WT_KEY },
        { sessionId: 'w1', projectKey: WT_KEY }
      ]
    })
  })

  it('does not take a group with a similar key along', () => {
    const dirs = [
      {
        cwd: '/repo2',
        projectKey: '-repo2',
        folderName: 'repo2',
        sessions: [session('r2', '-repo2', 'claude')]
      },
      worktreeGroup([session('w1', WT_KEY, 'claude')])
    ]
    expect(planClaudeProjectDelete(dirs, '-repo2')).toEqual({ removeDir: true, sessionFiles: [] })
  })

  it('a worktree group asked for by its own key goes file by file, never wholesale', () => {
    const dirs = [
      group(HOME, [session('p', HOME, 'claude')]),
      worktreeGroup([session('w1', WT_KEY, 'claude'), session('oc', WT_KEY, 'opencode')])
    ]
    expect(planClaudeProjectDelete(dirs, WT_KEY)).toEqual({
      removeDir: false,
      sessionFiles: [{ sessionId: 'w1', projectKey: WT_KEY }]
    })
  })

  // cwdToProjectKey is lossy: '/a/b' and '/a-b' are both '-a-b'.
  const lossy = (cwd: string, sessions: SessionInfo[], repoRoot?: string): DirectoryGroup => ({
    cwd,
    projectKey: '-a-b',
    folderName: cwd,
    sessions,
    ...(repoRoot ? { linkedWorktree: { worktreePath: cwd, repoRoot, name: 'x', branch: 'b' } } : {})
  })

  it('repo "/a/b" with no root group, its worktree "/a-b": only the worktree’s files, no folder wholesale', () => {
    const dirs = [lossy('/a-b', [session('w1', '-a-b', 'claude')], '/a/b')]
    expect(planClaudeProjectDelete(dirs, '-a-b')).toEqual({
      removeDir: false,
      sessionFiles: [{ sessionId: 'w1', projectKey: '-a-b' }]
    })
  })

  it('"/a-b" a worktree of "/other", "/wt" a worktree of "/a/b": deleting "-a-b" takes only "/wt"’s sessions', () => {
    const dirs = [
      lossy('/a-b', [session('other-wt', '-a-b', 'claude')], '/other'),
      {
        cwd: '/wt',
        projectKey: '-wt',
        folderName: 'wt',
        sessions: [session('mine', '-wt', 'claude')],
        linkedWorktree: { worktreePath: '/wt', repoRoot: '/a/b', name: 'wt', branch: 'b' }
      }
    ]
    expect(planClaudeProjectDelete(dirs, '-a-b')).toEqual({
      removeDir: false,
      sessionFiles: [{ sessionId: 'mine', projectKey: '-wt' }]
    })
  })
})
