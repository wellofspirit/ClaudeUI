/**
 * The opencode 2.x live mapper (ADR-097 S4), per event family. Payload
 * shapes follow `protocol-v2/events.ts` (transcribed from upstream
 * `schema/src/session-event.ts` at 2.0.24) and the recorded sequences in
 * `fixtures/opencode-v2/`; `v2-parity.test.ts` holds the mapper to the cold
 * converter on those recordings.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpencodeEvent } from '../protocol-v2/events'
import type { Session_Message_Info } from '../protocol-v2/openapi'
import {
  OpencodeEventMapper,
  type OpencodeMapperOutput,
  type OpencodeReconnectSnapshot
} from '../v2-event-mapper'

const SID = 'ses_own'
const CHILD = 'ses_child'
const MSG = 'msg_a1'
const MODEL = { providerID: 'openai', id: 'gpt-x' }
const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } }

let clock = 1_000
let seq = 0
/** An event as the feed delivers it (the mapper never reads `durable`). */
function ev(type: string, data: Record<string, unknown>, at?: number): OpencodeEvent {
  clock = at ?? clock + 1
  return {
    id: `evt_${String(++seq).padStart(4, '0')}`,
    type,
    created: clock,
    data
  } as unknown as OpencodeEvent
}

const kinds = (outputs: readonly OpencodeMapperOutput[]) => outputs.map((o) => o.kind)
const of = <K extends OpencodeMapperOutput['kind']>(
  outputs: readonly OpencodeMapperOutput[],
  kind: K
) => outputs.filter((o): o is Extract<OpencodeMapperOutput, { kind: K }> => o.kind === kind)

let mapper: OpencodeEventMapper
const map = (...events: OpencodeEvent[]) => events.flatMap((event) => mapper.map(event))

/** A step of the own session (or `session`), started. */
function step(id = MSG, session = SID, model = MODEL): OpencodeEvent {
  return ev('session.step.started', {
    sessionID: session,
    assistantMessageID: id,
    agent: 'build',
    model,
    started: clock + 1
  })
}
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  session = SID,
  msg = MSG
) => [
  ev('session.tool.input.started', { sessionID: session, assistantMessageID: msg, id, name }),
  ev('session.tool.called', {
    sessionID: session,
    assistantMessageID: msg,
    id,
    input,
    executed: false
  })
]

beforeEach(() => {
  mapper = new OpencodeEventMapper({ sessionID: SID })
})

describe('text and reasoning', () => {
  it('a text part streams as item-open → item-delta → item-seal on block 0', () => {
    const out = map(
      step(),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'Hel'
      }),
      ev('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'lo'
      }),
      ev('session.text.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        text: 'Hello'
      })
    )
    expect(kinds(out)).toEqual(['item-open', 'item-delta', 'item-delta', 'item-seal'])
    const [open] = of(out, 'item-open')
    expect(open.open.target).toEqual({ messageId: MSG, blockIndex: 0, kind: 'text' })
    expect(open.open.message.content).toEqual([{ type: 'text', text: '' }])
    expect(of(out, 'item-delta').map((o) => o.chunk)).toEqual(['Hel', 'lo'])
    expect(of(out, 'item-seal')[0].seal.message).toMatchObject({
      id: MSG,
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }]
    })
  })

  it('reasoning opens a thinking item timed from its start and seals with its duration', () => {
    const out = map(
      step(),
      ev(
        'session.reasoning.started',
        { sessionID: SID, assistantMessageID: MSG, ordinal: 0 },
        5_000
      ),
      ev(
        'session.reasoning.delta',
        { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'hmm' },
        5_010
      ),
      // 2.0.24 starts the text before it ends the reasoning (recorded).
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }, 5_020),
      ev(
        'session.reasoning.ended',
        { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'hmm' },
        5_250
      ),
      ev(
        'session.text.delta',
        { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'ok' },
        5_260
      ),
      ev(
        'session.text.ended',
        { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'ok' },
        5_270
      )
    )
    const opens = of(out, 'item-open')
    expect(opens[0].open).toMatchObject({
      target: { blockIndex: 0, kind: 'thinking' },
      startedAt: 5_000
    })
    expect(opens[1].open.target).toMatchObject({ blockIndex: 1, kind: 'text' })
    expect(of(out, 'item-seal').at(-1)?.seal.message.content).toEqual([
      { type: 'thinking', text: 'hmm', durationMs: 250 },
      { type: 'text', text: 'ok' }
    ])
  })

  it('an EMPTY reasoning (encrypted-only) never places a block', () => {
    const out = map(
      step(),
      ev('session.reasoning.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.reasoning.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        text: ''
      }),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'x' })
    )
    expect(of(out, 'item-open')[0].open.target).toMatchObject({ blockIndex: 0, kind: 'text' })
    expect(out.some((o) => o.kind === 'message')).toBe(false)
  })

  it('a text that ends with no deltas lands as one message, no stream', () => {
    const out = map(
      step(),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        text: 'whole'
      })
    )
    expect(kinds(out)).toEqual(['message'])
  })

  it('a second text in a step takes the next ordinal and the next block', () => {
    const out = map(
      step(),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.ended', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'a' }),
      ...tool('call_1', 'read', { path: 'x' }),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 1 }),
      ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 1, delta: 'b' })
    )
    expect(of(out, 'item-open')[0].open.target.blockIndex).toBe(2)
  })
})

