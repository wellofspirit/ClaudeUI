/**
 * @vitest-environment node
 *
 * Removing worktrees against REAL git repos (the `git` project): link safety, the branch rule
 * (R2), holder refusal (R3), partial removal and retry, out-of-repo layouts, and every refusal
 * (C-B1..C-B5, C-S2, C-S3, C-S8). Each test makes its own scratch directories; the sentinel
 * directory beside the repo is what any link in a worktree points at and must always survive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { simpleGit } from 'simple-git'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'
import {
  addWorktreeAt,
  makeLink,
  makeScratch,
  registeredPaths,
  type Scratch
} from '../../../test/helpers/worktree-fixtures'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  createWorktree,
  inventoryWorktrees,
  removeWorktree,
  removeWorktreeAtPath,
  removeWorktrees,
  type WorktreeRemoveOptions,
  type WorktreeRemoveProgress
} from '../../../core/services/worktree'
import { normaliseWorktreePath } from '../../../core/services/worktree-root'
import { createQuitRemovalDeps, removeWorktreesAfterTeardown } from '../quit-worktree-removal'
import type { HolderSources } from '../../../core/services/worktree-holders'

let repo: TempGitRepo
let scratch: Scratch
const children: ChildProcess[] = []

beforeEach(async () => {
  repo = await makeTempGitRepo()
  scratch = makeScratch()
})

afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await repo.cleanup()
  scratch.cleanup()
})

const idOf = (p: string): string => normaliseWorktreePath(p)
const none: HolderSources = { sessions: () => [], xAgents: () => [], terminals: () => [] }
const noHolders: WorktreeRemoveOptions = { enforceHolders: false }

async function branches(): Promise<string[]> {
  return (await repo.git.branch()).all
}

async function commitOn(worktreePath: string, file: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(worktreePath, file), `${message}\n`)
  const git = simpleGit(worktreePath)
  await git.add(file)
  await git.commit(message)
}

/** Start a process whose working directory is `dir` (a Windows delete of `dir` then fails). */
async function holdAsCwd(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: dir,
    stdio: 'ignore'
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return child
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  await exited
  await new Promise((r) => setTimeout(r, 300))
}

describe('removeWorktrees: the happy path and link safety', () => {
  it('removes a worktree full of junctions without touching their target, unregisters it, deletes its branch', async () => {
    const info = await createWorktree(repo.path, 'junc')
    fs.writeFileSync(path.join(info.worktreePath, 'work.txt'), 'x')
    makeLink(scratch.sentinel, path.join(info.worktreePath, 'node_modules'))
    makeLink(scratch.sentinel, path.join(info.worktreePath, 'vendor', 'claude-cli'))
    const progress: WorktreeRemoveProgress[] = []
    const forgot: string[][] = []

    const results = await removeWorktrees(
      repo.path,
      [idOf(info.worktreePath)],
      (p) => progress.push(p),
      {
        enforceHolders: false,
        forgetEntries: (paths) => forgot.push(paths)
      }
    )

    expect(results).toEqual([
      {
        id: idOf(info.worktreePath),
        outcome: 'removed',
        branch: { name: 'worktree-junc', action: 'deleted', uniqueCommits: 0 }
      }
    ])
    expect(fs.existsSync(info.worktreePath)).toBe(false)
    expect(scratch.sentinelIntact()).toBe(true)
    expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
    expect(await branches()).not.toContain('worktree-junc')
    expect(forgot).toEqual([[info.worktreePath]])
    expect(progress.at(-1)).toEqual({ done: 1, total: 1, phase: 'done' })
    expect(progress.some((p) => p.phase === 'junc: removing files')).toBe(true)
  })

  it('removes the shell a prior `git worktree remove` left behind (an orphan with links)', async () => {
    const managed = path.join(repo.path, '.claude', 'worktrees')
    makeLink(scratch.sentinel, path.join(managed, 'shell', 'node_modules'))
    makeLink(scratch.sentinel, path.join(managed, 'shell', 'vendor', 'x'))

    const results = await removeWorktrees(
      repo.path,
      [idOf(path.join(managed, 'shell'))],
      () => {},
      noHolders
    )

    expect(results[0].outcome).toBe('removed')
    expect(fs.existsSync(path.join(managed, 'shell'))).toBe(false)
    expect(scratch.sentinelIntact()).toBe(true)
  })

  it('removes an orphan that holds files (the confirm is the client’s job) and a link orphan without entering it', async () => {
    const managed = path.join(repo.path, '.claude', 'worktrees')
    fs.mkdirSync(path.join(managed, 'work'), { recursive: true })
    fs.writeFileSync(path.join(managed, 'work', 'unsaved.txt'), 'x')
    makeLink(scratch.sentinel, path.join(managed, 'linked'))

    const results = await removeWorktrees(
      repo.path,
      [idOf(path.join(managed, 'work')), idOf(path.join(managed, 'linked'))],
      () => {},
      noHolders
    )

    expect(results.map((r) => r.outcome)).toEqual(['removed', 'removed'])
    expect(fs.existsSync(path.join(managed, 'work'))).toBe(false)
    expect(fs.existsSync(path.join(managed, 'linked'))).toBe(false)
    expect(scratch.sentinelIntact()).toBe(true)
  })

  it('refuses a clone under the managed root and leaves it whole', async () => {
    const clone = path.join(repo.path, '.claude', 'worktrees', 'clone')
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
    fs.writeFileSync(path.join(clone, 'precious.txt'), 'x')

    const [res] = await removeWorktrees(repo.path, [idOf(clone)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: .*git repository/)
    expect(fs.existsSync(path.join(clone, 'precious.txt'))).toBe(true)
  })
})

describe('removeWorktrees: branch fate (R2, C-B5)', () => {
  it('keeps a branch with commits found nowhere else, and still removes a dirty worktree (R1)', async () => {
    const info = await createWorktree(repo.path, 'ahead')
    await commitOn(info.worktreePath, 'a.txt', 'only on the branch')
    fs.writeFileSync(path.join(info.worktreePath, 'dirty.txt'), 'uncommitted')

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res).toMatchObject({
      outcome: 'removed',
      branch: { name: 'worktree-ahead', action: 'kept', uniqueCommits: 1 }
    })
    expect(fs.existsSync(info.worktreePath)).toBe(false)
    expect(await branches()).toContain('worktree-ahead')
    expect((await repo.git.raw(['log', '-1', '--format=%s', 'worktree-ahead'])).trim()).toBe(
      'only on the branch'
    )
  })

  it('deletes a branch whose commits all live in another branch', async () => {
    const info = await createWorktree(repo.path, 'merged')
    await commitOn(info.worktreePath, 'a.txt', 'shared')
    await repo.git.raw(['branch', 'holder', info.worktreeBranch])

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res.branch).toEqual({ name: 'worktree-merged', action: 'deleted', uniqueCommits: 0 })
    expect(await branches()).not.toContain('worktree-merged')
    expect(await branches()).toContain('holder')
  })

  it('a detached worktree has no branch to decide about', async () => {
    const detached = path.join(scratch.base, 'det')
    await addWorktreeAt(repo, detached)

    const [res] = await removeWorktrees(repo.path, [idOf(detached)], () => {}, noHolders)

    expect(res).toEqual({ id: idOf(detached), outcome: 'removed' })
  })

  it('protects master and the remote default branch even with no unique commits', async () => {
    const onMaster = path.join(scratch.base, 'on-master')
    await addWorktreeAt(repo, onMaster, { branch: 'master' })
    const onTrunk = path.join(scratch.base, 'on-trunk')
    await addWorktreeAt(repo, onTrunk, { branch: 'trunk' })
    await repo.git.raw(['update-ref', 'refs/remotes/origin/trunk', 'trunk'])
    await repo.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])

    const results = await removeWorktrees(
      repo.path,
      [idOf(onMaster), idOf(onTrunk)],
      () => {},
      noHolders
    )

    expect(results[0].branch).toMatchObject({ name: 'master', action: 'protected' })
    expect(results[1].branch).toMatchObject({ name: 'trunk', action: 'protected' })
    expect(await branches()).toEqual(expect.arrayContaining(['master', 'trunk']))
  })
})

