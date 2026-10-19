/**
 * Layer 2: the resumed badge is one compact `↻N` chip, the same on the roster
 * row and the Task card's footer (each with its own test id).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ResumedBadge } from '../ResumedBadge'
import { AgentRow } from '../AgentRow'
import type { AgentRosterRow } from '../../../hooks/useAgentRoster'

afterEach(cleanup)

describe('ResumedBadge', () => {
  it('counts the resumes, not the runs, and names them for a screen reader', () => {
    render(<ResumedBadge runIndex={2} testId="badge" />)
    const badge = screen.getByTestId('badge')
    expect(badge.textContent).toBe('↻1')
    expect(badge.getAttribute('aria-label')).toBe('Resumed 1 time')
    expect(badge.title).toBe('This agent was sent a message after it finished, and ran again')
    cleanup()
    render(<ResumedBadge runIndex={4} testId="badge" />)
    expect(screen.getByTestId('badge').textContent).toBe('↻3')
    expect(screen.getByTestId('badge').getAttribute('aria-label')).toBe('Resumed 3 times')
  })

  it('draws nothing for an agent that never resumed', () => {
    const { container } = render(<ResumedBadge runIndex={1} testId="badge" />)
    expect(container.innerHTML).toBe('')
  })

  it('is the roster row’s badge too', () => {
    const row: AgentRosterRow = {
      toolUseId: 'a',
      kind: 'agent',
      name: 'x',
      hasExplicitName: true,
      description: 'd',
      isRunning: false,
      isError: false,
      isStopped: false,
      isLoaded: false,
      depth: 0,
      runIndex: 3
    }
    render(React.createElement(AgentRow, { row, selected: false, onOpen: vi.fn() }))
    expect(screen.getByTestId('AgentRow.resumed').textContent).toBe('↻2')
    expect(screen.getByTestId('AgentRow.resumed').getAttribute('aria-label')).toBe(
      'Resumed 2 times'
    )
  })
})
