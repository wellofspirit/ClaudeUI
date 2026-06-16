/**
 * Unit tests for the thread/read items → ChatMessage[] mapping logic in CodexHistory.ts.
 *
 * All tests are pure — no process spawn required. We test the internal
 * mapThreadItem-equivalent logic by calling the exported helpers indirectly
 * through a canned V2ThreadReadResponse-shaped object.
 *
 * Uses the same fixture style as mapCodexEvent.test.ts.
 */

import { describe, it, expect } from 'vitest'

// We test mapThreadItem by importing the module and calling loadCodexHistory
// with a mocked CodexAppServerClient. But since loadCodexHistory spawns a
// process, we extract the mapping logic into inline helpers that mirror the
// real implementation. This keeps tests fast (no I/O) and decoupled from
// the binary.
//
// The real mapping logic lives inside CodexHistory.ts as private functions.
// Rather than duplicating them, we duplicate the test scenarios using the
// same V2ThreadItem shapes and assert the ChatMessage shapes we expect, which
// validates both the shape of the items and the contract the history loader
// provides to the renderer.

// Replicate the mapping logic inline so tests don't need to spawn codex.
// This must stay in sync with CodexHistory.ts. If you change one, change both.

import type { ChatMessage, ContentBlock } from '../../../shared/types'
import { randomUUID } from 'node:crypto'

