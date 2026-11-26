/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  createRelaunchService,
  SIGNING_WINDOW_MS,
  type RelaunchServiceDeps
} from '../relaunch-service'
import { POWERSHELL_HELPER_ARGS_LINE, type HelperCommand } from '../helper-scripts'
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

// makeFakeApp copies /bin/bash: the suites that need a fake install run on
// macOS and Linux only (helper-powershell.test.ts drives the Windows helper).
const onWindows = process.platform === 'win32'

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-svc-')))
  state = path.join(root, 'state')
  if (onWindows) return
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

describe.skipIf(onWindows)('requestRelaunch', () => {
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
      svc.requestRelaunch({
        mode: 'swap',
        stagedPath: elsewhere,
        toVersion: '2.0.0',
        source: 'release'
      })
    ).rejects.toThrow(/beside the install/)
    const staged = makeFakeApp(
      siblingPath(install, 'update', '1.0.0', token, 'darwin'),
      '1.0.0',
      'healthy'
    )
    await expect(
      svc.requestRelaunch({
        mode: 'swap',
        stagedPath: staged,
        toVersion: '1.0.0',
        source: 'release'
      })
    ).rejects.toThrow(/not newer/)
    expect(fs.existsSync(path.join(state, 'lock'))).toBe(false)
    const good = makeFakeApp(
      siblingPath(install, 'update', '2.0.0', token, 'darwin'),
      '2.0.0',
      'healthy'
    )
    // darwin compares names case-insensitively (APFS): a differently cased name is ours.
    // Only where the volume agrees (a case-sensitive test volume has no such folder).
    const shouted = path.join(path.dirname(good), path.basename(good).toUpperCase())
    if (fs.existsSync(shouted)) {
      await svc.requestRelaunch({
        mode: 'swap',
        stagedPath: shouted,
        toVersion: '2.0.0',
        source: 'release'
      })
      fs.rmSync(path.join(state, 'lock'), { recursive: true })
    }
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
    await second.requestRelaunch({
      mode: 'swap',
      stagedPath: good,
      toVersion: '2.0.0',
      source: 'release'
    })
    const lock = readLock(state)!
    const job = parseJob(
      JSON.parse(fs.readFileSync(jobFiles(state, lock.owner!.token).json, 'utf8'))
    )!
    expect(job.stagedPath).toBe(good)
    expect(job.backupPath).toBe(backupPathFor(install, '1.0.0', lock.owner!.token, 'darwin'))
  })

  describe('swap hardening', () => {
    const token = 'abcdef0123456789abcdef0123456789'
    const swap = (
      stagedPath: string,
      toVersion: string,
      source: 'release' | 'rebuild' = 'release'
    ): { mode: 'swap'; stagedPath: string; toVersion: string; source: 'release' | 'rebuild' } => ({
      mode: 'swap',
      stagedPath,
      toVersion,
      source
    })

    it.each(['old', 'failed', 'extract'] as const)(
      'refuses a %s sibling: only a staged (update) name is swapped in',
      async (kind) => {
        const { svc, confirmQuit } = service()
        const dir = makeFakeApp(
          siblingPath(install, kind, '2.0.0', token, 'darwin'),
          '2.0.0',
          'healthy'
        )
        await expect(svc.requestRelaunch(swap(dir, '2.0.0'))).rejects.toThrow(/beside the install/)
        expect(confirmQuit).not.toHaveBeenCalled()
        expect(readLock(state)).toBeNull()
      }
    )

    it('refuses a staged build whose own marker is another version, or none', async () => {
      const { svc } = service()
      const other = makeFakeApp(
        siblingPath(install, 'update', '2.0.0', token, 'darwin'),
        '2.0.0',
        'healthy',
        { markerVersion: '2.0.1' }
      )
      await expect(svc.requestRelaunch(swap(other, '2.0.0'))).rejects.toThrow(
        /is 2\.0\.1, not 2\.0\.0/
      )
      const unversioned = makeFakeApp(
        siblingPath(install, 'update', '3.0.0', token, 'darwin'),
        '3.0.0',
        'healthy',
        { markerVersion: null }
      )
      await expect(svc.requestRelaunch(swap(unversioned, '3.0.0'))).rejects.toThrow(
        /unknown version/
      )
      const unmarked = makeFakeApp(
        siblingPath(install, 'update', '4.0.0', token, 'darwin'),
        '4.0.0',
        'healthy',
        { marker: false }
      )
      await expect(svc.requestRelaunch(swap(unmarked, '4.0.0'))).rejects.toThrow(
        /no ClaudeUI install marker/
      )
      await expect(
        svc.requestRelaunch(swap(siblingPath(install, 'update', '5.0.0', token, 'darwin'), '5.0.0'))
      ).rejects.toThrow(/missing/)
      expect(readLock(state)).toBeNull()
    })

    it.skipIf(process.platform === 'win32')('refuses a staged name that is a symlink', async () => {
      const { svc } = service()
      const target = makeFakeApp(path.join(root, 'elsewhere', 'ClaudeUI.app'), '2.0.0', 'healthy')
      const link = siblingPath(install, 'update', '2.0.0', token, 'darwin')
      fs.symlinkSync(target, link)
      await expect(svc.requestRelaunch(swap(link, '2.0.0'))).rejects.toThrow(/missing/)
    })

    it('a release must be newer than the running version', async () => {
      const { svc } = service()
      const same = makeFakeApp(
        siblingPath(install, 'update', '1.0.0', token, 'darwin'),
        '1.0.0',
        'healthy'
      )
      await expect(svc.requestRelaunch(swap(same, '1.0.0'))).rejects.toThrow(/not newer/)
      const older = makeFakeApp(
        siblingPath(install, 'update', '0.9.0', token, 'darwin'),
        '0.9.0',
        'healthy'
      )
      await expect(svc.requestRelaunch(swap(older, '0.9.0'))).rejects.toThrow(/not newer/)
    })

    it('a rebuild may be the same version (or older): the user built it on purpose', async () => {
      const { svc, confirmQuit } = service()
      const same = makeFakeApp(
        siblingPath(install, 'update', '1.0.0', token, 'darwin'),
        '1.0.0',
        'healthy'
      )
      await svc.requestRelaunch(swap(same, '1.0.0', 'rebuild'))
      expect(confirmQuit).toHaveBeenCalledTimes(1)
      const lock = readLock(state)!
      const job = parseJob(
        JSON.parse(fs.readFileSync(jobFiles(state, lock.owner!.token).json, 'utf8'))
      )!
      expect(job).toMatchObject({ mode: 'swap', stagedPath: same, toVersion: '1.0.0' })
      fs.rmSync(path.join(state, 'lock'), { recursive: true })
      const older = makeFakeApp(
        siblingPath(install, 'update', '0.9.0', token, 'darwin'),
        '0.9.0',
        'healthy'
      )
      await service().svc.requestRelaunch(swap(older, '0.9.0', 'rebuild'))
    })

    it('the job names both builds and the source, for the notice; a plain relaunch names one', async () => {
      const { svc } = service()
      const staged = makeFakeApp(
        siblingPath(install, 'update', '1.0.0', token, 'darwin'),
        '1.0.0',
        'healthy',
        { buildId: 'DEF5678abcdef@2026-11-25T00:00:00.000Z' }
      )
      await svc.requestRelaunch(swap(staged, '1.0.0', 'rebuild'))
      const readJob = (): RelaunchJob =>
        parseJob(
          JSON.parse(fs.readFileSync(jobFiles(state, readLock(state)!.owner!.token).json, 'utf8'))
        )!
      // The running install's marker has no build id: this process's own is used.
      expect(readJob()).toMatchObject({
        fromBuild: 'abc1234',
        toBuild: 'def5678',
        source: 'rebuild'
      })
      // The helper's shell rendering stays as it was (the scripts never read these).
      const sh = fs.readFileSync(jobFiles(state, readLock(state)!.owner!.token).sh, 'utf8')
      expect(sh).not.toMatch(/BUILD|SOURCE/)
      fs.rmSync(path.join(state, 'lock'), { recursive: true })

      await service().svc.requestRelaunch({ mode: 'relaunch' })
      const plain = readJob()
      expect(plain).toMatchObject({ mode: 'relaunch', fromBuild: 'abc1234', toBuild: 'abc1234' })
      expect(plain.source).toBeUndefined()
    })

    it('refuses a swap without a source', async () => {
      const { svc } = service()
      const good = makeFakeApp(
        siblingPath(install, 'update', '2.0.0', token, 'darwin'),
        '2.0.0',
        'healthy'
      )
      await expect(
        svc.requestRelaunch({ mode: 'swap', stagedPath: good, toVersion: '2.0.0' } as never)
      ).rejects.toThrow(/where its build came from/)
    })
  })

  it('busy (a rebuild running) refuses every relaunch, and says why', async () => {
    let busy: string | null = 'A rebuild is running; wait for it or cancel it'
    const { svc, confirmQuit } = service({ busy: () => busy })
    expect(svc.availability()).toEqual({ available: false, reason: busy })
    expect(svc.eligible()).toEqual({ available: true })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/rebuild is running/)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(readLock(state)).toBeNull()
    busy = null
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(confirmQuit).toHaveBeenCalledTimes(1)
  })

  it('relaunchInProgress: false at rest, true while one is in flight or another holds the lock', async () => {
    const { svc } = service()
    expect(svc.relaunchInProgress()).toBe(false)
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(svc.relaunchInProgress()).toBe(true)
    fs.rmSync(path.join(state, 'lock'), { recursive: true })
    const other = service().svc
    takeLock(state, { token: newToken(), pid: 1, at: Date.now() })
    expect(other.relaunchInProgress()).toBe(true)
  })

  it('windowless or unanswered: no restore record, the quit still goes ahead', async () => {
    const { svc, confirmQuit } = service({ collectRestore: () => new Promise(() => {}) })
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(fs.existsSync(restoreFile(state))).toBe(false)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
  })

  describe('a build made in place (the install rebuilt under the running app)', () => {
    const RUNNING = 'abc1234@2026-11-24T00:00:00.000Z'
    const NEW = 'def5678@2026-11-25T01:02:03.000Z'
    const markerFile = (): string =>
      path.join(install, 'Contents', 'Resources', 'claudeui-install.json')
    const sealFile = (): string => path.join(install, 'Contents', '_CodeSignature', 'CodeResources')
    /** Rewrite the install as a build would: the marker, then (when `signed`) the seal after it. */
    const rebuildInPlace = (buildId: string, version: string, signed = true): void => {
      makeFakeApp(install, version, 'healthy', { buildId })
      const markedAt = new Date(Date.now() - 10_000)
      fs.utimesSync(markerFile(), markedAt, markedAt)
      if (!signed) return
      fs.mkdirSync(path.dirname(sealFile()), { recursive: true })
      fs.writeFileSync(sealFile(), 'sealed')
    }
    const lastJob = (): RelaunchJob =>
      parseJob(
        JSON.parse(fs.readFileSync(jobFiles(state, readLock(state)!.owner!.token).json, 'utf8'))
      )!

    it('the same build on disk as running: a plain relaunch, nothing new reported', async () => {
      rebuildInPlace(RUNNING, '1.0.0')
      const { svc } = service()
      expect(svc.availability()).toEqual({ available: true })
      await svc.requestRelaunch({ mode: 'relaunch' })
      const job = lastJob()
      expect(job).toMatchObject({ fromBuild: 'abc1234', toBuild: 'abc1234', toVersion: '1.0.0' })
      expect(job.source).toBeUndefined()
    })

    it('another build on disk: offered as new, and the job names it so the notice and reconcile see it', async () => {
      rebuildInPlace(NEW, '1.1.0-pre.1')
      const { svc, confirmQuit } = service()
      expect(svc.availability()).toEqual({
        available: true,
        newBuild: { version: '1.1.0-pre.1', commit: 'def5678', builtAt: '2026-11-25T01:02:03.000Z' }
      })
      await svc.requestRelaunch({ mode: 'relaunch' })
      expect(confirmQuit).toHaveBeenCalledTimes(1)
      // From this process's build id, not the marker (which already names the new one).
      expect(lastJob()).toMatchObject({
        mode: 'relaunch',
        fromVersion: '1.0.0',
        toVersion: '1.1.0-pre.1',
        fromBuild: 'abc1234',
        toBuild: 'def5678',
        source: 'rebuild',
        stagedPath: '',
        backupPath: ''
      })
    })

    it('an uncommitted rebuild of the same commit is a new build too, offered without the commit (it names nothing new)', async () => {
      rebuildInPlace('abc1234@2026-11-25T09:00:00.000Z', '1.0.0')
      const { svc } = service()
      expect(svc.availability().newBuild).toEqual({
        version: '1.0.0',
        builtAt: '2026-11-25T09:00:00.000Z'
      })
      await svc.requestRelaunch({ mode: 'relaunch' })
      expect(lastJob()).toMatchObject({
        fromBuild: 'abc1234',
        toBuild: 'abc1234',
        source: 'rebuild'
      })
    })

    it('a refusal is not cached: Relaunch is offered as soon as a packed build gets its marker', async () => {
      // Mid-pack: electron-builder has put a bare bundle in place, no marker yet.
      fs.rmSync(markerFile())
      const { svc } = service()
      expect(svc.availability().available).toBe(false)
      rebuildInPlace(NEW, '1.0.0')
      expect(svc.availability()).toMatchObject({ available: true, newBuild: { commit: 'def5678' } })
    })

    it('a build still being made (marked, not yet signed) refuses, and is offered again once sealed', async () => {
      rebuildInPlace(NEW, '1.0.0', false)
      const { svc, confirmQuit } = service()
      expect(svc.availability()).toEqual({
        available: false,
        reason: expect.stringMatching(/still being written/)
      })
      await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/still being written/)
      expect(confirmQuit).not.toHaveBeenCalled()
      expect(readLock(state)).toBeNull()
      // A seal from an earlier build (older than the marker) is still unfinished.
      fs.mkdirSync(path.dirname(sealFile()), { recursive: true })
      fs.writeFileSync(sealFile(), 'old')
      const sealedBefore = new Date(Date.now() - 60_000)
      fs.utimesSync(sealFile(), sealedBefore, sealedBefore)
      expect(svc.availability().available).toBe(false)
      fs.utimesSync(sealFile(), new Date(), new Date())
      expect(svc.availability()).toMatchObject({ available: true, newBuild: { commit: 'def5678' } })
    })

    it('a swap is refused while a build made in place is unsigned, and backs that build up once it is', async () => {
      rebuildInPlace(NEW, '1.0.0', false)
      const staged = makeFakeApp(
        siblingPath(install, 'update', '1.2.0', newToken(), 'darwin'),
        '1.2.0',
        'healthy',
        { buildId: '9abcdef@2026-11-26T00:00:00.000Z' }
      )
      const swap = {
        mode: 'swap' as const,
        stagedPath: staged,
        toVersion: '1.2.0',
        source: 'release' as const
      }
      const { svc, confirmQuit } = service()
      await expect(svc.requestRelaunch(swap)).rejects.toThrow(/still being written/)
      expect(confirmQuit).not.toHaveBeenCalled()
      fs.mkdirSync(path.dirname(sealFile()), { recursive: true })
      fs.writeFileSync(sealFile(), 'sealed')
      await svc.requestRelaunch(swap)
      // The backup (and a rollback) is the build on disk, not the one this process runs.
      expect(lastJob()).toMatchObject({ mode: 'swap', fromBuild: 'def5678', toBuild: '9abcdef' })
    })

    it('a build never signed (build:unpack, a failed codesign) holds restarts off only for a while', async () => {
      rebuildInPlace(NEW, '1.0.0', false)
      const later = (ms: number) => service({ now: () => Date.now() + ms }).svc.availability()
      expect(later(0).available).toBe(false)
      expect(later(SIGNING_WINDOW_MS)).toMatchObject({
        available: true,
        newBuild: { commit: 'def5678' }
      })
    })

    it('a running build with no id (or a marker without one) never reports a new build', async () => {
      rebuildInPlace(NEW, '1.0.0', false)
      expect(service({ buildId: null }).svc.availability()).toEqual({ available: true })
      makeFakeApp(install, '1.0.0', 'healthy')
      expect(service().svc.availability()).toEqual({ available: true })
    })
  })
})

