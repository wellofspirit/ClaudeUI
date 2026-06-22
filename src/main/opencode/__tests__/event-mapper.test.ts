import { describe, it, expect, beforeEach } from 'vitest'
import {
  mapEvent,
  buildChatMessage,
  extractToolResult,
  normalizeOpencodeToolName,
  OPENCODE_TOOL_NAME_MAP,
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

// ── Hosted-tools plugin tool-name normalization (Phase 5c Part B) ────────────

describe('normalizeOpencodeToolName', () => {
  it('maps render_mermaid → mcp__claude-ui__render_mermaid', () => {
    expect(normalizeOpencodeToolName('render_mermaid')).toBe('mcp__claude-ui__render_mermaid')
  })

  it('maps create_mockup → mcp__claude-ui-mockup__create_mockup', () => {
    expect(normalizeOpencodeToolName('create_mockup')).toBe('mcp__claude-ui-mockup__create_mockup')
  })

  it('maps show_mockup → mcp__claude-ui-mockup__show_mockup', () => {
    expect(normalizeOpencodeToolName('show_mockup')).toBe('mcp__claude-ui-mockup__show_mockup')
  })

  it('passes through unmapped tool names unchanged', () => {
    expect(normalizeOpencodeToolName('bash')).toBe('bash')
    expect(normalizeOpencodeToolName('read')).toBe('read')
  })

  it('OPENCODE_TOOL_NAME_MAP has exactly the three hosted tools', () => {
    expect(Object.keys(OPENCODE_TOOL_NAME_MAP).sort()).toEqual([
      'create_mockup',
      'render_mermaid',
      'show_mockup'
    ])
  })
})

describe('buildChatMessage — tool-name normalization', () => {
  it('normalizes render_mermaid in tool_use block, preserving callID + toolInput', () => {
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
      // toolName normalized to the canonical renderer name
      expect(block.toolName).toBe('mcp__claude-ui__render_mermaid')
      // callID / toolUseId preserved
      expect(block.toolUseId).toBe('call_abc')
      // toolInput untouched (arg names already match the renderer)
      expect(block.toolInput).toEqual({ source: 'graph TD; A-->B;', title: 'Flow' })
    }
  })

  it('normalizes create_mockup + show_mockup tool names', () => {
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
    expect(names).toEqual([
      'mcp__claude-ui-mockup__create_mockup',
      'mcp__claude-ui-mockup__show_mockup'
    ])
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

describe('mapEvent — session.error', () => {
  const SESSION_ID = 'ses_abc123'
  const accumulators = new Map()
  const totalCostRef = { value: 0 }

  // Wire shape verified vs 1.17.9 /doc: properties.error =
  //   { name, data: { providerID?, message } }  (ProviderAuthError / UnknownError / …)
  it('maps ProviderAuthError to error kind with re-login hint including vendor name', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'openai', message: 'Token expired' }
      }
    })
    const out = mapEvent(ev, SESSION_ID, accumulators, START_TIME, totalCostRef)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toContain('openai')
      expect(out.message).toContain('Settings')
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
