/**
 * Pure helper functions for InputBox — prompt routing state machine and model
 * picker utilities.
 */

import type { FileAttachment } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Model picker filtering
// ---------------------------------------------------------------------------

/**
 * The minimum a model row must carry for the helpers below. Deliberately a
 * structural MINIMUM with no index signature: these are generic constraints,
 * so each caller's own richer row type (`ModelDisplay`, the InputBox literal)
 * flows through unchanged — and an `interface` gets no implicit index
 * signature, so requiring one would lock those callers out.
 */
export interface ModelEntry {
  value: string
  engineId?: string
  /** See `ModelInfo.resolvedModel`. Claude rows only; other engines omit it. */
  resolvedModel?: string
}

/**
 * Filter the model list for the selected engine. Model values are only unique
 * within an engine, so fresh and committed sessions use the same scope.
 */
export function filterModelsForEngine<T extends ModelEntry>(
  models: T[],
  sessionEngineId: string | null | undefined
): T[] {
  const engineId = sessionEngineId ?? 'claude'
  return models.filter((m) => (m.engineId ?? 'claude') === engineId)
}

/**
 * Collapse rows that resolve to the same concrete model.
 *
 * cli.js's Claude catalog lists the `default` alias and its concrete
 * equivalent as separate rows with an IDENTICAL `description` — on 2.1.268,
 * `default` and `opus[1m]`, both `resolvedModel: "claude-opus-5[1m]"`. The
 * picker labels rows from the description, so they render as two identical
 * entries. Keep one row per `resolvedModel`, in cli.js's own preference order
 * (which puts `default` first).
 *
 * Selection-safe: when the current selection is a LATER row in a group, that
 * row wins, so a session already pinned to `opus[1m]` still sees its own row
 * rather than being silently relabelled `default`. Rows without a
 * `resolvedModel` (every non-Claude engine) are never merged.
 */
export function dedupeResolvedModels<T extends ModelEntry>(
  models: T[],
  selectedValue?: string | null
): T[] {
  /** Group key, or null for a row that must pass through untouched. */
  const keyOf = (m: T): string | null =>
    typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel : null

  // Winning INDEX per group, decided before the output pass so order is
  // preserved by filtering the input. Indices, not object identity: the same
  // row object appearing twice must still collapse to one.
  const winners = new Map<string, number>()
  models.forEach((m, i) => {
    const key = keyOf(m)
    if (key === null) return
    const incumbent = winners.get(key)
    if (incumbent === undefined) {
      winners.set(key, i)
    } else if (
      selectedValue &&
      m.value === selectedValue &&
      models[incumbent].value !== selectedValue
    ) {
      // A later row holds the live selection — it displaces the first.
      winners.set(key, i)
    }
  })

  return models.filter((m, i) => {
    const key = keyOf(m)
    return key === null || winners.get(key) === i
  })
}

// ---------------------------------------------------------------------------
// Prompt routing
// ---------------------------------------------------------------------------

export type SendAction =
  | { type: 'side-question'; question: string }
  | { type: 'clear-session' }
  | {
      type: 'queue-prompt'
      prompt: string
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    }
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
    // Include attachments so an image queued mid-turn isn't dropped (Low).
    return { type: 'queue-prompt', prompt, attachments }
  }

  return { type: 'send-prompt', prompt, attachments }
}
