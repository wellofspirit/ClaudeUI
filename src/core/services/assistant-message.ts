/**
 * Pure assistant-SDK-message → ChatMessage conversion.
 *
 * Used by `claude-session.ts` and by the cross-engine dispatcher's headless
 * Claude targets (`dispatch-claude-targets.ts`), so live and forwarded
 * `session:subagent-message` carry the same `ChatMessage` shape. It is NOT the
 * only block mapper: the two inline mappers in `session-history.ts` (transcript
 * replay), `parseJsonlLine` in `subagent-watcher.ts` and
 * `AutomationManager.transformAssistantMessage` in `automation-manager.ts` map
 * the same blocks separately — keep all of them in step.
 *
 * Deliberately stateless — no `this`, no side effects — so it's safe to call
 * from either a live session or a headless dispatch target.
 */
import { v4 as uuid } from 'uuid'
import type { ChatMessage, ContentBlock } from '../../shared/types'
import { fallbackBlockText } from './session-history'
import { extractToolResultContent } from './tool-result-content'

export function transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
  const betaMessage = msg.message as Record<string, unknown> | undefined
  if (!betaMessage) return null

  const content = betaMessage.content as Array<Record<string, unknown>> | undefined
  if (!content || !Array.isArray(content)) return null

  const blocks: ContentBlock[] = content.map((block) => {
    const blockType = block.type as string
    if (blockType === 'text') {
      return { type: 'text' as const, text: block.text as string }
    } else if (blockType === 'tool_use') {
      return {
        type: 'tool_use' as const,
        toolName: block.name as string,
        toolInput: block.input as Record<string, unknown>,
        toolUseId: block.id as string
      }
    } else if (blockType === 'tool_result') {
      const { text, images } = extractToolResultContent(block.content)
      return {
        type: 'tool_result' as const,
        toolUseId: block.tool_use_id as string,
        toolResult: text,
        isError: block.is_error as boolean,
        ...(images ? { images } : {})
      }
    } else if (blockType === 'thinking') {
      return { type: 'thinking' as const, text: block.thinking as string }
    } else if (blockType === 'fallback') {
      // Canonical-replacement frame for a refusal-retracted partial. The
      // whole message is normally evicted right after via
      // retracted_message_uuids; render a readable note in case it survives.
      return { type: 'text' as const, text: fallbackBlockText(block) }
    }
    return { type: 'text' as const, text: JSON.stringify(block) }
  })

  // Use the BetaMessage id for deduplication of partial messages
  const messageId = (betaMessage.id as string) || (msg.uuid as string) || uuid()

  return {
    id: messageId,
    role: 'assistant',
    content: blocks,
    timestamp: Date.now(),
    ...(typeof betaMessage.model === 'string' && betaMessage.model
      ? { model: betaMessage.model }
      : {})
  }
}
