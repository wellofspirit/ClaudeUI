/**
 * The sidebar's worktree fold: a VIEW over the one-group-per-directory listing. The delete reads
 * the same answer (`worktreeChildrenOf`), so these cases pin what both show and delete.
 */
import { describe, it, expect } from 'vitest'
import {
  foldForView,
  foldedWorktreeSummary,
  inProject,
  liveProjectMembers,
  projectScope,
  worktreeChildrenOf
} from '../worktree-fold'
import { cwdToProjectKey } from '../project-key'
import type { DirectoryGroup, LinkedWorktree, SessionInfo } from '../types'

function session(id: string, cwd: string, at: number, engineId?: SessionInfo['engineId']) {
  return {
    sessionId: id,
    cwd,
    projectKey: cwdToProjectKey(cwd),
    title: id,
    timestamp: at,
    lastActivityAt: at,
    ...(engineId ? { engineId } : {})
  } satisfies SessionInfo
}

function group(
  cwd: string,
  sessions: SessionInfo[],
  linkedWorktree?: Partial<LinkedWorktree>
): DirectoryGroup {
  return {
    cwd,
    projectKey: cwdToProjectKey(cwd),
    folderName: cwd.split(/[\\/]/).pop() ?? cwd,
    sessions,
    ...(linkedWorktree
      ? {
          linkedWorktree: {
            worktreePath: cwd,
            repoRoot: '',
            name: cwd.split(/[\\/]/).pop() ?? cwd,
            branch: 'b',
            ...linkedWorktree
          }
        }
      : {})
  }
}

const REPO = 'D:\\Work\\repo'
const WT_A = 'D:\\Work\\repo\\.claude\\worktrees\\a'
const WT_B = 'D:\\Elsewhere\\b'

describe('foldForView', () => {
  it('returns the listing itself when nothing folds', () => {
    const listing = [group(REPO, [session('s1', REPO, 5)])]
    expect(foldForView(listing)).toBe(listing)
  })

  it('folds a worktree into its parent, whatever the case or separator of the repo root', () => {
    const listing = [
      group(REPO, [session('p1', REPO, 10)]),
      group(WT_A, [session('w1', WT_A, 20)], { repoRoot: 'd:/work/REPO/' })
    ]
    const view = foldForView(listing)
    expect(view.map((g) => g.projectKey)).toEqual([cwdToProjectKey(REPO)])
    expect(view[0].sessions.map((s) => s.sessionId)).toEqual(['w1', 'p1']) // newest first
    expect(view[0].foldedWorktrees).toEqual([
      {
        cwd: WT_A,
        projectKey: cwdToProjectKey(WT_A),
        linkedWorktree: expect.objectContaining({ repoRoot: 'd:/work/REPO/' })
      }
    ])
    expect(view[0].synthesized).toBeUndefined()
    // Each session keeps its own cwd and key.
    expect(view[0].sessions[0]).toMatchObject({ cwd: WT_A, projectKey: cwdToProjectKey(WT_A) })
  })

  it('synthesises a missing parent from the repo root', () => {
    const listing = [group(WT_A, [session('w1', WT_A, 20)], { repoRoot: REPO })]
    const view = foldForView(listing)
    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({
      cwd: REPO,
      projectKey: cwdToProjectKey(REPO),
      folderName: 'repo',
      synthesized: true
    })
    expect(view[0].sessions.map((s) => s.sessionId)).toEqual(['w1'])
  })

  it('leaves unmarked groups and groups without a repoRoot alone', () => {
    const noRoot = group('D:\\Work\\bare', [session('b1', 'D:\\Work\\bare', 3)], { repoRoot: '' })
    const plain = group('D:\\Work\\plain', [session('x1', 'D:\\Work\\plain', 4)])
    const view = foldForView([plain, noRoot])
    expect(view.map((g) => g.projectKey).sort()).toEqual(
      [plain.projectKey, noRoot.projectKey].sort()
    )
    expect(view.every((g) => !g.foldedWorktrees && !g.synthesized)).toBe(true)
  })

  it('folds several worktrees of one repo, and a worktree plus its subfolder (two entries, one worktree)', () => {
    const sub = `${WT_A}\\packages\\ui`
    const listing = [
      group(REPO, [session('p1', REPO, 10)]),
      group(WT_A, [session('a1', WT_A, 30)], { repoRoot: REPO, worktreePath: WT_A, name: 'a' }),
      group(sub, [session('a2', sub, 25)], { repoRoot: REPO, worktreePath: WT_A, name: 'a' }),
      group(WT_B, [session('b1', WT_B, 40)], { repoRoot: REPO, worktreePath: WT_B, name: 'b' })
    ]
    const view = foldForView(listing)
    expect(view).toHaveLength(1)
    expect(view[0].sessions.map((s) => s.sessionId)).toEqual(['b1', 'a1', 'a2', 'p1'])
    expect(view[0].foldedWorktrees).toHaveLength(3)
    expect(foldedWorktreeSummary(listing, view[0].projectKey)).toEqual({
      sessionCount: 3,
      names: ['a', 'b']
    })
  })

  it('shows a projectKey at most once: a synthesised parent whose key collides folds into that group', () => {
    // '/a/b-c' and '/a/b/c' are different directories with ONE Claude project key.
    const existing = group('/a/b-c', [session('e1', '/a/b-c', 5)])
    const wt = group('/wt/x', [session('w1', '/wt/x', 9)], { repoRoot: '/a/b/c' })
    expect(existing.projectKey).toBe(cwdToProjectKey('/a/b/c'))
    const view = foldForView([existing, wt])
    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({ cwd: '/a/b-c' })
    expect(view[0].synthesized).toBeUndefined()
    expect(view[0].sessions.map((s) => s.sessionId)).toEqual(['w1', 'e1'])
    // Two worktrees of the same colliding-but-missing root also share ONE synthesised group.
    const wt2 = group('/wt/y', [session('w2', '/wt/y', 8)], { repoRoot: '/q/r-s' })
    const wt3 = group('/wt/z', [session('w3', '/wt/z', 7)], { repoRoot: '/q/r/s' })
    const view2 = foldForView([wt2, wt3])
    expect(new Set(view2.map((g) => g.projectKey)).size).toBe(view2.length)
    expect(view2).toHaveLength(1)
  })

  it('sorts groups by their newest session, folded sessions included', () => {
    const other = group('D:\\Work\\other', [session('o1', 'D:\\Work\\other', 50)])
    const listing = [
      other,
      group(REPO, [session('p1', REPO, 10)]),
      group(WT_A, [session('w1', WT_A, 90)], { repoRoot: REPO })
    ]
    expect(foldForView(listing).map((g) => g.projectKey)).toEqual([
      cwdToProjectKey(REPO),
      other.projectKey
    ])
  })

  it('keeps one row per session id', () => {
    const dup = session('same', REPO, 10)
    const listing = [group(REPO, [dup]), group(WT_A, [{ ...dup, cwd: WT_A }], { repoRoot: REPO })]
    expect(foldForView(listing)[0].sessions).toHaveLength(1)
  })
})

