/**
 * The render-loss detector (F4).
 *
 * Two of twenty real-turn drives rendered only the user bubble and a spinner
 * while core's canonical held every message, and nothing captured WHICH renderer
 * layer lost them. These tests pin the three things the detector has to get
 * right for the next occurrence to be self-reporting:
 *
 *  - the four findings are computed from the store/canonical pair alone, one
 *    kind at a time, and a healthy pair produces NOTHING (a per-turn info line
 *    would bury the one warn that matters);
 *  - the scheduler rides the real replica — a real `session:status` fold, a real
 *    coalesced timer, a real rekey — rather than a second event tap;
 *  - `emptyTurn` excludes the turns that legitimately end on the user (a held
 *    queue item, an open approval, an unsealed streaming buffer, an `error`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  auditProjection,
  startProjectionAudit,
  PROJECTION_AUDIT_DELAY_MS,
  type ProjectionAuditInput
} from '../projection-audit'
import { useSessionStore, EMPTY_SESSION_STATE } from '../../stores/session-store'
import { getReplicaState } from '../../stores/replica'
import { emptyCanonicalState, emptySession } from '../../../../core/shared/sync/state'
import type { CanonicalState } from '../../../../core/shared/sync/state'
import type { ChatMessage } from '../../../../shared/types'
import { seed, resetReplicaSeam, nextSeq } from '@test/helpers/replica-seed'
import { getSyncClient } from '../../../../core/shared/sync/client-registry'
import {
  makeUserMessage,
  makeAssistantMessage,
  makeSessionStatus,
  makePendingApproval
} from '@test/factories/messages'

// ---------------------------------------------------------------------------
// (a) the pure audit over hand-built pairs
// ---------------------------------------------------------------------------

/** Canonical with one session whose transcript is `messages`. */
function canonicalWith(id: string, messages: ChatMessage[]): CanonicalState {
  const base = emptyCanonicalState()
  return { ...base, sessions: { [id]: { ...emptySession(id, '/p'), messages } } }
}

/** The audit inputs for a HEALTHY pair — the store shares canonical's array. */
function healthy(id: string, messages: ChatMessage[]): ProjectionAuditInput {
  const canonical = canonicalWith(id, messages)
  return {
    id,
    endedState: 'idle',
    storeSessions: { [id]: { messages: canonical.sessions[id].messages } },
    canonical,
    resolveRetired: (key) => key,
    resyncCount: 0,
    resyncDelta: 0,
    lastSeq: 7
  }
}

describe('auditProjection — the four findings', () => {
  const turn = (): ChatMessage[] => [makeUserMessage('hi'), makeAssistantMessage('hello')]

  it('reports nothing for a healthy pair', () => {
    expect(auditProjection(healthy('s1', turn()))).toBeNull()
  })

  it('reports `projection` when the store holds a different array than canonical', () => {
    const input = healthy('s1', turn())
    // Same CONTENT, different identity — exactly what a projection that rebuilt
    // the entry instead of sharing canonical's array would leave behind.
    const report = auditProjection({
      ...input,
      storeSessions: { s1: { messages: [...input.canonical.sessions['s1'].messages] } }
    })
    expect(report?.findings).toEqual(['projection'])
    expect(report?.projectionIds).toEqual(['s1'])
    expect(report?.storeCount).toBe(2)
    expect(report?.canonicalCount).toBe(2)
  })

  it('reports `projection` when canonical knows a session the store has lost', () => {
    const input = healthy('s1', turn())
    const report = auditProjection({ ...input, storeSessions: {} })
    expect(report?.findings).toEqual(['projection'])
    expect(report?.projectionIds).toEqual(['s1'])
    expect(report?.storeCount).toBe(0)
  })

  it('reports `retired` for a store key a rekey should have retired', () => {
    const input = healthy('s1', turn())
    const report = auditProjection({
      ...input,
      storeSessions: { ...input.storeSessions, old: { messages: [] } },
      resolveRetired: (key) => (key === 'old' ? 's1' : key)
    })
    expect(report?.findings).toEqual(['retired'])
    expect(report?.retiredIds).toEqual(['old'])
  })

  it('reports `emptyTurn` when an idle transcript ends on the user', () => {
    const report = auditProjection(healthy('s1', [makeUserMessage('hi')]))
    expect(report?.findings).toEqual(['emptyTurn'])
    expect(report?.canonicalRoles).toEqual({ user: 1 })
    expect(report?.id).toBe('s1')
  })

  it('reports `resyncs` when the count moved during the turn', () => {
    const report = auditProjection({ ...healthy('s1', turn()), resyncCount: 3, resyncDelta: 2 })
    expect(report?.findings).toEqual(['resyncs'])
    expect(report?.resyncDelta).toBe(2)
    expect(report?.resyncCount).toBe(3)
  })

  it('carries every kind at once when everything is wrong', () => {
    const input = healthy('s1', [makeUserMessage('hi')])
    const report = auditProjection({
      ...input,
      storeSessions: { s1: { messages: [] }, old: { messages: [] } },
      resolveRetired: (key) => (key === 'old' ? 's1' : key),
      resyncCount: 1,
      resyncDelta: 1
    })
    expect(report?.findings).toEqual(['projection', 'retired', 'emptyTurn', 'resyncs'])
    expect(() => JSON.stringify(report)).not.toThrow()
  })
})

