import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexClientOptions } from '../CodexAppServerClient'
import { CodexTransportError } from '../CodexAppServerClient'
import { CodexService, type CodexHostSource } from '../CodexService'
import { CodexClient } from '../CodexClient'
import type { CodexHost, CodexHostAcquireOptions, CodexHostHandle } from '../CodexHost'

const mocks = vi.hoisted(() => ({
  clients: [] as {
    options: CodexClientOptions
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }[],
  request: vi.fn(),
  start: vi.fn()
}))
// Only `startLogin` still builds a client of its own (ADR-069 §3: a login must
// run on a process nothing has injected). Every READ goes through the fake host
// registry below.
vi.mock('../CodexClient', () => ({
  CodexClient: class {
    constructor(public options: CodexClientOptions) {
      mocks.clients.push(this)
    }
    request = vi.fn((method, params) => mocks.request(method, params))
    start = vi.fn(() => mocks.start())
    dispose = vi.fn()
  }
}))

/**
 * A fake {@link CodexHostRegistry}: one entry per account key, so a test can
 * assert what the service SHARES and what it does not.
 *
 * The contract the old one-client-per-read assertions pinned has moved here:
 * a read no longer owns a process, it borrows the host for its home and account
 * and gives the lease back. `live` is what a `finally` must return to zero.
 */
type FakeHost = { key: string; acquires: number; live: number; requests: string[] }
const hosts = {
  entries: new Map<string, FakeHost>(),
  order: [] as string[],
  labels: [] as (string | undefined)[],
  /** Set to make the next acquire fail, the way a missing binary does. */
  failAcquire: null as Error | null,
  get(key: string): FakeHost {
    const host = this.entries.get(key)
    if (!host) throw new Error(`no host for ${key}`)
    return host
  },
  reset(): void {
    this.entries.clear()
    this.order.length = 0
    this.labels.length = 0
    this.failAcquire = null
  }
}
/**
 * The registry's key rule, standing in for the real one: an absent identity is
 * the uninjected host, and `{ accountId: null }` is the ACTIVE account, which the
 * real registry resolves to a concrete vault id at acquire time (or to `native`
 * when the vault holds none).
 */
const hostKey = (options: CodexHostAcquireOptions): string =>
  options.identity ? (options.identity.accountId ?? 'acct-active') : 'native'
const registry: CodexHostSource = {
  acquire: async (options: CodexHostAcquireOptions = {}) => {
    if (hosts.failAcquire) throw hosts.failAcquire
    const key = hostKey(options)
    let host = hosts.entries.get(key)
    if (!host) {
      host = { key, acquires: 0, live: 0, requests: [] }
      hosts.entries.set(key, host)
      hosts.order.push(key)
    }
    host.acquires++
    host.live++
    hosts.labels.push(options.label)
    let released = false
    const entry = host
    return {
      host: undefined as unknown as CodexHost,
      // A host the vault could not inject reports no identity — `acct-gone`
      // stands in for that, exactly as it does in the real hook.
      injectedAccountId: key === 'native' || key === 'acct-gone' ? null : key,
      request: (method: string, params: unknown) => {
        entry.requests.push(method)
        return mocks.request(method, params)
      },
      release: () => {
        if (released) return
        released = true
        entry.live--
      }
    } as unknown as CodexHostHandle
  }
}

afterEach(() => {
  vi.useRealTimers()
  mocks.clients.length = 0
  mocks.request.mockReset()
  mocks.start.mockReset()
  hosts.reset()
})
const options = { cwd: '/isolated', registry }
const notify = (loginId: string | null, success = true) =>
  mocks.clients.at(-1)!.options.onNotification?.('account/login/completed', {
    loginId,
    success,
    error: 'synthetic-secret-not-public'
  })

