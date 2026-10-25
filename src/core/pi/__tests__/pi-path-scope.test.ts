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
  absoluteRuleSpecifier,
  buildPiPathScope,
  hostPathFs,
  humanOnlyMessage,
  isPosixNamespacePath,
  isRemoteWindowsPath,
  normalizeWindowsShellPath,
  outsideAllowRules,
  pathFacts,
  piResolvePath,
  pinFor,
  pinMismatchReason,
  platformForCwd,
  rawSpellingHolds,
  readBlockMessage,
  readCandidate,
  sameFacts,
  suspiciousWindowsPath,
  withPathGuard,
  workspaceEditRules,
  type PathScopeFs,
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
// Slice F (exit review of PR #144)
// ---------------------------------------------------------------------------

/** A recording wrapper around a virtual win32 fs: every call, with its argument, in order. */
function recordingWinFs(nodes: Record<string, VirtualNode>) {
  const inner = makeVirtualFs('win32', nodes)
  const calls: string[] = []
  const fs: PathScopeFs = {
    realpath: (p) => (calls.push(`realpath ${p}`), inner.realpath(p)),
    lstat: (p) => (calls.push(`lstat ${p}`), inner.lstat(p)),
    readlink: (p) => (calls.push(`readlink ${p}`), inner.readlink(p)),
    exists: (p) => (calls.push(`exists ${p}`), inner.exists(p))
  }
  return { fs, calls, inner }
}

const BS = String.fromCharCode(92)
const REMOTE_ARG = /^(?:\w+ )(?:[\\/]{2})/

describe('R1 — a network path is never handed to the filesystem (the gate itself must not speak SMB / WebDAV)', () => {
  const REMOTE_SPELLINGS = [
    `${BS}${BS}attacker.example${BS}share${BS}x`,
    '//attacker.example/share/x',
    `${BS}${BS}attacker.example@SSL${BS}DavWWWRoot${BS}x`,
    `${BS}${BS}attacker.example@443${BS}DavWWWRoot${BS}x`,
    'file://attacker.example/share/x',
    `${BS}${BS}?${BS}UNC${BS}attacker.example${BS}share${BS}x`,
    `${BS}${BS}?${BS}C:${BS}Windows${BS}win.ini`,
    `${BS}${BS}.${BS}PhysicalDrive0`,
    `@${BS}${BS}attacker.example${BS}share${BS}x`
  ]
  const LOCAL_NAMESPACE = [
    `${BS}${BS}?${BS}C:${BS}Windows${BS}win.ini`,
    `${BS}${BS}.${BS}PhysicalDrive0`
  ]
  const TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const

  it.each(REMOTE_SPELLINGS)(
    '%s: unresolved + remote with no filesystem call at all (no roots to place either)',
    (p) => {
      const { fs, calls } = recordingWinFs({})
      const scope: PiPathScope = {
        cwd: 'D:\\repo',
        roots: [],
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        fs
      }
      for (const tool of TOOLS) {
        calls.length = 0
        const input = tool === 'write' ? { path: p, content: 'x' } : { path: p }
        const f = pathFacts(tool, input, scope)!
        expect(calls, `${tool} ${p}`).toEqual([])
        expect(f, `${tool} ${p}`).toMatchObject({
          state: 'unresolved',
          remote: true,
          inScope: false,
          inFence: false,
          carriedOut: false
        })
        expect(f.landing).toBeUndefined()
        // F3-3: a local namespace spelling (the extended-length and device prefixes on a drive or a
        // device) is a device / extended-length path, not a network one; a real UNC, WebDAV or
        // extended-length UNC spelling keeps the network wording
        if (LOCAL_NAMESPACE.includes(p)) {
          expect(humanOnlyMessage(f), p).toContain('device or extended-length path')
          expect(humanOnlyMessage(f), p).not.toMatch(/is a network path/)
        } else {
          expect(humanOnlyMessage(f), p).toContain('is a network path')
          expect(humanOnlyMessage(f), p).not.toContain('device or extended-length')
        }
      }
    }
  )

  it('a remote path never reaches a root, a scratchpad or the cwd probe either (the roots are placed locally)', () => {
    const { fs, calls } = recordingWinFs({ 'D:\\repo': 'dir' })
    const scope = buildPiPathScope({
      cwd: 'D:\\repo',
      // a project-settings additional directory that is itself UNC must not be probed
      rules: { additionalDirectories: [`${BS}${BS}attacker.example${BS}share`] },
      platform: 'win32',
      fs,
      homeDir: 'C:\\Users\\u'
    })
    for (const tool of TOOLS) {
      const input = tool === 'write' ? { path: 'src\\a.ts', content: 'x' } : { path: 'src\\a.ts' }
      calls.length = 0
      pathFacts(tool, input, scope)
      expect(
        calls.filter((c) => REMOTE_ARG.test(c) || /attacker/i.test(c)),
        tool
      ).toEqual([])
    }
  })

  it('a link whose target is UNC (directly, via a chain, or in an ancestor of a link target) is unresolved before any realpath', () => {
    const { fs, calls } = recordingWinFs({
      'D:\\repo': 'dir',
      'D:\\repo\\evil': { link: `${BS}${BS}attacker.example${BS}share` },
      'D:\\repo\\hop': { link: 'D:\\repo\\evil' },
      'D:\\repo\\rel': { link: `..${BS}other${BS}via` },
      'D:\\other': 'dir',
      'D:\\other\\via': { link: `${BS}${BS}?${BS}UNC${BS}attacker.example${BS}share` },
      'D:\\repo\\ok': { link: 'D:\\repo\\src' },
      'D:\\repo\\src': 'dir'
    })
    const scope: PiPathScope = {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs
    }
    for (const rel of [
      'evil',
      'evil\\x',
      'hop',
      'hop\\deep\\x',
      'rel\\x',
      'D:\\repo\\evil\\..\\evil\\x'
    ]) {
      for (const tool of TOOLS) {
        calls.length = 0
        const input = tool === 'write' ? { path: rel, content: 'x' } : { path: rel }
        const f = pathFacts(tool, input, scope)!
        expect(f, `${tool} ${rel}`).toMatchObject({ state: 'unresolved', remote: true })
        // only local lstat / readlink calls on the way; nothing on a UNC spelling, and no realpath on the link
        expect(
          calls.filter((c) => REMOTE_ARG.test(c)),
          `${tool} ${rel}`
        ).toEqual([])
        expect(
          calls.filter((c) => c.startsWith('realpath') && /evil|hop|rel|via/.test(c)),
          `${tool} ${rel}`
        ).toEqual([])
      }
    }
    // control: a link to a local directory is followed as before
    const ok = pathFacts('write', { path: 'ok\\n.ts', content: 'x' }, scope)!
    expect(ok).toMatchObject({ remote: false, landing: 'D:\\repo\\src\\n.ts', inScope: true })
  })

  it("read's fallback variants are checked too: a link-to-UNC under the narrow-space variant name is not looked at", () => {
    const { fs, calls } = recordingWinFs({
      'D:\\repo': 'dir',
      [`D:\\repo\\Shot 1.00${'\u202F'}PM.png`]: {
        link: `${BS}${BS}attacker.example${BS}share${BS}f`
      }
    })
    const scope: PiPathScope = {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs
    }
    const f = pathFacts('read', { path: 'Shot 1.00 PM.png' }, scope)!
    expect(f).toMatchObject({ state: 'unresolved', remote: true })
    expect(calls.filter((c) => c.startsWith('exists') && /attacker/i.test(c))).toEqual([])
    expect(calls.filter((c) => c.startsWith('realpath'))).not.toContain(
      `realpath D:\\repo\\Shot 1.00${'\u202F'}PM.png`
    )
  })

  it('POSIX is untouched: a backslash path is a file name there, resolved through the fs as ever', () => {
    const f = factsOf('read', { path: `${BS}${BS}host${BS}x` })
    expect(f.remote).toBe(false)
    expect(f.execPath).toBe(`/repo/${BS}${BS}host${BS}x`)
  })

  it('isRemoteWindowsPath: two leading separators, nothing else', () => {
    for (const p of [`${BS}${BS}h${BS}s`, '//h/s', `${BS}${BS}?${BS}C:${BS}x`, `${BS}/h`])
      expect(isRemoteWindowsPath(p), p).toBe(true)
    for (const p of ['D:\\x', '/x', 'x\\y', 'D:\\a\\\\b'])
      expect(isRemoteWindowsPath(p), p).toBe(false)
  })

  it('sameFacts: remote is part of what decides a verdict', () => {
    const f = factsOf('read', { path: 'src/a.ts' })
    expect(sameFacts(f, { ...f, remote: true }, 'linux')).toBe(false)
  })
})

