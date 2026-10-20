/**
 * L2 — the task panel and the agent roster say "queued" for a dispatch call that has not
 * started, as the card does, and their Stop on it is a DISPATCH stop (the third `stopTask`
 * argument): the dispatcher arms it for when the call starts. Without the flag Claude's
 * `stopTask` finds no task for the call and interrupts the whole parent turn, which includes
 * the blocking dispatch the queued one is waiting behind. The same components run in the
 * browser client, whose `stopTask` is the same `session:stop-task` channel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica, seed } from '@test/helpers/replica-seed'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { useAgentRoster } from '../../../hooks/useAgentRoster'
import { AgentRosterList } from '../AgentRosterList'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../../chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
import { TaskEntry } from '../../TaskDetailPanel/TaskEntry'
import { MessageBubble } from '../../chat/MessageBubble'

const ROUTE = 'route-queued-surfaces'
const DISPATCH = 'mcp__claude-ui-collab__dispatch_agent'

const dispatchUse = (toolUseId: string, description: string): ContentBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName: DISPATCH,
  toolInput: { engine: 'pi', prompt: 'do it', description }
})
const agentUse = (toolUseId: string): ContentBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName: 'Agent',
  toolInput: { description: 'native one', subagent_type: 'Explore', prompt: 'look' }
})
const assistant = (...content: ContentBlock[]): ChatMessage => ({
  id: 'asst-1',
  role: 'assistant',
  content,
  timestamp: 1
})

describe('a queued dispatch call in the task panel and the agent roster (L2, C1)', () => {
  let app: TestApp
  let stopCalls: Array<{ toolUseId: string; isDispatch: unknown }>

  const setSession = (messages: ChatMessage[], state: 'running' | 'idle' = 'running'): void => {
    useSessionStore.setState((s) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...s.sessions,
        [ROUTE]: {
          ...s.sessions[ROUTE],
          messages,
          status: { ...s.sessions[ROUTE].status, engineId: 'claude', state }
        }
      }
    }))
    mirrorStoreIntoReplica()
  }

  beforeEach(async () => {
    resetAgentTypeCatalog()
    app = await bootTestApp()
    stopCalls = []
    app.bridge.ipcMain.handle(
      'session:stop-task',
      async (_e, _routingId: string, toolUseId: string, isDispatch?: unknown) => {
        stopCalls.push({ toolUseId, isDispatch })
        return { success: true }
      }
    )
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  describe('TaskEntry', () => {
    it('the second dispatch of a message reads queued, keeps Stop, and stops as a dispatch', async () => {
      setSession([assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))])
      render(<TaskEntry toolUseId="toolu_b" />)
      expect(screen.getByTestId('TaskEntry.queued')).toHaveTextContent('queued')
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskEntry.stop'))
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_b', isDispatch: true }])
    })

    it('the first dispatch is running, as before', () => {
      setSession([assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))])
      render(<TaskEntry toolUseId="toolu_a" />)
      expect(screen.queryByTestId('TaskEntry.queued')).not.toBeInTheDocument()
      expect(screen.getByText('running')).toBeInTheDocument()
    })

    it('with the parent’s turn over the same call is not queued (a stale queue never settles)', () => {
      setSession(
        [assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))],
        'idle'
      )
      render(<TaskEntry toolUseId="toolu_b" />)
      expect(screen.queryByTestId('TaskEntry.queued')).not.toBeInTheDocument()
    })

    it('a native agent’s Stop is still a plain stop (no dispatch flag)', async () => {
      setSession([assistant(agentUse('toolu_n'))])
      render(<TaskEntry toolUseId="toolu_n" />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskEntry.stop'))
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_n', isDispatch: false }])
    })
  })

  describe('the roster', () => {
    const roster = (): ReturnType<typeof useAgentRoster> =>
      renderHook(() => useAgentRoster()).result.current

    it('a queued dispatch row is queued, not running, and is not counted as running', () => {
      setSession([assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))])
      const r = roster()
      const byId = Object.fromEntries(r.agents.map((a) => [a.toolUseId, a]))
      expect(byId.toolu_a).toMatchObject({ isRunning: true })
      expect(byId.toolu_a.isQueued).toBeUndefined()
      expect(byId.toolu_b).toMatchObject({ isRunning: false, isQueued: true })
      expect(r.runningAgentCount).toBe(1)
    })

    it('with the turn over, the same row is not queued', () => {
      setSession(
        [assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))],
        'idle'
      )
      const r = roster()
      expect(r.agents.every((a) => !a.isQueued)).toBe(true)
    })

    it('the row shows queued, keeps Stop under the Running filter, and stops as a dispatch', async () => {
      setSession([assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'))])
      const r = roster()
      await act(async () => {
        render(
          React.createElement(AgentRosterList, {
            roster: r,
            onOpen: vi.fn(),
            selectedIds: [],
            emptyHint: 'none'
          })
        )
      })
      const queuedRow = screen
        .getAllByTestId('AgentRow')
        .find((el) => el.getAttribute('data-tool-use-id') === 'toolu_b')!
      expect(queuedRow.querySelector('[data-testid="AgentRow.queued"]')).not.toBeNull()
      expect(queuedRow.getAttribute('data-running')).toBe('false')
      await act(async () => {
        fireEvent.click(queuedRow.querySelector('[data-testid="AgentRow.stop"]')!)
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_b', isDispatch: true }])
    })

    it('a native agent row’s Stop is a plain stop', async () => {
      setSession([assistant(agentUse('toolu_n'))])
      const r = roster()
      await act(async () => {
        render(
          React.createElement(AgentRosterList, {
            roster: r,
            onOpen: vi.fn(),
            selectedIds: [],
            emptyHint: 'none'
          })
        )
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('AgentRow.stop'))
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_n', isDispatch: false }])
    })
  })

  describe('one stopping state for every surface', () => {
    const pair = (...extra: ContentBlock[]): ChatMessage[] => [
      assistant(dispatchUse('toolu_a', 'first'), dispatchUse('toolu_b', 'second'), ...extra)
    ]
    const result = (toolUseId: string): ContentBlock => ({
      type: 'tool_result',
      toolUseId,
      toolResult: 'launched',
      isError: false
    })
    const pill = (): string[] => useSessionStore.getState().sessions[ROUTE].stoppingTaskIds
    const setMessages = (messages: ChatMessage[]): void =>
      useSessionStore.setState((s) => ({
        sessions: { ...s.sessions, [ROUTE]: { ...s.sessions[ROUTE], messages } }
      }))

    afterEach(() => {
      vi.useRealTimers()
    })

    it('a Stop from the roster shows "stopping" on the card and the panel and hides their Stop, and it holds while queued', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      setSession(pair())
      const r = renderHook(() => useAgentRoster()).result.current
      render(<TaskEntry toolUseId="toolu_b" />)
      render(<MessageBubble message={pair()[0]} pendingApprovals={[]} isLastAssistant />)
      await act(async () => {
        render(
          React.createElement(AgentRosterList, {
            roster: r,
            onOpen: vi.fn(),
            selectedIds: [],
            emptyHint: 'none'
          })
        )
      })
      const rowStop = (): HTMLElement | null =>
        screen
          .getAllByTestId('AgentRow')
          .find((el) => el.getAttribute('data-tool-use-id') === 'toolu_b')!
          .querySelector('[data-testid="AgentRow.stop"]')
      await act(async () => {
        fireEvent.click(rowStop()!)
      })
      const cardB = screen.getAllByTestId('TaskCard')[1]
      expect(pill()).toEqual(['toolu_b'])
      expect(screen.queryByTestId('TaskEntry.stop')).not.toBeInTheDocument()
      expect(screen.getByTestId('TaskEntry')).toHaveTextContent('stopping...')
      expect(cardB.querySelector('[data-testid="TaskCard.stop"]')).toBeNull()
      expect(cardB).toHaveTextContent('stopping...')
      // 60 s later the call is still queued: the pill (and so everyone's Stop) is still held
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(pill()).toEqual(['toolu_b'])
      expect(screen.getByTestId('TaskEntry')).toHaveTextContent('stopping...')
    })

    it('a Stop from the panel is seen by the card and the roster row too', async () => {
      setSession(pair())
      const r = renderHook(() => useAgentRoster()).result.current
      render(<MessageBubble message={pair()[0]} pendingApprovals={[]} isLastAssistant />)
      render(<TaskEntry toolUseId="toolu_b" />)
      await act(async () => {
        render(
          React.createElement(AgentRosterList, {
            roster: r,
            onOpen: vi.fn(),
            selectedIds: [],
            emptyHint: 'none'
          })
        )
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskEntry.stop'))
      })
      expect(screen.getAllByTestId('TaskCard')[1]).toHaveTextContent('stopping...')
      const row = screen
        .getAllByTestId('AgentRow')
        .find((el) => el.getAttribute('data-tool-use-id') === 'toolu_b')!
      expect(row).toHaveTextContent('Stopping')
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_b', isDispatch: true }])
    })

    it('once the call has started the usual 10 s count begins, for every surface alike', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      setSession(pair())
      render(<TaskEntry toolUseId="toolu_b" />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskEntry.stop'))
      })
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(pill()).toEqual(['toolu_b'])
      act(() => {
        setMessages(pair(result('toolu_a')))
        vi.advanceTimersByTime(5_000)
      })
      expect(pill()).toEqual(['toolu_b'])
      act(() => {
        vi.advanceTimersByTime(6_000)
      })
      expect(pill()).toEqual([])
    })
  })

  describe('a queued dispatch inside a subagent (nested roster row)', () => {
    it('keeps its Stop, which arms the dispatch stop', async () => {
      const parent = assistant(agentUse('toolu_p'))
      setSession([parent])
      // the subagent's own transcript: two dispatches in one message, the second queued
      useSessionStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [ROUTE]: {
            ...s.sessions[ROUTE],
            subagentMessages: {
              toolu_p: [
                assistant(dispatchUse('toolu_x', 'inner one'), dispatchUse('toolu_y', 'inner two'))
              ]
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
      seed.taskStarted(ROUTE, { toolUseId: 'toolu_p', taskId: 'task-p', taskType: 'local_agent' })
      const r = renderHook(() => useAgentRoster()).result.current
      const queuedRow = r.rows.find((row) => row.toolUseId === 'toolu_y')
      expect(queuedRow).toMatchObject({ depth: 1, isQueued: true })
      await act(async () => {
        render(
          React.createElement(AgentRosterList, {
            roster: r,
            onOpen: vi.fn(),
            selectedIds: [],
            emptyHint: 'none'
          })
        )
      })
      const row = screen
        .getAllByTestId('AgentRow')
        .find((el) => el.getAttribute('data-tool-use-id') === 'toolu_y')!
      await act(async () => {
        fireEvent.click(row.querySelector('[data-testid="AgentRow.stop"]')!)
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_y', isDispatch: true }])
    })
  })
})
