/**
 * Layer 1: buildSentFilesFromMessages — the SendUserFile → Files-widget derive.
 *
 * Mirrors build-todos.test.ts. The contract that matters:
 *  - derived purely from the transcript (so it survives resumption for free),
 *  - null when there is nothing to say (a rebuild must not clobber state),
 *  - cumulative, latest-send-wins per path,
 *  - in-flight calls (no tool_result yet) are still listed.
 */

import { describe, it, expect } from 'vitest'
import { buildSentFilesFromMessages } from '../session-store'
import type { ChatMessage } from '../../../../shared/types'

function msg(role: 'user' | 'assistant', ...blocks: ChatMessage['content']): ChatMessage {
  return { id: `msg-${Math.random()}`, role, content: blocks.flat(), timestamp: Date.now() }
}

function toolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = `tu-${Math.random()}`
): ChatMessage['content'][0] {
  return { type: 'tool_use', toolUseId, toolName, toolInput }
}

function toolResult(toolUseId: string, result: string, isError = false): ChatMessage['content'][0] {
  return { type: 'tool_result', toolUseId, toolResult: result, isError }
}

describe('buildSentFilesFromMessages', () => {
  it('returns null when no SendUserFile calls exist', () => {
    const messages = [
      msg('user', { type: 'text', text: 'hello' }),
      msg('assistant', toolUse('Read', { file_path: '/a.txt' }))
    ]
    expect(buildSentFilesFromMessages(messages)).toBeNull()
  })

  it('extracts a delivered file with caption and display', () => {
    const tu = 'tu-1'
    const messages = [
      msg(
        'assistant',
        toolUse(
          'SendUserFile',
          { files: ['report.html'], caption: 'Here is the report', display: 'render' },
          tu
        ),
        toolResult(tu, '1 file(s) delivered to user.')
      )
    ]
    expect(buildSentFilesFromMessages(messages)).toEqual([
      { path: 'report.html', caption: 'Here is the report', display: 'render', toolUseId: tu }
    ])
  })

  it('coerces a bare string `files` to a single entry', () => {
    const tu = 'tu-str'
    const messages = [
      msg('assistant', toolUse('SendUserFile', { files: 'chart.png' }, tu), toolResult(tu, 'ok'))
    ]
    const result = buildSentFilesFromMessages(messages)
    expect(result).toEqual([{ path: 'chart.png', toolUseId: tu }])
  })

  it('expands a multi-file call in order and skips empty/non-string entries', () => {
    const tu = 'tu-multi'
    const messages = [
      msg(
        'assistant',
        toolUse('SendUserFile', { files: ['a.txt', '', 42, null, 'b.txt'] }, tu),
        toolResult(tu, '2 file(s) delivered to user.')
      )
    ]
    const result = buildSentFilesFromMessages(messages)
    expect(result?.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('dedupes by path — latest send wins and moves to the end', () => {
    const messages = [
      msg('assistant', toolUse('SendUserFile', { files: ['a.txt'], caption: 'first' }, 'tu-a')),
      msg('assistant', toolUse('SendUserFile', { files: ['b.txt'] }, 'tu-b')),
      msg('assistant', toolUse('SendUserFile', { files: ['a.txt'], caption: 'second' }, 'tu-a2'))
    ]
    const result = buildSentFilesFromMessages(messages)
    expect(result?.map((f) => f.path)).toEqual(['b.txt', 'a.txt'])
    expect(result?.[1]).toEqual({ path: 'a.txt', caption: 'second', toolUseId: 'tu-a2' })
  })

  it('pairs an isError tool_result into `error`', () => {
    const tu = 'tu-err'
    const messages = [
      msg(
        'assistant',
        toolUse('SendUserFile', { files: ['missing.txt'] }, tu),
        toolResult(tu, '  File not found: missing.txt  ', true)
      )
    ]
    const result = buildSentFilesFromMessages(messages)
    expect(result?.[0].error).toBe('File not found: missing.txt')
  })

  it('caps a very long error result', () => {
    const tu = 'tu-long'
    const messages = [
      msg(
        'assistant',
        toolUse('SendUserFile', { files: ['x.txt'] }, tu),
        toolResult(tu, 'E'.repeat(2000), true)
      )
    ]
    expect(buildSentFilesFromMessages(messages)?.[0].error).toHaveLength(500)
  })

  it('does NOT set error for a successful result', () => {
    const tu = 'tu-ok'
    const messages = [
      msg(
        'assistant',
        toolUse('SendUserFile', { files: ['x.txt'] }, tu),
        toolResult(tu, '1 file(s) delivered to user.')
      )
    ]
    expect(buildSentFilesFromMessages(messages)?.[0].error).toBeUndefined()
  })

  it('includes an in-flight call that has no tool_result yet', () => {
    const messages = [msg('assistant', toolUse('SendUserFile', { files: ['pending.txt'] }, 'tu-p'))]
    const result = buildSentFilesFromMessages(messages)
    expect(result).toEqual([{ path: 'pending.txt', toolUseId: 'tu-p' }])
  })

  it('ignores a tool_result whose toolUseId belongs to a different call', () => {
    const messages = [
      msg(
        'assistant',
        toolUse('SendUserFile', { files: ['x.txt'] }, 'tu-mine'),
        toolResult('tu-other', 'unrelated failure', true)
      )
    ]
    expect(buildSentFilesFromMessages(messages)?.[0].error).toBeUndefined()
  })

  it('returns [] (not null) when a SendUserFile call carries no usable paths', () => {
    const messages = [msg('assistant', toolUse('SendUserFile', { files: [] }, 'tu-empty'))]
    expect(buildSentFilesFromMessages(messages)).toEqual([])
  })

  it('ignores user messages', () => {
    const messages = [msg('user', toolUse('SendUserFile', { files: ['fake.txt'] }))]
    expect(buildSentFilesFromMessages(messages)).toBeNull()
  })

  it('drops an unknown `display` value rather than passing it through', () => {
    const messages = [
      msg('assistant', toolUse('SendUserFile', { files: ['x.txt'], display: 'bogus' }, 'tu-d'))
    ]
    expect(buildSentFilesFromMessages(messages)?.[0].display).toBeUndefined()
  })
})
