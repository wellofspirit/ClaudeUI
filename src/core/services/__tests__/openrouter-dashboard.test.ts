/** @vitest-environment node */
/**
 * The OpenRouter tab's service (Slice A, Critical): what it sends where, what it
 * returns, and that the vault key appears in nothing it says. Fetch and vault are
 * fakes; no network is touched. Every identifier in the fixtures is a placeholder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterDashboard } from '../openrouter-dashboard'
import { apiKeyAccountKey } from '../account-key-hash'
import type { RemoteUsageBucketRow, UsageBucketRow } from '../db'
import {
  BENCHMARKS_BODY,
  COUNT_BODY,
  CREDITS_BODY,
  ENDPOINTS_BODY,
  KEY_BODY,
  MODELS_ALL_BODY,
  MODELS_USER_BODY
} from './openrouter-fixtures'

const SENTINEL = 'sk-or-v1-SENTINEL-DO-NOT-LEAK'
const OTHER_KEY = 'sk-or-v1-OTHER-KEY-DO-NOT-LEAK'
const BASE = 'https://openrouter.ai/api/v1'
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)

type Route = (() => Response) | Response | unknown
interface Call {
  url: string
  path: string
  init: RequestInit & { headers: Record<string, string> }
}

function setup(opts: { key?: string | null; routes?: Record<string, Route> } = {}) {
  let key: string | null = opts.key === undefined ? SENTINEL : opts.key
  let now = NOW
  const routes: Record<string, Route> = {
    '/key': KEY_BODY,
    '/credits': CREDITS_BODY,
    '/models/count': COUNT_BODY,
    '/models/user': MODELS_USER_BODY,
    '/models': MODELS_ALL_BODY,
    '/benchmarks': BENCHMARKS_BODY,
    '/models/deepseek/deepseek-v4.1-flash/endpoints': ENDPOINTS_BODY,
    ...opts.routes
  }
  const calls: Call[] = []
  const fetchFn = vi.fn(async (url: string, init: Call['init']) => {
    const path = url.slice(BASE.length)
    calls.push({ url, path, init })
    const route = routes[path]
    if (route === undefined) return new Response('not found', { status: 404 })
    if (typeof route === 'function') return (route as () => Response)()
    if (route instanceof Response) return route.clone()
    return new Response(JSON.stringify(route), { status: 200 })
  })
  const vault = {
    loadCredential: vi.fn(async () => (key === null ? null : { type: 'api_key' as const, key })),
    hasApiKey: vi.fn(async () => key !== null && key.length > 0)
  }
  const log = { debug: vi.fn(), warn: vi.fn() }
  const ledger = {
    local: vi.fn((): UsageBucketRow[] => []),
    remote: vi.fn((): RemoteUsageBucketRow[] => []),
    self: vi.fn((): { deviceId: string } | null => null)
  }
  const service = new OpenRouterDashboard({
    vault,
    fetch: async () => fetchFn as unknown as typeof fetch,
    now: () => now,
    logger: log,
    ledger
  })
  return {
    service,
    calls,
    fetchFn,
    vault,
    log,
    ledger,
    setKey: (next: string | null) => void (key = next),
    advance: (ms: number) => void (now += ms),
    pathsCalled: () => calls.map((c) => c.path)
  }
}

/** The key must be in no message, return value or log line, whichever key it was. */
function expectNoKey(value: unknown, ...keys: string[]): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const key of keys.length ? keys : [SENTINEL, OTHER_KEY]) {
    expect(text).not.toContain(key)
    expect(text).not.toContain(key.slice(-12))
  }
}
function expectLogsClean(log: { debug: unknown; warn: unknown }): void {
  expectNoKey([
    (log.debug as ReturnType<typeof vi.fn>).mock.calls,
    (log.warn as ReturnType<typeof vi.fn>).mock.calls
  ])
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected a rejection')
}

