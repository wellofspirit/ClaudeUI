import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BlockUsageData } from '../../../../../shared/types'
import { DailyUsageChart } from '../DailyUsageChart'

function makeHistory(days: number): BlockUsageData['dailyHistory'] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1))
    return {
      date: date.toISOString().slice(0, 10),
      totalTokens: 1_000 + index,
      costUsd: 1,
      models: { 'claude-opus-4-8': 1_000 + index },
      peakApiPercent: 10,
      blockCount: 1
    }
  })
}

describe('DailyUsageChart', () => {
  it('expands the SVG so long histories keep the latest bar inside the plot', () => {
    render(<DailyUsageChart dailyHistory={makeHistory(122)} />)

    const svg = screen.getByTestId('DailyUsageChart.svg')
    const viewBoxWidth = Number(svg.getAttribute('viewBox')?.split(' ')[2])
    const hitAreas = svg.querySelectorAll('rect[fill="transparent"]')
    const lastBar = hitAreas.item(hitAreas.length - 1)
    const lastBarRight = Number(lastBar.getAttribute('x')) + Number(lastBar.getAttribute('width'))
    const axis = screen.getByTestId('DailyUsageChart.axis')
    const scroll = screen.getByTestId('DailyUsageChart.scroll')

    expect(hitAreas).toHaveLength(122)
    expect(viewBoxWidth).toBeGreaterThan(600)
    expect(lastBarRight).toBeLessThan(viewBoxWidth)
    expect(parseFloat(svg.style.width)).toBeCloseTo((123 * 600) / 30)
    expect(scroll.contains(axis)).toBe(false)
    expect(screen.getByText('May 2')).toBeInTheDocument()
    expect(screen.queryByText('Apr 30')).not.toBeInTheDocument()
  })

  it('renders missing calendar dates as zero-usage slots', () => {
    const history = makeHistory(3).filter((_, index) => index !== 1)
    render(<DailyUsageChart dailyHistory={history} />)

    const hitAreas = screen
      .getByTestId('DailyUsageChart.svg')
      .querySelectorAll('rect[fill="transparent"]')
    expect(hitAreas).toHaveLength(3)

    fireEvent.mouseEnter(hitAreas.item(1).parentElement!)
    expect(screen.getByText('Jan 2')).toBeInTheDocument()
  })
})
