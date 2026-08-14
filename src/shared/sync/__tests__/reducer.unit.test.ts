/**
 * @vitest-environment node
 *
 * The shared reducer — SyncCore phase 4a item 4, invariants 5, 6 and 8.
 *
 * Every test here pins a semantic the RENDERER already implements, because 4a's
 * whole bet is that both interpretations agree; drift between them is what the
 * shadow harness hunts and what 4b's cutover would otherwise ship silently.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyEvent, emptyAux, checkDerivedFields, rekeyTargetFor } from '../reducer'
import { emptyCanonicalState, toSnapshot, type CanonicalState } from '../state'
import type { ChatMessage, SessionStatus, StatusLineData } from '../../types'

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'running',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    account: null,
    ...overrides
  } as SessionStatus
}

/** Fold a list of `[channel, ...args]` tuples, assigning seqs 1..n. */
function fold(
  events: Array<[string, ...unknown[]]>,
  initial: CanonicalState = emptyCanonicalState()
): CanonicalState {
  const aux = emptyAux()
  let state = initial
  events.forEach(([channel, ...args], i) => {
    state = applyEvent(state, { channel, args, seq: i + 1 }, aux)
  })
  return state
}

const created = (id = 'rid', cwd = '/repo'): [string, ...unknown[]] => [
  'session:created',
  id,
  { cwd }
]

function assistant(id: string, content: ChatMessage['content']): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0 }
}

describe('reducer — session registry', () => {
  it('creates a session with its cwd and marks the engine live', () => {
    const s = fold([created()])
    expect(s.sessions['rid'].cwd).toBe('/repo')
    expect(s.sessions['rid'].sdkActive).toBe(true)
  })

  it('bootstraps a placeholder for an event that outruns session:created', () => {
    // Verbatim from the renderer's `ensureSession`: a cross-client event must not
    // be dropped just because this replica has not seen the creation yet.
    const s = fold([['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'hi' }])]])
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('is a no-op for an unclassified channel', () => {
    const before = fold([created()])
    const after = applyEvent(before, { channel: 'not:classified', args: ['rid', {}] })
    expect(after).toBe(before)
  })
})

describe('reducer — transcript', () => {
  it('upserts messages by id and merges preserved blocks', () => {
    const s = fold([
      created(),
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'partial' }])],
      [
        'session:message',
        'rid',
        assistant('m1', [{ type: 'tool_use', toolUseId: 't1', toolName: 'Read', toolInput: {} }])
      ]
    ])
    const msg = s.sessions['rid'].messages
    expect(msg).toHaveLength(1)
    // mergeContentBlocks keeps the old text block (the update carries none).
    expect(msg[0].content.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  it('clears the streaming buffer when a message lands', () => {
    const s = fold([
      created(),
      ['session:stream', 'rid', { type: 'text', text: 'strea' }],
      ['session:stream', 'rid', { type: 'text', text: 'ming' }],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'streaming' }])]
    ])
    expect(s.sessions['rid'].streamingText).toBe('')
  })

  it('accumulates text and thinking into separate buffers', () => {
    const s = fold([
      created(),
      ['session:stream', 'rid', { type: 'thinking', text: 'hmm' }],
      ['session:stream', 'rid', { type: 'thinking', text: '...' }]
    ])
    expect(s.sessions['rid'].streamingThinking).toBe('hmm...')
    expect(s.sessions['rid'].streamingText).toBe('')
  })

  it('seals an open thinking span when text starts (clock-free)', () => {
    const s = fold([
      created(),
      ['session:stream', 'rid', { type: 'thinking', text: 'hmm' }],
      ['session:stream', 'rid', { type: 'text', text: 'answer' }]
    ])
    expect(s.sessions['rid'].streamingThinking).toBe('')
    expect(s.sessions['rid'].streamingText).toBe('answer')
  })

  it('attaches a tool_result to its tool_use, first result wins (idempotent)', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m1', [{ type: 'tool_use', toolUseId: 't1', toolName: 'Read', toolInput: {} }])
      ],
      ['session:tool-result', 'rid', { toolUseId: 't1', result: 'first', isError: false }],
      ['session:tool-result', 'rid', { toolUseId: 't1', result: 'second', isError: false }]
    ])
    const results = s.sessions['rid'].messages[0].content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolResult: 'first' })
  })

  it('retracts messages by id and clears streaming buffers', () => {
    const s = fold([
      created(),
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'a' }])],
      ['session:message', 'rid', assistant('m2', [{ type: 'text', text: 'b' }])],
      ['session:stream', 'rid', { type: 'text', text: 'partial' }],
      ['session:messages-retracted', 'rid', { messageIds: ['m1'] }]
    ])
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['m2'])
    expect(s.sessions['rid'].streamingText).toBe('')
  })

  it('mints a DETERMINISTIC id for a user message (the payload carries none)', () => {
    // Recorded divergence: `session:user-message` has no id/timestamp on the wire,
    // so the renderer mints `msg-<uuid>`/Date.now() and core mints `user-<seq>`/0.
    // 4b requires the id to move into the event; until then the comparator masks it.
    const a = fold([created(), ['session:user-message', 'rid', { prompt: 'hello' }]])
    const b = fold([created(), ['session:user-message', 'rid', { prompt: 'hello' }]])
    expect(a.sessions['rid'].messages[0].id).toBe('user-2')
    expect(a.sessions['rid'].messages[0].id).toBe(b.sessions['rid'].messages[0].id)
    expect(a.sessions['rid'].messages[0].timestamp).toBe(0)
  })
})

