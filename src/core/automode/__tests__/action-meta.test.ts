/**
 * P2a-2: the shared per-action meta helper the three shells call.
 *
 * The helper's contract is the one the three duplicated bodies had — a failed
 * capture contributes NOTHING — plus the facts P2a-2 adds: the redirects are
 * MEASURED (through the injected probe), scoped to the shell's effective cwd
 * (`workdir`), and temp variables expand. The four "fixture" tests below pin
 * the exact JSON the classifier's meta line receives, key order included.
 */
import { describe, expect, it, vi } from 'vitest'
import { captureShellActionMeta, type ShellActionMetaOptions } from '../action-meta'
import type { RedirectProbe, RedirectStat } from '../redirect-measure'

const CWD = '/work/wt'
const SESSION_START = 1_000_000

type Entry =
  | { type: 'file'; size?: number; mtimeMs?: number }
  | { type: 'dir' }
  | { type: 'symlink'; target?: string | null }

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

function fakeProbe(
  options: { entries?: Record<string, Entry>; hang?: string[] } = {}
): RedirectProbe {
  const entries = options.entries ?? {}
  return {
    async lstat(path) {
      if (options.hang?.includes(path)) return new Promise<RedirectStat>(() => {})
      const entry = entries[path]
      if (!entry) throw enoent(path)
      return statOf(entry)
    },
    async realpath(path) {
      const entry = entries[path]
      if (entry?.type === 'symlink') {
        if (!entry.target) throw enoent(path)
        return entry.target
      }
      return path
    }
  }
}

function options(overrides: Partial<ShellActionMetaOptions> = {}): ShellActionMetaOptions {
  return {
    command: 'echo x > build.log',
    input: {},
    cwd: CWD,
    honoursWorkdir: false,
    shell: 'posix',
    sessionStartMs: SESSION_START,
    repoVisibility: async () => 'private',
    platform: 'linux',
    env: {},
    ...overrides
  }
}

describe('captureShellActionMeta — the meta JSON', () => {
  it('new file OUT of scope → exists:false', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'dotnet build > ../_scratch/b.txt',
        probe: fakeProbe()
      })
    )
    expect(JSON.stringify(meta)).toBe(
      '{"redirects":{"targets":["../_scratch/b.txt"],"allInScope":false,"outOfScope":[{"path":"/work/_scratch/b.txt","exists":false}],"unresolvable":[],"protectedHits":[]}}'
    )
  })

  it('existing non-empty .txt modified BEFORE the session start → empty:false, modified:false', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo hi > ../_scratch/notes.txt',
        probe: fakeProbe({
          entries: {
            '/work/_scratch/notes.txt': { type: 'file', size: 42, mtimeMs: SESSION_START - 1_000 }
          }
        })
      })
    )
    expect(JSON.stringify(meta)).toBe(
      '{"redirects":{"targets":["../_scratch/notes.txt"],"allInScope":false,"outOfScope":[{"path":"/work/_scratch/notes.txt","exists":true,"empty":false,"modifiedSinceSessionStart":false}],"unresolvable":[],"protectedHits":[]}}'
    )
  })

  it('append to an existing .log modified THIS session → append:true, modified:true', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'dotnet build >> ../_scratch/build.log 2>&1',
        probe: fakeProbe({
          entries: {
            '/work/_scratch/build.log': { type: 'file', size: 900, mtimeMs: SESSION_START + 5 }
          }
        })
      })
    )
    expect(JSON.stringify(meta)).toBe(
      '{"redirects":{"targets":["../_scratch/build.log"],"allInScope":false,"outOfScope":[{"path":"/work/_scratch/build.log","append":true,"exists":true,"empty":false,"modifiedSinceSessionStart":true}],"unresolvable":[],"protectedHits":[]}}'
    )
  })

  it('in-scope symlink to ~/.bashrc → symlinked only, allInScope:false', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > build.log',
        probe: fakeProbe({
          entries: { [`${CWD}/build.log`]: { type: 'symlink', target: '/home/dev/.bashrc' } }
        })
      })
    )
    expect(JSON.stringify(meta)).toBe(
      '{"redirects":{"targets":["build.log"],"allInScope":false,"outOfScope":[],"unresolvable":[],"protectedHits":[],"symlinked":["build.log"]}}'
    )
  })
})

describe('captureShellActionMeta — capture triggers', () => {
  it('returns undefined when no capture applies', async () => {
    expect(await captureShellActionMeta(options({ command: 'cat notes.txt' }))).toBeUndefined()
  })

  it('adds repoVisibility only when the command needs it, from the owner memo', async () => {
    const repoVisibility = vi.fn(async () => 'private' as const)
    const meta = await captureShellActionMeta(
      options({ command: 'gh repo view > view.log', repoVisibility, probe: fakeProbe() })
    )
    expect(repoVisibility).toHaveBeenCalledTimes(1)
    expect(meta?.repoVisibility).toBe('private')
    expect(meta?.redirects).toBeDefined()
  })

  it('leaves repoVisibility out for a command that does not need it', async () => {
    const repoVisibility = vi.fn(async () => 'private' as const)
    const meta = await captureShellActionMeta(
      options({ command: 'echo x > build.log', repoVisibility, probe: fakeProbe() })
    )
    expect(repoVisibility).not.toHaveBeenCalled()
    expect(meta?.repoVisibility).toBeUndefined()
  })
})

