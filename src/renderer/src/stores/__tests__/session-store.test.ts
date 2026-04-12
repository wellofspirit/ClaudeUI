import { describe, it, expect } from 'vitest'
import { normalizeCwd, buildTodosFromMessages } from '../session-store'
import type { ChatMessage, ContentBlock } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Replicate cleanupEmptySession logic for testing
// ---------------------------------------------------------------------------

interface MinimalSessionState {
  messages: Array<{ id: string }>
  sdkActive: boolean
  draftText: string
}

function cleanupEmptySession(
  sessions: Record<string, MinimalSessionState>,
  recentSessionIds: string[],
  routingId: string | null
): { sessions: Record<string, MinimalSessionState>; recentSessionIds: string[] } {
  if (!routingId) return { sessions, recentSessionIds }
  const session = sessions[routingId]
  if (!session) return { sessions, recentSessionIds }
  if (session.messages.length > 0 || session.sdkActive || session.draftText) return { sessions, recentSessionIds }
  const { [routingId]: _, ...rest } = sessions
  return {
    sessions: rest,
    recentSessionIds: recentSessionIds.filter((id) => id !== routingId),
  }
}

// ---------------------------------------------------------------------------
// Tests — normalizeCwd (already partially tested in build-todos, but worth
// extending since it's used more broadly in the store)
// ---------------------------------------------------------------------------

describe('normalizeCwd', () => {
  it('strips trailing slash', () => {
    expect(normalizeCwd('/home/user/project/')).toBe('/home/user/project')
  })

  it('preserves root path', () => {
    expect(normalizeCwd('/')).toBe('/')
  })

  it('returns "." for empty string', () => {
    expect(normalizeCwd('')).toBe('.')
  })

  it('passes normal paths through', () => {
    expect(normalizeCwd('/home/user/project')).toBe('/home/user/project')
  })

  it('handles Windows-style paths with trailing slash', () => {
    expect(normalizeCwd('C:/Users/test/')).toBe('C:/Users/test')
  })

  it('does not strip single character paths ending in /', () => {
    // length > 1 check: "/" stays as-is
    expect(normalizeCwd('/')).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// Tests — buildTodosFromMessages (extending existing coverage)
// ---------------------------------------------------------------------------

describe('buildTodosFromMessages', () => {
  function makeAssistantMsg(content: ContentBlock[]): ChatMessage {
    return { id: 'msg-1', role: 'assistant', content, timestamp: Date.now() }
  }

  it('returns null when no task tool calls found', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 },
    ]
    expect(buildTodosFromMessages(messages)).toBeNull()
  })

  it('builds todos from TodoWrite', () => {
    const messages: ChatMessage[] = [
      makeAssistantMsg([{
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Task 1', status: 'completed' },
            { content: 'Task 2', status: 'pending' },
          ],
        },
      }]),
    ]

    const result = buildTodosFromMessages(messages)!
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('Task 1')
    expect(result[0].status).toBe('completed')
    expect(result[1].content).toBe('Task 2')
    expect(result[1].status).toBe('pending')
  })

  it('TodoWrite replaces all previous tasks', () => {
    const messages: ChatMessage[] = [
      makeAssistantMsg([{
        type: 'tool_use', toolUseId: 'tu-1', toolName: 'TodoWrite',
        toolInput: { todos: [{ content: 'Old task', status: 'pending' }] },
      }]),
      makeAssistantMsg([{
        type: 'tool_use', toolUseId: 'tu-2', toolName: 'TodoWrite',
        toolInput: { todos: [{ content: 'New task', status: 'pending' }] },
      }]),
    ]

    const result = buildTodosFromMessages(messages)!
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('New task')
  })

  it('TaskUpdate can delete a task', () => {
    const messages: ChatMessage[] = [
      makeAssistantMsg([
        {
          type: 'tool_use', toolUseId: 'tu-1', toolName: 'TaskCreate',
          toolInput: { subject: 'Task A' },
        },
        { type: 'tool_result', toolUseId: 'tu-1', toolResult: 'Task #abc created', isError: false },
      ]),
      makeAssistantMsg([{
        type: 'tool_use', toolUseId: 'tu-2', toolName: 'TaskUpdate',
        toolInput: { taskId: 'abc', status: 'deleted' },
      }]),
    ]

    const result = buildTodosFromMessages(messages)!
    expect(result).toHaveLength(0)
  })

  it('TaskUpdate can update status and subject', () => {
    const messages: ChatMessage[] = [
      makeAssistantMsg([
        {
          type: 'tool_use', toolUseId: 'tu-1', toolName: 'TaskCreate',
          toolInput: { subject: 'Original' },
        },
        { type: 'tool_result', toolUseId: 'tu-1', toolResult: 'Task #xyz created', isError: false },
      ]),
      makeAssistantMsg([{
        type: 'tool_use', toolUseId: 'tu-2', toolName: 'TaskUpdate',
        toolInput: { taskId: 'xyz', status: 'completed', subject: 'Updated' },
      }]),
    ]

    const result = buildTodosFromMessages(messages)!
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('completed')
    expect(result[0].content).toBe('Updated')
  })

  it('ignores user messages', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1', role: 'user', content: [{
          type: 'tool_use', toolUseId: 'tu-1', toolName: 'TodoWrite',
          toolInput: { todos: [{ content: 'Task', status: 'pending' }] },
        }], timestamp: 1,
      },
    ]
    expect(buildTodosFromMessages(messages)).toBeNull()
  })

  it('TaskCreate starts fresh when all existing tasks are completed', () => {
    const messages: ChatMessage[] = [
      makeAssistantMsg([
        {
          type: 'tool_use', toolUseId: 'tu-1', toolName: 'TaskCreate',
          toolInput: { subject: 'Old Task' },
        },
        { type: 'tool_result', toolUseId: 'tu-1', toolResult: 'Task #old1 created', isError: false },
      ]),
      makeAssistantMsg([{
        type: 'tool_use', toolUseId: 'tu-2', toolName: 'TaskUpdate',
        toolInput: { taskId: 'old1', status: 'completed' },
      }]),
      makeAssistantMsg([
        {
          type: 'tool_use', toolUseId: 'tu-3', toolName: 'TaskCreate',
          toolInput: { subject: 'New Task' },
        },
        { type: 'tool_result', toolUseId: 'tu-3', toolResult: 'Task #new1 created', isError: false },
      ]),
    ]

    const result = buildTodosFromMessages(messages)!
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('New Task')
  })
})

