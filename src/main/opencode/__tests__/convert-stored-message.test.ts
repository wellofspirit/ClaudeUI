/**
 * @vitest-environment node
 *
 * Tests for convertStoredMessage — maps opencode's persisted message+parts shape
 * (GET /session/{id}/message) to a ChatMessage for history replay on resume.
 * Parity with the live-turn buildChatMessage part→block mapping.
 */
import { describe, it, expect } from 'vitest'
import { convertStoredMessage } from '../event-mapper'
import type { StoredMessage } from '../protocol/types'

function msg(role: 'user' | 'assistant' | 'system', parts: StoredMessage['parts'], id = 'm1'): StoredMessage {
  return { info: { id, role, time: { created: 1000 } }, parts }
}

describe('convertStoredMessage', () => {
  it('maps a text part to a text block (assistant)', () => {
    const r = convertStoredMessage(msg('assistant', [{ type: 'text', text: 'hello' }]))
    expect(r).not.toBeNull()
    expect(r!.role).toBe('assistant')
    expect(r!.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(r!.timestamp).toBe(1000)
  })

  it('maps a reasoning part to a thinking block', () => {
    const r = convertStoredMessage(msg('assistant', [{ type: 'reasoning', text: 'thinking…' }]))
    expect(r!.content).toEqual([{ type: 'thinking', text: 'thinking…' }])
  })

  it('maps a completed tool part to tool_use + tool_result (success)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'bash',
          callID: 'call-1',
          state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' }
        }
      ])
    )
    expect(r!.content).toEqual([
      { type: 'tool_use', toolUseId: 'call-1', toolName: 'bash', toolInput: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 'call-1', toolResult: 'a\nb', isError: false }
    ])
  })

  it('maps an errored tool part to tool_result isError=true (from state.error)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        { type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'error', error: 'boom' } }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toEqual({ type: 'tool_result', toolUseId: 'c2', toolResult: 'boom', isError: true })
  })

  it('a running tool part yields only tool_use (no tool_result)', () => {
    const r = convertStoredMessage(
      msg('assistant', [{ type: 'tool', tool: 'bash', callID: 'c3', state: { status: 'running' } }])
    )
    expect(r!.content).toHaveLength(1)
    expect(r!.content[0].type).toBe('tool_use')
  })

  it('preserves user role', () => {
    const r = convertStoredMessage(msg('user', [{ type: 'text', text: 'hi' }]))
    expect(r!.role).toBe('user')
  })

  it('skips system messages (returns null)', () => {
    expect(convertStoredMessage(msg('system', [{ type: 'text', text: 'sys' }]))).toBeNull()
  })

  it('returns null when there is no renderable content', () => {
    expect(convertStoredMessage(msg('assistant', [{ type: 'step-start' }, { type: 'file' }]))).toBeNull()
    expect(convertStoredMessage(msg('assistant', []))).toBeNull()
    expect(convertStoredMessage(msg('assistant', [{ type: 'text', text: '' }]))).toBeNull()
  })

  it('returns null when info.id is missing', () => {
    expect(
      convertStoredMessage({ info: { role: 'assistant' } as never, parts: [{ type: 'text', text: 'x' }] })
    ).toBeNull()
  })

  it('attaches fileDiffs to the tool_result block for a completed apply_patch part', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'apply_patch',
          callID: 'c5',
          state: {
            status: 'completed',
            input: { patchText: '*** Begin Patch ***' },
            output: 'Success. Updated the following files:\nM a.ts',
            metadata: {
              files: [
                { relativePath: 'a.ts', type: 'update', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 }
              ]
            }
          }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({
      type: 'tool_result',
      toolUseId: 'c5',
      fileDiffs: [{ path: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, changeType: 'update' }]
    })
  })

  it('does not attach fileDiffs for a completed bash part (no files/filediff metadata)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'bash',
          callID: 'c6',
          state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', metadata: { output: 'a\nb' } }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result') as { fileDiffs?: unknown }
    expect(result?.fileDiffs).toBeUndefined()
  })

  it('preserves block order for a mixed message and ignores unknown parts', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        { type: 'text', text: 'before' },
        { type: 'step-start' },
        { type: 'tool', tool: 'read', callID: 'c4', state: { status: 'completed', input: {}, output: 'x' } },
        { type: 'text', text: 'after' }
      ])
    )
    expect(r!.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_result', 'text'])
    expect((r!.content[0] as { text: string }).text).toBe('before')
    expect((r!.content[3] as { text: string }).text).toBe('after')
  })
})
