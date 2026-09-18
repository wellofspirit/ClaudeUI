import { describe, expect, it, vi, afterEach } from 'vitest'
import { SyncCore } from '../../../sync/sync-core'
import { applyEvent, rekeyCanonical } from '../reducer'
import { fromSnapshot } from '../state'
import {
  applyItemStreamFrame,
  itemStreamKey,
  overlayItemStreams,
  isItemStreamFrame,
  mergeItemContent,
  type ItemStreamTarget,
  type ItemStreamFrame
} from '../item-stream'
import { SyncClient } from '../sync-client'
import type { ChatMessage } from '../../../../shared/types'
import {
  addStreamSubscriber,
  setStreamWatch,
  syncCore,
  clearStreamSubscribersForTests,
  emitEvent
} from '../../../services/sync-host'

const message = (id: string, text = ''): ChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  content: [{ type: 'text', text }]
})
const target = (id: string, ownerToolUseId?: string): ItemStreamTarget => ({
  messageId: id,
  blockIndex: 0,
  kind: 'text',
  ...(ownerToolUseId ? { ownerToolUseId } : {})
})
function fixture() {
  const core = new SyncCore({ capacity: 10 })
  core.emit('session:created', ['s', { cwd: '/fixture', engineId: 'codex' }])
  const frames: ItemStreamFrame[] = []
  core.setStreamDelivery((f) => {
    if (f.type === 'item-stream') frames.push(f)
  })
  const open = (t: ItemStreamTarget) =>
    core.emit('session:item-open', ['s', { target: t, message: message(t.messageId) }])
  const append = (t: ItemStreamTarget, chunk: string) =>
    core.emit('session:item-delta', ['s', { target: t, chunk }])
  const seal = (t: ItemStreamTarget, text: string) =>
    core.emit('session:item-seal', [
      's',
      { target: t, message: message(t.messageId, text), ownerToolUseId: t.ownerToolUseId }
    ])
  return { core, frames, open, append, seal }
}