const bucket = (over: Partial<UsageBucketRow>): UsageBucketRow => ({
  hourUtc: Date.UTC(2026, 9, 5, 10),
  accountKey: 'x',
  billingType: 'apiKey',
  engineId: 'opencode',
  vendorId: 'openrouter',
  modelId: 'm',
  origin: 'session',
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  apiCostUsd: 0,
  billedCostUsd: 0,
  unbilledApiCostUsd: 0,
  unknownApiCostCount: 0,
  unknownBilledCostCount: 0,
  requestCount: 1,
  source: 'rollup',
  rev: 1,
  ...over
})

let digest: string
beforeEach(() => {
  digest = apiKeyAccountKey('openrouter', SENTINEL).accountKey
})

describe('A1 — no key', () => {
  it('status says unconfigured and every read refuses before any request', async () => {
    const t = setup({ key: null })
    expect(await t.service.status()).toEqual({ configured: false })
    await expect(t.service.overview()).rejects.toThrow('No OpenRouter API key')
    await expect(t.service.models('user')).rejects.toThrow('No OpenRouter API key')
    await expect(t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')).rejects.toThrow(
      'No OpenRouter API key'
    )
    expect(t.fetchFn).not.toHaveBeenCalled()
  })

  it('an empty key and an OAuth-shaped record are no key either', async () => {
    const t = setup({ key: '' })
    await expect(t.service.overview()).rejects.toThrow('No OpenRouter API key')
    t.vault.loadCredential.mockResolvedValueOnce({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1
    } as never)
    await expect(t.service.models('all')).rejects.toThrow('No OpenRouter API key')
    expect(t.fetchFn).not.toHaveBeenCalled()
  })

  it('status reads presence only', async () => {
    const t = setup()
    expect(await t.service.status()).toEqual({ configured: true })
    expect(t.vault.loadCredential).not.toHaveBeenCalled()
  })
})

describe('A2 — overview mapping', () => {
  it('maps /key, /credits and the counts exactly, and drops the account identifiers', async () => {
    const t = setup()
    const overview = await t.service.overview()
    expect(overview).toEqual({
      fetchedAt: NOW,
      key: {
        label: 'sk-or-v1-...abc',
        limitUsd: 100,
        limitRemainingUsd: 57.5,
        limitReset: 'monthly',
        resetsAt: '2026-11-01T00:00:00.000Z',
        includeByokInLimit: false,
        usage: {
          dailyUsd: 0,
          weeklyUsd: 3.25,
          monthlyUsd: 42.5,
          totalUsd: 210.75
        },
        byokUsage: { dailyUsd: 0, weeklyUsd: 0.5, monthlyUsd: 1, totalUsd: 1.5 },
        isFreeTier: false,
        expiresAt: null,
        dataRegions: ['global'],
        freeModelRequests: { used: 0, limit: 1000, remaining: 1000 }
      },
      credits: { totalUsd: 1500, usedUsd: 480.25 },
      models: { available: 3, total: 464 },
      ledger: { sinceUtc: '2026-10-01T00:00:00.000Z', costUsd: 0, machines: 1 },
      partialErrors: {}
    })
    const text = JSON.stringify(overview)
    for (const dropped of [
      'user_TEST',
      '0000-0000',
      'creator_user_id',
      'workspace_id',
      'rate_limit',
      'budgets'
    ]) {
      expect(text).not.toContain(dropped)
    }
    expectNoKey(overview)
  })

  it('an unknown reset interval passes through as null, a missing free-model block as null', async () => {
    const body = structuredClone(KEY_BODY)
    body.data.effective_budget.reset_interval = 'fortnightly'
    delete (body.data as Record<string, unknown>).free_model_daily_requests
    const overview = await setup({ routes: { '/key': body } }).service.overview()
    expect(overview.key.limitReset).toBeNull()
    expect(overview.key.freeModelRequests).toBeNull()
  })
})