describe('tools', () => {
  it('input start shows the card; the call fills its input; success sends the result', () => {
    const out = map(
      step(),
      ...tool('call_1', 'shell', { command: 'ls' }),
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_1',
        content: [
          { type: 'text', text: 'a\n' },
          { type: 'text', text: 'Exited with code 1' }
        ],
        metadata: { exit: 1 },
        executed: false
      })
    )
    const messages = of(out, 'message')
    expect(messages[0].message.content).toEqual([
      { type: 'tool_use', toolUseId: 'call_1', toolName: 'shell', toolInput: {} }
    ])
    expect(messages[1].message.content[0]).toMatchObject({ toolInput: { command: 'ls' } })
    expect(of(out, 'tool-result')[0].result).toEqual({
      toolUseId: 'call_1',
      result: 'a\n\n\nExited with code 1',
      isError: false
    })
  })

  it('a tool.input.delta is passed on for live argument rendering', () => {
    const out = map(
      step(),
      ev('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'c',
        name: 'write'
      }),
      ev('session.tool.input.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'c',
        delta: '{"pa'
      })
    )
    expect(of(out, 'tool-input-delta')).toEqual([
      { kind: 'tool-input-delta', toolUseId: 'c', delta: '{"pa' }
    ])
  })

  it('edit/patch results carry per-file diffs (FileDiff.Info → FileDiff)', () => {
    const out = map(
      step(),
      ...tool('call_e', 'patch', { patchText: '…' }),
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_e',
        content: [{ type: 'text', text: 'Success.' }],
        metadata: {
          files: [
            { file: 'a.ts', patch: '@@ -1 +1 @@', additions: 1, deletions: 1, status: 'modified' },
            { file: 'b.ts', patch: '@@ +1 @@', additions: 1, deletions: 0, status: 'added' },
            { file: 'c.ts', patch: '@@ -1 @@', additions: 0, deletions: 1, status: 'deleted' }
          ]
        },
        executed: false
      })
    )
    expect(of(out, 'tool-result')[0].result.fileDiffs).toEqual([
      { path: 'a.ts', patch: '@@ -1 +1 @@', additions: 1, deletions: 1, changeType: 'update' },
      { path: 'b.ts', patch: '@@ +1 @@', additions: 1, deletions: 0, changeType: 'add' },
      { path: 'c.ts', patch: '@@ -1 @@', additions: 0, deletions: 1, changeType: 'delete' }
    ])
  })

  it('an image a tool returned becomes a result image (blob ref)', () => {
    const out = map(
      step(),
      ...tool('call_r', 'read', { path: 'p.png' }),
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_r',
        content: [
          {
            type: 'file',
            uri: 'data:image/png;base64,iVBORw0KGgo=',
            mime: 'image/png',
            name: 'p.png'
          }
        ],
        executed: false
      })
    )
    expect(of(out, 'tool-result')[0].result.images).toEqual([
      expect.objectContaining({
        mediaType: 'image/png',
        fileName: 'p.png',
        blobId: expect.any(String)
      })
    ])
  })

  it.each([
    ['permission.rejected', 'ClaudeUI denied: no', true],
    ['aborted', 'Tool execution aborted', false],
    ['tool.execution', 'Unable to execute command: x', false]
  ])(
    'a %s failure is an error result; only an unasked rejection adds the rule denial',
    (type, message, denial) => {
      const out = map(
        step(),
        ...tool('call_f', 'shell', { command: 'x' }),
        ev('session.tool.failed', {
          sessionID: SID,
          assistantMessageID: MSG,
          id: 'call_f',
          error: { type, message },
          executed: false
        })
      )
      expect(of(out, 'tool-result')[0].result).toEqual({
        toolUseId: 'call_f',
        result: message,
        isError: true,
        errorType: type
      })
      expect(of(out, 'permission-denial')).toEqual(
        denial
          ? [
              {
                kind: 'permission-denial',
                toolUseId: 'call_f',
                denial: {
                  type: 'permission_denial',
                  toolUseId: 'call_f',
                  denialId: 'opencode-rule:call_f',
                  source: 'rule',
                  reason: message
                }
              }
            ]
          : []
      )
    }
  )

  it('a rejection the HOST answered (an ask was raised) adds no denial of the mapper’s', () => {
    const out = map(
      step(),
      ...tool('call_f', 'shell', { command: 'x' }),
      ev('permission.asked', {
        id: 'per_1',
        sessionID: SID,
        action: 'shell',
        resources: ['x'],
        source: { type: 'tool', messageID: MSG, id: 'call_f' }
      }),
      ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'reject' }),
      ev('session.tool.failed', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_f',
        error: { type: 'permission.rejected', message: 'User denied' },
        executed: false
      })
    )
    expect(of(out, 'permission-denial')).toEqual([])
  })

  it('shell progress announces the shellID once (2.x streams no output on the feed)', () => {
    const progress = ev('session.tool.progress', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: 'call_s',
      metadata: { shellID: 'sh_1' }
    })
    const out = map(step(), ...tool('call_s', 'shell', { command: 'sleep 1' }), progress, progress)
    expect(of(out, 'shell-started')).toEqual([
      { kind: 'shell-started', toolUseId: 'call_s', shellID: 'sh_1' }
    ])
  })

  it('a duplicate terminal event sends no second result', () => {
    const done = ev('session.tool.success', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: 'c',
      content: [{ type: 'text', text: 'x' }],
      executed: false
    })
    expect(of(map(step(), ...tool('c', 'read', {}), done, done), 'tool-result')).toHaveLength(1)
  })
})

