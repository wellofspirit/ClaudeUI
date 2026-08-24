/**
 * @vitest-environment node
 *
 * The volatile stream lane — SyncCore phase 5 S1.
 *
 * `applyStreamFrame` is to the stream lane what `applyEvent` is to the event
 * lane: ONE interpretation, folded by core against canonical state and by every
 * client replica against its mirror. So the properties pinned here are the ones
 * that make "the two sides cannot disagree" true — accumulation, the offset
 * guard, the generation, and the replay that heals a divergence.
 *
 * The event-lane half of the interplay (a message seal, a retraction, a clear —
 * all of which CLEAR a buffer and start its next generation) is exercised through
 * the real reducer, because the aux is the only thing the two lanes share and a
 * test that faked it would prove nothing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyEvent, emptyAux, type ReducerAux } from '../reducer'
import {
  MAX_STREAM_WATCH,
  STREAM_BACKPRESSURE_BYTES,
  applyStreamFrame,
  isStreamEventFrame,
  streamEventScopeOf,
  bumpStreamTurn,
  dropStreamTurns,
  isStreamFrame,
  parseStreamId,
  rekeyStreamTurns,
  sessionIdOfStream,
  streamFrameFrom,
  streamIdFor,
  streamReplayFrames,
  streamTurnOf,
  type StreamFrame
} from '../stream'
import { emptyCanonicalState, emptySession, type CanonicalState } from '../state'
import type { SessionStatus } from '../../../../shared/types'

const RID = 'rid'

function stateWith(routingId = RID): CanonicalState {
  const base = emptyCanonicalState()
  return { ...base, sessions: { [routingId]: emptySession(routingId, '/repo') } }
}

/** Emit one delta the way `SyncCore.process` does: build the frame, then fold it. */
function emitDelta(
  state: CanonicalState,
  aux: ReducerAux,
  channel: string,
  args: unknown[]
): { state: CanonicalState; frame: StreamFrame | null } {
  const frame = streamFrameFrom(state, aux, channel, args)
  if (!frame) return { state, frame: null }
  return { state: applyStreamFrame(state, aux, frame).state, frame }
}

function text(state: CanonicalState, routingId = RID): string {
  return state.sessions[routingId].streamingText
}
function thinking(state: CanonicalState, routingId = RID): string {
  return state.sessions[routingId].streamingThinking
}

// ---------------------------------------------------------------------------

describe('streamId scheme (the single source)', () => {
  it('round-trips both shapes', () => {
    expect(streamIdFor(RID, 'text')).toBe('rid/text')
    expect(streamIdFor(RID, 'thinking')).toBe('rid/thinking')
    expect(streamIdFor(RID, 'text', 'tu-1')).toBe('rid/sub/tu-1/text')
    for (const id of ['rid/text', 'rid/thinking', 'rid/sub/tu-1/text', 'rid/sub/tu-1/thinking']) {
      const parsed = parseStreamId(id)!
      expect(streamIdFor(parsed.routingId, parsed.kind, parsed.toolUseId)).toBe(id)
    }
  })

  it('parses from the RIGHT, so a routing id containing a slash survives', () => {
    // Routing ids are opaque (a temp id, or whatever an engine reports), so only
    // the tail has fixed structure.
    const parsed = parseStreamId('a/b/c/text')!
    expect(parsed).toEqual({ routingId: 'a/b/c', kind: 'text' })
    expect(sessionIdOfStream('a/b/c/sub/tu/thinking')).toBe('a/b/c')
  })

  it('rejects a malformed id rather than guessing', () => {
    for (const bad of ['', 'rid', 'rid/audio', '/text', 'rid/sub//text']) {
      expect(parseStreamId(bad), bad).toBeNull()
    }
  })
})

describe('frame validation (the single source both transports use)', () => {
  const good: StreamFrame = {
    type: 'stream',
    streamId: 'rid/text',
    turnId: 0,
    offset: 0,
    chunk: 'x'
  }

  it('accepts a well-formed frame', () => {
    expect(isStreamFrame(good)).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isStreamFrame(null)).toBe(false)
    expect(isStreamFrame({ ...good, type: 'event' })).toBe(false)
    expect(isStreamFrame({ ...good, streamId: '' })).toBe(false)
    expect(isStreamFrame({ ...good, offset: -1 })).toBe(false)
    expect(isStreamFrame({ ...good, offset: 1.5 })).toBe(false)
    expect(isStreamFrame({ ...good, turnId: 'a' })).toBe(false)
    expect(isStreamFrame({ ...good, chunk: 42 })).toBe(false)
  })
})

