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
import { describe, expect, it } from 'vitest'
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
    })
  })

  it('emits no symlinked field when the parent realpath cannot be established', async () => {
    const probe = fakeProbe({ failRealpath: ['/work/repo'] })
    const result = await capture('echo x > build.log', probe)
    expect(result).toEqual({
      targets: ['build.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
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
