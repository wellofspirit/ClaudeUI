/**
 * @vitest-environment node
 *
 * `opencode serve --stdio` spawn / listen-line parse / stdin-EOF teardown
 * (ADR-097 §2), against a fake child — no binary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn as realSpawn } from 'node:child_process'
import {
  buildServerEnv,
  endStdioServer,
  parseListenLine,
  SERVE_ARGS,
  spawnStdioServer
} from '../opencode-server-spawn'
import { nativeLaunch } from '../../harness/launch'

interface FakeChild extends ChildProcess {
  stdinEnded: boolean
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  const stdin = new PassThrough()
  child.stdinEnded = false
  stdin.on('finish', () => (child.stdinEnded = true))
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: vi.fn(() => true)
  })
  child.emitExit = (code, signal = null) => {
    Object.assign(child, { exitCode: code, signalCode: signal })
    child.emit('exit', code, signal)
  }
  return child
}

function fakeSpawn(child: FakeChild): {
  spawn: typeof realSpawn
  calls: { command: string; args: string[]; options: Record<string, unknown> }[]
} {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    return child
  }) as unknown as typeof realSpawn
  return { spawn, calls }
}

/** Write to a fake child's output pipe. */
const feed = (stream: unknown, text: string): boolean => (stream as PassThrough).write(text)

const OPTIONS = { cwd: '/home/u', password: 'pw-secret', configContent: '{"mcp":{}}' }

afterEach(() => {
  vi.useRealTimers()
})

describe('parseListenLine', () => {
  it('reads the --stdio JSON line', () => {
    expect(parseListenLine('{"url":"http://127.0.0.1:51504"}')).toBe('http://127.0.0.1:51504')
    expect(parseListenLine('  {"url":"http://127.0.0.1:51504/"}\r')).toBe('http://127.0.0.1:51504')
  })

  it("rejects 1.x's text line, junk, and anything that is not a loopback http URL", () => {
    expect(parseListenLine('opencode server listening on http://127.0.0.1:4096')).toBeNull()
    expect(parseListenLine('')).toBeNull()
    expect(parseListenLine('{"url":42}')).toBeNull()
    expect(parseListenLine('{"port":4096}')).toBeNull()
    expect(parseListenLine('{"url":"http://0.0.0.0:4096"}')).toBeNull()
    expect(parseListenLine('{"url":"https://127.0.0.1:4096"}')).toBeNull()
    expect(parseListenLine('{"url":"http://evil.example:4096"}')).toBeNull()
  })
})

describe('buildServerEnv', () => {
  it('passes the password as OPENCODE_PASSWORD, drops a legacy one, disables autoupdate, keeps the parent env', () => {
    const env = buildServerEnv(
      { PATH: '/bin', KEEP_ME: '1', OPENCODE_SERVER_PASSWORD: 'stale' },
      'pw',
      '{"x":1}'
    )
    expect(env.OPENCODE_PASSWORD).toBe('pw')
    expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD')
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"x":1}')
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(env.KEEP_ME).toBe('1')
  })

  it('never overrides the data dir (ADR-097 §6: shared with the user)', () => {
    const parent = { HOME: '/home/u', XDG_DATA_HOME: '/home/u/.xdg' }
    const env = buildServerEnv(parent, 'pw', '{}')
    expect(env.HOME).toBe('/home/u')
    expect(env.XDG_DATA_HOME).toBe('/home/u/.xdg')
    for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB'])
      expect(env).not.toHaveProperty(key)
  })
})

