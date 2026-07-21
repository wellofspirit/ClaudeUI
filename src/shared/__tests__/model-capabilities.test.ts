import { describe, it, expect } from 'vitest'
import {
  supportsAdaptiveThinking,
  supportsEffort,
  supportsXhighEffort,
  supportsMaxEffort,
  supportedEffortLevels,
  defaultEffort,
  defaultThinkingMode,
  resolveThinkingMode,
  resolveEffort,
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
  modelSupportedEffortLevels,
  modelDefaultEffort,
  modelDefaultThinkingMode,
  modelResolveEffort,
  canonicalizeModelValue,
  resolveContextWindow,
  resolveClaudeCapabilities,
  resolveOpencodeCapabilitiesFromModel,
  maxOutputTokens,
  CONTEXT_WINDOW_1M,
  resolveCapabilities,
  OPENCODE_ENGINE_CAPABILITIES,
  CLAUDE_ENGINE_CAPABILITIES,
  PI_ENGINE_CAPABILITIES,
  piModelCapabilities,
  resolvePiCapabilitiesFromModel
} from '../model-capabilities'

describe('supportsAdaptiveThinking', () => {
  it('is true for opus-4-8 / opus-4-7 / opus-4-6 / sonnet-4-6 / sonnet-5', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true)
    expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true)
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true)
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true)
  })
  it('is false for legacy / haiku models', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-1')).toBe(false)
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false)
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false)
    expect(supportsAdaptiveThinking('claude-3-5-sonnet')).toBe(false)
  })
  it('strips date suffix before matching', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-7-20260101')).toBe(true)
  })
  it('handles empty / unknown defensively', () => {
    expect(supportsAdaptiveThinking('')).toBe(true) // unknown family → assume modern
    expect(supportsAdaptiveThinking(undefined)).toBe(true)
  })
})

describe('supportsEffort', () => {
  it('matches the adaptive-thinking model set', () => {
    expect(supportsEffort('claude-opus-4-8')).toBe(true)
    expect(supportsEffort('claude-opus-4-7')).toBe(true)
    expect(supportsEffort('claude-sonnet-4-6')).toBe(true)
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsEffort('claude-opus-4-5')).toBe(false)
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
  })
})

describe('supportsXhighEffort', () => {
  it('is fable-5, mythos-5, opus-4-7, opus-4-8, and sonnet-5', () => {
    expect(supportsXhighEffort('claude-opus-4-7')).toBe(true)
    expect(supportsXhighEffort('claude-opus-4-8')).toBe(true)
    expect(supportsXhighEffort('claude-fable-5')).toBe(true)
    expect(supportsXhighEffort('claude-fable-5[1m]')).toBe(true)
    expect(supportsXhighEffort('claude-mythos-5')).toBe(true)
    expect(supportsXhighEffort('claude-sonnet-5')).toBe(true)
    expect(supportsXhighEffort('claude-opus-4-6')).toBe(false)
    expect(supportsXhighEffort('claude-sonnet-4-6')).toBe(false)
    expect(supportsXhighEffort('claude-haiku-4-5')).toBe(false)
  })
  it('assumes unknown families are modern and allows xhigh', () => {
    expect(supportsXhighEffort('claude-saga-6')).toBe(true)
  })
})

describe('supportsMaxEffort', () => {
  it('is true for opus-4-6 / opus-4-7 / opus-4-8 / sonnet-4-6', () => {
    expect(supportsMaxEffort('claude-opus-4-8')).toBe(true)
    expect(supportsMaxEffort('claude-opus-4-7')).toBe(true)
    expect(supportsMaxEffort('claude-opus-4-6')).toBe(true)
    expect(supportsMaxEffort('claude-sonnet-4-6')).toBe(true)
  })
  it('is false for haiku and listed legacy models', () => {
    expect(supportsMaxEffort('claude-haiku-4-5')).toBe(false)
    expect(supportsMaxEffort('claude-sonnet-4-5')).toBe(false)
    expect(supportsMaxEffort('claude-opus-4-1')).toBe(false)
    expect(supportsMaxEffort('claude-3-5-sonnet')).toBe(false)
  })
})