describe('A3 — partial failure and key rejection', () => {
  it('/credits 500 → credits null with a partial error, the rest intact', async () => {
    const t = setup({ routes: { '/credits': () => new Response('boom', { status: 500 }) } })
    const overview = await t.service.overview()
    expect(overview.credits).toBeNull()
    expect(overview.partialErrors).toEqual({ credits: 'OpenRouter is unavailable' })
    expect(overview.key.label).toBe('sk-or-v1-...abc')
    expect(overview.models).toEqual({ available: 3, total: 464 })
  })

  it('/models/count failing leaves available set and total null, under one models error', async () => {
    const t = setup({ routes: { '/models/count': () => new Response('', { status: 429 }) } })
    const overview = await t.service.overview()
    expect(overview.models).toEqual({ available: 3, total: null })
    expect(overview.partialErrors).toEqual({ models: 'OpenRouter rate limit reached' })
  })

  it('/key 401 fails the whole call with the fixed message and no key anywhere', async () => {
    const t = setup({ routes: { '/key': () => new Response(`bad ${SENTINEL}`, { status: 401 }) } })
    const message = await messageOf(t.service.overview())
    expect(message).toBe('OpenRouter rejected the key')
    expectNoKey(message)
    expectLogsClean(t.log)
  })

  it('a network failure becomes "Could not reach OpenRouter" and the cause is dropped', async () => {
    const t = setup()
    t.fetchFn.mockRejectedValue(new TypeError(`fetch failed for Bearer ${SENTINEL}`))
    const message = await messageOf(t.service.overview())
    expect(message).toBe('Could not reach OpenRouter')
    expectNoKey(message)
    expectLogsClean(t.log)
  })
})

describe('A4 — every request', () => {
  it('is a GET with redirect:error, a timeout, the constant base, and a bearer only where needed', async () => {
    const t = setup()
    await t.service.overview()
    await t.service.models('all')
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')

    const withKey = new Set([
      '/key',
      '/credits',
      '/models/user',
      '/benchmarks',
      '/models/deepseek/deepseek-v4.1-flash/endpoints'
    ])
    expect(new Set(t.pathsCalled())).toEqual(
      new Set([
        '/key',
        '/credits',
        '/models/count',
        '/models/user',
        '/models',
        '/benchmarks',
        '/models/deepseek/deepseek-v4.1-flash/endpoints'
      ])
    )
    for (const { url, path, init } of t.calls) {
      expect(url.startsWith(`${BASE}/`)).toBe(true)
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.headers['User-Agent']).toBe('ClaudeUI')
      if (withKey.has(path)) expect(init.headers.Authorization).toBe(`Bearer ${SENTINEL}`)
      else
        expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    }
  })

  it('the endpoints channel validates the model id before it reads the key', async () => {
    const t = setup()
    await expect(t.service.modelEndpoints('../keys')).rejects.toThrow('Invalid model id')
    expect(t.vault.loadCredential).not.toHaveBeenCalled()
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    expect(t.vault.loadCredential).toHaveBeenCalledTimes(1)
  })
})

describe('A5 — caller-supplied input', () => {
  const rejected: unknown[] = [
    'a/b/../../keys',
    'a/b?x=1',
    '../keys',
    'a/..',
    '../..',
    './x',
    'a/b#c',
    'a/b%2e%2e',
    '~/x',
    '~~a/b',
    '~../x',
    'a/~b',
    'a/b/c',
    '/a/b',
    'a/',
    '',
    undefined,
    null,
    42,
    { toString: () => 'a/b' }
  ]
  it.each(rejected.map((id) => [JSON.stringify(id) ?? 'undefined', id]))(
    'rejects %s before any request',
    async (_label, id) => {
      const t = setup()
      await expect(t.service.modelEndpoints(id)).rejects.toThrow('Invalid model id')
      expect(t.fetchFn).not.toHaveBeenCalled()
    }
  )

  it('builds the path from a dotted slug, and keeps a variant colon literal', async () => {
    const t = setup({ routes: { '/models/x/y:free/endpoints': ENDPOINTS_BODY } })
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    await t.service.modelEndpoints('x/y:free')
    expect(t.pathsCalled()).toEqual([
      '/models/deepseek/deepseek-v4.1-flash/endpoints',
      '/models/x/y:free/endpoints'
    ])
  })

  it("accepts OpenRouter's `~` latest-alias ids", async () => {
    const t = setup({ routes: { '/models/~openai/gpt-luna-latest/endpoints': ENDPOINTS_BODY } })
    await t.service.modelEndpoints('~openai/gpt-luna-latest')
    expect(t.pathsCalled()).toEqual(['/models/~openai/gpt-luna-latest/endpoints'])
  })

  it('rejects a scope that is not user or all', async () => {
    const t = setup()
    for (const scope of ['x', '', undefined, null, { scope: 'user' }, 'USER']) {
      await expect(t.service.models(scope)).rejects.toThrow('Invalid model scope')
    }
    expect(t.fetchFn).not.toHaveBeenCalled()
  })
})

