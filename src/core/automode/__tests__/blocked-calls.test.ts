/**
 * ADR-091 part 6 — the per-root-session ledger of approvable auto-mode blocks:
 * one-shot exact-match grants keyed on the call and its effective cwd, the
 * 15-minute TTL, the held state, the double-press no-op, the nudge texts and
 * the shared nearest-live-agent routing decision.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolReviewBlock } from '../../../shared/types'
import {
  BLOCK_GRANT_TTL_MS,
  BlockedCallLedger,
  blockApprovalNotice,
  blockedCallDelivery,
  blockedCallNudge,
  blockedCallSummary,
  blockGrantKey,
  nearestLiveAgent,
  type BlockedCall
} from '../blocked-calls'

const REVIEW: ToolReviewBlock = {
  type: 'tool_review',
  toolUseId: 'c1',
  reviewId: 'r1',
  reviewer: 'auto-mode',
  decision: 'denied',
  rule: 'Remote Host Writes'
}

function call(over: Partial<BlockedCall> = {}): BlockedCall {
  const input = { command: 'git push origin main' }
  return {
    toolName: 'bash',
    input,
    review: REVIEW,
    grantKey: blockGrantKey('pi', 'bash', input, '/repo'),
    ...over
  }
}

function ledger(now = { t: 1_000 }): {
  l: BlockedCallLedger
  sent: Array<{ toolUseId: string; review: ToolReviewBlock }>
  now: { t: number }
} {
  const sent: Array<{ toolUseId: string; review: ToolReviewBlock }> = []
  const l = new BlockedCallLedger(
    (toolUseId, review) => sent.push({ toolUseId, review }),
    () => now.t
  )
  return { l, sent, now }
}

describe('blockGrantKey', () => {
  it('a shell command compares whitespace-collapsed, in its effective cwd', () => {
    const a = blockGrantKey('pi', 'bash', { command: 'git  push origin main ' }, '/repo')
    expect(a).toBe(blockGrantKey('pi', 'bash', { command: 'git push origin main' }, '/repo'))
    // Same command in a worktree: a different action.
    expect(a).not.toBe(
      blockGrantKey('pi', 'bash', { command: 'git push origin main' }, '/repo/.claude/worktrees/x')
    )
    // Another engine's vocabulary never matches.
    expect(a).not.toBe(
      blockGrantKey('opencode', 'bash', { command: 'git push origin main' }, '/repo')
    )
  })

  it("an opencode shell's workdir is resolved against the cwd (only where the engine honours it)", () => {
    const viaWorkdir = blockGrantKey(
      'opencode',
      'bash',
      { command: 'ls', workdir: 'sub' },
      '/repo',
      true
    )
    expect(viaWorkdir).toBe(blockGrantKey('opencode', 'bash', { command: 'ls' }, '/repo/sub', true))
    expect(viaWorkdir).not.toBe(blockGrantKey('opencode', 'bash', { command: 'ls' }, '/repo', true))
  })

  it('any other call compares its whole input, key order ignored', () => {
    const a = blockGrantKey('pi', 'edit', { path: 'a.ts', old: 'x', new: 'y' }, '/repo')
    expect(a).toBe(blockGrantKey('pi', 'edit', { new: 'y', path: 'a.ts', old: 'x' }, '/repo'))
    expect(a).not.toBe(blockGrantKey('pi', 'edit', { path: 'b.ts', old: 'x', new: 'y' }, '/repo'))
  })
})

describe('BlockedCallLedger', () => {
  it('approve grants the exact call once, then it is spent', () => {
    const { l } = ledger()
    const c = call()
    l.record('c1', c, false)
    expect(l.approve('c1')).toBe(c)
    expect(l.consumeGrant(c.grantKey!)).toBe(true)
    expect(l.consumeGrant(c.grantKey!)).toBe(false)
  })

  it('a grant lapses 15 minutes after the click', () => {
    const { l, now } = ledger()
    const c = call()
    l.record('c1', c, false)
    l.approve('c1')
    now.t += BLOCK_GRANT_TTL_MS
    expect(l.consumeGrant(c.grantKey!)).toBe(false)
  })

  it('an unexpired grant still clears just before the TTL', () => {
    const { l, now } = ledger()
    const c = call()
    l.record('c1', c, false)
    l.approve('c1')
    now.t += BLOCK_GRANT_TTL_MS - 1
    expect(l.consumeGrant(c.grantKey!)).toBe(true)
  })

  it('a second press (or an unknown id) is a no-op: no second grant', () => {
    const { l } = ledger()
    const c = call()
    l.record('c1', c, false)
    expect(l.approve('c1')).toBeDefined()
    expect(l.approve('c1')).toBeUndefined()
    expect(l.approve('nope')).toBeUndefined()
    expect(l.consumeGrant(c.grantKey!)).toBe(true)
    expect(l.consumeGrant(c.grantKey!)).toBe(false)
  })

  it('a held block is not approvable until it settles', () => {
    const { l } = ledger()
    l.record('c1', call(), true)
    expect(l.approve('c1')).toBeUndefined()
    l.settle('c1')
    expect(l.approve('c1')).toBeDefined()
  })

  it('Claude (no key) approves with no grant', () => {
    const { l } = ledger()
    const c = call({ grantKey: undefined })
    l.record('c1', c, false)
    expect(l.approve('c1')).toBe(c)
    expect(l.consumeGrant(blockGrantKey('pi', 'bash', c.input, '/repo'))).toBe(false)
  })

  it('markApproved re-sends the review overridden, with where the nudge went, under a new id', () => {
    const { l, sent } = ledger()
    l.markApproved('c1', REVIEW, 'the main agent')
    expect(sent).toEqual([
      {
        toolUseId: 'c1',
        review: {
          ...REVIEW,
          reviewId: 'r1:approved',
          overriddenByUser: true,
          nudgedTo: 'the main agent'
        }
      }
    ])
  })

  it('approveHeld marks the review with no grant and no nudge target', () => {
    const { l, sent } = ledger()
    const c = call()
    l.record('c1', c, true)
    l.approveHeld('c1')
    expect(sent[0].review).toMatchObject({ overriddenByUser: true })
    expect(sent[0].review.nudgedTo).toBeUndefined()
    expect(l.consumeGrant(c.grantKey!)).toBe(false)
    expect(l.approve('c1')).toBeUndefined()
  })
})

describe('nudge texts', () => {
  it("the root agent's prompt for its own call, a subagent's, and a dispatch target's", () => {
    expect(blockedCallNudge(call())).toBe(
      'I approve the bash call auto mode blocked: git push origin main. Run it again exactly as it was.'
    )
    expect(blockedCallNudge(call({ agentLabel: 'Fix "it"' }))).toBe(
      'I approve the bash call auto mode blocked for the "Fix \'it\'" subagent: git push origin main. ' +
        'Run it again exactly as it was — yourself, or by sending it back to that subagent.'
    )
    expect(blockedCallNudge(call({ agentLabel: 'gpt', dispatchSessionId: 'ses_1' }))).toContain(
      'by dispatching it back to that agent (session_id "ses_1").'
    )
  })

  it('a delivery is marked as ClaudeUI on behalf of the user', () => {
    expect(blockedCallDelivery(call(), true)).toBe(
      '[ClaudeUI] The user approved your blocked bash call: git push origin main. Run it again exactly as it was.'
    )
    expect(blockedCallDelivery(call({ agentLabel: 'kid' }), false)).toContain(
      'for the "kid" subagent: git push origin main.'
    )
  })

  it('rides the host\'s own envelope — never an <agent-message> an agent named "user" could mint', () => {
    const text = blockApprovalNotice(blockedCallDelivery(call(), true))
    expect(text.startsWith('<claudeui-notice ')).toBe(true)
    expect(text.endsWith('</claudeui-notice>')).toBe(true)
    expect(text).not.toContain('<agent-message')
  })
})

describe('blockedCallSummary', () => {
  it("names a delegation by its description, else its prompt — never the input's JSON", () => {
    expect(
      blockedCallSummary('agent', { description: 'Remove unused origin branches', prompt: 'long…' })
    ).toBe('Remove unused origin branches')
    expect(
      blockedCallSummary('dispatch_agent', { engine: 'pi', model: 'x/y', prompt: 'Run the test' })
    ).toBe('Run the test')
  })
})

describe('nearestLiveAgent', () => {
  const parents: Record<string, string | null> = { grandchild: 'child', child: 'root', root: null }
  const route = (live: string[]) =>
    nearestLiveAgent<string>(
      'grandchild',
      (a) => parents[a] ?? null,
      (a) => live.includes(a)
    )

  it('the blocked agent itself while it runs', () => {
    expect(route(['grandchild', 'child'])).toBe('grandchild')
  })

  it('else the nearest live ancestor', () => {
    expect(route(['child'])).toBe('child')
  })

  it('else nobody (the root agent takes it as a prompt)', () => {
    expect(route([])).toBeNull()
    expect(
      nearestLiveAgent<string>(
        null,
        () => null,
        () => true
      )
    ).toBeNull()
  })

  it('never loops on a cycle', () => {
    const isLive = vi.fn(() => false)
    expect(nearestLiveAgent<string>('a', (a) => (a === 'a' ? 'b' : 'a'), isLive)).toBeNull()
    expect(isLive).toHaveBeenCalledTimes(2)
  })
})
