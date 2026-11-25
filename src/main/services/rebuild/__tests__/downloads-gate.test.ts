/**
 * @vitest-environment node
 *
 * The downloads-dir gate: the only delete of a rebuild's output and log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { removeDownloadsEntry } from '../downloads-gate'

let root: string
let downloads: string
const log = vi.fn()
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-gate-')))
  downloads = path.join(root, 'updates', 'desktop')
  fs.mkdirSync(downloads, { recursive: true })
  log.mockClear()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const outDir = (name = 'rebuild-0123abcd'): string => {
  const dir = path.join(downloads, name)
  fs.mkdirSync(path.join(dir, 'mac-arm64', 'ClaudeUI.app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mac-arm64', 'ClaudeUI.app', 'x'), 'x')
  return dir
}

describe('removeDownloadsEntry', () => {
  it('removes a rebuild output folder and a rebuild log', () => {
    const dir = outDir()
    const logFile = `${dir}.log`
    fs.writeFileSync(logFile, 'build output')
    expect(removeDownloadsEntry(downloads, dir, log)).toEqual({ removed: true })
    expect(removeDownloadsEntry(downloads, logFile, log)).toEqual({ removed: true })
    expect(fs.readdirSync(downloads)).toEqual([])
  })

  it.each<[string, () => string, RegExp]>([
    ['another name', () => outDir('1.2.0'), /not a rebuild/],
    ['an upper-case token', () => outDir('rebuild-0123ABCD'), /not a rebuild/],
    ['a longer token', () => outDir('rebuild-0123abcd0'), /not a rebuild/],
    [
      'a nested one',
      () => {
        fs.mkdirSync(path.join(downloads, 'sub'))
        return outDir('sub/rebuild-0123abcd')
      },
      /not directly inside/
    ],
    [
      'one outside the folder',
      () => {
        const dir = path.join(root, 'rebuild-0123abcd')
        fs.mkdirSync(dir)
        return dir
      },
      /not directly inside/
    ],
    [
      'a log name that is a folder',
      () => {
        const dir = path.join(downloads, 'rebuild-0123abcd.log')
        fs.mkdirSync(dir)
        return dir
      },
      /not a regular file/
    ],
    ['a missing one', () => path.join(downloads, 'rebuild-0123abcd'), /does not exist/]
  ])('refuses %s, touching nothing', (_name, make, reason) => {
    const candidate = make()
    const r = removeDownloadsEntry(downloads, candidate, log)
    expect(r.removed).toBe(false)
    if (!r.removed) expect(r.reason).toMatch(reason)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('downloads gate refused'))
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked output folder and never follows it',
    () => {
      const target = path.join(root, 'precious')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'keep.txt'), 'x')
      const link = path.join(downloads, 'rebuild-0123abcd')
      fs.symlinkSync(target, link)
      expect(removeDownloadsEntry(downloads, link, log)).toMatchObject({ removed: false })
      expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses when the downloads folder itself is a link',
    () => {
      const real = path.join(root, 'real-downloads')
      fs.mkdirSync(real)
      const linked = path.join(root, 'linked-downloads')
      fs.symlinkSync(real, linked)
      const dir = path.join(linked, 'rebuild-0123abcd')
      fs.mkdirSync(dir)
      expect(removeDownloadsEntry(linked, dir, log)).toMatchObject({
        removed: false,
        reason: expect.stringMatching(/not a real directory/)
      })
      expect(fs.existsSync(path.join(real, 'rebuild-0123abcd'))).toBe(true)
    }
  )
})
