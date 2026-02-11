import type { ChatMessage, ContentBlock } from '../../shared/types'

interface JsonlEntry {
  type: string
  uuid?: string
  message?: {
    id?: string
    role?: string
    content: unknown
  }
}

export interface ParsedBackgroundOutput {
  messages: ChatMessage[]
}

function transformContentBlock(block: Record<string, unknown>): ContentBlock {
  const type = block.type as string
  if (type === 'text') {
    return { type: 'text', text: block.text as string }
  } else if (type === 'tool_use') {
    return {
      type: 'tool_use',
      toolUseId: block.id as string,
      toolName: block.name as string,
      toolInput: block.input as Record<string, unknown>
    }
  } else if (type === 'tool_result') {
    const content = block.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content.map((c: Record<string, unknown>) => (c.text as string) || '').join('\n')
    }
    return {
      type: 'tool_result',
      toolUseId: block.tool_use_id as string,
      toolResult: text,
      isError: !!(block.is_error)
    }
  } else if (type === 'thinking') {
    return { type: 'thinking', text: block.thinking as string }
  }
  return { type: 'text', text: JSON.stringify(block) }
}

export function parseBackgroundJsonl(content: string): ParsedBackgroundOutput {
  const lines = content.split('\n').filter((l) => l.trim())
  const entries: JsonlEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // skip invalid lines
    }
  }

  // Collect assistant messages, deduplicating by message.id (keep last)
  const assistantById = new Map<string, { entry: JsonlEntry; order: number }>()
  // Collect user messages (tool_results) in order
  const userEntries: { entry: JsonlEntry; order: number }[] = []

  let order = 0
  for (const entry of entries) {
    if (entry.type === 'assistant' && entry.message) {
      const msgId = entry.message.id || entry.uuid || String(order)
      assistantById.set(msgId, { entry, order: order++ })
    } else if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
      // Only keep user messages that contain tool_results
      const hasToolResult = (entry.message.content as Record<string, unknown>[]).some(
        (b) => b.type === 'tool_result'
      )
      if (hasToolResult) {
        userEntries.push({ entry, order: order++ })
      } else {
        order++
      }
    } else {
      order++
    }
  }

  // Build assistant ChatMessages
  const assistantMessages: ChatMessage[] = []
  for (const [msgId, { entry }] of assistantById) {
    const content = entry.message!.content
    if (!Array.isArray(content)) continue

    const blocks: ContentBlock[] = (content as Record<string, unknown>[]).map(transformContentBlock)
    assistantMessages.push({
      id: msgId,
      role: 'assistant',
      content: blocks,
      timestamp: Date.now()
    })
  }

  // Attach tool_results from user messages to their corresponding assistant messages
  for (const { entry } of userEntries) {
    const content = entry.message!.content as Record<string, unknown>[]
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id as string
      if (!toolUseId) continue

      const resultBlock = transformContentBlock(block)

      // Find the assistant message containing the matching tool_use
      for (const msg of assistantMessages) {
        const hasToolUse = msg.content.some(
          (b) => b.type === 'tool_use' && b.toolUseId === toolUseId
        )
        if (hasToolUse) {
          msg.content.push(resultBlock)
          break
        }
      }
    }
  }

  return { messages: assistantMessages }
}
