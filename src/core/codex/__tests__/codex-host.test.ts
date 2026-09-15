// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexTransportError, type CodexClientOptions } from '../CodexAppServerClient'
import { CodexHostRegistry, type CodexHostClient, type CodexHostDeps } from '../CodexHost'
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
  async request(method: string): Promise<never> {
    this.requests.push(method)
    return {} as never
  }
  dispose(): void {
    this.disposeCalls++
  }
  /** What a dying app-server does to its owner. */
  die(code = 'stdout-closed'): void {
    this.options.onDisconnect?.(new CodexTransportError(code))
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

  it('keeps a retained host alive past the deadline, and lets go when it is released', async () => {
    // H2's seam, tested here so the rule it depends on cannot rot: a REGISTERED
    // session is what keeps a host alive, and nothing in H1 calls this yet.
    const registry = build()
    const handle = await registry.acquire({ cwd: '/isolated' })
    handle.host.retain()
    handle.release()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 10)
    expect(FakeClient.instances[0].disposeCalls).toBe(0)
    handle.host.release()
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
