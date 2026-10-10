/**
 * Layer 2: the two roster surfaces (ADR-073).
 *
 * The rules they encode are owner rulings, not taste:
 *   - the PILL stays while the session has any agent at all, because it is the
 *     panel's only scroll-independent door;
 *   - the TAB exists only while something is running;
 *   - both are gated by a setting, and with both off the transcript card is
 *     still the way in;
 *   - both show a dot and a bare number, and the breakdown lives in the
 *     tooltip and aria-label (§7, superseding the 2026-09-22 "N agents" label).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentPill } from '../AgentPill'
import { AgentTab } from '../AgentTab'
import type { ChatMessage } from '../../../../../shared/types'
import {
  A,
  B,
  nestedActiveTasks,
  nestedBuckets,
  nestedMessages
} from '@test/factories/nested-agents'

const ROUTE = 'route-agent-surfaces'

function taskMessage(id: string, toolUseId: string, name: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Task',
        toolInput: { name, subagent_type: 'Explore', description: 'work' }
      }
    ],
    timestamp: Date.now()
  } as ChatMessage
}

function setSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], ...patch } }
  }))
}

async function renderEl(el: React.ReactElement): Promise<void> {
  await act(async () => {
    render(el)
  })
}

describe('agent roster surfaces', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE, settings: { ...DEFAULT_SETTINGS } })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  describe('AgentPill', () => {
    it('is absent in a session that has spawned nothing', async () => {
      await renderEl(<AgentPill />)
      expect(screen.queryByTestId('AgentPill')).toBeNull()
    })

    it('counts the running agents', async () => {
      setSession({
        messages: [taskMessage('m1', 'tu-a', 'reviewer'), taskMessage('m2', 'tu-b', 'explorer')],
        activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent' } },
        // tu-b has finished; only the armed one counts as running.
        taskNotifications: [
          { taskId: 'a2', toolUseId: 'tu-b', status: 'completed', outputFile: '', summary: '' }
        ]
      })
      await renderEl(<AgentPill />)
      expect(screen.getByTestId('AgentPill').getAttribute('data-running')).toBe('true')
      expect(screen.getByTestId('AgentPill.count').textContent).toBe('1')
      expect(screen.getByTestId('AgentPill').getAttribute('aria-label')).toBe(
        '1 agent running · 2 agents in this session'
      )
    })

    it('STAYS after they all finish, showing the total', async () => {
      // The ruling: the tab goes, the pill remains, so the history is one click
      // away and the panel never becomes unreachable.
      setSession({
        messages: [taskMessage('m1', 'tu-a', 'reviewer'), taskMessage('m2', 'tu-b', 'explorer')],
        taskNotifications: [
          { taskId: 'a1', toolUseId: 'tu-a', status: 'completed', outputFile: '', summary: '' },
          { taskId: 'a2', toolUseId: 'tu-b', status: 'completed', outputFile: '', summary: '' }
        ]
      })
      await renderEl(<AgentPill />)
      expect(screen.getByTestId('AgentPill').getAttribute('data-running')).toBe('false')
      expect(screen.getByTestId('AgentPill.count').textContent).toBe('2')
      const pill = screen.getByTestId('AgentPill')
      expect(pill.getAttribute('aria-label')).toBe('2 agents in this session')
      expect(pill.getAttribute('title')).toBe(pill.getAttribute('aria-label'))
    })

    it('counts nested agents and running shells, with the breakdown in its label', async () => {
      setSession({
        messages: nestedMessages(),
        subagentMessages: nestedBuckets(),
        activeTasks: nestedActiveTasks()
      })
      await renderEl(<AgentPill />)
      // A, B (nested) and A's run_in_background Bash; the foreground Bashes are not counted.
      expect(screen.getByTestId('AgentPill.count').textContent).toBe('3')
      expect(screen.getByTestId('AgentPill').getAttribute('aria-label')).toBe(
        '2 agents, 1 shell running · 2 agents in this session'
      )
    })

    it('lights up when only a background shell runs', async () => {
      setSession({
        messages: [
          taskMessage('m1', 'tu-a', 'reviewer'),
          {
            id: 'm2',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                toolUseId: 'tu-sh',
                toolName: 'Bash',
                toolInput: { command: 'bun run dev', run_in_background: true }
              }
            ],
            timestamp: 0
          } as ChatMessage
        ],
        activeTasks: { 'tu-sh': { taskId: 'b1', taskType: 'local_bash', isBackgrounded: true } },
        taskNotifications: [
          { taskId: 'a1', toolUseId: 'tu-a', status: 'completed', outputFile: '', summary: '' }
        ]
      })
      await renderEl(<AgentPill />)
      expect(screen.getByTestId('AgentPill').getAttribute('data-running')).toBe('true')
      expect(screen.getByTestId('AgentPill.count').textContent).toBe('1')
      expect(screen.getByTestId('AgentPill').getAttribute('aria-label')).toBe(
        '1 shell running · 1 agent in this session'
      )
    })

    it('toggles the panel without selecting an agent', async () => {
      setSession({ messages: [taskMessage('m1', 'tu-a', 'reviewer')] })
      await renderEl(<AgentPill />)

      fireEvent.click(screen.getByTestId('AgentPill'))
      expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('task')
      expect(useSessionStore.getState().sessions[ROUTE].openedTaskToolUseIds).toEqual([])

      fireEvent.click(screen.getByTestId('AgentPill'))
      expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
    })

    it('honours its setting', async () => {
      setSession({ messages: [taskMessage('m1', 'tu-a', 'reviewer')] })
      useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS, showAgentPill: false } })
      await renderEl(<AgentPill />)
      expect(screen.queryByTestId('AgentPill')).toBeNull()
    })
  })

  describe('AgentTab', () => {
    const running = {
      messages: [taskMessage('m1', 'tu-a', 'reviewer')],
      activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent' } },
      taskProgressMap: {
        'tu-a': {
          toolUseId: 'tu-a',
          toolName: 'Task',
          parentToolUseId: null,
          elapsedTimeSeconds: 74
        }
      }
    }

    it('is absent when nothing is running, even with finished agents', async () => {
      setSession({
        messages: [taskMessage('m1', 'tu-a', 'reviewer')],
        taskNotifications: [
          { taskId: 'a1', toolUseId: 'tu-a', status: 'completed', outputFile: '', summary: '' }
        ]
      })
      await renderEl(<AgentTab />)
      expect(screen.queryByTestId('AgentTab')).toBeNull()
    })

    it('shows the count and the longest clock while running', async () => {
      setSession(running)
      await renderEl(<AgentTab />)
      expect(screen.getByTestId('AgentTab.count').textContent).toBe('1')
      expect(screen.getByTestId('AgentTab').textContent).toContain('1m 14s')
      expect(screen.getByTestId('AgentTab').getAttribute('aria-label')).toBe(
        '1 agent running · 1 agent in this session'
      )
    })

    it('appears when only a nested agent runs', async () => {
      // The reported bug: the lead handed back, its implementer kept running.
      setSession({
        messages: nestedMessages(),
        subagentMessages: nestedBuckets(),
        activeTasks: { [B]: nestedActiveTasks()[B] },
        taskNotifications: [
          {
            taskId: 'af110ad6ad039a313',
            toolUseId: A,
            status: 'completed',
            outputFile: '',
            summary: ''
          }
        ]
      })
      await renderEl(<AgentTab />)
      expect(screen.getByTestId('AgentTab.count').textContent).toBe('1')
    })

    it('opens the roster overlay and keeps it out of the layout flow', async () => {
      setSession(running)
      await renderEl(<AgentTab />)
      expect(screen.queryByTestId('AgentOverlay')).toBeNull()

      fireEvent.click(screen.getByTestId('AgentTab'))
      const overlay = screen.getByTestId('AgentOverlay')
      // Absolutely positioned above the composer: opening it must never reflow
      // the transcript, which is why it is not a strip above the input.
      expect(overlay.className).toContain('absolute')
      expect(overlay.className).toContain('bottom-full')
      expect(screen.getByTestId('AgentRoster')).toBeTruthy()
    })

    it('a row opens that agent in the panel and closes the overlay', async () => {
      setSession(running)
      await renderEl(<AgentTab />)
      fireEvent.click(screen.getByTestId('AgentTab'))
      fireEvent.click(screen.getByTestId('AgentRow'))

      expect(useSessionStore.getState().sessions[ROUTE].openedTaskToolUseIds).toEqual(['tu-a'])
      expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('task')
      expect(screen.queryByTestId('AgentOverlay')).toBeNull()
    })

    it('closes on Escape', async () => {
      setSession(running)
      await renderEl(<AgentTab />)
      fireEvent.click(screen.getByTestId('AgentTab'))
      expect(screen.getByTestId('AgentOverlay')).toBeTruthy()

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      expect(screen.queryByTestId('AgentOverlay')).toBeNull()
    })

    it('honours its setting', async () => {
      setSession(running)
      useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS, showAgentTab: false } })
      await renderEl(<AgentTab />)
      expect(screen.queryByTestId('AgentTab')).toBeNull()
    })
  })
})
