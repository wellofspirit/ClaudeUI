/**
 * The agent note — one engine-neutral row shape for context an AGENT put into
 * a conversation (a task notification, a message from another agent): never
 * the user's bubble, and never a `User:` line for ClaudeUI's judge
 * (`slimTranscript` skips `system` rows; ADR-088 D1, ADR-089).
 *
 * `role: 'system'` with one `context_note` whose single fragment carries the
 * text verbatim (ContextNoteBlock never runs markdown) and a label saying where
 * it came from. Used by pi's custom messages (pi-custom-message.ts) and by
 * Claude Code's task notifications, live (claude-session.ts) and on reload
 * (session-history.ts), so a row renders the same everywhere.
 */
import type { ChatMessage } from '../../shared/types'
import {
  CROSS_SESSION_MESSAGE_TAG,
  SESSION_MESSAGE_TAG,
  parseSessionMessageWrapper
} from '../../shared/session-message-wrapper'

export const AGENT_NOTE_FRAGMENT_LABEL = 'from an agent, not from you'
/** The label of a message another session or agent sent (slice 1a). */
export const SESSION_MESSAGE_FRAGMENT_LABEL = 'from another session, not from you'

export interface AgentNoteInput {
  id: string
  title: string
  text: string
  timestamp: number
  /** Overrides {@link AGENT_NOTE_FRAGMENT_LABEL}. */
  label?: string
}

export function agentNoteMessage({
  id,
  title,
  text,
  timestamp,
  label = AGENT_NOTE_FRAGMENT_LABEL
}: AgentNoteInput): ChatMessage {
  return {
    id,
    role: 'system',
    content: [{ type: 'context_note', title, fragments: [{ text, label }] }],
    timestamp
  }
}

/** The row title for a message from `fromTitle` (empty → a generic one). */
export function sessionMessageNoteTitle(fromTitle: string): string {
  return fromTitle ? `Message from ${fromTitle}` : 'Message from another session'
}

/**
 * A session message or agent note as its row. The ONE place a delivered item
 * becomes a note, whichever engine carried it and whether it is live or read
 * back from disk.
 */
export function sessionMessageNote(input: {
  id: string
  fromTitle: string
  text: string
  timestamp: number
}): ChatMessage {
  return agentNoteMessage({
    id: input.id,
    title: sessionMessageNoteTitle(input.fromTitle),
    text: input.text,
    timestamp: input.timestamp,
    label: SESSION_MESSAGE_FRAGMENT_LABEL
  })
}

/**
 * A Claude transcript row cli.js wrote for a PEER turn — another session's
 * message, whether ClaudeUI delivered it (slice 1a) or a native cross-session
 * `SendMessage` did. cli.js stores it as a user row with `isMeta: true`,
 * `turnOrigin: 'peer'` and `origin: { kind: 'peer', from, name, body, … }`
 * (docs/research/session-tools/V1-probes.md §2.5). The body is `origin.body`; the
 * wrapped content is the fallback. Null for any other row — and for a peer row
 * with an empty body, which then falls into the loader's ordinary `isMeta`
 * discard (there is nothing to show).
 */
export function peerRowParts(
  row: { origin?: unknown; turnOrigin?: unknown },
  content: unknown
): { fromTitle: string; body: string } | null {
  const origin =
    row.origin && typeof row.origin === 'object'
      ? (row.origin as { kind?: unknown; name?: unknown; body?: unknown })
      : undefined
  if (origin?.kind !== 'peer' && row.turnOrigin !== 'peer') return null
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b: { type?: string; text?: string }) =>
              b?.type === 'text' ? (b.text ?? '') : ''
            )
            .join('')
        : ''
  const parsed = parseSessionMessageWrapper(text, CROSS_SESSION_MESSAGE_TAG)
  const body = typeof origin?.body === 'string' ? origin.body : (parsed?.body ?? text)
  if (!body) return null
  const fromTitle = typeof origin?.name === 'string' ? origin.name : (parsed?.fromTitle ?? '')
  return { fromTitle, body }
}

/**
 * The note a user-role row stands for, when its text is a delivered item's
 * wrapper (opencode and Codex deliver one as a plain prompt, so the engine's
 * own user row is what comes back live and on reload). Null for every other
 * row: attachments, several blocks, or text that merely mentions a tag.
 */
export function wrappedUserRowAsNote(message: ChatMessage): ChatMessage | null {
  if (message.role !== 'user' || message.content.length !== 1) return null
  const block = message.content[0]
  if (block.type !== 'text') return null
  const parsed = parseSessionMessageWrapper(block.text, SESSION_MESSAGE_TAG)
  if (!parsed) return null
  return sessionMessageNote({
    id: message.id,
    fromTitle: parsed.fromTitle,
    text: parsed.body,
    timestamp: message.timestamp
  })
}