describe('accumulation', () => {
  it('appends text and thinking into separate buffers', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'hm' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'm' }]))
    expect(thinking(s)).toBe('hmm')
    expect(text(s)).toBe('')
  })

  it('the offset of each frame is the length BEFORE its chunk', () => {
    const aux = emptyAux()
    let s = stateWith()
    const offsets: number[] = []
    for (const chunk of ['abc', 'de', 'f']) {
      const out = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: chunk }])
      s = out.state
      offsets.push(out.frame!.offset)
    }
    expect(offsets).toEqual([0, 3, 5])
    expect(text(s)).toBe('abcdef')
  })

  it('a text delta seals an open thinking span (and only the first one does)', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'hm' }]))
    expect(aux.thinkingOpen[RID]).toBe(true)
    const sealTurn = streamTurnOf(aux, streamIdFor(RID, 'thinking'))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'answer' }]))
    expect(thinking(s)).toBe('')
    expect(aux.thinkingOpen[RID]).toBe(false)
    // The seal is a CLEAR, so the thinking stream turns over.
    expect(streamTurnOf(aux, streamIdFor(RID, 'thinking'))).toBe(sealTurn + 1)
    // A second text delta has nothing left to seal.
    const after = streamTurnOf(aux, streamIdFor(RID, 'thinking'))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: '!' }]))
    expect(streamTurnOf(aux, streamIdFor(RID, 'thinking'))).toBe(after)
    expect(text(s)).toBe('answer!')
  })

  it('subagent streams are keyed per toolUseId, and text supersedes thinking', () => {
    const aux = emptyAux()
    let s = stateWith()
    const sub = (toolUseId: string, type: string, t: string): void => {
      ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
        RID,
        { toolUseId, type, text: t }
      ]))
    }
    sub('tu-1', 'thinking', 'planning')
    sub('tu-2', 'text', 'other')
    expect(s.sessions[RID].subagentStreamingThinking['tu-1']).toBe('planning')
    expect(s.sessions[RID].subagentStreamingText['tu-2']).toBe('other')
    sub('tu-1', 'text', 'doing it')
    expect(s.sessions[RID].subagentStreamingThinking['tu-1']).toBe('')
    expect(s.sessions[RID].subagentStreamingText['tu-1']).toBe('doing it')
    // tu-2 is untouched by tu-1's seal.
    expect(s.sessions[RID].subagentStreamingText['tu-2']).toBe('other')
  })

  it('a session the replica does not know is an honest no-op, identity-stable', () => {
    const aux = emptyAux()
    const before = emptyCanonicalState()
    // No frame can even be built without a session to measure the offset against.
    expect(
      streamFrameFrom(before, aux, 'session:stream', [RID, { type: 'text', text: 'x' }])
    ).toBeNull()
    // And a frame that arrives anyway (a delete the client already folded) changes
    // nothing — the projection is identity-diffed, so a fresh object would
    // re-write every slice.
    const outcome = applyStreamFrame(before, aux, {
      type: 'stream',
      streamId: 'rid/text',
      turnId: 0,
      offset: 0,
      chunk: 'x'
    })
    expect(outcome.result).toBe('unknown')
    expect(outcome.state).toBe(before)
    expect(aux.thinkingOpen).toEqual({})
    expect(aux.streamTurn).toEqual({})
  })

  it('a malformed delta produces no frame', () => {
    const aux = emptyAux()
    const s = stateWith()
    expect(streamFrameFrom(s, aux, 'session:stream', [RID, { type: 'text' }])).toBeNull()
    expect(streamFrameFrom(s, aux, 'session:stream', [42, { type: 'text', text: 'x' }])).toBeNull()
    // A subagent delta with no toolUseId names no stream.
    expect(
      streamFrameFrom(s, aux, 'session:subagent-stream', [RID, { type: 'text', text: 'x' }])
    ).toBeNull()
    // And a channel that is not on the lane at all.
    expect(
      streamFrameFrom(s, aux, 'session:message', [RID, { type: 'text', text: 'x' }])
    ).toBeNull()
  })
})

