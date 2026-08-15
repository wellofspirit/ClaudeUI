/**
 * Layer 2: the terminal tab's right-click menu — the DISCOVERABLE kill path.
 *
 * Killing a shell existed before this menu, but only as Shift-click on the ×:
 * invisible unless you already knew, which is how the owner ended up with
 * "there is no way to kill a terminal completely" while a kill verb sat behind
 * a modifier. The menu spells out the distinction the pool created — close
 * detaches THIS surface, kill ends the shell for every attached one — and asks
 * before the destructive half.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { TerminalTab as TerminalTabModel } from '../../../../../../shared/types'
import { TerminalTab } from '../TerminalTab'

const TAB: TerminalTabModel = { id: 'term-1', title: 'Terminal', cwd: '/d/repo', poolIndex: 0 }

function renderTab(onClose = vi.fn(), onSelect = vi.fn()): { onClose: typeof onClose; onSelect: typeof onSelect } {
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
    expect(screen.getByTestId('TerminalTab.menuClose')).toBeTruthy()
    expect(screen.getByTestId('TerminalTab.menuKill')).toBeTruthy()
  })

  it('the plain menu item closes WITHOUT killing', () => {
    const { onClose } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuClose'))

    expect(onClose).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId('TerminalTab.menu')).toBeNull()
  })

  it('kill asks first — the menu item alone kills nothing', () => {
    const { onClose } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('TerminalTab.killWarning')).toBeTruthy()
    // The safe item is out of the way while the destructive one is armed, so a
    // second click on the same spot cannot mean two different things.
    expect(screen.queryByTestId('TerminalTab.menuClose')).toBeNull()
  })

  it('the confirmation kills and closes the menu', () => {
    const { onClose } = renderTab()
    openMenu()
    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))
    fireEvent.click(screen.getByTestId('TerminalTab.confirmKill'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('TerminalTab.menu')).toBeNull()
  })

  it('cancel returns to the safe menu and kills nothing', () => {
    const { onClose } = renderTab()
    openMenu()
    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))
    fireEvent.click(screen.getByTestId('TerminalTab.cancelKill'))

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('TerminalTab.menuClose')).toBeTruthy()
    expect(screen.queryByTestId('TerminalTab.killWarning')).toBeNull()
  })

  it('re-opening the menu disarms a confirmation left behind', () => {
    renderTab()
    openMenu()
    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))
    expect(screen.getByTestId('TerminalTab.confirmKill')).toBeTruthy()

    // Outside click dismisses (useContextMenu listens on mousedown).
    fireEvent.mouseDown(document.body)
    openMenu()

    expect(screen.queryByTestId('TerminalTab.confirmKill')).toBeNull()
    expect(screen.getByTestId('TerminalTab.menuClose')).toBeTruthy()
  })

  // Pins the OUTCOME, not a guard: the menu is the tab's fragment sibling, so
  // menu clicks never travel through the tab. A refactor that nests the menu
  // inside the tab (or gives the strip a click handler) is exactly what this
  // catches — it would start selecting a tab on the way to killing it.
  it('clicking inside the menu does not select the tab underneath', () => {
    const { onSelect } = renderTab()
    openMenu()

    fireEvent.click(screen.getByTestId('TerminalTab.menuKill'))
    fireEvent.click(screen.getByTestId('TerminalTab.confirmKill'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the × as close-with-Shift-to-kill, and advertises the menu', () => {
    const { onClose } = renderTab()

    fireEvent.click(screen.getByTestId('TerminalTab.close'))
    expect(onClose).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByTestId('TerminalTab.close'), { shiftKey: true })
    expect(onClose).toHaveBeenLastCalledWith(true)

    expect(screen.getByTestId('TerminalTab.close')).toHaveAttribute(
      'title',
      'Close (detach) — Shift-click to kill, right-click for more'
    )
  })
})
