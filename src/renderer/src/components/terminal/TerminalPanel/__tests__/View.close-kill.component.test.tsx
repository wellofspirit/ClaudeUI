/**
 * Layer 2: the tab close button's two paths, THROUGH the strip.
 *
 * Closing a terminal means "stop it" (ADR-062), so the × KILLS and the modifier
 * guards the safe half: Shift-click detaches this surface and leaves the pty
 * running for anyone else attached to the shared per-cwd pool. That inverts the
 * older "the safe action stays the unmodified one" stance — deliberately, because
 * detach-only closing left a runaway process with no reachable stop, and the
 * phone's chip has no modifier to offer at all.
 *
 * The tab itself is now its own component (it owns a context menu — see
 * TerminalTab.component.test.tsx); these cases stay here because what they pin
 * is the STRIP's contract: which tab id the view reports, and with which flag.
 *
 * XTermInstance is stubbed so this stays a test of the tab bar — the lazy
 * boundary itself is covered by View.lazy-xterm.component.test.tsx.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { TerminalTab } from '../../../../../../shared/types'
import { TerminalPanelView, type TerminalPanelViewProps } from '../View'

vi.mock('../XTermInstance', () => ({
  XTermInstance: () => null
}))

const TAB: TerminalTab = { id: 'term-1', title: 'Terminal', cwd: '/d/repo' }

function viewProps(onCloseTab: TerminalPanelViewProps['onCloseTab']): TerminalPanelViewProps {
  return {
    style: {},
    visibleTabs: [TAB],
    allTabs: [TAB],
    activeId: TAB.id,
    onSelectTab: () => {},
    onCloseTab,
    onNewTab: () => {},
    onClosePanel: () => {},
    nextSlot: 1,
    nextSlotRunning: false
  }
}

describe('TerminalPanelView — close vs detach', () => {
  afterEach(() => cleanup())

  it('a plain click asks for the KILL', () => {
    const onCloseTab = vi.fn()
    render(<TerminalPanelView {...viewProps(onCloseTab)} />)

    fireEvent.click(screen.getByTestId('TerminalTab.close'))

    // `detach: false` — the container kills the pty and only then drops the tab.
    expect(onCloseTab).toHaveBeenCalledTimes(1)
    expect(onCloseTab).toHaveBeenCalledWith(TAB.id, false)
  })

  it('a SHIFT-click detaches instead, leaving the shell running', () => {
    const onCloseTab = vi.fn()
    render(<TerminalPanelView {...viewProps(onCloseTab)} />)

    fireEvent.click(screen.getByTestId('TerminalTab.close'), { shiftKey: true })

    expect(onCloseTab).toHaveBeenCalledTimes(1)
    expect(onCloseTab).toHaveBeenCalledWith(TAB.id, true)
  })

  it('does not select the tab as a side effect of closing it', () => {
    const onSelectTab = vi.fn()
    render(<TerminalPanelView {...viewProps(vi.fn())} onSelectTab={onSelectTab} />)

    fireEvent.click(screen.getByTestId('TerminalTab.close'), { shiftKey: true })

    expect(onSelectTab).not.toHaveBeenCalled()
  })

  it('advertises both paths on the button itself, plus the menu that spells them out', () => {
    render(<TerminalPanelView {...viewProps(vi.fn())} />)
    expect(screen.getByTestId('TerminalTab.close')).toHaveAttribute(
      'title',
      'Close (kill) — Shift-click to detach, right-click for more'
    )
  })
})
