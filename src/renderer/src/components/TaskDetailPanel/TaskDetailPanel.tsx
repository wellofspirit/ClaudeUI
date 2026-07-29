import { useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
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
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)

  const entries = useMemo<TaskEntryDescriptor[]>(() => {
    return openedTaskToolUseIds.map((toolUseId) => {
      const { taskBlock } = findTaskBlocks(messages, toolUseId)
      if (!taskBlock) return { toolUseId, kind: 'missing' as const }
      if (taskBlock.toolName === 'Bash' && taskBlock.toolInput?.run_in_background) {
        return { toolUseId, kind: 'bash-background' as const }
      }
      return { toolUseId, kind: 'task' as const }
    })
  }, [openedTaskToolUseIds, messages])

  if (!taskPanelOpen || openedTaskToolUseIds.length === 0) return null

  return (
    <TaskDetailPanelView
      style={style}
      variant={variant}
      entries={entries}
      onClose={() => activeSessionId && closeTaskPanel(activeSessionId)}
    />
  )
}
