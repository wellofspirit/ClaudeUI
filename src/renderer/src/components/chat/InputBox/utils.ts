/**
 * Pure helper functions for InputBox — prompt routing state machine and model
 * picker utilities.
 */

import type { FileAttachment } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Model picker filtering
// ---------------------------------------------------------------------------

export interface ModelEntry {
  value: string
  engineId?: string
  [key: string]: unknown
}

/**
 * Filter the model list for the picker based on session state.
 *
 * engineLocked: true once the session is committed to an engine (running OR
 * loaded-from-history) — then only that engine's models are shown, to prevent
 * offering a cross-engine pick that would corrupt an engine-committed session.
 *
 * When not locked (brand-new empty session): return all models so the user can
 * cross-engine pick (which switches the session engine). Defaults 'claude' when
 * engineId is absent on either the model entry or the session itself.
 */
export function filterModelsForEngine<T extends ModelEntry>(
  models: T[],
  engineLocked: boolean,
  sessionEngineId: string | null | undefined
): T[] {
  if (!engineLocked) return models
  const runningEngine = sessionEngineId ?? 'claude'
  return models.filter((m) => (m.engineId ?? 'claude') === runningEngine)
}

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
  /** Whether the engine supports out-of-band side questions (capabilities.sideQuestion).
   *  When false, `/btw ...` is treated as ordinary prompt text. Defaults to true. */
  sideQuestionEnabled?: boolean
  /** Whether the engine can queue a message while a turn runs (capabilities.queue).
   *  When false, a send during a running turn is a no-op (input is retained).
   *  Defaults to true. */
  queueEnabled?: boolean
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

  // /btw side question — only when the engine exposes the side-question channel.
  if ((ctx.sideQuestionEnabled ?? true) && prompt.startsWith('/btw ')) {
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
    // Engines without queue support can't accept a message mid-turn — retain the
    // input (no-op) rather than dropping or mis-sending it. Claude: queue → unchanged.
    if (!(ctx.queueEnabled ?? true)) return { type: 'noop' }
    return { type: 'queue-prompt', prompt }
  }

  return { type: 'send-prompt', prompt, attachments }
}
