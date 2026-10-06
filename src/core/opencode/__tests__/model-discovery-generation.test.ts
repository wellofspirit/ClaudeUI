/**
 * @vitest-environment node
 *
 * opencode discovery across an invalidation (an auth or config write, a
 * harness install or selection change). Discovery asks a server of its OWN
 * (`acquireDetached`) — never the pooled one, which can outlive a harness
 * change while anyone holds it — and a probe that started before the
 * invalidation never writes the catalog snapshot, the picker groups or the
 * capability map, whatever order the old and new probes settle in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeServer {
  baseUrl: string
  answer: (providers: unknown[]) => void
  release: ReturnType<typeof vi.fn>
}

/** A server start the test holds: let it come up, or fail. */
interface HeldStart {
  up: () => void
  fail: (err: Error) => void
}

const { servers, starts, control, mockAcquire, mockAcquireDetached, MockOpencodeClient } =
  vi.hoisted(() => {
    const servers: FakeServer[] = []
    const starts: HeldStart[] = []
    /** `hold`: each start waits for the test. `autoAnswer`: a new server answers at once. */
    const control: { hold: boolean; autoAnswer: unknown[] | null } = {
      hold: false,
      autoAnswer: null
    }
    const answers = new Map<string, Promise<unknown[]>>()
    const mockAcquire = vi.fn()
    const mockAcquireDetached = vi.fn(async () => {
      if (control.hold) {
        await new Promise<void>((resolve, reject) => starts.push({ up: resolve, fail: reject }))
      }
      const baseUrl = `http://127.0.0.1:${4000 + servers.length}`
      let resolve!: (providers: unknown[]) => void
      answers.set(
        baseUrl,
        new Promise((res) => {
          resolve = res
        })
      )
      const server: FakeServer = { baseUrl, answer: resolve, release: vi.fn() }
      servers.push(server)
      if (control.autoAnswer) resolve(control.autoAnswer)
      return { baseUrl, password: 'p', authHeader: 'Basic x', release: server.release }
    })
    // A regular function: production code calls it with `new`.
    const MockOpencodeClient = vi.fn().mockImplementation(function (baseUrl: string) {
      const providers = (): Promise<unknown[]> => answers.get(baseUrl)!
      return {
        getProviders: async () => ({ all: await providers() }),
        getConfigProviders: async () => ({ providers: await providers() }),
        getProviderAuth: async () => ({})
      }
    })
    return { servers, starts, control, mockAcquire, mockAcquireDetached, MockOpencodeClient }
  })

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: vi.fn(),
    acquireDetached: mockAcquireDetached
  }
}))
vi.mock('../OpencodeV1Client', () => ({ OpencodeV1Client: MockOpencodeClient }))
vi.mock('../../services/persisted-sessions-dir', () => ({ PERSISTED_SESSIONS_DIR: '/tmp/p' }))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: () => ({}) }))
vi.mock('../auth-store', () => ({ readOpencodeCredentialTypes: async () => ({}) }))
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: () => ({}),
  readDeclaredProviderIds: () => [],
  resolveOpencodeConfigFile: () => ({ path: '/tmp/opencode.json' })
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const openai = (modelIds: string[]) => ({
  id: 'openai',
  name: 'OpenAI',
  source: 'custom',
  env: [],
  options: {},
  models: Object.fromEntries(
    modelIds.map((id) => [
      id,
      { id, name: id, capabilities: { toolcall: true }, limit: { context: 400_000, output: 1 } }
    ])
  )
})
const OLD = [openai(['gpt-6-sol'])]
const NEW = [openai(['gpt-6-sol', 'gpt-6.1-sol'])]
const values = (groups: Array<{ models: Array<{ value: string }> }>): string[] =>
  groups.flatMap((g) => g.models.map((m) => m.value))