describe('the offset / generation guard', () => {
  it('an offset that does not fit is a NO-OP that signals mismatch', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'abc' }]))
    const stale = applyStreamFrame(s, aux, {
      type: 'stream',
      streamId: streamIdFor(RID, 'text'),
      turnId: streamTurnOf(aux, streamIdFor(RID, 'text')),
      offset: 99,
      chunk: 'def'
    })
    expect(stale.result).toBe('mismatch')
    // NOTHING changed — applying at the wrong offset would silently corrupt the
    // text, which is the whole reason the guard exists.
    expect(stale.state).toBe(s)
    expect(text(s)).toBe('abc')
  })

  it('a stale generation is treated exactly like a stale offset', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'abc' }]))
    const out = applyStreamFrame(s, aux, {
      type: 'stream',
      streamId: streamIdFor(RID, 'text'),
      turnId: streamTurnOf(aux, streamIdFor(RID, 'text')) + 7,
      offset: 3,
      chunk: 'def'
    })
    expect(out.result).toBe('mismatch')
    expect(out.state).toBe(s)
  })

  it('offset 0 on a NON-EMPTY buffer REPLACES, and adopts the sender generation', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'stale' }]))
    const out = applyStreamFrame(s, aux, {
      type: 'stream',
      streamId: streamIdFor(RID, 'text'),
      // A generation this replica has never seen: a replay must not be
      // conditional on agreeing about the number it exists to correct.
      turnId: 42,
      offset: 0,
      chunk: 'the whole coalesced value'
    })
    expect(out.result).toBe('applied')
    expect(text(out.state)).toBe('the whole coalesced value')
    expect(streamTurnOf(aux, streamIdFor(RID, 'text'))).toBe(42)
  })

  it('offset 0 on an EMPTY buffer is an ordinary first chunk (it still seals)', () => {
    // The distinction the replace rule turns on: without it, no turn's first text
    // delta would ever seal a thinking span.
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'hm' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'go' }]))
    expect(text(s)).toBe('go')
    expect(thinking(s)).toBe('')
  })
})

