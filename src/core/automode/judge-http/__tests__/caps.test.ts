/**
 * Capability derivation (ADR-081 §4): the OpenAI model-family tables and the
 * per-route caps every body builder reads.
 */
import { describe, it, expect } from 'vitest'
import {
  capsFor,
  isOpenAIReasoningModel,
  judgeCacheKey,
  reasoningFields,
  wireForKind
} from '../caps'

describe('isOpenAIReasoningModel', () => {
  it.each([
    ['o1', true],
    ['o1-mini', true],
    ['o3', true],
    ['o3-pro', true],
    ['o4-mini', true],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-5-nano', true],
    ['gpt-5-codex', true],
    ['gpt-5.1', true],
    ['gpt-5.2-codex', true],
    ['gpt-6', true],
    ['openai/gpt-5-mini', true],
    ['openai/o4-mini', true],
    ['GPT-5', true],
    // Non-reasoning: the chat snapshots, and everything before gpt-5.
    ['gpt-5-chat-latest', false],
    ['gpt-5.1-chat-latest', false],
    ['openai/gpt-5-chat', false],
    ['gpt-4.1', false],
    ['gpt-4.1-mini', false],
    ['gpt-4o', false],
    ['gpt-4o-mini', false],
    ['gpt-3.5-turbo', false],
    ['omni-moderation-latest', false],
    ['z-ai/glm-4.6', false],
    ['anthropic/claude-haiku-4.5', false]
  ])('%s → %s', (id, want) => {
    expect(isOpenAIReasoningModel(id)).toBe(want)
  })
})

describe('wireForKind', () => {
  it('maps the two Responses routes to responses and the rest to chat', () => {
    expect(wireForKind('chatgpt')).toBe('responses')
    expect(wireForKind('custom-responses')).toBe('responses')
    expect(wireForKind('openai')).toBe('chat')
    expect(wireForKind('openrouter')).toBe('chat')
    expect(wireForKind('custom-chat')).toBe('chat')
  })
})

