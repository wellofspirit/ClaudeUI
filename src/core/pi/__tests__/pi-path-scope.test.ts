/**
 * pi path containment (H1) — the pure half: pi's path normalisation (a port, with the fixtures of
 * pi's own `test/paths.test.ts` / `test/path-utils.test.ts`), the read variants, the facts
 * (landing, containment, sensitivity, Windows forms), the pin and the post-approval re-check.
 *
 * Filesystem behaviour runs against the in-memory `makeVirtualFs` with win32 or POSIX semantics, so
 * both halves are exercised on every host; a last block uses REAL symlinks / junctions in a temp
 * dir (skipped, with the reason, where the platform refuses to create one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import {
  PATH_CHANGED_REASON,
  buildPiPathScope,
  hostPathFs,
  normalizeWindowsShellPath,
  pathFacts,
  piResolvePath,
  platformForCwd,
  readCandidate,
  sameFacts,
  suspiciousWindowsPath,
  withPathGuard,
  type PiPathScope
} from '../pi-path-scope'
import { makeVirtualFs, type VirtualNode } from '../../../test/helpers/virtual-path-fs'

const NNBSP = '\u202F'

// ---------------------------------------------------------------------------
// piResolvePath — a port of pi 1.4.0 utils/paths.ts resolvePath(+normalizePath)
// ---------------------------------------------------------------------------

describe('piResolvePath — POSIX', () => {
  const cwd = '/repo'
  const home = '/home/u'
  const resolve = (raw: string): string => piResolvePath(raw, cwd, 'linux', home)

  it('resolves relative paths against the cwd and keeps absolute ones', () => {
    expect(resolve('src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolve('/etc/passwd')).toBe('/etc/passwd')
    expect(resolve('../x')).toBe('/x')
    expect(resolve('.')).toBe('/repo')
    expect(resolve('')).toBe('/repo')
  })

  it('strips exactly one leading @ (pi: stripAtPrefix)', () => {
    expect(resolve('@/etc/passwd')).toBe('/etc/passwd')
    expect(resolve('@src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolve('@@x')).toBe('/repo/@x')
    expect(resolve('@~draft.md')).toBe('/repo/~draft.md') // pi: path-utils.test.ts
  })

  it('expands only a home tilde (pi: paths.test.ts "expands only home tilde shortcuts")', () => {
    expect(resolve('~')).toBe('/home/u')
    expect(resolve('~/file.txt')).toBe('/home/u/file.txt')
    expect(resolve('~draft.md')).toBe('/repo/~draft.md')
    expect(resolve('~user/x')).toBe('/repo/~user/x')
    // `~\` is win32-only
    expect(resolve('~\\x')).toBe('/repo/~\\x')
    expect(resolve('@~/x')).toBe('/home/u/x')
  })

  it('folds unicode spaces to a plain space', () => {
    expect(resolve('file\u00A0name.txt')).toBe('/repo/file name.txt') // pi: path-utils.test.ts
    expect(resolve('a\u2003b\u3000c')).toBe('/repo/a b c')
  })

  it('decodes file:// URLs and refuses the ones pi refuses', () => {
    expect(resolve('file:///etc/passwd')).toBe('/etc/passwd')
    expect(resolve('file:///tmp/file%20with%20spaces.txt')).toBe('/tmp/file with spaces.txt')
    expect(() => resolve('file:///%E0%A4%A')).toThrow() // pi: paths.test.ts "invalid file URLs"
    expect(() => resolve('file://host/x')).toThrow()
  })

  it('treats a backslash as a file-name character and leaves literal percent sequences alone', () => {
    expect(resolve('a\\b')).toBe('/repo/a\\b')
    expect(resolve('/tmp/report%2026.md')).toBe('/tmp/report%2026.md')
    expect(resolve('/tmp/foo%2Fbar')).toBe('/tmp/foo%2Fbar')
  })

  it('does not convert Windows-shell drive forms off Windows', () => {
    expect(resolve('/c/x')).toBe('/c/x')
    expect(resolve('/mnt/c/x')).toBe('/mnt/c/x')
  })

  it('accepts a file:// cwd (pi: paths.test.ts "resolves relative paths against the base directory")', () => {
    expect(piResolvePath('sub/f.txt', 'file:///work/base', 'linux', home)).toBe(
      '/work/base/sub/f.txt'
    )
  })
})

describe('piResolvePath — win32', () => {
  const cwd = 'D:\\repo'
  const home = 'C:\\Users\\u'
  const resolve = (raw: string): string => piResolvePath(raw, cwd, 'win32', home)

  it('resolves a rooted-driveless path against the SESSION cwd drive, not the host', () => {
    expect(resolve('/etc/x')).toBe('D:\\etc\\x')
    expect(resolve('\\etc\\x')).toBe('D:\\etc\\x')
  })

  it('converts Git Bash / MSYS / Cygwin / WSL drive paths (pi: paths.test.ts)', () => {
    expect(resolve('/c/Users/example/project')).toBe('C:\\Users\\example\\project')
    expect(resolve('/cygdrive/d/work')).toBe('D:\\work')
    expect(resolve('/mnt/e/source')).toBe('E:\\source')
    expect(resolve('/c')).toBe('C:\\')
    expect(resolve('/c/x')).toBe('C:\\x')
    expect(resolve('@/c/x')).toBe('C:\\x')
  })

  it('leaves the forms pi leaves (the backslash and // skips)', () => {
    for (const p of [
      'C:/Users/example',
      'C:\\Users\\example',
      '//server/share/file',
      '/c/Users\\example',
      'relative/file',
      '/tmp/file'
    ]) {
      expect(normalizeWindowsShellPath(p)).toBe(p)
    }
    expect(resolve('//server/share/file')).toBe('\\\\server\\share\\file')
    expect(resolve('/c/Users\\example')).toBe('D:\\c\\Users\\example')
    expect(resolve('/tmp/file')).toBe('D:\\tmp\\file')
  })

  it('expands ~, ~/ and ~\\', () => {
    expect(resolve('~')).toBe('C:\\Users\\u')
    expect(resolve('~/x')).toBe('C:\\Users\\u\\x')
    expect(resolve('~\\x')).toBe('C:\\Users\\u\\x')
    expect(resolve('~draft.md')).toBe('D:\\repo\\~draft.md')
  })

  it('decodes file:// URLs with Windows semantics and keeps drive-relative names on the cwd drive', () => {
    expect(resolve('file:///C:/x/y.txt')).toBe('C:\\x\\y.txt')
    expect(resolve('D:foo')).toBe('D:\\repo\\foo')
    expect(resolve('d:\\Other')).toBe('d:\\Other')
    expect(() => resolve('file:///etc/x')).toThrow()
  })

  it('keeps device-namespace spellings as they are', () => {
    expect(resolve('\\\\?\\C:\\x')).toBe('\\\\?\\C:\\x')
  })
})

describe("piResolvePath — idempotence (the pin is stable under pi's own re-resolution)", () => {
  const rows: [NodeJS.Platform, string, string][] = [
    ['linux', '/repo', '@src/a.ts'],
    ['linux', '/repo', '~/x'],
    ['linux', '/repo', 'file:///etc/passwd'],
    ['linux', '/repo', 'a\u00A0b/c'],
    ['linux', '/repo', '../../x'],
    ['linux', '/repo', '@~/x'],
    ['win32', 'D:\\repo', '/c/x'],
    ['win32', 'D:\\repo', '@/etc/x'],
    ['win32', 'D:\\repo', '~\\x'],
    ['win32', 'D:\\repo', 'file:///C:/x'],
    ['win32', 'D:\\repo', '//server/share/x'],
    ['win32', 'D:\\repo', 'a\u00A0b\\c']
  ]
  it.each(rows)('%s %s: %s', (platform, cwd, raw) => {
    const once = piResolvePath(raw, cwd, platform, platform === 'win32' ? 'C:\\h' : '/h')
    expect(piResolvePath(once, cwd, platform, platform === 'win32' ? 'C:\\h' : '/h')).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// readCandidate — pi's read fallbacks (resolveReadPathAsync)
// ---------------------------------------------------------------------------

describe('readCandidate', () => {
  const existsOf =
    (...present: string[]) =>
    (p: string) =>
      present.includes(p)

  it('keeps the plain path when it exists, and when nothing else does', () => {
    expect(readCandidate('/r/a.txt', existsOf('/r/a.txt', `/r/a${NNBSP}.txt`))).toBe('/r/a.txt')
    expect(readCandidate('/r/none.txt', existsOf())).toBe('/r/none.txt')
  })

  it('tries the AM/PM narrow-space variant (also lowercase) first', () => {
    const variant = `/r/Screenshot 10.00.00${NNBSP}AM.png`
    expect(readCandidate('/r/Screenshot 10.00.00 AM.png', existsOf(variant))).toBe(variant)
    const lower = `/r/Screenshot 10.00.00${NNBSP}am.png`
    expect(readCandidate('/r/Screenshot 10.00.00 am.png', existsOf(lower))).toBe(lower)
  })

  it("tries NFD, then curly quote, then NFD + curly quote, in pi's order", () => {
    const nfc = '/r/file\u00e9.txt'
    const nfd = '/r/file\u0065\u0301.txt'
    expect(readCandidate(nfc, existsOf(nfd))).toBe(nfd)
    expect(readCandidate("/r/Capture d'cran.txt", existsOf('/r/Capture d\u2019cran.txt'))).toBe(
      '/r/Capture d\u2019cran.txt'
    )
    expect(
      readCandidate("/r/Capture d'\u00e9cran.txt", existsOf('/r/Capture d\u2019\u00e9cran.txt'))
    ).toBe('/r/Capture d\u2019\u00e9cran.txt')
    expect(readCandidate("/r/d'\u00e9.txt", existsOf('/r/d\u2019\u0065\u0301.txt'))).toBe(
      '/r/d\u2019\u0065\u0301.txt'
    )
    // AM/PM wins over NFD when both exist
    const both = [`/r/\u00e9 10 AM.png`.replace(' AM', `${NNBSP}AM`), '/r/\u0065\u0301 10 AM.png']
    expect(readCandidate('/r/\u00e9 10 AM.png', existsOf(...both))).toBe(both[0])
  })
})

// ---------------------------------------------------------------------------
// suspiciousWindowsPath (R8)
// ---------------------------------------------------------------------------

describe('suspiciousWindowsPath', () => {
  it.each([
    'D:\\repo\\notes.txt.',
    'D:\\repo\\notes.txt ',
    'D:\\repo\\.. ',
    'D:\\repo\\...',
    'D:\\repo\\a\\NUL',
    'D:\\repo\\nul.txt',
    'D:\\repo\\COM1',
    'D:\\repo\\lpt9.log',
    'D:\\repo\\CONIN$',
    'D:\\repo\\src\\con\\x.ts',
    'D:\\repo\\f.txt:stream',
    'D:\\repo\\.git::$INDEX_ALLOCATION',
    '\\\\?\\C:\\x',
    '\\\\.\\PhysicalDrive0',
    '\\\\server\\share\\x',
    '//server/share/x'
  ])('flags %s', (p) => {
    expect(suspiciousWindowsPath(p)).toBe(true)
  })

  it.each([
    'D:\\repo\\src\\a.ts',
    'D:\\repo\\.gitignore',
    'D:\\repo\\a.b.c',
    'D:\\repo\\console.ts',
    'D:\\repo\\nullable.ts',
    'D:\\repo\\com10',
    'C:\\'
  ])('passes %s', (p) => {
    expect(suspiciousWindowsPath(p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pathFacts
// ---------------------------------------------------------------------------

const POSIX_NODES: Record<string, VirtualNode> = {
  '/repo': 'dir',
  '/repo/src': 'dir',
  '/repo/src/a.ts': 'file',
  '/repo/file.txt': 'file',
  '/repo/.git': 'dir',
  '/repo/.git/hooks': 'dir',
  '/repo/.git/hooks/pre-commit': 'file',
  '/repo/.claude': 'dir',
  '/repo/.config': 'dir',
  '/repo/.config/git': 'dir',
  '/repo/.config/gitx': 'dir',
  '/repo/link-out': { link: '/etc' },
  '/repo/dangling': { link: '/nowhere' },
  '/repo/loop-a': { link: '/repo/loop-b' },
  '/repo/loop-b': { link: '/repo/loop-a' },
  '/repo/hook-link': { link: '/repo/.git/hooks/pre-commit' },
  '/repo/hooks-dir-link': { link: '/repo/.git/hooks' },
  '/repo/secret': 'dir',
  '/repo/Capture d\u2019cran.txt': { link: '/etc/passwd' },
  [`/repo/Screenshot 10.00.00${NNBSP}AM.png`]: 'file',
  '/etc': 'dir',
  '/etc/passwd': 'file',
  '/extra': 'dir',
  '/extra/notes.md': 'file',
  '/home': 'dir',
  '/home/u': 'dir',
  '/home/u/.ssh': 'dir',
  '/home/u/.ssh/id_rsa': 'file',
  '/home/u/.bashrc': 'file',
  '/tmp': 'dir',
  '/tmp/claudeui': 'dir',
  '/tmp/claudeui/proj': 'dir',
  '/tmp/claudeui/proj/sess': 'dir',
  '/tmp/claudeui/proj/sess/scratchpad': 'dir',
  '/tmp/other': 'dir'
}

function posixScope(over: Partial<PiPathScope> = {}, nodes = POSIX_NODES): PiPathScope {
  return {
    cwd: '/repo',
    roots: ['/repo', '/extra'],
    platform: 'linux',
    homeDir: '/home/u',
    fs: makeVirtualFs('posix', nodes, { denied: ['/repo/secret'] }),
    ...over
  }
}

function factsOf(
  tool: string,
  input: Record<string, unknown>,
  scope: PiPathScope = posixScope()
): NonNullable<ReturnType<typeof pathFacts>> {
  const facts = pathFacts(tool, input, scope)
  if (!facts) throw new Error('no facts')
  return facts
}

describe('pathFacts — states and landing (POSIX)', () => {
  it('only the six path tools have facts', () => {
    for (const tool of ['bash', 'agent', 'mcp__x__y', 'powershell', 'dispatch_agent']) {
      expect(pathFacts(tool, { path: '/etc/passwd' }, posixScope())).toBeUndefined()
    }
  })

  it('an existing file in the cwd is resolved and in scope', () => {
    const f = factsOf('read', { path: 'src/a.ts' })
    expect(f).toMatchObject({
      execPath: '/repo/src/a.ts',
      state: 'resolved',
      landing: '/repo/src/a.ts',
      inScope: true,
      leafIsSymlink: false,
      carriedOut: false,
      pinnable: true
    })
  })

  it('a missing leaf under an existing directory is missing-leaf, landing = real ancestor + tail', () => {
    const f = factsOf('edit', { path: 'src/new/deep/x.ts' })
    expect(f).toMatchObject({
      state: 'missing-leaf',
      landing: '/repo/src/new/deep/x.ts',
      inScope: true
    })
  })

  it('outside paths are resolved and out of scope', () => {
    for (const p of ['/etc/passwd', '../etc/passwd', '@/etc/passwd', 'file:///etc/passwd']) {
      const f = factsOf('read', { path: p })
      expect(f.execPath).toBe('/etc/passwd')
      expect(f.inScope).toBe(false)
      expect(f.state).toBe('resolved')
    }
    expect(factsOf('read', { path: '~/.ssh/id_rsa' })).toMatchObject({
      execPath: '/home/u/.ssh/id_rsa',
      inScope: false
    })
  })

  it('~user/x is a relative name, so it is inside the cwd', () => {
    expect(factsOf('read', { path: '~user/x' })).toMatchObject({
      execPath: '/repo/~user/x',
      inScope: true
    })
  })

  it('a symlink in the cwd to outside: lexically in, really out — carried out', () => {
    for (const tool of ['read', 'edit', 'write'] as const) {
      const f = factsOf(tool, { path: 'link-out/passwd' })
      expect(f).toMatchObject({
        execPath: '/repo/link-out/passwd',
        landing: '/etc/passwd',
        inScope: false,
        carriedOut: true,
        state: 'resolved'
      })
    }
    // a missing leaf under the link is carried out too
    expect(factsOf('write', { path: 'link-out/new.conf' })).toMatchObject({
      state: 'missing-leaf',
      landing: '/etc/new.conf',
      inScope: false,
      carriedOut: true
    })
  })

  it('a link into ANOTHER root stays in scope', () => {
    const nodes = { ...POSIX_NODES, '/repo/to-extra': { link: '/extra' } as VirtualNode }
    const f = factsOf('read', { path: 'to-extra/notes.md' }, posixScope({}, nodes))
    expect(f).toMatchObject({ landing: '/extra/notes.md', inScope: true, carriedOut: false })
  })

  it('dangling links, link loops and unreadable entries are unresolved (never missing-leaf)', () => {
    for (const p of ['dangling', 'dangling/sub/leaf', 'loop-a', 'loop-a/x', 'secret/inner']) {
      const f = factsOf('read', { path: p })
      expect(f.state, p).toBe('unresolved')
      expect(f.landing, p).toBeUndefined()
      expect(f.inScope, p).toBe(false)
    }
  })

  it("a path under a regular FILE is a harmless missing-leaf (pi's own ENOTDIR)", () => {
    expect(factsOf('edit', { path: 'file.txt/x' })).toMatchObject({
      state: 'missing-leaf',
      landing: '/repo/file.txt/x'
    })
  })

  it('edit/write: a leaf that is a symbolic link is flagged (read is not)', () => {
    expect(factsOf('edit', { path: 'hook-link' }).leafIsSymlink).toBe(true)
    expect(factsOf('write', { path: 'dangling' }).leafIsSymlink).toBe(true)
    expect(factsOf('read', { path: 'hook-link' }).leafIsSymlink).toBe(false)
    expect(factsOf('edit', { path: 'src/a.ts' }).leafIsSymlink).toBe(false)
    // a link in a MIDDLE component is not a leaf link
    expect(factsOf('edit', { path: 'hooks-dir-link/x' }).leafIsSymlink).toBe(false)
  })

  it('the read variants decide the gated path: a curly-quote spelling linked outside is outside', () => {
    const f = factsOf('read', { path: "Capture d'cran.txt" })
    expect(f.execPath).toBe('/repo/Capture d\u2019cran.txt')
    expect(f).toMatchObject({ landing: '/etc/passwd', inScope: false, carriedOut: true })
  })

  it('the AM/PM variant that exists is the one gated and pinned', () => {
    const f = factsOf('read', { path: 'Screenshot 10.00.00 AM.png' })
    expect(f.execPath).toBe(`/repo/Screenshot 10.00.00${NNBSP}AM.png`)
    expect(f.inScope).toBe(true)
    // edit does not use read's variants
    expect(factsOf('edit', { path: 'Screenshot 10.00.00 AM.png' }).execPath).toBe(
      '/repo/Screenshot 10.00.00 AM.png'
    )
  })

  it('an input pi would throw on, or a non-string path, is unresolved and not pinned', () => {
    expect(factsOf('read', { path: 'file://host/x' })).toMatchObject({
      state: 'unresolved',
      pinnable: false
    })
    expect(factsOf('read', { path: 42 })).toMatchObject({ state: 'unresolved', pinnable: false })
    expect(factsOf('edit', {})).toMatchObject({ state: 'unresolved', pinnable: false })
    expect(factsOf('grep', { path: 42 })).toMatchObject({ state: 'unresolved', pinnable: false })
  })
})

describe('pathFacts — search tools take their path from `path` only (R10)', () => {
  it.each(['grep', 'find', 'ls'])(
    '%s: no path / empty path is the cwd, in scope, pinnable',
    (tool) => {
      for (const input of [{ pattern: '*.ts' }, { pattern: 'x', path: '' }]) {
        expect(factsOf(tool, input)).toMatchObject({
          execPath: '/repo',
          inScope: true,
          pinnable: true
        })
      }
    }
  )

  it('a pattern or glob is not a path: only `path` is contained', () => {
    expect(factsOf('grep', { pattern: '/etc/passwd', glob: '/etc/**' }).inScope).toBe(true)
    expect(factsOf('find', { pattern: '../../**/*.pem' }).inScope).toBe(true)
  })

  it('a path that climbs out is outside', () => {
    expect(factsOf('grep', { pattern: 'x', path: '..' })).toMatchObject({
      execPath: '/',
      inScope: false
    })
    expect(factsOf('ls', { path: '/etc' }).inScope).toBe(false)
  })
})

