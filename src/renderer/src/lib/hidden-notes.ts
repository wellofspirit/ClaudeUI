import type { ChatMessage, ContentBlock } from '../../../shared/types'

export interface HiddenNoteOptions {
  hideTaskNotifications: boolean
  hideSessionMessages: boolean
}

/**
 * A `context_note` the user's view toggles hide (ADR-117). Display-only: an
 * untagged note (no `source`) and an `alert` note are never hidden.
 */
export function isHiddenNote(block: ContentBlock, opts: HiddenNoteOptions): boolean {
  if (block.type !== 'context_note' || block.alert) return false
  if (block.source === 'task') return opts.hideTaskNotifications
  if (block.source === 'session-message') return opts.hideSessionMessages
  return false
}

/**
 * Drops hidden notes from system messages, and a message left with no block.
 * Returns the SAME array when nothing is hidden so downstream memos stay stable.
 */
export function withoutHiddenNotes(
  messages: ChatMessage[],
  opts: HiddenNoteOptions
): ChatMessage[] {
  if (!opts.hideTaskNotifications && !opts.hideSessionMessages) return messages
  let changed = false
  const out: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role !== 'system' || !msg.content.some((b) => isHiddenNote(b, opts))) {
      out.push(msg)
      continue
    }
    changed = true
    const content = msg.content.filter((b) => !isHiddenNote(b, opts))
    if (content.length > 0) out.push({ ...msg, content })
  }
  return changed ? out : messages
}
