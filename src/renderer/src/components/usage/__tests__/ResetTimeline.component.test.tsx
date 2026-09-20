/**
 * `ResetTimeline` — every limit window on one seven-day axis (ADR-071 §8,
 * mockup Accounts D).
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResetTimeline } from '../ResetTimeline'
import { buildProviderColorMap } from '../usage-utils'
import { makeLimits, makeWindow } from './dashboard-fixtures'

const COLORS = buildProviderColorMap(['anthropic', 'openai'])
const NOW = Date.parse('2026-09-21T12:00:00.000Z')

function inDays(d: number): string {
  return new Date(NOW + d * 86_400_000).toISOString()
}

describe('ResetTimeline', () => {
  it('places one marker per window of every account, soonest first', () => {
    const limits = [
      makeLimits({
        accountKey: 'anthropic:org:acct',
        label: 'Claude · personal',
        windows: [
          makeWindow({ kind: '5h', label: '5-hour', usedPercent: 62, resetsAt: inDays(0.1) }),
          makeWindow({ kind: '7d', label: '7-day', usedPercent: 41, resetsAt: inDays(3) })
        ]
      }),
      makeLimits({
        accountKey: 'chatgpt:w:u',
        label: 'ChatGPT · personal',
        vendorId: 'openai',
        windows: [makeWindow({ kind: '7d', label: '7-day', usedPercent: 54, resetsAt: inDays(1) })]
      })
    ]

    render(<ResetTimeline limits={limits} providerColors={COLORS} now={NOW} />)

    const markers = screen.getAllByTestId('ResetTimeline.marker')
    expect(markers).toHaveLength(3)
    expect(
      markers.map((m) => `${m.getAttribute('data-account-key')}:${m.getAttribute('data-kind')}`)
    ).toEqual(['anthropic:org:acct:5h', 'chatgpt:w:u:7d', 'anthropic:org:acct:7d'])
    expect(screen.getByTestId('ResetTimeline.now')).toBeInTheDocument()
    expect(screen.queryByTestId('ResetTimeline.empty')).not.toBeInTheDocument()
  })

  it('positions a marker by how far out its reset is', () => {
    const limits = [makeLimits({ windows: [makeWindow({ kind: '7d', resetsAt: inDays(3.5) })] })]
    render(<ResetTimeline limits={limits} providerColors={COLORS} now={NOW} />)
    // 3.5 of 7 days along the axis.
    expect(screen.getByTestId('ResetTimeline.marker').style.left).toBe('50%')
  })

  it('names the account, the window, the percent and the reset on hover', () => {
    const limits = [
      makeLimits({
        label: 'Claude · work',
        windows: [makeWindow({ kind: '7d', label: '7-day', usedPercent: 77, resetsAt: inDays(2) })]
      })
    ]
    render(<ResetTimeline limits={limits} providerColors={COLORS} now={NOW} />)
    const title = screen.getByTestId('ResetTimeline.marker').getAttribute('title') ?? ''
    expect(title).toContain('Claude · work')
    expect(title).toContain('7-day')
    expect(title).toContain('77%')
    // A weekly window names the weekday; the countdown stays in the tooltip.
    expect(title).toMatch(/resets \w{3} \d{2}:\d{2} \(in /)
  })

  it('draws no marker for a window whose reset the vendor did not report', () => {
    const limits = [makeLimits({ windows: [makeWindow({ resetsAt: null })] })]
    render(<ResetTimeline limits={limits} providerColors={COLORS} now={NOW} />)
    expect(screen.queryByTestId('ResetTimeline.marker')).not.toBeInTheDocument()
    expect(screen.getByTestId('ResetTimeline')).toHaveTextContent('reset time not reported')
  })

  it('shows the empty state when no account reports a window', () => {
    render(
      <ResetTimeline limits={[makeLimits({ windows: [] })]} providerColors={COLORS} now={NOW} />
    )
    expect(screen.getByTestId('ResetTimeline.empty')).toHaveTextContent(
      'No account on this machine reports a rate window'
    )
  })

  it('distinguishes "still reading" from "no windows"', () => {
    render(<ResetTimeline limits={null} providerColors={COLORS} now={NOW} />)
    expect(screen.getByTestId('ResetTimeline.empty')).toHaveTextContent('Reading limits…')
  })
})
