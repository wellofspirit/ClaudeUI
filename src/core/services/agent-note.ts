/**
 * The agent note — one engine-neutral row shape for context an AGENT put into
 * a conversation (a task notification, a message from another agent): never
 * the user's bubble, and never a `User:` line for ClaudeUI's judge
 * (`slimTranscript` skips `system` rows; ADR-087 D1, ADR-088).
 *
 * `role: 'system'` with one `context_note` whose single fragment carries the
 * text verbatim (ContextNoteBlock never runs markdown) and a label saying where
 * it came from. Used by pi's custom messages (pi-custom-message.ts) and by
 * Claude Code's task notifications, live (claude-session.ts) and on reload
 * (session-history.ts), so a row renders the same everywhere.
 */
import type { ChatMessage } from '../../shared/types'

export const AGENT_NOTE_FRAGMENT_LABEL = 'from an agent, not from you'

export interface AgentNoteInput {
  id: string
  title: string
  text: string
  timestamp: number
}

export function agentNoteMessage({ id, title, text, timestamp }: AgentNoteInput): ChatMessage {
  return {
    id,
    role: 'system',
    content: [
      { type: 'context_note', title, fragments: [{ text, label: AGENT_NOTE_FRAGMENT_LABEL }] }
    ],
    timestamp
  }
}
