/**
 * The opencode 2.x cold-history converter (ADR-097 S4) and the 2.x status-line
 * seed: stored `Session.Message` rows → the transcript and accounting a
 * reopened chat shows. Parity with the live mapper is `history-parity.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Session_Message_Info } from '../protocol-v2/openapi'
import {
  childSessionsOf,
  convertOpencodeHistory,
  MAX_HISTORY_CHILDREN,
  readOpencodeHistory
} from '../history'

vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { buildAccountRef: () => ({ billingType: 'api' }) }
}))
vi.mock('../model-discovery', () => ({ getOpencodeModelContextWindow: () => 1_000 }))

import {
  lastOpencodeModel,
  opencodeActiveDurationMs,
  opencodeHistorySeed,
  opencodeHistoryStatusLine
} from '../history-status-line'

type Assistant = Extract<Session_Message_Info, { type: 'assistant' }>
type Part = Assistant['content'][number]

const MODEL = { providerID: 'openai', id: 'gpt-x' }
const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }

const user = (id: string, created: number, text: string): Session_Message_Info => ({
  id,
  type: 'user',
  text,
  time: { created }
})
const assistant = (
  id: string,
  created: number,
  content: Part[],
  extra: Partial<Assistant> = {}
): Session_Message_Info => ({
  id,
  type: 'assistant',
  agent: 'build',
  model: MODEL,
  content,
  time: { created, completed: created + 10 },
  ...extra
})
const idle = (
  id: string,
  created: number,
  outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded'
): Session_Message_Info => ({ id, type: 'idle', outcome, time: { created } })
const subagent = (id: string, state: Extract<Part, { type: 'tool' }>['state']): Part => ({
  type: 'tool',
  id,
  name: 'subagent',
  state,
  time: { created: 1 }
})

describe('convertOpencodeHistory', () => {
  it('a step is one row: text / thinking / tool_use in order, then its results in call order', () => {
    const { messages } = convertOpencodeHistory([
      user('msg_u', 1, 'go'),
      assistant('msg_a', 2, [
        { type: 'reasoning', text: 'plan', time: { created: 2, completed: 7 } },
        { type: 'text', text: 'ok' },
        {
          type: 'tool',
          id: 'c1',
          name: 'shell',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            content: [{ type: 'text', text: 'a' }]
          },
          time: { created: 3 }
        },
        {
          type: 'tool',
          id: 'c2',
          name: 'edit',
          state: {
            status: 'error',
            input: { path: 'x' },
            error: { type: 'permission.rejected', message: 'User denied' }
          },
          time: { created: 4 }
        }
      ])
    ])
    expect(messages).toEqual([
      { id: 'msg_u', role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
      {
        id: 'msg_a',
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'thinking', text: 'plan', durationMs: 5 },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', toolUseId: 'c1', toolName: 'shell', toolInput: { command: 'ls' } },
          { type: 'tool_use', toolUseId: 'c2', toolName: 'edit', toolInput: { path: 'x' } },
          { type: 'tool_result', toolUseId: 'c1', toolResult: 'a', isError: false },
          { type: 'tool_result', toolUseId: 'c2', toolResult: 'User denied', isError: true }
        ]
      }
    ])
  })

  it('drops empty text/thinking, empty steps, and rows that carry no transcript', () => {
    const { messages } = convertOpencodeHistory([
      assistant('msg_e', 1, [
        { type: 'reasoning', text: '', time: { created: 1, completed: 2 } },
        { type: 'text', text: '' }
      ]),
      { id: 's', type: 'synthetic', text: 'note', time: { created: 2 } },
      { id: 'y', type: 'system', text: 'sys', time: { created: 3 } },
      { id: 'm', type: 'model-switched', model: MODEL, time: { created: 4 } },
      idle('i', 5, 'interrupted'),
      {
        id: 'c',
        type: 'compaction',
        status: 'failed',
        reason: 'auto',
        error: { type: 'x', message: 'y' },
        time: { created: 6 }
      },
      {
        id: 'r',
        type: 'compaction',
        status: 'running',
        reason: 'auto',
        summary: '',
        recent: '',
        time: { created: 7 }
      }
    ])
    expect(messages).toEqual([])
  })

  it('a completed compaction is a separator row with its summary', () => {
    expect(
      convertOpencodeHistory([
        {
          id: 'msg_k',
          type: 'compaction',
          status: 'completed',
          reason: 'manual',
          summary: '## Objective',
          recent: '',
          time: { created: 9 }
        }
      ]).messages
    ).toEqual([
      {
        id: 'msg_k',
        role: 'system',
        content: [{ type: 'compact_separator', text: '## Objective' }],
        timestamp: 9
      }
    ])
  })

  it('a still-streaming tool shows its card with no input and no result', () => {
    const { messages } = convertOpencodeHistory([
      assistant('msg_a', 1, [
        {
          type: 'tool',
          id: 'c',
          name: 'write',
          state: { status: 'streaming', input: '{"pa' },
          time: { created: 1 }
        }
      ])
    ])
    expect(messages[0].content).toEqual([
      { type: 'tool_use', toolUseId: 'c', toolName: 'write', toolInput: {} }
    ])
  })

  it('a subagent call: the child transcript under the call (no child prompt), one notification', () => {
    const rows = [
      assistant('msg_a', 1, [
        subagent('call_1', {
          status: 'completed',
          input: { agent: 'general' },
          content: [
            {
              type: 'text',
              text: '<subagent sessionID="ses_c" state="completed">\nfine\n</subagent>'
            }
          ],
          metadata: { sessionID: 'ses_c', status: 'completed' }
        })
      ])
    ]
    const child = [
      user('msg_cu', 2, 'You are a subagent'),
      assistant('msg_c', 3, [{ type: 'text', text: 'fine' }])
    ]
    const history = convertOpencodeHistory(rows, new Map([['ses_c', child]]))
    expect(history.messages[0].content.at(-1)).toEqual({
      type: 'tool_result',
      toolUseId: 'call_1',
      toolResult: 'fine',
      isError: false
    })
    expect(history.subagentMessages).toEqual({
      call_1: [
        { id: 'msg_c', role: 'assistant', content: [{ type: 'text', text: 'fine' }], timestamp: 3 }
      ]
    })
    expect(history.taskNotifications).toEqual([
      { taskId: 'ses_c', toolUseId: 'call_1', status: 'completed', outputFile: '', summary: '' }
    ])
  })

  it.each([
    [{ type: 'aborted', message: 'Tool execution aborted (sessionID: ses_c)' }, 'stopped'],
    [{ type: 'tool.execution', message: 'Subagent failed (sessionID: ses_c): boom' }, 'failed']
  ] as const)(
    'a subagent call that errored (%j) is `%s`, its child found from the message',
    (error, status) => {
      const rows = [
        assistant('msg_a', 1, [subagent('call_1', { status: 'error', input: {}, error })])
      ]
      expect(childSessionsOf(rows)).toEqual(['ses_c'])
      expect(convertOpencodeHistory(rows).taskNotifications[0]).toMatchObject({
        taskId: 'ses_c',
        status
      })
    }
  )

  it('a child RESUMED by a second call: each call shows its own run (as live re-links it)', () => {
    const call = (id: string, ran: number): Part => ({
      type: 'tool',
      id,
      name: 'subagent',
      state: {
        status: 'completed',
        input: { agent: 'general' },
        content: [{ type: 'text', text: 'ok' }],
        metadata: { sessionID: 'ses_c', status: 'completed' }
      },
      time: { created: ran - 1, ran }
    })
    const rows = [
      assistant('msg_a', 1, [call('call_1', 2)]),
      assistant('msg_b', 10, [call('call_2', 11)])
    ]
    const child = [
      user('msg_cu1', 3, 'first prompt'),
      assistant('msg_c1', 4, [{ type: 'text', text: 'first run' }]),
      idle('i1', 5),
      user('msg_cu2', 12, 'second prompt'),
      assistant('msg_c2', 13, [{ type: 'text', text: 'second run' }]),
      idle('i2', 14)
    ]
    const history = convertOpencodeHistory(rows, new Map([['ses_c', child]]))
    const texts = (call: string) =>
      history.subagentMessages[call]?.map((m) => (m.content[0] as { text: string }).text)
    expect(texts('call_1')).toEqual(['first run'])
    expect(texts('call_2')).toEqual(['second run'])
    expect(history.taskNotifications.map((n) => n.toolUseId)).toEqual(['call_1', 'call_2'])
  })

  it('a background call takes its child’s stored outcome, or `unfinished`', () => {
    const rows = [
      assistant('msg_a', 1, [
        subagent('call_1', {
          status: 'completed',
          input: { background: true },
          content: [{ type: 'text', text: 'working in the background' }],
          metadata: { sessionID: 'ses_c', status: 'running' }
        })
      ])
    ]
    expect(convertOpencodeHistory(rows).taskNotifications[0].status).toBe('unfinished')
    expect(
      convertOpencodeHistory(rows, new Map([['ses_c', [idle('i', 5, 'failed')]]]))
        .taskNotifications[0].status
    ).toBe('failed')
  })

  it('a session migrated from 1.x keeps `task` + `metadata.sessionId` and `apply_patch` files', () => {
    const rows = [
      assistant('msg_a', 1, [
        {
          type: 'tool',
          id: 'call_t',
          name: 'task',
          state: {
            status: 'completed',
            input: { subagent_type: 'general' },
            content: [{ type: 'text', text: 'task_id: ses_old' }],
            metadata: { sessionId: 'ses_old' }
          },
          time: { created: 1 }
        },
        {
          type: 'tool',
          id: 'call_p',
          name: 'apply_patch',
          state: {
            status: 'completed',
            input: {},
            content: [{ type: 'text', text: 'ok' }],
            metadata: {
              files: [
                { relativePath: 'a.ts', patch: '@@', type: 'update', additions: 1, deletions: 0 }
              ]
            }
          },
          time: { created: 2 }
        }
      ])
    ]
    expect(childSessionsOf(rows)).toEqual(['ses_old'])
    expect(convertOpencodeHistory(rows).messages[0].content.at(-1)).toMatchObject({
      toolUseId: 'call_p',
      fileDiffs: [{ path: 'a.ts', patch: '@@', changeType: 'update', additions: 1, deletions: 0 }]
    })
  })
})

describe('readOpencodeHistory', () => {
  const call = (child: string): Part =>
    subagent(`call_${child}`, {
      status: 'completed',
      input: {},
      content: [{ type: 'text', text: 'x' }],
      metadata: { sessionID: child }
    })

  it('reads children breadth-first, nested ones too, and skips one it cannot read', async () => {
    const store: Record<string, Session_Message_Info[]> = {
      ses_root: [assistant('a', 1, [call('ses_1'), call('ses_gone')])],
      ses_1: [assistant('b', 2, [call('ses_2')])],
      ses_2: [assistant('c', 3, [{ type: 'text', text: 'deep' }])]
    }
    const list = vi.fn(async (id: string) => {
      if (!store[id]) throw new Error('404')
      return store[id]
    })
    const { rows, children } = await readOpencodeHistory(list, 'ses_root')
    expect(rows).toBe(store.ses_root)
    expect([...children.keys()]).toEqual(['ses_1', 'ses_2'])
    const history = convertOpencodeHistory(rows, children)
    expect(Object.keys(history.subagentMessages).sort()).toEqual(['call_ses_1', 'call_ses_2'])
  })

  it('stops at MAX_HISTORY_CHILDREN', async () => {
    const many = Array.from({ length: MAX_HISTORY_CHILDREN + 5 }, (_, i) => call(`ses_${i}`))
    const list = vi.fn(async (id: string) =>
      id === 'root'
        ? [assistant('a', 1, many)]
        : [assistant(`m_${id}`, 2, [{ type: 'text', text: id }])]
    )
    const { children } = await readOpencodeHistory(list, 'root')
    expect(children.size).toBe(MAX_HISTORY_CHILDREN)
  })
})

describe('the 2.x status-line seed', () => {
  const rows: Session_Message_Info[] = [
    user('u1', 1_000, 'a'),
    assistant('a1', 1_100, [], { cost: 0.5, tokens: TOKENS }),
    idle('i1', 2_000),
    user('u2', 5_000, 'b'),
    assistant('a2', 5_100, [], {
      cost: 0.25,
      tokens: { input: 300, output: 10, reasoning: 0, cache: { read: 50, write: 0 } },
      model: { providerID: 'anthropic', id: 'claude-x' }
    }),
    // The compaction's own request is billed, but its prompt is not the context.
    {
      id: 'k',
      type: 'compaction',
      status: 'completed',
      reason: 'auto',
      summary: 's',
      recent: '',
      cost: 0.1,
      tokens: { input: 900, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 5_200 }
    },
    idle('i2', 5_600)
  ]

  it('sums steps and compactions, prices each on its own model, keeps the last step’s context', () => {
    const seed = opencodeHistorySeed(rows, { providerID: 'openai', modelID: 'gpt-x' })
    expect(seed.engineReportedCostUsd).toBeCloseTo(0.85, 10)
    expect(seed.tokens).toEqual({ input: 1_300, output: 40, cacheWrite: 2, cacheRead: 60 })
    expect(seed.lastContextLength).toBe(350)
    expect([...seed.modelCosts.keys()].sort()).toEqual(['claude-x', 'gpt-x'])
    expect(seed.totalDurationMs).toBe(1_000 + 600)
  })

  it('active time runs from a turn’s first row to its idle; an open turn to its last step', () => {
    expect(
      opencodeActiveDurationMs([
        user('u', 0, 'x'),
        assistant('a', 10, []),
        idle('i', 50),
        user('v', 100, 'y'),
        assistant('b', 110, [])
      ])
    ).toBe(50 + 20)
  })

  it('the line reports the seed; the last step names the model', () => {
    const line = opencodeHistoryStatusLine(rows, lastOpencodeModel(rows))
    expect(line).toMatchObject({
      totalInputTokens: 1_300,
      totalOutputTokens: 40,
      contextWindow: { used: 350, size: 1_000 },
      usedPercentage: 35,
      turnStartedAtMs: null
    })
    expect(lastOpencodeModel(rows)).toEqual({ providerID: 'anthropic', modelID: 'claude-x' })
    expect(lastOpencodeModel([user('u', 1, 'x')])).toEqual({ providerID: '', modelID: '' })
  })
})
