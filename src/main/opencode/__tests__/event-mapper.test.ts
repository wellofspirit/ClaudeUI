import { describe, it, expect, beforeEach } from 'vitest'
import {
  mapEvent,
  buildChatMessage,
  extractToolResult,
  type MessageAccumulator
} from '../event-mapper'
import type { OpencodeEvent } from '../protocol/types'

const SESSION_ID = 'ses_abc123'
const START_TIME = Date.now()

function makeEvent(type: string, properties: Record<string, unknown>): OpencodeEvent {
  return { id: 'evt_1', type, properties }
}

describe('mapEvent — cross-session filter', () => {
  it('ignores events from an UNKNOWN foreign session', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: 'ses_OTHER',
      messageID: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'hello'
    })
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    // No childSessions entry for 'ses_OTHER' — must be ignored.
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef, new Map())
    expect(out.kind).toBe('ignore')
  })

  it('passes events matching the session', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: SESSION_ID,
      messageID: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'hello'
    })
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef, new Map())
    expect(out.kind).toBe('stream')
  })

  it('passes events from a KNOWN child session (no longer ignored)', () => {
    // A child session that was registered via a task tool part must be routed,
    // not ignored. Its delta → subagent-stream, not stream.
    const CHILD_ID = 'ses_CHILD'
    const PARENT_CALL_ID = 'call_task_1'
    const childSessions = new Map([[CHILD_ID, PARENT_CALL_ID]])
    const ev = makeEvent('message.part.delta', {
      sessionID: CHILD_ID,
      messageID: 'child_msg_1',
      partID: 'cp1',
      field: 'text',
      delta: 'child text'
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('subagent-stream')
    if (out.kind === 'subagent-stream') {
      expect(out.toolUseId).toBe(PARENT_CALL_ID)
      expect(out.delta).toBe('child text')
    }
  })
})

describe('mapEvent — message.part.delta', () => {
  let accumulators: Map<string, MessageAccumulator>
  let totalCostRef: { value: number }

  beforeEach(() => {
    accumulators = new Map()
    totalCostRef = { value: 0 }
  })

  it('returns stream with text delta', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: SESSION_ID,
      messageID: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'hello world'
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('stream')
    if (out.kind === 'stream') {
      expect(out.streamType).toBe('text')
      expect(out.delta).toBe('hello world')
    }
  })

  it('returns stream with thinking type for reasoning field', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: SESSION_ID,
      messageID: 'msg_1',
      partID: 'p1',
      field: 'reasoning',
      delta: 'thinking...'
    })
    // No accumulator entry yet — defaults to 'text' because no snap exists
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('stream')
    if (out.kind === 'stream') {
      // Default to text since no accumulator snap with type=reasoning
      expect(out.streamType).toBe('text')
    }
  })

  it('ignores delta with unknown field', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: SESSION_ID,
      messageID: 'msg_1',
      partID: 'p1',
      field: 'unknown',
      delta: 'x'
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('ignore')
  })
})

describe('mapEvent — message.part.updated', () => {
  let accumulators: Map<string, MessageAccumulator>
  let totalCostRef: { value: number }

  beforeEach(() => {
    accumulators = new Map()
    totalCostRef = { value: 0 }
  })

  it('creates accumulator and returns message for text part', () => {
    const ev = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p1',
        messageID: 'msg_1',
        type: 'text',
        text: 'Hello!'
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('message')
    if (out.kind === 'message') {
      expect(out.message.id).toBe('msg_1')
      expect(out.message.role).toBe('assistant')
      expect(out.message.content).toHaveLength(1)
      expect(out.message.content[0].type).toBe('text')
      if (out.message.content[0].type === 'text') {
        expect(out.message.content[0].text).toBe('Hello!')
      }
    }
    expect(accumulators.has('msg_1')).toBe(true)
  })

  it('creates tool_use block for tool part', () => {
    const ev = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p_tool',
        messageID: 'msg_2',
        type: 'tool',
        tool: 'bash',
        callID: 'call_abc',
        state: { status: 'running', input: { command: 'ls' } }
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('message')
    if (out.kind === 'message') {
      const block = out.message.content[0]
      expect(block.type).toBe('tool_use')
      if (block.type === 'tool_use') {
        expect(block.toolName).toBe('bash')
        expect(block.toolUseId).toBe('call_abc')
      }
    }
  })

  it('appends parts in insertion order across multiple updates', () => {
    const ev1 = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: { id: 'p1', messageID: 'msg_3', type: 'text', text: 'First' }
    })
    const ev2 = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: { id: 'p2', messageID: 'msg_3', type: 'text', text: 'Second' }
    })
    mapEvent(ev1, SESSION_ID, accumulators, START_TIME, totalCostRef)
    const out2 = mapEvent(ev2, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out2.kind).toBe('message')
    if (out2.kind === 'message') {
      expect(out2.message.content).toHaveLength(2)
    }
  })
})