describe('per-item volatile streams', () => {
  it('preserves established native slots on open, dedupes cloned auxiliaries, and truncates finals', () => {
    const tool = { type: 'tool_use' as const, toolUseId: 't', toolName: 'Bash', toolInput: {} }
    const old = [
      { type: 'text' as const, text: 'sealed sibling' },
      tool,
      { type: 'tool_result' as const, toolUseId: 't', toolResult: 'old', isError: false },
      {
        type: 'tool_review' as const,
        toolUseId: 't',
        reviewId: 'r',
        reviewer: 'auto-mode' as const,
        decision: 'approved' as const
      }
    ]
    expect(
      mergeItemContent(
        old,
        [{ type: 'text', text: 'stale sibling' }, tool, { type: 'text', text: '' }],
        true
      ).map((block) => (block.type === 'text' ? block.text : block.type))
    ).toEqual(['sealed sibling', 'tool_use', '', 'tool_result', 'tool_review'])
    expect(
      mergeItemContent(old, [{ ...old[2] }, { ...old[3] }]).map((block) => block.type)
    ).toEqual(['tool_result', 'tool_review'])
    expect(mergeItemContent(old, [{ type: 'text', text: 'final' }])).toEqual([
      { type: 'text', text: 'final' },
      old[2],
      old[3]
    ])
  })
  it('keeps native stream slots ahead of attached result and review blocks', () => {
    const f = fixture()
    f.core.emit('session:message', [
      's',
      {
        id: 'multi',
        role: 'assistant',
        timestamp: 1,
        content: [
          { type: 'tool_use', toolUseId: 'tool', toolName: 'Bash', toolInput: {} },
          { type: 'tool_result', toolUseId: 'tool', toolResult: 'done', isError: false },
          {
            type: 'tool_review',
            toolUseId: 'tool',
            reviewId: 'review',
            reviewer: 'auto-mode',
            decision: 'approved'
          }
        ]
      }
    ])
    const textTarget: ItemStreamTarget = { messageId: 'multi', blockIndex: 1, kind: 'text' }
    f.core.emit('session:item-open', [
      's',
      {
        target: textTarget,
        message: {
          id: 'multi',
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'tool_use', toolUseId: 'tool', toolName: 'Bash', toolInput: {} },
            { type: 'text', text: '' }
          ]
        }
      }
    ])
    const state = f.core.getCanonicalState().sessions.s
    expect(state.itemStreams[itemStreamKey(textTarget)]).toBeDefined()
    expect(state.messages[0].content.map((block) => block.type)).toEqual([
      'tool_use',
      'text',
      'tool_result',
      'tool_review'
    ])

    f.core.emit('session:message', [
      's',
      {
        id: 'multi',
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'tool_use', toolUseId: 'tool', toolName: 'Bash', toolInput: { command: 'pwd' } },
          { type: 'text', text: 'structural snapshot' }
        ]
      }
    ])
    const updated = f.core.getCanonicalState().sessions.s
    expect(updated.messages[0].content.map((block) => block.type)).toEqual([
      'tool_use',
      'text',
      'tool_result',
      'tool_review'
    ])
    expect(updated.itemStreams[itemStreamKey(textTarget)]).toBeDefined()
  })
  it('keeps child native slots stable across a structural subagent snapshot', () => {
    const f = fixture()
    const owner = 'child-tool'
    const tool = { type: 'tool_use' as const, toolUseId: 'inner', toolName: 'Bash', toolInput: {} }
    f.core.emit('session:subagent-message', [
      's',
      {
        toolUseId: owner,
        message: {
          id: 'child-message',
          role: 'assistant',
          timestamp: 1,
          content: [
            tool,
            { type: 'tool_result', toolUseId: 'inner', toolResult: 'done', isError: false }
          ]
        }
      }
    ])
    const childTarget: ItemStreamTarget = {
      messageId: 'child-message',
      blockIndex: 1,
      kind: 'text',
      ownerToolUseId: owner
    }
    f.core.emit('session:item-open', [
      's',
      {
        target: childTarget,
        message: {
          id: 'child-message',
          role: 'assistant',
          timestamp: 1,
          content: [tool, { type: 'text', text: '' }]
        }
      }
    ])
    f.core.emit('session:subagent-message', [
      's',
      {
        toolUseId: owner,
        message: {
          id: 'child-message',
          role: 'assistant',
          timestamp: 2,
          content: [tool, { type: 'text', text: 'structural' }]
        }
      }
    ])
    const state = f.core.getCanonicalState().sessions.s
    expect(state.itemStreams[itemStreamKey(childTarget)]).toBeDefined()
    expect(state.subagentMessages[owner][0].content.map((block) => block.type)).toEqual([
      'tool_use',
      'text',
      'tool_result'
    ])
  })
  it('keeps the native id when a Codex acknowledgement replaces an optimistic user row', () => {
    const f = fixture()
    f.core.emit('session:user-message', ['s', { id: 'optimistic', prompt: 'hello', timestamp: 1 }])
    f.core.emit('session:message', [
      's',
      {
        id: 'native',
        replacesMessageId: 'optimistic',
        role: 'user',
        timestamp: 2,
        content: [{ type: 'text', text: 'hello' }]
      }
    ])
    expect(f.core.getCanonicalState().sessions.s.messages).toEqual([
      expect.objectContaining({ id: 'native', replacesMessageId: 'optimistic' })
    ])
  })
  it('keeps interleaved items and child owners separate, with constant ring growth', () => {
    const f = fixture(),
      a = target('same'),
      b = target('other'),
      child = target('same', 'child/card')
    f.open(a)
    f.open(b)
    f.open(child)
    const seq = f.core.getSnapshot().seq
    for (let i = 0; i < 2000; i++) f.append(a, 'x')
    f.append(b, 'B')
    f.append(child, 'child')
    expect(f.core.getSnapshot().seq).toBe(seq)
    expect(f.frames).toHaveLength(2002)
    expect(f.frames.every((frame) => frame.op === 'append' && frame.chunk.length <= 5)).toBe(true)
    f.seal(a, 'authoritative A')
    const s = f.core.getCanonicalState().sessions.s
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'authoritative A' }])
    expect(s.itemStreams[itemStreamKey(a)]).toBeUndefined()
    expect(s.itemStreams[itemStreamKey(b)].value).toBe('B')
    expect(
      overlayItemStreams(s.subagentMessages['child/card'], s.itemStreams, 'child/card')[0].content
    ).toEqual([{ type: 'text', text: 'child' }])
    expect(f.core.getSnapshot().seq).toBe(seq + 1)
  })
  it('heals a dropped chunk with an explicit replay and survives a snapshot mid-item', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    let replica = fromSnapshot(f.core.getSnapshot())
    f.append(a, 'hello')
    f.append(a, ' world')
    expect(applyItemStreamFrame(replica, f.frames[1]).result).toBe('mismatch')
    replica = applyItemStreamFrame(replica, f.core.itemStreamReplay('s')).state
    expect(replica.sessions.s.itemStreams).toEqual(
      f.core.getCanonicalState().sessions.s.itemStreams
    )
    f.append(a, '🙂')
    replica = applyItemStreamFrame(replica, f.frames[2]).state
    const restored = fromSnapshot(f.core.getSnapshot())
    expect(replica.sessions.s.itemStreams).toEqual(restored.sessions.s.itemStreams)
    f.append(a, '!')
    expect(f.frames[3]).toMatchObject({ offset: 'hello world🙂'.length })
  })
  it('seals atomically on an unwatched replica, rejecting late deltas and stale replays', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    let replica = fromSnapshot(f.core.getSnapshot())
    f.append(a, 'preview')
    const stale = f.core.itemStreamReplay('s')
    f.seal(a, 'corrected final')
    const event = {
      seq: f.core.getSnapshot().seq,
      channel: 'session:item-seal',
      args: ['s', { message: message('a', 'corrected final') }]
    }
    replica = applyEvent(replica, event)
    expect(replica.sessions.s.messages[0].content).toEqual([
      { type: 'text', text: 'corrected final' }
    ])
    expect(replica.sessions.s.itemStreams).toEqual({})
    expect(applyItemStreamFrame(replica, f.frames[0]).result).toBe('unknown')
    expect(applyItemStreamFrame(replica, stale).result).toBe('mismatch')
    expect(
      applyItemStreamFrame(replica, f.core.itemStreamReplay('s')).state.sessions.s.itemStreams
    ).toEqual({})
  })
  it('replaces an active set including empty; does not revive deleted sessions', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'text')
    const state = f.core.getCanonicalState()
    const empty: ItemStreamFrame = {
      type: 'item-stream',
      op: 'replace',
      routingId: 's',
      atSeq: f.core.getSnapshot().seq,
      streams: {}
    }
    expect(applyItemStreamFrame(state, empty).state.sessions.s.itemStreams).toEqual({})
    const deleted = applyEvent(state, { channel: 'session:removed', args: ['s'], seq: 20 })
    expect(applyItemStreamFrame(deleted, f.frames[0]).state).toBe(deleted)
  })
  it('moves active values on rekey and removes them on clear and retraction', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'text')
    let state = rekeyCanonical(f.core.getCanonicalState(), 's', 'renamed')
    expect(state.sessions.renamed.itemStreams[itemStreamKey(a)].value).toBe('text')
    expect(applyItemStreamFrame(state, f.frames[0]).result).toBe('unknown')
    state = applyEvent(state, {
      channel: 'session:messages-retracted',
      args: ['renamed', { messageIds: ['a'] }],
      seq: 10
    })
    expect(state.sessions.renamed.itemStreams).toEqual({})
    state = applyEvent(state, {
      channel: 'session:conversation-cleared',
      args: ['renamed'],
      seq: 11
    })
    expect(state.sessions.renamed.itemStreamRevision).toBe(11)
  })
  it('keeps active items on an empty retraction', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'text')
    const state = applyEvent(f.core.getCanonicalState(), {
      channel: 'session:messages-retracted',
      args: ['s', { messageIds: [] }],
      seq: 10
    })
    expect(state.sessions.s.itemStreams[itemStreamKey(a)].value).toBe('text')
    expect(state.sessions.s.messages).toHaveLength(1)
  })
  it('commits a targeted seal when replay lost its active entry but never resurrects a retraction', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    let state = applyItemStreamFrame(f.core.getCanonicalState(), {
      type: 'item-stream',
      op: 'replace',
      routingId: 's',
      atSeq: f.core.getSnapshot().seq,
      streams: {}
    }).state
    state = applyEvent(state, {
      channel: 'session:item-seal',
      args: ['s', { target: a, message: message('a', 'authoritative') }],
      seq: 10
    })
    expect(state.sessions.s.messages[0].content).toEqual([{ type: 'text', text: 'authoritative' }])

    state = applyEvent(state, {
      channel: 'session:messages-retracted',
      args: ['s', { messageIds: ['a'] }],
      seq: 11
    })
    const sealed = applyEvent(state, {
      channel: 'session:item-seal',
      args: ['s', { target: a, message: message('a', 'must stay gone') }],
      seq: 12
    })
    expect(sealed.sessions.s.messages).toEqual([])
  })
  it('addresses multiple blocks and a plan without erasing attached results/reviews', () => {
    const f = fixture()
    const t: ItemStreamTarget = { messageId: 'mixed', blockIndex: 1, kind: 'plan' }
    const scaffold: ChatMessage = {
      ...message('mixed', 'fixed'),
      content: [
        { type: 'text', text: 'fixed' },
        { type: 'tool_use', toolUseId: 'p', toolName: 'plan', toolInput: { plan: '' } }
      ]
    }
    f.core.emit('session:item-open', ['s', { target: t, message: scaffold }])
    f.append(t, 'step one')
    f.core.emit('session:tool-result', ['s', { toolUseId: 'p', result: 'ok' }])
    f.core.emit('session:tool-review', [
      's',
      {
        toolUseId: 'p',
        review: {
          type: 'tool_review',
          toolUseId: 'p',
          reviewId: 'review',
          reviewer: 'codex-auto-review',
          decision: 'approved'
        }
      }
    ])
    const textTarget = target('mixed')
    f.core.emit('session:item-open', ['s', { target: textTarget, message: scaffold }])
    f.append(textTarget, ' and growing')
    const s = f.core.getCanonicalState().sessions.s
    expect(overlayItemStreams(s.messages, s.itemStreams)[0].content).toEqual([
      { type: 'text', text: 'fixed and growing' },
      expect.objectContaining({ toolInput: { plan: 'step one' } }),
      expect.objectContaining({ toolResult: 'ok' }),
      expect.objectContaining({ reviewId: 'review' })
    ])
    f.core.emit('session:item-seal', [
      's',
      {
        target: t,
        message: {
          ...scaffold,
          content: [
            scaffold.content[0],
            { type: 'tool_use', toolUseId: 'p', toolName: 'plan', toolInput: { plan: 'final' } }
          ]
        }
      }
    ])
    expect(f.core.getCanonicalState().sessions.s.messages[0].content).toContainEqual(
      expect.objectContaining({ toolResult: 'ok' })
    )
    const after = f.core.getCanonicalState().sessions.s
    expect(after.itemStreams[itemStreamKey(textTarget)].value).toBe('fixed and growing')
    expect(after.messages[0].content[0]).toEqual({ type: 'text', text: 'fixed' })
  })
  it('reopens from the preserved scaffold value', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'partial')
    f.seal(a, 'partial')
    f.core.emit('session:item-open', ['s', { target: a, message: message('a') }])
    f.append(a, ' tail')
    const s = f.core.getCanonicalState().sessions.s
    expect(s.itemStreams[itemStreamKey(a)].value).toBe('partial tail')
    expect(overlayItemStreams(s.messages, s.itemStreams)[0].content).toEqual([
      { type: 'text', text: 'partial tail' }
    ])
  })
  it('preserves every scaffold slot when a targeted seal carries partial content', () => {
    const f = fixture()
    const a = target('slots')
    const b: ItemStreamTarget = { messageId: 'slots', blockIndex: 2, kind: 'thinking' }
    const scaffold: ChatMessage = {
      id: 'slots',
      role: 'assistant',
      timestamp: 1,
      content: [
        { type: 'text', text: 'A preview' },
        { type: 'tool_result', toolUseId: 'tool', toolResult: 'completed result' },
        { type: 'thinking', text: 'B preview' }
      ]
    }
    f.core.emit('session:item-open', ['s', { target: a, message: scaffold }])
    f.core.emit('session:item-open', ['s', { target: b, message: scaffold }])
    f.core.emit('session:item-seal', ['s', { target: a, message: message('slots', 'A final') }])
    const s = f.core.getCanonicalState().sessions.s
    expect(s.messages[0].content).toEqual([
      { type: 'text', text: 'A final' },
      { type: 'tool_result', toolUseId: 'tool', toolResult: 'completed result' },
      { type: 'thinking', text: 'B preview' }
    ])
    expect(s.messages[0].content).not.toContain(undefined)
    expect(s.itemStreams[itemStreamKey(b)].value).toBe('B preview')

    const malformedBefore = f.core.getCanonicalState()
    f.core.emit('session:item-seal', [
      's',
      {
        target: b,
        message: {
          ...message('slots'),
          content: [{ type: 'thinking', text: 'misaddressed B' }]
        }
      }
    ])
    expect(f.core.getCanonicalState().sessions.s).toEqual(malformedBefore.sessions.s)

    f.core.emit('session:item-seal', [
      's',
      {
        target: b,
        message: {
          ...message('slots'),
          content: [
            { type: 'text', text: 'stale A preview' },
            { type: 'tool_result', toolUseId: 'tool', toolResult: 'completed result' },
            { type: 'thinking', text: 'B final' }
          ]
        }
      }
    ])
    expect(f.core.getCanonicalState().sessions.s.messages[0].content).toEqual([
      { type: 'text', text: 'A final' },
      { type: 'tool_result', toolUseId: 'tool', toolResult: 'completed result' },
      { type: 'thinking', text: 'B final' }
    ])
    expect(f.core.getCanonicalState().sessions.s.itemStreams[itemStreamKey(b)]).toBeUndefined()
  })
  it('fills the scaffold gap when a targeted seal addresses a slot past the committed end', () => {
    const f = fixture()
    // One committed block, no active entry: exactly the shape a targeted seal
    // takes on a replica whose `replace` was lost. The addressed slot then sits
    // PAST the committed end, so applying it by slot alone would leave holes.
    f.core.emit('session:message', [
      's',
      { id: 'sparse', role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'first' }] }
    ])
    const late: ItemStreamTarget = { messageId: 'sparse', blockIndex: 2, kind: 'thinking' }
    f.core.emit('session:item-seal', [
      's',
      {
        target: late,
        message: {
          id: 'sparse',
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
            { type: 'thinking', text: 'late thought' }
          ]
        }
      }
    ])
    const content = f.core.getCanonicalState().sessions.s.messages[0].content
    expect(content).toHaveLength(3)
    expect(content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'thinking', text: 'late thought' }
    ])
    // A hole is not `undefined` to `toEqual` but it IS `null` after transport.
    expect(Object.keys(content)).toEqual(['0', '1', '2'])
    const roundTripped = JSON.parse(JSON.stringify(f.core.getSnapshot())) as ReturnType<
      typeof f.core.getSnapshot
    >
    expect(roundTripped.sessions.s.messages[0].content).toEqual(content)
  })
  it('copies a valid open startedAt onto the active entry, and ignores an invalid one', () => {
    const f = fixture()
    const thought: ItemStreamTarget = { messageId: 'timed', blockIndex: 0, kind: 'thinking' }
    const scaffold: ChatMessage = {
      id: 'timed',
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'thinking', text: '' }]
    }
    f.core.emit('session:item-open', ['s', { target: thought, message: scaffold, startedAt: 4242 }])
    const key = itemStreamKey(thought)
    expect(f.core.getCanonicalState().sessions.s.itemStreams[key].startedAt).toBe(4242)

    // Survives the snapshot both ways — a reconnecting client keeps the timer.
    const snapshot = f.core.getSnapshot()
    expect(snapshot.sessions.s.itemStreams?.[key].startedAt).toBe(4242)
    expect(fromSnapshot(snapshot).sessions.s.itemStreams[key].startedAt).toBe(4242)

    // …and the `replace` validator accepts it, so a recovery frame carries it.
    const replay = f.core.itemStreamReplay('s')
    expect(isItemStreamFrame(replay)).toBe(true)
    expect(replay.op === 'replace' && replay.streams[key].startedAt).toBe(4242)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '4242', null]) {
      expect(
        isItemStreamFrame({
          ...replay,
          streams: {
            [key]: { ...(replay.op === 'replace' ? replay.streams[key] : {}), startedAt: bad }
          }
        })
      ).toBe(false)
    }

    // An invalid value on the OPEN is dropped, not repaired: the renderer then
    // falls back to the message timestamp exactly as it did before.
    const second: ItemStreamTarget = { messageId: 'timed', blockIndex: 1, kind: 'thinking' }
    f.core.emit('session:item-open', [
      's',
      {
        target: second,
        message: {
          ...scaffold,
          content: [
            { type: 'thinking', text: '' },
            { type: 'thinking', text: '' }
          ]
        },
        startedAt: Number.NaN
      }
    ])
    expect(
      f.core.getCanonicalState().sessions.s.itemStreams[itemStreamKey(second)].startedAt
    ).toBeUndefined()
  })
  it('stamps duration only on the targeted thinking slot', () => {
    const f = fixture()
    const first: ItemStreamTarget = { messageId: 'thoughts', blockIndex: 0, kind: 'thinking' }
    const second: ItemStreamTarget = { messageId: 'thoughts', blockIndex: 1, kind: 'thinking' }
    const scaffold: ChatMessage = {
      id: 'thoughts',
      role: 'assistant',
      timestamp: 1,
      content: [
        { type: 'thinking', text: 'first' },
        { type: 'thinking', text: 'second' }
      ]
    }
    f.core.emit('session:item-open', ['s', { target: first, message: scaffold }])
    f.core.emit('session:item-open', ['s', { target: second, message: scaffold }])
    f.core.emit('session:item-seal', [
      's',
      {
        target: second,
        message: {
          ...scaffold,
          thinkingDurationMs: 250,
          content: [scaffold.content[0], { type: 'thinking', text: 'second final' }]
        }
      }
    ])
    expect(f.core.getCanonicalState().sessions.s.messages[0].content).toEqual([
      { type: 'thinking', text: 'first' },
      { type: 'thinking', text: 'second final', durationMs: 250 }
    ])
  })
  it('shares root commit derivations while keeping child scope separate', () => {
    const f = fixture()
    f.core.emit('session:item-seal', [
      's',
      {
        message: {
          id: 'root-tools',
          role: 'assistant',
          timestamp: 1,
          thinkingDurationMs: 300,
          content: [
            { type: 'thinking', text: 'root thought' },
            {
              type: 'tool_use',
              toolUseId: 'todo',
              toolName: 'TodoWrite',
              toolInput: { todos: [{ content: 'ship', status: 'pending', activeForm: 'shipping' }] }
            },
            {
              type: 'tool_use',
              toolUseId: 'file',
              toolName: 'SendUserFile',
              toolInput: { files: ['/repo/result.txt'] }
            }
          ]
        }
      }
    ])
    const root = f.core.getCanonicalState().sessions.s
    expect(root.todos).toHaveLength(1)
    expect(root.sentFiles).toHaveLength(1)
    expect(root.messages[0].content[0]).toEqual({
      type: 'thinking',
      text: 'root thought',
      durationMs: 300
    })

    f.core.emit('session:item-seal', [
      's',
      {
        ownerToolUseId: 'child',
        message: {
          id: 'child-message',
          role: 'assistant',
          timestamp: 2,
          thinkingDurationMs: 400,
          content: [
            { type: 'thinking', text: 'child thought' },
            {
              type: 'tool_use',
              toolUseId: 'child-todo',
              toolName: 'TodoWrite',
              toolInput: { todos: [{ content: 'wrong scope', status: 'pending' }] }
            }
          ]
        }
      }
    ])
    const afterChild = f.core.getCanonicalState().sessions.s
    expect(afterChild.todos).toEqual(root.todos)
    expect(afterChild.sentFiles).toEqual(root.sentFiles)
    expect(afterChild.subagentMessages.child[0].content[0]).toEqual({
      type: 'thinking',
      text: 'child thought',
      durationMs: 400
    })
  })
  it('replays large values intact without turning them into ring entries', () => {
    const f = fixture(),
      a = target('large')
    f.open(a)
    const seq = f.core.getSnapshot().seq
    const value = 'x'.repeat(2 * 1024 * 1024)
    f.append(a, value)
    const restored = applyItemStreamFrame(
      fromSnapshot(f.core.getSnapshot()),
      f.core.itemStreamReplay('s')
    )
    expect(restored.state.sessions.s.itemStreams[itemStreamKey(a)].value).toBe(value)
    expect(f.core.getSnapshot().seq).toBe(seq)
  })
  it('validates identities, safe offsets, block types and generations', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'x')
    const frame = f.frames[0]
    expect(isItemStreamFrame({ ...frame, offset: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(isItemStreamFrame({ ...frame, target: { ...a, blockIndex: -1 } })).toBe(false)
    expect(isItemStreamFrame({ ...frame, generation: 0 })).toBe(false)
    expect(isItemStreamFrame({ ...frame, target: { ...a, kind: 'arbitrary' } })).toBe(false)
    expect(itemStreamKey(target('a/b', 'c'))).not.toBe(itemStreamKey(target('b', 'c/a')))
    f.core.emit('session:item-open', [
      's',
      { target: { ...a, kind: 'thinking' }, message: message('a') }
    ])
    expect(Object.keys(f.core.getCanonicalState().sessions.s.itemStreams)).toHaveLength(1)
  })
  it('gates frames on reliable events and coalesces missing-open synchronization', () => {
    const f = fixture(),
      a = target('a')
    f.open(a)
    f.append(a, 'x')
    const requestResync = vi.fn(),
      tap = vi.fn()
    const client = new SyncClient({ requestResync })
    client.onItemStreamFrame(tap)
    client.receiveItemStreamFrame(f.frames[0])
    expect(tap).not.toHaveBeenCalled()
    client.markReady()
    client.receiveItemStreamFrame(f.frames[0])
    client.receiveItemStreamFrame(f.frames[0])
    expect(requestResync).toHaveBeenCalledTimes(1)
    expect(tap).not.toHaveBeenCalled()
    client.applyFullState(f.core.getSnapshot(), 'epoch', f.core.getSnapshot().seq)
    client.receiveItemStreamFrame(f.core.itemStreamReplay('s'))
    expect(tap).toHaveBeenCalledTimes(1)
  })
})

