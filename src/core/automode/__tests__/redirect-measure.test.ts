/**
 * P2a-2: the MEASURED half of redirect ground truth.
 *
 * Every test drives {@link captureRedirects} through the injected probe, so the
 * fs shapes are exact and the suite touches no real file. The properties worth
 * holding onto:
 *
 *  - a probed absence is `exists:false`; a PROBE FAILURE is no field at all;
 *  - `empty`/`modifiedSinceSessionStart` only exist for a regular file;
 *  - a link (or a link in the parent directory) that leaves scope is
 *    `symlinked`, never an in-scope path — while a link that STAYS in scope is
 *    an ordinary in-scope write;
 *  - the deadline falls back to the pure result (no measurements).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  captureRedirects,
  REDIRECT_CAPTURE_TIMEOUT_MS,
  type RedirectProbe,
  type RedirectStat
} from '../redirect-measure'

const CWD = '/work/repo'
const SESSION_START = 1_000_000

const scope = { cwd: CWD, tempDirs: ['/tmp'], additionalDirectories: [] as string[] }

type Entry =
  | { type: 'file'; size?: number; mtimeMs?: number }
  | { type: 'dir' }
  /** `target` absent or null = dangling. */
  | { type: 'symlink'; target?: string | null }
  | { type: 'other' }

interface FakeOptions {
  entries?: Record<string, Entry>
  /** `realpath` of a non-link path that is itself reached through a link. */
  real?: Record<string, string>
  /** Throw a NON-ENOENT error: "could not measure", not "absent". */
  failLstat?: string[]
  failRealpath?: string[]
  /** Never resolve, for the deadline test. */
  hangLstat?: string[]
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

function statOf(entry: Entry): RedirectStat {
  if (entry.type === 'symlink') {
    return { isSymbolicLink: () => true, isFile: () => false, size: 0, mtimeMs: 0 }
  }
  if (entry.type === 'file') {
    return {
      isSymbolicLink: () => false,
      isFile: () => true,
      size: entry.size ?? 0,
      mtimeMs: entry.mtimeMs ?? 0
    }
  }
  return { isSymbolicLink: () => false, isFile: () => false, size: 0, mtimeMs: 0 }
}

function fakeProbe(options: FakeOptions = {}): RedirectProbe {
  const entries = options.entries ?? {}
  const real = options.real ?? {}
  return {
    async lstat(path) {
      if (options.hangLstat?.includes(path)) return new Promise<RedirectStat>(() => {})
      if (options.failLstat?.includes(path)) throw new Error(`lstat failed: ${path}`)
      const entry = entries[path]
      if (!entry) throw enoent(path)
      return statOf(entry)
    },
    async realpath(path) {
      if (options.failRealpath?.includes(path)) throw new Error(`realpath failed: ${path}`)
      const entry = entries[path]
      if (entry?.type === 'symlink') {
        if (!entry.target) throw enoent(path)
        return entry.target
      }
      return real[path] ?? path
    }
  }
}

const capture = (
  command: string,
  probe: RedirectProbe,
  extra: Partial<{ sessionStartMs: number; timeoutMs: number }> = {}
) =>
  captureRedirects(command, scope, {
    sessionStartMs: SESSION_START,
    platform: 'linux',
    probe,
    ...extra
  })

describe('captureRedirects — out-of-scope measurement', () => {
  it('reports a target that does not exist as exists:false (and nothing else)', async () => {
    const result = await capture('dotnet build > ../_scratch/b.txt', fakeProbe())
    expect(result).toEqual({
      targets: ['../_scratch/b.txt'],
      allInScope: false,
      outOfScope: [{ path: '/work/_scratch/b.txt', exists: false }],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('measures an existing append target: append:true, non-empty, mtime before session start', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/_scratch/build.log': { type: 'file', size: 4_096, mtimeMs: SESSION_START - 1 }
      }
    })
    const result = await capture('dotnet build >> ../_scratch/build.log 2>&1', probe)
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/_scratch/build.log',
        append: true,
        exists: true,
        empty: false,
        modifiedSinceSessionStart: false
      }
    ])
    expect(result?.allInScope).toBe(false)
  })

  it('measures an empty file as empty:true', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/_scratch/empty.log': { type: 'file', size: 0, mtimeMs: SESSION_START + 10 }
      }
    })
    const result = await capture('echo start > ../_scratch/empty.log', probe)
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/_scratch/empty.log',
        exists: true,
        empty: true,
        modifiedSinceSessionStart: true
      }
    ])
  })

  it('compares mtime against the session start: before → false, at/after → true', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/_scratch/old.log': { type: 'file', size: 10, mtimeMs: SESSION_START - 1 },
        '/work/_scratch/new.log': { type: 'file', size: 10, mtimeMs: SESSION_START }
      }
    })
    const result = await capture(
      'echo a > ../_scratch/old.log; echo b > ../_scratch/new.log',
      probe
    )
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/_scratch/old.log',
        exists: true,
        empty: false,
        modifiedSinceSessionStart: false
      },
      {
        path: '/work/_scratch/new.log',
        exists: true,
        empty: false,
        modifiedSinceSessionStart: true
      }
    ])
  })

  it('reports exists:true but no empty/mtime for a non-regular target', async () => {
    const probe = fakeProbe({
      entries: { '/work/_scratch/socket': { type: 'other' } }
    })
    const result = await capture('echo x > ../_scratch/socket', probe)
    expect(result?.outOfScope).toEqual([{ path: '/work/_scratch/socket', exists: true }])
  })

  it('keeps an append flag even when the target could not be measured', async () => {
    const probe = fakeProbe({ failLstat: ['/work/_scratch/b.txt'] })
    const result = await capture('echo x >> ../_scratch/b.txt', probe)
    expect(result?.outOfScope).toEqual([{ path: '/work/_scratch/b.txt', append: true }])
  })
})