describe('A5b — a 200 that is not what we expected, and the other statuses', () => {
  it('an HTML body and a JSON body missing required fields both read as unexpected', async () => {
    const html = `<html>captive portal ${SENTINEL} Unexpected token</html>`
    const t1 = setup({ routes: { '/key': () => new Response(html, { status: 200 }) } })
    const m1 = await messageOf(t1.service.overview())
    expect(m1).toBe('OpenRouter sent an unexpected response')
    expectNoKey(m1)
    expect(m1).not.toContain('captive')
    expect(JSON.stringify(t1.log.warn.mock.calls)).not.toContain('captive')
    expectLogsClean(t1.log)

    const t2 = setup({ routes: { '/key': { data: { usage: 1 } } } })
    expect(await messageOf(t2.service.overview())).toBe('OpenRouter sent an unexpected response')
    const t3 = setup({ routes: { '/key': { data: null } } })
    expect(await messageOf(t3.service.overview())).toBe('OpenRouter sent an unexpected response')
    const t4 = setup({ routes: { '/models/user': { data: 'nope' } } })
    expect(await messageOf(t4.service.models('user'))).toBe(
      'OpenRouter sent an unexpected response'
    )
  })

  it.each([
    [401, 'OpenRouter rejected the key'],
    [403, 'OpenRouter rejected the key'],
    [404, 'Not found on OpenRouter'],
    [418, 'OpenRouter answered 418'],
    [429, 'OpenRouter rate limit reached'],
    [503, 'OpenRouter is unavailable']
  ])('status %i → %s', async (status, message) => {
    const t = setup({ routes: { '/key': () => new Response(`teapot ${SENTINEL}`, { status }) } })
    const thrown = await messageOf(t.service.overview())
    expect(thrown).toBe(message)
    expectNoKey(thrown)
    expectLogsClean(t.log)
  })
})

describe('A5c — one budget source', () => {
  it('takes all four budget fields from a guardrail effective_budget', async () => {
    const body = structuredClone(KEY_BODY)
    body.data.effective_budget = {
      ...body.data.effective_budget,
      scope: 'guardrail',
      limit_usd: 20,
      remaining_usd: 4.5,
      reset_interval: 'daily',
      resets_at: '2026-10-28T00:00:00.000Z'
    }
    const { key } = await setup({ routes: { '/key': body } }).service.overview()
    expect(key).toMatchObject({
      limitUsd: 20,
      limitRemainingUsd: 4.5,
      limitReset: 'daily',
      resetsAt: '2026-10-28T00:00:00.000Z'
    })
  })

  it('a guardrail with no limit is "no limit", not the key’s own', async () => {
    const body = structuredClone(KEY_BODY)
    body.data.effective_budget = {
      ...body.data.effective_budget,
      scope: 'guardrail',
      limit_usd: null as never,
      remaining_usd: null as never,
      reset_interval: null as never,
      resets_at: null as never
    }
    const { key } = await setup({ routes: { '/key': body } }).service.overview()
    expect(key).toMatchObject({
      limitUsd: null,
      limitRemainingUsd: null,
      limitReset: null,
      resetsAt: null
    })
  })

  it('without effective_budget it uses the top-level fields and no reset time', async () => {
    const body = structuredClone(KEY_BODY) as { data: Record<string, unknown> }
    delete body.data.effective_budget
    const { key } = await setup({ routes: { '/key': body } }).service.overview()
    expect(key).toMatchObject({
      limitUsd: 100,
      limitRemainingUsd: 57.5,
      limitReset: 'monthly',
      resetsAt: null
    })
  })
})