describe('removeWorktrees: refusals', () => {
  it('refuses a worktree with a LIVE holder, naming it, and leaves the directory whole', async () => {
    const info = await createWorktree(repo.path, 'busy')
    const sources: HolderSources = {
      ...none,
      sessions: () => [
        {
          id: 's1',
          engine: 'claude',
          title: 'Refactor auth',
          live: true,
          cwds: [path.join(info.worktreePath, 'src')]
        }
      ]
    }

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, {
      enforceHolders: true,
      sources
    })

    expect(res).toEqual({
      id: idOf(info.worktreePath),
      outcome: 'refused',
      reason: 'in-use: Refactor auth'
    })
    expect(fs.existsSync(path.join(info.worktreePath, '.git'))).toBe(true)
    expect(await registeredPaths(repo)).toContain(idOf(info.worktreePath))
  })

  it('removes a worktree held only by a cold session or a parked X-Agent (a warning, not a refusal)', async () => {
    const info = await createWorktree(repo.path, 'parked')
    const sources: HolderSources = {
      sessions: () => [{ id: 'cold', engine: 'pi', live: false, cwds: [info.worktreePath] }],
      xAgents: () => [
        { id: 'x', engine: 'codex', label: 'reviewer', cwd: info.worktreePath, live: false }
      ],
      terminals: () => []
    }

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, {
      enforceHolders: true,
      sources
    })

    expect(res.outcome).toBe('removed')
  })

  it('refuses a locked worktree', async () => {
    const info = await createWorktree(repo.path, 'locked')
    await repo.git.raw(['worktree', 'lock', info.worktreePath])

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res).toEqual({ id: idOf(info.worktreePath), outcome: 'refused', reason: 'locked' })
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })

  it('refuses ids that are not in a fresh inventory, deletes nothing, and carries on to the next id', async () => {
    const good = await createWorktree(repo.path, 'good')
    const outsider = path.join(scratch.base, 'outsider')
    fs.mkdirSync(outsider)
    fs.writeFileSync(path.join(outsider, 'keep.txt'), 'x')

    const ids = [
      '../x',
      'good',
      idOf(outsider),
      idOf(repo.path),
      idOf(path.join(repo.path, '.claude', 'worktrees', '..', '..')),
      idOf(good.worktreePath)
    ]
    const results = await removeWorktrees(repo.path, ids, () => {}, noHolders)

    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'not-found'],
      ['refused', 'not-found'],
      ['refused', 'not-found'],
      ['refused', 'not-found'],
      ['refused', 'not-found'],
      ['removed', undefined]
    ])
    expect(results.map((r) => r.id)).toEqual(ids)
    expect(fs.existsSync(path.join(outsider, 'keep.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repo.path, 'README.md'))).toBe(true)
  })

  it('BACKLINK: a forged registration cannot make a directory removable', async () => {
    const real = await createWorktree(repo.path, 'forged')
    const victim = path.join(scratch.base, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'important.txt'), 'mine')
    const forged = path.join(victim, '.git').replace(/\\/g, '/')
    fs.writeFileSync(path.join(repo.path, '.git', 'worktrees', 'forged', 'gitdir'), `${forged}\n`)

    const [res] = await removeWorktrees(repo.path, [idOf(victim)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: not verifiably a worktree of this repo/)
    expect(fs.readFileSync(path.join(victim, 'important.txt'), 'utf-8')).toBe('mine')
    expect(real.worktreePath).toBeTruthy()
  })

  it('B1: a registration forged through a junction inside the managed root cannot delete what the junction points at', async () => {
    await createWorktree(repo.path, 'forged')
    const outside = path.join(scratch.base, 'outside')
    const victim = path.join(outside, 'victim')
    fs.mkdirSync(victim, { recursive: true })
    fs.writeFileSync(path.join(victim, 'important.txt'), 'mine')
    const managed = path.join(repo.path, '.claude', 'worktrees')
    makeLink(outside, path.join(managed, 'lnk'))
    // Lexically `<repo>/.claude/worktrees/lnk/victim`, really `<base>/outside/victim`, no `.git` in it.
    const lexical = path.join(managed, 'lnk', 'victim')
    const forged = path.join(lexical, '.git').replace(/\\/g, '/')
    fs.writeFileSync(path.join(repo.path, '.git', 'worktrees', 'forged', 'gitdir'), `${forged}\n`)

    const [res] = await removeWorktrees(repo.path, [idOf(lexical)], () => {}, noHolders)

    expect(fs.existsSync(path.join(victim, 'important.txt'))).toBe(true)
    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: not verifiably a worktree of this repo/)
    // The listing agrees: not a managed entry, and marked unverifiable.
    const entry = (await inventoryWorktrees(repo.path)).entries.find((e) => e.id === idOf(lexical))
    expect(entry?.invalidReason).toMatch(/^not verifiably a worktree of this repo/)
    expect(entry?.location).not.toBe('managed')
  })

  it('B1: a .git-less shell is only removable as a DIRECT child of the managed root', async () => {
    const nested = path.join(repo.path, '.claude', 'worktrees', 'group', 'nested')
    await addWorktreeAt(repo, nested)
    fs.rmSync(path.join(nested, '.git'))
    fs.writeFileSync(path.join(nested, 'precious.txt'), 'mine')

    const [res] = await removeWorktrees(repo.path, [idOf(nested)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: not verifiably a worktree of this repo/)
    expect(fs.readFileSync(path.join(nested, 'precious.txt'), 'utf-8')).toBe('mine')
  })

  it('C-S3: refuses a registered directory that IS the home directory', async () => {
    const fakeHome = path.join(scratch.base, 'home')
    fs.mkdirSync(fakeHome)
    await addWorktreeAt(repo, fakeHome)
    fs.writeFileSync(path.join(fakeHome, 'dotfile'), 'mine')
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome
    try {
      const [res] = await removeWorktrees(repo.path, [idOf(fakeHome)], () => {}, noHolders)

      expect(res.outcome).toBe('refused')
      expect(res.reason).toMatch(/^invalid: refusing to remove .*home directory/)
      expect(fs.readFileSync(path.join(fakeHome, 'dotfile'), 'utf-8')).toBe('mine')
    } finally {
      process.env.USERPROFILE = saved.USERPROFILE
      process.env.HOME = saved.HOME
    }
  })

  it('C-S3: refuses a registered directory that CONTAINS the repository', async () => {
    const outer = path.join(scratch.base, 'outer')
    const inner = path.join(outer, 'repo')
    fs.mkdirSync(inner, { recursive: true })
    const git = simpleGit(inner)
    await git.init(['--initial-branch=main'])
    await git.addConfig('user.name', 'T')
    await git.addConfig('user.email', 't@example.com')
    fs.writeFileSync(path.join(inner, 'a.txt'), 'a')
    await git.add('a.txt')
    await git.commit('initial')
    // Register `outer` as a (valid-looking) linked worktree of the inner repo, by hand.
    const admin = path.join(inner, '.git', 'worktrees', 'outer')
    fs.mkdirSync(admin, { recursive: true })
    const head = (await git.revparse(['HEAD'])).trim()
    fs.writeFileSync(path.join(admin, 'HEAD'), `${head}\n`)
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
    fs.writeFileSync(
      path.join(admin, 'gitdir'),
      `${path.join(outer, '.git').replace(/\\/g, '/')}\n`
    )
    fs.writeFileSync(path.join(outer, '.git'), `gitdir: ${admin.replace(/\\/g, '/')}\n`)

    const inv = await inventoryWorktrees(inner)
    expect(inv.entries.map((e) => [e.id, e.invalidReason])).toEqual([[idOf(outer), undefined]])
    const [res] = await removeWorktrees(inner, [idOf(outer)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: refusing to remove /)
    expect(fs.readFileSync(path.join(inner, 'a.txt'), 'utf-8')).toBe('a')
  })

  it('an entry that contains another is refused alone; selected together the inner one goes first', async () => {
    const outer = await createWorktree(repo.path, 'outer')
    const inner = path.join(outer.worktreePath, 'inner-wt')
    await addWorktreeAt(repo, inner)

    const [alone] = await removeWorktrees(
      repo.path,
      [idOf(outer.worktreePath)],
      () => {},
      noHolders
    )
    expect(alone.outcome).toBe('refused')
    expect(alone.reason).toMatch(/^invalid: contains other worktrees \(.*inner-wt.*\)/)
    expect(fs.existsSync(inner)).toBe(true)

    const together = await removeWorktrees(
      repo.path,
      [idOf(outer.worktreePath), idOf(inner)],
      () => {},
      noHolders
    )
    expect(together.map((r) => [r.id, r.outcome])).toEqual([
      [idOf(outer.worktreePath), 'removed'],
      [idOf(inner), 'removed']
    ])
    expect(fs.existsSync(outer.worktreePath)).toBe(false)
  })
})

