/**
 * Layer 2: the roster list (ADR-073) — foldable sections, the Running filter
 * (the default), what a row reports, and (§7) the agent tree: indent, guides,
 * context ancestors under Running, and Stop only where there is a record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentRosterList } from '../AgentRosterList'
import type { AgentRoster, AgentRosterRow } from '../../../hooks/useAgentRoster'
import type { ActiveTask } from '../../../../../shared/types'

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
    depth: 0,
    runIndex: 1,
    ...over
  }
}

function roster(over: Partial<AgentRoster> = {}): AgentRoster {
  const agents = over.agents ?? []
  const shells = over.shells ?? []
  const runningAgentCount = agents.filter((r) => r.isRunning).length
  const runningShellCount = shells.filter((r) => r.isRunning).length
  return {
    agents,
    shells,
    runningCount: over.runningCount ?? runningAgentCount + runningShellCount,
    runningAgentCount,
    runningShellCount,
    totalCount: over.totalCount ?? agents.length
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

  describe('the agent tree (§7)', () => {
    const ids = (): (string | null)[] =>
      screen.getAllByTestId('AgentRow').map((r) => r.getAttribute('data-tool-use-id'))
    const context = (): (string | null)[] =>
      screen
        .getAllByTestId('AgentRow')
        .filter((r) => r.getAttribute('data-context') === 'true')
        .map((r) => r.getAttribute('data-tool-use-id'))

    it('keeps a finished parent of a running child under Running, as uncounted context', async () => {
      await renderList(
        roster({
          agents: [
            row({ toolUseId: 'lead' }),
            row({ toolUseId: 'impl', depth: 1, parentToolUseId: 'lead', isRunning: true }),
            row({ toolUseId: 'other' })
          ]
        })
      )
      expect(ids()).toEqual(['lead', 'impl'])
      expect(context()).toEqual(['lead'])
      // The heading counts the running row only.
      expect(
        screen.getByTestId('AgentRoster.section.Agents.toggle').textContent?.trim().endsWith('1')
      ).toBe(true)
      const [lead, impl] = screen.getAllByTestId('AgentRow')
      expect(lead.className).toContain('opacity-55')
      expect(impl.getAttribute('data-depth')).toBe('1')
      expect(impl.getAttribute('data-context')).toBeNull()
      expect(lead.querySelector('[data-testid="AgentRow.stop"]')).toBeNull()
    })

    it('keeps the whole ancestor chain of a depth-3 running row', async () => {
      const { onOpen } = await renderList(
        roster({
          agents: [
            row({ toolUseId: 'd0' }),
            row({ toolUseId: 'd1', depth: 1, parentToolUseId: 'd0' }),
            row({ toolUseId: 'd1-sibling', depth: 1, parentToolUseId: 'd0' }),
            row({ toolUseId: 'd2', depth: 2, parentToolUseId: 'd1' }),
            row({ toolUseId: 'd3', depth: 3, parentToolUseId: 'd2', isRunning: true })
          ]
        })
      )
      expect(ids()).toEqual(['d0', 'd1', 'd2', 'd3'])
      expect(context()).toEqual(['d0', 'd1', 'd2'])
      expect(screen.getByTestId('AgentRoster').textContent).toContain('1 running')

      fireEvent.click(screen.getAllByTestId('AgentRow')[0])
      expect(onOpen).toHaveBeenCalledWith('d0')
    })

    it('does not mark an open ancestor as context', async () => {
      await renderList(
        roster({
          agents: [
            row({ toolUseId: 'lead' }),
            row({ toolUseId: 'impl', depth: 1, parentToolUseId: 'lead', isRunning: true })
          ]
        }),
        vi.fn(),
        ['lead']
      )
      expect(context()).toEqual([])
    })

    it('shows every row under All, with no context rows', async () => {
      await renderList(
        roster({
          agents: [
            row({ toolUseId: 'lead' }),
            row({ toolUseId: 'impl', depth: 1, parentToolUseId: 'lead', isRunning: true })
          ]
        })
      )
      fireEvent.click(screen.getByTestId('AgentRoster.filter.all'))
      expect(ids()).toEqual(['lead', 'impl'])
      expect(context()).toEqual([])
    })

    it('indents 14px per level and draws an elbow for nested rows only', async () => {
      await renderList(
        roster({
          agents: [
            row({ toolUseId: 'a', isRunning: true }),
            row({ toolUseId: 'b', depth: 1, parentToolUseId: 'a', isRunning: true }),
            row({ toolUseId: 'c', depth: 2, parentToolUseId: 'b', isRunning: true })
          ]
        })
      )
      const [a, b, c] = screen.getAllByTestId('AgentRow')
      expect(a.style.paddingLeft).toBe('')
      expect(b.style.paddingLeft).toBe('24px')
      expect(c.style.paddingLeft).toBe('38px')
      expect(screen.getAllByTestId('AgentRow.elbow')).toHaveLength(2)
    })
  })

  describe('Stop on a nested row', () => {
    const setActiveTasks = (activeTasks: Record<string, ActiveTask>): void =>
      useSessionStore.setState((state) => ({
        sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], activeTasks } }
      }))
    const nested = (): AgentRoster =>
      roster({
        agents: [
          row({ toolUseId: 'lead', isRunning: true }),
          row({ toolUseId: 'child', depth: 1, parentToolUseId: 'lead', isRunning: true })
        ]
      })

    it('is not offered without a lifecycle record, which would interrupt the main turn', async () => {
      // Running by the legacy heuristic alone (no task_started for it).
      await renderList(nested())
      const stops = screen
        .getAllByTestId('AgentRow')
        .map((r) => !!r.querySelector('[data-testid="AgentRow.stop"]'))
      // A top-level row keeps its Stop as before; the nested one has none.
      expect(stops).toEqual([true, false])
    })

    it('is offered once the nested agent has a lifecycle record', async () => {
      setActiveTasks({ child: { taskId: 'a2', taskType: 'local_agent' } })
      await renderList(nested())
      expect(screen.getAllByTestId('AgentRow.stop')).toHaveLength(2)
    })
  })
})
