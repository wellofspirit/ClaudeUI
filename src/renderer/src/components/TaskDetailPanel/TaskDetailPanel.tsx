import { useCallback, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { agentRowLabel, useAgentRoster } from '../../hooks/useAgentRoster'
import { bashMovedToBackground, latestNotification } from '../chat/task-state'
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
      if (!taskBlock) return { toolUseId, kind: 'missing' as const }
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
    isHistorical,
    activeTasks,
    taskNotifications,
    roster.agents
  ])

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
