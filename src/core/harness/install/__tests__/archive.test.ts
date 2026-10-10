/**
 * @vitest-environment node
 *
 * The installer's archive readers (ADR-082 §4): what they extract, and every
 * shape of entry they must refuse. Archives are built in memory and written to
 * a temp directory; nothing is downloaded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { ArchiveError, extractTarGz, extractZip, safeEntryPath } from '../archive'
import { paxPath, sha256, tar, tarEntry, tgz, zip } from './fixtures'

let tmp: string
let dest: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-archive-'))
  dest = path.join(tmp, 'out')
  fs.mkdirSync(dest)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function file(name: string, bytes: Buffer): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}

/** Every file under `dir`, as sorted `/`-separated relative paths. */
function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

describe('safeEntryPath', () => {
  it('normalises separators and dot segments', () => {
    expect(safeEntryPath('./pi/theme\\dark.json')).toBe('pi/theme/dark.json')
    expect(safeEntryPath('a//b/./c')).toBe('a/b/c')
  })

  it.each([
    ['../x', /leaves its directory/],
    ['a/../../x', /leaves its directory/],
    ['..\\x', /leaves its directory/],
    ['/etc/passwd', /absolute path/],
    ['\\\\server\\share\\x', /absolute path/],
    ['C:/Windows/x', /absolute path/],
    ['c:x', /absolute path/],
    ['pi/file.exe:stream', /':'/],
    ['.', /empty name/],
    ['a\0b', /NUL/]
  ])('refuses %j', (name, message) => {
    expect(() => safeEntryPath(name)).toThrow(message)
  })
})

describe('extractTarGz', () => {
  it('extracts files and directories, hashing each file', async () => {
    const archive = file(
      'a.tgz',
      tgz([
        tarEntry('pi/', '', { type: '5', mode: 0o755 }),
        tarEntry('pi/pi', 'binary', { mode: 0o755 }),
        tarEntry('pi/theme/dark.json', '{}')
      ])
    )
    const files = await extractTarGz(archive, dest)
    expect(listing(dest)).toEqual(['pi/pi', 'pi/theme/dark.json'])
    expect(files).toEqual([
      { entryPath: 'pi/pi', dest: path.join(dest, 'pi', 'pi'), size: 6, sha256: sha256('binary') },
      {
        entryPath: 'pi/theme/dark.json',
        dest: path.join(dest, 'pi', 'theme', 'dark.json'),
        size: 2,
        sha256: sha256('{}')
      }
    ])
    expect(fs.readFileSync(path.join(dest, 'pi', 'pi'), 'utf8')).toBe('binary')
  })

  it.skipIf(process.platform === 'win32')('keeps the executable bit and drops setuid', async () => {
    const archive = file(
      'a.tgz',
      tgz([tarEntry('run', 'x', { mode: 0o4755 }), tarEntry('data', 'y', { mode: 0o600 })])
    )
    await extractTarGz(archive, dest)
    expect(fs.statSync(path.join(dest, 'run')).mode & 0o7777).toBe(0o755)
    expect(fs.statSync(path.join(dest, 'data')).mode & 0o7777).toBe(0o600)
  })

  it('writes only selected entries, but still lists the rest', async () => {
    const archive = file(
      'a.tgz',
      tgz([tarEntry('package/package.json', '{}'), tarEntry('package/bin/opencode', 'bin')])
    )
    const files = await extractTarGz(archive, dest, {
      select: (p) => (p === 'package/bin/opencode' ? 'opencode' : null)
    })
    expect(listing(dest)).toEqual(['opencode'])
    expect(files.map((f) => [f.entryPath, f.dest !== null])).toEqual([
      ['package/package.json', false],
      ['package/bin/opencode', true]
    ])
  })

  it('reads GNU long names, pax paths and ustar prefixes', async () => {
    const long = `${'d'.repeat(120)}/file`
    const archive = file(
      'a.tgz',
      tgz([
        tarEntry('././@LongLink', `${long}\0`, { type: 'L' }),
        tarEntry('truncated', 'one'),
        paxPath('pax/named.txt'),
        tarEntry('ignored-name', 'two'),
        tarEntry('name.txt', 'three', { prefix: 'prefixed' })
      ])
    )
    await extractTarGz(archive, dest)
    expect(listing(dest)).toEqual([long, 'pax/named.txt', 'prefixed/name.txt'])
  })

  it.each([
    ['a parent traversal', tarEntry('../escape', 'x'), /leaves its directory/],
    ['a nested traversal', tarEntry('pi/../../escape', 'x'), /leaves its directory/],
    ['an absolute path', tarEntry('/tmp/escape', 'x'), /absolute path/],
    ['a drive letter', tarEntry('C:/escape', 'x'), /absolute path/],
    ['a symlink', tarEntry('link', '', { type: '2', linkname: '/etc/passwd' }), /link/],
    ['a hardlink', tarEntry('link', '', { type: '1', linkname: 'pi' }), /link/],
    ['a device', tarEntry('dev', '', { type: '3' }), /unsupported type/],
    ['a traversal via pax', Buffer.concat([paxPath('../escape'), tarEntry('ok', 'x')]), /leaves/]
  ])('refuses %s, even when it is not selected', async (_label, bad, message) => {
    const archive = file('a.tgz', tgz([tarEntry('ok-first', 'fine'), bad]))
    await expect(extractTarGz(archive, dest, { select: () => null })).rejects.toThrow(message)
    await expect(extractTarGz(archive, path.join(tmp, 'out2'))).rejects.toBeInstanceOf(ArchiveError)
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false)
  })

  it('refuses a duplicate entry rather than overwrite', async () => {
    const archive = file('a.tgz', tgz([tarEntry('pi', 'one'), tarEntry('pi', 'two')]))
    await expect(extractTarGz(archive, dest)).rejects.toThrow(/duplicate entry/)
  })

  it('refuses a corrupt header, a truncated archive and non-gzip input', async () => {
    const corrupt = tar([tarEntry('pi', 'binary')])
    corrupt[0] = 'q'.charCodeAt(0)
    await expect(extractTarGz(file('c.tgz', gzipSync(corrupt)), dest)).rejects.toThrow(
      /corrupt tar header/
    )
    const truncated = tarEntry('pi', 'x'.repeat(2000)).subarray(0, 1024)
    await expect(extractTarGz(file('t.tgz', gzipSync(truncated)), dest)).rejects.toThrow(
      /truncated/
    )
    await expect(extractTarGz(file('n.tgz', Buffer.from('not gzip')), dest)).rejects.toThrow()
  })

  it('enforces the per-entry, total and entry-count caps', async () => {
    const archive = file('a.tgz', tgz([tarEntry('a', 'x'.repeat(600)), tarEntry('b', 'y')]))
    await expect(extractTarGz(archive, dest, { limits: { maxEntryBytes: 100 } })).rejects.toThrow(
      /exceeds 100 bytes/
    )
    await expect(
      extractTarGz(archive, path.join(tmp, 'o2'), { limits: { maxTotalBytes: 1024 } })
    ).rejects.toThrow(/more than 1024 bytes/)
    await expect(
      extractTarGz(archive, path.join(tmp, 'o3'), { limits: { maxEntries: 1 } })
    ).rejects.toThrow(/more than 1 entries/)
  })

  it('stops when aborted', async () => {
    const archive = file('a.tgz', tgz([tarEntry('a', 'x')]))
    const controller = new AbortController()
    controller.abort()
    await expect(extractTarGz(archive, dest, { signal: controller.signal })).rejects.toThrow()
    expect(listing(dest)).toEqual([])
  })
})

