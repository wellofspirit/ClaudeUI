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

  it('agent_end (distinct from agent_settled, the real turn-complete signal) also maps to ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent({ type: 'agent_end', messages: [], willRetry: false }, state)
    expect(out).toEqual([{ kind: 'ignore' }])
  })
})

describe('mapPiEvent — agent_settled durationMs guard', () => {
  it('startTimeMs > 0: reports the elapsed wall-clock span', () => {
    const state = createPiMapperState()
    state.startTimeMs = Date.now() - 1000
    const out = mapPiEvent({ type: 'agent_settled' }, state)
    expect(out[0].kind).toBe('result')
    if (out[0].kind === 'result') {
      expect(out[0].durationMs).toBeGreaterThanOrEqual(1000)
    }
  })

  it('startTimeMs === 0 (never set by the caller): reports 0, not Date.now() - 0', () => {
    const state = createPiMapperState()
    expect(state.startTimeMs).toBe(0)
    const out = mapPiEvent({ type: 'agent_settled' }, state)
    expect(out[0].kind).toBe('result')
    if (out[0].kind === 'result') {
      expect(out[0].durationMs).toBe(0)
    }
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

describe('mapPiEvent — tool_execution_update (M2b live bash output streaming)', () => {
  it('bash: maps to bash_output carrying the ACCUMULATED text (joined across content blocks)', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'ls -la' },
        partialResult: {
          content: [
            { type: 'text', text: 'partial output so far' },
            { type: 'text', text: '...' }
          ],
          details: { truncation: null, fullOutputPath: null }
        }
      },
      state
    )
    expect(out).toEqual([{ kind: 'bash_output', toolUseId: 'call_1', output: 'partial output so far...' }])
  })

  it('bash with no text content blocks (e.g. only an image): maps to bash_output with an empty string, not ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'call_2',
        toolName: 'bash',
        args: {},
        partialResult: { content: [] }
      },
      state
    )
    expect(out).toEqual([{ kind: 'bash_output', toolUseId: 'call_2', output: '' }])
  })

  it('non-bash tool (e.g. edit): ignored — live streaming is bash-only in M2b', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'call_3',
        toolName: 'edit',
        args: { path: 'a.ts' },
        partialResult: { content: [{ type: 'text', text: 'diff so far' }] }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })
})

describe('mapPiEvent — tool_execution_update (M5b in-pi subagents: cuiSubagent mapping)', () => {
  function validCuiSubagent(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      agents: [
        {
          agent: 'echoer',
          model: 'anthropic/claude-haiku-4-5',
          status: 'running',
          newMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 }
        }
      ],
      ...overrides
    }
  }

  it('a well-formed v1 payload maps to subagent_update, keyed by the OUTER toolCallId', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_1',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [{ type: 'text', text: '[echoer] running' }], details: { cuiSubagent: validCuiSubagent() } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'subagent_update', toolUseId: 'outer_call_1', payload: validCuiSubagent() }])
  })

  it('missing details entirely -> ignore (never crashes)', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_2',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [] }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('details present but no cuiSubagent key -> ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_3',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { truncation: null } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('wrong v (not 1) -> ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_4',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: validCuiSubagent({ v: 2 }) } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('agents is not an array -> ignore', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_5',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: { v: 1, agents: 'not-an-array' } } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('an agent entry with an invalid status -> ignore (whole payload rejected)', () => {
    const state = createPiMapperState()
    const malformed = validCuiSubagent()
    ;(malformed.agents[0] as unknown as Record<string, unknown>).status = 'bogus'
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_6',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: malformed } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('an agent entry missing newMessages (not an array) -> ignore', () => {
    const state = createPiMapperState()
    const malformed = validCuiSubagent()
    delete (malformed.agents[0] as unknown as Record<string, unknown>).newMessages
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_7',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: malformed } }
      },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
  })

  it('usage is optional per agent — a missing/malformed usage still yields a valid payload with usage undefined', () => {
    const state = createPiMapperState()
    const payload = validCuiSubagent()
    delete (payload.agents[0] as unknown as Record<string, unknown>).usage
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'outer_call_8',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: payload } }
      },
      state
    )
    expect(out).toEqual([
      {
        kind: 'subagent_update',
        toolUseId: 'outer_call_8',
        payload: { v: 1, agents: [{ agent: 'echoer', model: 'anthropic/claude-haiku-4-5', status: 'running', newMessages: payload.agents[0].newMessages, usage: undefined }] }
      }
    ])
  })

  it('non-subagent toolName (bash) is UNCHANGED by this addition — still maps to bash_output', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCallId: 'call_bash',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'hi' }] }
      },
      state
    )
    expect(out).toEqual([{ kind: 'bash_output', toolUseId: 'call_bash', output: 'hi' }])
  })
})

