/**
 * A second key for a catalog provider (ADR-074 slice 10) — the rules the form
 * and the refresh apply, without a sheet: the id and name, what the form starts
 * with, the cap, and what a declared copy of a catalog model carries.
 */
import { describe, expect, it } from 'vitest'
import {
  CLONE_MODEL_CAP,
  catalogEndpoint,
  cloneIdError,
  cloneIdentity,
  cloneSlug,
  declareModels,
  endpointUrlError,
  formatCopiedAt,
  originPicks,
  seedClonePicks,
  today,
  withinCap,
  type CloneCatalogModel
} from '../provider-clone'

const kimi: CloneCatalogModel = {
  id: 'moonshotai/kimi-k3',
  name: 'Kimi K3',
  reasoning: true,
  vision: true,
  contextWindow: 262144,
  maxTokens: 32768,
  apiUrl: 'https://openrouter.ai/api/v1',
  apiNpm: '@openrouter/ai-sdk-provider'
}
const glm: CloneCatalogModel = { id: 'z-ai/glm-5.3', name: 'GLM 5.3' }

describe('the id and name', () => {
  it('slugs the label onto the vendor id, and names it "<Vendor> (<label>)"', () => {
    expect(cloneSlug('  Team A / EU ')).toBe('team-a-eu')
    expect(cloneIdentity('openrouter', 'OpenRouter', 'Work')).toEqual({
      id: 'openrouter-work',
      name: 'OpenRouter (Work)',
      numbered: false
    })
    // An empty label is no id at all, not `openrouter-`.
    expect(cloneIdentity('openrouter', 'OpenRouter', '  ').id).toBe('')
  })

  it('numbers a label with nothing to slug, and says so', () => {
    expect(cloneIdentity('openrouter', 'OpenRouter', '工作', new Set(['openrouter-2']))).toEqual({
      id: 'openrouter-3',
      name: 'OpenRouter (工作)',
      numbered: true
    })
  })

  it('refuses an empty, malformed or taken id', () => {
    const taken = new Set(['openrouter', 'openrouter-work'])
    expect(cloneIdError('', taken)).toMatch(/Give it a name/)
    expect(cloneIdError(`openrouter-${'x'.repeat(60)}`, taken)).toMatch(/lowercase/)
    expect(cloneIdError('openrouter-work', taken)).toMatch(/already a provider/)
    expect(cloneIdError('openrouter-personal', taken)).toBeNull()
  })
})

