/**
 * @vitest-environment node
 *
 * Unit test for claude-session's session:approval-dismiss emissions.
 *
 * Bug being fixed: cli.js ends the parent turn (`result` → status idle) while
 * background subagents may still be running. A subagent's can_use_tool
 * request can arrive — or remain pending — AFTER idle. The renderer used to
 * wipe every pending-approval card on idle, but main's pendingApprovals
 * promise map still held the unresolved entry — so the subagent's approval
 * could never be answered and it hung forever. The renderer fix (idle no
 * longer clears cards) means card removal now depends entirely on main
 * emitting `session:approval-dismiss` at every point it resolves an approval
 * WITHOUT a renderer click: cancel(), interrupt(), and the per-request abort
 * listener inside canUseTool.
 *
 * Uses a minimal replica (see claude-session-resolve-approval.test.ts) so we
 * avoid pulling in Electron/SDK deps. Mirrors the emission sites added to
 * src/main/services/claude-session.ts's cancel()/interrupt()/canUseTool.
 */

import { describe, it, expect } from 'vitest'

interface ApprovalResult {
  decision: 'allow' | 'deny'
}

interface PendingApprovalEntry {
  resolve: (result: ApprovalResult) => void
}

/**
 * Minimal replica of the ClaudeSession bookkeeping relevant to approval
 * dismissal. `sent` records every `session:approval-dismiss` broadcast so
 * tests can assert on it directly instead of mocking BrowserWindow/IPC.
 */
class TestSession {
  pendingApprovals = new Map<string, PendingApprovalEntry>()
  sent: Array<{ channel: string; data: unknown }> = []

  private send(channel: string, data: unknown): void {
    this.sent.push({ channel, data })
  }

  /** Mirrors ClaudeSession.cancel()'s deny-all loop. */
  cancel(): void {
    for (const [requestId, entry] of this.pendingApprovals) {
      entry.resolve({ decision: 'deny' })
      this.send('session:approval-dismiss', { requestId })
    }
    this.pendingApprovals.clear()
  }

  /** Mirrors ClaudeSession.interrupt()'s deny-all loop. */
  async interrupt(): Promise<void> {
    for (const [requestId, entry] of this.pendingApprovals) {
      entry.resolve({ decision: 'deny' })
      this.send('session:approval-dismiss', { requestId })
    }
    this.pendingApprovals.clear()
  }

  /** Mirrors the promise registered inside canUseTool, including its
   *  per-request abort-signal listener. */
  registerApproval(requestId: string, signal: AbortSignal): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, { resolve })
      signal.addEventListener(
        'abort',
        () => {
          this.pendingApprovals.delete(requestId)
          resolve({ decision: 'deny' })
          this.send('session:approval-dismiss', { requestId })
        },
        { once: true }
      )
    })
  }

  /** Mirrors canUseTool's normal-resolution path (post-await cleanup). */
  resolveNormally(requestId: string, result: ApprovalResult): void {
    const entry = this.pendingApprovals.get(requestId)
    entry?.resolve(result)
    this.pendingApprovals.delete(requestId)
    this.send('session:approval-dismiss', { requestId })
  }
}

describe('ClaudeSession — session:approval-dismiss emission', () => {
  it('cancel() denies and dismisses every pending approval', () => {
    const session = new TestSession()
    const resolvedDecisions: Record<string, ApprovalResult['decision']> = {}
    session.pendingApprovals.set('req-1', {
      resolve: (r) => {
        resolvedDecisions['req-1'] = r.decision
      }
    })
    session.pendingApprovals.set('req-2', {
      resolve: (r) => {
        resolvedDecisions['req-2'] = r.decision
      }
    })

    session.cancel()

    expect(resolvedDecisions).toEqual({ 'req-1': 'deny', 'req-2': 'deny' })
    expect(session.pendingApprovals.size).toBe(0)
    expect(session.sent).toEqual([
      { channel: 'session:approval-dismiss', data: { requestId: 'req-1' } },
      { channel: 'session:approval-dismiss', data: { requestId: 'req-2' } }
    ])
  })

  it('cancel() with no pending approvals emits nothing', () => {
    const session = new TestSession()
    session.cancel()
    expect(session.sent).toEqual([])
  })

  it('interrupt() denies and dismisses every pending approval', async () => {
    const session = new TestSession()
    let decision: ApprovalResult['decision'] | null = null
    session.pendingApprovals.set('req-3', {
      resolve: (r) => {
        decision = r.decision
      }
    })

    await session.interrupt()

    expect(decision).toBe('deny')
    expect(session.pendingApprovals.size).toBe(0)
    expect(session.sent).toEqual([
      { channel: 'session:approval-dismiss', data: { requestId: 'req-3' } }
    ])
  })

  it('the per-request abort listener dismisses only the aborted request, leaving siblings untouched', async () => {
    const session = new TestSession()
    const controllerA = new AbortController()
    const controllerB = new AbortController()

    const pendingA = session.registerApproval('req-a', controllerA.signal)
    const pendingB = session.registerApproval('req-b', controllerB.signal)
    expect(session.pendingApprovals.size).toBe(2)

    controllerA.abort()
    const resultA = await pendingA

    expect(resultA.decision).toBe('deny')
    expect(session.pendingApprovals.has('req-a')).toBe(false)
    expect(session.pendingApprovals.has('req-b')).toBe(true)
    expect(session.sent).toEqual([
      { channel: 'session:approval-dismiss', data: { requestId: 'req-a' } }
    ])

    // req-b was never aborted — still pending, no dismiss emitted for it.
    void pendingB
  })

  it('a normal (renderer-driven) resolution also emits dismiss, so remote/multi-window views drop the card', () => {
    const session = new TestSession()
    session.pendingApprovals.set('req-4', { resolve: () => {} })

    session.resolveNormally('req-4', { decision: 'allow' })

    expect(session.pendingApprovals.has('req-4')).toBe(false)
    expect(session.sent).toEqual([
      { channel: 'session:approval-dismiss', data: { requestId: 'req-4' } }
    ])
  })
})
