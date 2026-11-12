/**
 * @vitest-environment node
 *
 * The leaf that maps Claude wire blocks and decodes usage. Every engine path
 * (live frame, transcript replay, subagent tail, dispatch mirror) reads through
 * it, so these pin what each raw shape becomes.
 */
import { describe, it, expect } from 'vitest'
import {
  claudeAssistantMessage,
  claudeContentBlock,
  claudeContentBlocks,
  claudeContextLength,
  claudeToolResultBlock,
  claudeToolResults,
  claudeUsageTokens,
  fallbackBlockText,
  mergeAssistantSnapshot
} from '../claude-transcript'
import type { ContentBlock } from '../../../shared/types'

const PNG = 'iVBORw0KGgo='

describe('claudeContentBlock', () => {
  it('maps text, thinking and tool_use', () => {
    expect(claudeContentBlock({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' })
    expect(claudeContentBlock({ type: 'thinking', thinking: 'hm', signature: 's' })).toEqual({
      type: 'thinking',
      text: 'hm'
    })
    expect(
      claudeContentBlock({ type: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'a' } })
    ).toEqual({ type: 'tool_use', toolName: 'Read', toolInput: { path: 'a' }, toolUseId: 'tu1' })
  })

  it('renders a fallback block as a readable note', () => {
    expect(
      claudeContentBlock({ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } })
    ).toEqual({ type: 'text', text: 'Switched models from a to b.' })
    expect(fallbackBlockText({})).toBe('Switched models.')
  })

  it('keeps an unknown block type as its JSON', () => {
    const raw = { type: 'server_tool_use', id: 'x' }
    expect(claudeContentBlock(raw)).toEqual({ type: 'text', text: JSON.stringify(raw) })
  })

  it('never leaves undefined in a required field of a malformed block', () => {
    expect(claudeContentBlock({ type: 'text' })).toEqual({ type: 'text', text: '' })
    expect(claudeContentBlock({ type: 'thinking', thinking: 3 })).toEqual({
      type: 'thinking',
      text: ''
    })
    expect(claudeContentBlock({ type: 'tool_use', input: 'nope' })).toEqual({
      type: 'tool_use',
      toolName: '',
      toolInput: {},
      toolUseId: ''
    })
  })

  it('maps an embedded tool_result with isError false when is_error is absent', () => {
    expect(claudeContentBlock({ type: 'tool_result', tool_use_id: 't', content: 'ok' })).toEqual({
      type: 'tool_result',
      toolUseId: 't',
      toolResult: 'ok',
      isError: false
    })
  })
})

describe('claudeContentBlocks', () => {
  it('is null for non-array content', () => {
    expect(claudeContentBlocks('text')).toBeNull()
    expect(claudeContentBlocks(undefined)).toBeNull()
  })

  it('maps every entry, tolerating a non-object one', () => {
    expect(claudeContentBlocks([{ type: 'text', text: 'a' }, null])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'null' }
    ])
  })
})

describe('claudeToolResults', () => {
  it('decodes plain, error, array and image results', () => {
    const results = claudeToolResults([
      { type: 'tool_result', tool_use_id: 'a', content: 'plain' },
      { type: 'tool_result', tool_use_id: 'b', content: 'boom', is_error: true },
      {
        type: 'tool_result',
        tool_use_id: 'c',
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
        ]
      }
    ])
    expect(results.map((r) => [r.toolUseId, r.text, r.isError])).toEqual([
      ['a', 'plain', false],
      ['b', 'boom', true],
      ['c', 'one\ntwo\n', false]
    ])
    expect(results[0].images).toBeUndefined()
    expect(results[2].images).toHaveLength(1)
    expect(results[2].images![0].mediaType).toBe('image/png')
  })

  it('skips non-objects, other types and a missing or empty tool_use_id', () => {
    expect(
      claudeToolResults([
        null,
        'x',
        { type: 'text', text: 'a' },
        { type: 'tool_result', content: 'no id' },
        { type: 'tool_result', tool_use_id: '', content: 'empty id' },
        { type: 'tool_result', tool_use_id: 'ok', content: 'kept' }
      ]).map((r) => r.toolUseId)
    ).toEqual(['ok'])
  })

  it('is empty for non-array content', () => {
    expect(claudeToolResults('string')).toEqual([])
    expect(claudeToolResults(undefined)).toEqual([])
  })

  it('claudeToolResultBlock carries images only when present', () => {
    expect(claudeToolResultBlock({ toolUseId: 't', text: 'x', isError: true })).toEqual({
      type: 'tool_result',
      toolUseId: 't',
      toolResult: 'x',
      isError: true
    })
    const images = [{ mediaType: 'image/png' as const, id: 'i', size: 1 }]
    expect(
      claudeToolResultBlock({ toolUseId: 't', text: '', isError: false, images } as never)
    ).toHaveProperty('images', images)
  })
})