/** Let every queued microtask (probe bodies, `.finally`s) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function importFresh() {
  vi.resetModules()
  return import('../model-discovery')
}

beforeEach(() => {
  servers.length = 0
  starts.length = 0
  control.hold = false
  control.autoAnswer = null
  mockAcquire.mockClear()
  mockAcquireDetached.mockClear()
  MockOpencodeClient.mockClear()
})

describe('opencode discovery across an invalidation', () => {
  it('asks a server of its own, once for the picker and the catalog together, then kills it', async () => {
    const d = await importFresh()
    const groups = d.discoverOpencodeModels()
    const catalog = d.getOpencodeProviderModels('openai')
    await settle()
    expect(servers).toHaveLength(1)
    servers[0].answer(NEW)
    expect(values(await groups)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
    expect((await catalog).map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
    expect(servers[0].release).toHaveBeenCalledTimes(1)
    // The pooled server other holders keep alive is never consulted.
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('a new caller never joins the obsolete probe, whose server is released, not a session’s', async () => {
    const d = await importFresh()
    const before = d.discoverOpencodeModels()
    await settle()
    d.invalidateOpencodeModelCache()
    expect(servers[0].release).toHaveBeenCalled()

    const after = d.discoverOpencodeModels()
    await settle()
    expect(servers).toHaveLength(2)
    servers[1].answer(NEW)
    servers[0].answer(OLD)
    // The caller from BEFORE the invalidation gets the new generation's answer.
    expect(values(await before)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
    expect(values(await after)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
  })

  it('an old answer that arrives AFTER the new one cannot overwrite any cache', async () => {
    const d = await importFresh()
    const old = d.discoverOpencodeModels()
    await settle()
    d.invalidateOpencodeModelCache()

    const fresh = d.discoverOpencodeModels()
    await settle()
    servers[1].answer(NEW)
    await fresh
    servers[0].answer(OLD)
    await old
    await settle()

    expect(values(d.peekOpencodeModels()!)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
    expect(d.getOpencodeModelContextWindow('openai', 'gpt-6.1-sol')).toBe(400_000)
    expect((await d.getOpencodeProviderModels('openai')).map((m) => m.id)).toEqual([
      'gpt-6-sol',
      'gpt-6.1-sol'
    ])
    // All of it from the caches the new probe filled: no third server.
    expect(servers).toHaveLength(2)
  })

  it('an old answer that arrives BEFORE the new one writes nothing either', async () => {
    const d = await importFresh()
    const caller = d.discoverOpencodeModels()
    await settle()
    d.invalidateOpencodeModelCache()
    servers[0].answer(OLD)
    await settle()

    expect(d.peekOpencodeModels()).toBeNull()
    expect(d.getOpencodeModelContextWindow('openai', 'gpt-6-sol')).toBe(0)
    expect(d.getOpencodeModelCapabilities('openai', 'gpt-6-sol')).toBeUndefined()

    // The caller retried under the new generation: answer that probe too, so
    // no fake work outlives the test — and it is the new answer that lands.
    expect(servers).toHaveLength(2)
    servers[1].answer(NEW)
    expect(values(await caller)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
    expect(servers[1].release).toHaveBeenCalledTimes(1)
  })

  it('an obsolete server that fails to START sends its caller to the new probe', async () => {
    const d = await importFresh()
    control.hold = true
    const before = d.discoverOpencodeModels()
    await settle()
    d.invalidateOpencodeModelCache()
    const after = d.discoverOpencodeModels()
    await settle()
    expect(starts).toHaveLength(2)

    // The old start fails while the new one is still coming up.
    starts[0].fail(new Error('spawn ENOENT'))
    await settle()
    // Its cleanup left the new probe alone: a third caller joins it.
    const joined = d.discoverOpencodeModels()
    await settle()
    expect(starts).toHaveLength(2)

    control.autoAnswer = NEW
    starts[1].up()
    const want = ['openai/gpt-6-sol', 'openai/gpt-6.1-sol']
    expect(values(await before)).toEqual(want)
    expect(values(await after)).toEqual(want)
    expect(values(await joined)).toEqual(want)
  })

  it('a CURRENT start failure is opencode unavailable: [] and nothing cached', async () => {
    const d = await importFresh()
    control.hold = true
    const answer = d.discoverOpencodeModels()
    await settle()
    starts[0].fail(new Error('spawn ENOENT'))
    expect(await answer).toEqual([])
    expect(d.peekOpencodeModels()).toBeNull()
    expect(starts).toHaveLength(1)
  })

  it('a server that comes up after its probe was cancelled is released, never asked', async () => {
    const d = await importFresh()
    control.hold = true
    const caller = d.discoverOpencodeModels()
    await settle()
    d.invalidateOpencodeModelCache()
    starts[0].up()
    await settle()
    expect(servers[0].release).toHaveBeenCalledTimes(1)
    expect(MockOpencodeClient).not.toHaveBeenCalledWith(servers[0].baseUrl, expect.anything())

    // Settle the caller's retry, so no held start outlives the test.
    expect(starts).toHaveLength(2)
    control.autoAnswer = NEW
    starts[1].up()
    expect(values(await caller)).toEqual(['openai/gpt-6-sol', 'openai/gpt-6.1-sol'])
  })

  it('superseded failures retry a bounded number of times, then answer []', async () => {
    const d = await importFresh()
    control.hold = true
    const caller = d.discoverOpencodeModels()
    for (let i = 0; i < 3; i++) {
      await settle()
      d.invalidateOpencodeModelCache()
      starts[i].fail(new Error('spawn ENOENT'))
    }
    expect(await caller).toEqual([])
    expect(starts).toHaveLength(3)
  })

  it.each([
    ['discoverOpencodeModels', (d: Discovery) => d.discoverOpencodeModels()],
    ['getOpencodeProviderModels', (d: Discovery) => d.getOpencodeProviderModels('openai')],
    ['discoverOpencodeProviderCatalog', (d: Discovery) => d.discoverOpencodeProviderCatalog()]
  ] as const)(
    '%s never answers from a generation an invalidation superseded, at any microtask',
    async (_name, read) => {
      const fresh = JSON.stringify(await read(await freshAnswering(NEW)))
      let decisive = 0
      for (let hops = 0; hops <= 40; hops++) {
        const d = await importFresh()
        let clock = { tick: 0, stop: () => {} }
        let answeredAt = -1
        // The first reaction on the public promise: it runs at most one clock
        // hop after the promise resolved (one clock entry can be queued ahead).
        const answer = read(d)
        void answer.then(() => {
          answeredAt = clock.tick
        })
        await settle()
        control.autoAnswer = NEW
        let invalidatedAt = -1
        // Microtasks only from here to the answer: the clock would starve a timer.
        let value: string
        clock = startClock()
        try {
          servers[0].answer(OLD)
          afterHops(hops, () => {
            invalidatedAt = clock.tick
            d.invalidateOpencodeModelCache()
          })
          value = JSON.stringify(await answer)
        } finally {
          // Always: a running clock would starve every timer, the test's own included.
          clock.stop()
        }
        await settle()
        // Resolved more than a hop after the invalidation ran: it must be the
        // new generation's answer. Within a hop either answer is legitimate.
        if (answeredAt > invalidatedAt + 1) {
          decisive++
          expect(value, `hops=${hops}`).toBe(fresh)
        }
        servers.length = 0
        control.autoAnswer = null
      }
      // The sweep reached the window where an old answer would be wrong.
      expect(decisive).toBeGreaterThan(0)
    }
  )
})

type Discovery = Awaited<ReturnType<typeof importFresh>>

/** A fresh module whose servers answer `providers` at once. */
async function freshAnswering(providers: unknown[]): Promise<Discovery> {
  const d = await importFresh()
  control.autoAnswer = providers
  return d
}

/** A microtask-hop counter: one queued entry at a time, so it ticks once per turn. */
function startClock(): { readonly tick: number; stop: () => void } {
  let tick = 0
  let running = true
  const step = (): void => {
    if (!running) return
    tick++
    queueMicrotask(step)
  }
  queueMicrotask(step)
  return {
    get tick() {
      return tick
    },
    stop: () => {
      running = false
    }
  }
}

/** Run `fn` after `hops` microtask turns. */
function afterHops(hops: number, fn: () => void): void {
  if (hops === 0) fn()
  else queueMicrotask(() => afterHops(hops - 1, fn))
}