describe('pathFacts — roots (POSIX)', () => {
  it('additional directories are roots for reads and writes; the project temp dir is read-only', () => {
    const scope = posixScope({ readRoots: ['/tmp/claudeui/proj'] })
    expect(factsOf('read', { path: '/extra/notes.md' }, scope).inScope).toBe(true)
    expect(factsOf('write', { path: '/extra/new.md' }, scope).inScope).toBe(true)
    expect(factsOf('read', { path: '/tmp/claudeui/proj/other-session/x' }, scope).inScope).toBe(
      true
    )
    expect(factsOf('write', { path: '/tmp/claudeui/proj/other-session/x' }, scope).inScope).toBe(
      false
    )
    expect(factsOf('read', { path: '/tmp/other/x' }, scope).inScope).toBe(false)
  })

  it('the scratchpad is read+write in scope and flagged inScratchpad; its siblings are not', () => {
    const scope = posixScope({ scratchpad: '/tmp/claudeui/proj/sess/scratchpad' })
    for (const tool of ['read', 'write', 'edit'] as const) {
      expect(
        factsOf(tool, { path: '/tmp/claudeui/proj/sess/scratchpad/out.txt' }, scope)
      ).toMatchObject({ inScope: true, inScratchpad: true })
    }
    expect(factsOf('write', { path: '/tmp/claudeui/proj/sess/x' }, scope)).toMatchObject({
      inScope: false,
      inScratchpad: false
    })
    expect(factsOf('write', { path: '/tmp/x' }, scope).inScope).toBe(false)
  })

  it('the scratchpad is compared AS SPELLED: swapped for a link, its files land outside', () => {
    const nodes = {
      ...POSIX_NODES,
      '/tmp/claudeui/proj/sess/scratchpad': { link: '/etc' } as VirtualNode
    }
    const scope = posixScope({ scratchpad: '/tmp/claudeui/proj/sess/scratchpad' }, nodes)
    expect(
      factsOf('write', { path: '/tmp/claudeui/proj/sess/scratchpad/passwd' }, scope)
    ).toMatchObject({
      inScratchpad: false,
      inScope: false,
      carriedOut: true
    })
  })

  it('a root reached through a symlinked cwd matches by lexical and by real spelling', () => {
    const nodes: Record<string, VirtualNode> = {
      '/real': 'dir',
      '/real/repo': 'dir',
      '/real/repo/a.ts': 'file',
      '/link': { link: '/real/repo' }
    }
    const scope: PiPathScope = {
      cwd: '/link',
      roots: ['/link'],
      platform: 'linux',
      homeDir: '/h',
      fs: makeVirtualFs('posix', nodes)
    }
    // lexical spelling /link/a.ts, landing /real/repo/a.ts: both inside some variant of the root
    expect(factsOf('read', { path: 'a.ts' }, scope)).toMatchObject({
      execPath: '/link/a.ts',
      landing: '/real/repo/a.ts',
      inScope: true
    })
    // the real spelling directly
    expect(factsOf('read', { path: '/real/repo/a.ts' }, scope).inScope).toBe(true)
  })

  it('POSIX: case-sensitive, and a backslash is not a separator', () => {
    expect(factsOf('read', { path: '/REPO/src/a.ts' }).inScope).toBe(false)
    const f = factsOf('read', { path: '..\\..\\etc\\passwd' })
    expect(f.execPath).toBe('/repo/..\\..\\etc\\passwd')
    expect(f.inScope).toBe(true) // a file literally named that, inside the cwd
  })

  it('POSIX: nothing about Windows path forms applies', () => {
    for (const p of ['notes.txt.', 'NUL', 'a:b', 'x ']) {
      const f = factsOf('edit', { path: p })
      expect(f.suspiciousWindows, p).toBe(false)
      expect(f.inScope, p).toBe(true)
    }
  })
})