describe('reducer — approvals (ADR-038: event-driven ONLY)', () => {
  it('adds and dismisses by requestId', () => {
    const s = fold([
      created(),
      ['session:approval-request', 'rid', { requestId: 'r1', toolName: 'Bash' }],
      ['session:approval-request', 'rid', { requestId: 'r2', toolName: 'Edit' }],
      ['session:approval-dismiss', 'rid', { requestId: 'r1' }]
    ])
    expect(s.sessions['rid'].pendingApprovals.map((a) => a.requestId)).toEqual(['r2'])
  })

  it('does NOT clear approvals on the running→idle edge', () => {
    // A background subagent's can_use_tool request outlives the parent turn; the
    // 4003c19 regression was exactly this inference.
    const s = fold([
      created(),
      ['session:approval-request', 'rid', { requestId: 'r1', toolName: 'Bash' }],
      ['session:status', 'rid', status({ state: 'idle' })],
      ['session:result', 'rid', {}]
    ])
    expect(s.sessions['rid'].pendingApprovals.map((a) => a.requestId)).toEqual(['r1'])
  })

  it('clears approvals on `disconnected` (ADR-045) and marks the engine gone', () => {
    const s = fold([
      created(),
      ['session:approval-request', 'rid', { requestId: 'r1', toolName: 'Bash' }],
      ['session:status', 'rid', status({ state: 'disconnected' })]
    ])
    expect(s.sessions['rid'].pendingApprovals).toEqual([])
    expect(s.sessions['rid'].sdkActive).toBe(false)
    // Reported as idle, exactly as every client does today.
    expect(s.sessions['rid'].status.state).toBe('idle')
  })

  it('a tool_result retires the approval for that tool_use', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m1', [{ type: 'tool_use', toolUseId: 't1', toolName: 'Bash', toolInput: {} }])
      ],
      ['session:approval-request', 'rid', { requestId: 'r1', toolUseId: 't1', toolName: 'Bash' }],
      ['session:tool-result', 'rid', { toolUseId: 't1', result: 'ok', isError: false }]
    ])
    expect(s.sessions['rid'].pendingApprovals).toEqual([])
  })
})