describe('removeWorktrees: out-of-repo layouts (R5)', () => {
  it('removes a Codex-layout worktree and then its EMPTY <4hex> bucket, but not a bucket that holds anything else', async () => {
    const emptyBucket = path.join(scratch.base, '.codex', 'worktrees', 'ab12')
    const sharedBucket = path.join(scratch.base, '.codex', 'worktrees', 'cd34')
    const a = path.join(emptyBucket, 'myrepo')
    const b = path.join(sharedBucket, 'myrepo')
    await addWorktreeAt(repo, a)
    await addWorktreeAt(repo, b)
    fs.mkdirSync(path.join(sharedBucket, 'sibling'))
    fs.writeFileSync(path.join(sharedBucket, 'sibling', 'file.txt'), 'x')

    const results = await removeWorktrees(repo.path, [idOf(a), idOf(b)], () => {}, noHolders)

    expect(results.map((r) => r.outcome)).toEqual(['removed', 'removed'])
    expect(fs.existsSync(emptyBucket)).toBe(false)
    expect(fs.existsSync(path.join(sharedBucket, 'sibling', 'file.txt'))).toBe(true)
    expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
  })

  it('removes an opencode-layout worktree', async () => {
    const wt = path.join(scratch.base, 'share', 'worktree', 'abcdef', 'brave-fox')
    await addWorktreeAt(repo, wt)
    makeLink(scratch.sentinel, path.join(wt, 'node_modules'))

    const [res] = await removeWorktrees(repo.path, [idOf(wt)], () => {}, noHolders)

    expect(res.outcome).toBe('removed')
    expect(fs.existsSync(wt)).toBe(false)
    expect(scratch.sentinelIntact()).toBe(true)
    expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
  })

  it('never `git worktree prune`: unregistering a missing worktree leaves other missing ones registered', async () => {
    const m1 = await createWorktree(repo.path, 'm1')
    const m2 = await createWorktree(repo.path, 'm2')
    fs.rmSync(m1.worktreePath, { recursive: true, force: true })
    fs.rmSync(m2.worktreePath, { recursive: true, force: true })

    const [res] = await removeWorktrees(repo.path, [idOf(m1.worktreePath)], () => {}, noHolders)

    expect(res.outcome).toBe('removed')
    expect(res.branch).toMatchObject({ name: 'worktree-m1', action: 'deleted' })
    const registered = await registeredPaths(repo)
    expect(registered).not.toContain(idOf(m1.worktreePath))
    expect(registered).toContain(idOf(m2.worktreePath))
  })

  it('a branch git will not delete (checked out in another worktree) is kept with the reason, not failed', async () => {
    const m = await createWorktree(repo.path, 'twice')
    const elsewhere = path.join(scratch.base, 'elsewhere')
    await repo.git.raw(['worktree', 'add', '--force', elsewhere, m.worktreeBranch])
    fs.rmSync(m.worktreePath, { recursive: true, force: true })

    const [res] = await removeWorktrees(repo.path, [idOf(m.worktreePath)], () => {}, noHolders)

    expect(res.outcome).toBe('removed')
    expect(res.branch).toMatchObject({ name: 'worktree-twice', action: 'kept' })
    expect(res.branch?.reason).toMatch(/checked out|used by worktree/i)
    expect(await branches()).toContain('worktree-twice')
  })
})

