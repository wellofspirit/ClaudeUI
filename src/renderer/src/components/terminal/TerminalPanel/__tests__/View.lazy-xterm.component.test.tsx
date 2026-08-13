/**
 * Layer 2: Component test for TerminalPanelView's lazy XTermInstance boundary.
 *
 * SessionView keeps the terminal panel container mounted at all times
 * (display:none preserves scrollback), so xterm.js can only stay out of the
 * eager App chunk if the code split sits at XTermInstance — it mounts once per
 * tab, and the tab count starts at zero.
 *
 * The `xtermLoaded` probe *is* the mock factory: vitest runs it on the first
 * import of '@xterm/xterm', so flipping a flag there records when xterm enters
 * the module graph. A static import in View.tsx would flip it during this
 * file's own import phase, failing the first assertion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TerminalTab } from '../../../../../../shared/types'
import { TerminalPanelView, type TerminalPanelViewProps } from '../View'

// vi.hoisted so the probe exists before the hoisted vi.mock factory closes over it
const { xtermLoaded } = vi.hoisted(() => ({ xtermLoaded: { current: false } }))

// Mock shapes mirror XTermInstance.component.test.ts — the wiring itself is
// covered there; here they only need to survive mount/unmount.
class MockTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  write = vi.fn()
  focus = vi.fn()
  dispose = vi.fn()
  loadAddon = vi.fn()
  open = vi.fn()

  onData(): { dispose: () => void } {
    return { dispose: () => {} }
  }
}

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

vi.mock('@xterm/xterm', () => {
  xtermLoaded.current = true
  return {
    Terminal: class {
      constructor() {
        return new MockTerm() as any
      }
    } as any
  }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  } as any
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const TAB: TerminalTab = { id: 'term-1', title: 'Terminal', cwd: '/d/repo' }

function viewProps(tabs: TerminalTab[], activeId: string | null): TerminalPanelViewProps {
  return {
    style: {},
    visibleTabs: tabs,
    allTabs: tabs,
    activeId,
    onSelectTab: () => {},
    onCloseTab: () => {},
    onNewTab: () => {},
    onClosePanel: () => {}
  }
}

describe('TerminalPanelView — lazy XTermInstance', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    ;(global as any).ResizeObserver = MockResizeObserver
    // requestAnimationFrame fires synchronously in jsdom
    ;(global as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }
    app.bridge.ipcMain.handle('terminal:write', async () => {})
    app.bridge.ipcMain.handle('terminal:resize', async () => {})
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it('renders the empty state with zero tabs without pulling xterm into the graph', async () => {
    // A static import in View.tsx would already have run the mock factory.
    expect(xtermLoaded.current).toBe(false)

    render(<TerminalPanelView {...viewProps([], null)} />)

    expect(screen.getByTestId('TerminalPanel')).toBeInTheDocument()
    expect(screen.getByText(/to open a terminal/)).toBeInTheDocument()

    // Give any in-flight dynamic import a turn to land; nothing should request it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(xtermLoaded.current).toBe(false)
    expect(screen.queryByTestId('XTermInstance')).toBeNull()
  })

  it('suspends then mounts the terminal once the first tab exists', async () => {
    expect(xtermLoaded.current).toBe(false)

    render(<TerminalPanelView {...viewProps([TAB], TAB.id)} />)

    // First paint is the Suspense fallback: the chunk is still in flight.
    expect(screen.getByText('Loading terminal…')).toBeInTheDocument()
    expect(screen.queryByTestId('XTermInstance')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('XTermInstance')).toBeInTheDocument())

    expect(xtermLoaded.current).toBe(true)
    expect(screen.queryByText('Loading terminal…')).toBeNull()
  })
})
