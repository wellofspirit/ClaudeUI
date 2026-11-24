/**
 * The server's `versions/` folder: staging a release archive, the deletion gate
 * (every refusal) and the sweep after a healthy update. Critical: the gate is the
 * only recursive delete in `src/server`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tarEntry, tgz, zip } from '../../core/harness/install/__tests__/fixtures'
import { writeCurrent, writePending } from '../server-layout'
import {
  STAGE_RENAME_RETRY,
  STAGING_FILE,
  gcServerVersions,
  isOwnedVersionName,
  removeServerVersionDir,
  stageServerArchive
} from '../server-versions'
import { makeServerFolder, makeVersion, markerText, tempDir } from './fake-server'

const P = 'darwin'
const T1 = 'a'.repeat(32)
const posixOnly = it.skipIf(process.platform === 'win32')

let root: string
let downloads: string
let logs: string[]
const log = (m: string): void => {
  logs.push(m)
}

beforeEach(() => {
  root = tempDir()
  downloads = tempDir('claudeui-server-dl-')
  logs = []
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(downloads, { recursive: true, force: true })
})

const exists = (...p: string[]): boolean => fs.existsSync(path.join(root, ...p))
const versionsEntries = (): string[] => fs.readdirSync(path.join(root, 'versions')).sort()

/** A `.partial-*` (or any folder) holding only the stager's proof for `version`. */
function stagingProof(name: string, version: string): void {
  fs.mkdirSync(path.join(root, 'versions', name), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'versions', name, STAGING_FILE),
    JSON.stringify({ token: 'e'.repeat(32), version, at: 1 })
  )
}

describe('the deletion gate', () => {
  const gate = (name: string, protect?: string[]) =>
    removeServerVersionDir(root, name, { platform: P, protect, log })

  it('removes a marked release folder', () => {
    makeVersion(root, '1.2.0')
    expect(gate('1.2.0')).toEqual({ removed: true })
    expect(exists('versions', '1.2.0')).toBe(false)
  })

  it('removes a marked partial extraction', () => {
    makeServerFolder(path.join(root, 'versions', '.partial-1.2.0-0123abcd'), '1.2.0')
    expect(gate('.partial-1.2.0-0123abcd')).toEqual({ removed: true })
  })

  it('refuses anything that is not a direct child of versions/', () => {
    makeServerFolder(path.join(root, 'outside'), '1.2.0')
    for (const name of ['../outside', 'a/b', '..', '.', '', 'x\\y']) {
      expect(gate(name)).toMatchObject({ removed: false })
    }
    expect(exists('outside')).toBe(true)
  })

  it('refuses a name the machinery never gives', () => {
    fs.mkdirSync(path.join(root, 'versions', 'mine'), { recursive: true })
    makeServerFolder(path.join(root, 'versions', 'backup'), '1.2.0')
    makeServerFolder(path.join(root, 'versions', '.partial-1.2.0-xyz'), '1.2.0')
    expect(gate('mine')).toMatchObject({ removed: false, reason: expect.stringMatching(/name/) })
    expect(gate('backup')).toMatchObject({ removed: false })
    expect(gate('.partial-1.2.0-xyz')).toMatchObject({ removed: false })
    expect(versionsEntries()).toEqual(['.partial-1.2.0-xyz', 'backup', 'mine'])
    expect(isOwnedVersionName('1.2.0-pre.4')).toBe(true)
    expect(isOwnedVersionName('.partial-../x-0123abcd')).toBe(false)
  })

  posixOnly('refuses a link, and never follows one', () => {
    const elsewhere = makeServerFolder(path.join(root, 'elsewhere'), '1.2.0')
    fs.mkdirSync(path.join(root, 'versions'))
    fs.symlinkSync(elsewhere, path.join(root, 'versions', '1.2.0'))
    expect(gate('1.2.0')).toMatchObject({ removed: false, reason: 'not a real directory' })
    expect(exists('elsewhere', 'claudeui-install.json')).toBe(true)
  })

  posixOnly('refuses when versions/ itself is a link', () => {
    const other = tempDir()
    makeVersion(other, '1.2.0')
    fs.symlinkSync(path.join(other, 'versions'), path.join(root, 'versions'))
    expect(gate('1.2.0')).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/versions/)
    })
    expect(fs.existsSync(path.join(other, 'versions', '1.2.0'))).toBe(true)
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('refuses a folder without a server marker, and logs a partial left in place', () => {
    makeVersion(root, '1.2.0', { marker: false })
    fs.mkdirSync(path.join(root, 'versions', '.partial-1.3.0-0123abcd'))
    expect(gate('1.2.0')).toMatchObject({ removed: false, reason: expect.stringMatching(/marker/) })
    expect(gate('.partial-1.3.0-0123abcd')).toMatchObject({ removed: false })
    expect(logs.some((l) => /left the partial extraction/.test(l))).toBe(true)
    expect(versionsEntries()).toEqual(['.partial-1.3.0-0123abcd', '1.2.0'])
  })

  it("removes a partial that holds only the stager's proof", () => {
    stagingProof('.partial-1.3.0-0123abcd', '1.3.0')
    fs.writeFileSync(path.join(root, 'versions', '.partial-1.3.0-0123abcd', 'half'), 'x')
    expect(gate('.partial-1.3.0-0123abcd')).toEqual({ removed: true })
  })

  it("never takes the stager's proof for a release folder, nor a proof of another version", () => {
    stagingProof('1.3.0', '1.3.0')
    stagingProof('.partial-1.4.0-0123abcd', '1.3.0')
    expect(gate('1.3.0')).toMatchObject({ removed: false, reason: expect.stringMatching(/marker/) })
    expect(gate('.partial-1.4.0-0123abcd')).toMatchObject({ removed: false })
    fs.writeFileSync(
      path.join(root, 'versions', '.partial-1.4.0-0123abcd', STAGING_FILE),
      'not json'
    )
    expect(gate('.partial-1.4.0-0123abcd')).toMatchObject({ removed: false })
    expect(versionsEntries()).toEqual(['.partial-1.4.0-0123abcd', '1.3.0'])
  })

  it('refuses the version current names', () => {
    makeVersion(root, '1.2.0')
    writeCurrent(root, '1.2.0', P)
    expect(gate('1.2.0')).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/current/)
    })
    expect(exists('versions', '1.2.0')).toBe(true)
  })

  it("refuses an open window's from and to (a pending update)", () => {
    makeVersion(root, '1.1.0')
    makeVersion(root, '1.2.0')
    writePending(root, { token: T1, from: '1.1.0', to: '1.2.0' }, P)
    expect(gate('1.1.0')).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/pending/)
    })
    expect(gate('1.2.0')).toMatchObject({ removed: false })
    fs.writeFileSync(path.join(root, 'pending'), 'garbage')
    expect(gate('1.1.0')).toMatchObject({ removed: false })
  })

  it('refuses a protected name, and a missing folder', () => {
    makeVersion(root, '1.2.0')
    expect(gate('1.2.0', ['1.2.0'])).toMatchObject({ removed: false, reason: 'it is in use' })
    expect(gate('1.9.0')).toMatchObject({ removed: false, reason: 'it does not exist' })
  })

  it('never touches the flat install', () => {
    makeServerFolder(root, '1.0.0')
    makeVersion(root, '1.2.0')
    gcServerVersions(root, [], { platform: P, log })
    expect(exists('claudeui-server')).toBe(true)
    expect(exists('claudeui-install.json')).toBe(true)
  })
})