describe('subagents', () => {
  const linkEvents = (callID = 'call_sub', child = CHILD) => [
    ...tool(callID, 'subagent', { agent: 'general', description: 'd', prompt: 'p' }),
    ev('session.created', {
      sessionID: child,
      parentID: SID,
      projectID: 'p',
      location: { directory: '/ws' },
      slug: 's',
      version: '2.0.24'
    }),
    ev('session.tool.progress', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      metadata: { sessionID: child, status: 'running' }
    })
  ]
  const childText = (child = CHILD, msg = 'msg_c1') => [
    step(msg, child),
    ev('session.text.started', { sessionID: child, assistantMessageID: msg, ordinal: 0 }),
    ev('session.text.delta', {
      sessionID: child,
      assistantMessageID: msg,
      ordinal: 0,
      delta: 'hi'
    }),
    ev('session.text.ended', { sessionID: child, assistantMessageID: msg, ordinal: 0, text: 'hi' })
  ]
  const subSuccess = (callID = 'call_sub', child = CHILD, status = 'completed') =>
    ev('session.tool.success', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      content: [
        { type: 'text', text: `<subagent sessionID="${child}" state="completed">\nhi\n</subagent>` }
      ],
      metadata: { sessionID: child, status },
      executed: false
    })

  it('progress links the child; its stream and steps route under the call', () => {
    const out = map(step(), ...linkEvents(), ...childText())
    expect(of(out, 'subagent-started')).toEqual([
      { kind: 'subagent-started', toolUseId: 'call_sub', childSessionId: CHILD }
    ])
    expect(of(out, 'item-open')[0].open.target).toEqual({
      messageId: 'msg_c1',
      blockIndex: 0,
      kind: 'text',
      ownerToolUseId: 'call_sub'
    })
    expect(of(out, 'item-seal')[0].seal.ownerToolUseId).toBe('call_sub')
  })

  it('child events before the link are held and replayed when it comes', () => {
    const [input, called, created, progress] = linkEvents()
    const early = map(step(), input, called, created, ...childText())
    expect(early.some((o) => o.kind === 'item-open')).toBe(false)
    const late = map(progress)
    expect(kinds(late)).toEqual(['subagent-started', 'item-open', 'item-delta', 'item-seal'])
  })

  it('a foreground call’s result is its ONE terminal notification; the child’s own end is not', () => {
    const out = map(
      step(),
      ...linkEvents(),
      ev('session.execution.started', { sessionID: CHILD }),
      ...childText(),
      ev('session.execution.succeeded', { sessionID: CHILD }),
      subSuccess()
    )
    expect(of(out, 'task-notification').map((o) => o.notification)).toEqual([
      { taskId: CHILD, toolUseId: 'call_sub', status: 'completed', outputFile: '', summary: '' }
    ])
    // Never a parent turn end from the child.
    expect(out.some((o) => o.kind === 'result')).toBe(false)
    // A settled child is not re-read on a reconnect.
    expect(mapper.followedSessions()).toEqual([SID])
    expect(of(out, 'tool-result')[0].result.result).toBe('hi')
  })

  it('a background call returns at once; the child’s end is the notification', () => {
    const out = map(
      step(),
      ...linkEvents(),
      subSuccess('call_sub', CHILD, 'running'),
      ev('session.execution.started', { sessionID: CHILD }),
      ev('session.execution.failed', { sessionID: CHILD, error: { type: 'unknown', message: 'x' } })
    )
    expect(of(out, 'task-notification').map((o) => o.notification.status)).toEqual(['failed'])
  })

  it('an aborted call is `stopped`, a failed one `failed`', () => {
    const out = map(
      step(),
      ...linkEvents(),
      ev('session.tool.failed', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        error: { type: 'aborted', message: `Tool execution aborted (sessionID: ${CHILD})` },
        executed: false
      })
    )
    expect(of(out, 'task-notification')[0].notification.status).toBe('stopped')
  })

  it('a grandchild routes under the child’s own call', () => {
    const GRAND = 'ses_grand'
    const out = map(
      step(),
      ...linkEvents(),
      step('msg_c1', CHILD),
      ...tool('call_inner', 'subagent', { agent: 'general' }, CHILD, 'msg_c1'),
      ev('session.created', {
        sessionID: GRAND,
        parentID: CHILD,
        projectID: 'p',
        location: { directory: '/ws' },
        slug: 's',
        version: 'v'
      }),
      ev('session.tool.progress', {
        sessionID: CHILD,
        assistantMessageID: 'msg_c1',
        id: 'call_inner',
        metadata: { sessionID: GRAND, status: 'running' }
      }),
      ...childText(GRAND, 'msg_g1')
    )
    expect(of(out, 'subagent-started').at(-1)).toEqual({
      kind: 'subagent-started',
      toolUseId: 'call_inner',
      childSessionId: GRAND,
      ownerToolUseId: 'call_sub'
    })
    expect(of(out, 'item-open').at(-1)?.open.target.ownerToolUseId).toBe('call_inner')
    expect(mapper.followedSessions()).toEqual([SID, CHILD, GRAND])
  })

  it('a child’s permission ask carries the subagent marker and its own session as the route', () => {
    const out = map(
      step(),
      ...linkEvents(),
      step('msg_c1', CHILD),
      ...tool('call_c', 'shell', { command: 'ls' }, CHILD, 'msg_c1'),
      ev('permission.asked', {
        id: 'per_c',
        sessionID: CHILD,
        action: 'shell',
        resources: ['ls'],
        save: ['ls *'],
        source: { type: 'tool', messageID: 'msg_c1', id: 'call_c' }
      })
    )
    const [ask] = of(out, 'approval')
    expect(ask.route).toEqual({ sessionID: CHILD })
    expect(ask.approval).toEqual({
      requestId: 'per_c',
      toolUseId: 'call_c',
      toolName: 'shell',
      input: { command: 'ls' },
      patterns: ['ls'],
      always: ['ls *'],
      subagent: { sessionId: CHILD, parentToolUseId: 'call_sub' }
    })
  })
})

