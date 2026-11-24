/**
 * Layer 2: SubagentMessages honours the display-only note toggles, and a message
 * made only of hidden notes leaves no wrapper (no empty gap in the column).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import { SubagentMessages } from '../SubagentMessages'

const defaultSettings = useSessionStore.getState().settings

const note = (extra: Record<string, unknown>): ContentBlock =>
  ({ type: 'context_note', title: 't', fragments: [{ text: 'x' }], ...extra }) as ContentBlock
const msg = (id: string, content: ContentBlock[]): ChatMessage => ({
  id,
  role: 'user',
  content,
  timestamp: 1
})

const MESSAGES = [
  msg('only-task', [note({ source: 'task' })]),
  msg('mixed', [note({ source: 'session-message' }), note({})]),
  msg('alert', [note({ source: 'task', alert: true })])
]

describe('SubagentMessages — hidden notes', () => {
  afterEach(() => useSessionStore.setState({ settings: defaultSettings }))

  it('renders every note when nothing is hidden', () => {
    render(<SubagentMessages messages={MESSAGES} />)
    expect(screen.getAllByTestId('SubagentMessage')).toHaveLength(3)
    expect(screen.getAllByTestId('ContextNoteBlock')).toHaveLength(4)
  })

  it('drops a message of only hidden notes, keeps the rest', () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, hideTaskNotifications: true, hideSessionMessages: true }
    }))
    render(<SubagentMessages messages={MESSAGES} />)
    expect(screen.getAllByTestId('SubagentMessage').map((el) => el.dataset.id)).toEqual([
      'mixed',
      'alert'
    ])
    // mixed keeps its untagged note; the alert stays.
    expect(screen.getAllByTestId('ContextNoteBlock')).toHaveLength(2)
  })
})
