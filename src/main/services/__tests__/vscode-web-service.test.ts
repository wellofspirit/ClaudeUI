/**
 * @vitest-environment node
 *
 * `VscodeWebService` — detection, spawn, tokens, sessions, reaper, origin policy
 * (ADR-064 slice 1).
 *
 * Everything here runs against INJECTED seams (`spawn`, `platform`, `exists`,
 * `env`, `now`, `killTree`) rather than a real VS Code, and that is the point:
 * the detection order, the `.exe`-only Windows rule and the reaper's idle
 * arithmetic are all properties of THIS file's logic, not of any machine's
 * install layout — a test that needed VS Code installed would only pass on the
 * developer's box, and would pass vacuously on CI.
 *
 * The socket-level twin (`remote-ide.test.ts`) drives the real proxy over a real
 * listener; this file proves the service the proxy asks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

const { auditRows, configRef } = vi.hoisted(() => ({
  auditRows: [] as Array<Record<string, unknown>>,
  configRef: { current: null as Record<string, unknown> | null }
}))

vi.mock('../../../core/services/db', () => ({
  getRemoteConfig: () => configRef.current,
  appendAuditLog: (entry: Record<string, unknown>) => {
    auditRows.push(entry)
  }
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  VscodeWebService,
  ideFolderParam,
  ideOriginPolicy,
  readCookie,
  readIdePolicy,
  stripIdeCookie,
  IDE_ALLOWED_ORIGINS
} from '../../../core/services/vscode-web-service'
import type { ConnectionOrigin } from '../../../core/services/remote-server'
import { makeRemoteConnection } from '../../../core/ipc/command-registry'

// ---------------------------------------------------------------------------
// A fake child process, controllable frame by frame
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: Record<string, unknown>
  child: FakeChild
}

/** A spawn seam that records every call and hands back a controllable child. */
function recordingSpawn(): {
  fn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    fn: (command, args, options) => {
      const child = new FakeChild()
      calls.push({ command, args, options, child })
      return child as unknown as ChildProcess
    }
  }
}

const CONNECTION = makeRemoteConnection('password', 'tester')

beforeEach(() => {
  auditRows.length = 0
  configRef.current = null
})

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('readIdePolicy', () => {
  it('reads the persisted posture', () => {
    configRef.current = { allowIde: true, ideCliPath: '/opt/code-tunnel' }
    expect(readIdePolicy()).toEqual({ allowIde: true, cliPathOverride: '/opt/code-tunnel' })
  })

  it('fails CLOSED with no row at all', () => {
    configRef.current = null
    expect(readIdePolicy()).toEqual({ allowIde: false, cliPathOverride: null })
  })
})

// ---------------------------------------------------------------------------
// Origin policy — THE widening point
// ---------------------------------------------------------------------------

