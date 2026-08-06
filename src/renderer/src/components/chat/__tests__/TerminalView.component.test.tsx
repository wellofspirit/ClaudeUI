/**
 * WS8 guard test: TerminalView must not bleed ANSI SGR state between cards.
 * A module-level shared AnsiUp carried the "current color" from one card's
 * unterminated escape into the next card's output; each conversion now uses a
 * fresh instance.
 */

import { describe, it, expect, beforeEach } from 'vitest'
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
