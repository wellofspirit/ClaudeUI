/**
 * Denial caps + block surfacing (`../denial-tracker`) — the consumer that gives
 * `ClassifyResult.category` teeth.
 *
 * What is worth asserting here is the POLICY, engine-free: when auto mode stops
 * answering for the user, and what it tells them and the model when it does.
 * The engine wirings assert that they route through this (see
 * OpencodeSession.test.ts / PiSession.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  AutoModeDenialTracker,
  formatAutoModeDenyReason,
  CONSECUTIVE_DENIAL_CAP,
  SAME_CATEGORY_DENIAL_CAP,
  TOTAL_DENIAL_CAP
} from '../denial-tracker'

describe('AutoModeDenialTracker — same-category cap', () => {
  it('hands over on the SECOND block carrying the same rule (a block is a question, not a wall)', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock('git_destructive')).toBeNull()
    const capped = t.recordBlock('git_destructive')
    expect(capped).not.toBeNull()
    // The human sees WHICH bar the agent keeps hitting — the whole point of
    // keying the cap on the category rather than counting blindly.
    expect(capped).toContain('Git Destructive')
    expect(capped).toContain('2 times')
  })

  it('names the rule from the CORPUS, not the raw slug', () => {
    const t = new AutoModeDenialTracker()
    t.recordBlock('credential_leakage')
    const capped = t.recordBlock('credential_leakage')
    expect(capped).toContain('Credential Leakage')
    expect(capped).not.toContain('credential_leakage')
  })

  it('does NOT fire for two blocks on DIFFERENT rules — that is not a grind', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock('git_destructive')).toBeNull()
    expect(t.recordBlock('network_exposure')).toBeNull()
  })

  it('a different rule in between restarts the same-category streak', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock('git_destructive')).toBeNull()
    expect(t.recordBlock('network_exposure')).toBeNull()
    // 3rd consecutive → the plain consecutive cap fires here, and it does NOT
    // claim a rule, because no single rule was hit twice.
    const capped = t.recordBlock('git_destructive')
    expect(capped).toContain('3 actions in a row')
    expect(capped).not.toContain('rule:')
  })

  it('the cap restarts the streak, so the next grind is measured afresh', () => {
    const t = new AutoModeDenialTracker()
    t.recordBlock('git_destructive')
    expect(t.recordBlock('git_destructive')).not.toBeNull()
    // The human just answered this one; the very next block must not cap again.
    expect(t.recordBlock('git_destructive')).toBeNull()
    expect(t.recordBlock('git_destructive')).not.toBeNull()
  })
})

describe('AutoModeDenialTracker — uncategorized blocks keep the 3-consecutive rule', () => {
  it('two uncategorized blocks do not cap; the third does', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock()).toBeNull()
    expect(t.recordBlock()).toBeNull()
    expect(t.recordBlock()).toContain('3 actions in a row')
  })

  it('an uncategorized block between two same-rule blocks breaks the category streak (unknown intent is not the same intent)', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock('git_destructive')).toBeNull()
    expect(t.recordBlock(undefined)).toBeNull()
    // Same rule as block 1, but not consecutive with it — this caps only
    // because it is the 3rd block in a row, and says so.
    expect(t.recordBlock('git_destructive')).toContain('3 actions in a row')
  })

  it('caps at exactly the documented consecutive threshold', () => {
    const t = new AutoModeDenialTracker()
    for (let i = 1; i < CONSECUTIVE_DENIAL_CAP; i++) expect(t.recordBlock()).toBeNull()
    expect(t.recordBlock()).not.toBeNull()
  })
})

describe('AutoModeDenialTracker — reset on allow', () => {
  it('an allow clears the consecutive streak', () => {
    const t = new AutoModeDenialTracker()
    t.recordBlock()
    t.recordBlock()
    t.recordAllow()
    // Without the reset this pair would be blocks 3 and 4 in a row.
    expect(t.recordBlock()).toBeNull()
    expect(t.recordBlock()).toBeNull()
  })

  it('an allow also clears the same-CATEGORY streak', () => {
    const t = new AutoModeDenialTracker()
    expect(t.recordBlock('git_destructive')).toBeNull()
    t.recordAllow()
    // The agent got somewhere in between — it is not grinding one intent.
    expect(t.recordBlock('git_destructive')).toBeNull()
  })

  it('an allow does NOT clear the session total', () => {
    const t = new AutoModeDenialTracker()
    for (let i = 0; i < TOTAL_DENIAL_CAP - 1; i++) {
      t.recordBlock()
      t.recordAllow()
    }
    // Block number TOTAL_DENIAL_CAP, with every streak cleared before it.
    expect(t.recordBlock()).toContain(`${TOTAL_DENIAL_CAP} actions this session`)
  })
})

describe('AutoModeDenialTracker — total cap', () => {
  it('past the total, auto mode stops deciding for the rest of the session', () => {
    const t = new AutoModeDenialTracker()
    for (let i = 0; i < TOTAL_DENIAL_CAP; i++) t.recordBlock()
    // Every later block hands over too — the total is not reset by a cap.
    expect(t.recordBlock()).toContain('this session')
    t.recordAllow()
    expect(t.recordBlock()).toContain('this session')
  })
})

describe('formatAutoModeDenyReason', () => {
  it('prefixes the matched rule name when the judge reason does not name it', () => {
    expect(
      formatAutoModeDenyReason({ reason: 'force-push would drop pushed commits', category: 'git_destructive' })
    ).toBe('Auto mode blocked: [Git Destructive] force-push would drop pushed commits')
  })

  it('does not double-prefix a stage-2 reason that already names the rule', () => {
    expect(
      formatAutoModeDenyReason({
        reason: '[Git Destructive] force-push would drop pushed commits',
        category: 'git_destructive'
      })
    ).toBe('Auto mode blocked: [Git Destructive] force-push would drop pushed commits')
  })

  it('matches the rule name case-insensitively (the model is copying prose, not an id)', () => {
    expect(
      formatAutoModeDenyReason({ reason: 'this is git destructive work', category: 'git_destructive' })
    ).toBe('Auto mode blocked: this is git destructive work')
  })

  it('falls back to the generic text with no reason and no category (unchanged wording)', () => {
    expect(formatAutoModeDenyReason({})).toBe('Auto mode blocked: flagged as potentially unsafe')
  })

  it('names the rule even when the judge gave no reason at all', () => {
    expect(formatAutoModeDenyReason({ category: 'network_exposure' })).toBe(
      'Auto mode blocked: [Network Exposure] flagged as potentially unsafe'
    )
  })

  it('ignores a category that is not in the corpus (the classifier already validates, this is defense in depth)', () => {
    expect(formatAutoModeDenyReason({ reason: 'nope', category: 'not_a_rule' })).toBe(
      'Auto mode blocked: nope'
    )
  })
})

describe('cap constants', () => {
  it('the same-category cap is tighter than the consecutive one, or it could never fire', () => {
    expect(SAME_CATEGORY_DENIAL_CAP).toBeLessThan(CONSECUTIVE_DENIAL_CAP)
  })
})
