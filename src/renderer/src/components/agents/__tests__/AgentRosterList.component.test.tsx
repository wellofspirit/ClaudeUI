/**
 * Layer 2: the roster list (ADR-073) — one tree with no sections (§10), the
 * Running filter (the default), what a row reports, and (§7) the agent tree:
 * indent, guides, context ancestors under Running (a running shell under a
 * finished agent keeps that agent), and Stop only where there is a record.
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
    hasExplicitName: true,
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
    // Callers that care about nesting pass `rows`; otherwise agents then shells.
    rows: over.rows ?? [...agents, ...shells],
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
  const setActiveTasks = (activeTasks: Record<string, ActiveTask>): void =>
    useSessionStore.setState((state) => ({
      sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], activeTasks } }
    }))

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
    // The summary's own words (roster-summary), without "in this session".
    expect(screen.getByTestId('AgentRoster.summary').textContent).toBe('1 agent running · 2 agents')
  })

  it('counts running shells in the header, in the same words as the tooltip', async () => {
    await renderList(
      roster({
        agents: [row({ toolUseId: 'a', isRunning: true }), row({ toolUseId: 'b' })],
        shells: [
          row({ toolUseId: 's1', kind: 'shell', isRunning: true }),
          row({ toolUseId: 's2', kind: 'shell', isRunning: true })
        ]
      })
    )
    expect(screen.getByTestId('AgentRoster.summary').textContent).toBe(
      '1 agent, 2 shells running · 2 agents'
    )
    // The running part is the accented one.
    expect(
      screen.getByTestId('AgentRoster.summary').querySelector('.text-accent')?.textContent
    ).toBe('1 agent, 2 shells running')
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

  it('lists agents and shells in one tree, with no section headings', async () => {
    await renderList(
      roster({
        agents: [row({ toolUseId: 'a', name: 'reviewer', isRunning: true })],
        shells: [row({ toolUseId: 's', kind: 'shell', name: 'bun', isRunning: true })]
      })
    )
    expect(screen.queryByTestId(/^AgentRoster\.section/)).toBeNull()
    expect(screen.queryByText('Agents')).toBeNull()
    expect(screen.queryByText('Background shells')).toBeNull()
    const rows = screen.getAllByTestId('AgentRow')
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['agent', 'shell'])
  })

  it('renders the rows in the roster order, nested shells included', async () => {
    await renderList(
      roster({
        agents: [
          row({ toolUseId: 'a', isRunning: true }),
          row({ toolUseId: 'b', isRunning: true })
        ],
        rows: [
          row({ toolUseId: 'a', isRunning: true }),
          row({
            toolUseId: 's',
            kind: 'shell',
            depth: 1,
            parentToolUseId: 'a',
            isRunning: true
          }),
          row({ toolUseId: 'b', isRunning: true })
        ]
      })
    )
    expect(
      screen.getAllByTestId('AgentRow').map((r) => r.getAttribute('data-tool-use-id'))
    ).toEqual(['a', 's', 'b'])
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
    // Always the short form, at every width (§10); the title carries the sentence.
    expect(badges[0].textContent).toBe('↻2')
    expect(badges[0].title).toContain('ran again')
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
      // The header counts the running row only: the context row is not counted.
      expect(screen.getByTestId('AgentRoster.summary').textContent).toBe(
        '1 agent running · 3 agents'
      )
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
      expect(screen.getByTestId('AgentRoster.summary').textContent).toBe(
        '1 agent running · 5 agents'
      )

      fireEvent.click(screen.getAllByTestId('AgentRow')[0])
      expect(onOpen).toHaveBeenCalledWith('d0')
    })

    it('keeps a finished agent as context for the running shell it launched', async () => {
      // The shell outlived its agent: the agent is not running, the shell is, and
      // a running shell always has its lifecycle record.
      setActiveTasks({ sh: { taskId: 'b1', taskType: 'local_bash', isBackgrounded: true } })
      await renderList(
        roster({
          agents: [row({ toolUseId: 'lead', name: 'lead' }), row({ toolUseId: 'other' })],
          shells: [row({ toolUseId: 'sh', kind: 'shell', isRunning: true })],
          rows: [
            row({ toolUseId: 'lead', name: 'lead' }),
            row({
              toolUseId: 'sh',
              kind: 'shell',
              depth: 1,
              parentToolUseId: 'lead',
              isRunning: true
            }),
            row({ toolUseId: 'other' })
          ]
        })
      )
      expect(ids()).toEqual(['lead', 'sh'])
      expect(context()).toEqual(['lead'])
      const [lead, sh] = screen.getAllByTestId('AgentRow')
      expect(lead.className).toContain('opacity-55')
      expect(lead.querySelector('[data-testid="AgentRow.stop"]')).toBeNull()
      expect(sh.getAttribute('data-kind')).toBe('shell')
      expect(sh.getAttribute('data-depth')).toBe('1')
      expect(sh.getAttribute('data-context')).toBeNull()
      // Stop is on the shell, not on the dimmed context row above it.
      expect(sh.querySelector('[data-testid="AgentRow.stop"]')).not.toBeNull()
      expect(screen.getAllByTestId('AgentRow.stop')).toHaveLength(1)
      expect(screen.getByTestId('AgentRoster.summary').textContent).toBe(
        '1 shell running · 2 agents'
      )
    })

    it('offers a nested shell no Stop without a lifecycle record', async () => {
      await renderList(
        roster({
          agents: [row({ toolUseId: 'lead' })],
          shells: [row({ toolUseId: 'sh', kind: 'shell', isRunning: true })],
          rows: [
            row({ toolUseId: 'lead' }),
            row({
              toolUseId: 'sh',
              kind: 'shell',
              depth: 1,
              parentToolUseId: 'lead',
              isRunning: true
            })
          ]
        })
      )
      const sh = screen.getAllByTestId('AgentRow')[1]
      expect(sh.querySelector('[data-testid="AgentRow.stop"]')).toBeNull()
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
