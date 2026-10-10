/**
 * `shared/judge-guidance.ts` — the one definition of what may be written into
 * the judge's system prompt (ADR-083 §3/§4), shared by the IPC perimeter, the
 * environment builder and the settings UI.
 */
import { describe, it, expect } from 'vitest'
import {
  JUDGE_GUIDANCE_MAX_ENTRY_CHARS,
  codePointLength,
  hasPromptBreakingChar,
  judgeGuidanceEntryError
} from '../judge-guidance'

describe('hasPromptBreakingChar', () => {
  it('flags C0, DEL, C1 and the Unicode line separators — nothing else', () => {
    for (const bad of [
      '\n',
      '\r',
      '\t',
      '\u0000',
      '\u001f',
      '\u007f',
      '\u0085',
      '\u2028',
      '\u2029'
    ]) {
      expect(hasPromptBreakingChar(`a${bad}b`), JSON.stringify(bad)).toBe(true)
    }
    for (const ok of ['running the linter', 'Bash(git push:*)', 'café — naïve', '😀', ' ']) {
      expect(hasPromptBreakingChar(ok), JSON.stringify(ok)).toBe(false)
    }
  })
})

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength('😀😀')).toBe(2)
  })
})

describe('judgeGuidanceEntryError', () => {
  it('accepts plain one-line text up to the cap', () => {
    expect(judgeGuidanceEntryError('creating and switching git branches')).toBeNull()
    expect(judgeGuidanceEntryError('x'.repeat(JUDGE_GUIDANCE_MAX_ENTRY_CHARS))).toBeNull()
    expect(judgeGuidanceEntryError('😀'.repeat(JUDGE_GUIDANCE_MAX_ENTRY_CHARS))).toBeNull()
  })

  it('names the problem for a tab or line break', () => {
    expect(judgeGuidanceEntryError('a\tb')).toMatch(/no tabs or line breaks/)
    expect(judgeGuidanceEntryError('a\nb')).toMatch(/no tabs or line breaks/)
  })

  it('names the cap for an over-long entry', () => {
    expect(judgeGuidanceEntryError('x'.repeat(JUDGE_GUIDANCE_MAX_ENTRY_CHARS + 1))).toMatch(
      /300 characters or fewer/
    )
  })
})
