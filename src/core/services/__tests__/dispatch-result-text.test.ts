/**
 * @vitest-environment node
 *
 * The words of an X-Agent's end as its parent reads them (ADR-105 §3, slice B-3b).
 */
import { describe, it, expect } from 'vitest'
import {
  RESULT_REPORT_MAX,
  RESULT_TEXT_MAX,
  failedResultText,
  interruptedResultText,
  reportResultText,
  sentenceLabel,
  statusLine,
  stoppedResultText,
  truncationPointer
} from '../dispatch-result-text'
import { ITEM_BODY_MAX } from '../session-delivery'
import { frameHandBack } from '../../../shared/handback-frame'

const frame = (report: string): string =>
  frameHandBack({ name: 'rev', engine: 'pi', model: 'gpt', report })
const base = { name: 'rev', status: 'STATUS', frame }

describe('the delivery stays under the host cap', () => {
  it('RESULT_TEXT_MAX is below the 20 000 deliver() would cut at, so a trailing pointer is never cut', () => {
    expect(RESULT_REPORT_MAX).toBe(16_000)
    expect(RESULT_TEXT_MAX).toBeLessThan(ITEM_BODY_MAX)
  })

  it('a short report is delivered whole, with no pointer', () => {
    const text = reportResultText({ ...base, report: 'all good' })
    expect(text.startsWith('STATUS\n[X-Agent report]')).toBe(true)
    expect(text).toContain('\n  all good')
    expect(text).not.toContain('truncated')
  })

  it('a report over 16 000 is cut there and the pointer follows the frame', () => {
    const text = reportResultText({ ...base, report: 'Q'.repeat(40_000) })
    expect(text.endsWith(truncationPointer('rev'))).toBe(true)
    expect(text.match(/Q+/g)!.join('').length).toBe(16_000)
    expect(text.length).toBeLessThanOrEqual(RESULT_TEXT_MAX)
  })

  it('a report of short lines, which the frame indents, is cut further to fit', () => {
    const text = reportResultText({ ...base, report: 'a\n'.repeat(20_000) })
    expect(text.length).toBeLessThanOrEqual(RESULT_TEXT_MAX)
    expect(text.endsWith(truncationPointer('rev'))).toBe(true)
  })

  it('the pointer names the card of the X-Agent, one line, whatever its name holds', () => {
    expect(truncationPointer('a\nb  c')).toBe(
      "(report truncated — the full report is on X-Agent a b c's card)"
    )
  })
})

describe('the status line', () => {
  it('counts tool uses, tokens and time, and the cost when it is known', () => {
    expect(
      statusLine({
        name: 'rev',
        usage: { totalTokens: 12_345, toolUses: 1, durationMs: 125_000 },
        costUsd: 0.0123
      })
    ).toBe('X-Agent rev finished: 1 tool use · 12k tokens · 2m 05s · cost so far $0.0123.')
    expect(
      statusLine({ name: 'rev', usage: { totalTokens: 800, toolUses: 0, durationMs: 4000 } })
    ).toBe('X-Agent rev finished: 0 tool uses · 800 tokens · 4s.')
  })

  it('says when some turns could not be priced', () => {
    expect(
      statusLine({
        name: 'rev',
        usage: { totalTokens: 1, toolUses: 2, durationMs: 0 },
        costUsd: 0,
        unpricedTurns: 2
      })
    ).toContain('cost so far $0.0000 (2 unpriced turns not counted)')
  })
})

describe('the sentences of the other ends', () => {
  it('failed: the first line of the reason, bounded', () => {
    expect(failedResultText('rev', 'Dispatched turn failed: boom.\nstack…')).toBe(
      'X-Agent rev failed: Dispatched turn failed: boom.'
    )
    expect(failedResultText('rev', null)).toBe('X-Agent rev failed.')
    expect(failedResultText('rev', 'x'.repeat(500)).length).toBeLessThan(260)
  })

  it('stopped and interrupted', () => {
    expect(stoppedResultText('rev')).toBe('X-Agent rev was stopped by the user.')
    expect(interruptedResultText('rev', 'sess-1')).toBe(
      'X-Agent rev was interrupted when ClaudeUI quit; continue it with dispatch_agent session_id sess-1.'
    )
  })

  it('a name is one bounded line in our own sentences', () => {
    expect(sentenceLabel('a\n\nb')).toBe('a b')
    expect(sentenceLabel('n'.repeat(200)).length).toBe(80)
  })
})
