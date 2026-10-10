import { describe, it, expect } from 'vitest'
import type { ModelInfo } from '../../../../shared/types'
import { modelDisplayName } from '../model-display-name'

function model(over: Partial<ModelInfo> & { value: string }): ModelInfo {
  return { displayName: over.value, description: '', ...over }
}

const MODELS: ModelInfo[] = [
  model({
    value: 'openrouter/deepseek/deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash',
    engineId: 'pi'
  }),
  model({ value: 'opus', displayName: 'Opus', description: 'Opus 5 · Most capable' }),
  model({ value: 'coding4/qwen3.8:27b', engineId: 'pi' })
]

describe('modelDisplayName', () => {
  it('resolves the picker label within the session engine', () => {
    expect(modelDisplayName(MODELS, 'pi', 'openrouter/deepseek/deepseek-v4.1-flash')).toBe(
      'DeepSeek V4.1 Flash'
    )
  })

  it('reads a missing engine as claude, on both sides', () => {
    expect(modelDisplayName(MODELS, undefined, 'opus')).toBe('Opus 5')
    expect(modelDisplayName(MODELS, 'claude', 'opus')).toBe('Opus 5')
  })

  it('does not cross engines: values are only unique within one', () => {
    expect(modelDisplayName(MODELS, 'claude', 'openrouter/deepseek/deepseek-v4.1-flash')).toBe(
      undefined
    )
    expect(modelDisplayName(MODELS, 'pi', 'opus')).toBeUndefined()
  })

  it('is undefined when the row has no name of its own, or there is no row', () => {
    expect(modelDisplayName(MODELS, 'pi', 'coding4/qwen3.8:27b')).toBeUndefined()
    expect(modelDisplayName(MODELS, 'pi', 'unknown/model')).toBeUndefined()
    expect(modelDisplayName([], 'pi', 'x')).toBeUndefined()
  })
})