describe('captureRedirects — symlinks', () => {
  it('classifies a target symlink that resolves out of scope as symlinked', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/build.log': { type: 'symlink', target: '/home/dev/.bashrc' }
      }
    })
    const result = await capture('echo x > build.log', probe)
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: [],
      symlinked: ['build.log']
    })
  })

  it('classifies a target symlink that resolves IN scope as an ordinary in-scope write', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/build.log': { type: 'symlink', target: '/work/repo/logs/build.log' },
        '/work/repo/logs': { type: 'dir' }
      }
    })
    const result = await capture('echo x > build.log', probe)
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
    expect(result?.symlinked).toBeUndefined()
  })

  it('treats a symlink onto a protected component as symlinked even in scope', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/hook.sh': { type: 'symlink', target: '/work/repo/.git/hooks/pre-commit' },
        '/work/repo/.git': { type: 'dir' },
        '/work/repo/.git/hooks': { type: 'dir' }
      }
    })
    const result = await capture('echo evil > hook.sh', probe)
    expect(result?.symlinked).toEqual(['hook.sh'])
    expect(result?.allInScope).toBe(false)
  })

  it('classifies a dangling symlink as symlinked', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/link.log': { type: 'symlink', target: null } }
    })
    const result = await capture('echo x > link.log', probe)
    expect(result?.symlinked).toEqual(['link.log'])
    expect(result?.allInScope).toBe(false)
  })

  it('catches a PARENT directory link that leaves scope, even for a new file', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/out': { type: 'dir' } },
      real: { '/work/repo/out': '/outside/out' }
    })
    const result = await capture('echo x > out/x.log', probe)
    expect(result).toEqual({
      targets: ['out/x.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: [],
      symlinked: ['out/x.log']
    })
  })

  it('classifies an out-of-scope link that resolves back in scope by its real path', async () => {
    // `../notes.md` is lexically outside the root; it is a link to a file inside.
    const probe = fakeProbe({
      entries: {
        '/work/notes.md': { type: 'symlink', target: '/work/repo/notes.md' },
        '/work/repo/notes.md': { type: 'file', size: 5, mtimeMs: SESSION_START - 1 }
      }
    })
    const result = await capture('echo x > ../notes.md', probe)
    expect(result).toEqual({
      targets: ['../notes.md'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })
})

describe('captureRedirects — a `..` after a component (ruling 10)', () => {
  it('treats a prefix before `..` that is a link as symlinked', async () => {
    // `sub/../x` collapses to `<cwd>/x` textually, but `sub` is a link to
    // /outside, so bash writes /outside/../x = /x, not /work/repo/x.
    const probe = fakeProbe({
      entries: { '/work/repo/sub': { type: 'symlink', target: '/outside/sub' } }
    })
    const result = await capture('echo x > sub/../x', probe)
    expect(result?.symlinked).toEqual(['sub/../x'])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps an ordinary directory prefix in scope', async () => {
    const probe = fakeProbe({ entries: { '/work/repo/sub': { type: 'dir' } } })
    const result = await capture('echo x > sub/../x', probe)
    expect(result).toEqual({
      targets: ['sub/../x'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('does not fabricate when the prefix cannot be resolved', async () => {
    const probe = fakeProbe({ failRealpath: ['/work/repo/sub'] })
    const result = await capture('echo x > sub/../x', probe)
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(true)
  })

  it('reports an out-of-scope target through the link before `..`', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/sub': { type: 'symlink', target: '/outside/sub' } }
    })
    const result = await capture('echo x > sub/../../../y', probe)
    expect(result?.symlinked).toEqual(['sub/../../../y'])
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — the RESOLVED reading of a `..` (exit review #2)', () => {
  it('walks an MSYS absolute target (`/c/…`) through the link before `..`', async () => {
    const probe = fakeProbe({
      entries: { 'c:/proj/lnk': { type: 'symlink', target: '/home/sub' } }
    })
    const result = await captureRedirects(
      'echo k > /c/proj/lnk/../msys.txt',
      { cwd: 'c:/proj', tempDirs: [] },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result?.symlinked).toEqual(['/c/proj/lnk/../msys.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('walks a native `c:/…` target through the link (reported on the as-written path)', async () => {
    const probe = fakeProbe({
      entries: { 'c:/proj/lnk': { type: 'symlink', target: '/home/sub' } }
    })
    const result = await captureRedirects(
      'echo k > c:/proj/lnk/../abs.txt',
      { cwd: 'c:/proj', tempDirs: [] },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    // Win32 collapses `..` lexically, but an EXPLICIT link still moves the
    // write; the safe direction is the link finding.
    expect(result?.symlinked).toEqual(['c:/proj/lnk/../abs.txt'])
  })

  it('walks the bash backslash reading `l\\nk/../x` as `lnk/../x`', async () => {
    const probe = fakeProbe({
      entries: { '/work/proj/lnk': { type: 'symlink', target: '/outside/sub' } }
    })
    const result = await captureRedirects(
      'echo k > l\\nk/../bs.txt',
      { cwd: '/work/proj', tempDirs: [], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'linux', probe }
    )
    expect(result?.symlinked).toEqual(['l\\nk/../bs.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('ignores a reading that does not collapse to the path the scanner resolved', async () => {
    // The backslash-as-separator reading is `l/nk/../bs.txt` (→ `l/bs.txt`), not
    // the scanner's `<cwd>/bs.txt`, so its (link-shaped) prefix proves nothing.
    const probe = fakeProbe({
      entries: { '/work/proj/l': { type: 'symlink', target: '/outside' } }
    })
    const result = await captureRedirects(
      'echo k > l\\nk/../bs.txt',
      { cwd: '/work/proj', tempDirs: [], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'linux', probe }
    )
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(true)
  })
})

describe('captureRedirects — win32 `/tmp` is the host temp dir (exit review #3)', () => {
  const TEMP = 'c:/Users/me/AppData/Local/Temp'

  /** Node cannot see Git Bash's `/tmp` mount: `realpath('/tmp')` throws ENOENT. */
  function tmpProbe(entries: Record<string, Entry> = {}): RedirectProbe {
    return {
      async lstat(path) {
        const entry = entries[path]
        if (!entry) throw enoent(path)
        return statOf(entry)
      },
      async realpath(path) {
        if (path === '/tmp') throw enoent(path)
        const entry = entries[path]
        if (entry?.type === 'symlink') {
          if (!entry.target) throw enoent(path)
          return entry.target
        }
        return path
      }
    }
  }

  const scope = { cwd: 'c:/proj', tempDirs: ['/tmp', TEMP] }

  it('finds a link under the `/tmp` spelling', async () => {
    const probe = tmpProbe({ [`${TEMP}/sb/tmplink`]: { type: 'symlink', target: 'C:/Windows' } })
    const result = await captureRedirects('echo k >> /tmp/sb/tmplink/x.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(result?.symlinked).toEqual(['/tmp/sb/tmplink/x.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('folds `/TMP` and `/Tmp` too (Git Bash mounts case-insensitively; exit review N2)', async () => {
    const probe = tmpProbe({ [`${TEMP}/sb/tmplink`]: { type: 'symlink', target: 'C:/Windows' } })
    for (const spelling of ['/TMP', '/Tmp']) {
      const result = await captureRedirects(`echo k >> ${spelling}/sb/tmplink/x.txt`, scope, {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe
      })
      expect(result?.symlinked).toEqual([`${spelling}/sb/tmplink/x.txt`])
      expect(result?.allInScope).toBe(false)
    }
  })

  it('still measures an ordinary `/tmp` write as in scope (no fabricated finding)', async () => {
    const probe = tmpProbe({ [`${TEMP}/sb`]: { type: 'dir' } })
    const result = await captureRedirects('echo k >> /tmp/sb/x.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(result).toEqual({
      targets: ['/tmp/sb/x.txt'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })
})

describe('captureRedirects — out-of-scope writes through a directory link (exit review rec + N5)', () => {
  // Exit review N5 REVISED the first round: an out-of-scope target written
  // through a benign linked ancestor is NOT `symlinked` — lstat reads through
  // the link, so exists/empty/mtime describe the real file. Only a protected
  // real target is the finding.
  it('adds a protected real target as a hit but keeps the measured facts, not symlinked', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/outside/keys/authorized_keys': { type: 'file', size: 10 },
        '/work/outside/keys': { type: 'dir' }
      },
      real: { '/work/outside/keys': '/work/home/.ssh' }
    })
    const result = await capture('echo k >> ../outside/keys/authorized_keys', probe)
    expect(result?.protectedHits).toEqual(['.ssh'])
    expect(result?.symlinked).toBeUndefined()
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/outside/keys/authorized_keys',
        append: true,
        exists: true,
        empty: false,
        modifiedSinceSessionStart: false
      }
    ])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps a benign linked ancestor ordinary (a relocated folder clears as before)', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/outside/notes': { type: 'dir' },
        '/work/outside/notes/new.txt': { type: 'file', size: 0, mtimeMs: SESSION_START - 1 }
      },
      real: { '/work/outside/notes': '/work/elsewhere/notes' }
    })
    const result = await capture('echo k >> ../outside/notes/new.txt', probe)
    expect(result?.symlinked).toBeUndefined()
    expect(result?.protectedHits).toEqual([])
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/outside/notes/new.txt',
        append: true,
        exists: true,
        empty: true,
        modifiedSinceSessionStart: false
      }
    ])
  })

  it('still measures an absent target through the linked ancestor as exists:false', async () => {
    const probe = fakeProbe({
      entries: { '/work/outside/notes': { type: 'dir' } },
      real: { '/work/outside/notes': '/work/elsewhere/notes' }
    })
    const result = await capture('echo k > ../outside/notes/x.txt', probe)
    expect(result?.symlinked).toBeUndefined()
    expect(result?.outOfScope).toEqual([{ path: '/work/outside/notes/x.txt', exists: false }])
  })

  it('keeps a plain out-of-scope target measured by its textual path', async () => {
    const probe = fakeProbe({
      entries: { '/work/outside/notes.txt': { type: 'file', size: 0, mtimeMs: SESSION_START } }
    })
    const result = await capture('echo k > ../outside/notes.txt', probe)
    expect(result?.symlinked).toBeUndefined()
    expect(result?.outOfScope).toEqual([
      {
        path: '/work/outside/notes.txt',
        exists: true,
        empty: true,
        modifiedSinceSessionStart: true
      }
    ])
  })
})

describe('captureRedirects — win32 drive-less mounts other than /tmp (exit review N4)', () => {
  // Git Bash's `/etc`, `/usr`, `/bin`, `/opt` are under its install root, but
  // Node probes `<process drive>:\etc`. A measured field there is a fabrication,
  // so the target keeps only its pure facts.
  it('emits no exists/empty/mtime for `/etc/...` (and never probes it)', async () => {
    const probed: string[] = []
    const probe: RedirectProbe = {
      async lstat(path) {
        probed.push(path)
        throw enoent(path)
      },
      async realpath(path) {
        return path
      }
    }
    const result = await captureRedirects(
      'echo x > /etc/gitconfig',
      { cwd: 'c:/proj', tempDirs: [] },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).toEqual({
      targets: ['/etc/gitconfig'],
      allInScope: false,
      outOfScope: [{ path: '/etc/gitconfig' }],
      unresolvable: [],
      protectedHits: []
    })
    expect(probed).toEqual([])
  })

  it('still measures the folded `/tmp` spelling and drive-rooted paths on win32', async () => {
    const probed: string[] = []
    const probe: RedirectProbe = {
      async lstat(path) {
        probed.push(path)
        throw enoent(path)
      },
      async realpath(path) {
        return path
      }
    }
    const scope = { cwd: 'c:/proj', tempDirs: ['c:/user-temp', '/tmp'], shell: 'posix' as const }
    await captureRedirects('echo x > /tmp/scratch.log', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    await captureRedirects(
      'echo x > d:/_scratch/out.log',
      { cwd: 'c:/proj', tempDirs: [] },
      {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe
      }
    )
    expect(probed).toContain('c:/user-temp/scratch.log')
    expect(probed).toContain('d:/_scratch/out.log')
  })
})

describe('captureRedirects — one resolved path, two spellings (exit review N3)', () => {
  // `../out/x` and `../out/lnk/../x` share the resolved path; the second goes
  // through a link. If the plain spelling is measured LAST, its `exists:false`
  // used to replace the linked reading's `symlinked`.
  const entries: Record<string, Entry> = {
    'c:/out': { type: 'dir' },
    'c:/out/lnk': { type: 'symlink', target: 'c:/other/sub' },
    'c:/other': { type: 'dir' },
    'c:/other/sub': { type: 'dir' }
  }

  /** Defer the SECOND lstat of the shared path: with the plain spelling second, that is the plain one. */
  function orderedProbe(): RedirectProbe {
    const base = fakeProbe({ entries })
    let calls = 0
    return {
      async lstat(path) {
        if (path === 'c:/out/x' && ++calls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        return base.lstat(path)
      },
      realpath: (path) => base.realpath(path)
    }
  }

  it('never lets a plain reading erase a symlinked one (plain finishes last)', async () => {
    const result = await captureRedirects(
      'echo k > ../out/lnk/../x; echo a > ../out/x',
      { cwd: 'c:/proj', tempDirs: [], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'win32', probe: orderedProbe() }
    )
    // Both spellings resolve to the linked path, so both are reported there.
    expect(result?.symlinked?.slice().sort()).toEqual(['../out/lnk/../x', '../out/x'].sort())
    expect(result?.outOfScope).toEqual([])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps the symlinked reading whichever order the two targets are written in', async () => {
    for (const command of [
      'echo a > ../out/x; echo k > ../out/lnk/../x',
      'echo k > ../out/lnk/../x; echo a > ../out/x'
    ]) {
      const result = await captureRedirects(
        command,
        { cwd: 'c:/proj', tempDirs: [], shell: 'posix' },
        { sessionStartMs: SESSION_START, platform: 'win32', probe: fakeProbe({ entries }) }
      )
      expect(result?.symlinked?.slice().sort()).toEqual(['../out/lnk/../x', '../out/x'].sort())
      expect(result?.outOfScope).toEqual([])
    }
  })
})

describe('captureRedirects — a link ABOVE the `..` cancels out (exit review N6)', () => {
  it('does not flag an ancestor junction above the cancelled component', async () => {
    // The cwd is reached through a junction: `sub/../x` still lands at
    // `<real cwd>/x`, so nothing moved. The old check compared realpath(prefix)
    // with the lexical prefix and flagged it.
    const probe = fakeProbe({
      entries: {
        '/work/jroot': { type: 'dir' },
        '/work/jroot/proj': { type: 'dir' },
        '/work/jroot/proj/sub': { type: 'dir' },
        '/work/real/proj/sub': { type: 'dir' }
      },
      real: {
        '/work/jroot': '/work/real',
        '/work/jroot/proj': '/work/real/proj',
        '/work/jroot/proj/sub': '/work/real/proj/sub',
        '/work/real/proj': '/work/real/proj'
      }
    })
    const result = await captureRedirects(
      'echo x > sub/../x.txt',
      { cwd: '/work/jroot/proj', tempDirs: [], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'linux', probe }
    )
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(true)
  })

  it('does not flag the win32 `/tmp` fold as a link before `..`', async () => {
    const TEMP = 'c:/Users/me/AppData/Local/Temp'
    const probe: RedirectProbe = {
      async lstat(path) {
        const entry = path === `${TEMP}/sb` ? ({ type: 'dir' } as Entry) : undefined
        if (!entry) throw enoent(path)
        return statOf(entry)
      },
      async realpath(path) {
        if (path === '/tmp') throw enoent(path)
        return path
      }
    }
    const result = await captureRedirects(
      'echo k > /tmp/sb/../new.txt',
      { cwd: 'c:/proj', tempDirs: ['/tmp', TEMP], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(true)
  })

  it('still flags a link that IS the component before `..`', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/sub': { type: 'symlink', target: '/outside/sub' } }
    })
    const result = await capture('echo x > sub/../x', probe)
    expect(result?.symlinked).toEqual(['sub/../x'])
  })
})

describe('captureRedirects — a temp hint must stay inside its temp root (exit review N7)', () => {
  const TEMP = 'c:/user-temp'
  const scope = {
    cwd: 'c:/repo',
    tempDirs: [TEMP],
    shell: 'posix' as const,
    tempVars: { TMPDIR: TEMP }
  }
  const captureHint = (probe: RedirectProbe) =>
    captureRedirects('echo x > $TMPDIR/link/thesis.docx', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })

  it('drops the hint when the named parent resolves OUT of the temp root', async () => {
    const probe = fakeProbe({
      entries: {
        [`${TEMP}/link`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' },
        'c:/docs/thesis.docx': { type: 'file', size: 10 }
      }
    })
    const result = await captureHint(probe)
    expect(result?.unresolvable).toEqual(['$TMPDIR/link/thesis.docx'])
    expect(result?.allInScope).toBe(false)
    expect(result).not.toHaveProperty('tempVarTargets')
  })

  it('keeps the hint when the named parent resolves inside the temp root', async () => {
    const probe = fakeProbe({
      entries: {
        [`${TEMP}/link`]: { type: 'symlink', target: `${TEMP}/docs` },
        [`${TEMP}/docs`]: { type: 'dir' }
      }
    })
    const result = await captureHint(probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/link/thesis.docx', path: `${TEMP}/link/thesis.docx` }
    ])
  })

  it('keeps the hint for a parent that does not exist yet', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureHint(probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/link/thesis.docx', path: `${TEMP}/link/thesis.docx` }
    ])
  })

  it('drops the hint when the parent cannot be measured and is not known absent', async () => {
    const parent = `${TEMP}/link`
    const probe = fakeProbe({
      entries: { [TEMP]: { type: 'dir' } },
      failRealpath: [parent],
      failLstat: [parent]
    })
    const result = await captureHint(probe)
    expect(result).not.toHaveProperty('tempVarTargets')
  })
})

describe('captureRedirects — failures are absence, never a fact', () => {
  it('emits no field when lstat fails for a reason other than ENOENT', async () => {
    const probe = fakeProbe({ failLstat: ['/work/_scratch/b.txt'] })
    const result = await capture('echo x > ../_scratch/b.txt', probe)
    expect(result).toEqual({
      targets: ['../_scratch/b.txt'],
      allInScope: false,
      outOfScope: [{ path: '/work/_scratch/b.txt' }],
      unresolvable: [],
      protectedHits: []
      // `allInScope: false` is explained: containment could not be established.
    })
  })

  it('withholds a clean scope when the parent realpath cannot be established', async () => {
    // A parent whose physical identity is unknown is not evidence of an ordinary
    // in-scope write: the clean claim is withheld (exit review R3/R5), while no
    // `symlinked` fact is fabricated.
    const probe = fakeProbe({ failRealpath: ['/work/repo'] })
    const result = await capture('echo x > build.log', probe)
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: [],
      unmeasured: ['build.log']
    })
    expect(result?.symlinked).toBeUndefined()
  })

  it('falls back to the pure result when the deadline expires', async () => {
    const probe = fakeProbe({ hangLstat: ['/work/_scratch/slow.log'] })
    const result = await capture('echo x > ../_scratch/slow.log', probe, { timeoutMs: 10 })
    expect(result).toEqual({
      targets: ['../_scratch/slow.log'],
      allInScope: false,
      outOfScope: [{ path: '/work/_scratch/slow.log' }],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('exposes the callers’ default budget', () => {
    expect(REDIRECT_CAPTURE_TIMEOUT_MS).toBe(400)
  })
})

describe('captureRedirects — scope and shape', () => {
  it('returns null when the command has no file redirect', async () => {
    expect(await capture('ls -la', fakeProbe())).toBeNull()
  })

  it('does not measure an in-scope regular file (nothing to report there)', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/build.log': { type: 'file', size: 0, mtimeMs: SESSION_START + 1 } }
    })
    const result = await capture('echo x > build.log', probe)
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('checks the drive root itself as the parent of a win32 drive-root target', async () => {
    const realpathCalls: string[] = []
    const probe: RedirectProbe = {
      async lstat(path) {
        throw enoent(path)
      },
      async realpath(path) {
        realpathCalls.push(path)
        if (path === 'd:/') return 'd:/'
        throw new Error(`unexpected realpath('${path}')`)
      }
    }
    const result = await captureRedirects(
      'echo x > d:/x.log',
      { cwd: 'd:/', tempDirs: [] },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result?.allInScope).toBe(true)
    expect(realpathCalls).toContain('d:/')
    expect(realpathCalls).not.toContain('d:')
  })

  it('reports a protected in-scope target through the scanner and keeps it in scope-free form', async () => {
    const probe = fakeProbe({ entries: { '/work/repo/.git': { type: 'dir' } } })
    const result = await capture('echo x > .git/config', probe)
    expect(result?.protectedHits).toEqual(['.git'])
    expect(result?.allInScope).toBe(false)
    expect(result?.outOfScope).toEqual([])
  })
})

describe('captureRedirects — an in-scope parent link into a protected dir (exit review R1)', () => {
  // `ordinary/` is a link INSIDE the tree onto a protected directory, and the
  // target file may or may not exist. The lexical spelling has no protected
  // component; the old in-scope branch only asked "is the real parent under the
  // root?" and threw the real path away, so this was a clean `allInScope:true`.
  const fixtures: Array<[string, string, string, string]> = [
    ['.claude', '/work/repo/.claude', 'settings.json', '.claude'],
    ['.git/hooks', '/work/repo/.git/hooks', 'pre-commit', '.git'],
    ['.aws', '/work/repo/.aws', 'credentials', '.aws']
  ]
  for (const [label, real, file, hit] of fixtures) {
    for (const exists of [true, false]) {
      it(`${label} through the parent link, ${exists ? 'existing' : 'absent'} file`, async () => {
        const target = `/work/repo/ordinary/${file}`
        const entries: Record<string, Entry> = {
          '/work/repo/ordinary': { type: 'dir' },
          ...(exists ? { [target]: { type: 'file', size: 3, mtimeMs: SESSION_START } } : {})
        }
        const probe = fakeProbe({ entries, real: { '/work/repo/ordinary': real } })
        const result = await capture(`echo x > ordinary/${file}`, probe)
        expect(result?.protectedHits).toEqual([hit])
        expect(result?.symlinked).toEqual([`ordinary/${file}`])
        expect(result?.allInScope).toBe(false)
        expect(result?.outOfScope).toEqual([])
      })
    }
  }

  it('keeps an unprotected parent link that stays inside the root ordinary', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/ordinary': { type: 'dir' },
        '/work/repo/logs': { type: 'dir' }
      },
      real: { '/work/repo/ordinary': '/work/repo/logs' }
    })
    const result = await capture('echo x > ordinary/x.log', probe)
    expect(result).toEqual({
      targets: ['ordinary/x.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
    expect(result?.symlinked).toBeUndefined()
  })
})

describe('captureRedirects — win32 `/tmp` follows the dialect (exit review R2)', () => {
  const USER_TEMP = 'c:/user-temp'
  const scopeFor = (shell: 'posix' | 'powershell' | undefined) => ({
    cwd: 'd:/repo',
    tempDirs: [USER_TEMP, '/tmp'],
    shell
  })

  function recording(base: RedirectProbe, calls: string[]): RedirectProbe {
    return {
      lstat: (path) => {
        calls.push(`lstat ${path}`)
        return base.lstat(path)
      },
      realpath: (path) => {
        calls.push(`realpath ${path}`)
        return base.realpath(path)
      }
    }
  }

  async function measure(
    shell: 'posix' | 'powershell' | undefined,
    entries: Record<string, Entry>
  ): Promise<{ result: Awaited<ReturnType<typeof captureRedirects>>; calls: string[] }> {
    const calls: string[] = []
    const result = await captureRedirects('echo x > /tmp/alias/out.txt', scopeFor(shell), {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe: recording(fakeProbe({ entries }), calls)
    })
    return { result, calls }
  }

  // The two locations carry DIFFERENT contents: usertemp's `alias` is ordinary,
  // drive-root `d:/tmp/alias` is a junction that leaves scope.
  const usertempOrdinary: Record<string, Entry> = {
    [`${USER_TEMP}/alias`]: { type: 'dir' },
    'd:/tmp/alias': { type: 'symlink', target: 'c:/outside' }
  }
  const driveRootOrdinary: Record<string, Entry> = {
    [`${USER_TEMP}/alias`]: { type: 'symlink', target: 'c:/outside' },
    'd:/tmp/alias': { type: 'dir' }
  }

  it('posix measures /tmp through the usertemp mount, and never asks drive-root /tmp', async () => {
    const { result, calls } = await measure('posix', usertempOrdinary)
    expect(result?.allInScope).toBe(true)
    expect(result?.symlinked).toBeUndefined()
    expect(calls).toContain(`realpath ${USER_TEMP}/alias`)
    expect(calls).not.toContain('realpath d:/tmp/alias')
  })

  it('powershell measures /tmp at <shell drive>:/tmp, and never asks usertemp', async () => {
    const { result, calls } = await measure('powershell', usertempOrdinary)
    expect(result?.symlinked).toEqual(['/tmp/alias/out.txt'])
    expect(result?.allInScope).toBe(false)
    expect(calls).toContain('realpath d:/tmp/alias')
    expect(calls).not.toContain(`realpath ${USER_TEMP}/alias`)
  })

  it('the same fixture swapped: powershell stays ordinary, posix reports the link', async () => {
    const ps = await measure('powershell', driveRootOrdinary)
    expect(ps.result?.allInScope).toBe(true)
    expect(ps.result?.symlinked).toBeUndefined()

    const posix = await measure('posix', driveRootOrdinary)
    expect(posix.result?.symlinked).toEqual(['/tmp/alias/out.txt'])
    expect(posix.result?.allInScope).toBe(false)
  })

  it('an unknown dialect probes BOTH readings and keeps the worse result', async () => {
    const unknown = await measure(undefined, usertempOrdinary)
    expect(unknown.calls).toContain(`realpath ${USER_TEMP}/alias`)
    expect(unknown.calls).toContain('realpath d:/tmp/alias')
    expect(unknown.result?.symlinked).toEqual(['/tmp/alias/out.txt'])
    expect(unknown.result?.allInScope).toBe(false)

    // Either location being clean is not enough to call the write clean.
    const swapped = await measure(undefined, driveRootOrdinary)
    expect(swapped.result?.symlinked).toEqual(['/tmp/alias/out.txt'])
    expect(swapped.result?.allInScope).toBe(false)
  })

  it('uses the drive of the effective SHELL cwd, not of the session cwd', async () => {
    const calls: string[] = []
    const result = await captureRedirects(
      'echo x > /tmp/alias/out.txt',
      { cwd: 'c:/repo', shellCwd: 'd:/repo', tempDirs: [USER_TEMP, '/tmp'], shell: 'powershell' },
      {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe: recording(fakeProbe({ entries: usertempOrdinary }), calls)
      }
    )
    expect(result?.symlinked).toEqual(['/tmp/alias/out.txt'])
    expect(calls).toContain('realpath d:/tmp/alias')
    expect(calls).not.toContain('realpath c:/tmp/alias')
  })
})

describe('captureRedirects — a non-ENOENT lstat error still runs the link checks (exit review NIT)', () => {
  it('reports a protected in-scope parent link even though lstat failed', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/lnk': { type: 'dir' } },
      real: { '/work/repo/lnk': '/work/repo/.claude' },
      failLstat: ['/work/repo/lnk/keys']
    })
    const result = await capture('echo k > lnk/keys', probe)
    expect(result?.symlinked).toEqual(['lnk/keys'])
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.allInScope).toBe(false)
  })

  it('reports an out-of-tree parent link even though lstat failed (reviewer P7 shape)', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo/lnk': { type: 'dir' } },
      real: { '/work/repo/lnk': '/home/u/.ssh' },
      failLstat: ['/work/repo/lnk/authorized_keys']
    })
    const result = await capture('echo k > lnk/authorized_keys', probe)
    expect(result?.symlinked).toEqual(['lnk/authorized_keys'])
    expect(result?.allInScope).toBe(false)
    // Never fabricated: no measured field for a target lstat could not read.
    expect(result?.outOfScope).toEqual([])
  })
})

