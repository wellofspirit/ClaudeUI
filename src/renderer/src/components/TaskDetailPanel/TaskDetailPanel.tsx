import { useCallback, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useAgentRoster } from '../../hooks/useAgentRoster'
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
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const roster = useAgentRoster()

  const entries = useMemo<TaskEntryDescriptor[]>(() => {
    return openedTaskToolUseIds.map((toolUseId) => {
      const { taskBlock, resultBlock } = findTaskBlocks(messages, toolUseId)
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
      if (isBackgroundBash) return { toolUseId, kind: 'bash-background' as const }
      return { toolUseId, kind: 'task' as const }
    })
  }, [openedTaskToolUseIds, messages, isHistorical, activeTasks, taskNotifications])

  const handleOpen = useCallback(
    (toolUseId: string) => {
      if (activeSessionId) openTaskPanel(activeSessionId, toolUseId)
    },
    [activeSessionId, openTaskPanel]
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
      onOpenAgent={handleOpen}
      onClose={() => activeSessionId && closeTaskPanel(activeSessionId)}
    />
  )
}
