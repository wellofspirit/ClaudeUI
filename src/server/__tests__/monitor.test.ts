/**
 * The `claudeui-server` monitor (design review ruling 8): which worker it runs,
 * how it exits, and the restart / update / rollback protocol. Unit-level with fake
 * children and a fake clock; a last block runs real fake-worker processes.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chooseWorker,
  createMonitor,
  workerArgsFrom,
  type ChildLike,
  type MonitorDeps,
  type MonitorLayout,
  type StopSignal
} from '../monitor'
import {
  RESTART_EXIT_CODE,
  readCurrent,
  readPending,
  writeCurrent,
  writePending
} from '../server-layout'
import { installKeyFor, lastResult, writeHealth } from '../server-records'
import { makeServerFolder, makeVersion, tempDir } from './fake-server'

const T1 = 'a'.repeat(32)

let root: string
let stateDir: string
beforeEach(() => {
  root = tempDir()
  stateDir = path.join(tempDir('claudeui-server-state-'), 'relaunch')
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(path.dirname(stateDir), { recursive: true, force: true })
})

function compiledLayout(own = '1.0.0'): MonitorLayout {
  makeServerFolder(root, own)
  return {
    compiled: true,
    root,
    flat: { command: path.join(root, 'claudeui-server'), prefixArgs: [] },
    ownVersion: own,
    ownComparison: own
  }
}

describe('what the monitor runs', () => {
  const logs: string[] = []
  const choose = (layout: MonitorLayout) => chooseWorker(layout, 'darwin', (m) => logs.push(m))

  it('runs the flat install without current', () => {
    expect(choose(compiledLayout())).toMatchObject({ version: null, label: '1.0.0' })
  })

  it('runs a valid current newer than itself', () => {
    const layout = compiledLayout()
    makeVersion(root, '1.1.0')
    writeCurrent(root, '1.1.0', 'darwin')
    expect(choose(layout)).toMatchObject({
      version: '1.1.0',
      command: path.join(root, 'versions', '1.1.0', 'claudeui-server')
    })
    expect(readCurrent(root)).toBe('1.1.0')
  })

  it.each([
    ['older than the monitor (a reinstall over the root)', '0.9.0', true],
    ['the same version as the monitor', '1.0.0', true],
    ['missing its folder', '1.1.0', false],
    ['a bad name', '../1.1.0', false]
  ])('removes a current %s and runs flat', (_what, version, makeDir) => {
    const layout = compiledLayout()
    if (makeDir) makeVersion(root, version)
    fs.writeFileSync(path.join(root, 'current'), version)
    expect(choose(layout).version).toBeNull()
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false)
  })

  it('removes a current whose folder has a bad marker', () => {
    const layout = compiledLayout()
    makeVersion(root, '1.1.0', { markerVersion: '1.2.0' })
    writeCurrent(root, '1.1.0', 'darwin')
    expect(choose(layout).version).toBeNull()
    expect(readCurrent(root)).toBeNull()
  })

  it('runs flat when its own version is unknown', () => {
    const layout = { ...compiledLayout(), ownComparison: null }
    makeVersion(root, '1.1.0')
    writeCurrent(root, '1.1.0', 'darwin')
    expect(choose(layout).version).toBeNull()
  })

  it('from source, always the same source and never touches current', () => {
    writeCurrent(root, '9.0.0', 'darwin')
    const layout: MonitorLayout = {
      compiled: false,
      root,
      flat: { command: '/usr/bin/bun', prefixArgs: ['/repo/src/server/main.ts'] },
      ownVersion: 'dev',
      ownComparison: null
    }
    expect(choose(layout)).toMatchObject({
      version: null,
      command: '/usr/bin/bun',
      prefixArgs: ['/repo/src/server/main.ts']
    })
    expect(readCurrent(root)).toBe('9.0.0')
  })

  it('passes the user flags after an explicit serve', () => {
    expect(workerArgsFrom(['serve', '-p', '8080'])).toEqual(['-p', '8080'])
    expect(workerArgsFrom(['--tls'])).toEqual(['--tls'])
  })
})

class FakeChild extends EventEmitter implements ChildLike {
  readonly signals: Array<NodeJS.Signals | undefined> = []
  readonly stdin = new EventEmitter()
  constructor(readonly pid: number | undefined) {
    super()
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return true
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }
}

interface Spawned {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  child: FakeChild
}

function harness(
  opts: {
    layout?: MonitorLayout
    platform?: string
    workerArgs?: string[]
    /** Spawn indexes whose child gets no pid (a spawn that failed). */
    noPid?: number[]
  } = {}
) {
  const layout = opts.layout ?? compiledLayout()
  const platform = opts.platform ?? 'darwin'
  const spawned: Spawned[] = []
  const exits: number[] = []
  const raised: string[] = []
  const logs: string[] = []
  const handlers = new Map<StopSignal, () => void>()
  let pid = 1000
  let tokens = 0
  const deps: MonitorDeps = {
    layout,
    platform,
    workerArgs: opts.workerArgs ?? ['-p', '8080'],
    env: { PATH: '/bin' },
    stateDir,
    spawn: (command, args, env) => {
      const child = new FakeChild(opts.noPid?.includes(spawned.length) ? undefined : pid++)
      spawned.push({ command, args, env, child })
      return child
    },
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    raise: (signal) => raised.push(signal),
    onSignal: (signal, handler) => {
      handlers.set(signal, handler)
      return () => handlers.delete(signal)
    },
    newToken: () => (++tokens).toString(16).padStart(32, '0'),
    healthPollMs: 100
  }
  const monitor = createMonitor(deps)
  const key = installKeyFor(root, platform)
  return {
    monitor,
    spawned,
    exits,
    raised,
    logs,
    handlers,
    last: (): Spawned => spawned[spawned.length - 1],
    healthy(child: FakeChild, version = 'x'): void {
      writeHealth(
        stateDir,
        key,
        { version, buildId: null, pid: child.pid!, at: Date.now() },
        platform
      )
    },
    result: () => lastResult(stateDir, key),
    signal: (s: StopSignal) => handlers.get(s)?.()
  }
}

