import { describe, it, expect } from 'vitest'
import { buildTodosFromMessages, normalizeCwd } from '../session-store'
import type { ChatMessage } from '../../../../shared/types'

function msg(role: 'user' | 'assistant', ...blocks: ChatMessage['content']): ChatMessage {
  return { id: `msg-${Math.random()}`, role, content: blocks.flat(), timestamp: Date.now() }
}

function toolUse(toolName: string, toolInput: Record<string, unknown>, toolUseId = `tu-${Math.random()}`): ChatMessage['content'][0] {
  return { type: 'tool_use', toolUseId, toolName, toolInput }
}

function toolResult(toolUseId: string, result: string): ChatMessage['content'][0] {
  return { type: 'tool_result', toolUseId, toolResult: result }
}

describe('buildTodosFromMessages', () => {
  it('returns null when no task-related tool calls exist', () => {
    const messages = [
      msg('user', { type: 'text', text: 'hello' }),
      msg('assistant', { type: 'text', text: 'hi' })
    ]
    expect(buildTodosFromMessages(messages)).toBeNull()
  })

  it('builds todos from TodoWrite calls', () => {
    const messages = [
      msg('assistant',
        toolUse('TodoWrite', {
          todos: [
            { content: 'Fix bug', status: 'pending' },
            { content: 'Write tests', status: 'completed' }
          ]
        })
      )
    ]
    const result = buildTodosFromMessages(messages)
    expect(result).toEqual([
      { content: 'Fix bug', status: 'pending', activeForm: '' },
      { content: 'Write tests', status: 'completed', activeForm: '' }
    ])
  })

  it('TodoWrite replaces all previous tasks', () => {
    const messages = [
      msg('assistant',
        toolUse('TodoWrite', {
          todos: [{ content: 'Old task', status: 'pending' }]
        })
      ),
      msg('assistant',
        toolUse('TodoWrite', {
          todos: [{ content: 'New task', status: 'pending' }]
        })
      )
    ]
    const result = buildTodosFromMessages(messages)
    expect(result).toHaveLength(1)
    expect(result![0].content).toBe('New task')
  })

  it('builds todos from TaskCreate with ID from tool_result', () => {
    const tuId = 'tu-create'
    const messages = [
      msg('assistant',
        toolUse('TaskCreate', { subject: 'Implement feature' }, tuId),
        toolResult(tuId, 'Task #abc123 created')
      )
    ]
    const result = buildTodosFromMessages(messages)
    expect(result).toHaveLength(1)
    expect(result![0]).toEqual({ content: 'Implement feature', status: 'pending', activeForm: '' })
  })

  it('TaskUpdate changes status of existing task', () => {
    const tuId = 'tu-create'
    const messages = [
      msg('assistant',
        toolUse('TaskCreate', { subject: 'Do thing' }, tuId),
        toolResult(tuId, 'Task #t1 created')
      ),
      msg('assistant',
        toolUse('TaskUpdate', { taskId: 't1', status: 'completed' })
      )
    ]
    const result = buildTodosFromMessages(messages)
    expect(result).toHaveLength(1)
    expect(result![0].status).toBe('completed')
  })

  it('TaskUpdate with status=deleted removes task', () => {
    const tuId = 'tu-create'
    const messages = [
      msg('assistant',
        toolUse('TaskCreate', { subject: 'Temp task' }, tuId),
        toolResult(tuId, 'Task #t1 created')
      ),
      msg('assistant',
        toolUse('TaskUpdate', { taskId: 't1', status: 'deleted' })
      )
    ]
    const result = buildTodosFromMessages(messages)
    expect(result).toHaveLength(0)
  })

  it('TaskCreate clears completed tasks and starts fresh batch', () => {
    const tu1 = 'tu-1'
    const tu2 = 'tu-2'
    const messages = [
      msg('assistant',
        toolUse('TaskCreate', { subject: 'First' }, tu1),
        toolResult(tu1, 'Task #t1 created')
      ),
      msg('assistant',
        toolUse('TaskUpdate', { taskId: 't1', status: 'completed' })
      ),
      msg('assistant',
        toolUse('TaskCreate', { subject: 'Second batch' }, tu2),
        toolResult(tu2, 'Task #t2 created')
      )
    ]
    const result = buildTodosFromMessages(messages)
    // First task was completed → cleared on new TaskCreate
    expect(result).toHaveLength(1)
    expect(result![0].content).toBe('Second batch')
  })

  it('ignores user messages', () => {
    const messages = [
      msg('user',
        toolUse('TodoWrite', { todos: [{ content: 'Fake', status: 'pending' }] })
      )
    ]
    expect(buildTodosFromMessages(messages)).toBeNull()
  })
})

describe('normalizeCwd', () => {
  it('removes trailing slash', () => {
    expect(normalizeCwd('/home/user/')).toBe('/home/user')
  })

  it('preserves root slash', () => {
    expect(normalizeCwd('/')).toBe('/')
  })

  it('returns . for empty string', () => {
    expect(normalizeCwd('')).toBe('.')
  })

  it('leaves normal paths unchanged', () => {
    expect(normalizeCwd('/home/user')).toBe('/home/user')
  })
})
