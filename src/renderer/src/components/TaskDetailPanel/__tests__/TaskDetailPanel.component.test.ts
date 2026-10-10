/**
 * Layer 2: Component tests for TaskDetailPanel FC.
 *
 * Tested flows:
 *   1. renders null when task panel is not open
 *   2. renders the roster, with no entries, when nothing is opened yet
 *   3. a roster row toggles its entry open and closed
 *   4. onClose calls closeTaskPanel store action
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TaskDetailPanelViewProps } from '../View'
import {
  A_BG_BASH,
  B,
  nestedActiveTasks,
  nestedBuckets,
  nestedMessages
} from '@test/factories/nested-agents'

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

  it("opens a nested agent and a subagent's background Bash, not as missing (§7)", async () => {
    useSessionStore.getState().openTaskPanel(ROUTE, B)
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          openedTaskToolUseIds: [B, A_BG_BASH],
          messages: nestedMessages(),
          subagentMessages: nestedBuckets(),
          activeTasks: nestedActiveTasks()
        }
      }
    }))

    await renderFC()

    expect(viewProps?.entries).toEqual([
      { toolUseId: B, kind: 'task' },
      // The shell entry's "launched by" link is named the way the roster names A.
      { toolUseId: A_BG_BASH, kind: 'bash-background', ownerLabel: 'probenesta' }
    ])
  })

  it('labels an UNNAMED owner by its description, and gives a main-session shell none', async () => {
    const [spawnA, ...rest] = nestedMessages()
    const call = spawnA.content[0] as { toolInput: Record<string, unknown> }
    const { name: _name, ...unnamedInput } = call.toolInput
    void _name
    const unnamedA = {
      ...spawnA,
      content: [{ ...spawnA.content[0], toolInput: unnamedInput }]
    } as typeof spawnA
    const mainShell = {
      id: 'm-main-sh',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          toolUseId: 'tu-main-sh',
          toolName: 'Bash',
          toolInput: { command: 'bun run dev', run_in_background: true }
        }
      ],
      timestamp: 0
    }
    useSessionStore.getState().openTaskPanel(ROUTE, A_BG_BASH)
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          openedTaskToolUseIds: [A_BG_BASH, 'tu-main-sh'],
          messages: [unnamedA, ...rest, mainShell],
          subagentMessages: nestedBuckets(),
          activeTasks: nestedActiveTasks()
        }
      }
    }))

    await renderFC()

    expect(viewProps?.entries).toEqual([
      // Its name is only the type ("general-purpose"); the description says which agent.
      { toolUseId: A_BG_BASH, kind: 'bash-background', ownerLabel: 'probe nested a' },
      { toolUseId: 'tu-main-sh', kind: 'bash-background' }
    ])
  })

  // Seen live (2026-09-28): a Bash sent to the background with the card's button
  // opened as a plain task, whose finished entry showed "Command was manually
  // backgrounded by user…" instead of the command's output.
  describe('a Bash cli.js moved to the background', () => {
    const TASK_ID = 'b7x2k9'
    const openMoved = (patch: Record<string, unknown>): void => {
      useSessionStore.getState().openTaskPanel(ROUTE, 'tu-fg')
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ROUTE]: {
            ...state.sessions[ROUTE],
            openedTaskToolUseIds: ['tu-fg'],
            messages: [
              {
                id: 'm1',
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    toolUseId: 'tu-fg',
                    toolName: 'Bash',
                    toolInput: { command: 'bun run build' }
                  }
                ],
                timestamp: 0
              },
              {
                id: 'm2',
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    toolUseId: 'tu-fg',
                    toolResult: `Command was manually backgrounded by user with ID: ${TASK_ID}. Output is being written to: /tmp/claude/proj/session/tasks/${TASK_ID}.output.`,
                    isError: false
                  }
                ],
                timestamp: 1
              }
            ],
            ...patch
          }
        }
      }))
    }
    const ended = {
      taskNotifications: [
        { taskId: TASK_ID, toolUseId: 'tu-fg', status: 'completed', outputFile: '', summary: '' }
      ]
    }

    it('opens as a background shell while it runs', async () => {
      openMoved({
        activeTasks: { 'tu-fg': { taskId: TASK_ID, taskType: 'local_bash', isBackgrounded: true } }
      })
      await renderFC()
      expect(viewProps?.entries).toEqual([{ toolUseId: 'tu-fg', kind: 'bash-background' }])
    })

    it('stays a background shell after its task ends', async () => {
      openMoved(ended)
      await renderFC()
      expect(viewProps?.entries).toEqual([{ toolUseId: 'tu-fg', kind: 'bash-background' }])
    })

    it('opens as a task in a reopened session, which has no task events', async () => {
      openMoved({ ...ended, isHistorical: true })
      await renderFC()
      expect(viewProps?.entries).toEqual([{ toolUseId: 'tu-fg', kind: 'task' }])
    })
  })

  it('a roster row toggles its entry, and putting the last away keeps the roster open', async () => {
    useSessionStore.getState().toggleAgentsPanel(ROUTE)
    await renderFC()
    const session = (): { openedTaskToolUseIds: string[]; rightPanel: string } =>
      useSessionStore.getState().sessions[ROUTE]

    act(() => viewProps!.onToggleAgent('tu-1'))
    act(() => viewProps!.onToggleAgent('tu-2'))
    expect(session().openedTaskToolUseIds).toEqual(['tu-1', 'tu-2'])

    act(() => viewProps!.onToggleAgent('tu-1'))
    expect(session().openedTaskToolUseIds).toEqual(['tu-2'])

    act(() => viewProps!.onToggleAgent('tu-2'))
    expect(session().openedTaskToolUseIds).toEqual([])
    expect(session().rightPanel).toBe('task')
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
