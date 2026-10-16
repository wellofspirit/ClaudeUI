/**
 * @vitest-environment node
 *
 * `scripts/lib/vendor-swap.mjs`: replacing files under vendor/claude-cli while
 * a process holds `bun-claude.exe` open.
 *
 * Why this exists: on Windows the image of a running executable is locked.
 * Overwriting it fails with EBUSY and removing its directory with EPERM, and
 * extract-cli's `rmSync(vendor/claude-cli)` hit the latter AFTER it had
 * already deleted cli.js and version.json — a half-wiped vendor dir, seen in
 * several bump sessions. Renaming a running image is allowed, which is what
 * the helpers do. The Windows tests copy the real PING.EXE as the stand-in
 * "running bun-claude" and each first pins the failure the helpers exist to
 * avoid (EPERM for a directory remove, EBUSY for an overwrite), so a Windows
 * behaviour change shows up here instead of silently making them vacuous.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod: any = await import('../../../scripts/lib/vendor-swap.mjs')
const { removeOrMoveAside, clearDir, replaceFile, sweepTrash } = mod

const dirs: string[] = []
const children: ChildProcess[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vendor-swap-test-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  // A held exe can't be deleted: wait for (or stop) every child we started
  // before removing the temp dirs. Only PIDs spawned here are ever killed.
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill()
      await new Promise((r) => c.once('close', r))
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const pingExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE')
const canHoldExe = process.platform === 'win32' && existsSync(pingExe)

/** Copy PING.EXE to `target` and run it for ~2 s so the image is locked. */
function runHeldExe(target: string): { child: ChildProcess; exit: Promise<number | null> } {
  copyFileSync(pingExe, target)
  const child = spawn(target, ['-n', '3', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  const exit = new Promise<number | null>((res) => child.once('close', res))
  return { child, exit }
}

const started = (c: ChildProcess) =>
  new Promise((res, rej) => (c.once('spawn', res), c.once('error', rej)))

describe('vendor-swap: plain files (any platform)', () => {
  it('removeOrMoveAside deletes a file and a directory outright', () => {
    const root = tempDir()
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'b')
    const trash = join(root, '.trash')

    removeOrMoveAside(join(root, 'a.txt'), trash)
    removeOrMoveAside(join(root, 'sub'), trash)

    expect(readdirSync(root)).toEqual([])
    expect(existsSync(trash)).toBe(false) // nothing was locked: trash never created
  })

  it('removeOrMoveAside of a missing path is a no-op', () => {
    const root = tempDir()
    expect(() => removeOrMoveAside(join(root, 'nope'), join(root, '.trash'))).not.toThrow()
  })

  it('clearDir empties a directory but keeps (or creates) the directory itself', () => {
    const root = tempDir()
    const vendor = join(root, 'claude-cli')
    mkdirSync(vendor)
    writeFileSync(join(vendor, 'cli.js'), 'x')
    mkdirSync(join(vendor, 'old-chunks'))
    writeFileSync(join(vendor, 'old-chunks', 'c.js'), 'y')

    clearDir(vendor, join(root, '.trash'))
    expect(existsSync(vendor)).toBe(true)
    expect(readdirSync(vendor)).toEqual([])

    const fresh = join(root, 'fresh')
    clearDir(fresh, join(root, '.trash'))
    expect(existsSync(fresh)).toBe(true)
  })

  it('clearDir leaves a trash dir that lives inside the dir alone', () => {
    const root = tempDir()
    const vendor = join(root, 'claude-cli')
    const trash = join(vendor, '.trash')
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, 'held-1-2'), 'x')
    writeFileSync(join(vendor, 'cli.js'), 'x')

    clearDir(vendor, trash)

    expect(readdirSync(vendor)).toEqual(['.trash'])
    expect(readdirSync(trash)).toEqual(['held-1-2'])
  })

  it('replaceFile swaps the content and leaves no temp file behind', () => {
    const root = tempDir()
    const target = join(root, 'bun-claude.exe')
    writeFileSync(target, 'old')

    replaceFile(target, Buffer.from('new'), join(root, '.trash'))

    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(root)).toEqual(['bun-claude.exe'])
  })

  it('replaceFile creates a target that does not exist yet', () => {
    const root = tempDir()
    const target = join(root, 'bun-claude')
    replaceFile(target, Buffer.from('fresh'), join(root, '.trash'))
    expect(readFileSync(target, 'utf8')).toBe('fresh')
  })

  it('replaceFile rethrows when the write fails and leaves nothing behind', () => {
    const root = tempDir()
    expect(() =>
      replaceFile(join(root, 'missing-dir', 'x.exe'), Buffer.from('x'), join(root, 't'))
    ).toThrow(/ENOENT/)
    expect(readdirSync(root)).toEqual([])
  })

  it('sweepTrash reports 0 for a missing dir and clears an unlocked one', () => {
    const root = tempDir()
    expect(sweepTrash(join(root, '.trash'))).toBe(0)

    const trash = join(root, '.trash')
    mkdirSync(trash)
    writeFileSync(join(trash, 'bun-claude.exe-1-2'), 'x')
    mkdirSync(join(trash, 'dir-3-4'))
    expect(sweepTrash(trash)).toBe(0)
    expect(readdirSync(trash)).toEqual([])
  })
})

