/**
 * Layer 1: the terminal-toggle keybinding predicate.
 *
 * Two bindings share one matcher so SessionView's keydown handler can stay a
 * single `if`. The interesting case is Alt+` on macOS: Option+` is a DEAD KEY
 * in most layouts, so the keydown reports `key: 'Dead'` while `code` still says
 * 'Backquote'. Matching on `key` would silently drop the binding on exactly the
 * platform it was added for.
 */
import { describe, it, expect } from 'vitest'
import { isTerminalToggleShortcut } from '../toggle-terminal'

/** Minimal KeyboardEvent-shaped stub — the predicate reads five fields. */
function key(init: {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): KeyboardEvent {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false
  } as KeyboardEvent
}

describe('isTerminalToggleShortcut', () => {
  it('matches Ctrl+` (the original binding, unchanged)', () => {
    expect(isTerminalToggleShortcut(key({ key: '`', code: 'Backquote', ctrlKey: true }))).toBe(true)
  })

  it('matches Cmd+`', () => {
    expect(isTerminalToggleShortcut(key({ key: '`', code: 'Backquote', metaKey: true }))).toBe(true)
  })

  it("matches Alt+` on macOS, where the dead key reports key: 'Dead'", () => {
    expect(isTerminalToggleShortcut(key({ key: 'Dead', code: 'Backquote', altKey: true }))).toBe(
      true
    )
  })

  it('matches Alt+` off macOS, where the key resolves normally', () => {
    expect(isTerminalToggleShortcut(key({ key: '`', code: 'Backquote', altKey: true }))).toBe(true)
  })

  it('ignores every shift combo (~ is a different intent)', () => {
    expect(
      isTerminalToggleShortcut(key({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }))
    ).toBe(false)
    expect(
      isTerminalToggleShortcut(key({ key: '`', code: 'Backquote', metaKey: true, shiftKey: true }))
    ).toBe(false)
    expect(
      isTerminalToggleShortcut(
        key({ key: 'Dead', code: 'Backquote', altKey: true, shiftKey: true })
      )
    ).toBe(false)
  })

  it('ignores a bare backquote — it must stay typeable', () => {
    expect(isTerminalToggleShortcut(key({ key: '`', code: 'Backquote' }))).toBe(false)
  })

  it('ignores Alt on any other physical key', () => {
    expect(isTerminalToggleShortcut(key({ key: 'a', code: 'KeyA', altKey: true }))).toBe(false)
    // Even when a dead-key composition puts a backquote in `key`, the physical
    // key is what decides — this is the mirror of the macOS case above.
    expect(isTerminalToggleShortcut(key({ key: '`', code: 'KeyE', altKey: true }))).toBe(false)
  })

  it('ignores Ctrl+Alt+` and Cmd+Alt+` (modifier soup is not the binding)', () => {
    expect(
      isTerminalToggleShortcut(key({ key: '`', code: 'Backquote', ctrlKey: true, altKey: true }))
    ).toBe(false)
    expect(
      isTerminalToggleShortcut(key({ key: 'Dead', code: 'Backquote', metaKey: true, altKey: true }))
    ).toBe(false)
  })
})
