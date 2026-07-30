/**
 * Component tests for `useDraggableWidget` (ADR-043 §2).
 *
 * The interesting contract is the click/drag split: the floating widgets use
 * the SAME element as both the expand/collapse button and the drag handle, so a
 * regression here either breaks dragging or breaks the widget's only control.
 *
 * jsdom notes: `setPointerCapture` does not exist (the hook try/catches it) and
 * `getBoundingClientRect` reports 0×0, so the clamp falls back to its minimum
 * sizes — viewport bounds (1024×768) still drive the assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { useDraggableWidget } from '../useDraggableWidget'

const KEY = 'claudeui.widgetPos.test'

function Probe({ storageKey = KEY }: { storageKey?: string }): React.JSX.Element {
  const drag = useDraggableWidget(storageKey)
  const [clicks, setClicks] = useState(0)
  return (
    <div
      data-testid="root"
      ref={drag.ref}
      data-dragged={drag.dragged || undefined}
      style={drag.style}
    >
      <button
        data-testid="header"
        onClick={() => {
          if (drag.didDrag()) return
          setClicks((n) => n + 1)
        }}
        {...drag.headerHandlers}
      >
        header
      </button>
      <span data-testid="clicks">{clicks}</span>
    </div>
  )
}

/** Full press → (optional) move → release → click, the way a browser does it. */
function pressAt(el: Element, x: number, y: number): void {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: y })
}
function moveTo(el: Element, x: number, y: number): void {
  fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y })
}
function releaseAt(el: Element, x: number, y: number): void {
  fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y })
  fireEvent.click(el)
}

describe('useDraggableWidget', () => {
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight

  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
  })

  it('starts undragged, in the layout stack, with no inline position', () => {
    const { getByTestId } = render(<Probe />)
    const root = getByTestId('root') as HTMLElement
    expect(root.hasAttribute('data-dragged')).toBe(false)
    expect(root.style.position).toBe('')
  })

  it('a press with no movement still fires the header click', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    releaseAt(header, 100, 100)
    expect(getByTestId('clicks').textContent).toBe('1')
    expect(getByTestId('root').hasAttribute('data-dragged')).toBe(false)
  })

  it('movement below the 4px threshold is still a click, not a drag', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    moveTo(header, 102, 102) // hypot ≈ 2.83
    releaseAt(header, 102, 102)
    expect(getByTestId('clicks').textContent).toBe('1')
    expect(getByTestId('root').hasAttribute('data-dragged')).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('movement past the threshold detaches the widget and suppresses the click', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    moveTo(header, 100, 140)
    releaseAt(header, 100, 140)

    const root = getByTestId('root') as HTMLElement
    expect(root.getAttribute('data-dragged')).toBe('true')
    expect(root.style.position).toBe('fixed')
    expect(root.style.top).toBe('40px')
    // Right-anchored so the expand animation keeps growing leftwards.
    expect(root.style.right).not.toBe('')
    // The drag must NOT toggle the widget open.
    expect(getByTestId('clicks').textContent).toBe('0')
  })

  it('a click AFTER a drag works again (the suppression flag is consumed)', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    moveTo(header, 100, 140)
    releaseAt(header, 100, 140)
    expect(getByTestId('clicks').textContent).toBe('0')

    pressAt(header, 100, 140)
    releaseAt(header, 100, 140)
    expect(getByTestId('clicks').textContent).toBe('1')
  })

  it('persists the position and restores it on the next mount', () => {
    const first = render(<Probe />)
    const header = first.getByTestId('header')
    pressAt(header, 200, 200)
    moveTo(header, 180, 260)
    releaseAt(header, 180, 260)

    const stored = JSON.parse(window.localStorage.getItem(KEY) as string)
    expect(typeof stored.top).toBe('number')
    expect(typeof stored.right).toBe('number')
    first.unmount()

    const second = render(<Probe />)
    const root = second.getByTestId('root') as HTMLElement
    expect(root.getAttribute('data-dragged')).toBe('true')
    expect(root.style.top).toBe(`${stored.top}px`)
    expect(root.style.right).toBe(`${stored.right}px`)
  })

  it('ignores a corrupt stored position instead of throwing', () => {
    window.localStorage.setItem(KEY, '{not json')
    const first = render(<Probe />)
    expect(first.getByTestId('root').hasAttribute('data-dragged')).toBe(false)
    first.unmount()

    window.localStorage.setItem(KEY, JSON.stringify({ top: 'x', right: null }))
    const second = render(<Probe />)
    expect(second.getByTestId('root').hasAttribute('data-dragged')).toBe(false)
  })

  it('double-clicking the header returns the widget to the stack', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    moveTo(header, 100, 140)
    releaseAt(header, 100, 140)
    expect(getByTestId('root').getAttribute('data-dragged')).toBe('true')

    fireEvent.doubleClick(header)
    const root = getByTestId('root') as HTMLElement
    expect(root.hasAttribute('data-dragged')).toBe(false)
    expect(root.style.position).toBe('')
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('re-clamps into view when the window shrinks', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    pressAt(header, 100, 100)
    moveTo(header, 100, 500) // top = 400
    releaseAt(header, 100, 500)
    expect((getByTestId('root') as HTMLElement).style.top).toBe('400px')

    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true })
    fireEvent(window, new Event('resize'))
    // Keeps 48px of the widget on screen: top ≤ 200 - 48.
    expect((getByTestId('root') as HTMLElement).style.top).toBe('152px')
    expect(JSON.parse(window.localStorage.getItem(KEY) as string).top).toBe(152)
  })

  it('a non-primary button never starts a drag', () => {
    const { getByTestId } = render(<Probe />)
    const header = getByTestId('header')
    fireEvent.pointerDown(header, { pointerId: 1, button: 2, clientX: 100, clientY: 100 })
    moveTo(header, 100, 200)
    expect(getByTestId('root').hasAttribute('data-dragged')).toBe(false)
  })
})
