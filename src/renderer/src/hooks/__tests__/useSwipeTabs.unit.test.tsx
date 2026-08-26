/**
 * Tests for the mobile tab-swipe detector.
 *
 * jsdom notes: PointerEvent exists and honours `pointerType`, which is what the
 * detector gates on. Layout does not exist — `scrollWidth`/`clientWidth` are
 * both 0 — so the "starts on a horizontal scroller" exemption is exercised
 * through the explicit `[data-hscroll]` marker, which is the escape hatch real
 * callers are told to use anyway.
 */

import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { useSwipeTabs, SWIPE_THRESHOLD_PX } from '../useSwipeTabs'

function Probe({
  index = 1,
  count = 4,
  enabled = true,
  onChange
}: {
  index?: number
  count?: number
  enabled?: boolean
  onChange: (n: number) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useSwipeTabs(ref, { index, count, onChange, enabled })
  return (
    <div data-testid="content" ref={ref}>
      <p data-testid="text">a setting</p>
      <input data-testid="slider" type="range" />
      <div data-testid="hscroll" data-hscroll>
        <span data-testid="chip">chip</span>
      </div>
    </div>
  )
}

/** A press → (optional) move → release, the way a browser reports a drag. */
function swipe(
  el: Element,
  from: [number, number],
  to: [number, number],
  pointerType = 'touch'
): void {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(el, {
    pointerId: 1,
    pointerType,
    clientX: (from[0] + to[0]) / 2,
    clientY: (from[1] + to[1]) / 2
  })
  fireEvent.pointerUp(el, { pointerId: 1, pointerType, clientX: to[0], clientY: to[1] })
}

describe('useSwipeTabs', () => {
  it('a leftward swipe past the threshold advances one tab', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [280 - SWIPE_THRESHOLD_PX - 20, 300])
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('a rightward swipe goes back one tab', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('content'), [60, 300], [60 + SWIPE_THRESHOLD_PX + 20, 300])
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('a drag shorter than the threshold does nothing', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [280 - (SWIPE_THRESHOLD_PX - 10), 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('direction lock: a vertical scroll that drifts sideways never switches tab', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    const el = getByTestId('content')
    // Locks vertical on the first move, then travels far horizontally.
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 400 })
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 278, clientY: 340 })
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 330 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a purely vertical drag does nothing', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('content'), [200, 400], [200, 200])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the last tab does not wrap around to the first', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe index={3} onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [100, 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the first tab does not wrap around to the last', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe index={0} onChange={onChange} />)
    swipe(getByTestId('content'), [60, 300], [280, 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a gesture starting inside a [data-hscroll] descendant is ignored', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('chip'), [280, 300], [100, 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a drag on a range slider adjusts the slider, not the tab', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('slider'), [280, 300], [100, 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a mouse drag never switches tab', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [100, 300], 'mouse')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a second finger aborts the gesture (a pinch is not a swipe)', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    const el = getByTestId('content')

    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 300 })
    // Second finger lands — pinch/zoom, not a swipe.
    fireEvent.pointerDown(el, { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 300 })
    // Both fingers now travel far horizontally, as they do in a pinch.
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 })
    fireEvent.pointerUp(el, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 300 })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('a release from a pointer that did not start the gesture is ignored', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    const el = getByTestId('content')

    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 300 })
    // A stray release from another pointer must not be judged against pointer
    // 1's origin — that is how a pinch used to misfire a tab change.
    fireEvent.pointerUp(el, { pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 300 })
    expect(onChange).not.toHaveBeenCalled()

    // The real pointer's own release still works.
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 })
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('a move from another pointer does not steer the axis lock', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    const el = getByTestId('content')

    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 300 })
    // A wildly vertical move from a different pointer would lock the axis to
    // 'v' and kill a legitimate horizontal swipe if ids were not checked.
    fireEvent.pointerMove(el, { pointerId: 9, pointerType: 'touch', clientX: 280, clientY: 500 })
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 302 })
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 })

    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('pointercancel abandons the gesture', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe onChange={onChange} />)
    const el = getByTestId('content')
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 300 })
    fireEvent.pointerCancel(el, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 300 })
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('attaches nothing when disabled', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<Probe enabled={false} onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [100, 300])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a re-render with a new index is picked up without dropping the listeners', () => {
    const onChange = vi.fn()
    const { getByTestId, rerender } = render(<Probe index={1} onChange={onChange} />)
    rerender(<Probe index={2} onChange={onChange} />)
    swipe(getByTestId('content'), [280, 300], [100, 300])
    expect(onChange).toHaveBeenCalledWith(3)
  })
})