describe('the sweep after a healthy update', () => {
  it('keeps the running version and the previous one, and nothing else of ours', () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) makeVersion(root, v)
    makeServerFolder(path.join(root, 'versions', '.partial-1.4.0-0123abcd'), '1.4.0')
    fs.mkdirSync(path.join(root, 'versions', 'notes'))
    const removed = gcServerVersions(root, ['1.3.0', '1.2.0'], { platform: P, log })
    expect(removed.sort()).toEqual(['1.0.0', '1.1.0'])
    expect(versionsEntries()).toEqual(['.partial-1.4.0-0123abcd', '1.2.0', '1.3.0', 'notes'])
  })

  it('leaves the version current names even when not asked to keep it', () => {
    makeVersion(root, '1.0.0')
    makeVersion(root, '1.1.0')
    writeCurrent(root, '1.0.0', P)
    gcServerVersions(root, ['1.1.0'], { platform: P, log })
    expect(versionsEntries()).toEqual(['1.0.0', '1.1.0'])
  })
})

describe('staging', () => {
  const R = 'claudeui-server-1.2.0-mac-arm64'
  const zipFile = (entries: Parameters<typeof zip>[0]): string => {
    const file = path.join(downloads, 'claudeui-server-1.2.0-mac-arm64.zip')
    fs.writeFileSync(file, zip(entries))
    return file
  }
  const tgzFile = (entries: Buffer[]): string => {
    const file = path.join(downloads, 'claudeui-server-1.2.0-linux-x64.tar.gz')
    fs.writeFileSync(file, tgz(entries))
    return file
  }
  const goodZip = (markerVersion = '1.2.0'): string =>
    zipFile([
      { name: `${R}/`, unixMode: 0o040755 },
      // Recorded without the exec bit, as a zip from Windows would be.
      { name: `${R}/claudeui-server`, body: '#!/bin/sh\n' },
      { name: `${R}/claudeui-install.json`, body: markerText(markerVersion) },
      { name: `${R}/out/renderer/web.html`, body: '<html>' },
      { name: `${R}/vendor/claude-cli/bun-claude`, body: 'bin' }
    ])
  const stage = (archive: string, version = '1.2.0') =>
    stageServerArchive({ root, archive, version, platform: P, log, t8: '0123abcd' })

  it('extracts a zip into versions/<v> without its root folder, executables marked', async () => {
    expect(await stage(goodZip())).toEqual({ stagedId: '1.2.0' })
    expect(versionsEntries()).toEqual(['1.2.0'])
    expect(exists('versions', '1.2.0', 'out', 'renderer', 'web.html')).toBe(true)
    expect(exists('versions', '1.2.0', STAGING_FILE)).toBe(false)
    expect(exists('versions', '1.2.0', R)).toBe(false)
    if (process.platform !== 'win32') {
      const mode = (rel: string): number =>
        fs.statSync(path.join(root, 'versions', '1.2.0', rel)).mode & 0o777
      expect(mode('claudeui-server')).toBe(0o755)
      expect(mode('vendor/claude-cli/bun-claude')).toBe(0o755)
    }
  })

  it('extracts a tar.gz the same way, keeping its modes', async () => {
    const archive = tgzFile([
      tarEntry(`${R}/`, '', { type: '5', mode: 0o755 }),
      tarEntry(`${R}/claudeui-server`, '#!/bin/sh\n', { mode: 0o755 }),
      tarEntry(`${R}/claudeui-install.json`, markerText('1.2.0')),
      tarEntry(`${R}/out/build-info.json`, '{}')
    ])
    expect(await stage(archive)).toEqual({ stagedId: '1.2.0' })
    expect(exists('versions', '1.2.0', 'claudeui-server')).toBe(true)
    expect(exists('versions', '1.2.0', 'out', 'build-info.json')).toBe(true)
  })

  it('refuses an archive without a marker, and removes its partial by the stager proof', async () => {
    const archive = zipFile([{ name: `${R}/claudeui-server`, body: 'x' }])
    await expect(stage(archive)).rejects.toThrow(/no ClaudeUI server marker/)
    expect(exists('versions', '1.2.0')).toBe(false)
    expect(versionsEntries()).toEqual([])
  })

  it('refuses an archive that brings its own staging proof', async () => {
    const archive = zipFile([
      { name: `${R}/claudeui-install.json`, body: markerText('1.2.0') },
      { name: `${R}/${STAGING_FILE}`, body: '{}' }
    ])
    await expect(stage(archive)).rejects.toThrow(/duplicate/)
    expect(versionsEntries()).toEqual([])
  })

  it('sweeps leftover partials first, leaving one that proves nothing', async () => {
    fs.mkdirSync(path.join(root, 'versions'))
    makeServerFolder(path.join(root, 'versions', '.partial-1.1.0-11111111'), '1.1.0')
    stagingProof('.partial-1.1.5-22222222', '1.1.5')
    fs.mkdirSync(path.join(root, 'versions', '.partial-1.1.9-33333333'))
    makeVersion(root, '1.0.0')
    fs.mkdirSync(path.join(root, 'versions', 'notes'))
    expect(await stage(goodZip())).toEqual({ stagedId: '1.2.0' })
    expect(versionsEntries()).toEqual(['.partial-1.1.9-33333333', '1.0.0', '1.2.0', 'notes'])
  })

  describe('on Windows, the final rename', () => {
    const W = 'claudeui-server-1.2.0-win-x64'
    const winZip = (): string =>
      zipFile([
        { name: `${W}/claudeui-server.exe`, body: 'MZ' },
        { name: `${W}/claudeui-install.json`, body: markerText('1.2.0') }
      ])
    const busy = (): never => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }

    it('is retried for about 30 s while files are held open', async () => {
      expect(STAGE_RENAME_RETRY.attempts * STAGE_RENAME_RETRY.delayMs).toBeGreaterThanOrEqual(
        30_000
      )
      let calls = 0
      const result = await stageServerArchive({
        root,
        archive: winZip(),
        version: '1.2.0',
        platform: 'win32',
        log,
        t8: '0123abcd',
        rename: (from, to) => {
          if (++calls < 3) busy()
          fs.renameSync(from, to)
        },
        sleep: async () => undefined
      })
      expect(result).toEqual({ stagedId: '1.2.0' })
      expect(calls).toBe(3)
      expect(versionsEntries()).toEqual(['1.2.0'])
    })

    it('leaves the partial for the next sweep when it keeps failing', async () => {
      let calls = 0
      const err = await stageServerArchive({
        root,
        archive: winZip(),
        version: '1.2.0',
        platform: 'win32',
        log,
        t8: '0123abcd',
        rename: () => {
          calls++
          busy()
        },
        sleep: async () => undefined
      }).catch((e: Error) => e)
      expect(calls).toBe(STAGE_RENAME_RETRY.attempts)
      expect((err as Error).message).toMatch(/Could not move 1\.2\.0 into place/)
      expect((err as Error).message).not.toContain(root)
      expect(versionsEntries()).toEqual(['.partial-1.2.0-0123abcd'])
      expect(logs.some((l) => /left versions\/\.partial-1\.2\.0-0123abcd in place/.test(l))).toBe(
        true
      )
      // The next staging sweeps it (it holds the validated marker), then succeeds.
      expect(
        await stageServerArchive({
          root,
          archive: winZip(),
          version: '1.2.0',
          platform: 'win32',
          log,
          t8: '89abcdef'
        })
      ).toEqual({ stagedId: '1.2.0' })
      expect(versionsEntries()).toEqual(['1.2.0'])
    })
  })

  it('refuses an archive of another version, and removes its partial', async () => {
    await expect(stage(goodZip('1.1.0'))).rejects.toThrow(/names 1\.1\.0, not 1\.2\.0/)
    expect(versionsEntries()).toEqual([])
  })

  it("refuses an archive without this platform's executable", async () => {
    await expect(
      stageServerArchive({ root, archive: goodZip(), version: '1.2.0', platform: 'win32', log })
    ).rejects.toThrow(/claudeui-server\.exe/)
    expect(versionsEntries()).toEqual([])
  })

  it('reuses a valid staged folder and drops the new extraction', async () => {
    makeVersion(root, '1.2.0')
    fs.writeFileSync(path.join(root, 'versions', '1.2.0', 'sentinel'), 'x')
    expect(await stage(goodZip())).toEqual({ stagedId: '1.2.0' })
    expect(versionsEntries()).toEqual(['1.2.0'])
    expect(exists('versions', '1.2.0', 'sentinel')).toBe(true)
  })

  it('replaces an invalid marked folder through the gate', async () => {
    makeVersion(root, '1.2.0', { exe: false })
    expect(await stage(goodZip())).toEqual({ stagedId: '1.2.0' })
    expect(exists('versions', '1.2.0', 'claudeui-server')).toBe(true)
    expect(versionsEntries()).toEqual(['1.2.0'])
  })

  it('never replaces an unmarked folder in the way', async () => {
    makeVersion(root, '1.2.0', { marker: false })
    fs.writeFileSync(path.join(root, 'versions', '1.2.0', 'user-file'), 'x')
    await expect(stage(goodZip())).rejects.toThrow(/remove it by hand/)
    expect(exists('versions', '1.2.0', 'user-file')).toBe(true)
  })

  it('refuses path traversal and writes nothing outside versions/', async () => {
    const archive = zipFile([
      { name: `${R}/claudeui-install.json`, body: markerText('1.2.0') },
      { name: `${R}/../../escaped`, body: 'x' }
    ])
    await expect(stage(archive)).rejects.toThrow(/leaves its directory/)
    expect(exists('escaped')).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(root), 'escaped'))).toBe(false)
  })

  it('refuses two root folders, or a file beside the root folder', async () => {
    await expect(
      stage(
        zipFile([
          { name: `${R}/claudeui-install.json`, body: markerText('1.2.0') },
          { name: 'other/claudeui-server', body: 'x' }
        ])
      )
    ).rejects.toThrow(/one root folder/)
    await expect(
      stage(
        zipFile([
          { name: 'README', body: 'x' },
          { name: 'README/x', body: 'x' }
        ])
      )
    ).rejects.toThrow()
  })

  it('names no local path in its errors', async () => {
    const archive = zipFile([{ name: `${R}/claudeui-server`, body: 'x' }])
    const err = await stage(archive).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(root)
    const missing = await stageServerArchive({
      root,
      archive: path.join(downloads, 'missing.zip'),
      version: '1.2.0',
      platform: P,
      log
    }).catch((e: Error) => e)
    expect((missing as Error).message).not.toContain(downloads)
  })

  it('refuses a version that is not a release, and an unknown archive type', async () => {
    await expect(stage(goodZip(), '../1.2.0')).rejects.toThrow(/release version/)
    await expect(
      stageServerArchive({
        root,
        archive: path.join(downloads, 'x.rar'),
        version: '1.2.0',
        platform: P
      })
    ).rejects.toThrow(/\.zip nor a \.tar\.gz/)
  })
})
