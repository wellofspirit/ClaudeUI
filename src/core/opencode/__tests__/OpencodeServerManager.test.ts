import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  OpencodeServerManager,
  OpencodePermissionGuardError,
  SERVER_STARTED_HOOK_TIMEOUT_MS,
  CLEANUP_RETRY_DELAYS_MS,
  OpencodeCredentialCleanupError,
  locatePluginDir
} from '../OpencodeServerManager'
import type {
  HostedToolsReadiness,
  OpencodeServerManagerOptions,
  ServerConnection,
  SpawnResult,
  SpawnServerFn,
  WaitGuardFn,
  WaitReadyFn
} from '../OpencodeServerManager'
import { waitForPermissionGuard } from '../opencode-server-readiness'
import type { McpHttpHost } from '../mcp-http-host'
import type { OpencodeConfigInput } from '../opencode-server-config'
import { logger } from '../../services/logger'

// ── Fakes ─────────────────────────────────────────────────────────────────────
//
// A fake ChildProcess (EventEmitter) whose kill() flips a flag and emits 'exit'
// so the manager's unexpected-death cleanup runs exactly as it would in prod.
// The manager ends servers through the injected `endServerFn`, which kills.

interface FakeChild extends ChildProcess {
  killed: boolean
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild
  ;(emitter as { killed: boolean }).killed = false
  emitter.kill = ((_signal?: NodeJS.Signals | number) => {
    ;(emitter as { killed: boolean }).killed = true
    emitter.emit('exit', null, 'SIGTERM')
    return true
  }) as ChildProcess['kill']
  return emitter
}

interface FakeMcpHost extends McpHttpHost {
  closed: boolean
  createServer: () => McpServer
}

interface SpawnCall {
  cwd: string
  password: string
  configContent: string
  child: FakeChild
}

/** Records spawns; `delayMs` widens the window so concurrent acquires overlap. */
function makeSpawnFn(delayMs = 0): { spawnFn: SpawnServerFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  let port = 40000
  const spawnFn: SpawnServerFn = async (_launch, options) => {
    const child = makeFakeChild()
    calls.push({ ...options, child })
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const result: SpawnResult = { process: child, baseUrl: `http://127.0.0.1:${port++}` }
    return result
  }
  return { spawnFn, calls }
}

let fakeHostPort = 20000
function makeMcpHostFn(): {
  startMcpHostFn: (createServer: () => McpServer) => Promise<McpHttpHost>
  hosts: FakeMcpHost[]
} {
  const hosts: FakeMcpHost[] = []
  const startMcpHostFn = async (createServer: () => McpServer): Promise<McpHttpHost> => {
    const host: FakeMcpHost = {
      port: fakeHostPort++,
      token: 'test-token-' + Math.random().toString(36).slice(2),
      closed: false,
      createServer,
      async close() {
        this.closed = true
      }
    }
    hosts.push(host)
    return host
  }
  return { startMcpHostFn, hosts }
}

const READY: HostedToolsReadiness = { state: 'ready', signal: 'registry', elapsedMs: 1 }

interface Rig {
  manager: OpencodeServerManager
  calls: SpawnCall[]
  hosts: FakeMcpHost[]
  waits: { baseUrl: string; directory: string; pluginExpected: boolean }[]
  /** Per-cwd config input; mutate to simulate a config change. */
  configs: Map<string, OpencodeConfigInput>
}

