import { describe, it, expect } from 'vitest'
import { ENGINE_META, engineMeta, OPENCODE_DEFAULT_MODEL, PI_DEFAULT_MODEL } from '../engine-meta'
import {
  CLAUDE_ENGINE_CAPABILITIES,
  OPENCODE_ENGINE_CAPABILITIES,
  PI_ENGINE_CAPABILITIES,
  resolveClaudeCapabilities,
  resolveOpencodeCapabilitiesFromModel,
  resolvePiCapabilitiesFromModel
} from '../model-capabilities'
import type { EngineId, ModelInfo } from '../types'

const ALL_ENGINE_IDS: EngineId[] = ['claude', 'opencode', 'pi']

describe('ENGINE_META table completeness', () => {
  it('has an entry for every EngineId, keyed by its own id', () => {
    for (const id of ALL_ENGINE_IDS) {
      expect(engineMeta(id).id).toBe(id)
    }
  })
  it('has exactly the known engine ids as keys', () => {
    expect(Object.keys(ENGINE_META).sort()).toEqual([...ALL_ENGINE_IDS].sort())
  })
})

describe('engineMeta', () => {
  it('throws on an unregistered id', () => {
    expect(() => engineMeta('nope' as EngineId)).toThrow()
  })
})

describe('label', () => {
  it('claude → Claude, opencode → opencode, pi → pi', () => {
    expect(engineMeta('claude').label).toBe('Claude')
    expect(engineMeta('opencode').label).toBe('opencode')
    expect(engineMeta('pi').label).toBe('pi')
  })
})

describe('capabilities identity', () => {
  it('references the shared capability constants, not copies', () => {
    expect(engineMeta('claude').capabilities).toBe(CLAUDE_ENGINE_CAPABILITIES)
    expect(engineMeta('opencode').capabilities).toBe(OPENCODE_ENGINE_CAPABILITIES)
    expect(engineMeta('pi').capabilities).toBe(PI_ENGINE_CAPABILITIES)
  })
})

describe('defaultVendorId', () => {
  it('claude → anthropic, opencode → openai, pi → openai-codex', () => {
    expect(engineMeta('claude').defaultVendorId).toBe('anthropic')
    expect(engineMeta('opencode').defaultVendorId).toBe('openai')
    expect(engineMeta('pi').defaultVendorId).toBe('openai-codex')
  })
})

describe('defaultModelValue', () => {
  it('claude always returns "default", param or not', () => {
    expect(engineMeta('claude').defaultModelValue()).toBe('default')
    expect(engineMeta('claude').defaultModelValue('foo/bar')).toBe('default')
  })
  it('opencode falls back to OPENCODE_DEFAULT_MODEL when unset/empty', () => {
    expect(engineMeta('opencode').defaultModelValue(undefined)).toBe(OPENCODE_DEFAULT_MODEL)
    expect(engineMeta('opencode').defaultModelValue('')).toBe(OPENCODE_DEFAULT_MODEL)
  })
  it('opencode uses the configured default when present', () => {
    expect(engineMeta('opencode').defaultModelValue('foo/bar')).toBe('foo/bar')
  })
  it('pi falls back to PI_DEFAULT_MODEL when unset/empty', () => {
    expect(engineMeta('pi').defaultModelValue(undefined)).toBe(PI_DEFAULT_MODEL)
    expect(engineMeta('pi').defaultModelValue('')).toBe(PI_DEFAULT_MODEL)
  })
  it('pi uses the configured default when present', () => {
    expect(engineMeta('pi').defaultModelValue('foo/bar')).toBe('foo/bar')
  })
})

