/**
 * Link-hardening of the redirect measurement (ADR-106 §1): the ways a write that
 * LOOKS in scope lands elsewhere, and the one way a clean write looked blocked.
 *
 *  1. a junction onto ANOTHER scope root is an ordinary in-scope write;
 *  2. an in-scope target whose root Node cannot read (UNC) is never clean;
 *  3. an in-scope regular file with `nlink > 1` is never clean;
 *  4. a link the command creates itself is measured before it exists;
 *  5. a UNC path is never folded onto a drive (`//s/share` is not `s:/share`);
 *  6. a case-variant protected directory is one hit, not a symlink.
 *
 * The probe seam carries every case it can express; a real junction / hard link
 * is built only where the seam cannot (hard links, junction containment, the
 * on-disk casing of a name), under the OS temp dir and removed afterwards.
 */
import { mkdirSync, mkdtempSync, linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureRedirects, type RedirectProbe, type RedirectStat } from '../redirect-measure'
import { normalizePath, toPosixish } from '../shell-lexical'

const SESSION_START = 1_000_000

type Entry =
  | { type: 'file'; nlink?: number }
  | { type: 'dir'; nlink?: number }
  | { type: 'symlink'; target: string }

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

function statOf(entry: Entry): RedirectStat {
  return {
    isSymbolicLink: () => entry.type === 'symlink',
    isFile: () => entry.type === 'file',
    size: 1,
    mtimeMs: 0,
    ...('nlink' in entry && entry.nlink !== undefined ? { nlink: entry.nlink } : {})
  }
}

/** A recording fake fs: `real` maps a directory reached through a link to where it lands. */
function fakeProbe(
  entries: Record<string, Entry>,
  real: Record<string, string> = {}
): RedirectProbe & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async lstat(path) {
      seen.push(path)
      const entry = entries[path]
      if (!entry) throw enoent(path)
      return statOf(entry)
    },
    async realpath(path) {
      seen.push(path)
      const entry = entries[path]
      if (entry?.type === 'symlink') return entry.target
      return real[path] ?? path
    }
  }
}

const POSIX = { sessionStartMs: SESSION_START, platform: 'linux' as const }