describe('steps, usage, turn ends', () => {
  it('a step is metered once, with its model', () => {
    const ended = ev('session.step.ended', {
      sessionID: SID,
      assistantMessageID: MSG,
      finish: 'stop',
      cost: 0.01,
      tokens: TOKENS
    })
    const out = map(step(), ended, ended)
    expect(of(out, 'step-usage').map((o) => o.usage)).toEqual([
      { messageId: MSG, sessionId: SID, model: MODEL, cost: 0.01, tokens: TOKENS, finish: 'stop' }
    ])
  })

  it('session usage is the own session’s only', () => {
    const out = map(
      ev('session.usage.updated', { sessionID: SID, cost: 1, tokens: TOKENS }),
      ev('session.usage.updated', { sessionID: 'ses_foreign', cost: 2, tokens: TOKENS })
    )
    expect(of(out, 'session-usage')).toEqual([{ kind: 'session-usage', cost: 1, tokens: TOKENS }])
  })

  it.each([
    ['session.execution.succeeded', {}, { kind: 'result' }],
    [
      'session.execution.failed',
      { error: { type: 'provider.rate-limit', message: 'slow down' } },
      { kind: 'error', message: 'slow down', errorType: 'provider.rate-limit' }
    ],
    [
      'session.execution.failed',
      { error: { type: 'provider.auth', message: 'Request failed: 403' } },
      { kind: 'auth-required', vendorId: 'openai', message: 'Request failed: 403' }
    ],
    // ADR-090: the user's Stop is not an error.
    ['session.execution.interrupted', { reason: 'user' }, { kind: 'stopped', reason: 'user' }],
    [
      'session.execution.interrupted',
      { reason: 'shutdown' },
      { kind: 'stopped', reason: 'shutdown' }
    ],
    [
      'session.execution.interrupted',
      { reason: 'inactivity' },
      { kind: 'stopped', reason: 'inactivity' }
    ]
  ])('%s %j ends the turn as %j', (type, data, expected) => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }, 10_000),
      step(),
      ev(type, { sessionID: SID, ...data }, 12_500)
    )
    expect(out[0]).toEqual({ kind: 'turn-start' })
    expect(out.at(-1)).toEqual({ ...expected, sessionId: SID, durationMs: 2_500 })
    expect(mapper.running).toBe(false)
  })

  it('a shutdown after a REJECT is a denial-ended turn, not a server shutdown nor a user stop', () => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_1', 'shell', { command: 'rm -rf x' }),
      ev('permission.asked', {
        id: 'per_1',
        sessionID: SID,
        action: 'shell',
        resources: ['rm -rf x'],
        source: { type: 'tool', messageID: MSG, id: 'call_1' }
      }),
      ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'reject' }),
      ev('session.tool.failed', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_1',
        error: { type: 'aborted', message: 'Tool execution aborted' },
        executed: false
      }),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    expect(out.at(-1)).toMatchObject({ kind: 'stopped', reason: 'denied' })
  })

  it('the turn end seals a stream left open', () => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'part'
      }),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'user' })
    )
    expect(kinds(out).slice(-2)).toEqual(['item-seal', 'stopped'])
  })

  it('a retry is surfaced with its attempt and time', () => {
    const error = { type: 'provider.rate-limit', message: '429' }
    expect(
      map(
        step(),
        ev('session.retry.scheduled', {
          sessionID: SID,
          assistantMessageID: MSG,
          attempt: 2,
          at: 9_999,
          error
        })
      )
    ).toEqual([{ kind: 'retry', attempt: 2, at: 9_999, error }])
  })
})

describe('compaction', () => {
  it('ends in a separator row keyed by the input id, with the summary and the request’s usage', () => {
    const out = map(
      ev(
        'session.compaction.started',
        { sessionID: SID, reason: 'manual', recent: '', inputID: 'msg_in' },
        7_000
      ),
      ev('session.compaction.delta', { sessionID: SID, text: '## Obj' }),
      ev('session.compaction.ended', {
        sessionID: SID,
        reason: 'manual',
        text: '## Objective\nx',
        recent: '',
        cost: 0.5,
        tokens: TOKENS,
        model: MODEL
      })
    )
    expect(out).toEqual([
      { kind: 'compaction', phase: 'started', reason: 'manual' },
      {
        kind: 'message',
        message: {
          id: 'msg_in',
          role: 'system',
          content: [{ type: 'compact_separator', text: '## Objective\nx' }],
          timestamp: 7_000
        }
      },
      {
        kind: 'compaction',
        phase: 'ended',
        reason: 'manual',
        usage: { cost: 0.5, tokens: TOKENS, model: MODEL }
      }
    ])
  })

  it('a failed compaction leaves no row', () => {
    const error = { type: 'compaction.failed', message: 'template' }
    const out = map(
      ev('session.compaction.started', { sessionID: SID, reason: 'auto', recent: '' }),
      ev('session.compaction.failed', { sessionID: SID, reason: 'auto', error })
    )
    expect(kinds(out)).toEqual(['compaction', 'compaction'])
    expect(out[1]).toMatchObject({ phase: 'failed', error })
  })
})

