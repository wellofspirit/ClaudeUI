/**
 * @vitest-environment node
 *
 * `answerApproval` — the shared answer seam of `session:approval-response`
 * (desktop and remote). Pending approvals are replicated canonical state, so
 * the answer must retire the card on EVERY client: the seam emits
 * `session:approval-dismiss` once, whatever the engine and card kind
 * (ADR-038 addendum).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionManager } from '../../services/session-manager'

const { resolveXeng, emitEvent } = vi.hoisted(() => ({
  resolveXeng: vi.fn(),
  emitEvent: vi.fn()
}))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  XENG_REQUEST_PREFIX: 'xeng:',
  crossEngineDispatcher: { resolveApproval: resolveXeng }
}))
vi.mock('../../services/sync-host', () => ({ emitEvent }))

import { ApprovalAnswerRejected } from '../../services/approval-errors'
import { answerApproval } from '../approval-response'

function managerWith(session: { resolveApproval: ReturnType<typeof vi.fn> } | undefined) {
  return { get: vi.fn(() => session) } as unknown as SessionManager
}

describe('answerApproval', () => {
  beforeEach(() => {
    resolveXeng.mockReset()
    emitEvent.mockReset()
  })

  it('routes a session card to the session and retires it for every client (pi, A1)', () => {
    // pi's own resolveApproval emits nothing on a human answer; the seam must.
    const session = { resolveApproval: vi.fn() }
    answerApproval(managerWith(session), 'pi-rid', 'req-1', 'allow', { a: 'b' }, undefined)
    expect(session.resolveApproval).toHaveBeenCalledWith('req-1', 'allow', { a: 'b' }, undefined)
    expect(resolveXeng).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith('session:approval-dismiss', [
      'pi-rid',
      { requestId: 'req-1' }
    ])
  })

  it('routes an xeng: card to the dispatcher and dismisses on the routing id the client passed (A2)', () => {
    resolveXeng.mockReturnValue(true)
    const session = { resolveApproval: vi.fn() }
    answerApproval(managerWith(session), 'parent-rid', 'xeng:perm-7', 'deny', undefined, undefined)
    expect(resolveXeng).toHaveBeenCalledWith('xeng:perm-7', 'deny', undefined, undefined)
    expect(session.resolveApproval).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith('session:approval-dismiss', [
      'parent-rid',
      { requestId: 'xeng:perm-7' }
    ])
  })

  it('falls through to the session when the dispatcher declines, and still dismisses', () => {
    resolveXeng.mockReturnValue(false)
    const session = { resolveApproval: vi.fn() }
    answerApproval(managerWith(session), 'rid', 'xeng:stale', 'allow')
    expect(session.resolveApproval).toHaveBeenCalledWith(
      'xeng:stale',
      'allow',
      undefined,
      undefined
    )
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('an unknown session still retires the card (nothing is left to answer it)', () => {
    answerApproval(managerWith(undefined), 'gone', 'req-2', 'deny')
    expect(emitEvent).toHaveBeenCalledWith('session:approval-dismiss', [
      'gone',
      { requestId: 'req-2' }
    ])
  })

  it('a resolve that throws still dismisses and still rejects to the caller (A3)', () => {
    const session = {
      resolveApproval: vi.fn(() => {
        throw new Error('Stale or unknown approval')
      })
    }
    expect(() => answerApproval(managerWith(session), 'pi-rid', 'req-3', 'allow')).toThrow(
      'Stale or unknown approval'
    )
    expect(emitEvent).toHaveBeenCalledWith('session:approval-dismiss', [
      'pi-rid',
      { requestId: 'req-3' }
    ])
  })

  it('a malformed answer to a still-parked request keeps the card but still rejects (A3b)', () => {
    const session = {
      resolveApproval: vi.fn(() => {
        throw new ApprovalAnswerRejected('Missing question answer')
      })
    }
    expect(() => answerApproval(managerWith(session), 'pi-rid', 'req-q', 'allow', {})).toThrow(
      ApprovalAnswerRejected
    )
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('an ApprovalAnswerRejected from the dispatcher keeps the card too', () => {
    resolveXeng.mockImplementation(() => {
      throw new ApprovalAnswerRejected('bad answer')
    })
    expect(() => answerApproval(managerWith(undefined), 'rid', 'xeng:p', 'allow')).toThrow(
      'bad answer'
    )
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('a dispatcher resolve that throws still dismisses and still throws', () => {
    resolveXeng.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => answerApproval(managerWith(undefined), 'rid', 'xeng:p', 'allow')).toThrow('boom')
    expect(emitEvent).toHaveBeenCalledWith('session:approval-dismiss', [
      'rid',
      { requestId: 'xeng:p' }
    ])
  })
})