describe('auditProjection — what `emptyTurn` excludes', () => {
  /** A transcript that ends on the user, plus one canonical field patched. */
  function endingOnUser(patch: Partial<CanonicalState['sessions'][string]>): ProjectionAuditInput {
    const input = healthy('s1', [makeUserMessage('hi')])
    const session = { ...input.canonical.sessions['s1'], ...patch }
    return {
      ...input,
      canonical: { ...input.canonical, sessions: { s1: session } },
      storeSessions: { s1: { messages: session.messages } }
    }
  }

  it('does not fire after an `error` status — the failure is already reported', () => {
    expect(
      auditProjection({ ...healthy('s1', [makeUserMessage('hi')]), endedState: 'error' })
    ).toBe(null)
  })

  it('does not fire while a queued prompt is held', () => {
    const report = auditProjection(
      endingOnUser({ queue: [{ itemId: 'q1', text: 'next', state: 'queued' }] })
    )
    expect(report).toBeNull()
  })

  it('fires when the only queue entries are already consumed', () => {
    const report = auditProjection(
      endingOnUser({ queue: [{ itemId: 'q1', text: 'sent', state: 'consumed' }] })
    )
    expect(report?.findings).toEqual(['emptyTurn'])
  })

  it('does not fire while an approval is open', () => {
    const report = auditProjection(endingOnUser({ pendingApprovals: [makePendingApproval()] }))
    expect(report).toBeNull()
  })

  it('does not fire while an item is unsealed', () => {
    const target = { messageId: 'assistant-1', blockIndex: 0, kind: 'text' as const }
    const report = auditProjection(
      endingOnUser({
        itemStreams: {
          '[null,"assistant-1",0,"text"]': { target, generation: 8, value: 'partial reply' }
        }
      })
    )
    expect(report).toBeNull()
  })

  it('still fires when only a child item is unsealed', () => {
    const target = {
      messageId: 'child-1',
      blockIndex: 0,
      kind: 'text' as const,
      ownerToolUseId: 'background-tool'
    }
    const report = auditProjection(
      endingOnUser({
        itemStreams: {
          '["background-tool","child-1",0,"text"]': {
            target,
            generation: 8,
            value: 'child output'
          }
        }
      })
    )
    expect(report?.findings).toEqual(['emptyTurn'])
  })

  it('does not fire for a session canonical no longer has', () => {
    const input = healthy('s1', [makeUserMessage('hi')])
    expect(auditProjection({ ...input, id: 'gone' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (b)/(c) the scheduler, through the real replica
// ---------------------------------------------------------------------------

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

describe('the audit rides the real replica', () => {
  let logRelay: ReturnType<typeof vi.fn>
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    resetReplicaSeam()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    logRelay = vi.fn()
    // `saveSessionConfig` is not decoration: a rekey persists the renamed
    // registry from inside the replica's tap, BEFORE the post-apply observers
    // run, so an api without it throws and the audit never sees the event.
    ;(window as unknown as { api: unknown }).api = { logRelay, saveSessionConfig: vi.fn() }
    stop = startProjectionAudit()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  /** The parsed payload of the single warn line the audit relayed. */
  const relayed = (): Record<string, unknown> => {
    expect(logRelay).toHaveBeenCalledTimes(1)
    const [level, source, message] = logRelay.mock.calls[0]
    expect(level).toBe('warn')
    expect(source).toBe('ProjectionAudit')
    return JSON.parse(message as string)
  }

  it('warns once, with `emptyTurn`, when an idle turn produced no reply', () => {
    seed.created('r1', { cwd: '/p' })
    seed.status('r1', makeSessionStatus({ state: 'running' }))
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    expect(logRelay).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)

    const payload = relayed()
    expect(payload.id).toBe('r1')
    expect(payload.findings).toEqual(['emptyTurn'])
    expect(payload.canonicalRoles).toEqual({ user: 1 })
  })

  it('says nothing when the assistant replied', () => {
    seed.created('r1', { cwd: '/p' })
    seed.status('r1', makeSessionStatus({ state: 'running' }))
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.message('r1', makeAssistantMessage('hello'))
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS * 2)
    expect(logRelay).not.toHaveBeenCalled()
  })

  it('coalesces repeated idle statuses into ONE audit', () => {
    seed.created('r1', { cwd: '/p' })
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.status('r1', makeSessionStatus({ state: 'idle' }))
    seed.status('r1', makeSessionStatus({ state: 'idle' }))
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    expect(logRelay).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending audit when the next turn starts running', () => {
    seed.created('r1', { cwd: '/p' })
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.status('r1', makeSessionStatus({ state: 'idle' }))
    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS - 1)
    seed.status('r1', makeSessionStatus({ state: 'running' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS * 2)
    expect(logRelay).not.toHaveBeenCalled()
  })

  it('never throws when the relay itself fails', () => {
    ;(window as unknown as { api: unknown }).api = {
      saveSessionConfig: vi.fn(),
      logRelay: () => {
        throw new Error('relay is down')
      }
    }
    seed.created('r1', { cwd: '/p' })
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.status('r1', makeSessionStatus({ state: 'idle' }))
    expect(() => vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)).not.toThrow()
  })

  it('reports no `retired` finding for a Codex-style rekey', () => {
    seed.created('minted-1', { cwd: '/p' })
    seed.userMessage('minted-1', { id: 'u1', prompt: 'hi' })
    // The engine reports its stable id on the status that also ends the turn.
    seed.status('minted-1', makeSessionStatus({ state: 'idle', sessionId: 'thread-9', cwd: '/p' }))
    expect(store().sessions['minted-1']).toBeUndefined()
    expect(getReplicaState().sessions['thread-9']).toBeDefined()

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    const payload = relayed()
    // The audit followed the rekey: it audited the NEW id, and found only the
    // lost reply — no ghost of the minted id.
    expect(payload.id).toBe('thread-9')
    expect(payload.findings).toEqual(['emptyTurn'])
    expect(payload.retiredIds).toEqual([])
  })

  it('reports `retired` when the old key is still resident in the store', () => {
    seed.created('minted-1', { cwd: '/p' })
    seed.message('minted-1', makeAssistantMessage('hello'))
    seed.status('minted-1', makeSessionStatus({ state: 'idle', sessionId: 'thread-9', cwd: '/p' }))
    // Hand-corrupt the store the way a failed rekey carry-over would: the
    // retired key is back, pointing at a session canonical no longer has.
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        'minted-1': { ...EMPTY_SESSION_STATE, cwd: '/p' }
      }
    })

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    const payload = relayed()
    expect(payload.findings).toEqual(['retired'])
    expect(payload.retiredIds).toEqual(['minted-1'])
  })

  /**
   * A gap the client never healed (the seam's `requestResync` is a no-op) still
   * MOVES the counter, which is the signal: a resync replaced canonical
   * underneath a turn that otherwise looks complete.
   */
  it('reports `resyncs` when the count moved between turn start and turn end', () => {
    seed.created('r1', { cwd: '/p' })
    seed.status('r1', makeSessionStatus({ state: 'running' }))
    seed.userMessage('r1', { id: 'u1', prompt: 'hi' })
    seed.message('r1', makeAssistantMessage('hello'))
    seed.status('r1', makeSessionStatus({ state: 'idle' }))
    // After the schedule, so the events above still fold contiguously.
    getSyncClient()!.receiveEvent({ seq: nextSeq() + 5, channel: 'session:message', args: ['r1'] })

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    const payload = relayed()
    expect(payload.findings).toEqual(['resyncs'])
    expect(payload.resyncDelta).toBe(1)
    expect(payload.resyncCount).toBe(1)
  })

  it('does not blame a turn for a resync that predates it', () => {
    // A resync before this turn's `running` — the baseline is taken after it, so
    // the delta is 0 and a healthy turn stays silent.
    seed.created('r1', { cwd: '/p' })
    getSyncClient()!.receiveEvent({ seq: nextSeq() + 5, channel: 'session:message', args: ['r1'] })
    seed.status('r1', makeSessionStatus({ state: 'running' }))
    seed.message('r1', makeAssistantMessage('hello'))
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    expect(logRelay).not.toHaveBeenCalled()
  })

  /**
   * The first Codex turn of a session runs under the MINTED routing id until the
   * engine reports its thread id, and that rekey rides a `session:status` that is
   * usually still `running`. The baseline taken at the first `running` must
   * survive both the rekey (carried to the new id) and the later `running`
   * echo (not re-taken), or a resync inside that window is never attributed.
   */
  it('attributes a resync that landed before the rekey of the first Codex turn', () => {
    seed.created('minted-1', { cwd: '/p' })
    seed.status('minted-1', makeSessionStatus({ state: 'running' }))
    seed.userMessage('minted-1', { id: 'u1', prompt: 'hi' })
    getSyncClient()!.receiveEvent({
      seq: nextSeq() + 5,
      channel: 'session:message',
      args: ['minted-1']
    })
    seed.status(
      'minted-1',
      makeSessionStatus({ state: 'running', sessionId: 'thread-9', cwd: '/p' })
    )
    seed.message('thread-9', makeAssistantMessage('hello'))
    seed.status('thread-9', makeSessionStatus({ state: 'idle' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    const payload = relayed()
    expect(payload.id).toBe('thread-9')
    expect(payload.findings).toEqual(['resyncs'])
    expect(payload.resyncDelta).toBe(1)
  })

  it('stays silent about a resync it cannot attribute — no turn start was seen', () => {
    seed.created('r1', { cwd: '/p' })
    getSyncClient()!.receiveEvent({ seq: nextSeq() + 5, channel: 'session:message', args: ['r1'] })
    seed.message('r1', makeAssistantMessage('hello'))
    // No `running` ever observed for this session, so there is no baseline.
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    vi.advanceTimersByTime(PROJECTION_AUDIT_DELAY_MS)
    expect(logRelay).not.toHaveBeenCalled()
  })
})
