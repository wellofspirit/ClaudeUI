/**
 * @vitest-environment node
 *
 * The no-follow walker behind worktree removal and sizing. Every test builds its own temp tree
 * (and a sentinel directory beside it that a link points at); nothing outside os.tmpdir() is
 * ever named. The point of most of them: a junction or symlink inside the tree is unlinked or
 * counted ITSELF and its target is never entered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { listTreeFiles, measureTree, removeTreeLinkSafe, type TreeFs } from '../worktree-fs'

let base: string
let tree: string
let sentinel: string

const write = (p: string, content = 'x'): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const link = (target: string, at: string): void => {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at, 'junction')
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-wtfs-'))
  tree = path.join(base, 'tree')
  sentinel = path.join(base, 'sentinel')
  write(path.join(sentinel, 'keep.txt'), 'precious')
  write(path.join(sentinel, 'sub', 'deep.txt'), 'precious too')
  fs.mkdirSync(tree)
})

afterEach(() => {
  // `base` holds only what this test made; the links in it point inside it.
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

const sentinelIntact = (): boolean =>
  fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf-8') === 'precious' &&
  fs.readFileSync(path.join(sentinel, 'sub', 'deep.txt'), 'utf-8') === 'precious too'

describe('removeTreeLinkSafe', () => {
  it('removes a nested tree completely', async () => {
    write(path.join(tree, 'a.txt'))
    write(path.join(tree, 'src', 'b', 'c.txt'))
    fs.mkdirSync(path.join(tree, 'empty'))

    const res = await removeTreeLinkSafe(tree)

    expect(res).toEqual({ removed: true, failures: [] })
    expect(fs.existsSync(tree)).toBe(false)
  })

  it('unlinks a junction inside the tree and never enters its target', async () => {
    write(path.join(tree, 'a.txt'))
    link(sentinel, path.join(tree, 'node_modules'))

    const res = await removeTreeLinkSafe(tree)

    expect(res.removed).toBe(true)
    expect(res.failures).toEqual([])
    expect(fs.existsSync(tree)).toBe(false)
    expect(sentinelIntact()).toBe(true)
  })

  it('handles a nested junction (vendor/x), a symlinked file and a dangling link', async () => {
    link(sentinel, path.join(tree, 'vendor', 'x'))
    write(path.join(base, 'outside.txt'), 'outside')
    // File symlinks need a privilege on Windows; a dangling link may not be creatable either.
    for (const make of [
      () => fs.symlinkSync(path.join(base, 'outside.txt'), path.join(tree, 'file-link'), 'file'),
      () => link(path.join(base, 'does-not-exist'), path.join(tree, 'dangling'))
    ]) {
      try {
        make()
      } catch {
        // not creatable here
      }
    }

    const res = await removeTreeLinkSafe(tree)

    expect(res.removed).toBe(true)
    expect(fs.existsSync(tree)).toBe(false)
    expect(sentinelIntact()).toBe(true)
    expect(fs.readFileSync(path.join(base, 'outside.txt'), 'utf-8')).toBe('outside')
  })

  it('Windows: a directory link that unlink refuses is removed with rmdir instead (never entered)', async () => {
    const linkPath = path.join(tree, 'node_modules')
    link(sentinel, linkPath)
    const real = await import('node:fs/promises')
    const rmdirs: string[] = []

    const res = await removeTreeLinkSafe(tree, {
      fs: {
        unlink: async (p) => {
          if (p === linkPath) throw Object.assign(new Error('is a directory'), { code: 'EPERM' })
          return real.unlink(p)
        },
        rmdir: async (p) => {
          rmdirs.push(p)
          // POSIX would answer ENOTDIR for a symlink; the stand-in only has to prove the call.
          if (p === linkPath) return real.unlink(p)
          return real.rmdir(p)
        }
      }
    })

    expect(rmdirs).toContain(linkPath)
    expect(res).toEqual({ removed: true, failures: [] })
    expect(sentinelIntact()).toBe(true)
  })

  it('lstats the ROOT: a link root is unlinked, its target left whole', async () => {
    const rootLink = path.join(base, 'root-link')
    link(sentinel, rootLink)

    const res = await removeTreeLinkSafe(rootLink)

    expect(res).toEqual({ removed: true, failures: [] })
    expect(fs.existsSync(rootLink)).toBe(false)
    expect(sentinelIntact()).toBe(true)
  })

  it('treats a missing root as already removed', async () => {
    expect(await removeTreeLinkSafe(path.join(base, 'nope'))).toEqual({
      removed: true,
      failures: []
    })
  })

  it('deletes a path longer than 300 characters', async () => {
    let deep = tree
    while (deep.length < 320) deep = path.join(deep, 'segment-of-fifty-characters-'.padEnd(50, 'x'))
    expect(deep.length).toBeGreaterThan(300)
    write(path.join(deep, 'leaf.txt'))

    const res = await removeTreeLinkSafe(tree)

    expect(res).toEqual({ removed: true, failures: [] })
    expect(fs.existsSync(tree)).toBe(false)
  })

  it('removes a read-only file', async () => {
    const ro = path.join(tree, 'objects', 'pack.idx')
    write(ro)
    fs.chmodSync(ro, 0o444)

    const res = await removeTreeLinkSafe(tree)

    expect(res).toEqual({ removed: true, failures: [] })
  })

  it('on EPERM for a file, chmods it 0o666 and retries once', async () => {
    const ro = path.join(tree, 'pack.idx')
    write(ro)
    const chmods: Array<[string, number]> = []
    let denied = 0
    const real = await import('node:fs/promises')
    const res = await removeTreeLinkSafe(tree, {
      fs: {
        unlink: async (p) => {
          if (p === ro && denied++ === 0)
            throw Object.assign(new Error('read-only'), { code: 'EPERM' })
          return real.unlink(p)
        },
        chmod: async (p, mode) => {
          chmods.push([p, mode])
          return real.chmod(p, mode)
        }
      }
    })

    expect(chmods).toEqual([[ro, 0o666]])
    expect(denied).toBe(2)
    expect(res).toEqual({ removed: true, failures: [] })
  })

  it('records a locked file as a failure, removes the rest and leaves the directories holding it', async () => {
    const locked = path.join(tree, 'a', 'locked.txt')
    write(locked)
    write(path.join(tree, 'a', 'free.txt'))
    write(path.join(tree, 'b', 'free.txt'))
    const real = await import('node:fs/promises')

    const res = await removeTreeLinkSafe(tree, {
      fs: {
        unlink: async (p) => {
          if (p === locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
          return real.unlink(p)
        }
      }
    })

    expect(res.removed).toBe(false)
    expect(res.failures).toEqual([{ path: locked, code: 'EBUSY' }])
    expect(fs.existsSync(locked)).toBe(true)
    expect(fs.existsSync(path.join(tree, 'a', 'free.txt'))).toBe(false)
    expect(fs.existsSync(path.join(tree, 'b'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'a directory that is a process cwd (EBUSY/EPERM on Windows) is a failure; a retry after release succeeds',
    async () => {
      const held = path.join(tree, 'held')
      write(path.join(held, 'inner.txt'))
      write(path.join(tree, 'free.txt'))
      let child: ChildProcess | undefined
      try {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: held,
          stdio: 'ignore'
        })
        await new Promise<void>((resolve, reject) => {
          child!.once('spawn', () => resolve())
          child!.once('error', reject)
        })

        const first = await removeTreeLinkSafe(tree)

        expect(first.removed).toBe(false)
        expect(first.failures.map((f) => f.path)).toContain(held)
        expect(fs.existsSync(path.join(tree, 'free.txt'))).toBe(false)
        expect(fs.existsSync(path.join(held, 'inner.txt'))).toBe(false)
      } finally {
        if (child) {
          // Wait for the exit itself: under load a fixed pause was shorter than the teardown.
          const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
          child.kill()
          await exited
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      const second = await removeTreeLinkSafe(tree)
      expect(second).toEqual({ removed: true, failures: [] })
    }
  )

  it('keepTopLevel leaves those names (and so the root) and still removes everything else', async () => {
    write(path.join(tree, '.git'), 'gitdir: x')
    write(path.join(tree, 'a.txt'))
    link(sentinel, path.join(tree, 'node_modules'))
    write(path.join(tree, '.github', '.git'), 'nested .git is not top level')

    const res = await removeTreeLinkSafe(tree, { keepTopLevel: ['.git'] })

    expect(res).toEqual({ removed: false, failures: [] })
    expect(fs.readdirSync(tree)).toEqual(['.git'])
    expect(sentinelIntact()).toBe(true)
  })

  it('never has more than 16 filesystem calls in flight, and does use concurrency', async () => {
    for (let i = 0; i < 120; i++) write(path.join(tree, `d${i % 6}`, `f${i}.txt`))
    const real = await import('node:fs/promises')
    let inFlight = 0
    let peak = 0
    const track =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          await new Promise((r) => setTimeout(r, 2))
          return await fn(...a)
        } finally {
          inFlight--
        }
      }
    const wrapped: Partial<TreeFs> = {
      lstat: track((p: string) => real.lstat(p)),
      readdir: track((p: string) => real.readdir(p)),
      unlink: track((p: string) => real.unlink(p)),
      rmdir: track((p: string) => real.rmdir(p))
    }

    const res = await removeTreeLinkSafe(tree, { fs: wrapped })

    expect(res.removed).toBe(true)
    expect(peak).toBeLessThanOrEqual(16)
    expect(peak).toBeGreaterThan(4)
  })

  it('reports progress, ending on the full count of entries removed', async () => {
    write(path.join(tree, 'a', 'one.txt'))
    write(path.join(tree, 'a', 'two.txt'))
    write(path.join(tree, 'three.txt'))
    const seen: number[] = []

    await removeTreeLinkSafe(tree, { onProgress: (n) => seen.push(n) })

    // 3 files + directories `a` and the root
    expect(seen.at(-1)).toBe(5)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'POSIX: EACCES deleting a child of a non-writable directory is cured by chmod u+w on the parent',
    async () => {
      const locked = path.join(tree, 'locked')
      write(path.join(locked, 'f.txt'))
      fs.chmodSync(locked, 0o555)

      const res = await removeTreeLinkSafe(tree)

      expect(res).toEqual({ removed: true, failures: [] })
    }
  )
})

/** Pretend to be on `platform` (the permission and rmdir retries branch on it); returns the undo. */
function pretendPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

