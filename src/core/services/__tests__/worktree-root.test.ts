/**
 * @vitest-environment node
 *
 * Repo and linked-worktree discovery from the filesystem alone. The repos here are FABRICATED
 * (a `.git` directory plus the handful of files git keeps under `worktrees/<id>`), so no git is
 * spawned; the git-backed tests check the same shapes against what real git writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  classifyWorktreeLocation,
  forgetLinkedWorktrees,
  isRealChildOf,
  linkedWorktreeOf,
  locateGit,
  normaliseWorktreePath,
  pathEqualOrInside,
  realOrResolved,
  resolveRepoRoot,
  samePath
} from '../worktree-root'

let base: string

const write = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** A main checkout with a `.git` directory. */
function makeRepo(root: string): string {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

/** Register a linked worktree the way git lays it out; returns the admin dir. */
function addWorktree(
  root: string,
  wtPath: string,
  id: string,
  opts: { head?: string; relative?: boolean } = {}
): string {
  const common = path.join(root, '.git')
  const admin = path.join(common, 'worktrees', id)
  write(path.join(admin, 'commondir'), opts.relative ? '../..\n' : `${common}\n`)
  write(path.join(admin, 'gitdir'), `${path.join(wtPath, '.git')}\n`)
  write(path.join(admin, 'HEAD'), opts.head ?? 'ref: refs/heads/feature/x\n')
  const pointer = opts.relative ? path.relative(wtPath, admin) : admin
  write(path.join(wtPath, '.git'), `gitdir: ${pointer}\n`)
  return admin
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-wtroot-'))
  forgetLinkedWorktrees()
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

describe('normaliseWorktreePath', () => {
  it('win32: forward slashes, lower case, no trailing separator, no namespace prefix', () => {
    expect(normaliseWorktreePath('C:\\Users\\Me\\Repo\\', 'win32')).toBe('c:/users/me/repo')
    expect(normaliseWorktreePath('c:/Users/Me/Repo', 'win32')).toBe('c:/users/me/repo')
    expect(normaliseWorktreePath('\\\\?\\C:\\Users\\Me', 'win32')).toBe('c:/users/me')
    expect(normaliseWorktreePath('C:\\', 'win32')).toBe('c:/')
  })

  it('posix: case is significant, trailing slashes go, a backslash is just a character', () => {
    expect(normaliseWorktreePath('/Home/Me/Repo//', 'linux')).toBe('/Home/Me/Repo')
    expect(normaliseWorktreePath('/Home/Me/a\\b', 'linux')).toBe('/Home/Me/a\\b')
    expect(normaliseWorktreePath('/', 'linux')).toBe('/')
  })
})

describe('pathEqualOrInside', () => {
  it('is true for the directory itself and anything below, false for a sibling sharing a prefix', () => {
    const root = path.join(base, 'a', 'b')
    expect(pathEqualOrInside(root, root)).toBe(true)
    expect(pathEqualOrInside(root, path.join(root, 'c', 'd'))).toBe(true)
    expect(pathEqualOrInside(root, path.join(base, 'a', 'bfoo'))).toBe(false)
    expect(pathEqualOrInside(root, path.join(base, 'a'))).toBe(false)
  })
})

describe('locateGit / resolveRepoRoot (C-S4)', () => {
  it('a main checkout is its own root, from any subdirectory', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })

    expect(resolveRepoRoot(path.join(repo, 'src', 'deep'))).toBe(repo)
    expect(locateGit(repo)?.adminDir).toBeNull()
  })

  it('a linked worktree resolves to the MAIN root, not to itself (absolute and relative pointers)', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const abs = path.join(repo, '.claude', 'worktrees', 'abs')
    const rel = path.join(repo, '.claude', 'worktrees', 'rel')
    addWorktree(repo, abs, 'abs')
    addWorktree(repo, rel, 'rel', { relative: true })

    expect(resolveRepoRoot(abs)).toBe(repo)
    expect(resolveRepoRoot(path.join(abs, 'sub'))).toBe(repo)
    expect(resolveRepoRoot(rel)).toBe(repo)
  })

  it('a deleted worktree path resolves through its nearest existing ancestor', () => {
    const repo = makeRepo(path.join(base, 'repo'))

    expect(resolveRepoRoot(path.join(repo, '.claude', 'worktrees', 'gone', 'sub'))).toBe(repo)
  })

  it('a worktree outside the repo still resolves to the main root', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const wt = path.join(base, 'elsewhere', 'worktrees', 'ab12', 'repo')
    addWorktree(repo, wt, 'repo')

    expect(resolveRepoRoot(wt)).toBe(repo)
  })

  it('a submodule is its own root, never the superproject (its .git is a file under modules/)', () => {
    const super_ = makeRepo(path.join(base, 'super'))
    const modules = path.join(super_, '.git', 'modules', 'child')
    fs.mkdirSync(modules, { recursive: true })
    const child = path.join(super_, 'child')
    write(path.join(child, '.git'), 'gitdir: ../.git/modules/child\n')

    expect(resolveRepoRoot(child)).toBe(child)
    expect(resolveRepoRoot(path.join(child, 'src'))).toBe(child)
    expect(linkedWorktreeOf(child)).toBeNull()
  })

  it('a worktree of a submodule has no determinable root (the common dir is not a .git)', () => {
    const super_ = makeRepo(path.join(base, 'super'))
    const common = path.join(super_, '.git', 'modules', 'child')
    const admin = path.join(common, 'worktrees', 'w')
    const wt = path.join(base, 'wt')
    write(path.join(admin, 'commondir'), '../..\n')
    write(path.join(admin, 'HEAD'), 'ref: refs/heads/x\n')
    write(path.join(wt, '.git'), `gitdir: ${admin}\n`)

    expect(resolveRepoRoot(wt)).toBeNull()
    expect(linkedWorktreeOf(wt)).toBeNull()
  })

  it('a .git that is a link ends the search: nothing is read through it', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const decoy = path.join(base, 'decoy')
    fs.mkdirSync(decoy)
    try {
      fs.symlinkSync(path.join(repo, '.git'), path.join(decoy, '.git'), 'junction')
    } catch {
      return // links not creatable here
    }

    expect(locateGit(decoy)).toBeNull()
  })

  it('a .git file whose commondir does not lead back to the repo is not trusted', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const wt = path.join(base, 'wt')
    const admin = addWorktree(repo, wt, 'w')
    write(path.join(admin, 'commondir'), `${path.join(base, 'elsewhere', '.git')}\n`)

    expect(locateGit(wt)).toBeNull()
  })

  it('a path with no repository above it has no root', () => {
    expect(resolveRepoRoot(path.join(base, 'nothing', 'here'))).toBeNull()
  })
})