describe('captureRedirects — a link in the cwd path is not a protected component (exit review R1)', () => {
  it('relativises the real target against the REAL cwd, not its ancestors', async () => {
    // The session cwd is reached through a junction INTO a `.claude` tree. An
    // ordinary in-scope write must not become a `.claude` hit just because the
    // real path names it — that would send every write in such a worktree to
    // full review.
    const probe = fakeProbe({
      entries: {
        '/work/wt': { type: 'dir' },
        '/work/wt/build.log': { type: 'file', size: 3, mtimeMs: SESSION_START }
      },
      real: { '/work/wt': '/mnt/.claude/worktrees/wt' }
    })
    const result = await captureRedirects(
      'echo x > build.log',
      { cwd: '/work/wt', tempDirs: [] },
      {
        sessionStartMs: SESSION_START,
        platform: 'linux',
        probe
      }
    )
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
    expect(result?.symlinked).toBeUndefined()
  })

  it('still reports a protected real target under such a cwd', async () => {
    const probe = fakeProbe({
      entries: { '/work/wt/ordinary': { type: 'dir' } },
      real: {
        '/work/wt': '/mnt/.claude/worktrees/wt',
        '/work/wt/ordinary': '/mnt/.claude/worktrees/wt/.git'
      }
    })
    const result = await captureRedirects(
      'echo x > ordinary/config',
      { cwd: '/work/wt', tempDirs: [] },
      {
        sessionStartMs: SESSION_START,
        platform: 'linux',
        probe
      }
    )
    expect(result?.protectedHits).toEqual(['.git'])
    expect(result?.symlinked).toEqual(['ordinary/config'])
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — exit-fix4 R1: temp hint physical containment', () => {
  const TEMP = 'c:/user-temp'
  const scope = {
    cwd: 'c:/repo',
    tempDirs: [TEMP],
    shell: 'posix' as const,
    tempVars: { TMPDIR: TEMP }
  }
  const captureHint = (command: string, probe: RedirectProbe) =>
    captureRedirects(command, scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })

  it('drops the hint when the FINAL file is a link out of temp', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/leaf.txt`]: { type: 'symlink', target: 'c:/docs/thesis.txt' },
        'c:/docs/thesis.txt': { type: 'file', size: 10 }
      }
    })
    const result = await captureHint('echo x > $TMPDIR/leaf.txt', probe)
    expect(result?.unresolvable).toEqual(['$TMPDIR/leaf.txt'])
    expect(result?.allInScope).toBe(false)
    expect(result).not.toHaveProperty('tempVarTargets')
  })

  it('drops the hint for link/.. traversal whose collapsed parent looks safe', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/jump`]: { type: 'symlink', target: 'c:/docs/sub' },
        'c:/docs/sub': { type: 'dir' }
      }
    })
    const result = await captureHint('echo x > $TMPDIR/jump/../thesis.txt', probe)
    expect(result?.unresolvable).toEqual(['$TMPDIR/jump/../thesis.txt'])
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps a benign final file link that resolves inside temp', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/leaf.txt`]: { type: 'symlink', target: `${TEMP}/inside/thesis.txt` },
        [`${TEMP}/inside`]: { type: 'dir' }
      }
    })
    const result = await captureHint('echo x > $TMPDIR/leaf.txt', probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/leaf.txt', path: `${TEMP}/leaf.txt` }
    ])
  })

  it('keeps the hint for an ordinary new scratch file control', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureHint('echo x > $TMPDIR/new-scratch.txt', probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/new-scratch.txt', path: `${TEMP}/new-scratch.txt` }
    ])
  })
})

