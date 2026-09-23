/**
 * ADR-074 §1 — pi's allowlist becomes a per-provider record with opencode's
 * key-presence rule, and the legacy global `<provider>/<model>` list migrates on
 * read. The owner ruling that shapes the migration: a provider the old list
 * never named gets NO key, i.e. shows all.
 */
import { describe, expect, it } from 'vitest'
import {
  isPiModelAllowed,
  normalizePiEngineConfig,
  normalizePiModelAllowlist,
  splitPiModelValue
} from '../pi-model-allowlist'

describe('normalizePiModelAllowlist', () => {
  it('groups a legacy list by provider on the FIRST slash only', () => {
    expect(
      normalizePiModelAllowlist([
        'openrouter/deepseek/deepseek-v4-flash-0731',
        'openrouter/z-ai/glm-5.3',
        'anthropic/claude-sonnet-5'
      ])
    ).toEqual({
      openrouter: ['deepseek/deepseek-v4-flash-0731', 'z-ai/glm-5.3'],
      anthropic: ['claude-sonnet-5']
    })
  })

  it('gives providers the old list never named no key at all', () => {
    const record = normalizePiModelAllowlist(['openrouter/moonshotai/kimi-k3'])!
    expect(Object.keys(record)).toEqual(['openrouter'])
    expect('openai-codex' in record).toBe(false)
  })

  it('reads an old empty list as {} — every provider shows all (deliberate)', () => {
    expect(normalizePiModelAllowlist([])).toEqual({})
  })

  it('drops legacy entries with no provider prefix, an empty id, or a non-string', () => {
    expect(normalizePiModelAllowlist(['bare-id', '/no-provider', 'groq/', 42, null])).toEqual({})
  })

  it('passes a record through, minus non-array values and non-string entries', () => {
    expect(
      normalizePiModelAllowlist({
        groq: ['llama-4', 7, 'kimi'],
        xai: [],
        broken: 'grok-4',
        worse: null
      })
    ).toEqual({ groq: ['llama-4', 'kimi'], xai: [] })
  })

  it('reads absent or junk as undefined (show all)', () => {
    expect(normalizePiModelAllowlist(undefined)).toBeUndefined()
    expect(normalizePiModelAllowlist(null)).toBeUndefined()
    expect(normalizePiModelAllowlist('groq/llama-4')).toBeUndefined()
  })
})

describe('normalizePiEngineConfig', () => {
  it('migrates piConfig.modelAllowlist in place and leaves siblings alone', () => {
    const config = {
      dispatch: { defaultModel: 'groq/llama-4' },
      piConfig: { defaultModel: 'groq/llama-4', modelAllowlist: ['groq/llama-4'] }
    }
    expect(normalizePiEngineConfig(config as never)).toEqual({
      dispatch: { defaultModel: 'groq/llama-4' },
      piConfig: { defaultModel: 'groq/llama-4', modelAllowlist: { groq: ['llama-4'] } }
    })
  })

  it('removes a junk allowlist rather than keeping it, and ignores a missing block', () => {
    expect(normalizePiEngineConfig({ piConfig: { modelAllowlist: 'x' } } as never)).toEqual({
      piConfig: {}
    })
    expect(normalizePiEngineConfig({})).toEqual({})
    expect(normalizePiEngineConfig({ piConfig: { defaultModel: 'a/b' } })).toEqual({
      piConfig: { defaultModel: 'a/b' }
    })
  })
})

describe('isPiModelAllowed / splitPiModelValue', () => {
  it('applies the key-presence rule', () => {
    const allowlist = { groq: ['llama-4'], xai: [] }
    expect(isPiModelAllowed(undefined, 'groq', 'anything')).toBe(true)
    expect(isPiModelAllowed(allowlist, 'groq', 'llama-4')).toBe(true)
    expect(isPiModelAllowed(allowlist, 'groq', 'kimi')).toBe(false)
    expect(isPiModelAllowed(allowlist, 'xai', 'grok-4')).toBe(false)
    expect(isPiModelAllowed(allowlist, 'openai-codex', 'gpt-5.6-luna')).toBe(true)
  })

  it('splits on the first slash and refuses a value with no provider', () => {
    expect(splitPiModelValue('openrouter/z-ai/glm-5.3')).toEqual({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.3'
    })
    expect(splitPiModelValue('bare')).toBeNull()
    expect(splitPiModelValue('/x')).toBeNull()
  })
})
