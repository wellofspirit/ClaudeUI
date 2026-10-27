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
// ADR-102 Arc 2: the entry's on-demand request is the load's; asserted, not run.
const { requestSubagentTranscript } = vi.hoisted(() => ({ requestSubagentTranscript: vi.fn() }))
vi.mock('../../../lib/subagent-prefetch', () => ({ requestSubagentTranscript }))
import { TaskEntry } from '../TaskEntry'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { B, nestedActiveTasks, nestedBuckets, nestedMessages } from '@test/factories/nested-agents'
import {
  dispatchScroll,
  dispatchWheel,
  distanceFromBottom,
  fireResize,
  geo,
  installScrollGeometry,
  setDefaultGeometry
} from '@test/helpers/scroll-geometry'

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

/**
 * A dispatch's child (and anything nested in it) speaks the TARGET engine's tool
 * names; the panel reads them through that engine's map, not the session's.
 */
describe("TaskEntry - a dispatch child's tool cards use the target engine's tool map", () => {
  let app: TestApp
  const DISPATCH = 'call_dispatch_pi'
  const NESTED = 'call_pi_nested_agent'

  const readUse = (id: string): ChatMessage => ({
    id: `m-${id}`,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: id,
        toolName: 'read',
        toolInput: { path: '/d/repo/a.ts' }
      } as ToolUseBlock
    ],
    timestamp: 0
  })

  const nestedAgent: ChatMessage = {
    id: 'm-nested',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: NESTED,
        toolName: 'agent',
        toolInput: { description: 'inner', prompt: 'inner' }
      } as ToolUseBlock
    ],
    timestamp: 0
  }

  const dispatchMsg: ChatMessage = {
    id: 'assistant-d',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: DISPATCH,
        toolName: 'mcp__claude-ui-collab__dispatch_agent',
        toolInput: { engine: 'pi', prompt: 'look' }
      } as ToolUseBlock
    ],
    timestamp: 0
  }

  const stage = (nested: boolean): void => {
    const buckets: Record<string, ChatMessage[]> = nested
      ? { [DISPATCH]: [nestedAgent], [NESTED]: [readUse('inner-read')] }
      : { [DISPATCH]: [readUse('child-read')] }
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [dispatchMsg],
          subagentMessages: buckets
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

  it("renders the pi child's `read` as a Read card", () => {
    stage(false)
    render(<TaskEntry toolUseId={DISPATCH} />)
    const header = screen.getByTestId('ToolCard.expand').textContent ?? ''
    expect(header).toContain('Read')
    expect(header).not.toContain('{"path"')
  })

  it('a default-background X-Agent that failed does not show the launch acknowledgement as its body (ADR-105 §2)', () => {
    const ack = 'X-Agent rev launched on pi (id s-abc123). It runs in the background.'
    const resultMsg: ChatMessage = {
      id: 'result-d',
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: DISPATCH, toolResult: ack, isError: false }],
      timestamp: 1
    }
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], messages: [dispatchMsg, resultMsg] }
      }
    }))
    mirrorStoreIntoReplica()
    const end = (isBackgrounded: boolean): void =>
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: DISPATCH,
        status: 'failed',
        outputFile: '',
        summary: 'X-Agent rev failed: boom',
        ...(isBackgrounded ? { isBackgrounded: true } : {})
      })
    // Without the run's own word the ack reads as an answer (the input has no flag)...
    end(false)
    const { unmount } = render(<TaskEntry toolUseId={DISPATCH} />)
    expect(screen.queryByText(/It runs in the background/)).toBeInTheDocument()
    unmount()
    // ...with it, the ack is not the body.
    end(true)
    render(<TaskEntry toolUseId={DISPATCH} />)
    expect(screen.queryByText(/It runs in the background/)).not.toBeInTheDocument()
  })

  describe('an X-Agent call, as the panel names and ends it', () => {
    const call = (input: Record<string, unknown>, result?: Partial<ContentBlock>): void => {
      const messages: ChatMessage[] = [
        {
          ...dispatchMsg,
          content: [
            { ...(dispatchMsg.content[0] as ToolUseBlock), toolInput: input } as ToolUseBlock
          ]
        }
      ]
      if (result)
        messages.push({
          id: 'result-d',
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: DISPATCH, toolResult: '', isError: false, ...result }
          ] as ContentBlock[],
          timestamp: 1
        })
      useSessionStore.setState((state) => ({
        activeSessionId: ROUTE,
        sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], messages } }
      }))
      mirrorStoreIntoReplica()
    }
    const toggleText = (): string => screen.getByTestId('TaskEntry.toggle').textContent ?? ''

    it('the header says X-Agent and the description is the X-Agent’s, not the raw prompt', () => {
      call({ engine: 'pi', prompt: 'a very long instruction nobody wants in a header' })
      const { unmount } = render(<TaskEntry toolUseId={DISPATCH} />)
      expect(toggleText()).toContain('X-Agent')
      expect(toggleText()).toContain('Dispatch: pi')
      expect(toggleText()).not.toContain('very long instruction')
      unmount()

      call({ engine: 'pi', prompt: 'long', description: 'Review the auth change' })
      render(<TaskEntry toolUseId={DISPATCH} />)
      expect(toggleText()).toContain('Review the auth change')
    })

    it('a refused background launch shows the reason it was refused', () => {
      call(
        { engine: 'pi', prompt: 'go', run_in_background: true },
        {
          toolResult: 'X-Agent refused: 4 X-Agents are already running (the limit).',
          isError: true
        }
      )
      render(<TaskEntry toolUseId={DISPATCH} />)
      expect(screen.getByTestId('TaskEntry.failureSummary')).toHaveTextContent(
        'X-Agent refused: 4 X-Agents are already running (the limit).'
      )
    })

    it.each([
      ['failed', 'The X-Agent ran out of time.'],
      ['stopped', 'The X-Agent was stopped.']
    ] as const)('a %s run with no report says how it ended: "%s"', (status, summary) => {
      call(
        { engine: 'pi', prompt: 'go' },
        { toolResult: 'X-Agent launched on pi. It runs in the background.' }
      )
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: DISPATCH,
        status,
        outputFile: '',
        summary,
        isBackgrounded: true
      })
      render(<TaskEntry toolUseId={DISPATCH} />)
      expect(screen.getByTestId('TaskEntry.endNote')).toHaveTextContent(summary)
    })

    it('a withheld report of an X-Agent to an engine this build does not know still says X-Agent', () => {
      call({ engine: 'gemini', prompt: 'go' }, { toolResult: 'X-Agent launched.' })
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: DISPATCH,
        status: 'completed',
        outputFile: '',
        summary: 'ignored',
        handback: 'withheld',
        isBackgrounded: true
      })
      render(<TaskEntry toolUseId={DISPATCH} />)
      expect(screen.getByTestId('HandbackReport.withheld')).toHaveTextContent('The X-Agent ended')
      expect(screen.queryByTestId('TaskEntry.endNote')).not.toBeInTheDocument()
    })
  })

  it("a task nested in that child inherits the child's engine", () => {
    stage(true)
    render(<TaskEntry toolUseId={NESTED} />)
    const header = screen.getByTestId('ToolCard.expand').textContent ?? ''
    expect(header).toContain('Read')
    expect(header).not.toContain('{"path"')
  })
})

