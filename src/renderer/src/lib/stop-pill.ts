/**
 * The "stopping..." pill's fallback clear, in ONE place for every surface that offers Stop on a
 * task (the card, the task panel, the agent roster).
 *
 * The pill itself is shared state (`stoppingTaskIds`, keyed by tool_use id): a Stop from any
 * surface shows it on all of them and hides their Stop. What clears it is the task's terminal
 * notification; this is the fallback for a notification that never comes, 10 s after the click.
 * Each surface used to run its own timer, so one of them cleared the pill for the others, and
 * none of them knew that a call still QUEUED behind another has no notification to wait for yet:
 * its Stop is armed in the dispatcher and lands when the call starts, however long that takes.
 *
 * So the pill is held while the call reads queued. When the call starts, the 10 s count begins
 * from there (the armed stop lands at once, its notification clears the pill sooner); when it
 * never starts - the turn ended and cli.js answered it with an error result - the pill goes at
 * once. It is polled from the store, not from a component, so a card that unmounts (the chat
 * list is virtualised) loses nothing.
 */
import { useSessionStore } from '../stores/session-store'
import { isQueuedDispatchCall, latestNotification } from '../components/chat/task-state'
import { findTaskBlocks } from '../components/TaskDetailPanel/utils'

export const STOP_PILL_FALLBACK_MS = 10_000
const POLL_MS = 1_000

export function armStopPillFallback(routingId: string, toolUseId: string): void {
  // Counted in polls, not read from a clock: one count per second, held while queued.
  const polls = STOP_PILL_FALLBACK_MS / POLL_MS
  let left = polls
  let held = false
  const check = (): void => {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    // Cleared already (the notification came, or another surface's flow ended it).
    if (!session?.stoppingTaskIds.includes(toolUseId)) return
    const found = findTaskBlocks(session.messages, toolUseId, session.subagentMessages)
    const queued =
      !session.isHistorical &&
      !!found.taskBlock &&
      !found.resultBlock &&
      !session.activeTasks[toolUseId] &&
      !latestNotification(session.taskNotifications, toolUseId) &&
      isQueuedDispatchCall({
        engineId: session.status.engineId,
        turnRunning: session.status.state === 'running',
        content: found.siblings,
        block: found.taskBlock
      })
    if (queued) {
      held = true
      left = polls
    } else if (held) {
      held = false
      // It never started (an error result answered it): nothing is coming to clear the pill.
      if (found.resultBlock?.isError) {
        state.clearTaskStopping(routingId, toolUseId)
        return
      }
      left = polls
    }
    if (!held && --left <= 0) {
      state.clearTaskStopping(routingId, toolUseId)
      return
    }
    setTimeout(check, POLL_MS)
  }
  setTimeout(check, POLL_MS)
}
