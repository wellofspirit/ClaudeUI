/**
 * Unit tests for mapCodexEvent.ts
 *
 * Feed canned notification shapes (matching verified wire frames from
 * codex 0.140.0) and assert the emitted session:* payloads.
 *
 * All functions are pure — no process required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeAssemblyState,
  mapAgentMessageDelta,
  mapReasoningTextDelta,
  mapReasoningSummaryTextDelta,
  mapCommandExecutionOutputDelta,
  mapItemStarted,
  mapItemCompleted,
  mapTokenUsageUpdated,
  mapTurnCompleted,
  mapErrorNotification,
  type CodexAssemblyState,
} from '../mapCodexEvent'

// ---------------------------------------------------------------------------
// Fixtures matching wire frames from codex 0.140.0 probe
// ---------------------------------------------------------------------------

const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-xyz'
const ITEM_ID = 'item-001'

function makeTokenUsageParams(last: Partial<{
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
}> = {}) {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: {
      last: {
        totalTokens: last.totalTokens ?? 100,
        inputTokens: last.inputTokens ?? 60,
        outputTokens: last.outputTokens ?? 30,
        cachedInputTokens: last.cachedInputTokens ?? 10,
        reasoningOutputTokens: last.reasoningOutputTokens ?? 0,
      },
      total: {
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 30,
        cachedInputTokens: 10,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 128000,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapAgentMessageDelta', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a text stream event with the delta', () => {
    const result = mapAgentMessageDelta(
      { delta: 'Hello', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.stream).toEqual({ type: 'text', text: 'Hello' })
    expect(result.message).toBeUndefined()
  })

  it('accumulates text in assemblyState.itemText', () => {
    mapAgentMessageDelta({ delta: 'Hello', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID }, state)
    mapAgentMessageDelta({ delta: ' world', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID }, state)
    expect(state.itemText.get(ITEM_ID)).toBe('Hello world')
  })

  it('accumulates separately per itemId', () => {
    mapAgentMessageDelta({ delta: 'A', itemId: 'item-1', threadId: THREAD_ID, turnId: TURN_ID }, state)
    mapAgentMessageDelta({ delta: 'B', itemId: 'item-2', threadId: THREAD_ID, turnId: TURN_ID }, state)
    expect(state.itemText.get('item-1')).toBe('A')
    expect(state.itemText.get('item-2')).toBe('B')
  })
})

describe('mapReasoningTextDelta', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a thinking stream event', () => {
    const result = mapReasoningTextDelta(
      { delta: 'reasoning chunk', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID, contentIndex: 0 },
      state
    )
    expect(result.stream).toEqual({ type: 'thinking', text: 'reasoning chunk' })
  })
})

describe('mapReasoningSummaryTextDelta', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a thinking stream event', () => {
    const result = mapReasoningSummaryTextDelta(
      { delta: 'summary chunk', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID, summaryIndex: 0 },
      state
    )
    expect(result.stream).toEqual({ type: 'thinking', text: 'summary chunk' })
  })
})

describe('mapCommandExecutionOutputDelta', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits nothing (does not stream command output into the prose bubble)', () => {
    const result = mapCommandExecutionOutputDelta(
      { delta: 'stdout line\n', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.stream).toBeUndefined()
    expect(result.message).toBeUndefined()
    expect(result.toolResult).toBeUndefined()
  })

  it('buffers the delta into commandOutput keyed by itemId', () => {
    mapCommandExecutionOutputDelta({ delta: 'line1\n', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID }, state)
    mapCommandExecutionOutputDelta({ delta: 'line2\n', itemId: ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID }, state)
    expect(state.commandOutput.get(ITEM_ID)).toBe('line1\nline2\n')
  })

  it('buffers separately per itemId', () => {
    mapCommandExecutionOutputDelta({ delta: 'A', itemId: 'item-1', threadId: THREAD_ID, turnId: TURN_ID }, state)
    mapCommandExecutionOutputDelta({ delta: 'B', itemId: 'item-2', threadId: THREAD_ID, turnId: TURN_ID }, state)
    expect(state.commandOutput.get('item-1')).toBe('A')
    expect(state.commandOutput.get('item-2')).toBe('B')
  })
})

describe('mapItemStarted', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('suppresses userMessage items', () => {
    const result = mapItemStarted(
      { item: { id: ITEM_ID, type: 'userMessage', content: [] } as never, startedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.message).toBeUndefined()
    expect(result.stream).toBeUndefined()
  })

  it('suppresses agentMessage items (streamed incrementally)', () => {
    const result = mapItemStarted(
      { item: { id: ITEM_ID, type: 'agentMessage', text: '' } as never, startedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.message).toBeUndefined()
  })

  it('suppresses reasoning items', () => {
    const result = mapItemStarted(
      { item: { id: ITEM_ID, type: 'reasoning' } as never, startedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.message).toBeUndefined()
  })

  it('emits a tool_use ChatMessage for commandExecution', () => {
    const result = mapItemStarted(
      {
        item: { id: ITEM_ID, type: 'commandExecution', command: 'ls -la', status: 'inProgress' } as never,
        startedAtMs: 0,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      state
    )
    expect(result.message).toBeDefined()
    expect(result.message?.id).toBe(ITEM_ID)
    expect(result.message?.role).toBe('assistant')
    expect(result.message?.content[0].type).toBe('tool_use')
    const block = result.message?.content[0]
    if (block?.type === 'tool_use') {
      expect(block.toolName).toBe('Shell')
      expect(block.toolUseId).toBe(ITEM_ID)
      expect(block.toolInput).toMatchObject({ command: 'ls -la' })
    }
  })

  it('uses Shell for commandExecution — not Bash', () => {
    const result = mapItemStarted(
      { item: { id: ITEM_ID, type: 'commandExecution', command: 'echo hi' } as never, startedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    const block = result.message?.content[0]
    if (block?.type === 'tool_use') {
      expect(block.toolName).not.toBe('Bash')
      expect(block.toolName).not.toBe('Agent')
      expect(block.toolName).not.toBe('Task')
    }
  })

  it('emits ApplyPatch tool_use for fileChange', () => {
    const result = mapItemStarted(
      { item: { id: ITEM_ID, type: 'fileChange', path: '/src/foo.ts', status: 'inProgress' } as never, startedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    const block = result.message?.content[0]
    if (block?.type === 'tool_use') {
      expect(block.toolName).toBe('ApplyPatch')
    }
  })

  it('uses compound server·tool name for mcpToolCall', () => {
    const result = mapItemStarted(
      {
        item: { id: ITEM_ID, type: 'mcpToolCall', server: 'my-server', tool: 'my-tool', status: 'inProgress' } as never,
        startedAtMs: 0,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      state
    )
    const block = result.message?.content[0]
    if (block?.type === 'tool_use') {
      expect(block.toolName).toBe('my-server·my-tool')
    }
  })
})

describe('mapItemCompleted', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('suppresses userMessage items', () => {
    const result = mapItemCompleted(
      { item: { id: ITEM_ID, type: 'userMessage', content: [] } as never, completedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.message).toBeUndefined()
    expect(result.toolResult).toBeUndefined()
  })

  it('emits final ChatMessage for agentMessage using accumulated text', () => {
    state.itemText.set(ITEM_ID, 'Hello world')
    const result = mapItemCompleted(
      { item: { id: ITEM_ID, type: 'agentMessage', text: 'fallback' } as never, completedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.message).toBeDefined()
    expect(result.message?.id).toBe(ITEM_ID)
    expect(result.message?.content[0].type).toBe('text')
    if (result.message?.content[0].type === 'text') {
      expect(result.message.content[0].text).toBe('Hello world')
    }
    // State should be cleared
    expect(state.itemText.has(ITEM_ID)).toBe(false)
  })

  it('falls back to item.text for agentMessage when no accumulation', () => {
    const result = mapItemCompleted(
      { item: { id: ITEM_ID, type: 'agentMessage', text: 'Direct text' } as never, completedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    if (result.message?.content[0].type === 'text') {
      expect(result.message.content[0].text).toBe('Direct text')
    }
  })

  it('emits tool-result for commandExecution', () => {
    const result = mapItemCompleted(
      {
        item: { id: ITEM_ID, type: 'commandExecution', command: 'ls', aggregatedOutput: 'file.ts\n', status: 'completed' } as never,
        completedAtMs: 0,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      state
    )
    expect(result.toolResult).toBeDefined()
    expect(result.toolResult?.toolUseId).toBe(ITEM_ID)
    expect(result.toolResult?.result).toBe('file.ts\n')
    expect(result.toolResult?.isError).toBe(false)
  })

  it('sets isError=true for failed commandExecution', () => {
    const result = mapItemCompleted(
      { item: { id: ITEM_ID, type: 'commandExecution', command: 'bad', status: 'failed' } as never, completedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.toolResult?.isError).toBe(true)
  })

  it('emits tool-result for fileChange', () => {
    const result = mapItemCompleted(
      {
        item: { id: ITEM_ID, type: 'fileChange', changes: [{ type: 'update', unified_diff: '...' }], status: 'completed' } as never,
        completedAtMs: 0,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      state
    )
    expect(result.toolResult?.toolUseId).toBe(ITEM_ID)
    expect(result.toolResult?.isError).toBe(false)
  })

  it('falls back to buffered command output when no aggregatedOutput', () => {
    // Simulate streamed output deltas accumulated before completion
    state.commandOutput.set(ITEM_ID, 'buffered stdout\n')
    const result = mapItemCompleted(
      { item: { id: ITEM_ID, type: 'commandExecution', command: 'ls', status: 'completed' } as never, completedAtMs: 0, threadId: THREAD_ID, turnId: TURN_ID },
      state
    )
    expect(result.toolResult?.result).toBe('buffered stdout\n')
    expect(result.toolResult?.isError).toBe(false)
    // Buffer must be released after completion
    expect(state.commandOutput.has(ITEM_ID)).toBe(false)
  })

  it('prefers aggregatedOutput over buffered output', () => {
    state.commandOutput.set(ITEM_ID, 'buffered\n')
    const result = mapItemCompleted(
      {
        item: { id: ITEM_ID, type: 'commandExecution', command: 'ls', aggregatedOutput: 'authoritative\n', status: 'completed' } as never,
        completedAtMs: 0,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      state
    )
    expect(result.toolResult?.result).toBe('authoritative\n')
    // Buffer still released
    expect(state.commandOutput.has(ITEM_ID)).toBe(false)
  })
})

describe('mapTokenUsageUpdated', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a StatusLineData with token counts', () => {
    const result = mapTokenUsageUpdated(makeTokenUsageParams({ inputTokens: 60, outputTokens: 30, cachedInputTokens: 10 }), state)
    expect(result.statusLine).toBeDefined()
    expect(result.statusLine?.totalInputTokens).toBe(60)
    expect(result.statusLine?.totalOutputTokens).toBe(30)
    expect(result.statusLine?.cachedTokens).toBe(10)
    expect(result.statusLine?.totalCostUsd).toBe(0) // Codex has no USD cost
  })

  it('computes usedPercentage from context window', () => {
    const result = mapTokenUsageUpdated(makeTokenUsageParams({ totalTokens: 12800 }), state)
    // totalTokens in state is from total.totalTokens = 100 (fixture default)
    const usedPct = result.statusLine?.usedPercentage
    expect(typeof usedPct).toBe('number')
    expect(usedPct).toBeCloseTo((100 / 128000) * 100, 0)
  })

  it('sets usedPercentage=null when no context window', () => {
    const params = makeTokenUsageParams()
    // Remove modelContextWindow
    ;(params.tokenUsage as Record<string, unknown>).modelContextWindow = undefined
    const result = mapTokenUsageUpdated(params as never, state)
    expect(result.statusLine?.usedPercentage).toBeNull()
  })

  it('accumulates tokens across multiple calls', () => {
    mapTokenUsageUpdated(makeTokenUsageParams({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }), state)
    mapTokenUsageUpdated(makeTokenUsageParams({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 2 }), state)
    expect(state.totalInputTokens).toBe(30)
    expect(state.totalOutputTokens).toBe(15)
    expect(state.cachedInputTokens).toBe(2)
  })
})

describe('mapTurnCompleted', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a SessionResult for a completed turn', () => {
    const result = mapTurnCompleted(
      {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'completed', items: [] } as never,
      },
      state
    )
    expect(result.result).toBeDefined()
    expect(result.result?.totalCostUsd).toBe(0)
    expect(typeof result.result?.durationMs).toBe('number')
    expect(result.result?.result).toBe('completed')
    expect(result.alertKind).toBeUndefined()
  })

  it('emits a SessionResult for an interrupted turn', () => {
    const result = mapTurnCompleted(
      { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'interrupted', items: [] } as never },
      state
    )
    expect(result.result?.result).toBe('interrupted')
  })

  it('emits error alert for a failed turn with error message', () => {
    const result = mapTurnCompleted(
      {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'failed', error: { message: 'Context limit exceeded' }, items: [] } as never,
      },
      state
    )
    expect(result.result).toBeDefined()
    expect(result.alertKind).toBe('error')
    expect(result.alertText).toBe('Context limit exceeded')
  })
})

describe('mapErrorNotification', () => {
  let state: CodexAssemblyState

  beforeEach(() => {
    state = makeAssemblyState()
  })

  it('emits a warning alert when willRetry=true', () => {
    const result = mapErrorNotification(
      {
        error: { message: 'Rate limit hit, retrying', codexErrorInfo: null },
        threadId: THREAD_ID,
        turnId: TURN_ID,
        willRetry: true,
      },
      state
    )
    expect(result.alertKind).toBe('warning')
    expect(result.alertText).toContain('Rate limit')
  })

  it('emits an error alert when willRetry=false', () => {
    const result = mapErrorNotification(
      {
        error: { message: 'Fatal error', codexErrorInfo: null },
        threadId: THREAD_ID,
        turnId: TURN_ID,
        willRetry: false,
      },
      state
    )
    expect(result.alertKind).toBe('error')
    expect(result.alertText).toBe('Fatal error')
  })
})
