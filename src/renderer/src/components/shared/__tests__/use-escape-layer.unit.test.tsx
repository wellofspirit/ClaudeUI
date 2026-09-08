/**
 * Layer 1: the Escape layer stack.
 *
 * The rule the whole app now leans on: Escape goes ONE level up. A stack of
 * sheet › dialog › editor › confirm peels a single layer per press, the layers
 * underneath hear nothing, and nothing outside the stack hears the key at all
 * (`SettingsDialog` keeps a bubble-phase Escape listener on `document` that
 * would otherwise close the entire dialog).
 *
 * Registration is module-level and the layers are siblings rather than nested
 * components, so a leaked token is invisible from any one component's tests —
 * `__escapeLayerCount` is here for exactly that.
 *
 * `active` is the menu case: a dropdown is mounted the whole time its row is on
 * screen, so it is a layer only while it is OPEN. While it is closed the hook
 * must register NOTHING — not a swallowing layer, not a token — or a settings
 * page full of pickers would leave every press to the last one mounted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useEscapeLayer, __escapeLayerCount } from '../use-escape-layer'

afterEach(() => {
  cleanup()
  expect(__escapeLayerCount(), 'a layer leaked past unmount').toBe(0)
})

function Layer({
  onClose,
  enabled,
  active
}: {
  onClose: () => void
  enabled?: boolean
  active?: boolean
}): React.JSX.Element {
  useEscapeLayer(onClose, enabled, active)
  return <div />
}

function escape(): void {
  fireEvent.keyDown(document, { key: 'Escape' })
}

describe('useEscapeLayer', () => {
  it('peels one layer per press, topmost first', () => {
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    const tree = (top: boolean): React.JSX.Element => (
      <>
        <Layer onClose={first} />
        <Layer onClose={second} />
        {top && <Layer onClose={third} />}
      </>
    )
    const { rerender } = render(tree(true))
    expect(__escapeLayerCount()).toBe(3)

    escape()
    expect(third).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()

    // The third layer's owner unmounts it in response; the next press is the
    // second's, and the first is still untouched.
    rerender(tree(false))
    expect(__escapeLayerCount()).toBe(2)
    escape()
    expect(second).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('a disabled top layer swallows the key instead of passing it down', () => {
    // A confirm mid-flight: it must not be dismissed under the user, and the
    // dialog that opened it must not close instead.
    const below = vi.fn()
    const busy = vi.fn()
    render(
      <>
        <Layer onClose={below} />
        <Layer onClose={busy} enabled={false} />
      </>
    )
    escape()
    expect(busy).not.toHaveBeenCalled()
    expect(below).not.toHaveBeenCalled()
  })

  it('re-enabling the top layer lets it close again', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Layer onClose={onClose} enabled={false} />)
    escape()
    expect(onClose).not.toHaveBeenCalled()
    // `enabled` is read through a ref, so flipping it must NOT need a
    // re-registration to take effect.
    rerender(<Layer onClose={onClose} enabled />)
    expect(__escapeLayerCount()).toBe(1)
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops the key before anything outside the stack can answer', () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    try {
      const onClose = vi.fn()
      render(<Layer onClose={onClose} />)
      escape()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(behind).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', behind)
    }
  })

  it('a re-rendered onClose does not reorder the stack', () => {
    // Callers pass inline arrows, so `onClose`'s identity changes on every
    // render of their parent. A registration keyed to that identity would
    // re-push the layer and make the LAST re-rendered one the top, whatever
    // the mount order.
    const outer = vi.fn()
    const inner = vi.fn()
    const tree = (): React.JSX.Element => (
      <>
        <Layer onClose={() => outer()} />
        <Layer onClose={() => inner()} />
      </>
    )
    const { rerender } = render(tree())
    rerender(tree())
    expect(__escapeLayerCount()).toBe(2)
    escape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('ignores every other key, and lets it through', () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    try {
      const onClose = vi.fn()
      render(<Layer onClose={onClose} />)
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(onClose).not.toHaveBeenCalled()
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', behind)
    }
  })

  it('unregisters on unmount, leaving no listener behind', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Layer onClose={onClose} />)
    expect(__escapeLayerCount()).toBe(1)
    unmount()
    expect(__escapeLayerCount()).toBe(0)
    escape()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an inactive layer registers NOTHING and the layer below answers', () => {
    // A closed dropdown. `enabled=false` would have been wrong here: that
    // swallows the key on behalf of a layer that is still on top. An inactive
    // layer is not on the stack at all.
    const below = vi.fn()
    const closedMenu = vi.fn()
    render(
      <>
        <Layer onClose={below} />
        <Layer onClose={closedMenu} active={false} />
      </>
    )
    expect(__escapeLayerCount()).toBe(1)
    escape()
    expect(closedMenu).not.toHaveBeenCalled()
    expect(below).toHaveBeenCalledTimes(1)
  })

  it('registers when active turns true and unregisters when it turns false', () => {
    const onClose = vi.fn()
    const tree = (active: boolean): React.JSX.Element => <Layer onClose={onClose} active={active} />
    const { rerender } = render(tree(false))
    expect(__escapeLayerCount()).toBe(0)

    rerender(tree(true))
    expect(__escapeLayerCount()).toBe(1)
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(tree(false))
    expect(__escapeLayerCount()).toBe(0)
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('an open menu above a sheet answers first, and the next press reaches the sheet', () => {
    // The whole point of follow-up H: a select opened inside a sheet used to
    // lose the key to the sheet's capture-phase layer, which closed the SHEET.
    const sheet = vi.fn()
    const menu = vi.fn()
    const tree = (menuOpen: boolean): React.JSX.Element => (
      <>
        <Layer onClose={sheet} />
        <Layer onClose={menu} active={menuOpen} />
      </>
    )
    const { rerender } = render(tree(true))
    expect(__escapeLayerCount()).toBe(2)
    escape()
    expect(menu).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()

    // The menu closed itself in response; the next press is the sheet's.
    rerender(tree(false))
    escape()
    expect(sheet).toHaveBeenCalledTimes(1)
    expect(menu).toHaveBeenCalledTimes(1)
  })
})