function makeRig(
  opts: {
    delayMs?: number
    spawnFn?: SpawnServerFn
    waitReadyFn?: WaitReadyFn
    waitGuardFn?: WaitGuardFn
    locateBinaryFn?: () => string
    configReloadOpsFn?: OpencodeServerManagerOptions['configReloadOpsFn']
  } = {}
): Rig {
  const { spawnFn, calls } = makeSpawnFn(opts.delayMs)
  const { startMcpHostFn, hosts } = makeMcpHostFn()
  const waits: Rig['waits'] = []
  const configs = new Map<string, OpencodeConfigInput>()
  const manager = new OpencodeServerManager({
    spawnFn: opts.spawnFn ?? spawnFn,
    locateBinaryFn: opts.locateBinaryFn ?? (() => '/fake/opencode'),
    startMcpHostFn,
    configInputFn: (cwd) => configs.get(cwd) ?? { pluginDir: '/res/claudeui-xeng' },
    waitReadyFn:
      opts.waitReadyFn ??
      (async (endpoint, directory, pluginExpected) => {
        waits.push({ baseUrl: endpoint.baseUrl, directory, pluginExpected })
        return READY
      }),
    waitGuardFn: opts.waitGuardFn ?? (async () => ({ state: 'active', elapsedMs: 0 })),
    endServerFn: (child) => child.kill(),
    serverCwd: '/server-home',
    configReloadOpsFn: opts.configReloadOpsFn
  })
  return { manager, calls, hosts, waits, configs }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── One server for every directory, keyed by injected config (ADR-097 §2) ──────

describe('OpencodeServerManager (2.x) — keying', () => {
  it('different cwds with the same config share ONE server (1.x spawned one per cwd)', async () => {
    const { manager, calls } = makeRig()
    const a = await manager.acquire('/proj/a')
    const b = await manager.acquire('/proj/b')
    expect(calls).toHaveLength(1)
    expect(a.baseUrl).toBe(b.baseUrl)
    expect(a.directory).toBe('/proj/a')
    expect(b.directory).toBe('/proj/b')
    expect(calls[0].cwd).toBe('/server-home')
    expect(manager.activeCount).toBe(1)
  })

  it('a cwd whose effective config differs gets its own server', async () => {
    const { manager, calls, configs } = makeRig()
    configs.set('/proj/b', {
      pluginDir: '/res/claudeui-xeng',
      bridgedMcp: { local: { type: 'local', command: ['x'], codemode: false } }
    })
    const a = await manager.acquire('/proj/a')
    const b = await manager.acquire('/proj/b')
    expect(calls).toHaveLength(2)
    expect(a.baseUrl).not.toBe(b.baseUrl)
    expect(JSON.parse(calls[1].configContent).mcp.servers.local).toBeDefined()
    expect(JSON.parse(calls[0].configContent).mcp.servers.local).toBeUndefined()
  })

  it('a config change: new leases get a new server, the old one drains and ends at its last release', async () => {
    const { manager, calls, configs } = makeRig()
    const old = await manager.acquire('/proj/a')
    configs.set('/proj/a', {
      pluginDir: '/res/claudeui-xeng',
      bridgedMcp: { added: { type: 'remote', url: 'https://x/mcp', codemode: false } }
    })
    const fresh = await manager.acquire('/proj/a')
    expect(calls).toHaveLength(2)
    expect(fresh.baseUrl).not.toBe(old.baseUrl)
    // The old server keeps serving its holder.
    expect(calls[0].child.killed).toBe(false)
    manager.releaseIfCurrent('/proj/a', old)
    expect(calls[0].child.killed).toBe(true)
    expect(calls[1].child.killed).toBe(false)
    manager.releaseIfCurrent('/proj/a', fresh)
    expect(calls[1].child.killed).toBe(true)
  })

  it('normalizes cwd: relative + absolute forms of one dir are one lease directory', async () => {
    const { manager } = makeRig()
    const rel = await manager.acquire('.')
    const abs = await manager.acquire(process.cwd())
    expect(rel.directory).toBe(abs.directory)
    expect(rel.directory).toBe(process.cwd())
  })
})

describe('OpencodeServerManager (2.x) — ref-counting', () => {
  it('acquire×2 spawns once; release×2 ends once', async () => {
    const { manager, calls, hosts } = makeRig()
    const one = await manager.acquire('/p')
    const two = await manager.acquire('/p')
    manager.releaseIfCurrent('/p', one)
    expect(calls[0].child.killed).toBe(false)
    manager.releaseIfCurrent('/p', two)
    expect(calls[0].child.killed).toBe(true)
    expect(hosts[0].closed).toBe(true)
    expect(manager.activeCount).toBe(0)
  })

  it('leases across directories keep one server alive until the last', async () => {
    const { manager, calls } = makeRig()
    const a = await manager.acquire('/a')
    const b = await manager.acquire('/b')
    manager.releaseIfCurrent('/a', a)
    expect(calls[0].child.killed).toBe(false)
    manager.releaseIfCurrent('/b', b)
    expect(calls[0].child.killed).toBe(true)
  })

  it('concurrency: 5 simultaneous acquires (mixed dirs) share one start', async () => {
    const { manager, calls } = makeRig({ delayMs: 20 })
    const conns = await Promise.all(['/a', '/b', '/a', '/c', '/b'].map((d) => manager.acquire(d)))
    expect(calls).toHaveLength(1)
    expect(new Set(conns.map((c) => c.baseUrl)).size).toBe(1)
    for (const [i, d] of ['/a', '/b', '/a', '/c'].entries()) manager.releaseIfCurrent(d, conns[i])
    expect(calls[0].child.killed).toBe(false)
    manager.releaseIfCurrent('/b', conns[4])
    expect(calls[0].child.killed).toBe(true)
  })

  it('releaseIfCurrent for a directory the lease does not hold is a no-op', async () => {
    const { manager, calls } = makeRig()
    const conn = await manager.acquire('/p')
    manager.releaseIfCurrent('/nope', conn)
    expect(calls[0].child.killed).toBe(false)
  })

  it('releaseIfCurrent with two servers holding the cwd releases exactly the lease given', async () => {
    const { manager, calls, configs } = makeRig()
    const old = await manager.acquire('/p')
    configs.set('/p', { pluginDir: null })
    const fresh = await manager.acquire('/p')
    manager.releaseIfCurrent('/p', fresh)
    expect(calls[1].child.killed).toBe(true)
    expect(calls[0].child.killed).toBe(false)
    manager.releaseIfCurrent('/p', old)
    expect(calls[0].child.killed).toBe(true)
  })

  it('re-acquire after full release starts a fresh server', async () => {
    const { manager, calls } = makeRig()
    const first = await manager.acquire('/p')
    manager.releaseIfCurrent('/p', first)
    const second = await manager.acquire('/p')
    expect(calls).toHaveLength(2)
    expect(second.password).not.toBe(first.password)
  })

  it('a failed start rejects and leaves nothing behind (a retry can start)', async () => {
    let attempt = 0
    const { spawnFn } = makeSpawnFn()
    const { manager, hosts } = makeRig({
      spawnFn: async (launch, options) => {
        if (attempt++ === 0) throw new Error('boom')
        return spawnFn(launch, options)
      }
    })
    await expect(manager.acquire('/p')).rejects.toThrow('boom')
    expect(manager.activeCount).toBe(0)
    expect(hosts[0].closed).toBe(true)
    await expect(manager.acquire('/p')).resolves.toBeTruthy()
  })

  it('a distinct random password (Basic header) per server', async () => {
    const { manager, calls, configs } = makeRig()
    configs.set('/b', { pluginDir: null })
    const a = await manager.acquire('/a')
    const b = await manager.acquire('/b')
    expect(a.password).not.toBe(b.password)
    expect(a.authHeader).toBe('Basic ' + Buffer.from('opencode:' + a.password).toString('base64'))
    expect(calls[0].password).toBe(a.password)
  })

  it('the spawn gets the server-own hosted MCP endpoint in its config', async () => {
    const { manager, calls, hosts } = makeRig()
    await manager.acquire('/p')
    const cfg = JSON.parse(calls[0].configContent)
    expect(cfg.mcp.servers.claudeui.url).toBe(`http://127.0.0.1:${hosts[0].port}/mcp`)
    expect(cfg.mcp.servers.claudeui.headers.Authorization).toBe(`Bearer ${hosts[0].token}`)
    expect(cfg.plugins).toEqual(['/res/claudeui-xeng'])
  })

  it('the MCP host builds a fresh claudeui McpServer per session', async () => {
    const { manager, hosts } = makeRig()
    await manager.acquire('/p')
    const s1 = hosts[0].createServer()
    const s2 = hosts[0].createServer()
    expect(s1).toBeInstanceOf(McpServer)
    expect(s1).not.toBe(s2)
  })
})

describe('OpencodeServerManager (2.x) — hosted-tools readiness', () => {
  it('acquire waits for readiness per directory, once per directory', async () => {
    const { manager, waits } = makeRig()
    const a = await manager.acquire('/a')
    await manager.acquire('/a')
    await manager.acquire('/b')
    expect(waits.map((w) => w.directory)).toEqual(['/a', '/b'])
    expect(waits[0]).toMatchObject({ baseUrl: a.baseUrl, pluginExpected: true })
    expect(a.hostedTools).toEqual(READY)
  })

  it('waitForHostedTools:false skips the wait for a caller that runs no turn', async () => {
    const { manager, waits } = makeRig()
    const conn = await manager.acquire('/a', { waitForHostedTools: false })
    expect(conn.hostedTools).toEqual({ state: 'skipped' })
    expect(waits).toHaveLength(0)
    // A later turn-running acquire still waits (nothing was memoized).
    await manager.acquire('/a')
    expect(waits).toHaveLength(1)
  })

  it('acquire does not resolve before readiness does', async () => {
    let finish!: (r: HostedToolsReadiness) => void
    const { manager } = makeRig({
      waitReadyFn: () => new Promise((resolve) => (finish = resolve))
    })
    let resolved = false
    const pending = manager.acquire('/a').then((c) => {
      resolved = true
      return c
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
    finish(READY)
    await expect(pending).resolves.toMatchObject({ hostedTools: READY })
  })

  it('no plugin → the wait is told so (status fallback)', async () => {
    const { manager, waits, configs } = makeRig()
    configs.set('/a', { pluginDir: null })
    await manager.acquire('/a')
    expect(waits[0].pluginExpected).toBe(false)
  })

  it('a timeout is logged and the lease still handed out (degraded, never a failure)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager } = makeRig({
      waitReadyFn: async () => ({
        state: 'timeout',
        last: 'rpc 200 [], claudeui pending',
        elapsedMs: 10_000
      })
    })
    const conn = await manager.acquire('/a')
    expect(conn.hostedTools.state).toBe('timeout')
    expect(
      warn.mock.calls.some(([, msg]) => /still not registered.*\/a.*10000 ms/.test(String(msg)))
    ).toBe(true)
  })

  it('a readiness probe that throws counts as a timeout, not a rejected acquire', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager } = makeRig({ waitReadyFn: async () => Promise.reject(new Error('nope')) })
    await expect(manager.acquire('/a')).resolves.toMatchObject({
      hostedTools: { state: 'timeout' }
    })
  })

  it('a server that dies during the wait rejects the acquire and leaks no ref', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let finish!: (r: HostedToolsReadiness) => void
    const { manager, calls } = makeRig({
      waitReadyFn: () => new Promise((resolve) => (finish = resolve))
    })
    const pending = manager.acquire('/a')
    await new Promise((r) => setTimeout(r, 0))
    calls[0].child.emit('exit', 1, null)
    finish(READY)
    await expect(pending).rejects.toThrow(/went away/)
    expect(manager.activeCount).toBe(0)
  })

  it('refreshReadiness re-waits (S8: after a location reload)', async () => {
    const { manager, waits } = makeRig()
    const conn = await manager.acquire('/a')
    await expect(manager.refreshReadiness(conn)).resolves.toEqual(READY)
    expect(waits).toHaveLength(2)
    manager.releaseIfCurrent('/a', conn)
    await expect(manager.refreshReadiness(conn)).resolves.toEqual({ state: 'skipped' })
  })
})

