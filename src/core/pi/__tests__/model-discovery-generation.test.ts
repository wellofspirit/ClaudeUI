/**
 * @vitest-environment node
 *
 * pi discovery across an invalidation (a login, a config write, a harness
 * install or selection change): a probe that started before it is obsolete.
 * Whatever order the old and new probes settle in, the old one never writes a
 * cache, never clears the new one's in-flight entry, and its callers get the
 * new generation's answer — not the replaced pi's.
 *
 * Each probe is its own fake client whose answer the test releases, so the
 * interleavings are explicit rather than timing-dependent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeProbe {
  answer: (models: unknown[]) => void
  fail: (err: Error) => void
  dispose: ReturnType<typeof vi.fn>
}

const { probes, control, MockPiRpcClient, mockPiBinaryAvailable } = vi.hoisted(() => {
  const probes: FakeProbe[] = []
  /** `autoAnswer`: a new probe answers at once. */
  const control: { autoAnswer: unknown[] | null } = { autoAnswer: null }
  // A regular function: production code calls it with `new`.
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    let resolve!: (v: unknown) => void
    let reject!: (e: Error) => void
    const response = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    const probe: FakeProbe = {
      answer: (models) => resolve({ success: true, data: { models } }),
      fail: (err) => reject(err),
      dispose: vi.fn(() => reject(new Error('PiRpcClient: process exited')))
    }
    probes.push(probe)
    if (control.autoAnswer) probe.answer(control.autoAnswer)
    return {
      start: vi.fn().mockResolvedValue(undefined),
      request: () => response,
      dispose: probe.dispose
    }
  })
  const mockPiBinaryAvailable = vi.fn().mockReturnValue(true)
  return { probes, control, MockPiRpcClient, mockPiBinaryAvailable }
})

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({
  locatePiLaunch: () => ({ command: '/fake/pi', args: [] }),
  piBinaryAvailable: mockPiBinaryAvailable
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: () => ({}) }))

const model = (id: string) => ({
  id,
  name: id,
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: false,
  input: ['text'],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
})
const OLD = [model('gpt-6-sol')]
const NEW = [model('gpt-6-sol'), model('gpt-6.1-sol')]
const ids = (models: Array<{ id: string }>): string[] => models.map((m) => m.id)

