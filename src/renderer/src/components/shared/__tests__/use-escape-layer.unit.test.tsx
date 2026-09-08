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
  enabled
}: {
  onClose: () => void
  enabled?: boolean
}): React.JSX.Element {
  useEscapeLayer(onClose, enabled)
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
})
