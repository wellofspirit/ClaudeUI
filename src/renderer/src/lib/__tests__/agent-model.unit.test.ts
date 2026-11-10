import { describe, it, expect } from 'vitest'
import { latestMessageModel, resolveAgentModel } from '../agent-model'
import type { ChatMessage } from '../../../../shared/types'

function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'assistant', content: [], timestamp: 0, ...over }
}

describe('latestMessageModel', () => {
  it('is the model of the newest assistant message that has one', () => {
    const messages = [
      msg({ id: 'a', model: 'claude-haiku-4-5' }),
      msg({ id: 'b', model: 'claude-opus-5-5' })
    ]
    expect(latestMessageModel(messages)).toBe('claude-opus-5-5')
  })

  it('is not cleared by a newer message with no model (an error row)', () => {
    const messages = [
      msg({ id: 'a', model: 'claude-opus-5-5' }),
      msg({ id: 'b' }),
      msg({ id: 'c', content: [{ type: 'text', text: 'boom' }] })
    ]
    expect(latestMessageModel(messages)).toBe('claude-opus-5-5')
  })

  it('ignores a model on a message that is not the assistant’s', () => {
    expect(latestMessageModel([msg({ id: 'u', role: 'user', model: 'claude-opus-5-5' })])).toBe(
      undefined
    )
  })

  it('is undefined for no messages, or none with a model', () => {
    expect(latestMessageModel(undefined)).toBeUndefined()
    expect(latestMessageModel([])).toBeUndefined()
    expect(latestMessageModel([msg({ id: 'a' })])).toBeUndefined()
  })

  it('reads a bucket again once the store replaces its array', () => {
    const first = [msg({ id: 'a', model: 'claude-haiku-4-5' })]
    expect(latestMessageModel(first)).toBe('claude-haiku-4-5')
    const next = [...first, msg({ id: 'b', model: 'claude-opus-5-5' })]
    expect(latestMessageModel(next)).toBe('claude-opus-5-5')
    // The old array is still what it was.
    expect(latestMessageModel(first)).toBe('claude-haiku-4-5')
  })
})

describe('resolveAgentModel', () => {
  it('prefers what the agent’s messages report over what the spawn asked for', () => {
    expect(
      resolveAgentModel({ latestModel: 'claude-opus-5-5', requested: 'haiku', engine: 'claude' })
    ).toBe('claude-opus-5-5')
  })

  it('falls to the requested model, then to nothing', () => {
    expect(resolveAgentModel({ requested: 'haiku', engine: 'claude' })).toBe('haiku')
    expect(resolveAgentModel({ engine: 'claude' })).toBeUndefined()
  })

  it('names a dispatch by the model it ran on, else the one it asked for', () => {
    const dispatch = { engine: 'opencode', model: 'openai/gpt-6-luna' }
    expect(resolveAgentModel({ dispatch, latestModel: 'openai/gpt-6-sol' })).toBe(
      'openai/gpt-6-sol'
    )
    expect(resolveAgentModel({ dispatch })).toBe('openai/gpt-6-luna')
    expect(resolveAgentModel({ dispatch: { engine: 'pi' } })).toBeUndefined()
  })

  it('never lets a dispatch fall back to the spawn view', () => {
    expect(
      resolveAgentModel({
        dispatch: { engine: 'opencode' },
        requested: 'sonnet',
        engine: 'claude'
      })
    ).toBeUndefined()
  })
})
