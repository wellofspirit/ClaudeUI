/**
 * Layer 2: the roster list (ADR-073) — sections, the Running filter, and what a
 * row reports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentRosterList } from '../AgentRosterList'
import type { AgentRoster, AgentRosterRow } from '../../../hooks/useAgentRoster'

const ROUTE = 'route-roster-list'

function row(over: Partial<AgentRosterRow> & { toolUseId: string }): AgentRosterRow {
  return {
    kind: 'agent',
    name: 'agent',
    description: 'doing something',
    isRunning: false,
    isError: false,
    isStopped: false,
    isLoaded: false,
    runIndex: 1,
    ...over
  }
}

function roster(over: Partial<AgentRoster> = {}): AgentRoster {
  const agents = over.agents ?? []
  const shells = over.shells ?? []
  const all = [...agents, ...shells]
  return {
    agents,
    shells,
    runningCount: over.runningCount ?? all.filter((r) => r.isRunning).length,
    totalCount: over.totalCount ?? all.length
  }
}

async function renderList(r: AgentRoster, onOpen = vi.fn()): Promise<{ onOpen: typeof onOpen }> {
  await act(async () => {
    render(
      React.createElement(AgentRosterList, {
        roster: r,
        selectedIds: [],
        onOpen,
        emptyHint: 'none'
      })
    )
  })
  return { onOpen }
}

describe('AgentRosterList', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('counts running separately from the total', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a', name: 'reviewer', isRunning: true }),
          row({ toolUseId: 'b', name: 'explorer' })
        ]
      })
    )
    expect(screen.getByTestId('AgentRoster').textContent).toContain('1 running')
    expect(screen.getByTestId('AgentRoster').textContent).toContain('2 total')
  })

  it('splits agents from background shells when there are both', async () => {
    await renderList(
      roster({
        agents: [row({ toolUseId: 'a', name: 'reviewer' })],
        shells: [row({ toolUseId: 's', kind: 'shell', name: 'bun' })]
      })
    )
    expect(screen.getByTestId('AgentRoster.section.Agents')).toBeTruthy()
    expect(screen.getByTestId('AgentRoster.section.Background shells')).toBeTruthy()
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)
  })

  it('drops the headings when there is only one kind — the roster IS that list', async () => {
    await renderList(roster({ agents: [row({ toolUseId: 'a' })] }))
    expect(screen.queryByTestId('AgentRoster.section.Agents')).toBeNull()
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(1)
  })

  it('filters to running, and says so when nothing is', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a', name: 'done-one' }),
          row({ toolUseId: 'b', name: 'live-one', isRunning: true })
        ]
      })
    )
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('AgentRoster.filter.running'))
    const rows = screen.getAllByTestId('AgentRow')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-tool-use-id')).toBe('b')

    fireEvent.click(screen.getByTestId('AgentRoster.filter.all'))
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)
  })

  it('opens the row that was clicked', async () => {
    const { onOpen } = await renderList(roster({ agents: [row({ toolUseId: 'tu-9' })] }))
    fireEvent.click(screen.getByTestId('AgentRow'))
    expect(onOpen).toHaveBeenCalledWith('tu-9')
  })

  it('offers Stop only while running, and marks the status', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a', isRunning: true }),
          row({ toolUseId: 'b', isError: true }),
          row({ toolUseId: 'c' }),
          // Killed with its process — not "done": it never got to answer.
          row({ toolUseId: 'd', isStopped: true }),
          // Transcript ends mid-run; dead or running elsewhere, it claims neither.
          row({ toolUseId: 'e', isLoaded: true })
        ]
      })
    )
    expect(screen.getAllByTestId('AgentRow.stop')).toHaveLength(1)
    expect(
      screen.getAllByTestId('AgentRow.status').map((e) => e.getAttribute('data-status'))
    ).toEqual(['running', 'failed', 'done', 'stopped', 'loaded'])
  })

  it('shows the resume count only for an agent that was resumed', async () => {
    await renderList(
      roster({ agents: [row({ toolUseId: 'a', runIndex: 3 }), row({ toolUseId: 'b' })] })
    )
    const badges = screen.getAllByTestId('AgentRow.resumed')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toContain('×2')
  })
})