describe('worktreeChildrenOf', () => {
  it('matches the parent the view folds into, existing or synthesised, and nothing else', () => {
    const wt = group(WT_A, [session('w1', WT_A, 20)], { repoRoot: REPO })
    const similar = group('D:\\Work\\repo2', [session('r2', 'D:\\Work\\repo2', 1)])
    const unrelated = group(WT_B, [session('u1', WT_B, 2)], { repoRoot: 'D:\\Other\\repo' })
    const listing = [similar, wt, unrelated]
    // Synthesised parent: no group of its own, found by the key of the repo root.
    expect(worktreeChildrenOf(listing, cwdToProjectKey(REPO))).toEqual([wt])
    expect(worktreeChildrenOf(listing, similar.projectKey)).toEqual([])
    expect(worktreeChildrenOf(listing, wt.projectKey)).toEqual([])
  })

  it('an existing parent folded by directory is found by its own key', () => {
    const parent = group(REPO, [session('p1', REPO, 1)])
    const wt = group(WT_A, [session('w1', WT_A, 2)], { repoRoot: 'd:/work/repo' })
    expect(worktreeChildrenOf([parent, wt], parent.projectKey)).toEqual([wt])
  })
})

describe('foldedWorktreeSummary', () => {
  it('counts a session once even when two folded groups list it', () => {
    const dup = session('same', REPO, 10)
    const listing = [
      group(WT_A, [{ ...dup, cwd: WT_A }, session('a2', WT_A, 5)], { repoRoot: REPO }),
      group(`${WT_A}\\sub`, [{ ...dup, cwd: `${WT_A}\\sub` }], {
        repoRoot: REPO,
        worktreePath: WT_A
      })
    ]
    expect(foldedWorktreeSummary(listing, cwdToProjectKey(REPO))?.sessionCount).toBe(2)
  })
})

/**
 * What a request for a key means, resolved through the fold the sidebar draws. cwdToProjectKey is
 * lossy ('/a/b' and '/a-b' share '-a-b'), so a key alone must never pick "any group with this key".
 */
