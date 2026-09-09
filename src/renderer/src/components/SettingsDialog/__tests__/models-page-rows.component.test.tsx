/**
 * Layer 2: the two Models & providers groups ADR-065 phase 3A put on the row
 * vocabulary — Anthropic endpoint (`vendor-anthropic`) and Default models ›
 * Claude (`effortDefaults`).
 *
 * Both used to be forms of their own: uppercase sub-headers with 10px labels
 * over bare inputs, dependent fields that VANISHED when their master toggle was
 * off, and a prose footer repeating what the group header now says. What is
 * guarded here is the behaviour that changed with the vocabulary, not the markup:
 *
 *  - a dependent row stays MOUNTED and readable when its parent is off, and is
 *    disabled rather than absent (ADR-065's dependent-row rule);
 *  - the auth token is masked until Reveal, which is a per-view toggle;
 *  - every write still goes through `updateVendorConfig` with the whole-object
 *    patch shape the pre-redesign form used — byte-identical to the file;
 *  - an effort row is "modified" when its key is PRESENT in
 *    `modelEffortDefaults` (the object-valued setting the phase-1 `appDefault`
 *    helper cannot compare), and Reset DELETES that key rather than writing the
 *    default level.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type { AppSettings } from '../../../stores/session-store'
import type { VendorConfig } from '../../../../../shared/types'

afterEach(cleanup)

// ── Anthropic endpoint ───────────────────────────────────────────────

function renderAnthropic(vendorConfig: VendorConfig): {
  updateVendorConfig: ReturnType<typeof vi.fn>
} {
  const updateVendorConfig = vi.fn()
  const item = SECTIONS.find((s) => s.id === 'vendor-anthropic')!.items[0]
  render(
    item.render(
      {} as never,
      () => {},
      {} as never,
      () => {},
      vendorConfig,
      updateVendorConfig as never
    )
  )
  return { updateVendorConfig }
}

const V = 'VendorAnthropicEditableForm'

const ENDPOINT_ON: VendorConfig = {
  endpoint: { enabled: true, baseUrl: 'https://gw.example.com', authToken: 'sk-ant-secret' }
}

describe('Anthropic endpoint rows', () => {
  it('keeps the dependent rows mounted and readable when the toggle is OFF', () => {
    renderAnthropic({
      endpoint: { enabled: false, baseUrl: 'https://gw.example.com', authToken: '' }
    })

    // The old form unmounted these entirely, so what was configured was
    // invisible until you flipped the switch to find out (ADR-065).
    const baseUrl = screen.getByTestId(`${V}.baseUrl`) as HTMLInputElement
    expect(baseUrl.value).toBe('https://gw.example.com')
    expect(baseUrl.disabled).toBe(true)
    expect((screen.getByTestId(`${V}.authToken`) as HTMLInputElement).disabled).toBe(true)
    // Dimmed, one nesting level in — never removed.
    expect(screen.getByTestId(`${V}.baseUrlRow`).className).toContain('pl-[38px]')
  })

  it('enables them when the toggle is ON', () => {
    renderAnthropic(ENDPOINT_ON)
    expect((screen.getByTestId(`${V}.baseUrl`) as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByTestId(`${V}.authToken`) as HTMLInputElement).disabled).toBe(false)
  })

  it('masks the auth token until Reveal, and re-masks on a second press', () => {
    renderAnthropic(ENDPOINT_ON)

    const token = (): HTMLInputElement => screen.getByTestId(`${V}.authToken`) as HTMLInputElement
    expect(token().type).toBe('password')

    fireEvent.click(screen.getByTestId(`${V}.revealToken`))
    expect(token().type).toBe('text')
    expect(token().value).toBe('sk-ant-secret')

    fireEvent.click(screen.getByTestId(`${V}.revealToken`))
    expect(token().type).toBe('password')
  })

  it('writes the WHOLE endpoint object on every edit, exactly as before', () => {
    const { updateVendorConfig } = renderAnthropic(ENDPOINT_ON)

    fireEvent.change(screen.getByTestId(`${V}.baseUrl`), {
      target: { value: 'https://other.example.com' }
    })

    expect(updateVendorConfig).toHaveBeenCalledWith({
      endpoint: {
        enabled: true,
        baseUrl: 'https://other.example.com',
        authToken: 'sk-ant-secret'
      }
    })
  })

  it('still edits all four model-override fields, each writing the whole object', () => {
    // `claude-spawn-prep` maps every one of these onto an
    // ANTHROPIC_DEFAULT_*_MODEL env var, so dropping three of them would orphan
    // three live settings.
    const { updateVendorConfig } = renderAnthropic({
      modelOverride: {
        enabled: true,
        model: 'm',
        sonnetModel: 's',
        opusModel: 'o',
        haikuModel: 'h'
      }
    })

    const fields = screen.getAllByTestId(`${V}.modelField`).map((el) => el.getAttribute('data-id'))
    expect(fields).toEqual(['model', 'sonnetModel', 'opusModel', 'haikuModel'])

    const opus = screen
      .getAllByTestId(`${V}.modelField`)
      .find((el) => el.getAttribute('data-id') === 'opusModel')!
    fireEvent.change(opus, { target: { value: 'claude-opus-4-8' } })

    expect(updateVendorConfig).toHaveBeenCalledWith({
      modelOverride: {
        enabled: true,
        model: 'm',
        sonnetModel: 's',
        opusModel: 'claude-opus-4-8',
        haikuModel: 'h'
      }
    })
  })

  it('has no uppercase sub-headers and no prose footer left', () => {
    renderAnthropic(ENDPOINT_ON)
    // "Applies on next session start / persists to vendors/anthropic.json" is
    // the group's applies-on badge plus its storage tag now — not a third copy
    // in 10px muted type at the bottom of the card.
    const text = screen.getByTestId(V).textContent ?? ''
    expect(text).not.toContain('Persists to vendors/anthropic.json')
    expect(text).not.toContain('ENDPOINT')
  })
})

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
