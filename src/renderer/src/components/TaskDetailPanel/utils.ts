import type { ContentBlock } from '../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/**
 * Scan a message list for the tool_use block and its matching tool_result.
 *
 * NOTE: tool_use blocks live in role:'assistant' messages, but tool_result
 * blocks are stored in synthetic role:'user' messages (see session-store
 * addToolResult). The previous implementation only scanned assistant
 * messages, which meant resultBlock was always null and TaskEntry's
 * "completed" rendering never fired. We now scan user messages too for
 * tool_result, while still restricting tool_use to assistant.
 */
export function findTaskBlocks(
  messages: { role: string; content: ContentBlock[] }[],
  toolUseId: string
): { taskBlock: ToolUseBlock | null; resultBlock: ToolResultBlock | null } {
  let taskBlock: ToolUseBlock | null = null
  let resultBlock: ToolResultBlock | null = null
  for (const msg of messages) {
    for (const b of msg.content) {
      if (b.type === 'tool_use' && msg.role === 'assistant' && b.toolUseId === toolUseId) {
        taskBlock = b
      }
      if (b.type === 'tool_result' && b.toolUseId === toolUseId) {
        resultBlock = b
      }
    }
  }
  return { taskBlock, resultBlock }
}
