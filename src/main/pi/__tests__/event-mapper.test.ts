/**
 * Fixture-driven tests for mapPiEvent — the pure pi RPC event → MapperOutput[] mapper.
 */
import { describe, it, expect } from 'vitest'
import { mapPiEvent, createPiMapperState, buildPiChatMessage } from '../event-mapper'
import type { PiMapperState } from '../event-mapper'
import type { PiAssistantMessage, PiEvent, PiToolResultMessage, PiUserMessage } from '../pi-protocol'

function assistantMsg(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 }
    },
    stopReason: 'stop',
    timestamp: 1000,
    ...overrides
  }
}

function userMsg(overrides: Partial<PiUserMessage> = {}): PiUserMessage {
  return { role: 'user', content: 'hello', timestamp: 1000, ...overrides }
}

function toolResultMsg(overrides: Partial<PiToolResultMessage> = {}): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 1000,
    ...overrides
  }
}

describe('mapPiEvent — message_start', () => {
  it('assistant role: mints a messageId in state, emits ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    expect(out).toEqual([{ kind: 'ignore' }])
    expect(state.currentMessageId).toBeTruthy()
  })

  it('user role: ignored, no state mutation', () => {
    const state = createPiMapperState()
    const out = mapPiEvent({ type: 'message_start', message: userMsg() }, state)
    expect(out).toEqual([{ kind: 'ignore' }])
    expect(state.currentMessageId).toBeNull()
  })
})

describe('mapPiEvent — full happy turn', () => {
  it('start → text deltas → toolcall_end interim upsert → message_end w/ usage → toolResult → agent_settled', () => {
    const state = createPiMapperState()
    state.sessionId = 'sess-1'

    // 1. message_start
    let out = mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    expect(out).toEqual([{ kind: 'ignore' }])
    const messageId = state.currentMessageId!
    expect(messageId).toBeTruthy()

    // 2. text deltas
    out = mapPiEvent(
      {
        type: 'message_update',
        message: assistantMsg({ content: [{ type: 'text', text: 'Hel' }] }),
        assistantMessageEvent: { type: 'text_delta', delta: 'Hel' }
      },
      state
    )
    expect(out).toEqual([{ kind: 'stream', streamType: 'text', delta: 'Hel', messageId }])

    out = mapPiEvent(
      {
        type: 'message_update',
        message: assistantMsg({ content: [{ type: 'text', text: 'Hello' }] }),
        assistantMessageEvent: { type: 'text_delta', delta: 'lo' }
      },
      state
    )
    expect(out).toEqual([{ kind: 'stream', streamType: 'text', delta: 'lo', messageId }])

    // 3. toolcall_end — interim message upsert built from the partial message's content
    const partialWithToolCall = assistantMsg({
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }
      ]
    })
    out = mapPiEvent(
      {
        type: 'message_update',
        message: partialWithToolCall,
        assistantMessageEvent: { type: 'toolcall_end', toolCall: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } } }
      },
      state
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('message')
    if (out[0].kind === 'message') {
      expect(out[0].message.id).toBe(messageId)
      expect(out[0].message.content).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'ls' } }
      ])
    }

    // 4. message_end (assistant) — final message + usage, clears state.currentMessageId
    const finalAssistant = assistantMsg({
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }
      ],
      stopReason: 'toolUse'
    })
    out = mapPiEvent({ type: 'message_end', message: finalAssistant }, state)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      kind: 'message',
      message: {
        id: messageId,
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'ls' } }
        ],
        timestamp: expect.any(Number)
      }
    })
    expect(out[1]).toEqual({
      kind: 'usage',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.003,
      messageId
    })
    expect(state.currentMessageId).toBeNull()
    expect(state.totalCostUsd).toBeCloseTo(0.003)

    // 5. message_end (toolResult)
    out = mapPiEvent({ type: 'message_end', message: toolResultMsg() }, state)
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_1', result: 'ok', isError: false }])

    // 6. agent_settled — reports the accumulated cost + sessionId
    out = mapPiEvent({ type: 'agent_settled' }, state)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('result')
    if (out[0].kind === 'result') {
      expect(out[0].totalCostUsd).toBeCloseTo(0.003)
      expect(out[0].sessionId).toBe('sess-1')
      expect(out[0].durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('mapPiEvent — thinking deltas', () => {
  it('thinking_delta maps to a stream output with streamType thinking', () => {
    const state = createPiMapperState()
    mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    const messageId = state.currentMessageId!
    const out = mapPiEvent(
      {
        type: 'message_update',
        message: assistantMsg({ content: [{ type: 'thinking', thinking: 'pondering' }] }),
        assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' }
      },
      state
    )
    expect(out).toEqual([{ kind: 'stream', streamType: 'thinking', delta: 'pondering', messageId }])
  })
})

describe('mapPiEvent — abort', () => {
  it('stopReason aborted still emits the message (partial content is real) + a settled result follows', () => {
    const state = createPiMapperState()
    mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    const messageId = state.currentMessageId!

    const aborted = assistantMsg({
      content: [{ type: 'text', text: 'partial output' }],
      stopReason: 'aborted'
    })
    const out = mapPiEvent({ type: 'message_end', message: aborted }, state)
    expect(out[0]).toEqual({
      kind: 'message',
      message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'partial output' }], timestamp: expect.any(Number) }
    })
    expect(out[1].kind).toBe('usage')

    const settled = mapPiEvent({ type: 'agent_settled' }, state)
    expect(settled[0].kind).toBe('result')
  })
})