describe('supportedEffortLevels', () => {
  it('returns full set with xhigh for fable-5, opus-4-7 and opus-4-8', () => {
    expect(supportedEffortLevels('claude-opus-4-7')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(supportedEffortLevels('claude-opus-4-8')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(supportedEffortLevels('claude-fable-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })
  it('drops xhigh for opus-4-6 / sonnet-4-6', () => {
    expect(supportedEffortLevels('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(supportedEffortLevels('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  })
  it('returns full set with xhigh for sonnet-5', () => {
    expect(supportedEffortLevels('claude-sonnet-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })
  it('returns empty array for models without effort support', () => {
    expect(supportedEffortLevels('claude-sonnet-4-5')).toEqual([])
    expect(supportedEffortLevels('claude-haiku-4-5')).toEqual([])
  })
})

describe('defaultEffort', () => {
  it('xhigh for opus-4-7, high for everyone else (incl. opus-4-8 and fable-5)', () => {
    expect(defaultEffort('claude-opus-4-7')).toBe('xhigh')
    expect(defaultEffort('claude-opus-4-8')).toBe('high')
    expect(defaultEffort('claude-fable-5')).toBe('high')
    expect(defaultEffort('claude-opus-4-6')).toBe('high')
    expect(defaultEffort('claude-sonnet-4-5')).toBe('high')
  })
})

describe('defaultThinkingMode', () => {
  it('adaptive when supported, enabled otherwise', () => {
    expect(defaultThinkingMode('claude-opus-4-7')).toBe('adaptive')
    expect(defaultThinkingMode('claude-sonnet-4-6')).toBe('adaptive')
    expect(defaultThinkingMode('claude-sonnet-4-5')).toBe('enabled')
    expect(defaultThinkingMode('claude-haiku-4-5')).toBe('enabled')
  })
})

describe('resolveThinkingMode', () => {
  it('passes adaptive through on supporting models', () => {
    expect(resolveThinkingMode('claude-opus-4-7', 'adaptive')).toBe('adaptive')
  })
  it('coerces adaptive to enabled on legacy models', () => {
    expect(resolveThinkingMode('claude-sonnet-4-5', 'adaptive')).toBe('enabled')
  })
  it('always honours disabled', () => {
    expect(resolveThinkingMode('claude-opus-4-7', 'disabled')).toBe('disabled')
    expect(resolveThinkingMode('claude-haiku-4-5', 'disabled')).toBe('disabled')
  })
})

describe('resolveEffort', () => {
  it('returns null for models without effort support', () => {
    expect(resolveEffort('claude-sonnet-4-5', 'high')).toBeNull()
  })
  it('keeps allowed level', () => {
    expect(resolveEffort('claude-opus-4-7', 'xhigh')).toBe('xhigh')
    expect(resolveEffort('claude-opus-4-6', 'max')).toBe('max')
    // Regression: automation runs use this string-based path — Fable + xhigh
    // must not be silently downgraded (cli.js 2.1.170 allows xhigh on fable-5).
    expect(resolveEffort('claude-fable-5[1m]', 'xhigh')).toBe('xhigh')
  })
  it('falls back to default when level not allowed', () => {
    expect(resolveEffort('claude-opus-4-6', 'xhigh')).toBe('high')
    expect(resolveEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// SDK-aware accessors — prefer capability fields supplied by supportedModels()
// which are authoritative for alias values like `default`, `sonnet`, `haiku`.
// ---------------------------------------------------------------------------

describe('modelSupportsAdaptiveThinking', () => {
  it('trusts SDK-supplied supportsAdaptiveThinking=true', () => {
    expect(
      modelSupportsAdaptiveThinking({
        value: 'default', // alias, id heuristic has no info
        supportsAdaptiveThinking: true
      })
    ).toBe(true)
  })
  it('trusts SDK-supplied supportsAdaptiveThinking=false', () => {
    expect(
      modelSupportsAdaptiveThinking({
        value: 'default',
        supportsAdaptiveThinking: false
      })
    ).toBe(false)
  })
  it('falls back to id heuristic when field absent', () => {
    expect(modelSupportsAdaptiveThinking({ value: 'claude-haiku-4-5' })).toBe(false)
    expect(modelSupportsAdaptiveThinking({ value: 'claude-opus-4-7' })).toBe(true)
  })
  it('returns false for null/undefined input', () => {
    expect(modelSupportsAdaptiveThinking(null)).toBe(false)
    expect(modelSupportsAdaptiveThinking(undefined)).toBe(false)
  })
})

describe('modelSupportsEffort + modelSupportedEffortLevels', () => {
  it('returns SDK-supplied level list when present (default / Opus 4.7)', () => {
    const model = {
      value: 'default',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const
    }
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportedEffortLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('returns SDK-supplied level list when present (sonnet — no xhigh)', () => {
    const model = {
      value: 'sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const
    }
    expect(modelSupportedEffortLevels(model)).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('returns [] when SDK explicitly says unsupported', () => {
    expect(modelSupportedEffortLevels({ value: 'haiku', supportsEffort: false })).toEqual([])
  })

  it('falls back to id heuristic when fields absent (haiku alias)', () => {
    // Real probe output: `haiku` has no capability fields. Id heuristic catches
    // the "haiku" substring and returns no-effort.
    expect(modelSupportsEffort({ value: 'haiku' })).toBe(false)
    expect(modelSupportedEffortLevels({ value: 'haiku' })).toEqual([])
  })
})

describe('modelDefaultEffort', () => {
  it('returns a level that the model actually supports', () => {
    const sonnet = {
      value: 'sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const
    }
    expect(modelDefaultEffort(sonnet)).toBe('high')
  })
  it('returns xhigh for opus-4-7 (via id heuristic)', () => {
    expect(modelDefaultEffort({ value: 'claude-opus-4-7' })).toBe('xhigh')
  })
  it('returns high for opus-4-8 even though it supports xhigh', () => {
    // 4.8 supports xhigh but defaults to high — mirrors cli.js YK6.
    expect(modelDefaultEffort({ value: 'claude-opus-4-8' })).toBe('high')
    expect(
      modelDefaultEffort({
        value: 'claude-opus-4-8',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      })
    ).toBe('high')
  })
  it('does not blanket-pick xhigh just because SDK lists it as allowed', () => {
    // The `default`/`opus` alias resolves to opus-4-8 today; xhigh in the
    // allowed list must not be auto-selected when the id heuristic says high.
    expect(
      modelDefaultEffort({
        value: 'default',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      })
    ).toBe('high')
  })
  it('skips id-heuristic default when not in SDK-provided list', () => {
    // Id heuristic says xhigh for opus-4-7, but here the SDK claims only
    // low/medium/high are allowed for this hypothetical model — must not pick xhigh.
    expect(
      modelDefaultEffort({
        value: 'claude-opus-4-7',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high']
      })
    ).toBe('high')
  })
})

describe('modelDefaultThinkingMode', () => {
  it('adaptive when SDK supports it', () => {
    expect(modelDefaultThinkingMode({ value: 'default', supportsAdaptiveThinking: true })).toBe(
      'adaptive'
    )
  })
  it('enabled when SDK says no adaptive', () => {
    expect(modelDefaultThinkingMode({ value: 'haiku', supportsAdaptiveThinking: false })).toBe(
      'enabled'
    )
    expect(modelDefaultThinkingMode({ value: 'haiku' })).toBe('enabled') // id-fallback
  })
})

describe('canonicalizeModelValue', () => {
  it('maps known aliases to current canonical ids (mirrors cli.js i8_ 2.1.197)', () => {
    expect(canonicalizeModelValue('opus')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('opus[1m]')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('sonnet')).toBe('claude-sonnet-5')
    expect(canonicalizeModelValue('sonnet[1m]')).toBe('claude-sonnet-5')
    expect(canonicalizeModelValue('haiku')).toBe('claude-haiku-4-5')
  })
  it('passes canonical ids through (normalised, date stripped)', () => {
    expect(canonicalizeModelValue('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('claude-opus-4-7-20260101')).toBe('claude-opus-4-7')
    // Fable's picker value carries the [1m] context suffix — it must normalise
    // to the bare id used as the modelEffortDefaults key / EFFORT_MODELS row.
    expect(canonicalizeModelValue('claude-fable-5[1m]')).toBe('claude-fable-5')
  })
  it('leaves the `default` alias unmapped — its target depends on user config', () => {
    expect(canonicalizeModelValue('default')).toBe('default')
  })
  it('handles empty / null input', () => {
    expect(canonicalizeModelValue('')).toBe('')
    expect(canonicalizeModelValue(undefined)).toBe('')
    expect(canonicalizeModelValue(null)).toBe('')
  })
})

describe('modelResolveEffort', () => {
  it('returns null for models with SDK-declared no-effort support', () => {
    expect(modelResolveEffort({ value: 'haiku', supportsEffort: false }, 'high')).toBeNull()
  })
  it('coerces user pick against SDK-provided levels', () => {
    const sonnet = {
      value: 'sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const
    }
    expect(modelResolveEffort(sonnet, 'xhigh')).toBe('high') // not in list → default
    expect(modelResolveEffort(sonnet, 'max')).toBe('max') // allowed
  })
})

// ---------------------------------------------------------------------------
// Sonnet 5 — full capability suite
// ---------------------------------------------------------------------------

describe('claude-sonnet-5 capabilities (authoritative from cli.js 2.1.197)', () => {
  it('supportsAdaptiveThinking', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true)
  })
  it('supportsEffort', () => {
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
  })
  it('supportsXhighEffort', () => {
    expect(supportsXhighEffort('claude-sonnet-5')).toBe(true)
  })
  it('supportsMaxEffort (not in NO_MAX_EFFORT list)', () => {
    expect(supportsMaxEffort('claude-sonnet-5')).toBe(true)
  })
  it('supportedEffortLevels includes xhigh and max', () => {
    expect(supportedEffortLevels('claude-sonnet-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })
  it('defaultEffort is high', () => {
    expect(defaultEffort('claude-sonnet-5')).toBe('high')
  })
  it('defaultThinkingMode is adaptive', () => {
    expect(defaultThinkingMode('claude-sonnet-5')).toBe('adaptive')
  })
  it('resolveContextWindow returns 1M (native-1M model)', () => {
    expect(resolveContextWindow('claude-sonnet-5')).toBe(CONTEXT_WINDOW_1M)
  })
  it('maxOutputTokens is 128000', () => {
    expect(maxOutputTokens('claude-sonnet-5')).toBe(128_000)
  })
})

describe('maxOutputTokens (mirrors cli.js N0e upperLimit)', () => {
  it('128K models: Fable/Mythos 5, Sonnet 5, Opus 4.6/4.7/4.8, Sonnet 4.6', () => {
    for (const m of [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6'
    ]) {
      expect(maxOutputTokens(m)).toBe(128_000)
    }
  })
  it('64K models: Opus 4.5, Sonnet 4.0/4.5, Haiku 4.5, Claude 3.7 Sonnet', () => {
    for (const m of [
      'claude-opus-4-5',
      'claude-sonnet-4-0',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-7-sonnet'
    ]) {
      expect(maxOutputTokens(m)).toBe(64_000)
    }
  })
  it('32K models: Opus 4.1 / 4.0', () => {
    expect(maxOutputTokens('claude-opus-4-1')).toBe(32_000)
    expect(maxOutputTokens('claude-opus-4-0')).toBe(32_000)
  })
  it('legacy 3.x: 3-opus/3-haiku → 4096, 3-sonnet/3-5-sonnet/3-5-haiku → 8192', () => {
    expect(maxOutputTokens('claude-3-opus')).toBe(4_096)
    expect(maxOutputTokens('claude-3-haiku')).toBe(4_096)
    expect(maxOutputTokens('claude-3-sonnet')).toBe(8_192)
    expect(maxOutputTokens('claude-3-5-sonnet')).toBe(8_192)
    expect(maxOutputTokens('claude-3-5-haiku')).toBe(8_192)
  })
  it('resolves picker aliases via canonicalization (haiku → 64K, not the default)', () => {
    expect(maxOutputTokens('sonnet')).toBe(128_000) // → claude-sonnet-5
    expect(maxOutputTokens('opus')).toBe(128_000) // → claude-opus-4-8
    expect(maxOutputTokens('haiku')).toBe(64_000) // → claude-haiku-4-5
  })
  it('resolves dated / provider-prefixed ids by substring', () => {
    expect(maxOutputTokens('claude-sonnet-5-20260115')).toBe(128_000)
    expect(maxOutputTokens('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(64_000)
  })
  it('unknown / future ids fall back to the 128K default', () => {
    expect(maxOutputTokens('claude-something-9')).toBe(128_000)
    expect(maxOutputTokens('default')).toBe(128_000)
    expect(maxOutputTokens(null)).toBe(128_000)
  })
})

// ---------------------------------------------------------------------------
// resolveClaudeCapabilities — alias canonicalization guard
// ---------------------------------------------------------------------------

describe('resolveClaudeCapabilities alias canonicalization', () => {
  it("'sonnet' resolves to claude-sonnet-5 capabilities (effort + thinking + 1M context)", () => {
    const caps = resolveClaudeCapabilities('sonnet')
    // Effort picker must be present with full levels including xhigh
    expect(caps.reasoning.effort).toBeDefined()
    expect(caps.reasoning.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Thinking picker must be present
    expect(caps.reasoning.thinking).toBeDefined()
    // Context window must be 1M (native-1M Sonnet 5)
    expect(caps.contextWindow).toBe(CONTEXT_WINDOW_1M)
  })

  it("'default' seed path is unchanged (no canonicalization side-effects)", () => {
    const caps = resolveClaudeCapabilities('default')
    // 'default' has no canonical mapping → falls back to unknown-family heuristic.
    // The key assertion: it must NOT be null/throw, and reasoning is present
    // (unknown family assumes modern in both heuristics).
    expect(caps).toBeDefined()
    expect(caps.reasoning).toBeDefined()
  })

  it("'claude-sonnet-5' (canonical id) produces the same result as 'sonnet'", () => {
    const fromAlias = resolveClaudeCapabilities('sonnet')
    const fromCanonical = resolveClaudeCapabilities('claude-sonnet-5')
    expect(fromAlias.reasoning.effort?.levels).toEqual(fromCanonical.reasoning.effort?.levels)
    expect(fromAlias.contextWindow).toBe(fromCanonical.contextWindow)
    expect(fromAlias.reasoning.thinking).toEqual(fromCanonical.reasoning.thinking)
  })
})

describe('resolveContextWindow', () => {
  const ONE_M = 1_000_000
  const DEFAULT = 200_000

  it('resolves the [1m] suffix to 1M, case-insensitively', () => {
    expect(resolveContextWindow('sonnet[1m]')).toBe(ONE_M)
    expect(resolveContextWindow('SONNET[1M]')).toBe(ONE_M)
  })

  it('resolves implicit-1M picker aliases (the regression: no "1m" marker)', () => {
    expect(resolveContextWindow('fable')).toBe(ONE_M)
    expect(resolveContextWindow('opus')).toBe(ONE_M)
    // sonnet now resolves to claude-sonnet-5 (native-1M since 2.1.197)
    expect(resolveContextWindow('sonnet')).toBe(ONE_M)
  })

  it('resolves implicit-1M full ids by substring (dated / Bedrock)', () => {
    expect(resolveContextWindow('claude-fable-5')).toBe(ONE_M)
    expect(resolveContextWindow('claude-opus-4-8-20251201')).toBe(ONE_M)
    expect(resolveContextWindow('us.anthropic.claude-opus-4-8-20251201-v1:0')).toBe(ONE_M)
    expect(resolveContextWindow('claude-sonnet-5')).toBe(ONE_M)
  })

  it('keeps 200K models and aliases at the default', () => {
    expect(resolveContextWindow('haiku')).toBe(DEFAULT)
    expect(resolveContextWindow('claude-sonnet-4-6')).toBe(DEFAULT)
    expect(resolveContextWindow('claude-opus-4-6')).toBe(DEFAULT)
  })

  it('falls back to the default for unknown / empty values', () => {
    expect(resolveContextWindow('some-future-model')).toBe(DEFAULT)
    expect(resolveContextWindow('')).toBe(DEFAULT)
    expect(resolveContextWindow(undefined)).toBe(DEFAULT)
    expect(resolveContextWindow(null)).toBe(DEFAULT)
  })
})

describe('resolveOpencodeCapabilitiesFromModel', () => {
  it('resolveOpencodeCapabilitiesFromModel seeds vision from ModelInfo flags', () => {
    expect(resolveOpencodeCapabilitiesFromModel({ vision: true }).vision).toBe(true)
    expect(resolveOpencodeCapabilitiesFromModel(undefined).vision).toBe(false)
  })
})

describe('engine capability honesty (ADR-030)', () => {
  it('opencode fork/forkFromMessage are false — the end-to-end path is unwired', () => {
    expect(OPENCODE_ENGINE_CAPABILITIES.fork).toBe(false)
    expect(OPENCODE_ENGINE_CAPABILITIES.forkFromMessage).toBe(false)
  })

  it('claude fork/forkFromMessage stay true — the flip is engine-specific, not global', () => {
    expect(CLAUDE_ENGINE_CAPABILITIES.fork).toBe(true)
    expect(CLAUDE_ENGINE_CAPABILITIES.forkFromMessage).toBe(true)
  })

  it('degraded path: no-toolCalling model → canUseMcp/canUseSubagents/isAgentCapable false, engine gates unaffected', () => {
    const noToolModel = {
      reasoning: {},
      vision: true,
      toolCalling: false,
      contextWindow: 200000,
      maxOutput: 4096,
      promptCaching: false
    }
    const caps = resolveCapabilities(CLAUDE_ENGINE_CAPABILITIES, noToolModel)
    expect(caps.canUseMcp).toBe(false)
    expect(caps.canUseSubagents).toBe(false)
    expect(caps.isAgentCapable).toBe(false)
    // Engine gates still true
    expect(caps.voice).toBe(true)
    expect(caps.hostedMcp).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// piModelCapabilities — pi's reasoning is two independent things that must
// not be conflated: thinkingLevel is a session-wide dial (never a `thinking`
// picker), reasoning.effort flips per-model off the catalog's `reasoning` fact.
// ---------------------------------------------------------------------------

describe('piModelCapabilities', () => {
  it('reasoning:true → effort levels exactly [low, medium, high], and reasoning.thinking is never set', () => {
    const caps = piModelCapabilities({ reasoning: true })
    expect(caps.reasoning.effort).toEqual({ levels: ['low', 'medium', 'high'] })
    expect(caps.reasoning.thinking).toBeUndefined()
  })

  it('reasoning:false → reasoning is {} (no effort picker)', () => {
    const caps = piModelCapabilities({ reasoning: false })
    expect(caps.reasoning).toEqual({})
    expect(caps.reasoning.thinking).toBeUndefined()
  })

  it('reasoning:undefined (no arg) → reasoning is {}', () => {
    expect(piModelCapabilities().reasoning).toEqual({})
    expect(piModelCapabilities(undefined).reasoning).toEqual({})
  })

  it('never populates reasoning.thinking regardless of input — no Adaptive picker for any pi model', () => {
    expect(piModelCapabilities({ reasoning: true }).reasoning.thinking).toBeUndefined()
    expect(piModelCapabilities({ reasoning: false }).reasoning.thinking).toBeUndefined()
  })

  it('defaults contextWindow to 200_000 and maxOutput to 8192 when absent', () => {
    const caps = piModelCapabilities()
    expect(caps.contextWindow).toBe(200_000)
    expect(caps.maxOutput).toBe(8192)
  })

  it('passes through explicit contextWindow / maxOutput', () => {
    const caps = piModelCapabilities({ contextWindow: 1_000_000, maxOutput: 64_000 })
    expect(caps.contextWindow).toBe(1_000_000)
    expect(caps.maxOutput).toBe(64_000)
  })

  it('toolCalling is always true, regardless of input', () => {
    expect(piModelCapabilities().toolCalling).toBe(true)
    expect(piModelCapabilities({ reasoning: false }).toolCalling).toBe(true)
    expect(piModelCapabilities({ vision: false, reasoning: true }).toolCalling).toBe(true)
  })

  it('vision passes through the input flag (defaults to false when absent)', () => {
    expect(piModelCapabilities({ vision: true }).vision).toBe(true)
    expect(piModelCapabilities({ vision: false }).vision).toBe(false)
    expect(piModelCapabilities().vision).toBe(false)
  })

  it('promptCaching is always true', () => {
    expect(piModelCapabilities().promptCaching).toBe(true)
  })

  it('M3: an explicit effortLevels array (from thinkingLevelMap) reaches reasoning.effort.levels verbatim, xhigh/max included', () => {
    const caps = piModelCapabilities({
      reasoning: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
    })
    expect(caps.reasoning.effort).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(caps.reasoning.thinking).toBeUndefined()
  })

  it('M3 back-compat: no effortLevels passed → still low/medium/high (existing callers unaffected)', () => {
    const caps = piModelCapabilities({ reasoning: true })
    expect(caps.reasoning.effort).toEqual({ levels: ['low', 'medium', 'high'] })
  })

  it('M3: reasoning:false ignores any effortLevels passed — no effort picker regardless', () => {
    const caps = piModelCapabilities({ reasoning: false, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(caps.reasoning).toEqual({})
  })
})

describe('resolvePiCapabilitiesFromModel', () => {
  it('resolves against PI_ENGINE_CAPABILITIES (engine gates come from the pi table)', () => {
    const caps = resolvePiCapabilitiesFromModel({ reasoning: true })
    expect(caps.steer).toBe(PI_ENGINE_CAPABILITIES.steer)
    expect(caps.queue).toBe(PI_ENGINE_CAPABILITIES.queue)
    expect(caps.auth).toEqual(PI_ENGINE_CAPABILITIES.auth)
  })

  // M6c: pi now drives ONE vendor's login (openai-codex, via ClaudeUI's own
  // auth vault — CredentialSync/AuthVault) — was permanently false pre-M6c.
  it('auth.canDriveLogin is true (M6c: openai-codex is driven via the auth vault; pi\'s other subscription vendors stay undriven)', () => {
    expect(PI_ENGINE_CAPABILITIES.auth.canDriveLogin).toBe(true)
    expect(PI_ENGINE_CAPABILITIES.auth.multiAccount).toBe(false)
  })

  it('sideQuestion is true (/btw wired via PiSession.askSideQuestion\'s transcript-fed ephemeral pi process)', () => {
    expect(PI_ENGINE_CAPABILITIES.sideQuestion).toBe(true)
    expect(resolvePiCapabilitiesFromModel().sideQuestion).toBe(true)
  })

  it('seeds reasoning.effort from the model shape, undefined → engine defaults + no reasoning', () => {
    expect(resolvePiCapabilitiesFromModel(undefined).reasoning).toEqual({})
    expect(resolvePiCapabilitiesFromModel({ reasoning: true }).reasoning.effort?.levels).toEqual([
      'low',
      'medium',
      'high'
    ])
  })

  it('M3: passes effortLevels through to the resolved capability, xhigh/max included', () => {
    const caps = resolvePiCapabilitiesFromModel({
      reasoning: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
    })
    expect(caps.reasoning.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('isAgentCapable is true (toolCalling always true for pi)', () => {
    expect(resolvePiCapabilitiesFromModel(undefined).isAgentCapable).toBe(true)
  })
})