describe('approvals', () => {
  it('an own ask takes the call’s real input and the suggestion; replied retracts it once', () => {
    mapper = new OpencodeEventMapper({
      sessionID: SID,
      suggest: (action, resources) => ({
        type: 'addRules',
        rules: [{ toolName: action, ruleContent: resources[0] }],
        behavior: 'allow',
        destination: 'localSettings'
      })
    })
    const replied = ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'once' })
    const out = map(
      step(),
      ...tool('call_1', 'edit', { path: 'a', oldString: 'x', newString: 'y' }),
      ev('permission.asked', {
        id: 'per_1',
        sessionID: SID,
        action: 'edit',
        resources: ['a'],
        save: ['*'],
        metadata: { files: [] },
        source: { type: 'tool', messageID: MSG, id: 'call_1' }
      }),
      replied,
      replied
    )
    const [ask] = of(out, 'approval')
    expect(ask.approval).toMatchObject({
      requestId: 'per_1',
      toolUseId: 'call_1',
      toolName: 'edit',
      input: { path: 'a', oldString: 'x', newString: 'y' },
      suggestions: [expect.objectContaining({ behavior: 'allow' })]
    })
    expect(of(out, 'approval-resolved')).toEqual([
      { kind: 'approval-resolved', requestId: 'per_1' }
    ])
  })

  it('an ask with no known call falls back to its metadata', () => {
    const [ask] = of(
      map(
        ev('permission.asked', {
          id: 'per_2',
          sessionID: SID,
          action: 'external_directory',
          resources: ['/x'],
          metadata: { path: '/x' }
        })
      ),
      'approval'
    )
    expect(ask.approval.input).toEqual({ path: '/x' })
  })

  it('a question form is an AskUserQuestion with the reply keys', () => {
    const out = map(
      ev('form.created', {
        form: {
          id: 'frm_1',
          sessionID: SID,
          title: 'Questions',
          metadata: { kind: 'question', tool: { messageID: MSG, id: 'call_q' } },
          fields: [
            {
              key: 'q0',
              type: 'string',
              title: 'Fruit',
              description: 'Pick a fruit?',
              custom: true,
              options: [
                { value: 'Apple', label: 'Apple', description: 'red' },
                { value: 'Banana', label: 'Banana' }
              ]
            },
            {
              key: 'q1',
              type: 'multiselect',
              title: 'Many',
              description: 'Pick many?',
              options: []
            }
          ]
        }
      }),
      ev('form.cancelled', { sessionID: SID, id: 'frm_1' })
    )
    expect(out).toEqual([
      {
        kind: 'approval',
        approval: {
          requestId: 'frm_1',
          toolUseId: 'call_q',
          toolName: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Pick a fruit?',
                header: 'Fruit',
                multiSelect: false,
                options: [
                  { label: 'Apple', description: 'red' },
                  { label: 'Banana', description: '' }
                ]
              },
              { question: 'Pick many?', header: 'Many', multiSelect: true, options: [] }
            ]
          }
        },
        route: {
          sessionID: SID,
          form: {
            formID: 'frm_1',
            fields: [
              { key: 'q0', multiSelect: false, values: { Apple: 'Apple', Banana: 'Banana' } },
              { key: 'q1', multiSelect: true }
            ]
          }
        }
      },
      { kind: 'approval-resolved', requestId: 'frm_1' }
    ])
  })
})

describe('inbox', () => {
  const item = (text: string, delivery: 'steer' | 'queue' = 'queue') => ({
    type: 'user',
    payload: { text },
    delivery
  })

  it('enqueued / delivery changed / delivered (+ the user row) / cancelled', () => {
    const out = map(
      ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_q1', item: item('first') }),
      ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_q2', item: item('second') }),
      ev('session.inbox.delivery.changed', {
        sessionID: SID,
        inboxID: 'msg_q1',
        delivery: 'steer'
      }),
      ev('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_q1' }, 4_242),
      ev('session.inbox.cancelled', { sessionID: SID, inboxID: 'msg_q2' })
    )
    expect(out).toEqual([
      {
        kind: 'inbox',
        change: 'enqueued',
        inboxID: 'msg_q1',
        delivery: 'queue',
        item: item('first')
      },
      {
        kind: 'inbox',
        change: 'enqueued',
        inboxID: 'msg_q2',
        delivery: 'queue',
        item: item('second')
      },
      { kind: 'inbox', change: 'delivery-changed', inboxID: 'msg_q1', delivery: 'steer' },
      { kind: 'inbox', change: 'delivered', inboxID: 'msg_q1' },
      {
        kind: 'user-message',
        inboxID: 'msg_q1',
        message: {
          id: 'msg_q1',
          role: 'user',
          content: [{ type: 'text', text: 'first' }],
          timestamp: 4_242
        }
      },
      { kind: 'inbox', change: 'cancelled', inboxID: 'msg_q2' }
    ])
  })

  it('a child’s inbox (its subagent prompt) is not ClaudeUI’s queue', () => {
    expect(
      map(ev('session.inbox.enqueued', { sessionID: CHILD, inboxID: 'x', item: item('p') }))
    ).toEqual([])
  })

  it('an inline image attachment comes first, a mentioned file not at all', () => {
    const out = map(
      ev('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_q',
        item: {
          type: 'user',
          delivery: 'steer',
          payload: {
            text: 'look',
            files: [
              { data: 'aGk=', mime: 'text/plain', source: { type: 'uri', uri: 'file:///a' } },
              { data: 'iVBORw0KGgo=', mime: 'image/png', source: { type: 'inline' }, name: 'p.png' }
            ]
          }
        }
      }),
      ev('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_q' })
    )
    expect(of(out, 'user-message')[0].message.content).toEqual([
      expect.objectContaining({ type: 'image', mediaType: 'image/png', fileName: 'p.png' }),
      { type: 'text', text: 'look' }
    ])
  })
})

describe('routing and session events', () => {
  it('foreign sessions on the shared feed are ignored', () => {
    const FOREIGN = 'ses_other'
    expect(
      map(
        step('msg_x', FOREIGN),
        ev('session.text.started', { sessionID: FOREIGN, assistantMessageID: 'msg_x', ordinal: 0 }),
        ev('session.text.delta', {
          sessionID: FOREIGN,
          assistantMessageID: 'msg_x',
          ordinal: 0,
          delta: 'x'
        }),
        ev('permission.asked', { id: 'per_x', sessionID: FOREIGN, action: 'shell', resources: [] }),
        ev('session.execution.succeeded', { sessionID: FOREIGN }),
        ev('server.connected', {})
      )
    ).toEqual([])
  })

  it('rename, model and agent switches, delete', () => {
    expect(
      map(
        ev('session.renamed', { sessionID: SID, title: 'T' }),
        ev('session.model.selected', { sessionID: SID, model: MODEL }),
        ev('session.agent.selected', { sessionID: SID, agent: 'plan' }),
        ev('session.deleted', { sessionID: SID })
      )
    ).toEqual([
      { kind: 'session-renamed', title: 'T' },
      { kind: 'model-selected', model: MODEL },
      { kind: 'agent-selected', agent: 'plan' },
      { kind: 'session-deleted' }
    ])
  })

  it('provider.auth names the vendor from the session’s model (constructor, created, or step)', () => {
    mapper = new OpencodeEventMapper({
      sessionID: SID,
      model: { providerID: 'openrouter', id: 'm' }
    })
    expect(
      map(
        ev('session.execution.failed', {
          sessionID: SID,
          error: { type: 'provider.auth', message: 'x' }
        })
      )[0]
    ).toMatchObject({ kind: 'auth-required', vendorId: 'openrouter' })
    mapper = new OpencodeEventMapper({ sessionID: SID })
    expect(
      map(
        ev('session.execution.failed', {
          sessionID: SID,
          error: { type: 'provider.auth', message: 'x' }
        })
      )[0]
    ).toMatchObject({ kind: 'error', errorType: 'provider.auth' })
  })
})

