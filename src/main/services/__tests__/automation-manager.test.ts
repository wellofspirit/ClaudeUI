/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import type { ContentBlock, ChatMessage } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Replicate the private pure functions from AutomationManager for testing
// ---------------------------------------------------------------------------

function transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
  const betaMessage = msg.message as Record<string, unknown> | undefined
  if (!betaMessage) return null

  const id = (betaMessage.id as string) || 'test-id'
  const rawContent = betaMessage.content as Array<Record<string, unknown>> | undefined
  if (!rawContent || !Array.isArray(rawContent)) return null

  const content: ContentBlock[] = rawContent.map((block) => {
    const blockType = block.type as string
    if (blockType === 'text') {
      return { type: 'text' as const, text: (block.text as string) || '' }
    } else if (blockType === 'tool_use') {
      return {
        type: 'tool_use' as const,
        toolName: (block.name as string) || '',
        toolInput: (block.input as Record<string, unknown>) || {},
        toolUseId: (block.id as string) || '',
      }
    } else if (blockType === 'thinking') {
      return { type: 'thinking' as const, text: (block.thinking as string) || '' }
    }
    return { type: 'text' as const, text: '' }
  }).filter((b) => b.text !== '' || b.type !== 'text')

  return { id, role: 'assistant', content, timestamp: Date.now() }
}

function extractToolResults(content: Array<Record<string, unknown>>): ContentBlock[] {
  const results: ContentBlock[] = []
  for (const block of content) {
    if (typeof block !== 'object' || !block || block.type !== 'tool_result') continue
    const toolUseId = block.tool_use_id as string
    if (!toolUseId) continue

    let resultText = ''
    const blockContent = block.content
    if (typeof blockContent === 'string') {
      resultText = blockContent
    } else if (Array.isArray(blockContent)) {
      resultText = blockContent
        .map((c: Record<string, unknown>) => (c.text as string) || '')
        .join('\n')
    }

    results.push({
      type: 'tool_result',
      toolUseId,
      toolResult: resultText,
      isError: !!(block.is_error),
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transformAssistantMessage', () => {
  it('transforms a text message', () => {
    const msg = {
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    }

    const result = transformAssistantMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('msg-1')
    expect(result!.role).toBe('assistant')
    expect(result!.content).toHaveLength(1)
    expect(result!.content[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('transforms tool_use blocks', () => {
    const msg = {
      message: {
        id: 'msg-2',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/test.ts' },
        }],
      },
    }

    const result = transformAssistantMessage(msg)
    expect(result!.content).toHaveLength(1)
    const block = result!.content[0]
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      expect(block.toolName).toBe('Read')
      expect(block.toolInput).toEqual({ file_path: '/test.ts' })
      expect(block.toolUseId).toBe('tool-1')
    }
  })

  it('transforms thinking blocks', () => {
    const msg = {
      message: {
        id: 'msg-3',
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
      },
    }

    const result = transformAssistantMessage(msg)
    expect(result!.content).toHaveLength(1)
    expect(result!.content[0]).toEqual({ type: 'thinking', text: 'Let me think...' })
  })

  it('filters out empty text blocks', () => {
    const msg = {
      message: {
        id: 'msg-4',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Valid text' },
          { type: 'unknown_type' }, // becomes empty text, gets filtered
        ],
      },
    }

    const result = transformAssistantMessage(msg)
    expect(result!.content).toHaveLength(1)
    expect(result!.content[0]).toEqual({ type: 'text', text: 'Valid text' })
  })

  it('returns null when message is missing', () => {
    expect(transformAssistantMessage({})).toBeNull()
  })

  it('returns null when content is not an array', () => {
    const msg = { message: { id: 'msg-5', content: 'not an array' } }
    expect(transformAssistantMessage(msg)).toBeNull()
  })

  it('handles mixed content blocks', () => {
    const msg = {
      message: {
        id: 'msg-6',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }

    const result = transformAssistantMessage(msg)
    expect(result!.content).toHaveLength(3)
    expect(result!.content[0].type).toBe('thinking')
    expect(result!.content[1].type).toBe('text')
    expect(result!.content[2].type).toBe('tool_use')
  })
})

describe('extractToolResults', () => {
  it('extracts a simple string tool result', () => {
    const content = [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'File contents here',
    }]

    const results = extractToolResults(content)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'tool-1',
      toolResult: 'File contents here',
      isError: false,
    })
  })

  it('extracts array content tool result', () => {
    const content = [{
      type: 'tool_result',
      tool_use_id: 'tool-2',
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    }]

    const results = extractToolResults(content)
    expect(results).toHaveLength(1)
    expect(results[0].type === 'tool_result' && results[0].toolResult).toBe('line 1\nline 2')
  })

  it('handles error results', () => {
    const content = [{
      type: 'tool_result',
      tool_use_id: 'tool-3',
      content: 'Error: file not found',
      is_error: true,
    }]

    const results = extractToolResults(content)
    expect(results).toHaveLength(1)
    expect(results[0].type === 'tool_result' && results[0].isError).toBe(true)
  })

  it('skips non-tool-result blocks', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'tool_result', tool_use_id: 'tool-4', content: 'ok' },
      { type: 'tool_use', id: 'x' },
    ]

    const results = extractToolResults(content)
    expect(results).toHaveLength(1)
  })

  it('skips tool_result without tool_use_id', () => {
    const content = [{
      type: 'tool_result',
      content: 'orphan result',
    }]

    const results = extractToolResults(content)
    expect(results).toHaveLength(0)
  })

  it('handles empty content array', () => {
    expect(extractToolResults([])).toEqual([])
  })

  it('extracts multiple tool results', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'a', content: 'result A' },
      { type: 'tool_result', tool_use_id: 'b', content: 'result B' },
    ]

    const results = extractToolResults(content)
    expect(results).toHaveLength(2)
  })
})