describe('captureRedirects — exit-fix4 R2: raw link/.. beats the safe leaf link', () => {
  const entries: Record<string, Entry> = {
    '/work/proj/jump': { type: 'symlink', target: '/work/docs/sub' },
    '/work/docs/sub': { type: 'dir' },
    '/work/proj/x.txt': { type: 'symlink', target: '/work/proj/inside.txt' },
    '/work/proj/inside.txt': { type: 'file', size: 4 }
  }
  const scope = { cwd: '/work/proj', tempDirs: [], shell: 'posix' as const }

  it('does not let the safe lexical leaf link hide an escaping cancelled component', async () => {
    const result = await captureRedirects('printf physically-outside > jump/../x.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'linux',
      probe: fakeProbe({ entries })
    })
    expect(result?.symlinked).toEqual(['jump/../x.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('still treats a safe leaf link at the collapsed path as an ordinary in-scope write', async () => {
    const result = await captureRedirects('echo x > x.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'linux',
      probe: fakeProbe({ entries })
    })
    expect(result?.symlinked).toBeUndefined()
    expect(result?.allInScope).toBe(true)
  })
})

describe('captureRedirects — exit-fix4 R3: missing descendants under a link', () => {
  it('resolves the nearest existing ancestor and reports the protected real target', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/ordinary': { type: 'dir' },
        '/work/repo/.claude': { type: 'dir' }
      },
      real: { '/work/repo/ordinary': '/work/repo/.claude' }
    })
    const result = await capture(
      'mkdir -p ordinary/new; printf probe-settings > ordinary/new/settings.json',
      probe
    )
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.symlinked).toEqual(['ordinary/new/settings.json'])
    expect(result?.allInScope).toBe(false)
  })

  it('leaves an ordinary new directory tree in scope (no fabricated link finding)', async () => {
    const probe = fakeProbe({ entries: { '/work/repo': { type: 'dir' } } })
    const result = await capture('mkdir -p fresh/new; echo x > fresh/new/file.txt', probe)
    expect(result).toEqual({
      targets: ['fresh/new/file.txt'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
    expect(result?.symlinked).toBeUndefined()
  })

  it('drops a temp hint for a missing child below an escaping temp junction', async () => {
    const TEMP = 'c:/user-temp'
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/jump`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' }
      }
    })
    const result = await captureRedirects(
      'echo x > $TMPDIR/jump/new/thesis.txt',
      { cwd: 'c:/repo', tempDirs: [TEMP], shell: 'posix', tempVars: { TMPDIR: TEMP } },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — exit-fix4 R4: per-target PowerShell drive state', () => {
  const USER_TEMP = 'c:/user-temp'
  const scopeFor = (shell: 'posix' | 'powershell' | undefined) => ({
    cwd: 'd:/repo',
    tempDirs: [USER_TEMP, '/tmp'],
    shell
  })

  function probeWith(): RedirectProbe {
    return fakeProbe({
      entries: {
        [`${USER_TEMP}/alias`]: { type: 'dir' },
        'd:/tmp/alias': { type: 'dir' },
        'c:/tmp/alias': { type: 'symlink', target: 'c:/outside' },
        'c:/outside': { type: 'dir' }
      }
    })
  }

  async function captureCd(
    command: string,
    shell: 'posix' | 'powershell' | undefined
  ): Promise<Awaited<ReturnType<typeof captureRedirects>>> {
    return captureRedirects(command, scopeFor(shell), {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe: probeWith()
    })
  }

  it('follows a successful cd to C: for a rooted /tmp target (powershell)', async () => {
    const result = await captureCd('cd C:/Windows && echo x > /tmp/alias/thesis.txt', 'powershell')
    expect(result?.symlinked).toEqual(['/tmp/alias/thesis.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps every drive a failed or unconditional cd can leave (; form)', async () => {
    const result = await captureCd('cd C:/Windows; echo x > /tmp/alias/thesis.txt', 'powershell')
    expect(result?.symlinked).toEqual(['/tmp/alias/thesis.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps both shell readings and drives when the dialect is unknown', async () => {
    const result = await captureCd('cd C:/Windows && echo x > /tmp/alias/thesis.txt', undefined)
    expect(result?.symlinked).toEqual(['/tmp/alias/thesis.txt'])
    expect(result?.allInScope).toBe(false)
  })

  it('withholds a clean scope when the PowerShell drive cannot be established', async () => {
    const result = await captureRedirects(
      'echo x > /tmp/alias/thesis.txt',
      { cwd: 'd:/repo', shellCwd: null, tempDirs: [USER_TEMP, '/tmp'], shell: 'powershell' },
      { sessionStartMs: SESSION_START, platform: 'win32', probe: probeWith() }
    )
    expect(result?.allInScope).toBe(false)
    expect(result?.symlinked).toBeUndefined()
  })

  it('does not restore an unsafe temp hint because a /tmp target ran first', async () => {
    const TEMP = 'c:/user-temp'
    const probe = fakeProbe({
      entries: {
        [`${TEMP}/alias`]: { type: 'dir' },
        'd:/tmp/alias': { type: 'dir' },
        [`${TEMP}/evil`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' }
      }
    })
    const result = await captureRedirects(
      'echo k > /tmp/alias/out.txt; echo x > $TMPDIR/evil/thesis.txt',
      { cwd: 'c:/repo', tempDirs: [TEMP, '/tmp'], shell: 'posix', tempVars: { TMPDIR: TEMP } },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — exit-fix4 R5: conservative deadline fallback', () => {
  function delayed(probe: RedirectProbe, ms: number): RedirectProbe {
    return {
      lstat: (path) => probe.lstat(path),
      async realpath(path) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return probe.realpath(path)
      }
    }
  }

  it('never restores a temp hint when the 400 ms budget expires', async () => {
    const TEMP = 'c:/user-temp'
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/link`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' }
      }
    })
    const result = await captureRedirects(
      'echo x > $TMPDIR/link/thesis.docx',
      { cwd: 'c:/repo', tempDirs: [TEMP], shell: 'posix', tempVars: { TMPDIR: TEMP } },
      {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe: delayed(probe, 150),
        timeoutMs: REDIRECT_CAPTURE_TIMEOUT_MS
      }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('never restores a clean scope for a protected junction when the deadline expires', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/repo/ordinary': { type: 'dir' },
        '/work/repo/.claude': { type: 'dir' }
      },
      real: { '/work/repo/ordinary': '/work/repo/.claude' }
    })
    const result = await capture('echo x > ordinary/settings.json', delayed(probe, 150), {
      timeoutMs: REDIRECT_CAPTURE_TIMEOUT_MS
    })
    expect(result?.allInScope).toBe(false)
  })

  it('keeps negative evidence established before the deadline', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/_scratch/link.log': { type: 'symlink', target: '/home/dev/.bashrc' },
        '/home/dev/.bashrc': { type: 'file', size: 10 }
      },
      hangLstat: ['/work/_scratch/slow.log']
    })
    const result = await capture(
      'echo x > ../_scratch/link.log; echo y > ../_scratch/slow.log',
      probe,
      { timeoutMs: 30 }
    )
    expect(result?.symlinked).toEqual(['../_scratch/link.log'])
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — exit-fix4 R5: unreadable leaf and thrown measurement', () => {
  it('does not clear an unreadable leaf just because its parent is benign', async () => {
    const probe = fakeProbe({
      entries: { '/work/repo': { type: 'dir' } },
      failLstat: ['/work/repo/build.log']
    })
    const result = await capture('echo x > build.log', probe)
    expect(result?.allInScope).toBe(false)
    // No fabricated link fact: the leaf's identity is simply unknown.
    expect(result?.symlinked).toBeUndefined()
  })

  it('does not restore pure allInScope when measureTarget throws', async () => {
    const probe: RedirectProbe = {
      async lstat() {
        return {
          isSymbolicLink() {
            throw new Error('stat exploded')
          },
          isFile() {
            return true
          }
        }
      },
      async realpath(path) {
        return path
      }
    }
    const result = await capture('echo x > build.log', probe)
    expect(result?.allInScope).toBe(false)
  })
})