describe('R2 — the pin is a spelling pi re-resolves to exactly the gated path', () => {
  const allow = async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' })
  const HOME = '/home/u'
  const opens = (pin: string, cwd: string, platform: NodeJS.Platform, home: string): string =>
    piResolvePath(pin, cwd, platform, home)

  function scopeAt(cwd: string, home: string, nodes: Record<string, VirtualNode>, over = {}) {
    return {
      cwd,
      roots: [cwd],
      platform: 'linux' as const,
      homeDir: home,
      fs: makeVirtualFs('posix', { [cwd]: 'dir', ...nodes }),
      ...over
    } satisfies PiPathScope
  }

  it.each([
    ['U+3000 in the cwd', '/home/u/My\u3000Project'],
    ['U+00A0 in the cwd', '/home/u/My\u00A0Project'],
    ['U+202F in the cwd', '/home/u/My\u202FProject']
  ])(
    '%s: the pin is the cwd-relative spelling, and pi opens exactly the gated file',
    async (_n, cwd) => {
      const scope = scopeAt(cwd, HOME, {})
      for (const [tool, input] of [
        ['write', { path: 'src/new.txt', content: 'x' }],
        ['edit', { path: './notes.txt', edits: [] }],
        ['grep', { pattern: 'x' }],
        ['ls', { path: '' }]
      ] as const) {
        const facts = factsOf(tool, input, scope)
        // the bug: the absolute spelling is NOT a fixed point (pi folds the cwd's own space)
        expect(opens(facts.execPath, cwd, 'linux', HOME), tool).not.toBe(facts.execPath)
        const decision = await withPathGuard(tool, input, scope, allow)
        expect(decision.behavior, tool).toBe('allow')
        const pin = (decision as unknown as { updatedInput: { path: string } }).updatedInput.path
        expect(opens(pin, cwd, 'linux', HOME), `${tool} -> ${pin}`).toBe(facts.execPath)
        expect(pin.startsWith('/'), `${tool} -> ${pin}`).toBe(false)
      }
    }
  )

  it('a home with a unicode space: `~/x` inside the cwd tree pins relative (step 2); outside the tree no pin survives and `~/x`, absolute after normalisation, passes UNPINNED (step 3) — never pinned to another file', async () => {
    const home = '/home/u\u3000x'
    // home under the cwd: the relative spelling carries no unicode space
    const cwd = '/work　x'
    const inside = scopeAt(cwd, `${cwd}/h`, {})
    expect(
      await withPathGuard('write', { path: '~/f.txt', content: 'x' }, inside, allow)
    ).toMatchObject({ behavior: 'allow', updatedInput: { path: 'h/f.txt' } })
    // home elsewhere, with the space in its own name: no rewritten spelling survives pi's folding,
    // but `~/f.txt` itself opens `${home}/f.txt` (pi expands `~` after folding) — left unpinned
    const outside = scopeAt(cwd, home, {})
    const decision = await withPathGuard('write', { path: '~/f.txt', content: 'x' }, outside, allow)
    expect(decision).toEqual({ behavior: 'allow' })
    expect(opens('~/f.txt', cwd, 'linux', home)).toBe(`${home}/f.txt`)
    expect(pinMismatchReason('/p')).toContain('/p')
  })

  it('a scratchpad path: pinned as is when it is a fixed point, and pinned as its FOLDED fixed point (never the original spelling) when its own name holds a unicode space', async () => {
    const scratch = '/tmp/claudeui-1000/proj/sess/scratchpad'
    const cwd = '/home/u/My\u3000Project'
    const scope = scopeAt(
      cwd,
      HOME,
      {
        '/tmp': 'dir',
        '/tmp/claudeui-1000': 'dir',
        '/tmp/claudeui-1000/proj': 'dir',
        '/tmp/claudeui-1000/proj/sess': 'dir',
        [scratch]: 'dir'
      },
      { scratchpad: scratch }
    )
    const decision = await withPathGuard(
      'write',
      { path: `${scratch}/out.txt`, content: 'x' },
      scope,
      allow
    )
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { path: `${scratch}/out.txt` }
    })
    // a scratchpad whose own path holds the space: the model's spelling is folded by pi (and by us),
    // so what is gated is the folded path, which is pinned as a fixed point — never the original
    const odd = '/tmp/My\u00A0Tmp/claudeui-1000/p/s/scratchpad'
    const oddScope = scopeAt(HOME, HOME, {}, { scratchpad: odd })
    const d2 = await withPathGuard('write', { path: `${odd}/o.txt`, content: 'x' }, oddScope, allow)
    const pin = (d2 as unknown as { updatedInput: { path: string } }).updatedInput.path
    expect(pin).toBe('/tmp/My Tmp/claudeui-1000/p/s/scratchpad/o.txt')
    expect(opens(pin, HOME, 'linux', HOME)).toBe(pin)
  })

  it('win32: a cwd with an ideographic space pins the relative spelling', async () => {
    const cwd = 'C:\\work\\新しい\u3000フォルダー'
    const scope: PiPathScope = {
      cwd,
      roots: [cwd],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: makeVirtualFs('win32', { [cwd]: 'dir' })
    }
    const decision = await withPathGuard('write', { path: 'src/a.txt', content: 'x' }, scope, allow)
    const pin = (decision as unknown as { updatedInput: { path: string } }).updatedInput.path
    expect(pin).toBe('src\\a.txt')
    expect(opens(pin, cwd, 'win32', 'C:\\Users\\u')).toBe(`${cwd}\\src\\a.txt`)
  })

  it("read's macOS variant (narrow no-break space): pi folds it, so the resolved (pre-variant) spelling is pinned and pi re-derives the variant", async () => {
    const variant = `/repo/Screenshot 10.00.00${NNBSP}AM.png`
    const scope = posixScope()
    const facts = factsOf('read', { path: 'Screenshot 10.00.00 AM.png' }, scope)
    expect(facts.execPath).toBe(variant)
    const decision = await withPathGuard(
      'read',
      { path: 'Screenshot 10.00.00 AM.png' },
      scope,
      allow
    )
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { path: '/repo/Screenshot 10.00.00 AM.png' }
    })
  })

  it('pinFor: the absolute path when it is a fixed point; undefined when nothing round-trips', () => {
    const scope = scopeAt('/repo', HOME, {})
    expect(pinFor('/repo/a.ts', '/repo/a.ts', scope)).toBe('/repo/a.ts')
    expect(pinFor('/etc/x', '/etc/x', scope)).toBe('/etc/x')
    expect(pinFor('/repo', '/repo', scope)).toBe('/repo')
    // a path that itself holds a folded character cannot be spelled to pi at all
    expect(pinFor('/repo/a\u3000b', '/repo/a\u3000b', scope)).toBeUndefined()
    // the cwd-relative spelling is only a pin while it stays under the cwd (no leading `..`)
    const tainted = scopeAt('/h/A　B/proj', HOME, {})
    expect(pinFor('/h/A　B/proj/a.ts', '/h/A　B/proj/a.ts', tainted)).toBe('a.ts')
    expect(pinFor('/h/A　B/shared/f', '/h/A　B/shared/f', tainted)).toBeUndefined()
    expect(pinFor('/h/A　B', '/h/A　B', tainted)).toBeUndefined()
    // an unusable cwd (pi would throw)
    expect(pinFor('/x', '/x', { ...scope, cwd: 'file://host/x' })).toBeUndefined()
  })
})

