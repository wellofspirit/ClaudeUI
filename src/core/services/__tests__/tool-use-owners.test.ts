/**
 * @vitest-environment node
 *
 * Who made a tool call, from the stream (session tools, slice 1c): a tool_use
 * block in a frame without subagent markers is the root agent's, one in a frame
 * with `parent_tool_use_id` / `agent_id` is a subagent's, a subagent verdict is
 * final, and a call nothing announced is `unknown` after a short wait.
 */
import { describe, expect, it } from 'vitest'
import { ToolUseOwners } from '../tool-use-owners'

const assistant = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id, name: 'x' }
    ]
  },
  ...over
})

describe('ToolUseOwners', () => {
  it('reads the root agent’s tool_use from an assistant frame and from a stream start', async () => {
    const o = new ToolUseOwners()
    o.noteFrame(assistant('tu-1', { parent_tool_use_id: null }))
    o.noteFrame({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu-2' } }
    })
    expect(await o.ownerOf('tu-1', 0)).toBe('root')
    expect(await o.ownerOf('tu-2', 0)).toBe('root')
  })

  it('reads a subagent’s by parent_tool_use_id or agent_id, in either frame kind', async () => {
    const o = new ToolUseOwners()
    o.noteFrame(assistant('tu-a', { parent_tool_use_id: 'toolu_agent' }))
    o.noteFrame(assistant('tu-b', { agent_id: 'a1b2' }))
    o.noteFrame(assistant('tu-t', { teammate_id: 'mate-1' }))
    o.noteFrame({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_agent',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu-c' } }
    })
    for (const id of ['tu-a', 'tu-b', 'tu-c', 'tu-t'])
      expect(await o.ownerOf(id, 0), id).toBe('subagent')
  })

  it('a subagent verdict is final; a root one can still be corrected', async () => {
    const o = new ToolUseOwners()
    o.note('tu-1', false)
    o.note('tu-1', true)
    o.note('tu-1', false)
    expect(await o.ownerOf('tu-1', 0)).toBe('subagent')
  })

  it('ignores frames that announce no tool, and malformed ones', async () => {
    const o = new ToolUseOwners()
    o.noteFrame({ type: 'assistant', message: { content: 'plain text' } })
    o.noteFrame({ type: 'assistant' })
    o.noteFrame({ type: 'stream_event', event: { type: 'content_block_delta' } })
    o.noteFrame({ type: 'user', message: { content: [{ type: 'tool_use', id: 'tu-x' }] } })
    expect(await o.ownerOf('tu-x', 0)).toBe('unknown')
  })

  it('an unknown or missing id is unknown, after waiting for the frame', async () => {
    const o = new ToolUseOwners()
    const started = Date.now()
    expect(await o.ownerOf('never-seen', 60)).toBe('unknown')
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(await o.ownerOf(undefined, 60)).toBe('unknown')
  })

  it('a frame that arrives while the call waits attributes it', async () => {
    const o = new ToolUseOwners()
    const pending = o.ownerOf('tu-late', 500)
    setTimeout(() => o.noteFrame(assistant('tu-late', { parent_tool_use_id: 'toolu_agent' })), 40)
    expect(await pending).toBe('subagent')
    const rootPending = o.ownerOf('tu-late-root', 500)
    setTimeout(() => o.noteFrame(assistant('tu-late-root', { parent_tool_use_id: null })), 40)
    expect(await rootPending).toBe('root')
  })
})

describe('ownerNow', () => {
  it('answers from what the stream has said so far, without waiting', () => {
    const owners = new ToolUseOwners()
    expect(owners.ownerNow('toolu_x')).toBeUndefined()
    owners.noteFrame({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'a', input: {} }] }
    })
    owners.noteFrame({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { content: [{ type: 'tool_use', id: 'toolu_y', name: 'a', input: {} }] }
    })
    expect(owners.ownerNow('toolu_x')).toBe('root')
    expect(owners.ownerNow('toolu_y')).toBe('subagent')
  })
})
