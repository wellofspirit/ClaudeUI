import { useSessionStore } from '../../../stores/session-store'

/**
 * Take back the session's queued messages and put them in the input (ADR-053).
 *
 * Shared by the two take-back affordances (ArrowUp in InputBox, the pencil on
 * QueuedMessageCard) so both obey the same contract:
 *
 *  - only the texts the host actually recalled reach the draft, joined with
 *    `\n` — the join is a client-side convenience, never storage;
 *  - items the engine had already started consuming are NOT cleared from the
 *    card. They stay until their `consumed` broadcast turns them into chat
 *    messages. The pre-fix code cleared the display on `removed: 0` anyway,
 *    which is precisely how a "cancelled" message went on to execute unseen;
 *  - the card itself is never cleared here at all. `session:queue-changed` is
 *    the only thing that moves items off it, so a failed IPC leaves the queue
 *    visible instead of swallowing the user's text.
 */
export async function recallQueuedInto(
  activeSessionId: string | null,
  setDraftText: (text: string) => void
): Promise<void> {
  if (!activeSessionId) return
  let result: { recalled?: string[]; notRecalled?: number } | null = null
  try {
    result = await window.api.recallQueued(activeSessionId)
  } catch {
    // Fall through to the warning below with a null result — the queue stays.
  }
  const recalled = result?.recalled ?? []
  const notRecalled = result?.notRecalled ?? 0
  if (recalled.length > 0) setDraftText(recalled.join('\n'))
  if (notRecalled > 0) {
    useSessionStore
      .getState()
      .addWarning(
        activeSessionId,
        `${notRecalled} queued message${notRecalled === 1 ? ' is' : 's are'} already being executed and could not be taken back.`
      )
  }
}