describe('mapPiEvent — compaction_end', () => {
  it('with a result: emits a compact_separator message using the summary\'s first line', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: {
          summary: 'First line summary.\nMore details on a second line.',
          firstKeptEntryId: 'abc',
          tokensBefore: 1000,
          estimatedTokensAfter: 200
        },
        aborted: false,
        willRetry: false
      },
      state
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('message')
    if (out[0].kind === 'message') {
      expect(out[0].message.role).toBe('system')
      expect(out[0].message.content).toEqual([
        { type: 'compact_separator', text: 'First line summary.' }
      ])
    }
  })

  it('aborted (result: null) → ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      { type: 'compaction_end', reason: 'manual', result: null, aborted: true, willRetry: false },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })
})

describe('mapPiEvent — usage extraction incl. reasoning tokens', () => {
  it('carries usage.reasoning through to tokens.reasoning when present', () => {
    const state = createPiMapperState()
    mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    const msg = assistantMsg({
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        reasoning: 15,
        totalTokens: 140,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 }
      }
    })
    const out = mapPiEvent({ type: 'message_end', message: msg }, state)
    const usageOutput = out.find((o) => o.kind === 'usage')
    expect(usageOutput).toBeDefined()
    if (usageOutput?.kind === 'usage') {
      expect(usageOutput.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 15 })
      expect(usageOutput.costUsd).toBeCloseTo(0.03)
    }
  })

  it('omits tokens.reasoning entirely when usage.reasoning is absent', () => {
    const state = createPiMapperState()
    mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    const out = mapPiEvent({ type: 'message_end', message: assistantMsg() }, state)
    const usageOutput = out.find((o) => o.kind === 'usage')
    if (usageOutput?.kind === 'usage') {
      expect(usageOutput.tokens.reasoning).toBeUndefined()
      expect('reasoning' in usageOutput.tokens).toBe(false)
    }
  })
})

describe('mapPiEvent — malformed/unknown event', () => {
  it('an unrecognised event type maps to ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent({ type: 'some_future_event', foo: 'bar' } as unknown as PiEvent, state)
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('known-but-unhandled-in-M1 event types (tool_execution_start, queue_update, agent_start) all map to ignore', () => {
    const state = createPiMapperState()
    expect(mapPiEvent({ type: 'agent_start' }, state)).toEqual([{ kind: 'ignore' }])
    expect(
      mapPiEvent({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: {} }, state)
    ).toEqual([{ kind: 'ignore' }])
    expect(mapPiEvent({ type: 'queue_update', steering: [], followUp: [] }, state)).toEqual([
      { kind: 'ignore' }
    ])
  })
})

describe('mapPiEvent — extension_error', () => {
  it('maps to an error output carrying the message', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      { type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' },
      state
    )
    expect(out).toEqual([{ kind: 'error', message: 'boom' }])
  })
})

describe('mapPiEvent — defensive fallback when message_start was missed', () => {
  it('message_update still gets a messageId (minted + stored) even without a prior message_start', () => {
    const state: PiMapperState = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'message_update',
        message: assistantMsg({ content: [{ type: 'text', text: 'x' }] }),
        assistantMessageEvent: { type: 'text_delta', delta: 'x' }
      },
      state
    )
    expect(state.currentMessageId).toBeTruthy()
    expect(out).toEqual([{ kind: 'stream', streamType: 'text', delta: 'x', messageId: state.currentMessageId }])
  })
})

describe('buildPiChatMessage', () => {
  it('maps text/thinking/toolCall blocks — thinking uses the `text` field (not `thinking`)', () => {
    const msg = buildPiChatMessage('m1', [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'considering' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/a.ts' } }
    ])
    expect(msg).toEqual({
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'thinking', text: 'considering' },
        { type: 'tool_use', toolUseId: 'c1', toolName: 'read', toolInput: { path: '/a.ts' } }
      ],
      timestamp: expect.any(Number)
    })
  })
})