// The Windows path through the service (probes and a fake spawn, no fake
// install), so it runs on every host.
describe('requestRelaunch on Windows: the launcher', () => {
  const winService = (over: Partial<RelaunchServiceDeps> = {}) =>
    service({
      platform: 'win32',
      execPath: 'C:\\Tools\\ClaudeUI\\ClaudeUI.exe',
      probes: {
        canWriteDir: () => true,
        readFile: () =>
          JSON.stringify({
            schema: 1,
            product: 'com.claudeui.app',
            kind: 'desktop',
            entries: ['ClaudeUI.exe', 'resources']
          }),
        readdir: () => ['ClaudeUI.exe', 'resources']
      },
      ...over
    })
  /** The job's files, from the job path the command carries. */
  const filesOf = (cmd: HelperCommand) =>
    jobFiles(state, path.basename(cmd.env.CLAUDEUI_RELAUNCH_JOB, '.job.json'))

  it('spawns the launcher, with the helper arguments written beside the job', async () => {
    const spawned: Array<[HelperCommand, string]> = []
    const { svc, confirmQuit } = winService({
      spawnHelper: (cmd, cwd) => {
        spawned.push([cmd, cwd])
        const files = filesOf(cmd)
        fs.writeFileSync(files.helperPid, '4321')
        fs.writeFileSync(files.ready, '1')
        return { pid: 77, failed: new Promise(() => {}), stop: () => {} }
      }
    })
    await svc.requestRelaunch({ mode: 'relaunch' })
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    const [cmd, cwd] = spawned[0]
    expect(cwd).toBe(state)
    expect(cmd.launcher).toEqual({
      pidFile: filesOf(cmd).helperPid,
      errorFile: filesOf(cmd).launchError
    })
    expect(cmd.env.CLAUDEUI_RELAUNCH_ARGS).toBe(filesOf(cmd).helperArgs)
    expect(fs.readFileSync(filesOf(cmd).helperArgs, 'utf8')).toBe(POWERSHELL_HELPER_ARGS_LINE)
  })

  it('never ready: stops the launcher by its handle and the helper by the pid it wrote', async () => {
    const killPid = vi.fn()
    const stop = vi.fn()
    let writePid = true
    const { svc, confirmQuit } = winService({
      spawnHelper: (cmd) => {
        if (writePid) fs.writeFileSync(filesOf(cmd).helperPid, '4321\r\n')
        return { pid: 77, failed: new Promise(() => {}), stop }
      },
      killPid,
      readyTimeoutMs: 300
    })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(
      /did not start within 0\.3 s/
    )
    expect(stop).toHaveBeenCalledTimes(1)
    expect(killPid.mock.calls).toEqual([[4321]]) // never the launcher's pid
    expect(readLock(state)).toBeNull()
    // No pid file (the launcher never got that far): only the launcher is stopped.
    writePid = false
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/did not start/)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(killPid).toHaveBeenCalledTimes(1)
    expect(confirmQuit).not.toHaveBeenCalled()
  })

  it('a failed launcher is reported straight away', async () => {
    const failure = new Error('the helper launcher failed (exit code 1); the log says why')
    const { svc, confirmQuit } = winService({
      spawnHelper: () => ({ pid: 77, failed: Promise.resolve(failure), stop: () => {} })
    })
    const t0 = Date.now()
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/launcher failed/)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(readLock(state)).toBeNull()
  })

  it('waits 15 s for the helper on Windows (two PowerShell starts)', async () => {
    let t = 1_800_000_000_000
    const { svc } = winService({
      spawnHelper: () => ({ pid: 77, failed: new Promise(() => {}) }),
      killPid: () => {},
      readyTimeoutMs: undefined,
      now: () => (t += 1000)
    })
    await expect(svc.requestRelaunch({ mode: 'relaunch' })).rejects.toThrow(/within 15 s/)
  })
})

