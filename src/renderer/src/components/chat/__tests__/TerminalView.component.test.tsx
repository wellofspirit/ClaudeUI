/**
 * WS8 guard test: TerminalView must not bleed ANSI SGR state between cards.
 * A module-level shared AnsiUp carried the "current color" from one card's
 * unterminated escape into the next card's output; each conversion now uses a
 * fresh instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TerminalView } from '../TerminalView'

const ESC = String.fromCharCode(27)

beforeEach(() => {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = { logError: () => {} }
})

describe('TerminalView — ANSI isolation', () => {
  it('does not leak color state from one card into the next', () => {
    render(
      <>
        {/* Unterminated red foreground (no reset). */}
        <TerminalView text={`${ESC}[31mred without reset`} />
        {/* Plain text — must render uncolored. */}
        <TerminalView text={'plain text'} />
      </>
    )
    const views = screen.getAllByTestId('TerminalView')
    expect(views[1].textContent).toContain('plain text')
    // Pre-fix, the shared AnsiUp carried the red SGR into this second card.
    expect(views[1].innerHTML).not.toContain('color:')
  })
})

describe('TerminalView — pin to the tail without forcing layout', () => {
  // A ResizeObserver whose callback the test fires by hand: "the card was laid out".
  let fire: (() => void) | null
  const disconnect = vi.fn()
  beforeEach(() => {
    fire = null
    disconnect.mockReset()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb
        }
        observe(): void {}
        disconnect = disconnect
      }
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Reading `scrollHeight` in the mount effect forced a layout of every card,
  // even one whose message `content-visibility: auto` was skipping: on a pi
  // transcript with ~500 tool cards that was ~70% of the time to open it.
  it('reads no layout on mount, and scrolls to the bottom once the card is laid out', () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    try {
      render(<TerminalView text={'line\n'.repeat(100)} />)
      const pre = screen.getByTestId('TerminalView')
      expect(scrollHeight).not.toHaveBeenCalled()
      expect(pre.scrollTop).toBe(0)

      fire?.()
      expect(pre.scrollTop).toBe(500)
      expect(disconnect).toHaveBeenCalled()
    } finally {
      scrollHeight.mockRestore()
    }
  })
})
