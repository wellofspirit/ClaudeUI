/**
 * L2 — Stop on a running task follows the engine. A NATIVE task (opencode's `subagent`, Codex's
 * `spawn_agent`) is stopped through the session (`session:stop-task` -> the session's own
 * `stopTask`), which only engines with `capabilities.backgroundTasks` implement: on the others
 * the click could only ever fail with "Provider does not support background tasks". A DISPATCH
 * (X-Agent) is stopped through the dispatcher whatever the engine, so it keeps Stop.
 *
 * The three surfaces that offer it: the chat TaskCard, the task panel's TaskEntry and the agent
 * roster's AgentRow. The same components run in the browser client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { useAgentRoster } from '../../../hooks/useAgentRoster'
import { AgentRosterList } from '../AgentRosterList'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../../chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
import { TaskEntry } from '../../TaskDetailPanel/TaskEntry'
import { MessageBubble } from '../../chat/MessageBubble'

const ROUTE = 'route-stop-capability'

// opencode's own tools, as its session reports them: the native `subagent` (`task` on 1.x; both map
// to the task card) and the bridge's dispatch. opencode 2.x advertises `backgroundTasks` (per-agent
// Stop, ADR-111), so the `false` cases below pin the gate itself, not what opencode reports today.
const nativeUse = (toolUseId: string, toolName = 'task'): ContentBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName,
  toolInput: { description: 'native one', subagent_type: 'explore', prompt: 'look' }
})
const dispatchUse = (toolUseId: string): ContentBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName: 'claudeui_dispatch_agent',
  toolInput: { engine: 'pi', prompt: 'do it', description: 'dispatched one' }
})
const assistant = (...content: ContentBlock[]): ChatMessage => ({
  id: 'asst-1',
  role: 'assistant',
  content,
  timestamp: 1
})

describe('Stop on a running task follows capabilities.backgroundTasks (native) and never gates a dispatch', () => {
  let app: TestApp
  let stopCalls: Array<{ toolUseId: string; isDispatch: unknown }>

  const setSession = (
    messages: ChatMessage[],
    engineId: 'opencode' | 'claude',
    backgroundTasks: boolean
  ): void => {
    useSessionStore.setState((s) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...s.sessions,
        [ROUTE]: {
          ...s.sessions[ROUTE],
          messages,
          status: {
            ...s.sessions[ROUTE].status,
            engineId,
            state: 'running',
            capabilities: { ...s.sessions[ROUTE].status.capabilities, backgroundTasks }
          }
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

  const renderRoster = async (): Promise<void> => {
    const roster = renderHook(() => useAgentRoster()).result.current
    await act(async () => {
      render(
        React.createElement(AgentRosterList, {
          roster,
          onOpen: vi.fn(),
          selectedIds: [],
          emptyHint: 'none'
        })
      )
    })
  }
  const rowFor = (toolUseId: string): HTMLElement =>
    screen
      .getAllByTestId('AgentRow')
      .find((el) => el.getAttribute('data-tool-use-id') === toolUseId)!
  const cardFor = (index: number): HTMLElement => screen.getAllByTestId('TaskCard')[index]

  describe('TaskCard', () => {
    it('opencode with backgroundTasks off: no Stop on the native task, Stop on the dispatch', async () => {
      setSession([assistant(nativeUse('toolu_n'), dispatchUse('toolu_d'))], 'opencode', false)
      render(
        <MessageBubble
          message={assistant(nativeUse('toolu_n'), dispatchUse('toolu_d'))}
          pendingApprovals={[]}
          isLastAssistant
        />
      )
      expect(screen.getAllByTestId('TaskCard')).toHaveLength(2)
      expect(cardFor(0).querySelector('[data-testid="TaskCard.stop"]')).toBeNull()
      const dispatchStop = cardFor(1).querySelector('[data-testid="TaskCard.stop"]')
      expect(dispatchStop).not.toBeNull()
      await act(async () => {
        fireEvent.click(dispatchStop!)
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_d', isDispatch: true }])
    })

    it('opencode with backgroundTasks on (2.x): Stop on the native subagent card, through the session', async () => {
      setSession([assistant(nativeUse('toolu_n', 'subagent'))], 'opencode', true)
      render(
        <MessageBubble
          message={assistant(nativeUse('toolu_n', 'subagent'))}
          pendingApprovals={[]}
          isLastAssistant
        />
      )
      const stop = cardFor(0).querySelector('[data-testid="TaskCard.stop"]')
      expect(stop).not.toBeNull()
      await act(async () => {
        fireEvent.click(stop!)
      })
      expect(stopCalls).toHaveLength(1)
      expect(stopCalls[0].toolUseId).toBe('toolu_n')
      expect(stopCalls[0].isDispatch).toBeFalsy()
    })

    it('an engine WITH background tasks keeps Stop on the native task', () => {
      setSession([assistant(nativeUse('toolu_n', 'Agent'))], 'claude', true)
      render(
        <MessageBubble
          message={assistant(nativeUse('toolu_n', 'Agent'))}
          pendingApprovals={[]}
          isLastAssistant
        />
      )
      expect(cardFor(0).querySelector('[data-testid="TaskCard.stop"]')).not.toBeNull()
    })
  })

  describe('TaskEntry (task panel)', () => {
    it('opencode with backgroundTasks off: no Stop on the native task, Stop on the dispatch', async () => {
      setSession([assistant(nativeUse('toolu_n'), dispatchUse('toolu_d'))], 'opencode', false)
      const native = render(<TaskEntry toolUseId="toolu_n" />)
      expect(screen.getByTestId('TaskEntry')).toBeInTheDocument()
      expect(screen.queryByTestId('TaskEntry.stop')).not.toBeInTheDocument()
      native.unmount()
      render(<TaskEntry toolUseId="toolu_d" />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskEntry.stop'))
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_d', isDispatch: true }])
    })

    it('opencode with backgroundTasks on (2.x): Stop on the native subagent entry', () => {
      setSession([assistant(nativeUse('toolu_n', 'subagent'))], 'opencode', true)
      render(<TaskEntry toolUseId="toolu_n" />)
      expect(screen.getByTestId('TaskEntry.stop')).toBeInTheDocument()
    })

    it('an engine WITH background tasks keeps Stop on the native task', () => {
      setSession([assistant(nativeUse('toolu_n', 'Agent'))], 'claude', true)
      render(<TaskEntry toolUseId="toolu_n" />)
      expect(screen.getByTestId('TaskEntry.stop')).toBeInTheDocument()
    })
  })

  describe('AgentRow (roster)', () => {
    it('opencode with backgroundTasks off: no Stop on the native row, Stop on the dispatch row', async () => {
      setSession([assistant(nativeUse('toolu_n'), dispatchUse('toolu_d'))], 'opencode', false)
      await renderRoster()
      expect(rowFor('toolu_n')).toBeTruthy()
      expect(rowFor('toolu_n').querySelector('[data-testid="AgentRow.stop"]')).toBeNull()
      const dispatchStop = rowFor('toolu_d').querySelector('[data-testid="AgentRow.stop"]')
      expect(dispatchStop).not.toBeNull()
      await act(async () => {
        fireEvent.click(dispatchStop!)
      })
      expect(stopCalls).toEqual([{ toolUseId: 'toolu_d', isDispatch: true }])
    })

    it('opencode with backgroundTasks on (2.x): Stop on the native subagent row', async () => {
      setSession([assistant(nativeUse('toolu_n', 'subagent'))], 'opencode', true)
      await renderRoster()
      expect(rowFor('toolu_n').querySelector('[data-testid="AgentRow.stop"]')).not.toBeNull()
    })

    it('an engine WITH background tasks keeps Stop on the native row', async () => {
      setSession([assistant(nativeUse('toolu_n', 'Agent'))], 'claude', true)
      await renderRoster()
      expect(rowFor('toolu_n').querySelector('[data-testid="AgentRow.stop"]')).not.toBeNull()
    })
  })
})