describe('claude encode/decode', () => {
  it('decodeModelValue builds a claudeModel ref', () => {
    expect(engineMeta('claude').decodeModelValue('claude-opus-4-8')).toEqual({
      engineId: 'claude',
      vendorId: 'anthropic',
      modelId: 'claude-opus-4-8'
    })
  })
  it('encodeModelValue round-trips to the bare modelId', () => {
    const ref = engineMeta('claude').decodeModelValue('claude-opus-4-8')
    expect(engineMeta('claude').encodeModelValue(ref)).toBe('claude-opus-4-8')
  })
  it('decodes the "default" alias unchanged', () => {
    expect(engineMeta('claude').decodeModelValue('default').modelId).toBe('default')
  })
})

describe('opencode encode/decode', () => {
  it('decodeModelValue splits vendor/model', () => {
    expect(engineMeta('opencode').decodeModelValue('openai/gpt-5.4')).toEqual({
      engineId: 'opencode',
      vendorId: 'openai',
      modelId: 'gpt-5.4'
    })
  })
  it('encodeModelValue round-trips vendor/model', () => {
    const ref = engineMeta('opencode').decodeModelValue('openai/gpt-5.4')
    expect(engineMeta('opencode').encodeModelValue(ref)).toBe('openai/gpt-5.4')
  })
  it('handles a slash embedded in the modelId', () => {
    const ref = engineMeta('opencode').decodeModelValue('qwen-sandbox/qwen3.6:27b')
    expect(ref.vendorId).toBe('qwen-sandbox')
    expect(ref.modelId).toBe('qwen3.6:27b')
    expect(engineMeta('opencode').encodeModelValue(ref)).toBe('qwen-sandbox/qwen3.6:27b')
  })
  it('splits on the FIRST slash only for multi-slash values', () => {
    const ref = engineMeta('opencode').decodeModelValue('a/b/c')
    expect(ref.vendorId).toBe('a')
    expect(ref.modelId).toBe('b/c')
    expect(engineMeta('opencode').encodeModelValue(ref)).toBe('a/b/c')
  })
  it('falls back to vendor "opencode" when there is no slash', () => {
    const ref = engineMeta('opencode').decodeModelValue('mimo')
    expect(ref.vendorId).toBe('opencode')
    expect(ref.modelId).toBe('mimo')
  })
  it('round-trips a handful of values through encode(decode(v)) === v', () => {
    const values = [
      'openai/gpt-5.4',
      'qwen-sandbox/qwen3.6:27b',
      'a/b/c',
      'anthropic/claude-sonnet-4-6'
    ]
    for (const v of values) {
      expect(
        engineMeta('opencode').encodeModelValue(engineMeta('opencode').decodeModelValue(v))
      ).toBe(v)
    }
  })
})

describe('pi encode/decode', () => {
  it('decodeModelValue splits vendor/model', () => {
    expect(engineMeta('pi').decodeModelValue('openai-codex/gpt-5.6-luna')).toEqual({
      engineId: 'pi',
      vendorId: 'openai-codex',
      modelId: 'gpt-5.6-luna'
    })
  })
  it('encodeModelValue round-trips vendor/model', () => {
    const ref = engineMeta('pi').decodeModelValue('openai-codex/gpt-5.6-luna')
    expect(engineMeta('pi').encodeModelValue(ref)).toBe('openai-codex/gpt-5.6-luna')
  })
  it('splits on the FIRST slash only for multi-slash values', () => {
    const ref = engineMeta('pi').decodeModelValue('a/b/c')
    expect(ref.vendorId).toBe('a')
    expect(ref.modelId).toBe('b/c')
    expect(engineMeta('pi').encodeModelValue(ref)).toBe('a/b/c')
  })
  it('falls back to vendor "openai-codex" when there is no slash', () => {
    const ref = engineMeta('pi').decodeModelValue('gpt-5.6-luna')
    expect(ref.vendorId).toBe('openai-codex')
    expect(ref.modelId).toBe('gpt-5.6-luna')
  })
  it('round-trips a handful of values through encode(decode(v)) === v', () => {
    const values = ['anthropic/claude-sonnet-5', 'openai-codex/gpt-5.6-luna', 'a/b/c']
    for (const v of values) {
      expect(engineMeta('pi').encodeModelValue(engineMeta('pi').decodeModelValue(v))).toBe(v)
    }
  })
})

