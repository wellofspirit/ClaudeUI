/**
 * @vitest-environment node
 *
 * createWorktree's `base` option against real temp repos: `'default'` branches from a freshly
 * fetched `origin/<default>` with no upstream, and falls back to HEAD when there is no remote.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { simpleGit } from 'simple-git'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { createWorktree } from '../../../core/services/worktree'

describe('createWorktree: base', () => {
  let repo: TempGitRepo
  let scratch: string

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-wt-base-'))
  })
  afterEach(async () => {
    await repo.cleanup()
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const branchConfig = async (branch: string): Promise<string> => {
    try {
      return (await repo.git.raw(['config', '--get-regexp', `^branch\\.${branch}\\.`])).trim()
    } catch {
      return '' // `git config` exits 1 when nothing matches
    }
  }

  /** A bare "origin" holding `main`, advanced one commit by a second clone; the main checkout sits on `other`. */
  async function withOrigin(): Promise<{ originTip: string }> {
    const origin = path.join(scratch, 'origin.git')
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', origin])
    await repo.git.raw(['remote', 'add', 'origin', origin])
    await repo.git.raw(['push', 'origin', 'main'])
    await repo.git.raw(['fetch', 'origin'])
    await repo.git.raw(['remote', 'set-head', 'origin', 'main'])

    // Someone else lands a commit on origin/main; the main checkout has not fetched it.
    const other = path.join(scratch, 'other')
    await simpleGit().raw(['clone', origin, other])
    const g = simpleGit(other)
    await g.addConfig('user.name', 'Other')
    await g.addConfig('user.email', 'other@example.com')
    await g.addConfig('commit.gpgsign', 'false')
    fs.writeFileSync(path.join(other, 'upstream.txt'), 'x')
    await g.add('-A')
    await g.commit('upstream work')
    await g.raw(['push', 'origin', 'main'])
    const originTip = (await g.revparse(['HEAD'])).trim()

    // The main checkout works on another branch with its own commit.
    await repo.git.raw(['checkout', '-b', 'other'])
    await repo.writeFile('local.txt', 'y')
    await repo.commit('local work')
    return { originTip }
  }

  it('G1 base "default" branches from the freshly fetched origin default branch, with no upstream', async () => {
    const { originTip } = await withOrigin()

    const info = await createWorktree(repo.path, 'fresh', { base: 'default' })

    expect(info.originalHeadCommit).toBe(originTip)
    expect((await simpleGit(info.worktreePath).revparse(['HEAD'])).trim()).toBe(originTip)
    expect(info.worktreeBranch).toBe('worktree-fresh')
    expect(await branchConfig('worktree-fresh')).toBe('')
  })

  it('G2 the default base is HEAD', async () => {
    const { originTip } = await withOrigin()
    const head = (await repo.git.revparse(['HEAD'])).trim()

    const info = await createWorktree(repo.path, 'plain')

    expect(info.originalHeadCommit).toBe(head)
    expect(info.originalHeadCommit).not.toBe(originTip)
  })

  it('G3 base "default" falls back to HEAD when there is no remote', async () => {
    const head = (await repo.git.revparse(['HEAD'])).trim()

    const info = await createWorktree(repo.path, 'no-remote', { base: 'default' })

    expect(info.originalHeadCommit).toBe(head)
    expect((await simpleGit(info.worktreePath).revparse(['HEAD'])).trim()).toBe(head)
  })

  it('G5 base "default" falls back to HEAD when origin/HEAD dangles', async () => {
    await withOrigin()
    // origin/HEAD names a branch the remote no longer has (renamed, and pruned here).
    await repo.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone'])
    const head = (await repo.git.revparse(['HEAD'])).trim()

    const info = await createWorktree(repo.path, 'dangling', { base: 'default' })

    expect(info.originalHeadCommit).toBe(head)
  })

  it('G4 base "default" falls back to HEAD when the remote is unreachable', async () => {
    await repo.git.raw(['remote', 'add', 'origin', path.join(scratch, 'missing.git')])
    const head = (await repo.git.revparse(['HEAD'])).trim()

    const info = await createWorktree(repo.path, 'dead-remote', { base: 'default' })

    expect(info.originalHeadCommit).toBe(head)
  })
})
