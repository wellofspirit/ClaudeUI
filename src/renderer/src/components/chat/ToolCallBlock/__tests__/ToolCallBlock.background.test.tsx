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
import type { ContentBlock, TaskNotification } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const ROUTE = 'route-bash-background'
const TOOL_USE_ID = 'toolu_bash_fg'
const TASK_ID = 'bvup3m1hz'

const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: TOOL_USE_ID,
  toolName: 'Bash',
  toolInput: { command: 'sleep 45', description: 'Wait' }
}

const registered = (isBackgrounded: boolean): void =>
  seed.taskStarted(ROUTE, {
    toolUseId: TOOL_USE_ID,
    taskId: TASK_ID,
    taskType: 'local_bash',
    runIndex: 1,
    isBackgrounded
  })

/**
 * What the blocked call returns about a second after the flip, while the
 * command runs on (probes/background-task/official.main.jsonl:121, with a
 * neutral output path).
 */
const manualResult: ToolResultBlock = {
  type: 'tool_result',
  toolUseId: TOOL_USE_ID,
  toolResult: `Command was manually backgrounded by user with ID: ${TASK_ID}. Output is being written to: /tmp/claude/proj/session/tasks/${TASK_ID}.output.`,
  isError: false
}

const ended = (status: TaskNotification['status']): void =>
  seed.taskNotification(ROUTE, {
    taskId: TASK_ID,
    toolUseId: TOOL_USE_ID,
    status,
    outputFile: '',
    summary: ''
  })

const button = (): HTMLElement | null => screen.queryByTestId('ToolCard.sendToBackground')
const stop = (): HTMLElement | null => screen.queryByTestId('ToolCard.stop')
const cardClass = (): string => screen.getByTestId('ToolCard').className

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

// After the flip the blocked call returns "Command was manually backgrounded…"
// while the command runs on for as long as it takes. That tool_result is not
// the command's result: the card follows the task, as for run_in_background.
describe('ToolCallBlock — a Bash sent to the background runs on until its task ends', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
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

  const sendToBackground = (): ReturnType<typeof render> => {
    const view = render(<ToolCallBlock block={block} />)
    act(() => registered(false))
    act(() => registered(true))
    view.rerender(<ToolCallBlock block={block} result={manualResult} />)
    return view
  }

  it('reads as running in the background, not as a finished success, and completes on the notification', () => {
    sendToBackground()
    expect(stop()).toBeInTheDocument()
    expect(screen.getByText('background')).toBeInTheDocument()
    expect(cardClass()).toContain('border-accent/30')
    expect(cardClass()).not.toContain('border-success/30')

    act(() => ended('completed'))
    expect(stop()).not.toBeInTheDocument()
    expect(cardClass()).toContain('border-success/30')
    // Still a background command once its record is gone.
    expect(screen.getByText('background')).toBeInTheDocument()
  })

  it('takes the outcome from the notification, not from the tool_result', () => {
    sendToBackground()
    act(() => ended('failed'))
    expect(cardClass()).toContain('border-danger/30')
  })

  // A reopened session that goes live again has neither: history maps no
  // shell's notification to its call. The wording alone must not leave the
  // card spinning with a Stop button for a command that ended long ago.
  it('shows the tool_result when there is no record and no notification to follow', () => {
    render(<ToolCallBlock block={block} result={manualResult} />)
    expect(stop()).not.toBeInTheDocument()
    expect(cardClass()).toContain('border-success/30')
  })
})