describe('captureRedirects — exit-fix4 R1/R5: hint mapping and failed traversal', () => {
  it('maps a TMPDIR=/tmp POSIX hint through the host temp mount (not process-drive /tmp)', async () => {
    const TEMP = 'c:/Temp'
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/leaf.txt`]: { type: 'symlink', target: 'c:/docs/thesis.txt' },
        'c:/docs/thesis.txt': { type: 'file', size: 5 },
        'd:/tmp/leaf.txt': { type: 'dir' }
      }
    })
    const scope = {
      cwd: 'c:/repo',
      tempDirs: ['/tmp', 'c:/Temp'],
      shell: 'posix' as const,
      tempVars: { TMPDIR: '/tmp' }
    }
    const escaping = await captureRedirects('echo x > $TMPDIR/leaf.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(escaping).not.toHaveProperty('tempVarTargets')
    expect(escaping?.allInScope).toBe(false)

    const clean = await captureRedirects('echo x > $TMPDIR/newfine.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(clean?.tempVarTargets).toEqual([
      { target: '$TMPDIR/newfine.txt', path: '/tmp/newfine.txt' }
    ])

    const unrelated = await captureRedirects('echo x > /tmp/other.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })
    expect(unrelated?.allInScope).toBe(true)
  })

  it('drops a hint when a prefix before `..` exists but realpath is unestablished', async () => {
    const TEMP = 'c:/user-temp'
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/jump`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' }
      },
      failRealpath: [`${TEMP}/jump`]
    })
    const result = await captureRedirects(
      'echo x > $TMPDIR/jump/../thesis.txt',
      { cwd: 'c:/repo', tempDirs: [TEMP], shell: 'posix', tempVars: { TMPDIR: TEMP } },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('requires review for an unestablished prefix before `..` without fabricating a link', async () => {
    const probe = fakeProbe({
      entries: {
        '/work/proj/jump': { type: 'symlink', target: '/work/docs/sub' },
        '/work/docs/sub': { type: 'dir' }
      },
      failRealpath: ['/work/proj/jump']
    })
    const result = await captureRedirects(
      'printf > jump/../x.txt',
      { cwd: '/work/proj', tempDirs: [], shell: 'posix' },
      { sessionStartMs: SESSION_START, platform: 'linux', probe }
    )
    expect(result?.allInScope).toBe(false)
    expect(result?.symlinked).toBeUndefined()
  })
})

