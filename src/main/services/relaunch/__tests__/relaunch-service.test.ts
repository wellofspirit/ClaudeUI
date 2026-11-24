/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { createRelaunchService, type RelaunchServiceDeps } from '../relaunch-service'
import { createRestoreCollector } from '..'
import { whenHealthy } from '../health-gate'
import { readLock, takeLock } from '../lock'
import {
  DEFAULT_TIMEOUTS,
  parseJob,
  writeAtomicRetrying,
  writeJobFiles,
  type RelaunchJob
} from '../job'
import { BACKUP_KEEP_MS, JOB_FILES_KEEP_MS, lastResultFor, reconcileJobs } from '../reconcile'
import { RESTORE_TTL_MS, takeRestore, writeRestore } from '../records'
import {
  backupPathFor,
  healthFile,
  installKeyFor,
  jobFiles,
  newToken,
  restoreFile,
  siblingPath
} from '../paths'
import { makeFakeApp } from './fake-install'
import { parseRelaunchResult } from '../../../../shared/relaunch'

let root: string
let state: string
let install: string
let execPath: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-svc-')))
  state = path.join(root, 'state')
  install = makeFakeApp(path.join(root, 'ClaudeUI.app'), '1.0.0', 'healthy')
  execPath = path.join(install, 'Contents', 'MacOS', 'ClaudeUI')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function service(over: Partial<RelaunchServiceDeps> = {}) {
  const confirmQuit = vi.fn()
  const svc = createRelaunchService({
    platform: 'darwin',
    packaged: true,
    execPath,
    pid: 4242,
    runningVersion: '1.0.0',
    buildId: 'abc1234@2026-11-24T00:00:00.000Z',
    stateDir: state,
    collectRestore: async () => ({ activeSessionId: 's1', drafts: { s1: 'hello' } }),
    confirmQuit,
    // A helper that comes up: it writes its ready file at once.
    spawnHelper: (cmd) => {
      const sh = cmd.args.at(-1)!
      fs.writeFileSync(sh.replace(/\.job\.sh$/, '.ready'), '1')
      return { pid: undefined, failed: new Promise(() => {}) }
    },
    readyTimeoutMs: 300,
    collectTimeoutMs: 200,
    ...over
  })
  return { svc, confirmQuit }
}