describe('F2-1 / F2-2 — the pin ladder: absolute, cwd-relative (never climbing), the model spelling (only where trustworthy), else deny', () => {
  const allow = async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' })
  const HOME = '/h/u'
  // pi resolves a relative path against process.cwd(), the PHYSICAL cwd on POSIX; ours is logical
  const CWD = '/h/A\u3000B/proj'
  const SHARED = '/h/A\u3000B/shared'
  const NODES: Record<string, VirtualNode> = {
    '/h': 'dir',
    '/h/u': 'dir',
    '/h/A\u3000B': 'dir',
    [CWD]: 'dir',
    [`${CWD}/src`]: 'dir',
    [SHARED]: 'dir'
  }
  const scopeAt = (over: Partial<PiPathScope> = {}): PiPathScope => ({
    cwd: CWD,
    roots: [CWD, SHARED],
    platform: 'linux',
    homeDir: HOME,
    fs: makeVirtualFs('posix', NODES),
    ...over
  })
  const pinOf = (d: unknown): string => (d as { updatedInput: { path: string } }).updatedInput.path

  it('step 2, allow: a path under the cwd pins the cwd-relative spelling, even when the model climbed out and back (`../proj/x`)', async () => {
    const scope = scopeAt()
    for (const [input, pin] of [
      [{ path: 'src/new.txt', content: 'x' }, 'src/new.txt'],
      [{ path: '../proj/x.txt', content: 'x' }, 'x.txt'],
      [{ path: './src/../y.txt', content: 'x' }, 'y.txt']
    ] as const) {
      const decision = await withPathGuard('write', input, scope, allow)
      expect(pinOf(decision), input.path).toBe(pin)
      expect(piResolvePath(pin, CWD, 'linux', HOME), input.path).toBe(
        factsOf('write', input, scope).execPath
      )
    }
  })

  it('step 2, deny: a target that is only reachable by a spelling climbing above the cwd is never pinned relative (reviewer probe)', async () => {
    const scope = scopeAt()
    // the facts agree that this is an in-scope additional directory...
    const facts = factsOf('write', { path: '../shared/f.txt', content: 'x' }, scope)
    expect(facts).toMatchObject({ execPath: `${SHARED}/f.txt`, inScope: true })
    // ...but pi would resolve `../shared/f.txt` against its own (physical) cwd, so no pin exists
    expect(pinFor(facts.execPath, facts.resolved, scope)).toBeUndefined()
    for (const tool of ['write', 'edit'] as const) {
      for (const p of ['../shared/f.txt', 'src/../../shared/f.txt', '@../shared/f.txt']) {
        const decision = await withPathGuard(tool, { path: p, content: 'x' }, scope, allow)
        expect(decision, `${tool} ${p}`).toEqual({
          behavior: 'deny',
          reason: pinMismatchReason(`${SHARED}/f.txt`)
        })
      }
    }
  })

  it('step 3, allow: a spelling that is absolute after normalisation (`~/`, `file://`) passes through unpinned when it opens the gated path', async () => {
    const home = '/h/u\u3000x'
    const scope = scopeAt({ homeDir: home })
    const viaHome = await withPathGuard('write', { path: '~/f.txt', content: 'x' }, scope, allow)
    expect(viaHome).toEqual({ behavior: 'allow' })
    expect(piResolvePath('~/f.txt', CWD, 'linux', home)).toBe(`${home}/f.txt`)
    // the shared directory by URL: execPath holds the (unfolded) U+3000, which no absolute pin survives
    const url = 'file:///h/A%E3%80%80B/shared/f.txt'
    const facts = factsOf('write', { path: url, content: 'x' }, scope)
    expect(facts.execPath).toBe(`${SHARED}/f.txt`)
    expect(pinFor(facts.execPath, facts.resolved, scope)).toBeUndefined()
    expect(await withPathGuard('write', { path: url, content: 'x' }, scope, allow)).toEqual({
      behavior: 'allow'
    })
  })

  it('step 3, deny: win32 drive-relative `D:..\\x` is never passed through (pi uses its per-drive cwd)', async () => {
    const cwd = 'D:\\a\u3000b\\proj'
    const shared = 'D:\\a\u3000b\\shared'
    const scope: PiPathScope = {
      cwd,
      roots: [cwd, shared],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: makeVirtualFs('win32', { [cwd]: 'dir', [shared]: 'dir' })
    }
    const input = { path: 'D:..\\shared\\f.txt', content: 'x' }
    const facts = factsOf('write', input, scope)
    expect(facts.execPath).toBe(`${shared}\\f.txt`)
    // the cwd-relative spelling climbs, so step 2 is out and the raw spelling is all that is left
    expect(pinFor(facts.execPath, facts.resolved, scope)).toBeUndefined()
    expect(await withPathGuard('write', input, scope, allow)).toEqual({
      behavior: 'deny',
      reason: pinMismatchReason(`${shared}\\f.txt`)
    })
    // `D:f.txt` stays under the cwd: step 2 pins it
    const under = await withPathGuard('write', { path: 'D:f.txt', content: 'x' }, scope, allow)
    expect(pinOf(under)).toBe('f.txt')
  })

  describe('rawSpellingHolds', () => {
    const holds = (raw: string, scope: PiPathScope): boolean => {
      const f = factsOf('write', { path: raw, content: 'x' }, scope)
      return rawSpellingHolds(f, scope)
    }
    const posix = scopeAt({
      cwd: '/repo',
      roots: ['/repo'],
      fs: makeVirtualFs('posix', { '/repo': 'dir' })
    })
    const win: PiPathScope = {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: makeVirtualFs('win32', { 'D:\\repo': 'dir' })
    }

    it('relative spellings that stay under the cwd, absolute ones and `~` hold', () => {
      for (const p of [
        'a.txt',
        './a.txt',
        'a/../b.txt',
        '/etc/x',
        '~/x',
        '~',
        '@a.txt',
        '..\\x',
        '~user/x'
      ])
        expect(holds(p, posix), p).toBe(true)
    })

    it('a relative spelling that climbs above the cwd after normalisation does not', () => {
      for (const p of ['../x', 'a/../../x', '@../x', '..', './../x', '../../etc/passwd'])
        expect(holds(p, posix), p).toBe(false)
    })

    it('win32: drive-relative and rooted-driveless spellings do not; a drive path, UNC and a relative path do', () => {
      for (const p of ['C:x', 'D:..\\x', 'd:x.txt', '\\repo\\x.txt', '/repo/x.txt', '\\x'])
        expect(holds(p, win), p).toBe(false)
      for (const p of ['x.txt', '.\\x.txt', 'D:\\repo\\x.txt', 'D:/repo/x.txt', '/c/x', '~/x'])
        expect(holds(p, win), p).toBe(true)
      expect(holds('..\\x', win)).toBe(false)
    })

    it('a spelling that does not open the gated path does not hold (and a throwing one never)', () => {
      const f = factsOf('write', { path: 'a.txt', content: 'x' }, posix)
      expect(rawSpellingHolds({ ...f, execPath: '/other', resolved: '/other' }, posix)).toBe(false)
      expect(rawSpellingHolds({ ...f, raw: 'file://host/x' }, posix)).toBe(false)
    })
  })
})

