/**
 * The server's root layout (`current`, `pending`, server folders) and the records
 * in the relaunch state dir: the monitor protocol's on-disk half.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHealthRecord } from '../../shared/relaunch'
import {
  isValidVersionDir,
  parsePending,
  readCurrent,
  readPending,
  WIN_RETRY,
  removeCurrent,
  removePending,
  retryTransientSync,
  serverFolderProblem,
  versionRunningFrom,
  writeCurrent,
  writePending
} from '../server-layout'
import {
  installKeyFor,
  lastResult,
  pruneResults,
  readHealth,
  resultFile,
  writeHealth,
  writeResult
} from '../server-records'
import { makeServerFolder, makeVersion, tempDir } from './fake-server'

const T1 = 'a'.repeat(32)
const T2 = 'b'.repeat(32)
const platform = process.platform

let root: string
beforeEach(() => {
  root = tempDir()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('current', () => {
  it('reads what was written, trimmed, and null when absent', () => {
    expect(readCurrent(root)).toBeNull()
    writeCurrent(root, '1.2.3', platform)
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n')
    expect(readCurrent(root)).toBe('1.2.3')
  })

  it('never writes something that is not a release version', () => {
    expect(() => writeCurrent(root, '../x', platform)).toThrow(/not a release version/)
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false)
  })

  it('removes the file, and leaves a directory of that name alone', () => {
    writeCurrent(root, '1.2.3', platform)
    expect(removeCurrent(root, platform).removed).toBe(true)
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false)
    fs.mkdirSync(path.join(root, 'current'))
    fs.writeFileSync(path.join(root, 'current', 'keep'), 'x')
    expect(removeCurrent(root, platform)).toEqual({ removed: false, reason: 'it is a directory' })
    expect(fs.existsSync(path.join(root, 'current', 'keep'))).toBe(true)
  })
})

describe('Windows retries for the root files', () => {
  const busy = (code: string): Error => Object.assign(new Error(code), { code })

  it('retries a file held open, then succeeds', () => {
    const sleep = vi.fn()
    let calls = 0
    const value = retryTransientSync(
      () => {
        if (++calls < 3) throw busy('EBUSY')
        return 'done'
      },
      'win32',
      sleep
    )
    expect(value).toBe('done')
    expect(calls).toBe(3)
    expect(sleep).toHaveBeenCalledWith(WIN_RETRY.delayMs)
  })

  it('gives up after the budget, which is longer than a second', () => {
    expect(WIN_RETRY.attempts * WIN_RETRY.delayMs).toBeGreaterThanOrEqual(5_000)
    let calls = 0
    expect(() =>
      retryTransientSync(
        () => {
          calls++
          throw busy('EPERM')
        },
        'win32',
        () => undefined
      )
    ).toThrow('EPERM')
    expect(calls).toBe(WIN_RETRY.attempts)
  })

  it('never retries elsewhere, nor another error', () => {
    for (const [platform, code] of [
      ['linux', 'EBUSY'],
      ['darwin', 'EACCES'],
      ['win32', 'ENOSPC']
    ]) {
      let calls = 0
      expect(() =>
        retryTransientSync(
          () => {
            calls++
            throw busy(code)
          },
          platform,
          () => undefined
        )
      ).toThrow(code)
      expect(calls).toBe(1)
    }
  })
})

describe('pending', () => {
  it('accepts a flat or versioned from, and nothing malformed', () => {
    expect(parsePending({ token: T1, from: null, to: '1.2.0' })).toEqual({
      token: T1,
      from: null,
      to: '1.2.0'
    })
    expect(parsePending({ token: T1, from: '1.1.0', to: '1.2.0-pre.3' })).not.toBeNull()
    expect(parsePending({ token: 'short', from: null, to: '1.2.0' })).toBeNull()
    expect(parsePending({ token: T1, from: null, to: '../1.2.0' })).toBeNull()
    expect(parsePending({ token: T1, from: 'flat', to: '1.2.0' })).toBeNull()
    expect(parsePending({ token: T1, to: '1.2.0' })).toBeNull()
    expect(parsePending(null)).toBeNull()
  })

  it('round-trips, reads a broken file as invalid, and an absent one as null', () => {
    expect(readPending(root)).toBeNull()
    writePending(root, { token: T1, from: null, to: '1.2.0' }, platform)
    expect(readPending(root)).toEqual({ token: T1, from: null, to: '1.2.0' })
    fs.writeFileSync(path.join(root, 'pending'), '{nope')
    expect(readPending(root)).toBe('invalid')
    expect(removePending(root, platform).removed).toBe(true)
    expect(readPending(root)).toBeNull()
  })
})

describe('server folders', () => {
  it('is valid with a server marker naming the version and the executable', () => {
    makeVersion(root, '1.2.0')
    expect(isValidVersionDir(root, '1.2.0', 'darwin')).toBe(true)
    expect(serverFolderProblem(path.join(root, 'versions', '1.2.0'), '1.2.0', 'darwin')).toBeNull()
  })

  it('names each problem', () => {
    const dir = (v: string): string => path.join(root, 'versions', v)
    makeVersion(root, '1.0.0', { marker: false })
    makeVersion(root, '1.0.1', { markerVersion: '9.9.9' })
    makeVersion(root, '1.0.2', { exe: false })
    expect(serverFolderProblem(dir('1.0.0'), '1.0.0', 'darwin')).toMatch(
      /no ClaudeUI server marker/
    )
    expect(serverFolderProblem(dir('1.0.1'), '1.0.1', 'darwin')).toMatch(/names 9\.9\.9/)
    expect(serverFolderProblem(dir('1.0.2'), '1.0.2', 'darwin')).toMatch(/no claudeui-server/)
    expect(serverFolderProblem(dir('1.0.3'), '1.0.3', 'darwin')).toBe('it does not exist')
    // The Windows executable is a different file.
    makeVersion(root, '1.0.4')
    expect(serverFolderProblem(dir('1.0.4'), '1.0.4', 'win32')).toMatch(/claudeui-server\.exe/)
  })

  it('refuses a desktop marker', () => {
    const dir = makeVersion(root, '1.0.0')
    fs.writeFileSync(
      path.join(dir, 'claudeui-install.json'),
      JSON.stringify({
        schema: 1,
        product: 'com.claudeui.app',
        kind: 'desktop',
        entries: [],
        version: '1.0.0'
      })
    )
    expect(isValidVersionDir(root, '1.0.0', 'darwin')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a link, and a linked versions/', () => {
    const elsewhere = makeServerFolder(path.join(root, 'elsewhere'), '1.0.0')
    fs.mkdirSync(path.join(root, 'versions'))
    fs.symlinkSync(elsewhere, path.join(root, 'versions', '1.0.0'))
    expect(isValidVersionDir(root, '1.0.0', 'darwin')).toBe(false)

    const other = tempDir()
    makeVersion(other, '2.0.0')
    fs.rmSync(path.join(root, 'versions'), { recursive: true })
    fs.symlinkSync(path.join(other, 'versions'), path.join(root, 'versions'))
    expect(isValidVersionDir(root, '2.0.0', 'darwin')).toBe(false)
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('tells a versions/ worker from the flat install', () => {
    expect(
      versionRunningFrom(root, path.join(root, 'versions', '1.2.0', 'claudeui-server'), 'linux')
    ).toBe('1.2.0')
    expect(versionRunningFrom(root, path.join(root, 'claudeui-server'), 'linux')).toBeNull()
    expect(
      versionRunningFrom(root, path.join(root, 'elsewhere', '1.2.0', 'claudeui-server'), 'linux')
    ).toBeNull()
  })
})

describe('records', () => {
  it('keys an install by its root, case-insensitively on Windows only', () => {
    expect(installKeyFor('/srv/ClaudeUI', 'linux')).toMatch(/^[0-9a-f]{16}$/)
    expect(installKeyFor('/srv/ClaudeUI', 'linux')).not.toBe(
      installKeyFor('/srv/claudeui', 'linux')
    )
    expect(installKeyFor('C:\\Srv', 'win32')).toBe(installKeyFor('C:\\srv', 'win32'))
  })

  it('writes and reads a health record in the desktop shape', () => {
    const state = path.join(root, 'state')
    writeHealth(state, 'k', { version: '1.2.0', buildId: null, pid: 42, at: 5 }, platform)
    expect(fs.readFileSync(path.join(state, 'health', 'k.json'), 'utf8')).toBe(
      '{"version":"1.2.0","buildId":null,"pid":42,"at":5}'
    )
    expect(readHealth(state, 'k')).toEqual({ version: '1.2.0', buildId: null, pid: 42, at: 5 })
    expect(parseHealthRecord({ version: '1', buildId: null, pid: 0, at: 1 })).toBeNull()
    expect(parseHealthRecord({ version: '1', buildId: 3, pid: 1, at: 1 })).toBeNull()
  })

  it('reads the newest result of this install only', () => {
    const state = path.join(root, 'state')
    const base = { mode: 'relaunch' as const, fromVersion: '1', toVersion: '1' }
    writeResult(state, 'mine', { ...base, token: T1, status: 'ok', at: 10 }, platform)
    writeResult(state, 'mine', { ...base, token: T2, status: 'no-health', at: 20 }, platform)
    writeResult(state, 'other', { ...base, token: 'c'.repeat(32), status: 'ok', at: 30 }, platform)
    expect(lastResult(state, 'mine')?.token).toBe(T2)
    expect(lastResult(state, 'other')?.at).toBe(30)
    expect(lastResult(state, 'none')).toBeNull()
  })

  it('prunes old result files and nothing else', () => {
    const state = path.join(root, 'state')
    const base = {
      mode: 'relaunch' as const,
      fromVersion: '1',
      toVersion: '1',
      status: 'ok' as const
    }
    writeResult(state, 'k', { ...base, token: T1, at: 1 }, platform)
    writeResult(state, 'k', { ...base, token: T2, at: 2 }, platform)
    const old = Date.now() / 1000 - 40 * 24 * 3600
    fs.utimesSync(resultFile(state, T1), old, old)
    fs.writeFileSync(path.join(state, `${T1}.result.json`), '{}')
    fs.utimesSync(path.join(state, `${T1}.result.json`), old, old)
    pruneResults(state, Date.now())
    expect(fs.existsSync(resultFile(state, T1))).toBe(false)
    expect(fs.existsSync(resultFile(state, T2))).toBe(true)
    // The desktop's own result file is not this module's.
    expect(fs.existsSync(path.join(state, `${T1}.result.json`))).toBe(true)
  })
})
