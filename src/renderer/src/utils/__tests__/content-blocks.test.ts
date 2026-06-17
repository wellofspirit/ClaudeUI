import { describe, it, expect } from 'vitest'
import { mergeContentBlocks } from '../content-blocks'
import type { ContentBlock } from '../../../../shared/types'

describe('mergeContentBlocks', () => {
  it('returns new blocks when old is empty', () => {
    const newBlocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    expect(mergeContentBlocks([], newBlocks)).toEqual(newBlocks)
  })

  it('returns new blocks when they fully replace old text', () => {
    const old: ContentBlock[] = [{ type: 'text', text: 'old' }]
    const next: ContentBlock[] = [{ type: 'text', text: 'new' }]
    expect(mergeContentBlocks(old, next)).toEqual([{ type: 'text', text: 'new' }])
  })

  it('preserves old tool_use blocks not in the new set', () => {
    const old: ContentBlock[] = [
      { type: 'tool_use', toolUseId: 'a', toolName: 'Read' },
      { type: 'tool_use', toolUseId: 'b', toolName: 'Write' }
    ]
    const next: ContentBlock[] = [
      { type: 'tool_use', toolUseId: 'b', toolName: 'Write' },
      { type: 'text', text: 'done' }
    ]
    const result = mergeContentBlocks(old, next)
    expect(result).toEqual([
      { type: 'tool_use', toolUseId: 'a', toolName: 'Read' },
      { type: 'tool_use', toolUseId: 'b', toolName: 'Write' },
      { type: 'text', text: 'done' }
    ])
  })

  it('preserves old tool_result blocks not in the new set', () => {
    const old: ContentBlock[] = [
      { type: 'tool_result', toolUseId: 'a', toolResult: 'file contents' }
    ]
    const next: ContentBlock[] = [{ type: 'text', text: 'response' }]
    const result = mergeContentBlocks(old, next)
    expect(result).toEqual([
      { type: 'tool_result', toolUseId: 'a', toolResult: 'file contents' },
      { type: 'text', text: 'response' }
    ])
  })

  it('does not duplicate tool_result blocks already in new set', () => {
    const old: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'a', toolResult: 'v1' }]
    const next: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'a', toolResult: 'v2' }]
    const result = mergeContentBlocks(old, next)
    expect(result).toEqual([{ type: 'tool_result', toolUseId: 'a', toolResult: 'v2' }])
  })

  it('preserves old thinking blocks dropped by new message', () => {
    const old: ContentBlock[] = [
      { type: 'thinking', text: 'thought 1' },
      { type: 'thinking', text: 'thought 2' }
    ]
    const next: ContentBlock[] = [{ type: 'thinking', text: 'thought 2' }]
    const result = mergeContentBlocks(old, next)
    // Old had 2 thinking, new has 1 → 1 dropped, so preserve the first
    expect(result).toEqual([
      { type: 'thinking', text: 'thought 1' },
      { type: 'thinking', text: 'thought 2' }
    ])
  })

  it('preserves old text block when new message has no text', () => {
    const old: ContentBlock[] = [{ type: 'text', text: 'old text' }]
    const next: ContentBlock[] = [{ type: 'tool_use', toolUseId: 'x', toolName: 'Bash' }]
    const result = mergeContentBlocks(old, next)
    expect(result).toEqual([
      { type: 'text', text: 'old text' },
      { type: 'tool_use', toolUseId: 'x', toolName: 'Bash' }
    ])
  })

  it('drops old text block when new message has text', () => {
    const old: ContentBlock[] = [{ type: 'text', text: 'old text' }]
    const next: ContentBlock[] = [{ type: 'text', text: 'updated text' }]
    const result = mergeContentBlocks(old, next)
    expect(result).toEqual([{ type: 'text', text: 'updated text' }])
  })

  it('handles complex mixed scenario', () => {
    const old: ContentBlock[] = [
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', toolUseId: 'a', toolName: 'Read' },
      { type: 'tool_result', toolUseId: 'a', toolResult: 'contents' },
      { type: 'tool_use', toolUseId: 'b', toolName: 'Edit' }
    ]
    const next: ContentBlock[] = [
      { type: 'tool_use', toolUseId: 'b', toolName: 'Edit' },
      { type: 'tool_result', toolUseId: 'b', toolResult: 'ok' },
      { type: 'text', text: 'done editing' }
    ]
    const result = mergeContentBlocks(old, next)
    // Preserved: thinking (dropped=1-0=1, but old only has 1, so droppedCount=max(0,1-0)=1,
    // first thinking is preserved), tool_use 'a', tool_result 'a'
    // Old text dropped because new has text
    expect(result.map((b) => b.type)).toEqual([
      'thinking',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'text'
    ])
    expect(result[1]).toEqual({ type: 'tool_use', toolUseId: 'a', toolName: 'Read' })
    expect(result[5]).toEqual({ type: 'text', text: 'done editing' })
  })
})