describe('OpencodeServerManager (2.x) — config reload (S8)', () => {
  function reloadRig(active: number[]) {
    const reloads: string[] = []
    const asked: string[] = []
    let call = 0
    const rig = makeRig({
      configReloadOpsFn: (endpoint, directory) => ({
        activeExecutions: async () => {
          asked.push(`${endpoint.baseUrl} ${directory}`)
          return active[call++] ?? 0
        },
        reloadLocations: async () => {
          reloads.push(endpoint.baseUrl)
        }
      })
    })
    return { ...rig, reloads, asked }
  }

  it('reloads an idle server, re-waits every held directory and re-probes the guard', async () => {
    const waitGuard = vi.fn(async () => ({ state: 'active' as const, elapsedMs: 0 }))
    const reloads: string[] = []
    const { manager, waits } = makeRig({
      waitGuardFn: waitGuard,
      configReloadOpsFn: (endpoint) => ({
        activeExecutions: async () => 0,
        reloadLocations: async () => {
          reloads.push(endpoint.baseUrl)
        }
      })
    })
    await manager.acquire('/a')
    await manager.acquire('/b')
    const changed = vi.fn()
    manager.onConfigChanged(changed)
    waits.length = 0
    await expect(manager.reloadConfig()).resolves.toEqual({ reloaded: 1, busy: 0, failed: 0 })
    expect(reloads).toHaveLength(1)
    expect(waits.map((w) => w.directory).sort()).toEqual(['/a', '/b'])
    expect(changed).toHaveBeenCalledTimes(1)
    await manager.acquire('/a')
    expect(waitGuard).toHaveBeenCalledTimes(3) // /a, /b, then /a again after the reload
  })

  it('never reloads a server with a running execution (a reload cancels pending asks), but still notifies', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { manager, reloads, waits } = reloadRig([2])
    await manager.acquire('/a')
    const changed = vi.fn()
    manager.onConfigChanged(changed)
    waits.length = 0
    await expect(manager.reloadConfig()).resolves.toEqual({ reloaded: 0, busy: 1, failed: 0 })
    expect(reloads).toHaveLength(0)
    expect(waits).toHaveLength(0)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('a failing server is reported, never thrown, and the others still reload', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let n = 0
    const { manager, configs } = makeRig({
      configReloadOpsFn: () => ({
        activeExecutions: async () => {
          if (n++ === 0) throw new Error('boom')
          return 0
        },
        reloadLocations: async () => {}
      })
    })
    configs.set('/b', { pluginDir: '/other' })
    await manager.acquire('/a')
    await manager.acquire('/b')
    await expect(manager.reloadConfig()).resolves.toEqual({ reloaded: 1, busy: 0, failed: 1 })
  })

  it('an unsubscribed listener is not told', async () => {
    const { manager } = reloadRig([])
    const cb = vi.fn()
    manager.onConfigChanged(cb)()
    await manager.reloadConfig()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('OpencodeServerManager (2.x) — exit fan-out', () => {
  it('subscribeExit fires on an unexpected exit; the handle is dropped and its MCP host closed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager, calls, hosts } = makeRig()
    const conn = await manager.acquire('/p')
    const cb = vi.fn()
    manager.subscribeExit('/p', cb, conn)
    calls[0].child.emit('exit', 1, null)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(manager.activeCount).toBe(0)
    expect(hosts[0].closed).toBe(true)
  })

  it('does NOT fire on the deliberate last release or on dispose', async () => {
    const { manager } = makeRig()
    const conn = await manager.acquire('/p')
    const cb = vi.fn()
    manager.subscribeExit('/p', cb)
    manager.releaseIfCurrent('/p', conn)
    await manager.acquire('/q')
    const cb2 = vi.fn()
    manager.subscribeExit('/q', cb2)
    manager.dispose()
    expect(cb).not.toHaveBeenCalled()
    expect(cb2).not.toHaveBeenCalled()
  })

  it('subscribeExit with conn binds to that exact server', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager, calls, configs } = makeRig()
    const old = await manager.acquire('/p')
    configs.set('/p', { pluginDir: null })
    await manager.acquire('/p')
    const onOld = vi.fn()
    const onNewest = vi.fn()
    manager.subscribeExit('/p', onOld, old)
    manager.subscribeExit('/p', onNewest)
    calls[0].child.emit('exit', 1, null)
    expect(onOld).toHaveBeenCalledTimes(1)
    expect(onNewest).not.toHaveBeenCalled()
  })

  it('releaseIfCurrent no-ops after the death, and never touches the replacement', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager, calls } = makeRig()
    const dead = await manager.acquire('/p')
    calls[0].child.emit('exit', 1, null)
    await manager.acquire('/p') // replacement
    manager.releaseIfCurrent('/p', dead)
    expect(calls[1].child.killed).toBe(false)
    expect(manager.activeCount).toBe(1)
  })

  it('a throwing subscriber does not starve the others', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { manager, calls } = makeRig()
    const conn = await manager.acquire('/p')
    const ok = vi.fn()
    manager.subscribeExit(
      '/p',
      () => {
        throw new Error('bad')
      },
      conn
    )
    manager.subscribeExit('/p', ok, conn)
    calls[0].child.emit('exit', 1, null)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('subscribeExit with nothing live returns a no-op unsubscribe', () => {
    const { manager } = makeRig()
    expect(() => manager.subscribeExit('/nope', () => {})()).not.toThrow()
  })
})