describe('reconnect', () => {
  const user = (id: string, created: number, text: string): Session_Message_Info => ({
    id,
    type: 'user',
    text,
    time: { created }
  })
  const assistant = (
    id: string,
    created: number,
    content: Extract<Session_Message_Info, { type: 'assistant' }>['content'],
    done = true
  ): Session_Message_Info => ({
    id,
    type: 'assistant',
    agent: 'build',
    model: MODEL,
    content,
    time: { created, ...(done ? { completed: created + 5 } : {}) },
    ...(done ? { cost: 0.01, tokens: TOKENS, finish: 'stop' as const } : {})
  })
  const idle = (
    eventID: string,
    created: number,
    outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded'
  ): Session_Message_Info => ({
    id: eventID.replace(/^evt_/, 'msg_'),
    type: 'idle',
    outcome,
    time: { created }
  })
  const snapshot = (
    messages: Session_Message_Info[],
    extra: Partial<OpencodeReconnectSnapshot['sessions'][string]> = {},
    active: Record<string, { type: 'running' }> = {}
  ): OpencodeReconnectSnapshot => ({
    sessions: { [SID]: { messages, permissions: [], forms: [], inbox: [], ...extra } },
    active
  })

  it('an item open across the gap shows nothing more until its end, which seals the whole text', () => {
    const before = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'Hel'
      })
    )
    expect(kinds(before)).toContain('item-open')
    // The read: the step is in progress, its text not ended yet (stored as "").
    const rec = mapper.reconcile(
      snapshot(
        [assistant(MSG, 1, [{ type: 'text', text: '' }], false)],
        {},
        { [SID]: { type: 'running' } }
      )
    )
    expect(rec).toEqual([])
    const after = map(
      ev('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'lo, wor'
      }),
      ev('session.text.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        text: 'Hello, world'
      })
    )
    expect(kinds(after)).toEqual(['item-seal'])
    expect(of(after, 'item-seal')[0].seal.message.content).toEqual([
      { type: 'text', text: 'Hello, world' }
    ])
  })

  it('a turn that ended in the gap: the rest of its content, its result and its end, once', () => {
    map(ev('session.execution.started', { sessionID: SID }, 100), step())
    const end = ev('session.execution.succeeded', { sessionID: SID }, 200)
    const rows = [
      user('msg_u', 99, 'hi'),
      assistant(MSG, 101, [
        { type: 'text', text: 'done' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'read',
          state: {
            status: 'completed',
            input: { path: 'a' },
            content: [{ type: 'text', text: 'A' }]
          },
          time: { created: 102 }
        }
      ]),
      idle(end.id, 200)
    ]
    const rec = mapper.reconcile(snapshot(rows))
    expect(kinds(rec)).toEqual(['user-message', 'message', 'tool-result', 'step-usage', 'result'])
    expect(rec.at(-1)).toEqual({ kind: 'result', sessionId: SID, durationMs: 100 })
    // The end event itself (published after the subscription came back) is not a second end.
    expect(map(end)).toEqual([])
    expect(mapper.running).toBe(false)
  })

  it('the live end of an end already read is dropped; a live START after the read re-arms it', () => {
    map(ev('session.execution.started', { sessionID: SID }))
    const end = ev('session.execution.succeeded', { sessionID: SID })
    mapper.reconcile(snapshot([idle(end.id, 1)]))
    expect(map(end)).toEqual([])
    // A turn that started after the reconnect but before the read finished.
    const restarted = map(ev('session.execution.started', { sessionID: SID }), end)
    expect(kinds(restarted)).toEqual(['turn-start', 'result'])
  })

  it('not active and no idle row: the turn ended by shutdown — or by a messageless reject', () => {
    map(ev('session.execution.started', { sessionID: SID }))
    expect(mapper.reconcile(snapshot([]))).toEqual([
      expect.objectContaining({ kind: 'stopped', reason: 'shutdown' })
    ])
    // Its late `interrupted{shutdown}` is not a second end.
    expect(
      map(ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' }))
    ).toEqual([])

    // The reject was seen live; its call's `aborted` failure only in the read.
    mapper = new OpencodeEventMapper({ sessionID: SID })
    map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_1', 'shell', { command: 'x' }),
      ev('permission.asked', {
        id: 'per_1',
        sessionID: SID,
        action: 'shell',
        resources: ['x'],
        source: { type: 'tool', messageID: MSG, id: 'call_1' }
      }),
      ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'reject' })
    )
    const rec = mapper.reconcile(
      snapshot([
        assistant(
          MSG,
          1,
          [
            {
              type: 'tool',
              id: 'call_1',
              name: 'shell',
              state: {
                status: 'error',
                input: { command: 'x' },
                error: { type: 'aborted', message: 'Tool execution aborted' }
              },
              time: { created: 1 }
            }
          ],
          false
        )
      ])
    )
    expect(rec.at(-1)).toMatchObject({ kind: 'stopped', reason: 'denied' })
  })

  it('a turn the read shows ended retracts the cards it still had up', () => {
    map(
      ev('session.execution.started', { sessionID: SID }),
      ev('permission.asked', { id: 'per_1', sessionID: SID, action: 'shell', resources: ['x'] })
    )
    const end = ev('session.execution.interrupted', { sessionID: SID, reason: 'user' })
    // Even a read that still lists the request (a stale read) cannot keep a card past the end.
    const rec = mapper.reconcile(
      snapshot([idle(end.id, 5, 'interrupted')], {
        permissions: [{ id: 'per_1', sessionID: SID, action: 'shell', resources: ['x'] }]
      })
    )
    expect(kinds(rec)).toEqual(['approval-resolved', 'stopped'])
  })

  it('active but believed idle: the turn started in the gap', () => {
    expect(
      mapper.reconcile(snapshot([user('msg_u', 1, 'x')], {}, { [SID]: { type: 'running' } }))
    ).toEqual([expect.objectContaining({ kind: 'user-message' }), { kind: 'turn-start' }])
    expect(mapper.running).toBe(true)
  })

  it('pending asks and forms are (re)announced; settled ones retracted', () => {
    map(
      ev('permission.asked', { id: 'per_old', sessionID: SID, action: 'shell', resources: ['x'] })
    )
    const rec = mapper.reconcile(
      snapshot([], {
        permissions: [{ id: 'per_new', sessionID: SID, action: 'edit', resources: ['a'] }],
        forms: [
          { id: 'frm_1', sessionID: SID, title: 'Q', fields: [{ key: 'q0', type: 'string' }] }
        ]
      })
    )
    expect(
      rec.map((o) =>
        o.kind === 'approval'
          ? o.approval.requestId
          : o.kind === 'approval-resolved'
            ? `-${o.requestId}`
            : o.kind
      )
    ).toEqual(['-per_old', 'per_new', 'frm_1'])
  })

  it('the inbox: new items enqueued, gone ones delivered (stored as a row) or cancelled', () => {
    map(
      ev('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_a',
        item: { type: 'user', payload: { text: 'a' }, delivery: 'queue' }
      }),
      ev('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_b',
        item: { type: 'user', payload: { text: 'b' }, delivery: 'queue' }
      }),
      ev('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_c',
        item: { type: 'user', payload: { text: 'c' }, delivery: 'queue' }
      })
    )
    const rec = mapper.reconcile(
      snapshot([user('msg_a', 5, 'a')], {
        inbox: [
          {
            id: 'msg_c',
            sessionID: SID,
            type: 'user',
            payload: { text: 'c' },
            delivery: 'steer',
            time: { created: 1 }
          },
          {
            id: 'msg_d',
            sessionID: SID,
            type: 'user',
            payload: { text: 'd' },
            delivery: 'queue',
            time: { created: 2 }
          }
        ]
      })
    )
    expect(rec.filter((o) => o.kind === 'inbox')).toEqual([
      { kind: 'inbox', change: 'delivered', inboxID: 'msg_a' },
      { kind: 'inbox', change: 'cancelled', inboxID: 'msg_b' },
      { kind: 'inbox', change: 'delivery-changed', inboxID: 'msg_c', delivery: 'steer' },
      {
        kind: 'inbox',
        change: 'enqueued',
        inboxID: 'msg_d',
        delivery: 'queue',
        item: { type: 'user', payload: { text: 'd' }, delivery: 'queue' }
      }
    ])
    expect(of(rec, 'user-message').map((o) => o.inboxID)).toEqual(['msg_a'])
  })

  it('a rejection read back adds no rule denial (its ask may have been in the gap)', () => {
    const rec = mapper.reconcile(
      snapshot([
        assistant(MSG, 1, [
          {
            type: 'tool',
            id: 'call_r',
            name: 'shell',
            state: {
              status: 'error',
              input: { command: 'x' },
              error: { type: 'permission.rejected', message: 'User denied' }
            },
            time: { created: 1 }
          }
        ])
      ])
    )
    expect(of(rec, 'tool-result')).toHaveLength(1)
    expect(of(rec, 'permission-denial')).toEqual([])
  })

  it('seed() marks stored history as shown: a re-read of the same rows emits nothing', () => {
    const rows = [
      user('msg_u', 1, 'hi'),
      assistant(MSG, 2, [{ type: 'text', text: 'hello' }]),
      idle('evt_x', 10)
    ]
    mapper.seed(rows)
    expect(mapper.reconcile(snapshot(rows))).toEqual([])
    expect(mapper.followedSessions()).toEqual([SID])
  })
})