describe.runIf(canHoldExe)('vendor-swap: a running executable (Windows)', () => {
  it('the old behaviour fails: rm of the dir is EPERM, overwrite is EBUSY', async () => {
    const root = tempDir()
    const vendor = join(root, 'claude-cli')
    mkdirSync(vendor)
    const exe = join(vendor, 'bun-claude.exe')
    const { child, exit } = runHeldExe(exe)
    await started(child)

    expect(() => rmSync(vendor, { recursive: true, force: true })).toThrow(/EPERM/)
    expect(() => writeFileSync(exe, 'new')).toThrow(/EBUSY/)

    expect(await exit).toBe(0)
  })

  it('clearDir moves the held exe into the trash while the process keeps running', async () => {
    const root = tempDir()
    const vendor = join(root, 'claude-cli')
    const trash = join(root, '.claude-cli-trash')
    mkdirSync(vendor)
    writeFileSync(join(vendor, 'cli.js'), 'x')
    writeFileSync(join(vendor, 'version.json'), '{}')
    const { child, exit } = runHeldExe(join(vendor, 'bun-claude.exe'))
    await started(child)

    clearDir(vendor, trash)

    expect(readdirSync(vendor)).toEqual([])
    const moved = readdirSync(trash)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatch(/^bun-claude\.exe-\d+-\d+$/)
    expect(child.exitCode).toBeNull() // still running when the move happened
    expect(await exit).toBe(0) // and it was not disturbed by it
  })

  it('replaceFile swaps in a new file at the held path and trashes the old one', async () => {
    const root = tempDir()
    const trash = join(root, '.claude-cli-trash')
    const exe = join(root, 'bun-claude.exe')
    const { child, exit } = runHeldExe(exe)
    await started(child)

    replaceFile(exe, Buffer.from('NEW'), trash)

    expect(readFileSync(exe, 'utf8')).toBe('NEW')
    expect(readdirSync(root).sort()).toEqual(['.claude-cli-trash', 'bun-claude.exe'])
    expect(readdirSync(trash)).toHaveLength(1)
    expect(await exit).toBe(0)
  })

  it('sweepTrash tolerates the still-locked entry, then clears it once the process exits', async () => {
    const root = tempDir()
    const vendor = join(root, 'claude-cli')
    const trash = join(root, '.claude-cli-trash')
    mkdirSync(vendor)
    const { child, exit } = runHeldExe(join(vendor, 'bun-claude.exe'))
    await started(child)
    clearDir(vendor, trash)

    expect(sweepTrash(trash)).toBe(1) // held: reported, not thrown
    expect(readdirSync(trash)).toHaveLength(1)

    await exit
    expect(sweepTrash(trash)).toBe(0)
    expect(readdirSync(trash)).toEqual([])
  })
})
