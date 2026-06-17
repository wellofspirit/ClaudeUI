/**
 * Pure helper functions for InputBox — prompt routing state machine.
 */

import type { FileAttachment } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Prompt routing
// ---------------------------------------------------------------------------

export type SendAction =
  | { type: 'side-question'; question: string }
  | { type: 'clear-session' }
  | { type: 'queue-prompt'; prompt: string }
  | {
      type: 'send-prompt'
      prompt: string
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    }
  | { type: 'noop' }

export interface SendContext {
  text: string
  attachedFiles: FileAttachment[]
  isDisabled: boolean
  activeSessionId: string | null
  isRunning: boolean
}

/**
 * Determine what action to take when the user hits "send".
 * Pure function — no side effects, no IPC calls, no store mutations.
 */
export function resolveSendAction(ctx: SendContext): SendAction {
  const prompt = ctx.text.trim()
  const hasFiles = ctx.attachedFiles.length > 0

  if ((!prompt && !hasFiles) || ctx.isDisabled || !ctx.activeSessionId) {
    return { type: 'noop' }
  }

  // /btw side question
  if (prompt.startsWith('/btw ')) {
    const question = prompt.slice(5).trim()
    if (question) return { type: 'side-question', question }
  }

  // /clear — start fresh session
  if (prompt === '/clear') {
    return { type: 'clear-session' }
  }

  // Queue vs direct send
  const attachments = hasFiles
    ? ctx.attachedFiles.map(({ mediaType, base64Data, fileName }) => ({
        mediaType,
        base64Data,
        fileName
      }))
    : undefined

  if (ctx.isRunning) {
    return { type: 'queue-prompt', prompt }
  }

  return { type: 'send-prompt', prompt, attachments }
}
