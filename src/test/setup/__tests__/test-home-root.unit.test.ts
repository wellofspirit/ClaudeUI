/**
 * The prune of old test homes (`scripts/lib/test-home-root.mjs`, called by vitest.config.ts). The
 * root `<tmpdir>/claudeui-test-home` is a predictable name in a possibly shared temp directory, so
 * a link planted there must never be followed and emptied.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestHomeRoot,
  isOwnRealDirectory,
  pruneTestHomes
} from '../../../../scripts/lib/test-home-root.mjs'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudeui-prune-test-'))
  scratch.push(dir)
  return dir
}

/** A directory with a file in it, last modified `ageMs` ago. */
function runDir(root: string, name: string, ageMs: number): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'file.txt'), 'x')
  const when = new Date(Date.now() - ageMs)
  utimesSync(dir, when, when)
  return dir
}

afterEach(() => {
  // Each scratch directory is ours; links inside are removed as links (rmSync never follows them).
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pruneTestHomes', () => {
  it('removes run directories older than the cutoff and keeps newer ones', () => {
    const root = tempDir()
    const old = runDir(root, 'old-run', 8 * 24 * 60 * 60 * 1000)
    const fresh = runDir(root, 'fresh-run', 60 * 1000)
    pruneTestHomes(root, Date.now() - WEEK_MS)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('does not follow a link inside the root', () => {
    const root = tempDir()
    const outside = tempDir()
    const victim = runDir(outside, 'victim', 8 * 24 * 60 * 60 * 1000)
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    pruneTestHomes(root, Date.now() + 1000)
    expect(existsSync(victim)).toBe(true)
  })

  it('skips the prune when the root itself is a link, and deletes nothing in its target', () => {
    const target = tempDir()
    const victim = runDir(target, 'victim', 8 * 24 * 60 * 60 * 1000)
    const holder = tempDir()
    const root = join(holder, 'claudeui-test-home')
    symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(root).isSymbolicLink()).toBe(true)

    expect(isOwnRealDirectory(root)).toBe(false)
    // A cutoff in the future: every directory in the target is "old".
    pruneTestHomes(root, Date.now() + 60 * 1000)
    expect(existsSync(join(victim, 'file.txt'))).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('skips a root owned by another user', () => {
    const root = tempDir()
    const old = runDir(root, 'old-run', 8 * 24 * 60 * 60 * 1000)
    const someoneElse = (process.getuid?.() ?? 0) + 1
    expect(isOwnRealDirectory(root, someoneElse)).toBe(false)
    pruneTestHomes(root, Date.now() - WEEK_MS, someoneElse)
    expect(existsSync(old)).toBe(true)
  })

  it('does nothing when the root does not exist', () => {
    expect(() => pruneTestHomes(join(tempDir(), 'missing'), Date.now())).not.toThrow()
  })
})

describe('createTestHomeRoot', () => {
  it.runIf(process.platform !== 'win32')('creates the root readable by this user only', () => {
    const root = join(tempDir(), 'nested', 'claudeui-test-home')
    createTestHomeRoot(root)
    expect(lstatSync(root).mode & 0o077).toBe(0)
  })

  it('refuses a root that is a link, without creating anything in its target', () => {
    const base = tempDir()
    const target = join(base, 'target')
    mkdirSync(target)
    const root = join(base, 'claudeui-test-home')
    symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => createTestHomeRoot(root)).toThrow(/is a link or belongs to another user/)
    expect(readdirSync(target)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('refuses a root owned by another user', () => {
    const root = join(tempDir(), 'claudeui-test-home')
    const otherUid = (process.getuid?.() ?? 0) + 1
    expect(() => createTestHomeRoot(root, otherUid)).toThrow(/belongs to another user/)
  })
})
