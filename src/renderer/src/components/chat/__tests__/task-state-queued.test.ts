import { describe, it, expect } from 'vitest'
import type { ContentBlock, TaskNotification } from '../../../../../shared/types'
import {
  deriveTaskState,
  hasDispatchBehindCall,
  isBehindUnfinishedCall,
  isDispatchToolName,
  isQueuedDispatchCall
} from '../task-state'

const DISPATCH = 'mcp__claude-ui-collab__dispatch_agent'
const use = (toolUseId: string, toolName = DISPATCH): ContentBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName,
  toolInput: {}
})
const result = (toolUseId: string): ContentBlock => ({
  type: 'tool_result',
  toolUseId,
  toolResult: 'ok',
  isError: false
})
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

describe('isBehindUnfinishedCall — a call that has not started (L2)', () => {
  it('a call behind an earlier call with no result is queued', () => {
    expect(isBehindUnfinishedCall([use('a'), use('b')], 'b')).toBe(true)
  })

  it('the first call of a message is never queued, whatever follows it', () => {
    expect(isBehindUnfinishedCall([use('a'), use('b')], 'a')).toBe(false)
  })

  it('a single call is not queued', () => {
    expect(isBehindUnfinishedCall([text('go'), use('a')], 'a')).toBe(false)
  })

  it('stops being queued once every earlier call has answered, in any order of the blocks', () => {
    expect(isBehindUnfinishedCall([use('a'), use('b'), result('a')], 'b')).toBe(false)
    expect(isBehindUnfinishedCall([use('a'), result('a'), use('b')], 'b')).toBe(false)
  })

  it('stays queued while ANY earlier call is unanswered (three in a row)', () => {
    const content = [use('a'), use('b'), use('c'), result('a')]
    expect(isBehindUnfinishedCall(content, 'c')).toBe(true) // b has not answered
    expect(isBehindUnfinishedCall([...content, result('b')], 'c')).toBe(false)
  })

  it('counts an earlier call of any tool (a blocking Agent, a Read), not only dispatches', () => {
    expect(isBehindUnfinishedCall([use('r', 'Read'), use('d')], 'd')).toBe(true)
    expect(isBehindUnfinishedCall([use('g', 'Agent'), text('x'), use('d')], 'd')).toBe(true)
  })

  it('is false for an id the message does not hold', () => {
    expect(isBehindUnfinishedCall([use('a')], 'nope')).toBe(false)
  })
})

// MessageBubble subscribes to the turn's state only for a message this admits: it must
// admit every message `isQueuedDispatchCall` can say yes to.
describe('hasDispatchBehindCall — the only shape that can read queued', () => {
  it('is true for a dispatch after another tool call, false for the rest', () => {
    expect(hasDispatchBehindCall([use('r', 'Read'), use('d')])).toBe(true)
    expect(hasDispatchBehindCall([use('a'), text('x'), use('b')])).toBe(true)
    expect(hasDispatchBehindCall([use('d'), use('r', 'Read')])).toBe(false)
    expect(hasDispatchBehindCall([text('go'), use('d')])).toBe(false)
    expect(hasDispatchBehindCall([use('r', 'Read'), use('w', 'Write')])).toBe(false)
    expect(hasDispatchBehindCall([])).toBe(false)
  })

  it('admits every content for which a call reads queued', () => {
    const shapes = [
      [use('a'), use('b')],
      [use('r', 'Read'), use('d'), use('e')],
      [use('r', 'Read'), use('d'), result('r')],
      [text('x'), use('d')],
      [use('d')]
    ]
    for (const content of shapes) {
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const queued = isQueuedDispatchCall({
          engineId: 'claude',
          turnRunning: true,
          content,
          block
        })
        if (queued) expect(hasDispatchBehindCall(content)).toBe(true)
      }
    }
  })
})

describe('deriveTaskState — queued (L2)', () => {
  const base = { isHistorical: false, hasActiveTask: false, isBackground: false, hasResult: false }

  it('a queued call is not running, and says so', () => {
    expect(deriveTaskState({ ...base, queued: true })).toMatchObject({
      isQueued: true,
      isRunning: false
    })
  })

  it('the same call, not queued, is running as before (a single call is unchanged)', () => {
    expect(deriveTaskState(base)).toMatchObject({ isQueued: false, isRunning: true })
    expect(deriveTaskState({ ...base, isBackground: true })).toMatchObject({
      isQueued: false,
      isRunning: true
    })
  })

  it('a lifecycle record, a result, a notification or a replayed transcript settles the heuristic', () => {
    const notification: TaskNotification = {
      taskId: 't',
      toolUseId: 'u',
      status: 'stopped',
      outputFile: '',
      summary: ''
    }
    expect(deriveTaskState({ ...base, queued: true, hasActiveTask: true })).toMatchObject({
      isQueued: false,
      isRunning: true
    })
    expect(deriveTaskState({ ...base, queued: true, hasResult: true })).toMatchObject({
      isQueued: false,
      isRunning: false
    })
    expect(deriveTaskState({ ...base, queued: true, notification })).toMatchObject({
      isQueued: false,
      isStopped: true
    })
    expect(deriveTaskState({ ...base, queued: true, isHistorical: true })).toMatchObject({
      isQueued: false,
      isRunning: false
    })
  })
})

describe('isDispatchToolName', () => {
  it('knows the name each engine gives the dispatch tool, and nothing else', () => {
    expect(isDispatchToolName('mcp__claude-ui-collab__dispatch_agent')).toBe(true)
    expect(isDispatchToolName('claudeui_dispatch_agent')).toBe(true)
    expect(isDispatchToolName('dispatch_agent')).toBe(true)
    expect(isDispatchToolName('Agent')).toBe(false)
    expect(isDispatchToolName('mcp__claude-ui-collab__message_agent')).toBe(false)
  })
})

describe('isQueuedDispatchCall — the one rule every surface uses (L2)', () => {
  const content = [use('a'), use('b')]
  const ask = (over: Partial<Parameters<typeof isQueuedDispatchCall>[0]> = {}): boolean =>
    isQueuedDispatchCall({
      engineId: 'claude',
      turnRunning: true,
      content,
      block: { toolUseId: 'b', toolName: DISPATCH },
      ...over
    })

  it('a Claude dispatch behind an unanswered call, in a running turn, is queued', () => {
    expect(ask()).toBe(true)
  })

  it('not once the turn is over: a queue can only be held inside a live turn', () => {
    expect(ask({ turnRunning: false })).toBe(false)
  })

  it('not on another engine, not for another tool, not for the first call', () => {
    expect(ask({ engineId: 'pi' })).toBe(false)
    expect(ask({ block: { toolUseId: 'b', toolName: 'Agent' } })).toBe(false)
    expect(ask({ block: { toolUseId: 'a', toolName: DISPATCH } })).toBe(false)
  })
})