describe('reducer — queue of record (ADR-053)', () => {
  it('replaces the pending list wholesale and keeps only `queued` items', () => {
    const s = fold([
      created(),
      ['session:queue-changed', 'rid', { items: [{ itemId: 'i1', text: 'a', state: 'queued' }] }],
      [
        'session:queue-changed',
        'rid',
        {
          items: [
            { itemId: 'i1', text: 'a', state: 'queued' },
            { itemId: 'i2', text: 'b', state: 'queued' }
          ]
        }
      ],
      [
        'session:queue-changed',
        'rid',
        {
          items: [
            { itemId: 'i1', text: 'a', state: 'consumed' },
            { itemId: 'i2', text: 'b', state: 'queued' }
          ]
        }
      ]
    ])
    expect(s.sessions['rid'].queue.map((i) => i.itemId)).toEqual(['i2'])
    // A consumed item becomes a transcript message keyed on its ITEM id, so a
    // re-delivered broadcast or a resync can never append the same steer twice.
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['steer-i1'])
  })

  it('take-back removes items without painting them into the transcript', () => {
    const s = fold([
      created(),
      [
        'session:queue-changed',
        'rid',
        {
          items: [
            { itemId: 'i1', text: 'a', state: 'queued' },
            { itemId: 'i2', text: 'b', state: 'queued' }
          ]
        }
      ],
      [
        'session:queue-changed',
        'rid',
        {
          items: [
            { itemId: 'i1', text: 'a', state: 'recalled' },
            { itemId: 'i2', text: 'b', state: 'consumed' }
          ]
        }
      ]
    ])
    // The honest race outcome: one taken back, one already consumed.
    expect(s.sessions['rid'].queue).toEqual([])
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['steer-i2'])
  })

  it('re-applying the same broadcast is idempotent', () => {
    const items = [{ itemId: 'i1', text: 'a', state: 'consumed' }]
    const s = fold([
      created(),
      ['session:queue-changed', 'rid', { items }],
      ['session:queue-changed', 'rid', { items }]
    ])
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['steer-i1'])
  })
})

describe('reducer — per-session config (item 6)', () => {
  it('applies a PARTIAL patch as a per-field replace', () => {
    const s = fold([
      created(),
      ['session:config-changed', 'rid', { model: 'sonnet', effort: 'high' }],
      ['session:config-changed', 'rid', { effort: 'low' }]
    ])
    expect(s.sessions['rid'].selectedModel).toBe('sonnet')
    expect(s.sessions['rid'].effort).toBe('low')
    // An absent key leaves the field alone — that is what "partial" means.
    // (`null`, not `''`: an unset config field is null on the wire.)
    expect(s.sessions['rid'].thinkingMode).toBe(null)
  })

  it('carries an explicit null (a model change invalidating the variant)', () => {
    const s = fold([
      created(),
      ['session:config-changed', 'rid', { reasoningVariant: 'v2' }],
      ['session:config-changed', 'rid', { model: 'opus', reasoningVariant: null }]
    ])
    expect(s.sessions['rid'].reasoningVariant).toBe(null)
  })

  it('permission-mode replaces', () => {
    const s = fold([created(), ['session:permission-mode', 'rid', 'plan']])
    expect(s.sessions['rid'].permissionMode).toBe('plan')
  })
})

describe('reducer — cost + metering REPLACE, never accumulate (invariant 6)', () => {
  const line = (cost: number): StatusLineData =>
    ({ totalCostUsd: cost, model: 'sonnet' }) as unknown as StatusLineData

  it('a status-line sequence ends at the LAST value, not the sum', () => {
    // Engine cost fields are cumulative-per-process snapshots (see
    // reference: result cost fields are cumulative). Accumulating would report
    // 0.10+0.25+0.40 = 0.75 for a turn that actually cost 0.40.
    const s = fold([
      created(),
      ['session:status-line', 'rid', line(0.1)],
      ['session:status-line', 'rid', line(0.25)],
      ['session:status-line', 'rid', line(0.4)]
    ])
    expect(s.sessions['rid'].statusLine).toEqual(line(0.4))
  })

  it('a --resume RESET (cost going back down) is honoured, not clamped', () => {
    const s = fold([
      created(),
      ['session:status-line', 'rid', line(5)],
      // New process after --resume: the engine's counter starts over.
      ['session:status-line', 'rid', line(0.02)]
    ])
    expect((s.sessions['rid'].statusLine as unknown as { totalCostUsd: number }).totalCostUsd).toBe(
      0.02
    )
  })

  it('metering replaces and reaches the snapshot (item 8)', () => {
    const metering = (total: number) =>
      ({
        engineId: 'claude',
        tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total },
        equivalentCostUsd: null,
        contextWindow: { used: total, size: 200000 }
      }) as never
    const s = fold([
      created(),
      ['session:metering', 'rid', metering(100)],
      ['session:metering', 'rid', metering(250)]
    ])
    expect(s.sessions['rid'].metering).toEqual(metering(250))
    expect(toSnapshot(s, 9).sessions['rid'].metering).toEqual(metering(250))
  })
})

