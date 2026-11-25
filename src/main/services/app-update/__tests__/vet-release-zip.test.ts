/**
 * @vitest-environment node
 *
 * Vetting a macOS release zip before `ditto` unpacks it: crafted names and
 * links in real zips (read through the harness archive reader), and the pure
 * rules on listings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zip, type ZipEntry } from '../../../../core/harness/install/__tests__/fixtures'
import type { ZipListing } from '../../../../core/harness/install/archive'
import { vetReleaseEntries, vetReleaseZip } from '../vet-release-zip'

const LINK = 0o120777
const FW = 'ClaudeUI.app/Contents/Frameworks/Electron Framework.framework'

/** What an Electron bundle legitimately holds: framework version links, all relative and inside. */
const ELECTRON: ZipEntry[] = [
  { name: 'ClaudeUI.app/', unixMode: 0o040755 },
  { name: 'ClaudeUI.app/Contents/MacOS/ClaudeUI', body: 'exe', unixMode: 0o100755 },
  { name: `${FW}/Versions/A/Electron Framework`, body: 'lib' },
  { name: `${FW}/Versions/A/Resources/Info.plist`, body: 'plist' },
  { name: `${FW}/Versions/Current`, body: 'A', unixMode: LINK },
  { name: `${FW}/Electron Framework`, body: 'Versions/Current/Electron Framework', unixMode: LINK },
  { name: `${FW}/Resources`, body: 'Versions/Current/Resources', unixMode: LINK, method: 0 }
]

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vet-zip-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (entries: ZipEntry[]): string => {
  const file = path.join(root, `a-${Math.random().toString(16).slice(2)}.zip`)
  fs.writeFileSync(file, zip(entries))
  return file
}

describe('vetReleaseZip (real zips)', () => {
  it("accepts an Electron bundle's relative framework links", async () => {
    await expect(vetReleaseZip(write(ELECTRON))).resolves.toBeUndefined()
  })

  it.each<[string, ZipEntry[], RegExp]>([
    ['an absolute name', [{ name: '/etc/x', body: 'x' }], /absolute/],
    ['a drive-letter name', [{ name: 'C:/x', body: 'x' }], /absolute/],
    ['a `..` segment', [{ name: 'ClaudeUI.app/Contents/../../x', body: 'x' }], /climbs out/],
    ['an entry outside the bundle', [{ name: '__MACOSX/._ClaudeUI.app', body: 'x' }], /outside/],
    ['a bundle of another name', [{ name: 'ClaudeUI2.app/x', body: 'x' }], /outside/],
    ['a backslash name', [{ name: 'ClaudeUI.app\\x', body: 'x' }], /malformed/],
    [
      'an absolute link',
      [{ name: 'ClaudeUI.app/Contents/l', body: '/etc/passwd', unixMode: LINK }],
      /points outside/
    ],
    [
      'a link that climbs out',
      [{ name: 'ClaudeUI.app/Contents/l', body: '../../outside', unixMode: LINK }],
      /points outside/
    ],
    [
      'a link chained out through another link',
      [
        { name: 'ClaudeUI.app/Contents/up', body: '..', unixMode: LINK },
        { name: 'ClaudeUI.app/Contents/out', body: 'up/..', unixMode: LINK }
      ],
      /points outside/
    ],
    [
      'two links in a cycle',
      [
        { name: 'ClaudeUI.app/a', body: 'b', unixMode: LINK },
        { name: 'ClaudeUI.app/b', body: 'a', unixMode: LINK }
      ],
      /points outside/
    ],
    [
      'an entry written through an earlier link',
      [
        { name: 'ClaudeUI.app/Contents/l', body: 'Resources', unixMode: LINK },
        { name: 'ClaudeUI.app/Contents/l/payload', body: 'x' }
      ],
      /through a link/
    ],
    [
      'an entry under a link that comes later',
      [
        { name: 'ClaudeUI.app/Contents/l/payload', body: 'x' },
        { name: 'ClaudeUI.app/Contents/l', body: 'Resources', unixMode: LINK }
      ],
      /through a link/
    ],
    [
      'the bundle itself as a link',
      [{ name: 'ClaudeUI.app', body: '/Applications', unixMode: LINK }],
      /points outside/
    ],
    ['a FIFO', [{ name: 'ClaudeUI.app/fifo', body: '', unixMode: 0o010644 }], /special file/],
    ['nothing at all', [], /empty/]
  ])('refuses %s', async (_name, entries, reason) => {
    await expect(vetReleaseZip(write(entries))).rejects.toThrow(reason)
  })

  it('refuses a file that is not a zip, saying so', async () => {
    const file = path.join(root, 'x.zip')
    fs.writeFileSync(file, 'nope')
    await expect(vetReleaseZip(file)).rejects.toThrow(/not a zip ClaudeUI can check/)
  })
})

describe('vetReleaseEntries', () => {
  const file = (name: string): ZipListing => ({ name, type: 'file', size: 1 })
  const link = (name: string, linkTarget: string): ZipListing => ({
    name,
    type: 'symlink',
    size: linkTarget.length,
    linkTarget
  })

  it('a link to the bundle root, or one resolved through another link, may stay inside', () => {
    expect(
      vetReleaseEntries([
        file('ClaudeUI.app/Contents/Info.plist'),
        link('ClaudeUI.app/Contents/root', '..'),
        link('ClaudeUI.app/Contents/self', 'root/Contents')
      ])
    ).toBeNull()
  })

  it('refuses a link without a readable target, and an empty or NUL target', () => {
    expect(vetReleaseEntries([{ name: 'ClaudeUI.app/l', type: 'symlink', size: 0 }])).toMatch(
      /unreadable link/
    )
    expect(vetReleaseEntries([link('ClaudeUI.app/l', '')])).toMatch(/points outside/)
    expect(vetReleaseEntries([link('ClaudeUI.app/l', 'a\0b')])).toMatch(/points outside/)
  })

  it('refuses empty and `.` segments', () => {
    expect(vetReleaseEntries([file('ClaudeUI.app//x')])).toMatch(/malformed/)
    expect(vetReleaseEntries([file('ClaudeUI.app/./x')])).toMatch(/malformed/)
  })
})
