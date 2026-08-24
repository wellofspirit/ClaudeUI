/**
 * Layer 2: the themed `<select>` replacement. Everything asserted here is a
 * semantic the native element gave us for free and that call sites still rely
 * on after the sweep:
 *   1. controlled `value` -> trigger label; an UNKNOWN value is not silently
 *      re-read as the first option (a native select would show option[0])
 *   2. `onChange` receives the option's value string (the old `e.target.value`)
 *   3. an explicit empty option is a real, selectable choice
 *   4. `disabled` blocks selection AND cannot be left with an open menu
 *   5. options are real DOM buttons styled from theme tokens (the Monokai
 *      regression that motivated the whole sweep), never `<option>`
 *   6. ADR-027 testids: root / `.trigger` / `.option` + `data-id`
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { SelectMenu } from '../SelectMenu'
import {
  chooseSelectMenuOption,
  selectMenuOptionValues,
  selectMenuValue
} from '../../../../../test/helpers/select-menu'

const OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' }
]

function renderMenu(props: Partial<React.ComponentProps<typeof SelectMenu>> = {}): {
  onChange: ReturnType<typeof vi.fn>
  root: HTMLElement
} {
  const onChange = vi.fn()
  render(<SelectMenu testid="Demo" value="a" options={OPTIONS} onChange={onChange} {...props} />)
  return { onChange, root: screen.getByTestId('Demo') }
}

afterEach(cleanup)

describe('SelectMenu', () => {
  it('shows the selected option label and exposes the value as data-value', () => {
    const { root } = renderMenu()
    expect(selectMenuValue(root)).toBe('a')
    expect(root).toHaveTextContent('Alpha')
  })

  it('never renders a native <select> or <option>', () => {
    const { root } = renderMenu()
    fireEvent.click(within(root).getByTestId('Demo.trigger'))
    expect(root.querySelector('select')).toBeNull()
    expect(root.querySelector('option')).toBeNull()
    // Real DOM buttons carrying theme tokens, so they are legible under every
    // theme (the OS-painted option list was not, under Monokai).
    const option = within(root)
      .getAllByTestId('Demo.option')
      .find((o) => o.getAttribute('data-id') === 'b')!
    expect(option.tagName).toBe('BUTTON')
    expect(option.className).toContain('text-text-secondary')
  })

  it('opens on the trigger and offers every option in order', () => {
    const { root } = renderMenu()
    expect(within(root).queryByRole('listbox')).toBeNull()
    expect(selectMenuOptionValues(root)).toEqual(['', 'a', 'b'])
  })

  it('hands onChange the option value and closes', () => {
    const { onChange, root } = renderMenu()
    chooseSelectMenuOption(root, 'b')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('b')
    expect(within(root).queryByRole('listbox')).toBeNull()
  })

  it('treats an explicit empty option as a real choice (clearing a value)', () => {
    const { onChange, root } = renderMenu()
    chooseSelectMenuOption(root, '')
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('shows an unknown value verbatim rather than collapsing to option[0]', () => {
    const { root } = renderMenu({ value: 'legacy/hand-edited' })
    expect(selectMenuValue(root)).toBe('legacy/hand-edited')
    expect(root).toHaveTextContent('legacy/hand-edited')
    expect(root).not.toHaveTextContent('(none)')
  })

  it('prefers fallbackLabel over the raw value when one is given', () => {
    const { root } = renderMenu({ value: 'gone', fallbackLabel: 'Unavailable' })
    expect(root).toHaveTextContent('Unavailable')
  })

  it('a disabled control cannot be opened', () => {
    const { onChange, root } = renderMenu({ disabled: true })
    expect(within(root).getByTestId('Demo.trigger')).toBeDisabled()
    fireEvent.click(within(root).getByTestId('Demo.trigger'))
    expect(within(root).queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes an already-open menu when the control becomes disabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <SelectMenu testid="Demo" value="a" options={OPTIONS} onChange={onChange} />
    )
    fireEvent.click(screen.getByTestId('Demo.trigger'))
    expect(screen.getByRole('listbox')).toBeTruthy()

    rerender(<SelectMenu testid="Demo" value="a" options={OPTIONS} onChange={onChange} disabled />)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a disabled OPTION is rendered but not selectable', () => {
    const { onChange, root } = renderMenu({
      options: [...OPTIONS, { value: 'c', label: 'Gamma', disabled: true }]
    })
    fireEvent.click(within(root).getByTestId('Demo.trigger'))
    const gamma = within(root)
      .getAllByTestId('Demo.option')
      .find((o) => o.getAttribute('data-id') === 'c')!
    expect(gamma).toBeDisabled()
    fireEvent.click(gamma)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes on Escape and on an outside mousedown', () => {
    const { root } = renderMenu()
    fireEvent.click(within(root).getByTestId('Demo.trigger'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(within(root).queryByRole('listbox')).toBeNull()

    fireEvent.click(within(root).getByTestId('Demo.trigger'))
    fireEvent.mouseDown(document.body)
    expect(within(root).queryByRole('listbox')).toBeNull()
  })

  it('carries the call site id and extra data attributes for repeated instances', () => {
    const { root } = renderMenu({ id: 'field-1', dataAttrs: { 'data-harness': 'pi' } })
    expect(root.getAttribute('data-harness')).toBe('pi')
    // `id` lands on the focusable control so an existing <label htmlFor> still works.
    expect(within(root).getByTestId('Demo.trigger').id).toBe('field-1')
  })

  it('reads as a combobox to assistive tech, exactly like the <select> it replaced', () => {
    const { root } = renderMenu()
    const trigger = within(root).getByRole('combobox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(within(root).getByRole('listbox')).toBeTruthy()
    expect(
      within(root)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-selected'))
    ).toEqual(['false', 'true', 'false'])
  })
})
