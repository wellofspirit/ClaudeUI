// @vitest-environment node
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest'
import {
  CodexAppServerClient,
  type CodexClientOptions,
  type CodexTransportError
} from '../CodexAppServerClient'
import { CodexClient, CodexInjectionError } from '../CodexClient'
import { getLogDir, logger } from '../../services/logger'
import type { CodexAuthHook } from '../codex-auth-hook'
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
let warn: MockInstance<typeof logger.warn>
let debug: MockInstance<typeof logger.debug>
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
/**
 * Every client resolves a Codex home, because the first-run gate reads that
 * directory before it spawns. Point the whole file at a scratch home that
 * already holds a state database: no test touches the developer's real
 * `~/.codex`, and no test outside the gate's own block takes the gate.
 */
const initialisedHome = mkdtempSync(join(tmpdir(), 'codex-client-home-'))
writeFileSync(join(initialisedHome, 'state_5.sqlite'), '')
const savedCodexHome = process.env.CODEX_HOME
afterAll(() => {
  rmSync(initialisedHome, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.CODEX_HOME = initialisedHome
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  app = new Child()
  version = new Child()
  writes = []
  disconnect = vi.fn()
  // Silenced as well as observed: a death line would otherwise print, and
  // append to the shared vitest log dir, once per teardown in this file.
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  // The spawn line is a debug line; silenced for the same reason, and observed
  // by the caller-label guards below.
  debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
  app.stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())))
  mocks.locate.mockReturnValue('/vendor/codex')
  mocks.spawn.mockReset().mockImplementation((command, args) => {
    if (command === 'taskkill') return new Child()
    return args[0] === '--version' ? version : app
  })
})
afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
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

  it('reports disposal, not a version-check failure, when disposed mid-probe', async () => {
    // `fail('disposed')` stamps closedError BEFORE tripping stopVersion, so the
    // probe must surface that reason instead of minting its own generic code.
    client = new CodexAppServerClient({ cwd: '/isolated', onDisconnect: disconnect })
    const promise = client.start(init)
    const rejection = expect(promise).rejects.toMatchObject({ code: 'disposed' })
    client.dispose()
    await rejection
    expect(writes).toEqual([])
    expect(disconnect).toHaveBeenCalledTimes(1)
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

/**
 * Slice 2a guard 1 — ChatGPT token injection on the REAL transport (ADR-068 §1).
 *
 * `CodexClient.start` is what every app-server ClaudeUI owns goes through, so
 * this is the one place the order is provable: handshake, then
 * `account/login/start`, then — and only then — a resolved `start()`. The child
 * process is the same mocked pair the suite above drives; no binary, no vault
 * and no token that could be mistaken for a real one.
 */
describe('ChatGPT token injection', () => {
  let typed: CodexClient
  function hook(token: Awaited<ReturnType<CodexAuthHook['inject']>>): CodexAuthHook {
    return {
      inject: vi.fn(async () => token),
      onRefreshRequest: vi.fn(),
      requestAccount: vi.fn(),
      hasAccount: vi.fn(async () => true),
      injectedAccountId: token?.vaultAccountId ?? null
    }
  }
  /** Drives the handshake and hands the STILL-PENDING `start()` back, boxed. */
  async function handshake(
    auth: CodexAuthHook
  ): Promise<{ started: ReturnType<CodexClient['start']> }> {
    typed = new CodexClient({ cwd: '/isolated', onDisconnect: disconnect })
    const started = typed.start(init, auth)
    void started.catch(() => {})
    version.stdout.write('codex-cli 0.154.0\n')
    version.emit('close', 0)
    await ticks()
    frame({ id: 0, result: initialized })
    await ticks()
    return { started }
  }
  afterEach(() => typed?.dispose())

  it('sends initialize, then exactly the injected triple, and resolves only after the login response', async () => {
    const { started } = await handshake(
      hook({
        accessToken: 'fake-access-jwt',
        chatgptAccountId: 'ws-fixture',
        chatgptPlanType: 'pro',
        vaultAccountId: 'acct-fixture'
      })
    )
    expect(writes[0]).toMatchObject({ id: 0, method: 'initialize' })
    expect(writes[1]).toEqual({ method: 'initialized' })
    expect(writes[2]).toEqual({
      id: 1,
      method: 'account/login/start',
      params: {
        type: 'chatgptAuthTokens',
        accessToken: 'fake-access-jwt',
        chatgptAccountId: 'ws-fixture',
        chatgptPlanType: 'pro'
      }
    })
    // Nothing may run under the previous identity: `start` is still pending.
    let settled = false
    void started.then(() => (settled = true))
    await ticks()
    expect(settled).toBe(false)
    frame({ id: 1, result: {} })
    await started
  })

  it('surfaces a native refusal verbatim and disposes the process', async () => {
    const { started } = await handshake(
      hook({
        accessToken: 'fake-access-jwt',
        chatgptAccountId: 'ws-wrong',
        chatgptPlanType: null,
        vaultAccountId: 'acct-fixture'
      })
    )
    const native =
      'External auth must use one of workspace(s) ["ws-forced"], but received "ws-wrong".'
    frame({ id: 1, error: { code: -32600, message: native } })
    await expect(started).rejects.toThrow(native)
    await expect(started).rejects.toBeInstanceOf(CodexInjectionError)
    // No retry and no fallback to native auth: the process is gone, and nothing
    // can be sent under the identity Codex just refused.
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'disposed' })
    )
    await expect(typed.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: 'not-ready'
    })
  })

  it('sends no login at all when the vault has nothing to inject', async () => {
    const auth = hook(null)
    const { started } = await handshake(auth)
    await started
    expect(auth.inject).toHaveBeenCalledOnce()
    expect(writes.map((write) => write.method)).toEqual(['initialize', 'initialized'])
  })
})