describe('the monitor', () => {
  beforeEach(() => vi.useFakeTimers())

  it('starts the worker with serve --worker, the flags and its environment', () => {
    const h = harness()
    h.monitor.start()
    expect(h.spawned).toHaveLength(1)
    expect(h.last()).toMatchObject({
      command: path.join(root, 'claudeui-server'),
      args: ['serve', '--worker', '-p', '8080']
    })
    expect(h.last().env).toMatchObject({
      PATH: '/bin',
      CLAUDEUI_MONITOR: '1',
      CLAUDEUI_MONITOR_ROOT: root
    })
  })

  it('exits with the code of a worker that exits on its own', () => {
    const h = harness()
    h.monitor.start()
    h.last().child.exit(0)
    expect(h.exits).toEqual([0])
    const h2 = harness()
    h2.monitor.start()
    h2.last().child.exit(3)
    expect(h2.exits).toEqual([3])
    expect(h2.spawned).toHaveLength(1)
  })

  it("re-raises a worker's fatal signal on itself, handlers removed", () => {
    const h = harness()
    h.monitor.start()
    expect(h.handlers.size).toBe(2)
    h.last().child.exit(null, 'SIGSEGV')
    expect(h.raised).toEqual(['SIGSEGV'])
    expect(h.handlers.size).toBe(0)
    expect(h.exits).toEqual([])
  })

  it('restarts the same worker on 75 without pending; ok once healthy', async () => {
    const h = harness()
    h.monitor.start()
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[1].command).toBe(h.spawned[0].command)
    h.healthy(h.last().child, '1.0.0')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.result()).toMatchObject({ status: 'ok', mode: 'relaunch', toVersion: '1.0.0' })
    expect(h.exits).toEqual([])
  })

  it('records no-health for a restart that never reports, and keeps it running', async () => {
    const h = harness()
    h.monitor.start()
    h.last().child.exit(RESTART_EXIT_CODE)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.result()).toMatchObject({ status: 'no-health', mode: 'relaunch' })
    expect(h.last().child.signals).toEqual([])
  })

  it('updates from the flat install: current, health, updated, pending gone, old versions swept', async () => {
    const h = harness()
    makeVersion(root, '0.9.0')
    makeVersion(root, '1.1.0')
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(readCurrent(root)).toBe('1.1.0')
    expect(h.last().command).toBe(path.join(root, 'versions', '1.1.0', 'claudeui-server'))
    h.healthy(h.last().child, '1.1.0')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.result()).toMatchObject({
      token: T1,
      status: 'updated',
      mode: 'swap',
      fromVersion: '1.0.0',
      toVersion: '1.1.0'
    })
    expect(readPending(root)).toBeNull()
    expect(fs.readdirSync(path.join(root, 'versions'))).toEqual(['1.1.0'])
    expect(fs.existsSync(path.join(root, 'claudeui-server'))).toBe(true)
  })

  it('updates from a versioned worker and keeps the previous version', async () => {
    const h = harness()
    for (const v of ['1.1.0', '1.2.0', '1.3.0']) makeVersion(root, v)
    writeCurrent(root, '1.2.0', 'darwin')
    h.monitor.start()
    expect(h.last().command).toContain(path.join('versions', '1.2.0'))
    writePending(root, { token: T1, from: '1.2.0', to: '1.3.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    h.healthy(h.last().child, '1.3.0')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.result()).toMatchObject({
      status: 'updated',
      fromVersion: '1.2.0',
      toVersion: '1.3.0'
    })
    expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.2.0', '1.3.0'])
  })

  it('ignores a health record of another pid', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    const old = h.last().child
    old.exit(RESTART_EXIT_CODE)
    h.healthy(old, '1.0.0')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.result()).toBeNull()
  })

  it('rolls back to the flat install when the update is not healthy within 90 s', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    const bad = h.last().child
    await vi.advanceTimersByTimeAsync(89_900)
    expect(bad.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(bad.signals).toEqual(['SIGTERM'])
    bad.exit(0)
    expect(readCurrent(root)).toBeNull()
    expect(readPending(root)).toBeNull()
    expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
    expect(h.spawned).toHaveLength(3)
    expect(h.result()).toMatchObject({
      status: 'rolled-back',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: expect.stringMatching(/did not report healthy within 90 s/)
    })
    // The staged folder stays (the user may retry); nothing was swept.
    expect(fs.existsSync(path.join(root, 'versions', '1.1.0'))).toBe(true)
  })

  it('rolls back to the previous version when the update is not healthy within 90 s', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    makeVersion(root, '1.2.0')
    writeCurrent(root, '1.1.0', 'darwin')
    h.monitor.start()
    writePending(root, { token: T1, from: '1.1.0', to: '1.2.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(readCurrent(root)).toBe('1.2.0')
    await vi.advanceTimersByTimeAsync(90_000)
    h.last().child.exit(0)
    expect(readCurrent(root)).toBe('1.1.0')
    expect(h.last().command).toContain(path.join('versions', '1.1.0'))
    expect(h.result()).toMatchObject({
      status: 'rolled-back',
      fromVersion: '1.1.0',
      toVersion: '1.2.0'
    })
    expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.1.0', '1.2.0'])
  })

  it('kills a worker that ignores SIGTERM during a rollback, and goes on', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    const bad = h.last().child
    await vi.advanceTimersByTimeAsync(90_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bad.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.spawned).toHaveLength(3)
    expect(h.result()?.status).toBe('rolled-back')
  })

  it('rolls back to the previous version when the update crashes in its window', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    makeVersion(root, '1.2.0')
    writeCurrent(root, '1.1.0', 'darwin')
    h.monitor.start()
    writePending(root, { token: T1, from: '1.1.0', to: '1.2.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    h.last().child.exit(1)
    expect(readCurrent(root)).toBe('1.1.0')
    expect(h.last().command).toContain(path.join('versions', '1.1.0'))
    expect(h.result()).toMatchObject({
      status: 'rolled-back',
      reason: expect.stringMatching(/exited with code 1 before it reported healthy/)
    })
    expect(h.exits).toEqual([])
  })

  it('refuses a pending update whose folder is not valid, and restarts the same worker', () => {
    const h = harness()
    makeVersion(root, '1.1.0', { exe: false })
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(readCurrent(root)).toBeNull()
    expect(readPending(root)).toBeNull()
    expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
    expect(h.result()).toMatchObject({ token: T1, status: 'failed' })
  })

  it('never restarts after a stop signal, even on 75', () => {
    const h = harness()
    h.monitor.start()
    h.signal('SIGTERM')
    expect(h.last().child.signals).toEqual(['SIGTERM'])
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(h.spawned).toHaveLength(1)
    expect(h.exits).toEqual([RESTART_EXIT_CODE])
  })

  it('a stop during an update window leaves current and pending for the next start', async () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    h.monitor.start()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.last().child.exit(RESTART_EXIT_CODE)
    h.signal('SIGINT')
    h.last().child.exit(0)
    expect(h.exits).toEqual([0])
    expect(readCurrent(root)).toBe('1.1.0')

    // The next start reopens the window and finishes the update.
    const next = harness({ layout: compiledLayout() })
    next.monitor.start()
    expect(next.last().command).toContain(path.join('versions', '1.1.0'))
    next.healthy(next.last().child, '1.1.0')
    await vi.advanceTimersByTimeAsync(100)
    expect(next.result()).toMatchObject({ token: T1, status: 'updated' })
    expect(readPending(root)).toBeNull()
  })

  it('a reopened window that fails rolls back to the flat install', async () => {
    compiledLayout()
    makeVersion(root, '1.1.0')
    writeCurrent(root, '1.1.0', 'darwin')
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    const h = harness({ layout: compiledLayout() })
    h.monitor.start()
    h.last().child.exit(1)
    expect(readCurrent(root)).toBeNull()
    expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
  })

  it('removes a pending update an earlier run left behind that no longer applies', () => {
    const h = harness()
    writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
    h.monitor.start()
    expect(readPending(root)).toBeNull()
    expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
  })

  it('gives up after more than 3 restarts within 60 s', () => {
    const h = harness()
    h.monitor.start()
    for (let i = 0; i < 3; i++) h.last().child.exit(RESTART_EXIT_CODE)
    expect(h.spawned).toHaveLength(4)
    h.last().child.exit(RESTART_EXIT_CODE)
    expect(h.spawned).toHaveLength(4)
    expect(h.exits).toEqual([1])
    expect(h.logs.some((l) => /4 restarts within 60 s/.test(l))).toBe(true)
  })

  it('does not count restarts whose worker came up healthy', async () => {
    const h = harness()
    h.monitor.start()
    for (let i = 0; i < 6; i++) {
      h.last().child.exit(RESTART_EXIT_CODE)
      h.healthy(h.last().child, '1.0.0')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(h.exits).toEqual([])
    expect(h.spawned).toHaveLength(7)
    // Unhealthy ones still count from there.
    for (let i = 0; i < 4; i++) h.last().child.exit(RESTART_EXIT_CODE)
    expect(h.exits).toEqual([1])
  })

  it('allows restarts spread over more than 60 s', async () => {
    const h = harness()
    h.monitor.start()
    for (let i = 0; i < 6; i++) {
      h.last().child.exit(RESTART_EXIT_CODE)
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(h.exits).toEqual([])
    expect(h.spawned).toHaveLength(7)
  })

  it('falls back to the flat install when a staged version cannot be started', () => {
    const h = harness()
    makeVersion(root, '1.1.0')
    writeCurrent(root, '1.1.0', 'darwin')
    h.monitor.start()
    const child = h.last().child as FakeChild & { pid: number | undefined }
    Object.defineProperty(child, 'pid', { value: undefined })
    child.emit('error', new Error('spawn EACCES'))
    expect(readCurrent(root)).toBeNull()
    expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
  })

  describe('--disable-auth', () => {
    const args = ['--port', '8080', '--bind', '0.0.0.0', '--tls', '--disable-auth']

    it('reaches the first worker only; the other flags reach every worker', async () => {
      const h = harness({ workerArgs: args })
      makeVersion(root, '1.1.0')
      h.monitor.start()
      expect(h.spawned[0].args).toEqual(['serve', '--worker', ...args])
      h.last().child.exit(RESTART_EXIT_CODE)
      const later = ['serve', '--worker', '--port', '8080', '--bind', '0.0.0.0', '--tls']
      expect(h.spawned[1].args).toEqual(later)
      // An update, then its rollback.
      writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
      h.last().child.exit(RESTART_EXIT_CODE)
      expect(h.spawned[2].args).toEqual(later)
      await vi.advanceTimersByTimeAsync(10)
      h.last().child.exit(1)
      expect(h.spawned[3].args).toEqual(later)
      expect(h.result()?.status).toBe('rolled-back')
    })

    it('still reaches the worker that starts after one that could not be started', () => {
      const h = harness({ workerArgs: args, noPid: [0] })
      makeVersion(root, '1.1.0')
      writeCurrent(root, '1.1.0', 'darwin')
      h.monitor.start()
      h.last().child.emit('error', new Error('spawn EACCES'))
      expect(h.spawned).toHaveLength(2)
      expect(h.spawned[1].args).toContain('--disable-auth')
    })
  })

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  describe.skipIf(process.platform === 'win32' || asRoot)(
    'a rollback that cannot restore current',
    () => {
      it('keeps pending, never re-applies it in this run, and restores current later', () => {
        const h = harness()
        makeVersion(root, '1.1.0')
        h.monitor.start()
        writePending(root, { token: T1, from: null, to: '1.1.0' }, 'darwin')
        h.last().child.exit(RESTART_EXIT_CODE)
        expect(readCurrent(root)).toBe('1.1.0')
        fs.chmodSync(root, 0o555)
        try {
          h.last().child.exit(1)
          // Rolled back to the flat worker, but `current` and `pending` stay.
          expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
          expect(readCurrent(root)).toBe('1.1.0')
          expect(readPending(root)).toMatchObject({ token: T1 })
          expect(h.result()).toMatchObject({
            status: 'rolled-back',
            reason: expect.stringMatching(/current could not be restored/)
          })
          // A relaunch in the same run restarts the flat worker; the update is not re-applied.
          h.last().child.exit(RESTART_EXIT_CODE)
          expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
          expect(readCurrent(root)).toBe('1.1.0')
        } finally {
          fs.chmodSync(root, 0o755)
        }
        // Once the file can be removed, the next restart restores current and drops pending.
        h.last().child.exit(RESTART_EXIT_CODE)
        expect(h.last().command).toBe(path.join(root, 'claudeui-server'))
        expect(readCurrent(root)).toBeNull()
        expect(readPending(root)).toBeNull()
      })

      it('a versioned from that cannot be written back is retried by the next start', () => {
        const h = harness()
        makeVersion(root, '1.1.0')
        makeVersion(root, '1.2.0')
        writeCurrent(root, '1.1.0', 'darwin')
        h.monitor.start()
        writePending(root, { token: T1, from: '1.1.0', to: '1.2.0' }, 'darwin')
        h.last().child.exit(RESTART_EXIT_CODE)
        fs.chmodSync(root, 0o555)
        try {
          h.last().child.exit(1)
          expect(h.last().command).toContain(path.join('versions', '1.1.0'))
          expect(readCurrent(root)).toBe('1.2.0')
          expect(readPending(root)).toMatchObject({ token: T1, from: '1.1.0' })
        } finally {
          fs.chmodSync(root, 0o755)
        }
        // A new run (after a reboot) reopens the window on 1.2.0 and rolls back again.
        const next = harness({ layout: compiledLayout() })
        next.monitor.start()
        expect(next.last().command).toContain(path.join('versions', '1.2.0'))
        next.last().child.exit(1)
        expect(readCurrent(root)).toBe('1.1.0')
        expect(readPending(root)).toBeNull()
        expect(next.last().command).toContain(path.join('versions', '1.1.0'))
      })
    }
  )

  describe('on POSIX', () => {
    it('forwards each stop signal to the worker and exits with its code', () => {
      const h = harness()
      h.monitor.start()
      h.signal('SIGINT')
      h.signal('SIGINT')
      expect(h.last().child.signals).toEqual(['SIGINT', 'SIGINT'])
      h.last().child.exit(0)
      expect(h.exits).toEqual([0])
    })
  })

  describe('on Windows', () => {
    it('does not forward the signal; ends the worker by pid after 8 s', async () => {
      const h = harness({ platform: 'win32' })
      h.monitor.start()
      h.signal('SIGINT')
      expect(h.last().child.signals).toEqual([])
      await vi.advanceTimersByTimeAsync(7_999)
      expect(h.last().child.signals).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(h.last().child.signals).toEqual([undefined])
      h.last().child.exit(1)
      expect(h.exits).toEqual([1])
    })

    it('exits with the code of a worker that stopped on its own console event', async () => {
      const h = harness({ platform: 'win32' })
      h.monitor.start()
      h.signal('SIGTERM')
      h.last().child.exit(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.last().child.signals).toEqual([])
      expect(h.exits).toEqual([0])
    })

    it('ends a failed update by pid at once for the rollback', async () => {
      const h = harness({ platform: 'win32' })
      makeVersion(root, '1.1.0', { exeName: 'claudeui-server.exe' })
      h.monitor.start()
      writePending(root, { token: T1, from: null, to: '1.1.0' }, 'win32')
      h.last().child.exit(RESTART_EXIT_CODE)
      expect(h.last().command).toBe(path.join(root, 'versions', '1.1.0', 'claudeui-server.exe'))
      await vi.advanceTimersByTimeAsync(90_000)
      expect(h.last().child.signals).toEqual([undefined])
      h.last().child.exit(1)
      expect(h.result()?.status).toBe('rolled-back')
    })
  })
})

