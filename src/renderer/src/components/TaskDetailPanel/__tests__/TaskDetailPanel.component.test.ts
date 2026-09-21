/**
 * Layer 2: Component tests for TaskDetailPanel FC.
 *
 * Tested flows:
 *   1. renders null when task panel is not open
 *   2. renders the roster, with no entries, when nothing is opened yet
 *   3. onClose calls closeTaskPanel store action
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TaskDetailPanelViewProps } from '../View'

let viewProps: TaskDetailPanelViewProps | null = null
vi.mock('../View', () => ({
  TaskDetailPanelView: (props: TaskDetailPanelViewProps) => {
    viewProps = props
    return null
  }
}))

const ROUTE = 'route-task-panel'

describe('TaskDetailPanel FC', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    viewProps = null
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderFC(): Promise<void> {
    const { TaskDetailPanel } = await import('../TaskDetailPanel')
    await act(async () => {
      render(React.createElement(TaskDetailPanel))
    })
  }

  it('renders nothing when task panel is not open', async () => {
    await renderFC()
    expect(viewProps).toBeNull()
  })

  it('still renders the roster when no task is opened', async () => {
    // Changed deliberately in ADR-073: the top-bar pill opens this panel
    // WITHOUT picking an agent, because a card scrolled out of view used to
    // leave the panel unreachable. An open panel with no entries is the
    // roster on its own, not a bug.
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], openedTaskToolUseIds: [] }
      }
    }))

    await renderFC()
    expect(viewProps).not.toBeNull()
    expect(viewProps?.entries).toEqual([])
    expect(viewProps?.roster.totalCount).toBe(0)
  })

  it('classifies each task as bash-background, task, or missing', async () => {
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-bash-bg')
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          openedTaskToolUseIds: ['tu-bash-bg', 'tu-task', 'tu-gone'],
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  toolUseId: 'tu-bash-bg',
                  toolName: 'Bash',
                  toolInput: { run_in_background: true }
                },
                { type: 'tool_use', toolUseId: 'tu-task', toolName: 'Task', toolInput: {} }
              ],
              timestamp: 0
            }
          ]
        }
      }
    }))

    await renderFC()

    expect(viewProps?.entries).toEqual([
      { toolUseId: 'tu-bash-bg', kind: 'bash-background' },
      { toolUseId: 'tu-task', kind: 'task' },
      { toolUseId: 'tu-gone', kind: 'missing' }
    ])
  })

  it('onClose calls closeTaskPanel, setting rightPanel to none', async () => {
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderFC()
    expect(viewProps).not.toBeNull()

    act(() => {
      viewProps!.onClose()
    })

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
  })
})