describe('1. a link onto another scope root is an ordinary in-scope write', () => {
  const scope = { cwd: '/work/wt/x', additionalDirectories: ['/work/main'] }

  it('does not report symlinked for a junction into the other root', async () => {
    const probe = fakeProbe(
      { '/work/wt/x/bundle': { type: 'dir' } },
      {
        '/work/wt/x/bundle': '/work/main/bundle'
      }
    )
    const result = await captureRedirects('echo x > bundle/out.txt', scope, { ...POSIX, probe })
    expect(result).toEqual({
      targets: ['bundle/out.txt'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('still reports symlinked for a junction out of every root', async () => {
    const probe = fakeProbe(
      { '/work/wt/x/bundle': { type: 'dir' } },
      {
        '/work/wt/x/bundle': '/work/elsewhere/bundle'
      }
    )
    const result = await captureRedirects('echo x > bundle/out.txt', scope, { ...POSIX, probe })
    expect(result?.symlinked).toEqual(['bundle/out.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('still reports a protected component inside the other root', async () => {
    const probe = fakeProbe(
      { '/work/wt/x/bundle': { type: 'dir' } },
      {
        '/work/wt/x/bundle': '/work/main/.claude'
      }
    )
    const result = await captureRedirects('echo x > bundle/settings.json', scope, {
      ...POSIX,
      probe
    })
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.symlinked).toEqual(['bundle/settings.json'])
    expect(result?.allInScope).toBe(false)
  })

  it('is as strict as ground truth when the other root itself sits under a protected name', async () => {
    // Naming `/work/main/.claude/wt/f` directly is a `.claude` hit (additional
    // roots do not relativise), so reaching it through a link must be too.
    const probe = fakeProbe(
      { '/work/wt/x/bundle': { type: 'dir' } },
      {
        '/work/wt/x/bundle': '/work/main/.claude/wt/bundle'
      }
    )
    const result = await captureRedirects(
      'echo x > bundle/f.txt',
      {
        cwd: '/work/wt/x',
        additionalDirectories: ['/work/main/.claude/wt']
      },
      { ...POSIX, probe }
    )
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.allInScope).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('1. (real junction, win32)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rm-links-j-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('accepts a junction between two scope roots and rejects one out of both', async () => {
    const wt = join(base, 'wt')
    const main = join(base, 'main')
    const other = join(base, 'other')
    for (const dir of [wt, join(main, 'bundle'), join(other, 'bundle')]) {
      mkdirSync(dir, { recursive: true })
    }
    symlinkSync(join(main, 'bundle'), join(wt, 'in-main'), 'junction')
    symlinkSync(join(other, 'bundle'), join(wt, 'in-other'), 'junction')
    const scope = { cwd: wt, additionalDirectories: [main] }
    const options = { sessionStartMs: SESSION_START }

    const ok = await captureRedirects('echo x > in-main/out.txt', scope, options)
    expect(ok?.allInScope).toBe(true)
    expect(ok?.symlinked).toBeUndefined()

    const escaped = await captureRedirects('echo x > in-other/out.txt', scope, options)
    expect(escaped?.symlinked).toEqual(['in-other/out.txt'])
    expect(escaped?.allInScope).toBe(false)
  })
})

describe('2. an in-scope target under an unmeasurable (UNC) root is never clean', () => {
  const unc = { cwd: '\\\\host\\share\\proj', shell: 'powershell' as const }
  const WIN = { sessionStartMs: SESSION_START, platform: 'win32' as const }

  it.each([
    ['a UNC share', '\\\\host\\share\\proj'],
    ['a WSL share', '\\\\wsl$\\Ubuntu\\home\\u\\proj'],
    ['a single-letter UNC host', '\\\\s\\share\\proj']
  ])('requires review for %s', async (_label, cwd) => {
    const result = await captureRedirects(
      'echo x > bundle\\out.txt',
      { ...unc, cwd },
      { ...WIN, probe: fakeProbe({}) }
    )
    expect(result).toEqual({
      targets: ['bundle\\out.txt'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: [],
      unmeasured: ['bundle\\out.txt']
    })
  })

  it('does not probe the wrong place for an in-scope UNC target', async () => {
    const probe = fakeProbe({})
    await captureRedirects('echo x > bundle\\out.txt', unc, { ...WIN, probe })
    expect(probe.seen.filter((p) => p.includes('bundle'))).toEqual([])
  })

  it('leaves a drive-rooted in-scope target clean', async () => {
    const result = await captureRedirects(
      'echo x > bundle\\out.txt',
      { cwd: 'D:\\work\\repo', shell: 'powershell' },
      { ...WIN, probe: fakeProbe({ 'd:/work/repo': { type: 'dir' } }) }
    )
    expect(result?.allInScope).toBe(true)
  })
})

describe('3. an in-scope regular file with several hard links is never clean', () => {
  const scope = { cwd: '/work/repo' }
  const run = (entries: Record<string, Entry>, command = 'echo x > notes.txt') =>
    captureRedirects(command, scope, { ...POSIX, probe: fakeProbe(entries) })

  it('requires review for nlink > 1', async () => {
    const result = await run({ '/work/repo/notes.txt': { type: 'file', nlink: 2 } })
    expect(result).toEqual({
      targets: ['notes.txt'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: [],
      unmeasured: ['notes.txt']
    })
  })

  it.each([
    ['nlink 1', { type: 'file', nlink: 1 } as Entry],
    ['an unmeasured nlink', { type: 'file' } as Entry],
    ['a directory with many links', { type: 'dir', nlink: 5 } as Entry]
  ])('leaves %s clean', async (_label, entry) => {
    const result = await run({ '/work/repo/notes.txt': entry })
    expect(result?.allInScope).toBe(true)
  })

  it('also checks the real file behind a symlink that stays in scope', async () => {
    const result = await run({
      '/work/repo/notes.txt': { type: 'symlink', target: '/work/repo/real.txt' },
      '/work/repo/real.txt': { type: 'file', nlink: 2 }
    })
    expect(result?.allInScope).toBe(false)
    expect(result?.symlinked).toBeUndefined()
  })

  it('does not change an out-of-scope file measurement', async () => {
    const result = await run(
      { '/work/other.txt': { type: 'file', nlink: 3 } },
      'echo x > ../other.txt'
    )
    expect(result?.outOfScope).toEqual([
      { path: '/work/other.txt', exists: true, empty: false, modifiedSinceSessionStart: false }
    ])
  })

  it('(real fs) flags a real hard link and clears a plain file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-links-h-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      writeFileSync(join(dir, 'plain.txt'), 'p')
      linkSync(join(dir, 'a.txt'), join(dir, 'b.txt'))
      const options = { sessionStartMs: SESSION_START }
      const linked = await captureRedirects('echo x > b.txt', { cwd: dir }, options)
      expect(linked?.allInScope).toBe(false)
      expect(linked?.symlinked).toBeUndefined()
      const plain = await captureRedirects('echo x > plain.txt', { cwd: dir }, options)
      expect(plain?.allInScope).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('4. a link the command creates is measured before it exists', () => {
  const scope = { cwd: '/work/repo' }
  const run = (command: string) =>
    captureRedirects(command, scope, { ...POSIX, probe: fakeProbe({}) })

  it('control: the same write without a link verb is clean', async () => {
    expect((await run('echo x > lnk/f.txt'))?.allInScope).toBe(true)
  })

  it.each([
    ['ln -s', 'ln -s ../outside lnk && echo x > lnk/f.txt'],
    ['gln', 'gln -sf ../outside lnk; echo x > lnk/f.txt'],
    ['/bin/ln', '/bin/ln -s ../outside lnk && echo x > lnk/f.txt'],
    ['mklink /J', 'cmd /c mklink /J sshj C:\\Users\\x\\.ssh && echo x >> sshj/authorized_keys'],
    ['MKLINK upper case', 'cmd /c MKLINK /D lnk C:\\x && echo x > lnk/f.txt'],
    [
      'SymbolicLink',
      'New-Item -ItemType SymbolicLink -Path lnk -Target C:\\x; echo x > lnk\\f.txt'
    ],
    ['Junction', 'ni -ItemType Junction -Path lnk -Target C:\\x; echo x > lnk\\f.txt'],
    ['HardLink', 'New-Item -Type HardLink -Path b -Target a; echo x > b'],
    ['case-insensitive', 'NEW-ITEM -itemtype JUNCTION lnk -Target C:\\x; echo x > lnk\\f.txt'],
    ['cp -al', 'cp -al ../outside lnk && echo x > lnk/f.txt'],
    ['os.symlink', "python -c \"import os; os.symlink('../o', 'lnk')\" && echo x > lnk/f.txt"]
  ])('requires review when the command creates a link: %s', async (_label, command) => {
    const result = await run(command)
    expect(result?.allInScope).toBe(false)
    expect(result?.outOfScope).toEqual([])
    expect(result?.symlinked).toBeUndefined()
  })

  it.each([
    ['grep -ln', 'grep -ln foo src > hits.txt'],
    ['cp -L', 'cp -L a b > log.txt'],
    ['a file called builtin', 'echo builtin > f.txt'],
    ['ln as a suffix', 'echo main.ln > f.txt']
  ])('does not cry wolf on %s', async (_label, command) => {
    expect((await run(command))?.allInScope).toBe(true)
  })

  it('does not drop an out-of-scope target', async () => {
    const result = await run('ln -s a b && echo x > ../out.txt')
    expect(result?.outOfScope).toEqual([{ path: '/work/out.txt', exists: false }])
  })
})

describe('5. a UNC path is never folded onto a drive', () => {
  it('keeps the UNC prefix and leaves the MSYS spelling alone', () => {
    expect(toPosixish('//s/share/a.txt', 'win32')).toBe('//s/share/a.txt')
    expect(toPosixish('\\\\s\\share\\a.txt', 'win32')).toBe('//s/share/a.txt')
    expect(toPosixish('/s/share/a.txt', 'win32')).toBe('s:/share/a.txt')
    expect(toPosixish('///s/share/a.txt', 'win32')).toBe('s:/share/a.txt')
    expect(toPosixish('/d/x', 'win32')).toBe('d:/x')
  })

  it('is idempotent, so a second read of its own output keeps the host', () => {
    for (const raw of ['//s/share/a.txt', '\\\\s\\share', '//host/share/a.txt']) {
      const once = toPosixish(raw, 'win32')
      expect(toPosixish(once, 'win32')).toBe(once)
      const full = normalizePath(raw, 'win32').full
      expect(normalizePath(full, 'win32').full).toBe(full)
    }
    expect(normalizePath('//s/share/a.txt', 'win32').full).toBe('//s/share/a.txt')
    expect(normalizePath('//s/share/../..', 'win32').full).toBe('/')
  })

  it('leaves other platforms and ordinary paths alone', () => {
    expect(toPosixish('//s/share/a.txt', 'linux')).toBe('/s/share/a.txt')
    expect(normalizePath('//s/share/a.txt', 'linux').full).toBe('/s/share/a.txt')
    expect(normalizePath('C:\\Users\\x', 'win32').full).toBe('c:/Users/x')
    expect(normalizePath('/tmp/x', 'win32').full).toBe('/tmp/x')
  })

  it('does not measure a single-letter UNC host at a fabricated drive path', async () => {
    const probe = fakeProbe({ 's:/share/a.txt': { type: 'file', nlink: 1 } })
    const result = await captureRedirects(
      'echo x > //s/share/a.txt',
      { cwd: 'D:\\work\\repo', shell: 'powershell' },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(probe.seen.filter((p) => p.startsWith('s:'))).toEqual([])
    // Not measured: the path is reported, with no `exists` fact.
    expect(result?.outOfScope).toEqual([{ path: '//s/share/a.txt' }])
    expect(result?.allInScope).toBe(false)
  })
})

describe('6. a case-variant protected directory is one hit, not a symlink', () => {
  const scope = { cwd: 'D:\\work\\repo', shell: 'powershell' as const }

  it('reports `.CLAUDE` once and no symlink on win32', async () => {
    // The on-disk casing is `.claude`; the command spelled `.CLAUDE`.
    const probe = fakeProbe(
      { 'd:/work/repo/.CLAUDE': { type: 'dir' } },
      { 'd:/work/repo/.CLAUDE': 'd:/work/repo/.claude' }
    )
    const result = await captureRedirects('echo x > .CLAUDE\\settings.json', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(result?.protectedHits).toEqual(['.CLAUDE'])
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(false)
  })

  it('still compares case-sensitively off win32', async () => {
    const probe = fakeProbe(
      { '/work/repo/.Claude': { type: 'dir' } },
      { '/work/repo/.Claude': '/work/repo/.claude' }
    )
    const result = await captureRedirects(
      'echo x > .Claude/settings.json',
      { cwd: '/work/repo' },
      {
        ...POSIX,
        probe
      }
    )
    // Off win32 `.Claude` and `.claude` are different directories: a link from
    // one onto the other is a genuine second hit and a symlinked write.
    expect(result?.protectedHits).toEqual(['.Claude', '.claude'])
    expect(result?.symlinked).toEqual(['.Claude/settings.json'])
  })

  it.runIf(process.platform === 'win32')(
    '(real fs, win32) one hit for a real `.claude`',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rm-links-c-'))
      try {
        mkdirSync(join(dir, '.claude'))
        const result = await captureRedirects(
          'echo x > .CLAUDE\\settings.json',
          { cwd: dir, shell: 'powershell' },
          { sessionStartMs: SESSION_START }
        )
        expect(result?.protectedHits).toEqual(['.CLAUDE'])
        expect(result?.symlinked).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
