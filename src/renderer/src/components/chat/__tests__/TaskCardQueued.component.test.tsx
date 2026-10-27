/**
 * L2 — a dispatch call that has not started is not shown as running with a Stop that dies.
 *
 * cli.js runs a first-party MCP call such as `dispatch_agent` only when nothing else of its
 * assistant message is executing, so the second of two dispatches in one message — or one
 * behind a blocking call — shows no `task_started`, no result, no notification, exactly as a
 * running call would. The card says "queued" instead (no spinner, no clock); Stop stays and
 * is armed for when the call starts, and its "stopping" pill outlives the usual 10 s while
 * the call is still waiting. Claude Code only: the other engines announce a call when it
 * starts. The same components run in the desktop app and in the browser client.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))

import { TaskCard } from '../TaskCard'
import { MessageBubble } from '../MessageBubble'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-taskcard-queued'
const DISPATCH = 'mcp__claude-ui-collab__dispatch_agent'

const dispatchBlock = (toolUseId: string): ToolUseBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName: DISPATCH,
  toolInput: { engine: 'pi', prompt: 'do it', description: 'do it' }
})
const view = {
  kind: 'task' as const,
  description: 'do it',
  prompt: 'do it',
  dispatch: { engine: 'pi' as const }
}
const answer = (toolUseId: string, isError = false): ContentBlock => ({
  type: 'tool_result',
  toolUseId,
  toolResult: isError ? 'interrupted' : 'launched',
  isError
})
const assistant = (...content: ContentBlock[]): ChatMessage => ({
  id: 'asst-1',
  role: 'assistant',
  content,
  timestamp: 1
})

const setTurn = (state: 'running' | 'idle'): void =>
  useSessionStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [ROUTE]: { ...s.sessions[ROUTE], status: { ...s.sessions[ROUTE].status, state } }
    }
  }))

const setEngine = (engineId: 'claude' | 'pi'): void =>
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [ROUTE]: {
        ...state.sessions[ROUTE],
        status: { ...state.sessions[ROUTE].status, engineId }
      }
    }
  }))

describe('TaskCard — a dispatch call that has not started (L2)', () => {
  let app: TestApp
  let stopCalls: Array<{ toolUseId: string; isDispatch: unknown }>

  beforeEach(async () => {
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
    useSessionStore.setState({ activeSessionId: ROUTE })
    setEngine('claude')
    setTurn('running')
  })

  afterEach(() => {
    vi.useRealTimers()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('a queued call says queued: no spinner, no elapsed clock, but a Stop', () => {
    const { container } = render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'queued')
    expect(screen.getByTestId('TaskCard.queued')).toHaveTextContent('queued')
    expect(screen.getByTestId('TaskCard.queued.icon')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin-slow')).toBeNull()
    expect(screen.queryByTestId('TaskCard.elapsed')).not.toBeInTheDocument()
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByTestId('TaskCard.queuedNote')).toBeInTheDocument()
  })

  it('the same call, not queued, is running with its spinner, as before', () => {
    const { container } = render(<TaskCard block={dispatchBlock('toolu_a')} view={view} />)
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'running')
    expect(screen.queryByTestId('TaskCard.queued')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-spin-slow')).not.toBeNull()
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
  })

  it('a call that has started (task_started) is running even when its block order says queued', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'toolu_b',
      taskId: 'x-agent-b',
      taskType: 'dispatch'
    })
    render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'running')
    expect(screen.queryByTestId('TaskCard.queued')).not.toBeInTheDocument()
  })

  it('Stop on a queued call is a dispatch stop (armed in the dispatcher) and shows the pill', async () => {
    render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    expect(stopCalls).toEqual([{ toolUseId: 'toolu_b', isDispatch: true }])
    expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).toEqual(['toolu_b'])
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
    expect(screen.getByText('stopping...')).toBeInTheDocument()
  })

  /** The store holds the message the cards were drawn from: the pill's fallback reads it. */
  const setMessages = (...messages: ChatMessage[]): void =>
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, [ROUTE]: { ...s.sessions[ROUTE], messages } }
    }))
  const pill = (): string[] => useSessionStore.getState().sessions[ROUTE].stoppingTaskIds

  it('the stopping pill outlives the 10 s fallback while the call is still queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setMessages(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
    render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(pill()).toEqual(['toolu_b'])
    expect(screen.getByText('stopping...')).toBeInTheDocument()
  })

  it('a running (not queued) call keeps the 10 s fallback for its pill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setMessages(assistant(dispatchBlock('toolu_a')))
    render(<TaskCard block={dispatchBlock('toolu_a')} view={view} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    act(() => {
      vi.advanceTimersByTime(9_000)
    })
    expect(pill()).toEqual(['toolu_a'])
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(pill()).toEqual([])
  })

  it('the pill goes when the queued call never starts (its turn ended and cli.js answered it)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setMessages(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
    render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('stopping...')).toBeInTheDocument()
    // The turn ended: both calls were answered with an error, so it is no longer waiting.
    act(() => {
      setMessages(
        assistant(
          dispatchBlock('toolu_a'),
          dispatchBlock('toolu_b'),
          answer('toolu_a', true),
          answer('toolu_b', true)
        )
      )
      vi.advanceTimersByTime(1_000)
    })
    expect(pill()).toEqual([])
  })

  it('a card that unmounts while queued loses nothing: the pill is held by the store and counts from the start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setMessages(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
    const first = render(<TaskCard block={dispatchBlock('toolu_b')} view={view} queued />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    first.unmount() // scrolled away (the chat list is virtualised)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(pill()).toEqual(['toolu_b'])
    // The blocking call ended and this one started: the usual 10 s, from the start.
    act(() => {
      setMessages(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b'), answer('toolu_a')))
      vi.advanceTimersByTime(5_000)
    })
    expect(pill()).toEqual(['toolu_b'])
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(pill()).toEqual([])
  })

  describe('in a message (MessageBubble)', () => {
    const states = (): string[] =>
      screen.getAllByTestId('TaskCard').map((el) => el.getAttribute('data-status') ?? '')
    const bubble = (message: ChatMessage): ReturnType<typeof render> =>
      render(<MessageBubble message={message} pendingApprovals={[]} isLastAssistant />)

    it('the second dispatch of one message queues behind the first', () => {
      bubble(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
      expect(states()).toEqual(['running', 'queued'])
    })

    it('...and starts when the first has answered', () => {
      bubble(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b'), answer('toolu_a')))
      // (a's own card reads settled: a blocking call that answered; b is no longer waiting.)
      expect(states()).toEqual(['completed', 'running'])
    })

    it('a dispatch behind any other unanswered call (a Read) is queued too', () => {
      const read: ContentBlock = {
        type: 'tool_use',
        toolUseId: 'toolu_r',
        toolName: 'Read',
        toolInput: { file_path: '/x' }
      }
      bubble(assistant(read, dispatchBlock('toolu_b')))
      expect(states()).toEqual(['queued'])
    })

    it('a lone dispatch is running', () => {
      bubble(assistant(dispatchBlock('toolu_a')))
      expect(states()).toEqual(['running'])
    })

    it('with the parent’s turn over the same message reads running, never queued (a stale queue)', () => {
      setTurn('idle')
      bubble(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
      expect(states()).toEqual(['running', 'running'])
    })

    it('other engines are not second-guessed: the same message reads running, running', () => {
      setEngine('pi')
      bubble(assistant(dispatchBlock('toolu_a'), dispatchBlock('toolu_b')))
      expect(states()).toEqual(['running', 'running'])
    })
  })
})