describe('item replay after backpressure', () => {
  afterEach(() => {
    clearStreamSubscribersForTests()
    vi.useRealTimers()
  })
  it('retries the current accumulation without another token and cancels on unwatch', () => {
    vi.useFakeTimers()
    const id = 'backpressure-items'
    emitEvent('session:created', [id, { cwd: '/fixture', engineId: 'codex' }])
    const t = target('a')
    emitEvent('session:item-open', [id, { target: t, message: message('a') }])
    let congested = true
    const seen: ItemStreamFrame[] = []
    addStreamSubscriber('item-test', (frame) => {
      if (frame.type !== 'item-stream') return
      if (congested) return false
      seen.push(frame)
      return true
    })
    setStreamWatch('item-test', [id])
    emitEvent('session:item-delta', [id, { target: t, chunk: 'last token' }])
    congested = false
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([syncCore.itemStreamReplay(id)])
    expect(seen[0]).toMatchObject({
      op: 'replace',
      streams: { [itemStreamKey(t)]: { value: 'last token' } }
    })
    congested = true
    setStreamWatch('item-test', [id])
    setStreamWatch('item-test', [])
    congested = false
    vi.advanceTimersByTime(500)
    expect(seen).toHaveLength(1)
  })
  it('backs off repeated recovery attempts and resets after delivery', () => {
    vi.useFakeTimers()
    const id = 'backpressure-backoff'
    emitEvent('session:created', [id, { cwd: '/fixture', engineId: 'codex' }])
    const t = target('a')
    emitEvent('session:item-open', [id, { target: t, message: message('a') }])
    let congested = true
    const attempts: number[] = []
    addStreamSubscriber('backoff-test', (frame) => {
      if (frame.type !== 'item-stream') return
      attempts.push(Date.now())
      return !congested
    })
    setStreamWatch('backoff-test', [id])
    expect(attempts).toHaveLength(1)
    vi.advanceTimersByTime(99)
    expect(attempts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(attempts).toHaveLength(2)
    vi.advanceTimersByTime(199)
    expect(attempts).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(attempts).toHaveLength(3)
    congested = false
    vi.advanceTimersByTime(400)
    expect(attempts).toHaveLength(4)
    congested = true
    emitEvent('session:item-delta', [id, { target: t, chunk: 'again' }])
    vi.advanceTimersByTime(99)
    expect(attempts).toHaveLength(5)
    vi.advanceTimersByTime(1)
    expect(attempts).toHaveLength(6)
  })
  it('caps recovery backoff at two seconds and cancels it on disconnect', () => {
    vi.useFakeTimers()
    const id = 'backpressure-cap'
    emitEvent('session:created', [id, { cwd: '/fixture', engineId: 'codex' }])
    const t = target('a')
    emitEvent('session:item-open', [id, { target: t, message: message('a') }])
    let attempts = 0
    const disconnect = addStreamSubscriber('cap-test', (frame) => {
      if (frame.type === 'item-stream') attempts++
      return false
    })
    setStreamWatch('cap-test', [id])
    expect(attempts).toBe(1)
    for (const delay of [100, 200, 400, 800, 1600, 2000, 2000]) {
      vi.advanceTimersByTime(delay - 1)
      const before = attempts
      vi.advanceTimersByTime(1)
      expect(attempts).toBe(before + 1)
    }
    disconnect()
    const disconnectedAt = attempts
    vi.advanceTimersByTime(10_000)
    expect(attempts).toBe(disconnectedAt)
  })
  it('clears a retry scheduled while the last of multiple pending sessions drains', () => {
    vi.useFakeTimers()
    const ids = ['multi-a', 'multi-b']
    for (const id of ids) {
      emitEvent('session:created', [id, { cwd: '/fixture', engineId: 'codex' }])
      emitEvent('session:item-open', [id, { target: target('item'), message: message('item') }])
    }
    let congested = true
    let attempts = 0
    addStreamSubscriber('multi-test', (frame) => {
      if (frame.type === 'item-stream') attempts++
      return !congested
    })
    setStreamWatch('multi-test', ids)
    expect(attempts).toBe(2)
    congested = false
    vi.advanceTimersByTime(100)
    expect(attempts).toBe(4)

    congested = true
    emitEvent('session:item-delta', ['multi-a', { target: target('item'), chunk: 'new' }])
    expect(attempts).toBe(5)
    vi.advanceTimersByTime(99)
    expect(attempts).toBe(5)
    vi.advanceTimersByTime(1)
    expect(attempts).toBe(6)
  })
})