describe('removeTreeLinkSafe: review hardening', () => {
  it('S2: never chmods the PARENT of the walk root, which lies outside what is being deleted', async () => {
    const restore = pretendPlatform('linux')
    try {
      const chmods: string[] = []
      const res = await removeTreeLinkSafe(tree, {
        fs: {
          rmdir: async (p) => {
            if (p === tree) throw Object.assign(new Error('denied'), { code: 'EACCES' })
          },
          chmod: async (p) => {
            chmods.push(p)
          }
        }
      })

      expect(chmods).toEqual([])
      expect(res).toEqual({ removed: false, failures: [{ path: tree, code: 'EACCES' }] })
    } finally {
      restore()
    }
  })

  it('S2 control: a directory INSIDE the walk still gets its parent made writable once', async () => {
    const restore = pretendPlatform('linux')
    try {
      write(path.join(tree, 'sub', 'f.txt'))
      const real = await import('node:fs/promises')
      const chmods: string[] = []
      let denied = 0
      const res = await removeTreeLinkSafe(tree, {
        fs: {
          rmdir: async (p) => {
            if (p === path.join(tree, 'sub') && denied++ === 0)
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            return real.rmdir(p)
          },
          chmod: async (p) => {
            chmods.push(p)
          }
        }
      })

      expect(chmods).toEqual([tree])
      expect(res).toEqual({ removed: true, failures: [] })
    } finally {
      restore()
    }
  })

  it('N6: a directory swapped for another between its lstat and its readdir is not descended into', async () => {
    write(path.join(tree, 'sub', 'inner.txt'))
    const real = await import('node:fs/promises')
    const sub = path.join(tree, 'sub')
    const unlinked: string[] = []
    let looks = 0

    const res = await removeTreeLinkSafe(tree, {
      fs: {
        lstat: async (p) => {
          const st = await real.lstat(p)
          // The second look at `sub` finds a different inode.
          if (p === sub && ++looks === 2) return Object.create(st, { ino: { value: -1 } })
          return st
        },
        unlink: async (p) => {
          unlinked.push(p)
          return real.unlink(p)
        }
      }
    })

    expect(res.removed).toBe(false)
    expect(res.failures).toEqual([{ path: sub, code: 'ECHANGED' }])
    expect(unlinked).toEqual([])
    expect(fs.existsSync(path.join(sub, 'inner.txt'))).toBe(true)
  })

  it('N7: on Windows a directory answering ENOTEMPTY/EBUSY is retried once after a short wait', async () => {
    const restore = pretendPlatform('win32')
    try {
      write(path.join(tree, 'sub', 'f.txt'))
      const real = await import('node:fs/promises')
      const sub = path.join(tree, 'sub')
      const attempts: string[] = []
      const res = await removeTreeLinkSafe(tree, {
        fs: {
          rmdir: async (p) => {
            attempts.push(p)
            if (p === sub && attempts.filter((a) => a === sub).length === 1)
              throw Object.assign(new Error('delete pending'), { code: 'ENOTEMPTY' })
            return real.rmdir(p)
          }
        }
      })

      expect(attempts.filter((a) => a === sub)).toHaveLength(2)
      expect(res).toEqual({ removed: true, failures: [] })
    } finally {
      restore()
    }
  })

  it('N7: elsewhere ENOTEMPTY is final (no retry), and on Windows a persistent one is still a failure', async () => {
    write(path.join(tree, 'sub', 'f.txt'))
    const real = await import('node:fs/promises')
    const sub = path.join(tree, 'sub')
    const stuck = (counter: string[]) => ({
      rmdir: async (p: string) => {
        counter.push(p)
        if (p === sub) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' })
        return real.rmdir(p)
      }
    })

    const posix: string[] = []
    let restore = pretendPlatform('linux')
    try {
      const res = await removeTreeLinkSafe(tree, { fs: stuck(posix) })
      expect(posix.filter((a) => a === sub)).toHaveLength(1)
      expect(res.failures).toEqual([{ path: sub, code: 'ENOTEMPTY' }])
    } finally {
      restore()
    }

    const win: string[] = []
    restore = pretendPlatform('win32')
    try {
      const res = await removeTreeLinkSafe(tree, { fs: stuck(win) })
      expect(win.filter((a) => a === sub)).toHaveLength(2)
      expect(res.failures).toEqual([{ path: sub, code: 'ENOTEMPTY' }])
    } finally {
      restore()
    }
  })
})

