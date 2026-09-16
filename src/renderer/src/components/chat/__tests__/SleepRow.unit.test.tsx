/**
 * Layer 1 (unit) for `SleepRow` — Codex's `clock.sleep`, lifted out of the
 * card shell into the one-line shape `TodoToolBlock` uses.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SleepRow, formatSleepDuration } from '../SleepRow'
import type { ContentBlock } from '../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: 'tu-sleep',
  toolName: 'sleep',
  toolInput: { durationMs: 2500 }
}

describe('SleepRow', () => {
  it('reads `waiting …` with a spinner until the result lands', () => {
    render(<SleepRow block={block} view={{ kind: 'sleep', durationMs: 30_000 }} />)
    expect(screen.getByTestId('SleepRow.duration').textContent).toBe('waiting 30 s…')
  })

  it('reads `waited …` once it has resolved', () => {
    const result: ToolResultBlock = { type: 'tool_result', toolUseId: 'tu-sleep', toolResult: '' }
    render(<SleepRow block={block} result={result} view={{ kind: 'sleep', durationMs: 2500 }} />)
    expect(screen.getByTestId('SleepRow.duration').textContent).toBe('waited 2.5 s')
    expect(screen.getByTestId('SleepRow').textContent).toContain('Sleep')
  })

  it('reads the duration from the VIEW, never from the tool input', () => {
    render(<SleepRow block={block} view={{ kind: 'sleep', durationMs: 1000 }} />)
    expect(screen.getByTestId('SleepRow.duration').textContent).toContain('1 s')
  })
})

describe('formatSleepDuration', () => {
  it.each([
    [340, '340 ms'],
    [999, '999 ms'],
    [1000, '1 s'],
    [2500, '2.5 s'],
    [59_900, '59.9 s'],
    [60_000, '1 m'],
    [90_000, '1 m 30 s'],
    [300_000, '5 m']
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatSleepDuration(ms)).toBe(text)
  })

  it('refuses to invent a number for a broken duration', () => {
    expect(formatSleepDuration(Number.NaN)).toBe('?')
    expect(formatSleepDuration(-1)).toBe('?')
    expect(formatSleepDuration(Number.POSITIVE_INFINITY)).toBe('?')
  })
})
