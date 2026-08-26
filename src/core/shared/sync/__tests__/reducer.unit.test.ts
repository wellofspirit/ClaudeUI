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
import {
  applyEvent,
  emptyAux,
  auxFromCanonical,
  checkDerivedFields,
  rekeyTargetFor,
  type ReducerAux
} from '../reducer'
import { isVolatileStream } from '../channels'
import { applyStreamFrame, streamFrameFrom } from '../stream'
import { emptyCanonicalState, fromSnapshot, toSnapshot, type CanonicalState } from '../state'
import type { ChatMessage, SessionStatus, StatusLineData } from '../../../../shared/types'

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

/**
 * Fold a list of `[channel, ...args]` tuples, assigning seqs 1..n — routed by the
 * channel's CLASS exactly as `SyncCore.process` routes it.
 *
 * A `volatile` channel (phase 5 S1) never reaches `applyEvent`: it is translated
 * into a stream frame and folded by `applyStreamFrame`. Keeping ONE fold helper
 * that knows both lanes is deliberate — the seal/clear interplay between them
 * (a text delta seals a thinking span; a `session:message` clears the buffer and
 * bumps its generation) is only testable if a test can express both.
 */
function fold(
  events: Array<[string, ...unknown[]]>,
  initial: CanonicalState = emptyCanonicalState(),
  aux: ReducerAux = emptyAux()
): CanonicalState {
  let state = initial
  events.forEach(([channel, ...args], i) => {
    if (isVolatileStream(channel)) {
      const frame = streamFrameFrom(state, aux, channel, args)
      if (frame) state = applyStreamFrame(state, aux, frame).state
      return
    }
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

  // -------------------------------------------------------------------------
  // F7 — `ensured()` is gone from every branch but `session:watch-update`.
  //
  // It used to bootstrap an `emptySession()` for ANY event naming an unknown id,
  // inherited from the renderer's `ensureSession`. Nothing can legitimately
  // outrun `session:created` on any transport (one FIFO funnel, one seq-ordered
  // ring), so what actually reached it was the pre-spawn config echoes and
  // post-DELETE engine traffic — both of which minted a permanent `cwd: ''` ghost.
  // -------------------------------------------------------------------------

  it.each([
    ['session:message', ['rid', assistant('m1', [{ type: 'text', text: 'hi' }])]],
    ['session:stream', ['rid', { type: 'text', text: 'hi' }]],
    ['session:subagent-stream', ['rid', { type: 'text', toolUseId: 't1', text: 'hi' }]],
    ['session:subagent-message', ['rid', { toolUseId: 't1', message: assistant('m1', []) }]],
    [
      'session:subagent-message-batch',
      ['rid', { toolUseId: 't1', messages: [assistant('m1', [])] }]
    ],
    ['session:approval-request', ['rid', { requestId: 'r1', toolUseId: 't1' }]],
    ['session:task-started', ['rid', { toolUseId: 't1', taskId: 'a', taskType: 'b' }]],
    ['session:task-progress', ['rid', { toolUseId: 't1' }]],
    ['session:task-notification', ['rid', { toolUseId: 't1' }]],
    ['session:permission-mode', ['rid', 'plan']],
    ['session:config-changed', ['rid', { model: 'opus' }]],
    // The todos channel is `session:plan` — pi's explicit plan REPLACES the
    // derived `todos` field. There is no `session:todos` channel; todos are
    // otherwise reducer-DERIVED from the transcript, never carried by an event.
    ['session:plan', ['rid', [{ content: 'step', status: 'pending' }]]],
    ['session:tool-result', ['rid', { toolUseId: 't1', result: 'ok' }]],
    ['session:status-line', ['rid', { totalCostUsd: 1 }]],
    ['session:metering', ['rid', { contextWindow: null }]],
    ['session:queue-changed', ['rid', { items: [] }]],
    ['session:result', ['rid', {}]],
    ['session:messages-retracted', ['rid', { messageIds: ['m1'] }]],
    ['session:approval-dismiss', ['rid', { requestId: 'r1' }]],
    ['session:subagent-tool-result', ['rid', { toolUseId: 't1', toolResultToolUseId: 'x' }]]
  ])('%s for an unknown id is an honest no-op (no ghost session)', (channel, args) => {
    const before = emptyCanonicalState()
    const after = fold([[channel, ...(args as unknown[])]], before)
    expect(after.sessions['rid']).toBeUndefined()
    // Identity-stable too: the replica's projection is identity-diffed, so a
    // no-op that returned a fresh object would re-write every slice.
    expect(after).toBe(before)
  })

  it('a stream delta for an unknown id leaves no orphan thinking-span flag', () => {
    // The aux write used to happen before the (bootstrapping) session write, so a
    // delta for a dead id parked `thinkingOpen` that a same-id respawn inherited
    // — its first real thinking output would be blanked by the next text delta.
    const aux = emptyAux()
    applyEvent(
      emptyCanonicalState(),
      {
        channel: 'session:stream',
        args: ['rid', { type: 'thinking', text: 'hmm' }],
        seq: 1
      },
      aux
    )
    expect(aux.thinkingOpen['rid']).toBeUndefined()
  })

  it('session:watch-update KEEPS the bootstrap — it is the only birth event a watched session has', () => {
    const s = fold([
      [
        'session:watch-update',
        {
          routingId: 'watched',
          messages: [assistant('m1', [{ type: 'text', text: 'hi' }])],
          taskNotifications: [],
          cwd: '/repo'
        }
      ]
    ])
    expect(s.sessions['watched'].messages.map((m) => m.id)).toEqual(['m1'])
    // F2: without the cwd on the payload this entry was born with `cwd: ''`, and
    // every cwd-keyed feature (git, folder name, terminal group) missed it.
    expect(s.sessions['watched'].cwd).toBe('/repo')
  })

  it('an old-shape watch-update (no cwd) leaves the existing cwd alone', () => {
    const s = fold([
      created('watched', '/repo'),
      [
        'session:watch-update',
        { routingId: 'watched', messages: [assistant('m1', [])], taskNotifications: [] }
      ]
    ])
    expect(s.sessions['watched'].cwd).toBe('/repo')
  })

  it('is a no-op for an unclassified channel', () => {
    const before = fold([created()])
    const after = applyEvent(before, { channel: 'not:classified', args: ['rid', {}] })
    expect(after).toBe(before)
  })

  // -------------------------------------------------------------------------
  // The birth config (post-4 payload addition). Before it, EVERY client except
  // the one that issued the create — and canonical, hence every snapshot — read
  // a desktop-created session as default/claude/default and vice versa.
  // -------------------------------------------------------------------------

  it('applies the spawn config the birth event carries', () => {
    const s = fold([
      [
        'session:created',
        'rid',
        { cwd: '/repo', permissionMode: 'plan', engineId: 'pi', model: 'gpt-5-codex' }
      ]
    ])
    const session = s.sessions['rid']
    expect(session.permissionMode).toBe('plan')
    expect(session.selectedEngineId).toBe('pi')
    expect(session.selectedModel).toBe('gpt-5-codex')
    // Reasoning config is NOT part of the birth payload: what the emitter has at
    // spawn is a RESOLVED model default, and these fields mean "explicitly
    // picked" (null = unset, which drives the effort precedence ladder).
    expect(session.effort).toBeNull()
    expect(session.thinkingMode).toBeNull()
  })

  it('keeps the empty-session defaults for an OLD-SHAPE birth event', () => {
    // Committed golden fixtures replay this shape, and so does catchup from a
    // host that predates the addition: the per-field fallback to `base` is what
    // makes those folds identical to what they were before.
    const s = fold([['session:created', 'rid', { cwd: '/repo' }]])
    const session = s.sessions['rid']
    expect(session.permissionMode).toBe('default')
    expect(session.selectedEngineId).toBe('claude')
    expect(session.selectedModel).toBe('default')
  })

  it('converges with the ORIGINATOR seed instead of clobbering it', () => {
    // The originating client's `createNewSession` seeds its replica through
    // `patchLocalSession` BEFORE the event arrives. Same values ⇒ idempotent
    // (assert 1); an old-shape event that announces nothing must leave the seed
    // alone rather than reset it to claude/default (assert 2).
    const seeded = fold([
      [
        'session:created',
        'rid',
        { cwd: '/repo', permissionMode: 'acceptEdits', engineId: 'opencode', model: 'zen/qwen' }
      ]
    ])
    const again = applyEvent(
      seeded,
      {
        channel: 'session:created',
        args: [
          'rid',
          { cwd: '/repo', permissionMode: 'acceptEdits', engineId: 'opencode', model: 'zen/qwen' }
        ],
        seq: 2
      },
      emptyAux()
    )
    expect(again.sessions['rid']).toEqual(seeded.sessions['rid'])

    const oldShape = applyEvent(
      seeded,
      { channel: 'session:created', args: ['rid', { cwd: '/repo' }], seq: 3 },
      emptyAux()
    )
    expect(oldShape.sessions['rid'].permissionMode).toBe('acceptEdits')
    expect(oldShape.sessions['rid'].selectedEngineId).toBe('opencode')
    expect(oldShape.sessions['rid'].selectedModel).toBe('zen/qwen')
  })
})

// ---------------------------------------------------------------------------
// F1 — explicit removal
// ---------------------------------------------------------------------------

describe('reducer — session:removed (explicit delete)', () => {
  it('drops the entry AND every id-keyed app-level row', () => {
    const before = fold([created('rid')], {
      ...emptyCanonicalState(),
      customTitles: { rid: 'My session', other: 'keep' },
      worktreeInfoMap: { rid: { worktreePath: '/wt', originalCwd: '/repo', branch: 'b' } } as never,
      sessionEngines: { rid: { engineId: 'pi' } } as never,
      recentSessionIds: ['rid', 'other'],
      pinnedSessionIds: ['rid'],
      hiddenSessions: ['rid']
    })
    const after = fold([['session:removed', 'rid']], before)
    expect(after.sessions['rid']).toBeUndefined()
    expect(after.customTitles).toEqual({ other: 'keep' })
    expect(after.worktreeInfoMap).toEqual({})
    expect(after.sessionEngines).toEqual({})
    expect(after.recentSessionIds).toEqual(['other'])
    expect(after.pinnedSessionIds).toEqual([])
    expect(after.hiddenSessions).toEqual([])
  })

  it('cleans the app-level rows of a COLD session canonical never held', () => {
    // Browsing an old session from the sidebar spawns nothing, so there is no
    // canonical entry — but there can absolutely be a title and a pin, and
    // leaving those behind is how a deleted session comes back as a dead row.
    const before: CanonicalState = {
      ...emptyCanonicalState(),
      customTitles: { cold: 'Old work' },
      pinnedSessionIds: ['cold']
    }
    const after = fold([['session:removed', 'cold']], before)
    expect(after.customTitles).toEqual({})
    expect(after.pinnedSessionIds).toEqual([])
  })

  it('is identity-stable when the id is unknown everywhere (double delete)', () => {
    const before = fold([created('rid')])
    const once = fold([['session:removed', 'rid']], before)
    const twice = fold([['session:removed', 'rid']], once)
    expect(twice).toBe(once)
  })

  it('drops the thinking-span bookkeeping, so a same-id respawn starts clean', () => {
    const aux = emptyAux()
    // The span is opened by the STREAM lane (phase 5 S1) and dropped by the event
    // lane's removal branch — the aux is what the two share.
    const state = fold(
      [created(), ['session:stream', 'rid', { type: 'thinking', text: 'hmm' }]],
      emptyCanonicalState(),
      aux
    )
    expect(aux.thinkingOpen['rid']).toBe(true)
    expect(aux.streamTurn).not.toEqual({})
    applyEvent(state, { channel: 'session:removed', args: ['rid'], seq: 3 }, aux)
    expect(aux.thinkingOpen['rid']).toBeUndefined()
    // The stream generations go with it, or a same-id respawn's first frame would
    // be judged against a dead session's turn counter.
    expect(aux.streamTurn).toEqual({})
  })

  it('a late engine event after a removal cannot resurrect the session (F7)', () => {
    const s = fold([
      created('rid'),
      ['session:removed', 'rid'],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'late' }])],
      ['session:stream', 'rid', { type: 'text', text: 'later' }],
      ['session:permission-mode', 'rid', 'plan']
    ])
    expect(s.sessions['rid']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// F4 — clear conversation
// ---------------------------------------------------------------------------

describe('reducer — session:conversation-cleared', () => {
  const dirty = (): CanonicalState =>
    fold([
      [
        'session:created',
        'rid',
        { cwd: '/repo', permissionMode: 'plan', engineId: 'pi', model: 'gpt-5' }
      ],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'hi' }])],
      ['session:stream', 'rid', { type: 'text', text: 'partial' }],
      ['session:approval-request', 'rid', { requestId: 'r1', toolUseId: 't1' }],
      ['session:task-started', 'rid', { toolUseId: 't1', taskId: 'a', taskType: 'b' }],
      [
        'session:queue-changed',
        'rid',
        { items: [{ itemId: 'q1', text: 'later', state: 'queued' }] }
      ],
      ['session:config-changed', 'rid', { effort: 'high', reasoningVariant: 'v' }]
    ])

  it('blanks the whole conversation but keeps cwd and sdkActive', () => {
    const s = fold([['session:conversation-cleared', 'rid', {}]], dirty())
    const session = s.sessions['rid']
    expect(session.messages).toEqual([])
    expect(session.streamingText).toBe('')
    expect(session.pendingApprovals).toEqual([])
    expect(session.activeTasks).toEqual({})
    expect(session.queue).toEqual([])
    expect(session.todos).toEqual([])
    expect(session.statusLine).toBeNull()
    expect(session.metering).toBeNull()
    expect(session.effort).toBeNull()
    expect(session.reasoningVariant).toBeNull()
    // Preserved on purpose — clearing the CONVERSATION says nothing about the process.
    expect(session.cwd).toBe('/repo')
    expect(session.sdkActive).toBe(true)
    // An empty transcript is a COMPLETE one; otherwise the next reselect would
    // re-hydrate the cleared session from disk.
    expect(session.seeded).toBe(true)
  })

  it('carries the per-session catalogs over rather than blanking them (R10)', () => {
    // Vestigial in canonical (the app-level lists are the real ones and
    // `toSnapshot` fans them out), but they describe the ENGINE, not the
    // conversation — a bare remote clear must not look like the slash menu went
    // away.
    const before = dirty()
    const seeded: CanonicalState = {
      ...before,
      sessions: {
        ...before.sessions,
        rid: {
          ...before.sessions['rid'],
          slashCommands: [{ name: '/compact' }] as never,
          sdkSkillNames: ['dataviz']
        }
      }
    }
    const s = fold([['session:conversation-cleared', 'rid', {}]], seeded)
    expect(s.sessions['rid'].slashCommands).toEqual([{ name: '/compact' }])
    expect(s.sessions['rid'].sdkSkillNames).toEqual(['dataviz'])
  })

  it('takes the fresh-run permission mode from the event', () => {
    const s = fold(
      [['session:conversation-cleared', 'rid', { permissionMode: 'acceptEdits' }]],
      dirty()
    )
    expect(s.sessions['rid'].permissionMode).toBe('acceptEdits')
  })

  it('falls back to the default mode when the payload carries none', () => {
    const s = fold([['session:conversation-cleared', 'rid', {}]], dirty())
    expect(s.sessions['rid'].permissionMode).toBe('default')
  })

  it('closes any open thinking span', () => {
    const aux = emptyAux()
    let state = applyEvent(
      emptyCanonicalState(),
      { channel: 'session:created', args: ['rid', { cwd: '/repo' }], seq: 1 },
      aux
    )
    state = applyEvent(
      state,
      { channel: 'session:stream', args: ['rid', { type: 'thinking', text: 'hmm' }], seq: 2 },
      aux
    )
    applyEvent(state, { channel: 'session:conversation-cleared', args: ['rid', {}], seq: 3 }, aux)
    expect(aux.thinkingOpen['rid']).toBe(false)
  })

  it('is a no-op for an unknown id', () => {
    const before = emptyCanonicalState()
    expect(fold([['session:conversation-cleared', 'ghost', {}]], before)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// F6 — the directory listing is replicated, not refetched per client
// ---------------------------------------------------------------------------

describe('reducer — session:directories-changed', () => {
  const listing = [
    { cwd: '/repo', projectKey: '-repo', folderName: 'repo', sessions: [] }
  ] as unknown as CanonicalState['directories']

  it('applies the merged listing as a replace', () => {
    const s = fold([['session:directories-changed', listing]])
    expect(s.directories).toBe(listing)
  })

  it('an OLD-shape (payload-less) notify leaves the listing alone', () => {
    // Committed fixtures and any ring caught up across the upgrade carry these;
    // blanking the sidebar on one would be a regression, not a migration.
    const before = fold([['session:directories-changed', listing]])
    const after = fold([['session:directories-changed']], before)
    expect(after).toBe(before)
    expect(after.directories).toBe(listing)
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

describe('reducer — event-carried identity (phase 4b)', () => {
  it('takes the user message id + timestamp from the payload', () => {
    // `sendPrompt` mints them now, so every replica agrees on the id. Before 4b
    // each client invented its own and a resync renumbered the transcript.
    const s = fold([
      created(),
      ['session:user-message', 'rid', { id: 'msg-abc', timestamp: 1_700_000_000_000, prompt: 'hi' }]
    ])
    const msg = s.sessions['rid'].messages[0]
    expect(msg.id).toBe('msg-abc')
    expect(msg.timestamp).toBe(1_700_000_000_000)
  })

  it('falls back to user-<seq>/0 for an old-shape payload (fixture-pinned)', () => {
    // The committed golden fixtures replay the pre-4b shape, and so does any
    // client mid-upgrade. Positional, so it stays deterministic on replay.
    const s = fold([created(), ['session:user-message', 'rid', { prompt: 'hi' }]])
    expect(s.sessions['rid'].messages[0]).toMatchObject({ id: 'user-2', timestamp: 0 })
  })

  it('is idempotent under a catchup overlap — the same id lands once', () => {
    // Two deliveries of ONE send (a rewound watermark after sync-full) must not
    // duplicate the turn. With client-minted ids this was impossible to detect.
    let s = fold([created()])
    const event = {
      channel: 'session:user-message',
      args: ['rid', { id: 'msg-abc', timestamp: 5, prompt: 'hi' }]
    }
    s = applyEvent(s, { ...event, seq: 2 })
    const ids = () => s.sessions['rid'].messages.map((m) => m.id)
    expect(ids()).toEqual(['msg-abc'])
    // NOTE: the reducer APPENDS user messages, so replay-safety here comes from
    // the client's cursor (`sync-client` drops seq <= lastSeq), not from an
    // upsert. Pinned so a future change to either side is a deliberate one.
    s = applyEvent(s, { ...event, seq: 2 })
    expect(ids()).toEqual(['msg-abc', 'msg-abc'])
  })
})

describe('reducer — emitter-supplied thinking duration (phase 4b)', () => {
  it('moves thinkingDurationMs onto the sealed block and drops the field', () => {
    const s = fold([
      created(),
      ['session:stream', 'rid', { type: 'thinking', text: 'weighing' }],
      ['session:stream', 'rid', { type: 'text', text: 'answer' }],
      [
        'session:message',
        'rid',
        {
          ...assistant('m1', [
            { type: 'thinking', text: 'weighing' },
            { type: 'text', text: 'answer' }
          ]),
          thinkingDurationMs: 4200
        }
      ]
    ])
    const msg = s.sessions['rid'].messages[0]
    const block = msg.content.find((b) => b.type === 'thinking')
    expect(block?.type === 'thinking' ? block.durationMs : null).toBe(4200)
    // The hint is transient: canonical must not carry a duplicate of it, or the
    // snapshot would ship a field with no meaning at rest.
    expect('thinkingDurationMs' in msg).toBe(false)
  })

  it('stamps a thinking block that arrived in an EARLIER frame of the same message', () => {
    // The streaming shape: [thinking] lands first, the sealing text lands in a
    // later frame of the same message id, and the merge is what brings them
    // together. The renderer stamps over the merged content; so does this.
    const s = fold([
      created(),
      ['session:message', 'rid', assistant('m1', [{ type: 'thinking', text: 'weighing' }])],
      [
        'session:message',
        'rid',
        { ...assistant('m1', [{ type: 'text', text: 'answer' }]), thinkingDurationMs: 1500 }
      ]
    ])
    const block = s.sessions['rid'].messages[0].content.find((b) => b.type === 'thinking')
    expect(block?.type === 'thinking' ? block.durationMs : null).toBe(1500)
  })

  it('leaves an already-stamped block alone and never invents a duration', () => {
    const s = fold([
      created(),
      [
        'session:message',
        'rid',
        {
          ...assistant('m1', [{ type: 'thinking', text: 'a', durationMs: 111 }]),
          thinkingDurationMs: 999
        }
      ],
      // No hint at all ⇒ no durationMs, which is exactly the pre-4b behavior for
      // an engine that does not time its spans.
      ['session:message', 'rid', assistant('m2', [{ type: 'thinking', text: 'b' }])]
    ])
    const first = s.sessions['rid'].messages[0].content[0]
    const second = s.sessions['rid'].messages[1].content[0]
    expect(first.type === 'thinking' ? first.durationMs : null).toBe(111)
    expect(second.type === 'thinking' ? second.durationMs : undefined).toBeUndefined()
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

  /**
   * The S4 shape: a notify. The branch keeps the bootstrap (nothing else
   * introduces a watched session) and stops writing content — which the WATCHER
   * has already seeded into canonical, and every client refetches.
   */
  it('a NOTIFY-shaped update bootstraps with its cwd and touches no content', () => {
    const s = fold([
      [
        'session:watch-update',
        { routingId: 'watched', sessionId: 'uuid-w', projectKey: '-repo', cwd: '/repo' }
      ]
    ])
    expect(s.sessions['watched'].cwd).toBe('/repo')
    expect(s.sessions['watched'].messages).toEqual([])
    // NOT seeded: the content is somebody else's job now, so claiming otherwise
    // would tell a client its empty transcript is complete.
    expect(s.sessions['watched'].seeded).toBe(false)
  })

  it('a notify never blanks a transcript a seed or the events already filled', () => {
    let s = fold([
      created('watched', '/repo'),
      ['session:message', 'watched', assistant('m1', [{ type: 'text', text: 'kept' }])]
    ])
    s = applyEvent(s, {
      channel: 'session:watch-update',
      args: [{ routingId: 'watched', sessionId: 'uuid-w', projectKey: '-repo', cwd: '/repo' }],
      seq: 9
    })
    expect(s.sessions['watched'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('a repeat notify for a known session is identity-stable (nothing re-projects)', () => {
    const before = fold([
      created('watched', '/repo'),
      [
        'session:watch-update',
        { routingId: 'watched', sessionId: 'uuid-w', projectKey: '-repo', cwd: '/repo' }
      ]
    ])
    const after = applyEvent(before, {
      channel: 'session:watch-update',
      args: [{ routingId: 'watched', sessionId: 'uuid-w', projectKey: '-repo', cwd: '/repo' }],
      seq: 9
    })
    expect(after).toBe(before)
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

describe('snapshot restore — fromSnapshot / auxFromCanonical (phase 4b)', () => {
  it('round-trips canonical state through the wire shape', () => {
    const live = fold([
      created(),
      ['session:user-message', 'rid', { id: 'msg-1', timestamp: 9, prompt: 'hi' }],
      ['session:message', 'rid', assistant('m1', [{ type: 'text', text: 'yo' }])],
      [
        'session:queue-changed',
        'rid',
        { items: [{ itemId: 'i1', text: 'later', state: 'queued' }] }
      ],
      ['session:metering', 'rid', { tokens: { total: 3 } } as never],
      ['session:config-changed', 'rid', { model: 'opus', effort: 'high' }],
      ['session:slash-commands', 'rid', [{ name: '/foo' }]],
      ['session:skills', 'rid', ['skill-x']],
      ['config:settings-changed', { theme: 'monokai' }]
    ])
    const restored = fromSnapshot(toSnapshot(live, 42))
    // `seeded` is core-internal and not on the wire — a restored session is
    // complete by definition. Everything else must match exactly.
    const strip = (s: CanonicalState): unknown => ({
      ...s,
      sessions: Object.fromEntries(
        Object.entries(s.sessions).map(([id, session]) => {
          const { seeded: _seeded, ...rest } = session
          return [id, rest]
        })
      )
    })
    expect(strip(restored)).toEqual(strip(live))
  })

  it("fills defaults for an older host's snapshot (absent optional fields)", () => {
    const restored = fromSnapshot({
      seq: 1,
      sessions: {
        rid: {
          routingId: 'rid',
          cwd: '/repo',
          messages: [],
          streamingText: '',
          streamingThinking: '',
          status: status({ state: 'idle' }),
          pendingApprovals: [],
          todos: [],
          taskNotifications: [],
          taskProgressMap: {},
          subagentMessages: {},
          subagentStreamingText: {},
          subagentStreamingThinking: {},
          permissionMode: 'default',
          effort: null,
          statusLine: null,
          slashCommands: [],
          sdkSkillNames: []
        }
      },
      directories: [],
      activeSessionId: null,
      settings: {},
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
      worktreeInfoMap: {}
    })
    const s = restored.sessions['rid']
    expect(s.sentFiles).toEqual([])
    expect(s.queue).toEqual([])
    expect(s.activeTasks).toEqual({})
    expect(s.metering).toBeNull()
    expect(s.sdkActive).toBe(false)
    expect(s.selectedEngineId).toBe('claude')
    expect(restored.autoModeDisabledBySettings).toBe(false)
  })

  it('recovers the open-thinking-span flag from streamingThinking', () => {
    // The flag is core-internal, but it is DERIVABLE: a non-empty thinking buffer
    // IS an unsealed span. Without recovering it, a client restored mid-span would
    // never clear that buffer — stale thinking text under a finished answer.
    const midSpan = fold([created(), ['session:stream', 'rid', { type: 'thinking', text: 'hmm' }]])
    const restored = fromSnapshot(toSnapshot(midSpan, 2))
    const aux = auxFromCanonical(restored)
    expect(aux.thinkingOpen['rid']).toBe(true)

    const sealed = fold(
      [['session:stream', 'rid', { type: 'text', text: 'answer' }]],
      restored,
      aux
    )
    expect(sealed.sessions['rid'].streamingThinking).toBe('')
    // And an idle session restores with no open span at all.
    expect(auxFromCanonical(fromSnapshot(toSnapshot(fold([created()]), 1))).thinkingOpen).toEqual(
      {}
    )
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

  it('drops activeTasks on `disconnected` — they lived in the dead process', () => {
    const s = fold([
      created(),
      ['session:task-started', 'rid', { toolUseId: 't1', taskId: 'a', taskType: 'local_agent' }],
      ['session:status', 'rid', status({ state: 'disconnected' })]
    ])
    expect(s.sessions['rid'].activeTasks).toEqual({})
    expect(s.sessions['rid'].sdkActive).toBe(false)
  })

  it('KEEPS activeTasks on the running→idle edge', () => {
    // Background agents outlive the parent turn; inferring their death from idle
    // is the 4003c19 mistake in another costume.
    const s = fold([
      created(),
      ['session:task-started', 'rid', { toolUseId: 't1', taskId: 'a', taskType: 'local_agent' }],
      ['session:status', 'rid', status({ state: 'idle' })]
    ])
    expect(s.sessions['rid'].activeTasks).toEqual({
      t1: { taskId: 'a', taskType: 'local_agent' }
    })
  })
})