// ── Real processes ────────────────────────────────────────────────────────────

/**
 * A fake worker: records how it was started, then does what `FAKE_PLAN/<label>`
 * says. `exit:<n>`; `update:<v>` (write pending, exit 75); `healthy` (write the
 * health record, then exit 0 on SIGTERM); `stdin` (exit 0 when stdin ends).
 */
const FAKE_WORKER = `
const fs = require('node:fs')
const path = require('node:path')
const label = process.env.FAKE_LABEL || 'flat'
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  label, pid: process.pid, args: process.argv.slice(2),
  monitor: process.env.CLAUDEUI_MONITOR, root: process.env.CLAUDEUI_MONITOR_ROOT
}) + '\\n')
const plan = fs.readFileSync(path.join(process.env.FAKE_PLAN, label), 'utf8').trim()
const keepAlive = setInterval(() => {}, 1000)
if (plan.startsWith('exit:')) process.exit(Number(plan.slice(5)))
if (plan.startsWith('update:')) {
  const pending = { token: '${T1}', from: null, to: plan.slice(7) }
  fs.writeFileSync(path.join(process.env.CLAUDEUI_MONITOR_ROOT, 'pending'), JSON.stringify(pending))
  process.exit(${RESTART_EXIT_CODE})
}
if (plan === 'healthy') {
  fs.mkdirSync(path.dirname(process.env.FAKE_HEALTH), { recursive: true })
  fs.writeFileSync(process.env.FAKE_HEALTH, JSON.stringify({ version: label, buildId: null, pid: process.pid, at: Date.now() }))
  process.on('SIGTERM', () => process.exit(0))
}
if (plan === 'stdin') {
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}
void keepAlive
`

