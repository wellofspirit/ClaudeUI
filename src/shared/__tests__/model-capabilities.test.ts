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
  claudeEffortKey,
  claudeLegacyEffortKey,
  claudeSavedEffort,
  resolveDesiredEffort,
  resolveSpawnEffort,
  withSavedEffort,
  savedEffortFor,
  rememberEffortPatch,
  engineRemembersEffort,
  type EffortDefaultsSlice,
  resolveContextWindow,
  resolveClaudeCapabilities,
  claudeModelCapabilities,
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
  it('is true for opus-5 / opus-4-8 / opus-4-7 / opus-4-6 / sonnet-4-6 / sonnet-5', () => {
    expect(supportsAdaptiveThinking('claude-opus-5')).toBe(true)
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
    expect(supportsEffort('claude-opus-5')).toBe(true)
    expect(supportsEffort('claude-opus-4-8')).toBe(true)
    expect(supportsEffort('claude-opus-4-7')).toBe(true)
    expect(supportsEffort('claude-sonnet-4-6')).toBe(true)
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsEffort('claude-opus-4-5')).toBe(false)
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
  })
})

describe('supportsXhighEffort', () => {
  it('is fable-5, mythos-5, opus-5, opus-4-7, opus-4-8, and sonnet-5', () => {
    expect(supportsXhighEffort('claude-opus-5')).toBe(true)
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
  it('mirrors the catalog: xhigh for opus-4-7, medium for opus-5-5 / sonnet-5-5, else high', () => {
    expect(defaultEffort('claude-opus-4-7')).toBe('xhigh')
    expect(defaultEffort('claude-opus-5-5')).toBe('medium')
    expect(defaultEffort('claude-sonnet-5-5')).toBe('medium')
    expect(defaultEffort('claude-opus-4-8')).toBe('high')
    expect(defaultEffort('claude-opus-5')).toBe('high')
    expect(defaultEffort('claude-sonnet-5')).toBe('high')
    expect(defaultEffort('claude-fable-5')).toBe('high')
    expect(defaultEffort('claude-opus-4-6')).toBe('high')
    expect(defaultEffort('claude-sonnet-4-5')).toBe('high')
  })
  it('judges a picker alias by the model it resolves to', () => {
    expect(defaultEffort('opus')).toBe('medium')
    expect(defaultEffort('sonnet[1m]')).toBe('medium')
    expect(defaultEffort('haiku')).toBe('high')
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
      resolvedModel: 'claude-sonnet-4-6',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const
    }
    expect(modelDefaultEffort(sonnet)).toBe('high')
  })
  it("reads the RESOLVED model: `default` on Opus 5.5 starts at cli.js's medium", () => {
    expect(modelDefaultEffort({ value: 'default', resolvedModel: 'claude-opus-5-5' })).toBe(
      'medium'
    )
    expect(modelDefaultEffort({ value: 'default', resolvedModel: 'claude-opus-4-7' })).toBe('xhigh')
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
    // The `default`/`opus` alias resolves to opus-5 today (defaults to high);
    // xhigh in the allowed list must not be auto-selected when the id
    // heuristic says high.
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
  it('maps known aliases to current canonical ids (mirrors cli.js alias map, 2.1.285)', () => {
    expect(canonicalizeModelValue('opus')).toBe('claude-opus-5-5')
    expect(canonicalizeModelValue('opus[1m]')).toBe('claude-opus-5-5')
    expect(canonicalizeModelValue('sonnet')).toBe('claude-sonnet-5-5')
    expect(canonicalizeModelValue('sonnet[1m]')).toBe('claude-sonnet-5-5')
    expect(canonicalizeModelValue('haiku')).toBe('claude-haiku-4-5')
  })
  it('passes canonical ids through (normalised, date stripped)', () => {
    expect(canonicalizeModelValue('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('claude-opus-4-7-20260101')).toBe('claude-opus-4-7')
    // Fable's picker value carries the [1m] context suffix — it must normalise
    // to the bare id used as the modelEffortDefaults key (`claudeEffortKey`).
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

describe('claudeEffortKey (ADR-074 §8)', () => {
  // The 2.1.285 catalog as cli.js reports it: `default` and `opus` land on one
  // model, `fable` has no alias row, older models are listed by id.
  const CATALOG = [
    { value: 'default', resolvedModel: 'claude-opus-5-5' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5' },
    { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5' }
  ]
  it('keys a family alias by the alias, so the setting follows it to a new model', () => {
    expect(claudeEffortKey({ value: 'opus', resolvedModel: 'claude-opus-5-5' })).toBe('opus')
    expect(claudeEffortKey({ value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]' })).toBe(
      'opus'
    )
    expect(claudeEffortKey({ value: 'sonnet' })).toBe('sonnet')
    expect(claudeEffortKey({ value: 'haiku', resolvedModel: 'claude-haiku-4-5' })).toBe('haiku')
  })
  it('gives `default` the key of the alias that resolves where it does', () => {
    expect(claudeEffortKey(CATALOG[0], CATALOG)).toBe('opus')
    // No alias lands there: the model's own id, date and [1m] dropped.
    expect(
      claudeEffortKey({ value: 'default', resolvedModel: 'claude-opus-4-7[1m]' }, CATALOG)
    ).toBe('claude-opus-4-7')
    // Without a catalog there is nothing to share with.
    expect(claudeEffortKey(CATALOG[0])).toBe('claude-opus-5-5')
    expect(claudeEffortKey({ value: 'default' })).toBe('default')
  })
  it('keys a specific model by its id, even the one an alias used to name', () => {
    expect(claudeEffortKey(CATALOG[5], CATALOG)).toBe('claude-sonnet-5')
    expect(claudeEffortKey({ value: 'claude-fable-5-1[1m]' })).toBe('claude-fable-5-1')
  })
  it('is empty for no row', () => {
    expect(claudeEffortKey(undefined)).toBe('')
    expect(claudeEffortKey(null)).toBe('')
  })
})

describe('claudeSavedEffort — v3.5 values saved under the resolved model id', () => {
  const CATALOG = [
    { value: 'default', resolvedModel: 'claude-opus-5-5' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
    { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5' }
  ]
  it('still reads the old key for an alias row, and the new key wins', () => {
    expect(claudeLegacyEffortKey(CATALOG[1], CATALOG)).toBe('claude-opus-5-5')
    expect(claudeSavedEffort({ 'claude-opus-5-5': 'low' }, CATALOG[1], CATALOG)).toBe('low')
    expect(claudeSavedEffort({ 'claude-opus-5-5': 'low' }, CATALOG[0], CATALOG)).toBe('low')
    expect(claudeSavedEffort({ 'claude-opus-5-5': 'low', opus: 'max' }, CATALOG[0], CATALOG)).toBe(
      'max'
    )
  })
  it('never borrows a key a listed model owns', () => {
    const catalog = [...CATALOG, { value: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5' }]
    expect(claudeLegacyEffortKey(catalog[2], catalog)).toBeUndefined()
    expect(claudeSavedEffort({ 'claude-sonnet-5-5': 'low' }, catalog[2], catalog)).toBeUndefined()
  })
  it('has no legacy key for a row keyed by its own model', () => {
    expect(claudeLegacyEffortKey(CATALOG[3], CATALOG)).toBeUndefined()
    expect(claudeSavedEffort({ 'claude-sonnet-5': 'high' }, CATALOG[3], CATALOG)).toBe('high')
  })
  it('is undefined with nothing saved or no row', () => {
    expect(claudeSavedEffort(undefined, CATALOG[1], CATALOG)).toBeUndefined()
    expect(claudeSavedEffort({ opus: 'low' }, undefined, CATALOG)).toBeUndefined()
  })
})

describe('modelResolveEffort', () => {
  it('returns null for models with SDK-declared no-effort support', () => {
    expect(modelResolveEffort({ value: 'haiku', supportsEffort: false }, 'high')).toBeNull()
  })
  it('coerces user pick against SDK-provided levels', () => {
    const sonnet = {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-4-6',
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

  // The `default` alias names no model family, so it cannot resolve here by
  // design — which is exactly why claudeModelCapabilities must be handed
  // `resolvedModel` (next block).
  it('leaves the opaque `default` alias at 200K — only cli.js knows its target', () => {
    expect(resolveContextWindow('default')).toBe(DEFAULT)
  })
})

describe('claudeModelCapabilities — sizing from resolvedModel', () => {
  const ONE_M = 1_000_000
  const DEFAULT = 200_000

  it('sizes the opaque `default` alias from its resolvedModel', () => {
    expect(
      claudeModelCapabilities({ value: 'default', resolvedModel: 'claude-opus-5[1m]' })
        .contextWindow
    ).toBe(ONE_M)
  })

  it('falls back to `value` when no resolvedModel is present (non-Claude catalogs)', () => {
    expect(claudeModelCapabilities({ value: 'default' }).contextWindow).toBe(DEFAULT)
  })

  it('a resolvedModel that is genuinely 200K stays 200K', () => {
    expect(
      claudeModelCapabilities({ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' })
        .contextWindow
    ).toBe(DEFAULT)
  })

  // maxOutput is routed through resolvedModel too. It agrees with the `value`
  // derivation on all five real 2.1.268 catalog rows; haiku is the one row
  // where the figure is not the 128K unknown-model default, so it is the row
  // that would expose a divergence.
  it('resolveClaudeCapabilities sizes a `default` session from the init-reported id', () => {
    expect(resolveClaudeCapabilities('default', 'claude-opus-5[1m]').contextWindow).toBe(ONE_M)
  })

  it('resolveClaudeCapabilities is unchanged without the second argument', () => {
    expect(resolveClaudeCapabilities('default').contextWindow).toBe(DEFAULT)
  })

  /**
   * The resolved id must reach claudeModelCapabilities RAW. Canonicalizing it
   * would strip a `[1m]` suffix that resolveContextWindow depends on —
   * `canonicalizeModelValue('claude-sonnet-4-6[1m]')` is 'claude-sonnet-4-6',
   * which is a 200K model. (The 2.1.268 catalog happens not to expose this,
   * because its 1M rows are implicit-1M base models either way.)
   */
  it('does NOT canonicalize the resolved id — the [1m] suffix is load-bearing', () => {
    expect(canonicalizeModelValue('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6')
    expect(resolveContextWindow('claude-sonnet-4-6')).toBe(DEFAULT)
    // Passed through raw, so the suffix survives and the window stays 1M.
    expect(resolveClaudeCapabilities('default', 'claude-sonnet-4-6[1m]').contextWindow).toBe(ONE_M)
  })

  it('routes maxOutput through resolvedModel without changing any real catalog row', () => {
    expect(
      claudeModelCapabilities({ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' })
        .maxOutput
    ).toBe(maxOutputTokens('haiku'))
    expect(
      claudeModelCapabilities({ value: 'default', resolvedModel: 'claude-opus-5[1m]' }).maxOutput
    ).toBe(128_000)
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

  it('pi fork/forkFromMessage are true (M5c: clone/fork RPCs wired end-to-end via PiSession.doStart)', () => {
    expect(PI_ENGINE_CAPABILITIES.fork).toBe(true)
    expect(PI_ENGINE_CAPABILITIES.forkFromMessage).toBe(true)
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
    const caps = piModelCapabilities({
      reasoning: false,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
    })
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
  it("auth.canDriveLogin is true (M6c: openai-codex is driven via the auth vault; pi's other subscription vendors stay undriven)", () => {
    expect(PI_ENGINE_CAPABILITIES.auth.canDriveLogin).toBe(true)
    expect(PI_ENGINE_CAPABILITIES.auth.multiAccount).toBe(false)
  })

  it("sideQuestion is true (/btw wired via PiSession.askSideQuestion's transcript-fed ephemeral pi process)", () => {
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

describe('resolveDesiredEffort / resolveSpawnEffort — the one effort ladder', () => {
  const OPUS = {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5', // built-in default: medium
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const
  }
  const DEFAULT_ROW = { ...OPUS, value: 'default' }
  const catalog = [DEFAULT_ROW, OPUS]
  const args = (over: Partial<Parameters<typeof resolveDesiredEffort>[0]> = {}) => ({
    explicit: null,
    modelInfo: OPUS,
    engineModels: catalog,
    effortDefaults: undefined,
    ...over
  })

  it('falls back to the built-in default with nothing saved and no pick', () => {
    expect(resolveDesiredEffort(args())).toBe('medium')
  })
  it("the model's saved starting effort beats the built-in default", () => {
    expect(
      resolveDesiredEffort(args({ effortDefaults: { modelEffortDefaults: { opus: 'high' } } }))
    ).toBe('high')
  })
  it('an explicit pick beats the saved starting effort', () => {
    expect(
      resolveDesiredEffort(
        args({ explicit: 'low', effortDefaults: { modelEffortDefaults: { opus: 'high' } } })
      )
    ).toBe('low')
  })
  it('reads the alias key for `default` too', () => {
    expect(
      resolveDesiredEffort(
        args({ modelInfo: DEFAULT_ROW, effortDefaults: { modelEffortDefaults: { opus: 'max' } } })
      )
    ).toBe('max')
  })
  it('still reads a v3.5 value saved under the resolved model id', () => {
    expect(
      resolveDesiredEffort(
        args({ effortDefaults: { modelEffortDefaults: { 'claude-opus-5-5': 'low' } } })
      )
    ).toBe('low')
  })
  describe('pi remembers in its OWN map, never in the Claude namespace', () => {
    // pi's `anthropic/claude-opus-5-5` canonicalises onto the key Claude's `opus`
    // row owns (its legacy key); pi must neither read nor write it.
    const piRow = {
      value: 'anthropic/claude-opus-5-5',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'] as const
    }
    const piArgs = (effortDefaults: EffortDefaultsSlice, over = {}) =>
      args({ engineId: 'pi', modelInfo: piRow, engineModels: [piRow], effortDefaults, ...over })

    it('reads engineEffortDefaults.pi[<model value>]', () => {
      expect(
        resolveDesiredEffort(
          piArgs({ engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'low' } } })
        )
      ).toBe('low')
    })
    it('never reads a Claude key, even one the model id canonicalises onto', () => {
      const saved: EffortDefaultsSlice = {
        modelEffortDefaults: { 'claude-opus-5-5': 'low', opus: 'low' }
      }
      expect(resolveDesiredEffort(piArgs(saved))).toBe(modelDefaultEffort(piRow))
    })
    it('does not read another engine entry or another pi model entry', () => {
      expect(
        resolveDesiredEffort(
          piArgs({
            engineEffortDefaults: {
              opencode: { 'anthropic/claude-opus-5-5': 'low' },
              pi: { 'other/model': 'low' }
            }
          })
        )
      ).toBe(modelDefaultEffort(piRow))
    })
    it('an explicit pick still wins', () => {
      expect(
        resolveDesiredEffort(
          piArgs(
            { engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'low' } } },
            { explicit: 'high' }
          )
        )
      ).toBe('high')
    })
    it('the spawn clamp holds a saved pi value to the model levels', () => {
      expect(
        resolveSpawnEffort(
          piArgs({ engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'max' } } })
        )
      ).toBe(modelDefaultEffort(piRow))
    })
  })
  it('opencode and Codex remember nothing: neither reads either map', () => {
    const row = { value: 'x/y', supportsEffort: true }
    const saved: EffortDefaultsSlice = {
      engineEffortDefaults: { opencode: { 'x/y': 'low' }, codex: { 'x/y': 'low' } }
    }
    for (const engineId of ['opencode', 'codex'])
      expect(
        resolveDesiredEffort(
          args({ engineId, modelInfo: row, engineModels: [row], effortDefaults: saved })
        )
      ).toBe(modelDefaultEffort(row))
  })
  it('spawn effort clamps a saved value the model does not offer', () => {
    const noMax = { ...OPUS, supportedEffortLevels: ['low', 'medium', 'high'] as const }
    expect(
      resolveSpawnEffort(
        args({ modelInfo: noMax, effortDefaults: { modelEffortDefaults: { opus: 'max' } } })
      )
    ).toBe('medium')
  })
  it('spawn effort keeps the desired value for a model with no effort support', () => {
    const none = { value: 'x', supportsEffort: false }
    expect(resolveSpawnEffort(args({ modelInfo: none, explicit: 'high' }))).toBe('high')
  })
})

describe('withSavedEffort', () => {
  it('writes the key, drops the legacy key, and does not mutate the input', () => {
    const before = { 'claude-opus-5-5': 'low', haiku: 'low' } as const
    const after = withSavedEffort(before, { key: 'opus', legacyKey: 'claude-opus-5-5' }, 'high')
    expect(after).toEqual({ opus: 'high', haiku: 'low' })
    expect(before).toEqual({ 'claude-opus-5-5': 'low', haiku: 'low' })
  })
  it('clears the key when next is undefined', () => {
    expect(withSavedEffort({ opus: 'high' }, { key: 'opus' }, undefined)).toEqual({})
  })
  it('accepts an unset map', () => {
    expect(withSavedEffort(undefined, { key: 'opus' }, 'low')).toEqual({ opus: 'low' })
  })
})

describe('rememberEffortPatch / savedEffortFor — the one read/write pair', () => {
  const OPUS = { value: 'opus', resolvedModel: 'claude-opus-5-5' }
  const PI = { value: 'anthropic/claude-opus-5-5' }

  it('only claude and pi remember', () => {
    expect(['claude', 'pi', undefined].map(engineRemembersEffort)).toEqual([true, true, true])
    expect(['opencode', 'codex'].map(engineRemembersEffort)).toEqual([false, false])
  })
  it('claude writes modelEffortDefaults under claudeEffortKey, moving a legacy key', () => {
    const settings = { modelEffortDefaults: { 'claude-opus-5-5': 'low' } } as const
    expect(rememberEffortPatch(settings, 'claude', OPUS, [OPUS], 'max')).toEqual({
      modelEffortDefaults: { opus: 'max' }
    })
  })
  it('pi writes engineEffortDefaults.pi[<value>] and leaves modelEffortDefaults out of the patch', () => {
    const settings = {
      modelEffortDefaults: { opus: 'low' },
      engineEffortDefaults: { pi: { 'other/m': 'high' } }
    } as const
    const patch = rememberEffortPatch(settings, 'pi', PI, [PI], 'max')
    expect(patch).toEqual({
      engineEffortDefaults: { pi: { 'other/m': 'high', 'anthropic/claude-opus-5-5': 'max' } }
    })
    expect(patch && 'modelEffortDefaults' in patch).toBe(false)
  })
  it('writes nothing for opencode, codex, or a model not in the catalog', () => {
    expect(rememberEffortPatch({}, 'opencode', PI, [PI], 'low')).toBeUndefined()
    expect(rememberEffortPatch({}, 'codex', PI, [PI], 'low')).toBeUndefined()
    expect(rememberEffortPatch({}, 'pi', undefined, [], 'low')).toBeUndefined()
    expect(rememberEffortPatch({}, 'claude', null, [], 'low')).toBeUndefined()
  })
  it('savedEffortFor reads what rememberEffortPatch wrote, per engine', () => {
    const piPatch = rememberEffortPatch({}, 'pi', PI, [PI], 'low')
    expect(savedEffortFor(piPatch, 'pi', PI, [PI])).toBe('low')
    expect(savedEffortFor(piPatch, 'claude', PI, [PI])).toBeUndefined()
    const claudePatch = rememberEffortPatch({}, 'claude', OPUS, [OPUS], 'high')
    expect(savedEffortFor(claudePatch, 'claude', OPUS, [OPUS])).toBe('high')
    expect(savedEffortFor(claudePatch, 'pi', PI, [PI])).toBeUndefined()
  })
})
