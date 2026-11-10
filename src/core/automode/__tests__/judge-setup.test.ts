/**
 * JudgeSetup — the auto-mode judge setup every owner (PiSession, OpencodeSession,
 * DispatchTargetJudge) holds one of: memoized configs, the stale-model rule, the fallback rules,
 * the one-per-owner banners, and transports built from per-call thunks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoModeConfig } from '../../../shared/types'
import type { JudgeTransport } from '../classifier'
import { JudgeSetup, type JudgeSetupOptions } from '../judge-setup'
import type { SessionJudgeOptions } from '../session-judge'

const { mockLogger, ground, accountPlan } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ground: {
    remotes: vi.fn(async () => [] as unknown[]),
    visibility: vi.fn(async () => 'private')
  },
  // The plan a fallback judge's label names (`<model> (<Plan> account)`).
  accountPlan: vi.fn((_accountId: string): string | undefined => undefined)
}))
vi.mock('../../services/logger', () => ({ logger: mockLogger }))
vi.mock('../judge-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../judge-accounts')>()),
  chatgptAccountPlan: accountPlan
}))
vi.mock('../ground-truth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ground-truth')>()),
  captureGitRemotes: ground.remotes,
  captureRepoVisibility: ground.visibility
}))

const PRIMARY = 'anthropic/primary'
const FALLBACK = 'anthropic/fallback'

interface Harness {
  setup: JudgeSetup
  reports: string[]
  built: SessionJudgeOptions[]
  state: { model: string; routingId: string; catalog: string[] }
  loadEngineConfig: ReturnType<typeof vi.fn>
  loadSharedConfig: ReturnType<typeof vi.fn>
}

function make(autoMode: AutoModeConfig, extra: Partial<JudgeSetupOptions> = {}): Harness {
  const reports: string[] = []
  const built: SessionJudgeOptions[] = []
  const state = { model: 'own/model', routingId: 'route-1', catalog: [] as string[] }
  const loadEngineConfig = vi.fn(() => ({ autoMode }))
  const loadSharedConfig = vi.fn(() => ({}))
  const setup = new JudgeSetup({
    engine: 'pi',
    logSource: 'TestOwner',
    cwd: '/work',
    model: () => state.model,
    sessionId: () => 'sess-1',
    routingId: () => state.routingId,
    report: (m) => reports.push(m),
    catalogValues: () => state.catalog,
    loadEngineConfig: loadEngineConfig as unknown as JudgeSetupOptions['loadEngineConfig'],
    loadSharedConfig,
    makeTransport: (o): JudgeTransport => {
      built.push(o)
      return async () => ({ text: '' }) as never
    },
    ...extra
  })
  return { setup, reports, built, state, loadEngineConfig, loadSharedConfig }
}

beforeEach(() => {
  vi.clearAllMocks()
  accountPlan.mockImplementation(() => undefined)
})

describe('config memoization', () => {
  it('loads lazily, once, for the engine asked', () => {
    const h = make({ judgeModel: PRIMARY })
    expect(h.loadEngineConfig).not.toHaveBeenCalled()
    expect(h.setup.config().judgeModel).toBe(PRIMARY)
    h.setup.config()
    expect(h.loadEngineConfig).toHaveBeenCalledTimes(1)
    expect(h.loadEngineConfig).toHaveBeenCalledWith('pi')
  })

  it('a throwing loader yields {} and is not retried', () => {
    const h = make({})
    h.loadEngineConfig.mockImplementation(() => {
      throw new Error('boom')
    })
    h.loadSharedConfig.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(h.setup.config()).toEqual({})
    expect(h.setup.config()).toEqual({})
    expect(h.setup.shared()).toEqual({})
    h.setup.shared()
    expect(h.loadEngineConfig).toHaveBeenCalledTimes(1)
    expect(h.loadSharedConfig).toHaveBeenCalledTimes(1)
  })

  it('an engine config without an autoMode block is {}', () => {
    const h = make({})
    h.loadEngineConfig.mockReturnValue({})
    expect(h.setup.config()).toEqual({})
  })
})

describe('active(mode)', () => {
  it('is on for auto and full only, off when the config disables it', () => {
    const on = make({})
    expect(on.setup.active('auto')).toBe(true)
    expect(on.setup.active('full')).toBe(true)
    expect(on.setup.active('default')).toBe(false)
    expect(on.setup.active('acceptEdits')).toBe(false)
    expect(make({ enabled: false }).setup.active('auto')).toBe(false)
  })
})

describe('git facts', () => {
  it('captures remotes and visibility once, sharing the in-flight promise', async () => {
    const h = make({})
    expect(h.setup.resolvedVisibility()).toBeUndefined()
    const [a, b] = await Promise.all([h.setup.gitRemotes(), h.setup.gitRemotes()])
    expect(a).toBe(b)
    await h.setup.gitRemotes()
    const [v1, v2] = await Promise.all([h.setup.repoVisibility(), h.setup.repoVisibility()])
    expect([v1, v2]).toEqual(['private', 'private'])
    expect(h.setup.resolvedVisibility()).toBe('private')
    expect(ground.remotes).toHaveBeenCalledTimes(1)
    expect(ground.remotes).toHaveBeenCalledWith('/work')
    expect(ground.visibility).toHaveBeenCalledTimes(1)
  })
})

describe('primaryStale', () => {
  it('is false with no configured model, and for an empty or listing catalog', () => {
    expect(make({}).setup.primaryStale(['x'])).toBe(false)
    const h = make({ judgeModel: PRIMARY })
    expect(h.setup.primaryStale([])).toBe(false)
    expect(h.setup.primaryStale([PRIMARY, 'x'])).toBe(false)
    expect(h.reports).toEqual([])
  })

  it('is true when a configured model is missing from a non-empty list; one banner only', () => {
    const h = make({ judgeModel: PRIMARY })
    expect(h.setup.primaryStale(['x'])).toBe(true)
    expect(h.setup.primaryStale(['x'])).toBe(true)
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toContain(PRIMARY)
  })

  it('names the fallback in the banner, which is built after the stale-fallback log line', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.state.catalog = ['x']
    expect(h.setup.primaryStale(['x'])).toBe(true)
    // The fallback is gone too: one log line, and the banner names no fallback.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(h.reports[0]).not.toContain(FALLBACK)
  })
})

describe('fallback rules', () => {
  it('none set -> none', () => {
    expect(make({ judgeModel: PRIMARY }).setup.fallbackModel()).toBeUndefined()
  })

  it('the same as the primary (judgeModel or own model) -> none', () => {
    expect(make({ judgeModel: PRIMARY, fallbackJudgeModel: PRIMARY }).setup.fallbackModel()).toBe(
      undefined
    )
    expect(make({ fallbackJudgeModel: 'own/model' }).setup.fallbackModel()).toBeUndefined()
  })

  it('is kept on an empty or listing catalog', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    expect(h.setup.fallbackModel()).toBe(FALLBACK)
    h.state.catalog = [FALLBACK]
    expect(h.setup.fallbackModel()).toBe(FALLBACK)
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  it('missing from a non-empty catalog -> none, logged once under the owner source', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.state.catalog = ['x']
    expect(h.setup.fallbackModel()).toBeUndefined()
    expect(h.setup.fallbackModel()).toBeUndefined()
    expect(h.setup.fallbackLabel()).toBeUndefined()
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockLogger.warn).toHaveBeenCalledWith('TestOwner', expect.stringContaining(FALLBACK))
  })

  it('judgeModelValue follows the owner model when no judge model is configured', () => {
    const h = make({})
    expect(h.setup.judgeModelValue()).toBe('own/model')
    h.state.model = 'other/model'
    expect(h.setup.judgeModelValue()).toBe('other/model')
  })
})

describe('route-unavailable banners', () => {
  it('the primary banner shows once; the fallback banner has its own flag', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.setup.reportRouteUnavailable('no route')
    h.setup.reportRouteUnavailable('no route')
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toContain(FALLBACK)
    h.setup.reportFallbackRouteUnavailable(FALLBACK, 'down')
    h.setup.reportFallbackRouteUnavailable(FALLBACK, 'down')
    expect(h.reports).toHaveLength(2)
    expect(h.reports[1]).toContain('down')
  })

  it('a transport failure reaches the primary banner, or the caller override instead', () => {
    const h = make({ judgeModel: PRIMARY })
    h.setup.transport()
    h.built[0].onUnavailable('route gone')
    expect(h.reports).toHaveLength(1)
    const seen: string[] = []
    h.setup.transport((r) => seen.push(r))
    h.built[1].onUnavailable('again')
    expect(seen).toEqual(['again'])
    expect(h.reports).toHaveLength(1)
  })

  it('a fallback failure reaches its banner, or the override with a label computed then', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.setup.fallbackJudge()
    h.built[0].onUnavailable('down')
    expect(h.reports).toHaveLength(1)
    const seen: Array<[string, string]> = []
    const fallback = h.setup.fallbackJudge((label, reason) => seen.push([label, reason]))
    expect(fallback?.label).toBe(FALLBACK)
    h.built[1].onUnavailable('down again')
    expect(seen).toEqual([[FALLBACK, 'down again']])
    expect(h.reports).toHaveLength(1)
  })

  it('names the fallback by the label in force when its failure is reported, not when it was built', () => {
    // The plan behind the label can change between building the fallback judge and its failure
    // (the accounts snapshot refreshes). Every owner reports with the label as it is then.
    const h = make({
      judgeModel: PRIMARY,
      fallbackJudgeModel: FALLBACK,
      fallbackJudgeAccount: 'acct-1'
    })
    accountPlan.mockImplementation(() => 'plus')
    const seen: Array<[string, string]> = []
    const fallback = h.setup.fallbackJudge((label, reason) => seen.push([label, reason]))
    // The label the pipeline is handed is still the one built with the judge.
    expect(fallback?.label).toBe(`${FALLBACK} (Plus account)`)
    accountPlan.mockImplementation(() => 'pro')
    h.built[0].onUnavailable('down')
    expect(seen).toEqual([[`${FALLBACK} (Pro account)`, 'down']])

    // The banner path, without an override.
    h.setup.fallbackJudge()
    accountPlan.mockImplementation(() => 'team')
    h.built[1].onUnavailable('down')
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toContain(`${FALLBACK} (Team account)`)
  })

  it('fallbackJudge is undefined when no fallback is in effect', () => {
    expect(make({ judgeModel: PRIMARY }).setup.fallbackJudge()).toBeUndefined()
  })
})

describe('transports read the live thunks when built', () => {
  it('a re-keyed routing id reaches the next transport, primary and fallback', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.setup.transport()
    h.state.routingId = 'route-2'
    h.setup.transport()
    h.setup.fallbackJudge()
    expect(h.built.map((o) => o.routingId)).toEqual(['route-1', 'route-2', 'route-2'])
    expect(h.built[0].engine).toBe('pi')
    expect(h.built[0].sessionId()).toBe('sess-1')
  })

  it('a changed model reaches the transport when it resolves the judge model', () => {
    const h = make({})
    h.setup.transport()
    expect(h.built[0].modelValue()).toBe('own/model')
    h.state.model = 'new/model'
    expect(h.built[0].modelValue()).toBe('new/model')
    h.setup.transport()
    expect(h.built[1].modelValue()).toBe('new/model')
  })

  it('the fallback transport is pinned to the fallback model and its account', () => {
    const h = make({ judgeModel: PRIMARY, fallbackJudgeModel: FALLBACK })
    h.setup.fallbackJudge()
    expect(h.built[0].modelValue()).toBe(FALLBACK)
    expect(h.built[0].chatgptAccountId?.()).toBeUndefined()
  })
})