/**
 * F7 — why an app-server died, and the opt-in stderr file.
 *
 * The hygiene rule above (`never exposes RPC error message/data or stderr`) is
 * the constraint these three live under: the death line may name the capture
 * file's PATH and nothing else out of the child, and with the flag unset no
 * file exists at all. The marker below stands in for the key fragment Codex's
 * stderr can carry.
 */
describe('app-server death reporting', () => {
  const MARKER = 'stderr-secret-token-f7'
  const captureFile = (): string => join(getLogDir(), 'codex-stderr-45678.log')
  /** The transport error a pending request rejected with. */
  const rejection = (promise: Promise<unknown>): Promise<CodexTransportError> =>
    promise.then(
      () => {
        throw new Error('expected the request to reject')
      },
      (error: CodexTransportError) => error
    )
  /**
   * EOF on stdout, the way a dying app-server delivers it: BEFORE its `exit`
   * (this is what makes the observed failure `stdout-closed` rather than
   * `process-exited`). A stream's `end` event lands on the next macrotask, so
   * eight promise ticks are not enough to see it.
   */
  const endStdout = async (): Promise<void> => {
    app.stdout.end()
    await vi.advanceTimersByTimeAsync(0)
  }
  /** No file under the log dir may hold the marker — not just the capture file. */
  function assertNoFileHoldsMarker(): void {
    const dir = getLogDir()
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const info = statSync(path)
      // A day's log is capped at 50 MB; skip anything that big rather than
      // read it, the capture file would be tiny.
      if (!info.isFile() || info.size > 4 * 1024 * 1024) continue
      expect(readFileSync(path, 'utf-8')).not.toContain(MARKER)
    }
  }

  it('reports the failure code, exit status, pid and readiness in one warn line', async () => {
    await start()
    const failed = rejection(client.request('never-answered'))
    app.stderr.write(MARKER)
    await endStdout()
    // The client is already closed, but the exit code is what makes the line
    // worth having, so the report waits for it.
    expect(warn).not.toHaveBeenCalled()
    app.emit('exit', 101, null)

    const error = await failed
    expect(error.code).toBe('stdout-closed')
    expect(error.exitCode).toBe(101)
    expect(error.exitSignal).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const [source, line] = warn.mock.calls[0]
    expect(source).toBe('CodexAppServerClient')
    expect(line).toContain('stdout-closed')
    expect(line).toContain('exit=101')
    expect(line).toContain('pid=45678')
    expect(line).toContain('ready=true')
    expect(line).toContain('cwd=/isolated')
    expect(line).not.toContain(MARKER)
    expect(line).not.toContain('stderr=')
  })

  it('reports "still running" when the child outlives the grace, and only once', async () => {
    await start()
    app.stdout.emit('close')
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1001)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toContain('exit=still running')
    app.emit('exit', 0, null)
    app.emit('close', 0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the client closed the process itself', async () => {
    await start()
    client.dispose()
    app.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('copies stderr to an opt-in file and puts only its path in the line', async () => {
    const saved = process.env.CLAUDEUI_CODEX_STDERR
    process.env.CLAUDEUI_CODEX_STDERR = '1'
    rmSync(captureFile(), { force: true })
    try {
      await start()
      app.stderr.write(`${MARKER}\n`)
      await ticks()
      expect(existsSync(captureFile())).toBe(true)
      expect(readFileSync(captureFile(), 'utf-8')).toContain(MARKER)

      await endStdout()
      app.emit('exit', 1, null)
      const line = warn.mock.calls[0][1]
      expect(line).toContain(`stderr=${captureFile()}`)
      expect(line).not.toContain(MARKER)
    } finally {
      if (saved === undefined) delete process.env.CLAUDEUI_CODEX_STDERR
      else process.env.CLAUDEUI_CODEX_STDERR = saved
      rmSync(captureFile(), { force: true })
    }
  })

  it('keeps capturing stderr that arrives after `exit`, until the stream itself ends', async () => {
    // Node delivers `exit` before the stdio streams drain, and a crash message is
    // exactly the chunk that lands in that window; closing the file on `exit`
    // would drop the one line the flag exists to keep.
    const saved = process.env.CLAUDEUI_CODEX_STDERR
    process.env.CLAUDEUI_CODEX_STDERR = '1'
    rmSync(captureFile(), { force: true })
    try {
      await start()
      app.stderr.write('before-exit\n')
      await ticks()
      await endStdout()
      app.emit('exit', 101, null)
      app.stderr.write('after-exit-panic-line\n')
      await vi.advanceTimersByTimeAsync(0)
      app.stderr.end()
      await vi.advanceTimersByTimeAsync(0)
      expect(readFileSync(captureFile(), 'utf-8')).toContain('after-exit-panic-line')
    } finally {
      if (saved === undefined) delete process.env.CLAUDEUI_CODEX_STDERR
      else process.env.CLAUDEUI_CODEX_STDERR = saved
      rmSync(captureFile(), { force: true })
    }
  })

  it('writes no file and leaks the stderr nowhere with the flag unset', async () => {
    const saved = process.env.CLAUDEUI_CODEX_STDERR
    delete process.env.CLAUDEUI_CODEX_STDERR
    rmSync(captureFile(), { force: true })
    try {
      await start()
      const failed = rejection(client.request('never-answered'))
      app.stderr.write(MARKER)
      await endStdout()
      app.emit('exit', 2, null)
      await failed

      expect(existsSync(captureFile())).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER)
      expect(JSON.stringify(disconnect.mock.calls)).not.toContain(MARKER)
      assertNoFileHoldsMarker()
    } finally {
      if (saved !== undefined) process.env.CLAUDEUI_CODEX_STDERR = saved
    }
  })
})

