// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexMethodNotFound,
  CodexTransportError,
  type CodexClientOptions
} from '../CodexAppServerClient'
import {
  CodexHostRegistry,
  type CodexHostClient,
  type CodexHostDeps,
  type CodexThreadOwner
} from '../CodexHost'
import type { CodexAuthHook } from '../codex-auth-hook'
import type { InitializeParams } from '../protocol/InitializeParams'

/**
 * ADR-069 §1 — the host primitive.
 *
 * No binary, no vault, no filesystem: the registry is driven with a fake client
 * and a fake hook, which is the whole point of its construction seams. What is
 * under test is the SHARING and the LIFETIME — one process per home and account,
 * a single start under concurrent acquirers, the idle deadline that a read may
 * pause but never push out, and a dead transport that is forgotten rather than
 * retried.
 */

/** One fake app-server. Records what the host asked it to do. */
class FakeClient implements CodexHostClient {
  static instances: FakeClient[] = []
  /** Resolves the pending `start()`; set when `holdStart` is on. */
  release?: () => void
  startCalls = 0
  disposeCalls = 0
  readonly requests: string[] = []
  constructor(readonly options: CodexClientOptions) {
    FakeClient.instances.push(this)
  }
  static holdStart = false
  static failStart: Error | null = null
  async start(_params: InitializeParams, auth?: CodexAuthHook | null): Promise<unknown> {
    this.startCalls++
    if (FakeClient.holdStart) await new Promise<void>((done) => (this.release = done))
    if (FakeClient.failStart) throw FakeClient.failStart
    await auth?.inject()
    return {}
  }
  readonly sent: Array<{ method: string; params: unknown }> = []
  /** What the next `request` resolves with — a `thread/*` opener's response. */
  reply: unknown = {}
  async request(method: string, params?: unknown): Promise<never> {
    this.requests.push(method)
    this.sent.push({ method, params })
    return this.reply as never
  }
  readonly aborted: Array<[string, string]> = []
  abortServerRequests(threadId: string, turnId: string): void {
    this.aborted.push([threadId, turnId])
  }
  dispose(): void {
    this.disposeCalls++
  }
  /** What a dying app-server does to its owner. */
  die(code = 'stdout-closed'): void {
    this.options.onDisconnect?.(new CodexTransportError(code))
  }
  /** One server -> client notification, exactly as the transport delivers it. */
  notify(method: string, params: unknown): void {
    this.options.onNotification?.(method, params)
  }
  /** One server -> client REQUEST. Returns the promise the transport would answer with. */
  ask(method: string, params: unknown): Promise<unknown> {
    return this.options.onServerRequest!(method, params, {
      id: 1,
      signal: new AbortController().signal
    })
  }
}

/** A thread owner that records everything the host hands it. */
function fakeOwner(): CodexThreadOwner & {
  notifications: Array<[string, unknown]>
  requests: Array<[string, unknown]>
  disconnects: CodexTransportError[]
  authRequired: Array<string | null>
} {
  const notifications: Array<[string, unknown]> = []
  const requests: Array<[string, unknown]> = []
  const disconnects: CodexTransportError[] = []
  const authRequired: Array<string | null> = []
  return {
    notifications,
    requests,
    disconnects,
    authRequired,
    onNotification: (method, params) => void notifications.push([method, params]),
    onServerRequest: async (method, params) => {
      requests.push([method, params])
      return { decision: 'accept' }
    },
    onDisconnect: (error) => void disconnects.push(error),
    onAuthRequired: (accountId) => void authRequired.push(accountId)
  }
}

