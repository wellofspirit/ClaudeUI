/**
 * Layer 1: shared settings controls.
 *
 * Focused on `InfoTooltip`, which grew a touch affordance: a phone has no hover,
 * so the ⓘ is now tappable. Desktop hover must be untouched, and the tap must
 * not leak into the control the icon is embedded in (`SettingsToggle` renders
 * the icon INSIDE its row button).
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InfoTooltip, SettingsToggle } from '../settings-controls'

/**
 * One tap, as a real touch browser reports it.
 *
 * Android Chrome and iOS Safari synthesize a mouse sequence after the touch
 * one, INCLUDING a `mouseenter` — and never a matching `mouseleave`, because
 * the finger has left. Simulating only `click` would test a device that does
 * not exist and would miss the stuck-open bug entirely.
 */
function deviceTap(el: Element): void {
  fireEvent.pointerEnter(el, { pointerType: 'touch' })
  fireEvent.pointerDown(el, { pointerType: 'touch' })
  fireEvent.pointerUp(el, { pointerType: 'touch' })
  fireEvent.mouseEnter(el) // synthesized; no mouseleave will ever follow
  fireEvent.click(el)
}

describe('InfoTooltip', () => {
  it('is closed until something asks for it', () => {
    render(<InfoTooltip text="the explanation" />)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('opens on hover and closes on leave (desktop, unchanged)', () => {
    render(<InfoTooltip text="the explanation" />)
    const root = screen.getByTestId('InfoTooltip')

    fireEvent.mouseEnter(root)
    expect(screen.getByTestId('InfoTooltip.popover')).toHaveTextContent('the explanation')

    fireEvent.mouseLeave(root)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('a tap pins it open, and a second tap closes it — on a browser that fakes hover', () => {
    render(<InfoTooltip text="the explanation" />)
    const toggle = screen.getByTestId('InfoTooltip.toggle')

    deviceTap(toggle)
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // The second tap must actually CLOSE it. Two things have to hold: the
    // outside-tap dismiss must ignore pointerdowns inside the tooltip (or it
    // would cancel the toggle out), and the synthesized `mouseenter` must not
    // have latched `hovered` (or the popover would stay up on a phantom hover
    // that no `mouseleave` will ever clear).
    deviceTap(toggle)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('a tap never latches hover, so nothing is left stuck open', () => {
    render(<InfoTooltip text="the explanation" />)
    const toggle = screen.getByTestId('InfoTooltip.toggle')
    deviceTap(toggle)
    deviceTap(toggle)
    // A mouseleave would never arrive on a phone; assert the popover is already
    // gone without one.
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('a real mouse still hovers after a touch interaction on the same element', () => {
    render(<InfoTooltip text="the explanation" />)
    const root = screen.getByTestId('InfoTooltip')
    deviceTap(screen.getByTestId('InfoTooltip.toggle'))
    deviceTap(screen.getByTestId('InfoTooltip.toggle')) // back to closed

    // Hybrid device (a Surface, a phone with a mouse): a genuine mouse pointer
    // must not be permanently locked out by the earlier taps.
    fireEvent.pointerEnter(root, { pointerType: 'mouse' })
    fireEvent.mouseEnter(root)
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
  })

  it('a pinned popover survives the pointer leaving (no hover on touch)', () => {
    render(<InfoTooltip text="the explanation" />)
    deviceTap(screen.getByTestId('InfoTooltip.toggle'))
    fireEvent.mouseLeave(screen.getByTestId('InfoTooltip'))
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
  })

  it('a tap outside dismisses it', () => {
    render(
      <div>
        <InfoTooltip text="the explanation" />
        <button data-testid="elsewhere">elsewhere</button>
      </div>
    )
    fireEvent.click(screen.getByTestId('InfoTooltip.toggle'))
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('the popover itself is inert — taps fall through to the content behind it', () => {
    render(<InfoTooltip text="the explanation" />)
    fireEvent.click(screen.getByTestId('InfoTooltip.toggle'))
    // Deliberate: the popover is a read-only hint, so it must never swallow a
    // tap aimed at the setting underneath it.
    expect(screen.getByTestId('InfoTooltip.popover')).toHaveClass('pointer-events-none')
  })

  it('tapping the ⓘ inside a SettingsToggle explains it instead of toggling it', () => {
    const onChange = vi.fn()
    render(
      <SettingsToggle label="Command sandbox" checked={false} onChange={onChange} tooltip="what it does" />
    )
    fireEvent.click(screen.getByTestId('InfoTooltip.toggle'))
    expect(screen.getByTestId('InfoTooltip.popover')).toHaveTextContent('what it does')
    expect(onChange).not.toHaveBeenCalled()
  })
})