describe.skipIf(onWindows)('reportHealthy', () => {
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

describe.skipIf(onWindows)('reconcileJobs', () => {
  const key = (): string => installKeyFor(install, 'darwin')
  const DAY = 24 * 60 * 60_000
  const NOW = Date.now()

  function addJob(opts: {
    status?: 'updated' | 'failed' | 'ok' | 'interrupted'
    resultAt?: number
    toVersion?: string
    backup?: boolean
    installKey?: string
    facts?: Pick<RelaunchJob, 'fromBuild' | 'toBuild' | 'source'>
    resultExtra?: Record<string, unknown>
    mode?: RelaunchJob['mode']
  }): { token: string; backup: string } {
    const token = newToken()
    const backup = backupPathFor(install, '0.9.0', token, 'darwin')
    if (opts.backup) makeFakeApp(backup, '0.9.0', 'healthy')
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: 1,
      platform: 'darwin',
      mode: opts.mode ?? 'swap',
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
      timeouts: DEFAULT_TIMEOUTS,
      ...opts.facts
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
          at: opts.resultAt ?? NOW,
          ...opts.resultExtra
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

  it('an abandoned relaunch into a build made in place (another version) is recovered when that build runs', async () => {
    const facts = { fromBuild: 'abc1234', toBuild: 'def5678', source: 'rebuild' as const }
    const { token } = addJob({ mode: 'relaunch', toVersion: '1.1.0-pre.1', facts })
    // The old version still running: not its target, nothing recorded.
    expect((await run()).recovered).toEqual([])
    expect(lastResultFor(state, key())).toBeNull()
    expect((await run({ runningVersion: '1.1.0-pre.1' })).recovered).toEqual([token])
    expect(lastResultFor(state, key())).toMatchObject({
      token,
      status: 'ok',
      mode: 'relaunch',
      toVersion: '1.1.0-pre.1',
      recovered: true,
      ...facts
    })
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

  it('the reported result carries the job’s builds and source; a field the result has wins', async () => {
    const j = addJob({
      status: 'updated',
      toVersion: '0.9.0',
      facts: { fromBuild: 'abc1234', toBuild: 'def5678', source: 'rebuild' }
    })
    expect(lastResultFor(state, key())).toMatchObject({
      token: j.token,
      status: 'updated',
      fromBuild: 'abc1234',
      toBuild: 'def5678',
      source: 'rebuild'
    })
    const k = addJob({
      status: 'rolled-back' as never,
      resultAt: NOW + 1,
      facts: { fromBuild: 'abc1234', toBuild: 'def5678' },
      resultExtra: { toBuild: '9999999' }
    })
    expect(lastResultFor(state, key())).toMatchObject({
      token: k.token,
      fromBuild: 'abc1234',
      toBuild: '9999999'
    })
    // A job without them (an older build wrote it) reports none.
    addJob({ status: 'ok', resultAt: NOW + 2 })
    const plain = lastResultFor(state, key())!
    expect(plain.fromBuild).toBeUndefined()
    expect(plain.source).toBeUndefined()
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