describe('capsFor', () => {
  it('chatgpt: nothing server-side the backend rejects; cache key + session-id affinity', () => {
    expect(capsFor('chatgpt', 'gpt-5.1-codex-mini')).toEqual({
      outputCap: 'none',
      supportsStop: false,
      temperature: null,
      systemChannel: 'instructions',
      promptCacheKey: true,
      cacheMarkerOnSystem: false,
      affinityHeader: 'session-id',
      extraBody: {
        store: false,
        include: ['reasoning.encrypted_content'],
        text: { verbosity: 'low' }
      },
      reasoning: {
        fast: { reasoning: { effort: 'low' } },
        thinking: { reasoning: { effort: 'low' } }
      }
    })
  })

  it.each(['gpt-5', 'gpt-5.1-codex-mini', 'gpt-5.2', 'gpt-6', 'gpt-6-luna', 'o4-mini'])(
    'stage 1 of reasoning model %s reasons at low, not the lowest effort it accepts (ADR-083 §2)',
    (model) => {
      // At `none` a stage-1 severity grade scattered (real block cases graded
      // 0-20, i.e. cleared without stage 2), so stage 1 matches stage 2 here.
      expect(capsFor('chatgpt', model).reasoning.fast).toEqual({ reasoning: { effort: 'low' } })
      expect(capsFor('openai', model).reasoning.fast).toEqual({ reasoning_effort: 'low' })
    }
  )

  it('openai reasoning model: developer role, no stop, no temperature, reasoning_effort', () => {
    expect(capsFor('openai', 'gpt-5-mini')).toEqual({
      outputCap: 'max_completion_tokens',
      supportsStop: false,
      temperature: null,
      systemChannel: 'developer',
      promptCacheKey: true,
      cacheMarkerOnSystem: false,
      affinityHeader: null,
      extraBody: { store: false, stream_options: { include_usage: true } },
      reasoningHeadroom: 2048,
      reasoning: {
        fast: { reasoning_effort: 'low' },
        thinking: { reasoning_effort: 'low' }
      }
    })
  })

  it('openai non-reasoning model: system role, stop, temperature 0, no reasoning fields', () => {
    expect(capsFor('openai', 'gpt-4.1-mini')).toEqual({
      outputCap: 'max_completion_tokens',
      supportsStop: true,
      temperature: 0,
      systemChannel: 'system',
      promptCacheKey: true,
      cacheMarkerOnSystem: false,
      affinityHeader: null,
      extraBody: { store: false, stream_options: { include_usage: true } },
      reasoning: { fast: {}, thinking: {} }
    })
  })

  it('openrouter: cost-reporting usage, x-session-id affinity, reasoning off when flagged', () => {
    expect(capsFor('openrouter', 'z-ai/glm-4.6', { reasoning: true })).toEqual({
      outputCap: 'max_tokens',
      supportsStop: true,
      temperature: 0,
      systemChannel: 'system',
      promptCacheKey: false,
      cacheMarkerOnSystem: false,
      affinityHeader: 'x-session-id',
      extraBody: { usage: { include: true }, stream_options: { include_usage: true } },
      reasoning: {
        fast: { reasoning: { enabled: false } },
        thinking: { reasoning: { enabled: false } }
      }
    })
    expect(capsFor('openrouter', 'z-ai/glm-4.6').reasoning).toEqual({ fast: {}, thinking: {} })
  })

  it('openrouter: Claude models get no temperature; anthropic/* also gets the cache marker', () => {
    const anthropic = capsFor('openrouter', 'anthropic/claude-haiku-4.5')
    expect(anthropic.temperature).toBeNull()
    expect(anthropic.cacheMarkerOnSystem).toBe(true)
    // A Claude id under another vendor prefix: no temperature, but no marker —
    // only the `anthropic/` provider honours cache_control this way.
    const other = capsFor('openrouter', 'some-vendor/claude-like-model')
    expect(other.temperature).toBeNull()
    expect(other.cacheMarkerOnSystem).toBe(false)
  })

  it('custom-chat: the plain OpenAI-compatible set, nothing provider-specific', () => {
    expect(capsFor('custom-chat', 'local-model')).toEqual({
      outputCap: 'max_tokens',
      supportsStop: true,
      temperature: 0,
      systemChannel: 'system',
      promptCacheKey: false,
      cacheMarkerOnSystem: false,
      affinityHeader: null,
      extraBody: { stream_options: { include_usage: true } },
      reasoning: { fast: {}, thinking: {} }
    })
  })

  it('custom-responses: like chatgpt but with a real output cap and no affinity header', () => {
    expect(capsFor('custom-responses', 'gpt-5-mini')).toEqual({
      outputCap: 'max_output_tokens',
      supportsStop: false,
      temperature: null,
      systemChannel: 'instructions',
      promptCacheKey: true,
      cacheMarkerOnSystem: false,
      affinityHeader: null,
      extraBody: { store: false },
      reasoning: { fast: {}, thinking: {} }
    })
  })
})

describe('reasoningFields', () => {
  it('picks the stage, defaulting to thinking', () => {
    // The two stages send the same effort on every route today, so the pick
    // is observable only on caps whose stages differ.
    const caps = {
      ...capsFor('openai', 'gpt-5.1'),
      reasoning: { fast: { reasoning_effort: 'x-fast' }, thinking: { reasoning_effort: 'x-think' } }
    }
    expect(reasoningFields(caps, 'fast')).toEqual({ reasoning_effort: 'x-fast' })
    expect(reasoningFields(caps, 'thinking')).toEqual({ reasoning_effort: 'x-think' })
    expect(reasoningFields(caps, undefined)).toEqual({ reasoning_effort: 'x-think' })
  })
})

describe('judgeCacheKey', () => {
  it('is judge- + 32 hex, stable per system prompt, distinct across prompts', () => {
    const a = judgeCacheKey('POLICY A')
    expect(a).toMatch(/^judge-[0-9a-f]{32}$/)
    expect(judgeCacheKey('POLICY A')).toBe(a)
    expect(judgeCacheKey('POLICY B')).not.toBe(a)
    // Known vector: SHA-256 of the empty string.
    expect(judgeCacheKey('')).toBe('judge-e3b0c44298fc1c149afbf4c8996fb924')
  })
})