describe('F2-4 — a DOS device name is placed with no filesystem call (win32)', () => {
  const TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const
  const DEVICES = [
    'NUL',
    'nul',
    'CON',
    'PRN',
    'AUX',
    'COM1',
    'COM9',
    'LPT1',
    'lpt9',
    'CONIN$',
    'CONOUT$',
    'NUL.txt',
    'com1.log',
    'src\\CON\\x.ts',
    'src\\sub\\AUX.d\\y',
    'D:\\repo\\NUL',
    '/repo/prn.txt',
    '@COM2'
  ]
  const scopeWith = (fs: PathScopeFs): PiPathScope => ({
    cwd: 'D:\\repo',
    roots: ['D:\\repo'],
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    fs
  })

  it.each(DEVICES)('%s: unresolved + device, every tool, ZERO filesystem calls', (p) => {
    const { fs, calls } = recordingWinFs({ 'D:\\repo': 'dir', 'D:\\repo\\src': 'dir' })
    const scope = scopeWith(fs)
    for (const tool of TOOLS) {
      calls.length = 0
      const input = tool === 'write' ? { path: p, content: 'x' } : { path: p }
      const f = pathFacts(tool, input, scope)!
      expect(calls, `${tool} ${p}`).toEqual([])
      expect(f, `${tool} ${p}`).toMatchObject({
        state: 'unresolved',
        device: true,
        remote: false,
        inScope: false,
        inFence: false,
        carriedOut: false
      })
      expect(f.landing).toBeUndefined()
      expect(humanOnlyMessage(f)).toContain('Windows device')
    }
  })

  it('names that merely contain a device word are ordinary: the filesystem is consulted and nothing is flagged', () => {
    for (const p of ['console.ts', 'nullable.ts', 'com10', 'src\\communicate\\x', 'auxiliary.md']) {
      const { fs, calls } = recordingWinFs({ 'D:\\repo': 'dir', 'D:\\repo\\src': 'dir' })
      const f = pathFacts('write', { path: p, content: 'x' }, scopeWith(fs))!
      expect(f.device, p).toBe(false)
      expect(calls.length, p).toBeGreaterThan(0)
    }
  })

  it('F3-4: a link whose TARGET has a DOS device component (directly, relative, via a chain, or in a link-target ancestor) is unresolved + device, and the device is never looked at', () => {
    const { fs, calls } = recordingWinFs({
      'D:\\repo': 'dir',
      'D:\\repo\\src': 'dir',
      'D:\\repo\\devlink': { link: 'NUL' },
      'D:\\repo\\abslink': { link: 'D:\\repo\\sub\\COM1' },
      'D:\\repo\\rellink': { link: '..\\other\\via' },
      'D:\\other': 'dir',
      'D:\\other\\via': { link: 'CON.txt' },
      'D:\\repo\\hop': { link: 'D:\\repo\\devlink' },
      'D:\\repo\\dirlink': { link: 'D:\\repo\\AUX' },
      'D:\\repo\\okay': { link: 'D:\\repo\\src' },
      'D:\\repo\\conlink': { link: 'D:\\repo\\console.ts' },
      // the text names a device even though the path collapses to an ordinary directory
      'D:\\repo\\collapse': { link: 'NUL\\..\\src' }
    })
    const scope = scopeWith(fs)
    // the arguments of every call that names a device component
    const onDevice = (): string[] =>
      calls.filter((c) => /[\\/](?:nul|con|aux|com\d|lpt\d)(?:[.:\s]|$)/i.test(c.split(' ')[1]))
    for (const rel of [
      'devlink',
      'devlink\\x',
      'abslink',
      'rellink\\x',
      'hop',
      'hop\\deep\\x',
      'dirlink\\x',
      'collapse\\x'
    ]) {
      for (const tool of TOOLS) {
        calls.length = 0
        const input = tool === 'write' ? { path: rel, content: 'x' } : { path: rel }
        const f = pathFacts(tool, input, scope)!
        expect(f, `${tool} ${rel}`).toMatchObject({
          state: 'unresolved',
          device: true,
          remote: false,
          inScope: false,
          carriedOut: false
        })
        expect(f.landing).toBeUndefined()
        expect(onDevice(), `${tool} ${rel}`).toEqual([])
        expect(
          calls.filter((c) => c.startsWith('realpath')),
          `${tool} ${rel}`
        ).toEqual([])
        expect(humanOnlyMessage(f)).toContain('Windows device')
      }
    }
    // controls: a link to a local directory, and to a name that merely contains a device word
    const ok = pathFacts('write', { path: 'okay\\n.ts', content: 'x' }, scope)!
    expect(ok).toMatchObject({ device: false, remote: false, landing: 'D:\\repo\\src\\n.ts' })
    const conlink = pathFacts('read', { path: 'conlink' }, scope)!
    expect(conlink.device).toBe(false)
  })

  it('sameFacts: the device flag decides a verdict', () => {
    const { fs } = recordingWinFs({ 'D:\\repo': 'dir' })
    const f = pathFacts('read', { path: 'NUL' }, scopeWith(fs))!
    expect(sameFacts(f, { ...f, device: false }, 'win32')).toBe(false)
  })

  it('POSIX is untouched: a file called `nul` is an ordinary file', () => {
    const f = factsOf('read', { path: 'nul' })
    expect(f.device).toBe(false)
    expect(f.state).toBe('missing-leaf')
  })
})

