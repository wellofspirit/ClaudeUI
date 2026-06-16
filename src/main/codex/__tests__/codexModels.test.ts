/**
 * Unit tests for the Codex model → ModelInfo mapping logic in codexModels.ts.
 *
 * Pure function tests — no process spawn, no IPC. We test mapCodexModelToModelInfo
 * with canned V2Model inputs and assert the ModelInfo output shape.
 */

import { describe, it, expect } from 'vitest'
import { mapCodexModelToModelInfo } from '../codexModels'
import type { V2Model } from '../protocol/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<V2Model> = {}): V2Model {
  return {
    id: 'model-id',
    model: 'codex-mini-latest',
    displayName: 'codex-mini',
    description: 'A fast model',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapCodexModelToModelInfo', () => {
  it('maps slug to value', () => {
    const info = mapCodexModelToModelInfo(makeModel({ model: 'o4-mini' }))
    expect(info.value).toBe('o4-mini')
  })

  it('capitalizes GPT prefix in displayName', () => {
    const info = mapCodexModelToModelInfo(makeModel({ displayName: 'gpt-4o' }))
    expect(info.displayName).toBe('GPT-4o')
  })

  it('capitalizes letters after dashes in displayName', () => {
    const info = mapCodexModelToModelInfo(makeModel({ displayName: 'codex-mini-latest' }))
    expect(info.displayName).toBe('codex-Mini-Latest')
  })

  it('sets supportsEffort to true for all models', () => {
    const info = mapCodexModelToModelInfo(makeModel())
    expect(info.supportsEffort).toBe(true)
  })

  it('sets supportsAdaptiveThinking to false', () => {
    const info = mapCodexModelToModelInfo(makeModel())
    expect(info.supportsAdaptiveThinking).toBe(false)
  })

  it('maps supportedReasoningEfforts to supportedEffortLevels', () => {
    const info = mapCodexModelToModelInfo(
      makeModel({
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' },
          { reasoningEffort: 'medium', description: 'Medium' },
          { reasoningEffort: 'high', description: 'High' },
        ],
      })
    )
    expect(info.supportedEffortLevels).toEqual(['low', 'medium', 'high'])
  })

  it('filters out unknown effort levels not in ClaudeUI EffortLevel union', () => {
    const info = mapCodexModelToModelInfo(
      makeModel({
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' },
          { reasoningEffort: 'extreme', description: 'Extreme' }, // not in union
          { reasoningEffort: 'high', description: 'High' },
        ],
      })
    )
    expect(info.supportedEffortLevels).toEqual(['low', 'high'])
    expect(info.supportedEffortLevels).not.toContain('extreme')
  })

  it('sets supportedEffortLevels to undefined when all efforts are unknown', () => {
    const info = mapCodexModelToModelInfo(
      makeModel({
        supportedReasoningEfforts: [
          { reasoningEffort: 'turbo', description: 'Turbo' },
          { reasoningEffort: 'extreme', description: 'Extreme' },
        ],
      })
    )
    // All filtered out → undefined
    expect(info.supportedEffortLevels).toBeUndefined()
  })

  it('sets supportedEffortLevels to undefined when list is empty', () => {
    const info = mapCodexModelToModelInfo(
      makeModel({ supportedReasoningEfforts: [] })
    )
    expect(info.supportedEffortLevels).toBeUndefined()
  })

  it('sets description to empty string', () => {
    const info = mapCodexModelToModelInfo(makeModel({ description: 'Some description' }))
    // ClaudeUI uses description for the "model · description" label in the picker.
    // Codex models don't have useful subtitles, so we leave it empty.
    expect(info.description).toBe('')
  })

  it('maps known effort levels including xhigh and max', () => {
    const info = mapCodexModelToModelInfo(
      makeModel({
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'medium', description: '' },
          { reasoningEffort: 'high', description: '' },
          { reasoningEffort: 'xhigh', description: '' },
          { reasoningEffort: 'max', description: '' },
        ],
      })
    )
    expect(info.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})
