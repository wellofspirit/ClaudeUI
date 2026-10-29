/**
 * @vitest-environment node
 *
 * Worktree inventory, inspection and measuring against REAL git repos (the `git` project).
 * Out-of-repo layouts (opencode's `<data>/worktree/<proj6>/<slug>`, a foreign tool's
 * `<home>/worktrees/<4hex>/<repo>`) are made with `git worktree add` into a scratch base.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { simpleGit } from 'simple-git'
import {
  makeTempGitRepo,
  makeBareRemoteRepo,
  type TempGitRepo
} from '../../../test/helpers/temp-git-repo'
import {
  addWorktreeAt,
  makeLink,
  makeScratch,
  type Scratch
} from '../../../test/helpers/worktree-fixtures'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  createWorktree,
  getWorktreeStatus,
  inspectWorktree,
  inventoryWorktrees,
  measureWorktree
} from '../../../core/services/worktree'
import { linkedWorktreeOf, normaliseWorktreePath } from '../../../core/services/worktree-root'
import type { HolderSources } from '../../../core/services/worktree-holders'

let repo: TempGitRepo
let scratch: Scratch

beforeEach(async () => {
  repo = await makeTempGitRepo()
  scratch = makeScratch()
})

afterEach(async () => {
  await repo.cleanup()
  scratch.cleanup()
})

const idOf = (p: string): string => normaliseWorktreePath(p)

async function commitOn(worktreePath: string, file: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(worktreePath, file), `${message}\n`)
  const git = simpleGit(worktreePath)
  await git.add(file)
  await git.commit(message)
}

describe('inventoryWorktrees', () => {
  it('lists a created worktree (managed, on its branch) and never the main worktree', async () => {
    const info = await createWorktree(repo.path, 'feat')

    const inv = await inventoryWorktrees(repo.path)

    expect(normaliseWorktreePath(inv.repoRoot)).toBe(idOf(repo.path))
    expect(normaliseWorktreePath(inv.managedRoot)).toBe(
      idOf(path.join(repo.path, '.claude', 'worktrees'))
    )
    expect(inv.entries).toHaveLength(1)
    expect(inv.entries[0]).toMatchObject({
      id: idOf(info.worktreePath),
      name: 'feat',
      location: 'managed',
      kind: 'worktree',
      branch: 'worktree-feat',
      locked: false,
      contains: [],
      holders: []
    })
    expect(inv.entries[0].head).toMatch(/^[0-9a-f]{40}$/)
    expect(inv.entries[0].invalidReason).toBeUndefined()
  })

  it('a repo reached through a link (a symlinked project dir, macOS /tmp, an 8.3 name): its worktrees are still managed and every id is the real spelling', async () => {
    const viaLink = path.join(scratch.base, 'repo-link')
    makeLink(repo.path, viaLink)
    await createWorktree(viaLink, 'feat')
    fs.mkdirSync(path.join(viaLink, '.claude', 'worktrees', 'shell'), { recursive: true })
    const realManaged = path.join(repo.path, '.claude', 'worktrees')

    const inv = await inventoryWorktrees(viaLink)

    // git lists a worktree by its real path: the repo root and the managed root must be spelled
    // the same way or no registered worktree is ever found under the managed root.
    expect(idOf(inv.repoRoot)).toBe(idOf(repo.path))
    expect(idOf(inv.managedRoot)).toBe(idOf(realManaged))
    expect(inv.entries.map((e) => [e.name, e.location, e.kind, e.id]).sort()).toEqual([
      ['feat', 'managed', 'worktree', idOf(path.join(realManaged, 'feat'))],
      ['shell', 'managed', 'orphan', idOf(path.join(realManaged, 'shell'))]
    ])
  })

  it('reports a detached worktree with no branch, a locked one with its reason', async () => {
    const detached = path.join(repo.path, '.claude', 'worktrees', 'det')
    await addWorktreeAt(repo, detached)
    const locked = await createWorktree(repo.path, 'held')
    await repo.git.raw(['worktree', 'lock', '--reason', 'on a usb stick', locked.worktreePath])

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries.find((e) => e.name === 'det')).toMatchObject({
      branch: null,
      kind: 'worktree'
    })
    expect(inv.entries.find((e) => e.name === 'held')).toMatchObject({
      locked: true,
      lockReason: 'on a usb stick'
    })
  })

  it('a registered worktree whose directory is gone is `missing`', async () => {
    const info = await createWorktree(repo.path, 'gone')
    fs.rmSync(info.worktreePath, { recursive: true, force: true })

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries[0]).toMatchObject({ name: 'gone', kind: 'missing', branch: 'worktree-gone' })
  })

  it('lists a directory under the managed root that git does not know as an `orphan` (a shell of links, or files)', async () => {
    const managed = path.join(repo.path, '.claude', 'worktrees')
    makeLink(scratch.sentinel, path.join(managed, 'shell', 'node_modules'))
    fs.mkdirSync(path.join(managed, 'with-files'), { recursive: true })
    fs.writeFileSync(path.join(managed, 'with-files', 'work.txt'), 'unsaved')
    fs.writeFileSync(path.join(managed, 'stray-file.txt'), 'not a directory')

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries.map((e) => [e.name, e.kind]).sort()).toEqual([
      ['shell', 'orphan'],
      ['with-files', 'orphan']
    ])
    expect(inv.entries[0]).toMatchObject({ location: 'managed', branch: null, head: null })
  })

  it('lists worktrees registered OUTSIDE the repo with their layout, and they verify (removable)', async () => {
    const foreign = path.join(scratch.base, '.codex', 'worktrees', 'ab12', 'myrepo')
    const opencode = path.join(scratch.base, 'share', 'opencode', 'worktree', 'abcdef', 'brave-fox')
    const other = path.join(scratch.base, 'elsewhere', 'wt')
    await addWorktreeAt(repo, foreign)
    await addWorktreeAt(repo, opencode)
    await addWorktreeAt(repo, other)

    const inv = await inventoryWorktrees(repo.path)

    const byId = new Map(inv.entries.map((e) => [e.id, e]))
    // A layout ClaudeUI used to name (the removed Codex engine's) is now just another outside directory.
    expect(byId.get(idOf(foreign))).toMatchObject({ location: 'other', kind: 'worktree' })
    expect(byId.get(idOf(opencode))).toMatchObject({ location: 'opencode', name: 'brave-fox' })
    expect(byId.get(idOf(other))).toMatchObject({ location: 'other', name: 'wt' })
    for (const e of inv.entries) expect(e.invalidReason).toBeUndefined()
  })

  it('never lists an unregistered directory outside the managed root', async () => {
    const stray = path.join(scratch.base, 'stray-dir')
    fs.mkdirSync(stray)
    fs.mkdirSync(path.join(repo.path, 'not-a-worktree'))

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries).toEqual([])
  })

  it('answers the same for a cwd that is a worktree and for one that was deleted', async () => {
    const info = await createWorktree(repo.path, 'where')
    const fromRoot = await inventoryWorktrees(repo.path)

    const fromWorktree = await inventoryWorktrees(info.worktreePath)
    fs.rmSync(info.worktreePath, { recursive: true, force: true })
    const fromDeleted = await inventoryWorktrees(path.join(info.worktreePath, 'src'))

    expect(normaliseWorktreePath(fromWorktree.repoRoot)).toBe(idOf(repo.path))
    expect(fromWorktree.entries.map((e) => e.id)).toEqual(fromRoot.entries.map((e) => e.id))
    expect(normaliseWorktreePath(fromDeleted.repoRoot)).toBe(idOf(repo.path))
    expect(fromDeleted.entries[0].kind).toBe('missing')
  })

  it('createWorktree drops a cached "not a worktree" answer for its path, so the marker shows at once', async () => {
    const future = path.join(repo.path, '.claude', 'worktrees', 'fresh-marker')
    expect(linkedWorktreeOf(future)).toBeNull() // cached as a miss for 30 s

    const info = await createWorktree(repo.path, 'fresh-marker')

    expect(linkedWorktreeOf(info.worktreePath)).toMatchObject({
      worktreePath: expect.any(String),
      branch: 'worktree-fresh-marker'
    })
  })

  it('createWorktree from inside a worktree makes a sibling in the MAIN repo, not a nested one', async () => {
    const first = await createWorktree(repo.path, 'outer')

    const second = await createWorktree(first.worktreePath, 'sibling')

    expect(idOf(second.worktreePath)).toBe(
      idOf(path.join(repo.path, '.claude', 'worktrees', 'sibling'))
    )
    expect(second.origin).toBe('created')
  })

  it('flags an entry that contains other entries', async () => {
    const outer = await createWorktree(repo.path, 'outer')
    const inner = path.join(outer.worktreePath, 'nested-wt')
    await addWorktreeAt(repo, inner)

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries.find((e) => e.name === 'outer')?.contains).toEqual([idOf(inner)])
    expect(inv.entries.find((e) => e.id === idOf(inner))?.contains).toEqual([])
  })

  it('fills holders from the injected sources by path containment, live and not', async () => {
    const info = await createWorktree(repo.path, 'busy')
    const sources: HolderSources = {
      sessions: () => [
        {
          id: 's1',
          engine: 'claude',
          title: 'Refactor',
          live: true,
          cwds: [path.join(info.worktreePath, 'src')]
        },
        { id: 'cold', engine: 'pi', live: false, cwds: [info.worktreePath] },
        { id: 'elsewhere', engine: 'claude', live: true, cwds: [repo.path] }
      ],
      xAgents: () => [],
      terminals: () => [{ id: 'pty1', cwd: info.worktreePath }]
    }

    const inv = await inventoryWorktrees(repo.path, sources)

    const holders = inv.entries[0].holders
    expect(holders.map((h) => [h.kind, h.id, h.live]).sort()).toEqual([
      ['session', 'cold', false],
      ['session', 's1', true],
      ['terminal', 'pty1', true]
    ])
    expect(holders.find((h) => h.id === 's1')?.label).toBe('Refactor')
  })
})

describe('inventoryWorktrees: what is never trusted', () => {
  it('BACKLINK: a hand-edited .git/worktrees/<id>/gitdir cannot make an arbitrary directory removable', async () => {
    const real = await createWorktree(repo.path, 'real')
    const victim = path.join(scratch.base, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'important.txt'), 'mine')
    const admin = path.join(repo.path, '.git', 'worktrees', 'real')
    // git writes forward slashes, and strips a literal "/.git" when listing.
    const forged = path.join(victim, '.git').replace(/\\/g, '/')
    fs.writeFileSync(path.join(admin, 'gitdir'), `${forged}\n`)

    const inv = await inventoryWorktrees(repo.path)

    const entry = inv.entries.find((e) => e.id === idOf(victim))
    expect(entry?.kind).toBe('worktree')
    expect(entry?.invalidReason).toMatch(/not verifiably a worktree of this repo/)
    expect(real.worktreePath).toBeTruthy()
  })

  it('BACKLINK: a directory whose own .git points at another worktree’s admin dir is invalid', async () => {
    const a = path.join(scratch.base, 'a')
    const b = path.join(scratch.base, 'b')
    await addWorktreeAt(repo, a)
    await addWorktreeAt(repo, b)
    // b claims to be a's checkout: forward pointer is valid for a, the back pointer is not b.
    const adminOf = (name: string): string => path.join(repo.path, '.git', 'worktrees', name)
    fs.rmSync(path.join(b, '.git'))
    fs.writeFileSync(path.join(b, '.git'), `gitdir: ${adminOf('a')}\n`)

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries.find((e) => e.id === idOf(b))?.invalidReason).toMatch(
      /registration points elsewhere/
    )
    expect(inv.entries.find((e) => e.id === idOf(a))?.invalidReason).toBeUndefined()
  })

  it('an out-of-repo worktree that lost its .git file is invalid, a managed one is still a removable shell', async () => {
    const outside = path.join(scratch.base, 'outside-wt')
    await addWorktreeAt(repo, outside)
    const managed = await createWorktree(repo.path, 'managed-shell')
    fs.rmSync(path.join(outside, '.git'))
    fs.rmSync(path.join(managed.worktreePath, '.git'))

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries.find((e) => e.id === idOf(outside))?.invalidReason).toMatch(/no .git file/)
    expect(inv.entries.find((e) => e.name === 'managed-shell')?.invalidReason).toBeUndefined()
  })

  it('a clone under the managed root is an orphan marked invalid (a repository, not a worktree)', async () => {
    const managed = path.join(repo.path, '.claude', 'worktrees')
    fs.mkdirSync(path.join(managed, 'clone', '.git'), { recursive: true })

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries[0]).toMatchObject({ name: 'clone', kind: 'orphan' })
    expect(inv.entries[0].invalidReason).toMatch(/git repository/)
  })

  it('an orphan whose .git file points at another repository is invalid', async () => {
    const other = await makeTempGitRepo()
    try {
      const managed = path.join(repo.path, '.claude', 'worktrees', 'foreign')
      await addWorktreeAt(other, managed)

      const inv = await inventoryWorktrees(repo.path)

      expect(inv.entries.find((e) => e.name === 'foreign')?.invalidReason).toMatch(
        /another repository/
      )
    } finally {
      await other.cleanup()
    }
  })

  it('does not scan for orphans when .claude/worktrees is a link', async () => {
    const elsewhere = path.join(scratch.base, 'elsewhere-managed')
    fs.mkdirSync(path.join(elsewhere, 'looks-like-an-orphan'), { recursive: true })
    makeLink(elsewhere, path.join(repo.path, '.claude', 'worktrees'))

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries).toEqual([])
  })

  it('does not scan for orphans when .claude is a link', async () => {
    const elsewhere = path.join(scratch.base, 'elsewhere-claude')
    fs.mkdirSync(path.join(elsewhere, 'worktrees', 'looks-like-an-orphan'), { recursive: true })
    makeLink(elsewhere, path.join(repo.path, '.claude'))

    const inv = await inventoryWorktrees(repo.path)

    expect(inv.entries).toEqual([])
  })
})

describe('inspectWorktree: what removal would lose (D3, C-B5)', () => {
  it('counts changed files with a sample, and files git ignores separately', async () => {
    const info = await createWorktree(repo.path, 'dirty')
    fs.writeFileSync(path.join(info.worktreePath, 'README.md'), 'changed\n')
    fs.writeFileSync(path.join(info.worktreePath, 'new.txt'), 'new\n')
    fs.writeFileSync(path.join(info.worktreePath, '.gitignore'), 'ignored.log\n')
    fs.writeFileSync(path.join(info.worktreePath, 'ignored.log'), 'x')

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    // README.md modified, new.txt and .gitignore untracked
    expect(res.uncommittedFiles).toBe(3)
    expect(res.uncommittedSample.sort()).toEqual(['.gitignore', 'README.md', 'new.txt'])
    expect(res.ignoredEntries).toBe(1)
    expect(res.uniqueCommits).toBe(0)
  })

  it('N8: untracked LINKS (an agent’s node_modules / vendor junctions) are not changes; real files beside them are', async () => {
    const info = await createWorktree(repo.path, 'links')
    makeLink(scratch.sentinel, path.join(info.worktreePath, 'node_modules'))
    makeLink(scratch.sentinel, path.join(info.worktreePath, 'vendor', 'x'))

    const clean = await inspectWorktree(repo.path, idOf(info.worktreePath))
    expect(clean.uncommittedFiles).toBe(0)
    expect(clean.uncommittedSample).toEqual([])
    const cleanStatus = await getWorktreeStatus(info.worktreePath, info.originalHeadCommit)
    expect(cleanStatus.uncommittedFiles).toBe(0)

    fs.writeFileSync(path.join(info.worktreePath, 'real.txt'), 'x')
    const dirty = await inspectWorktree(repo.path, idOf(info.worktreePath))
    expect(dirty.uncommittedSample).toEqual(['real.txt'])
    expect(scratch.sentinelIntact()).toBe(true)
  })

  it('N-b: an untracked directory is judged by its first real file, not by walking all of it', async () => {
    const info = await createWorktree(repo.path, 'wide-untracked')
    const wide = path.join(info.worktreePath, 'scratch-output')
    fs.mkdirSync(wide)
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(wide, `f${i}.txt`), 'x')
    const real = fs.promises.lstat
    const seen: string[] = []
    const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation(((p: fs.PathLike) => {
      seen.push(String(p))
      return real(p)
    }) as typeof fs.promises.lstat)

    try {
      const status = await getWorktreeStatus(info.worktreePath, info.originalHeadCommit)

      expect(status.uncommittedFiles).toBe(1) // the directory, as git reports it
      // The 16-wide walker finishes what is in flight; it must not stat all 400.
      expect(seen.filter((p) => p.includes('scratch-output')).length).toBeLessThan(100)
    } finally {
      spy.mockRestore()
    }
  })

  it('a staged rename is one change; names with spaces and non-ASCII come through unquoted', async () => {
    const info = await createWorktree(repo.path, 'rename')
    const git = simpleGit(info.worktreePath)
    await git.raw(['mv', 'README.md', 'LIESMICH.md'])
    fs.writeFileSync(path.join(info.worktreePath, 'sp ace é.txt'), 'x')

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res.uncommittedFiles).toBe(2)
    expect(res.uncommittedSample.sort()).toEqual(['LIESMICH.md', 'sp ace é.txt'])
  })

  it('a commit only on the worktree’s branch counts, with its subject', async () => {
    const info = await createWorktree(repo.path, 'ahead')
    await commitOn(info.worktreePath, 'a.txt', 'only here')

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res.uniqueCommits).toBe(1)
    expect(res.uniqueCommitSample).toEqual([
      { sha: expect.stringMatching(/^[0-9a-f]{40}$/), subject: 'only here' }
    ])
  })

  it('a branch whose commits are all in another branch counts 0', async () => {
    const info = await createWorktree(repo.path, 'merged')
    await commitOn(info.worktreePath, 'a.txt', 'shared')
    await repo.git.raw(['branch', 'keeps-it', info.worktreeBranch])

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res.uniqueCommits).toBe(0)
  })

  it('--exclude keeps the branch itself out of --branches: without it every branch would count 0', async () => {
    const info = await createWorktree(repo.path, 'self')
    await commitOn(info.worktreePath, 'a.txt', 'one')
    await commitOn(info.worktreePath, 'b.txt', 'two')

    expect((await inspectWorktree(repo.path, idOf(info.worktreePath))).uniqueCommits).toBe(2)
  })

  it('a tag named like the branch does not shadow it (refs/heads/<b> is the positive ref)', async () => {
    const info = await createWorktree(repo.path, 'tagged')
    await commitOn(info.worktreePath, 'a.txt', 'unique')
    await repo.git.raw(['tag', info.worktreeBranch, 'main'])

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res.uniqueCommits).toBe(1)
  })

  it('a branch pushed to a remote-tracking ref counts 0; a repo with no remote works at all', async () => {
    const info = await createWorktree(repo.path, 'pushed')
    await commitOn(info.worktreePath, 'a.txt', 'pushed commit')
    expect((await inspectWorktree(repo.path, idOf(info.worktreePath))).uniqueCommits).toBe(1)

    const remote = await makeBareRemoteRepo()
    try {
      await repo.git.raw(['remote', 'add', 'origin', remote.path])
      await repo.git.raw(['push', 'origin', info.worktreeBranch])

      expect((await inspectWorktree(repo.path, idOf(info.worktreePath))).uniqueCommits).toBe(0)
    } finally {
      await remote.cleanup()
    }
  })

  it('a detached HEAD counts commits reachable from no ref, and 0 once a branch holds them', async () => {
    const detached = path.join(scratch.base, 'det')
    await addWorktreeAt(repo, detached)
    await commitOn(detached, 'a.txt', 'dangling')

    expect((await inspectWorktree(repo.path, idOf(detached))).uniqueCommits).toBe(1)

    const head = (await simpleGit(detached).raw(['rev-parse', 'HEAD'])).trim()
    await repo.git.raw(['branch', 'rescued', head])
    expect((await inspectWorktree(repo.path, idOf(detached))).uniqueCommits).toBe(0)
  })

  it('a missing worktree still reports the commits only its branch holds', async () => {
    const info = await createWorktree(repo.path, 'lost')
    await commitOn(info.worktreePath, 'a.txt', 'keep me')
    fs.rmSync(info.worktreePath, { recursive: true, force: true })

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res).toMatchObject({ uncommittedFiles: 0, uniqueCommits: 1 })
  })

  it('an orphan: any file that is not a link is dirty, a shell of links is clean', async () => {
    const managed = path.join(repo.path, '.claude', 'worktrees')
    makeLink(scratch.sentinel, path.join(managed, 'shell', 'node_modules'))
    fs.mkdirSync(path.join(managed, 'work'), { recursive: true })
    fs.writeFileSync(path.join(managed, 'work', 'a.txt'), 'a')
    fs.writeFileSync(path.join(managed, 'work', 'b.txt'), 'b')

    const shell = await inspectWorktree(repo.path, idOf(path.join(managed, 'shell')))
    const work = await inspectWorktree(repo.path, idOf(path.join(managed, 'work')))

    expect(shell).toMatchObject({ uncommittedFiles: 0, uncommittedSample: [], uniqueCommits: 0 })
    expect(work).toMatchObject({ uncommittedFiles: 2, uncommittedSample: ['a.txt', 'b.txt'] })
  })

  it('a registered managed shell with no .git is judged by its files, never by the repo above it', async () => {
    const info = await createWorktree(repo.path, 'shelled')
    fs.rmSync(path.join(info.worktreePath, '.git'))
    // The main repo is dirty; if git ran in the shell it would report THAT.
    fs.writeFileSync(path.join(repo.path, 'main-only.txt'), 'x')

    const res = await inspectWorktree(repo.path, idOf(info.worktreePath))

    expect(res.uncommittedSample).toEqual(['README.md'])
    expect(res.uncommittedSample).not.toContain('main-only.txt')
  })

  it('N4: an invalid entry is not walked: inspect answers empty, measure answers zero', async () => {
    await createWorktree(repo.path, 'real')
    const victim = path.join(scratch.base, 'victim-walk')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'important.txt'), 'mine')
    const admin = path.join(repo.path, '.git', 'worktrees', 'real')
    const forged = path.join(victim, '.git').replace(/\\/g, '/')
    fs.writeFileSync(path.join(admin, 'gitdir'), `${forged}\n`)
    const inv = await inventoryWorktrees(repo.path)
    expect(inv.entries.find((e) => e.id === idOf(victim))?.invalidReason).toBeTruthy()

    expect(await inspectWorktree(repo.path, idOf(victim))).toEqual({
      uncommittedFiles: 0,
      uncommittedSample: [],
      ignoredEntries: 0,
      uniqueCommits: 0,
      uniqueCommitSample: []
    })
    expect(await measureWorktree(repo.path, idOf(victim))).toMatchObject({ bytes: 0, files: 0 })
    expect(fs.readFileSync(path.join(victim, 'important.txt'), 'utf-8')).toBe('mine')
  })

  it('an id that is not in the inventory is an error', async () => {
    await expect(inspectWorktree(repo.path, idOf(path.join(repo.path, '..', 'x')))).rejects.toThrow(
      /not found/
    )
  })
})

describe('measureWorktree', () => {
  it('sizes the tree and does not follow a junction into the sentinel', async () => {
    const info = await createWorktree(repo.path, 'sized')
    fs.writeFileSync(path.join(scratch.sentinel, 'big.bin'), 'z'.repeat(50_000))
    makeLink(scratch.sentinel, path.join(info.worktreePath, 'node_modules'))

    const size = await measureWorktree(repo.path, idOf(info.worktreePath))

    expect(size.links).toBe(1)
    expect(size.files).toBeGreaterThan(0)
    expect(size.bytes).toBeLessThan(50_000)
    expect(size.newestMtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('a missing worktree measures zero', async () => {
    const info = await createWorktree(repo.path, 'nothing')
    fs.rmSync(info.worktreePath, { recursive: true, force: true })

    expect(await measureWorktree(repo.path, idOf(info.worktreePath))).toMatchObject({
      bytes: 0,
      files: 0
    })
  })
})

describe('getWorktreeStatus', () => {
  it('reports the branch and the commits found nowhere else', async () => {
    const info = await createWorktree(repo.path, 'status')
    await commitOn(info.worktreePath, 'a.txt', 'one')

    const status = await getWorktreeStatus(info.worktreePath, info.originalHeadCommit)

    expect(status.branch).toBe('worktree-status')
    expect(status.uniqueCommits).toBe(1)
    expect(status.commitsAhead).toBe(1)
  })

  it('a detached worktree has a null branch', async () => {
    const detached = path.join(scratch.base, 'det-status')
    await addWorktreeAt(repo, detached)

    const status = await getWorktreeStatus(detached, '')

    expect(status.branch).toBeNull()
    expect(status.uniqueCommits).toBe(0)
  })
})
