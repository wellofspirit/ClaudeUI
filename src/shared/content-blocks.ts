import type { ContentBlock } from './types'

/**
 * Merges content blocks when upserting an assistant message by ID.
 * The SDK sends partial messages that may not include all previously accumulated
 * content blocks. This function preserves tool_use and tool_result blocks from the
 * old message that aren't present in the incoming update.
 *
 * Lives in `shared/` because the message-upsert semantics are now interpreted in
 * TWO places — the renderer store and the shared SyncCore reducer
 * (`shared/sync/reducer.ts`). A duplicated copy of this function would be a
 * guaranteed source of snapshot/event divergence, which is precisely what the
 * shared reducer exists to make unrepresentable. `renderer/src/utils/content-blocks`
 * re-exports it, so every existing import site is unchanged.
 */
export function mergeContentBlocks(
  oldBlocks: ContentBlock[],
  newBlocks: ContentBlock[]
): ContentBlock[] {
  const newToolUseIds = new Set(
    newBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => b.toolUseId)
  )
  const newToolResultIds = new Set(
    newBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => b.toolUseId)
  )
  const newThinkingCount = newBlocks.filter((b) => b.type === 'thinking').length
  const newHasText = newBlocks.some((b) => b.type === 'text')

  const droppedThinkingCount = Math.max(
    0,
    oldBlocks.filter((b) => b.type === 'thinking').length - newThinkingCount
  )
  let thinkingsSeen = 0
  const preserved: ContentBlock[] = []

  for (const b of oldBlocks) {
    if (b.type === 'tool_use' && !newToolUseIds.has(b.toolUseId)) {
      preserved.push(b)
    } else if (b.type === 'tool_result' && !newToolResultIds.has(b.toolUseId)) {
      preserved.push(b)
    } else if (b.type === 'thinking') {
      if (thinkingsSeen < droppedThinkingCount) {
        preserved.push(b)
      }
      thinkingsSeen++
    } else if (b.type === 'text' && !newHasText) {
      preserved.push(b)
    }
  }

  return [...preserved, ...newBlocks]
}
