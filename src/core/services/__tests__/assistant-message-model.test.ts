/**
 * @vitest-environment node
 *
 * `transformAssistantMessage` carries the model an assistant message ran on —
 * the non-stream path of a Claude session and a headless dispatch target both
 * build their ChatMessage here.
 */
import { describe, expect, it } from 'vitest'
import { transformAssistantMessage } from '../assistant-message'

const text = [{ type: 'text', text: 'hi' }]

describe('transformAssistantMessage — model', () => {
  it('carries the model the message ran on', () => {
    const msg = transformAssistantMessage({
      message: { id: 'm1', model: 'claude-opus-5-5', content: text }
    })
    expect(msg?.model).toBe('claude-opus-5-5')
  })

  it('leaves the field off when the message names no model', () => {
    const msg = transformAssistantMessage({ message: { id: 'm1', content: text } })
    expect(msg).not.toHaveProperty('model')
    expect(
      transformAssistantMessage({ message: { id: 'm2', model: '', content: text } })
    ).not.toHaveProperty('model')
  })
})