describe('linkedWorktreeOf (3c)', () => {
  it('describes a managed worktree from any directory inside it, branch from HEAD', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const wt = path.join(repo, '.claude', 'worktrees', 'feat')
    addWorktree(repo, wt, 'feat')
    fs.mkdirSync(path.join(wt, 'packages', 'app'), { recursive: true })

    const found = linkedWorktreeOf(path.join(wt, 'packages', 'app'))

    expect(found).toEqual({ worktreePath: wt, repoRoot: repo, name: 'feat', branch: 'feature/x' })
  })

  it('a detached HEAD gives an empty branch', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const wt = path.join(base, 'detached')
    addWorktree(repo, wt, 'detached', { head: 'a'.repeat(40) + '\n' })

    expect(linkedWorktreeOf(wt)?.branch).toBe('')
  })

  it('names an opencode worktree by its slug, and any other out-of-tree one by its last segment', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const other = path.join(base, '.codex', 'worktrees', 'ab12', 'repo')
    const opencode = path.join(base, 'data', 'worktree', 'abcdef', 'brave-fox')
    addWorktree(repo, other, 'other')
    addWorktree(repo, opencode, 'opencode')

    // Codex's layout (a build that no longer ships Codex) is just another out-of-tree directory.
    expect(linkedWorktreeOf(other)?.name).toBe('repo')
    expect(linkedWorktreeOf(opencode)?.name).toBe('brave-fox')
  })

  it('is null for a main checkout and for a plain directory', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    fs.mkdirSync(path.join(base, 'plain'))

    expect(linkedWorktreeOf(repo)).toBeNull()
    expect(linkedWorktreeOf(path.join(base, 'plain'))).toBeNull()
  })

  it('revalidates a cached hit: a worktree whose .git is gone stops answering without a forget', () => {
    const repo = makeRepo(path.join(base, 'repo'))
    const wt = path.join(base, 'wt')
    addWorktree(repo, wt, 'w')
    expect(linkedWorktreeOf(wt)).not.toBeNull()

    fs.rmSync(path.join(wt, '.git'))
    expect(linkedWorktreeOf(wt)).toBeNull()
  })
})

