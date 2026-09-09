/**
 * Layer 2: SheetFrame's Escape handling.
 *
 * The Manage sheet mounts a SECOND frame for "Edit endpoint" (ProviderSheet's
 * `endpointSheet`), so two frames are on screen at once. Both listen for Escape
 * on `document` in the capture phase, so one press used to close BOTH — the
 * edit sheet and the Manage sheet under it — and the user landed back on the
 * providers list having only meant to cancel the edit (ADR-065 phase 7).
 *
 * The rule guarded here: an Escape closes exactly the TOPMOST frame, and the
 * settings dialog behind never sees the key at all (the frame stops it, which
 * is why `SettingsDialog`'s own bubble-phase Escape listener stays quiet).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SheetFrame } from '../SheetFrame'

afterEach(() => cleanup())

function escape(): void {
  fireEvent.keyDown(document, { key: 'Escape' })
}

describe('SheetFrame Escape', () => {
  it('closes a lone sheet', () => {
    const onClose = vi.fn()
    render(
      <SheetFrame testid="Sheet.a" title="A" footer={null} onClose={onClose}>
        body
      </SheetFrame>
    )
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes ONLY the topmost of two stacked sheets, then the one below', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    const { rerender } = render(
      <>
        <SheetFrame testid="Sheet.outer" title="Outer" footer={null} onClose={closeOuter}>
          outer
        </SheetFrame>
        <SheetFrame testid="Sheet.inner" title="Inner" footer={null} onClose={closeInner}>
          inner
        </SheetFrame>
      </>
    )
    expect(screen.getByTestId('Sheet.inner')).toBeInTheDocument()

    escape()
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()

    // The inner sheet's owner unmounts it in response; the next Escape is the
    // outer one's.
    rerender(
      <>
        <SheetFrame testid="Sheet.outer" title="Outer" footer={null} onClose={closeOuter}>
          outer
        </SheetFrame>
      </>
    )
    escape()
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).toHaveBeenCalledTimes(1)
  })

  it('a re-rendered onClose does not reorder the stack', () => {
    // The endpoint sheet passes an INLINE arrow as onClose, so its identity
    // changes on every render of its parent. A registration keyed to that
    // identity would re-push the frame and make the LAST re-rendered sheet the
    // top one, whatever the mount order.
    const closeOuter = vi.fn()
    const inner = vi.fn()
    const tree = (outerClose: () => void): React.JSX.Element => (
      <>
        <SheetFrame testid="Sheet.outer" title="Outer" footer={null} onClose={outerClose}>
          outer
        </SheetFrame>
        <SheetFrame testid="Sheet.inner" title="Inner" footer={null} onClose={inner}>
          inner
        </SheetFrame>
      </>
    )
    const { rerender } = render(tree(() => closeOuter()))
    rerender(tree(() => closeOuter()))
    escape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('stops the key before the settings dialog behind it can answer', () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    try {
      const onClose = vi.fn()
      render(
        <SheetFrame testid="Sheet.a" title="A" footer={null} onClose={onClose}>
          body
        </SheetFrame>
      )
      escape()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(behind).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', behind)
    }
  })

  it('ignores every other key', () => {
    const onClose = vi.fn()
    render(
      <SheetFrame testid="Sheet.a" title="A" footer={null} onClose={onClose}>
        body
      </SheetFrame>
    )
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
