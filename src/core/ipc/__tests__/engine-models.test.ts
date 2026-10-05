/**
 * @vitest-environment node
 *
 * `listEngineModels` — what `session:get-engine-models` answers on both
 * transports. Asked for one engine, only that engine is probed (the composer's
 * per-engine requests: one slow pi probe must not hold back Claude's,
 * opencode's and Codex's models). Asked for all, the engines are probed
 * concurrently and the groups keep their order. Each engine degrades to [] on
 * its own, and an engine id that is not one rejects.
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

  it('null asks for every engine, like no argument (a JSON wire sends `undefined` as null)', async () => {
    discoverOpencodeModels.mockResolvedValue([group('opencode', 'zen')])
    discoverPiModels.mockResolvedValue([])
    discoverCodexModels.mockResolvedValue([])

    const groups = await listEngineModels(async () => [opus], null)
    expect(groups.map((g) => g.engineId)).toEqual(['claude', 'opencode'])
  })
})

describe('listEngineModels for one engine', () => {
  it.each([
    ['opencode', discoverOpencodeModels, 'zen'],
    ['pi', discoverPiModels, 'openrouter'],
    ['codex', discoverCodexModels, 'openai']
  ] as const)(
    '%s: runs only its own lookup and answers only its groups',
    async (id, own, vendor) => {
      const claudeModels = vi.fn(async () => [opus])
      own.mockResolvedValue([group(id, vendor)])

      const groups = await listEngineModels(claudeModels, id)

      expect(groups.map((g) => `${g.engineId}:${g.vendorId}`)).toEqual([`${id}:${vendor}`])
      expect(own).toHaveBeenCalledTimes(1)
      expect(claudeModels).not.toHaveBeenCalled()
      for (const lookup of [discoverOpencodeModels, discoverPiModels, discoverCodexModels]) {
        if (lookup !== own) expect(lookup).not.toHaveBeenCalled()
      }
    }
  )

  it('claude: answers the one stamped group without probing any other engine', async () => {
    const groups = await listEngineModels(async () => [opus], 'claude')

    expect(groups).toEqual([
      {
        engineId: 'claude',
        vendorId: 'anthropic',
        vendorName: 'Anthropic',
        models: [{ ...opus, engineId: 'claude', vendorId: 'anthropic' }]
      }
    ])
    expect(discoverOpencodeModels).not.toHaveBeenCalled()
    expect(discoverPiModels).not.toHaveBeenCalled()
    expect(discoverCodexModels).not.toHaveBeenCalled()
  })

  it('degrades to its empty contribution, never a rejection', async () => {
    discoverPiModels.mockRejectedValue(new Error('probe timed out'))
    await expect(listEngineModels(async () => [], 'pi')).resolves.toEqual([])
    await expect(
      listEngineModels(async () => {
        throw new Error('not logged in')
      }, 'claude')
    ).resolves.toEqual([expect.objectContaining({ engineId: 'claude', models: [] })])
  })

  it.each([['gemini'], [''], [42], [{ engineId: 'pi' }]])(
    'rejects %j — a client bug is never answered as an engine with no models',
    async (bad) => {
      const claudeModels = vi.fn(async () => [opus])
      await expect(listEngineModels(claudeModels, bad)).rejects.toThrow(/unknown engine/)
      expect(claudeModels).not.toHaveBeenCalled()
      expect(discoverOpencodeModels).not.toHaveBeenCalled()
      expect(discoverPiModels).not.toHaveBeenCalled()
      expect(discoverCodexModels).not.toHaveBeenCalled()
    }
  )
})
