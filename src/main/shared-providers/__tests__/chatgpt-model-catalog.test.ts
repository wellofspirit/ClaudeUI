import { describe, expect, it } from 'vitest'
import type { EngineModelGroup } from '../../../shared/types'
import { aggregateChatgptModels } from '../chatgpt-model-catalog'

function group(
  vendorId: string,
  value: string,
  displayName: string,
  reasoning = false,
  vision = false
): EngineModelGroup {
  return {
    engineId: vendorId === 'openai-codex' ? 'pi' : 'opencode',
    vendorId,
    vendorName: vendorId,
    models: [{ value, displayName, description: '', supportsEffort: reasoning, vision }]
  }
}

describe('aggregateChatgptModels', () => {
  it('unions route-native catalogs, keeps unavailable routes explicit, and merges capabilities', () => {
    const models = aggregateChatgptModels(
      [group('openai-codex', 'openai-codex/gpt-test', 'Pi GPT', true, false)],
      [
        group('openai', 'openai/gpt-test', 'OpenCode GPT', false, true),
        group('openai', 'openai/gpt-other', 'Other')
      ]
    )
    expect(models).toEqual([
      {
        id: 'gpt-test',
        name: 'Pi GPT',
        reasoning: true,
        vision: true,
        harnessOverrides: {
          pi: { id: 'gpt-test', available: true },
          opencode: { id: 'gpt-test', available: true }
        }
      },
      {
        id: 'gpt-other',
        name: 'Other',
        reasoning: false,
        vision: false,
        harnessOverrides: {
          pi: { available: false },
          opencode: { id: 'gpt-other', available: true }
        }
      }
    ])
  })
})