describe('what the form starts with', () => {
  it('takes the linked list, else every curating engine’s picks, else All', () => {
    expect(originPicks({ linked: true, models: ['a'] }, {}, ['opencode', 'pi'])).toEqual(['a'])
    expect(originPicks({ linked: true }, {}, ['opencode', 'pi'])).toBeUndefined()
    expect(
      originPicks({ linked: false }, { opencode: ['a', 'b'], pi: ['b', 'c'] }, ['opencode', 'pi'])
    ).toEqual(['a', 'b', 'c'])
    // Any engine on All models means the original shows everything.
    expect(originPicks(undefined, { opencode: ['a'] }, ['opencode', 'pi'])).toBeUndefined()
    expect(originPicks(undefined, { pi: ['c'] }, ['pi'])).toEqual(['c'])
    expect(originPicks(undefined, {}, [])).toBeUndefined()
  })

  it('seeds the picks the catalog still lists, or a small catalog whole, never past the cap', () => {
    expect(seedClonePicks(['z-ai/glm-5.3', 'gone/model'], [kimi, glm])).toEqual(['z-ai/glm-5.3'])
    expect(seedClonePicks(undefined, [kimi, glm])).toEqual([kimi.id, glm.id])
    const big = Array.from({ length: CLONE_MODEL_CAP + 1 }, (_, i) => ({ id: `v/m${i}`, name: '' }))
    expect(seedClonePicks(undefined, big)).toEqual([])
    expect(
      seedClonePicks(
        big.map((m) => m.id),
        big
      )
    ).toHaveLength(CLONE_MODEL_CAP)
  })

  it('lets a selection grow to the cap, and always shrink', () => {
    const at = Array.from({ length: CLONE_MODEL_CAP }, (_, i) => `m${i}`)
    expect(withinCap(at, [])).toBe(true)
    expect(withinCap([...at, 'one-more'], at)).toBe(false)
    const over = [...at, 'x', 'y']
    expect(withinCap(over.slice(0, -1), over)).toBe(true)
  })

  it('takes the endpoint and API from the catalog only when every model agrees', () => {
    expect(catalogEndpoint([glm, kimi])).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      protocol: 'openai-completions'
    })
    expect(catalogEndpoint([glm])).toEqual({})
    // Two endpoints, or an SDK ClaudeUI cannot declare: the form asks.
    expect(catalogEndpoint([kimi, { ...glm, apiUrl: 'https://other.test/v1' }])).toEqual({
      protocol: 'openai-completions'
    })
    expect(catalogEndpoint([{ ...kimi, apiNpm: '@ai-sdk/google' }])).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1'
    })
    for (const [npm, protocol] of [
      ['@ai-sdk/openai-compatible', 'openai-completions'],
      ['@ai-sdk/anthropic', 'anthropic-messages'],
      ['@ai-sdk/openai', 'openai-responses']
    ])
      expect(catalogEndpoint([{ ...kimi, apiNpm: npm }]).protocol).toBe(protocol)
    // A placeholder opencode fills from the environment cannot be declared.
    expect(
      catalogEndpoint([{ ...kimi, apiUrl: 'https://api.test/${ACCOUNT_ID}/v1' }]).baseUrl
    ).toBeUndefined()
  })

  it('accepts only a plain http(s) URL', () => {
    expect(endpointUrlError('https://api.test/v1')).toBeNull()
    expect(endpointUrlError('https://api.test/${ACCOUNT_ID}/v1')).toMatch(/placeholder/)
    expect(endpointUrlError('ftp://x')).toMatch(/http/)
    expect(endpointUrlError('nope')).toMatch(/http/)
  })

  it('dates a copy, and reads the date back without a timezone shift', () => {
    expect(today(new Date(2026, 8, 3, 23, 59))).toBe('2026-09-03')
    expect(formatCopiedAt('2026-09-23')).toBe('23 Sep 2026')
    expect(formatCopiedAt(undefined)).toBeUndefined()
  })
})

describe('a declared copy', () => {
  it('copies name, limits, reasoning and vision from the catalog, in the order picked', () => {
    expect(declareModels([glm.id, kimi.id], [kimi, glm])).toEqual([
      { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
      {
        id: 'moonshotai/kimi-k3',
        name: 'Kimi K3',
        reasoning: true,
        vision: true,
        contextWindow: 262144,
        maxTokens: 32768
      }
    ])
  })

  it('overlays only what the catalog states: a read with no limits keeps the declared ones', () => {
    const existing = [
      { id: kimi.id, name: 'Kimi K3', reasoning: true, contextWindow: 262144, maxTokens: 32768 }
    ]
    // pi's catalog: name and reasoning, no limits, nothing about images.
    expect(
      declareModels([kimi.id], [{ id: kimi.id, name: 'Kimi K3.1', reasoning: false }], existing)
    ).toEqual([{ id: kimi.id, name: 'Kimi K3.1', contextWindow: 262144, maxTokens: 32768 }])
    // A zero limit is "unknown", never a limit.
    expect(
      declareModels([kimi.id], [{ id: kimi.id, name: '', contextWindow: 0 }], existing)[0]
        .contextWindow
    ).toBe(262144)
  })

  it('re-copies on refresh, keeps per-engine overrides, and keeps one the catalog dropped', () => {
    const existing = [
      {
        id: kimi.id,
        name: 'Old name',
        contextWindow: 1000,
        harnessOverrides: { pi: { enabled: false } }
      },
      { id: 'gone/model', name: 'Gone', maxTokens: 10 }
    ]
    expect(declareModels([kimi.id, 'gone/model'], [kimi], existing)).toEqual([
      {
        id: kimi.id,
        name: 'Kimi K3',
        reasoning: true,
        vision: true,
        contextWindow: 262144,
        maxTokens: 32768,
        harnessOverrides: { pi: { enabled: false } }
      },
      { id: 'gone/model', name: 'Gone', maxTokens: 10 }
    ])
  })
})