describe('F3-6 — landingAliases: the landing under a root’s logical spelling', () => {
  const nodes: Record<string, VirtualNode> = {
    '/physical': 'dir',
    '/physical/src': 'dir',
    '/physical/src/a.ts': 'file',
    '/physical/lnk': { link: '/outside' },
    '/outside': 'dir',
    '/outside/f': 'file',
    '/logical': { link: '/physical' }
  }
  const scope = (): PiPathScope => ({
    cwd: '/logical',
    roots: ['/logical'],
    platform: 'linux',
    homeDir: '/home/u',
    fs: makeVirtualFs('posix', nodes)
  })

  it('a root reached through a link: the landing is also spelled under the root, and a missing leaf too', () => {
    expect(pathFacts('read', { path: 'src/a.ts' }, scope())).toMatchObject({
      landing: '/physical/src/a.ts',
      landingAliases: ['/logical/src/a.ts']
    })
    expect(pathFacts('write', { path: 'src/new.ts', content: 'x' }, scope())).toMatchObject({
      landing: '/physical/src/new.ts',
      landingAliases: ['/logical/src/new.ts']
    })
  })

  it('no alias when no root is a link, or the landing is outside the root’s real path', () => {
    const plain = { ...scope(), cwd: '/physical', roots: ['/physical'] }
    expect(pathFacts('read', { path: 'src/a.ts' }, plain)!.landingAliases).toBeUndefined()
    expect(pathFacts('read', { path: 'lnk/f' }, scope())!).toMatchObject({ landing: '/outside/f' })
    expect(pathFacts('read', { path: 'lnk/f' }, scope())!.landingAliases).toBeUndefined()
  })
})

describe('N2 — a missing leaf that appears during the approval is not a changed path', () => {
  it('sameFacts ignores `state` when both landings are equal and neither side is unresolved', () => {
    const a = factsOf('write', { path: 'src/new.ts', content: '' })
    expect(a.state).toBe('missing-leaf')
    expect(sameFacts(a, { ...a, state: 'resolved' }, 'linux')).toBe(true)
    // but unresolved on either side still differs
    expect(sameFacts(a, { ...a, state: 'unresolved', landing: undefined }, 'linux')).toBe(false)
    expect(sameFacts({ ...a, state: 'unresolved', landing: undefined }, a, 'linux')).toBe(false)
    // and a different landing still differs
    expect(sameFacts(a, { ...a, state: 'resolved', landing: '/repo/src/other.ts' }, 'linux')).toBe(
      false
    )
  })

  it('withPathGuard: the file being created while the card is open still allows (and pins)', async () => {
    const vfs = makeVirtualFs('posix', POSIX_NODES)
    const scope = posixScope({ fs: vfs })
    const decision = await withPathGuard(
      'write',
      { path: 'src/created-meanwhile.ts', content: 'x' },
      scope,
      async () => {
        vfs.set('/repo/src/created-meanwhile.ts', 'file')
        return { behavior: 'allow' as const }
      }
    )
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { path: '/repo/src/created-meanwhile.ts' }
    })
  })
})

