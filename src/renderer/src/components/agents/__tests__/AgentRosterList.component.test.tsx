/**
 * Layer 2: the roster list (ADR-073) — foldable sections, the Running filter
 * (the default), and what a row reports.
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

async function renderList(
  r: AgentRoster,
  onOpen = vi.fn(),
  selectedIds: string[] = []
): Promise<{ onOpen: typeof onOpen }> {
  await act(async () => {
    render(
      React.createElement(AgentRosterList, {
        roster: r,
        selectedIds,
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

  it('opens on Running, and All shows the finished rows too', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a', name: 'done-one' }),
          row({ toolUseId: 'b', name: 'live-one', isRunning: true })
        ]
      })
    )
    expect(screen.getByTestId('AgentRoster.filter.running').getAttribute('aria-pressed')).toBe(
      'true'
    )
    const rows = screen.getAllByTestId('AgentRow')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-tool-use-id')).toBe('b')

    fireEvent.click(screen.getByTestId('AgentRoster.filter.all'))
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('AgentRoster.filter.running'))
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(1)
  })

  it('offers the whole list when nothing is running', async () => {
    await renderList(roster({ agents: [row({ toolUseId: 'a' }), row({ toolUseId: 'b' })] }))
    expect(screen.queryAllByTestId('AgentRow')).toHaveLength(0)
    expect(screen.getByTestId('AgentRoster.empty').textContent).toContain('Nothing running')

    fireEvent.click(screen.getByTestId('AgentRoster.empty.showAll'))
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)
  })

  it('has no Show all link in a session with nothing in it', async () => {
    await renderList(roster())
    expect(screen.getByTestId('AgentRoster.empty')).toBeTruthy()
    expect(screen.queryByTestId('AgentRoster.empty.showAll')).toBeNull()
  })

  it('keeps an open row under Running after it finishes, so it can be put away', async () => {
    await renderList(
      roster({ agents: [row({ toolUseId: 'open-done' }), row({ toolUseId: 'closed-done' })] }),
      vi.fn(),
      ['open-done']
    )
    const rows = screen.getAllByTestId('AgentRow')
    expect(rows.map((r) => r.getAttribute('data-tool-use-id'))).toEqual(['open-done'])
  })

  it('splits agents from background shells', async () => {
    await renderList(
      roster({
        agents: [row({ toolUseId: 'a', name: 'reviewer', isRunning: true })],
        shells: [row({ toolUseId: 's', kind: 'shell', name: 'bun', isRunning: true })]
      })
    )
    expect(screen.getByTestId('AgentRoster.section.Agents').textContent).toContain('1')
    expect(screen.getByTestId('AgentRoster.section.Background shells')).toBeTruthy()
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(2)
  })

  it('heads even a lone section, since the heading is what folds it', async () => {
    await renderList(roster({ agents: [row({ toolUseId: 'a', isRunning: true })] }))
    expect(screen.getByTestId('AgentRoster.section.Agents')).toBeTruthy()
    expect(screen.queryByTestId('AgentRoster.section.Background shells')).toBeNull()
  })

  it('folds one section without touching the other', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a1', isRunning: true }),
          row({ toolUseId: 'a2', isRunning: true })
        ],
        shells: [row({ toolUseId: 's', kind: 'shell', isRunning: true })]
      })
    )
    const toggle = screen.getByTestId('AgentRoster.section.Agents.toggle')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The count stays on the folded heading — that is what it is folded down to.
    expect(screen.getByTestId('AgentRoster.section.Agents').textContent).toContain('2')
    expect(
      screen.getAllByTestId('AgentRow').map((r) => r.getAttribute('data-tool-use-id'))
    ).toEqual(['s'])

    fireEvent.click(toggle)
    expect(screen.getAllByTestId('AgentRow')).toHaveLength(3)
  })

  it('scrolls a row into view when it becomes selected, not when it mounts selected', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const rows = roster({
      agents: [row({ toolUseId: 'a', isRunning: true }), row({ toolUseId: 'b', isRunning: true })]
    })
    const props = { roster: rows, onOpen: vi.fn(), emptyHint: 'none' }
    let rerender!: ReturnType<typeof render>['rerender']
    await act(async () => {
      ;({ rerender } = render(
        React.createElement(AgentRosterList, { ...props, selectedIds: ['a'] })
      ))
    })
    expect(scrollIntoView).not.toHaveBeenCalled()

    await act(async () => {
      rerender(React.createElement(AgentRosterList, { ...props, selectedIds: ['a', 'b'] }))
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('opens the row that was clicked', async () => {
    const { onOpen } = await renderList(
      roster({ agents: [row({ toolUseId: 'tu-9', isRunning: true })] })
    )
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
    fireEvent.click(screen.getByTestId('AgentRoster.filter.all'))
    expect(screen.getAllByTestId('AgentRow.stop')).toHaveLength(1)
    expect(
      screen.getAllByTestId('AgentRow.status').map((e) => e.getAttribute('data-status'))
    ).toEqual(['running', 'failed', 'done', 'stopped', 'loaded'])
  })

  it('shows the resume count only for an agent that was resumed', async () => {
    await renderList(
      roster({ agents: [row({ toolUseId: 'a', runIndex: 3 }), row({ toolUseId: 'b' })] })
    )
    fireEvent.click(screen.getByTestId('AgentRoster.filter.all'))
    const badges = screen.getAllByTestId('AgentRow.resumed')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toContain('×2')
  })
})
