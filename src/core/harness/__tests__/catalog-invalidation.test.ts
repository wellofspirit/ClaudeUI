/**
 * @vitest-environment node
 *
 * `startCatalogInvalidation` (ADR-082): an engine's model catalog goes with
 * the binary that answered it. Driven through the REAL resolver event
 * (`invalidateHarness` → `onHarnessChanged`) and, for pi, the real discovery
 * cache — only what the harness resolves to is injected, so a test can say
 * "the binary changed" or "it did not" without a filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HarnessId } from '../../../shared/harness-types'

const { mockRequest, MockPiRpcClient } = vi.hoisted(() => {
  const mockRequest = vi.fn()
  // A regular function: production code calls it with `new`.
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    return { start: vi.fn().mockResolvedValue(undefined), request: mockRequest, dispose: vi.fn() }
  })
  return { mockRequest, MockPiRpcClient }
})

vi.mock('../../pi/PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../../pi/pi-locate', () => ({
  locatePiLaunch: () => ({ command: '/fake/pi', args: [] }),
  piBinaryAvailable: () => true
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: () => ({}) }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { invalidateHarness } from '../resolve'
import { startCatalogInvalidation } from '../catalog-invalidation'
import {
  getPiModelCatalog,
  invalidatePiModelCache,
  peekPiCatalogCounts
} from '../../pi/model-discovery'

const catalog = (ids: string[]) => ({
  success: true,
  data: {
    models: ids.map((id) => ({
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
    }))
  }
})

/** What each harness resolves to, as the injected identity reads it. */
let resolved: Record<string, string>
let stop: () => void = () => {}

beforeEach(() => {
  resolved = { pi: 'pi 0.87.1', opencode: 'opencode 1.18.32', codex: 'codex', claude: 'claude' }
  mockRequest.mockReset()
  invalidatePiModelCache()
})
afterEach(() => stop())

function start(invalidate: { pi: () => void; opencode: () => void }): void {
  stop = startCatalogInvalidation(invalidate, { identity: (id) => resolved[id] })
}

describe('startCatalogInvalidation', () => {
  it('drops the warm pi catalog when the resolver now answers a different pi', async () => {
    mockRequest.mockResolvedValueOnce(catalog(['gpt-6-sol']))
    await getPiModelCatalog()
    expect(peekPiCatalogCounts()).toEqual({ 'openai-codex': 1 })
    start({ pi: invalidatePiModelCache, opencode: vi.fn() })

    resolved.pi = 'pi 0.99.2'
    invalidateHarness('pi')
    expect(peekPiCatalogCounts()).toBeNull()

    mockRequest.mockResolvedValueOnce(catalog(['gpt-6-sol', 'gpt-6.1-sol']))
    expect((await getPiModelCatalog()).map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
  })

  it('keeps a warm catalog through an invalidation that changed nothing (the boot detection)', async () => {
    mockRequest.mockResolvedValueOnce(catalog(['gpt-6-sol']))
    await getPiModelCatalog()
    const opencode = vi.fn()
    start({ pi: invalidatePiModelCache, opencode })

    invalidateHarness()
    expect(peekPiCatalogCounts()).toEqual({ 'openai-codex': 1 })
    expect(opencode).not.toHaveBeenCalled()
  })

  it('invalidates only the engine whose harness changed, once per change', () => {
    const pi = vi.fn()
    const opencode = vi.fn()
    start({ pi, opencode })

    resolved.opencode = 'opencode 1.18.34'
    invalidateHarness()
    invalidateHarness('opencode')
    expect(opencode).toHaveBeenCalledTimes(1)
    expect(pi).not.toHaveBeenCalled()
  })

  it('treats an uninstall as a change, and reinstalling the same binary as another', () => {
    const pi = vi.fn()
    start({ pi, opencode: vi.fn() })

    resolved.pi = 'none'
    invalidateHarness('pi')
    resolved.pi = 'pi 0.87.1'
    invalidateHarness('pi')
    expect(pi).toHaveBeenCalledTimes(2)
  })

  it('ignores harnesses whose catalogs it does not own', () => {
    const pi = vi.fn()
    const opencode = vi.fn()
    start({ pi, opencode })

    for (const id of ['codex', 'claude'] as HarnessId[]) {
      resolved[id] = `${id} next`
      invalidateHarness(id)
    }
    expect(pi).not.toHaveBeenCalled()
    expect(opencode).not.toHaveBeenCalled()
  })

  it('stops listening when stopped, and a second start replaces the first', () => {
    const first = vi.fn()
    start({ pi: first, opencode: vi.fn() })
    const second = vi.fn()
    start({ pi: second, opencode: vi.fn() })

    resolved.pi = 'pi 0.99.2'
    invalidateHarness('pi')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    stop()
    resolved.pi = 'pi 1.0.0'
    invalidateHarness('pi')
    expect(second).toHaveBeenCalledTimes(1)
  })
})
