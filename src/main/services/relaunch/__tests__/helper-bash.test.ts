/**
 * @vitest-environment node
 *
 * The bash relaunch helper, end to end, against temp dirs: marker-bearing fake
 * installs whose "app" records each launch and (when healthy) writes a health
 * record after a short delay. Short timeouts throughout. Nothing here touches a
 * real install or `~/.claude/ui`: the job names only temp paths.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BASH_HELPER, helperCommand } from '../helper-scripts'
import { DEFAULT_TIMEOUTS, writeJobFiles, type RelaunchJob, type RelaunchTimeouts } from '../job'
import {
  backupPathFor,
  failedPathFor,
  installKeyFor,
  jobFiles,
  newToken,
  siblingPath
} from '../paths'
import { takeLock } from '../lock'
import { parseRelaunchResult, type RelaunchResult } from '../../../../shared/relaunch'
import {
  alive,
  fakeLaunch,
  launches,
  makeFakeApp,
  versionOf,
  waitFor,
  type FakeMode
} from './fake-install'

const started: number[] = []
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
})

/** A pid that has already exited. */
function deadPid(): number {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

interface Fixture {
  root: string
  state: string
  install: string
  token: string
  files: ReturnType<typeof jobFiles>
  launchesFile: string
  staged: string
  backup: string
  failed: string
  run: (over?: {
    pid?: number
    timeouts?: Partial<RelaunchTimeouts>
    launch?: string[]
  }) => Promise<number>
  result: (timeoutMs?: number) => Promise<RelaunchResult>
}

function fixture(opts: {
  mode: 'relaunch' | 'swap'
  installMode?: FakeMode
  staged?: FakeMode | 'missing' | 'no-marker'
}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-helper-')))
  const state = path.join(root, 'state')
  fs.mkdirSync(state)
  const install = makeFakeApp(
    path.join(root, 'ClaudeUI.app'),
    '1.0.0',
    opts.installMode ?? 'healthy'
  )
  const token = newToken()
  const files = jobFiles(state, token)
  const staged = siblingPath(install, 'update', '2.0.0', token, 'darwin')
  if (opts.staged && opts.staged !== 'missing')
    makeFakeApp(staged, '2.0.0', opts.staged === 'no-marker' ? 'healthy' : opts.staged, {
      marker: opts.staged !== 'no-marker'
    })
  const backup = backupPathFor(install, '1.0.0', token, 'darwin')
  const failed = failedPathFor(install, '2.0.0', token, 'darwin')
  const launchesFile = path.join(root, 'launches.log')
  const installKey = installKeyFor(install, 'darwin')

  // A startup file the helper (its $0 is claudeui-relaunch) must never read. The
  // fake apps it launches are plain bash and do read it, so it checks who runs it.
  fs.writeFileSync(
    path.join(root, 'bash-env.sh'),
    `[ "$0" = claudeui-relaunch ] && touch '${path.join(root, 'BASH_ENV_RAN')}'\n`
  )

  const run = async (
    over: { pid?: number; timeouts?: Partial<RelaunchTimeouts>; launch?: string[] } = {}
  ) => {
    const timeouts: RelaunchTimeouts = {
      ...DEFAULT_TIMEOUTS,
      waitPidSec: 5,
      lockWaitSec: 1,
      killWaitSec: 1,
      launchCheckSec: 1,
      healthSec: 4,
      ...over.timeouts
    }
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: over.pid ?? deadPid(),
      platform: 'darwin',
      mode: opts.mode,
      installPath: install,
      installKey,
      stateDir: state,
      stagedPath: opts.mode === 'swap' ? staged : '',
      backupPath: opts.mode === 'swap' ? backup : '',
      failedPath: opts.mode === 'swap' ? failed : '',
      fromVersion: '1.0.0',
      toVersion: opts.mode === 'swap' ? '2.0.0' : '1.0.0',
      startedAt: Date.now(),
      launch: over.launch ?? fakeLaunch,
      timeouts
    }
    takeLock(state, { token, pid: process.pid, at: Date.now() })
    writeJobFiles(files, job)
    const cmd = helperCommand('darwin', files)
    const child = spawn(cmd.file, cmd.args, {
      detached: true,
      stdio: 'ignore',
      cwd: state,
      env: {
        HOME: root,
        FAKE_LAUNCHES: launchesFile,
        FAKE_STATE: state,
        FAKE_KEY: installKey,
        // Privileged mode must ignore these: nothing inherited runs before the helper.
        BASH_ENV: path.join(root, 'bash-env.sh'),
        ENV: path.join(root, 'bash-env.sh')
      }
    })
    if (child.pid) started.push(child.pid)
    child.unref()
    return child.pid!
  }

  const result = async (timeoutMs = 15_000): Promise<RelaunchResult> => {
    const r = await waitFor(
      () =>
        fs.existsSync(files.result) &&
        parseRelaunchResult(JSON.parse(fs.readFileSync(files.result, 'utf8'))),
      timeoutMs,
      'the result'
    )
    for (const l of launches(launchesFile)) started.push(l.pid)
    // The lock is released on every exit path (just after the result, which
    // already makes it stale: `isLockStale`).
    await waitFor(() => !fs.existsSync(path.join(state, 'lock')), 3000, 'the lock release')
    expect(fs.existsSync(path.join(root, 'BASH_ENV_RAN'))).toBe(false)
    return r
  }

  return { root, state, install, token, files, launchesFile, staged, backup, failed, run, result }
}