describe('R4 helpers — path-scoped "always allow" rules for an outside target', () => {
  it('absoluteRuleSpecifier: `//` absolute on POSIX, `//c/…` for a drive; refuses roots, relative, UNC and glob characters', () => {
    expect(absoluteRuleSpecifier('/opt/data', 'linux')).toBe('//opt/data')
    expect(absoluteRuleSpecifier('/opt/data/', 'linux')).toBe('//opt/data')
    expect(absoluteRuleSpecifier('C:\\Users\\u\\docs', 'win32')).toBe('//c/Users/u/docs')
    expect(absoluteRuleSpecifier('D:\\x', 'win32')).toBe('//d/x')
    for (const [p, platform] of [
      ['/', 'linux'],
      ['C:\\', 'win32'],
      ['relative/dir', 'linux'],
      [`${BS}${BS}host${BS}share${BS}x`, 'win32'],
      ['/opt/da*ta', 'linux'],
      ['/opt/da?ta', 'linux'],
      ['/opt/(x)', 'linux']
    ] as const)
      expect(absoluteRuleSpecifier(p, platform), p).toBeUndefined()
  })

  it("read -> Read(//<dir>/**), edit/write -> Edit(//<dir>/**) on the target's directory", () => {
    expect(outsideAllowRules('read', '/opt/data/a.txt', 'linux')).toEqual([
      { toolName: 'Read', ruleContent: '//opt/data/**' }
    ])
    for (const tool of ['edit', 'write'])
      expect(outsideAllowRules(tool, '/opt/data/new.txt', 'linux')).toEqual([
        { toolName: 'Edit', ruleContent: '//opt/data/**' }
      ])
    expect(outsideAllowRules('read', 'C:\\Users\\u\\n.txt', 'win32')).toEqual([
      { toolName: 'Read', ruleContent: '//c/Users/u/**' }
    ])
  })

  it('a search covers the searched path itself and everything under it (Read, never a bare tool rule)', () => {
    for (const tool of ['grep', 'find', 'ls'])
      expect(outsideAllowRules(tool, '/opt/data', 'linux')).toEqual([
        { toolName: 'Read', ruleContent: '//opt/data' },
        { toolName: 'Read', ruleContent: '//opt/data/**' }
      ])
  })

  it('nothing to offer for a root target, a non-path tool, or a glob-character directory', () => {
    expect(outsideAllowRules('read', '/etc', 'linux')).toBeUndefined() // dir '/' is a root
    expect(outsideAllowRules('grep', '/', 'linux')).toBeUndefined()
    expect(outsideAllowRules('bash', '/opt/x', 'linux')).toBeUndefined()
    expect(outsideAllowRules('write', '/opt/a*/x', 'linux')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real symlinks / junctions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slice F4 (second exit review)
// ---------------------------------------------------------------------------

/** A recording wrapper around a virtual POSIX fs: every call, with its argument, in order. */
function recordingPosixFs(nodes: Record<string, VirtualNode>) {
  const inner = makeVirtualFs('posix', nodes)
  const calls: string[] = []
  const fs: PathScopeFs = {
    realpath: (p) => (calls.push(`realpath ${p}`), inner.realpath(p)),
    lstat: (p) => (calls.push(`lstat ${p}`), inner.lstat(p)),
    readlink: (p) => (calls.push(`readlink ${p}`), inner.readlink(p)),
    exists: (p) => (calls.push(`exists ${p}`), inner.exists(p))
  }
  return { fs, calls, inner }
}

const F4_TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const
const toolInput = (tool: string, p: string): Record<string, unknown> =>
  tool === 'write' ? { path: p, content: 'x' } : { path: p }
/** A call argument that is under one of the namespaces (`recordingPosixFs` prints `<op> <path>`). */
const NAMESPACE_ARG = /^\w+ \/(?:net|network|\.vol|\.file|\.nofollow|\.resolve)(?:\/|$)/i

describe('F4-1 — automount and kernel-redirect namespaces are placed with no filesystem call (POSIX)', () => {
  const scopeFor = (
    platform: NodeJS.Platform,
    fs: PathScopeFs,
    roots: string[] = []
  ): PiPathScope => ({ cwd: '/repo', roots, platform, homeDir: '/home/u', fs })

  // `/net` is every POSIX platform (Linux autofs too)
  const NET = [
    '/net/x.example/f',
    '/net',
    '/net/h',
    '/NET/x.example/f',
    '/Net/h/f',
    '/repo/../net/h/f',
    '../net/h/f',
    '@/net/h/f',
    'file:///net/x.example/f',
    '/n\u200cet/h/f',
    '/net/h/Shot 1.00 PM.png'
  ]
  // darwin only
  const DARWIN = [
    '/Network/Servers/h/f',
    '/network/servers/h/f',
    '/Network',
    '/.vol/1/2',
    '/.VOL/1/2',
    '/.file/id=1.2',
    '/.nofollow/x',
    '/.resolve/x',
    '/.vol'
  ]

  describe.each(['linux', 'darwin'] as const)('platform %s', (platform) => {
    it.each(NET)('%s: unresolved + remote, every tool, ZERO filesystem calls', (p) => {
      const { fs, calls } = recordingPosixFs({ '/repo': 'dir' })
      for (const tool of F4_TOOLS) {
        calls.length = 0
        const f = pathFacts(tool, toolInput(tool, p), scopeFor(platform, fs))!
        expect(calls, `${tool} ${p}`).toEqual([])
        expect(f, `${tool} ${p}`).toMatchObject({
          state: 'unresolved',
          remote: true,
          device: false,
          inScope: false,
          inFence: false,
          carriedOut: false
        })
        expect(f.landing).toBeUndefined()
        expect(humanOnlyMessage(f)).toContain('is a network path')
      }
    })

    it.each(DARWIN)(
      platform === 'darwin'
        ? '%s: unresolved + remote, every tool, ZERO filesystem calls'
        : '%s: an ordinary path on Linux (the filesystem is consulted, nothing is flagged)',
      (p) => {
        const { fs, calls } = recordingPosixFs({ '/repo': 'dir' })
        for (const tool of F4_TOOLS) {
          calls.length = 0
          const f = pathFacts(tool, toolInput(tool, p), scopeFor(platform, fs))!
          if (platform === 'darwin') {
            expect(calls, `${tool} ${p}`).toEqual([])
            expect(f, `${tool} ${p}`).toMatchObject({
              state: 'unresolved',
              remote: true,
              inScope: false
            })
          } else {
            expect(calls.length, `${tool} ${p}`).toBeGreaterThan(0)
            expect(f.remote, `${tool} ${p}`).toBe(false)
          }
        }
      }
    )

    it('a path that merely contains the word is ordinary (/netx, /repo/net, /.volume, /internet)', () => {
      for (const p of ['/netx/f', '/repo/net/x', '/repo/.vol/x', '/.volume/x', '/internet/x']) {
        const { fs, calls } = recordingPosixFs({ '/repo': 'dir' })
        const f = pathFacts('read', { path: p }, scopeFor(platform, fs))!
        expect(f.remote, p).toBe(false)
        expect(calls.length, p).toBeGreaterThan(0)
      }
    })

    it('a namespace additional directory is never probed, and nothing under it is in scope; the cwd still works', () => {
      const { fs, calls } = recordingPosixFs({
        '/repo': 'dir',
        '/repo/src': 'dir',
        '/repo/src/a.ts': 'file'
      })
      const scope = buildPiPathScope({
        cwd: '/repo',
        rules: { additionalDirectories: ['/net/h/share', '/Network/Servers/h/s', '/.vol/1/2'] },
        platform,
        fs,
        homeDir: '/home/u'
      })
      for (const tool of F4_TOOLS) {
        calls.length = 0
        const ok = pathFacts(tool, toolInput(tool, 'src/a.ts'), scope)!
        expect(ok, tool).toMatchObject({ state: 'resolved', inScope: true, remote: false })
        expect(
          calls.filter(
            (c) => NAMESPACE_ARG.test(c) && (platform === 'darwin' || /\/net\b/i.test(c))
          ),
          tool
        ).toEqual([])
        calls.length = 0
        const net = pathFacts(tool, toolInput(tool, '/net/h/share/f'), scope)!
        expect(net, tool).toMatchObject({ state: 'unresolved', remote: true, inScope: false })
        expect(calls, tool).toEqual([])
      }
    })

    it('a link whose target text is under /net (directly, relative, via a chain, in a link-target ancestor) is unresolved + remote before any realpath', () => {
      const { fs, calls } = recordingPosixFs({
        '/repo': 'dir',
        '/repo/src': 'dir',
        '/repo/evil': { link: '/net/h/x' },
        '/repo/hop': { link: '/repo/evil' },
        '/repo/rel': { link: '../net/h' },
        '/repo/via': { link: '../other/via' },
        '/other': 'dir',
        '/other/via': { link: '/NET/h' },
        '/repo/ok': { link: '/repo/src' }
      })
      for (const rel of ['evil', 'evil/x', 'hop', 'hop/deep/x', 'rel/x', 'via/x']) {
        for (const tool of F4_TOOLS) {
          calls.length = 0
          const f = pathFacts(tool, toolInput(tool, rel), scopeFor(platform, fs, ['/repo']))!
          expect(f, `${tool} ${rel}`).toMatchObject({ state: 'unresolved', remote: true })
          expect(f.landing).toBeUndefined()
          expect(
            calls.filter((c) => c.startsWith('realpath') && /evil|hop|rel|via/.test(c)),
            `${tool} ${rel}`
          ).toEqual([])
          expect(
            calls.filter((c) => NAMESPACE_ARG.test(c)),
            `${tool} ${rel}`
          ).toEqual([])
          expect(humanOnlyMessage(f)).toContain('is a network path')
        }
      }
      // control: a link to a local directory is followed as before
      const ok = pathFacts(
        'write',
        toolInput('write', 'ok/n.ts'),
        scopeFor(platform, fs, ['/repo'])
      )!
      expect(ok).toMatchObject({ remote: false, landing: '/repo/src/n.ts', inScope: true })
    })

    it(`a link whose target is under /Network or /.vol is ${platform === 'darwin' ? 'remote' : 'an ordinary dangling link'}`, () => {
      const { fs, calls } = recordingPosixFs({
        '/repo': 'dir',
        '/repo/nw': { link: '/Network/Servers/h' },
        '/repo/vol': { link: '/.vol/1/2' },
        '/repo/rel': { link: '../.nofollow/x' }
      })
      for (const rel of ['nw/x', 'vol', 'rel']) {
        calls.length = 0
        const f = pathFacts('read', { path: rel }, scopeFor(platform, fs, ['/repo']))!
        expect(f.state, rel).toBe('unresolved')
        if (platform === 'darwin') {
          expect(f.remote, rel).toBe(true)
          expect(
            calls.filter((c) => NAMESPACE_ARG.test(c)),
            rel
          ).toEqual([])
          expect(
            calls.filter((c) => c.startsWith('realpath')),
            rel
          ).toEqual([])
        } else {
          expect(f.remote, rel).toBe(false)
        }
      }
    })
  })

  it('isPosixNamespacePath: the first component decides, after `.` / `..` are folded, ignoring case and zero-width characters', () => {
    const yes: Array<[string, NodeJS.Platform]> = [
      ['/net', 'linux'],
      ['/net/h/x', 'linux'],
      ['/NET/h', 'linux'],
      ['//net//h', 'linux'],
      ['/./net/h', 'linux'],
      ['/n\u200det/h', 'linux'],
      ['/net/../etc', 'linux'], // conservative, as Claude's: the name was spelled
      ['/Network/Servers/h', 'darwin'],
      ['/network', 'darwin'],
      ['/.vol/1/2', 'darwin'],
      ['/.FILE/x', 'darwin'],
      ['/.nofollow/x', 'darwin'],
      ['/.resolve/x', 'darwin'],
      ['/.vol/../etc/passwd', 'darwin'],
      ['/net/h', 'darwin']
    ]
    const no: Array<[string, NodeJS.Platform]> = [
      ['/Network/Servers/h', 'linux'],
      ['/.vol/1/2', 'linux'],
      ['/repo/net', 'linux'],
      ['/repo/.vol', 'darwin'],
      ['/netx', 'linux'],
      ['/.volume', 'darwin'],
      ['/', 'darwin'],
      ['net/h', 'linux'],
      ['/net/h', 'win32'],
      ['\\net\\h', 'win32']
    ]
    for (const [p, plat] of yes) expect(isPosixNamespacePath(p, plat), `${plat} ${p}`).toBe(true)
    for (const [p, plat] of no) expect(isPosixNamespacePath(p, plat), `${plat} ${p}`).toBe(false)
  })

  it('sameFacts: a link that turned into a /net link while a human sat on the card changes the verdict facts', () => {
    const { fs, inner } = recordingPosixFs({ '/repo': 'dir', '/repo/l': 'dir' })
    const scope = scopeFor('linux', fs, ['/repo'])
    const before = pathFacts('write', toolInput('write', 'l/f.ts'), scope)!
    inner.set('/repo/l', { link: '/net/h/x' })
    const after = pathFacts('write', toolInput('write', 'l/f.ts'), scope)!
    expect(after.remote).toBe(true)
    expect(sameFacts(before, after, 'linux')).toBe(false)
  })
})

describe('F4-3 — a link walk that cannot read an entry makes the path unplaceable, not "end of walk"', () => {
  const eacces = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: fixture`), { code })

  function fsDenying(
    platform: 'posix' | 'win32',
    nodes: Record<string, VirtualNode>,
    deny: { lstat?: string; readlink?: string; code: string }
  ) {
    const inner = makeVirtualFs(platform, nodes)
    const calls: string[] = []
    const same = (a: string, b: string): boolean =>
      platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    const fs: PathScopeFs = {
      realpath: (p) => (calls.push(`realpath ${p}`), inner.realpath(p)),
      lstat: (p) => {
        calls.push(`lstat ${p}`)
        if (deny.lstat !== undefined && same(p, deny.lstat)) throw eacces(deny.code)
        return inner.lstat(p)
      },
      readlink: (p) => {
        calls.push(`readlink ${p}`)
        if (deny.readlink !== undefined && same(p, deny.readlink)) throw eacces(deny.code)
        return inner.readlink(p)
      },
      exists: (p) => inner.exists(p)
    }
    return { fs, calls }
  }

  it.each(['EACCES', 'EPERM', 'ELOOP', 'EIO'])(
    'POSIX: lstat %s on a component -> unresolved, no realpath, not remote',
    (code) => {
      const { fs, calls } = fsDenying(
        'posix',
        { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.ts': 'file' },
        { lstat: '/repo/src', code }
      )
      const scope: PiPathScope = {
        cwd: '/repo',
        roots: [],
        platform: 'linux',
        homeDir: '/home/u',
        fs
      }
      for (const tool of F4_TOOLS) {
        calls.length = 0
        const f = pathFacts(tool, toolInput(tool, 'src/a.ts'), scope)!
        expect(f, `${tool}`).toMatchObject({
          state: 'unresolved',
          remote: false,
          device: false,
          inScope: false,
          carriedOut: false
        })
        expect(
          calls.filter((c) => c.startsWith('realpath')),
          tool
        ).toEqual([])
        expect(humanOnlyMessage(f)).toContain('could not be determined')
      }
    }
  )

  it('POSIX: a link whose readlink fails -> unresolved, no realpath, not remote', () => {
    const { fs, calls } = fsDenying(
      'posix',
      { '/repo': 'dir', '/repo/src': 'dir', '/repo/lnk': { link: '/repo/src' } },
      { readlink: '/repo/lnk', code: 'EPERM' }
    )
    const scope: PiPathScope = {
      cwd: '/repo',
      roots: [],
      platform: 'linux',
      homeDir: '/home/u',
      fs
    }
    const f = pathFacts('write', toolInput('write', 'lnk/a.ts'), scope)!
    expect(f).toMatchObject({ state: 'unresolved', remote: false, inScope: false })
    expect(calls.filter((c) => c.startsWith('realpath'))).toEqual([])
  })

  it('win32: lstat EACCES / readlink EPERM -> unresolved, no realpath (was: "remote" for readlink, "end of walk" for lstat)', () => {
    const nodes: Record<string, VirtualNode> = {
      'D:\\repo': 'dir',
      'D:\\repo\\src': 'dir',
      'D:\\repo\\src\\a.ts': 'file',
      'D:\\repo\\lnk': { link: 'D:\\repo\\src' }
    }
    for (const deny of [
      { lstat: 'D:\\repo\\src', code: 'EACCES' },
      { readlink: 'D:\\repo\\lnk', code: 'EPERM' }
    ]) {
      const { fs, calls } = fsDenying('win32', nodes, deny)
      const scope: PiPathScope = {
        cwd: 'D:\\repo',
        roots: [],
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        fs
      }
      const rel = deny.lstat ? 'src\\a.ts' : 'lnk\\a.ts'
      const f = pathFacts('write', toolInput('write', rel), scope)!
      expect(f, rel).toMatchObject({ state: 'unresolved', remote: false, device: false })
      expect(
        calls.filter((c) => c.startsWith('realpath')),
        rel
      ).toEqual([])
    }
  })

  it('a link loop is unresolved with no realpath on either platform family, and is not called a network path', () => {
    const { fs, calls } = recordingPosixFs({
      '/repo': 'dir',
      '/repo/loop-a': { link: '/repo/loop-b' },
      '/repo/loop-b': { link: '/repo/loop-a' }
    })
    const scope: PiPathScope = {
      cwd: '/repo',
      roots: [],
      platform: 'linux',
      homeDir: '/home/u',
      fs
    }
    const f = pathFacts('read', { path: 'loop-a/x' }, scope)!
    expect(f).toMatchObject({ state: 'unresolved', remote: false })
    expect(calls.filter((c) => c.startsWith('realpath'))).toEqual([])
    expect(humanOnlyMessage(f)).not.toContain('network path')
  })

  it('a missing entry still ends the walk: a new file in a new directory is a missing leaf', () => {
    const { fs } = recordingPosixFs({ '/repo': 'dir' })
    const scope: PiPathScope = {
      cwd: '/repo',
      roots: ['/repo'],
      platform: 'linux',
      homeDir: '/home/u',
      fs
    }
    expect(pathFacts('write', toolInput('write', 'new/dir/f.ts'), scope)).toMatchObject({
      state: 'missing-leaf',
      inScope: true
    })
  })

  it('the read block says why: network, device, or undetermined', () => {
    const posix = recordingPosixFs({ '/repo': 'dir' })
    const scope: PiPathScope = {
      cwd: '/repo',
      roots: ['/repo'],
      platform: 'darwin',
      homeDir: '/home/u',
      fs: posix.fs,
      blockOutsideReads: true
    }
    const net = pathFacts('read', { path: '/net/h/f' }, scope)!
    expect(readBlockMessage(net, scope)).toContain('is a network path')
    expect(readBlockMessage(net, scope)).not.toContain('could not be determined')
    expect(readBlockMessage(net, scope)).toContain('blockReadsOutsideWorkingDirectories')

    const win = recordingWinFs({ 'D:\\repo': 'dir' })
    const winScope: PiPathScope = {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: win.fs,
      blockOutsideReads: true
    }
    const dev = pathFacts('read', { path: 'COM1' }, winScope)!
    expect(readBlockMessage(dev, winScope)).toContain('Windows device')
    expect(readBlockMessage(dev, winScope)).toContain('blockReadsOutsideWorkingDirectories')
    const unc = pathFacts('read', { path: '\\\\h\\s\\f' }, winScope)!
    expect(readBlockMessage(unc, winScope)).toContain('is a network path')

    const { fs } = fsDenying(
      'posix',
      { '/repo': 'dir', '/repo/a': 'file' },
      {
        lstat: '/repo/a',
        code: 'EACCES'
      }
    )
    const other: PiPathScope = { ...scope, platform: 'linux', fs }
    const undetermined = pathFacts('read', { path: 'a' }, other)!
    expect(readBlockMessage(undetermined, other)).toContain('could not be determined')
  })
})

describe('F4-2 — DOS device names: superscript digits and the odd spellings (win32)', () => {
  const scopeWith = (fs: PathScopeFs): PiPathScope => ({
    cwd: 'D:\\repo',
    roots: ['D:\\repo'],
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    fs
  })
  const DEVICES = [
    'COM\u00B9',
    'com\u00B2',
    'COM\u00B3',
    'LPT\u00B9',
    'lpt\u00B2',
    'LPT\u00B3',
    'COM\u00B9.txt',
    'lpt\u00B3.log',
    'src\\COM\u00B2\\x.ts',
    // the odd spellings Win32 still maps to the device (trailing colon, space, space before the extension)
    'NUL:',
    'COM1 ',
    'CON .txt',
    'aux :stream'
  ]

  it.each(DEVICES)('%j: unresolved + device, every tool, ZERO filesystem calls', (p) => {
    const { fs, calls } = recordingWinFs({ 'D:\\repo': 'dir', 'D:\\repo\\src': 'dir' })
    for (const tool of F4_TOOLS) {
      calls.length = 0
      const f = pathFacts(tool, toolInput(tool, p), scopeWith(fs))!
      expect(calls, `${tool} ${p}`).toEqual([])
      expect(f, `${tool} ${p}`).toMatchObject({ state: 'unresolved', device: true, remote: false })
    }
    expect(suspiciousWindowsPath(`D:\\repo\\${p}`)).toBe(true)
  })

  it('the neighbours are ordinary: COM0, COM10, COM\u2074 (superscript four), LPT0, comx', () => {
    for (const p of ['COM0', 'COM10', 'COM\u2074', 'LPT0', 'lpt\u2075', 'comx', 'COM\u00B9x']) {
      const { fs, calls } = recordingWinFs({ 'D:\\repo': 'dir' })
      const f = pathFacts('write', { path: p, content: 'x' }, scopeWith(fs))!
      expect(f.device, p).toBe(false)
      expect(calls.length, p).toBeGreaterThan(0)
    }
  })

  it('a link whose target is a superscript device is unresolved + device', () => {
    const { fs, calls } = recordingWinFs({
      'D:\\repo': 'dir',
      'D:\\repo\\l': { link: 'D:\\repo\\COM\u00B2' }
    })
    const f = pathFacts('read', { path: 'l' }, scopeWith(fs))!
    expect(f).toMatchObject({ state: 'unresolved', device: true })
    expect(calls.filter((c) => /COM\u00B2/.test(c))).toEqual([])
  })
})

describe('F4-4 — workspaceEditRules: the rule an in-workspace edit/write card suggests', () => {
  it('Edit(//<root>/**) for the root holding the target, for edit and write alike', () => {
    for (const tool of ['edit', 'write'] as const) {
      expect(workspaceEditRules(tool, { path: 'src/a.ts' }, posixScope())).toEqual([
        { toolName: 'Edit', ruleContent: '//repo/**' }
      ])
      expect(workspaceEditRules(tool, { path: '/repo/src/new.ts' }, posixScope())).toEqual([
        { toolName: 'Edit', ruleContent: '//repo/**' }
      ])
    }
  })

  it('an additional directory suggests its own root, not the cwd and not the bare tool', () => {
    expect(workspaceEditRules('write', { path: '/extra/notes.md' }, posixScope())).toEqual([
      { toolName: 'Edit', ruleContent: '//extra/**' }
    ])
  })

  it('nested roots: the narrowest root that holds the target', () => {
    const scope = posixScope({ roots: ['/repo', '/repo/src'] })
    expect(workspaceEditRules('edit', { path: 'src/a.ts' }, scope)).toEqual([
      { toolName: 'Edit', ruleContent: '//repo/src/**' }
    ])
    expect(workspaceEditRules('edit', { path: 'file.txt' }, scope)).toEqual([
      { toolName: 'Edit', ruleContent: '//repo/**' }
    ])
  })

  it('a cwd reached through a link: the rule is spelled the way the cwd is (the allow tier matches that alias)', () => {
    const scope: PiPathScope = {
      cwd: '/logical',
      roots: ['/logical'],
      platform: 'linux',
      homeDir: '/home/u',
      fs: makeVirtualFs('posix', { '/logical': { link: '/physical' }, '/physical': 'dir' })
    }
    expect(workspaceEditRules('write', { path: 'a.ts' }, scope)).toEqual([
      { toolName: 'Edit', ruleContent: '//logical/**' }
    ])
  })

  it('win32: //<drive>/<dir>/**', () => {
    const scope: PiPathScope = {
      cwd: 'D:\\repo',
      roots: ['D:\\repo'],
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fs: makeVirtualFs('win32', { 'D:\\repo': 'dir' })
    }
    expect(workspaceEditRules('edit', { path: 'src\\a.ts' }, scope)).toEqual([
      { toolName: 'Edit', ruleContent: '//d/repo/**' }
    ])
  })

  it('nothing to offer: an outside target, an agent-control path, an unplaceable path, a read tool, the scratchpad, a root with a glob character', () => {
    const scope = posixScope({ scratchpad: '/tmp/claudeui/proj/sess/scratchpad' })
    expect(workspaceEditRules('write', { path: '/etc/passwd' }, scope)).toBeUndefined()
    expect(workspaceEditRules('write', { path: '/repo/link-out/x' }, scope)).toBeUndefined()
    expect(workspaceEditRules('edit', { path: '.git/hooks/pre-commit' }, scope)).toBeUndefined()
    expect(workspaceEditRules('edit', { path: 'dangling/x' }, scope)).toBeUndefined()
    expect(workspaceEditRules('edit', { path: '/net/h/f' }, scope)).toBeUndefined()
    expect(workspaceEditRules('read', { path: 'src/a.ts' }, scope)).toBeUndefined()
    expect(workspaceEditRules('bash', { command: 'ls' }, scope)).toBeUndefined()
    expect(
      workspaceEditRules('write', { path: '/tmp/claudeui/proj/sess/scratchpad/n.md' }, scope)
    ).toBeUndefined()
    const globby = posixScope({
      cwd: '/rep*o',
      roots: ['/rep*o'],
      fs: makeVirtualFs('posix', { '/rep*o': 'dir' })
    })
    expect(workspaceEditRules('write', { path: 'a.ts' }, globby)).toBeUndefined()
  })
})

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
