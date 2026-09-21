/**
 * The cli.js permission-frame contract (docs/protocol-cc/04-system-subtypes.md
 * §4.25), pinned at the mapper.
 *
 * These cases are the wire facts the feature rests on, not a restatement of the
 * implementation: a classifier verdict must become the SAME block pi and
 * opencode produce (so all four engines render one card), a rule denial must
 * NOT (it judged nothing), and a frame we cannot bind must be dropped rather
 * than guessed at.
 */
import { describe, it, expect } from 'vitest'
import {
  classifierReviewBlock,
  isClassifierDecision,
  permissionDenialBlock,
  readPermissionDecisionFrame,
  splitRulePrefix
} from '../claude-permission-decision'
import { REVIEW_RATIONALE_LIMIT } from '../../shared/tool-review'

/** A frame as cli.js actually emits it — shape probed against 2.1.268. */
const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Bash',
  tool_use_id: 'toolu_01',
  message: 'Permission to use Bash with command git push --force has been denied.',
  uuid: 'frame-uuid-1',
  session_id: 'sess-1',
  ...over
})

describe('readPermissionDecisionFrame', () => {
  it('narrows a real frame to the fields that bind it to a card', () => {
    expect(
      readPermissionDecisionFrame(
        frame({ decision_reason_type: 'classifier', decision_reason: '[Git Destructive] nope' })
      )
    ).toEqual({
      toolUseId: 'toolu_01',
      frameUuid: 'frame-uuid-1',
      decisionReasonType: 'classifier',
      decisionReason: '[Git Destructive] nope'
    })
  })

  it('carries agent_id so the session can tell a subagent decision apart', () => {
    expect(readPermissionDecisionFrame(frame({ agent_id: 'agent-7' }))?.agentId).toBe('agent-7')
  })

  // Both are required rather than defaulted: a decision with no call has
  // nowhere to render, and one with no uuid could not be deduped on replay.
  it.each([
    ['tool_use_id', { tool_use_id: '' }],
    ['uuid', { uuid: undefined }]
  ])('drops a frame missing %s', (_field, over) => {
    expect(readPermissionDecisionFrame(frame(over))).toBeNull()
  })

  it('omits decision_reason fields that are absent, rather than emitting empty ones', () => {
    const read = readPermissionDecisionFrame(frame({ decision_reason_type: 'subcommandResults' }))
    expect(read).not.toHaveProperty('decisionReason')
    expect(read?.decisionReasonType).toBe('subcommandResults')
  })
})

describe('isClassifierDecision', () => {
  it('is true only for the auto-mode judge', () => {
    expect(isClassifierDecision({ toolUseId: 't', frameUuid: 'u' })).toBe(false)
    expect(
      isClassifierDecision({ toolUseId: 't', frameUuid: 'u', decisionReasonType: 'rule' })
    ).toBe(false)
    expect(
      isClassifierDecision({ toolUseId: 't', frameUuid: 'u', decisionReasonType: 'classifier' })
    ).toBe(true)
  })
})

describe('splitRulePrefix', () => {
  it('splits the stage-2 grammar into the badge and the sentence', () => {
    expect(splitRulePrefix('[Git Destructive] Discards uncommitted work.')).toEqual({
      rule: 'Git Destructive',
      rationale: 'Discards uncommitted work.'
    })
  })

  it('keeps a slash — a rule name is copied verbatim, unlike <category>', () => {
    expect(splitRulePrefix('[Logging/Audit Tampering] Clears the audit log.').rule).toBe(
      'Logging/Audit Tampering'
    )
  })

  it('treats a reason with no prefix as all rationale (fast mode asks for none)', () => {
    expect(splitRulePrefix('Sends the repo to an external host.')).toEqual({
      rationale: 'Sends the repo to an external host.'
    })
  })

  // The bracket is attacker-reachable model text, so it is bounded. Anything
  // over the bound is not a rule name and must not become a badge.
  it('refuses a bracket longer than 48 chars, keeping the whole string as prose', () => {
    const long = `[${'x'.repeat(49)}] tail`
    expect(splitRulePrefix(long)).toEqual({ rationale: long })
  })

  it('refuses a bracket carrying markup rather than a rule name', () => {
    const injected = '[<img src=x onerror=alert(1)>] tail'
    expect(splitRulePrefix(injected).rule).toBeUndefined()
  })

  it('falls back to prose for an empty bracket', () => {
    expect(splitRulePrefix('[] still blocked')).toEqual({ rationale: '[] still blocked' })
  })

  it('yields a rule and no rationale when the reason is only a rule name', () => {
    expect(splitRulePrefix('[Data Exfiltration]')).toEqual({ rule: 'Data Exfiltration' })
  })

  it.each([[undefined], [''], ['   ']])('yields nothing for %p', (input) => {
    expect(splitRulePrefix(input)).toEqual({})
  })

  it('collapses and caps the rationale at the shared producer limit', () => {
    const { rationale } = splitRulePrefix(`[Rule Name] ${'a'.repeat(REVIEW_RATIONALE_LIMIT + 50)}`)
    expect(rationale).toHaveLength(REVIEW_RATIONALE_LIMIT)
    expect(rationale?.endsWith('…')).toBe(true)
  })
})