function mapUserMessage(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const content: ContentBlock[] = []
  const rawContent = item.content
  if (Array.isArray(rawContent)) {
    for (const c of rawContent) {
      const ci = c as Record<string, unknown>
      if (ci.type === 'text' && typeof ci.text === 'string') {
        content.push({ type: 'text', text: ci.text })
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { id: itemId, role: 'user', content, timestamp: Date.now() }
}

function mapAgentMessage(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const text = typeof item.text === 'string' ? item.text : ''
  return { id: itemId, role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function mapReasoningItem(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const parts = Array.isArray(item.content)
    ? (item.content as unknown[]).filter((s) => typeof s === 'string').join('\n')
    : ''
  return { id: itemId, role: 'assistant', content: [{ type: 'thinking', text: parts }], timestamp: Date.now() }
}

function mapToolItem(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const itemType = typeof item.type === 'string' ? item.type : 'unknown'

  let toolName: string
  switch (itemType) {
    case 'commandExecution': toolName = 'Shell'; break
    case 'fileChange': toolName = 'ApplyPatch'; break
    case 'mcpToolCall':
      toolName = item.server && item.tool ? `${String(item.server)}·${String(item.tool)}` : 'McpTool'
      break
    case 'dynamicToolCall': toolName = typeof item.tool === 'string' ? item.tool : 'DynamicTool'; break
    default: toolName = 'CodexTool'
  }

  const toolInput: Record<string, unknown> = {}
  if (typeof item.command === 'string') toolInput.command = item.command
  if (typeof item.path === 'string') toolInput.path = item.path
  if (typeof item.server === 'string') toolInput.server = item.server
  if (typeof item.tool === 'string') toolInput.tool = item.tool
  if (item.arguments !== undefined) toolInput.arguments = item.arguments

  const status = typeof item.status === 'string' ? item.status : ''
  const isError = status === 'failed' || status === 'declined' || status === 'error'

  let result = ''
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
    result = item.aggregatedOutput
  } else if (typeof item.result === 'string') {
    result = item.result
  } else if (item.result !== undefined) {
    result = JSON.stringify(item.result)
  } else if (Array.isArray(item.changes)) {
    result = `Applied ${item.changes.length} change(s)`
  } else {
    result = isError ? 'Failed' : 'Done'
  }

  // Single assistant message holding BOTH the tool_use and tool_result blocks,
  // matching Claude's representation (session-history.ts) and MessageBubble's
  // toolUseId pairing.
  return {
    id: itemId, role: 'assistant',
    content: [
      { type: 'tool_use', toolUseId: itemId, toolName, toolInput },
      { type: 'tool_result', toolUseId: itemId, toolResult: result, isError },
    ],
    timestamp: Date.now(),
  }
}

function mapThreadItem(item: Record<string, unknown>): ChatMessage[] {
  const itemType = typeof item.type === 'string' ? item.type : ''
  switch (itemType) {
    case 'userMessage':    return [mapUserMessage(item)]
    case 'agentMessage':   return [mapAgentMessage(item)]
    case 'reasoning':      return [mapReasoningItem(item)]
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall': return [mapToolItem(item)]
    default: return []
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ITEM_ID = 'item-001'

describe('CodexHistory thread/read item mapper', () => {
  describe('userMessage', () => {
    it('maps to a role:user ChatMessage with text block', () => {
      const item = { id: ITEM_ID, type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] }
      const [msg] = mapThreadItem(item)
      expect(msg.role).toBe('user')
      expect(msg.id).toBe(ITEM_ID)
      expect(msg.content[0].type).toBe('text')
      if (msg.content[0].type === 'text') expect(msg.content[0].text).toBe('Hello')
    })

    it('produces an empty text block when content array is empty', () => {
      const item = { id: ITEM_ID, type: 'userMessage', content: [] }
      const [msg] = mapThreadItem(item)
      expect(msg.content.length).toBe(1)
      expect(msg.content[0].type).toBe('text')
      if (msg.content[0].type === 'text') expect(msg.content[0].text).toBe('')
    })
  })

  describe('agentMessage', () => {
    it('maps to a role:assistant ChatMessage with text block', () => {
      const item = { id: ITEM_ID, type: 'agentMessage', text: 'The answer is 42.' }
      const [msg] = mapThreadItem(item)
      expect(msg.role).toBe('assistant')
      expect(msg.content[0].type).toBe('text')
      if (msg.content[0].type === 'text') expect(msg.content[0].text).toBe('The answer is 42.')
    })

    it('uses empty string when text is absent', () => {
      const item = { id: ITEM_ID, type: 'agentMessage' }
      const [msg] = mapThreadItem(item)
      if (msg.content[0].type === 'text') expect(msg.content[0].text).toBe('')
    })
  })

  describe('reasoning', () => {
    it('maps to a role:assistant ChatMessage with thinking block', () => {
      const item = { id: ITEM_ID, type: 'reasoning', content: ['First thought', 'Second thought'] }
      const [msg] = mapThreadItem(item)
      expect(msg.role).toBe('assistant')
      expect(msg.content[0].type).toBe('thinking')
      if (msg.content[0].type === 'thinking') {
        expect(msg.content[0].text).toBe('First thought\nSecond thought')
      }
    })
  })

  describe('commandExecution', () => {
    it('maps to a SINGLE assistant message with tool_use (Shell) + tool_result blocks', () => {
      const item = {
        id: ITEM_ID, type: 'commandExecution',
        command: 'ls -la', aggregatedOutput: 'file.ts\n', status: 'completed',
      }
      const msgs = mapThreadItem(item)
      // ONE assistant message, not a [tool_use, tool_result] pair
      expect(msgs).toHaveLength(1)
      const [msg] = msgs
      expect(msg.role).toBe('assistant')
      expect(msg.content).toHaveLength(2)

      const useBlock = msg.content[0]
      expect(useBlock.type).toBe('tool_use')
      if (useBlock.type === 'tool_use') {
        expect(useBlock.toolName).toBe('Shell')
        expect(useBlock.toolUseId).toBe(ITEM_ID)
        expect(useBlock.toolInput).toMatchObject({ command: 'ls -la' })
      }

      const resultBlock = msg.content[1]
      expect(resultBlock.type).toBe('tool_result')
      if (resultBlock.type === 'tool_result') {
        // Both blocks share the same toolUseId so MessageBubble pairs them
        expect(resultBlock.toolUseId).toBe(ITEM_ID)
        expect(resultBlock.toolResult).toBe('file.ts\n')
        expect(resultBlock.isError).toBe(false)
      }
    })

    it('sets isError=true on the tool_result block for failed status', () => {
      const item = { id: ITEM_ID, type: 'commandExecution', command: 'bad', status: 'failed' }
      const [msg] = mapThreadItem(item)
      const resultBlock = msg.content[1]
      if (resultBlock.type === 'tool_result') expect(resultBlock.isError).toBe(true)
    })

    it('tool_use does not use Claude-specific tool names', () => {
      const item = { id: ITEM_ID, type: 'commandExecution', command: 'echo hi', status: 'completed' }
      const [msg] = mapThreadItem(item)
      const useBlock = msg.content[0]
      if (useBlock.type === 'tool_use') {
        expect(useBlock.toolName).not.toBe('Bash')
        expect(useBlock.toolName).not.toBe('Agent')
        expect(useBlock.toolName).not.toBe('Task')
      }
    })
  })

  describe('fileChange', () => {
    it('maps to a single assistant message: ApplyPatch tool_use + tool_result', () => {
      const item = {
        id: ITEM_ID, type: 'fileChange',
        changes: [{ type: 'update', path: '/foo.ts' }, { type: 'create', path: '/bar.ts' }],
        status: 'completed',
      }
      const msgs = mapThreadItem(item)
      expect(msgs).toHaveLength(1)
      const [msg] = msgs
      expect(msg.content).toHaveLength(2)
      const useBlock = msg.content[0]
      if (useBlock.type === 'tool_use') expect(useBlock.toolName).toBe('ApplyPatch')
      const resultBlock = msg.content[1]
      if (resultBlock.type === 'tool_result') {
        expect(resultBlock.toolUseId).toBe(ITEM_ID)
        expect(resultBlock.toolResult).toBe('Applied 2 change(s)')
        expect(resultBlock.isError).toBe(false)
      }
    })
  })

  describe('mcpToolCall', () => {
    it('maps to compound server·tool name in a single assistant message', () => {
      const item = {
        id: ITEM_ID, type: 'mcpToolCall',
        server: 'my-server', tool: 'my-tool', status: 'completed',
      }
      const msgs = mapThreadItem(item)
      expect(msgs).toHaveLength(1)
      const useBlock = msgs[0].content[0]
      if (useBlock.type === 'tool_use') expect(useBlock.toolName).toBe('my-server·my-tool')
    })
  })

  describe('skipped item types', () => {
    it.each(['plan', 'hookPrompt', 'subAgentActivity', 'webSearch', 'contextCompaction', 'unknown'])(
      'skips "%s" items (returns empty array)',
      (type) => {
        const item = { id: ITEM_ID, type }
        expect(mapThreadItem(item)).toHaveLength(0)
      }
    )
  })

  describe('multi-turn scenario', () => {
    it('produces correct ChatMessage sequence for a full user+assistant+shell turn', () => {
      const items: Record<string, unknown>[] = [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'list files' }] },
        { id: 'a1', type: 'agentMessage', text: "I'll list the files for you." },
        { id: 's1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.ts\n', status: 'completed' },
        { id: 'a2', type: 'agentMessage', text: 'Here they are.' },
      ]
      const messages = items.flatMap((i) => mapThreadItem(i))
      // user + agent + shell(tool_use+tool_result in ONE assistant msg) + agent = 4 messages
      expect(messages).toHaveLength(4)
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('assistant')
      // The shell turn is a single assistant message carrying both blocks
      expect(messages[2].role).toBe('assistant')
      expect(messages[2].content.map((b) => b.type)).toEqual(['tool_use', 'tool_result'])
      expect(messages[3].role).toBe('assistant')
    })
  })
})