describe.skipIf(process.platform === 'win32')('the monitor with real worker processes', () => {
  let scripts: string
  let plan: string
  let workerLog: string

  beforeEach(() => {
    scripts = tempDir('claudeui-server-fake-')
    plan = path.join(scripts, 'plan')
    fs.mkdirSync(plan)
    workerLog = path.join(scripts, 'workers.log')
    fs.writeFileSync(path.join(scripts, 'worker.cjs'), FAKE_WORKER)
  })
  afterEach(() => {
    fs.rmSync(scripts, { recursive: true, force: true })
  })

  function run(layout: MonitorLayout) {
    const children: ChildLike[] = []
    const handlers = new Map<StopSignal, () => void>()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((r) => (resolveExit = r))
    const monitor = createMonitor({
      layout,
      platform: process.platform,
      workerArgs: ['--port', '0'],
      env: {
        ...process.env,
        FAKE_LOG: workerLog,
        FAKE_PLAN: plan,
        FAKE_HEALTH: path.join(stateDir, 'health', `${installKeyFor(root, process.platform)}.json`)
      },
      stateDir,
      spawn: (command, args, env) => {
        const child = nodeSpawn(command, args, { env, stdio: ['pipe', 'inherit', 'inherit'] })
        children.push(child)
        return child
      },
      log: () => undefined,
      exit: (code) => resolveExit(code),
      raise: (signal) => resolveExit(-1 * (signal === 'SIGTERM' ? 15 : 1)),
      onSignal: (signal, handler) => {
        handlers.set(signal, handler)
        return () => handlers.delete(signal)
      },
      healthPollMs: 50,
      healthWindowMs: 10_000
    })
    monitor.start()
    return { children, handlers, exited }
  }

  const workers = (): Array<{ label: string; args: string[]; monitor: string; root: string }> =>
    fs
      .readFileSync(workerLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))

  const flatLayout = (): MonitorLayout => {
    makeServerFolder(root, '1.0.0')
    return {
      compiled: true,
      root,
      flat: { command: process.execPath, prefixArgs: [path.join(scripts, 'worker.cjs')] },
      ownVersion: '1.0.0',
      ownComparison: '1.0.0'
    }
  }

  it('passes serve --worker and its environment, and exits with the worker', async () => {
    fs.writeFileSync(path.join(plan, 'flat'), 'exit:0')
    const { exited } = run(flatLayout())
    expect(await exited).toBe(0)
    expect(workers()).toEqual([
      {
        label: 'flat',
        pid: expect.any(Number),
        args: ['serve', '--worker', '--port', '0'],
        monitor: '1',
        root
      }
    ])
  })

  it("ties the worker's life to its stdin pipe", async () => {
    fs.writeFileSync(path.join(plan, 'flat'), 'stdin')
    const { children, exited } = run(flatLayout())
    await vi.waitFor(() => expect(fs.existsSync(workerLog)).toBe(true))
    ;(children[0] as unknown as { stdin: NodeJS.WritableStream }).stdin.end()
    expect(await exited).toBe(0)
  })

  it('updates to a staged version, then stops it on SIGTERM', async () => {
    const layout = flatLayout()
    makeVersion(root, '1.1.0', {
      exeText: `#!/bin/sh\nFAKE_LABEL=1.1.0 exec "${process.execPath}" "${path.join(scripts, 'worker.cjs')}" "$@"\n`
    })
    fs.writeFileSync(path.join(plan, 'flat'), 'update:1.1.0')
    fs.writeFileSync(path.join(plan, '1.1.0'), 'healthy')
    const { handlers, exited } = run(layout)
    await vi.waitFor(
      () =>
        expect(lastResult(stateDir, installKeyFor(root, process.platform))?.status).toBe('updated'),
      { timeout: 4000 }
    )
    expect(readCurrent(root)).toBe('1.1.0')
    expect(readPending(root)).toBeNull()
    handlers.get('SIGTERM')?.()
    expect(await exited).toBe(0)
    expect(workers().map((w) => w.label)).toEqual(['flat', '1.1.0'])
  })
})
