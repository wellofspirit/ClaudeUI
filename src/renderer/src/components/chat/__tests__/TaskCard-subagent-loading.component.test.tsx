/**
 * ADR-102 Arc 2 — a TaskCard whose subagent transcript is still on disk.
 *
 * The content-first load fetches buckets in the background, so an agent the index
 * lists (bytes > 0) can be on screen before its bucket is. Opening the card must
 * (a) request that bucket at once, (b) say "Loading…" rather than flash the
 * markdown result body and swap it, and (c) keep the failure summary steady. An
 * agent the load gave up on (index entry zeroed) falls back to the result it had.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
const { requestSubagentTranscript } = vi.hoisted(() => ({ requestSubagentTranscript: vi.fn() }))
vi.mock('../../../lib/subagent-prefetch', () => ({ requestSubagentTranscript }))

import { TaskCard } from '../TaskCard'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-taskcard-loading'
const TOOL_USE_ID = 'call_task_loading'

const block = {
  type: 'tool_use',
  toolUseId: TOOL_USE_ID,
  toolName: 'Task',
  toolInput: { description: 'Audit the importer' }
} as ToolUseBlock
const view = { kind: 'task' as const, description: 'Audit the importer', prompt: '', subagent: '' }
const finished = (isError = false): never =>
  ({
    type: 'tool_result',
    toolUseId: TOOL_USE_ID,
    toolResult: 'The audit found 3 issues',
    isError
  }) as never

const bucket: ChatMessage[] = [
  { id: 'b1', role: 'assistant', content: [{ type: 'text', text: 'working on it' }], timestamp: 1 }
]

function patchSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [ROUTE]: { ...s.sessions[ROUTE], ...patch } }
  }))
  mirrorStoreIntoReplica()
}
const listed = (bytes: number): Record<string, unknown> => ({
  [TOOL_USE_ID]: { agentId: 'agent-x', parentToolUseId: null, bytes, order: 1 }
})

describe('TaskCard — subagent transcript on its way (ADR-102 Arc 2)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    requestSubagentTranscript.mockClear()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    patchSession({ isHistorical: true })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const open = (): void => {
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
  }

  it('asks for the bucket when the card is expanded, not before', () => {
    patchSession({ subagentIndex: listed(900) })
    render(<TaskCard block={block} result={finished()} view={view} />)
    expect(requestSubagentTranscript).not.toHaveBeenCalled()

    open()
    expect(requestSubagentTranscript).toHaveBeenCalledWith(ROUTE, TOOL_USE_ID)
  })

  it('shows "Loading…" instead of the markdown result, then the transcript once it lands', async () => {
    patchSession({ subagentIndex: listed(900) })
    render(<TaskCard block={block} result={finished()} view={view} />)
    open()

    expect(screen.getByTestId('TaskCard.subagentLoading')).toHaveTextContent('Loading…')
    // No flash of the result body that the transcript would replace.
    expect(screen.queryByTestId('md')).toBeNull()

    await act(async () => {
      patchSession({ subagentMessages: { [TOOL_USE_ID]: bucket } })
    })

    expect(screen.queryByTestId('TaskCard.subagentLoading')).toBeNull()
    expect(screen.getByText('working on it')).toBeInTheDocument()
  })

  it('keeps the failure summary steady: it is there while loading, not popped in after', () => {
    patchSession({ subagentIndex: listed(900) })
    render(<TaskCard block={block} result={finished(true)} view={view} />)
    open()

    expect(screen.getByTestId('TaskCard.subagentLoading')).toBeInTheDocument()
    expect(screen.getByTestId('TaskCard.failureSummary')).toHaveTextContent(
      'The audit found 3 issues'
    )
  })

  it('an agent the load gave up on (index entry zeroed) falls back to its result, asking for nothing', () => {
    patchSession({ subagentIndex: listed(0) })
    render(<TaskCard block={block} result={finished()} view={view} />)
    open()

    expect(requestSubagentTranscript).not.toHaveBeenCalled()
    expect(screen.queryByTestId('TaskCard.subagentLoading')).toBeNull()
    expect(screen.getByTestId('md')).toHaveTextContent('The audit found 3 issues')
  })

  it('without an index (another engine, an unloaded entry) nothing changes', () => {
    render(<TaskCard block={block} result={finished()} view={view} />)
    open()

    expect(requestSubagentTranscript).not.toHaveBeenCalled()
    expect(screen.queryByTestId('TaskCard.subagentLoading')).toBeNull()
    expect(screen.getByTestId('md')).toBeInTheDocument()
  })
})
