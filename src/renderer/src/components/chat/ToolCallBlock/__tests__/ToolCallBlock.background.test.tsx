/**
 * "Send to background" on a foreground Bash card — the real ToolCallBlock →
 * ToolCard stack, driven through the store the way the wire drives it.
 *
 * cli.js registers a foreground Bash as a task only once it has run for 2 s
 * (docs/protocol-cc/04-system-subtypes.md §4.5), and until then answers
 * `background_tasks` with `{backgrounded:false}`. The button used to show from
 * the first moment the command ran, so every early click became a failure. It
 * now follows the task record: absent before registration, present for a
 * registered foreground task, gone once the task flips to the background.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { ToolCallBlock } from '../ToolCallBlock'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-bash-background'
const TOOL_USE_ID = 'toolu_bash_fg'

const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: TOOL_USE_ID,
  toolName: 'Bash',
  toolInput: { command: 'sleep 45', description: 'Wait' }
}

const registered = (isBackgrounded: boolean): void =>
  seed.taskStarted(ROUTE, {
    toolUseId: TOOL_USE_ID,
    taskId: 'bvup3m1hz',
    taskType: 'local_bash',
    runIndex: 1,
    isBackgrounded
  })

const button = (): HTMLElement | null => screen.queryByTestId('ToolCard.sendToBackground')

describe('ToolCallBlock — "Send to background" follows the task record', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    // An expanded running command card tails its output file.
    app.bridge.ipcMain.handle('session:watch-background', async () => {})
    app.bridge.ipcMain.handle('session:unwatch-background', async () => {})
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('is absent while the command runs unregistered, present once registered in the foreground, and gone after the flip', () => {
    render(<ToolCallBlock block={block} />)
    expect(button()).not.toBeInTheDocument()

    act(() => registered(false))
    expect(button()).toBeInTheDocument()

    act(() => registered(true))
    expect(button()).not.toBeInTheDocument()
  })

  it('clears "sending to background…" once the task flips, without waiting for the reply', async () => {
    const calls: string[] = []
    app.bridge.ipcMain.handle('session:background-task', (_e, _rid: string, id: string) => {
      calls.push(id)
      return new Promise(() => {})
    })
    registered(false)
    render(<ToolCallBlock block={block} />)

    await act(async () => {
      fireEvent.click(button()!)
    })
    expect(calls).toEqual([TOOL_USE_ID])
    expect(screen.getByText('sending to background…')).toBeInTheDocument()
    expect(button()).not.toBeInTheDocument()

    act(() => registered(true))
    expect(screen.queryByText('sending to background…')).not.toBeInTheDocument()
    expect(button()).not.toBeInTheDocument()
  })

  it('comes back after a failed attempt', async () => {
    app.bridge.ipcMain.handle('session:background-task', async () => ({
      success: false,
      error: 'Task is not registered yet — try again in a moment'
    }))
    registered(false)
    render(<ToolCallBlock block={block} />)

    await act(async () => {
      fireEvent.click(button()!)
    })

    expect(button()).toBeInTheDocument()
    expect(screen.queryByText('sending to background…')).not.toBeInTheDocument()
  })
})
