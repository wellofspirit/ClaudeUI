/**
 * Layer 2: the terminal tab's close semantics and its right-click menu.
 *
 * Closing a terminal MEANS "stop it" (ADR-062): the × kills the shell, and the
 * modifier now guards the SAFE half — Shift-click detaches and leaves the pty
 * running for whoever else is attached. The menu spells both out, in that order,
 * and the kill no longer asks: it is the same action a plain click performs, so
 * an in-menu confirm in front of it would be ceremony the × does not charge.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { TerminalTab as TerminalTabModel } from '../../../../../../shared/types'
import { TerminalTab } from '../TerminalTab'

const TAB: TerminalTabModel = { id: 'term-1', title: 'Terminal', cwd: '/d/repo', poolIndex: 0 }

function renderTab(
  onClose = vi.fn(),
  onSelect = vi.fn()
): { onClose: typeof onClose; onSelect: typeof onSelect } {
  render(<TerminalTab tab={TAB} active onSelect={onSelect} onClose={onClose} />)
  return { onClose, onSelect }
}

/** Right-click the tab body — jsdom fires no contextmenu from `click`. */
function openMenu(): void {
  fireEvent.contextMenu(screen.getByTestId('TerminalTab'))
}

describe('TerminalTab — context menu', () => {
  afterEach(() => cleanup())

  it('has no menu until the tab is right-clicked', () => {
    renderTab()
    expect(screen.queryByTestId('TerminalTab.menu')).toBeNull()

    openMenu()
    expect(screen.getByTestId('TerminalTab.menu')).toBeTruthy()
    expect(screen.getByTestId('TerminalTab.menuKill')).toBeTruthy()
    expect(screen.getByTestId('TerminalTab.menuDetach')).toBeTruthy()
  })

  it('the kill item kills immediately — no confirmation step', () => {
    const { onClose } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))

    // `detach: false` IS the kill. A confirm here would be stricter than the ×,
    // which performs the identical action on one unmodified click.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId('TerminalTab.menu')).toBeNull()
    // The whole arm-then-confirm machinery is gone with it.
    expect(screen.queryByTestId('TerminalTab.killWarning')).toBeNull()
    expect(screen.queryByTestId('TerminalTab.confirmKill')).toBeNull()
    expect(screen.queryByTestId('TerminalTab.cancelKill')).toBeNull()
  })

  it('the detach item keeps the shell running and closes the menu', () => {
    const { onClose } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuDetach'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('TerminalTab.menu')).toBeNull()
  })

  it('names both actions for what they do to the SHELL, not to the tab', () => {
    renderTab()
    openMenu()

    expect(screen.getByTestId('TerminalTab.menuKill').textContent).toBe('Kill shell')
    expect(screen.getByTestId('TerminalTab.menuDetach').textContent).toBe(
      'Detach (keep shell running)'
    )
  })

  // Pins the OUTCOME, not a guard: the menu is the tab's fragment sibling, so
  // menu clicks never travel through the tab. A refactor that nests the menu
  // inside the tab (or gives the strip a click handler) is exactly what this
  // catches — it would start selecting a tab on the way to killing it.
  it('clicking inside the menu does not select the tab underneath', () => {
    const { onSelect } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('makes the × a kill, Shift-click a detach, and advertises both', () => {
    const { onClose } = renderTab()

    fireEvent.click(screen.getByTestId('TerminalTab.close'))
    expect(onClose).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByTestId('TerminalTab.close'), { shiftKey: true })
    expect(onClose).toHaveBeenLastCalledWith(true)

    expect(screen.getByTestId('TerminalTab.close')).toHaveAttribute(
      'title',
      'Close (kill) — Shift-click to detach, right-click for more'
    )
  })
})