describe('mapPiEvent — message_end (toolResult, subagent): final result cuiSubagent mapping (M5b)', () => {
  it('a subagent toolResult carrying a valid cuiSubagent in details emits BOTH tool_result AND subagent_update', () => {
    const state = createPiMapperState()
    const payload = {
      v: 1,
      agents: [{ agent: 'echoer', status: 'done', newMessages: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 } }]
    }
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'outer_call_9',
          toolName: 'subagent',
          content: [{ type: 'text', text: 'done' }],
          details: { cuiSubagent: payload }
        })
      },
      state
    )
    expect(out).toEqual([
      { kind: 'tool_result', toolUseId: 'outer_call_9', result: 'done', isError: false },
      { kind: 'subagent_update', toolUseId: 'outer_call_9', payload }
    ])
  })

  it('a subagent toolResult with NO details (or malformed cuiSubagent) emits ONLY tool_result — no crash', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({ toolCallId: 'outer_call_10', toolName: 'subagent', content: [{ type: 'text', text: 'done' }] })
      },
      state
    )
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'outer_call_10', result: 'done', isError: false }])
  })

  it('a non-subagent toolResult (e.g. bash) is UNCHANGED — never checks for cuiSubagent', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({ toolCallId: 'call_bash', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] })
      },
      state
    )
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_bash', result: 'ok', isError: false }])
  })
})

