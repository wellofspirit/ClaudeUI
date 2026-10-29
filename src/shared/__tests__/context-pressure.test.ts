/**
 * Context pressure (session tools, slice 4): the setting's rules, the percentage, the engine
 * ceilings the Settings section shows, the banner's words and the hand-off instruction.
 */
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_AUTOCOMPACT_RESERVE_TOKENS,
  DEFAULT_CONTEXT_PRESSURE,
  ceilingRows,
  contextPercent,
  contextPressureBannerText,
  effectiveCeilingPercent,
  handOffInstruction,
  handOffBlockedReason,
  handOffToolName,
  isContextPressureAnswer,
  normalizeContextPressure,
  parseContextPressureBanner,
  thresholdAboveCeiling
} from '../context-pressure'
import {
  SESSION_TOOL_NAMES,
  sessionToolBareName,
  sessionToolsGuidance,
  sessionToolsGuidanceParts
} from '../session-tools-description'

describe('normalizeContextPressure (the setting validation)', () => {
  it('defaults to off with one 70 % threshold', () => {
    expect(normalizeContextPressure(undefined)).toEqual({ mode: 'off', thresholds: [70] })
    expect(DEFAULT_CONTEXT_PRESSURE).toEqual({ mode: 'off', thresholds: [70] })
    expect(normalizeContextPressure('nonsense')).toEqual({ mode: 'off', thresholds: [70] })
  })

  it('keeps a valid value', () => {
    expect(normalizeContextPressure({ mode: 'auto', thresholds: [30, 50, 70, 80] })).toEqual({
      mode: 'auto',
      thresholds: [30, 50, 70, 80]
    })
  })

  it('sorts, dedupes and rounds the thresholds, and drops those outside 10-95', () => {
    expect(
      normalizeContextPressure({ mode: 'ask', thresholds: [80, 80, 9, 96, 30.4, 'x', null, 50] })
    ).toEqual({ mode: 'ask', thresholds: [30, 50, 80] })
    expect(normalizeContextPressure({ mode: 'ask', thresholds: [10, 95] }).thresholds).toEqual([
      10, 95
    ])
  })

  it('keeps at most four, the lowest', () => {
    expect(
      normalizeContextPressure({ mode: 'ask', thresholds: [90, 20, 40, 60, 80, 30] }).thresholds
    ).toEqual([20, 30, 40, 60])
  })

  it('an empty or missing list is the default list, so a mode that is on always has one', () => {
    expect(normalizeContextPressure({ mode: 'ask', thresholds: [] }).thresholds).toEqual([70])
    expect(normalizeContextPressure({ mode: 'ask', thresholds: [1, 99] }).thresholds).toEqual([70])
    expect(normalizeContextPressure({ mode: 'ask' }).thresholds).toEqual([70])
  })

  it('an unknown mode is off, and the default list is a copy', () => {
    expect(normalizeContextPressure({ mode: 'always', thresholds: [40] })).toEqual({
      mode: 'off',
      thresholds: [40]
    })
    normalizeContextPressure(undefined).thresholds.push(1)
    expect(DEFAULT_CONTEXT_PRESSURE.thresholds).toEqual([70])
  })
})

describe('contextPercent', () => {
  it('is used over size', () => {
    expect(contextPercent({ used: 50_000, size: 200_000 })).toBe(25)
  })
  it('is null for an unknown window (size 0), a missing one or nonsense', () => {
    expect(contextPercent({ used: 150_000, size: 0 })).toBeNull()
    expect(contextPercent(null)).toBeNull()
    expect(contextPercent(undefined)).toBeNull()
    expect(contextPercent({ used: -1, size: 100 })).toBeNull()
    expect(contextPercent({ used: Number.NaN, size: 100 })).toBeNull()
  })
  it('never exceeds 100', () => {
    expect(contextPercent({ used: 300_000, size: 200_000 })).toBe(100)
  })
})