describe('read service ownership', () => {
  it('reads every full native history page without resuming the thread', async () => {
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return { thread: { id: 'root', historyMode: 'paginated' } }
      return params.cursor
        ? { data: [{ id: 'second', items: [], itemsView: 'full' }], nextCursor: null }
        : { data: [{ id: 'first', items: [], itemsView: 'full' }], nextCursor: 'next' }
    })
    const thread = await new CodexService(options).history('root')
    expect(thread.turns.map((turn) => turn.id)).toEqual(['first', 'second'])
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
      'thread/read',
      'thread/turns/list',
      'thread/turns/list'
    ])
    expect(mocks.request).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'root',
      cursor: 'next',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full'
    })
  })
  it('writes config.toml and reads it back on ONE client, in that order', async () => {
    // ADR-068 §6: the settings page re-reads after every write, and `read()`
    // disposes its client the moment the last user drops — so a write followed
    // by a SEPARATE read would start two app-server children per toggle click
    // (~2.4 s each on the pinned binary). Both requests belong to one operation.
    mocks.request.mockImplementation(async (method) =>
      method === 'config/batchWrite'
        ? { status: 'ok', version: 'v2', filePath: '/c.toml', overriddenMetadata: null }
        : { config: {}, origins: {}, layers: [] }
    )
    const result = await new CodexService(options).batchWriteConfigAndRead(
      {
        edits: [{ keyPath: 'model_verbosity', value: 'high', mergeStrategy: 'replace' }],
        expectedVersion: 'v1',
        reloadUserConfig: true
      },
      '/home/u'
    )
    // One host, ONE lease: both requests belong to a single `read()` operation.
    expect(hosts.order).toEqual(['native'])
    expect(hosts.get('native').acquires).toBe(1)
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
      'config/batchWrite',
      'config/read'
    ])
    expect(mocks.request).toHaveBeenLastCalledWith('config/read', {
      includeLayers: true,
      cwd: '/home/u'
    })
    expect(result.write.version).toBe('v2')
    expect(result.read.layers).toEqual([])
    expect(hosts.get('native').live).toBe(0)
  })

  it('never reads back a write the binary refused', async () => {
    // There is nothing new to show, and a read after a refusal would hand the
    // caller a snapshot that looks like a successful write.
    mocks.request.mockImplementation(async (method) => {
      if (method === 'config/batchWrite') throw new CodexTransportError('rpc-error--32600')
      return { config: {}, origins: {}, layers: [] }
    })
    await expect(
      new CodexService(options).batchWriteConfigAndRead({
        edits: [],
        expectedVersion: 'v1',
        reloadUserConfig: true
      })
    ).rejects.toBeInstanceOf(CodexTransportError)
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual(['config/batchWrite'])
  })

  it('retains a shared reader until the final parallel request settles', async () => {
    let complete!: (result: unknown) => void
    mocks.request.mockImplementation((method) =>
      method === 'account/read'
        ? Promise.resolve({ account: null, requiresOpenaiAuth: true })
        : new Promise((resolve) => {
            complete = resolve
          })
    )
    const service = new CodexService(options)
    const account = service.accountStatus()
    const catalog = service.models()
    await account
    // One host serves both reads; the settled one gives its lease back and the
    // host stays warm for the one still in flight (ADR-069 §3).
    expect(hosts.order).toEqual(['native'])
    expect(hosts.get('native').live).toBe(1)
    complete({ data: [], nextCursor: null })
    await catalog
    expect(hosts.get('native').live).toBe(0)
  })
  it('coalesces status only while pending, uses refresh false and strips account metadata', async () => {
    mocks.request.mockResolvedValue({
      account: { type: 'chatgpt', email: 'private@example.invalid', extra: 'secret' },
      requiresOpenaiAuth: true
    })
    const service = new CodexService(options)
    const first = service.accountStatus()
    expect(service.accountStatus()).toBe(first)
    expect(await first).toEqual({
      available: true,
      authenticated: true,
      authKind: 'chatgpt',
      requiresLogin: false
    })
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('account/read', { refreshToken: false })
    expect(hosts.get('native').live).toBe(0)
    await service.accountStatus()
    // A second read is a second LEASE, never a second process.
    expect(hosts.order).toEqual(['native'])
    expect(hosts.get('native').acquires).toBe(2)
    service.dispose()
  })

  it('shares parallel read connection and never resumes or starts history', async () => {
    mocks.request.mockImplementation(async (method) =>
      method === 'account/read'
        ? { account: null, requiresOpenaiAuth: false }
        : method === 'model/list'
          ? { data: [], nextCursor: null }
          : { thread: { id: 'root-native' } }
    )
    const service = new CodexService(options)
    const [status, models, history] = await Promise.all([
      service.accountStatus(),
      service.models(),
      service.readThread({ threadId: 'root-native', includeTurns: true })
    ])
    expect(status).toMatchObject({ authenticated: false, requiresLogin: false })
    expect(models).toEqual([])
    expect(history.thread.id).toBe('root-native')
    expect(hosts.order).toEqual(['native'])
    expect(hosts.get('native').acquires).toBe(3)
    expect(mocks.request.mock.calls.map((call) => call[0]).sort()).toEqual([
      'account/read',
      'model/list',
      'thread/read'
    ])
    // Every lease is handed back, or the host could never idle out.
    expect(hosts.get('native').live).toBe(0)
  })

  it('preserves paginated native effort metadata and an undiscovered explicit model', async () => {
    const model = {
      model: 'native-model',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'native' }]
    }
    mocks.request
      .mockResolvedValueOnce({ data: [model], nextCursor: 'page2' })
      .mockResolvedValueOnce({ data: [], nextCursor: null })
    const service = new CodexService(options)
    const catalog = service.models()
    expect(service.models()).toBe(catalog)
    expect(await catalog).toEqual([model])
    expect(mocks.request).toHaveBeenLastCalledWith('model/list', {
      cursor: 'page2',
      limit: 100,
      includeHidden: false
    })
    mocks.request.mockImplementation(async (method) =>
      method === 'config/read'
        ? { config: { model: null, model_provider: 'openai' } }
        : { data: [], nextCursor: null }
    )
    expect(await service.modelOptions('explicit-custom')).toEqual({
      model: 'explicit-custom',
      catalog: []
    })
    expect(await service.modelOptions()).toEqual({ model: undefined, catalog: [] })
  })

  it('bounds repeated cursors and redacts all read failures', async () => {
    mocks.request.mockResolvedValue({ data: [], nextCursor: 'same' })
    const service = new CodexService(options)
    await expect(service.models()).rejects.toThrow('service-read-failed')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    mocks.request.mockRejectedValue(new Error('synthetic-secret'))
    expect(await service.accountStatus()).toEqual({ available: false, failure: 'native-error' })
    hosts.failAcquire = new CodexTransportError('binary-unavailable')
    expect(await service.accountStatus()).toEqual({ available: false, failure: 'unavailable' })
  })

  /**
   * Redaction is about PAYLOADS, not about the transport's own taxonomy.
   * `CodexTransportError` codes are payload-free by construction in
   * `CodexAppServerClient` — literals, plus `rpc-error-<n>` built from a code
   * the frame reader has already proven to be a safe integer — so collapsing
   * them all into `service-read-failed` threw away the only signal a caller
   * (or a delete/archive probe) has for telling "the native binary refused
   * this" apart from "the read broke".
   */
  it('keeps a transport error CODE intact and still redacts everything else', async () => {
    const service = new CodexService(options)
    mocks.request.mockRejectedValue(new CodexTransportError('rpc-error--32600'))
    await expect(service.models()).rejects.toThrow('Codex transport: rpc-error--32600')
    mocks.request.mockRejectedValue(new CodexTransportError('request-timeout'))
    await expect(service.effectiveConfig()).rejects.toThrow('Codex transport: request-timeout')
    // A NON-transport throw is still redacted — that is where native payloads,
    // config values and caller strings could ride out.
    mocks.request.mockRejectedValue(new Error('synthetic-secret'))
    await expect(service.effectiveConfig()).rejects.toThrow('service-read-failed')
    await expect(service.effectiveConfig()).rejects.not.toThrow('synthetic-secret')
  })

  it('only exposes selected config fields', async () => {
    mocks.request.mockResolvedValue({
      config: { model: 'native', private_key: 'synthetic-secret', model_provider: 'openai' }
    })
    const result = await new CodexService(options).effectiveConfig()
    expect(result).toMatchObject({ model: 'native', model_provider: 'openai' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
})

describe('native login lifecycle', () => {
  it('never exposes native start errors and releases the failed connection', async () => {
    mocks.request.mockRejectedValue(new Error('synthetic-secret-from-provider'))
    const login = new CodexService(options).startLogin({ type: 'chatgpt' })
    await expect(login.started).rejects.toThrow('Codex transport: login-start-failed')
    expect(await login.completed).toEqual({ status: 'failed' })
    expect(mocks.clients[0].dispose).toHaveBeenCalledOnce()
  })
  it.each(['chatgpt', 'chatgptDeviceCode'] as const)(
    'retains %s connection until matching completion',
    async (type) => {
      mocks.request.mockResolvedValue({
        type,
        loginId: 'login',
        authUrl: 'https://auth.invalid/',
        verificationUrl: 'https://auth.invalid/device',
        userCode: 'fixture-code',
        extra: 'synthetic-secret'
      })
      const service = new CodexService(options)
      const login = service.startLogin({ type })
      expect(await login.started).not.toHaveProperty('extra')
      expect(mocks.clients[0].dispose).not.toHaveBeenCalled()
      expect(() => service.startLogin({ type })).toThrow('login-in-progress')
      notify('unrelated')
      expect(mocks.clients[0].dispose).not.toHaveBeenCalled()
      notify('login')
      expect(await login.completed).toEqual({ status: 'completed' })
      expect(mocks.clients[0].dispose).toHaveBeenCalledOnce()
    }
  )

  it('correlates completion before start response and ignores raw error data', async () => {
    mocks.request.mockImplementation(async () => {
      notify('login', false)
      return { type: 'chatgpt', loginId: 'login', authUrl: 'https://auth.invalid/' }
    })
    const login = new CodexService(options).startLogin({ type: 'chatgpt' })
    await login.started
    expect(await login.completed).toEqual({ status: 'failed' })
  })

  it('awaits API-key completion with null login identity, without exporting input', async () => {
    mocks.request.mockResolvedValue({ type: 'apiKey' })
    const login = new CodexService(options).startLogin({
      type: 'apiKey',
      apiKey: 'synthetic-not-a-key'
    })
    expect(await login.started).toEqual({ type: 'apiKey' })
    expect(mocks.clients[0].dispose).not.toHaveBeenCalled()
    notify(null)
    expect(await login.completed).toEqual({ status: 'completed' })
  })

  it.each(['cancel', 'dispose', 'timeout'] as const)(
    'bounds %s and never logs out',
    async (action) => {
      vi.useFakeTimers()
      mocks.request.mockResolvedValue({
        type: 'chatgptDeviceCode',
        loginId: 'login',
        verificationUrl: 'https://auth.invalid/',
        userCode: 'fixture'
      })
      const service = new CodexService(options)
      const login = service.startLogin({ type: 'chatgptDeviceCode' }, 100)
      await login.started
      if (action === 'cancel') login.cancel()
      if (action === 'dispose') service.dispose()
      if (action === 'timeout') await vi.advanceTimersByTimeAsync(100)
      expect(await login.completed).toEqual({
        status: action === 'timeout' ? 'timed-out' : 'cancelled'
      })
      notify('login')
      expect(mocks.clients[0].dispose).toHaveBeenCalledOnce()
      expect(mocks.request.mock.calls.map((call) => call[0])).toEqual([
        'account/login/start',
        'account/login/cancel'
      ])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cancels during startup without issuing login and sanitizes startup failure', async () => {
    let ready!: () => void
    mocks.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    const service = new CodexService(options)
    const login = service.startLogin({ type: 'chatgpt' })
    login.cancel()
    ready()
    await expect(login.started).rejects.toThrow('login-start-failed')
    expect(await login.completed).toEqual({ status: 'cancelled' })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('settles disconnect and permits a subsequent login with fresh callbacks', async () => {
    mocks.request.mockResolvedValue({ type: 'apiKey' })
    const service = new CodexService(options)
    const login = service.startLogin({ type: 'apiKey', apiKey: 'fixture' })
    await login.started
    mocks.clients[0].options.onDisconnect?.(new CodexTransportError('process-exited'))
    expect(await login.completed).toEqual({ status: 'failed' })
    const next = service.startLogin({ type: 'apiKey', apiKey: 'fixture' })
    await next.started
    mocks.clients[0].options.onNotification?.('account/login/completed', {
      loginId: null,
      success: true
    })
    expect(mocks.clients[1].dispose).not.toHaveBeenCalled()
    next.cancel()
    expect(await next.completed).toEqual({ status: 'cancelled' })
  })
})

// Compile-only guards, checked by tsc without executing protocol calls.
function typedContract(client: CodexClient): void {
  void client
    .request('account/read', { refreshToken: false })
    .then((result) => result.requiresOpenaiAuth)
  // @ts-expect-error account params are not thread params
  void client.request('account/read', { threadId: 'root' })
  // @ts-expect-error steer requires expected turn identity
  void client.request('turn/steer', { threadId: 'root', input: [] })
  // @ts-expect-error unused methods are not admitted by the narrow map
  void client.request('fs/remove', {})
}
void typedContract

/**
 * Slice 2b guard 7 (pull half) — per-account rate limits, ONE HOST PER ACCOUNT
 * (ADR-068 §2 through ADR-069 §1).
 *
 * The old shape was one process re-injected account by account, because
 * `read()` released its client the moment the last user dropped and one call per
 * account would have been one child per account. A host per account removes the
 * constraint and the re-injection with it: each account's process is already
 * running as that account, so the sweep is one read per host and NOTHING sends
 * `account/login/start` — which is what kept a stale identity from ever billing
 * the wrong subscription.
 */
describe('per-account ChatGPT rate limits', () => {
  const snapshot = (usedPercent: number) => ({
    rateLimits: {
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_735_693_200 },
      secondary: null
    }
  })

  it('reads each account on its OWN host and never re-injects across them', async () => {
    let percent = 10
    mocks.request.mockImplementation(async (method: string) =>
      method === 'account/rateLimits/read' ? snapshot((percent += 10)) : {}
    )
    const service = new CodexService({ ...options, identity: { accountId: null } })

    const limits = await service.rateLimits(['acct-a', 'acct-b'])

    expect(hosts.order).toEqual(['acct-a', 'acct-b'])
    expect([...limits.keys()]).toEqual(['acct-a', 'acct-b'])
    // The WHOLE response comes back — a credits-based plan hides its figures in
    // `rateLimitsByLimitId`, so the transport must not pre-pick a bucket.
    expect(limits.get('acct-b')!.rateLimits.primary).toEqual({
      usedPercent: 30,
      windowDurationMins: 300,
      resetsAt: 1_735_693_200
    })
    // One read per host, and NOT ONE login: the identity is the process's own.
    expect(hosts.get('acct-a').requests).toEqual(['account/rateLimits/read'])
    expect(hosts.get('acct-b').requests).toEqual(['account/rateLimits/read'])
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
      'account/rateLimits/read',
      'account/rateLimits/read'
    ])
    expect(hosts.get('acct-a').live).toBe(0)
    expect(hosts.get('acct-b').live).toBe(0)
  })

  it('skips an account whose host the vault could not inject', async () => {
    mocks.request.mockImplementation(async (method: string) =>
      method === 'account/rateLimits/read' ? snapshot(55) : {}
    )
    const service = new CodexService({ ...options, identity: { accountId: null } })

    const limits = await service.rateLimits(['acct-gone', 'acct-a'])

    // The host exists and was asked for, but it is running as nobody, so its
    // figures are not this account's and it is never read.
    expect(hosts.order).toEqual(['acct-gone', 'acct-a'])
    expect(hosts.get('acct-gone').requests).toEqual([])
    expect([...limits.keys()]).toEqual(['acct-a'])
    expect(hosts.get('acct-gone').live).toBe(0)
  })

  it('reads nothing at all without an identity — and acquires no host', async () => {
    const service = new CodexService(options)
    expect([...(await service.rateLimits(['acct-a'])).keys()]).toEqual([])
    expect(hosts.order).toEqual([])
  })
})