describe('captureShellActionMeta — scope follows the shell, not the session', () => {
  it('honours workdir: the target resolves from the call’s directory', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > out.log',
        input: { workdir: '..' },
        honoursWorkdir: true,
        probe: fakeProbe()
      })
    )
    expect(meta).toEqual({
      redirects: {
        targets: ['out.log'],
        allInScope: false,
        outOfScope: [{ path: '/work/out.log', exists: false }],
        unresolvable: [],
        protectedHits: []
      }
    })
  })

  it('ignores workdir for an engine whose shell does not honour it', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > out.log',
        input: { workdir: '..' },
        honoursWorkdir: false,
        probe: fakeProbe()
      })
    )
    expect(meta).toEqual({
      redirects: {
        targets: ['out.log'],
        allInScope: true,
        outOfScope: [],
        unresolvable: [],
        protectedHits: []
      }
    })
  })

  it('passes an unknown shell cwd through as null (relative targets become unresolvable)', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > out.log',
        input: { workdir: 42 },
        honoursWorkdir: true,
        probe: fakeProbe()
      })
    )
    expect(meta?.redirects).toEqual({
      targets: ['out.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['out.log'],
      protectedHits: []
    })
  })

  it('hints a temp variable with the host temp path, never claiming scope (ruling 18)', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > $TMPDIR/scratch.log',
        env: { TMPDIR: '/tmp' },
        probe: fakeProbe()
      })
    )
    expect(meta?.redirects).toEqual({
      targets: ['$TMPDIR/scratch.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['$TMPDIR/scratch.log'],
      protectedHits: [],
      tempVarTargets: [{ target: '$TMPDIR/scratch.log', path: '/tmp/scratch.log' }]
    })
  })

  it('hints only the dialect it was told (rulings 3 and 18)', async () => {
    // PowerShell: `$TMPDIR` is an ordinary (empty) variable, so it gets no hint;
    // `$env:TEMP` is the environment variable. Neither is ever claimed in scope.
    const psBare = await captureShellActionMeta(
      options({
        command: 'echo x > $TMPDIR/scratch.log',
        env: { TMPDIR: '/tmp' },
        shell: 'powershell',
        probe: fakeProbe()
      })
    )
    expect(psBare?.redirects).toMatchObject({
      unresolvable: ['$TMPDIR/scratch.log'],
      allInScope: false
    })
    expect(psBare?.redirects).not.toHaveProperty('tempVarTargets')
    const psEnv = await captureShellActionMeta(
      options({
        command: 'echo x > $env:TEMP/scratch.log',
        env: { TEMP: '/tmp' },
        shell: 'powershell',
        probe: fakeProbe()
      })
    )
    expect(psEnv?.redirects).toMatchObject({
      unresolvable: ['$env:TEMP/scratch.log'],
      allInScope: false,
      tempVarTargets: [{ target: '$env:TEMP/scratch.log', path: '/tmp/scratch.log' }]
    })
    // POSIX: the reverse — `$env:TEMP` is not a POSIX reference.
    const posixEnv = await captureShellActionMeta(
      options({
        command: 'echo x > $env:TEMP/scratch.log',
        env: { TEMP: '/tmp' },
        shell: 'posix',
        probe: fakeProbe()
      })
    )
    expect(posixEnv?.redirects).toMatchObject({
      unresolvable: ['$env:TEMP/scratch.log'],
      allInScope: false
    })
    expect(posixEnv?.redirects).not.toHaveProperty('tempVarTargets')
  })

  it('leaves an unset temp variable unresolvable (never a guess)', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > $TMPDIR/scratch.log',
        env: {},
        probe: fakeProbe()
      })
    )
    expect(meta?.redirects).toEqual({
      targets: ['$TMPDIR/scratch.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['$TMPDIR/scratch.log'],
      protectedHits: []
    })
  })

  it('reports a protected in-scope target', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > .git/config',
        probe: fakeProbe({ entries: { [`${CWD}/.git`]: { type: 'dir' } } })
      })
    )
    expect(meta?.redirects).toEqual({
      targets: ['.git/config'],
      allInScope: false,
      outOfScope: [],
      unresolvable: [],
      protectedHits: ['.git']
    })
  })

  it('falls back to the pure result on a deadline (no invented fields)', async () => {
    const meta = await captureShellActionMeta(
      options({
        command: 'echo x > ../_scratch/slow.log',
        probe: fakeProbe({ hang: ['/work/_scratch/slow.log'] }),
        timeoutMs: 5
      })
    )
    expect(meta).toEqual({
      redirects: {
        targets: ['../_scratch/slow.log'],
        allInScope: false,
        outOfScope: [{ path: '/work/_scratch/slow.log' }],
        unresolvable: [],
        protectedHits: []
      }
    })
  })
})