describe('projectScope', () => {
  it('an existing parent is removable and carries its folded worktrees', () => {
    const parent = group(REPO, [session('p1', REPO, 1)])
    const wt = group(WT_A, [session('w1', WT_A, 2)], { repoRoot: REPO })
    const scope = projectScope([parent, wt], parent.projectKey)
    expect(scope).toMatchObject({ group: parent, synthesized: false, ownDirRemovable: true })
    expect(scope.children).toEqual([wt])
  })

  it('a synthesised parent is not removable', () => {
    const wt = group(WT_A, [session('w1', WT_A, 2)], { repoRoot: REPO })
    const scope = projectScope([wt], cwdToProjectKey(REPO))
    expect(scope).toMatchObject({ group: null, synthesized: true, ownDirRemovable: false })
    expect(scope.children).toEqual([wt])
  })

  it('a key the listing has no group for scopes nothing and removes nothing', () => {
    const scope = projectScope([group(REPO, [session('p1', REPO, 1)])], '-nope')
    expect(scope).toMatchObject({ group: null, synthesized: false, ownDirRemovable: false })
    expect(scope.children).toEqual([])
    expect(inProject(scope, REPO)).toBe(false)
  })

  it('a worktree group asked for by its own key is that group alone, never removable', () => {
    const parent = group(REPO, [session('p1', REPO, 1)])
    const wt = group(WT_A, [session('w1', WT_A, 2)], { repoRoot: REPO })
    const scope = projectScope([parent, wt], wt.projectKey)
    expect(scope).toMatchObject({ group: wt, synthesized: false, ownDirRemovable: false })
    expect(scope.children).toEqual([])
  })

  it('repo "/a/b" with no root group and its worktree "/a-b" (one lossy key): the view group, synthesised', () => {
    const wt = group('/a-b', [session('w1', '/a-b', 2)], { repoRoot: '/a/b' })
    expect(wt.projectKey).toBe(cwdToProjectKey('/a/b'))
    const scope = projectScope([wt], wt.projectKey)
    expect(scope).toMatchObject({ group: null, synthesized: true, ownDirRemovable: false })
    expect(scope.children).toEqual([wt])
  })

  it('"/a-b" a worktree of "/other" while "/wt" is a worktree of "/a/b": each key covers its own view group', () => {
    const g1 = group('/a-b', [session('s1', '/a-b', 2)], { repoRoot: '/other' })
    const g2 = group('/wt', [session('s2', '/wt', 3)], { repoRoot: '/a/b' })
    const listing = [g1, g2]
    const abScope = projectScope(listing, cwdToProjectKey('/a/b'))
    expect(abScope).toMatchObject({ group: null, synthesized: true, ownDirRemovable: false })
    expect(abScope.children).toEqual([g2])
    expect(inProject(abScope, '/a/b')).toBe(true)
    expect(inProject(abScope, '/wt')).toBe(true)
    expect(inProject(abScope, '/a-b')).toBe(false) // another project's worktree
    const otherScope = projectScope(listing, cwdToProjectKey('/other'))
    expect(otherScope.children).toEqual([g1])
  })

  it('a live session belongs by directory, whatever the drive-letter case or separator', () => {
    const parent = group(REPO, [session('p1', REPO, 1)])
    const wt = group(WT_A, [session('w1', WT_A, 2)], { repoRoot: REPO })
    const scope = projectScope([parent, wt], parent.projectKey)
    expect(inProject(scope, 'd:/work/repo')).toBe(true)
    expect(inProject(scope, 'D:/WORK/repo/.claude/worktrees/a/')).toBe(true)
    expect(inProject(scope, 'D:\\Work\\repo\\src')).toBe(false) // a subfolder is its own directory
    expect(inProject(scope, '')).toBe(false)
    expect(inProject(scope, undefined)).toBe(false)
  })

  it('an unrelated directory sharing the lossy key is not in the project', () => {
    const parent = group('/repo', [session('p1', '/repo', 1)])
    const wt = group('/a/b', [session('w1', '/a/b', 2)], { repoRoot: '/repo' })
    const scope = projectScope([parent, wt], parent.projectKey)
    expect(inProject(scope, '/a/b')).toBe(true)
    expect(inProject(scope, '/a-b')).toBe(false)
  })
})

describe('liveProjectMembers', () => {
  const live = (...entries: Array<[string, string]>): Array<[string, { cwd: string }]> =>
    entries.map(([id, cwd]) => [id, { cwd }])

  it('a key the listing knows nothing for: the live sessions whose cwd maps to it', () => {
    const listing = [group('/other', [session('o1', '/other', 1)])]
    const scope = projectScope(listing, cwdToProjectKey('/new/folder'))
    const out = liveProjectMembers(
      listing,
      scope,
      cwdToProjectKey('/new/folder'),
      live(['n1', '/new/folder'], ['n2', '/new/folder'], ['x', '/elsewhere'])
    )
    expect(out).toEqual({ ids: ['n1', 'n2'], unlisted: ['n1', 'n2'] })
  })

  it('...except an id some listing group holds and a directory a listed group claims', () => {
    const listed = group('D:\\Work\\x', [session('held', 'D:\\Work\\x', 1)])
    const scope = projectScope([listed], 'd--work-x') // the lower-case spelling is not a listed key
    expect(scope.group).toBeNull()
    const out = liveProjectMembers(
      [listed],
      scope,
      'd--work-x',
      live(['claimed', 'd:/work/x'], ['held', 'd:/work/x'])
    )
    expect(out.ids).toEqual([])
  })

  it('a known project is the by-directory predicate, and a session another group holds is not "unlisted"', () => {
    const parent = group(REPO, [session('p1', REPO, 1)])
    const scope = projectScope([parent], parent.projectKey)
    const out = liveProjectMembers(
      [parent],
      scope,
      parent.projectKey,
      live(['p1', REPO], ['n', REPO])
    )
    expect(out).toEqual({ ids: ['p1', 'n'], unlisted: ['n'] })
  })
})