describe('removeWorktrees: partial removal and retry', () => {
  it.skipIf(process.platform !== 'win32')(
    'a locked directory gives `partial` with its path, the entry stays registered and valid, and a retry removes it',
    async () => {
      const info = await createWorktree(repo.path, 'locked-dir')
      const held = path.join(info.worktreePath, 'held')
      fs.mkdirSync(held)
      fs.writeFileSync(path.join(held, 'inner.txt'), 'x')
      fs.writeFileSync(path.join(info.worktreePath, 'free.txt'), 'x')
      const child = await holdAsCwd(held)
      const forgot: string[][] = []
      const opts: WorktreeRemoveOptions = {
        enforceHolders: false,
        forgetEntries: (p) => forgot.push(p)
      }

      const [first] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, opts)

      expect(first.outcome).toBe('partial')
      expect(first.failures?.map((f) => f.path)).toContain(held)
      expect(fs.existsSync(path.join(info.worktreePath, 'free.txt'))).toBe(false)
      expect(fs.existsSync(path.join(info.worktreePath, '.git'))).toBe(true)
      expect(await registeredPaths(repo)).toContain(idOf(info.worktreePath))
      expect(await branches()).toContain('worktree-locked-dir')
      const inv = await inventoryWorktrees(repo.path)
      expect(
        inv.entries.find((e) => e.id === idOf(info.worktreePath))?.invalidReason
      ).toBeUndefined()
      // A partial result keeps the recorded entries: dropping them would make `createdOnly`
      // refuse every retry (the next test).
      expect(forgot).toEqual([])

      await release(child)
      const [second] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, opts)

      expect(second.outcome).toBe('removed')
      expect(second.branch).toMatchObject({ action: 'deleted' })
      expect(fs.existsSync(info.worktreePath)).toBe(false)
      expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
      expect(forgot).toEqual([[info.worktreePath]])
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'a partial result keeps the created-worktree record, so a retry under createdOnly passes and the removal then forgets it',
    async () => {
      const info = await createWorktree(repo.path, 'created-retry')
      const held = path.join(info.worktreePath, 'held')
      fs.mkdirSync(held)
      fs.writeFileSync(path.join(held, 'inner.txt'), 'x')
      const child = await holdAsCwd(held)
      // Stands for the session records `createdOnly` re-reads: `forgetEntries` clears it, as
      // `forgetWorktreeEntries` does for the real `worktreeInfoMap`.
      const recorded = new Set([idOf(info.worktreePath)])
      const opts: WorktreeRemoveOptions = {
        enforceHolders: false,
        createdOnly: (p) => recorded.has(idOf(p)),
        forgetEntries: (paths) => paths.forEach((p) => recorded.delete(idOf(p)))
      }

      const [first] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, opts)

      expect(first.outcome).toBe('partial')
      expect(recorded.has(idOf(info.worktreePath))).toBe(true)

      await release(child)
      const [second] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, opts)

      expect(second.outcome).toBe('removed')
      expect(fs.existsSync(info.worktreePath)).toBe(false)
      expect(recorded.size).toBe(0)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'an out-of-repo worktree whose ROOT is a process cwd keeps its .git pointer (partial, still listed), and retries cleanly',
    async () => {
      const wt = path.join(scratch.base, '.codex', 'worktrees', 'ab12', 'myrepo')
      await addWorktreeAt(repo, wt)
      fs.writeFileSync(path.join(wt, 'file.txt'), 'x')
      const child = await holdAsCwd(wt)

      const [first] = await removeWorktrees(repo.path, [idOf(wt)], () => {}, noHolders)

      expect(first.outcome).toBe('partial')
      expect(first.failures?.length).toBeGreaterThan(0)
      expect(fs.existsSync(path.join(wt, '.git'))).toBe(true)
      expect(fs.existsSync(path.join(wt, 'file.txt'))).toBe(false)
      const inv = await inventoryWorktrees(repo.path)
      const entry = inv.entries.find((e) => e.id === idOf(wt))
      expect(entry).toMatchObject({ kind: 'worktree', location: 'codex' })
      expect(entry?.invalidReason).toBeUndefined()

      await release(child)
      const [second] = await removeWorktrees(repo.path, [idOf(wt)], () => {}, noHolders)

      expect(second.outcome).toBe('removed')
      expect(fs.existsSync(path.join(scratch.base, '.codex', 'worktrees', 'ab12'))).toBe(false)
      expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
    }
  )
})

