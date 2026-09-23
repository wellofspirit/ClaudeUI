/**
 * Layer 2: the Models & providers group ADR-065 phase 3A put on the row
 * vocabulary — Default models › Claude (`effortDefaults`).
 *
 * It used to be a form of its own, with a prose footer repeating what the group
 * header now says. What is guarded here is the behaviour that changed with the
 * vocabulary, not the markup: an effort row is "modified" when its key is
 * PRESENT in `modelEffortDefaults` (the object-valued setting the phase-1
 * `appDefault` helper cannot compare), and Reset DELETES that key rather than
 * writing the default level.
 *
 * The Anthropic endpoint rows that shared this file moved to the Claude page
 * (ADR-074 §9); `ClaudeEndpointSettings.component.test.tsx` guards them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type { AppSettings } from '../../../stores/session-store'

afterEach(cleanup)

// ── Default models › Claude (per-model effort) ───────────────────────

function renderEffortRows(settings: Partial<AppSettings>): {
  update: ReturnType<typeof vi.fn>
} {
  const update = vi.fn()
  const section = SECTIONS.find((s) => s.id === 'effortDefaults')!
  render(
    <div>
      {section.items.map((item) => (
        <div key={item.key}>
          {item.render(
            settings as AppSettings,
            update as never,
            {} as never,
            () => {},
            {} as never,
            () => {}
          )}
        </div>
      ))}
    </div>
  )
  return { update }
}

function effortRow(modelId: string): HTMLElement {
  const row = screen
    .getAllByTestId('ModelEffortRow')
    .find((el) => el.getAttribute('data-id') === modelId)
  expect(row, `ModelEffortRow for ${modelId}`).toBeTruthy()
  return row!
}

describe('Default models › Claude effort rows', () => {
  it('is a row per model: display name, canonical id as the config key, one select', () => {
    renderEffortRows({})

    const ids = screen.getAllByTestId('ModelEffortRow').map((el) => el.getAttribute('data-id'))
    expect(ids).toEqual([
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-fable-5'
    ])

    const row = effortRow('claude-opus-4-8')
    expect(row.textContent).toContain('Opus 4.8')
    expect(row.textContent).toContain('claude-opus-4-8')
    expect(within(row).getByTestId('ModelEffortRow.effort')).toBeTruthy()
  })

  it('marks a row modified only when ITS key is present in modelEffortDefaults', () => {
    renderEffortRows({ modelEffortDefaults: { 'claude-opus-4-8': 'max' } })

    // The accent dot is gone (2026-09-08); the hover Reset is the marker, and
    // the row always passes `onReset`, so its presence IS "this row is
    // modified".
    expect(within(effortRow('claude-opus-4-8')).queryByTestId('ModelEffortRow.reset')).toBeTruthy()
    expect(within(effortRow('claude-sonnet-5')).queryByTestId('ModelEffortRow.reset')).toBeNull()
  })

  it('Reset DELETES the key rather than writing the default level', () => {
    const { update } = renderEffortRows({
      modelEffortDefaults: { 'claude-opus-4-8': 'max', 'claude-sonnet-5': 'low' }
    })

    fireEvent.click(within(effortRow('claude-opus-4-8')).getByTestId('ModelEffortRow.reset'))

    expect(update).toHaveBeenCalledWith({ modelEffortDefaults: { 'claude-sonnet-5': 'low' } })
    expect(update.mock.calls[0][0].modelEffortDefaults).not.toHaveProperty('claude-opus-4-8')
  })

  it('replaces the 11px footer with a description-only row', () => {
    renderEffortRows({})
    const note = screen.getByTestId('EffortDefaultsNote')
    expect(note.textContent).toContain('per-session effort chip always wins')
  })
})