describe('claudeAssistantMessage', () => {
  const opts = { fallbackId: () => 'fallback', timestamp: 42 }

  it('is null without a message or with non-array content', () => {
    expect(claudeAssistantMessage({}, opts)).toBeNull()
    expect(claudeAssistantMessage({ message: { content: 'x' } }, opts)).toBeNull()
  })

  it('takes the id from message.id, then the line uuid, then the fallback', () => {
    const content = [{ type: 'text', text: 'a' }]
    expect(claudeAssistantMessage({ uuid: 'u', message: { id: 'm', content } }, opts)!.id).toBe('m')
    expect(claudeAssistantMessage({ uuid: 'u', message: { content } }, opts)!.id).toBe('u')
    expect(claudeAssistantMessage({ message: { content } }, opts)!.id).toBe('fallback')
  })

  it('sets model only when it is a non-empty string', () => {
    const content: unknown[] = []
    expect(claudeAssistantMessage({ message: { id: 'm', model: 'x', content } }, opts)).toEqual({
      id: 'm',
      role: 'assistant',
      content: [],
      timestamp: 42,
      model: 'x'
    })
    expect(
      claudeAssistantMessage({ message: { id: 'm', model: '', content } }, opts)
    ).not.toHaveProperty('model')
  })
})

describe('mergeAssistantSnapshot', () => {
  const use = (id: string): ContentBlock => ({
    type: 'tool_use',
    toolName: 'Read',
    toolInput: {},
    toolUseId: id
  })
  const text = (t: string): ContentBlock => ({ type: 'text', text: t })
  const thinking = (t: string): ContentBlock => ({ type: 'thinking', text: t })

  it('keeps old tool_use blocks the snapshot lacks, drops ones it re-sends', () => {
    const merged = mergeAssistantSnapshot([use('a'), use('b')], [use('b'), text('t')])
    expect(merged).toEqual([use('a'), use('b'), text('t')])
  })

  it('keeps old text or thinking only when the snapshot has none of that kind', () => {
    expect(mergeAssistantSnapshot([text('old'), thinking('old')], [use('a')])).toEqual([
      text('old'),
      thinking('old'),
      use('a')
    ])
    expect(mergeAssistantSnapshot([text('old'), thinking('old')], [text('new')])).toEqual([
      thinking('old'),
      text('new')
    ])
  })

  it('keeps an old tool_result the snapshot does not carry', () => {
    const result: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'a',
      toolResult: 'r',
      isError: false
    }
    expect(mergeAssistantSnapshot([use('a'), result], [use('a')])).toEqual([result, use('a')])
  })
})

describe('claudeUsageTokens', () => {
  it('decodes every field, with the 1h subset of cache writes', () => {
    const t = claudeUsageTokens({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 25 },
      cache_read_input_tokens: 40
    })
    expect(t).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheWrite1h: 25, cacheRead: 40 })
    expect(claudeContextLength(t)).toBe(80)
  })

  it('reads a missing breakdown as 0 and a missing or non-finite field as 0', () => {
    expect(
      claudeUsageTokens({ input_tokens: 'x', output_tokens: NaN, cache_read_input_tokens: 7 })
    ).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 7 })
  })

  it('is all zeros for a non-object usage', () => {
    const zero = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    expect(claudeUsageTokens(undefined)).toEqual(zero)
    expect(claudeUsageTokens('x')).toEqual(zero)
  })
})
