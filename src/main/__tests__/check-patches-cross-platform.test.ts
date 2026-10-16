/**
 * @vitest-environment node
 *
 * `scripts/check-patches-cross-platform.mjs`: the argument parser and the
 * verdict logic. The pipeline itself (three ~250 MB downloads) is exercised by
 * running the script, not here.
 *
 * Why the comparison matters: a patch that anchors on code present in the win32
 * bundle but renamed in the darwin one applies "successfully" as a no-op there
 * and only its missing `patches:` marker shows it — the failure mode this
 * script exists to surface before a bump merges.
 */

import { describe, it, expect } from 'vitest'

const mod: any = await import('../../../scripts/check-patches-cross-platform.mjs')
const { parseCheckArgs, parsePatchesLine, comparePatches, formatTable, DEFAULT_PLATFORMS } = mod

describe('parseCheckArgs', () => {
  it('defaults to win32-x64, darwin-arm64, linux-x64 and the pinned version', () => {
    expect(parseCheckArgs([])).toEqual({
      platforms: ['win32-x64', 'darwin-arm64', 'linux-x64'],
      version: null,
      keep: false
    })
    expect(DEFAULT_PLATFORMS).toHaveLength(3)
  })

  it('reads every flag and dedupes platforms', () => {
    expect(
      parseCheckArgs([
        '--platforms',
        'linux-x64, linux-x64,darwin-x64',
        '--version',
        '2.1.300',
        '--keep'
      ])
    ).toEqual({ platforms: ['linux-x64', 'darwin-x64'], version: '2.1.300', keep: true })
  })

  it('rejects unknown platforms, missing values and unknown flags', () => {
    expect(() => parseCheckArgs(['--platforms', 'win32-x64,plan9-x64'])).toThrow(/plan9-x64/)
    expect(() => parseCheckArgs(['--platforms'])).toThrow(/needs a value/)
    expect(() => parseCheckArgs(['--version', '--keep'])).toThrow(/needs a value/)
    expect(() => parseCheckArgs(['--nope'])).toThrow(/unknown argument/)
  })
})

describe('parsePatchesLine', () => {
  it('reads the list apply-all prints, among other output', () => {
    const out = '>>> a applied.\n  OK Structure check passed (2269 chunks)\npatches: a, b, c\n'
    expect(parsePatchesLine(out)).toEqual(['a', 'b', 'c'])
  })

  it('reads an empty list as empty and a missing line as null', () => {
    expect(parsePatchesLine('patches: \n')).toEqual([])
    expect(parsePatchesLine('nothing here\n')).toBeNull()
  })
})

describe('comparePatches', () => {
  const r = (key: string, patches: string[] | null) => ({
    key,
    patches,
    failure: null as string | null
  })

  it('passes when every platform carries the same patches', () => {
    const rs = [r('win32-x64', ['a', 'b']), r('darwin-arm64', ['a', 'b'])]
    expect(comparePatches(rs, 'win32-x64')).toBe('win32-x64')
    expect(rs.every((x) => x.failure === null)).toBe(true)
  })

  it('flags the platform that lost a patch, against the host as reference', () => {
    const rs = [r('darwin-arm64', ['a']), r('win32-x64', ['a', 'b']), r('linux-x64', ['a', 'b'])]
    expect(comparePatches(rs, 'win32-x64')).toBe('win32-x64')
    expect(rs.map((x) => x.failure !== null)).toEqual([true, false, false])
    expect(rs[0].failure).toContain('differ from win32-x64')
  })

  it('falls back to the first platform with a list when the host was not run', () => {
    const rs = [r('darwin-arm64', null), r('linux-x64', ['a']), r('darwin-x64', ['a'])]
    expect(comparePatches(rs, 'win32-x64')).toBe('linux-x64')
  })

  it('does not overwrite a step failure, and ignores platforms with no list', () => {
    const failed = { key: 'darwin-arm64', patches: ['a'], failure: 'rebundle exited 1' }
    const rs = [r('win32-x64', ['a', 'b']), failed, r('linux-x64', null)]
    comparePatches(rs, 'win32-x64')
    expect(failed.failure).toBe('rebundle exited 1')
    expect(rs[2].failure).toBeNull()
    expect(comparePatches([r('x', null)], 'y')).toBeNull()
  })
})

describe('formatTable', () => {
  it('prints one aligned row per platform', () => {
    const table = formatTable(
      [
        {
          key: 'win32-x64',
          version: '2.1.293',
          extract: 'ok',
          apply: 'ok',
          rebundle: 'ok',
          patches: ['a', 'b']
        },
        {
          key: 'linux-x64',
          version: null,
          extract: 'FAIL',
          apply: '-',
          rebundle: '-',
          patches: null
        }
      ],
      'win32-x64'
    )
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/^platform\s+version\s+extract\s+apply\s+rebundle\s+patches$/)
    expect(lines[2]).toMatch(/^win32-x64\s+2\.1\.293\s+ok\s+ok\s+ok\s+a, b$/)
    expect(lines[3]).toMatch(/^linux-x64\s+\?\s+FAIL/)
    expect(table).toContain('patches compared against win32-x64')
  })
})