describe('turn ends: cards, classification, background order, overhead', () => {
  const asked = (id: string, call: string, session = SID, msg = MSG) =>
    ev('permission.asked', {
      id,
      sessionID: session,
      action: 'shell',
      resources: ['x'],
      source: { type: 'tool', messageID: msg, id: call }
    })
  const failed = (call: string, type: string, message: string, session = SID, msg = MSG) =>
    ev('session.tool.failed', {
      sessionID: session,
      assistantMessageID: msg,
      id: call,
      error: { type, message },
      executed: false
    })
  const questionForm = (id: string, call: string) =>
    ev('form.created', {
      form: {
        id,
        sessionID: SID,
        title: 'Questions',
        metadata: { kind: 'question', tool: { messageID: MSG, id: call } },
        fields: [{ key: 'q0', type: 'string', title: 'H', description: 'Q?', options: [] }]
      }
    })

  it('a Stop with an ask pending retracts its card (an interrupt publishes no permission.replied)', () => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_1', 'shell', { command: 'x' }),
      asked('per_1', 'call_1'),
      failed('call_1', 'aborted', 'Tool execution aborted'),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'user' })
    )
    expect(kinds(out).slice(-2)).toEqual(['approval-resolved', 'stopped'])
    expect(out.at(-1)).toMatchObject({ reason: 'user' })
  })

  it('a turn end retracts a foreground child’s cards, not a running background child’s', () => {
    const link = (call: string, child: string) => [
      ...tool(call, 'subagent', { agent: 'general' }),
      ev('session.created', {
        sessionID: child,
        parentID: SID,
        projectID: 'p',
        location: { directory: '/' },
        slug: 's',
        version: 'v'
      }),
      ev('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: call,
        metadata: { sessionID: child, status: 'running' }
      })
    ]
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...link('call_fg', 'ses_fg'),
      ...link('call_bg', 'ses_bg'),
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_bg',
        content: [{ type: 'text', text: 'bg' }],
        metadata: { sessionID: 'ses_bg', status: 'running' },
        executed: false
      }),
      ev('session.execution.started', { sessionID: 'ses_bg' }),
      ev('permission.asked', { id: 'per_fg', sessionID: 'ses_fg', action: 'shell', resources: [] }),
      ev('permission.asked', { id: 'per_bg', sessionID: 'ses_bg', action: 'shell', resources: [] }),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'user' })
    )
    expect(of(out, 'approval-resolved').map((o) => o.requestId)).toEqual(['per_fg'])
  })

  it('a form cancelled WITHOUT a message ends the turn as `form-cancelled`, not a shutdown', () => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_q', 'question', { questions: [] }),
      questionForm('frm_1', 'call_q'),
      ev('form.cancelled', { sessionID: SID, id: 'frm_1' }),
      failed('call_q', 'aborted', 'Tool execution aborted'),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    expect(out.at(-1)).toMatchObject({ kind: 'stopped', reason: 'form-cancelled' })
  })

  it('a reject or cancel WITH a message does not arm the stop: a later real shutdown is a shutdown', () => {
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_1', 'shell', { command: 'x' }),
      asked('per_1', 'call_1'),
      ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'reject' }),
      failed('call_1', 'permission.rejected', 'ClaudeUI denied: no'),
      ...tool('call_q', 'question', { questions: [] }),
      questionForm('frm_1', 'call_q'),
      ev('form.cancelled', { sessionID: SID, id: 'frm_1' }),
      failed('call_q', 'tool.execution', 'The user skipped this'),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    expect(out.at(-1)).toMatchObject({ kind: 'stopped', reason: 'shutdown' })
  })

  it('the arming is per execution', () => {
    map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_1', 'shell', { command: 'x' }),
      asked('per_1', 'call_1'),
      ev('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'reject' }),
      failed('call_1', 'aborted', 'Tool execution aborted'),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    // opencode resumes the claimed turn on its next start; that execution ends on a real shutdown.
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      ev('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    expect(out.at(-1)).toMatchObject({ kind: 'stopped', reason: 'shutdown' })
  })

  describe('a background call gets exactly one notification, whatever the order', () => {
    const CH = 'ses_bg'
    const setup = () => [
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ...tool('call_s', 'subagent', { agent: 'explore', background: true }),
      ev('session.created', {
        sessionID: CH,
        parentID: SID,
        projectID: 'p',
        location: { directory: '/' },
        slug: 's',
        version: 'v'
      }),
      ev('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_s',
        metadata: { sessionID: CH, status: 'running' }
      })
    ]
    const childRun = (end = 'session.execution.succeeded') => [
      ev('session.execution.started', { sessionID: CH }),
      ev(end, { sessionID: CH, error: { type: 'unknown', message: 'x' } })
    ]
    const backgrounded = () =>
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_s',
        content: [{ type: 'text', text: 'working in the background' }],
        metadata: { sessionID: CH, status: 'running' },
        executed: false
      })
    it.each([
      ['child ends first', () => [...setup(), ...childRun(), backgrounded()], 'completed'],
      ['call returns first', () => [...setup(), backgrounded(), ...childRun()], 'completed'],
      [
        'child fails first',
        () => [...setup(), ...childRun('session.execution.failed'), backgrounded()],
        'failed'
      ]
    ])('%s', (_name, events, status) => {
      const notes = of(map(...events()), 'task-notification')
      expect(notes.map((o) => [o.notification.toolUseId, o.notification.status])).toEqual([
        ['call_s', status]
      ])
    })
  })

  it('usage no step carries (title generation) is reported as overhead, once, before the end', () => {
    const title = { input: 120, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }
    const stepTokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      // title generation lands first (recorded 2.0.24 order)
      ev('session.usage.updated', { sessionID: SID, cost: 0.2, tokens: title }),
      step(),
      ev('session.step.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        finish: 'stop',
        cost: 0.1,
        tokens: stepTokens
      }),
      ev('session.usage.updated', {
        sessionID: SID,
        cost: 0.3,
        tokens: { input: 220, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
      }),
      ev('session.execution.succeeded', { sessionID: SID }),
      // an update with nothing new while idle adds nothing
      ev('session.usage.updated', {
        sessionID: SID,
        cost: 0.3,
        tokens: { input: 220, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    )
    const overhead = of(out, 'overhead-usage')
    expect(overhead).toHaveLength(1)
    expect(overhead[0].cost).toBeCloseTo(0.2, 10)
    expect(overhead[0].tokens).toEqual(title)
    expect(kinds(out).slice(-3, -1)).toEqual(['overhead-usage', 'result'])
  })

  it('seed(…, sessionTotals): what the cold line counted is not reported again', () => {
    const totals = { cost: 1, tokens: TOKENS }
    mapper.seed([], { sessionTotals: totals })
    expect(
      map(ev('session.usage.updated', { sessionID: SID, ...totals })).map((o) => o.kind)
    ).toEqual(['session-usage'])
  })
})
