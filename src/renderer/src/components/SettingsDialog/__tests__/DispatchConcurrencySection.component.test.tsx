/**
 * Layer 2: the app-level dispatch concurrency row (ADR-033, 2026-09-18 ruling).
 *
 * The only row on the dispatch page backed by ClaudeUI's own settings.json
 * rather than an `engines/<engine>.json`, so what it has to get right is the
 * three-state value: empty (the key is absent, the cap is the default 3), `0`
 * (no limit) and `n`. The placeholder is the only place the default is stated,
 * and Reset must CLEAR the key rather than write 3 into the profile — a written
 * 3 would pin today's default forever.
 *
 * Tested flows:
 *   1. Unset renders empty with the default as the placeholder, and offers no
 *      Reset (nothing to reset to).
 *   2. Typing a number commits on blur and saves it.
 *   3. `0` is saved as 0, not dropped — it is the "no limit" pick.
 *   4. Clearing the field, and Reset, both remove the key (undefined).
 *   5. A negative count drops the key instead of being clamped to 0 — clamping
 *      would silently turn a mistyped -1 into "no limit".
 *   6. The row's number and the dispatcher's gate share one resolver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { DispatchConcurrencySection } from '../settings-sections'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../stores/session-store'
import {
  DEFAULT_MAX_CONCURRENT_DISPATCHES,
  resolveDispatchMaxConcurrent
} from '../../../../../shared/dispatch-concurrency'

const update = vi.fn()

function renderRow(dispatchMaxConcurrent?: number): void {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, dispatchMaxConcurrent }
  render(<DispatchConcurrencySection settings={settings} update={update} />)
}

function field(): HTMLInputElement {
  return screen.getByTestId('DispatchConcurrencySection.maxConcurrent') as HTMLInputElement
}

/** NumberField commits on blur, so a half-typed number never reaches the store. */
function type(value: string): void {
  fireEvent.change(field(), { target: { value } })
  fireEvent.blur(field())
}

beforeEach(() => {
  update.mockClear()
})

afterEach(cleanup)

describe('DispatchConcurrencySection', () => {
  it('renders the row with the default as the placeholder when unset', () => {
    renderRow(undefined)

    expect(screen.getByTestId('DispatchConcurrencySection.maxConcurrentRow')).toBeTruthy()
    expect(field().value).toBe('')
    expect(field().placeholder).toBe(String(DEFAULT_MAX_CONCURRENT_DISPATCHES))
    expect(field().placeholder).toBe('3')
    // Nothing to reset: the key is not in the profile.
    expect(screen.queryByTestId('DispatchConcurrencySection.maxConcurrentRow.reset')).toBeNull()
  })

  it('shows the configured value and saves a typed one on blur', () => {
    renderRow(undefined)

    fireEvent.change(field(), { target: { value: '6' } })
    expect(update).not.toHaveBeenCalled() // not until blur

    fireEvent.blur(field())
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: 6 })
  })

  it('keeps 0 — the "no limit" pick — instead of treating it as empty', () => {
    renderRow(undefined)
    type('0')
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: 0 })
    expect(resolveDispatchMaxConcurrent(0)).toBe(Number.POSITIVE_INFINITY)
  })

  it('clearing the field removes the key', () => {
    renderRow(6)
    expect(field().value).toBe('6')

    type('')
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: undefined })
  })

  it('Reset appears once the key is set and clears it', () => {
    renderRow(6)

    const reset = screen.getByTestId('DispatchConcurrencySection.maxConcurrentRow.reset')
    fireEvent.click(reset)
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: undefined })
  })

  it('drops a negative count rather than clamping it to "no limit"', () => {
    renderRow(undefined)
    type('-1')
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: undefined })
  })

  it('floors a fractional count so the file never holds a partial slot', () => {
    renderRow(undefined)
    type('2.7')
    expect(update).toHaveBeenCalledWith({ dispatchMaxConcurrent: 2 })
  })
})

describe('resolveDispatchMaxConcurrent', () => {
  it('maps every stored shape to the cap the gate compares against', () => {
    expect(resolveDispatchMaxConcurrent(undefined)).toBe(3)
    expect(resolveDispatchMaxConcurrent(0)).toBe(Number.POSITIVE_INFINITY)
    expect(resolveDispatchMaxConcurrent(1)).toBe(1)
    expect(resolveDispatchMaxConcurrent(12)).toBe(12)
    // Fractions floor, but never below one usable slot.
    expect(resolveDispatchMaxConcurrent(2.7)).toBe(2)
    expect(resolveDispatchMaxConcurrent(0.5)).toBe(1)
    // Junk — a hand-edited settings.json — reads as unset, never as 0.
    expect(resolveDispatchMaxConcurrent(-4)).toBe(3)
    expect(resolveDispatchMaxConcurrent(Number.NaN)).toBe(3)
    expect(resolveDispatchMaxConcurrent(Number.POSITIVE_INFINITY)).toBe(3)
    expect(resolveDispatchMaxConcurrent('5')).toBe(3)
    expect(resolveDispatchMaxConcurrent(null)).toBe(3)
  })
})