describe('captureRedirects … exit-fix4 R4/R1: rooted PowerShell hints keep drive ambiguity', () => {
  const TEMP = 'c:/user-temp'

  it('checks a rooted hint on the single known PowerShell drive', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        'd:/tmp/leaf.txt': { type: 'symlink', target: 'c:/docs/thesis.txt' },
        'c:/docs/thesis.txt': { type: 'file', size: 3 }
      }
    })
    const result = await captureRedirects(
      'echo x > $env:TEMP/leaf.txt',
      {
        cwd: 'd:/repo',
        tempDirs: [TEMP, '/tmp'],
        shell: 'powershell',
        tempVars: { TEMP: '/tmp' }
      },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('withholds an ambiguous rooted hint rather than trusting the start drive', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        'c:/tmp/leaf.txt': { type: 'symlink', target: 'c:/docs/thesis.txt' },
        'd:/tmp/leaf.txt': { type: 'dir' },
        'c:/docs/thesis.txt': { type: 'file', size: 3 }
      }
    })
    const result = await captureRedirects(
      'cd C:/Windows; echo x > $env:TEMP/leaf.txt',
      {
        cwd: 'd:/repo',
        tempDirs: [TEMP, '/tmp'],
        shell: 'powershell',
        tempVars: { TEMP: '/tmp' }
      },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps a clean rooted hint when the single PowerShell drive is safe', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureRedirects(
      'echo x > $env:TEMP/safe.txt',
      {
        cwd: 'd:/repo',
        tempDirs: [TEMP, '/tmp'],
        shell: 'powershell',
        tempVars: { TEMP: '/tmp' }
      },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(result?.tempVarTargets).toEqual([
      { target: '$env:TEMP/safe.txt', path: '/tmp/safe.txt' }
    ])
  })
})

