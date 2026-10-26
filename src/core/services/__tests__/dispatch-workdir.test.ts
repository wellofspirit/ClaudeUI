/**
 * @vitest-environment node
 *
 * `resolveDispatchWorkdir`: where `dispatch_agent`'s `workdir` may point. Real directories under
 * the OS temp dir (nothing under the real profile), real links for the escape cases: a junction on
 * Windows, a symlink elsewhere.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDispatchWorkdir } from '../dispatch-workdir'
import { uiPath } from '../session-tools'

let base: string
/** The parent's working directory, and a directory beside it that the parent has no claim on. */
let parent: string
let outside: string
const links: string[] = []

const real = (p: string): string => uiPath(fs.realpathSync.native(p))
const mkdir = (...parts: string[]): string => {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
/** A junction on Windows (no privilege needed), a directory symlink elsewhere. */
const link = (at: string, to: string): string => {
  fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(at)
  return at
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'xeng-workdir-'))
  parent = mkdir(base, 'project')
  outside = mkdir(base, 'elsewhere')
})

afterAll(() => {
  // A link first, so removing the tree can never reach what it points at.
  for (const l of links) {
    try {
      fs.unlinkSync(l)
    } catch {
      try {
        fs.rmdirSync(l)
      } catch {
        /* already gone */
      }
    }
  }
  fs.rmSync(base, { recursive: true, force: true })
})

