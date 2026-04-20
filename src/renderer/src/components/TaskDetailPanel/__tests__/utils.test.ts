import { describe, it, expect } from 'vitest'
import { formatElapsed, findTaskBlocks } from '../utils'
import type { ContentBlock } from '../../../../../shared/types'

describe('formatElapsed', () => {
  it('formats seconds under a minute', () => {
    expect(formatElapsed(5)).toBe('5s')
    expect(formatElapsed(59)).toBe('59s')
  })

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(90)).toBe('1m 30s')
    expect(formatElapsed(125)).toBe('2m 5s')
  })

  it('rounds fractional seconds', () => {
    expect(formatElapsed(5.7)).toBe('6s')
    expect(formatElapsed(90.4)).toBe('1m 30s')
  })
})

describe('findTaskBlocks', () => {
  const toolUseBlock: ContentBlock = {
    type: 'tool_use',
    toolUseId: 'tu-1',
    toolName: 'Agent',
    toolInput: { prompt: 'do stuff' }
  }

  const toolResultBlock: ContentBlock = {
    type: 'tool_result',
    toolUseId: 'tu-1',
    toolResult: 'done',
    isError: false
  }

  it('finds matching task and result blocks', () => {
    const messages = [
      { role: 'assistant', content: [toolUseBlock] },
      { role: 'assistant', content: [toolResultBlock] }
    ]
    const result = findTaskBlocks(messages, 'tu-1')
    expect(result.taskBlock).toBeTruthy()
    expect(result.taskBlock!.toolUseId).toBe('tu-1')
    expect(result.resultBlock).toBeTruthy()
    expect(result.resultBlock!.toolResult).toBe('done')
  })

  it('returns nulls when no matching blocks', () => {
    const messages = [
      { role: 'assistant', content: [toolUseBlock] }
    ]
    const result = findTaskBlocks(messages, 'tu-999')
    expect(result.taskBlock).toBeNull()
    expect(result.resultBlock).toBeNull()
  })

  it('ignores tool_use blocks in user messages (only assistant tool_use is valid)', () => {
    const messages = [
      { role: 'user', content: [toolUseBlock] }
    ]
    const result = findTaskBlocks(messages, 'tu-1')
    expect(result.taskBlock).toBeNull()
  })

  // Regression: the store stores tool_result blocks inside synthetic
  // role:'user' messages (see session-store addToolResult). A prior
  // implementation of findTaskBlocks filtered out user messages entirely,
  // so the result block was never found and TaskEntry's "completed" state
  // never rendered.
  it('finds tool_result blocks that live in role:user messages', () => {
    const messages = [
      { role: 'assistant', content: [toolUseBlock] },
      { role: 'user', content: [toolResultBlock] },
    ]
    const result = findTaskBlocks(messages, 'tu-1')
    expect(result.taskBlock?.toolUseId).toBe('tu-1')
    expect(result.resultBlock?.toolResult).toBe('done')
  })
})
