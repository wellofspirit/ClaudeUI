/**
 * Live/cold parity of pi's content blocks: one conversation expressed as the
 * stored entries `convertPiSessionEntries` reads and as the live events the
 * same turns produce through `mapPiEvent`, folded the way the sync reducer
 * folds them (a message upserts by id; a tool result attaches to the message
 * holding its `tool_use`). Both must carry the same blocks.
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock } from '../../../shared/types'
import { convertPiSessionEntries } from '../history'
import { createPiMapperState, mapPiEvent, type PiMapperOutput } from '../event-mapper'
import type {
  PiAssistantContentBlock,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiEvent,
  PiSessionEntry,
  PiToolResultMessage
} from '../pi-protocol'

const PATCH = '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n'

function assistant(content: PiAssistantContentBlock[], timestamp: number): PiAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp
  }
}

function toolResult(
  toolCallId: string,
  toolName: string,
  content: PiToolResultMessage['content'],
  overrides: Partial<PiToolResultMessage> = {}
): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content,
    isError: false,
    timestamp: 1000,
    ...overrides
  }
}

const THINK: PiAssistantContentBlock = { type: 'thinking', thinking: 'weigh the options' }
const TEXT: PiAssistantContentBlock = { type: 'text', text: 'Let me look.' }
const EDIT: PiAssistantContentBlock = {
  type: 'toolCall',
  id: 'c1',
  name: 'edit',
  arguments: { path: 'f.ts' }
}
const BASH: PiAssistantContentBlock = {
  type: 'toolCall',
  id: 'c2',
  name: 'bash',
  arguments: { command: 'false' }
}
const READ: PiAssistantContentBlock = {
  type: 'toolCall',
  id: 'c3',
  name: 'read',
  arguments: { path: 'pic.png' }
}

const A1 = assistant([THINK, TEXT, EDIT, BASH], 1001)
const A2 = assistant([READ], 1002)
const A3 = assistant([{ type: 'text', text: 'All done.' }], 1003)
const R1 = toolResult('c1', 'edit', [{ type: 'text', text: 'edited' }], {
  details: { patch: PATCH }
})
const R2 = toolResult('c2', 'bash', [{ type: 'text', text: 'exit 1' }], { isError: true })
const R3 = toolResult('c3', 'read', [
  { type: 'text', text: 'image follows' },
  { type: 'image', data: 'PARITYIMG', mimeType: 'image/png' }
])

/** The conversation as pi stores it. */
const ENTRIES: PiSessionEntry[] = [
  {
    type: 'message',
    id: 'e0',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'fix it', timestamp: 1000 }
  },
  ...[A1, R1, R2, A2, R3, A3].map((message, i): PiSessionEntry => ({
    type: 'message',
    id: `e${i + 1}`,
    parentId: `e${i}`,
    timestamp: '2026-01-01T00:00:00Z',
    message
  }))
]

function update(assistantMessageEvent: PiAssistantMessageEvent): PiEvent {
  return {
    type: 'message_update',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    assistantMessageEvent
  }
}

/** The events pi streams for one assistant message, block by block, then its message_end. */
function assistantEvents(message: PiAssistantMessage): PiEvent[] {
  const events: PiEvent[] = [{ type: 'message_start', message: { ...message, content: [] } }]
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text') {
      events.push(update({ type: 'text_start', contentIndex }))
      events.push(update({ type: 'text_delta', contentIndex, delta: block.text }))
      events.push(update({ type: 'text_end', contentIndex, content: block.text }))
    } else if (block.type === 'thinking') {
      events.push(update({ type: 'thinking_start', contentIndex }))
      events.push(update({ type: 'thinking_delta', contentIndex, delta: block.thinking }))
      events.push(update({ type: 'thinking_end', contentIndex, content: block.thinking }))
    } else {
      events.push(
        update({ type: 'toolcall_start', contentIndex, id: block.id, toolName: block.name })
      )
      events.push(update({ type: 'toolcall_end', contentIndex, toolCall: block }))
    }
  })
  events.push({ type: 'message_end', message })
  return events
}

/** The same turns, in the order pi emits them. */
const LIVE_EVENTS: PiEvent[] = [
  ...assistantEvents(A1),
  { type: 'message_end', message: R1 },
  { type: 'message_end', message: R2 },
  ...assistantEvents(A2),
  { type: 'message_end', message: R3 },
  ...assistantEvents(A3)
]

/** What the sync reducer does with `session:message` / `session:item-seal` / `session:tool-result`. */
function foldLive(outputs: PiMapperOutput[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const upsert = (message: ChatMessage): void => {
    const index = messages.findIndex((m) => m.id === message.id)
    if (index < 0) messages.push(structuredClone(message))
    else messages[index] = structuredClone(message)
  }
  for (const output of outputs) {
    if (output.kind === 'message' || output.kind === 'item_seal') {
      upsert(output.message)
    } else if (output.kind === 'tool_result') {
      const holder = [...messages]
        .reverse()
        .find((m) =>
          m.content.some((b) => b.type === 'tool_use' && b.toolUseId === output.toolUseId)
        )
      if (!holder) throw new Error(`tool_result with no tool_use: ${output.toolUseId}`)
      holder.content.push({
        type: 'tool_result',
        toolUseId: output.toolUseId,
        toolResult: output.result,
        isError: output.isError,
        ...(output.fileDiffs ? { fileDiffs: output.fileDiffs } : {}),
        ...(output.images ? { images: output.images } : {})
      })
    }
  }
  return messages
}

/**
 * Per assistant message, in order: its non-result blocks and its results by
 * `toolUseId`. Differences by design, dropped here:
 *  - message ids (live mints a uuid, cold uses the entry id) and timestamps;
 *  - the thinking block's `durationMs` (live only: measured while streaming);
 *  - `fileDiffs` on a result (live only: cold history carries none yet);
 *  - where a result sits in the message (live appends at the end, cold puts it
 *    right after its call): results are compared as a map;
 *  - user messages (live never emits pi's own prompt; the renderer shows it).
 */
function normalize(messages: ChatMessage[]): Array<{
  blocks: ContentBlock[]
  results: Record<string, ContentBlock>
}> {
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      const results: Record<string, ContentBlock> = {}
      const blocks: ContentBlock[] = []
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          const { fileDiffs: _fileDiffs, ...rest } = block
          results[block.toolUseId] = rest
        } else if (block.type === 'thinking') {
          const { durationMs: _durationMs, ...rest } = block
          blocks.push(rest)
        } else {
          blocks.push(block)
        }
      }
      return { blocks, results }
    })
}

describe('pi live/cold content-block parity', () => {
  const state = createPiMapperState()
  const live = foldLive(LIVE_EVENTS.flatMap((ev) => mapPiEvent(ev, state)))
  const cold = convertPiSessionEntries(ENTRIES)

  it('the live fold carries every message and result (the fold itself is sound)', () => {
    const folded = normalize(live)
    expect(folded).toHaveLength(3)
    expect(folded.flatMap((m) => Object.keys(m.results)).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('gives the same text, thinking, tool_use and tool_result blocks', () => {
    expect(normalize(live)).toEqual(normalize(cold))
  })

  it('covers an error result and an image result', () => {
    const results = normalize(cold).flatMap((m) => Object.values(m.results))
    expect(results).toContainEqual(expect.objectContaining({ toolUseId: 'c2', isError: true }))
    expect(results).toContainEqual(
      expect.objectContaining({
        toolUseId: 'c3',
        images: [expect.objectContaining({ mediaType: 'image/png' })]
      })
    )
  })
})
