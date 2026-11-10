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
  isAnyXAgentSender,
  isXAgentMessageSender,
  isXAgentSender,
  parseSessionMessageWrapper,
  unescapeClosingTag,
  xAgentBareName
} from '../../shared/session-message-wrapper'

export const AGENT_NOTE_FRAGMENT_LABEL = 'from an agent, not from you'
/** The label of a message another session or agent sent (slice 1a). */
export const SESSION_MESSAGE_FRAGMENT_LABEL = 'from another session, not from you'
/** The label of an X-Agent's result delivered into its parent (ADR-105 §3). */
export const X_AGENT_RESULT_FRAGMENT_LABEL = 'from an X-Agent, not from you'

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

/**
 * The row title for a message from `fromTitle` (empty → a generic one). `native`:
 * from another Claude Code process rather than a ClaudeUI session.
 */
export function sessionMessageNoteTitle(
  fromTitle: string,
  native = false,
  fromKey?: string
): string {
  // An X-Agent's result is the parent's own agent reporting back, never "another session".
  if (fromKey !== undefined && !native && isXAgentSender(fromKey)) {
    const name = xAgentBareName(fromTitle)
    return name ? `Report from X-Agent ${name}` : 'Report from an X-Agent'
  }
  // A message it sent while it ran is not its report (ADR-105 §4).
  if (fromKey !== undefined && !native && isXAgentMessageSender(fromKey)) {
    const name = xAgentBareName(fromTitle)
    return name ? `Message from X-Agent ${name}` : 'Message from an X-Agent'
  }
  if (native)
    return fromTitle
      ? // The sender first: a narrow screen truncates the title's tail.
        `${fromTitle} · another Claude session`
      : 'Message from another Claude session'
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
  native?: boolean
  /** The sender's key as the wrapper names it; an X-Agent's (`x-agent:` or `x-agent-message:` prefix) makes this an X-Agent note. */
  fromKey?: string
}): ChatMessage {
  const result = input.fromKey !== undefined && !input.native && isAnyXAgentSender(input.fromKey)
  return agentNoteMessage({
    id: input.id,
    title: sessionMessageNoteTitle(input.fromTitle, input.native, input.fromKey),
    text: input.text,
    timestamp: input.timestamp,
    label: result ? X_AGENT_RESULT_FRAGMENT_LABEL : SESSION_MESSAGE_FRAGMENT_LABEL
  })
}

/**
 * A Claude transcript row cli.js wrote for a PEER turn — another session's
 * message, whether ClaudeUI delivered it (slice 1a) or a native cross-session
 * `SendMessage` did. cli.js stores it as a user row with `isMeta: true`,
 * `turnOrigin: 'peer'` and `origin: { kind: 'peer', from, name, body, … }`
 * (docs/protocol-cc/15-peer-sessions.md §15.2.7). The body is `origin.body`; the
 * wrapped content is the fallback. Null for any other row — and for a peer row
 * with an empty body, which then falls into the loader's ordinary `isMeta`
 * discard (there is nothing to show).
 */
export function peerRowParts(
  row: { origin?: unknown; turnOrigin?: unknown },
  content: unknown
): { fromTitle: string; fromKey: string; body: string; native: boolean } | null {
  const origin =
    row.origin && typeof row.origin === 'object'
      ? (row.origin as {
          kind?: unknown
          from?: unknown
          name?: unknown
          body?: unknown
          hostInjected?: unknown
        })
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
  const body =
    typeof origin?.body === 'string'
      ? unescapeClosingTag(CROSS_SESSION_MESSAGE_TAG, origin.body)
      : (parsed?.body ?? text)
  if (!body) return null
  const fromTitle = typeof origin?.name === 'string' ? origin.name : (parsed?.fromTitle ?? '')
  const fromKey = typeof origin?.from === 'string' ? origin.from : (parsed?.fromKey ?? '')
  // cli.js stamps `hostInjected` on a frame a host wrote to its stdin (ClaudeUI's
  // own deliveries); a message another Claude Code process sent over cli.js's
  // socket has none.
  return { fromTitle, fromKey, body, native: origin?.hostInjected !== true }
}

/**
 * The note a user-role row stands for, when its text is a delivered item's
 * wrapper (opencode delivers one as a plain prompt, so the engine's
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
    fromKey: parsed.fromKey,
    text: parsed.body,
    timestamp: message.timestamp
  })
}
