/**
 * One converter for pi `custom` messages (an extension's `pi.sendMessage`),
 * shared by the live mapper (event-mapper.ts `message_end`) and the history
 * loader (pi-session-list.ts `custom_message` entries), so a row renders the
 * same live and on reload (ADR-088 S3, Q10).
 *
 * Every row is `role: 'system'` with one `context_note`: context the model saw
 * that the user never typed, rendered verbatim (an extension's text is
 * third-party text). ClaudeUI's own agent messages (pi-delivery.ts) get the
 * title from their `details` and a fragment label saying they come from an
 * agent; the marking comes from the customType + details, never the text.
 */

import type { ChatMessage } from '../../shared/types'
import type { PiImageContent, PiTextContent } from './pi-protocol'
import { piAgentDeliveryDetails } from './pi-delivery'
import { AGENT_NOTE_FRAGMENT_LABEL, agentNoteMessage } from '../services/agent-note'

/** The shared agent-note label (services/agent-note.ts), under pi's historical name. */
export const PI_AGENT_MESSAGE_FRAGMENT_LABEL = AGENT_NOTE_FRAGMENT_LABEL

const FALLBACK_TITLE = {
  'task-notification': 'Agent notification',
  'agent-message': 'Message from an agent'
} as const

export interface PiCustomMessageInput {
  id: string
  customType: string
  content: string | Array<PiTextContent | PiImageContent> | null | undefined
  display: boolean
  details?: unknown
  timestamp: number
}

/** The text parts of a custom message's content, joined by newlines. */
export function piCustomMessageText(content: PiCustomMessageInput['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => (part && part.type === 'text' && part.text ? [part.text] : []))
    .join('\n')
}

/** A `display: true` custom message with text → its system row; anything else → null. */
export function piCustomMessageToChat(input: PiCustomMessageInput): ChatMessage | null {
  // Not-displayed (or a missing flag) stays hidden, as history always did.
  if (!input.display) return null
  const text = piCustomMessageText(input.content)
  if (!text) return null
  const ours = piAgentDeliveryDetails(input.customType, input.details)
  if (ours) {
    return agentNoteMessage({
      id: input.id,
      title: ours.title || FALLBACK_TITLE[ours.kind],
      text,
      timestamp: input.timestamp
    })
  }
  return {
    id: input.id,
    role: 'system',
    content: [{ type: 'context_note', title: input.customType, fragments: [{ text }] }],
    timestamp: input.timestamp
  }
}