describe('captureRedirects — exit-fix4 R1/N7: hint spelling provenance', () => {
  const TEMP = 'c:/user-temp'
  const scope = {
    cwd: 'c:/repo',
    tempDirs: [TEMP],
    shell: 'posix' as const,
    tempVars: { TMPDIR: TEMP }
  }
  const captureHint = (command: string, probe: RedirectProbe) =>
    captureRedirects(command, scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })

  const escaping = () =>
    fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/evil`]: { type: 'symlink', target: 'c:/docs' },
        [`${TEMP}/docs`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' },
        'c:/docs/thesis.txt': { type: 'file', size: 3 }
      }
    })

  it('drops an unquoted POSIX backslash hint (shell removes the backslash)', async () => {
    const result = await captureHint('echo x > $TMPDIR/ev\\il/thesis.txt', escaping())
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('drops a glob suffix hint', async () => {
    const result = await captureHint('echo x > $TMPDIR/ev*/thesis.txt', escaping())
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('drops a hint whose suffix is another variable', async () => {
    const result = await captureHint(
      'part=../docs; echo escaped > $TMPDIR/$part/thesis.txt',
      escaping()
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('drops a single-quoted leading reference (literal, never expanded)', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        $TMPDIR: { type: 'dir' },
        '$TMPDIR/thesis.txt': { type: 'file', size: 3 }
      }
    })
    const result = await captureHint("printf literal > '$TMPDIR/thesis.txt'", probe)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('drops an escaped leading reference (literal, never expanded)', async () => {
    const result = await captureHint('printf literal > \\$TMPDIR/thesis.txt', escaping())
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('drops a double-quoted escaped leading reference (literal)', async () => {
    const result = await captureHint('printf literal > "\\$TMPDIR/thesis.txt"', escaping())
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps an ordinary double-quoted expanding reference control', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureHint('printf > "$TMPDIR/new-scratch.txt"', probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/new-scratch.txt', path: `${TEMP}/new-scratch.txt` }
    ])
  })

  it('keeps a static binding control and preserves PowerShell native separators', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const posixBound = await captureHint('T=$TMPDIR; printf > $T/new-scratch.txt', probe)
    expect(posixBound?.tempVarTargets).toEqual([
      { target: '$T/new-scratch.txt', path: `${TEMP}/new-scratch.txt` }
    ])

    const ps = await captureRedirects(
      'echo x > "$env:TEMP\\new-scratch.txt"',
      {
        cwd: 'c:/repo',
        tempDirs: [TEMP],
        shell: 'powershell',
        tempVars: { TEMP }
      },
      { sessionStartMs: SESSION_START, platform: 'win32', probe }
    )
    expect(ps?.tempVarTargets).toEqual([
      { target: '$env:TEMP\\new-scratch.txt', path: `${TEMP}/new-scratch.txt` }
    ])
  })
})

describe('captureRedirects — exit-fix4 R1/N7: duplicate hints and binding provenance', () => {
  const TEMP = 'c:/user-temp'
  const posixScope = {
    cwd: 'c:/repo',
    tempDirs: [TEMP],
    shell: 'posix' as const,
    tempVars: { TMPDIR: TEMP }
  }
  const posixProbe = () =>
    fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/evil`]: { type: 'symlink', target: 'c:/docs' },
        'c:/docs': { type: 'dir' },
        'c:/docs/thesis.txt': { type: 'file', size: 3 }
      }
    })
  const capturePosix = (command: string, probe = posixProbe()) =>
    captureRedirects(command, posixScope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe
    })

  it('vetoes the hint when a later occurrence is single-quoted (both orders)', async () => {
    for (const command of [
      "echo ok > $TMPDIR/thesis.txt; echo bad > '$TMPDIR/thesis.txt'",
      "echo bad > '$TMPDIR/thesis.txt'; echo ok > $TMPDIR/thesis.txt"
    ]) {
      const result = await capturePosix(command)
      expect(result).not.toHaveProperty('tempVarTargets')
      expect(result?.allInScope).toBe(false)
    }
  })

  it('vetoes the hint for mixed empty/single quote reconstructions', async () => {
    const result = await capturePosix('echo bad > ""\'$TMPDIR/thesis.txt\'')
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps one hint when every occurrence is validated and identical', async () => {
    const result = await capturePosix('echo a > $TMPDIR/new.txt; echo b > $TMPDIR/new.txt')
    expect(result?.tempVarTargets).toEqual([{ target: '$TMPDIR/new.txt', path: `${TEMP}/new.txt` }])
  })

  it('drops a binding whose RHS is a double-quoted escaped literal', async () => {
    const command = String.raw`t="\$TMPDIR"; echo x > $t/thesis.txt`
    const result = await capturePosix(command)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it("drops a POSIX ANSI-quoted `$'TMPDIR'` literal reference", async () => {
    const result = await capturePosix(String.raw`echo x > $'TMPDIR'/thesis.txt`)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps a static unquoted binding control', async () => {
    const result = await capturePosix('t=$TMPDIR; echo x > $t/new-scratch.txt')
    expect(result?.tempVarTargets).toEqual([
      { target: '$t/new-scratch.txt', path: `${TEMP}/new-scratch.txt` }
    ])
  })

  it('drops a PowerShell spaced escaped binding RHS', async () => {
    const BT = String.fromCharCode(96)
    const command = `$t = "${BT}$env:TEMP"; echo x > $t/leaf.txt`
    const result = await captureRedirects(
      command,
      { cwd: 'c:/repo', tempDirs: [TEMP], shell: 'powershell', tempVars: { TEMP } },
      { sessionStartMs: SESSION_START, platform: 'win32', probe: posixProbe() }
    )
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })

  it('keeps a validated PowerShell inline writer hint', async () => {
    const result = await captureRedirects(
      'echo x | Out-File -LiteralPath:"$env:TEMP/new.txt"',
      { cwd: 'c:/repo', tempDirs: [TEMP], shell: 'powershell', tempVars: { TEMP } },
      { sessionStartMs: SESSION_START, platform: 'win32', probe: posixProbe() }
    )
    expect(result?.tempVarTargets).toEqual([
      { target: '$env:TEMP/new.txt', path: `${TEMP}/new.txt` }
    ])
  })

  it('drops a PowerShell duplicate hint when one drive reading is unsafe (both orders)', async () => {
    const TEMP_ROOT = 'c:/user-temp'
    const probe = fakeProbe({
      entries: {
        [TEMP_ROOT]: { type: 'dir' },
        'd:/tmp': { type: 'dir' },
        'c:/tmp': { type: 'dir' },
        'c:/tmp/leaf.txt': { type: 'symlink', target: 'c:/docs/thesis.txt' },
        'c:/docs': { type: 'dir' },
        'c:/docs/thesis.txt': { type: 'file', size: 3 }
      }
    })
    const scope = {
      cwd: 'd:/repo',
      tempDirs: [TEMP_ROOT, '/tmp'],
      shell: 'powershell' as const,
      tempVars: { TEMP: '/tmp' }
    }
    const capturePs = (command: string) =>
      captureRedirects(command, scope, {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe
      })

    // Each single occurrence is individually known: D: is safe, C: escapes.
    const safeOnly = await capturePs('echo safe > $env:TEMP/leaf.txt')
    expect(safeOnly?.tempVarTargets).toEqual([
      { target: '$env:TEMP/leaf.txt', path: '/tmp/leaf.txt' }
    ])
    const badOnly = await capturePs('cd C:/Windows && echo bad > $env:TEMP/leaf.txt')
    expect(badOnly).not.toHaveProperty('tempVarTargets')
    expect(badOnly?.allInScope).toBe(false)

    for (const command of [
      'echo safe > $env:TEMP/leaf.txt; cd C:/Windows && echo bad > $env:TEMP/leaf.txt',
      'cd C:/Windows && echo bad > $env:TEMP/leaf.txt; cd D:/repo && echo safe > $env:TEMP/leaf.txt'
    ]) {
      const result = await capturePs(command)
      expect(result).not.toHaveProperty('tempVarTargets')
      expect(result?.allInScope).toBe(false)
    }
  })
})