describe('OpencodeServerManager (2.x) — first-contact hook (S7 follow-up)', () => {
  it('runs on every new server BEFORE any readiness request or lease, once per server', async () => {
    const order: string[] = []
    const { manager } = makeRig({
      waitReadyFn: async () => {
        order.push('readiness')
        return READY
      }
    })
    manager.setServerStartedHook(async (endpoint) => {
      order.push(`hook ${endpoint.baseUrl}`)
    })
    const a = await manager.acquire('/a')
    order.push('leased')
    await manager.acquire('/a')
    expect(order).toEqual([`hook ${a.baseUrl}`, 'readiness', 'leased'])
  })

  it('a failing hook: no location request (readiness) until a retry succeeds', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const { manager, waits } = makeRig()
      let runs = 0
      manager.setServerStartedHook(async () => {
        runs++
        order.push(`hook ${runs}`)
        if (runs < 2) throw new Error('SQLITE_BUSY')
      })
      const leased = manager.acquire('/a')
      await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_DELAYS_MS[0])
      await expect(leased).resolves.toMatchObject({ directory: '/a' })
      expect(runs).toBe(2)
      expect(waits).toHaveLength(1) // readiness only after the successful retry
      // Cleaned now: the next acquire runs no hook.
      await manager.acquire('/a')
      expect(runs).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stuck hook keeps the server uncleaned past its bound; the acquire waits for the retry', async () => {
    vi.useFakeTimers()
    try {
      const { manager, waits } = makeRig()
      let release!: () => void
      let runs = 0
      manager.setServerStartedHook(() => {
        runs++
        return runs === 1 ? new Promise<void>(() => {}) : new Promise<void>((r) => (release = r))
      })
      const leased = manager.acquire('/a', { waitForHostedTools: false })
      await vi.advanceTimersByTimeAsync(
        SERVER_STARTED_HOOK_TIMEOUT_MS * 2 + CLEANUP_RETRY_DELAYS_MS[0]
      )
      expect(waits).toHaveLength(0)
      let resolved = false
      void leased.then(() => (resolved = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)
      release()
      await vi.advanceTimersByTimeAsync(0)
      await expect(leased).resolves.toMatchObject({ directory: '/a' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('persistent failure fails CLOSED with a clear error; credential-route leases still work; a later acquire retries', async () => {
    vi.useFakeTimers()
    try {
      const { manager, calls, waits } = makeRig()
      let broken = true
      manager.setServerStartedHook(async () => {
        if (broken) throw new Error('SQLITE_BUSY')
      })
      const reads = await manager.acquire('/p', {
        waitForHostedTools: false,
        credentialRoutesOnly: true
      })
      expect(reads.baseUrl).toBe(calls[0] && reads.baseUrl)
      const turn = manager.acquire('/a')
      const caught = turn.catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(
        CLEANUP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + SERVER_STARTED_HOOK_TIMEOUT_MS
      )
      expect(await caught).toBeInstanceOf(OpencodeCredentialCleanupError)
      expect(waits).toHaveLength(0)
      expect(calls[0].child.killed).toBe(false) // the credential lease still holds it
      broken = false
      await expect(manager.acquire('/a')).resolves.toMatchObject({ directory: '/a' })
      expect(waits).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OpencodeServerManager (2.x) — dispose / start turns', () => {
  it('dispose ends all servers and closes hosts; an acquire after it rejects at once', async () => {
    const { manager, calls, hosts } = makeRig()
    await manager.acquire('/a')
    manager.dispose()
    expect(calls[0].child.killed).toBe(true)
    expect(hosts[0].closed).toBe(true)
    await expect(manager.acquire('/a')).rejects.toThrow(/disposed/)
    expect(hosts).toHaveLength(1)
  })

  it('dispose during an in-flight start reaps the server instead of orphaning it', async () => {
    const { manager, calls } = makeRig({ delayMs: 20 })
    const pending = manager.acquire('/a')
    await new Promise((r) => setTimeout(r, 5))
    manager.dispose()
    await expect(pending).rejects.toThrow(/disposed/)
    expect(calls[0].child.killed).toBe(true)
  })

  it('starts take turns; a failed start passes the turn on', async () => {
    let active = 0
    let maxActive = 0
    let n = 0
    const { spawnFn } = makeSpawnFn()
    const { manager, configs } = makeRig({
      spawnFn: async (launch, options) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        if (n++ === 1) throw new Error('second fails')
        return spawnFn(launch, options)
      }
    })
    configs.set('/b', { pluginDir: null })
    configs.set('/c', { pluginDir: 'x' })
    configs.set('/d', { pluginDir: 'y' })
    const results = await Promise.allSettled([
      manager.acquire('/a'),
      manager.acquire('/b'),
      manager.acquire('/d'),
      manager.acquire('/c')
    ])
    expect(maxActive).toBe(1)
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled'
    ])
  })
})

describe('OpencodeServerManager (2.x) — secrets', () => {
  it('never logs the password, the hosted bearer, or a bridged secret', async () => {
    const lines: string[] = []
    for (const level of ['debug', 'info', 'warn', 'error'] as const)
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    const { manager, calls, hosts, configs } = makeRig({
      waitReadyFn: async () => ({ state: 'timeout', last: 'x', elapsedMs: 1 })
    })
    configs.set('/a', {
      pluginDir: null,
      bridgedMcp: {
        gh: {
          type: 'local',
          command: ['gh'],
          environment: { TOKEN: 'ghp_SECRET_VALUE' },
          codemode: false
        }
      }
    })
    const conn = await manager.acquire('/a')
    calls[0].child.emit('exit', 1, null)
    expect(lines.length).toBeGreaterThan(0)
    const all = lines.join('\n')
    expect(all).not.toContain('ghp_SECRET_VALUE')
    expect(all).not.toContain(hosts[0].token)
    expect(all).not.toContain(conn.password)
    expect(all).not.toContain('OPENCODE_CONFIG_CONTENT')
  })
})

describe('locatePluginDir', () => {
  it('finds the shipped directory plugin in dev (repo root) and maps app.asar → app.asar.unpacked', () => {
    const dir = locatePluginDir(process.cwd())
    expect(dir).toBe(`${process.cwd()}/resources/opencode/claudeui-xeng`)
    expect(locatePluginDir('/nowhere/app.asar')).toBeNull()
  })
})

// Typed seam check: a ServerConnection carries what S3's client needs.
export type _S3Seam = Pick<ServerConnection, 'baseUrl' | 'authHeader' | 'directory' | 'startedAt'>

describe('ADR-097 §3 (S6) — fail closed without the plugin permission guard', () => {
  /** The real guard probe against a server whose RPC answers `status` (never `active`). */
  const silentGuard =
    (status = 404): WaitGuardFn =>
    (_endpoint, _directory, pluginExpected) =>
      waitForPermissionGuard(
        { pluginExpected, timeoutMs: 30, pollMs: 5 },
        { request: async () => ({ status, body: null }) }
      )

  it('no plugin in the build: a turn acquire throws, the server is ended, a turn-less acquire still works', async () => {
    const { manager, configs, calls } = makeRig({ waitGuardFn: silentGuard() })
    configs.set('/p', { pluginDir: null })
    const err = await manager.acquire('/p').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpencodePermissionGuardError)
    expect((err as Error).message).toMatch(/not found in this ClaudeUI build/)
    expect(calls[0].child.killed).toBe(true)
    // Session lists, auth and usage reads run no turn: they may still use a server.
    const listing = await manager.acquire('/p', { waitForHostedTools: false })
    expect(listing.hostedTools).toEqual({ state: 'skipped' })
    manager.dispose()
  })

  it('plugin injected but its guard RPC never answers: throws even though tool readiness fell back to mcp-status', async () => {
    const { manager } = makeRig({
      waitReadyFn: async () => ({ state: 'ready', signal: 'mcp-status', elapsedMs: 1 }),
      waitGuardFn: silentGuard(404)
    })
    await expect(manager.acquire('/p')).rejects.toThrow(/did not confirm its permission hook/)
    manager.dispose()
  })

  it('a failed probe is not memoized: the next acquire probes again and can succeed', async () => {
    let answer: 'missing' | 'active' = 'missing'
    const probes: string[] = []
    const { manager } = makeRig({
      waitGuardFn: async (_e, directory) => {
        probes.push(directory)
        return answer === 'active'
          ? { state: 'active', elapsedMs: 0 }
          : { state: 'missing', reason: 'x', elapsedMs: 0 }
      }
    })
    await expect(manager.acquire('/p')).rejects.toBeInstanceOf(OpencodePermissionGuardError)
    answer = 'active'
    await expect(manager.acquire('/p')).resolves.toMatchObject({ directory: '/p' })
    await manager.acquire('/p')
    expect(probes).toEqual(['/p', '/p']) // the active result is memoized
    manager.dispose()
  })
})
