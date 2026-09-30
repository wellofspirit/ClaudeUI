import { describe, it, expect } from 'vitest'
import { findTaskBlocks } from '../utils'
import type { ContentBlock } from '../../../../../shared/types'
import {
  A,
  A_BG_BASH,
  B,
  B_FG_BASH,
  nestedBuckets,
  nestedMessages
} from '@test/factories/nested-agents'

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

  // ADR-073 §7: a nested agent's spawn and its result live in the parent's bucket.
  describe('with sub-agent buckets', () => {
    it("finds a nested call and its result in the parent's bucket", () => {
      const r = findTaskBlocks(nestedMessages(), B, nestedBuckets())
      expect(r.taskBlock?.toolUseId).toBe(B)
      expect(r.resultBlock?.toolResult).toContain('Async agent launched')
      expect(r.ownerToolUseId).toBe(A)
    })

    it('finds a call two levels down, and a subagent Bash with its result', () => {
      expect(findTaskBlocks(nestedMessages(), B_FG_BASH, nestedBuckets()).ownerToolUseId).toBe(B)
      const bg = findTaskBlocks(nestedMessages(), A_BG_BASH, nestedBuckets())
      expect(bg.taskBlock?.toolInput?.run_in_background).toBe(true)
      expect(bg.resultBlock?.toolResult).toContain('Command running in background')
    })

    it('prefers the main transcript, where it reports no owner', () => {
      const r = findTaskBlocks(nestedMessages(), A, nestedBuckets())
      expect(r.taskBlock?.toolUseId).toBe(A)
      expect(r.ownerToolUseId).toBeNull()
    })

    it('does not search buckets it is not given', () => {
      expect(findTaskBlocks(nestedMessages(), B).taskBlock).toBeNull()
    })
  })
})
