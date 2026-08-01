/**
 * Drivers for `SelectMenu` (src/renderer/src/components/shared/SelectMenu.tsx),
 * the themed replacement for the renderer's native `<select>` elements.
 *
 * A native select is a single element you `fireEvent.change`; `SelectMenu` is a
 * trigger button plus a menu of option buttons that only exists while open. The
 * helpers keep that mechanic in ONE place, so a component test still reads as
 * "choose this value" rather than "click trigger, find option, click option".
 *
 * All three take the ROOT element (`screen.getByTestId('<the original id>')`),
 * which is where `SelectMenu` puts the call site's testid and its `data-value`.
 *
 * Usage:
 *   const field = screen.getByTestId('RemoteServerSettings.bindHost')
 *   expect(selectMenuValue(field)).toBe('10.0.0.5')
 *   chooseSelectMenuOption(field, '')
 */
import { fireEvent, within } from '@testing-library/react'

/** The controlled value the menu currently holds (mirrors `select.value`). */
export function selectMenuValue(root: HTMLElement): string | null {
  return root.getAttribute('data-value')
}

/** The option values on offer, in order (mirrors `[...select.options]`). */
export function selectMenuOptionValues(root: HTMLElement): string[] {
  const wasOpen = openSelectMenu(root)
  const values = within(root)
    .queryAllByRole('option')
    .map((o) => o.getAttribute('data-id') ?? '')
  if (!wasOpen) closeSelectMenu(root)
  return values
}

/** The option labels on offer, in order. */
export function selectMenuOptionLabels(root: HTMLElement): string[] {
  const wasOpen = openSelectMenu(root)
  const labels = within(root)
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '')
  if (!wasOpen) closeSelectMenu(root)
  return labels
}

/** Pick an option by value (mirrors `fireEvent.change(select, {target:{value}})`). */
export function chooseSelectMenuOption(root: HTMLElement, value: string): void {
  openSelectMenu(root)
  const option = within(root)
    .queryAllByRole('option')
    .find((o) => o.getAttribute('data-id') === value)
  if (!option) {
    const offered = within(root)
      .queryAllByRole('option')
      .map((o) => o.getAttribute('data-id'))
    throw new Error(`SelectMenu has no option "${value}" — offered: ${JSON.stringify(offered)}`)
  }
  fireEvent.click(option)
}

/** Opens the menu if closed. Returns whether it was ALREADY open. */
export function openSelectMenu(root: HTMLElement): boolean {
  if (within(root).queryByRole('listbox')) return true
  fireEvent.click(within(root).getByRole('combobox'))
  return false
}

function closeSelectMenu(root: HTMLElement): void {
  if (within(root).queryByRole('listbox')) {
    fireEvent.click(within(root).getByRole('combobox'))
  }
}