describe('captureRedirects — exit-fix4 R1: protected temp hint destinations', () => {
  const TEMP = 'c:/user-temp'
  const scope = {
    cwd: 'c:/repo',
    tempDirs: [TEMP],
    shell: 'posix' as const,
    tempVars: { TMPDIR: TEMP }
  }
  const captureHint = (command: string, probe: RedirectProbe, extra = {}) =>
    captureRedirects(command, scope, {
      sessionStartMs: SESSION_START,
      platform: 'win32',
      probe,
      ...extra
    })

  it('omits a hint whose final file link lands on temp/.claude', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/.claude`]: { type: 'dir' },
        [`${TEMP}/.claude/settings.json`]: { type: 'file', size: 4 },
        [`${TEMP}/leaf.txt`]: { type: 'symlink', target: `${TEMP}/.claude/settings.json` }
      }
    })
    const result = await captureHint('echo x > $TMPDIR/leaf.txt', probe)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.unresolvable).toEqual(['$TMPDIR/leaf.txt'])
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.allInScope).toBe(false)
  })

  it('omits a hint for a missing child below a temp/ordinary -> .claude junction', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/.claude`]: { type: 'dir' },
        [`${TEMP}/ordinary`]: { type: 'symlink', target: `${TEMP}/.claude` }
      }
    })
    const result = await captureHint('echo x > $TMPDIR/ordinary/new/settings.json', probe)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.unresolvable).toEqual(['$TMPDIR/ordinary/new/settings.json'])
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.allInScope).toBe(false)
  })

  it('keeps the established protected hit when an unrelated target times out', async () => {
    const probe = fakeProbe({
      entries: {
        [TEMP]: { type: 'dir' },
        [`${TEMP}/.claude`]: { type: 'dir' },
        [`${TEMP}/.claude/settings.json`]: { type: 'file', size: 4 },
        [`${TEMP}/leaf.txt`]: { type: 'symlink', target: `${TEMP}/.claude/settings.json` }
      },
      hangLstat: ['c:/_scratch/slow.log']
    })
    const lstat = vi.spyOn(probe, 'lstat')
    const result = await captureRedirects(
      'echo x > $TMPDIR/leaf.txt; echo y > ../_scratch/slow.log',
      scope,
      {
        sessionStartMs: SESSION_START,
        platform: 'win32',
        probe,
        timeoutMs: 30
      }
    )
    expect(lstat).toHaveBeenCalledWith('c:/_scratch/slow.log')
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.protectedHits).toEqual(['.claude'])
    expect(result?.allInScope).toBe(false)
  })

  it('still keeps a benign inside-temp new scratch hint', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureHint('echo x > $TMPDIR/scratch.txt', probe)
    expect(result?.tempVarTargets).toEqual([
      { target: '$TMPDIR/scratch.txt', path: `${TEMP}/scratch.txt` }
    ])
  })

  it('omits a static binding whose suffix is dynamic', async () => {
    const probe = fakeProbe({ entries: { [TEMP]: { type: 'dir' } } })
    const result = await captureHint('part=../docs; t=$TMPDIR/$part; echo x > $t/thesis.txt', probe)
    expect(result).not.toHaveProperty('tempVarTargets')
    expect(result?.allInScope).toBe(false)
  })
})
