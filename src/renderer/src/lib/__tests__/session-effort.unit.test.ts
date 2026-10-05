import { describe, it, expect } from 'vitest'
import { rememberedModelEfforts, sessionSpawnEffort, spawnAnnouncement } from '../session-effort'
import type { ModelInfo } from '../../../../shared/types'

const OPUS: ModelInfo = {
  value: 'opus',
  resolvedModel: 'claude-opus-5-5',
  displayName: 'Opus',
  description: '',
  engineId: 'claude',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
}

describe('sessionSpawnEffort / rememberedModelEfforts', () => {
  const session = { selectedModel: 'opus', selectedEngineId: 'claude', effort: null }
  const state = (modelEffortDefaults = {}) => ({
    availableModels: [OPUS],
    settings: { modelEffortDefaults }
  })

  it('resolves the saved starting effort for a session with no pick', () => {
    expect(sessionSpawnEffort(state({ opus: 'xhigh' }), session)).toBe('xhigh')
    expect(sessionSpawnEffort(state(), session)).toBe('medium')
  })
  it('remembers a pick under the Settings table key, replacing a legacy key', () => {
    expect(rememberedModelEfforts(state({ 'claude-opus-5-5': 'low' }), session, 'max')).toEqual({
      opus: 'max'
    })
  })
  it('refuses to file a pick under "" when the model is not in the catalog', () => {
    expect(
      rememberedModelEfforts(state(), { ...session, selectedModel: 'gone' }, 'high')
    ).toBeUndefined()
  })
})

describe('spawnAnnouncement', () => {
  const NO_EFFORT: ModelInfo = {
    ...OPUS,
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    supportsEffort: false,
    supportedEffortLevels: []
  }
  const base = {
    selectedModel: 'opus',
    selectedEngineId: 'claude',
    effort: null,
    thinkingMode: null
  }
  const state = (modelEffortDefaults = {}) => ({
    availableModels: [OPUS, NO_EFFORT],
    settings: { modelEffortDefaults }
  })

  it('announces the RESOLVED starting effort for a session with no pick', () => {
    expect(spawnAnnouncement(state({ opus: 'high' }), base)).toEqual({
      effort: 'high',
      thinkingMode: null
    })
  })
  it('announces the effort the spawn already computed, so it equals the positional arg', () => {
    expect(spawnAnnouncement(state({ opus: 'high' }), base, 'low')?.effort).toBe('low')
  })
  it('announces the RAW thinking-mode pick', () => {
    expect(spawnAnnouncement(state(), { ...base, thinkingMode: 'disabled' })?.thinkingMode).toBe(
      'disabled'
    )
  })
  it('announces NO effort for a model that takes none, so no rung is frozen onto it', () => {
    expect(
      spawnAnnouncement(state(), { ...base, selectedModel: 'haiku', effort: 'high' })?.effort
    ).toBeNull()
  })
  it('OMITS effort when the model is not in the catalog — null would clear a pick', () => {
    const a = spawnAnnouncement(state(), { ...base, selectedModel: 'gone', effort: 'low' })
    expect(a).toEqual({ thinkingMode: null })
    expect(a && 'effort' in a).toBe(false)
    expect(
      spawnAnnouncement({ ...state(), availableModels: [] }, { ...base, effort: 'low' })
    ).toEqual({
      thinkingMode: null
    })
  })
  it('is undefined for Codex and for no session', () => {
    expect(spawnAnnouncement(state(), { ...base, selectedEngineId: 'codex' })).toBeUndefined()
    expect(spawnAnnouncement(state(), undefined)).toBeUndefined()
  })
})

describe('per-model effort is Claude-only', () => {
  // A pi model embedding a Claude id canonicalises onto the key Claude's own `opus`
  // row owns as its legacy key.
  const PI_OPUS: ModelInfo = {
    value: 'anthropic/claude-opus-5-5',
    displayName: 'Opus (pi)',
    description: '',
    engineId: 'pi',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  }
  const state = (modelEffortDefaults: Record<string, 'low' | 'max'> = {}) => ({
    availableModels: [OPUS, PI_OPUS],
    settings: { modelEffortDefaults }
  })
  const piSession = {
    selectedModel: PI_OPUS.value,
    selectedEngineId: 'pi',
    effort: null,
    thinkingMode: null
  }

  it('a pi pick writes nothing (it must not clobber or orphan a Claude row)', () => {
    expect(
      rememberedModelEfforts(state({ 'claude-opus-5-5': 'low' }), piSession, 'max')
    ).toBeUndefined()
  })
  it('a pi session does not read a Claude key', () => {
    expect(sessionSpawnEffort(state({ 'claude-opus-5-5': 'low' }), piSession)).toBe(
      sessionSpawnEffort(state(), piSession)
    )
    // ...but the same map still serves Claude's own row.
    expect(
      sessionSpawnEffort(state({ opus: 'low' }), {
        selectedModel: 'opus',
        selectedEngineId: 'claude',
        effort: null
      })
    ).toBe('low')
  })
  it('a pi session with a pick still announces its frozen effort', () => {
    expect(spawnAnnouncement(state(), { ...piSession, effort: 'high' })?.effort).toBe('high')
  })
})