describe('requestRelaunch', () => {
  it('writes the job, waits for the helper, saves the restore record and confirms the quit', async () => {
    const { svc, confirmQuit } = service()
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    const lock = readLock(state)
    expect(lock?.owner?.pid).toBe(4242)
    const job = parseJob(
      JSON.parse(fs.readFileSync(jobFiles(state, lock!.owner!.token).json, 'utf8'))
    )
    expect(job).toMatchObject({
      mode: 'relaunch',
      installPath: install,
      installKey: installKeyFor(install, 'darwin'),
      launch: ['open', '-n', '{app}', '--args', `--relaunch-token=${lock!.owner!.token}`]
    })
    expect(JSON.parse(fs.readFileSync(restoreFile(state), 'utf8'))).toMatchObject({
      activeSessionId: 's1',
      drafts: { s1: 'hello' }
    })
  })

  it('a helper that never writes ready: cancelled, lock released, no quit, app keeps running', async () => {
    const killPid = vi.fn()
    const { svc, confirmQuit } = service({
      spawnHelper: () => ({ pid: 999_999, failed: new Promise(() => {}) }),
      killPid
    })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/did not start/)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(killPid).toHaveBeenCalledWith(999_999)
    expect(readLock(state)).toBeNull()
    expect(svc.lastResult()?.status).toBe('aborted')
    // And a later request is not blocked by it.
    expect(svc.availability()).toEqual({ available: true })
  })

  it('a spawn error is reported straight away', async () => {
    const { svc, confirmQuit } = service({
      spawnHelper: () => ({ pid: undefined, failed: Promise.resolve(new Error('spawn ENOENT')) }),
      readyTimeoutMs: 5000
    })
    const t0 = Date.now()
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/ENOENT/)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(readLock(state)).toBeNull()
  })

  it('a second request while one is in flight is refused', async () => {
    const { svc, confirmQuit } = service()
    await svc.requestRelaunch({ mode: 'relaunch' })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/already in progress/)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    expect(svc.availability().available).toBe(false)
  })

  it('a live lock held by another job refuses; a stale one is broken', async () => {
    takeLock(state, { token: newToken(), pid: 1, at: Date.now() })
    const { svc } = service()
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/Another relaunch/)
    fs.rmSync(path.join(state, 'lock'), { recursive: true })
    takeLock(state, { token: newToken(), pid: 1, at: Date.now() - 16 * 60_000 })
    await svc.requestRelaunch({ mode: 'relaunch' })
  })

  it('eligibility (what offers the menu item) ignores a relaunch in flight', async () => {
    takeLock(state, { token: newToken(), pid: 1, at: Date.now() })
    const { svc } = service()
    expect(svc.eligible()).toEqual({ available: true })
    expect(svc.availability()).toEqual({
      available: false,
      reason: 'Another relaunch is in progress'
    })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/Another relaunch/)
  })

  it('refuses an unpackaged build and an ineligible install', async () => {
    await expect(
      service({ packaged: false }).svc.requestRelaunch({ mode: 'relaunch' })
    ).rejects.toThrow(/packaged/)
    fs.rmSync(path.join(install, 'Contents', 'Resources', 'claudeui-install.json'))
    const { svc } = service()
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/install marker/)
    expect(svc.availability()).toMatchObject({ available: false })
    expect(fs.existsSync(path.join(state, 'lock'))).toBe(false)
  })

  it('swap: the staged build must be a sibling with our name, and newer', async () => {
    const { svc } = service()
    const token = newToken()
    const elsewhere = makeFakeApp(path.join(root, 'sub', 'X.app'), '2.0.0', 'healthy')
    await expect(
      svc.requestRelaunch({ mode: 'swap', stagedPath: elsewhere, toVersion: '2.0.0' })
    ).rejects.toThrow(/beside the install/)
    const staged = siblingPath(install, 'update', '1.0.0', token, 'darwin')
    await expect(
      svc.requestRelaunch({ mode: 'swap', stagedPath: staged, toVersion: '1.0.0' })
    ).rejects.toThrow(/not newer/)
    expect(fs.existsSync(path.join(state, 'lock'))).toBe(false)
    const good = siblingPath(install, 'update', '2.0.0', token, 'darwin')
    // darwin compares names case-insensitively (APFS): a differently cased name is ours.
    const shouted = path.join(path.dirname(good), path.basename(good).toUpperCase())
    await svc.requestRelaunch({ mode: 'swap', stagedPath: shouted, toVersion: '2.0.0' })
    fs.rmSync(path.join(state, 'lock'), { recursive: true })
    const second = createRelaunchService({
      platform: 'darwin',
      packaged: true,
      execPath,
      pid: 4242,
      runningVersion: '1.0.0',
      buildId: null,
      stateDir: state,
      collectRestore: async () => null,
      confirmQuit: () => {},
      spawnHelper: (cmd) => {
        fs.writeFileSync(cmd.args.at(-1)!.replace(/\.job\.sh$/, '.ready'), '1')
        return { pid: undefined, failed: new Promise(() => {}) }
      }
    })
    await second.requestRelaunch({ mode: 'swap', stagedPath: good, toVersion: '2.0.0' })
    const lock = readLock(state)!
    const job = parseJob(
      JSON.parse(fs.readFileSync(jobFiles(state, lock.owner!.token).json, 'utf8'))
    )!
    expect(job.stagedPath).toBe(good)
    expect(job.backupPath).toBe(backupPathFor(install, '1.0.0', lock.owner!.token, 'darwin'))
  })

  it('windowless or unanswered: no restore record, the quit still goes ahead', async () => {
    const { svc, confirmQuit } = service({ collectRestore: () => new Promise(() => {}) })
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(fs.existsSync(restoreFile(state))).toBe(false)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
  })
})

