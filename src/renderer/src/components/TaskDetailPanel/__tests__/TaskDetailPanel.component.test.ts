/**
 * Layer 2: Component tests for TaskDetailPanel FC.
 *
 * Tested flows:
 *   1. renders null when task panel is not open
 *   2. renders null when openedTaskToolUseIds is empty
 *   3. onClose calls closeTaskPanel store action
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  },
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

  it('renders nothing when no opened task tool use IDs', async () => {
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], openedTaskToolUseIds: [] },
      },
    }))

    await renderFC()
    expect(viewProps).toBeNull()
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
                { type: 'tool_use', toolUseId: 'tu-bash-bg', toolName: 'Bash', toolInput: { run_in_background: true } },
                { type: 'tool_use', toolUseId: 'tu-task', toolName: 'Task', toolInput: {} },
              ],
              timestamp: 0,
            },
          ],
        },
      },
    }))

    await renderFC()

    expect(viewProps?.entries).toEqual([
      { toolUseId: 'tu-bash-bg', kind: 'bash-background' },
      { toolUseId: 'tu-task', kind: 'task' },
      { toolUseId: 'tu-gone', kind: 'missing' },
    ])
  })

  it('onClose calls closeTaskPanel, setting rightPanel to none', async () => {
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderFC()
    expect(viewProps).not.toBeNull()

    act(() => { viewProps!.onClose() })

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
  })
})
