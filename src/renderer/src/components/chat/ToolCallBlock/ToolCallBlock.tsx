import { memo, useEffect, useState } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionSuggestion
} from '../../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import { ToolCallBlockView } from './View'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  approval?: PendingApproval
}

export const ToolCallBlock = memo(function ToolCallBlock({
  block,
  result,
  approval
}: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const permissionMode = useActiveSession((s) => s.permissionMode)
  const backgroundTasksEnabled = useActiveSession((s) => s.status.capabilities.backgroundTasks)
  const expandToolCalls = useSessionStore((s) => s.settings.expandToolCalls)
  const expandReadResults = useSessionStore((s) => s.settings.expandReadResults)
  const hideToolInput = useSessionStore((s) => s.settings.hideToolInput)
  const theme = useSessionStore((s) => s.settings.theme)

  const toolUseId = block.toolUseId || ''
  const isBackgroundBash = block.toolName === 'Bash' && !!block.toolInput?.run_in_background
  const bashOutput = useActiveSession((s) => s.bashOutputs[toolUseId])
  const bgOutput = useActiveSession((s) => s.backgroundOutputs[toolUseId])
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const watchBackgroundOutput = useSessionStore((s) => s.watchBackgroundOutput)
  const unwatchBackgroundOutput = useSessionStore((s) => s.unwatchBackgroundOutput)

  const bgNotification = isBackgroundBash
    ? (taskNotifications.find((n) => n.toolUseId === toolUseId) ?? null)
    : null

  const isStopping = stoppingTaskIds.includes(toolUseId)
  const [isBackgrounding, setIsBackgrounding] = useState(false)

  // Start file polling as soon as a background bash tool_use renders, independent of
  // expanded state. BackgroundBashOutput only mounts when expanded, but auto-expand
  // waits for bgOutput to populate — moving the watch up here breaks that deadlock.
  useEffect(() => {
    if (!isBackgroundBash || isHistorical || !activeSessionId || !toolUseId) return
    watchBackgroundOutput(activeSessionId, toolUseId)
    return () => {
      unwatchBackgroundOutput(activeSessionId, toolUseId)
    }
  }, [
    isBackgroundBash,
    isHistorical,
    activeSessionId,
    toolUseId,
    watchBackgroundOutput,
    unwatchBackgroundOutput
  ])

  const handleApproval = async (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ): Promise<void> => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(
      activeSessionId,
      approval.requestId,
      decision,
      undefined,
      selectedSuggestions
    )
    removePendingApproval(activeSessionId, approval.requestId)
  }

  const handleBackgroundTask = async (): Promise<void> => {
    if (!activeSessionId) return
    setIsBackgrounding(true)
    const bgResult = await window.api.backgroundTask(activeSessionId, toolUseId)
    if (!bgResult.success) {
      window.api.logError('ToolCallBlock', `Failed to background task: ${bgResult.error}`)
      setIsBackgrounding(false)
    }
  }

  const handleStopTask = async (): Promise<void> => {
    if (!activeSessionId) return
    setTaskStopping(activeSessionId, toolUseId)
    const stopResult = await window.api.stopTask(activeSessionId, toolUseId)

    if (!stopResult.success) {
      window.api.logError('ToolCallBlock', `Failed to stop task: ${stopResult.error}`)
      clearTaskStopping(activeSessionId, toolUseId)
      return
    }

    setTimeout(() => {
      const rid = useSessionStore.getState().activeSessionId
      if (rid) clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  const handleOpenTaskPanel = (): void => {
    if (activeSessionId) openTaskPanel(activeSessionId, toolUseId)
  }

  return (
    <ToolCallBlockView
      block={block}
      result={result}
      approval={approval}
      isHistorical={isHistorical}
      permissionMode={permissionMode}
      expandToolCalls={expandToolCalls}
      expandReadResults={expandReadResults}
      hideToolInput={hideToolInput}
      theme={theme}
      isBackgroundBash={isBackgroundBash}
      bashOutput={bashOutput}
      bgOutput={bgOutput}
      bgNotification={bgNotification}
      isStopping={isStopping}
      isBackgrounding={isBackgrounding}
      hasActiveSession={activeSessionId !== null}
      backgroundTasksEnabled={backgroundTasksEnabled}
      onApproval={handleApproval}
      onBackgroundTask={handleBackgroundTask}
      onStopTask={handleStopTask}
      onOpenTaskPanel={handleOpenTaskPanel}
    />
  )
})
