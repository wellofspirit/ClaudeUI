import { describe, it, expect } from 'vitest'
import { findTaskBlocks } from '../utils'
import type { ContentBlock } from '../../../../../shared/types'

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
    const messages = [{ role: 'assistant', content: [toolUseBlock] }]
    const result = findTaskBlocks(messages, 'tu-999')
    expect(result.taskBlock).toBeNull()
    expect(result.resultBlock).toBeNull()
  })

  it('ignores tool_use blocks in user messages (only assistant tool_use is valid)', () => {
    const messages = [{ role: 'user', content: [toolUseBlock] }]
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
      { role: 'user', content: [toolResultBlock] }
    ]
    const result = findTaskBlocks(messages, 'tu-1')
    expect(result.taskBlock?.toolUseId).toBe('tu-1')
    expect(result.resultBlock?.toolResult).toBe('done')
  })
})