/**
 * The detail panel's body must follow its content to the bottom. It used to pin
 * in a React effect on `[msgs, bashOutput, following]`, so growth that happens
 * AFTER the commit (a Bash card finishing its render, highlighting, a result
 * expanding) was never followed; and any scroll event within 40px of the bottom
 * flipped `following` back on, with the scroll animation's own events flipping
 * it off mid-flight.
 */
describe('TaskEntry — following the bottom', () => {
  let app: TestApp
  let restoreGeometry: () => void
  let clock = 1000

  const body = (): HTMLElement => screen.getByTestId('TaskEntry.body')
  const content = (): HTMLElement => {
    const el = body().firstElementChild
    if (!(el instanceof HTMLElement)) throw new Error('content not mounted')
    return el
  }

  /** The Bash card finishes rendering after commit: no DOM mutation, only layout. */
  function growLayoutOnly(by: number): void {
    geo(body()).scrollHeight += by
    act(() => fireResize(content()))
  }

  /** What a browser does once the body is laid out: the observer's first notification. */
  function laidOut(): void {
    act(() => fireResize())
  }

  function userScrollTo(top: number): void {
    act(() => dispatchWheel(body(), top < body().scrollTop ? -120 : 120))
    body().scrollTop = top
    act(() => dispatchScroll(body()))
    clock += 1000
  }

  beforeEach(async () => {
    restoreGeometry = installScrollGeometry()
    setDefaultGeometry({ scrollHeight: 1500, clientHeight: 400 })
    clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)

    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [taskMessage()],
          subagentMessages: {
            [TOOL_USE_ID]: [
              {
                id: 'sub-1',
                role: 'assistant',
                content: [{ type: 'text', text: 'looking around' }],
                timestamp: 1
              }
            ]
          }
        }
      }
    }))
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
    vi.restoreAllMocks()
    restoreGeometry()
  })

  it('opens at the bottom and follows layout-only growth of its content', () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    laidOut()
    expect(distanceFromBottom(body())).toBe(0)

    growLayoutOnly(800)
    expect(distanceFromBottom(body())).toBe(0)
    growLayoutOnly(120)
    expect(distanceFromBottom(body())).toBe(0)
    expect(screen.queryByTestId('TaskEntry.scrollToBottom')).toBeNull()
  })

  it('stops following when the user scrolls up, and the button re-arms it', () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    laidOut()

    userScrollTo(300)
    expect(screen.getByTestId('TaskEntry.scrollToBottom')).toBeInTheDocument()
    growLayoutOnly(500)
    expect(distanceFromBottom(body())).toBe(2000 - 400 - 300)

    fireEvent.click(screen.getByTestId('TaskEntry.scrollToBottom'))
    expect(screen.queryByTestId('TaskEntry.scrollToBottom')).toBeNull()
    // The click's animation is aimed at the bottom as it was; growth finishes it.
    growLayoutOnly(300)
    expect(distanceFromBottom(body())).toBe(0)
    growLayoutOnly(300)
    expect(distanceFromBottom(body())).toBe(0)
  })

  it('does not treat its own scroll events as the user leaving', () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    laidOut()
    userScrollTo(300)
    fireEvent.click(screen.getByTestId('TaskEntry.scrollToBottom'))
    // Mid-animation scroll events, well over 40px from the bottom, long after any input.
    for (const top of [450, 700, 950]) {
      body().scrollTop = top
      act(() => dispatchScroll(body()))
    }
    expect(screen.queryByTestId('TaskEntry.scrollToBottom')).toBeNull()
  })

  it('re-attaches when the body is collapsed and expanded again', () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    fireEvent.click(screen.getByTestId('TaskEntry.toggle'))
    expect(screen.queryByTestId('TaskEntry.body')).toBeNull()

    fireEvent.click(screen.getByTestId('TaskEntry.toggle'))
    laidOut()
    expect(distanceFromBottom(body())).toBe(0)
    growLayoutOnly(600)
    expect(distanceFromBottom(body())).toBe(0)
  })
})