describe('mapEvent — permission.asked', () => {
  it('returns approval output', () => {
    const ev = makeEvent('permission.asked', {
      sessionID: SESSION_ID,
      id: 'perm_1',
      permission: 'bash',
      tool: { callID: 'call_1' },
      metadata: { command: 'rm -rf' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    expect(out.kind).toBe('approval')
    if (out.kind === 'approval') {
      expect(out.approval.requestId).toBe('perm_1')
      expect(out.approval.toolName).toBe('bash')
      expect(out.approval.toolUseId).toBe('call_1')
    }
  })

  it('attaches an "always allow" suggestion derived from the matched pattern', () => {
    const ev = makeEvent('permission.asked', {
      sessionID: SESSION_ID,
      id: 'perm_2',
      permission: 'bash',
      patterns: ['echo hi'],
      tool: { callID: 'call_2' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    if (out.kind === 'approval') {
      expect(out.approval.suggestions).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }]
        }
      ])
    } else {
      throw new Error('expected approval')
    }
  })

  it('omits suggestions for an unmappable permission category', () => {
    const ev = makeEvent('permission.asked', {
      sessionID: SESSION_ID,
      id: 'perm_3',
      permission: 'doom_loop',
      patterns: ['*'],
      tool: { callID: 'call_3' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    if (out.kind === 'approval') {
      expect(out.approval.suggestions).toBeUndefined()
    } else {
      throw new Error('expected approval')
    }
  })
})

describe('mapEvent — session.idle', () => {
  it('returns result output', () => {
    const ev = makeEvent('session.idle', { sessionID: SESSION_ID })
    const totalCostRef = { value: 1.23 }
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, totalCostRef)
    expect(out.kind).toBe('result')
    if (out.kind === 'result') {
      expect(out.result.sessionId).toBe(SESSION_ID)
      expect(out.result.totalCostUsd).toBe(1.23)
      expect(out.result.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('mapEvent — message.updated cost (S1: cumulative snapshot, not additive)', () => {
  it('sets the turn total from the per-message cumulative snapshot', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const ev = makeEvent('message.updated', {
      sessionID: SESSION_ID,
      info: { id: 'msg_1', role: 'assistant', cost: 0.5 }
    })
    const totalCostRef = { value: 0 }
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('cost_update')
    expect(totalCostRef.value).toBeCloseTo(0.5)
  })

  it('does NOT double-count when the same message re-emits a cumulative cost', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    // opencode re-emits message.updated for the same message multiple times with
    // a growing CUMULATIVE cost. The total must reflect the latest snapshot, not
    // the sum of every snapshot.
    mapEvent(
      makeEvent('message.updated', { sessionID: SESSION_ID, info: { id: 'msg_1', cost: 0.2 } }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    mapEvent(
      makeEvent('message.updated', { sessionID: SESSION_ID, info: { id: 'msg_1', cost: 0.5 } }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    expect(totalCostRef.value).toBeCloseTo(0.5) // NOT 0.7
  })

  it('sums distinct messages within a turn', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    mapEvent(
      makeEvent('message.updated', { sessionID: SESSION_ID, info: { id: 'msg_1', cost: 0.3 } }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    mapEvent(
      makeEvent('message.updated', { sessionID: SESSION_ID, info: { id: 'msg_2', cost: 0.4 } }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    expect(totalCostRef.value).toBeCloseTo(0.7)
  })

  it('records role even when cost is zero/absent (does not early-return before role)', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const out = mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: { id: 'msg_u', role: 'user', cost: 0 }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    expect(out.kind).toBe('ignore')
    expect(accumulators.get('msg_u')?.role).toBe('user')
  })
})

// ── message.updated info.tokens — cumulative-per-message (store, not sum) ──────
// These guard the Phase 7 metering recorder: opencode re-emits message.updated
// for the same message with a growing CUMULATIVE token snapshot, so the
// accumulator must STORE the latest (final) tokens, not sum across events.
describe('mapEvent — message.updated info.tokens (Phase 7 metering)', () => {
  it('stores info.tokens on the accumulator (final snapshot, replace not sum)', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    // Two updates for the SAME message id with growing cumulative tokens.
    mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: {
          id: 'msg_tok',
          role: 'assistant',
          cost: 0.1,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 4 } }
        }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: {
          id: 'msg_tok',
          role: 'assistant',
          cost: 0.2,
          tokens: { input: 100, output: 80, reasoning: 12, cache: { read: 10, write: 4 } }
        }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      totalCostRef
    )
    const acc = accumulators.get('msg_tok')
    // Latest snapshot wins — output 80, NOT 20+80=100
    expect(acc?.tokens?.input).toBe(100)
    expect(acc?.tokens?.output).toBe(80)
    expect(acc?.tokens?.reasoning).toBe(12)
    expect(acc?.tokens?.cache?.read).toBe(10)
    expect(acc?.tokens?.cache?.write).toBe(4)
  })

  it('carries tokens + messageId + engineCostUsd on the cost_update output', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const out = mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: {
          id: 'msg_co',
          role: 'assistant',
          cost: 0.33,
          tokens: { input: 7, output: 3, cache: { read: 1, write: 2 } }
        }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    expect(out.kind).toBe('cost_update')
    if (out.kind === 'cost_update') {
      expect(out.messageId).toBe('msg_co')
      expect(out.engineCostUsd).toBeCloseTo(0.33)
      expect(out.tokens?.input).toBe(7)
      expect(out.tokens?.output).toBe(3)
      expect(out.tokens?.cache?.write).toBe(2)
    }
  })

  it('tolerates missing/partial info.tokens (undefined fields, no cache)', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: { id: 'msg_partial', role: 'assistant', cost: 0.01, tokens: { input: 50 } }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    const acc = accumulators.get('msg_partial')
    expect(acc?.tokens?.input).toBe(50)
    expect(acc?.tokens?.output).toBeUndefined()
    expect(acc?.tokens?.cache).toBeUndefined()
  })
})

describe('mapEvent — R3: user-role part.updated is not rendered as assistant', () => {
  it('ignores a part.updated whose message role is user', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    // message.updated (role=user) arrives first, as opencode always orders it.
    mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: { id: 'msg_user', role: 'user' }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    const out = mapEvent(
      makeEvent('message.part.updated', {
        sessionID: SESSION_ID,
        part: { id: 'p1', messageID: 'msg_user', type: 'text', text: 'my prompt' }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    expect(out.kind).toBe('ignore')
  })

  it('still maps an assistant-role message normally', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    mapEvent(
      makeEvent('message.updated', {
        sessionID: SESSION_ID,
        info: { id: 'msg_asst', role: 'assistant' }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    const out = mapEvent(
      makeEvent('message.part.updated', {
        sessionID: SESSION_ID,
        part: { id: 'p1', messageID: 'msg_asst', type: 'text', text: 'Hi there' }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    expect(out.kind).toBe('message')
    if (out.kind === 'message') {
      expect(out.message.role).toBe('assistant')
      expect(out.message.content[0]).toMatchObject({ type: 'text', text: 'Hi there' })
    }
  })

  it('defaults to assistant when no message.updated preceded the part (role unknown)', () => {
    const accumulators = new Map<string, MessageAccumulator>()
    const out = mapEvent(
      makeEvent('message.part.updated', {
        sessionID: SESSION_ID,
        part: { id: 'p1', messageID: 'msg_x', type: 'text', text: 'orphan' }
      }),
      SESSION_ID,
      accumulators,
      START_TIME,
      { value: 0 }
    )
    expect(out.kind).toBe('message')
    if (out.kind === 'message') expect(out.message.role).toBe('assistant')
  })
})

describe('buildChatMessage', () => {
  it('builds message with text and tool blocks', () => {
    const acc: MessageAccumulator = {
      messageId: 'msg_x',
      partOrder: ['p1', 'p2'],
      parts: new Map([
        ['p1', { type: 'text', text: 'hello' }],
        ['p2', { type: 'tool', toolName: 'read', callID: 'c1', state: { status: 'running', input: { path: '/foo' } } }]
      ])
    }
    const msg = buildChatMessage('msg_x', acc)
    expect(msg.id).toBe('msg_x')
    expect(msg.role).toBe('assistant')
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0].type).toBe('text')
    expect(msg.content[1].type).toBe('tool_use')
  })
})

// ── Hosted-tools plugin tool names — RAW pass-through (Phase 6) ───────────────
// Phase 6 retired the 5c name-normalization hack (OPENCODE_TOOL_NAME_MAP). The
// mapper now emits the RAW opencode tool name; the renderer's OpencodeEngineToolMap
// classifies render_mermaid→diagram, create_mockup/show_mockup→mockup, bash→command.

describe('buildChatMessage — raw tool names (no normalization)', () => {
  it('keeps render_mermaid as the raw name, preserving callID + toolInput', () => {
    const acc: MessageAccumulator = {
      messageId: 'msg_m',
      partOrder: ['p1'],
      parts: new Map([
        [
          'p1',
          {
            type: 'tool',
            toolName: 'render_mermaid',
            callID: 'call_abc',
            state: { status: 'completed', input: { source: 'graph TD; A-->B;', title: 'Flow' } }
          }
        ]
      ])
    }
    const msg = buildChatMessage('msg_m', acc)
    expect(msg.content).toHaveLength(1)
    const block = msg.content[0]
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      // RAW name preserved — the renderer's OpencodeEngineToolMap maps it to 'diagram'
      expect(block.toolName).toBe('render_mermaid')
      // callID / toolUseId preserved
      expect(block.toolUseId).toBe('call_abc')
      // toolInput untouched (arg names already match the diagram body)
      expect(block.toolInput).toEqual({ source: 'graph TD; A-->B;', title: 'Flow' })
    }
  })

  it('keeps create_mockup + show_mockup as raw names', () => {
    const acc: MessageAccumulator = {
      messageId: 'msg_n',
      partOrder: ['p1', 'p2'],
      parts: new Map([
        ['p1', { type: 'tool', toolName: 'create_mockup', callID: 'c1', state: { status: 'completed', input: { html: '<div/>' } } }],
        ['p2', { type: 'tool', toolName: 'show_mockup', callID: 'c2', state: { status: 'completed', input: { directory: 'abc12345' } } }]
      ])
    }
    const msg = buildChatMessage('msg_n', acc)
    const names = msg.content.map((b) => (b.type === 'tool_use' ? b.toolName : null))
    expect(names).toEqual(['create_mockup', 'show_mockup'])
  })

  it('leaves a native opencode tool name (bash) unchanged', () => {
    const acc: MessageAccumulator = {
      messageId: 'msg_o',
      partOrder: ['p1'],
      parts: new Map([
        ['p1', { type: 'tool', toolName: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' } } }]
      ])
    }
    const msg = buildChatMessage('msg_o', acc)
    const block = msg.content[0]
    if (block.type === 'tool_use') {
      expect(block.toolName).toBe('bash')
      expect(block.toolUseId).toBe('c1')
    }
  })
})

describe('extractToolResult', () => {
  it('returns null for non-tool parts', () => {
    expect(extractToolResult('p1', { type: 'text', text: 'hi' })).toBeNull()
  })

  it('returns null for running tool', () => {
    expect(extractToolResult('p1', { type: 'tool', callID: 'c1', state: { status: 'running' } })).toBeNull()
  })

  it('returns result for completed tool', () => {
    const res = extractToolResult('p1', {
      type: 'tool',
      callID: 'c1',
      state: { status: 'completed', output: 'file content' }
    })
    expect(res).not.toBeNull()
    expect(res?.toolUseId).toBe('c1')
    expect(res?.result).toBe('file content')
    expect(res?.isError).toBe(false)
  })

  it('returns error result for errored tool', () => {
    const res = extractToolResult('p1', {
      type: 'tool',
      callID: 'c1',
      state: { status: 'error', output: 'permission denied' }
    })
    expect(res?.isError).toBe(true)
    expect(res?.result).toBe('permission denied')
  })
})

// ── session.error / ProviderAuthError (Phase 5c) ─────────────────────────────

// ── question.asked / question.replied / question.rejected (Phase 8b) ─────────

describe('mapEvent — question.asked', () => {
  const accumulators = new Map()
  const totalCostRef = { value: 0 }

  it('maps question.asked to approval with toolName AskUserQuestion', () => {
    const ev = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      id: 'que_1',
      questions: [
        {
          question: 'Which language?',
          header: 'Language',
          options: [{ label: 'TypeScript', description: 'TS' }, { label: 'Python', description: 'PY' }],
          multiple: false,
          custom: true
        }
      ],
      tool: { callID: 'call_q1' }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('approval')
    if (out.kind === 'approval') {
      expect(out.approval.requestId).toBe('que_1')
      expect(out.approval.toolName).toBe('AskUserQuestion')
      expect(out.approval.toolUseId).toBe('call_q1')
      const input = out.approval.input as { questions: unknown[] }
      expect(input.questions).toHaveLength(1)
      const q = (input.questions[0]) as { question: string; header: string; multiSelect: boolean; options: unknown[] }
      expect(q.question).toBe('Which language?')
      expect(q.header).toBe('Language')
      expect(q.multiSelect).toBe(false)
      expect(q.options).toEqual([
        { label: 'TypeScript', description: 'TS' },
        { label: 'Python', description: 'PY' }
      ])
    }
  })

  it('maps multiple:true to multiSelect:true', () => {
    const ev = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      id: 'que_2',
      questions: [
        {
          question: 'Select features',
          header: 'Features',
          options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
          multiple: true
        }
      ]
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('approval')
    if (out.kind === 'approval') {
      const input = out.approval.input as { questions: Array<{ multiSelect: boolean }> }
      expect(input.questions[0].multiSelect).toBe(true)
    }
  })

  it('multiple:undefined → multiSelect:false', () => {
    const ev = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      id: 'que_3',
      questions: [{ question: 'Q?', header: 'H', options: [] }]
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    if (out.kind === 'approval') {
      const input = out.approval.input as { questions: Array<{ multiSelect: boolean }> }
      expect(input.questions[0].multiSelect).toBe(false)
    }
  })

  it('ignores question.asked from a foreign session', () => {
    const ev = makeEvent('question.asked', {
      sessionID: 'ses_OTHER',
      id: 'que_4',
      questions: [{ question: 'Q?', header: 'H', options: [] }]
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    expect(out.kind).toBe('ignore')
  })

  it('ignores question.asked when id or questions is missing', () => {
    const noId = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      questions: [{ question: 'Q?', header: 'H', options: [] }]
    })
    const noQ = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      id: 'que_5'
    })
    expect(mapEvent(noId, SESSION_ID, new Map(), START_TIME, { value: 0 }).kind).toBe('ignore')
    expect(mapEvent(noQ, SESSION_ID, new Map(), START_TIME, { value: 0 }).kind).toBe('ignore')
  })

  it('maps question.replied to ignore', () => {
    const ev = makeEvent('question.replied', {
      sessionID: SESSION_ID,
      requestID: 'que_1',
      answers: [['TypeScript']]
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    expect(out.kind).toBe('ignore')
  })

  it('maps question.rejected to ignore', () => {
    const ev = makeEvent('question.rejected', {
      sessionID: SESSION_ID,
      requestID: 'que_1'
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    expect(out.kind).toBe('ignore')
  })
})

describe('mapEvent — session.error', () => {
  const SESSION_ID = 'ses_abc123'
  const accumulators = new Map()
  const totalCostRef = { value: 0 }

  // Wire shape verified vs 1.17.9 /doc: properties.error =
  //   { name, data: { providerID?, message } }  (ProviderAuthError / UnknownError / …)
  it('maps ProviderAuthError with providerID to auth-required kind (structured re-login card)', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'openai', message: 'Token expired' }
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('auth-required')
    if (out.kind === 'auth-required') {
      expect(out.vendorId).toBe('openai')
      expect(out.message).toBe('Token expired')
    }
  })

  it('maps ProviderAuthError without providerID to generic re-login hint', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: { name: 'ProviderAuthError', data: { message: 'Token expired' } }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toContain('Authentication required')
    }
  })

  it('maps a non-auth session.error to its error data.message', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: { name: 'UnknownError', data: { message: 'connection refused' } }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toBe('connection refused')
    }
  })

  it('cross-session filter still applies for session.error', () => {
    const ev = makeEvent('session.error', {
      sessionID: 'ses_OTHER',
      error: { name: 'ProviderAuthError', data: { message: 'Token expired' } }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('ignore')
  })
})

// ── Phase 8d — child session subagent routing ─────────────────────────────────

const CHILD_SESSION_ID = 'ses_CHILD_001'
const PARENT_CALL_ID = 'call_task_parent_1'

describe('mapEvent — Phase 8d: child-session registration (task tool part)', () => {
  it('registers child session when own-session task part has state.metadata.sessionId', () => {
    const childSessions = new Map<string, string>()
    const accumulators = new Map<string, MessageAccumulator>()
    const ev = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p_task',
        messageID: 'msg_parent_1',
        type: 'tool',
        tool: 'task',
        callID: PARENT_CALL_ID,
        state: {
          status: 'running',
          input: { description: 'do something' },
          metadata: { sessionId: CHILD_SESSION_ID }
        }
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    // Must still emit the parent message (parent tool_use block with toolUseId=PARENT_CALL_ID)
    expect(out.kind).toBe('message')
    if (out.kind === 'message') {
      const taskBlock = out.message.content.find((b) => b.type === 'tool_use')
      expect(taskBlock?.type).toBe('tool_use')
      if (taskBlock?.type === 'tool_use') {
        expect(taskBlock.toolName).toBe('task')
        expect(taskBlock.toolUseId).toBe(PARENT_CALL_ID)
      }
    }
    // Child session must now be registered
    expect(childSessions.get(CHILD_SESSION_ID)).toBe(PARENT_CALL_ID)
  })

  it('does NOT register when task part has no state.metadata.sessionId', () => {
    const childSessions = new Map<string, string>()
    const accumulators = new Map<string, MessageAccumulator>()
    const ev = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p_task2',
        messageID: 'msg_parent_2',
        type: 'tool',
        tool: 'task',
        callID: 'call_task_2',
        state: { status: 'running', input: { description: 'pending' } }
      }
    })
    mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(childSessions.size).toBe(0)
  })

  it('does NOT register for non-task tool parts', () => {
    const childSessions = new Map<string, string>()
    const accumulators = new Map<string, MessageAccumulator>()
    const ev = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p_bash',
        messageID: 'msg_bash',
        type: 'tool',
        tool: 'bash',
        callID: 'call_bash',
        state: { status: 'running', input: { command: 'ls' }, metadata: { sessionId: 'fake' } }
      }
    })
    mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(childSessions.size).toBe(0)
  })
})

describe('mapEvent — Phase 8d: parent session.idle still → result (not task-notification)', () => {
  it('parent session.idle (no childSessions entry for it) → result, NOT task-notification', () => {
    // The PARENT session's own session.idle must still end the turn normally.
    // This is the most critical guard: a child's session.idle must not be routed
    // here. The parent's own idle IS routed here (eventSessionId === ownSessionId).
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const ev = makeEvent('session.idle', { sessionID: SESSION_ID })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0.5 }, childSessions)
    expect(out.kind).toBe('result')
    if (out.kind === 'result') {
      expect(out.result.totalCostUsd).toBe(0.5)
      expect(out.result.sessionId).toBe(SESSION_ID)
    }
  })
})

describe('mapEvent — Phase 8d: child message.part.delta → subagent-stream', () => {
  it('child text delta → subagent-stream with correct toolUseId', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const ev = makeEvent('message.part.delta', {
      sessionID: CHILD_SESSION_ID,
      messageID: 'child_msg_1',
      partID: 'cp1',
      field: 'text',
      delta: 'hello from child'
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('subagent-stream')
    if (out.kind === 'subagent-stream') {
      expect(out.toolUseId).toBe(PARENT_CALL_ID)
      expect(out.streamType).toBe('text')
      expect(out.delta).toBe('hello from child')
    }
  })

  it('child reasoning delta → subagent-stream with streamType=thinking when acc has reasoning part', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const accumulators = new Map<string, MessageAccumulator>()
    // Pre-seed accumulator with a reasoning part so the peek returns 'thinking'
    const acc: MessageAccumulator = {
      messageId: 'child_msg_think',
      partOrder: ['cp_think'],
      parts: new Map([['cp_think', { type: 'reasoning', text: '' }]])
    }
    accumulators.set('child_msg_think', acc)
    const ev = makeEvent('message.part.delta', {
      sessionID: CHILD_SESSION_ID,
      messageID: 'child_msg_think',
      partID: 'cp_think',
      field: 'reasoning',
      delta: '<thought>'
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('subagent-stream')
    if (out.kind === 'subagent-stream') {
      expect(out.streamType).toBe('thinking')
    }
  })

  it('child delta with unknown field → ignore', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const ev = makeEvent('message.part.delta', {
      sessionID: CHILD_SESSION_ID,
      messageID: 'child_msg_2',
      partID: 'cp2',
      field: 'unknown',
      delta: 'x'
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('ignore')
  })
})

describe('mapEvent — Phase 8d: child message.part.updated → subagent-message / ignore for user', () => {
  it('child assistant message → subagent-message keyed by parent callID', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const accumulators = new Map<string, MessageAccumulator>()
    // Set up role=assistant via a message.updated first
    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SESSION_ID,
        info: { id: 'child_msg_a', role: 'assistant' }
      }),
      SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions
    )
    const ev = makeEvent('message.part.updated', {
      sessionID: CHILD_SESSION_ID,
      part: { id: 'cp_a', messageID: 'child_msg_a', type: 'text', text: 'I found it.' }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('subagent-message')
    if (out.kind === 'subagent-message') {
      expect(out.toolUseId).toBe(PARENT_CALL_ID)
      expect(out.message.id).toBe('child_msg_a')
      expect(out.message.role).toBe('assistant')
      expect(out.message.content[0]).toMatchObject({ type: 'text', text: 'I found it.' })
    }
  })

  it('child user message (task prompt text) → ignore (not rendered in subagent transcript)', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const accumulators = new Map<string, MessageAccumulator>()
    // Establish user role
    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SESSION_ID,
        info: { id: 'child_msg_u', role: 'user' }
      }),
      SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions
    )
    const ev = makeEvent('message.part.updated', {
      sessionID: CHILD_SESSION_ID,
      part: { id: 'cp_u', messageID: 'child_msg_u', type: 'text', text: 'the task prompt' }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('ignore')
  })

  it('child tool part → subagent-message containing a tool_use block', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const accumulators = new Map<string, MessageAccumulator>()
    const ev = makeEvent('message.part.updated', {
      sessionID: CHILD_SESSION_ID,
      part: {
        id: 'cp_tool',
        messageID: 'child_msg_tool',
        type: 'tool',
        tool: 'bash',
        callID: 'child_call_1',
        state: { status: 'running', input: { command: 'ls /tmp' } }
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('subagent-message')
    if (out.kind === 'subagent-message') {
      expect(out.toolUseId).toBe(PARENT_CALL_ID)
      const block = out.message.content[0]
      expect(block.type).toBe('tool_use')
      if (block.type === 'tool_use') {
        expect(block.toolName).toBe('bash')
        expect(block.toolUseId).toBe('child_call_1')
      }
    }
  })
})

describe('mapEvent — Phase 8d: child session.idle → task-notification (NOT result)', () => {
  it('child session.idle → task-notification with status=completed, NOT result', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const ev = makeEvent('session.idle', { sessionID: CHILD_SESSION_ID })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    // CRITICAL GUARD: must NOT be 'result' — that would end the parent turn early.
    expect(out.kind).not.toBe('result')
    expect(out.kind).toBe('task-notification')
    if (out.kind === 'task-notification') {
      expect(out.notification.toolUseId).toBe(PARENT_CALL_ID)
      expect(out.notification.taskId).toBe(CHILD_SESSION_ID)
      expect(out.notification.status).toBe('completed')
    }
  })

  it('child session.error → task-notification with status=failed', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    const ev = makeEvent('session.error', {
      sessionID: CHILD_SESSION_ID,
      error: { name: 'UnknownError', data: { message: 'child crashed' } }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).not.toBe('result')
    expect(out.kind).not.toBe('error') // child errors must not surface as parent errors
    expect(out.kind).toBe('task-notification')
    if (out.kind === 'task-notification') {
      expect(out.notification.status).toBe('failed')
      expect(out.notification.toolUseId).toBe(PARENT_CALL_ID)
    }
  })
})

describe('mapEvent — Phase 8d: unknown foreign session → ignore', () => {
  it('event from a session not in childSessions and not own → ignore', () => {
    const childSessions = new Map([[CHILD_SESSION_ID, PARENT_CALL_ID]])
    // 'ses_STRANGER' is neither ownSessionId nor a known child
    const ev = makeEvent('message.part.delta', {
      sessionID: 'ses_STRANGER',
      messageID: 'x_msg',
      partID: 'xp1',
      field: 'text',
      delta: 'alien text'
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('ignore')
  })
})

// ── Phase 8e — child session permission.asked (hang fix) ─────────────────────

describe('mapEvent — Phase 8e: child permission.asked → approval (hang fix)', () => {
  const CHILD_ID = 'ses_child_8e'
  const CHILD_CALL_ID = 'child_call_8e'

  it('child permission.asked → {kind:approval} with child tool callID and no suggestions', () => {
    // The key hang fix: a child subagent hitting an ask-gated tool emits
    // permission.asked under the child sessionId. Without this case it would
    // fall through to handleChildEvent default:ignore → child blocks → parent hangs.
    const childSessions = new Map([[CHILD_ID, PARENT_CALL_ID]])
    const ev = makeEvent('permission.asked', {
      sessionID: CHILD_ID,
      id: 'perm_child_1',
      permission: 'bash',
      patterns: ['echo hi'],
      tool: { callID: CHILD_CALL_ID },
      metadata: { command: 'echo hi' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)

    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')

    // requestId from props.id
    expect(out.approval.requestId).toBe('perm_child_1')
    // toolName from props.permission
    expect(out.approval.toolName).toBe('bash')
    // input from props.metadata
    expect(out.approval.input).toEqual({ command: 'echo hi' })

    // CRITICAL — toolUseId must be the CHILD tool's callID, NOT the parent task callID.
    // FloatingApproval's unmatched-approval filter hides the card when toolUseId matches
    // a callID already in the rendered main assistant blocks (the parent task part is there).
    // The child callID only appears inside subagent blocks → card shows.
    expect(out.approval.toolUseId).toBe(CHILD_CALL_ID)
    expect(out.approval.toolUseId).not.toBe(PARENT_CALL_ID)

    // CRITICAL — no suggestions field. A persisted allow rule compiles into the
    // parent's ruleset only; deriveSubagentSessionPermission propagates parent *deny*
    // rules, NOT allows, so the persisted allow would never stop the child re-asking.
    // Including it would be misleading — omit it entirely.
    expect('suggestions' in out.approval).toBe(false)
  })

  it('child permission.asked for doom_loop category → approval with no suggestions (unmappable category)', () => {
    const childSessions = new Map([[CHILD_ID, PARENT_CALL_ID]])
    const ev = makeEvent('permission.asked', {
      sessionID: CHILD_ID,
      id: 'perm_child_dl',
      permission: 'doom_loop',
      patterns: ['*'],
      tool: { callID: CHILD_CALL_ID }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)

    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    expect(out.approval.toolName).toBe('doom_loop')
    expect('suggestions' in out.approval).toBe(false)
  })

  it('child permission.asked with no tool → approval with toolUseId=undefined', () => {
    // tool field may be absent in some opencode versions — must not crash.
    const childSessions = new Map([[CHILD_ID, PARENT_CALL_ID]])
    const ev = makeEvent('permission.asked', {
      sessionID: CHILD_ID,
      id: 'perm_child_notool',
      permission: 'read'
      // no `tool` field
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)

    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    expect(out.approval.toolUseId).toBeUndefined()
  })

  it('child permission.asked for UNREGISTERED child session → ignore (treated as foreign)', () => {
    // A permission.asked from a session not in childSessions must be ignored —
    // the cross-session filter catches it before handleChildEvent is called.
    const childSessions = new Map([[CHILD_ID, PARENT_CALL_ID]])
    const ev = makeEvent('permission.asked', {
      sessionID: 'ses_UNREGISTERED',
      id: 'perm_unregistered',
      permission: 'bash',
      tool: { callID: 'call_x' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('ignore')
  })

  it('own-session permission.asked still emits suggestions (unchanged)', () => {
    // Guard: adding the child case must not break the own-session path.
    const ev = makeEvent('permission.asked', {
      sessionID: SESSION_ID,
      id: 'perm_own_1',
      permission: 'bash',
      patterns: ['echo hi'],
      tool: { callID: 'own_call_1' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })

    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    // Own-session approval DOES get suggestions (persist-rule offer is valid for the parent).
    expect(out.approval.suggestions).toBeDefined()
    expect(out.approval.suggestions!.length).toBeGreaterThan(0)
  })
})

// ── Phase 8e Part 2 — child-event ordering guarantee (no buffering needed) ───

describe('mapEvent — Phase 8e Part 2: child-event ordering (registration before transcript)', () => {
  // Verified vs opencode 1.17.9 task.ts:
  //   sessions.create(child) →
  //   ctx.metadata({ metadata: { sessionId } })  ← publishes message.part.updated (this event)
  //   → background.start(runTask)                ← runTask → ops.prompt(child) → child transcript
  //
  // ctx.metadata is yield*-ed (Effect fiber await) before ops.prompt is ever scheduled.
  // The SSE stream is a single FIFO queue. Therefore:
  //   Registration event (task part with state.metadata.sessionId) ALWAYS precedes
  //   any child transcript events (message.updated / permission.asked / session.idle).
  // No buffering needed — the happy-path ordering is structurally guaranteed.

  it('task-part event registers the child, then a child message.part.updated routes to subagent-message (happy-path order)', () => {
    const childSessions = new Map<string, string>()
    const accumulators = new Map<string, import('../event-mapper').MessageAccumulator>()

    // Step 1: own-session task part arrives — registers the child (simulates ctx.metadata publish)
    const regEvent = makeEvent('message.part.updated', {
      sessionID: SESSION_ID,
      part: {
        id: 'p_task_8e',
        messageID: 'msg_parent_8e',
        type: 'tool',
        tool: 'task',
        callID: PARENT_CALL_ID,
        state: {
          status: 'running',
          input: { description: 'subwork' },
          metadata: { sessionId: CHILD_SESSION_ID }
        }
      }
    })
    const regOut = mapEvent(regEvent, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)
    // Registration must succeed (parent message emitted + child registered)
    expect(regOut.kind).toBe('message')
    expect(childSessions.has(CHILD_SESSION_ID)).toBe(true)

    // Step 2: child transcript event arrives AFTER registration (FIFO guarantee from task.ts)
    // This is what used to be at risk of a race — confirmed not a race.
    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SESSION_ID,
        info: { id: 'child_msg_8e', role: 'assistant' }
      }),
      SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions
    )
    const childMsgEvent = makeEvent('message.part.updated', {
      sessionID: CHILD_SESSION_ID,
      part: { id: 'cp_8e', messageID: 'child_msg_8e', type: 'text', text: 'child result' }
    })
    const childOut = mapEvent(childMsgEvent, SESSION_ID, accumulators, START_TIME, { value: 0 }, childSessions)

    // Must route to subagent-message (not ignored) — proves registration preceded the transcript event
    expect(childOut.kind).toBe('subagent-message')
    if (childOut.kind !== 'subagent-message') throw new Error('expected subagent-message')
    expect(childOut.toolUseId).toBe(PARENT_CALL_ID)
    expect(childOut.message.id).toBe('child_msg_8e')
    expect(childOut.message.content[0]).toMatchObject({ type: 'text', text: 'child result' })
  })
})

// ============================================================================
// Phase 9a — subagent metering field capture + sumAccumulatorCosts guard
// ============================================================================

describe('Phase 9a — child message.updated captures model + childSessionId + cost', () => {
  const PARENT_SES = 'ses_parent9a'
  const CHILD_SES = 'ses_child9a'
  const TASK_CALL = 'call_task_9a'

  function setup() {
    const accumulators = new Map<string, MessageAccumulator>()
    const childSessions = new Map([[CHILD_SES, TASK_CALL]])
    const totalCostRef = { value: 0 }
    return { accumulators, childSessions, totalCostRef }
  }

  it('child message.updated with providerID + modelID + cost → acc.model, acc.childSessionId, acc.cost', () => {
    const { accumulators, childSessions, totalCostRef } = setup()

    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SES,
        info: {
          id: 'child_msg_9a',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4o',
          cost: 0.42,
          tokens: { input: 100, output: 50 }
        }
      }),
      PARENT_SES, accumulators, START_TIME, totalCostRef, childSessions
    )

    const acc = accumulators.get('child_msg_9a')!
    expect(acc).toBeDefined()
    expect(acc.isChild).toBe(true)
    expect(acc.childSessionId).toBe(CHILD_SES)
    expect(acc.model).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
    expect(acc.cost).toBe(0.42)
    expect(acc.tokens).toMatchObject({ input: 100, output: 50 })
  })

  it('child message.updated WITHOUT providerID/modelID → acc.model undefined', () => {
    const { accumulators, childSessions, totalCostRef } = setup()

    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SES,
        info: { id: 'child_msg_no_model', role: 'assistant', cost: 0.1, tokens: { input: 10, output: 5 } }
      }),
      PARENT_SES, accumulators, START_TIME, totalCostRef, childSessions
    )

    const acc = accumulators.get('child_msg_no_model')!
    expect(acc).toBeDefined()
    expect(acc.isChild).toBe(true)
    expect(acc.model).toBeUndefined()
  })

  it('sumAccumulatorCosts guard — child cost does NOT inflate parent totalCostUsd (Phase 9a)', () => {
    // This is the CRITICAL guard. Before Phase 9a, sumAccumulatorCosts summed ALL
    // accumulators. Now that children capture cost, it MUST skip isChild.
    //
    // Scenario: parent has cost 0.5, child has cost 0.99.
    // Expected: totalCostUsd.value after parent update = 0.5, NOT 0.5 + 0.99 = 1.49.
    //
    // We test this indirectly: fire the parent message.updated AFTER the child has
    // already set acc.cost = 0.99. The own-session cost_update path calls
    // sumAccumulatorCosts to recompute totalCostUsd.value.
    const { accumulators, childSessions, totalCostRef } = setup()

    // First: child message.updated sets acc.cost = 0.99
    mapEvent(
      makeEvent('message.updated', {
        sessionID: CHILD_SES,
        info: {
          id: 'child_cost_guard',
          role: 'assistant',
          providerID: 'openai', modelID: 'gpt-4o',
          cost: 0.99,
          tokens: { input: 100, output: 50 }
        }
      }),
      PARENT_SES, accumulators, START_TIME, totalCostRef, childSessions
    )
    // Child event returns ignore — totalCostUsd must still be 0 (child doesn't update it)
    expect(totalCostRef.value).toBe(0)

    // Second: parent message.updated fires with cost 0.5 → triggers sumAccumulatorCosts
    const out = mapEvent(
      makeEvent('message.updated', {
        sessionID: PARENT_SES,
        info: { id: 'parent_cost_9a', role: 'assistant', cost: 0.5 }
      }),
      PARENT_SES, accumulators, START_TIME, totalCostRef, childSessions
    )

    // Must be a cost_update (own path, cost changed)
    expect(out.kind).toBe('cost_update')
    // GUARD: totalCostUsd must be 0.5 (parent only), NOT 1.49 (parent + child)
    expect(totalCostRef.value).toBeCloseTo(0.5, 6)
    if (out.kind === 'cost_update') {
      expect(out.totalCostUsd).toBeCloseTo(0.5, 6)
    }
  })
})

// ── Child question.asked (floating AskUserQuestion hang-fix) ──────────────────

describe('mapEvent — child question.asked → floating approval (hang-fix)', () => {
  const CHILD_Q_ID = 'ses_child_q'
  const PARENT_Q_CALL = 'call_task_q'
  const CHILD_Q_CALL = 'child_call_question'

  it('child question.asked → {kind:approval} with toolName AskUserQuestion and child callID', () => {
    // Core regression: a child subagent calling the `question` tool emits
    // question.asked under the child sessionId. Without this case it falls through
    // to handleChildEvent default:ignore → child blocks → parent turn hangs.
    const childSessions = new Map([[CHILD_Q_ID, PARENT_Q_CALL]])
    const ev = makeEvent('question.asked', {
      sessionID: CHILD_Q_ID,
      id: 'que_child_1',
      questions: [
        {
          question: 'Which approach?',
          header: 'Strategy',
          options: [
            { label: 'Fast', description: 'Quick but rough' },
            { label: 'Safe', description: 'Slow but correct' }
          ],
          multiple: false
        }
      ],
      tool: { callID: CHILD_Q_CALL }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)

    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')

    expect(out.approval.requestId).toBe('que_child_1')
    expect(out.approval.toolName).toBe('AskUserQuestion')

    // CRITICAL — toolUseId must be the CHILD question tool's callID, NOT the
    // parent task callID. The parent callID is already in the rendered main
    // assistant blocks → FloatingApproval would hide the card. The child callID
    // only appears in subagent blocks → card shows correctly.
    expect(out.approval.toolUseId).toBe(CHILD_Q_CALL)
    expect(out.approval.toolUseId).not.toBe(PARENT_Q_CALL)

    const input = out.approval.input as { questions: Array<{ question: string; header: string; multiSelect: boolean; options: unknown[] }> }
    expect(input.questions).toHaveLength(1)
    expect(input.questions[0].question).toBe('Which approach?')
    expect(input.questions[0].header).toBe('Strategy')
    expect(input.questions[0].multiSelect).toBe(false)
    expect(input.questions[0].options).toEqual([
      { label: 'Fast', description: 'Quick but rough' },
      { label: 'Safe', description: 'Slow but correct' }
    ])
  })

  it('child question.asked with multiple:true → multiSelect:true', () => {
    const childSessions = new Map([[CHILD_Q_ID, PARENT_Q_CALL]])
    const ev = makeEvent('question.asked', {
      sessionID: CHILD_Q_ID,
      id: 'que_child_multi',
      questions: [
        {
          question: 'Pick features',
          header: 'Features',
          options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
          multiple: true
        }
      ],
      tool: { callID: CHILD_Q_CALL }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    const input = out.approval.input as { questions: Array<{ multiSelect: boolean }> }
    expect(input.questions[0].multiSelect).toBe(true)
  })

  it('child question.asked with no tool field → toolUseId undefined', () => {
    const childSessions = new Map([[CHILD_Q_ID, PARENT_Q_CALL]])
    const ev = makeEvent('question.asked', {
      sessionID: CHILD_Q_ID,
      id: 'que_child_notool',
      questions: [{ question: 'Q?', header: 'H', options: [] }]
      // no `tool` field
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    expect(out.approval.toolUseId).toBeUndefined()
  })

  it('child question.asked missing id or questions → ignore', () => {
    const childSessions = new Map([[CHILD_Q_ID, PARENT_Q_CALL]])
    const noId = makeEvent('question.asked', {
      sessionID: CHILD_Q_ID,
      questions: [{ question: 'Q?', header: 'H', options: [] }]
    })
    const noQ = makeEvent('question.asked', {
      sessionID: CHILD_Q_ID,
      id: 'que_child_noq'
    })
    expect(mapEvent(noId, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions).kind).toBe('ignore')
    expect(mapEvent(noQ, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions).kind).toBe('ignore')
  })

  it('child question.asked from UNREGISTERED session → ignore (foreign session filter)', () => {
    // A question.asked from a session not in childSessions is treated as a foreign
    // session and ignored before handleChildEvent is ever reached.
    const childSessions = new Map([[CHILD_Q_ID, PARENT_Q_CALL]])
    const ev = makeEvent('question.asked', {
      sessionID: 'ses_UNREGISTERED',
      id: 'que_unregistered',
      questions: [{ question: 'Q?', header: 'H', options: [] }],
      tool: { callID: 'call_x' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 }, childSessions)
    expect(out.kind).toBe('ignore')
  })

  it('own-session question.asked regression — still returns correct approval (helper shared, behavior unchanged)', () => {
    // Guard: extracting buildQuestionApproval must not change the own-session path.
    // Re-runs the key assertions from the Phase 8b test suite to catch helper drift.
    const ev = makeEvent('question.asked', {
      sessionID: SESSION_ID,
      id: 'que_own_regression',
      questions: [
        {
          question: 'Which language?',
          header: 'Language',
          options: [{ label: 'TypeScript', description: 'TS' }],
          multiple: false
        }
      ],
      tool: { callID: 'call_own_q' }
    })
    const out = mapEvent(ev, SESSION_ID, new Map(), START_TIME, { value: 0 })
    expect(out.kind).toBe('approval')
    if (out.kind !== 'approval') throw new Error('expected approval')
    expect(out.approval.requestId).toBe('que_own_regression')
    expect(out.approval.toolName).toBe('AskUserQuestion')
    expect(out.approval.toolUseId).toBe('call_own_q')
    const input = out.approval.input as { questions: Array<{ question: string; header: string; multiSelect: boolean }> }
    expect(input.questions).toHaveLength(1)
    expect(input.questions[0].question).toBe('Which language?')
    expect(input.questions[0].multiSelect).toBe(false)
  })
})
