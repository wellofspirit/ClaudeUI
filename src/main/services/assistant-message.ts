/**
 * Pure assistant-SDK-message → ChatMessage conversion.
 *
 * Factored out of `ClaudeSession.transformAssistantMessage` (ADR-033 M3) so the
 * cross-engine dispatcher's headless Claude targets can build the SAME
 * `ChatMessage` shape for `session:subagent-message` forwarding, without
 * duplicating the block-mapping logic. `claude-session.ts` keeps importing
 * this module (its own call site was replaced) so there is exactly one
 * implementation.
 *
 * Deliberately stateless — no `this`, no side effects — so it's safe to call
 * from either a live session or a headless dispatch target.
 */
import { v4 as uuid } from 'uuid'
import type { ChatMessage, ContentBlock } from '../../shared/types'
import { fallbackBlockText } from './session-history'

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
      const resultContent = block.content
      let text = ''
      if (typeof resultContent === 'string') {
        text = resultContent
      } else if (Array.isArray(resultContent)) {
        text = resultContent.map((c: Record<string, unknown>) => (c.text as string) || '').join('\n')
      }
      return {
        type: 'tool_result' as const,
        toolUseId: block.tool_use_id as string,
        toolResult: text,
        isError: block.is_error as boolean
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
    timestamp: Date.now()
  }
}
