import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../../stores/session-store'
import { TaskCard } from '../TaskCard'
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
