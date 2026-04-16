import type { ContentBlock } from '../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

export function findTaskBlocks(
  messages: { role: string; content: ContentBlock[] }[],
  toolUseId: string
): { taskBlock: ToolUseBlock | null; resultBlock: ToolResultBlock | null } {
  let taskBlock: ToolUseBlock | null = null
  let resultBlock: ToolResultBlock | null = null
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.toolUseId === toolUseId) taskBlock = b
      if (b.type === 'tool_result' && b.toolUseId === toolUseId) resultBlock = b
    }
  }
  return { taskBlock, resultBlock }
}
