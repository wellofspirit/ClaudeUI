import { describe, it, expect } from 'vitest'
import { isHiddenNote, withoutHiddenNotes } from '../hidden-notes'
import type { ChatMessage, ContentBlock } from '../../../../shared/types'

const OFF = { hideTaskNotifications: false, hideSessionMessages: false }
const TASK = { hideTaskNotifications: true, hideSessionMessages: false }
const SESSION = { hideTaskNotifications: false, hideSessionMessages: true }
const BOTH = { hideTaskNotifications: true, hideSessionMessages: true }

const note = (extra: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'context_note', title: 't', fragments: [{ text: 'x' }], ...extra }) as ContentBlock
const sys = (id: string, content: ContentBlock[]): ChatMessage => ({
  id,
  role: 'system',
  content,
  timestamp: 1
})

describe('isHiddenNote', () => {
  it.each([
    ['task', OFF, false],
    ['task', TASK, true],
    ['task', SESSION, false],
    ['task', BOTH, true],
    ['session-message', OFF, false],
    ['session-message', TASK, false],
    ['session-message', SESSION, true],
    ['session-message', BOTH, true]
  ] as const)('source %s with %j -> %s', (source, opts, hidden) => {
    expect(isHiddenNote(note({ source }), opts)).toBe(hidden)
  })

  it('never hides an alert, whatever the toggles', () => {
    expect(isHiddenNote(note({ source: 'task', alert: true }), BOTH)).toBe(false)
    expect(isHiddenNote(note({ source: 'session-message', alert: true }), BOTH)).toBe(false)
  })

  it('never hides a note with no source, or a non-note block', () => {
    expect(isHiddenNote(note(), BOTH)).toBe(false)
    expect(isHiddenNote({ type: 'text', text: 'hi' }, BOTH)).toBe(false)
  })
})

describe('withoutHiddenNotes', () => {
  it('returns the same array when both toggles are off', () => {
    const messages = [sys('a', [note({ source: 'task' })])]
    expect(withoutHiddenNotes(messages, OFF)).toBe(messages)
  })

  it('returns the same array when a toggle is on but nothing matches', () => {
    const messages = [sys('a', [note({ source: 'session-message' })]), sys('b', [note()])]
    expect(withoutHiddenNotes(messages, TASK)).toBe(messages)
  })

  it('drops a system message whose only blocks were hidden notes', () => {
    const keep = sys('keep', [note({ source: 'session-message' })])
    const out = withoutHiddenNotes([sys('gone', [note({ source: 'task' })]), keep], TASK)
    expect(out).toEqual([keep])
  })

  it('keeps the other blocks of a mixed system message', () => {
    const other: ContentBlock = { type: 'text', text: 'kept' }
    const out = withoutHiddenNotes([sys('m', [note({ source: 'task' }), other])], TASK)
    expect(out).toHaveLength(1)
    expect(out[0].content).toEqual([other])
  })

  it('leaves non-system messages untouched', () => {
    const user: ChatMessage = {
      id: 'u',
      role: 'user',
      content: [note({ source: 'task' })],
      timestamp: 1
    }
    const messages = [user]
    expect(withoutHiddenNotes(messages, BOTH)).toBe(messages)
  })

  it('does not hide an alert note inside a message', () => {
    const messages = [sys('a', [note({ source: 'task', alert: true })])]
    expect(withoutHiddenNotes(messages, BOTH)).toBe(messages)
  })
})