describe('seedCapabilities parity with the pre-existing resolvers', () => {
  it('claude("default") matches resolveClaudeCapabilities("default")', () => {
    expect(engineMeta('claude').seedCapabilities('default')).toEqual(
      resolveClaudeCapabilities('default')
    )
  })
  it('claude("claude-opus-4-8") matches resolveClaudeCapabilities("claude-opus-4-8")', () => {
    expect(engineMeta('claude').seedCapabilities('claude-opus-4-8')).toEqual(
      resolveClaudeCapabilities('claude-opus-4-8')
    )
  })
  it('opencode with no modelInfo matches resolveOpencodeCapabilitiesFromModel(undefined)', () => {
    expect(engineMeta('opencode').seedCapabilities('x')).toEqual(
      resolveOpencodeCapabilitiesFromModel(undefined)
    )
  })
  it('opencode with a modelInfo matches resolveOpencodeCapabilitiesFromModel({vision, toolCalling})', () => {
    const modelInfo: ModelInfo = {
      value: 'openai/gpt',
      displayName: '',
      description: '',
      vision: true,
      toolCalling: true
    }
    expect(engineMeta('opencode').seedCapabilities('x', modelInfo)).toEqual(
      resolveOpencodeCapabilitiesFromModel({ vision: true, toolCalling: true })
    )
  })
  it('pi with no modelInfo matches resolvePiCapabilitiesFromModel(undefined)', () => {
    expect(engineMeta('pi').seedCapabilities('x')).toEqual(
      resolvePiCapabilitiesFromModel(undefined)
    )
  })
  it('pi with a modelInfo matches resolvePiCapabilitiesFromModel({vision})', () => {
    const modelInfo: ModelInfo = {
      value: 'openai-codex/gpt',
      displayName: '',
      description: '',
      vision: true,
      toolCalling: true
    }
    expect(engineMeta('pi').seedCapabilities('x', modelInfo)).toEqual(
      resolvePiCapabilitiesFromModel({ vision: true })
    )
  })
})

// ---------------------------------------------------------------------------
// PI_META.seedCapabilities' reasoning derivation (engine-meta.ts ~:120-123):
// ModelInfo has no `reasoning` field of its own — it's derived from
// `supportsEffort` (the flag model-discovery.ts sets from the catalog's
// `reasoning: boolean` fact per model) so the seeded capabilities agree with
// the effort picker the SAME ModelInfo drives in InputBox.
// ---------------------------------------------------------------------------

describe('pi seedCapabilities reasoning derivation from supportsEffort', () => {
  it('supportsEffort: true → reasoning.effort is the conservative low/medium/high set', () => {
    const modelInfo: ModelInfo = {
      value: 'openai-codex/gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      description: '',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high']
    }
    const caps = engineMeta('pi').seedCapabilities('openai-codex/gpt-5.6-luna', modelInfo)
    expect(caps.reasoning.effort).toEqual({ levels: ['low', 'medium', 'high'] })
    // pi never gets an Adaptive-thinking picker, regardless of supportsEffort.
    expect(caps.reasoning.thinking).toBeUndefined()
  })

  it('supportsEffort: false → reasoning.effort is absent', () => {
    const modelInfo: ModelInfo = {
      value: 'openai-codex/gpt-5.5-mini',
      displayName: 'GPT-5.5 Mini',
      description: '',
      supportsEffort: false
    }
    const caps = engineMeta('pi').seedCapabilities('openai-codex/gpt-5.5-mini', modelInfo)
    expect(caps.reasoning).toEqual({})
  })

  it('supportsEffort absent (no modelInfo) → reasoning.effort is absent', () => {
    const caps = engineMeta('pi').seedCapabilities('openai-codex/gpt-5.6-luna')
    expect(caps.reasoning).toEqual({})
  })
})