describe('replay-on-subscribe (the self-heal)', () => {
  it('states EVERY stream of the session at offset 0, text before thinking', () => {
    // Including the empty ones: a replay is a claim about the session, and a
    // stream it stays silent about is a stream re-watching cannot correct.
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'answer' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'more' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'sub' }
    ]))
    const frames = streamReplayFrames(s, aux, RID)
    expect(frames.map((f) => f.streamId)).toEqual([
      `${RID}/text`,
      `${RID}/thinking`,
      `${RID}/sub/tu-1/text`,
      `${RID}/sub/tu-1/thinking`
    ])
    expect(frames.every((f) => f.offset === 0)).toBe(true)
    expect(frames.map((f) => f.chunk)).toEqual(['answer', 'more', 'sub', ''])
  })

  it('is bounded by the session, not by the turn', () => {
    // Two per session plus two per toolUseId that has actually streamed — the
    // maps are per-session, so the frame count cannot grow with turn length.
    const aux = emptyAux()
    let s = stateWith()
    for (const toolUseId of ['tu-1', 'tu-2', 'tu-3']) {
      for (let i = 0; i < 50; i++) {
        ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
          RID,
          { toolUseId, type: 'text', text: 'x' }
        ]))
      }
    }
    expect(streamReplayFrames(s, aux, RID)).toHaveLength(2 + 3 * 2)
  })

  it('heals a divergent replica exactly — including the (text, thinking) pair', () => {
    // The ordering hazard the replay exists to survive: a text frame landing on an
    // EMPTY buffer seals, so replaying thinking first would wipe what it restored.
    const hostAux = emptyAux()
    let host = stateWith()
    ;({ state: host } = emitDelta(host, hostAux, 'session:stream', [
      RID,
      { type: 'text', text: 'answer' }
    ]))
    ;({ state: host } = emitDelta(host, hostAux, 'session:stream', [
      RID,
      { type: 'thinking', text: 'second thoughts' }
    ]))

    // A replica that missed everything and holds stale content of its own.
    const replicaAux = emptyAux()
    let replica = stateWith()
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:stream', [
      RID,
      { type: 'thinking', text: 'ancient' }
    ]))

    for (const frame of streamReplayFrames(host, hostAux, RID)) {
      const out = applyStreamFrame(replica, replicaAux, frame)
      expect(out.result).toBe('applied')
      replica = out.state
    }
    expect(text(replica)).toBe(text(host))
    expect(thinking(replica)).toBe(thinking(host))
    // Non-vacuity: the host really is mid-turn with BOTH buffers occupied.
    expect(text(host)).toBe('answer')
    expect(thinking(host)).toBe('second thoughts')
  })

  it('heals a buffer canonical EMPTIED while the replica held content', () => {
    // The case an "only non-empty accumulations" replay cannot express, and it is
    // reachable by ordinary use: watch A mid-thinking, switch away, A's first text
    // delta seals the span on canonical, switch back. The replica keeps a phantom
    // thinking span above the assistant text until the next message seal.
    //
    // A replay is a statement about the WHOLE session, not about the streams that
    // happen to be non-empty in it — so it must be able to say "this one is empty".
    const hostAux = emptyAux()
    let host = stateWith()
    ;({ state: host } = emitDelta(host, hostAux, 'session:stream', [
      RID,
      { type: 'thinking', text: 'xyz' }
    ]))
    // The seal: canonical's thinking is now '' and the span is closed.
    ;({ state: host } = emitDelta(host, hostAux, 'session:stream', [
      RID,
      { type: 'text', text: 'abcdef' }
    ]))
    ;({ state: host } = emitDelta(host, hostAux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'thinking', text: 'sub-thinking' }
    ]))
    ;({ state: host } = emitDelta(host, hostAux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'sub-text' }
    ]))
    expect(thinking(host)).toBe('')
    expect(host.sessions[RID].subagentStreamingThinking['tu-1']).toBe('')

    // The replica watched the first half only: it holds the thinking the seal
    // removed, and its span is still open.
    const replicaAux = emptyAux()
    let replica = stateWith()
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:stream', [
      RID,
      { type: 'thinking', text: 'xyz' }
    ]))
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:stream', [
      RID,
      { type: 'text', text: 'ab' }
    ]))
    // Put the phantom back the way a switch-away leaves it: text arrived, then
    // more thinking, and the seal that would have cleared it never reached here.
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:stream', [
      RID,
      { type: 'thinking', text: 'xyz' }
    ]))
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'thinking', text: 'sub-thinking' }
    ]))
    expect(thinking(replica)).toBe('xyz')
    expect(replicaAux.thinkingOpen[RID]).toBe(true)

    for (const frame of streamReplayFrames(host, hostAux, RID)) {
      const out = applyStreamFrame(replica, replicaAux, frame)
      expect(out.result).toBe('applied')
      replica = out.state
    }

    expect(text(replica)).toBe('abcdef')
    expect(thinking(replica)).toBe('')
    // …and the span bookkeeping, or the next text delta would "seal" a buffer
    // that is already empty and the ticker would keep running.
    expect(replicaAux.thinkingOpen[RID]).toBe(false)
    expect(replica.sessions[RID].subagentStreamingThinking['tu-1']).toBe('')
    expect(replica.sessions[RID].subagentStreamingText['tu-1']).toBe('sub-text')
  })

  it('a live delta continues cleanly from a replayed offset', () => {
    const hostAux = emptyAux()
    let host = stateWith()
    ;({ state: host } = emitDelta(host, hostAux, 'session:stream', [
      RID,
      { type: 'text', text: 'abc' }
    ]))
    const replicaAux = emptyAux()
    let replica = stateWith()
    for (const frame of streamReplayFrames(host, hostAux, RID)) {
      replica = applyStreamFrame(replica, replicaAux, frame).state
    }
    const next = emitDelta(host, hostAux, 'session:stream', [RID, { type: 'text', text: 'def' }])
    host = next.state
    const out = applyStreamFrame(replica, replicaAux, next.frame!)
    expect(out.result).toBe('applied')
    expect(text(out.state)).toBe(text(host))
  })

  it('an idle session still states its two empty streams; an UNKNOWN one says nothing', () => {
    // The distinction matters: "this session has no streaming output" is a fact a
    // replica may need told (it might be holding some); "I have never heard of
    // this session" is not something to answer at all.
    const idle = streamReplayFrames(stateWith(), emptyAux(), RID)
    expect(idle.map((f) => [f.streamId, f.chunk])).toEqual([
      [`${RID}/text`, ''],
      [`${RID}/thinking`, '']
    ])
    expect(streamReplayFrames(emptyCanonicalState(), emptyAux(), RID)).toEqual([])
  })

  it('a frame that changes nothing is identity-stable', () => {
    // Most frames of a replay land on a value the replica already holds, and the
    // store projection is identity-diffed — a fresh object per frame would
    // re-render the whole session entry for every stream of every watch.
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'abc' }]))
    const before = s
    for (const frame of streamReplayFrames(s, aux, RID)) {
      const out = applyStreamFrame(s, aux, frame)
      expect(out.result).toBe('applied')
      s = out.state
    }
    expect(s).toBe(before)
  })
})

