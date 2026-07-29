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
import { render, screen, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../../chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
vi.mock('../../chat/SubagentMessages', () => ({
  SubagentMessages: () => <div data-testid="subagent-msgs" />
}))

import { TaskEntry } from '../TaskEntry'

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
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, settings: defaultSettings })
  })

  it('renders the message list, then live thinking, then live streamed text, in that DOM order', () => {
    useSessionStore.getState().addSubagentMessage(ROUTE, TOOL_USE_ID, {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial result' }],
      timestamp: Date.now()
    })
    // Set both live buffers directly (bypassing the append* actions): in real
    // usage appendSubagentStreamingText clears the thinking buffer for the
    // same toolUseId (thinking ends before text starts), so calling both
    // actions in sequence can never produce a state with both non-empty.
    // This test only needs the render-time DOM order for that combined
    // state, not a realistic action sequence.
    useSessionStore.setState((state) => {
      const session = state.sessions[ROUTE]
      return {
        sessions: {
          ...state.sessions,
          [ROUTE]: {
            ...session,
            subagentStreamingThinking: {
              ...session.subagentStreamingThinking,
              [TOOL_USE_ID]: 'pondering'
            },
            subagentStreamingText: { ...session.subagentStreamingText, [TOOL_USE_ID]: 'final answer' }
          }
        }
      }
    })

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    const msgsEl = screen.getByTestId('subagent-msgs')
    const thinkingEl = screen.getByTestId('SubagentOutputBody.liveThinking')
    const textEl = screen.getByTestId('md')

    // Pre-fix, thinkingEl preceded msgsEl in the DOM.
    expect(
      msgsEl.compareDocumentPosition(thinkingEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      thinkingEl.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('expandThinking=false: live thinking starts collapsed (tail preview only)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    useSessionStore.getState().appendSubagentStreamingThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(screen.queryByText(longText, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByTestId('SubagentOutputBody.liveThinking')).toBeInTheDocument()
  })

  it('expandThinking=false: clicking the live-thinking toggle reveals the full buffer', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    useSessionStore.getState().appendSubagentStreamingThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    fireEvent.click(screen.getByTestId('SubagentOutputBody.liveThinking.toggle'))

    expect(screen.getByText(longText)).toBeInTheDocument()
  })

  it('expandThinking=true: live thinking starts expanded (full buffer visible immediately)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: true } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    useSessionStore.getState().appendSubagentStreamingThinking(ROUTE, TOOL_USE_ID, longText)

    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(screen.getByText(longText)).toBeInTheDocument()
  })
})
