/**
 * @vitest-environment node
 *
 * The additional-directories helpers: how an entry is resolved (per source cwd), de-duplicated,
 * and narrowed to what an engine may be sent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../logger', () => ({ logger: mockLogger }))

import {
  existingDirectories,
  expandHome,
  resolveAdditionalDirectories,
  uniqueDirs
} from '../additional-directories'

describe('expandHome', () => {
  it('expands ~ and ~/x, leaves ~name and plain paths', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'))
    expect(expandHome('~name')).toBe('~name')
    expect(expandHome('rel/x')).toBe('rel/x')
  })
})

describe('resolveAdditionalDirectories', () => {
  const parent = resolve('/parent-repo')
  const target = resolve('/target-worktree')

  it('resolves a relative entry against the cwd of the settings that carried it', () => {
    expect(resolveAdditionalDirectories(['../shared'], parent)).toEqual([resolve('/shared')])
    expect(resolveAdditionalDirectories(['libs'], target)).toEqual([join(target, 'libs')])
    // Same text, different source cwd, different directory: why the union happens AFTER this.
    expect(resolveAdditionalDirectories(['libs'], parent)).not.toEqual(
      resolveAdditionalDirectories(['libs'], target)
    )
  })

  it('expands ~ and keeps an absolute entry', () => {
    expect(resolveAdditionalDirectories(['~/notes', resolve('/abs/dir')], parent)).toEqual([
      join(homedir(), 'notes'),
      resolve('/abs/dir')
    ])
  })

  it('drops blanks and non-strings; undefined is empty', () => {
    expect(resolveAdditionalDirectories(['', '  ', null, undefined, 'a'], parent)).toEqual([
      join(parent, 'a')
    ])
    expect(resolveAdditionalDirectories(undefined, parent)).toEqual([])
  })
})

describe('existingDirectories', () => {
  let base: string
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'addl-dirs-'))
    mkdirSync(join(base, 'real'))
    writeFileSync(join(base, 'file.txt'), 'x')
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('keeps existing absolute directories only; logs what it drops', () => {
    mockLogger.debug.mockClear()
    const real = join(base, 'real')
    const dropped = [join(base, 'missing'), join(base, 'file.txt'), 'relative/dir']
    expect(existingDirectories([real, ...dropped], 'Test')).toEqual([real])
    expect(mockLogger.debug).toHaveBeenCalledTimes(3)
  })
})

describe('uniqueDirs', () => {
  it('drops blanks, non-strings and repeats; keeps the first spelling and the order', () => {
    expect(
      uniqueDirs(['/a', undefined, '', '  ', '/b', '/a', null, '/c/'], undefined, 'linux')
    ).toEqual(['/a', '/b', '/c/'])
    expect(uniqueDirs(['/a/', '/a'], undefined, 'linux')).toEqual(['/a/'])
  })

  it('posix: letter case tells directories apart', () => {
    expect(uniqueDirs(['/Repo', '/repo'], undefined, 'linux')).toEqual(['/Repo', '/repo'])
  })

  it('win32: letter case, separators and a trailing slash do not', () => {
    expect(
      uniqueDirs(['D:\\Work\\Repo', 'd:/work/repo/', 'D:\\Work\\Other'], undefined, 'win32')
    ).toEqual(['D:\\Work\\Repo', 'D:\\Work\\Other'])
  })

  it('except removes the directory the target already runs in', () => {
    expect(uniqueDirs(['D:\\W\\Repo', 'D:\\W\\Extra'], 'd:/w/repo', 'win32')).toEqual([
      'D:\\W\\Extra'
    ])
    expect(uniqueDirs(['/p', '/p/x'], '/p', 'linux')).toEqual(['/p/x'])
  })
})