/** Let every queued microtask (probe bodies, `.finally`s) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function importFresh() {
  vi.resetModules()
  return import('../model-discovery')
}

beforeEach(() => {
  probes.length = 0
  control.autoAnswer = null
  MockPiRpcClient.mockClear()
  mockPiBinaryAvailable.mockReturnValue(true)
})

describe('pi discovery across an invalidation', () => {
  it('drops a warm catalog, so the next caller probes the pi that runs now', async () => {
    const d = await importFresh()
    const first = d.getPiModelCatalog()
    await settle()
    probes[0].answer(OLD)
    expect(ids(await first)).toEqual(['gpt-6-sol'])
    expect(d.peekPiCatalogCounts()).toEqual({ 'openai-codex': 1 })

    d.invalidatePiModelCache()
    expect(d.peekPiCatalogCounts()).toBeNull()
    expect(d.peekPiModels()).toBeNull()

    const second = d.getPiModelCatalog()
    await settle()
    expect(probes).toHaveLength(2)
    probes[1].answer(NEW)
    expect(ids(await second)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
  })

  it('a new caller never joins the obsolete probe, and the obsolete probe is killed', async () => {
    const d = await importFresh()
    const before = d.getPiModelCatalog()
    await settle()
    expect(probes).toHaveLength(1)

    d.invalidatePiModelCache()
    expect(probes[0].dispose).toHaveBeenCalled()
    const after = d.getPiModelCatalog()
    await settle()
    // A second probe — not a join onto the first.
    expect(probes).toHaveLength(2)

    probes[1].answer(NEW)
    // The caller from BEFORE the invalidation gets the new generation's answer.
    expect(ids(await before)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
    expect(ids(await after)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
  })

  it('an old answer that arrives AFTER the new one cannot overwrite it', async () => {
    const d = await importFresh()
    // Keep the old probe alive past the invalidation (its kill is a no-op here).
    const old = d.getPiModelCatalog()
    await settle()
    probes[0].dispose.mockImplementation(() => {})
    d.invalidatePiModelCache()

    const fresh = d.discoverPiModels()
    await settle()
    probes[1].answer(NEW)
    expect((await fresh)[0].models.map((m) => m.value)).toEqual([
      'openai-codex/gpt-6-sol',
      'openai-codex/gpt-6.1-sol'
    ])

    probes[0].answer(OLD)
    await settle()
    expect(ids(await old)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
    expect(d.peekPiCatalogCounts()).toEqual({ 'openai-codex': 2 })
    expect(d.peekPiModels()?.[0].models).toHaveLength(2)
    expect(d.peekPiModelContextWindow('openai-codex', 'gpt-6.1-sol')).toBe(128_000)
  })

  it('an old failure installs no negative cache and does not clear the new in-flight probe', async () => {
    const d = await importFresh()
    void d.getPiModelCatalog()
    await settle()
    probes[0].dispose.mockImplementation(() => {})
    d.invalidatePiModelCache()

    const fresh = d.getPiModelCatalog()
    await settle()
    expect(probes).toHaveLength(2)

    // The old probe fails while the new one is still in flight.
    probes[0].fail(new Error('timed out'))
    await settle()
    // Joining, not re-spawning: the old failure's cleanup left the entry alone.
    const joined = d.getPiModelCatalog()
    await settle()
    expect(probes).toHaveLength(2)

    probes[1].answer(NEW)
    expect(ids(await fresh)).toHaveLength(2)
    expect(ids(await joined)).toHaveLength(2)
    // And no negative cache: the answer is cached, not suppressed.
    expect(ids(await d.getPiModelCatalog())).toHaveLength(2)
    expect(probes).toHaveLength(2)
  })

  it('after an uninstall the old catalog stays gone, even when the old probe answers late', async () => {
    const d = await importFresh()
    const old = d.getPiModelCatalog()
    await settle()
    probes[0].dispose.mockImplementation(() => {})

    mockPiBinaryAvailable.mockReturnValue(false)
    d.invalidatePiModelCache()
    probes[0].answer(OLD)

    expect(await old).toEqual([])
    expect(await d.discoverPiModels()).toEqual([])
    expect(d.peekPiModels()).toBeNull()
    expect(d.peekPiCatalogCounts()).toBeNull()
    // No probe was spawned for a pi that is not there.
    expect(probes).toHaveLength(1)
  })

  it('stops retrying when invalidations keep overtaking it, answering [] rather than an old catalog', async () => {
    const d = await importFresh()
    const caller = d.getPiModelCatalog()
    for (let i = 0; i < 3; i++) {
      await settle()
      probes[i].dispose.mockImplementation(() => {})
      d.invalidatePiModelCache()
      probes[i].answer(OLD)
    }
    expect(await caller).toEqual([])
    // One probe per generation it tried: the first and two retries.
    expect(probes).toHaveLength(3)
  })

  it.each([
    ['discoverPiModels', (d: Discovery) => d.discoverPiModels()],
    ['getPiModelCatalog', (d: Discovery) => d.getPiModelCatalog()],
    ['getPiModelCatalogGroups', (d: Discovery) => d.getPiModelCatalogGroups()]
  ] as const)(
    '%s never answers from a generation an invalidation superseded, at any microtask',
    async (_name, read) => {
      const fresh = await importFresh()
      control.autoAnswer = NEW
      const want = JSON.stringify(await read(fresh))
      control.autoAnswer = null
      let decisive = 0
      for (let hops = 0; hops <= 40; hops++) {
        probes.length = 0
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
        probes[0].dispose.mockImplementation(() => {})
        control.autoAnswer = NEW
        let invalidatedAt = -1
        // Microtasks only from here to the answer: the clock would starve a timer.
        let value: string
        clock = startClock()
        try {
          probes[0].answer(OLD)
          afterHops(hops, () => {
            invalidatedAt = clock.tick
            d.invalidatePiModelCache()
          })
          value = JSON.stringify(await answer)
        } finally {
          // Always: a running clock would starve every timer, the test's own included.
          clock.stop()
        }
        await settle()
        control.autoAnswer = null
        // Resolved more than a hop after the invalidation ran: it must be the
        // new generation's answer. Within a hop either answer is legitimate.
        if (answeredAt > invalidatedAt + 1) {
          decisive++
          expect(value, `hops=${hops}`).toBe(want)
        }
      }
      // The sweep reached the window where an old answer would be wrong.
      expect(decisive).toBeGreaterThan(0)
    }
  )
})

type Discovery = Awaited<ReturnType<typeof importFresh>>

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
