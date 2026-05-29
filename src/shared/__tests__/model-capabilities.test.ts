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
} from '../model-capabilities'

describe('supportsAdaptiveThinking', () => {
  it('is true for opus-4-8 / opus-4-7 / opus-4-6 / sonnet-4-6', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true)
    expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true)
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true)
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
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
    expect(supportsEffort('claude-opus-4-5')).toBe(false)
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
  })
})

describe('supportsXhighEffort', () => {
  it('is opus-4-7 and opus-4-8', () => {
    expect(supportsXhighEffort('claude-opus-4-7')).toBe(true)
    expect(supportsXhighEffort('claude-opus-4-8')).toBe(true)
    expect(supportsXhighEffort('claude-opus-4-6')).toBe(false)
    expect(supportsXhighEffort('claude-sonnet-4-6')).toBe(false)
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
  it('returns full set with xhigh for opus-4-7 and opus-4-8', () => {
    expect(supportedEffortLevels('claude-opus-4-7')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(supportedEffortLevels('claude-opus-4-8')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('drops xhigh for opus-4-6 / sonnet-4-6', () => {
    expect(supportedEffortLevels('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(supportedEffortLevels('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  })
  it('returns empty array for models without effort support', () => {
    expect(supportedEffortLevels('claude-sonnet-4-5')).toEqual([])
    expect(supportedEffortLevels('claude-haiku-4-5')).toEqual([])
  })
})

describe('defaultEffort', () => {
  it('xhigh for opus-4-7, high for everyone else (incl. opus-4-8)', () => {
    expect(defaultEffort('claude-opus-4-7')).toBe('xhigh')
    expect(defaultEffort('claude-opus-4-8')).toBe('high')
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
    expect(modelSupportsAdaptiveThinking({
      value: 'default', // alias, id heuristic has no info
      supportsAdaptiveThinking: true,
    })).toBe(true)
  })
  it('trusts SDK-supplied supportsAdaptiveThinking=false', () => {
    expect(modelSupportsAdaptiveThinking({
      value: 'default',
      supportsAdaptiveThinking: false,
    })).toBe(false)
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
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    }
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportedEffortLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('returns SDK-supplied level list when present (sonnet — no xhigh)', () => {
    const model = {
      value: 'sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const,
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
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const,
    }
    expect(modelDefaultEffort(sonnet)).toBe('high')
  })
  it('returns xhigh for opus-4-7 (via id heuristic)', () => {
    expect(modelDefaultEffort({ value: 'claude-opus-4-7' })).toBe('xhigh')
  })
  it('returns high for opus-4-8 even though it supports xhigh', () => {
    // 4.8 supports xhigh but defaults to high — mirrors cli.js YK6.
    expect(modelDefaultEffort({ value: 'claude-opus-4-8' })).toBe('high')
    expect(modelDefaultEffort({
      value: 'claude-opus-4-8',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })).toBe('high')
  })
  it('does not blanket-pick xhigh just because SDK lists it as allowed', () => {
    // The `default`/`opus` alias resolves to opus-4-8 today; xhigh in the
    // allowed list must not be auto-selected when the id heuristic says high.
    expect(modelDefaultEffort({
      value: 'default',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })).toBe('high')
  })
  it('skips id-heuristic default when not in SDK-provided list', () => {
    // Id heuristic says xhigh for opus-4-7, but here the SDK claims only
    // low/medium/high are allowed for this hypothetical model — must not pick xhigh.
    expect(modelDefaultEffort({
      value: 'claude-opus-4-7',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    })).toBe('high')
  })
})

describe('modelDefaultThinkingMode', () => {
  it('adaptive when SDK supports it', () => {
    expect(modelDefaultThinkingMode({ value: 'default', supportsAdaptiveThinking: true })).toBe('adaptive')
  })
  it('enabled when SDK says no adaptive', () => {
    expect(modelDefaultThinkingMode({ value: 'haiku', supportsAdaptiveThinking: false })).toBe('enabled')
    expect(modelDefaultThinkingMode({ value: 'haiku' })).toBe('enabled') // id-fallback
  })
})

describe('canonicalizeModelValue', () => {
  it('maps known aliases to current canonical ids (mirrors cli.js i8_)', () => {
    expect(canonicalizeModelValue('opus')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('opus[1m]')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('sonnet')).toBe('claude-sonnet-4-6')
    expect(canonicalizeModelValue('sonnet[1m]')).toBe('claude-sonnet-4-6')
    expect(canonicalizeModelValue('haiku')).toBe('claude-haiku-4-5')
  })
  it('passes canonical ids through (normalised, date stripped)', () => {
    expect(canonicalizeModelValue('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(canonicalizeModelValue('claude-opus-4-7-20260101')).toBe('claude-opus-4-7')
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
      supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const,
    }
    expect(modelResolveEffort(sonnet, 'xhigh')).toBe('high') // not in list → default
    expect(modelResolveEffort(sonnet, 'max')).toBe('max')    // allowed
  })
})
