/**
 * The worker's side of the monitor protocol: who counts as supervised, the
 * restart (exit code 75), the relaunch and update seams, update eligibility with
 * its container detection, and the health record.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  MONITOR_PROTOCOL,
  RESTART_EXIT_CODE,
  SUPPORTED_MONITOR_PROTOCOLS,
  readPending,
  writePending
} from '../server-layout'
import { installKeyFor, readHealth, writeResult } from '../server-records'
import {
  NO_MONITOR_REASON,
  UNSUPERVISED_REASON,
  FIREWALL_NOTICE,
  clearMonitorEnv,
  containerSign,
  createRestarter,
  createServerAppUpdateHost,
  createServerHostRelaunch,
  reportWorkerHealthy,
  serverUpdateEligibility,
  serverUpdateTarget,
  supervisionOf,
  tieToMonitor,
  type ContainerProbes,
  type Supervision
} from '../worker-host'
import { makeServerFolder, makeVersion, tempDir } from './fake-server'

let root: string
beforeEach(() => {
  root = tempDir()
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

const supervised = (): Supervision => ({ supervised: true, root })
const monitorEnv = (): NodeJS.ProcessEnv => ({
  CLAUDEUI_MONITOR: '1',
  CLAUDEUI_MONITOR_ROOT: root
})
const noContainer: ContainerProbes = { exists: () => false, readFile: () => null, env: {} }

describe('supervision', () => {
  it('is a --worker started with the monitor protocol and an absolute root', () => {
    expect(supervisionOf({ worker: true }, monitorEnv(), '/x')).toEqual({ supervised: true, root })
  })

  it('is never --no-monitor, whatever the environment says', () => {
    expect(supervisionOf({ worker: true, noMonitor: true }, monitorEnv(), '/x')).toEqual({
      supervised: false,
      reason: NO_MONITOR_REASON,
      root: '/x'
    })
  })

  it.each([
    ['no --worker', {}, monitorEnv()],
    ['no environment', { worker: true }, {}],
    ['another protocol', { worker: true }, { ...monitorEnv(), CLAUDEUI_MONITOR: '2' }],
    ['a relative root', { worker: true }, { ...monitorEnv(), CLAUDEUI_MONITOR_ROOT: 'rel' }]
  ])('is not supervised with %s', (_what, options, env) => {
    expect(supervisionOf(options, env, '/x')).toMatchObject({
      supervised: false,
      reason: UNSUPERVISED_REASON
    })
  })

  it('accepts every protocol this build supports, including its own', () => {
    expect(SUPPORTED_MONITOR_PROTOCOLS).toContain(MONITOR_PROTOCOL)
    for (const protocol of SUPPORTED_MONITOR_PROTOCOLS)
      expect(
        supervisionOf({ worker: true }, { ...monitorEnv(), CLAUDEUI_MONITOR: protocol }, '/x')
          .supervised
      ).toBe(true)
  })

  it("clears the monitor's variables so children do not inherit them", () => {
    const env = { ...monitorEnv(), PATH: '/bin' }
    clearMonitorEnv(env)
    expect(env).toEqual({ PATH: '/bin' })
  })
})

describe('the lifetime tie', () => {
  const stdin = () => Object.assign(new EventEmitter(), { resume: vi.fn() })

  it('exits at once when the monitor goes while the worker still boots', () => {
    const s = stdin()
    const exit = vi.fn()
    tieToMonitor(s, exit)
    expect(s.resume).toHaveBeenCalled()
    s.emit('end')
    s.emit('close')
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('runs the graceful shutdown once it has been handed over', () => {
    const s = stdin()
    const exit = vi.fn()
    const shutdown = vi.fn()
    tieToMonitor(s, exit).onGone(shutdown)
    s.emit('close')
    s.emit('end')
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('the restarter', () => {
  beforeEach(() => vi.useFakeTimers())

  it('refuses without a monitor, and until the shutdown exists', () => {
    expect(createRestarter({ supervised: false, reason: NO_MONITOR_REASON, root }).refusal()).toBe(
      NO_MONITOR_REASON
    )
    const r = createRestarter(supervised())
    expect(r.refusal()).toMatch(/still starting/)
    expect(() => r.restart('x')).toThrow(/still starting/)
  })

  it('shuts down with exit code 75 a moment later, once', async () => {
    const shutdown = vi.fn()
    const r = createRestarter(supervised())
    r.attach(shutdown)
    expect(r.refusal()).toBeNull()
    r.restart('relaunch requested')
    expect(shutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(shutdown).toHaveBeenCalledWith('relaunch requested', RESTART_EXIT_CODE)
    expect(() => r.restart('again')).toThrow(/already stopping/)
  })

  it('refuses a restart once a stop signal began the shutdown', () => {
    const shutdown = vi.fn()
    const r = createRestarter(supervised())
    const forSignals = r.attach(shutdown)
    forSignals('SIGTERM')
    expect(shutdown).toHaveBeenCalledWith('SIGTERM', undefined)
    expect(r.refusal()).toMatch(/already stopping/)
  })
})

describe('the relaunch seam', () => {
  it('is available only when the restarter is, and relaunch restarts', async () => {
    vi.useFakeTimers()
    const shutdown = vi.fn()
    const restarter = createRestarter(supervised())
    const host = createServerHostRelaunch({ restarter, stateDir: root, installKey: 'k' })
    expect(host.availability()).toMatchObject({ available: false })
    restarter.attach(shutdown)
    expect(host.availability()).toEqual({ available: true })
    await host.relaunch()
    await vi.advanceTimersByTimeAsync(250)
    expect(shutdown).toHaveBeenCalledWith('relaunch requested', RESTART_EXIT_CODE)
  })

  it("says why without a monitor, and still reads this install's last result", () => {
    const restarter = createRestarter({ supervised: false, reason: NO_MONITOR_REASON, root })
    const state = path.join(root, 'state')
    writeResult(
      state,
      'k',
      {
        token: 'a'.repeat(32),
        status: 'updated',
        mode: 'swap',
        fromVersion: '1',
        toVersion: '2',
        at: 1
      },
      process.platform
    )
    const host = createServerHostRelaunch({ restarter, stateDir: state, installKey: 'k' })
    expect(host.availability()).toEqual({ available: false, reason: NO_MONITOR_REASON })
    expect(host.lastResult()?.status).toBe('updated')
  })
})

describe('update eligibility', () => {
  const eligible = (over: Partial<Parameters<typeof serverUpdateEligibility>[0]> = {}) =>
    serverUpdateEligibility({
      supervision: supervised(),
      platform: 'linux',
      container: noContainer,
      canWrite: () => true,
      ...over
    })

  beforeEach(() => {
    makeServerFolder(root, '1.0.0')
  })

  it('is ok for a supervised, writable, marked install', () => {
    expect(eligible()).toEqual({ ok: true })
  })

  it('is ok on Windows and macOS with the firewall notice, and on Linux without one', () => {
    expect(eligible({ platform: 'win32' })).toEqual({ ok: true, notice: FIREWALL_NOTICE })
    expect(eligible({ platform: 'darwin' })).toEqual({ ok: true, notice: FIREWALL_NOTICE })
    expect(eligible({ platform: 'linux' })).toEqual({ ok: true })
    expect(FIREWALL_NOTICE).toMatch(/macOS and Windows firewalls/)
  })

  it('refuses without a monitor, or with --no-monitor', () => {
    expect(
      eligible({ supervision: { supervised: false, reason: NO_MONITOR_REASON, root } })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('--no-monitor') })
    expect(
      eligible({ supervision: { supervised: false, reason: UNSUPERVISED_REASON, root } })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('not supervised') })
  })

  it('refuses in a container', () => {
    expect(
      eligible({ container: { ...noContainer, exists: (f) => f === '/.dockerenv' } })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/container/) })
  })

  it('refuses a folder it cannot write, root or versions/', () => {
    expect(eligible({ canWrite: () => false })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/server folder is not writable/)
    })
    fs.mkdirSync(path.join(root, 'versions'))
    expect(eligible({ canWrite: (dir) => dir === root })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/versions folder is not writable/)
    })
  })

  it.skipIf(process.platform === 'win32')('refuses a linked versions/', () => {
    const other = tempDir()
    fs.symlinkSync(other, path.join(root, 'versions'))
    expect(eligible()).toMatchObject({ ok: false, reason: expect.stringMatching(/real directory/) })
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('refuses an install that predates the marker', () => {
    fs.rmSync(path.join(root, 'claudeui-install.json'))
    expect(eligible()).toMatchObject({ ok: false, reason: expect.stringMatching(/reinstall/) })
  })

  it('names no local path in a reason', () => {
    for (const result of [eligible({ canWrite: () => false }), eligible({ platform: 'win32' })]) {
      expect(JSON.stringify(result)).not.toContain(root)
    }
  })
})

describe('container detection', () => {
  const probes = (over: Partial<ContainerProbes>): ContainerProbes => ({ ...noContainer, ...over })

  it('finds each sign', () => {
    expect(containerSign(probes({ exists: (f) => f === '/.dockerenv' }))).toBe('/.dockerenv')
    expect(containerSign(probes({ exists: (f) => f === '/run/.containerenv' }))).toBe(
      '/run/.containerenv'
    )
    expect(containerSign(probes({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } }))).toBe(
      'KUBERNETES_SERVICE_HOST'
    )
    for (const cgroup of [
      '12:pids:/docker/0123abcd\n',
      '11:memory:/kubepods/burstable/pod1\n',
      '0::/system.slice/containerd.service\n'
    ])
      expect(containerSign(probes({ readFile: () => cgroup }))).toBe('/proc/1/cgroup')
  })

  it('finds none on a plain host, nor from a cgroup v2 root alone', () => {
    expect(containerSign(noContainer)).toBeNull()
    expect(containerSign(probes({ readFile: () => '0::/\n' }))).toBeNull()
    expect(containerSign(probes({ readFile: () => '0::/user.slice/session-1.scope\n' }))).toBeNull()
  })
})

describe('the update seam', () => {
  const T = 'c'.repeat(32)
  function host(execPath: string, attach = true) {
    const shutdown = vi.fn()
    const restarter = createRestarter(supervised())
    if (attach) restarter.attach(shutdown)
    const seam = createServerAppUpdateHost({
      supervision: supervised(),
      restarter,
      platform: 'darwin',
      arch: 'arm64',
      execPath,
      buildInfo: () => ({ kind: 'dev' }),
      home: path.join(root, 'home'),
      container: noContainer,
      canWrite: () => true,
      newToken: () => T,
      log: () => undefined
    })
    return { seam, shutdown }
  }

  it('maps each published platform to its server target', () => {
    expect(serverUpdateTarget('darwin', 'arm64')).toBe('server-darwin-arm64')
    expect(serverUpdateTarget('win32', 'x64')).toBe('server-win32-x64')
    expect(serverUpdateTarget('linux', 'x64')).toBe('server-linux-x64')
    expect(serverUpdateTarget('linux', 'arm64')).toBe('server-linux-arm64')
    expect(serverUpdateTarget('darwin', 'x64')).toBeNull()
    expect(serverUpdateTarget('freebsd', 'x64')).toBeNull()
    expect(host(path.join(root, 'claudeui-server')).seam.target()).toBe('server-darwin-arm64')
  })

  it('downloads under ~/.claude/ui/updates/server', () => {
    expect(host(path.join(root, 'claudeui-server')).seam.downloadsDir()).toBe(
      path.join(root, 'home', '.claude', 'ui', 'updates', 'server')
    )
  })

  it('knows what is staged', async () => {
    const { seam } = host(path.join(root, 'claudeui-server'))
    makeVersion(root, '1.1.0')
    expect(await seam.isStaged('1.1.0', '1.1.0')).toBe(true)
    expect(await seam.isStaged('1.1.0', '1.2.0')).toBe(false)
    expect(await seam.isStaged('1.2.0', '1.2.0')).toBe(false)
  })

  it('applies from the flat install: pending with from null, then the restart', async () => {
    vi.useFakeTimers()
    const { seam, shutdown } = host(path.join(root, 'claudeui-server'))
    makeVersion(root, '1.1.0')
    await seam.apply('1.1.0', '1.1.0')
    expect(readPending(root)).toEqual({ token: T, from: null, to: '1.1.0' })
    await vi.advanceTimersByTimeAsync(250)
    expect(shutdown).toHaveBeenCalledWith('update to 1.1.0 requested', RESTART_EXIT_CODE)
  })

  it('applies from a versions/ worker with that version as from', async () => {
    const { seam } = host(path.join(root, 'versions', '1.1.0', 'claudeui-server'))
    makeVersion(root, '1.1.0')
    makeVersion(root, '1.2.0')
    await seam.apply('1.2.0', '1.2.0')
    expect(readPending(root)).toMatchObject({ from: '1.1.0', to: '1.2.0' })
  })

  it('refuses an apply that cannot restart, or of something no longer staged, writing nothing', async () => {
    makeVersion(root, '1.1.0')
    await expect(
      host(path.join(root, 'claudeui-server'), false).seam.apply('1.1.0', '1.1.0')
    ).rejects.toThrow(/still starting/)
    expect(readPending(root)).toBeNull()
    await expect(
      host(path.join(root, 'claudeui-server')).seam.apply('1.3.0', '1.3.0')
    ).rejects.toThrow(/no longer staged/)
    expect(readPending(root)).toBeNull()
  })

  it('overwrites a stale pending request', async () => {
    const { seam } = host(path.join(root, 'claudeui-server'))
    makeVersion(root, '1.1.0')
    writePending(root, { token: 'd'.repeat(32), from: null, to: '1.0.5' }, 'darwin')
    await seam.apply('1.1.0', '1.1.0')
    expect(readPending(root)).toMatchObject({ token: T, to: '1.1.0' })
  })
})

describe('the health record', () => {
  const args = (supervision: Supervision) => ({
    supervision,
    stateDir: path.join(root, 'state'),
    platform: process.platform,
    version: '1.1.0',
    buildId: 'abc@t',
    pid: 4242,
    now: 99,
    log: () => undefined
  })

  it('is written under the root key when supervised', () => {
    reportWorkerHealthy(args(supervised()))
    expect(readHealth(path.join(root, 'state'), installKeyFor(root, process.platform))).toEqual({
      version: '1.1.0',
      buildId: 'abc@t',
      pid: 4242,
      at: 99
    })
  })

  it('is not written without a monitor', () => {
    reportWorkerHealthy(args({ supervised: false, reason: NO_MONITOR_REASON, root }))
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false)
  })
})