describe('TaskEntry — a SubagentHandback report (S6)', () => {
  let app: TestApp

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
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const ended = (extra: {
    summary: string
    handback?: 'send' | 'flagged' | 'withheld'
    warning?: string
  }): void => {
    seed.taskNotification(ROUTE, {
      taskId: 'task-abc123',
      toolUseId: TOOL_USE_ID,
      status: 'completed',
      outputFile: '',
      ...extra
    })
  }

  it('shows the report, with a flagged warning above it', () => {
    ended({ summary: 'Found 3 files.', handback: 'flagged', warning: 'SECURITY WARNING: x' })
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    const warning = screen.getByTestId('HandbackReport.warning')
    const text = screen.getByTestId('HandbackReport.text')
    expect(text).toHaveTextContent('Found 3 files.')
    expect(warning.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a withheld hand-back as "ended without delivering a report"', () => {
    ended({ summary: 'ignored', handback: 'withheld' })
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    expect(screen.getByTestId('HandbackReport.withheld')).toHaveTextContent(
      'ended without delivering a report'
    )
  })

  it('shows nothing for a notification without a hand-back', () => {
    ended({ summary: 'Found 3 files.' })
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    expect(screen.queryByTestId('HandbackReport')).not.toBeInTheDocument()
  })
})

/**
 * ADR-102 Arc 2: the content-first load leaves a subagent's transcript on disk until
 * it is needed. The entry (expanded by default) asks for it at once and says
 * "Loading…" in place of the result text it would otherwise flash.
 */
describe('TaskEntry — subagent transcript on its way (ADR-102 Arc 2)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    requestSubagentTranscript.mockClear()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [
            taskMessage(),
            {
              id: 'user-1',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  toolUseId: TOOL_USE_ID,
                  toolResult: 'The audit found 3 issues',
                  isError: false
                }
              ],
              timestamp: 1
            } as ChatMessage
          ],
          subagentIndex: {
            [TOOL_USE_ID]: { agentId: 'agent-x', parentToolUseId: null, bytes: 900, order: 1 }
          }
        }
      }
    }))
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('requests its bucket and shows "Loading…", not the markdown result', () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(requestSubagentTranscript).toHaveBeenCalledWith(ROUTE, TOOL_USE_ID)
    expect(screen.getByTestId('TaskEntry.subagentLoading')).toHaveTextContent('Loading…')
    expect(screen.queryByTestId('md')).toBeNull()
  })

  it('shows the transcript once the bucket lands', async () => {
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)
    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ROUTE]: {
            ...state.sessions[ROUTE],
            subagentMessages: {
              [TOOL_USE_ID]: [
                {
                  id: 'b1',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'on it' }],
                  timestamp: 1
                }
              ]
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
    })

    expect(screen.queryByTestId('TaskEntry.subagentLoading')).toBeNull()
    expect(screen.getByText('on it')).toBeInTheDocument()
  })

  it('falls back to the result when the load gave the transcript up (entry zeroed)', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          subagentIndex: {
            [TOOL_USE_ID]: { agentId: 'agent-x', parentToolUseId: null, bytes: 0, order: 1 }
          }
        }
      }
    }))
    render(<TaskEntry toolUseId={TOOL_USE_ID} />)

    expect(requestSubagentTranscript).not.toHaveBeenCalled()
    expect(screen.queryByTestId('TaskEntry.subagentLoading')).toBeNull()
    expect(screen.getByTestId('md')).toHaveTextContent('The audit found 3 issues')
  })
})