describe('spawnStdioServer', () => {
  it('spawns serve --stdio with piped stdin and resolves on the JSON url line', async () => {
    const child = fakeChild()
    const { spawn, calls } = fakeSpawn(child)
    const started = spawnStdioServer(nativeLaunch('/bin/opencode'), OPTIONS, {
      spawn,
      env: { PATH: '/bin' }
    })
    feed(child.stdout, 'some banner\n{"url":"http://127.0.0.1:40001"}\n')
    const result = await started
    expect(result.baseUrl).toBe('http://127.0.0.1:40001')
    expect(result.process).toBe(child)
    expect(calls[0].command).toBe('/bin/opencode')
    expect(calls[0].args).toEqual([...SERVE_ARGS])
    expect(calls[0].args).toEqual(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'])
    expect(calls[0].options.cwd).toBe('/home/u')
    expect(calls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    const env = calls[0].options.env as NodeJS.ProcessEnv
    expect(env.OPENCODE_PASSWORD).toBe('pw-secret')
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"mcp":{}}')
    // stdin is the lease: still open after start.
    expect(child.stdinEnded).toBe(false)
  })

  it('a node-script launch keeps its own argv prefix', async () => {
    const child = fakeChild()
    const { spawn, calls } = fakeSpawn(child)
    const started = spawnStdioServer(
      { command: '/usr/bin/node', args: ['/pkg/cli.js'], env: { MARK: '1' } },
      OPTIONS,
      { spawn, env: { PATH: '/bin' } }
    )
    feed(child.stdout, '{"url":"http://127.0.0.1:40002"}\n')
    await started
    expect(calls[0].args).toEqual(['/pkg/cli.js', ...SERVE_ARGS])
    expect((calls[0].options.env as NodeJS.ProcessEnv).MARK).toBe('1')
  })

  it('an exit before the url rejects with the stderr tail', async () => {
    const child = fakeChild()
    const { spawn } = fakeSpawn(child)
    const started = spawnStdioServer(nativeLaunch('/bin/opencode'), OPTIONS, { spawn, env: {} })
    feed(child.stderr, 'Error: config parse failed\n')
    await new Promise((r) => setImmediate(r))
    child.emitExit(1)
    await expect(started).rejects.toThrow(/exited before printing its URL.*config parse failed/s)
  })

  it('times out, kills what it started, and rejects', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const { spawn } = fakeSpawn(child)
    const started = spawnStdioServer(nativeLaunch('/bin/opencode'), OPTIONS, {
      spawn,
      env: {},
      listenTimeoutMs: 1000
    })
    const assertion = expect(started).rejects.toThrow(/printed no URL within 1000 ms/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(child.kill).toHaveBeenCalled()
  })

  it('a spawn error rejects', async () => {
    const child = fakeChild()
    const { spawn } = fakeSpawn(child)
    const started = spawnStdioServer(nativeLaunch('/bin/opencode'), OPTIONS, { spawn, env: {} })
    child.emit('error', new Error('ENOENT'))
    await expect(started).rejects.toThrow(/Failed to spawn opencode: ENOENT/)
  })
})

describe('endStdioServer', () => {
  it('closes stdin; a server that exits on its own is not killed', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const kill = vi.fn()
    const ended = endStdioServer(child, 5000, kill)
    expect(child.stdinEnded).toBe(false) // 'finish' is async
    await vi.advanceTimersByTimeAsync(0)
    expect(child.stdinEnded).toBe(true)
    child.emitExit(0)
    await expect(ended).resolves.toEqual({ forced: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(kill).not.toHaveBeenCalled()
  })

  it('tree-kills a server still running after the grace period', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const kill = vi.fn((c: ChildProcess) => (c as FakeChild).emitExit(null, 'SIGTERM'))
    const ended = endStdioServer(child, 5000, kill)
    await vi.advanceTimersByTimeAsync(4999)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill).toHaveBeenCalledWith(child)
    await expect(ended).resolves.toEqual({ forced: true })
  })

  it('is immediate for a process that already exited', async () => {
    const child = fakeChild()
    child.emitExit(0)
    const kill = vi.fn()
    await expect(endStdioServer(child, 5000, kill)).resolves.toEqual({ forced: false })
    expect(kill).not.toHaveBeenCalled()
  })
})
