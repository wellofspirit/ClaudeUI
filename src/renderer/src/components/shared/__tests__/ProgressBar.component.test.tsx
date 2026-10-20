import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProgressBar } from '../ProgressBar'

describe('ProgressBar', () => {
  it('is determinate with a percent: aria value and width', () => {
    render(<ProgressBar percent={42} testid="bar" />)
    const bar = screen.getByTestId('bar')
    expect(bar).toHaveAttribute('role', 'progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('42%')
  })

  it('pulses without a percent', () => {
    render(<ProgressBar percent={null} testid="bar" />)
    const bar = screen.getByTestId('bar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar.firstElementChild).toHaveClass('animate-pulse')
  })

  it('eases the fill only when asked (the load view feeds it four times a second)', () => {
    const { rerender } = render(<ProgressBar percent={10} testid="bar" />)
    expect(screen.getByTestId('bar').firstElementChild).not.toHaveClass('transition-[width]')
    rerender(<ProgressBar percent={10} testid="bar" smooth />)
    expect(screen.getByTestId('bar').firstElementChild).toHaveClass('transition-[width]')
  })
})
