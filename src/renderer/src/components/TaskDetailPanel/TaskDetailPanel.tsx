import { useCallback, useEffect, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { agentRowLabel, useAgentRoster } from '../../hooks/useAgentRoster'
import { bashMovedToBackground, latestNotification } from '../chat/task-state'
import { requestSubagentTranscript } from '../../lib/subagent-prefetch'
import { findTaskBlocks } from './utils'
import { TaskDetailPanelView, type TaskEntryDescriptor } from './View'

export function TaskDetailPanel({
  style,
  variant
}: {
  style?: React.CSSProperties
  variant?: 'panel' | 'fullscreen'
}): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const taskPanelOpen = useActiveSession((s) => s.rightPanel === 'task')
  const openedTaskToolUseIds = useActiveSession((s) => s.openedTaskToolUseIds)
  const messages = useActiveSession((s) => s.messages)
  const subagentMessages = useActiveSession((s) => s.subagentMessages)
  const subagentIndex = useActiveSession((s) => s.subagentIndex)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)
  const toggleTaskInPanel = useSessionStore((s) => s.toggleTaskInPanel)
  const roster = useAgentRoster()

  const entries = useMemo<TaskEntryDescriptor[]>(() => {
    return openedTaskToolUseIds.map((toolUseId) => {
      // A nested agent's spawn, or a subagent's Bash, lives in its parent's bucket.
      const { taskBlock, resultBlock, ownerToolUseId } = findTaskBlocks(
        messages,
        toolUseId,
        subagentMessages
      )
      if (!taskBlock) {
        // A nested agent's spawn lives in its PARENT's transcript (ADR-073 §7), which
        // the content-first load may not have fetched yet (ADR-102 Arc 2): say it is
        // coming rather than render nothing. Once the parent lands the call is found
        // and this becomes an ordinary entry.
        const parent = subagentIndex?.[toolUseId]?.parentToolUseId
        return parent && parentTranscriptPending(parent, subagentIndex, subagentMessages)
          ? { toolUseId, kind: 'loading' as const }
          : { toolUseId, kind: 'missing' as const }
      }
      // A Bash cli.js moved to the background is a background shell too: its
      // tool_result is only the hand-off text, not the command's output.
      const isBackgroundBash =
        taskBlock.toolName === 'Bash' &&
        (!!taskBlock.toolInput?.run_in_background ||
          bashMovedToBackground({
            isHistorical: !!isHistorical,
            activeTask: activeTasks[toolUseId],
            notification: latestNotification(taskNotifications, toolUseId),
            resultText: resultBlock?.toolResult
          }))
      if (isBackgroundBash) {
        // The shell entry links back to the agent that launched it, named the way
        // the roster names it. Worked out here, once, not per mounted entry.
        const owner = ownerToolUseId
          ? roster.agents.find((a) => a.toolUseId === ownerToolUseId)
          : undefined
        return {
          toolUseId,
          kind: 'bash-background' as const,
          ...(owner ? { ownerLabel: agentRowLabel(owner) } : {})
        }
      }
      return { toolUseId, kind: 'task' as const }
    })
  }, [
    openedTaskToolUseIds,
    messages,
    subagentMessages,
    subagentIndex,
    isHistorical,
    activeTasks,
    taskNotifications,
    roster.agents
  ])

  // Ask for what a `loading` entry waits on, at the descriptor level: such an entry
  // renders no `TaskEntry`, so nothing inside it could. The parent's bucket holds the
  // spawn; the agent's own bucket is its transcript. Deduplicated by the load.
  const loadingKey = entries
    .filter((e) => e.kind === 'loading')
    .map((e) => e.toolUseId)
    .join('\n')
  useEffect(() => {
    if (!taskPanelOpen || !activeSessionId || !loadingKey) return
    for (const toolUseId of loadingKey.split('\n')) {
      const parent = subagentIndex?.[toolUseId]?.parentToolUseId
      if (parent) requestSubagentTranscript(activeSessionId, parent)
      requestSubagentTranscript(activeSessionId, toolUseId)
    }
    // `subagentIndex` is the plan's identity: a reload replaces it and the request is repeated.
  }, [taskPanelOpen, activeSessionId, loadingKey, subagentIndex])

  const handleToggle = useCallback(
    (toolUseId: string) => {
      if (activeSessionId) toggleTaskInPanel(activeSessionId, toolUseId)
    },
    [activeSessionId, toggleTaskInPanel]
  )

  // Open with NO entries is a valid state now: the top-bar pill opens the
  // roster without picking an agent, which is the whole point of having a door
  // that does not depend on a card still being on screen (ADR-073).
  if (!taskPanelOpen) return null

  return (
    <TaskDetailPanelView
      style={style}
      variant={variant}
      entries={entries}
      roster={roster}
      openedToolUseIds={openedTaskToolUseIds}
      onToggleAgent={handleToggle}
      onClose={() => activeSessionId && closeTaskPanel(activeSessionId)}
    />
  )
}

/** The parent's transcript is on disk and not loaded yet. */
function parentTranscriptPending(
  parentToolUseId: string,
  index: Readonly<Record<string, { bytes: number }>> | null,
  buckets: Readonly<Record<string, readonly unknown[]>>
): boolean {
  return (index?.[parentToolUseId]?.bytes ?? 0) > 0 && !buckets[parentToolUseId]?.length
}