describe('mapPiEvent — message_end (toolResult, edit/write): rich diff fileDiffs (M2)', () => {
  const UNIFIED_DIFF = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1,2 +1,2 @@', '-old line', '+new line', '+another new line'].join(
    '\n'
  )

  function editToolCall(id: string, path: string, edits: Array<{ oldText: string; newText: string }>) {
    return { type: 'toolCall' as const, id, name: 'edit', arguments: { path, edits } }
  }

  it('single-edit call: the assistant tool_use path is threaded through to the toolResult as fileDiffs', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [editToolCall('call_1', '/src/foo.ts', [{ oldText: 'old line', newText: 'new line' }])],
          stopReason: 'toolUse'
        })
      },
      state
    )

    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_1',
          toolName: 'edit',
          content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in /src/foo.ts.' }],
          details: { diff: 'ignored ascii view', patch: UNIFIED_DIFF, firstChangedLine: 1 }
        })
      },
      state
    )

    expect(out).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'call_1',
        result: 'Successfully replaced 1 block(s) in /src/foo.ts.',
        isError: false,
        fileDiffs: [{ path: '/src/foo.ts', patch: UNIFIED_DIFF, changeType: 'update', additions: 2, deletions: 1 }]
      }
    ])
  })

  it('multi-edit call: still ONE FileDiff from the ready-made patch — the whole point of M2', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [
            editToolCall('call_multi', '/src/bar.ts', [
              { oldText: 'a', newText: 'b' },
              { oldText: 'c', newText: 'd' }
            ])
          ],
          stopReason: 'toolUse'
        })
      },
      state
    )

    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_multi',
          toolName: 'edit',
          content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in /src/bar.ts.' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF, firstChangedLine: 1 }
        })
      },
      state
    )

    expect(out[0].kind).toBe('tool_result')
    if (out[0].kind === 'tool_result') {
      expect(out[0].fileDiffs).toEqual([{ path: '/src/bar.ts', patch: UNIFIED_DIFF, changeType: 'update', additions: 2, deletions: 1 }])
    }
  })

  it('captured also via the toolcall_end interim upsert (not just the final message_end assistant branch)', () => {
    const state = createPiMapperState()
    mapPiEvent({ type: 'message_start', message: assistantMsg() }, state)
    mapPiEvent(
      {
        type: 'message_update',
        message: assistantMsg({
          content: [editToolCall('call_interim', '/src/interim.ts', [{ oldText: 'x', newText: 'y' }])]
        }),
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: editToolCall('call_interim', '/src/interim.ts', [{ oldText: 'x', newText: 'y' }])
        }
      },
      state
    )

    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_interim',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF }
        })
      },
      state
    )

    expect(out[0].kind).toBe('tool_result')
    if (out[0].kind === 'tool_result') {
      expect(out[0].fileDiffs).toEqual([{ path: '/src/interim.ts', patch: UNIFIED_DIFF, changeType: 'update', additions: 2, deletions: 1 }])
    }
  })

  it('no recorded path (no preceding tool_use capture) → no fileDiffs — never fabricates', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_orphan',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF }
        })
      },
      state
    )
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_orphan', result: 'ok', isError: false }])
  })

  it('recorded path but no details on the toolResult → no fileDiffs', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [editToolCall('call_nodetails', '/src/nodetails.ts', [{ oldText: 'x', newText: 'y' }])],
          stopReason: 'toolUse'
        })
      },
      state
    )
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({ toolCallId: 'call_nodetails', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] })
      },
      state
    )
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_nodetails', result: 'ok', isError: false }])
  })

  it('recorded path but details.patch is empty/absent → no fileDiffs', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [editToolCall('call_emptypatch', '/src/e.ts', [{ oldText: 'x', newText: 'y' }])],
          stopReason: 'toolUse'
        })
      },
      state
    )
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_emptypatch',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: 'ignored', patch: '' }
        })
      },
      state
    )
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_emptypatch', result: 'ok', isError: false }])
  })

  it('the path entry is consumed: a second toolResult for the same toolCallId gets no fileDiffs', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [editToolCall('call_once', '/src/once.ts', [{ oldText: 'x', newText: 'y' }])],
          stopReason: 'toolUse'
        })
      },
      state
    )
    const first = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_once',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF }
        })
      },
      state
    )
    expect(first[0].kind).toBe('tool_result')
    if (first[0].kind === 'tool_result') expect(first[0].fileDiffs).toBeDefined()

    const second = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_once',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok again' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF }
        })
      },
      state
    )
    expect(second).toEqual([{ kind: 'tool_result', toolUseId: 'call_once', result: 'ok again', isError: false }])
  })

  it('write tool_use path is recorded, but write never produces fileDiffs (pi\'s write.execute() always returns details: undefined)', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [{ type: 'toolCall', id: 'call_write', name: 'write', arguments: { path: '/src/new.ts', content: 'hi' } }],
          stopReason: 'toolUse'
        })
      },
      state
    )
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_write',
          toolName: 'write',
          content: [{ type: 'text', text: 'Successfully wrote 2 bytes to /src/new.ts' }]
          // details omitted — matches write.execute()'s real `details: undefined`.
        })
      },
      state
    )
    expect(out).toEqual([
      { kind: 'tool_result', toolUseId: 'call_write', result: 'Successfully wrote 2 bytes to /src/new.ts', isError: false }
    ])
  })

  it('a non-edit/non-write tool_use (e.g. bash) never records a path, even if it happens to have one in its args', () => {
    const state = createPiMapperState()
    mapPiEvent(
      {
        type: 'message_end',
        message: assistantMsg({
          content: [{ type: 'toolCall', id: 'call_bash_path', name: 'bash', arguments: { command: 'ls', path: '/decoy.ts' } }],
          stopReason: 'toolUse'
        })
      },
      state
    )
    const out = mapPiEvent(
      {
        type: 'message_end',
        message: toolResultMsg({
          toolCallId: 'call_bash_path',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: 'ignored', patch: UNIFIED_DIFF }
        })
      },
      state
    )
    // bash is never recorded as an edit/write path, so even a details.patch present
    // here (defensive/unrealistic for bash) must not fabricate fileDiffs.
    expect(out).toEqual([{ kind: 'tool_result', toolUseId: 'call_bash_path', result: 'ok', isError: false }])
  })
})

describe('mapPiEvent — tool_execution_end (untouched — final result comes via toolResult message_end)', () => {
  it('still maps to ignore regardless of toolName', () => {
    const state = createPiMapperState()
    const out = mapPiEvent(
      { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: {}, isError: false },
      state
    )
    expect(out).toEqual([{ kind: 'ignore' }])
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