// ---------------------------------------------------------------------------
// Tests — cleanupEmptySession
// ---------------------------------------------------------------------------

describe('cleanupEmptySession', () => {
  it('removes session with no messages, not active, no draft', () => {
    const sessions = {
      'r1': { messages: [], sdkActive: false, draftText: '' },
    }
    const result = cleanupEmptySession(sessions, ['r1'], 'r1')
    expect(result.sessions).not.toHaveProperty('r1')
    expect(result.recentSessionIds).not.toContain('r1')
  })

  it('preserves session with messages', () => {
    const sessions = {
      'r1': { messages: [{ id: 'm1' }], sdkActive: false, draftText: '' },
    }
    const result = cleanupEmptySession(sessions, ['r1'], 'r1')
    expect(result.sessions).toHaveProperty('r1')
  })

  it('preserves session with active SDK', () => {
    const sessions = {
      'r1': { messages: [], sdkActive: true, draftText: '' },
    }
    const result = cleanupEmptySession(sessions, ['r1'], 'r1')
    expect(result.sessions).toHaveProperty('r1')
  })

  it('preserves session with draft text', () => {
    const sessions = {
      'r1': { messages: [], sdkActive: false, draftText: 'typing...' },
    }
    const result = cleanupEmptySession(sessions, ['r1'], 'r1')
    expect(result.sessions).toHaveProperty('r1')
  })

  it('returns unchanged when routingId is null', () => {
    const sessions = { 'r1': { messages: [], sdkActive: false, draftText: '' } }
    const result = cleanupEmptySession(sessions, ['r1'], null)
    expect(result.sessions).toHaveProperty('r1')
  })

  it('returns unchanged when routingId not found', () => {
    const sessions = { 'r1': { messages: [], sdkActive: false, draftText: '' } }
    const result = cleanupEmptySession(sessions, ['r1'], 'r2')
    expect(result.sessions).toHaveProperty('r1')
  })
})
