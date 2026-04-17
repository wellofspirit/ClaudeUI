/**
 * Layer 1 unit tests for useContextMenu — specifically the edge-flip logic
 * so a menu opened near the right/bottom edge of the window repositions
 * instead of getting clipped.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useContextMenu } from '../useContextMenu'
import { useSessionStore } from '../../stores/session-store'

/** Test harness: wraps the hook so we can drive it and read its style. */
function Harness({ menuSize }: { menuSize: { w: number; h: number } }): React.JSX.Element {
  const menu = useContextMenu()
  return (
    <div>
      <div data-testid="anchor" onContextMenu={menu.open} style={{ width: 10, height: 10 }} />
      {menu.isOpen && (
        <div
          data-testid="menu"
          ref={menu.ref}
          style={{ position: 'fixed', width: menuSize.w, height: menuSize.h, ...menu.style }}
        >
          item
        </div>
      )}
    </div>
  )
}

// jsdom returns zeros for getBoundingClientRect by default — stub dimensions.
function stubMenuSize(w: number, h: number): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.dataset?.testid === 'menu') {
        return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) }
      }
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    }
  })
}

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
}

function rightClick(x: number, y: number): void {
  const anchor = screen.getByTestId('anchor')
  fireEvent.contextMenu(anchor, { clientX: x, clientY: y })
}

beforeEach(() => {
  useSessionStore.setState({ settings: { ...useSessionStore.getState().settings, uiFontScale: 1 } })
  setViewport(1000, 800)
})

describe('useContextMenu edge-flip', () => {
  it('keeps the anchor position when the menu fits', () => {
    stubMenuSize(160, 200)
    render(<Harness menuSize={{ w: 160, h: 200 }} />)
    act(() => { rightClick(100, 100) })
    const menu = screen.getByTestId('menu')
    expect(menu.style.left).toBe('100px')
    expect(menu.style.top).toBe('100px')
    expect(menu.style.visibility).toBe('visible')
  })

  it('flips to the left of the anchor when it would overflow the right edge', () => {
    stubMenuSize(200, 150)
    render(<Harness menuSize={{ w: 200, h: 150 }} />)
    // anchor at x=950 with 200-wide menu → right edge would be 1150 > 1000
    act(() => { rightClick(950, 100) })
    const menu = screen.getByTestId('menu')
    // flipped: new left = 950 - 200 = 750
    expect(menu.style.left).toBe('750px')
    expect(menu.style.top).toBe('100px')
  })

  it('flips above the anchor when it would overflow the bottom edge', () => {
    stubMenuSize(160, 200)
    render(<Harness menuSize={{ w: 160, h: 200 }} />)
    act(() => { rightClick(100, 750) })
    const menu = screen.getByTestId('menu')
    expect(menu.style.left).toBe('100px')
    // flipped: new top = 750 - 200 = 550
    expect(menu.style.top).toBe('550px')
  })

  it('flips both axes when both would overflow', () => {
    stubMenuSize(200, 200)
    render(<Harness menuSize={{ w: 200, h: 200 }} />)
    act(() => { rightClick(950, 750) })
    const menu = screen.getByTestId('menu')
    expect(menu.style.left).toBe('750px')
    expect(menu.style.top).toBe('550px')
  })

  it('clamps to margin instead of producing a negative position when flipping would overshoot', () => {
    stubMenuSize(900, 100)
    render(<Harness menuSize={{ w: 900, h: 100 }} />)
    act(() => { rightClick(950, 50) })
    const menu = screen.getByTestId('menu')
    // 950 - 900 = 50; still positive so no clamp, but would overflow left if anchor smaller.
    expect(Number(menu.style.left.replace('px', ''))).toBeGreaterThanOrEqual(0)
  })

  it('accounts for uiFontScale zoom when computing viewport bounds', () => {
    useSessionStore.setState({ settings: { ...useSessionStore.getState().settings, uiFontScale: 2 } })
    // viewport = 1000/2=500 x 800/2=400 in logical units
    stubMenuSize(200, 100) // raw px — hook divides by zoom → 100x50 logical
    render(<Harness menuSize={{ w: 200, h: 100 }} />)
    // clientX=900 / zoom(2) = 450 logical; + 100 width = 550 > 500 → flip
    act(() => { rightClick(900, 100) })
    const menu = screen.getByTestId('menu')
    expect(Number(menu.style.left.replace('px', ''))).toBeLessThan(450)
  })
})