describe('pathFacts — sensitivity over every spelling (edit/write only)', () => {
  it('names the written path, the resolved path and the landing', () => {
    expect(factsOf('edit', { path: '.claude/settings.json' }).sensitive).toBe(true)
    expect(factsOf('edit', { path: '@.git/config' }).sensitive).toBe(true)
    expect(factsOf('edit', { path: 'src/../.git/config' }).sensitive).toBe(true)
    expect(factsOf('edit', { path: '/repo/.git/hooks/pre-commit' }).sensitive).toBe(true)
    expect(factsOf('edit', { path: 'src/a.ts' }).sensitive).toBe(false)
    expect(factsOf('write', { path: 'bunfig.toml' }).sensitive).toBe(true)
    expect(factsOf('write', { path: '/home/u/.bashrc' }).sensitive).toBe(true)
  })

  it('a link inside the cwd to a sensitive file or directory is sensitive by its landing', () => {
    const viaFile = factsOf('edit', { path: 'hook-link' })
    expect(viaFile.sensitive).toBe(true)
    const viaDir = factsOf('edit', { path: 'hooks-dir-link/pre-commit' })
    expect(viaDir).toMatchObject({
      landing: '/repo/.git/hooks/pre-commit',
      inScope: true,
      sensitive: true,
      leafIsSymlink: false
    })
  })

  it('nested entries (.config/git) match as a run; near misses do not', () => {
    expect(factsOf('edit', { path: '.config/git/config' }).sensitive).toBe(true)
    expect(factsOf('edit', { path: '.config/gitx/config' }).sensitive).toBe(false)
    expect(factsOf('edit', { path: 'x.config/git/config' }).sensitive).toBe(false)
  })

  it('reads are never sensitive', () => {
    expect(factsOf('read', { path: '.git/config' }).sensitive).toBe(false)
    expect(factsOf('grep', { path: '.git' }).sensitive).toBe(false)
  })

  it('the cwd itself living under a control directory does not make every edit sensitive', () => {
    const nodes: Record<string, VirtualNode> = {
      '/p/.claude/worktrees/w': 'dir',
      '/p/.claude/worktrees/w/src': 'dir'
    }
    const scope: PiPathScope = {
      cwd: '/p/.claude/worktrees/w',
      roots: ['/p/.claude/worktrees/w'],
      platform: 'linux',
      homeDir: '/h',
      fs: makeVirtualFs('posix', nodes)
    }
    expect(factsOf('edit', { path: 'src/a.ts' }, scope).sensitive).toBe(false)
    expect(factsOf('edit', { path: '/p/.claude/worktrees/w/src/a.ts' }, scope).sensitive).toBe(
      false
    )
    expect(factsOf('edit', { path: '/p/.claude/settings.json' }, scope).sensitive).toBe(true)
  })
})

