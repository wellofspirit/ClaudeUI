/**
 * @vitest-environment node
 *
 * `listEngineModels` — what `session:get-engine-models` answers on both
 * transports. The engines are probed concurrently (one slow pi probe must not
 * hold back Claude's, opencode's and Codex's models), the groups keep their
 * order, and each engine degrades to [] on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EngineModelGroup, ModelInfo } from '../../../shared/types'

const { discoverOpencodeModels, discoverPiModels, discoverCodexModels } = vi.hoisted(() => ({
  discoverOpencodeModels: vi.fn(),
  discoverPiModels: vi.fn(),
  discoverCodexModels: vi.fn()
}))
vi.mock('../../opencode/model-discovery', () => ({ discoverOpencodeModels }))
vi.mock('../../pi/model-discovery', () => ({ discoverPiModels }))
vi.mock('../../codex/model-discovery', () => ({ discoverCodexModels }))

import { listEngineModels } from '../engine-models'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const group = (engineId: EngineModelGroup['engineId'], vendorId: string): EngineModelGroup => ({
  engineId,
  vendorId,
  vendorName: vendorId,
  models: [{ value: `${vendorId}/m`, displayName: 'm', description: '', engineId, vendorId }]
})
const opus: ModelInfo = { value: 'opus', displayName: 'Opus', description: '' }

beforeEach(() => {
  discoverOpencodeModels.mockReset()
  discoverPiModels.mockReset()
  discoverCodexModels.mockReset()
})

describe('listEngineModels', () => {
  it('starts every engine before any answers, and keeps claude, opencode, pi, codex order', async () => {
    const claude = deferred<ModelInfo[]>()
    const opencode = deferred<EngineModelGroup[]>()
    const pi = deferred<EngineModelGroup[]>()
    const codex = deferred<EngineModelGroup[]>()
    const claudeModels = vi.fn(() => claude.promise)
    discoverOpencodeModels.mockReturnValue(opencode.promise)
    discoverPiModels.mockReturnValue(pi.promise)
    discoverCodexModels.mockReturnValue(codex.promise)

    const answer = listEngineModels(claudeModels)
    // Nothing has resolved, yet all four lookups are already running.
    await Promise.resolve()
    expect(claudeModels).toHaveBeenCalledTimes(1)
    expect(discoverOpencodeModels).toHaveBeenCalledTimes(1)
    expect(discoverPiModels).toHaveBeenCalledTimes(1)
    expect(discoverCodexModels).toHaveBeenCalledTimes(1)

    // Settle in reverse order: the result order is fixed regardless.
    codex.resolve([group('codex', 'openai')])
    pi.resolve([group('pi', 'openrouter')])
    opencode.resolve([group('opencode', 'zen')])
    claude.resolve([opus])

    const groups = await answer
    expect(groups.map((g) => `${g.engineId}:${g.vendorId}`)).toEqual([
      'claude:anthropic',
      'opencode:zen',
      'pi:openrouter',
      'codex:openai'
    ])
    // Claude's bare ModelInfo is stamped so a pick is attributed to claude.
    expect(groups[0].models).toEqual([{ ...opus, engineId: 'claude', vendorId: 'anthropic' }])
  })

  it('a failing engine is an empty contribution, never a failed catalog', async () => {
    discoverOpencodeModels.mockRejectedValue(new Error('server did not start'))
    discoverPiModels.mockResolvedValue([group('pi', 'openrouter')])
    discoverCodexModels.mockRejectedValue(new Error('app-server crashed'))

    const groups = await listEngineModels(async () => {
      throw new Error('not logged in')
    })
    expect(groups.map((g) => `${g.engineId}:${g.vendorId}:${g.models.length}`)).toEqual([
      'claude:anthropic:0',
      'pi:openrouter:1'
    ])
  })
})
