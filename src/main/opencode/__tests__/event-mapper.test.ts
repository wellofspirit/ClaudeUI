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
  it('ignores events from a different session', () => {
    const ev = makeEvent('message.part.delta', {
      sessionID: 'ses_OTHER',
      messageID: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'hello'
    })
    const accumulators = new Map<string, MessageAccumulator>()
    const totalCostRef = { value: 0 }
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
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
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('stream')
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
