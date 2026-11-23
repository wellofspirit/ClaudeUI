/**
 * The opencode 2.x live mapper (ADR-097 S4), per event family. Payload
 * shapes follow `protocol-v2/events.ts` (transcribed from upstream
 * `schema/src/session-event.ts`) and the recorded sequences in
 * `fixtures/opencode-v2/`; `history-parity.test.ts` holds the mapper to the cold
 * converter on those recordings.
 *
 * Subagents: since opencode 2.3.0 every `subagent` call answers at once with a
 * launch acknowledgement (`metadata.status: 'running'`) and the child's own end
 * is the run's notification. A `completed` call result (`<subagent …>` envelope)
 * is the foreground shape of data older than 2.3.0; the mapper still settles a
 * run on it, and some cases below use it where the shape does not matter.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpencodeEvent } from '../protocol-v2/events'
import type { Session_Message_Info, TokenUsage_Info } from '../protocol-v2/openapi'
import {
  OpencodeEventMapper,
  type OpencodeMapperOutput,
  type OpencodeReconnectSnapshot
} from '../event-mapper'

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
function step(
  id = MSG,
  session = SID,
  model: { providerID: string; id: string; variant?: string } = MODEL
): OpencodeEvent {
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
  /** What every 2.3.0 call answers: the child keeps running. */
  const LAUNCHED = (child: string) =>
    `The subagent is working in the background (sessionID: ${child}). You will receive a <subagent> message when it goes idle, and again after each later round of work.`
  const launched = (callID = 'call_sub', child = CHILD) =>
    ev('session.tool.success', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      content: [{ type: 'text', text: LAUNCHED(child) }],
      metadata: { sessionID: child, status: 'running' },
      executed: false
    })
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
    expect(kinds(late)).toEqual([
      'subagent-started',
      'task-started',
      'item-open',
      'item-delta',
      'item-seal'
    ])
  })

  it('the call answers at once (2.3.0); the child’s own end is the ONE notification', () => {
    const out = map(
      step(),
      ...linkEvents(),
      launched(),
      ev('session.execution.started', { sessionID: CHILD }),
      ...childText(),
      ev('session.execution.succeeded', { sessionID: CHILD })
    )
    expect(of(out, 'task-notification').map((o) => o.notification)).toEqual([
      {
        taskId: CHILD,
        toolUseId: 'call_sub',
        status: 'completed',
        outputFile: '',
        // What the child said last in the run, not the call's launch acknowledgement.
        summary: 'hi',
        runIndex: 1,
        isBackgrounded: true,
        usage: { totalTokens: 0, toolUses: 0, durationMs: expect.any(Number) }
      }
    ])
    // Never a parent turn end from the child.
    expect(out.some((o) => o.kind === 'result')).toBe(false)
    // A settled child is not re-read on a reconnect.
    expect(mapper.followedSessions()).toEqual([SID])
    // The call's own result is the acknowledgement, as the model read it.
    expect(of(out, 'tool-result')[0].result.result).toBe(LAUNCHED(CHILD))
  })

  it('a child that ends before its call answers is notified once; the late answer adds nothing', () => {
    const out = map(
      step(),
      ...linkEvents(),
      ev('session.execution.started', { sessionID: CHILD }),
      ...childText(),
      ev('session.execution.succeeded', { sessionID: CHILD }),
      launched()
    )
    expect(
      of(out, 'task-notification').map((o) => [o.notification.status, o.notification.summary])
    ).toEqual([['completed', 'hi']])
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

  it('an aborted call is `stopped`, a failed one `failed` — without the background flag: the error is the result', () => {
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
    // The launch itself failed: nothing runs on, and the card shows the error (cold reads the same).
    expect(of(out, 'task-notification')[0].notification).not.toHaveProperty('isBackgrounded')
    expect(of(out, 'task-started')[0].data.isBackgrounded).toBe(true)
    expect(mapper.hasLiveBackgroundChild()).toBe(false)
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

  // ── Task lifecycle (S2): task-started, task-progress, the notification's figures ──
  describe('task lifecycle', () => {
    /** A call of the own session whose child is `child` (resumed when `resume`). */
    const call = (callID: string, input: Record<string, unknown>, child = CHILD, msg = MSG) => [
      ...tool(
        callID,
        'subagent',
        { agent: 'general', description: `d ${callID}`, ...input },
        SID,
        msg
      ),
      ev('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: msg,
        id: callID,
        metadata: { sessionID: child, status: 'running' }
      })
    ]
    const announce = (child = CHILD, parent = SID) =>
      ev('session.created', {
        sessionID: child,
        parentID: parent,
        projectID: 'p',
        location: { directory: '/ws' },
        slug: 's',
        version: '2.1.2'
      })
    /** One metered child step that ran one tool. */
    const childStep = (msg: string, toolID: string, name = 'read', child = CHILD) => [
      step(msg, child),
      ...tool(toolID, name, {}, child, msg),
      ev('session.step.ended', {
        sessionID: child,
        assistantMessageID: msg,
        finish: 'tool-calls',
        cost: 0.01,
        tokens: TOKENS
      })
    ]
    const result = (callID: string, status = 'completed', child = CHILD, text = 'hi') =>
      ev('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: callID,
        content: [
          {
            type: 'text',
            text: `<subagent sessionID="${child}" state="${status}">\n${text}\n</subagent>`
          }
        ],
        metadata: { sessionID: child, status },
        executed: false
      })
    const started = (out: readonly OpencodeMapperOutput[]) =>
      of(out, 'task-started').map((o) => o.data)

    it('every run starts as a background one (2.3.0) and wakes the parent', () => {
      const out = map(step(), announce(), ...call('call_a', {}))
      const [data] = started(out)
      expect(data).toEqual({
        toolUseId: 'call_a',
        taskId: CHILD,
        taskType: 'local_agent',
        runIndex: 1,
        startedAt: expect.any(Number),
        wakesParent: true,
        // Never `false`: only an explicit false offers "Send to background" (ADR-111 §4).
        isBackgrounded: true,
        description: 'd call_a'
      })
      // Before anything of the child's, so progress never precedes the start.
      expect(kinds(out).indexOf('task-started')).toBe(kinds(out).indexOf('subagent-started') + 1)
      // The parent's turn may end now: the child holds the idle timer.
      expect(mapper.hasLiveBackgroundChild()).toBe(true)
    })

    it('startedAt is the call’s own start', () => {
      const [input, called, progress] = [
        ev('session.tool.input.started', {
          sessionID: SID,
          assistantMessageID: MSG,
          id: 'call_a',
          name: 'subagent'
        }),
        ev(
          'session.tool.called',
          {
            sessionID: SID,
            assistantMessageID: MSG,
            id: 'call_a',
            input: { agent: 'general' },
            executed: false
          },
          7_000
        ),
        ev(
          'session.tool.progress',
          {
            sessionID: SID,
            assistantMessageID: MSG,
            id: 'call_a',
            metadata: { sessionID: CHILD, status: 'running' }
          },
          7_400
        )
      ]
      expect(started(map(step(), input, called, progress))[0].startedAt).toBe(7_000)
    })

    it('the launch acknowledgement (`status: running`) does not announce the run again', () => {
      // A 2.2.x `background: true` input changes nothing either (2.3.0 dropped the parameter).
      for (const input of [{}, { background: true }]) {
        mapper = new OpencodeEventMapper({ sessionID: SID })
        const out = map(step(), announce(), ...call('call_a', input), result('call_a', 'running'))
        expect(started(out)).toMatchObject([
          { toolUseId: 'call_a', runIndex: 1, isBackgrounded: true }
        ])
        expect(of(out, 'task-notification')).toEqual([])
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
      }
    })

    it('a resumed child is the next run, under the resuming call', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        ...childStep('msg_c1', 'c1'),
        result('call_a'),
        ...call('call_b', { sessionID: CHILD }),
        ...childStep('msg_c2', 'c2'),
        result('call_b')
      )
      expect(started(out).map((d) => [d.toolUseId, d.taskId, d.runIndex])).toEqual([
        ['call_a', CHILD, 1],
        ['call_b', CHILD, 2]
      ])
      expect(
        of(out, 'task-notification').map((o) => [o.notification.toolUseId, o.notification.runIndex])
      ).toEqual([
        ['call_a', 1],
        ['call_b', 2]
      ])
    })

    describe('a re-read that links a later call to a child (both calls inside a feed gap)', () => {
      /** The own session's two `subagent` calls, read back: `call_a` at 10, `call_b` at 50. */
      const own = (): Session_Message_Info[] =>
        (['call_a', 'call_b'] as const).map(
          (id, i) =>
            ({
              id: `msg_${id}`,
              type: 'assistant',
              agent: 'build',
              model: MODEL,
              content: [
                {
                  type: 'tool',
                  id,
                  name: 'subagent',
                  state: {
                    status: 'completed',
                    input: { agent: 'general', ...(i ? { sessionID: CHILD } : {}) },
                    content: [{ type: 'text', text: 'working in the background' }],
                    metadata: { sessionID: CHILD, status: 'running' }
                  },
                  time: { created: 10 + 40 * i, ran: 10 + 40 * i, completed: 11 + 40 * i }
                }
              ],
              time: { created: 10 + 40 * i, completed: 12 + 40 * i }
            }) as Session_Message_Info
        )
      const said = (id: string, at: number, text: string) =>
        ({
          id,
          type: 'assistant',
          agent: 'general',
          model: MODEL,
          content: [{ type: 'text', text }],
          time: { created: at, completed: at + 1 }
        }) as Session_Message_Info
      const idle = (id: string, at: number) =>
        ({ id, type: 'idle', outcome: 'succeeded', time: { created: at } }) as Session_Message_Info
      const read = (child: Session_Message_Info[] | null) =>
        mapper.reconcile({
          sessions: {
            [SID]: { messages: own(), permissions: [], forms: [], inbox: [] },
            ...(child ? { [CHILD]: { messages: child, permissions: [], forms: [] } } : {})
          },
          active: {}
        })
      const notes = (out: readonly OpencodeMapperOutput[]) =>
        of(out, 'task-notification').map((o) => [o.notification.toolUseId, o.notification.summary])

      it('the earlier run that ended on its own (its idle row) is notified as itself', () => {
        const out = read([
          said('m1', 20, 'first'),
          idle('i1', 30),
          said('m2', 60, 'second'),
          idle('i2', 70)
        ])
        expect(notes(out)).toEqual([
          ['call_a', 'first'],
          ['call_b', 'second']
        ])
      })

      it('a real steer (no end of its own before the later call) is superseded', () => {
        const out = read([said('m1', 20, 'first'), said('m2', 60, 'second'), idle('i2', 70)])
        expect(notes(out)).toEqual([
          ['call_b', 'second'],
          ['call_a', 'continued by a later call']
        ])
      })

      it('a child that could not be read back: its takeover settles at the next live event', () => {
        expect(notes(read(null))).toEqual([])
        expect(
          notes(map(ev('session.usage.updated', { sessionID: SID, cost: 0, tokens: TOKENS })))
        ).toEqual([['call_a', 'continued by a later call']])
      })
    })

    it('a call that steers a still-running child settles the earlier call first', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        ...childStep('msg_c1', 'c1'),
        // opencode joins the second call to the child's running job.
        ...call('call_b', { sessionID: CHILD })
      )
      const notes = of(out, 'task-notification')
      expect(notes).toHaveLength(1)
      expect(notes[0].notification).toMatchObject({
        toolUseId: 'call_a',
        status: 'completed',
        summary: 'continued by a later call',
        runIndex: 1,
        // The run's figures so far.
        usage: { totalTokens: 125, toolUses: 1 }
      })
      // Before the second run arms (so the reducer drops the first record, not the second).
      const order = kinds(out)
      expect(order.indexOf('task-notification')).toBeLessThan(order.lastIndexOf('task-started'))
      expect(started(out).map((d) => [d.toolUseId, d.runIndex])).toEqual([
        ['call_a', 1],
        ['call_b', 2]
      ])
      // The child ends: both calls settle with the one result; each run is told once.
      const end = map(
        ev('session.execution.started', { sessionID: CHILD }),
        ev('session.execution.succeeded', { sessionID: CHILD }),
        result('call_a'),
        result('call_b')
      )
      expect(
        of(end, 'task-notification').map((o) => [o.notification.toolUseId, o.notification.runIndex])
      ).toEqual([['call_b', 2]])
    })

    it('a superseded call settling late notifies nothing of the later run', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        ...call('call_b', { sessionID: CHILD }),
        // The first call's own result arrives after the steer: it names a running child.
        result('call_a', 'running')
      )
      expect(of(out, 'task-notification').map((o) => o.notification.toolUseId)).toEqual(['call_a'])
      // The child belongs to call_b now, whose run is still live.
      expect(mapper.hasLiveBackgroundChild()).toBe(true)
      expect(mapper.stopRun('call_a')).toBeNull()
      expect(mapper.stopRun('call_b')?.sessions).toEqual([CHILD])
    })

    it('every child step of the run reports usage: tokens, distinct tools, the last tool, the clock', () => {
      mapper = new OpencodeEventMapper({ sessionID: SID })
      const out = map(
        step(),
        ev('session.tool.input.started', {
          sessionID: SID,
          assistantMessageID: MSG,
          id: 'call_a',
          name: 'subagent'
        }),
        ev(
          'session.tool.called',
          {
            sessionID: SID,
            assistantMessageID: MSG,
            id: 'call_a',
            input: { agent: 'general' },
            executed: false
          },
          10_000
        ),
        announce(),
        ev(
          'session.tool.progress',
          {
            sessionID: SID,
            assistantMessageID: MSG,
            id: 'call_a',
            metadata: { sessionID: CHILD, status: 'running' }
          },
          10_010
        ),
        step('msg_c1', CHILD),
        ...tool('c1', 'read', {}, CHILD, 'msg_c1'),
        ...tool('c2', 'grep', {}, CHILD, 'msg_c1'),
        ev(
          'session.step.ended',
          {
            sessionID: CHILD,
            assistantMessageID: 'msg_c1',
            finish: 'tool-calls',
            cost: 0.01,
            tokens: TOKENS
          },
          12_500
        ),
        step('msg_c2', CHILD),
        ...tool('c3', 'read', {}, CHILD, 'msg_c2'),
        ev(
          'session.step.ended',
          {
            sessionID: CHILD,
            assistantMessageID: 'msg_c2',
            finish: 'stop',
            cost: 0.01,
            tokens: TOKENS
          },
          16_000
        )
      )
      expect(of(out, 'task-progress').map((o) => o.progress)).toEqual([
        {
          toolUseId: 'call_a',
          toolName: 'subagent',
          parentToolUseId: null,
          elapsedTimeSeconds: 2,
          usage: { totalTokens: 125, toolUses: 2, durationMs: 2_500 },
          lastToolName: 'grep'
        },
        {
          toolUseId: 'call_a',
          toolName: 'subagent',
          parentToolUseId: null,
          elapsedTimeSeconds: 6,
          usage: { totalTokens: 250, toolUses: 3, durationMs: 6_000 },
          lastToolName: 'read'
        }
      ])
      // The cache is not part of the figure (input + output + reasoning, as pi's).
      expect(TOKENS.cache.read).toBeGreaterThan(0)
    })

    it('usage restarts for a resumed run and the run’s notification carries it', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        ...childStep('msg_c1', 'c1'),
        ...childStep('msg_c1b', 'c1b'),
        result('call_a'),
        ...call('call_b', { sessionID: CHILD }),
        ...childStep('msg_c2', 'c2'),
        result('call_b')
      )
      const progress = of(out, 'task-progress').map((o) => [o.progress.toolUseId, o.progress.usage])
      expect(progress).toEqual([
        ['call_a', { totalTokens: 125, toolUses: 1, durationMs: expect.any(Number) }],
        ['call_a', { totalTokens: 250, toolUses: 2, durationMs: expect.any(Number) }],
        ['call_b', { totalTokens: 125, toolUses: 1, durationMs: expect.any(Number) }]
      ])
      const notes = of(out, 'task-notification').map((o) => o.notification)
      expect(
        notes.map((n) => [n.toolUseId, n.usage?.totalTokens, n.usage?.toolUses, n.runIndex])
      ).toEqual([
        ['call_a', 250, 2, 1],
        ['call_b', 125, 1, 2]
      ])
    })

    it('a grandchild’s steps are its own run: not summed into the child’s, parented on the child’s call', () => {
      const GRAND = 'ses_grand'
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        step('msg_c1', CHILD),
        ...tool('call_g', 'subagent', { agent: 'general', description: 'inner' }, CHILD, 'msg_c1'),
        announce(GRAND, CHILD),
        ev('session.tool.progress', {
          sessionID: CHILD,
          assistantMessageID: 'msg_c1',
          id: 'call_g',
          metadata: { sessionID: GRAND, status: 'running' }
        }),
        ...childStep('msg_g1', 'g1', 'read', GRAND),
        ev('session.step.ended', {
          sessionID: CHILD,
          assistantMessageID: 'msg_c1',
          finish: 'tool-calls',
          cost: 0.01,
          tokens: TOKENS
        })
      )
      expect(started(out).map((d) => [d.toolUseId, d.taskId])).toEqual([
        ['call_a', CHILD],
        ['call_g', GRAND]
      ])
      const progress = of(out, 'task-progress').map((o) => o.progress)
      expect(
        progress.map((p) => [
          p.toolUseId,
          p.parentToolUseId,
          p.usage?.totalTokens,
          p.usage?.toolUses
        ])
      ).toEqual([
        // The grandchild's step: owned by the child's call, run under its own.
        ['call_g', 'call_a', 125, 1],
        // The child's own step: its one tool is the `subagent` call, none of the grandchild's.
        ['call_a', null, 125, 1]
      ])
    })

    it('a background child’s end is its notification: flagged, summarised by its last words, usage of the run', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', { background: true }),
        result('call_a', 'running'),
        ev('session.execution.started', { sessionID: CHILD }, 20_000),
        ...childStep('msg_c1', 'c1'),
        ...childText(CHILD, 'msg_c2'),
        ev('session.execution.succeeded', { sessionID: CHILD }, 20_500)
      )
      expect(mapper.hasLiveBackgroundChild()).toBe(false)
      expect(of(out, 'task-notification').map((o) => o.notification)).toEqual([
        {
          taskId: CHILD,
          toolUseId: 'call_a',
          status: 'completed',
          outputFile: '',
          summary: 'hi',
          runIndex: 1,
          isBackgrounded: true,
          usage: { totalTokens: 125, toolUses: 1, durationMs: expect.any(Number) }
        }
      ])
    })

    it('a long result is cut to 100 characters', () => {
      const out = map(
        step(),
        announce(),
        ...call('call_a', {}),
        result('call_a', 'completed', CHILD, 'y'.repeat(300))
      )
      expect(of(out, 'task-notification')[0].notification.summary).toBe('y'.repeat(100))
    })

    it('child work is pending while a child runs or its report waits in the own inbox (dispatch settlement)', () => {
      const reportItem = (child = CHILD) => ({
        type: 'synthetic',
        delivery: 'steer',
        payload: {
          text: `<subagent sessionID="${child}" state="completed" description="d">\nx\n</subagent>`
        }
      })
      expect(mapper.childWorkPending()).toBe(false)
      map(step(), announce(), ...call('call_a', {}), result('call_a', 'running'))
      expect(mapper.childWorkPending()).toBe(true)
      map(
        ev('session.execution.started', { sessionID: CHILD }),
        ev('session.execution.succeeded', { sessionID: CHILD })
      )
      // Ended, but its report is admitted and not read yet.
      map(ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_r', item: reportItem() }))
      expect(mapper.childWorkPending()).toBe(true)
      map(ev('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_r' }))
      expect(mapper.childWorkPending()).toBe(false)
      // Other synthetic items (reminders, notices) and a child's own inbox are no child work.
      map(
        ev('session.inbox.enqueued', {
          sessionID: SID,
          inboxID: 'msg_n',
          item: { type: 'synthetic', delivery: 'steer', payload: { text: '<system-reminder>' } }
        }),
        ev('session.inbox.enqueued', {
          sessionID: CHILD,
          inboxID: 'msg_c',
          item: reportItem('ses_g')
        })
      )
      expect(mapper.childWorkPending()).toBe(false)
    })

    it('every linked child is held until its notification', () => {
      expect(mapper.hasLiveBackgroundChild()).toBe(false)
      map(step(), announce('ses_a'), ...call('call_a', {}, 'ses_a'))
      map(announce('ses_b'), ...call('call_b', {}, 'ses_b'))
      expect(mapper.hasLiveBackgroundChild()).toBe(true)
      map(
        ev('session.execution.started', { sessionID: 'ses_a' }),
        ev('session.execution.succeeded', { sessionID: 'ses_a' })
      )
      // ses_b still runs.
      expect(mapper.hasLiveBackgroundChild()).toBe(true)
      map(
        ev('session.execution.started', { sessionID: 'ses_b' }),
        ev('session.execution.failed', {
          sessionID: 'ses_b',
          error: { type: 'unknown', message: 'x' }
        })
      )
      expect(mapper.hasLiveBackgroundChild()).toBe(false)
    })

    // 2.3.0 reports every idle round of a child to its parent (`<subagent … state="running">`
    // while the child's own background work still runs, `completed` after the last round):
    // a round after the run's end is that run again.
    describe('a later round of an ended run (the child woke again under the same call)', () => {
      const ended = (session = CHILD) => ev('session.execution.succeeded', { sessionID: session })
      const running = (session = CHILD, at?: number) =>
        ev('session.execution.started', { sessionID: session }, at)
      const roundOne = () => [
        step(),
        announce(),
        ...call('call_a', {}),
        result('call_a', 'running'),
        running(CHILD, 20_000),
        ...childStep('msg_c1', 'c1', 'shell'),
        ...childText(CHILD, 'msg_c2'),
        ended()
      ]
      const roundTwo = () => [
        running(CHILD, 30_000),
        ...childStep('msg_c3', 'c3'),
        step('msg_c4', CHILD),
        ev('session.text.started', { sessionID: CHILD, assistantMessageID: 'msg_c4', ordinal: 0 }),
        ev('session.text.ended', {
          sessionID: CHILD,
          assistantMessageID: 'msg_c4',
          ordinal: 0,
          text: 'second round'
        }),
        ev('session.execution.succeeded', { sessionID: CHILD }, 31_000)
      ]

      it('re-arms the same run (clock, index), holds the idle timer, and is notified again with the later round', () => {
        const first = map(...roundOne())
        const [start] = started(first)
        expect(of(first, 'task-notification').map((o) => o.notification.summary)).toEqual(['hi'])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)

        const woke = map(running(CHILD, 30_000))
        expect(started(woke)).toEqual([start])
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
        expect(mapper.followedSessions()).toEqual([SID, CHILD])
        expect(mapper.stopRun('call_a')?.sessions).toEqual([CHILD])
      })

      it('the later round’s steps report progress and its end carries the whole run', () => {
        map(...roundOne())
        const out = map(...roundTwo())
        expect(of(out, 'task-progress').map((o) => o.progress.usage?.totalTokens)).toEqual([250])
        expect(of(out, 'task-notification').map((o) => o.notification)).toEqual([
          {
            taskId: CHILD,
            toolUseId: 'call_a',
            status: 'completed',
            outputFile: '',
            summary: 'second round',
            runIndex: 1,
            isBackgrounded: true,
            usage: { totalTokens: 250, toolUses: 2, durationMs: expect.any(Number) }
          }
        ])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
      })

      it('a reconnect that finds the ended child active again re-arms its run', () => {
        map(...roundOne())
        const out = mapper.reconcile({
          sessions: {
            [SID]: { messages: [], permissions: [], forms: [], inbox: [] },
            [CHILD]: { messages: [], permissions: [], forms: [] }
          },
          active: { [CHILD]: { type: 'running' } }
        })
        expect(started(out).map((d) => [d.toolUseId, d.runIndex])).toEqual([['call_a', 1]])
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
      })

      it('a stopped child that wakes is stopped again, not re-armed', () => {
        map(step(), announce(), ...call('call_a', {}), running())
        mapper.stopRun('call_a')
        map(ev('session.execution.interrupted', { sessionID: CHILD, reason: 'user' }))
        const out = map(running())
        expect(of(out, 'reinterrupt')).toHaveLength(1)
        expect(started(out)).toEqual([])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
      })

      it('a child a later call took over runs under that call: the earlier run stays settled', () => {
        map(...roundOne(), ...call('call_b', { sessionID: CHILD }))
        const out = map(running(CHILD, 30_000))
        expect(started(out)).toEqual([])
        expect(mapper.stopRun('call_a')).toBeNull()
        expect(mapper.stopRun('call_b')?.sessions).toEqual([CHILD])
      })

      it('the own session starting again is a turn, never a run', () => {
        map(...roundOne())
        expect(kinds(map(running(SID)))).toEqual(['turn-start'])
      })

      /** The child's report to its parent's inbox (`subagent-report.ts`), as the feed admits it. */
      const report = (id: string, state: string, parent = SID, child = CHILD) =>
        ev('session.inbox.enqueued', {
          sessionID: parent,
          inboxID: id,
          item: {
            type: 'synthetic',
            delivery: 'steer',
            payload: {
              text: `<subagent sessionID="${child}" state="${state}" description="d">\nx\n</subagent>`,
              description: 'd',
              metadata: { source: 'subagent', childID: child, agent: 'general', state: 'completed' }
            }
          }
        })

      it('a run a `running` report re-armed is no child work while its child sits idle (dispatch settlement)', () => {
        map(...roundOne(), report('msg_r1', 'running'))
        map(ev('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_r1' }))
        // The card's run is live and holds the idle timer (ADR-111 §3)…
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
        // …but nothing executes and no report waits: a waiting answer is not coming.
        expect(mapper.childWorkPending()).toBe(false)
        // Its own background work wakes it: that round is child work until it ends.
        map(running(CHILD, 30_000))
        expect(mapper.childWorkPending()).toBe(true)
        map(ended())
        expect(mapper.childWorkPending()).toBe(false)
      })

      it('a give-up settles an idle re-armed run `stopped` and latches its child; a running one is left to its end', () => {
        map(...roundOne(), report('msg_r1', 'running'))
        const settled = mapper.settleGiveUp([CHILD])
        expect(
          settled.map(
            (o) =>
              o.kind === 'task-notification' && [o.notification.status, o.notification.runIndex]
          )
        ).toEqual([['stopped', 1]])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
        // Its background work wakes it later: interrupted again, never re-armed.
        const woke = map(running(CHILD, 40_000), report('msg_r2', 'running'))
        expect(of(woke, 'reinterrupt')).toEqual([{ kind: 'reinterrupt', sessionID: CHILD }])
        expect(started(woke)).toEqual([])
        // A child still executing is left to its own (interrupted) end.
        mapper = new OpencodeEventMapper({ sessionID: SID })
        map(step(), announce(), ...call('call_a', {}), result('call_a', 'running'), running())
        expect(mapper.settleGiveUp([CHILD])).toEqual([])
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
      })

      it('a `running` report re-arms the run at once: the child waits on its own work, the timer is held', () => {
        map(...roundOne())
        const out = map(report('msg_r1', 'running'))
        expect(started(out).map((d) => [d.toolUseId, d.runIndex])).toEqual([['call_a', 1]])
        expect(mapper.hasLiveBackgroundChild()).toBe(true)
        // The wake that follows is that run: not announced again.
        const second = map(...roundTwo(), report('msg_r2', 'completed'))
        expect(started(second)).toEqual([])
        expect(of(second, 'task-notification').map((o) => o.notification.summary)).toEqual([
          'second round'
        ])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
      })

      it('a final report, a replayed one and an unknown child’s change nothing', () => {
        map(...roundOne())
        expect(
          map(report('msg_r1', 'completed'), report('msg_x', 'running', SID, 'ses_x'))
        ).toEqual([
          {
            kind: 'inbox',
            change: 'enqueued',
            inboxID: 'msg_r1',
            delivery: 'steer',
            item: expect.anything()
          },
          expect.objectContaining({ inboxID: 'msg_x' })
        ])
        map(report('msg_r2', 'running'), ...roundTwo())
        // A re-read replays the delivered reports: applied once.
        const read = mapper.reconcile({
          sessions: {
            [SID]: {
              messages: [
                {
                  id: 'msg_r2',
                  type: 'synthetic',
                  text: `<subagent sessionID="${CHILD}" state="running" description="d">\nx\n</subagent>`,
                  time: { created: 1 }
                } as unknown as Session_Message_Info
              ],
              permissions: [],
              forms: [],
              inbox: []
            }
          },
          active: {}
        })
        expect(started(read)).toEqual([])
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
      })

      it('a report to a CHILD (its grandchild’s) re-arms the grandchild’s run', () => {
        const GRAND = 'ses_grand'
        map(
          ...roundOne(),
          ev('session.execution.started', { sessionID: CHILD }),
          step('msg_c5', CHILD),
          ...tool('call_g', 'subagent', { agent: 'general' }, CHILD, 'msg_c5'),
          announce(GRAND, CHILD),
          ev('session.tool.progress', {
            sessionID: CHILD,
            assistantMessageID: 'msg_c5',
            id: 'call_g',
            metadata: { sessionID: GRAND, status: 'running' }
          }),
          running(GRAND),
          ended(GRAND)
        )
        const out = map(report('msg_rg', 'running', CHILD, GRAND))
        expect(started(out).map((d) => d.toolUseId)).toEqual(['call_g'])
      })

      it('a Stop of a child idle between rounds settles it at once; its later wake is stopped again', () => {
        map(...roundOne(), report('msg_r1', 'running'))
        const plan = mapper.stopRun('call_a')
        expect(plan?.sessions).toEqual([CHILD])
        // The interrupt of an idle session ends nothing upstream: the host settles it.
        const settled = mapper.settleIdleStops(plan!.sessions)
        expect(settled.map((o) => o.kind === 'task-notification' && o.notification.status)).toEqual(
          ['stopped']
        )
        expect(mapper.hasLiveBackgroundChild()).toBe(false)
        // Its background work wakes it later: stopped again, never re-armed.
        const woke = map(running(), report('msg_r2', 'running'))
        expect(of(woke, 'reinterrupt')).toHaveLength(1)
        expect(started(woke)).toEqual([])
        // A running child is left to its own end.
        mapper = new OpencodeEventMapper({ sessionID: SID })
        map(step(), announce(), ...call('call_a', {}), running())
        expect(mapper.settleIdleStops(mapper.stopRun('call_a')!.sessions)).toEqual([])
      })

      it('a later round wholly inside a feed gap is that run’s: re-read, it is notified with that round', () => {
        map(...roundOne())
        const rows: Session_Message_Info[] = [
          {
            id: 'msg_c4',
            type: 'assistant',
            agent: 'general',
            model: MODEL,
            content: [{ type: 'text', text: 'second round' }],
            time: { created: 30_100, completed: 30_200 }
          } as Session_Message_Info,
          { id: 'msg_idle2', type: 'idle', outcome: 'succeeded', time: { created: 31_000 } }
        ]
        const out = mapper.reconcile({
          sessions: { [CHILD]: { messages: rows, permissions: [], forms: [] } },
          active: {}
        })
        expect(started(out).map((d) => d.toolUseId)).toEqual(['call_a'])
        expect(of(out, 'task-notification').map((o) => o.notification.summary)).toEqual([
          'second round'
        ])
      })
    })

    it('after a reopen (seed) a resume continues the run count from the stored runs', () => {
      const run = (id: string, ran: number) => ({
        type: 'tool' as const,
        id,
        name: 'subagent',
        state: {
          status: 'completed' as const,
          input: { agent: 'general' },
          content: [{ type: 'text' as const, text: 'ok' }] as [{ type: 'text'; text: string }],
          metadata: { sessionID: CHILD, status: 'completed' }
        },
        time: { created: ran - 1, ran }
      })
      const row = (
        id: string,
        created: number,
        ...content: ReturnType<typeof run>[]
      ): Session_Message_Info => ({
        id,
        type: 'assistant',
        agent: 'build',
        model: MODEL,
        content,
        time: { created, completed: created + 1 }
      })
      mapper = new OpencodeEventMapper({ sessionID: SID })
      mapper.seed([
        row('msg_old1', 100, run('call_old1', 101)),
        row('msg_old2', 200, run('call_old2', 201))
      ])
      // Seeding follows nothing and says nothing.
      expect(mapper.followedSessions()).toEqual([SID])
      const out = map(
        step(),
        announce(),
        ...call('call_new', { sessionID: CHILD }),
        result('call_new')
      )
      expect(started(out)[0]).toMatchObject({ toolUseId: 'call_new', runIndex: 3 })
      expect(of(out, 'task-notification')[0].notification.runIndex).toBe(3)
    })

    it('steps a re-read lands behind a notification refresh it once, with the fuller usage', () => {
      const own = (rows: Session_Message_Info[]) => ({
        sessions: { [SID]: { messages: rows, permissions: [], forms: [] } },
        active: {}
      })
      const callRow: Session_Message_Info = {
        id: 'msg_p',
        type: 'assistant',
        agent: 'build',
        model: MODEL,
        time: { created: 100, completed: 200 },
        content: [
          {
            type: 'tool',
            id: 'call_a',
            name: 'subagent',
            state: {
              status: 'completed',
              input: { agent: 'general' },
              content: [
                {
                  type: 'text',
                  text: '<subagent sessionID="ses_child" state="completed">\nfine\n</subagent>'
                }
              ],
              metadata: { sessionID: CHILD, status: 'completed' }
            },
            time: { created: 100, ran: 101, completed: 190 }
          }
        ]
      }
      const childRow: Session_Message_Info = {
        id: 'msg_c',
        type: 'assistant',
        agent: 'general',
        model: MODEL,
        time: { created: 120, completed: 150 },
        cost: 0.01,
        tokens: TOKENS,
        content: [
          {
            type: 'tool',
            id: 'c1',
            name: 'read',
            state: {
              status: 'completed',
              input: {},
              content: [{ type: 'text', text: 'x' }],
              metadata: {}
            },
            time: { created: 121 }
          }
        ]
      }
      const first = mapper.reconcile(own([callRow]))
      expect(of(first, 'task-notification')).toHaveLength(1)
      expect(of(first, 'task-notification')[0].notification.usage?.totalTokens).toBe(0)
      const second = mapper.reconcile({
        sessions: { [CHILD]: { messages: [childRow], permissions: [], forms: [] } },
        active: {}
      })
      const again = of(second, 'task-notification').map((o) => o.notification)
      expect(again).toHaveLength(1)
      expect(again[0]).toMatchObject({
        toolUseId: 'call_a',
        status: 'completed',
        usage: { totalTokens: 125, toolUses: 1, durationMs: 89 }
      })
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

  // 2.3.0: a child reports every idle round to its parent as a SYNTHETIC inbox item
  // (`subagent-report.ts`); `state="running"` while its own background work still runs.
  it.each(['running', 'completed', 'cancelled'])(
    'a child’s `<subagent state="%s">` report is never a user message, live or re-read',
    (state) => {
      const report = {
        type: 'synthetic' as const,
        delivery: 'steer' as const,
        payload: {
          text: `<subagent sessionID="${CHILD}" state="${state}" description="d">\nhi\n</subagent>`,
          description: 'd',
          metadata: { source: 'subagent', childID: CHILD, agent: 'general', state: 'completed' }
        }
      }
      const live = map(
        ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_rep', item: report }),
        ev('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_rep' })
      )
      expect(kinds(live)).toEqual(['inbox', 'inbox'])
      const read = mapper.reconcile({
        sessions: {
          [SID]: {
            messages: [
              {
                id: 'msg_rep2',
                type: 'synthetic',
                text: report.payload.text,
                time: { created: 5 }
              } as unknown as Session_Message_Info
            ],
            permissions: [],
            forms: [],
            inbox: [{ id: 'msg_rep3', ...report } as never]
          }
        },
        active: {}
      })
      expect(read.filter((o) => o.kind === 'user-message' || o.kind === 'message')).toEqual([])
    }
  )

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

  // session-event.ts `Moved` = `session.moved` + `Session.Inbox.MovePayload` fields
  // ({location:{directory}, projectID, subpath?}); `session_move` and the TUI both emit it.
  it('session.moved of the own session reports where it works now; a foreign one is ignored', () => {
    const moved = {
      location: { directory: 'C:/data/opencode/worktree/abcdef/brave-fox' },
      projectID: 'prj_x',
      subpath: ''
    }
    expect(
      map(
        ev('session.moved', { sessionID: SID, ...moved }),
        ev('session.moved', { sessionID: 'ses_foreign', ...moved })
      )
    ).toEqual([{ kind: 'session-moved', directory: 'C:/data/opencode/worktree/abcdef/brave-fox' }])
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

  it('a turn end retracts the cards of a child that is not running, not a running child’s', () => {
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

  // 2.3.0: `session.generate` (ClaudeUI's `/btw` on the chat's own session) publishes
  // `session.usage.recorded {source:'generate'}`, folded into the cumulative only.
  it('a `generate` (`/btw`) is counted once: while idle at once, mid-turn at the turn’s end', () => {
    const tokens = (input: number, output: number) => ({
      input,
      output,
      reasoning: 0,
      cache: { read: 0, write: 0 }
    })
    const stepTokens = tokens(100, 20)
    const btw = tokens(40, 10)
    const out = map(
      ev('session.execution.started', { sessionID: SID }),
      step(),
      ev('session.step.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        finish: 'stop',
        cost: 0.1,
        tokens: stepTokens
      }),
      ev('session.usage.updated', { sessionID: SID, cost: 0.1, tokens: stepTokens }),
      ev('session.execution.succeeded', { sessionID: SID }),
      // Idle: a `/btw`.
      ev('session.usage.updated', { sessionID: SID, cost: 0.15, tokens: tokens(140, 30) }),
      // A turn, and a `/btw` asked while it runs.
      ev('session.execution.started', { sessionID: SID }),
      ev('session.usage.updated', { sessionID: SID, cost: 0.2, tokens: tokens(180, 40) }),
      step('msg_a2'),
      ev('session.step.ended', {
        sessionID: SID,
        assistantMessageID: 'msg_a2',
        finish: 'stop',
        cost: 0.1,
        tokens: stepTokens
      }),
      ev('session.usage.updated', { sessionID: SID, cost: 0.3, tokens: tokens(280, 60) }),
      ev('session.execution.succeeded', { sessionID: SID }),
      ev('session.usage.updated', { sessionID: SID, cost: 0.3, tokens: tokens(280, 60) })
    )
    const overhead = of(out, 'overhead-usage')
    expect(overhead.map((o) => o.tokens)).toEqual([btw, btw])
    expect(overhead.map((o) => o.cost)).toEqual([
      expect.closeTo(0.05, 10),
      expect.closeTo(0.05, 10)
    ])
    // The mid-turn one waits for the turn's end.
    expect(kinds(out).slice(-3, -1)).toEqual(['overhead-usage', 'result'])
  })

  it('seed(…, sessionTotals): what the cold line counted is not reported again', () => {
    const totals = { cost: 1, tokens: TOKENS }
    mapper.seed([], { sessionTotals: totals })
    expect(
      map(ev('session.usage.updated', { sessionID: SID, ...totals })).map((o) => o.kind)
    ).toEqual(['session-usage'])
  })

  // 2.3.2 writes the compaction summary in the BACKGROUND by default (`compaction.background`,
  // `core/src/session/compaction.ts` `precompute`): its request is billed when it finishes,
  // usually after the turn ended (`session.usage.recorded {source:'compaction'}` → the idle
  // `session.usage.updated`, reported as overhead at once), and the compaction that later swaps
  // it in carries the same figures again on `compaction.ended` (`usePrecomputed` → `addSpent`).
  describe('a background compaction summary is counted once', () => {
    const tokens = (input: number, output: number) => ({
      input,
      output,
      reasoning: 0,
      cache: { read: 0, write: 0 }
    })
    const stepTokens = tokens(100, 20)
    const summary = tokens(120, 30)
    /** Everything the outputs count: steps, compactions and overhead. */
    const counted = (out: readonly OpencodeMapperOutput[]) => {
      let cost = 0
      let input = 0
      let output = 0
      for (const o of out) {
        const u =
          o.kind === 'step-usage'
            ? o.usage
            : o.kind === 'overhead-usage'
              ? o
              : o.kind === 'compaction'
                ? o.usage
                : undefined
        if (!u) continue
        cost += u.cost
        input += u.tokens.input
        output += u.tokens.output
      }
      return { cost, input, output }
    }
    const turn = (id: string, cumulative: { cost: number; tokens: TokenUsage_Info }) => [
      step(id),
      ev('session.step.ended', {
        sessionID: SID,
        assistantMessageID: id,
        finish: 'stop',
        cost: 0.1,
        tokens: stepTokens
      }),
      ev('session.usage.updated', { sessionID: SID, ...cumulative })
    ]
    const swapped = [
      ev('session.compaction.started', { sessionID: SID, reason: 'auto' }),
      ev('session.compaction.ended', {
        sessionID: SID,
        reason: 'auto',
        text: '## Objective\nx',
        cost: 0.03,
        tokens: summary,
        model: MODEL
      })
    ]

    it('billed while idle: reported as overhead then, and the swap adds nothing', () => {
      const out = map(
        ev('session.execution.started', { sessionID: SID }),
        ...turn('msg_a1', { cost: 0.1, tokens: stepTokens }),
        ev('session.execution.succeeded', { sessionID: SID }),
        // The background summary finishes after the turn.
        ev('session.usage.updated', { sessionID: SID, cost: 0.13, tokens: tokens(220, 50) }),
        // The next prompt is due for compaction: the held summary is swapped in.
        ev('session.execution.started', { sessionID: SID }),
        ...swapped,
        ...turn('msg_a2', { cost: 0.23, tokens: tokens(320, 70) }),
        ev('session.execution.succeeded', { sessionID: SID })
      )
      // Counted exactly what opencode billed the session (its cumulative).
      const total = counted(out)
      expect(total.cost).toBeCloseTo(0.23, 10)
      expect([total.input, total.output]).toEqual([320, 70])
      expect(of(out, 'overhead-usage').map((o) => o.tokens)).toEqual([summary])
      // The compaction itself still shows: its separator row and its end.
      const ended = of(out, 'compaction').find((o) => o.phase === 'ended')
      expect(ended).toMatchObject({ reason: 'auto' })
      expect(ended?.usage).toBeUndefined()
      expect(
        of(out, 'message').some((o) => o.message.content[0]?.type === 'compact_separator')
      ).toBe(true)
    })

    it('billed mid-turn (not yet reported): the swap counts it, once', () => {
      const out = map(
        ev('session.execution.started', { sessionID: SID }),
        ...turn('msg_a1', { cost: 0.1, tokens: stepTokens }),
        // Started before a step, finished while the turn still runs.
        ev('session.usage.updated', { sessionID: SID, cost: 0.13, tokens: tokens(220, 50) }),
        ...swapped,
        ...turn('msg_a2', { cost: 0.23, tokens: tokens(320, 70) }),
        ev('session.execution.succeeded', { sessionID: SID })
      )
      const total = counted(out)
      expect(total.cost).toBeCloseTo(0.23, 10)
      expect([total.input, total.output]).toEqual([320, 70])
      expect(of(out, 'overhead-usage')).toEqual([])
      expect(of(out, 'compaction').find((o) => o.phase === 'ended')?.usage).toEqual({
        cost: 0.03,
        tokens: summary,
        model: MODEL
      })
    })

    it('a foreground compaction keeps its usage, a title reported earlier notwithstanding', () => {
      const out = map(
        ev('session.execution.started', { sessionID: SID }),
        ...turn('msg_a1', { cost: 0.1, tokens: stepTokens }),
        ev('session.execution.succeeded', { sessionID: SID }),
        // A title (or `/btw`) billed while idle: overhead.
        ev('session.usage.updated', { sessionID: SID, cost: 0.13, tokens: tokens(220, 50) }),
        // `/compact`: the summary streams inside the execution, billed before it ends.
        ev('session.execution.started', { sessionID: SID }),
        ev('session.compaction.started', { sessionID: SID, reason: 'manual', inputID: 'msg_c' }),
        ev('session.usage.updated', { sessionID: SID, cost: 0.16, tokens: tokens(340, 80) }),
        ev('session.compaction.ended', {
          sessionID: SID,
          reason: 'manual',
          text: '## Objective\nx',
          cost: 0.03,
          tokens: summary,
          model: MODEL
        }),
        ev('session.execution.succeeded', { sessionID: SID })
      )
      const total = counted(out)
      expect(total.cost).toBeCloseTo(0.16, 10)
      expect([total.input, total.output]).toEqual([340, 80])
      expect(of(out, 'compaction').find((o) => o.phase === 'ended')?.usage).toEqual({
        cost: 0.03,
        tokens: summary,
        model: MODEL
      })
    })

    it('a summary the cold line already counted (a resume) is not counted again when swapped in', () => {
      mapper.seed([], { sessionTotals: { cost: 0.13, tokens: tokens(220, 50) } })
      const out = map(
        ev('session.execution.started', { sessionID: SID }),
        ...swapped,
        ...turn('msg_a2', { cost: 0.23, tokens: tokens(320, 70) }),
        ev('session.execution.succeeded', { sessionID: SID })
      )
      // Only the new step: the seed covered everything up to the resume.
      const total = counted(out)
      expect(total.cost).toBeCloseTo(0.1, 10)
      expect([total.input, total.output]).toEqual([100, 20])
    })
  })
})

describe('the model a step ran on', () => {
  it('rides on every message the step produces, as providerID/id with the variant dropped', () => {
    const out = map(
      step(MSG, SID, {
        providerID: 'openrouter',
        id: 'anthropic/claude-haiku-4.5',
        variant: 'high'
      }),
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'a' }),
      ev('session.text.ended', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'a' }),
      ...tool('c1', 'shell', { command: 'ls' })
    )
    const messages = out.flatMap((o) =>
      o.kind === 'item-open'
        ? [o.open.message]
        : o.kind === 'item-seal'
          ? [o.seal.message]
          : o.kind === 'message'
            ? [o.message]
            : []
    )
    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(messages.map((m) => m.model)).toEqual(
      messages.map(() => 'openrouter/anthropic/claude-haiku-4.5')
    )
  })

  it('leaves the field off a message whose step never reported one', () => {
    const out = map(
      ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'a' })
    )
    const [open] = of(out, 'item-open')
    expect(open.open.message).not.toHaveProperty('model')
  })
})