/**
 * F8. Codex creates its sqlite state runtime on the FIRST app-server start in a
 * home; a second one racing it exits 1 (`failed to initialize sqlite state
 * runtime under <home>`). ClaudeUI's boot starts three within milliseconds, so
 * the transport serialises the first start per home.
 */
describe('first app-server on a Codex home with no state database', () => {
  const homes: string[] = []
  const clients: CodexAppServerClient[] = []
  let apps: Child[]
  let versions: Child[]

  const makeHome = (initialised: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-first-run-'))
    homes.push(dir)
    // The versioned state database an initialised home holds — its presence is
    // the whole signal, its content is never read.
    if (initialised) writeFileSync(join(dir, 'state_5.sqlite'), '')
    return dir
  }

  /**
   * Start a client on `home` and answer its `codex --version` probe, which
   * `start()` spawns synchronously, before it consults the gate.
   */
  const startOn = (home: string): { client: CodexAppServerClient; ready: Promise<unknown> } => {
    const client = new CodexAppServerClient({ cwd: '/isolated', env: { CODEX_HOME: home } })
    clients.push(client)
    const ready = client.start(init)
    // Teardown rejects whatever is still pending; that must not surface as an
    // unhandled rejection in a test that never awaited it.
    ready.catch(() => {})
    const probe = versions[versions.length - 1]
    probe.stdout.write('codex-cli 0.154.0\n')
    probe.emit('close', 0)
    return { client, ready }
  }

  const answerInitialize = (child: Child): void => {
    child.stdout.write(JSON.stringify({ id: 0, result: initialized }) + '\n')
  }

  beforeEach(() => {
    apps = []
    versions = []
    // One fresh child per spawn: these tests run several app-servers at once.
    mocks.spawn.mockReset().mockImplementation((command: string, args: string[]) => {
      if (command === 'taskkill') return new Child()
      const child = new Child()
      if (args[0] === '--version') versions.push(child)
      else apps.push(child)
      return child
    })
  })

  afterEach(() => {
    for (const each of clients) each.dispose()
    clients.length = 0
    for (const dir of homes) rmSync(dir, { recursive: true, force: true })
    homes.length = 0
  })

  it('holds the second start until the first has answered initialize', async () => {
    const home = makeHome(false)
    const first = startOn(home)
    const second = startOn(home)
    await ticks()
    expect(apps).toHaveLength(1)

    answerInitialize(apps[0])
    await expect(first.ready).resolves.toMatchObject({ codexHome: '/isolated' })
    await ticks()
    expect(apps).toHaveLength(2)
    answerInitialize(apps[1])
    await expect(second.ready).resolves.toMatchObject({ codexHome: '/isolated' })
  })

  it('spawns both at once on a home that already holds a state database', async () => {
    const home = makeHome(true)
    const first = startOn(home)
    const second = startOn(home)
    await ticks()
    expect(apps).toHaveLength(2)
    answerInitialize(apps[0])
    answerInitialize(apps[1])
    await expect(first.ready).resolves.toBeTruthy()
    await expect(second.ready).resolves.toBeTruthy()
  })

  it('lets the next start through when the holder dies before initialize', async () => {
    const home = makeHome(false)
    const first = startOn(home)
    const second = startOn(home)
    await ticks()
    expect(apps).toHaveLength(1)

    apps[0].stdout.end()
    await vi.advanceTimersByTimeAsync(0)
    await expect(first.ready).rejects.toMatchObject({ code: 'stdout-closed' })
    await ticks()
    expect(apps).toHaveLength(2)
    answerInitialize(apps[1])
    await expect(second.ready).resolves.toBeTruthy()
  })

  it('lets the next start through when the holder is disposed before initialize', async () => {
    const home = makeHome(false)
    const first = startOn(home)
    await ticks()
    expect(apps).toHaveLength(1)
    first.client.dispose()
    await expect(first.ready).rejects.toMatchObject({ code: 'disposed' })

    const second = startOn(home)
    await ticks()
    expect(apps).toHaveLength(2)
    answerInitialize(apps[1])
    await expect(second.ready).resolves.toBeTruthy()
  })

  it('rejects a waiting client that is disposed, without ever spawning it', async () => {
    const home = makeHome(false)
    const first = startOn(home)
    const second = startOn(home)
    await ticks()
    expect(apps).toHaveLength(1)

    second.client.dispose()
    await expect(second.ready).rejects.toMatchObject({ code: 'disposed' })
    // Not even after the holder releases the gate.
    answerInitialize(apps[0])
    await expect(first.ready).resolves.toBeTruthy()
    await ticks()
    expect(apps).toHaveLength(1)
  })

  it('hands the gate to ONE waiter when the holder dies, so the waiters do not race each other', async () => {
    // Three boot-time starts, the holder dies before initialize: the home is
    // still uninitialised, so letting both waiters through at once would
    // recreate exactly the race the gate exists to remove.
    const home = makeHome(false)
    const first = startOn(home)
    const second = startOn(home)
    const third = startOn(home)
    await ticks()
    expect(apps).toHaveLength(1)

    apps[0].stdout.end()
    await vi.advanceTimersByTimeAsync(0)
    await expect(first.ready).rejects.toMatchObject({ code: 'stdout-closed' })
    await ticks()
    expect(apps).toHaveLength(2)

    answerInitialize(apps[1])
    await ticks()
    expect(apps).toHaveLength(3)
    answerInitialize(apps[2])
    await expect(second.ready).resolves.toBeTruthy()
    await expect(third.ready).resolves.toBeTruthy()
  })

  it('never makes one home wait on another', async () => {
    const first = startOn(makeHome(false))
    const second = startOn(makeHome(false))
    await ticks()
    expect(apps).toHaveLength(2)
    answerInitialize(apps[0])
    answerInitialize(apps[1])
    await expect(first.ready).resolves.toBeTruthy()
    await expect(second.ready).resolves.toBeTruthy()
  })
})