describe('pathFacts — win32', () => {
  const nodes: Record<string, VirtualNode> = {
    'D:\\repo': 'dir',
    'D:\\repo\\src': 'dir',
    'D:\\repo\\src\\a.ts': 'file',
    'D:\\repo\\junction': { link: 'C:\\Windows' },
    'D:\\etc': 'dir',
    'C:\\Windows': 'dir',
    'C:\\Windows\\win.ini': 'file',
    'C:\\x': 'file'
  }
  function winScope(over: Partial<PiPathScope> = {}): PiPathScope {
    return {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: makeVirtualFs('win32', nodes),
      ...over
    }
  }

  it('a rooted-driveless path is on the cwd drive; /c/x is C:\\x', () => {
    expect(factsOf('read', { path: '/etc/x' }, winScope())).toMatchObject({
      execPath: 'D:\\etc\\x',
      inScope: false
    })
    expect(factsOf('read', { path: '/c/x' }, winScope())).toMatchObject({
      execPath: 'C:\\x',
      inScope: false,
      state: 'resolved'
    })
    expect(factsOf('read', { path: '@/etc/passwd' }, winScope()).execPath).toBe('D:\\etc\\passwd')
    expect(factsOf('read', { path: 'file:///C:/x' }, winScope()).execPath).toBe('C:\\x')
  })

  it('containment is case-insensitive and drive-aware', () => {
    expect(factsOf('read', { path: 'D:\\REPO\\Src\\A.ts' }, winScope()).inScope).toBe(true)
    expect(factsOf('read', { path: 'd:/repo/src/a.ts' }, winScope()).inScope).toBe(true)
    expect(factsOf('read', { path: 'E:\\repo\\src\\a.ts' }, winScope()).inScope).toBe(false)
    expect(factsOf('read', { path: 'D:\\repo2\\x' }, winScope()).inScope).toBe(false)
  })

  it('a junction out of the cwd is carried out', () => {
    expect(factsOf('edit', { path: 'junction\\win.ini' }, winScope())).toMatchObject({
      landing: 'C:\\Windows\\win.ini',
      carriedOut: true,
      inScope: false
    })
  })

  it('suspicious forms: writes carry the flag, reads are outside (never inside)', () => {
    for (const p of [
      'notes.txt.',
      'NUL',
      'nul.txt',
      'f.txt:stream',
      '\\\\?\\C:\\x',
      '\\\\.\\PhysicalDrive0',
      '...',
      '.. \\x'
    ]) {
      expect(factsOf('edit', { path: p }, winScope()).suspiciousWindows, p).toBe(true)
    }
    expect(factsOf('write', { path: '//server/share/x' }, winScope()).suspiciousWindows).toBe(true)
    // `..\u00A0` is folded by pi to `.. ` and then stripped to `..` by Win32
    expect(factsOf('edit', { path: '..\u00A0\\x' }, winScope()).suspiciousWindows).toBe(true)
    const read = factsOf('read', { path: 'notes.txt.' }, winScope())
    expect(read.suspiciousWindows).toBe(true)
    expect(read.inScope).toBe(false)
    expect(factsOf('read', { path: '\\\\server\\share\\x' }, winScope()).inScope).toBe(false)
    expect(factsOf('edit', { path: 'src\\a.ts' }, winScope()).suspiciousWindows).toBe(false)
  })

  it('the additional directory on another drive and a UNC root are compared like any root', () => {
    const scope = winScope({ roots: ['D:\\repo', 'E:\\extra'] })
    expect(factsOf('write', { path: 'E:\\extra\\n.txt' }, scope).inScope).toBe(true)
    // a UNC path never matches a non-UNC root
    expect(factsOf('read', { path: '\\\\D\\repo\\src' }, scope).inScope).toBe(false)
  })

  it('the unfolded spelling is checked too: backslash and slash both split components', () => {
    expect(factsOf('edit', { path: 'src\\..\\.git\\config' }, winScope()).sensitive).toBe(true)
    expect(factsOf('edit', { path: '.GIT/config' }, winScope()).sensitive).toBe(true)
    expect(factsOf('edit', { path: 'GIT~1/config' }, winScope()).sensitive).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildPiPathScope / platformForCwd
// ---------------------------------------------------------------------------

describe('platformForCwd', () => {
  it("reads the cwd's own syntax", () => {
    expect(platformForCwd('D:\\repo')).toBe('win32')
    expect(platformForCwd('d:/repo')).toBe('win32')
    expect(platformForCwd('\\\\server\\share\\r')).toBe('win32')
    expect(platformForCwd('/repo')).not.toBe('win32')
  })
})

describe('buildPiPathScope', () => {
  // Additional directories resolve with the HOST's path module (they come from the host's
  // settings files), so these tests use host-native absolute paths.
  const nat = (...parts: string[]): string => path.resolve(path.sep, ...parts)
  const cwd = nat('repo')

  it('resolves additional directories (~ and relative) against the cwd and folds repeats', () => {
    const scope = buildPiPathScope({
      cwd,
      rules: {
        additionalDirectories: [nat('extra'), 'sibling', '~/x', nat('extra') + path.sep, '', '  ']
      }
    })
    expect(scope.cwd).toBe(cwd)
    expect(scope.roots).toEqual([
      cwd,
      nat('extra'),
      path.join(cwd, 'sibling'),
      path.join(homedir(), 'x')
    ])
    expect(scope.fenceRoots).toBeUndefined()
    expect(scope.blockOutsideReads).toBeUndefined()
  })

  it('carries the scratchpad and the project temp dir (read-only)', () => {
    const scope = buildPiPathScope({
      cwd,
      rules: { additionalDirectories: [] },
      scratchpad: nat('tmp', 's'),
      projectTemp: nat('tmp', 'p')
    })
    expect(scope.scratchpad).toBe(nat('tmp', 's'))
    expect(scope.readRoots).toEqual([nat('tmp', 'p')])
    expect(scope.roots).toEqual([cwd])
  })

  it('under the read block, directories ONLY project settings listed are not fence roots', () => {
    const [u, pr, both] = [nat('user-dir'), nat('project-dir'), nat('both')]
    const scope = buildPiPathScope({
      cwd,
      rules: {
        additionalDirectories: [u, pr, both],
        nonProjectAdditionalDirectories: [u, both],
        blockReadsOutsideWorkingDirectories: true
      }
    })
    expect(scope.roots).toEqual([cwd, u, pr, both])
    expect(scope.blockOutsideReads).toBe(true)
    expect(scope.fenceRoots).toEqual([cwd, u, both])
  })

  it('without provenance every entry counts for the fence; without the setting there is no fence', () => {
    const a = nat('a')
    expect(
      buildPiPathScope({
        cwd,
        rules: { additionalDirectories: [a], blockReadsOutsideWorkingDirectories: true }
      }).fenceRoots
    ).toEqual([cwd, a])
    expect(
      buildPiPathScope({
        cwd,
        rules: { additionalDirectories: [a], nonProjectAdditionalDirectories: [] }
      }).blockOutsideReads
    ).toBeUndefined()
  })

  it('derives the platform from the cwd when none is given', () => {
    expect(buildPiPathScope({ cwd: 'D:\\r', rules: { additionalDirectories: [] } }).platform).toBe(
      'win32'
    )
    expect(buildPiPathScope({ cwd: '/r', rules: { additionalDirectories: [] } }).platform).not.toBe(
      'win32'
    )
  })
})

// ---------------------------------------------------------------------------
// withPathGuard — the pin (R2) and the re-check after a delayed approval (R15)
// ---------------------------------------------------------------------------

describe('withPathGuard', () => {
  const allow = async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' })

  it('pins an allowed path-tool call to the canonical absolute path it gated', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['read', { path: '@src/a.ts' }, '/repo/src/a.ts'],
      ['edit', { path: '~/.bashrc', edits: [{ oldText: 'a', newText: 'b' }] }, '/home/u/.bashrc'],
      ['write', { path: 'file:///extra/n.md', content: 'x' }, '/extra/n.md'],
      ['grep', { pattern: 'x' }, '/repo'],
      ['find', { pattern: '*.ts', path: 'src/../src' }, '/repo/src'],
      ['ls', { path: '' }, '/repo']
    ]
    for (const [tool, input, expected] of cases) {
      const decision = await withPathGuard(tool, input, posixScope(), allow)
      expect(decision, tool).toEqual({
        behavior: 'allow',
        updatedInput: { ...input, path: expected }
      })
    }
  })

  it('does not mutate the input and keeps its other fields', async () => {
    const input = { path: 'src/a.ts', content: 'x' }
    const frozen = Object.freeze({ ...input })
    const decision = await withPathGuard('write', frozen, posixScope(), allow)
    expect(frozen).toEqual(input)
    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { path: '/repo/src/a.ts', content: 'x' }
    })
  })

  it('passes a deny, a non-path tool and a scope-less call through untouched', async () => {
    const deny = async (): Promise<{ behavior: 'deny'; reason: string }> => ({
      behavior: 'deny',
      reason: 'no'
    })
    expect(await withPathGuard('read', { path: 'a' }, posixScope(), deny)).toEqual({
      behavior: 'deny',
      reason: 'no'
    })
    expect(await withPathGuard('bash', { command: 'ls' }, posixScope(), allow)).toEqual({
      behavior: 'allow'
    })
    expect(await withPathGuard('read', { path: 'a' }, undefined, allow)).toEqual({
      behavior: 'allow'
    })
  })

  it('does not pin a call without a usable path argument', async () => {
    expect(await withPathGuard('read', { path: 5 }, posixScope(), allow)).toEqual({
      behavior: 'allow'
    })
  })

  it('denies when a link was swapped in while the approval was pending', async () => {
    const nodes: Record<string, VirtualNode> = { ...POSIX_NODES }
    const vfs = makeVirtualFs('posix', nodes)
    const scope = posixScope({ fs: vfs })
    // the model asks to write /repo/notes.txt (a missing leaf in scope); a human takes their time...
    const decision = await withPathGuard(
      'write',
      { path: 'notes.txt', content: 'x' },
      scope,
      async () => {
        // ...and meanwhile the path becomes a link out of the workspace
        vfs.set('/repo/notes.txt', { link: '/etc/passwd' })
        return { behavior: 'allow' as const }
      }
    )
    expect(decision).toEqual({ behavior: 'deny', reason: PATH_CHANGED_REASON })
  })

  it('denies when only the landing changed (a directory link retargeted)', async () => {
    const vfs = makeVirtualFs('posix', {
      ...POSIX_NODES,
      '/repo/d': { link: '/repo/src' },
      '/repo/src2': 'dir'
    })
    const scope = posixScope({ fs: vfs })
    const decision = await withPathGuard(
      'write',
      { path: 'd/new.ts', content: '' },
      scope,
      async () => {
        vfs.set('/repo/d', { link: '/repo/src2' }) // still in scope, but not what was approved
        return { behavior: 'allow' as const }
      }
    )
    expect(decision).toEqual({ behavior: 'deny', reason: PATH_CHANGED_REASON })
  })

  it('allows (and pins) when nothing that matters changed', async () => {
    const vfs = makeVirtualFs('posix', POSIX_NODES)
    const scope = posixScope({ fs: vfs })
    const decision = await withPathGuard(
      'write',
      { path: 'notes.txt', content: 'x' },
      scope,
      async () => {
        vfs.set('/repo/unrelated.txt', 'file')
        return { behavior: 'allow' as const }
      }
    )
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { path: '/repo/notes.txt' }
    })
  })
})