describe('reducer — derived todos / sentFiles (ratified §2)', () => {
  const todoWrite = (todos: Array<{ content: string; status: string }>): ChatMessage =>
    assistant('m-todo', [
      {
        type: 'tool_use',
        toolUseId: 't-todo',
        toolName: 'TodoWrite',
        toolInput: { todos: todos.map((t) => ({ ...t, activeForm: t.content })) }
      }
    ])

  it('derives todos on message-apply, without any client help', () => {
    const s = fold([
      created(),
      ['session:message', 'rid', todoWrite([{ content: 'step 1', status: 'pending' }])]
    ])
    expect(s.sessions['rid'].todos).toEqual([
      { content: 'step 1', status: 'pending', activeForm: 'step 1' }
    ])
  })

  it('dismisses an all-completed list at the turn boundary', () => {
    const s = fold([
      created(),
      ['session:message', 'rid', todoWrite([{ content: 'step 1', status: 'completed' }])],
      ['session:result', 'rid', {}]
    ])
    expect(s.sessions['rid'].todos).toEqual([])
  })

  it('keeps a partially-completed list at the turn boundary', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        todoWrite([
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' }
        ])
      ],
      ['session:result', 'rid', {}]
    ])
    expect(s.sessions['rid'].todos.map((t) => t.content)).toEqual(['a', 'b'])
  })

  it('derives sentFiles and NEVER clears them on turn end', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m-file', [
          {
            type: 'tool_use',
            toolUseId: 't-f',
            toolName: 'SendUserFile',
            toolInput: { files: ['/repo/out.png'], display: 'render' }
          }
        ])
      ],
      ['session:result', 'rid', {}]
    ])
    expect(s.sessions['rid'].sentFiles).toEqual([
      { path: '/repo/out.png', display: 'render', toolUseId: 't-f' }
    ])
  })

  it('an explicit session:plan replaces the derived list', () => {
    const s = fold([
      created(),
      ['session:plan', 'rid', [{ content: 'from plan', status: 'pending', activeForm: 'doing' }]]
    ])
    expect(s.sessions['rid'].todos.map((t) => t.content)).toEqual(['from plan'])
  })
})

describe('reducer — derived-field tripwire (invariant 8)', () => {
  it('reports nothing for a normally-folded state', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m-todo', [
          {
            type: 'tool_use',
            toolUseId: 't',
            toolName: 'TodoWrite',
            toolInput: { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }
          }
        ])
      ]
    ])
    expect(checkDerivedFields(s)).toEqual([])
  })

  it('catches a carried value that disagrees with a fresh derivation', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m-todo', [
          {
            type: 'tool_use',
            toolUseId: 't',
            toolName: 'TodoWrite',
            toolInput: { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }
          }
        ])
      ]
    ])
    // Simulate a snapshot whose carried todos were computed by a DIFFERENT
    // interpretation — the exact failure mode a shared reducer exists to kill.
    const tampered: CanonicalState = {
      ...s,
      sessions: { rid: { ...s.sessions['rid'], todos: [] } }
    }
    const drift = checkDerivedFields(tampered)
    expect(drift.map((d) => d.field)).toEqual(['todos'])
  })

  it('does not flag the turn-boundary dismissal as drift', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m-todo', [
          {
            type: 'tool_use',
            toolUseId: 't',
            toolName: 'TodoWrite',
            toolInput: { todos: [{ content: 'x', status: 'completed', activeForm: 'x' }] }
          }
        ])
      ],
      ['session:result', 'rid', {}]
    ])
    expect(s.sessions['rid'].todos).toEqual([])
    expect(checkDerivedFields(s)).toEqual([])
  })

  it('skips sessions core has not finished seeding', () => {
    const s = fold([['session:created', 'rid', { cwd: '/x', resumeSessionId: 'uuid' }]])
    expect(s.sessions['rid'].seeded).toBe(false)
    expect(checkDerivedFields(s)).toEqual([])
  })
})

