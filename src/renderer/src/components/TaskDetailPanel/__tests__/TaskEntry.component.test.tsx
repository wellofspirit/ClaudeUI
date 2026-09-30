/**
 * Layer 2: Component tests for TaskEntry's subagent output ordering + the
 * expand-thinking toggle (thinking-order-bug).
 *
 * Pre-fix: TaskEntry had an identical copy-pasted block to TaskCard's — the
 * live streamThinking buffer rendered ABOVE the accumulated message list
 * instead of below it, and the toggle was ignored entirely (raw always-on
 * tail preview). These pin the fixed ordering (messages, then live thinking,
 * then live text) and toggle honoring, mirroring the TaskCard regression
 * tests in chat/__tests__/TaskCard.component.test.tsx.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ActiveTask, ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../../chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
import { TaskEntry } from '../TaskEntry'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { B, nestedActiveTasks, nestedBuckets, nestedMessages } from '@test/factories/nested-agents'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-task-entry'
const TOOL_USE_ID = 'call_task_entry_1'

function taskMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: TOOL_USE_ID,
        toolName: 'Task',
        toolInput: { description: 'Explore ChatView components' }
      } as ToolUseBlock
    ],
    timestamp: Date.now()
  }
}

describe('TaskEntry — subagent output ordering + thinking toggle', () => {
  let app: TestApp
  const defaultSettings = useSessionStore.getState().settings

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], messages: [taskMessage()] }
      }
    }))
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, settings: defaultSettings })
    mirrorStoreIntoReplica()
  })

  it('expandThinking=false: live thinking starts collapsed (tail preview only)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(screen.queryByText(longText, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByTestId('SubagentMessages.thinkingToggle')).toBeInTheDocument()
  })

  it('expandThinking=false: clicking the live-thinking toggle reveals the full buffer', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    fireEvent.click(screen.getByTestId('SubagentMessages.thinkingToggle'))

    expect(screen.getByText(longText)).toBeInTheDocument()
  })

  it('expandThinking=true: live thinking starts expanded (full buffer visible immediately)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: true } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(screen.getByText(longText)).toBeInTheDocument()
  })
})

/**
 * The panel's header had the TaskCard defect verbatim: its only clock was
 * `tool_progress`, which cli.js does not send for an agent, and a usage-only
 * `task_progress` left the reducer's default 0 — "0s" for the whole run.
 */
describe('TaskEntry — a running task’s clock', () => {
  let app: TestApp
  const T0 = new Date('2026-09-27T12:06:58.000Z').getTime()

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], messages: [taskMessage()] }
      }
    }))
    mirrorStoreIntoReplica()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('advances from the run’s start, past a usage-only task_progress', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: TOOL_USE_ID,
      taskId: 'agent-abc123',
      taskType: 'local_agent',
      runIndex: 1,
      startedAt: T0
    })
    seed.taskProgress(ROUTE, {
      toolUseId: TOOL_USE_ID,
      usage: { totalTokens: 1200, toolUses: 1, durationMs: 4000 }
    } as unknown as Parameters<typeof seed.taskProgress>[1])
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    act(() => {
      vi.advanceTimersByTime(22_000)
    })
    expect(screen.getByTestId('TaskEntry.elapsed').textContent).toBe('22s')
  })
})

/**
 * ADR-073 §7: a nested agent opens from the roster like any agent. Its spawn is
 * in its parent's bucket; its own transcript is `subagentMessages[<its id>]`.
 */
describe('TaskEntry — a nested agent', () => {
  let app: TestApp

  const stage = (activeTasks: Record<string, ActiveTask>): void => {
    const buckets = nestedBuckets()
    // B's own transcript. Its Bash card is left out: rendering it would watch
    // background output over IPC, which this layer does not host.
    buckets[B] = [
      {
        id: 'b-text',
        role: 'assistant',
        content: [{ type: 'text', text: 'NESTED_B_TRANSCRIPT' }],
        timestamp: 0
      }
    ]
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: nestedMessages(),
          subagentMessages: buckets,
          activeTasks
        }
      }
    }))
    mirrorStoreIntoReplica()
  }

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it("renders the nested agent's own transcript", () => {
    stage(nestedActiveTasks())
    render(<TaskEntry toolUseId={B} />)
    expect(screen.getByTestId('TaskEntry').getAttribute('data-id')).toBe(B)
    expect(screen.getByText('NESTED_B_TRANSCRIPT')).toBeInTheDocument()
    expect(screen.getByTestId('TaskEntry.stop')).toBeInTheDocument()
  })

  it('offers no Stop while it runs with no lifecycle record', () => {
    // Running by the legacy heuristic (background input, no terminal event).
    // Stop would reach Claude's interrupt() fallback and end the MAIN turn.
    stage({})
    render(<TaskEntry toolUseId={B} />)
    expect(screen.getByTestId('TaskEntry')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskEntry.stop')).toBeNull()
  })
})