describe('the effective ceiling (P6: auto-compact at window minus 33k)', () => {
  it('is 83.5 % for Claude on 200k and 96.7 % on 1M', () => {
    expect(CLAUDE_AUTOCOMPACT_RESERVE_TOKENS).toBe(33_000)
    expect(effectiveCeilingPercent('claude', 200_000)).toBeCloseTo(83.5, 5)
    expect(Math.floor(effectiveCeilingPercent('claude', 200_000) ?? 0)).toBe(83)
    expect(effectiveCeilingPercent('claude', 1_000_000)).toBeCloseTo(96.7, 5)
    expect(Math.floor(effectiveCeilingPercent('claude', 1_000_000) ?? 0)).toBe(96)
  })
  it('is unknown for the other engines and for a window too small to have one', () => {
    for (const engine of ['opencode', 'pi'] as const) {
      expect(effectiveCeilingPercent(engine, 200_000)).toBeNull()
    }
    expect(effectiveCeilingPercent('claude', 0)).toBeNull()
    expect(effectiveCeilingPercent('claude', 33_000)).toBeNull()
  })
  it('flags a threshold above it as never reached, and nothing when the ceiling is unknown', () => {
    const ceiling = effectiveCeilingPercent('claude', 200_000)
    expect(thresholdAboveCeiling(90, ceiling)).toBe(true)
    expect(thresholdAboveCeiling(83, ceiling)).toBe(false)
    expect(thresholdAboveCeiling(95, effectiveCeilingPercent('claude', 1_000_000))).toBe(false)
    expect(thresholdAboveCeiling(95, null)).toBe(false)
  })
  it('lists each engine/model/window once, with its ceiling', () => {
    const rows = ceilingRows([
      { engine: 'claude', model: 'opus', windowSize: 200_000 },
      { engine: 'claude', model: 'opus', windowSize: 200_000 },
      { engine: 'claude', model: 'opus', windowSize: 1_000_000 },
      { engine: 'pi', model: 'gpt', windowSize: 400_000 },
      { engine: 'pi', model: 'unknown', windowSize: 0 }
    ])
    expect(rows.map((r) => [r.engine, r.model, r.windowSize])).toEqual([
      ['claude', 'opus', 200_000],
      ['claude', 'opus', 1_000_000],
      ['pi', 'gpt', 400_000]
    ])
    expect(rows[0].ceilingPercent).toBeCloseTo(83.5, 5)
    expect(rows[2].ceilingPercent).toBeNull()
  })
})

describe('the banner', () => {
  it('asks in the spec words and says plainly when ClaudeUI asked and was not obeyed', () => {
    expect(contextPressureBannerText({ kind: 'ask', percent: 72 })).toBe(
      'Context is at 72 % — continue in a new session?'
    )
    expect(contextPressureBannerText({ kind: 'failed', percent: 72 })).toBe(
      "ClaudeUI asked this session to hand off but it didn't."
    )
  })
  it('parses a wire banner and rejects anything else', () => {
    expect(parseContextPressureBanner({ kind: 'ask', percent: 71.6 })).toEqual({
      kind: 'ask',
      percent: 72
    })
    for (const bad of [null, 'x', {}, { kind: 'ask' }, { kind: 'later', percent: 1 }]) {
      expect(parseContextPressureBanner(bad)).toBeNull()
    }
    expect(parseContextPressureBanner({ kind: 'ask', percent: Number.NaN })).toBeNull()
  })
  it('knows the two answers', () => {
    expect(isContextPressureAnswer('handoff')).toBe(true)
    expect(isContextPressureAnswer('dismiss')).toBe(true)
    expect(isContextPressureAnswer('later')).toBe(false)
    expect(isContextPressureAnswer(undefined)).toBe(false)
  })
})

describe('plan mode', () => {
  it('blocks hand-off with a reason, and nothing else', () => {
    expect(handOffBlockedReason('plan')).toBe('Switch out of plan mode to hand off.')
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', null, undefined]) {
      expect(handOffBlockedReason(mode)).toBeNull()
    }
  })
})

describe('the hand-off instruction', () => {
  it('names the hand-off tool the way each engine spells it, and every spelling is the real tool', () => {
    expect(handOffToolName('claude')).toBe('mcp__claude-ui-sessions__session_hand_off')
    expect(handOffToolName('opencode')).toBe('claudeui_session_hand_off')
    expect(handOffToolName('pi')).toBe('session_hand_off')
    for (const engine of ['claude', 'opencode', 'pi'] as const) {
      expect(sessionToolBareName(handOffToolName(engine))).toBe('session_hand_off')
    }
  })
  it('carries the percentage, the tool and the content a fresh session needs', () => {
    const text = handOffInstruction(72, 'pi')
    expect(text).toContain('Your context is at 72 %.')
    expect(text).toContain('call session_hand_off')
    for (const part of [
      'goal',
      'state',
      'decisions',
      'remaining plan',
      'files touched',
      'how to verify'
    ]) {
      expect(text).toContain(part)
    }
    expect(text).toContain("Don't start new work here.")
  })
})

describe('the guidance block says the user’s context instruction beats "no need to wrap up early"', () => {
  const SUPERSEDES =
    'That instruction supersedes any general advice not to wrap up early or hand off.'

  it.each([
    ['Claude', 'mcp__claude-ui-sessions__'],
    ['opencode', 'claudeui_'],
    ['pi', '']
  ])('%s: the system-prompt text names session_hand_off and carries the line', (_, prefix) => {
    const text = sessionToolsGuidance({ toolPrefix: prefix })
    expect(text).toContain(`\`${prefix}session_hand_off\``)
    expect(text).toContain(SUPERSEDES)
  })

  it('every carrier takes the same bullets (pi promptGuidelines, opencode instructions)', () => {
    const { bullets } = sessionToolsGuidanceParts({ toolPrefix: '' })
    expect(bullets.some((b) => b.includes(SUPERSEDES))).toBe(true)
    expect(SESSION_TOOL_NAMES).toContain('session_hand_off')
  })
})