describe('reducer — status-driven rekey (invariant 7)', () => {
  it('moves the session entry and every id-keyed app map', () => {
    let s = fold([created('temp-1')])
    s = {
      ...s,
      activeSessionId: 'temp-1',
      recentSessionIds: ['temp-1'],
      customTitles: { 'temp-1': 'T' }
    }
    s = applyEvent(s, {
      channel: 'session:status',
      args: ['temp-1', status({ sessionId: 'uuid-9' })],
      seq: 2
    })
    expect(Object.keys(s.sessions)).toEqual(['uuid-9'])
    expect(s.sessions['uuid-9'].routingId).toBe('uuid-9')
    expect(s.activeSessionId).toBe('uuid-9')
    expect(s.recentSessionIds).toEqual(['uuid-9'])
    expect(s.customTitles).toEqual({ 'uuid-9': 'T' })
  })

  it('rekeyTargetFor is null when there is nothing to move', () => {
    const empty = emptyCanonicalState()
    expect(rekeyTargetFor(empty, 'temp-1', status({ sessionId: 'uuid-9' }))).toBe(null)
    const s = fold([created('temp-1')])
    expect(rekeyTargetFor(s, 'temp-1', status({ sessionId: null }))).toBe(null)
    expect(rekeyTargetFor(s, 'temp-1', status({ sessionId: 'temp-1' }))).toBe(null)
    expect(rekeyTargetFor(s, 'temp-1', status({ sessionId: 'uuid-9' }))).toBe('uuid-9')
  })

  it('carries the post-rekey session forward for later events', () => {
    let s = fold([created('temp-1')])
    s = applyEvent(s, {
      channel: 'session:status',
      args: ['temp-1', status({ sessionId: 'uuid-9' })],
      seq: 2
    })
    s = applyEvent(s, { channel: 'session:permission-mode', args: ['uuid-9', 'plan'], seq: 3 })
    expect(s.sessions['uuid-9'].permissionMode).toBe('plan')
    expect(s.sessions['temp-1']).toBeUndefined()
  })
})

describe('reducer — watched sessions', () => {
  it('replaces the transcript, re-derives, and marks the session seeded', () => {
    const s = fold([
      ['session:created', 'rid', { cwd: '/x', resumeSessionId: 'uuid' }],
      [
        'session:watch-update',
        {
          routingId: 'rid',
          messages: [
            assistant('w1', [
              {
                type: 'tool_use',
                toolUseId: 't',
                toolName: 'TodoWrite',
                toolInput: { todos: [{ content: 'watched', status: 'pending', activeForm: 'w' }] }
              }
            ])
          ],
          taskNotifications: []
        }
      ]
    ])
    expect(s.sessions['rid'].messages.map((m) => m.id)).toEqual(['w1'])
    expect(s.sessions['rid'].todos.map((t) => t.content)).toEqual(['watched'])
    expect(s.sessions['rid'].seeded).toBe(true)
  })

  it('dismisses a completed watched list (watched sessions get no session:result)', () => {
    const s = fold([
      created(),
      [
        'session:watch-update',
        {
          routingId: 'rid',
          messages: [
            assistant('w1', [
              {
                type: 'tool_use',
                toolUseId: 't',
                toolName: 'TodoWrite',
                toolInput: { todos: [{ content: 'done', status: 'completed', activeForm: 'd' }] }
              }
            ])
          ],
          taskNotifications: []
        }
      ]
    ])
    expect(s.sessions['rid'].todos).toEqual([])
  })
})

describe('reducer — app-level config', () => {
  it('config:sessions-changed honours per-key PRESENCE (H15)', () => {
    // The on-disk sessions.json strips sessionEngines (it lives in the DB), so a
    // missing key must mean "leave it alone" — `?? {}` would zero the map on every
    // external file-watcher sync.
    let s = emptyCanonicalState()
    s = { ...s, sessionEngines: { a: { engineId: 'claude' } } }
    s = applyEvent(s, {
      channel: 'config:sessions-changed',
      args: [{ recentSessions: ['a'], pinnedSessions: [] }]
    })
    expect(s.sessionEngines).toEqual({ a: { engineId: 'claude' } })
    expect(s.recentSessionIds).toEqual(['a'])

    s = applyEvent(s, { channel: 'config:sessions-changed', args: [{ sessionEngines: {} }] })
    expect(s.sessionEngines).toEqual({})
  })

  it('slash commands and skills are app-level and fan out per session', () => {
    const s = fold([
      created('a'),
      created('b'),
      ['session:slash-commands', 'a', [{ name: '/foo' }]],
      ['session:skills', 'a', ['skill-x']]
    ])
    const snap = toSnapshot(s, 1)
    expect(snap.sessions['a'].slashCommands).toEqual([{ name: '/foo' }])
    expect(snap.sessions['b'].slashCommands).toEqual([{ name: '/foo' }])
    expect(snap.sessions['b'].sdkSkillNames).toEqual(['skill-x'])
  })
})