describe('classifyWorktreeLocation', () => {
  const managedRoot = path.join(os.tmpdir(), 'repo', '.claude', 'worktrees')

  it('tells the layouts apart', () => {
    expect(classifyWorktreeLocation(path.join(managedRoot, 'feat'), managedRoot)).toEqual({
      location: 'managed',
      name: 'feat'
    })
    expect(
      classifyWorktreeLocation(
        path.join(os.tmpdir(), '.codex', 'worktrees', 'AB12', 'repo'),
        managedRoot
      )
    ).toEqual({ location: 'other', name: 'repo' })
    expect(
      classifyWorktreeLocation(
        path.join(os.tmpdir(), 'share', 'worktree', 'a1b2c3', 'slug'),
        managedRoot
      )
    ).toEqual({ location: 'opencode', name: 'slug' })
    expect(
      classifyWorktreeLocation(path.join(os.tmpdir(), 'elsewhere', 'wt'), managedRoot)
    ).toEqual({
      location: 'other',
      name: 'wt'
    })
  })

  it('B1: a path that is inside the managed root only through a link is not `managed`', () => {
    const managed = path.join(base, 'repo', '.claude', 'worktrees')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true })
    fs.mkdirSync(managed, { recursive: true })
    try {
      fs.symlinkSync(outside, path.join(managed, 'lnk'), 'junction')
    } catch {
      return
    }

    expect(classifyWorktreeLocation(path.join(managed, 'lnk', 'victim'), managed).location).toBe(
      'other'
    )
    // The link's own path is still under the root, and a plain child still is managed.
    fs.mkdirSync(path.join(managed, 'real'))
    expect(classifyWorktreeLocation(path.join(managed, 'real'), managed).location).toBe('managed')
    // A path that does not exist yet is judged the same way, through the link in the middle.
    expect(classifyWorktreeLocation(path.join(managed, 'lnk', 'not-yet'), managed).location).toBe(
      'other'
    )
  })
})

describe('samePath', () => {
  it('sees through a junction', () => {
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    try {
      fs.symlinkSync(real, path.join(base, 'alias'), 'junction')
    } catch {
      return
    }

    expect(samePath(real, path.join(base, 'alias'))).toBe(true)
    expect(samePath(real, path.join(base, 'other'))).toBe(false)
  })
})

describe('realOrResolved / isRealChildOf', () => {
  it('canonicalises the existing part of a path that does not exist yet (a link in the middle shows through)', () => {
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    try {
      fs.symlinkSync(real, path.join(base, 'alias'), 'junction')
    } catch {
      return
    }

    expect(normaliseWorktreePath(realOrResolved(path.join(base, 'alias', 'a', 'b')))).toBe(
      normaliseWorktreePath(path.join(realOrResolved(real), 'a', 'b'))
    )
  })

  it('B1: a direct child by canonical path, not one reached through a link', () => {
    const managed = path.join(base, 'managed')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(managed, 'kid'), { recursive: true })
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true })
    try {
      fs.symlinkSync(outside, path.join(managed, 'lnk'), 'junction')
    } catch {
      return
    }

    expect(isRealChildOf(managed, path.join(managed, 'kid'))).toBe(true)
    expect(isRealChildOf(managed, path.join(managed, 'lnk', 'victim'))).toBe(false)
    expect(isRealChildOf(managed, path.join(managed, 'kid', 'deeper'))).toBe(false)
  })
})
