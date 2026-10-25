/**
 * @vitest-environment node
 *
 * pi's per-session scratchpad (ADR-110): the layout, Claude Code's preplant defence (a planted link
 * or a foreign owner at ANY level means no scratchpad, never a followed link), resume finding the
 * same directory, and the link-safe removal. Real directories under a unique temp base (the
 * `tmpdir` seam), real links (a junction on Windows, which needs no privilege); the owner and mode
 * cases go through the `fs` seam because a test cannot become another user.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  dispatchScratchpadKey,
  ensurePiScratchpad,
  hostScratchpadFs,
  isScratchpadSessionKey,
  removePiScratchpad,
  scratchpadProjectKey,
  scratchpadPrompt,
  scratchpadPromptArgs,
  type ScratchpadEnv,
  type ScratchpadFs
} from '../pi-scratchpad'

/** Can this platform create a directory link (a junction on Windows)? Probed once, at collection. */
const canLink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-scratch-probe-'))
  try {
    mkdirSync(join(dir, 'target'))
    symlinkSync(join(dir, 'target'), join(dir, 'dl'), 'junction')
    unlinkSync(join(dir, 'dl'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('pi scratchpad', () => {
  let testRoot = ''
  /** A fresh OS-temp stand-in per test. */
  let tmp = ''
  let counter = 0
  const links: string[] = []
  const warn = vi.fn<(message: string) => void>()
  const env = (over: Partial<ScratchpadEnv> = {}): Partial<ScratchpadEnv> => ({
    tmpdir: () => tmp,
    warn,
    ...over
  })
  const link = (target: string, at: string): void => {
    symlinkSync(target, at, 'junction')
    links.push(at)
  }
  const base = (): string => join(tmp, 'claudeui')
  const CWD = join(tmpdir(), 'some-project') // never created: only its spelling matters

  beforeAll(() => {
    testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-scratch-')))
  })
  beforeEach(() => {
    warn.mockClear()
    tmp = join(testRoot, `t${counter++}`)
    mkdirSync(tmp)
  })
  afterAll(() => {
    for (const l of links) {
      try {
        unlinkSync(l)
      } catch {
        // already gone (a removal test unlinked it)
      }
    }
    if (testRoot) rmSync(testRoot, { recursive: true, force: true })
  })

  describe('layout', () => {
    it('project key: non-alphanumerics become "-", exactly like Claude Code', () => {
      expect(scratchpadProjectKey('/home/me/My App')).toBe('-home-me-My-App')
      expect(scratchpadProjectKey('C:\\Work Place\\x.y')).toBe('C--Work-Place-x-y')
    })

    it('project key: capped at 200 chars plus a short stable hash, distinct for distinct cwds', () => {
      const a = `/${'a'.repeat(300)}/one`
      const b = `/${'a'.repeat(300)}/two`
      const ka = scratchpadProjectKey(a)
      expect(ka).toMatch(/^-a{199}-[0-9a-f]{10}$/)
      expect(ka.length).toBe(200 + 1 + 10)
      expect(scratchpadProjectKey(a)).toBe(ka)
      expect(scratchpadProjectKey(b)).not.toBe(ka)
      // exactly at the cap: unchanged, no hash
      expect(scratchpadProjectKey(`/${'b'.repeat(199)}`)).toBe(`-${'b'.repeat(199)}`)
    })

    it('builds <realpath(tmp)/claudeui>/<project-key>/<session>/scratchpad and the project temp dir', () => {
      const pad = ensurePiScratchpad(CWD, 'sess-1', env())
      const root = realpathSync.native(base())
      expect(pad).toEqual({
        dir: join(root, scratchpadProjectKey(CWD), 'sess-1', 'scratchpad'),
        projectTemp: join(root, scratchpadProjectKey(CWD))
      })
      expect(statSync(pad!.dir).isDirectory()).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    })

    it.skipIf(!canLink)(
      'is built on the REALPATH of the base: a symlinked temp dir does not leak into the spelling',
      () => {
        const real = join(testRoot, 'real-tmp')
        mkdirSync(real)
        const spelled = join(testRoot, 'spelled-tmp')
        link(real, spelled)
        const pad = ensurePiScratchpad(CWD, 'sess-1', env({ tmpdir: () => spelled }))
        expect(pad).toBeDefined()
        const root = realpathSync.native(join(real, 'claudeui'))
        expect(pad!.dir.startsWith(root)).toBe(true)
        expect(pad!.dir).not.toContain('spelled-tmp')
      }
    )

    it('session keys are one safe path segment', () => {
      for (const ok of ['a', 'pi-sess_1.2', '0190b3c4-1111-4222-8333-444455556666'])
        expect(isScratchpadSessionKey(ok), ok).toBe(true)
      for (const bad of [
        '',
        '..',
        '.',
        'a/b',
        'a\\b',
        '-x',
        'x-',
        '../etc',
        'a b',
        'x'.repeat(200)
      ])
        expect(isScratchpadSessionKey(bad), bad).toBe(false)
      expect(dispatchScratchpadKey('row-1')).toBe('dispatch-row-1')
    })

    it('a bad session key creates nothing and warns', () => {
      expect(ensurePiScratchpad(CWD, '../escape', env())).toBeUndefined()
      expect(existsSync(base())).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('the prompt paragraph names the directory and is one line; no directory, no flag', () => {
      const text = scratchpadPrompt('/t/claudeui/p/s/scratchpad')
      expect(text).toBe(
        "Scratchpad directory: /t/claudeui/p/s/scratchpad. Use it for temporary files (intermediate results, scripts, outputs that don't belong in the project) instead of /tmp or other system temp directories; it is session-specific and can be used without permission prompts. Always write its complete absolute path when you mention a file in it."
      )
      expect(text).not.toContain('\n')
      expect(scratchpadPromptArgs('/d')).toEqual(['--append-system-prompt', scratchpadPrompt('/d')])
      expect(scratchpadPromptArgs(undefined)).toEqual([])
    })
  })

  describe('creation', () => {
    it.skipIf(process.platform === 'win32')(
      'every level is 0700 and owned by this user (POSIX)',
      () => {
        const pad = ensurePiScratchpad(CWD, 'sess-1', env())!
        const levels = [base(), pad.projectTemp, join(pad.projectTemp, 'sess-1'), pad.dir]
        for (const level of levels) {
          const st = statSync(level)
          expect(st.mode & 0o777, level).toBe(0o700)
          expect(st.uid, level).toBe(process.getuid!())
        }
      }
    )

    it.skipIf(process.platform !== 'win32')('every level exists (Windows: no modes)', () => {
      const pad = ensurePiScratchpad(CWD, 'sess-1', env())!
      for (const level of [base(), pad.projectTemp, join(pad.projectTemp, 'sess-1'), pad.dir])
        expect(statSync(level).isDirectory()).toBe(true)
    })

    it('a resume (same key) finds the same directory and what was left in it', () => {
      const first = ensurePiScratchpad(CWD, 'sess-1', env())!
      writeFileSync(join(first.dir, 'notes.txt'), 'kept')
      const again = ensurePiScratchpad(CWD, 'sess-1', env())!
      expect(again).toEqual(first)
      expect(readFileSync(join(again.dir, 'notes.txt'), 'utf8')).toBe('kept')
      expect(warn).not.toHaveBeenCalled()
    })

    it('two sessions of one project share the project temp dir, not the scratchpad', () => {
      const a = ensurePiScratchpad(CWD, 'sess-a', env())!
      const b = ensurePiScratchpad(CWD, 'sess-b', env())!
      expect(a.projectTemp).toBe(b.projectTemp)
      expect(a.dir).not.toBe(b.dir)
    })
  })

  describe('a preplanted entry means no scratchpad, and no link is followed', () => {
    let elsewhere = ''
    beforeEach(() => {
      elsewhere = join(tmp, 'attacker-dir')
      mkdirSync(elsewhere)
    })

    it.skipIf(!canLink)('a link at the base', () => {
      link(elsewhere, base())
      expect(ensurePiScratchpad(CWD, 'sess-1', env())).toBeUndefined()
      expect(readdirSync(elsewhere)).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is a link'))
    })

    it.skipIf(!canLink)('a link at the project level', () => {
      mkdirSync(base(), { mode: 0o700 })
      link(elsewhere, join(realpathSync.native(base()), scratchpadProjectKey(CWD)))
      expect(ensurePiScratchpad(CWD, 'sess-1', env())).toBeUndefined()
      expect(readdirSync(elsewhere)).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is a link'))
    })

    it.skipIf(!canLink)('a link at the session level', () => {
      const project = join(realpathSync.native(mkdirAndReturn(base())), scratchpadProjectKey(CWD))
      mkdirSync(project, { mode: 0o700 })
      link(elsewhere, join(project, 'sess-1'))
      expect(ensurePiScratchpad(CWD, 'sess-1', env())).toBeUndefined()
      expect(readdirSync(elsewhere)).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is a link'))
    })

    it.skipIf(!canLink)('a link at the scratchpad itself', () => {
      const session = join(
        realpathSync.native(mkdirAndReturn(base())),
        scratchpadProjectKey(CWD),
        'sess-1'
      )
      mkdirSync(session, { recursive: true, mode: 0o700 })
      link(elsewhere, join(session, 'scratchpad'))
      expect(ensurePiScratchpad(CWD, 'sess-1', env())).toBeUndefined()
      expect(readdirSync(elsewhere)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('a plain file where a directory belongs', () => {
      mkdirSync(base(), { mode: 0o700 })
      writeFileSync(join(realpathSync.native(base()), scratchpadProjectKey(CWD)), 'x')
      expect(ensurePiScratchpad(CWD, 'sess-1', env())).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a directory'))
    })

    /**
     * A fs whose `lstat` reports every directory as owned by uid 1000 with mode 0700, except the
     * paths `match` picks, which get `patch`: a test cannot become another user.
     */
    const lying = (match: (p: string) => boolean, patch: { uid: number; mode: number }) =>
      ({
        ...hostScratchpadFs,
        lstat: (p: string) => {
          const st = lstatSync(p)
          const { uid, mode } = match(p) ? patch : { uid: 1000, mode: 0o40700 }
          return {
            isDirectory: () => st.isDirectory(),
            isSymbolicLink: () => st.isSymbolicLink(),
            uid,
            mode
          }
        }
      }) satisfies ScratchpadFs

    it.each([
      ['the base', (p: string) => p.endsWith('claudeui')],
      ['the project dir', (p: string) => p.endsWith(scratchpadProjectKey(CWD))],
      ['the session dir', (p: string) => p.endsWith('sess-1')],
      ['the scratchpad', (p: string) => p.endsWith('scratchpad')]
    ])('a directory owned by another user at %s (POSIX uid check, via the seam)', (_n, match) => {
      const pad = ensurePiScratchpad(
        CWD,
        'sess-1',
        env({ uid: 1000, fs: lying(match, { uid: 4242, mode: 0o40700 }) })
      )
      expect(pad).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('owned by uid 4242, expected 1000'))
    })

    it('a base that other users can reach (mode 0755) is refused', () => {
      const pad = ensurePiScratchpad(
        CWD,
        'sess-1',
        env({ uid: 1000, fs: lying(() => true, { uid: 1000, mode: 0o40755 }) })
      )
      expect(pad).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('accessible to others'))
    })

    it('with matching owner and 0700 the seam is accepted (the checks are not vacuous)', () => {
      const pad = ensurePiScratchpad(
        CWD,
        'sess-1',
        env({ uid: 1000, fs: lying(() => true, { uid: 1000, mode: 0o40700 }) })
      )
      expect(pad).toBeDefined()
    })

    it('a failing mkdir (read-only temp) is a warning, not a throw', () => {
      const fs: ScratchpadFs = {
        ...hostScratchpadFs,
        mkdir: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        }
      }
      expect(ensurePiScratchpad(CWD, 'sess-1', env({ fs }))).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('removal', () => {
    it("removes the session's directory and prunes an emptied project dir; other sessions stay", () => {
      const a = ensurePiScratchpad(CWD, 'sess-a', env())!
      const b = ensurePiScratchpad(CWD, 'sess-b', env())!
      writeFileSync(join(a.dir, 'x.txt'), 'x')
      removePiScratchpad('sess-a', env())
      expect(existsSync(join(a.projectTemp, 'sess-a'))).toBe(false)
      expect(existsSync(b.dir)).toBe(true)
      removePiScratchpad('sess-b', env())
      expect(existsSync(a.projectTemp)).toBe(false)
      expect(existsSync(base())).toBe(true)
    })

    it('finds the session under whichever project dir holds it', () => {
      const here = ensurePiScratchpad(CWD, 'sess-1', env())!
      const there = ensurePiScratchpad(`${CWD}-other`, 'sess-2', env())!
      removePiScratchpad('sess-2', env())
      expect(existsSync(there.dir)).toBe(false)
      expect(existsSync(here.dir)).toBe(true)
    })

    it.skipIf(!canLink)(
      'does not follow a link planted INSIDE the scratchpad: the link goes, its target stays',
      () => {
        const pad = ensurePiScratchpad(CWD, 'sess-1', env())!
        const victim = join(tmp, 'victim')
        mkdirSync(join(victim, 'deep'), { recursive: true })
        writeFileSync(join(victim, 'precious.txt'), 'precious')
        writeFileSync(join(victim, 'deep', 'more.txt'), 'more')
        link(victim, join(pad.dir, 'sneaky'))
        writeFileSync(join(pad.dir, 'plain.txt'), 'p')
        removePiScratchpad('sess-1', env())
        expect(existsSync(join(pad.projectTemp, 'sess-1'))).toBe(false)
        expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('precious')
        expect(readFileSync(join(victim, 'deep', 'more.txt'), 'utf8')).toBe('more')
      }
    )

    it.skipIf(!canLink)('refuses a session dir that is itself a link: nothing is touched', () => {
      mkdirSync(base(), { mode: 0o700 })
      const project = join(realpathSync.native(base()), scratchpadProjectKey(CWD))
      mkdirSync(project, { mode: 0o700 })
      const victim = join(tmp, 'victim')
      mkdirSync(victim)
      writeFileSync(join(victim, 'precious.txt'), 'precious')
      link(victim, join(project, 'sess-1'))
      removePiScratchpad('sess-1', env())
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('precious')
      expect(lstatSync(join(project, 'sess-1')).isSymbolicLink()).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is a link'))
    })

    it.skipIf(!canLink)('does not walk a base that is a link', () => {
      const victim = join(tmp, 'victim')
      mkdirSync(join(victim, 'proj', 'sess-1'), { recursive: true })
      writeFileSync(join(victim, 'proj', 'sess-1', 'precious.txt'), 'precious')
      link(victim, base())
      removePiScratchpad('sess-1', env())
      expect(existsSync(join(victim, 'proj', 'sess-1', 'precious.txt'))).toBe(true)
    })

    it('is a quiet no-op when nothing was ever created, and never throws on a bad key', () => {
      expect(() => removePiScratchpad('sess-1', env())).not.toThrow()
      expect(() => removePiScratchpad('../..', env())).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    })
  })
})

function mkdirAndReturn(p: string): string {
  mkdirSync(p, { mode: 0o700 })
  return p
}