describe('models', () => {
  it('maps prices to USD per million, joins the best benchmark row, and drops the join key', async () => {
    const rows = await setup().service.models('user')
    expect(rows).toEqual([
      {
        id: 'deepseek/deepseek-v4.1-flash-1017',
        name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
        contextLength: 1048576,
        promptPerM: 0.195,
        completionPerM: 0.78,
        cacheReadPerM: 0.0039,
        inputModalities: ['text', 'image'],
        reasoning: true,
        intelligenceIndex: 39.5,
        codingIndex: null
      },
      {
        id: 'moonshotai/kimi-k3',
        name: 'MoonshotAI: Kimi K3',
        contextLength: 1048576,
        promptPerM: 3,
        completionPerM: 15,
        cacheReadPerM: 0.3,
        inputModalities: ['text'],
        reasoning: false,
        intelligenceIndex: 43.6,
        codingIndex: 76.2
      },
      {
        id: 'z-ai/glm-5.3-flash',
        name: 'Z.ai: GLM 5.3 Flash',
        contextLength: 262144,
        promptPerM: 0.084,
        completionPerM: 0.28,
        cacheReadPerM: null,
        inputModalities: ['text'],
        reasoning: true,
        intelligenceIndex: null,
        codingIndex: null
      }
    ])
  })

  it('a router’s -1 price is no price; scope all uses the public catalog without the key', async () => {
    const t = setup()
    const rows = await t.service.models('all')
    expect(rows).toHaveLength(4)
    expect(rows.at(-1)).toMatchObject({
      id: 'openrouter/auto',
      promptPerM: null,
      completionPerM: null
    })
    expect(t.pathsCalled()).toEqual(['/models', '/benchmarks'])
  })

  it('a failing /benchmarks leaves the catalog, indices null, and is retried next time', async () => {
    const t = setup({ routes: { '/benchmarks': () => new Response('', { status: 500 }) } })
    const rows = await t.service.models('user')
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.intelligenceIndex === null)).toBe(true)
    await t.service.models('user')
    expect(t.pathsCalled().filter((p) => p === '/benchmarks')).toHaveLength(2)
    expect(t.pathsCalled().filter((p) => p === '/models/user')).toHaveLength(1)
  })
})

describe('endpoints mapping', () => {
  it('maps the health figures, nulls the absent ones and the "unknown" quantization', async () => {
    const rows = await setup().service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    expect(rows).toEqual([
      {
        provider: 'OpenInference',
        tag: 'open-inference/fp4',
        quantization: 'fp4',
        promptPerM: 0.02,
        completionPerM: 0.081571,
        contextLength: 1048576,
        status: 0,
        uptime1d: 97.98611111111111,
        uptime30m: 100,
        latencyP50Ms: 732,
        throughputP50: 91
      },
      {
        provider: 'Relace',
        tag: 'relace',
        quantization: null,
        promptPerM: 0.07,
        completionPerM: 0.5,
        contextLength: 1048576,
        status: -2,
        uptime1d: null,
        uptime30m: 80.5,
        latencyP50Ms: null,
        throughputP50: null
      }
    ])
  })
})