/**
 * F9. About ten call sites build a client, and every app-server they start
 * looks alike in the log. Each one names itself, so a death line says WHOSE
 * app-server died.
 */
describe('caller label on every app-server spawn', () => {
  /** The transport error a pending request rejected with. */
  const rejection = (promise: Promise<unknown>): Promise<CodexTransportError> =>
    promise.then(
      () => {
        throw new Error('expected the request to reject')
      },
      (error: CodexTransportError) => error
    )
  /**
   * Kill the child the way a dying app-server does — EOF on stdout, then the
   * exit the death line waits for — and hand back the rejected transport error.
   */
  const die = async (): Promise<CodexTransportError> => {
    const failed = rejection(client.request('never-answered'))
    app.stdout.end()
    await vi.advanceTimersByTimeAsync(0)
    app.emit('exit', 1, null)
    return failed
  }
  const spawnLines = (): string[] =>
    debug.mock.calls
      .filter(
        ([source, line]) =>
          source === 'CodexAppServerClient' && line.startsWith('app-server spawned:')
      )
      .map(([, line]) => line)

  it('logs one spawn line per start, naming the caller', async () => {
    await start({ label: 'auth-probe' })
    expect(spawnLines()).toEqual(['app-server spawned: auth-probe pid=45678 cwd=/isolated'])
  })

  it('names the caller in the death line and on the transport error', async () => {
    await start({ label: 'lineage-scan' })
    const error = await die()
    expect(error.label).toBe('lineage-scan')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toContain('label=lineage-scan')
  })

  it('reads unlabelled on the death line and the error when the site named nobody', async () => {
    await start()
    const error = await die()
    expect(error.label).toBe('unlabelled')
    expect(warn.mock.calls[0][1]).toContain('label=unlabelled')
  })

  it('reads unlabelled on the spawn line when the site named nobody', async () => {
    await start()
    expect(spawnLines()).toEqual(['app-server spawned: unlabelled pid=45678 cwd=/isolated'])
  })

  it('drops a label that is not a bare identifier rather than logging it', async () => {
    // The label reaches the log, so it may never carry a path, an account or
    // anything else the user typed — whatever a future call site passes.
    await start({ label: '/Users/someone/.codex' })
    expect(spawnLines()).toEqual(['app-server spawned: unlabelled pid=45678 cwd=/isolated'])
    const error = await die()
    expect(error.label).toBe('unlabelled')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('someone')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('someone')
  })
})
