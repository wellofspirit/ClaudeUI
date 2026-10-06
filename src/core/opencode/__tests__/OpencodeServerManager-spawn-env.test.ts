/**
 * Guards what the manager's DEFAULT spawn path actually runs (ADR-093 §2).
 *
 * The lifecycle test injects `spawnFn`, which skips the real spawn entirely —
 * so this one mocks `node:child_process` instead and lets the default
 * `spawnStdioServer` run, the only way to see what the child receives:
 * - `serve --stdio --hostname 127.0.0.1 --port 0`, stdin piped (the lease);
 * - OPENCODE_PASSWORD (not the legacy name), OPENCODE_DISABLE_AUTOUPDATE=1,
 *   OPENCODE_DISABLE_SHARE=1;
 * - OPENCODE_CONFIG_CONTENT in the 2.x shape with the hosted `claudeui` server
 *   and no `continue_loop_on_deny`;
 * - the parent environment inherited, XDG/HOME untouched (shared data dir);
 * - the process cwd is the server cwd, not the acquiring project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { McpHttpHost } from '../mcp-http-host'
import type { HarnessLaunch } from '../../harness/launch'

const { spawnMock, spawnCalls } = vi.hoisted(() => {
  const spawnCalls: {
    command: string
    args: string[]
    cwd: string
    stdio: unknown
    env: Record<string, string | undefined>
  }[] = []
  const spawnMock = vi.fn(
    (
      command: string,
      args: string[],
      opts: { env: NodeJS.ProcessEnv; cwd: string; stdio: unknown }
    ) => {
      spawnCalls.push({ command, args, cwd: opts.cwd, stdio: opts.stdio, env: { ...opts.env } })
      // Runs at call time, after the imports below are bound.
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      const stdout = new PassThrough()
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: () => true
      })
      setTimeout(() => stdout.write('{"url":"http://127.0.0.1:41234"}\n'), 0)
      return child as unknown as import('node:child_process').ChildProcess
    }
  )
  return { spawnMock, spawnCalls }
})

// Partial mock: other modules in this import graph pull real members out of
// node:child_process, so only `spawn` is replaced (on `default` too: CJS
// interop can read a named import off the default export).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const mocked = { ...actual, spawn: spawnMock }
  return { ...mocked, default: mocked }
})

const { OpencodeServerManager } = await import('../OpencodeServerManager')

function fakeMcpHost(): McpHttpHost {
  return { port: 19998, token: 'hosted-token', close: async () => {} }
}

describe('opencode serve --stdio spawn (default spawn path)', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    spawnMock.mockClear()
  })

  async function spawnOnce(
    launch: string | HarnessLaunch = '/fake/opencode'
  ): Promise<(typeof spawnCalls)[number]> {
    const manager = new OpencodeServerManager({
      locateBinaryFn: () => launch,
      startMcpHostFn: async () => fakeMcpHost(),
      configInputFn: () => ({ bridgedMcp: {}, pluginDir: '/res/opencode/claudeui-xeng' }),
      waitReadyFn: async () => ({ state: 'ready', signal: 'registry', elapsedMs: 0 }),
      waitGuardFn: async () => ({ state: 'active', elapsedMs: 0 }),
      serverCwd: '/server-home'
    })
    const conn = await manager.acquire('/some/project')
    expect(conn.baseUrl).toBe('http://127.0.0.1:41234')
    expect(conn.directory).toBe('/some/project')
    manager.dispose()
    expect(spawnCalls).toHaveLength(1)
    return spawnCalls[0]
  }

  it('spawns serve --stdio on loopback with piped stdin, in the server cwd', async () => {
    const call = await spawnOnce()
    expect(call.command).toBe('/fake/opencode')
    expect(call.args).toEqual(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'])
    expect(call.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.cwd).toBe('/server-home')
  })

  it('a node-script launch keeps its prefix and env', async () => {
    const call = await spawnOnce({
      command: '/usr/bin/node',
      args: ['/pkg/cli.js'],
      env: { LAUNCH_MARKER: '1' }
    })
    expect(call.command).toBe('/usr/bin/node')
    expect(call.args.slice(0, 3)).toEqual(['/pkg/cli.js', 'serve', '--stdio'])
    expect(call.env.LAUNCH_MARKER).toBe('1')
    expect(call.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
  })

  it('passes the password as OPENCODE_PASSWORD only', async () => {
    const { env } = await spawnOnce()
    expect(typeof env.OPENCODE_PASSWORD).toBe('string')
    expect(env.OPENCODE_PASSWORD!.length).toBeGreaterThan(20)
    expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD')
  })

  it('disables autoupdate and share by env', async () => {
    const { env } = await spawnOnce()
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(env.OPENCODE_DISABLE_SHARE).toBe('1')
  })

  it('injects the 2.x config: hosted claudeui + plugin dir, no continue_loop_on_deny', async () => {
    const { env } = await spawnOnce()
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      mcp?: { servers?: Record<string, Record<string, unknown>> }
      plugins?: string[]
      experimental?: unknown
      autoupdate?: unknown
    }
    expect(cfg.mcp?.servers?.claudeui).toMatchObject({
      type: 'remote',
      url: 'http://127.0.0.1:19998/mcp',
      headers: { Authorization: 'Bearer hosted-token' },
      codemode: false
    })
    expect(cfg.plugins).toEqual(['/res/opencode/claudeui-xeng'])
    expect(cfg).not.toHaveProperty('experimental')
    expect(cfg).not.toHaveProperty('autoupdate')
  })

  it('inherits the parent environment and leaves the data dir alone', async () => {
    process.env.CLAUDEUI_SPAWN_ENV_PROBE = 'inherited'
    try {
      const { env } = await spawnOnce()
      expect(env.CLAUDEUI_SPAWN_ENV_PROBE).toBe('inherited')
      expect(env.HOME).toBe(process.env.HOME)
      expect(env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME)
    } finally {
      delete process.env.CLAUDEUI_SPAWN_ENV_PROBE
    }
  })

  it('ends the server by closing its stdin (the --stdio lease)', async () => {
    const manager = new OpencodeServerManager({
      locateBinaryFn: () => '/fake/opencode',
      startMcpHostFn: async () => fakeMcpHost(),
      configInputFn: () => ({}),
      waitReadyFn: async () => ({ state: 'ready', signal: 'registry', elapsedMs: 0 }),
      waitGuardFn: async () => ({ state: 'active', elapsedMs: 0 })
    })
    await manager.acquire('/p')
    const child = spawnMock.mock.results[0].value as unknown as { stdin: PassThrough }
    let ended = false
    child.stdin.on('finish', () => (ended = true))
    manager.release('/p')
    await new Promise((r) => setTimeout(r, 0))
    expect(ended).toBe(true)
    manager.dispose()
  })
})
