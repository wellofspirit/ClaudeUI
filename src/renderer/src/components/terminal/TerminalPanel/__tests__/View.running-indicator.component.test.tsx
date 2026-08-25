/**
 * Layer 2: the "a shell is still running here" indicator.
 *
 * The pool is shared and a DETACH (Shift-click, or the tab menu) lets go of a
 * slot without stopping it, so the panel can be empty while a dev server keeps
 * running in slot 0 — as it can when another surface owns that slot outright.
 * Before this, nothing on screen distinguished either case from a machine with
 * no shells at all. The strip's "+" and the empty state both have to say which
 * of the two the next open will be.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { TerminalTab } from '../../../../../../shared/types'
import { TerminalPanelView, type TerminalPanelViewProps } from '../View'

vi.mock('../XTermInstance', () => ({ XTermInstance: () => null }))

const TAB: TerminalTab = { id: 'term-1', title: 'Terminal', cwd: '/d/repo', poolIndex: 0 }

function props(overrides: Partial<TerminalPanelViewProps> = {}): TerminalPanelViewProps {
  return {
    style: {},
    visibleTabs: [],
    allTabs: [],
    activeId: null,
    onSelectTab: () => {},
    onCloseTab: () => {},
    onNewTab: () => {},
    onClosePanel: () => {},
    nextSlot: 0,
    nextSlotRunning: false,
    ...overrides
  }
}

describe('TerminalPanelView — detached-but-running indicator', () => {
  afterEach(() => cleanup())

  it('says nothing when the next slot is free', () => {
    render(<TerminalPanelView {...props()} />)

    expect(screen.queryByTestId('TerminalPanel.newTabRunning')).toBeNull()
    expect(screen.getByTestId('TerminalPanel.newTab')).not.toHaveAttribute('data-running')
    expect(screen.getByTestId('TerminalPanel.newTab')).toHaveAttribute('title', 'New terminal')
    expect(screen.getByTestId('TerminalPanel.empty')).toBeTruthy()
    expect(screen.queryByTestId('TerminalPanel.emptyRunning')).toBeNull()
  })

  it('badges "+" and renames the action when the next open would RE-ATTACH', () => {
    render(<TerminalPanelView {...props({ nextSlotRunning: true })} />)

    expect(screen.getByTestId('TerminalPanel.newTabRunning')).toBeTruthy()
    expect(screen.getByTestId('TerminalPanel.newTab')).toHaveAttribute('data-running', 'true')
    expect(screen.getByTestId('TerminalPanel.newTab')).toHaveAttribute(
      'title',
      'Re-attach to the shell already running in terminal 1'
    )
  })

  // The wire is 0-based (slot 3 IS the fourth pool slot); the copy is 1-based,
  // because the only number a person can check is the tab's position.
  it('names the terminal the re-attach would land on, 1-based in copy', () => {
    render(<TerminalPanelView {...props({ nextSlot: 3, nextSlotRunning: true })} />)

    expect(screen.getByTestId('TerminalPanel.newTab')).toHaveAttribute(
      'title',
      'Re-attach to the shell already running in terminal 4'
    )
  })

  it('replaces the empty state with the running one — an empty panel is not an idle machine', () => {
    render(<TerminalPanelView {...props({ nextSlotRunning: true })} />)

    expect(screen.getByTestId('TerminalPanel.emptyRunning')).toBeTruthy()
    expect(screen.queryByTestId('TerminalPanel.empty')).toBeNull()
  })

  it('shows neither empty state while a tab is open, badge or not', () => {
    render(
      <TerminalPanelView
        {...props({
          visibleTabs: [TAB],
          allTabs: [TAB],
          activeId: TAB.id,
          nextSlot: 1,
          nextSlotRunning: true
        })}
      />
    )

    expect(screen.queryByTestId('TerminalPanel.empty')).toBeNull()
    expect(screen.queryByTestId('TerminalPanel.emptyRunning')).toBeNull()
    // The badge still applies: slot 1 is somebody else's live shell.
    expect(screen.getByTestId('TerminalPanel.newTabRunning')).toBeTruthy()
  })
})