describe('sameFacts', () => {
  it("compares paths with the platform's case rules", () => {
    const a = factsOf('read', { path: 'src/a.ts' })
    expect(sameFacts(a, { ...a }, 'linux')).toBe(true)
    expect(sameFacts(a, { ...a, execPath: '/REPO/src/a.ts' }, 'linux')).toBe(false)
    expect(
      sameFacts(a, { ...a, execPath: '/REPO/src/a.ts', landing: '/REPO/src/a.ts' }, 'win32')
    ).toBe(true)
    expect(sameFacts(a, { ...a, inScope: false }, 'linux')).toBe(false)
    expect(sameFacts(a, { ...a, state: 'unresolved', landing: undefined }, 'linux')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real symlinks / junctions
// ---------------------------------------------------------------------------

describe('pathFacts — real links in a temp dir', () => {
  let base: string
  let cwd: string
  let outside: string
  let linksWork = true

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'pi-path-scope-'))
    cwd = path.join(base, 'repo')
    outside = path.join(base, 'outside')
    mkdirSync(path.join(cwd, 'src'), { recursive: true })
    mkdirSync(path.join(cwd, '.git', 'hooks'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'a')
    writeFileSync(path.join(outside, 'secret.txt'), 's')
    writeFileSync(path.join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh')
    try {
      // a junction needs no privilege on Windows and exercises the same realpath path
      symlinkSync(outside, path.join(cwd, 'out'), process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(
        path.join(cwd, '.git', 'hooks'),
        path.join(cwd, 'hooks-link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch {
      linksWork = false
    }
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function scope(): PiPathScope {
    return buildPiPathScope({ cwd, rules: { additionalDirectories: [] } })
  }

  it('a link to outside is carried out; an edit through a link to .git/hooks is sensitive', (ctx) => {
    if (!linksWork) return ctx.skip()
    const out = pathFacts('read', { path: 'out/secret.txt' }, scope())!
    expect(out).toMatchObject({ state: 'resolved', inScope: false, carriedOut: true })
    expect(out.landing && path.basename(out.landing)).toBe('secret.txt')
    const missing = pathFacts('write', { path: 'out/new.txt' }, scope())!
    expect(missing).toMatchObject({ state: 'missing-leaf', carriedOut: true, inScope: false })
    const hook = pathFacts('edit', { path: 'hooks-link/pre-commit' }, scope())!
    expect(hook).toMatchObject({ inScope: true, sensitive: true })
  })

  it('an ordinary file is in scope, a nonexistent one is a missing leaf', () => {
    expect(pathFacts('read', { path: 'src/a.ts' }, scope())).toMatchObject({
      state: 'resolved',
      inScope: true
    })
    expect(pathFacts('edit', { path: 'src/none/x.ts' }, scope())).toMatchObject({
      state: 'missing-leaf',
      inScope: true
    })
    expect(hostPathFs.exists(path.join(cwd, 'src', 'a.ts'))).toBe(true)
  })
})