describe('A6 — caches', () => {
  it('serves models and benchmarks from cache within the TTL, and refetches after it', async () => {
    const t = setup()
    await t.service.models('user')
    await t.service.models('user')
    expect(t.pathsCalled()).toEqual(['/models/user', '/benchmarks'])
    // The other scope is its own entry; benchmarks are shared.
    await t.service.models('all')
    expect(t.pathsCalled()).toEqual(['/models/user', '/benchmarks', '/models'])

    t.advance(61 * 60_000)
    await t.service.models('user')
    // Catalog expired (1 h), benchmarks (6 h) did not.
    expect(t.pathsCalled().slice(3)).toEqual(['/models/user'])
    t.advance(6 * 60 * 60_000)
    await t.service.models('user')
    expect(t.pathsCalled().slice(4)).toEqual(['/models/user', '/benchmarks'])
  })

  it('a different key (different digest) misses every cache', async () => {
    const t = setup()
    await t.service.models('user')
    t.setKey(OTHER_KEY)
    await t.service.models('user')
    expect(t.pathsCalled()).toEqual(['/models/user', '/benchmarks', '/models/user', '/benchmarks'])
    expect(t.calls[2].init.headers.Authorization).toBe(`Bearer ${OTHER_KEY}`)
    // And swapping back does not resurrect the first key's entries.
    t.setKey(SENTINEL)
    await t.service.models('user')
    expect(t.pathsCalled()).toHaveLength(6)
  })

  it('concurrent overviews share one round of requests; the next one reads again', async () => {
    const t = setup()
    await Promise.all([t.service.overview(), t.service.overview(), t.service.overview()])
    expect(t.pathsCalled().filter((p) => p === '/key')).toHaveLength(1)
    await t.service.overview()
    expect(t.pathsCalled().filter((p) => p === '/key')).toHaveLength(2)
  })

  it('the overview fills the models(user) cache', async () => {
    const t = setup()
    await t.service.overview()
    t.calls.length = 0
    await t.service.models('user')
    expect(t.pathsCalled()).toEqual(['/benchmarks'])
  })

  it('endpoints are cached for 5 minutes', async () => {
    const t = setup()
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    expect(t.fetchFn).toHaveBeenCalledTimes(1)
    t.advance(5 * 60_000 + 1)
    await t.service.modelEndpoints('deepseek/deepseek-v4.1-flash')
    expect(t.fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('A7 — the ledger figure', () => {
  const monthStart = Date.UTC(2026, 9, 1)

  it('sums this key’s buckets since the UTC month began and ignores the rest', async () => {
    const t = setup()
    t.ledger.local.mockReturnValue([
      bucket({ accountKey: digest, billedCostUsd: 2.5 }),
      bucket({
        accountKey: digest,
        hourUtc: monthStart,
        billedCostUsd: 1,
        unbilledApiCostUsd: 0.25
      }),
      // Another key, last month, and an hour that has not happened yet.
      bucket({
        accountKey: apiKeyAccountKey('openrouter', OTHER_KEY).accountKey,
        billedCostUsd: 99
      }),
      bucket({ accountKey: digest, hourUtc: monthStart - 3_600_000, billedCostUsd: 50 }),
      bucket({ accountKey: digest, hourUtc: NOW + 3_600_000, billedCostUsd: 70 })
    ])
    const { ledger } = await t.service.overview()
    expect(ledger).toEqual({ sinceUtc: '2026-10-01T00:00:00.000Z', costUsd: 3.75, machines: 1 })
    expect(t.ledger.local).toHaveBeenCalledWith(monthStart)
    expect(t.ledger.remote).not.toHaveBeenCalled()
  })

  it('folds other machines’ rows only under a hub identity, never this device’s own copy', async () => {
    const t = setup()
    t.ledger.local.mockReturnValue([bucket({ accountKey: digest, billedCostUsd: 1 })])
    t.ledger.remote.mockReturnValue([
      { ...bucket({ accountKey: digest, billedCostUsd: 2 }), deviceId: 'phone' },
      {
        ...bucket({ accountKey: digest, billedCostUsd: 4, hourUtc: monthStart + 3_600_000 }),
        deviceId: 'phone'
      },
      { ...bucket({ accountKey: digest, billedCostUsd: 8 }), deviceId: 'me' },
      { ...bucket({ accountKey: 'someone-else', billedCostUsd: 16 }), deviceId: 'laptop' }
    ])
    expect((await t.service.overview()).ledger).toMatchObject({ costUsd: 1, machines: 1 })

    t.ledger.self.mockReturnValue({ deviceId: 'me' })
    expect((await t.service.overview()).ledger).toEqual({
      sinceUtc: '2026-10-01T00:00:00.000Z',
      costUsd: 7,
      machines: 2
    })
  })

  it('a ledger read that throws is null, not a failed overview', async () => {
    const t = setup()
    t.ledger.local.mockImplementation(() => {
      throw new Error('db locked')
    })
    const overview = await t.service.overview()
    expect(overview.ledger).toBeNull()
    expect(overview.key.label).toBe('sk-or-v1-...abc')
  })
})