/** A hook with no vault behind it: `inject()` claims the id it was built with. */
function fakeHook(accountId: string | null): CodexAuthHook & { injected: Array<string | null> } {
  const injected: Array<string | null> = []
  let current: string | null = null
  let requested = accountId
  return {
    injected,
    get injectedAccountId() {
      return current
    },
    requestAccount: (id: string | null) => {
      requested = id
    },
    hasAccount: async () => true,
    // ADR-071 §3's metering question. Nothing in this suite asks it; a hook
    // that did not answer it at all would not be one.
    accountIdentity: async () => ({ accountKey: 'codex:openai:native', accountLabel: null }),
    onRefreshRequest: vi.fn(),
    inject: async () => {
      injected.push(requested)
      // `acct-gone` stands in for an account the vault cannot produce a token
      // for: the process stays uninjected and reports no identity.
      if (requested === 'acct-gone') return null
      current = requested ?? 'acct-active'
      return {
        accessToken: `fake-${current}`,
        chatgptAccountId: `ws-${current}`,
        chatgptPlanType: 'pro',
        vaultAccountId: current
      }
    }
  } as CodexAuthHook & { injected: Array<string | null> }
}

const hooks: Array<ReturnType<typeof fakeHook>> = []
const IDLE_MS = 1000

function build(overrides: CodexHostDeps = {}): CodexHostRegistry {
  return new CodexHostRegistry({
    createClient: (options) => new FakeClient(options),
    createHook: (accountId) => {
      const hook = fakeHook(accountId)
      hooks.push(hook)
      return hook
    },
    activeAccountId: async () => 'acct-active',
    idleMs: IDLE_MS,
    ...overrides
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeClient.instances.length = 0
  FakeClient.holdStart = false
  FakeClient.failStart = null
  hooks.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('one host per home and account', () => {
  it('starts ONE app-server for two acquires landing in the same tick', async () => {
    FakeClient.holdStart = true
    const registry = build()
    const first = registry.acquire({ cwd: '/isolated', label: 'discovery' })
    const second = registry.acquire({ cwd: '/isolated', label: 'history-list' })
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeClient.instances).toHaveLength(1)
    FakeClient.instances[0].release!()
    const [a, b] = await Promise.all([first, second])
    expect(FakeClient.instances).toHaveLength(1)
    expect(FakeClient.instances[0].startCalls).toBe(1)
    expect(registry.size).toBe(1)
    // The PROCESS belongs to no caller, so it is labelled `host`; the callers
    // name themselves per acquire instead (a debug line).
    expect(FakeClient.instances[0].options.label).toBe('host')
    a.release()
    b.release()
  })

  it('gives two accounts two hosts, each injected once, with no cross-injection', async () => {
    const registry = build()
    const a = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-a' } })
    const b = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-b' } })
    expect(FakeClient.instances).toHaveLength(2)
    expect(registry.size).toBe(2)
    expect(a.injectedAccountId).toBe('acct-a')
    expect(b.injectedAccountId).toBe('acct-b')
    // One identity per process, for the life of the process (ADR-068 §1).
    expect(hooks.map((hook) => hook.injected)).toEqual([['acct-a'], ['acct-b']])
    a.release()
    b.release()
  })

  it('resolves the active account to an id, so following and pinning share one host', async () => {
    const registry = build()
    const following = await registry.acquire({ cwd: '/isolated', identity: { accountId: null } })
    const pinned = await registry.acquire({
      cwd: '/isolated',
      identity: { accountId: 'acct-active' }
    })
    expect(FakeClient.instances).toHaveLength(1)
    expect(registry.size).toBe(1)
    // The hook is pinned to the RESOLVED id, which is what the key promised.
    expect(hooks.map((hook) => hook.injected)).toEqual([['acct-active']])
    following.release()
    pinned.release()
  })

  /**
   * ONE app-server per home in the common case.
   *
   * "Follow the active account" on a vault that holds none IS the uninjected
   * host — the same answer `inject()` would have given, and the same fallback
   * the auth probe already reports — so it must not open a second, identical
   * process in a bucket of its own.
   */
  it('collapses the active identity onto the uninjected host when the vault has none', async () => {
    const registry = build({ activeAccountId: async () => null })
    const following = await registry.acquire({ cwd: '/isolated', identity: { accountId: null } })
    const bare = await registry.acquire({ cwd: '/isolated' })
    expect(FakeClient.instances).toHaveLength(1)
    expect(registry.size).toBe(1)
    expect(following.injectedAccountId).toBeNull()
    // Nothing to inject, so nothing is built to inject with.
    expect(hooks).toHaveLength(0)
    following.release()
    bare.release()
  })

  it('still gives an explicitly pinned account its own host when the vault has no active one', async () => {
    const registry = build({ activeAccountId: async () => null })
    const bare = await registry.acquire({ cwd: '/isolated' })
    const pinned = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-a' } })
    expect(FakeClient.instances).toHaveLength(2)
    expect(registry.size).toBe(2)
    expect(bare.injectedAccountId).toBeNull()
    expect(pinned.injectedAccountId).toBe('acct-a')
    bare.release()
    pinned.release()
  })

  it('keeps the uninjected host apart from the active account host', async () => {
    // The `native` bucket survives for `startLogin`'s client and for tests that
    // must never touch the vault; a machine WITH an account keeps them apart.
    const registry = build()
    const native = await registry.acquire({ cwd: '/isolated' })
    const active = await registry.acquire({ cwd: '/isolated', identity: { accountId: null } })
    expect(FakeClient.instances).toHaveLength(2)
    expect(native.injectedAccountId).toBeNull()
    // A service with no identity never reaches the vault at all.
    expect(hooks).toHaveLength(1)
    native.release()
    active.release()
  })
})

describe('the idle rule', () => {
  it('closes a host once the last handle has been gone for the idle period', async () => {
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    handle.release()
    expect(FakeClient.instances[0].disposeCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(FakeClient.instances[0].disposeCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeClient.instances[0].disposeCalls).toBe(1)
    expect(registry.size).toBe(0)
  })

  it('never closes a host under a live read', async () => {
    const registry = build()
    const first = await registry.acquire({ cwd: '/isolated' })
    first.release()
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2)
    const second = await registry.acquire({ cwd: '/isolated' })
    await vi.advanceTimersByTimeAsync(IDLE_MS * 4)
    expect(FakeClient.instances[0].disposeCalls).toBe(0)
    second.release()
  })

  /**
   * The load-bearing half of ADR-069 §3's idle rule, and the reason the sidebar's
   * 30-second directory poll does not pin a process for the life of the app:
   * reads keep a host WARM, never ALIVE. The deadline is fixed when the host
   * first falls idle and a later read only pauses the timer, so the host still
   * dies on schedule.
   */
  it('does not let a repeated read push the idle deadline out', async () => {
    const registry = build()
    ;(await registry.acquire({ cwd: '/isolated' })).release()
    // Four "polls" inside the idle period, each of which a sliding window would
    // have reset.
    for (let poll = 0; poll < 4; poll++) {
      await vi.advanceTimersByTimeAsync(IDLE_MS / 5)
      ;(await registry.acquire({ cwd: '/isolated' })).release()
      expect(FakeClient.instances[0].disposeCalls).toBe(0)
    }
    await vi.advanceTimersByTimeAsync(IDLE_MS / 5)
    expect(FakeClient.instances[0].disposeCalls).toBe(1)
    expect(registry.size).toBe(0)
  })

  it('keeps a host with an attached owner alive past the deadline, and lets go on detach', async () => {
    // ADR-069 §2: a SESSION is what keeps a host alive; reads only keep it warm.
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    const connection = handle.host.attach(fakeOwner())
    handle.release()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 10)
    expect(FakeClient.instances[0].disposeCalls).toBe(0)
    connection.detach()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(FakeClient.instances[0].disposeCalls).toBe(1)
  })

  it('starts a fresh host after the idle close', async () => {
    const registry = build()
    ;(await registry.acquire({ cwd: '/isolated' })).release()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    const next = await registry.acquire({ cwd: '/isolated' })
    expect(FakeClient.instances).toHaveLength(2)
    expect(next.injectedAccountId).toBeNull()
    next.release()
  })
})

describe('host death', () => {
  it('forgets a host whose transport died and starts a fresh one on the next acquire', async () => {
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    FakeClient.instances[0].die()
    expect(registry.size).toBe(0)
    // The lease is dead too: ADR-069 §5 — nothing retries a dead process on the
    // caller's behalf.
    await expect(handle.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: 'stdout-closed'
    })
    const next = await registry.acquire({ cwd: '/isolated' })
    expect(FakeClient.instances).toHaveLength(2)
    next.release()
  })

  it('rejects every acquirer of a failed start and keeps no host behind', async () => {
    FakeClient.failStart = new CodexTransportError('binary-unavailable')
    const registry = build()
    await expect(registry.acquire({ cwd: '/isolated' })).rejects.toMatchObject({
      code: 'binary-unavailable'
    })
    expect(registry.size).toBe(0)
    FakeClient.failStart = null
    const next = await registry.acquire({ cwd: '/isolated' })
    expect(FakeClient.instances).toHaveLength(2)
    next.release()
  })

  it('rejects a request on a handle the caller already gave back', async () => {
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    handle.release()
    // Idempotent: a double release must not credit the host with a user it
    // never had, or the idle rule would never fire.
    handle.release()
    await expect(handle.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: 'handle-released'
    })
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(registry.size).toBe(0)
  })
})

