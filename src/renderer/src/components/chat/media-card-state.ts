/**
 * What a media card is showing, derived from the session's task records (`activeTasks`,
 * `taskNotifications`, ADR-040) the way TaskCard reads them, plus the call's own result.
 */
import type { ActiveTask, ChatMessage, TaskNotification } from '../../../../shared/types'
import { isMediaToolName } from '../../../../shared/media-tool-view'

export type MediaCardState =
  | 'approval'
  | 'running'
  | 'done'
  | 'error'
  | 'stopped'
  /** Finished, but the notification carries no file (a cold load that could not rebuild it). */
  | 'unavailable'
  /** Nothing says how it ended (a historical transcript). */
  | 'unknown'

export function deriveMediaState(input: {
  isPendingApproval: boolean
  isHistorical: boolean
  activeTask?: ActiveTask
  notification?: TaskNotification
  hasResult: boolean
  resultIsError: boolean
}): MediaCardState {
  if (input.isPendingApproval) return 'approval'
  const n = input.notification
  if (n) {
    if (n.status === 'completed') return n.media ? 'done' : 'unavailable'
    if (n.status === 'failed') return 'error'
    if (n.status === 'stopped') return 'stopped'
    return 'unknown'
  }
  if (input.activeTask && !input.isHistorical) return 'running'
  if (input.resultIsError) return 'error'
  // Approved, the host has not announced the job yet.
  if (!input.hasResult && !input.isHistorical) return 'running'
  return 'unknown'
}

/** How many of the newest media calls keep their full card; older finished ones shrink to a row. */
export const MEDIA_CARDS_EXPANDED = 4

/** Whether this call is among the newest `MEDIA_CARDS_EXPANDED` media calls of the transcript. */
export function isRecentMediaCall(messages: readonly ChatMessage[], toolUseId: string): boolean {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j]
      if (b.type !== 'tool_use' || !isMediaToolName(b.toolName)) continue
      if (b.toolUseId === toolUseId) return true
      if (++seen >= MEDIA_CARDS_EXPANDED) return false
    }
  }
  // Not in this transcript (a subagent's call): nothing to compare against.
  return true
}
