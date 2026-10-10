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
  permissionDecisionBlock,
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
        read({ decision_reason: '[Git Destructive] Discards uncommitted work.' })
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
    const a = classifierReviewBlock(read({ decision_reason: 'x' }))
    const b = classifierReviewBlock(read({ decision_reason: 'x' }))
    expect(a.reviewId).toBe(b.reviewId)
  })

  it('still renders a block that carried no reason at all', () => {
    expect(classifierReviewBlock(read({}))).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'denied'
    })
  })

  // cli.js's allow-stage constant on a DENIAL is not a constant at all — it
  // would be the judge's own words, so it is never dropped.
  it('never drops a reason from a denial', () => {
    expect(
      classifierReviewBlock(read({ decision_reason: 'Allowed by classifier' })).rationale
    ).toBe('Allowed by classifier')
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

/**
 * The content-free reasons cli.js's classifier falls back to. They carry no
 * judgment, so they are dropped as RATIONALE — by exact string — while the
 * decision (and any rule badge) stays.
 */
describe('classifierReviewBlock — content-free reasons', () => {
  const read = (over: Record<string, unknown>) =>
    readPermissionDecisionFrame(frame({ decision_reason_type: 'classifier', ...over }))!

  it.each([['Blocked by classifier'], ['No reason provided'], ['  No reason provided  ']])(
    'drops the content-free deny reason %p but keeps the decision',
    (reason) => {
      const block = classifierReviewBlock(read({ decision_reason: reason }))
      expect(block.decision).toBe('denied')
      expect(block).not.toHaveProperty('rationale')
    }
  )

  it('still parses the rule in front of a content-free deny reason', () => {
    expect(
      classifierReviewBlock(read({ decision_reason: '[Data Exfiltration] No reason provided' }))
    ).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'denied',
      rule: 'Data Exfiltration'
    })
  })

  // Exact match: a real sentence that merely contains the words is the judge's.
  it('keeps a deny reason that only resembles a fallback', () => {
    expect(
      classifierReviewBlock(
        read({ decision_reason: 'Blocked by classifier policy on prod hosts.' })
      ).rationale
    ).toBe('Blocked by classifier policy on prod hosts.')
  })

  // Only the deny fallbacks are dropped: cli.js's allow-stage constant on a
  // denial would be the judge's own words.
  it('does not apply the allow-only constants to a denial', () => {
    expect(
      classifierReviewBlock(
        read({ decision_reason: 'Not flagged by the server-side auto mode classifier' })
      ).rationale
    ).toBe('Not flagged by the server-side auto mode classifier')
  })
})

/**
 * The single routing decision `handlePermissionDecision` delegates to. Every
 * rule the session used to apply inline, plus the no-verdict split: a
 * `classifier` frame is not always a verdict.
 */
describe('permissionDecisionBlock', () => {
  const read = (over: Record<string, unknown>) => readPermissionDecisionFrame(frame(over))!
  const classifier = (over: Record<string, unknown> = {}) =>
    read({ decision_reason_type: 'classifier', ...over })

  it('classifier + denied → a denied review', () => {
    expect(
      permissionDecisionBlock(classifier({ decision_reason: '[Git Destructive] nope' }))
    ).toMatchObject({ type: 'tool_review', decision: 'denied', rule: 'Git Destructive' })
  })

  // A `no_verdict` key on the wire is ignored: only a retired patch wrote it,
  // so it must not route a block by itself (the reason here matches none of
  // the native no-verdict signals).
  it('ignores a no_verdict key on a classifier denial', () => {
    const reason = 'Auto mode classifier transcript exceeded context window'
    expect(
      permissionDecisionBlock(classifier({ no_verdict: true, decision_reason: reason }))
    ).toEqual({
      type: 'tool_review',
      toolUseId: 'toolu_01',
      reviewId: 'frame-uuid-1',
      reviewer: 'auto-mode',
      decision: 'denied',
      rationale: reason
    })
  })

  // cli.js tells "Classifier unavailable" apart by the exact string itself, so
  // the reason alone must route it.
  it.each([['Classifier unavailable'], ['  Classifier unavailable  ']])(
    'classifier + denied %p (no flag) → an autoModeNoVerdict denial',
    (reason) => {
      expect(permissionDecisionBlock(classifier({ decision_reason: reason }))).toEqual({
        type: 'permission_denial',
        toolUseId: 'toolu_01',
        denialId: 'frame-uuid-1',
        source: 'autoModeNoVerdict',
        reason: 'Classifier unavailable'
      })
    }
  )

  // cli.js 2.1.280 sends this code on a classifier denial only for the
  // transcript-overflow fallback (`qoe`), so the code alone routes it.
  it('classifier + denied with the transcript-too-long code → an autoModeNoVerdict denial', () => {
    expect(
      permissionDecisionBlock(
        classifier({
          decision_reason_code: 'classifier_transcript_too_long',
          decision_reason: 'Auto mode classifier transcript exceeded context window'
        })
      )
    ).toMatchObject({ type: 'permission_denial', source: 'autoModeNoVerdict' })
  })

  it('classifier + denied with the no-verdict streak reason → an autoModeNoVerdict denial', () => {
    expect(
      permissionDecisionBlock(
        classifier({
          decision_reason:
            'Auto mode unavailable — stopped after repeated responses with no safety verdict'
        })
      )
    ).toMatchObject({ type: 'permission_denial', source: 'autoModeNoVerdict' })
  })

  it('matches "Classifier unavailable" exactly, not as a prefix', () => {
    expect(
      permissionDecisionBlock(
        classifier({ decision_reason: 'Classifier unavailable for this tool, judged on text.' })
      )?.type
    ).toBe('tool_review')
  })

  it('non-classifier + denied → a denial naming its source', () => {
    expect(permissionDecisionBlock(read({ decision_reason_type: 'subcommandResults' }))).toEqual({
      type: 'permission_denial',
      toolUseId: 'toolu_01',
      denialId: 'frame-uuid-1',
      source: 'subcommandResults'
    })
  })

  // `autoModeNoVerdict` is OURS — derived, never read. A frame that claims it
  // as its reason type is an unknown wire value like any other.
  it('never accepts autoModeNoVerdict from the wire', () => {
    expect(
      permissionDecisionBlock(read({ decision_reason_type: 'autoModeNoVerdict' }))
    ).toMatchObject({ type: 'permission_denial', source: 'other' })
  })
})
