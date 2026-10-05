import { describe, it, expect } from 'vitest'
import { rememberedEffortPatch, sessionSpawnEffort, spawnAnnouncement } from '../session-effort'
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

describe('sessionSpawnEffort / rememberedEffortPatch', () => {
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
    expect(rememberedEffortPatch(state({ 'claude-opus-5-5': 'low' }), session, 'max')).toEqual({
      modelEffortDefaults: { opus: 'max' }
    })
  })
  it('refuses to file a pick under "" when the model is not in the catalog', () => {
    expect(
      rememberedEffortPatch(state(), { ...session, selectedModel: 'gone' }, 'high')
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

describe('pi remembers effort in its own map', () => {
  // A pi model embedding a Claude id canonicalises onto the key Claude's own `opus`
  // row owns as its legacy key; the two must stay apart.
  const PI_OPUS: ModelInfo = {
    value: 'anthropic/claude-opus-5-5',
    displayName: 'Opus (pi)',
    description: '',
    engineId: 'pi',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high']
  }
  const state = (settings: Record<string, unknown> = {}) => ({
    availableModels: [OPUS, PI_OPUS],
    settings
  })
  const piSession = {
    selectedModel: PI_OPUS.value,
    selectedEngineId: 'pi',
    effort: null,
    thinkingMode: null
  }

  it('a pi pick writes engineEffortDefaults.pi[<value>] and nothing in modelEffortDefaults', () => {
    const patch = rememberedEffortPatch(
      state({ modelEffortDefaults: { 'claude-opus-5-5': 'low' } }),
      piSession,
      'high'
    )
    expect(patch).toEqual({
      engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'high' } }
    })
  })
  it('a pi pick on a model not in the catalog writes nothing', () => {
    expect(
      rememberedEffortPatch(state(), { ...piSession, selectedModel: 'gone/model' }, 'high')
    ).toBeUndefined()
  })
  it('opencode and codex picks write nothing', () => {
    for (const selectedEngineId of ['opencode', 'codex']) {
      const row = { ...PI_OPUS, engineId: selectedEngineId as 'opencode' | 'codex' }
      expect(
        rememberedEffortPatch(
          { availableModels: [row], settings: {} },
          { ...piSession, selectedEngineId },
          'high'
        )
      ).toBeUndefined()
    }
  })
  it('a new pi session on that model spawns (and so displays) the remembered effort', () => {
    const settings = { engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'low' } } }
    expect(sessionSpawnEffort(state(settings), piSession)).toBe('low')
  })
  it('a remembered value the model does not offer is clamped at spawn', () => {
    // PI_OPUS offers low/medium/high only.
    const settings = { engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'max' } } }
    expect(sessionSpawnEffort(state(settings), piSession)).toBe('medium')
  })
  it('a pi session does not read a Claude key', () => {
    expect(
      sessionSpawnEffort(
        state({ modelEffortDefaults: { 'claude-opus-5-5': 'low', opus: 'low' } }),
        piSession
      )
    ).toBe(sessionSpawnEffort(state(), piSession))
    // ...but the same map still serves Claude's own row.
    expect(
      sessionSpawnEffort(state({ modelEffortDefaults: { opus: 'low' } }), {
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
