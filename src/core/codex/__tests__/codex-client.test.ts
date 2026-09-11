// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient, type CodexClientOptions } from '../CodexAppServerClient'
import type { InitializeParams } from '../protocol/InitializeParams'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), locate: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../codex-locate', () => ({ locateCodexBinary: mocks.locate }))
class Child extends EventEmitter {
  pid = 45678
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
}
const init: InitializeParams = {
  clientInfo: { name: 'test', title: null, version: '1' },
  capabilities: null
}
const initialized = {
  userAgent: 'not-a-schema-version',
  codexHome: '/isolated',
  platformFamily: 'unix',
  platformOs: 'macos'
}
let app: Child
let version: Child
let client: CodexAppServerClient
let writes: Record<string, unknown>[]
let disconnect: ReturnType<typeof vi.fn<(error: Error) => void>>
const ticks = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function frame(value: unknown): void {
  app.stdout.write(JSON.stringify(value) + '\n')
}
async function start(options: Partial<CodexClientOptions> = {}): Promise<void> {
  client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect, ...options })
  const promise = client.start(init)
  version.stdout.write('codex-cli 0.154.0\n')
  version.emit('close', 0)
  await ticks()
  expect(writes[0]).toMatchObject({ id: 0, method: 'initialize' })
  expect(writes).toHaveLength(1)
  frame({ id: 0, result: initialized })
  await promise
  expect(writes[1]).toEqual({ method: 'initialized' })
}
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  app = new Child()
  version = new Child()
  writes = []
  disconnect = vi.fn()
  app.stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())))
  mocks.locate.mockReturnValue('/vendor/codex')
  mocks.spawn.mockReset().mockImplementation((command, args) => {
    if (command === 'taskkill') return new Child()
    return args[0] === '--version' ? version : app
  })
})
afterEach(() => {
  client?.dispose()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Codex JSONL client', () => {
  it('initializes once, validates executable version and replaces caller environment', async () => {
    await start({ env: { HOME: '/isolated' } })
    expect(mocks.spawn.mock.calls[0][2].env).toEqual({ HOME: '/isolated' })
    expect(mocks.spawn.mock.calls[1][2].env).toEqual({ HOME: '/isolated' })
    await expect(client.start(init)).rejects.toMatchObject({ code: 'one-shot-client' })
    client.dispose()
    client.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('accepts split UTF8, CRLF, multiple frames, U2028 and final response before stdout closes', async () => {
    const notification = vi.fn()
    await start({ onNotification: notification })
    const result = client.request('test')
    const bytes = Buffer.from(
      JSON.stringify({ id: 1, result: '\u96ea\u{1f600}\u2028end' }) +
        '\r\n' +
        JSON.stringify({ method: 'future/event', params: 1 }) +
        '\n'
    )
    for (const byte of bytes) app.stdout.write(Buffer.from([byte]))
    await expect(result).resolves.toBe('\u96ea\u{1f600}\u2028end')
    expect(notification).toHaveBeenCalledWith('future/event', 1)
    const last = client.request('last')
    app.stdout.end(JSON.stringify({ id: 2, result: 'last' }))
    await expect(last).resolves.toBe('last')
  })

  it('handles independent numeric/string server ids and unknown methods without confusing responses', async () => {
    await start({ serverMethods: ['tool'], onServerRequest: async () => ({ ok: true }) })
    const pending = client.request('wait')
    frame({ id: 1, method: 'tool', params: {} })
    frame({ id: '1', method: 'unknown' })
    await ticks()
    expect(writes).toContainEqual({ id: 1, result: { ok: true } })
    expect(writes).toContainEqual({ id: '1', error: { code: -32601, message: 'Method not found' } })
    frame({ id: 1, result: 'ours' })
    await expect(pending).resolves.toBe('ours')
  })

  it('resolves a final response arriving after child exit but before stdout end and close', async () => {
    await start()
    const pending = client.request('final-response')
    const resolution = expect(pending).resolves.toBe('after-exit')
    // Node may emit exit before the child's stdio has finished delivering data.
    app.emit('exit', 0)
    frame({ id: 1, result: 'after-exit' })
    app.stdout.end()
    app.emit('close', 0)
    await resolution
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['darwin', 'win32'])(
    'bounds post-exit draining when inherited stdout remains open on %s',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform })
      await start({ requestTimeoutMs: 10000, killGraceMs: 100 })
      const pending = client.request('never-responds')
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'process-exited',
        ambiguousDelivery: true
      })
      app.emit('exit', 0)
      // Allow trailing data first, but do not wait for the ordinary RPC timeout
      // when a descendant keeps the stdout pipe open without end/close events.
      expect.soft(disconnect).not.toHaveBeenCalled()
      expect.soft(app.stdout.destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(1001)
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(app.stdout.destroyed).toBe(true)
      await rejection
      client.dispose()
      app.emit('close', 0)
      expect(disconnect).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects start and remains closed when the initialized notification write throws', async () => {
    client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect })
    const promise = client.start(init)
    const rejection = expect(promise).rejects.toMatchObject({ code: 'write-error' })
    version.stdout.write('codex-cli 0.154.0\n')
    version.emit('close', 0)
    await ticks()
    expect(writes).toEqual([{ id: 0, method: 'initialize', params: init }])
    const write = app.stdin.write.bind(app.stdin)
    vi.spyOn(app.stdin, 'write').mockImplementation((...args) => {
      if (JSON.parse(String(args[0])).method === 'initialized') throw new Error('EPIPE')
      return write(...args)
    })
    frame({ id: 0, result: initialized })
    await rejection
    await expect(client.request('after-failed-start')).rejects.toMatchObject({ code: 'not-ready' })
    expect(disconnect).toHaveBeenCalledTimes(1)
    client.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('blocks new requests, server handlers and queued writes while draining after exit', async () => {
    let signal!: AbortSignal
    const handler = vi.fn<NonNullable<CodexClientOptions['onServerRequest']>>(
      async (_method, _params, context) => {
        signal = context.signal
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(null), { once: true })
        )
      }
    )
    await start({ serverMethods: ['tool'], onServerRequest: handler })
    frame({ id: 'existing', method: 'tool' })
    await ticks()
    vi.spyOn(app.stdin, 'write').mockReturnValue(false)
    const sent = client.request('sent')
    const resolution = expect(sent).resolves.toBe('trailing-result')
    const queued = client.request('queued')
    const rejection = expect(queued).rejects.toMatchObject({
      code: 'process-exited',
      ambiguousDelivery: false
    })
    app.emit('exit', 1)
    expect(signal.aborted).toBe(true)
    await expect(client.request('new')).rejects.toMatchObject({ code: 'not-ready' })
    frame({ id: 'new-tool', method: 'tool' })
    frame({ id: 'unknown-tool', method: 'unknown' })
    app.stdin.emit('drain')
    await ticks()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(app.stdin.write).toHaveBeenCalledTimes(1)
    frame({ id: 1, result: 'trailing-result' })
    app.emit('close', 1)
    await Promise.all([resolution, rejection])
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'process-exited' })
    )
  })

  it('does not become ready when initialize responds after process exit', async () => {
    client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect })
    const promise = client.start(init)
    const rejection = expect(promise).rejects.toMatchObject({ code: 'process-exited' })
    version.stdout.write('codex-cli 0.154.0\n')
    version.emit('close', 0)
    await ticks()
    app.emit('exit', 0)
    frame({ id: 0, result: initialized })
    await rejection
    await expect(client.request('new')).rejects.toMatchObject({ code: 'not-ready' })
    expect(writes.map((message) => message.method)).toEqual(['initialize'])
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('aborts resolved/owning-turn requests only and ignores late replies', async () => {
    const contexts: { signal: AbortSignal }[] = []
    let finish!: (value: unknown) => void
    await start({
      serverMethods: ['tool'],
      onServerRequest: async (_m, _p, context) => {
        contexts.push(context)
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    })
    frame({ id: 'parent', method: 'tool', params: { threadId: 'root', turnId: 'a' } })
    frame({ id: 'child', method: 'tool', params: { threadId: 'child', turnId: 'a' } })
    await ticks()
    client.abortServerRequests('root', 'a')
    expect(contexts[0].signal.aborted).toBe(true)
    expect(contexts[1].signal.aborted).toBe(false)
    frame({ method: 'serverRequest/resolved', params: { requestId: 'child' } })
    expect(contexts[1].signal.aborted).toBe(true)
    finish('late')
    await ticks()
    expect(writes.filter((m) => m.id === 'child')).toEqual([])
  })

  it('fails closed on duplicate incoming requests and aborts handlers on disconnect', async () => {
    let signal!: AbortSignal
    await start({
      serverMethods: ['tool'],
      onServerRequest: async (_m, _p, context) => {
        signal = context.signal
        return new Promise(() => {})
      }
    })
    frame({ id: 0, method: 'tool' })
    await ticks()
    frame({ id: 0, method: 'tool' })
    expect(signal.aborted).toBe(true)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['invalid-json', 'invalid-envelope', 'invalid-utf8', 'oversized'])(
    'redacts and closes %s',
    async (kind) => {
      await start({ maxFrameBytes: 512 })
      const promise = client.request('secret-request', { token: 'secret' })
      const rejection = expect(promise).rejects.toThrow(
        /^Codex transport: (invalid-frame-or-handler|frame-limit)$/
      )
      if (kind === 'invalid-json') app.stdout.write('secret token\n')
      if (kind === 'invalid-envelope') frame({ id: null, result: 'secret' })
      if (kind === 'invalid-utf8') app.stdout.write(Buffer.from([255, 10]))
      if (kind === 'oversized') app.stdout.write('x'.repeat(513))
      await rejection
      expect(JSON.stringify(disconnect.mock.calls)).not.toContain('secret')
    }
  )

  it('never exposes RPC error message/data or stderr', async () => {
    await start()
    const promise = client.request('test')
    app.stderr.write('secret-token')
    frame({ id: 1, error: { code: -123, message: 'secret-token', data: 'secret-token' } })
    await expect(promise).rejects.toThrow('Codex transport: rpc-error--123')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('distinguishes sent timeout from queued timeout and never writes expired queued work after drain', async () => {
    await start({ requestTimeoutMs: 100 })
    vi.spyOn(app.stdin, 'write').mockReturnValue(false)
    const sent = client.request('sent')
    const queued = client.request('must-not-run')
    const a = expect(sent).rejects.toMatchObject({
      code: 'request-timeout',
      ambiguousDelivery: true
    })
    const b = expect(queued).rejects.toMatchObject({
      code: 'request-timeout',
      ambiguousDelivery: false
    })
    await vi.advanceTimersByTimeAsync(101)
    await Promise.all([a, b])
    app.stdin.emit('drain')
    expect(app.stdin.write).toHaveBeenCalledTimes(1)
  })

  it('bounds requests/queued bytes and handles EPIPE without unhandled errors', async () => {
    await start({ maxPendingRequests: 1, maxQueuedBytes: 512 })
    const promise = client.request('wait')
    await expect(client.request('excess')).rejects.toMatchObject({ code: 'request-limit' })
    const rejection = expect(promise).rejects.toMatchObject({
      code: 'write-error',
      ambiguousDelivery: true
    })
    app.stdin.emit('error', new Error('EPIPE secret'))
    await rejection
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['close', 'error', 'dispose'])(
    'rejects pending work immediately on %s',
    async (event) => {
      await start()
      const promise = client.request('wait')
      const rejection = expect(promise).rejects.toBeInstanceOf(Error)
      if (event === 'dispose') client.dispose()
      else app.emit(event, event === 'error' ? new Error('private') : 1)
      await rejection
      expect(disconnect).toHaveBeenCalledTimes(1)
    }
  )

  it('reports idle exit once and escalates group kill even after root exit', async () => {
    await start()
    vi.mocked(process.kill).mockClear()
    app.emit('exit', 0)
    app.emit('close', 0)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(process.kill).toHaveBeenCalledWith(-45678, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(1001)
    expect(process.kill).toHaveBeenCalledWith(-45678, 'SIGKILL')
  })

  it('uses Windows taskkill ordering without killing the root first', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    await start()
    mocks.spawn.mockClear()
    client.dispose()
    expect(mocks.spawn).toHaveBeenCalledWith('taskkill', ['/pid', '45678', '/T', '/F'], {
      stdio: 'ignore'
    })
    expect(app.kill).not.toHaveBeenCalled()
  })

  it('bounds queued bytes without closing otherwise healthy transport', async () => {
    await start({ maxQueuedBytes: 256 })
    await expect(client.request('large', 'x'.repeat(257))).rejects.toMatchObject({
      code: 'queue-limit-or-serialization',
      ambiguousDelivery: false
    })
    expect(disconnect).not.toHaveBeenCalled()
    expect(writes).toHaveLength(2)
  })

  it('drops a completed handler reply still queued when its owning turn terminates', async () => {
    await start({ serverMethods: ['tool'], onServerRequest: async () => 'completed-result' })
    vi.spyOn(app.stdin, 'write').mockReturnValue(false)
    const pending = client.request('block-writes')
    frame({ id: 'tool-request', method: 'tool', params: { threadId: 'root', turnId: 'turn' } })
    await ticks()
    client.abortServerRequests('root', 'turn')
    app.stdin.emit('drain')
    expect(app.stdin.write).toHaveBeenCalledTimes(1)
    frame({ id: 1, result: null })
    await pending
  })

  it('times out initialization/version startup and rejects app spawn errors', async () => {
    client = new CodexAppServerClient({
      cwd: '/isolated',
      requestTimeoutMs: 100,
      onDisconnect: disconnect
    })
    const promise = client.start(init)
    const rejection = expect(promise).rejects.toMatchObject({ code: 'version-check-failed' })
    await vi.advanceTimersByTimeAsync(101)
    await rejection
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects asynchronous app-server startup failure after successful version check', async () => {
    client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect })
    const promise = client.start(init)
    const rejection = expect(promise).rejects.toMatchObject({ code: 'spawn-failed' })
    version.stdout.write('codex-cli 0.154.0\n')
    version.emit('close', 0)
    await ticks()
    app.emit('error', new Error('private-path'))
    await rejection
  })

  it.each(['mismatch', 'error', 'dispose', 'throw'])(
    'rejects startup %s without initializing',
    async (kind) => {
      client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect })
      if (kind === 'throw')
        mocks.spawn.mockReset().mockImplementation(() => {
          throw new Error('secret')
        })
      const promise = client.start(init)
      const rejection = expect(promise).rejects.toBeInstanceOf(Error)
      if (kind === 'mismatch') {
        version.stdout.write('codex-cli 99.0')
        version.emit('close', 0)
      }
      if (kind === 'error') version.emit('error', new Error('secret'))
      if (kind === 'dispose') client.dispose()
      await rejection
      expect(writes).toEqual([])
      expect(disconnect).toHaveBeenCalledTimes(1)
    }
  )
})
