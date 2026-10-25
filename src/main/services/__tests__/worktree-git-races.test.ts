/**
 * @vitest-environment node
 *
 * Things that change between the checks and the delete. Real git against a temp repo, with a hook
 * on `simple-git`'s `raw` that runs a callback just before a chosen git command: the removal has
 * read the inventory by then and is deciding the branch's fate, so whatever the hook does is a
 * change made behind its back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'
import { registeredPaths } from '../../../test/helpers/worktree-fixtures'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const hooks = vi.hoisted(() => ({
  onRaw: null as null | ((args: string[]) => void | Promise<void>)
}))

vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('simple-git')>()
  return {
    ...actual,
    simpleGit: (...params: Parameters<typeof actual.simpleGit>) => {
      const git = actual.simpleGit(...params)
      const raw = git.raw.bind(git) as (...a: unknown[]) => Promise<string>
      return Object.assign(git, {
        raw: async (...a: unknown[]): Promise<string> => {
          await hooks.onRaw?.(a.flat() as string[])
          return raw(...a)
        }
      })
    }
  }
})

import { createWorktree, removeWorktrees } from '../../../core/services/worktree'
import { normaliseWorktreePath } from '../../../core/services/worktree-root'

let repo: TempGitRepo

beforeEach(async () => {
  repo = await makeTempGitRepo()
})

afterEach(async () => {
  hooks.onRaw = null
  await repo.cleanup()
})

const idOf = (p: string): string => normaliseWorktreePath(p)
const noHolders = { enforceHolders: false } as const

/** Run `fire` once, just before the first `git <command>`. */
function onceBefore(command: string, fire: () => void): void {
  let fired = false
  hooks.onRaw = (args) => {
    if (!fired && args[0] === command) {
      fired = true
      fire()
    }
  }
}

describe('removal re-checks behind its own back', () => {
  it('N1: a directory that reappears at a missing worktree’s path is refused, not handed to `git worktree remove`', async () => {
    const info = await createWorktree(repo.path, 'ghost')
    fs.rmSync(info.worktreePath, { recursive: true, force: true })
    // The branch decision runs git before the unregister; the agent recreates its directory then.
    onceBefore('symbolic-ref', () => {
      fs.mkdirSync(info.worktreePath)
      fs.writeFileSync(path.join(info.worktreePath, 'precious.txt'), 'new work')
    })

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res).toEqual({
      id: idOf(info.worktreePath),
      outcome: 'refused',
      reason: 'invalid: reappeared'
    })
    expect(fs.readFileSync(path.join(info.worktreePath, 'precious.txt'), 'utf-8')).toBe('new work')
    expect(await registeredPaths(repo)).toContain(idOf(info.worktreePath))
  })

  it('N5: a lock taken after the inventory was read stops the walk (files untouched)', async () => {
    const info = await createWorktree(repo.path, 'racelock')
    onceBefore('symbolic-ref', () => {
      execFileSync('git', ['worktree', 'lock', info.worktreePath], { cwd: repo.path })
    })

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res).toEqual({ id: idOf(info.worktreePath), outcome: 'refused', reason: 'locked' })
    expect(fs.existsSync(path.join(info.worktreePath, 'README.md'))).toBe(true)
    expect(await registeredPaths(repo)).toContain(idOf(info.worktreePath))
  })

  it('N5: a worktree unregistered after the inventory was read is refused, not deleted as if still registered', async () => {
    const info = await createWorktree(repo.path, 'racegone')
    onceBefore('symbolic-ref', () => {
      execFileSync('git', ['worktree', 'remove', '--force', info.worktreePath], { cwd: repo.path })
      // …and the directory comes back with the user’s files in it.
      fs.mkdirSync(info.worktreePath)
      fs.writeFileSync(path.join(info.worktreePath, 'precious.txt'), 'mine')
    })

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(fs.readFileSync(path.join(info.worktreePath, 'precious.txt'), 'utf-8')).toBe('mine')
  })
})
