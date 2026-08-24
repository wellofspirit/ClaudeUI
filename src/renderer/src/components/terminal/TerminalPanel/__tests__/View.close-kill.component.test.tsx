/**
 * Layer 2: the tab close button's two paths, THROUGH the strip.
 *
 * Closing a terminal tab is DETACH-ONLY since terminals became a shared per-cwd
 * pool — which left no UI path at all to stop a runaway process, because the
 * cold sweep only reaps cwds with no live session (never the one you are working
 * in). Shift-click is that path. The modifier belongs on the DESTRUCTIVE action:
 * the unmodified click must stay the safe one, since another surface may be
 * attached to the same pty.
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

describe('TerminalPanelView — close vs kill', () => {
  afterEach(() => cleanup())

  it('a plain click closes without asking for a kill', () => {
    const onCloseTab = vi.fn()
    render(<TerminalPanelView {...viewProps(onCloseTab)} />)

    fireEvent.click(screen.getByTestId('TerminalTab.close'))

    expect(onCloseTab).toHaveBeenCalledTimes(1)
    expect(onCloseTab).toHaveBeenCalledWith(TAB.id, false)
  })

  it('a SHIFT-click asks for the kill', () => {
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
      'Close (detach) — Shift-click to kill, right-click for more'
    )
  })
})