describe('extractZip', () => {
  it('extracts stored and deflated entries, hashing each file', async () => {
    const big = 'pi '.repeat(10_000)
    const archive = file(
      'a.zip',
      zip([
        { name: 'pi.exe', body: big },
        { name: 'theme/', body: '' },
        { name: 'theme/dark.json', body: '{}', method: 0 }
      ])
    )
    const files = await extractZip(archive, dest)
    expect(listing(dest)).toEqual(['pi.exe', 'theme/dark.json'])
    expect(fs.readFileSync(path.join(dest, 'pi.exe'), 'utf8')).toBe(big)
    expect(files.map((f) => [f.entryPath, f.sha256])).toEqual([
      ['pi.exe', sha256(big)],
      ['theme/dark.json', sha256('{}')]
    ])
  })

  it.skipIf(process.platform === 'win32')('keeps the unix mode', async () => {
    const archive = file('a.zip', zip([{ name: 'pi', body: 'x', unixMode: 0o100755 }]))
    await extractZip(archive, dest)
    expect(fs.statSync(path.join(dest, 'pi')).mode & 0o777).toBe(0o755)
  })

  it.each([
    ['a traversal', { name: '../escape', body: 'x' }, /leaves its directory/],
    ['a backslash traversal', { name: '..\\escape', body: 'x' }, /leaves its directory/],
    ['an absolute path', { name: '/escape', body: 'x' }, /absolute path/],
    ['a drive letter', { name: 'C:\\escape', body: 'x' }, /absolute path/],
    ['a symlink', { name: 'link', body: '/etc/passwd', unixMode: 0o120777 }, /link/]
  ])('refuses %s, even when it is not selected', async (_label, bad, message) => {
    const archive = file('a.zip', zip([{ name: 'ok', body: 'fine' }, bad]))
    await expect(extractZip(archive, dest, { select: () => null })).rejects.toThrow(message)
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false)
  })

  it('refuses an entry that inflates past its declared size', async () => {
    const bytes = zip([{ name: 'bomb', body: 'z'.repeat(10_000) }])
    // Lie about the uncompressed size in the central directory.
    const cd = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(10, cd + 24)
    await expect(extractZip(file('b.zip', bytes), dest)).rejects.toThrow(/larger than it says/)
  })

  it('refuses a file that is not a zip, and caps entry sizes', async () => {
    await expect(extractZip(file('n.zip', Buffer.alloc(100)), dest)).rejects.toThrow(
      /no end of central directory/
    )
    const archive = file('a.zip', zip([{ name: 'a', body: 'x'.repeat(500) }]))
    await expect(extractZip(archive, dest, { limits: { maxEntryBytes: 100 } })).rejects.toThrow(
      /exceeds 100 bytes/
    )
  })
})