describe('quit', () => {
  it('disposes every host and forgets them', async () => {
    const registry = build()
    const a = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-a' } })
    const b = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-b' } })
    registry.dispose()
    expect(FakeClient.instances.map((client) => client.disposeCalls)).toEqual([1, 1])
    expect(registry.size).toBe(0)
    await expect(a.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: 'host-disposed'
    })
    b.release()
  })
})

/**
 * The caller half of "one app-server per home": every PRODUCT reader asks for
 * the active account, so they all land on the same host.
 *
 * A source check rather than a behavioural one because that is exactly the shape
 * of the regression — a new reader built the way the old ones were, quietly
 * opening a SECOND process on the home for an identity it does not use. There is
 * nothing to observe at runtime until a machine has two app-servers on it.
 *
 * Deliberately NOT covered: `CodexService.startLogin`'s own client (a native
 * login is refused while external auth is active, so it must run uninjected) and
 * the integration suites, which construct services without an identity so a
 * developer's vault is never read. Both live outside the directories scanned.
 */
describe('every product reader asks for the active account', () => {
  const roots = ['src/core/codex', 'src/core/auth']
  const sources = roots.flatMap((root) =>
    readdirSync(root)
      .filter((name) => name.endsWith('.ts') && name !== 'CodexService.ts')
      .map((name) => ({ path: join(root, name), text: readFileSync(join(root, name), 'utf-8') }))
  )

  it('constructs no CodexService without an identity', () => {
    const offenders: string[] = []
    for (const source of sources) {
      let index = source.text.indexOf('new CodexService(')
      while (index !== -1) {
        // The construction's own argument list: up to the next `)` that closes
        // it is hard to find without a parser, so take a window big enough for
        // every call site in the tree and small enough not to reach the next one.
        const window = source.text.slice(index, index + 400).split('new CodexService(')[1] ?? ''
        if (!window.includes('identity:')) offenders.push(source.path)
        index = source.text.indexOf('new CodexService(', index + 1)
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds the readers it is meant to be guarding', () => {
    // A scan that matched nothing would pass the guard above for the wrong
    // reason; this is the canary for a moved file or a renamed directory.
    const found = sources
      .filter((source) => source.text.includes('new CodexService('))
      .map((source) => source.path.split(sep).join('/'))
      .sort()
    expect(found).toEqual([
      'src/core/auth/CodexAuthProvider.ts',
      'src/core/codex/chatgpt-rate-limits.ts',
      'src/core/codex/codex-config.ts',
      'src/core/codex/delete.ts',
      'src/core/codex/history.ts',
      'src/core/codex/model-discovery.ts'
    ])
  })
})

/**
 * ADR-069 §2 — the demultiplexer.
 *
 * One process, several threads, and the rule that decides who hears what: the
 * owner that CLAIMED a `threadId` gets everything stamped with it, a payload
 * with no `threadId` at all is account-level and reaches every owner, and a
 * thread nobody claimed is dropped (notification) or refused (server request).
 */
describe('threads on a host', () => {
  /**
   * A started host plus a view of its fake process. Identity-bearing, because
   * the refresh and the sign-in fan-out are the host HOOK's and a host that was
   * asked for no identity has none.
   */
  async function host(registry = build()) {
    const handle = await registry.acquire({ cwd: '/isolated', identity: { accountId: null } })
    const codex = FakeClient.instances.at(-1)!
    return { registry, handle, codex }
  }

  it('routes every notification to the owner that claimed its thread', async () => {
    const { handle, codex } = await host()
    const a = fakeOwner()
    const b = fakeOwner()
    const first = handle.host.attach(a)
    const second = handle.host.attach(b)
    handle.release()
    first.claim('thread-a')
    second.claim('thread-b')
    codex.notify('turn/started', { threadId: 'thread-a', turn: { id: 't1' } })
    codex.notify('turn/started', { threadId: 'thread-b', turn: { id: 't2' } })
    expect(a.notifications).toEqual([
      ['turn/started', { threadId: 'thread-a', turn: { id: 't1' } }]
    ])
    expect(b.notifications).toEqual([
      ['turn/started', { threadId: 'thread-b', turn: { id: 't2' } }]
    ])
  })

  it('fans a notification that carries no threadId out to every owner', async () => {
    const { handle, codex } = await host()
    const a = fakeOwner()
    const b = fakeOwner()
    handle.host.attach(a)
    handle.host.attach(b)
    handle.release()
    // `account/rateLimits/updated` is the shape this rule exists for: it reports
    // the whole PROCESS's subscription usage, so it belongs to every session on
    // it (ADR-069 §8).
    codex.notify('account/rateLimits/updated', { rateLimits: { primary: null } })
    expect(a.notifications).toHaveLength(1)
    expect(b.notifications).toHaveLength(1)
  })

  it('holds an unclaimed thread notification and replays it on claim', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    const connection = handle.host.attach(owner)
    handle.release()
    // A native child's first events routinely beat the spawn item that names it.
    codex.notify('item/completed', { threadId: 'child', item: { id: 'm1' } })
    expect(owner.notifications).toEqual([])
    connection.claim('child')
    expect(owner.notifications).toEqual([
      ['item/completed', { threadId: 'child', item: { id: 'm1' } }]
    ])
  })

  it('never delivers one thread to an owner that claimed a different one', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    const connection = handle.host.attach(owner)
    handle.release()
    connection.claim('root')
    codex.notify('item/completed', { threadId: 'stranger', item: { id: 'm1' } })
    connection.claim('other')
    expect(owner.notifications).toEqual([])
  })

  it('drops a held thread the binary says it CLOSED', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    const connection = handle.host.attach(owner)
    handle.release()
    codex.notify('item/completed', { threadId: 'gone', item: { id: 'm1' } })
    // A thread the app-server has unloaded can never be claimed by anyone, so
    // what was held for it is dead weight — and would otherwise be replayed into
    // whichever session next resumed that id.
    codex.notify('thread/closed', { threadId: 'gone' })
    connection.claim('gone')
    expect(owner.notifications).toEqual([])
  })

  it('discards held notifications older than the replay window', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    const connection = handle.host.attach(owner)
    handle.release()
    codex.notify('item/completed', { threadId: 'child', item: { id: 'stale' } })
    // A disposed session's trailing notifications must not surface minutes later
    // in the session that resumes the thread.
    await vi.advanceTimersByTimeAsync(31_000)
    codex.notify('item/completed', { threadId: 'child', item: { id: 'fresh' } })
    connection.claim('child')
    expect(
      owner.notifications.map(([, params]) => (params as { item: { id: string } }).item.id)
    ).toEqual(['fresh'])
  })

  it('evicts the OLDEST held thread when the hold is full, rather than silencing new ones', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    const connection = handle.host.attach(owner)
    handle.release()
    // 200 leftovers from threads nobody will ever claim…
    for (let index = 0; index < 200; index++)
      codex.notify('item/completed', { threadId: `dead-${index}`, item: { id: `m${index}` } })
    // …must not cost the child that arrives next its first notification.
    codex.notify('item/completed', { threadId: 'child', item: { id: 'first' } })
    connection.claim('child')
    expect(owner.notifications).toHaveLength(1)
    // The evicted bucket is the oldest one, and only that one.
    connection.claim('dead-0')
    expect(owner.notifications).toHaveLength(1)
    connection.claim('dead-1')
    expect(owner.notifications).toHaveLength(2)
  })

  it('refuses a second owner’s claim of a live thread instead of stealing it', async () => {
    const { handle, codex } = await host()
    const first = fakeOwner()
    const second = fakeOwner()
    handle.host.attach(first).claim('root')
    const intruder = handle.host.attach(second)
    handle.release()
    expect(() => intruder.claim('root')).toThrow('already claimed')
    // The turn's notifications still reach the owner that opened it.
    codex.notify('turn/started', { threadId: 'root', turn: { id: 't1' } })
    expect(first.notifications).toHaveLength(1)
    expect(second.notifications).toEqual([])
  })

  it('holds a thread it OPENED even when nobody claimed it', async () => {
    // `thread/start` answering is what takes the writer lock — not the claim.
    // A session that threw between the two leaves the thread loaded here, and a
    // delete has nowhere else to go (the walk lost its retry with ADR-069 §3).
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    const connection = handle.host.attach(fakeOwner())
    handle.release()
    FakeClient.instances[0].reply = { thread: { id: 'opened-not-claimed' } }
    await connection.request('thread/start', { cwd: '/isolated' } as never)
    expect(handle.host.holds('opened-not-claimed')).toBe(true)
    expect(registry.holderFor(handle.host.homeKey, 'opened-not-claimed')).toBe(handle.host)
  })

  it('answers a server request for an unclaimed thread with method-not-found', async () => {
    const { handle, codex } = await host()
    const owner = fakeOwner()
    handle.host.attach(owner).claim('root')
    handle.release()
    await expect(
      codex.ask('item/commandExecution/requestApproval', { threadId: 'stranger', turnId: 't' })
    ).rejects.toBeInstanceOf(CodexMethodNotFound)
    expect(owner.requests).toEqual([])
  })

  it('routes a server request to the claiming owner and answers the refresh itself', async () => {
    const { handle, codex } = await host()
    const a = fakeOwner()
    const b = fakeOwner()
    handle.host.attach(a).claim('thread-a')
    handle.host.attach(b).claim('thread-b')
    handle.release()
    await expect(
      codex.ask('item/commandExecution/requestApproval', { threadId: 'thread-b', turnId: 't' })
    ).resolves.toEqual({ decision: 'accept' })
    expect(a.requests).toEqual([])
    expect(b.requests).toHaveLength(1)
    // The one server request that belongs to the PROCESS and to no thread.
    await codex.ask('account/chatgptAuthTokens/refresh', {})
    expect(hooks[0].onRefreshRequest).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes every claimed thread when its owner detaches', async () => {
    const { handle, codex } = await host()
    const connection = handle.host.attach(fakeOwner())
    handle.release()
    connection.claim('root')
    connection.claim('child')
    connection.detach()
    expect(codex.sent.filter((entry) => entry.method === 'thread/unsubscribe')).toEqual([
      { method: 'thread/unsubscribe', params: { threadId: 'root' } },
      { method: 'thread/unsubscribe', params: { threadId: 'child' } }
    ])
  })

  it('tells every attached owner exactly once when the host dies', async () => {
    const { registry, handle, codex } = await host()
    const a = fakeOwner()
    const b = fakeOwner()
    handle.host.attach(a).claim('thread-a')
    handle.host.attach(b).claim('thread-b')
    handle.release()
    codex.die()
    codex.die('process-exited')
    expect(a.disconnects.map((error) => error.code)).toEqual(['stdout-closed'])
    expect(b.disconnects.map((error) => error.code)).toEqual(['stdout-closed'])
    expect(registry.size).toBe(0)
    // Nothing is routed afterwards, and no unsubscribe reaches a dead transport.
    codex.notify('turn/started', { threadId: 'thread-a', turn: { id: 't1' } })
    expect(a.notifications).toEqual([])
    expect(codex.requests).not.toContain('thread/unsubscribe')
  })

  it('tells every attached owner when the registry closes the host on quit', async () => {
    const { registry, handle } = await host()
    const owner = fakeOwner()
    handle.host.attach(owner)
    handle.release()
    registry.dispose()
    expect(owner.disconnects.map((error) => error.code)).toEqual(['host-disposed'])
  })

  it('fans the vault sign-in failure out to every session on the host', async () => {
    const { handle } = await host()
    const a = fakeOwner()
    const b = fakeOwner()
    handle.host.attach(a)
    handle.host.attach(b)
    handle.release()
    // The hook belongs to the PROCESS now (ADR-069 §8), so its one callback has
    // to reach every session running on that credential.
    hooks[0].onAuthRequired?.('acct-active')
    expect(a.authRequired).toEqual(['acct-active'])
    expect(b.authRequired).toEqual(['acct-active'])
  })

  it('gives every host start its own generation', async () => {
    const registry = build()
    const first = await registry.acquire({ cwd: '/isolated' })
    const before = first.host.generation
    FakeClient.instances[0].die()
    const second = await registry.acquire({ cwd: '/isolated' })
    expect(second.host.generation).toBe(before + 1)
    second.release()
  })

  it('serves an acquire for a loaded thread from the host that holds it', async () => {
    // ADR-069 §3 / probe P5: the writer lock is PROCESS-scoped, so a delete has
    // to be issued on whichever host loaded the thread — which for a pinned
    // session is not the active account's host at all.
    const registry = build()
    const pinned = await registry.acquire({ cwd: '/isolated', identity: { accountId: 'acct-b' } })
    pinned.host.attach(fakeOwner()).claim('thread-on-b')
    pinned.release()
    const active = await registry.acquire({ cwd: '/isolated', identity: { accountId: null } })
    active.release()
    expect(registry.size).toBe(2)
    const holder = await registry.acquire({
      cwd: '/isolated',
      identity: { accountId: null },
      thread: 'thread-on-b',
      label: 'delete'
    })
    expect(holder.host.key).toBe(pinned.host.key)
    holder.release()
    // A thread no live host has loaded falls back to the asked-for identity.
    const fallback = await registry.acquire({
      cwd: '/isolated',
      identity: { accountId: null },
      thread: 'thread-on-disk'
    })
    expect(fallback.host.key).toBe(active.host.key)
    fallback.release()
  })

  it('stops holding a thread the binary says it unloaded', async () => {
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    handle.host.attach(fakeOwner()).claim('root')
    handle.release()
    expect(handle.host.holds('root')).toBe(true)
    // `thread/closed` is the app-server saying it dropped an idle, unsubscribed
    // thread (`thread_lifecycle.rs`) — its writer lock went with it.
    FakeClient.instances[0].notify('thread/closed', { threadId: 'root' })
    expect(handle.host.holds('root')).toBe(false)
  })
})
