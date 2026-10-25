/**
 * Owner ruling R1 (opencode subagent parity): opencode 2.1.2 cannot move ONE
 * call to the background (its `POST /session/:id/background` is whole-session),
 * so its task records say nothing of `isBackgrounded` for a foreground run, and
 * no card may offer "Send to background" for it — not the TaskCard (a subagent
 * call) nor the ToolCard (a command) — even though the engine now reports
 * `backgroundTasks: true` for its per-child Stop.
 *
 * The button needs an explicit `isBackgrounded: false` (the cli.js
 * foreground-task record). Each case is paired with that control, so the test
 * fails if the gate ever reads "absent" as "foreground".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ContentBlock, TaskStartedData } from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))

import { TaskCard } from '../TaskCard'
import { ToolCallBlock } from '../ToolCallBlock/ToolCallBlock'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-opencode-r1'

/** The record the opencode mapper sends for a foreground run (event-mapper.ts `taskStarted`). */
const opencodeRun = (toolUseId: string, extra: Partial<TaskStartedData> = {}): TaskStartedData => ({
  toolUseId,
  taskId: 'ses_child',
  taskType: 'local_agent',
  runIndex: 1,
  startedAt: Date.now(),
  wakesParent: true,
  description: 'Look around',
  ...extra
})

describe('opencode: no "Send to background" without an explicit foreground record (R1)', () => {
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

  describe('TaskCard (a subagent call)', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      toolUseId: 'call_sub',
      toolName: 'subagent',
      toolInput: { agent: 'general', description: 'Look around', prompt: 'look' }
    }
    const view = {
      kind: 'task' as const,
      description: 'Look around',
      prompt: 'look',
      subagent: 'general'
    }
    const sendToBackground = () => screen.queryByTestId('TaskCard.sendToBackground')

    it('a foreground run (no `isBackgrounded`) shows Stop and no Send to background', () => {
      seed.taskStarted(ROUTE, opencodeRun('call_sub'))
      render(<TaskCard block={block} view={view} />)
      expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
      expect(sendToBackground()).not.toBeInTheDocument()
    })

    it('control: the same record with `isBackgrounded: false` does offer it', () => {
      seed.taskStarted(ROUTE, opencodeRun('call_sub', { isBackgrounded: false }))
      render(<TaskCard block={block} view={view} />)
      expect(sendToBackground()).toBeInTheDocument()
    })

    it('a resumed run (runIndex 2) is no different', () => {
      seed.taskStarted(ROUTE, opencodeRun('call_sub', { runIndex: 2 }))
      render(<TaskCard block={block} view={view} />)
      expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
      expect(sendToBackground()).not.toBeInTheDocument()
    })

    it('a run that turns out backgrounded keeps no button either', () => {
      seed.taskStarted(ROUTE, opencodeRun('call_sub'))
      render(<TaskCard block={block} view={view} />)
      act(() => seed.taskStarted(ROUTE, opencodeRun('call_sub', { isBackgrounded: true })))
      expect(sendToBackground()).not.toBeInTheDocument()
    })
  })

  describe('ToolCard (a running command)', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      toolUseId: 'call_shell',
      toolName: 'Bash',
      toolInput: { command: 'sleep 45', description: 'Wait' }
    }
    const record = (extra: Partial<TaskStartedData> = {}): TaskStartedData => ({
      ...opencodeRun('call_shell', { taskType: 'local_bash' }),
      ...extra
    })
    const sendToBackground = () => screen.queryByTestId('ToolCard.sendToBackground')

    it('a record without `isBackgrounded` never shows it', () => {
      seed.taskStarted(ROUTE, record())
      render(<ToolCallBlock block={block} />)
      expect(sendToBackground()).not.toBeInTheDocument()
    })

    it('control: `isBackgrounded: false` does', () => {
      seed.taskStarted(ROUTE, record({ isBackgrounded: false }))
      render(<ToolCallBlock block={block} />)
      expect(sendToBackground()).toBeInTheDocument()
    })
  })
})