describe('removeWorktrees: concurrency and freshness (C-S8)', () => {
  it('two calls for one repo never overlap', async () => {
    const a = await createWorktree(repo.path, 'a')
    const b = await createWorktree(repo.path, 'b')
    const events: string[] = []
    const track =
      (tag: string) =>
      (p: WorktreeRemoveProgress): void => {
        events.push(`${tag}:${p.phase === 'done' ? 'done' : 'work'}`)
      }

    await Promise.all([
      removeWorktrees(repo.path, [idOf(a.worktreePath)], track('A'), noHolders),
      removeWorktrees(repo.path, [idOf(b.worktreePath)], track('B'), noHolders)
    ])

    const firstDone = events.findIndex((e) => e.endsWith(':done'))
    const firstTag = events[0].split(':')[0]
    expect(events.slice(0, firstDone + 1).every((e) => e.startsWith(firstTag))).toBe(true)
    expect(events.slice(firstDone + 1).every((e) => !e.startsWith(firstTag))).toBe(true)
  })

  it('holders are re-collected for each entry: a session that appears mid-call blocks the later one', async () => {
    const a = await createWorktree(repo.path, 'first')
    const b = await createWorktree(repo.path, 'second')
    let appeared = false
    const sources: HolderSources = {
      ...none,
      sessions: () =>
        appeared
          ? [{ id: 'late', engine: 'claude', title: 'Late', live: true, cwds: [b.worktreePath] }]
          : []
    }

    const results = await removeWorktrees(
      repo.path,
      [idOf(a.worktreePath), idOf(b.worktreePath)],
      (p) => {
        if (p.done === 1) appeared = true
      },
      { enforceHolders: true, sources }
    )

    // Equal depth keeps the input order, so `first` goes first and `second` is checked afterwards.
    expect(results.map((r) => r.outcome)).toEqual(['removed', 'refused'])
    expect(results[1].reason).toBe('in-use: Late')
    expect(fs.existsSync(b.worktreePath)).toBe(true)
  })
})