describe('reducer — purity (invariant 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never reads the clock or the RNG', () => {
    // A reducer that read wall-clock time would produce a different canonical
    // state on every replay, so replay-equals-live — the property the whole
    // replication model rests on — would be false.
    const now = vi.spyOn(Date, 'now')
    const random = vi.spyOn(Math, 'random')

    fold([
      created(),
      ['session:user-message', 'rid', { prompt: 'hi' }],
      ['session:stream', 'rid', { type: 'thinking', text: 'hmm' }],
      ['session:stream', 'rid', { type: 'text', text: 'answer' }],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'answer' }])],
      ['session:status', 'rid', status({ state: 'idle' })],
      ['session:result', 'rid', {}],
      ['session:queue-changed', 'rid', { items: [{ itemId: 'i1', text: 'q', state: 'consumed' }] }],
      ['session:metering', 'rid', { tokens: { total: 1 } } as never],
      ['session:config-changed', 'rid', { model: 'opus' }]
    ])

    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
  })

  it('does not mutate the input state', () => {
    const before = fold([created()])
    const frozen = JSON.stringify(before)
    applyEvent(before, {
      channel: 'session:message',
      args: ['rid', assistant('m1', [{ type: 'text', text: 'x' }])],
      seq: 2
    })
    expect(JSON.stringify(before)).toBe(frozen)
  })

  it('the same event stream folds to the same state, twice', () => {
    const events: Array<[string, ...unknown[]]> = [
      created(),
      ['session:user-message', 'rid', { prompt: 'hi' }],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'yo' }])],
      ['session:status', 'rid', status({ state: 'idle' })]
    ]
    expect(JSON.stringify(fold(events))).toBe(JSON.stringify(fold(events)))
  })
})

describe('reducer — subagents', () => {
  it('upserts subagent messages and clears the buffers for that subagent', () => {
    const s = fold([
      created(),
      ['session:subagent-stream', 'rid', { type: 'text', toolUseId: 'task-1', text: 'partial' }],
      [
        'session:subagent-message',
        'rid',
        { toolUseId: 'task-1', message: assistant('s1', [{ type: 'text', text: 'partial done' }]) }
      ]
    ])
    expect(s.sessions['rid'].subagentMessages['task-1'].map((m) => m.id)).toEqual(['s1'])
    expect(s.sessions['rid'].subagentStreamingText['task-1']).toBe('')
  })

  it('clears FOREGROUND subagent buffers when the parent goes idle, keeps background', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        assistant('m1', [
          {
            type: 'tool_use',
            toolUseId: 'bg-1',
            toolName: 'Task',
            toolInput: { run_in_background: true }
          },
          { type: 'tool_use', toolUseId: 'fg-1', toolName: 'Task', toolInput: {} }
        ])
      ],
      ['session:subagent-stream', 'rid', { type: 'text', toolUseId: 'bg-1', text: 'still going' }],
      ['session:subagent-stream', 'rid', { type: 'text', toolUseId: 'fg-1', text: 'stale' }],
      ['session:status', 'rid', status({ state: 'idle' })]
    ])
    expect(s.sessions['rid'].subagentStreamingText['bg-1']).toBe('still going')
    expect(s.sessions['rid'].subagentStreamingText['fg-1']).toBe('')
  })

  it('a task notification drops the task from activeTasks', () => {
    const s = fold([
      created(),
      ['session:task-started', 'rid', { toolUseId: 't1', taskId: 'a', taskType: 'general' }],
      ['session:task-notification', 'rid', { toolUseId: 't1', message: 'done' }]
    ])
    expect(s.sessions['rid'].activeTasks).toEqual({})
    expect(s.sessions['rid'].taskNotifications).toHaveLength(1)
  })
})