describe('measureTree', () => {
  it('sums regular files and counts links without following or sizing them', async () => {
    write(path.join(tree, 'a.bin'), 'x'.repeat(100))
    write(path.join(tree, 'sub', 'b.bin'), 'y'.repeat(50))
    write(path.join(sentinel, 'big.bin'), 'z'.repeat(10_000))
    link(sentinel, path.join(tree, 'node_modules'))
    link(sentinel, path.join(tree, 'vendor', 'x'))

    const m = await measureTree(tree)

    expect(m.bytes).toBe(150)
    expect(m.files).toBe(2)
    expect(m.links).toBe(2)
    expect(m.errors).toBe(0)
  })

  it('reports the newest mtime of anything in the tree', async () => {
    write(path.join(tree, 'old.txt'))
    write(path.join(tree, 'sub', 'new.txt'))
    const old = new Date('2020-01-01T00:00:00Z')
    const fresh = new Date('2031-06-15T12:00:00Z')
    fs.utimesSync(path.join(tree, 'old.txt'), old, old)
    fs.utimesSync(path.join(tree, 'sub', 'new.txt'), fresh, fresh)
    // Directories were touched when their entries were made; push them back so the file wins.
    fs.utimesSync(path.join(tree, 'sub'), old, old)
    fs.utimesSync(tree, old, old)

    const m = await measureTree(tree)

    expect(m.newestMtimeMs).toBe(fresh.getTime())
  })

  it('counts an unreadable entry in errors instead of throwing', async () => {
    write(path.join(tree, 'ok.txt'), 'abc')
    write(path.join(tree, 'bad.txt'), 'abcdef')
    const real = await import('node:fs/promises')

    const m = await measureTree(tree, {
      fs: {
        lstat: async (p) => {
          if (p.endsWith('bad.txt')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
          return real.lstat(p)
        }
      }
    })

    expect(m).toMatchObject({ bytes: 3, files: 1, errors: 1 })
  })

  it('answers zeros for a missing root', async () => {
    expect(await measureTree(path.join(base, 'nope'))).toEqual({
      bytes: 0,
      files: 0,
      links: 0,
      errors: 0,
      newestMtimeMs: 0
    })
  })

  it('reports throttled progress and a final value', async () => {
    write(path.join(tree, 'a.txt'), '1234')
    write(path.join(tree, 'b.txt'), '12')
    const seen: Array<{ files: number; bytes: number }> = []

    await measureTree(tree, { onProgress: (p) => seen.push(p) })

    expect(seen.at(-1)).toEqual({ files: 2, bytes: 6 })
  })
})

describe('listTreeFiles', () => {
  it('a shell holding only links has no files', async () => {
    link(sentinel, path.join(tree, 'node_modules'))
    fs.mkdirSync(path.join(tree, 'empty-dir'))

    expect(await listTreeFiles(tree, 20)).toEqual({ count: 0, sample: [] })
  })

  it('counts every non-link file and samples relative paths, capped', async () => {
    for (let i = 0; i < 30; i++) write(path.join(tree, 'dir', `f${String(i).padStart(2, '0')}.txt`))
    link(sentinel, path.join(tree, 'node_modules'))

    const listing = await listTreeFiles(tree, 20)

    expect(listing.count).toBe(30)
    expect(listing.sample).toHaveLength(20)
    expect(listing.sample.every((s) => /^dir\/f\d\d\.txt$/.test(s))).toBe(true)
  })

  describe('stopAfter', () => {
    const lstatCounter = (): { calls: () => number; fs: Partial<TreeFs> } => {
      let n = 0
      return {
        calls: () => n,
        fs: {
          lstat: (p) => {
            n++
            return fs.promises.lstat(p)
          }
        }
      }
    }

    it('stops at the first file instead of reading a wide directory to the end', async () => {
      for (let i = 0; i < 300; i++) write(path.join(tree, 'big', `f${i}.txt`))
      const all = lstatCounter()
      await listTreeFiles(tree, 1, { fs: all.fs })
      const early = lstatCounter()

      const listing = await listTreeFiles(tree, 1, { fs: early.fs, stopAfter: 1 })

      expect(listing.count).toBeGreaterThanOrEqual(1)
      expect(listing.sample).toHaveLength(1)
      expect(all.calls()).toBeGreaterThan(300)
      // The files already in flight (the walker's concurrency) finish; the rest are never touched.
      expect(early.calls()).toBeLessThan(60)
    })

    it('does not change the answer for a tree with no file: links and empty directories only', async () => {
      link(sentinel, path.join(tree, 'node_modules'))
      fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true })

      expect(await listTreeFiles(tree, 1, { stopAfter: 1 })).toEqual({ count: 0, sample: [] })
    })
  })
})