describe('the per-entry re-check matches live holders only (R1)', () => {
  it('does not resolve the directories of cold holders', async () => {
    const wt = await createWorktree(repo.path, 'recheck-live-only')
    const coldRoot = path.join(scratch.base, 'cold-holder-marker')
    let calls = 0
    // Only the re-check right before the walk (the 2nd collection) sees the cold session.
    const sources: HolderSources = {
      ...none,
      sessions: () =>
        ++calls === 1
          ? []
          : [
              {
                id: 'cold',
                engine: 'claude',
                title: 'Cold',
                live: false,
                cwds: [path.join(coldRoot, 'deep')]
              }
            ]
    }
    const real = fs.realpathSync.native
    const resolved: string[] = []
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((
      p: fs.PathLike,
      ...rest: unknown[]
    ) => {
      resolved.push(String(p))
      return (real as (...a: unknown[]) => string)(p, ...rest)
    }) as typeof fs.realpathSync.native)

    try {
      const [res] = await removeWorktrees(repo.path, [idOf(wt.worktreePath)], () => {}, {
        enforceHolders: true,
        sources
      })

      // The cold session never blocked it, and its directory was never resolved.
      expect(res.outcome).toBe('removed')
      expect(calls).toBe(2)
      expect(resolved.filter((p) => p.includes('cold-holder-marker'))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('beforeWalk hook (the IPC layer closes mockup watchers under the path)', () => {
  it('runs for an entry about to be walked, not for a refused one, and a throw does not stop the removal', async () => {
    const gone = await createWorktree(repo.path, 'hook-gone')
    const held = await createWorktree(repo.path, 'hook-held')
    const sources: HolderSources = {
      ...none,
      sessions: () => [
        { id: 's', engine: 'claude', title: 'Open', live: true, cwds: [held.worktreePath] }
      ]
    }
    const walked: string[] = []

    const results = await removeWorktrees(
      repo.path,
      [idOf(gone.worktreePath), idOf(held.worktreePath)],
      () => {},
      {
        enforceHolders: true,
        sources,
        beforeWalk: (p) => {
          walked.push(p)
          throw new Error('watcher already closed')
        }
      }
    )

    expect(results.map((r) => r.outcome)).toEqual(['removed', 'refused'])
    expect(walked.map(idOf)).toEqual([idOf(gone.worktreePath)])
    expect(fs.existsSync(gone.worktreePath)).toBe(false)
  })

  it('is not called when only the final re-check refuses (a holder that appeared after the inventory)', async () => {
    const wt = await createWorktree(repo.path, 'hook-late')
    let calls = 0
    // The first collection (the inventory read) is clean; the one right before the walk sees the holder.
    const sources: HolderSources = {
      ...none,
      sessions: () =>
        ++calls === 1
          ? []
          : [{ id: 'late', engine: 'claude', title: 'Late', live: true, cwds: [wt.worktreePath] }]
    }
    const walked: string[] = []

    const [res] = await removeWorktrees(repo.path, [idOf(wt.worktreePath)], () => {}, {
      enforceHolders: true,
      sources,
      beforeWalk: (p) => walked.push(p)
    })

    expect(res).toMatchObject({ outcome: 'refused', reason: 'in-use: Late' })
    expect(calls).toBe(2)
    expect(walked).toEqual([])
    expect(fs.existsSync(wt.worktreePath)).toBe(true)
  })

  it('is not called for a missing entry (there is nothing to walk)', async () => {
    const wt = await createWorktree(repo.path, 'hook-missing')
    fs.rmSync(wt.worktreePath, { recursive: true, force: true })
    const walked: string[] = []

    const [res] = await removeWorktrees(repo.path, [idOf(wt.worktreePath)], () => {}, {
      enforceHolders: false,
      beforeWalk: (p) => walked.push(p)
    })

    expect(res.outcome).toBe('removed')
    expect(walked).toEqual([])
  })

  it('is passed through the legacy entry point', async () => {
    const info = await createWorktree(repo.path, 'hook-legacy')
    const walked: string[] = []

    await removeWorktree(info.worktreePath, 'x', '', {
      sources: none,
      beforeWalk: (p) => walked.push(p)
    })

    expect(walked.map(idOf)).toEqual([idOf(info.worktreePath)])
  })
})

describe('the quit ladder over a partial removal (R-1: the created record survives a partial)', () => {
  it.skipIf(process.platform !== 'win32')(
    'a busy worktree is retried by the real ladder and removed, because the first partial kept its record',
    async () => {
      const info = await createWorktree(repo.path, 'quit-retry')
      const held = path.join(info.worktreePath, 'held')
      fs.mkdirSync(held)
      fs.writeFileSync(path.join(held, 'inner.txt'), 'x')
      const child = await holdAsCwd(held)
      // The session records `createdOnly` re-reads; `forgetEntries` clears it like the real one.
      const recorded = new Set([idOf(info.worktreePath)])
      const lines: string[] = []
      const outcomes: string[] = []
      const deps = createQuitRemovalDeps({
        forEachSession: () => {},
        killTerminals: () => {},
        releaseDispatchTargets: () => {},
        removeAtPath: async (p, opts, root) => {
          const res = await removeWorktreeAtPath(p, opts, root)
          outcomes.push(res.outcome === 'refused' ? `refused: ${res.reason}` : res.outcome)
          return res
        },
        beforeWalk: () => {},
        forgetEntries: (paths) => paths.forEach((p) => recorded.delete(idOf(p))),
        createdOnly: (p) => recorded.has(idOf(p)),
        debug: (m) => lines.push(m),
        warn: (m) => lines.push(m),
        settleMs: 0,
        retryDelaysMs: [0, 0],
        // Let the holder go after the first attempt, before the first retry.
        sleep: async () => {
          if (outcomes.length > 0 && child.exitCode === null) await release(child)
        }
      })

      await removeWorktreesAfterTeardown([info.worktreePath], deps)

      expect(outcomes).toEqual(['partial', 'removed'])
      expect(fs.existsSync(info.worktreePath)).toBe(false)
      expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
      expect(recorded.size).toBe(0)
    }
  )
})

describe('createdOnly (C-S11: the quit and legacy paths remove only what ClaudeUI created)', () => {
  it('refuses an entry the predicate does not accept, touching nothing, and removes the accepted one', async () => {
    const made = await createWorktree(repo.path, 'made-by-us')
    const foreign = await createWorktree(repo.path, 'not-ours')
    const walked: string[] = []

    const results = await removeWorktrees(
      repo.path,
      [idOf(made.worktreePath), idOf(foreign.worktreePath)],
      () => {},
      {
        enforceHolders: false,
        createdOnly: (p) => idOf(p) === idOf(made.worktreePath),
        beforeWalk: (p) => walked.push(p)
      }
    )

    expect(results.map((r) => r.outcome)).toEqual(['removed', 'refused'])
    expect(results[1].reason).toBe('invalid: not a worktree ClaudeUI created')
    expect(fs.existsSync(foreign.worktreePath)).toBe(true)
    expect(await registeredPaths(repo)).toContain(idOf(foreign.worktreePath))
    expect(walked.map(idOf)).toEqual([idOf(made.worktreePath)])
  })

  it('applies to the legacy entry point too', async () => {
    const info = await createWorktree(repo.path, 'legacy-foreign')

    const res = await removeWorktree(info.worktreePath, 'x', '', {
      sources: none,
      createdOnly: () => false
    })

    expect(res).toMatchObject({
      outcome: 'refused',
      reason: 'invalid: not a worktree ClaudeUI created'
    })
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })

  it('a path that is no worktree is still not-found, not a created-check answer', async () => {
    const [res] = await removeWorktrees(repo.path, [idOf(path.join(repo.path, 'nope'))], () => {}, {
      enforceHolders: false,
      createdOnly: () => false
    })

    expect(res).toMatchObject({ outcome: 'refused', reason: 'not-found' })
  })
})

describe('removeWorktreeAtPath (the quit removal: one path in, the entry found by directory, N1)', () => {
  it('finds the entry for a path spelled through a link (not by lexical id) and removes it, holders not enforced', async () => {
    const info = await createWorktree(repo.path, 'via-link')
    const link = path.join(scratch.base, 'via-link-parent')
    makeLink(path.dirname(info.worktreePath), link)
    const spelled = path.join(link, path.basename(info.worktreePath))
    expect(idOf(spelled)).not.toBe(idOf(info.worktreePath)) // the lexical ids differ

    const res = await removeWorktreeAtPath(spelled, { enforceHolders: false })

    expect(res).toMatchObject({ outcome: 'removed' })
    expect(fs.existsSync(info.worktreePath)).toBe(false)
    expect(scratch.sentinelIntact()).toBe(true)
  })

  it('throws for a path that is no worktree of its repo, and honours createdOnly', async () => {
    const info = await createWorktree(repo.path, 'at-path')

    // Inside a repo but no worktree of it: the message says so (NIT-3), not "outside the managed
    // directory" (that is for a path that leads to no repo at all, tested below).
    await expect(
      removeWorktreeAtPath(path.join(repo.path, 'src-not-a-worktree'), { enforceHolders: false })
    ).rejects.toThrow(/Refusing to remove worktree .*: not a worktree of its repository/)
    await expect(
      removeWorktreeAtPath(path.join(scratch.base, 'nowhere'), { enforceHolders: false })
    ).rejects.toThrow(/Refusing to remove worktree outside the managed directory/)
    const res = await removeWorktreeAtPath(info.worktreePath, {
      enforceHolders: false,
      createdOnly: () => false
    })

    expect(res).toMatchObject({
      outcome: 'refused',
      reason: 'invalid: not a worktree ClaudeUI created'
    })
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })
})

describe('removeWorktreeAtPath: a created worktree whose folder is already gone (RC-1)', () => {
  it('finds an out-of-repo worktree through the recorded repo root and unregisters it', async () => {
    const wt = path.join(scratch.base, 'elsewhere', 'gone-wt')
    await addWorktreeAt(repo, wt)
    fs.rmSync(wt, { recursive: true, force: true })
    const forgot: string[][] = []
    const opts: WorktreeRemoveOptions = {
      enforceHolders: false,
      createdOnly: () => true,
      forgetEntries: (p) => forgot.push(p)
    }

    // Without the recorded root the path leads nowhere: only the record is dropped, git's
    // registration stays (the old behaviour was a throw, and a retry that never worked).
    await removeWorktreeAtPath(wt, opts)
    expect(await registeredPaths(repo)).toContain(idOf(wt))
    forgot.length = 0

    const res = await removeWorktreeAtPath(wt, opts, repo.path)

    expect(res).toMatchObject({ outcome: 'removed' })
    expect(await registeredPaths(repo)).toEqual([idOf(repo.path)])
    expect(forgot).toEqual([[wt]])
  })

  it('removes the branch of a missing entry by the branch rule', async () => {
    const wt = path.join(scratch.base, 'elsewhere', 'gone-branch')
    await addWorktreeAt(repo, wt, { branch: 'gone-branch' })
    fs.rmSync(wt, { recursive: true, force: true })

    const res = await removeWorktreeAtPath(
      wt,
      { enforceHolders: false, createdOnly: () => true },
      repo.path
    )

    expect(res).toMatchObject({ outcome: 'removed', branch: { name: 'gone-branch' } })
    expect(await branches()).not.toContain('gone-branch')
  })

  it('a created path that is in no inventory and not on disk is only forgotten', async () => {
    const wt = path.join(scratch.base, 'elsewhere', 'never-registered')
    const forgot: string[][] = []

    const res = await removeWorktreeAtPath(
      wt,
      { enforceHolders: false, createdOnly: () => true, forgetEntries: (p) => forgot.push(p) },
      path.join(scratch.base, 'repo-also-gone')
    )

    expect(res).toMatchObject({ outcome: 'removed' })
    expect(forgot).toEqual([[wt]])
  })

  it('does not forget (and throws) when the path was not created by ClaudeUI, or still exists', async () => {
    const gone = path.join(scratch.base, 'elsewhere', 'foreign-gone')
    const forgot: string[][] = []
    const opts: WorktreeRemoveOptions = {
      enforceHolders: false,
      createdOnly: () => false,
      forgetEntries: (p) => forgot.push(p)
    }
    await expect(removeWorktreeAtPath(gone, opts)).rejects.toThrow(/Refusing to remove worktree/)

    const stranger = path.join(scratch.base, 'stranger-dir')
    fs.mkdirSync(stranger)
    await expect(
      removeWorktreeAtPath(stranger, { ...opts, createdOnly: () => true })
    ).rejects.toThrow(/Refusing to remove worktree/)
    expect(forgot).toEqual([])
    expect(fs.existsSync(stranger)).toBe(true)
  })
})

describe('removeWorktree (legacy single-path entry point)', () => {
  it('returns the result object and takes the repo from the path, ignoring the caller’s root argument', async () => {
    const info = await createWorktree(repo.path, 'legacy')

    const res = await removeWorktree(
      info.worktreePath,
      'main',
      path.join(scratch.base, 'bogus-root'),
      {
        sources: none
      }
    )

    expect(res).toMatchObject({ outcome: 'removed', branch: { action: 'deleted' } })
    expect(fs.existsSync(info.worktreePath)).toBe(false)
  })

  it('enforces holders when given sources (the session-delete flow does not stop the session)', async () => {
    const info = await createWorktree(repo.path, 'legacy-busy')
    const sources: HolderSources = {
      ...none,
      sessions: () => [
        { id: 's', engine: 'claude', title: 'Still open', live: true, cwds: [info.worktreePath] }
      ]
    }

    const res = await removeWorktree(info.worktreePath, 'main', repo.path, { sources })

    expect(res).toMatchObject({ outcome: 'refused', reason: 'in-use: Still open' })
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })

  it('removes an out-of-repo registered worktree found through its own .git file', async () => {
    const wt = path.join(scratch.base, 'elsewhere', 'wt')
    await addWorktreeAt(repo, wt)

    const res = await removeWorktree(wt, 'x', '', { sources: none })

    expect(res.outcome).toBe('removed')
    expect(fs.existsSync(wt)).toBe(false)
  })

  it('refuses (throws) a directory that is registered nowhere and sits outside the managed root', async () => {
    const stranger = path.join(scratch.base, 'stranger')
    fs.mkdirSync(stranger)

    await expect(removeWorktree(stranger, 'x', repo.path, { sources: none })).rejects.toThrow(
      /outside the managed directory/
    )
    expect(fs.existsSync(stranger)).toBe(true)
  })
})

describe('removeWorktree (legacy): holders are not optional (S1) and bare repos work (S4)', () => {
  it('S1: refuses to run without holder sources, so the live-holder refusal cannot be skipped by omission', async () => {
    const info = await createWorktree(repo.path, 'nosources')

    // @ts-expect-error `deps` (with `sources`) is required
    const none1 = removeWorktree(info.worktreePath, 'x', '')
    await expect(none1).rejects.toThrow(/holder sources/)
    // @ts-expect-error `sources` is required
    const none2 = removeWorktree(info.worktreePath, 'x', '', { forgetEntries: () => {} })
    await expect(none2).rejects.toThrow(/holder sources/)

    expect(fs.existsSync(info.worktreePath)).toBe(true)
    expect(await registeredPaths(repo)).toContain(idOf(info.worktreePath))
  })

  it('S4: a worktree of a BARE repo is found and removed (the common dir is not a place to run git from)', async () => {
    const bare = path.join(scratch.base, 'origin.git')
    await simpleGit(scratch.base).raw(['clone', '--bare', repo.path, bare])
    const wt = path.join(scratch.base, 'bare-wt')
    await simpleGit(bare).raw(['worktree', 'add', '--detach', wt])
    const inventory = await inventoryWorktrees(wt)
    expect(inventory.managedRoot).toBe('')
    expect(inventory.entries.map((e) => e.id)).toEqual([idOf(wt)])

    const res = await removeWorktree(wt, 'x', '', { sources: none })

    expect(res).toMatchObject({ id: idOf(wt), outcome: 'removed' })
    expect(fs.existsSync(wt)).toBe(false)
    const listed = await simpleGit(bare).raw(['worktree', 'list', '--porcelain'])
    expect(listed.match(/^worktree /gm)).toHaveLength(1)
  })
})

describe('removeWorktrees: review hardening', () => {
  it('S3: the same repo reached through a link shares one lock with its real spelling', async () => {
    const a = await createWorktree(repo.path, 'lock-a')
    const b = await createWorktree(repo.path, 'lock-b')
    const viaLink = path.join(scratch.base, 'repo-link')
    makeLink(repo.path, viaLink)
    const events: string[] = []
    const track =
      (tag: string) =>
      (p: WorktreeRemoveProgress): void => {
        events.push(`${tag}:${p.phase === 'done' ? 'done' : 'work'}`)
      }

    await Promise.all([
      removeWorktrees(repo.path, [idOf(a.worktreePath)], track('A'), noHolders),
      removeWorktrees(viaLink, [idOf(b.worktreePath)], track('B'), noHolders)
    ])

    const firstDone = events.findIndex((e) => e.endsWith(':done'))
    const firstTag = events[0].split(':')[0]
    expect(events.slice(0, firstDone + 1).every((e) => e.startsWith(firstTag))).toBe(true)
    expect(events.slice(firstDone + 1).every((e) => !e.startsWith(firstTag))).toBe(true)
    expect(fs.existsSync(a.worktreePath) || fs.existsSync(b.worktreePath)).toBe(false)
  })

  it('N3: an inventory git cannot read is a failure with its message, not "not-found"', async () => {
    const info = await createWorktree(repo.path, 'badconfig')
    fs.appendFileSync(path.join(repo.path, '.git', 'config'), '\n[broken\n')

    const [res] = await removeWorktrees(repo.path, [idOf(info.worktreePath)], () => {}, noHolders)

    expect(res.outcome).toBe('failed')
    expect(res.reason).toMatch(/config/i)
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })

  it('N2: a registered directory inside the git directory is refused even when the repo is reached through a link', async () => {
    const inside = path.join(repo.path, '.git', 'inside-wt')
    await addWorktreeAt(repo, inside)
    const viaLink = path.join(scratch.base, 'repo-link')
    makeLink(repo.path, viaLink)

    const [res] = await removeWorktrees(viaLink, [idOf(inside)], () => {}, noHolders)

    expect(res.outcome).toBe('refused')
    expect(res.reason).toMatch(/^invalid: refusing to remove .*git directory/)
    expect(fs.existsSync(path.join(inside, '.git'))).toBe(true)
  })

  it('N4: a progress callback that throws neither fails an entry nor loses the other results', async () => {
    const a = await createWorktree(repo.path, 'noisy-a')
    const b = await createWorktree(repo.path, 'noisy-b')

    const results = await removeWorktrees(
      repo.path,
      [idOf(a.worktreePath), idOf(b.worktreePath)],
      () => {
        throw new Error('window is gone')
      },
      noHolders
    )

    expect(results.map((r) => r.outcome)).toEqual(['removed', 'removed'])
    expect(fs.existsSync(a.worktreePath) || fs.existsSync(b.worktreePath)).toBe(false)
  })
})