describe('classifierReviewBlock', () => {
  const read = (over: Record<string, unknown>) =>
    readPermissionDecisionFrame(frame({ decision_reason_type: 'classifier', ...over }))!

  // The point of the whole feature: the same shape pi and opencode build
  // (`automode/denial-tracker.ts`), so one renderer serves every engine.
  it('builds the block ClaudeUI own judge builds for pi and opencode', () => {
    expect(
      classifierReviewBlock(
        read({ decision_reason: '[Git Destructive] Discards uncommitted work.' }),
        'denied'
      )
    ).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'denied',
      rule: 'Git Destructive',
      rationale: 'Discards uncommitted work.'
    })
  })

  it('reuses the frame uuid as the review id, so a replay is idempotent', () => {
    const a = classifierReviewBlock(read({ decision_reason: 'x' }), 'approved')
    const b = classifierReviewBlock(read({ decision_reason: 'x' }), 'approved')
    expect(a.reviewId).toBe(b.reviewId)
  })

  it('still renders an allow that carried no reason at all', () => {
    expect(classifierReviewBlock(read({}), 'approved')).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'approved'
    })
  })

  /**
   * cli.js's allow reasons are fixed constants naming the stage that cleared
   * the action — they restate the card's own "Auto mode allowed this action"
   * and say nothing pi or opencode would show either. Dropped at the producer
   * so the strip does not print the same claim twice (verifier, 2026-09-21).
   */
  it.each([
    ['Allowed by classifier'],
    ['Allowed by fast classifier'],
    ['  Allowed by classifier  ']
  ])('drops the content-free allow reason %p', (reason) => {
    expect(classifierReviewBlock(read({ decision_reason: reason }), 'approved')).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'approved'
    })
  })

  // The drop is by exact string, not "every allow reason": an allow that says
  // anything else is carrying real information and must survive.
  it('keeps an allow reason that is not one of the two constants', () => {
    expect(
      classifierReviewBlock(
        read({ decision_reason: 'Allowed because the path is inside cwd.' }),
        'approved'
      ).rationale
    ).toBe('Allowed because the path is inside cwd.')
  })

  // …and the same constant on a DENIAL is not a constant at all — it would be
  // the judge's own words, so the drop must not reach that branch.
  it('never drops a reason from a denial', () => {
    expect(
      classifierReviewBlock(read({ decision_reason: 'Allowed by classifier' }), 'denied').rationale
    ).toBe('Allowed by classifier')
  })

  it('carries the flagged-allow warning cli.js delivers with the tool', () => {
    const block = classifierReviewBlock(
      read({
        decision_reason: 'Flagged by the classifier, delivered with its warning: touches prod.'
      }),
      'approved'
    )
    expect(block.decision).toBe('approved')
    expect(block.rationale).toContain('touches prod')
  })
})

describe('permissionDenialBlock', () => {
  const read = (over: Record<string, unknown>) => readPermissionDecisionFrame(frame(over))!

  it('names the source, and does NOT repeat the tool_result own text', () => {
    const block = permissionDenialBlock(read({ decision_reason_type: 'subcommandResults' }))
    expect(block).toEqual({
      type: 'permission_denial',
      toolUseId: 'toolu_01',
      denialId: 'frame-uuid-1',
      source: 'subcommandResults'
    })
    expect(JSON.stringify(block)).not.toContain('has been denied')
  })

  it('carries the reason for the sources cli.js renders one for', () => {
    expect(
      permissionDenialBlock(
        read({ decision_reason_type: 'hook', decision_reason: '  PreToolUse   said no  ' })
      ).reason
    ).toBe('PreToolUse said no')
  })

  // A source we do not know must render as a generic denial, never reach a
  // typed slot unchecked — the union is ours, the wire field is cli.js's.
  it.each([['somethingNew'], [undefined]])('degrades an unknown source %p to "other"', (raw) => {
    expect(permissionDenialBlock(read({ decision_reason_type: raw })).source).toBe('other')
  })

  it('caps an over-long reason at the shared producer limit', () => {
    const block = permissionDenialBlock(
      read({
        decision_reason_type: 'hook',
        decision_reason: 'b'.repeat(REVIEW_RATIONALE_LIMIT + 9)
      })
    )
    expect(block.reason).toHaveLength(REVIEW_RATIONALE_LIMIT)
  })
})