describe('ideOriginPolicy', () => {
  const table: Array<[ConnectionOrigin, boolean]> = [
    ['tailnet-serve', true],
    ['localhost', true],
    // The three refusals, each for its own reason (ADR-064 §3): the tunnel would
    // hand plaintext source + shell traffic to Cloudflare's edge (ADR-039's
    // refusal), plain LAN cannot even boot the workbench (no secure context ⇒ no
    // service worker), and funnel is the public internet.
    ['tunnel', false],
    ['lan', false],
    ['funnel', false]
  ]

  it.each(table)('%s → allowed=%s', (origin, allowed) => {
    const verdict = ideOriginPolicy(origin)
    expect(verdict.allowed).toBe(allowed)
    if (!verdict.allowed) expect(verdict.reason).toBe('origin-not-allowed')
  })

  it('the allowlist const IS the policy (nothing else encodes it)', () => {
    // The guard behind "widening is a one-const edit": every member of the const
    // is allowed and nothing outside it is, so a future edit that added an origin
    // here needs no other change — and one that forgot the const would fail.
    expect([...IDE_ALLOWED_ORIGINS]).toEqual(['tailnet-serve', 'localhost'])
    for (const origin of IDE_ALLOWED_ORIGINS) {
      expect(ideOriginPolicy(origin).allowed).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('cookie + folder helpers', () => {
  it('reads one cookie out of a multi-pair header', () => {
    expect(readCookie('a=1; claudeui-ide=deadbeef; vscode-tkn=xyz', 'claudeui-ide')).toBe('deadbeef')
    expect(readCookie('a=1', 'claudeui-ide')).toBeNull()
    expect(readCookie(undefined, 'claudeui-ide')).toBeNull()
  })

  it('strips EVERY claudeui-ide pair and keeps everything else', () => {
    // Our cookie is the credential for OUR gate — a child process must never see
    // it — while upstream's `vscode-tkn` is exactly what the workbench needs.
    expect(stripIdeCookie('a=1; claudeui-ide=x; vscode-tkn=t; claudeui-ide=y')).toBe(
      'a=1; vscode-tkn=t'
    )
    expect(stripIdeCookie('claudeui-ide=x')).toBeUndefined()
    expect(stripIdeCookie(undefined)).toBeUndefined()
  })

  it('shapes a host path for the workbench `?folder=`', () => {
    expect(ideFolderParam('D:\\WorkPlace\\ClaudeUI')).toBe('/D:/WorkPlace/ClaudeUI')
    expect(ideFolderParam('/home/dev/project')).toBe('/home/dev/project')
  })
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('probeCli — candidate order and validation', () => {
  /** A service whose only existing files are the ones named. */
  function serviceWith(opts: {
    platform: NodeJS.Platform
    files: string[]
    env?: NodeJS.ProcessEnv
    exitCodes?: Record<string, number>
  }): { service: VscodeWebService; spawn: ReturnType<typeof recordingSpawn> } {
    const spawn = recordingSpawn()
    const service = new VscodeWebService({
      platform: () => opts.platform,
      exists: (p) => opts.files.includes(p),
      env: () => opts.env ?? {},
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        const child = spawn.fn(command, args, options)
        // Answer on the next tick, like a real exit would.
        setTimeout(() => {
          ;(child as unknown as FakeChild).emit('exit', opts.exitCodes?.[command] ?? 0)
        }, 0)
        return child
      }) as never
    })
    return { service, spawn }
  }

  it('prefers code-tunnel BESIDE the `code` that PATH resolves to', async () => {
    const { service, spawn } = serviceWith({
      platform: 'win32',
      env: { PATH: 'C:\\tools;C:\\vscode\\bin' },
      files: ['C:\\vscode\\bin\\code.cmd', 'C:\\vscode\\bin\\code-tunnel.exe']
    })
    const probe = await service.probeCli(null)
    expect(probe).toEqual({ ok: true, cliPath: 'C:\\vscode\\bin\\code-tunnel.exe' })
    expect(spawn.calls[0].args).toEqual(['serve-web', '--help'])
    expect(spawn.calls[0].options).toMatchObject({ windowsHide: true, shell: false })
  })

  it('NEVER auto-probes a non-.exe candidate on Windows', async () => {
    // `code.cmd` is a batch wrapper (unspawnable under the repo's `shell: false`
    // rule) and `Code.exe` is the Electron GUI — running either by accident is
    // the failure this rule exists to prevent. With only `code.cmd` present there
    // is nothing to probe at all.
    const { service, spawn } = serviceWith({
      platform: 'win32',
      env: { PATH: 'C:\\vscode\\bin' },
      files: ['C:\\vscode\\bin\\code.cmd']
    })
    const probe = await service.probeCli(null)
    expect(probe).toEqual({
      ok: false,
      reason: 'cli-not-found',
      detail: expect.any(String)
    })
    expect(spawn.calls).toHaveLength(0)
  })

  it('exempts an EXPLICIT override from the .exe rule and from the exists check', async () => {
    const { service, spawn } = serviceWith({
      platform: 'win32',
      env: {},
      files: []
    })
    const probe = await service.probeCli('C:\\custom\\code')
    expect(probe).toEqual({ ok: true, cliPath: 'C:\\custom\\code' })
    expect(spawn.calls[0].command).toBe('C:\\custom\\code')
  })

  it('falls back to the platform well-knowns, then to the POSIX `code`', async () => {
    const { service } = serviceWith({
      platform: 'linux',
      env: { PATH: '/nowhere' },
      files: ['/usr/bin/code']
    })
    expect(await service.probeCli(null)).toEqual({ ok: true, cliPath: '/usr/bin/code' })
  })

  it('reports cli-invalid (not cli-not-found) when a candidate EXISTS but fails --help', async () => {
    // The distinction is what lets the settings pane say "install VS Code" vs
    // "that is not a VS Code CLI" instead of one generic failure.
    const { service } = serviceWith({
      platform: 'linux',
      env: { PATH: '/nowhere' },
      files: ['/usr/bin/code'],
      exitCodes: { '/usr/bin/code': 1 }
    })
    const probe = await service.probeCli(null)
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.reason).toBe('cli-invalid')
  })

  it('caches the result and re-probes after invalidateProbe()', async () => {
    const { service, spawn } = serviceWith({
      platform: 'linux',
      env: { PATH: '/nowhere' },
      files: ['/usr/bin/code']
    })
    await service.probeCli(null)
    await service.probeCli(null)
    expect(spawn.calls).toHaveLength(1)
    service.invalidateProbe()
    await service.probeCli(null)
    expect(spawn.calls).toHaveLength(2)
  })

  it('re-probes when the OVERRIDE changes, without an explicit invalidation', async () => {
    const { service, spawn } = serviceWith({
      platform: 'linux',
      env: { PATH: '/nowhere' },
      files: ['/usr/bin/code']
    })
    await service.probeCli(null)
    await service.probeCli('/opt/code-tunnel')
    expect(spawn.calls.map((c) => c.command)).toEqual(['/usr/bin/code', '/opt/code-tunnel'])
  })
})

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

describe('ensureRunning — spawn args, port parse, lifecycle', () => {
  /** A service whose CLI probe always succeeds, with manual control of `serve-web`. */
  function readyService(over: Partial<{ now: () => number }> = {}): {
    service: VscodeWebService
    calls: SpawnCall[]
    killed: ChildProcess[]
  } {
    const calls: SpawnCall[] = []
    const killed: ChildProcess[] = []
    const service = new VscodeWebService({
      platform: () => 'linux',
      exists: (p) => p === '/usr/bin/code',
      env: () => ({ PATH: '/usr/bin' }),
      killTree: (child) => {
        killed.push(child)
        child.kill()
      },
      ...(over.now ? { now: over.now } : {}),
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        const child = new FakeChild()
        calls.push({ command, args, options, child })
        // The `--help` probe answers 0 immediately; a `serve-web` run is left for
        // the test to drive.
        if (args[1] === '--help') setTimeout(() => child.emit('exit', 0), 0)
        return child as unknown as ChildProcess
      }) as never
    })
    return { service, calls, killed }
  }

  /** The line `serve-web` really prints (probed, VS Code 1.135.0). */
  const readyLine = (port: number): string =>
    `Web UI available at http://127.0.0.1:${port}/vscode?tkn=abc123\n`

  it('spawns with the pinned args and resolves on the stdout port line', async () => {
    const { service, calls } = readyService()
    const running = service.ensureRunning(CONNECTION)
    // Let the probe settle, then feed the ready line.
    await vi.waitFor(() => expect(calls.length).toBe(2))
    const spawnCall = calls[1]
    expect(spawnCall.command).toBe('/usr/bin/code')
    expect(spawnCall.args.slice(0, 6)).toEqual([
      'serve-web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--connection-token'
    ])
    // Per-spawn random, 32 bytes hex.
    expect(spawnCall.args[6]).toMatch(/^[0-9a-f]{64}$/)
    expect(spawnCall.args.slice(7)).toEqual([
      '--server-base-path',
      '/vscode',
      '--accept-server-license-terms',
      '--disable-telemetry'
    ])
    expect(spawnCall.options).toMatchObject({ windowsHide: true, shell: false })

    spawnCall.child.stdout.emit('data', Buffer.from(readyLine(39217)))
    await expect(running).resolves.toMatchObject({ port: 39217 })
    expect(service.runtime()).toBe('running')
    expect(service.upstreamPort()).toBe(39217)
    expect(auditRows.some((r) => r.channel === 'ide:spawn' && r.outcome === 'ok')).toBe(true)
  })

  it('is single-flight — two concurrent mints share one child', async () => {
    const { service, calls } = readyService()
    const a = service.ensureRunning(CONNECTION)
    const b = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    calls[1].child.stdout.emit('data', Buffer.from(readyLine(4001)))
    await expect(a).resolves.toMatchObject({ port: 4001 })
    await expect(b).resolves.toMatchObject({ port: 4001 })
    // One `--help`, one `serve-web`. A second server would hold a second port.
    expect(calls.filter((c) => c.args[1] !== '--help')).toHaveLength(1)
  })

  it('rejects and goes to `error` when the child dies before printing a port', async () => {
    const { service, calls } = readyService()
    const running = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    calls[1].child.stderr.emit('data', Buffer.from('EACCES'))
    calls[1].child.emit('exit', 1, null)
    await expect(running).rejects.toThrow(/exited before printing a port/)
    expect(service.runtime()).toBe('error')
    expect(service.lastErrorMessage()).toContain('EACCES')
    expect(auditRows.some((r) => r.channel === 'ide:spawn' && r.outcome === 'error')).toBe(true)
  })

  it('a death AFTER ready clears the sessions and the next mint respawns', async () => {
    const { service, calls } = readyService()
    const running = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    calls[1].child.stdout.emit('data', Buffer.from(readyLine(4002)))
    await running

    const entry = service.mintEntry(CONNECTION, '/tmp/project')
    const token = new URL(`http://x${entry.url}`).searchParams.get('it')!
    const redeemed = service.redeemEntry(token)!
    expect(service.validateCookie(`claudeui-ide=${redeemed.cookieValue}`)).toBe(true)

    calls[1].child.emit('exit', 137, null)
    expect(service.runtime()).toBe('error')
    expect(service.upstreamPort()).toBeNull()
    // The session dies with the server it pointed at — a cookie for a gone
    // upstream is not a session, it is a 403 waiting to happen.
    expect(service.validateCookie(`claudeui-ide=${redeemed.cookieValue}`)).toBe(false)

    // No auto-restart loop; the NEXT mint is what respawns.
    const again = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(3))
    calls[2].child.stdout.emit('data', Buffer.from(readyLine(4003)))
    await expect(again).resolves.toMatchObject({ port: 4003 })
  })

  it('stop() kills by TREE and returns to `stopped`', async () => {
    // Parent-only kill orphans the inner server child, which keeps the port —
    // observed live on Windows. `killProcessTree` is the only correct reaper.
    const { service, calls, killed } = readyService()
    const running = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    calls[1].child.stdout.emit('data', Buffer.from(readyLine(4004)))
    await running
    service.stop()
    expect(killed).toHaveLength(1)
    expect(service.runtime()).toBe('stopped')
    expect(service.upstreamPort()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Entry tokens + cookie sessions
// ---------------------------------------------------------------------------

describe('entry tokens and cookie sessions', () => {
  let clock = 1_000_000
  let service: VscodeWebService
  let calls: SpawnCall[]

  beforeEach(async () => {
    clock = 1_000_000
    calls = []
    service = new VscodeWebService({
      platform: () => 'linux',
      exists: (p) => p === '/usr/bin/code',
      env: () => ({ PATH: '/usr/bin' }),
      now: () => clock,
      killTree: (child) => child.kill(),
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        const child = new FakeChild()
        calls.push({ command, args, options, child })
        if (args[1] === '--help') setTimeout(() => child.emit('exit', 0), 0)
        return child as unknown as ChildProcess
      }) as never
    })
    const running = service.ensureRunning(CONNECTION)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    calls[1].child.stdout.emit(
      'data',
      Buffer.from('Web UI available at http://127.0.0.1:5555/vscode?tkn=t\n')
    )
    await running
  })

  const tokenOf = (url: string): string => new URL(`http://x${url}`).searchParams.get('it')!

  it('mints a relative single-use entry URL', () => {
    const entry = service.mintEntry(CONNECTION, '/home/dev/project')
    expect(entry.url).toMatch(/^\/vscode\/enter\?it=[0-9a-f]{64}$/)
  })

  it('a token is spent exactly once', () => {
    const token = tokenOf(service.mintEntry(CONNECTION, '/home/dev/p').url)
    expect(service.redeemEntry(token)).not.toBeNull()
    expect(service.redeemEntry(token)).toBeNull()
  })

  it('a token expires after 60 s', () => {
    const token = tokenOf(service.mintEntry(CONNECTION, '/home/dev/p').url)
    clock += 60_001
    expect(service.redeemEntry(token)).toBeNull()
  })

  it('refuses a wrong / malformed token without throwing', () => {
    service.mintEntry(CONNECTION, '/home/dev/p')
    expect(service.redeemEntry('ff'.repeat(32))).toBeNull()
    expect(service.redeemEntry('not-hex')).toBeNull()
    expect(service.redeemEntry(null)).toBeNull()
  })

  it('bounds pending tokens, dropping the OLDEST', () => {
    const first = tokenOf(service.mintEntry(CONNECTION, '/a').url)
    for (let i = 0; i < 8; i++) service.mintEntry(CONNECTION, `/b${i}`)
    expect(service.redeemEntry(first)).toBeNull()
  })

  it('redeem hands back the workbench redirect with the encoded folder', () => {
    const token = tokenOf(service.mintEntry(CONNECTION, 'D:\\WorkPlace\\ClaudeUI').url)
    const redeemed = service.redeemEntry(token)!
    expect(redeemed.cookieValue).toMatch(/^[0-9a-f]{64}$/)
    // `tkn` is the token WE generated for this spawn (spawn arg 6), never the one
    // echoed in serve-web's stdout line — the two are the same value in
    // production, and asserting the generated one is what proves we are handing
    // out our own secret rather than parsing it back off a log line.
    const spawnToken = calls[1].args[6]
    expect(redeemed.redirect).toBe(
      `/vscode/?tkn=${spawnToken}&folder=${encodeURIComponent('/D:/WorkPlace/ClaudeUI')}`
    )
  })

  it('a session cookie validates, expires at 24 h, and is bounded', () => {
    const cookieFor = (folder: string): string =>
      service.redeemEntry(tokenOf(service.mintEntry(CONNECTION, folder).url))!.cookieValue

    const first = cookieFor('/a')
    expect(service.validateCookie(`claudeui-ide=${first}`)).toBe(true)
    expect(service.validateCookie('claudeui-ide=deadbeef')).toBe(false)
    expect(service.validateCookie(undefined)).toBe(false)

    // Sixteen more evict it by count.
    for (let i = 0; i < 16; i++) cookieFor(`/b${i}`)
    expect(service.validateCookie(`claudeui-ide=${first}`)).toBe(false)

    const fresh = cookieFor('/c')
    clock += 24 * 3_600_000 + 1
    expect(service.validateCookie(`claudeui-ide=${fresh}`)).toBe(false)
  })

  it('clearSessions destroys live sockets AND drops unspent tokens', () => {
    const cookie = service.redeemEntry(tokenOf(service.mintEntry(CONNECTION, '/a').url))!
      .cookieValue
    const unspent = tokenOf(service.mintEntry(CONNECTION, '/b').url)
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    service.registerSocket(socket as never)
    expect(service.liveSocketCount()).toBe(1)

    service.clearSessions('policy-off')

    expect(service.validateCookie(`claudeui-ide=${cookie}`)).toBe(false)
    expect(service.redeemEntry(unspent)).toBeNull()
    // The socket half is what actually ENDS a live IDE: our gate only runs at
    // request and upgrade time, so an established workbench WebSocket would
    // otherwise outlive the cookie that opened it.
    expect(socket.destroy).toHaveBeenCalled()
    expect(service.liveSocketCount()).toBe(0)
    expect(auditRows.some((r) => r.channel === 'ide:sessions-cleared')).toBe(true)
  })

  it('reaps the child after 30 idle minutes with no live sockets', () => {
    expect(service.runtime()).toBe('running')
    clock += 29 * 60_000
    service.maybeReap()
    expect(service.runtime()).toBe('running')

    // A live socket holds it open regardless of the clock.
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    service.registerSocket(socket as never)
    clock += 60 * 60_000
    service.maybeReap()
    expect(service.runtime()).toBe('running')

    socket.emit('close')
    clock += 31 * 60_000
    service.maybeReap()
    expect(service.runtime()).toBe('stopped')
    expect(service.upstreamPort()).toBeNull()
  })

  it('a `/vscode` request resets the idle clock', () => {
    clock += 29 * 60_000
    service.noteRequest()
    clock += 29 * 60_000
    service.maybeReap()
    expect(service.runtime()).toBe('running')
  })
})
