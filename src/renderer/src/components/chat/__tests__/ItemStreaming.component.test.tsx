import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../../stores/session-store'
import { TaskCard } from '../TaskCard'
import { MessageBubble } from '../MessageBubble'
import { TaskEntry } from '../../TaskDetailPanel/TaskEntry'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

let app: TestApp
const owner = 'spawn-card'
const block: Extract<ContentBlock, { type: 'tool_use' }> = {
  type: 'tool_use',
  toolUseId: owner,
  toolName: 'task',
  toolInput: { description: 'Child work' }
}
const view = { kind: 'task' as const, description: 'Child work', prompt: '', subagent: 'worker' }
const message = (text: string): ChatMessage => ({
  id: 'child-answer',
  role: 'assistant',
  timestamp: 1,
  content: [{ type: 'text', text }]
})
beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.getState().createNewSession('r', '/fixture')
  app.emit('session:message', 'r', {
    id: 'spawn',
    role: 'assistant',
    timestamp: 1,
    content: [block]
  })
})
afterEach(() => app.teardown())
it('updates the matching child card and detail panel in place, then replaces with the final answer', () => {
  const target = { ownerToolUseId: owner, messageId: 'child-answer', blockIndex: 0, kind: 'text' }
  act(() => {
    app.emit('session:item-open', 'r', { target, message: message('') })
    app.emit('session:item-delta', 'r', { target, chunk: 'Child preview' })
  })
  render(
    <>
      <TaskCard block={block} view={view} />
      <TaskEntry toolUseId={owner} />
    </>
  )
  fireEvent.click(screen.getByTestId('TaskCard.expand'))
  expect(screen.getAllByText('Child preview')).toHaveLength(2)
  act(() => {
    const other = { ...target, ownerToolUseId: 'other-card' }
    app.emit('session:item-open', 'r', { target: other, message: message('') })
    app.emit('session:item-delta', 'r', { target: other, chunk: 'Different child' })
    app.emit('session:item-delta', 'r', { target, chunk: ' continues' })
  })
  expect(screen.queryByText('Different child')).not.toBeInTheDocument()
  expect(screen.getAllByText('Child preview continues')).toHaveLength(2)
  act(() =>
    app.emit('session:item-seal', 'r', {
      target,
      ownerToolUseId: owner,
      message: message('Final child answer')
    })
  )
  expect(screen.queryByText('Child preview continues')).not.toBeInTheDocument()
  expect(screen.getAllByText('Final child answer')).toHaveLength(2)
  expect(Object.values(useSessionStore.getState().sessions.r.itemStreams)).toHaveLength(1)
})

it('keeps committed text, active thinking, and active text in stable item-slot order', () => {
  const scaffold: ChatMessage = {
    id: 'ordered-child',
    role: 'assistant',
    timestamp: 1,
    content: [
      { type: 'text', text: 'Committed first' },
      { type: 'thinking', text: '' },
      { type: 'text', text: '' }
    ]
  }
  const thinking = {
    ownerToolUseId: owner,
    messageId: scaffold.id,
    blockIndex: 1,
    kind: 'thinking'
  } as const
  const text = {
    ownerToolUseId: owner,
    messageId: scaffold.id,
    blockIndex: 2,
    kind: 'text'
  } as const
  act(() => {
    app.emit('session:item-open', 'r', { target: thinking, message: scaffold })
    app.emit('session:item-delta', 'r', { target: thinking, chunk: 'Working it through' })
    app.emit('session:item-open', 'r', { target: text, message: scaffold })
    app.emit('session:item-delta', 'r', { target: text, chunk: 'Answering now' })
  })
  render(
    <>
      <TaskCard block={block} view={view} />
      <TaskEntry toolUseId={owner} />
    </>
  )
  fireEvent.click(screen.getByTestId('TaskCard.expand'))

  const outputs = screen.getAllByTestId('SubagentMessages')
  expect(outputs).toHaveLength(2)
  for (const output of outputs) {
    const committed = within(output).getByText('Committed first')
    const thinkingToggle = within(output).getByTestId('SubagentMessages.thinkingToggle')
    const activeText = within(output).getByText('Answering now')
    expect(
      committed.compareDocumentPosition(thinkingToggle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      thinkingToggle.compareDocumentPosition(activeText) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(thinkingToggle)
    expect(within(output).getByText('Working it through')).toBeInTheDocument()
  }
})

it('seeds the live thinking timer from the item open, not from the message', () => {
  // A thinking block that starts AFTER a tool call: the message was created
  // long before the thought, so timing from `message.timestamp` reads minutes
  // high. The open's own clock is what the bubble must use.
  vi.useFakeTimers()
  try {
    vi.setSystemTime(100_000)
    const thinker: ChatMessage = {
      id: 'thinker',
      role: 'assistant',
      timestamp: 40_000,
      content: [
        { type: 'text', text: 'Preamble' },
        { type: 'thinking', text: 'weighing it' }
      ]
    }
    const { rerender } = render(
      <MessageBubble
        message={thinker}
        pendingApprovals={[]}
        isLastAssistant={true}
        activeThinking={[{ index: 1, startedAt: 95_000 }]}
      />
    )
    expect(screen.getByTestId('ThinkingBlock.toggle').textContent).toContain('(5s)')

    // Without a measured start the old behaviour stands: the message timestamp.
    rerender(
      <MessageBubble
        message={thinker}
        pendingApprovals={[]}
        isLastAssistant={true}
        activeThinking={[{ index: 1 }]}
      />
    )
    expect(screen.getByTestId('ThinkingBlock.toggle').textContent).toContain('(60s)')
  } finally {
    vi.useRealTimers()
  }
})