// Every case spawns the helper and fake apps and waits on real timeouts (up to 4 s
// of health window plus a retry); a busy CI runner needs more than vitest's 5 s.
describe
  .skipIf(process.platform === 'win32')
  .concurrent('bash relaunch helper', { timeout: 20_000 }, () => {
    it('runs the fixed script with the job path as its only argument', () => {
      const cmd = helperCommand('darwin', { json: '/s/t.job.json', sh: '/s/t.job.sh' })
      expect(cmd).toEqual({
        file: '/bin/bash',
        // -p: no BASH_ENV/ENV, no SHELLOPTS, no functions imported from the environment.
        args: ['-p', '-c', BASH_HELPER, 'claudeui-relaunch', '/s/t.job.sh'],
        env: {},
        unsetEnv: []
      })
    })

    it('writes the ready file immediately, while the old process still runs', async ({
      expect
    }) => {
      const f = fixture({ mode: 'relaunch' })
      const old = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      started.push(old.pid!)
      const t0 = Date.now()
      await f.run({ pid: old.pid, timeouts: { waitPidSec: 30 } })
      await waitFor(() => fs.existsSync(f.files.ready), 3000, 'the ready file')
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(fs.existsSync(f.files.result)).toBe(false)
      expect(launches(f.launchesFile)).toEqual([])
      old.kill('SIGKILL') // "the app quit"
      expect((await f.result()).status).toBe('ok')
    })

    it('relaunch: launches the install and reports ok once it is healthy', async ({ expect }) => {
      const f = fixture({ mode: 'relaunch' })
      await f.run()
      const r = await f.result()
      expect(r).toMatchObject({ token: f.token, status: 'ok', mode: 'relaunch' })
      expect(launches(f.launchesFile).map((l) => l.version)).toEqual(['1.0.0'])
      expect(fs.readFileSync(f.files.log, 'utf8')).toContain('helper started')
    })

    it('the log names a carried variable but never its value (a proxy can hold a password)', async ({
      expect
    }) => {
      const f = fixture({ mode: 'relaunch' })
      await f.run({ launch: [...fakeLaunch, '--env', 'HTTPS_PROXY=http://u:s3cret@proxy:8080'] })
      expect(await f.result()).toMatchObject({ status: 'ok' })
      const log = fs.readFileSync(f.files.log, 'utf8')
      expect(log).toContain('--env HTTPS_PROXY=...')
      expect(log).not.toContain('s3cret')
    })

    it('relaunch: no health in time is no-health (nothing renamed)', async ({ expect }) => {
      const f = fixture({ mode: 'relaunch', installMode: 'silent' })
      await f.run({ timeouts: { healthSec: 2 } })
      const r = await f.result()
      expect(r.status).toBe('no-health')
      expect(versionOf(f.install)).toBe('1.0.0')
    })

    it('swap: replaces the install, keeps a backup, reports updated', async ({ expect }) => {
      const f = fixture({ mode: 'swap', staged: 'healthy' })
      await f.run()
      const r = await f.result()
      expect(r).toMatchObject({
        status: 'updated',
        mode: 'swap',
        fromVersion: '1.0.0',
        toVersion: '2.0.0'
      })
      expect(versionOf(f.install)).toBe('2.0.0')
      expect(versionOf(f.backup)).toBe('1.0.0')
      expect(fs.existsSync(f.staged)).toBe(false)
      expect(fs.existsSync(f.failed)).toBe(false)
      expect(launches(f.launchesFile).map((l) => l.version)).toEqual(['2.0.0'])
    })

    it('swap: a new build that never reports healthy is rolled back', async ({ expect }) => {
      const f = fixture({ mode: 'swap', staged: 'silent' })
      await f.run({ timeouts: { healthSec: 3 } })
      const r = await f.result()
      expect(r.status).toBe('rolled-back')
      expect(r.reason).toContain('did not report healthy')
      expect(versionOf(f.install)).toBe('1.0.0')
      expect(versionOf(f.failed)).toBe('2.0.0')
      expect(fs.existsSync(f.backup)).toBe(false)
      const l = launches(f.launchesFile)
      expect(l.map((x) => x.version)).toEqual(['2.0.0', '1.0.0'])
      // The unhealthy new build was stopped (by pid); the old one runs.
      await waitFor(() => !alive(l[0].pid), 3000, 'the new build to stop')
      expect(alive(l[1].pid)).toBe(true)
    })

    it('the old process never exits: aborted, nothing touched, nothing launched', async ({
      expect
    }) => {
      const f = fixture({ mode: 'swap', staged: 'healthy' })
      const old = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      started.push(old.pid!)
      await f.run({ pid: old.pid, timeouts: { waitPidSec: 1 } })
      const r = await f.result()
      expect(r).toMatchObject({ status: 'aborted', reason: 'ClaudeUI did not quit' })
      expect(versionOf(f.install)).toBe('1.0.0')
      expect(versionOf(f.staged)).toBe('2.0.0')
      expect(fs.existsSync(f.backup)).toBe(false)
      expect(launches(f.launchesFile)).toEqual([])
      old.kill('SIGKILL')
    })

    it.each([
      ['missing', /staged build is missing/],
      ['no-marker', /staged build carries no ClaudeUI marker/]
    ] as const)('staged %s: failed, install intact and relaunched', async (staged, reason) => {
      const f = fixture({ mode: 'swap', staged })
      await f.run()
      const r = await f.result()
      expect(r.status).toBe('failed')
      expect(r.reason).toMatch(reason)
      expect(versionOf(f.install)).toBe('1.0.0')
      expect(fs.existsSync(f.backup)).toBe(false)
      await waitFor(() => launches(f.launchesFile).length > 0, 3000, 'the relaunch')
      expect(launches(f.launchesFile).map((l) => l.version)).toEqual(['1.0.0'])
    })

    it('the backup path already exists: failed before any rename', async ({ expect }) => {
      const f = fixture({ mode: 'swap', staged: 'healthy' })
      fs.mkdirSync(f.backup)
      fs.writeFileSync(path.join(f.backup, 'mine.txt'), 'user data')
      await f.run()
      const r = await f.result()
      expect(r).toMatchObject({ status: 'failed', reason: 'the backup path already exists' })
      expect(versionOf(f.install)).toBe('1.0.0')
      expect(versionOf(f.staged)).toBe('2.0.0')
      expect(fs.readdirSync(f.backup)).toEqual(['mine.txt'])
      expect(fs.existsSync(`${f.staged}.probe`)).toBe(false)
    })

    it("the user's own instance reports healthy first: updated, not rolled back", async ({
      expect
    }) => {
      const f = fixture({ mode: 'swap', staged: 'silent' })
      await f.run({ timeouts: { healthSec: 6 } })
      // As soon as the swap landed, "the user" starts the new build, which reports
      // healthy without any token; the helper's own launch stays silent.
      await waitFor(
        () => fs.existsSync(f.install) && versionOf(f.install) === '2.0.0',
        5000,
        'the swap'
      )
      fs.mkdirSync(path.join(f.state, 'health'), { recursive: true })
      fs.writeFileSync(
        path.join(f.state, 'health', `${installKeyFor(f.install, 'darwin')}.json`),
        JSON.stringify({ version: '2.0.0', buildId: 'user', pid: 1, at: Date.now() + 1 })
      )
      const r = await f.result()
      expect(r.status).toBe('updated')
      expect(versionOf(f.install)).toBe('2.0.0')
      expect(fs.existsSync(f.failed)).toBe(false)
    })

    it('stopped part-way through a swap: the install is put back and launched', async ({
      expect
    }) => {
      const f = fixture({ mode: 'swap', staged: 'healthy' })
      const old = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      started.push(old.pid!)
      const helper = await f.run({ pid: old.pid, timeouts: { waitPidSec: 30 } })
      await waitFor(() => fs.existsSync(f.files.ready), 3000, 'the ready file')
      // The state a kill between the two renames would leave: the install moved aside.
      fs.renameSync(f.install, f.backup)
      process.kill(helper, 'SIGTERM')
      const r = await f.result()
      expect(r).toMatchObject({
        status: 'failed',
        reason: 'the relaunch helper stopped unexpectedly'
      })
      expect(versionOf(f.install)).toBe('1.0.0')
      expect(fs.existsSync(f.backup)).toBe(false)
      await waitFor(() => launches(f.launchesFile).length > 0, 3000, 'the relaunch')
      old.kill('SIGKILL')
    })

    it('stopped after the swap, before health: interrupted, the new build left in place', async ({
      expect
    }) => {
      const f = fixture({ mode: 'swap', staged: 'silent' })
      const helper = await f.run({ timeouts: { healthSec: 30 } })
      await waitFor(() => launches(f.launchesFile).length > 0, 5000, 'the new build to launch')
      process.kill(helper, 'SIGTERM')
      const r = await f.result()
      expect(r).toMatchObject({ status: 'interrupted', mode: 'swap', toVersion: '2.0.0' })
      expect(versionOf(f.install)).toBe('2.0.0')
      expect(versionOf(f.backup)).toBe('1.0.0')
      // The new build was already running: nothing else was launched.
      expect(launches(f.launchesFile).map((l) => l.version)).toEqual(['2.0.0'])
    }, 20_000)

    it('a stale health record (older than the job) does not count', async ({ expect }) => {
      const f = fixture({ mode: 'relaunch', installMode: 'silent' })
      fs.mkdirSync(path.join(f.state, 'health'), { recursive: true })
      fs.writeFileSync(
        path.join(f.state, 'health', `${installKeyFor(f.install, 'darwin')}.json`),
        JSON.stringify({ version: '1.0.0', buildId: 'old', pid: 1, at: Date.now() - 60_000 })
      )
      await f.run({ timeouts: { healthSec: 2 } })
      expect((await f.result()).status).toBe('no-health')
    })
  })
