/**
 * Layer 1: Unit tests for ModelPicker's "free" badge + filter (opencode zen
 * free-tier models). Verifies:
 *   - a "free" badge renders next to shortName only for flagged models
 *   - the "Free" filter chip appears only when at least one model is free
 *   - activating the filter hides non-free models AND groups that become empty
 *   - a stale active filter is ignored when the list loses all free models
 *     (chip unmounts → user can't un-toggle → must not dead-end empty)
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { EnginePicker, ModelPicker, type ModelDisplay } from '../InlinePickers'

const claudeModel: ModelDisplay = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Anthropic',
  shortName: 'Opus 4.7',
  engineId: 'claude',
  vendorId: 'anthropic'
}

const zenFreeModel: ModelDisplay = {
  value: 'opencode/free1',
  displayName: 'Free One',
  description: 'Free One · OpenCode Zen',
  shortName: 'Free One',
  engineId: 'opencode',
  vendorId: 'zen',
  free: true
}

const zenPaidModel: ModelDisplay = {
  value: 'opencode/paid1',
  displayName: 'Paid One',
  description: 'Paid One · OpenCode Zen',
  shortName: 'Paid One',
  engineId: 'opencode',
  vendorId: 'zen'
}

function openDropdown(): void {
  fireEvent.click(screen.getByTestId('ModelPicker.trigger'))
}

function optionByValue(value: string): HTMLElement {
  const options = screen.getAllByTestId('ModelPicker.option')
  const match = options.find((o) => o.getAttribute('data-value') === value)
  if (!match) throw new Error(`No ModelPicker.option with data-value="${value}"`)
  return match
}

describe('ModelPicker — free badge + filter', () => {
  it('renders a free badge only for flagged models', () => {
    render(
      <ModelPicker
        models={[claudeModel, zenFreeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()

    expect(
      within(optionByValue('opencode/free1')).getByTestId('ModelPicker.freeBadge')
    ).toBeInTheDocument()
    expect(
      within(optionByValue('opencode/paid1')).queryByTestId('ModelPicker.freeBadge')
    ).toBeNull()
    expect(
      within(optionByValue('claude-opus-4-7')).queryByTestId('ModelPicker.freeBadge')
    ).toBeNull()

    // Exactly one badge rendered across the whole dropdown.
    expect(screen.getAllByTestId('ModelPicker.freeBadge')).toHaveLength(1)
  })

  it('shows the Free filter chip only when at least one model is free', () => {
    const { unmount } = render(
      <ModelPicker
        models={[claudeModel, zenFreeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()
    expect(screen.getByTestId('ModelPicker.freeFilter')).toBeInTheDocument()
    unmount()

    render(
      <ModelPicker
        models={[claudeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()
    expect(screen.queryByTestId('ModelPicker.freeFilter')).toBeNull()
  })

  it('activating the filter hides non-free models and empties the Claude group', () => {
    render(
      <ModelPicker
        models={[claudeModel, zenFreeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()
    expect(screen.getAllByTestId('ModelPicker.option')).toHaveLength(3)

    fireEvent.click(screen.getByTestId('ModelPicker.freeFilter'))

    const remaining = screen.getAllByTestId('ModelPicker.option')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].getAttribute('data-value')).toBe('opencode/free1')
    expect(screen.getByTestId('ModelPicker.freeFilter').getAttribute('aria-pressed')).toBe('true')

    // Toggling off restores the full list.
    fireEvent.click(screen.getByTestId('ModelPicker.freeFilter'))
    expect(screen.getAllByTestId('ModelPicker.option')).toHaveLength(3)
  })

  it('ignores a stale active filter when the model list loses all free models', () => {
    const { rerender } = render(
      <ModelPicker
        models={[claudeModel, zenFreeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()
    fireEvent.click(screen.getByTestId('ModelPicker.freeFilter'))
    expect(screen.getAllByTestId('ModelPicker.option')).toHaveLength(1)

    // The session becomes engine-locked to Claude → upstream filtering strips
    // all opencode (free) models. The chip unmounts, so the user could never
    // un-toggle — the stale filter must be ignored, not leave an empty dropdown.
    rerender(
      <ModelPicker
        models={[claudeModel, zenPaidModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    expect(screen.queryByTestId('ModelPicker.freeFilter')).toBeNull()
    const options = screen.getAllByTestId('ModelPicker.option')
    expect(options.map((o) => o.getAttribute('data-value')).sort()).toEqual([
      'claude-opus-4-7',
      'opencode/paid1'
    ])
  })
})

describe('EnginePicker', () => {
  it('offers every registered engine and invokes the selected engine', () => {
    const onSelectEngine = vi.fn()
    render(
      <EnginePicker selectedEngineId="claude" locked={false} onSelectEngine={onSelectEngine} />
    )

    fireEvent.click(screen.getByTestId('EnginePicker.trigger'))
    expect(
      screen.getAllByTestId('EnginePicker.option').map((option) => option.dataset.engine)
    ).toEqual(['claude', 'opencode', 'pi'])
    const piOption = screen
      .getAllByTestId('EnginePicker.option')
      .find((option) => option.dataset.engine === 'pi')
    if (!piOption) throw new Error('Pi engine option not found')
    fireEvent.click(piOption)
    expect(onSelectEngine).toHaveBeenCalledWith('pi')
  })

  it('stays visible but disabled when the session engine is locked', () => {
    const onSelectEngine = vi.fn()
    render(<EnginePicker selectedEngineId="pi" locked onSelectEngine={onSelectEngine} />)

    const trigger = screen.getByTestId('EnginePicker.trigger')
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('title', 'Engine selection is unavailable')
    fireEvent.click(trigger)
    expect(screen.queryByTestId('EnginePicker.option')).toBeNull()
    expect(onSelectEngine).not.toHaveBeenCalled()
  })
})
