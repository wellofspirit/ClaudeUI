import type { ContentBlock } from '../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type MessageLike = { role: string; content: ContentBlock[] }

export interface TaskBlocks {
  taskBlock: ToolUseBlock | null
  resultBlock: ToolResultBlock | null
  /**
   * The origin id of the agent whose transcript holds the call, or null when
   * the main transcript does. A nested agent's spawn, and a Bash a subagent
   * ran, live in their parent agent's bucket (ADR-073 §7).
   */
  ownerToolUseId: string | null
}

function scan(
  messages: readonly MessageLike[],
  toolUseId: string
): Pick<TaskBlocks, 'taskBlock' | 'resultBlock'> {
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

/**
 * Scan a message list for the tool_use block and its matching tool_result.
 *
 * NOTE: tool_use blocks live in role:'assistant' messages, but tool_result
 * blocks are stored in synthetic role:'user' messages (see session-store
 * addToolResult). The previous implementation only scanned assistant
 * messages, which meant resultBlock was always null and TaskEntry's
 * "completed" rendering never fired. We now scan user messages too for
 * tool_result, while still restricting tool_use to assistant.
 *
 * With `subagentMessages`, a call the main transcript does not hold is looked
 * up in every agent's bucket, and its result is taken from the SAME bucket
 * (a sub-agent's tool_result is appended to the message that made the call).
 * The first bucket that holds the call wins.
 */
export function findTaskBlocks(
  messages: readonly MessageLike[],
  toolUseId: string,
  subagentMessages?: Readonly<Record<string, readonly MessageLike[]>>
): TaskBlocks {
  const top = scan(messages, toolUseId)
  if (top.taskBlock || !subagentMessages) return { ...top, ownerToolUseId: null }
  for (const [owner, bucket] of Object.entries(subagentMessages)) {
    const found = scan(bucket, toolUseId)
    if (found.taskBlock) return { ...found, ownerToolUseId: owner }
  }
  return { ...top, ownerToolUseId: null }
}