describe('a user Stop on one subagent (stopRun)', () => {
  const GRAND = 'ses_grand'
  const OTHER = 'ses_other'
  const CMSG = 'msg_c1'
  const announce = (child: string, parent: string) =>
    ev('session.created', {
      sessionID: child,
      parentID: parent,
      projectID: 'p',
      location: { directory: '/ws' },
      slug: 's',
      version: '2.1.2'
    })
  /** A subagent call made in `session` (whose step message is `msg`) that runs `child`. */
  const spawn = (
    callID: string,
    child: string,
    input: Record<string, unknown> = {},
    session = SID,
    msg = MSG
  ) => [
    ...(session === SID ? [] : [step(msg, session)]),
    ...tool(
      callID,
      'subagent',
      { agent: 'general', description: `d ${callID}`, ...input },
      session,
      msg
    ),
    announce(child, session),
    ev('session.tool.progress', {
      sessionID: session,
      assistantMessageID: msg,
      id: callID,
      metadata: { sessionID: child, status: 'running' }
    })
  ]
  const running = (session: string) => ev('session.execution.started', { sessionID: session })
  const interrupted = (session: string) =>
    ev('session.execution.interrupted', { sessionID: session, reason: 'user' })
  const callFailed = (callID: string, message = 'Subagent cancelled (sessionID: ses_child)') =>
    ev('session.tool.failed', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      error: { type: 'unknown', message },
      executed: false
    })
  const callOk = (callID: string, child = CHILD) =>
    ev('session.tool.success', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      content: [
        { type: 'text', text: `<subagent sessionID="${child}" state="completed">\nhi\n</subagent>` }
      ],
      metadata: { sessionID: child, status: 'completed' },
      executed: false
    })
  /** The call came back `running`: the child is a background run. */
  const background = (callID: string, child: string, session = SID) =>
    ev('session.tool.success', {
      sessionID: session,
      assistantMessageID: session === SID ? MSG : CMSG,
      id: callID,
      content: [{ type: 'text', text: 'running' }],
      metadata: { sessionID: child, status: 'running' },
      executed: false
    })
  const notes = (out: readonly OpencodeMapperOutput[], callID?: string) =>
    of(out, 'task-notification')
      .map((o) => o.notification)
      .filter((n) => callID === undefined || n.toolUseId === callID)
  const relink = (callID: string, child: string) => [
    ...tool(callID, 'subagent', { agent: 'general', sessionID: child }),
    ev('session.tool.progress', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callID,
      metadata: { sessionID: child, status: 'running' }
    })
  ]

  it('has nothing to stop for an unknown call, a finished run, or a run a later call took over', () => {
    map(step(), running(SID), ...spawn('call_a', CHILD), running(CHILD))
    expect(mapper.stopRun('call_nope')).toBeNull()
    map(callOk('call_a'))
    expect(mapper.stopRun('call_a')).toBeNull()
    // Steered: the earlier call's run is settled by the later one.
    mapper = new OpencodeEventMapper({ sessionID: SID })
    map(step(), ...spawn('call_a', CHILD, { background: true }), running(CHILD))
    map(...relink('call_b', CHILD))
    expect(mapper.stopRun('call_a')).toBeNull()
    expect(mapper.stopRun('call_b')?.sessions).toEqual([CHILD])
  })

  it('a run the user stopped is notified `stopped`, not `failed`, once', () => {
    const failedEnd = ev('session.execution.failed', {
      sessionID: CHILD,
      error: { type: 'unknown', message: 'aborted' }
    })
    const control = map(
      step(),
      ...spawn('call_a', CHILD),
      background('call_a', CHILD),
      running(CHILD),
      failedEnd
    )
    expect(notes(control, 'call_a')).toMatchObject([{ status: 'failed' }])

    mapper = new OpencodeEventMapper({ sessionID: SID })
    map(
      step(),
      running(SID),
      ...spawn('call_a', CHILD),
      background('call_a', CHILD),
      running(CHILD)
    )
    expect(mapper.stopRun('call_a')?.sessions).toEqual([CHILD])
    const out = map(
      ev('session.execution.failed', { sessionID: CHILD, error: { type: 'unknown', message: 'x' } })
    )
    expect(notes(out, 'call_a')).toMatchObject([{ status: 'stopped', taskId: CHILD }])
    expect(notes(out)).toHaveLength(1)
  })

  it('a natural completion that beat the Stop stays `completed` (the mark only applies to a non-ok end)', () => {
    map(step(), ...spawn('call_a', CHILD), running(CHILD))
    expect(mapper.stopRun('call_a')).not.toBeNull()
    expect(notes(map(callOk('call_a')), 'call_a')).toMatchObject([{ status: 'completed' }])
  })

  it('a stopped background child delivers its cancelled end as `stopped`, once', () => {
    map(
      step(),
      running(SID),
      ...spawn('call_a', CHILD, { background: true }),
      background('call_a', CHILD),
      running(CHILD)
    )
    expect(mapper.hasLiveBackgroundChild()).toBe(true)
    expect(mapper.stopRun('call_a')?.sessions).toEqual([CHILD])
    const out = map(interrupted(CHILD))
    expect(notes(out)).toMatchObject([
      { toolUseId: 'call_a', status: 'stopped', isBackgrounded: true }
    ])
    expect(mapper.hasLiveBackgroundChild()).toBe(false)
  })

  it('stops the child and every live descendant, deepest first; never a sibling or the parent', () => {
    map(
      step(),
      running(SID),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_o', OTHER),
      running(OTHER),
      // C's background grandchild G, and G's own child H.
      ...spawn('call_g', GRAND, { background: true }, CHILD, CMSG),
      running(GRAND),
      ...spawn('call_h', 'ses_h', {}, GRAND, 'msg_g1'),
      running('ses_h')
    )
    expect(mapper.stopRun('call_c')?.sessions).toEqual(['ses_h', GRAND, CHILD])
    // The sibling is untouched: stopping it is its own plan.
    expect(mapper.stopRun('call_o')?.sessions).toEqual([OTHER])
    // A grandchild alone does not reach up.
    mapper = new OpencodeEventMapper({ sessionID: SID })
    map(
      step(),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_g', GRAND, {}, CHILD, CMSG),
      running(GRAND)
    )
    expect(mapper.stopRun('call_g')?.sessions).toEqual([GRAND])
  })

  it('leaves out a descendant that already ended', () => {
    map(
      step(),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_g', GRAND, {}, CHILD, CMSG),
      running(GRAND),
      ev('session.execution.succeeded', { sessionID: GRAND }),
      ev('session.tool.success', {
        sessionID: CHILD,
        assistantMessageID: CMSG,
        id: 'call_g',
        content: [
          {
            type: 'text',
            text: `<subagent sessionID="${GRAND}" state="completed">\nx\n</subagent>`
          }
        ],
        metadata: { sessionID: GRAND, status: 'completed' },
        executed: false
      })
    )
    expect(mapper.stopRun('call_c')?.sessions).toEqual([CHILD])
  })

  it('a stopped grandchild reads `stopped` in its own notification too', () => {
    map(
      step(),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_g', GRAND, { background: true }, CHILD, CMSG),
      background('call_g', GRAND, CHILD),
      running(GRAND)
    )
    mapper.stopRun('call_c')
    const out = map(interrupted(GRAND), interrupted(CHILD), callFailed('call_c'))
    expect(notes(out, 'call_g')).toMatchObject([{ status: 'stopped' }])
    expect(notes(out, 'call_c')).toMatchObject([{ status: 'stopped' }])
  })

  describe('the user-stopped latch', () => {
    it('a stopped child that starts executing again (a cancelled grandchild woke it) is interrupted again', () => {
      map(step(), ...spawn('call_c', CHILD), running(CHILD))
      mapper.stopRun('call_c')
      map(interrupted(CHILD))
      // The woken turn: asked to stop again, as often as it wakes.
      expect(of(map(running(CHILD)), 'reinterrupt')).toEqual([
        { kind: 'reinterrupt', sessionID: CHILD }
      ])
      map(interrupted(CHILD))
      expect(of(map(running(CHILD)), 'reinterrupt')).toHaveLength(1)
    })

    it('a child nobody stopped, and the own session, never get one', () => {
      map(step(), ...spawn('call_c', CHILD), running(CHILD))
      expect(of(map(interrupted(CHILD), running(CHILD), running(SID)), 'reinterrupt')).toEqual([])
    })

    it('a new call that links the child clears the latch (a resume is the model asking again)', () => {
      map(step(), ...spawn('call_c', CHILD), running(CHILD))
      mapper.stopRun('call_c')
      map(interrupted(CHILD), callFailed('call_c'))
      // opencode publishes the call's progress (the link) BEFORE it prompts the child.
      map(...relink('call_r', CHILD))
      expect(of(map(running(CHILD)), 'reinterrupt')).toEqual([])
    })

    it('a descendant is latched with the child', () => {
      map(
        step(),
        ...spawn('call_c', CHILD),
        running(CHILD),
        ...spawn('call_g', GRAND, { background: true }, CHILD, CMSG),
        running(GRAND)
      )
      mapper.stopRun('call_c')
      map(interrupted(GRAND), interrupted(CHILD))
      expect(of(map(running(GRAND)), 'reinterrupt')).toEqual([
        { kind: 'reinterrupt', sessionID: GRAND }
      ])
    })

    it('a reconnect that finds the stopped child active again asks to stop it again', () => {
      map(step(), ...spawn('call_c', CHILD), running(CHILD))
      mapper.stopRun('call_c')
      map(interrupted(CHILD))
      const out = mapper.reconcile({
        sessions: {
          [SID]: { messages: [], permissions: [], forms: [], inbox: [] },
          [CHILD]: { messages: [], permissions: [], forms: [] }
        },
        active: { [CHILD]: { type: 'running' } }
      })
      expect(of(out, 'reinterrupt')).toEqual([{ kind: 'reinterrupt', sessionID: CHILD }])
    })

    it('undo() takes the mark and the latch back (the interrupt could not be sent)', () => {
      map(step(), ...spawn('call_c', CHILD), running(CHILD))
      mapper.stopRun('call_c')?.undo()
      expect(of(map(interrupted(CHILD), running(CHILD)), 'reinterrupt')).toEqual([])
      expect(notes(map(callFailed('call_c')), 'call_c')).toMatchObject([{ status: 'failed' }])
    })
  })

  it('no approval card of the stopped subtree stays open once its executions end', () => {
    const ask = (id: string, session: string) =>
      ev('permission.asked', { id, sessionID: session, action: 'shell', resources: ['x'] })
    map(
      step(),
      running(SID),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_g', GRAND, { background: true }, CHILD, CMSG),
      background('call_g', GRAND, CHILD),
      running(GRAND),
      ask('per_c', CHILD),
      ask('per_g', GRAND),
      ask('per_own', SID)
    )
    mapper.stopRun('call_c')
    const out = map(interrupted(GRAND), interrupted(CHILD))
    expect(
      of(out, 'approval-resolved')
        .map((o) => o.requestId)
        .sort()
    ).toEqual(['per_c', 'per_g'])
  })
})