describe('resolveDispatchWorkdir', () => {
  it('accepts a directory inside the parent, answering its real path', () => {
    const wt = mkdir(parent, '.claude', 'worktrees', 'a')
    expect(resolveDispatchWorkdir(wt, parent)).toEqual({ ok: true, cwd: real(wt) })
  })

  it('accepts the parent directory itself', () => {
    expect(resolveDispatchWorkdir(parent, parent)).toEqual({ ok: true, cwd: real(parent) })
  })

  it('accepts a directory inside one of the additional directories', () => {
    const extra = mkdir(base, 'granted')
    const inside = mkdir(extra, 'repo')
    expect(resolveDispatchWorkdir(inside, parent, [extra])).toEqual({ ok: true, cwd: real(inside) })
  })

  it('resolves a relative workdir against the parent directory', () => {
    const wt = mkdir(parent, 'wt', 'rel')
    expect(resolveDispatchWorkdir(path.join('wt', 'rel'), parent)).toEqual({
      ok: true,
      cwd: real(wt)
    })
    expect(resolveDispatchWorkdir(`.${path.sep}wt${path.sep}rel`, parent)).toEqual({
      ok: true,
      cwd: real(wt)
    })
  })

  it('resolves a relative additional directory against the parent directory too', () => {
    // Only the additional list can grant a sibling of the parent.
    const target = mkdir(base, 'sibling', 'y')
    expect(resolveDispatchWorkdir(target, parent).ok).toBe(false)
    expect(resolveDispatchWorkdir(target, parent, [path.join('..', 'sibling')])).toEqual({
      ok: true,
      cwd: real(target)
    })
  })

  it('skips an additional directory that does not exist', () => {
    const gone = path.join(base, 'never-created')
    expect(resolveDispatchWorkdir(outside, parent, [gone]).ok).toBe(false)
    expect(resolveDispatchWorkdir(parent, parent, [gone]).ok).toBe(true)
  })

  it('refuses a directory outside both, naming what is allowed', () => {
    const extra = mkdir(base, 'granted2')
    const result = resolveDispatchWorkdir(outside, parent, [extra])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.text).toContain(
      `dispatch_agent "workdir" ${outside} is not inside your working directory`
    )
    expect(result.text).toContain("the user's additional directories")
    expect(result.text).toContain(parent)
    expect(result.text).toContain(extra)
  })

  it('refuses a sibling whose name only starts like the parent, and a `..` climb', () => {
    const lookalike = mkdir(base, 'project-evil')
    expect(resolveDispatchWorkdir(lookalike, parent).ok).toBe(false)
    expect(resolveDispatchWorkdir(path.join(parent, '..', 'elsewhere'), parent).ok).toBe(false)
    expect(resolveDispatchWorkdir(path.join('..', 'elsewhere'), parent).ok).toBe(false)
    // A parent of the working directory is not inside it either.
    expect(resolveDispatchWorkdir(base, parent).ok).toBe(false)
  })

  it('refuses a link inside the parent that leads outside it', () => {
    const escape = link(path.join(parent, 'escape'), outside)
    const direct = resolveDispatchWorkdir(escape, parent)
    expect(direct.ok).toBe(false)
    // ... and a directory reached THROUGH it.
    const through = mkdir(outside, 'deep')
    const viaLink = resolveDispatchWorkdir(path.join(escape, 'deep'), parent)
    expect(viaLink.ok).toBe(false)
    if (!direct.ok) expect(direct.text).toContain('is not inside your working directory')
    expect(fs.existsSync(through)).toBe(true)
  })

  it('accepts a link inside the parent that leads somewhere inside it, answering the real target', () => {
    const target = mkdir(parent, 'real-target')
    const alias = link(path.join(parent, 'alias'), target)
    expect(resolveDispatchWorkdir(alias, parent)).toEqual({ ok: true, cwd: real(target) })
  })

  it('refuses a directory that does not exist, inside the parent', () => {
    const result = resolveDispatchWorkdir(path.join(parent, 'not-created'), parent)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.text).toMatch(/"workdir" .*not-created does not exist/)
  })

  it('a parent spelled through a link (a symlinked project, macOS /tmp, an 8.3 name): a directory not created yet is inside it', () => {
    const alias = link(path.join(base, 'project-alias'), parent)
    // Both spellings of the parent, and a spelling of the missing directory through either.
    for (const [workdir, cwd] of [
      [path.join(alias, 'not-yet'), alias],
      [path.join(alias, 'not-yet'), parent],
      [path.join(parent, 'not-yet'), alias]
    ]) {
      const result = resolveDispatchWorkdir(workdir, cwd)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.text).toMatch(/"workdir" .*not-yet does not exist/)
    }
  })

  it('a directory that does not exist under a link leading out of the parent is outside, and does not say whether it exists', () => {
    const escape = link(path.join(parent, 'escape-missing'), outside)
    const result = resolveDispatchWorkdir(path.join(escape, 'nope'), parent)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.text).toContain('is not inside your working directory')
      expect(result.text).not.toContain('does not exist')
    }
  })

  it('does not tell whether a path outside its reach exists', () => {
    const missing = resolveDispatchWorkdir(path.join(outside, 'nope'), parent)
    const present = resolveDispatchWorkdir(outside, parent)
    expect(missing.ok).toBe(false)
    expect(present.ok).toBe(false)
    if (!missing.ok && !present.ok) {
      expect(missing.text).toContain('is not inside your working directory')
      expect(missing.text).not.toContain('does not exist')
    }
  })

  it('refuses a file', () => {
    const file = path.join(parent, 'notes.txt')
    fs.writeFileSync(file, 'x')
    const result = resolveDispatchWorkdir(file, parent)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.text).toBe(`dispatch_agent "workdir" ${file} is not a directory.`)
  })

  it('shows a relative workdir with where it landed', () => {
    const result = resolveDispatchWorkdir('absent', parent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.text).toContain(`absent (${path.join(parent, 'absent')})`)
  })

  it('expands a leading ~ to the home directory', () => {
    const home = os.homedir()
    expect(resolveDispatchWorkdir('~', home)).toEqual({ ok: true, cwd: real(home) })
    // Under a parent that is not the home directory it is outside, not a relative `~` directory.
    const result = resolveDispatchWorkdir('~', parent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.text).toContain('is not inside your working directory')
  })

  it.runIf(process.platform === 'win32')(
    'accepts another spelling of the same directory (letter case, separators) on Windows',
    () => {
      const wt = mkdir(parent, 'Case', 'Wt')
      const swapped = wt
        .split('')
        .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
        .join('')
      expect(resolveDispatchWorkdir(swapped, parent)).toEqual({ ok: true, cwd: real(wt) })
      expect(resolveDispatchWorkdir(wt.replace(/\\/g, '/'), parent.toLowerCase())).toEqual({
        ok: true,
        cwd: real(wt)
      })
    }
  )
})
