/**
 * @vitest-environment node
 *
 * Unit test for claude-session's resolveApproval allowForSession coercion.
 *
 * Uses a minimal replica so we avoid pulling in Electron/SDK deps. Mirrors
 * the logic in ClaudeSession.resolveApproval that was updated to coerce
 * 'allowForSession' → 'allow' before handing off to the canUseTool callback.
 */

import { describe, it, expect } from 'vitest'

type ApprovalDecision = 'allow' | 'allowForSession' | 'deny'

interface ApprovalResult {
  decision: 'allow' | 'deny'
  answers?: Record<string, string>
}

interface PendingApprovalEntry {
  resolve: (result: ApprovalResult) => void
}

/**
 * Minimal replica of ClaudeSession.resolveApproval.
 * The real impl is in src/main/services/claude-session.ts.
 */
class TestSession {
  pendingApprovals = new Map<string, PendingApprovalEntry>()

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>
  ): void {
    const entry = this.pendingApprovals.get(requestId)
    if (entry) {
      // cli.js's canUseTool only understands 'allow' | 'deny'. Coerce
      // 'allowForSession' to 'allow' so the ApprovalDecision union is
      // handled safely in the Claude path (opencode may produce it in Phase 5).
      const coerced: 'allow' | 'deny' = decision === 'allowForSession' ? 'allow' : decision
      entry.resolve({ decision: coerced, answers })
    }
  }
}

describe('ClaudeSession.resolveApproval — allowForSession coercion', () => {
  it('coerces allowForSession → allow so cli.js canUseTool receives a valid decision', () => {
    const session = new TestSession()
    let resolved: ApprovalResult | null = null
    session.pendingApprovals.set('req-1', {
      resolve: (r) => {
        resolved = r
      }
    })

    session.resolveApproval('req-1', 'allowForSession')

    expect(resolved).not.toBeNull()
    expect(resolved!.decision).toBe('allow')
  })

  it('passes allow through unchanged', () => {
    const session = new TestSession()
    let resolved: ApprovalResult | null = null
    session.pendingApprovals.set('req-2', {
      resolve: (r) => {
        resolved = r
      }
    })

    session.resolveApproval('req-2', 'allow')

    expect(resolved!.decision).toBe('allow')
  })

  it('passes deny through unchanged', () => {
    const session = new TestSession()
    let resolved: ApprovalResult | null = null
    session.pendingApprovals.set('req-3', {
      resolve: (r) => {
        resolved = r
      }
    })

    session.resolveApproval('req-3', 'deny')

    expect(resolved!.decision).toBe('deny')
  })

  it('does nothing when requestId is not found', () => {
    const session = new TestSession()
    // Should not throw
    expect(() => session.resolveApproval('unknown', 'allowForSession')).not.toThrow()
  })

  it('forwards answers when provided', () => {
    const session = new TestSession()
    let resolved: ApprovalResult | null = null
    session.pendingApprovals.set('req-4', {
      resolve: (r) => {
        resolved = r
      }
    })

    session.resolveApproval('req-4', 'allowForSession', { feedback: 'ok' })

    expect(resolved!.decision).toBe('allow')
    expect(resolved!.answers).toEqual({ feedback: 'ok' })
  })
})