describe('reportHealthy', () => {
  it('writes the health record the helper reads', async () => {
    const now = 1_800_000_000_000
    const { svc } = service({ now: () => now })
    await svc.reportHealthy()
    const text = fs.readFileSync(healthFile(state, installKeyFor(install, 'darwin')), 'utf8')
    expect(text).toBe(
      `{"version":"1.0.0","buildId":"abc1234@2026-11-24T00:00:00.000Z","pid":4242,"at":${now}}`
    )
  })

  it('does nothing for an unpackaged build', async () => {
    await service({ packaged: false }).svc.reportHealthy()
    expect(fs.existsSync(path.join(state, 'health'))).toBe(false)
  })

  it("on Windows, retries a rename the helper's read briefly blocks", async () => {
    let failures = 3
    const rename = vi.fn((from: string, to: string) => {
      if (failures-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      fs.renameSync(from, to)
    })
    const { svc } = service({
      writeOptions: { platform: 'win32', rename, sleep: async () => {} }
    })
    await svc.reportHealthy()
    expect(rename).toHaveBeenCalledTimes(4)
    expect(fs.existsSync(healthFile(state, installKeyFor(install, 'darwin')))).toBe(true)
  })
})

describe('writeAtomicRetrying', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code })

  it('retries EPERM, EBUSY and EACCES on win32, then succeeds', async () => {
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(state, 'x.json')
    const codes = ['EPERM', 'EBUSY', 'EACCES']
    const sleep = vi.fn(async () => {})
    await writeAtomicRetrying(file, 'ok', {
      platform: 'win32',
      sleep,
      rename: (from, to) => {
        const code = codes.shift()
        if (code) throw busy(code)
        fs.renameSync(from, to)
      }
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('ok')
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('gives up after 20 attempts and leaves no temp file', async () => {
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(state, 'y.json')
    const rename = vi.fn(() => {
      throw busy('EBUSY')
    })
    await expect(
      writeAtomicRetrying(file, 'x', { platform: 'win32', rename, sleep: async () => {} })
    ).rejects.toThrow('EBUSY')
    expect(rename).toHaveBeenCalledTimes(20)
    expect(fs.readdirSync(state)).toEqual([])
  })

  it('does not retry off Windows, nor another error', async () => {
    fs.mkdirSync(state, { recursive: true })
    for (const [platform, code] of [
      ['darwin', 'EBUSY'],
      ['win32', 'ENOENT']
    ]) {
      const rename = vi.fn(() => {
        throw busy(code)
      })
      await expect(
        writeAtomicRetrying(path.join(state, 'z.json'), 'x', {
          platform,
          rename,
          sleep: async () => {}
        })
      ).rejects.toThrow(code)
      expect(rename).toHaveBeenCalledTimes(1)
    }
  })
})

describe('restore record', () => {
  it('is one-shot', async () => {
    await writeRestore(state, { activeSessionId: 'a', drafts: { a: 'x' } }, 1000)
    expect(takeRestore(state, 2000)).toEqual({ activeSessionId: 'a', drafts: { a: 'x' } })
    expect(takeRestore(state, 2000)).toBeNull()
  })

  it('expires after 10 minutes, and is deleted anyway', async () => {
    await writeRestore(state, { activeSessionId: 'a', drafts: {} }, 1000)
    expect(takeRestore(state, 1000 + RESTORE_TTL_MS + 1)).toBeNull()
    expect(fs.existsSync(restoreFile(state))).toBe(false)
  })

  it('the collector resolves with what the renderer sends, and null with no window', async () => {
    const sent = vi.fn(() => true)
    const c = createRestoreCollector(sent)
    const p = c.collect()
    c.deliver({ activeSessionId: 's', drafts: { s: 'd', t: '' }, junk: 1 })
    await expect(p).resolves.toEqual({ activeSessionId: 's', drafts: { s: 'd' } })
    await expect(createRestoreCollector(() => false).collect()).resolves.toBeNull()
  })
})

describe('health gate', () => {
  it('waits for the window, then for the remote start to settle listening', async () => {
    let loaded!: () => void
    const windowLoaded = new Promise<void>((r) => (loaded = r))
    let settle!: (o: 'listening') => void
    const remoteStart = new Promise<'listening'>((r) => (settle = r))
    let outcome: string | null = null
    const p = whenHealthy({ windowLoaded, remoteStart }).then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 20))
    expect(outcome).toBeNull()
    loaded()
    await new Promise((r) => setTimeout(r, 20))
    expect(outcome).toBeNull()
    settle('listening')
    await p
    expect(outcome).toBe('listening')
  })

  it('a start that failed settles it too: health is recorded anyway, with a warning', async () => {
    const { logger } = await import('../../../../core/services/logger')
    vi.mocked(logger.warn).mockClear()
    const outcome = await whenHealthy({
      windowLoaded: Promise.resolve(),
      remoteStart: Promise.resolve('failed')
    })
    expect(outcome).toBe('failed')
    expect(logger.warn).toHaveBeenCalledWith('relaunch', expect.stringContaining('failed to start'))
  })

  it('nothing configured settles at once; a start that never settles is cut off at the bound', async () => {
    await expect(
      whenHealthy({ windowLoaded: Promise.resolve(), remoteStart: Promise.resolve('not-started') })
    ).resolves.toBe('not-started')
    const t0 = Date.now()
    await expect(
      whenHealthy({
        windowLoaded: Promise.resolve(),
        remoteStart: new Promise(() => {}),
        boundMs: 50
      })
    ).resolves.toBe('timed-out')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('reconcileJobs', () => {
  const key = (): string => installKeyFor(install, 'darwin')
  const DAY = 24 * 60 * 60_000
  const NOW = Date.now()

  function addJob(opts: {
    status?: 'updated' | 'failed' | 'ok' | 'interrupted'
    resultAt?: number
    toVersion?: string
    backup?: boolean
    installKey?: string
  }): { token: string; backup: string } {
    const token = newToken()
    const backup = backupPathFor(install, '0.9.0', token, 'darwin')
    if (opts.backup) makeFakeApp(backup, '0.9.0', 'healthy')
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: 1,
      platform: 'darwin',
      mode: 'swap',
      installPath: install,
      installKey: opts.installKey ?? key(),
      stateDir: state,
      stagedPath: siblingPath(install, 'update', '1.0.0', token, 'darwin'),
      backupPath: backup,
      failedPath: siblingPath(install, 'failed', '1.0.0', token, 'darwin'),
      fromVersion: '0.9.0',
      toVersion: opts.toVersion ?? '1.0.0',
      startedAt: (opts.resultAt ?? NOW) - 1000,
      launch: [],
      timeouts: DEFAULT_TIMEOUTS
    }
    fs.mkdirSync(state, { recursive: true })
    writeJobFiles(jobFiles(state, token), job)
    if (opts.status)
      fs.writeFileSync(
        jobFiles(state, token).result,
        JSON.stringify({
          token,
          status: opts.status,
          mode: 'swap',
          fromVersion: '0.9.0',
          toVersion: job.toVersion,
          at: opts.resultAt ?? NOW
        })
      )
    return { token, backup }
  }

  const run = (over: Partial<Parameters<typeof reconcileJobs>[0]> = {}) =>
    reconcileJobs({
      stateDir: state,
      installPath: install,
      installKey: key(),
      platform: 'darwin',
      runningVersion: '1.0.0',
      now: NOW,
      ...over
    })

  it('keeps the newest updated backup for 7 days and removes older ones through the gate', async () => {
    const newest = addJob({ status: 'updated', resultAt: NOW - DAY, backup: true })
    const older = addJob({ status: 'updated', resultAt: NOW - 2 * DAY, backup: true })
    const r = await run()
    expect(fs.existsSync(newest.backup)).toBe(true)
    expect(fs.existsSync(older.backup)).toBe(false)
    expect(r.removedBackups).toEqual([older.backup])
    expect(fs.existsSync(install)).toBe(true)
  })

  it('removes even the newest backup once it is older than 7 days', async () => {
    const j = addJob({ status: 'updated', resultAt: NOW - BACKUP_KEEP_MS - 1, backup: true })
    await run()
    expect(fs.existsSync(j.backup)).toBe(false)
  })

  it("never removes a failed job's backup (it may be what is running)", async () => {
    const j = addJob({ status: 'failed', resultAt: NOW - 30 * DAY, backup: true })
    await run()
    expect(fs.existsSync(j.backup)).toBe(true)
  })

  it("leaves another install's jobs alone", async () => {
    const j = addJob({
      status: 'updated',
      resultAt: NOW - 20 * DAY,
      backup: true,
      installKey: 'ffffffffffffffff'
    })
    await run()
    expect(fs.existsSync(j.backup)).toBe(true)
  })

  it('an abandoned job whose target is running is recorded updated (recovered)', async () => {
    const j = addJob({ toVersion: '1.0.0' })
    expect((await run()).recovered).toEqual([j.token])
    const result = parseRelaunchResult(
      JSON.parse(fs.readFileSync(jobFiles(state, j.token).result, 'utf8'))
    )
    expect(result).toMatchObject({ status: 'updated', recovered: true })
    expect(lastResultFor(state, key())?.token).toBe(j.token)
  })

  it('an abandoned job whose target is not running is reported nowhere and its paths left alone', async () => {
    const j = addJob({ toVersion: '2.0.0', backup: true })
    expect((await run()).recovered).toEqual([])
    expect(fs.existsSync(jobFiles(state, j.token).result)).toBe(false)
    expect(fs.existsSync(j.backup)).toBe(true)
    expect(lastResultFor(state, key())).toBeNull()
  })

  it('an interrupted swap whose target is running is recorded updated (recovered)', async () => {
    const j = addJob({ status: 'interrupted', toVersion: '1.0.0' })
    expect((await run()).recovered).toEqual([j.token])
    expect(lastResultFor(state, key())).toMatchObject({
      token: j.token,
      status: 'updated',
      recovered: true
    })
  })

  it('an interrupted swap whose target is not running keeps its interrupted result', async () => {
    const j = addJob({ status: 'interrupted', toVersion: '2.0.0', backup: true })
    expect((await run()).recovered).toEqual([])
    expect(lastResultFor(state, key())).toMatchObject({ token: j.token, status: 'interrupted' })
    expect(fs.existsSync(j.backup)).toBe(true)
  })

  it('a delete that fails (or throws) does not stop the sweep', async () => {
    const a = addJob({ status: 'updated', resultAt: NOW - 2 * DAY, backup: true })
    const b = addJob({ status: 'updated', resultAt: NOW - 3 * DAY, backup: true })
    const c = addJob({ status: 'updated', resultAt: NOW - 4 * DAY, backup: true })
    const newest = addJob({ status: 'updated', resultAt: NOW - DAY, backup: true })
    const attempts: string[] = []
    const r = await run({
      remove: (_install, candidate) => {
        attempts.push(candidate)
        if (candidate === a.backup) throw new Error('boom')
        if (candidate === b.backup) return { removed: false, reason: 'in use' }
        fs.rmSync(candidate, { recursive: true })
        return { removed: true }
      }
    })
    expect(attempts).toEqual([a.backup, b.backup, c.backup])
    expect(r.removedBackups).toEqual([c.backup])
    expect(fs.existsSync(newest.backup)).toBe(true)
  })

  it('a job whose helper still holds the lock is in flight, not abandoned', async () => {
    const j = addJob({ toVersion: '1.0.0' })
    takeLock(state, { token: j.token, pid: 1, at: NOW - 1000 })
    expect((await run()).recovered).toEqual([])
    expect(fs.existsSync(jobFiles(state, j.token).result)).toBe(false)
  })

  it('unlinks job files older than 30 days, and the newest result wins', async () => {
    const old = addJob({ status: 'ok', resultAt: NOW - 40 * DAY })
    const fresh = addJob({ status: 'ok', resultAt: NOW - DAY })
    const past = new Date(NOW - JOB_FILES_KEEP_MS - DAY)
    for (const f of Object.values(jobFiles(state, old.token)))
      if (fs.existsSync(f)) fs.utimesSync(f, past, past)
    expect(lastResultFor(state, key())?.token).toBe(fresh.token)
    expect((await run()).removedFiles).toBe(3) // job.json, job.sh, result.json
    expect(fs.existsSync(jobFiles(state, old.token).json)).toBe(false)
    expect(fs.existsSync(jobFiles(state, fresh.token).json)).toBe(true)
  })
})