describe('generations across the event lane', () => {
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

  it('a committed message bumps the text generation (the seal)', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'partial' }]))
    const before = streamTurnOf(aux, streamIdFor(RID, 'text'))
    s = applyEvent(
      s,
      {
        channel: 'session:message',
        args: [
          RID,
          {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            timestamp: 0
          }
        ],
        seq: 2
      },
      aux
    )
    expect(text(s)).toBe('')
    expect(streamTurnOf(aux, streamIdFor(RID, 'text'))).toBe(before + 1)
  })

  it('a retraction bumps both generations', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'oops' }]))
    const beforeText = streamTurnOf(aux, streamIdFor(RID, 'text'))
    const beforeThinking = streamTurnOf(aux, streamIdFor(RID, 'thinking'))
    s = applyEvent(
      s,
      { channel: 'session:messages-retracted', args: [RID, { messageIds: ['m1'] }], seq: 2 },
      aux
    )
    expect(text(s)).toBe('')
    expect(streamTurnOf(aux, streamIdFor(RID, 'text'))).toBe(beforeText + 1)
    expect(streamTurnOf(aux, streamIdFor(RID, 'thinking'))).toBe(beforeThinking + 1)
  })

  it('a conversation clear bumps the session streams and RETIRES the subagent ones', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'a' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'b' }
    ]))
    const before = { ...aux.streamTurn }
    s = applyEvent(s, { channel: 'session:conversation-cleared', args: [RID, {}], seq: 3 }, aux)
    expect(text(s)).toBe('')
    expect(s.sessions[RID].subagentStreamingText).toEqual({})
    for (const id of [streamIdFor(RID, 'text'), streamIdFor(RID, 'thinking')]) {
      expect(streamTurnOf(aux, id), id).toBe((before[id] ?? 0) + 1)
    }
    // The subagent maps are emptied outright, so their keys are RETIRED rather
    // than bumped — nothing is left to be a generation OF.
    expect(Object.keys(aux.streamTurn).filter((k) => k.includes('/sub/'))).toEqual([])
  })

  it('a rekey carries the generations to the new id (mid-stream rekey)', () => {
    const aux = emptyAux()
    let s = stateWith('temp-1')
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [
      'temp-1',
      { type: 'text', text: 'Partial ' }
    ]))
    bumpStreamTurn(aux, streamIdFor('temp-1', 'text'))
    const carried = streamTurnOf(aux, streamIdFor('temp-1', 'text'))
    s = applyEvent(
      s,
      { channel: 'session:status', args: ['temp-1', status({ sessionId: 'uuid-9' })], seq: 2 },
      aux
    )
    expect(s.sessions['uuid-9']).toBeDefined()
    expect(streamTurnOf(aux, streamIdFor('uuid-9', 'text'))).toBe(carried)
    expect(aux.streamTurn[streamIdFor('temp-1', 'text')]).toBeUndefined()
    // …and a delta on the NEW id continues from the carried offset rather than
    // being refused as a stale generation.
    const out = emitDelta(s, aux, 'session:stream', ['uuid-9', { type: 'text', text: 'answer' }])
    expect(out.frame!.offset).toBe('Partial '.length)
    expect(text(out.state, 'uuid-9')).toBe('Partial answer')
  })

  it('a subagent message DROPS its generations rather than accreting them', () => {
    // toolUseIds are minted per tool call, so bumping would grow `streamTurn` by
    // two entries per subagent for the session's whole life. Dropping is sound
    // because the clear rides the EVENT lane — every replica folds it, watching
    // or not — so both sides land on "no key", which reads as generation 0.
    const aux = emptyAux()
    let s = stateWith()
    for (const toolUseId of ['tu-1', 'tu-2', 'tu-3']) {
      ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
        RID,
        { toolUseId, type: 'text', text: 'partial' }
      ]))
    }
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'x' }]))
    const subKeys = () => Object.keys(aux.streamTurn).filter((k) => k.includes('/sub/'))
    expect(subKeys().length).toBeGreaterThan(0)

    for (const toolUseId of ['tu-1', 'tu-2', 'tu-3']) {
      s = applyEvent(
        s,
        {
          channel: 'session:subagent-message',
          args: [
            RID,
            {
              toolUseId,
              message: { id: `m-${toolUseId}`, role: 'assistant', content: [], timestamp: 0 }
            }
          ],
          seq: 9
        },
        aux
      )
    }
    expect(subKeys()).toEqual([])
    // The parent's own generations are untouched — only the retired keys go.
    expect(streamTurnOf(aux, streamIdFor(RID, 'text'))).toBeGreaterThanOrEqual(0)
  })

  it('a MULTI-TURN subagent keeps streaming after its message, from a clean generation', () => {
    // The premise "a cleared subagent stream can never flow again" is false — a
    // subagent emits more deltas after its first message — so the drop has to be
    // safe rather than merely unreachable. It is: the buffer is empty on both
    // sides and the key is absent on both, so the next frame is offset 0 / turn 0
    // and simply appends.
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'first turn' }
    ]))
    s = applyEvent(
      s,
      {
        channel: 'session:subagent-message',
        args: [
          RID,
          { toolUseId: 'tu-1', message: { id: 'm1', role: 'assistant', content: [], timestamp: 0 } }
        ],
        seq: 2
      },
      aux
    )
    expect(s.sessions[RID].subagentStreamingText['tu-1']).toBe('')

    const next = emitDelta(s, aux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'second turn' }
    ])
    expect(next.frame).toMatchObject({ offset: 0, turnId: 0 })
    expect(next.state.sessions[RID].subagentStreamingText['tu-1']).toBe('second turn')
    // …and a replica folding the same two lanes agrees, key for key.
    const replicaAux = emptyAux()
    let replica = stateWith()
    ;({ state: replica } = emitDelta(replica, replicaAux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'first turn' }
    ]))
    replica = applyEvent(
      replica,
      {
        channel: 'session:subagent-message',
        args: [
          RID,
          { toolUseId: 'tu-1', message: { id: 'm1', role: 'assistant', content: [], timestamp: 0 } }
        ],
        seq: 2
      },
      replicaAux
    )
    const out = applyStreamFrame(replica, replicaAux, next.frame!)
    expect(out.result).toBe('applied')
    expect(out.state.sessions[RID].subagentStreamingText['tu-1']).toBe('second turn')
  })

  it('the parent going idle drops its FOREGROUND subagents generations, keeps background', () => {
    const aux = emptyAux()
    let s = stateWith()
    // A background subagent is one whose tool_use carried run_in_background.
    s = applyEvent(
      s,
      {
        channel: 'session:message',
        args: [
          RID,
          {
            id: 'm1',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                toolUseId: 'bg-1',
                toolName: 'Bash',
                toolInput: { run_in_background: true }
              }
            ],
            timestamp: 0
          }
        ],
        seq: 1
      },
      aux
    )
    for (const toolUseId of ['fg-1', 'bg-1']) {
      ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
        RID,
        { toolUseId, type: 'text', text: 'going' }
      ]))
    }
    s = applyEvent(
      s,
      { channel: 'session:status', args: [RID, status({ state: 'idle' })], seq: 3 },
      aux
    )
    expect(Object.keys(aux.streamTurn).filter((k) => k.includes('/sub/fg-1/'))).toEqual([])
    expect(s.sessions[RID].subagentStreamingText['bg-1']).toBe('going')
  })

  it('a removal drops the generations, so a same-id respawn starts clean', () => {
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'a' }]))
    bumpStreamTurn(aux, streamIdFor(RID, 'text'))
    applyEvent(s, { channel: 'session:removed', args: [RID], seq: 2 }, aux)
    expect(aux.streamTurn).toEqual({})
  })

  it('dropStreamTurns / rekeyStreamTurns touch only the named session', () => {
    const aux = emptyAux()
    bumpStreamTurn(aux, streamIdFor('a', 'text'))
    bumpStreamTurn(aux, streamIdFor('ab', 'text'))
    dropStreamTurns(aux, 'a')
    expect(Object.keys(aux.streamTurn)).toEqual([streamIdFor('ab', 'text')])
    rekeyStreamTurns(aux, 'ab', 'cd')
    expect(Object.keys(aux.streamTurn)).toEqual([streamIdFor('cd', 'text')])
    // Identity rekey is a no-op rather than a self-delete.
    rekeyStreamTurns(aux, 'cd', 'cd')
    expect(Object.keys(aux.streamTurn)).toEqual([streamIdFor('cd', 'text')])
  })
})

describe('purity (the same contract applyEvent carries)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads no clock and no randomness', () => {
    const now = vi.spyOn(Date, 'now')
    const random = vi.spyOn(Math, 'random')
    const aux = emptyAux()
    let s = stateWith()
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'thinking', text: 'hm' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:stream', [RID, { type: 'text', text: 'go' }]))
    ;({ state: s } = emitDelta(s, aux, 'session:subagent-stream', [
      RID,
      { toolUseId: 'tu-1', type: 'text', text: 'sub' }
    ]))
    streamReplayFrames(s, aux, RID)
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
  })

  it('the watch cap is a named bound, not a magic number at the call site', () => {
    expect(MAX_STREAM_WATCH).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// The PASS-THROUGH flavor (phase 5 S2)
// ---------------------------------------------------------------------------

describe('pass-through frames (the tails)', () => {
  it('validates structurally, and rejects the text flavor', () => {
    expect(
      isStreamEventFrame({ type: 'stream-ev', channel: 'session:bash-output', args: [] })
    ).toBe(true)
    // `args` must be an array — the frame IS the emission, and an emission is
    // positional (`(routingId, data)`). Anything else cannot be dispatched.
    expect(isStreamEventFrame({ type: 'stream-ev', channel: 'x' })).toBe(false)
    expect(isStreamEventFrame({ type: 'stream-ev', args: [] })).toBe(false)
    expect(isStreamEventFrame({ type: 'stream', streamId: 'a/text' })).toBe(false)
    expect(isStreamEventFrame(null)).toBe(false)
    // …and the two validators do not accept each other's frames, or a decoder
    // could route one flavor into the other's fold.
    expect(isStreamFrame({ type: 'stream-ev', channel: 'c', args: [] })).toBe(false)
  })

  it('scopes the session tails by routingId and the automation tail by automationId', () => {
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'session:bash-output',
        args: [RID, { toolUseId: 'tu-1', output: 'x' }]
      })
    ).toEqual({ kind: 'session', id: RID })
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'session:background-output',
        args: [RID, { toolUseId: 'tu-1', tail: 'x' }]
      })
    ).toEqual({ kind: 'session', id: RID })
    // Automation-scoped, NOT run-scoped: the payload carries no run id, and
    // inventing one here would be a second answer to "which run is this".
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'automation:stream-event',
        args: [{ automationId: 'auto-1', type: 'text', text: 'x' }]
      })
    ).toEqual({ kind: 'automation', id: 'auto-1' })
  })

  it('refuses to scope a malformed payload (delivered to nobody, never broadcast)', () => {
    const cases = [
      { channel: 'session:bash-output', args: [] },
      { channel: 'session:bash-output', args: [42] },
      { channel: 'session:bash-output', args: [''] },
      { channel: 'automation:stream-event', args: [{}] },
      { channel: 'automation:stream-event', args: [{ automationId: '' }] },
      { channel: 'automation:stream-event', args: [] }
    ]
    for (const c of cases) {
      expect(
        streamEventScopeOf({ type: 'stream-ev', ...c }),
        `${c.channel} ${JSON.stringify(c.args)}`
      ).toBeNull()
    }
  })

  it('the backpressure budget is a named bound matching the PTY high-water mark', () => {
    expect(STREAM_BACKPRESSURE_BYTES).toBe(1024 * 1024)
  })
})
